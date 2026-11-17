importScripts('ExtPay.js');

// ExtensionPayで発行した楽天版の拡張機能ID（スラッグ）を設定してください
const EXTPAY_EXTENSION_ID = 'rakuten-invoice-pro-jp';
const FREE_MONTHLY_LIMIT = 10;

let isCancelled = false;
let isRunning = false;
let activeAutoDownloadFilename = null;

// 楽天ページからの直接PDFダウンロードを指定ファイル名へリネーム
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (
    activeAutoDownloadFilename &&
    downloadItem.url &&
    (downloadItem.url.includes('rakuten.co.jp') || downloadItem.mime === 'application/pdf')
  ) {
    suggest({ filename: activeAutoDownloadFilename, conflictAction: 'uniquify' });
    return;
  }
  suggest();
});

const isExtPayConfigured = () =>
  EXTPAY_EXTENSION_ID && EXTPAY_EXTENSION_ID !== 'YOUR_RAKUTEN_EXTPAY_ID';

const extpay = isExtPayConfigured() ? ExtPay(EXTPAY_EXTENSION_ID) : null;
if (extpay) {
  extpay.startBackground();
}

// 現在の年月（YYYY-MM）を取得
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// 月間利用回数を取得
async function getMonthlyUsage() {
  const currentMonth = getCurrentMonthKey();
  return new Promise((resolve) => {
    chrome.storage.local.get(['monthlyUsage'], (res) => {
      const usage = res.monthlyUsage;
      if (usage && usage.month === currentMonth) {
        resolve({ month: currentMonth, count: usage.count || 0 });
      } else {
        const fresh = { month: currentMonth, count: 0 };
        chrome.storage.local.set({ monthlyUsage: fresh }, () => resolve(fresh));
      }
    });
  });
}

// 月間利用回数を加算
async function incrementMonthlyUsage(addedCount) {
  if (!addedCount) return;
  const usage = await getMonthlyUsage();
  const updated = { month: usage.month, count: usage.count + addedCount };
  return new Promise((resolve) => {
    chrome.storage.local.set({ monthlyUsage: updated }, () => resolve(updated));
  });
}

// ローカル開発版（update_urlがない）か判定
const isUnpackedDev = () => !chrome.runtime.getManifest().update_url;

// 課金状態と無料枠残数を取得
async function getLicenseStatus() {
  let isPaid = false;
  const devMode = isUnpackedDev();

  if (devMode) {
    const devPro = await new Promise((resolve) => {
      chrome.storage.local.get(['devProMode'], (res) => {
        resolve(res.devProMode === undefined ? true : Boolean(res.devProMode));
      });
    });
    if (devPro) {
      isPaid = true;
    }
  }

  if (!isPaid && extpay) {
    try {
      const user = await extpay.getUser();
      isPaid = Boolean(user && user.paid);
    } catch (err) {
      console.warn('[ExtPay] ユーザー状態取得エラー:', err);
    }
  }

  const usage = await getMonthlyUsage();
  const remaining = isPaid ? Infinity : Math.max(0, FREE_MONTHLY_LIMIT - usage.count);

  return {
    isPaid,
    isConfigured: isExtPayConfigured(),
    isUnpackedDev: devMode,
    monthlyUsed: usage.count,
    monthlyLimit: FREE_MONTHLY_LIMIT,
    remaining: isPaid ? null : remaining
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_LICENSE_STATUS') {
    getLicenseStatus().then((status) => sendResponse(status));
    return true;
  }

  if (message.action === 'OPEN_PAYMENT_PAGE') {
    if (extpay) {
      extpay.openPaymentPage();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: 'NOT_CONFIGURED' });
    }
    return false;
  }

  if (message.action === 'OPEN_LOGIN_PAGE') {
    if (extpay) {
      extpay.openLoginPage();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: 'NOT_CONFIGURED' });
    }
    return false;
  }

  if (message.action === 'TOGGLE_DEV_PRO') {
    if (!isUnpackedDev()) {
      sendResponse({ devProMode: false });
      return false;
    }
    chrome.storage.local.get(['devProMode'], (res) => {
      const current = res.devProMode === undefined ? true : Boolean(res.devProMode);
      const next = !current;
      chrome.storage.local.set({ devProMode: next }, () => {
        sendResponse({ devProMode: next });
      });
    });
    return true;
  }

  if (message.action === 'START_DOWNLOAD') {
    if (isRunning) return;
    const sourceTabId = sender.tab ? sender.tab.id : null;
    const { items, exportCsv, receiptName } = message.payload;
    processPdfQueue(items, exportCsv, sourceTabId, receiptName || '');
  } else if (message.action === 'CANCEL_DOWNLOAD') {
    isCancelled = true;
  }
});

function notifyProgress(tabId, current, total, statusText, done = false, extra = {}) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    action: 'PROGRESS_UPDATE',
    current,
    total,
    statusText,
    done,
    ...extra
  }).catch(() => {});
}

function isRakutenLoginUrl(url) {
  if (!url) return false;
  return (
    url.includes('id.rakuten.co.jp') ||
    url.includes('login.account.rakuten.com')
  );
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('ページ読み込みがタイムアウトしました'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodeUtf8BomBase64(text) {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = new TextEncoder().encode(text);
  const merged = new Uint8Array(bom.length + body.length);
  merged.set(bom, 0);
  merged.set(body, bom.length);
  return arrayBufferToBase64(merged.buffer);
}

function escapeCsv(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function recordDownloadedOrderIds(newIds) {
  if (!newIds.length) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(['downloadedOrderIds'], (res) => {
      const existing = Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : [];
      const merged = Array.from(new Set([...existing, ...newIds]));
      chrome.storage.local.set({ downloadedOrderIds: merged }, () => {
        resolve(merged.length);
      });
    });
  });
}

// まずURLが直接PDFを返すか確認し、PDFならそのまま保存
async function tryDownloadDirectPdf(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (isRakutenLoginUrl(res.url)) {
    throw new Error('楽天会員のログインセッションが切れました。再ログインしてください。');
  }
  if (!res.ok) {
    return false;
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    return false;
  }
  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  await downloadDataUrl(`data:application/pdf;base64,${base64}`, filename);
  return true;
}

// タブを指定してPDF生成・保存
async function renderTabAsPdf(tabId, filename) {
  const pdfResult = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.4,
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4
  });
  const pdfDataUrl = `data:application/pdf;base64,${pdfResult.data}`;
  await downloadDataUrl(pdfDataUrl, filename);
}

// 新規タブが開かれるのを少し待機（別タブで領収書が開くパターン対応）
function waitForCreatedTab(openerTabId, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onCreated.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    function listener(tab) {
      if (tab.openerTabId === openerTabId) {
        clearTimeout(timer);
        chrome.tabs.onCreated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onCreated.addListener(listener);
  });
}

// 新規ダウンロード開始を待機（楽天「発行する」ボタンで直接PDFが落ちるパターン対応）
function waitForDownloadStart(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    function listener(downloadItem) {
      if (downloadItem.url && downloadItem.url.startsWith('data:')) return;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(listener);
      resolve(downloadItem);
    }

    chrome.downloads.onCreated.addListener(listener);
  });
}

// タブを使って注文詳細ページから領収書を探し出しPDFを生成・保存
async function printTabToPdf(tabId, item, receiptName) {
  const loadPromise = waitForTabComplete(tabId);
  await chrome.tabs.update(tabId, { url: item.url });
  const updatedTab = await loadPromise;

  if (isRakutenLoginUrl(updatedTab.url)) {
    throw new Error('楽天会員のログインセッションが切れました。再ログインしてください。');
  }

  await new Promise((r) => setTimeout(r, 1200));
  if (isCancelled) return false;

  // すでに領収書ページでない場合、「領収書・請求書」セクションや「発行する」ボタンを探す（最大5秒ポーリング）
  if (!/receipt|ryoshusho/i.test(updatedTab.url || '')) {
    const safeNameJson = JSON.stringify(receiptName || '');

    let found = null;
    for (let poll = 0; poll < 10; poll++) {
      if (isCancelled) return false;
      const evalRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => {
          const desiredName = ${safeNameJson};
          const setReactInput = (input, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, val);
            else input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          };

          // 1. 「領収書・請求書」セクション内の「発行する」ボタン（BUTTON）を最優先で探す
          const allBtns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'));
          const issueBtn =
            allBtns.find((el) => {
              const t = (el.textContent || el.value || '').replace(/\s+/g, '').trim();
              return t === '発行する' || t === '領収書を発行する' || t === '再発行する';
            }) ||
            allBtns.find((el) => {
              const t = (el.textContent || el.value || '').replace(/\s+/g, '').trim();
              return /領収書/.test(t) && !/ヘルプ|とは|について|ガイド/.test(t);
            });

          if (issueBtn) {
            const container = issueBtn.closest('section, article, form, div') || document;
            const nameInput =
              container.querySelector('input[type="text"], input:not([type])') ||
              issueBtn.parentElement?.querySelector('input');
            if (nameInput && !nameInput.disabled && !nameInput.readOnly && !nameInput.value.trim()) {
              const fillVal = desiredName || '上様';
              setReactInput(nameInput, fillVal);
            }
            issueBtn.scrollIntoView({ block: 'center' });
            const rect = issueBtn.getBoundingClientRect();
            return {
              type: 'ready_to_click',
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2
            };
          }

          // 2. ボタンがない場合のみ、直接の領収書リンク（a[href]）を探す
          const links = Array.from(document.querySelectorAll('a[href]'));
          const receiptLink = links.find((a) => {
            const t = (a.textContent || '').trim();
            const h = a.getAttribute('href') || '';
            if (!h || h === '#' || h.startsWith('javascript:')) return false;
            if (/ヘルプ|とは|について|ガイド|faq/i.test(t + h)) return false;
            return /^領収書/.test(t) || /receipt|ryoshusho/i.test(h);
          });
          if (receiptLink) {
            return { type: 'url', url: new URL(receiptLink.getAttribute('href'), location.href).href };
          }

          return { type: 'none' };
        })()`,
        returnByValue: true
      });

      found = evalRes && evalRes.result ? evalRes.result.value : null;
      if (found && found.type !== 'none') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (found && found.type === 'url' && found.url) {
      const directSaved = await tryDownloadDirectPdf(found.url, item.filename);
      if (directSaved) {
        item.pdfType = '楽天公式PDF';
        item.url = found.url;
        return true;
      }
      const receiptLoad = waitForTabComplete(tabId);
      await chrome.tabs.update(tabId, { url: found.url });
      await receiptLoad;
      await new Promise((r) => setTimeout(r, 900));
      await renderTabAsPdf(tabId, item.filename);
      item.pdfType = '領収書ページPDF';
      item.url = found.url;
      return true;
    }

    if (found && found.type === 'ready_to_click') {
      await new Promise((r) => setTimeout(r, 250));
      const createdTabPromise = waitForCreatedTab(tabId, 6000);
      const downloadStartPromise = waitForDownloadStart(6000);
      activeAutoDownloadFilename = item.filename;

      // ネットワークレベルで application/pdf レスポンスを傍受
      let interceptedPdfUrl = null;
      const netListener = (source, method, params) => {
        if (source.tabId !== tabId) return;
        if (method === 'Network.responseReceived') {
          const mime = (params.response?.mimeType || '').toLowerCase();
          const url = params.response?.url || '';
          if (mime.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
            interceptedPdfUrl = url;
          }
        }
      };
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => {});
      chrome.debugger.onEvent.addListener(netListener);

      try {
        // btn.focus() + btn.click() でクリックを実行
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(() => {
            const allBtns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'));
            const btn =
              allBtns.find((el) => {
                const t = (el.textContent || el.value || '').replace(/\\s+/g, '').trim();
                return t === '発行する' || t === '領収書を発行する' || t === '再発行する';
              }) ||
              allBtns.find((el) => /領収書/.test(el.textContent || el.value || ''));
            if (btn) {
              btn.focus();
              btn.click();
              return true;
            }
            return false;
          })()`,
          returnByValue: true
        });

        const [startedDownload, newTab] = await Promise.all([downloadStartPromise, createdTabPromise]);
        activeAutoDownloadFilename = null;

        if (startedDownload) {
          item.pdfType = '楽天公式PDF';
          return true;
        }

        if (interceptedPdfUrl) {
          const directSaved = await tryDownloadDirectPdf(interceptedPdfUrl, item.filename).catch(() => false);
          if (directSaved) {
            item.pdfType = '楽天公式PDF(通信取得)';
            item.url = interceptedPdfUrl;
            return true;
          }
        }

        if (newTab) {
          try {
            const finishedTab = await waitForTabComplete(newTab.id).catch(() => newTab);
            await new Promise((r) => setTimeout(r, 900));
            const targetUrl = finishedTab.url || newTab.pendingUrl || '';
            if (targetUrl && targetUrl !== 'about:blank') {
              const directSaved = await tryDownloadDirectPdf(targetUrl, item.filename).catch(() => false);
              if (directSaved) {
                item.pdfType = '楽天公式PDF';
                item.url = targetUrl;
                return true;
              }
            }
            await chrome.debugger.attach({ tabId: newTab.id }, '1.3');
            await chrome.debugger.sendCommand({ tabId: newTab.id }, 'Page.enable');
            await renderTabAsPdf(newTab.id, item.filename);
            await chrome.debugger.detach({ tabId: newTab.id }).catch(() => {});
            item.pdfType = '領収書ページPDF';
            if (targetUrl) item.url = targetUrl;
            return true;
          } finally {
            await chrome.tabs.remove(newTab.id).catch(() => {});
          }
        }

        // window.open がフックされた場合
        const capturedRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: 'window.__capturedOpenUrl || null',
          returnByValue: true
        }).catch(() => null);
        const capturedUrl = capturedRes && capturedRes.result ? capturedRes.result.value : null;

        if (capturedUrl) {
          const absUrl = new URL(capturedUrl, updatedTab.url).href;
          const directSaved = await tryDownloadDirectPdf(absUrl, item.filename).catch(() => false);
          if (directSaved) {
            item.pdfType = '楽天公式PDF';
            item.url = absUrl;
            return true;
          }
          const receiptLoad = waitForTabComplete(tabId);
          await chrome.tabs.update(tabId, { url: absUrl });
          await receiptLoad;
          await new Promise((r) => setTimeout(r, 900));
          await renderTabAsPdf(tabId, item.filename);
          item.pdfType = '領収書ページPDF';
          item.url = absUrl;
          return true;
        }

        await new Promise((r) => setTimeout(r, 1000));
        await renderTabAsPdf(tabId, item.filename);
        item.pdfType = '領収書PDF(未遷移)';
        return true;
      } finally {
        chrome.debugger.onEvent.removeListener(netListener);
        activeAutoDownloadFilename = null;
      }
    }

    activeAutoDownloadFilename = null;
  }

  // 領収書ボタンが見つからない場合は注文詳細ページをPDF化
  await renderTabAsPdf(tabId, item.filename);
  item.pdfType = '注文詳細PDF(ボタンなし)';
  return true;
}

// PDF一括生成メイン処理
async function processPdfQueue(rawItems, exportCsv, sourceTabId, receiptName = '') {
  isRunning = true;
  isCancelled = false;

  let workerTab = null;
  let debuggerAttached = false;
  let successCount = 0;
  const completedItems = [];
  const failedItems = [];

  try {
    const license = await getLicenseStatus();
    if (!license.isPaid && license.remaining <= 0) {
      notifyProgress(
        sourceTabId,
        0,
        rawItems.length,
        `今月の無料枠（${FREE_MONTHLY_LIMIT}件）に達しました。Proプランで無制限になります。`,
        true,
        { licenseStatus: license }
      );
      return;
    }

    const items = license.isPaid ? rawItems : rawItems.slice(0, license.remaining);
    const allowCsv = Boolean(exportCsv && license.isPaid);

    const ensureWorkerTab = async () => {
      if (workerTab) return;
      workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });
      await chrome.debugger.attach({ tabId: workerTab.id }, '1.3');
      debuggerAttached = true;
      await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `
          window.print = function() {};
          window.__capturedOpenUrl = null;
          const __origOpen = window.open;
          window.open = function(url) {
            if (url) window.__capturedOpenUrl = String(url);
            try { return __origOpen.apply(this, arguments); } catch (_) { return null; }
          };
        `
      });
    };

    for (let i = 0; i < items.length; i++) {
      if (isCancelled) break;

      const item = items[i];
      notifyProgress(
        sourceTabId,
        i,
        items.length,
        `PDF保存中 (${i + 1}/${items.length}): ${item.orderId}`
      );

      let saved = false;

      // 1. 領収書URLが直接PDFを返すか試行
      try {
        const directSaved = await tryDownloadDirectPdf(item.url, item.filename);
        if (directSaved) {
          saved = true;
          item.pdfType = '楽天公式PDF';
        }
      } catch (err) {
        if (err.message.includes('ログインセッション')) {
          notifyProgress(sourceTabId, i, items.length, err.message, true);
          return;
        }
      }

      // 2. HTMLページの場合はタブで開いて Page.printToPDF でPDF生成（最大2回試行）
      if (!saved) {
        await ensureWorkerTab();
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (isCancelled) break;
          try {
            const ok = await printTabToPdf(workerTab.id, item, receiptName);
            if (ok) {
              saved = true;
              if (!item.pdfType) item.pdfType = '印刷生成PDF';
            }
            break;
          } catch (err) {
            console.error(`[PDF生成失敗 attempt=${attempt}] ${item.orderId}:`, err);
            if (err.message.includes('ログインセッション')) {
              notifyProgress(sourceTabId, i, items.length, err.message, true);
              return;
            }
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 1200));
            }
          }
        }
      }

      if (saved) {
        successCount++;
        completedItems.push(item);
      } else if (!isCancelled) {
        failedItems.push(item);
      }

      if (i < items.length - 1 && !isCancelled) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (!license.isPaid && successCount > 0) {
      await incrementMonthlyUsage(successCount);
    }

    const historyCount = await recordDownloadedOrderIds(completedItems.map((it) => it.orderId));
    const latestLicense = await getLicenseStatus();

    // ProプランのみCSVサマリー出力
    if (!isCancelled && allowCsv && completedItems.length > 0) {
      const header = ['注文日', '注文番号', '金額(円)', 'ショップ/商品名', 'PDF種別', '保存ファイル名', '領収書URL'];
      const rows = completedItems.map((it) => [
        it.dateIso || it.date,
        it.orderId,
        it.priceNum,
        it.title,
        it.pdfType || '',
        it.filename,
        it.url
      ]);
      const csvText = [header, ...rows]
        .map((row) => row.map(escapeCsv).join(','))
        .join('\r\n');

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const csvDataUrl = `data:text/csv;charset=utf-8;base64,${encodeUtf8BomBase64(csvText)}`;
      await downloadDataUrl(csvDataUrl, `楽天領収書/${today}_楽天領収書一覧.csv`);
    }

    const finalMsg = isCancelled
      ? `中止しました (${successCount}/${items.length}件 保存済み)`
      : failedItems.length > 0
        ? `完了: ${successCount}/${items.length}件保存（失敗: ${failedItems.length}件）`
        : `完了: ${successCount}/${items.length}件のPDFを保存しました`;

    notifyProgress(sourceTabId, items.length, items.length, finalMsg, true, {
      historyCount,
      licenseStatus: latestLicense,
      failedItems
    });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '楽天領収書一括ダウンローダー',
      message: finalMsg
    });
  } catch (err) {
    console.error('[楽天領収書PDF] 致命的エラー:', err);
    notifyProgress(sourceTabId, 0, rawItems.length, `エラー: ${err.message}`, true);
  } finally {
    if (debuggerAttached && workerTab) {
      try {
        await chrome.debugger.detach({ tabId: workerTab.id });
      } catch (_) {}
    }
    if (workerTab) {
      try {
        await chrome.tabs.remove(workerTab.id);
      } catch (_) {}
    }
    isRunning = false;
  }
}
