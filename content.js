(() => {
  let isProcessing = false;
  let isCancelled = false;
  let scannedItems = [];
  let lastFailedItems = [];
  let currentLicense = { isPaid: false, isConfigured: false, monthlyUsed: 0, monthlyLimit: 10, remaining: 10 };

  const DEFAULT_SETTINGS = {
    fetchDepth: '3',
    dateFrom: '',
    dateTo: '',
    filenameTemplate: '{date}_{price}_Rakuten_{orderId}',
    receiptName: '',
    skipDownloaded: false,
    exportCsv: true
  };

  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function handleInvalidContext() {
    alert('拡張機能が更新されました。このページを再読み込み（F5）してからもう一度お試しください。');
  }

  function fetchLicenseStatus() {
    if (!isContextValid()) {
      return Promise.resolve(currentLicense);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(currentLicense);
            return;
          }
          if (res) currentLicense = res;
          resolve(currentLicense);
        });
      } catch (_) {
        resolve(currentLicense);
      }
    });
  }

  function openUpgradePage() {
    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'OPEN_PAYMENT_PAGE' }, (res) => {
        if (chrome.runtime.lastError) {
          handleInvalidContext();
          return;
        }
        if (res && !res.ok && res.reason === 'NOT_CONFIGURED') {
          alert('ExtensionPay ID が未設定です。拡張機能アイコンから設定・テストしてください。');
        }
      });
    } catch (_) {
      handleInvalidContext();
    }
  }

  function renderLicenseUI(license) {
    currentLicense = license;
    const badgeEl = document.getElementById('rkt-plan-badge');
    const upgradeBtn = document.getElementById('rkt-upgrade-inline-btn');
    const csvCheckbox = document.getElementById('rkt-export-csv');
    const csvLabel = document.getElementById('rkt-csv-label');

    if (!badgeEl) return;

    if (license.isPaid) {
      badgeEl.textContent = '✨ Proプラン（無制限）';
      badgeEl.style.background = '#e6f4ea';
      badgeEl.style.color = '#137333';
      badgeEl.style.borderColor = '#ceead6';
      if (upgradeBtn) upgradeBtn.style.display = 'none';
      if (csvCheckbox) csvCheckbox.disabled = false;
      if (csvLabel) csvLabel.textContent = '注文一覧CSVも同時に保存';
    } else {
      badgeEl.textContent = `無料枠: 今月あと ${license.remaining}/${license.monthlyLimit}件`;
      badgeEl.style.background = '#fff8e1';
      badgeEl.style.color = '#8d6e00';
      badgeEl.style.borderColor = '#ffe082';
      if (upgradeBtn) upgradeBtn.style.display = 'inline-block';
      if (csvCheckbox) {
        csvCheckbox.checked = false;
        csvCheckbox.disabled = true;
      }
      if (csvLabel) csvLabel.textContent = '注文一覧CSVも同時に保存 (Pro限定)';
    }
  }

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['rktSettings', 'downloadedOrderIds', 'panelPos'], (res) => {
        resolve({
          settings: { ...DEFAULT_SETTINGS, ...(res.rktSettings || {}) },
          downloadedOrderIds: Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : [],
          panelPos: res.panelPos || null
        });
      });
    });
  }

  function saveSettings(settings) {
    chrome.storage.local.set({ rktSettings: settings });
  }

  function sanitizeFilePart(str) {
    return String(str || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildFilename(template, item) {
    const safeTitle = sanitizeFilePart(item.title || '商品');
    const year = item.date !== '不明日付' ? item.date.slice(0, 4) : '不明年';
    const month = item.date !== '不明日付' ? item.date.slice(4, 6) : '00';
    const dateIso = item.dateIso || item.date;

    let name = (template || DEFAULT_SETTINGS.filenameTemplate)
      .replace(/\{date\}/g, item.date)
      .replace(/\{dateIso\}/g, dateIso)
      .replace(/\{year\}/g, year)
      .replace(/\{month\}/g, month)
      .replace(/\{price\}/g, item.priceStr)
      .replace(/\{priceNum\}/g, item.priceNum)
      .replace(/\{orderId\}/g, item.orderId)
      .replace(/\{title\}/g, safeTitle.slice(0, 40));

    name = name
      .split('/')
      .map((seg) => sanitizeFilePart(seg))
      .filter(Boolean)
      .join('/');

    if (!name.toLowerCase().endsWith('.pdf')) {
      name += '.pdf';
    }
    return `楽天領収書/${name}`;
  }

  function enableDrag(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(0, window.innerHeight - 60);
      const left = Math.max(8, Math.min(maxLeft, e.clientX - offsetX));
      const top = Math.max(8, Math.min(maxTop, e.clientY - offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      chrome.storage.local.set({
        panelPos: {
          top: parseInt(panel.style.top, 10) || 64,
          left: parseInt(panel.style.left, 10) || 16
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function injectPanelStyles() {
    if (document.getElementById('rkt-invoice-style')) return;
    const style = document.createElement('style');
    style.id = 'rkt-invoice-style';
    style.textContent = `
      #rkt-invoice-panel * { box-sizing: border-box; }
      #rkt-invoice-panel input:focus,
      #rkt-invoice-panel select:focus {
        outline: none;
        border-color: #BF0000 !important;
        box-shadow: 0 0 0 2px rgba(191, 0, 0, 0.18);
      }
      #rkt-invoice-panel .rkt-primary-btn {
        background: linear-gradient(180deg, #d60000 0%, #bf0000 100%) !important;
        transition: filter 0.15s, transform 0.05s;
      }
      #rkt-invoice-panel .rkt-primary-btn:hover:not(:disabled) {
        filter: brightness(0.93);
      }
      #rkt-invoice-panel .rkt-primary-btn:active:not(:disabled) {
        transform: translateY(1px);
      }
      #rkt-preview-list::-webkit-scrollbar { width: 6px; }
      #rkt-preview-list::-webkit-scrollbar-thumb {
        background: #d1d5db; border-radius: 3px;
      }
      #rkt-preview-list .rkt-item-row:hover {
        background: #fff5f5;
      }
      @media print {
        #rkt-invoice-panel {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function updateSelectionSummary() {
    const listEl = document.getElementById('rkt-preview-list');
    const countEl = document.getElementById('rkt-selected-count');
    const totalEl = document.getElementById('rkt-selected-total');
    const downloadBtn = document.getElementById('rkt-download-selected-btn');
    if (!listEl) return;

    const checkedBoxes = Array.from(listEl.querySelectorAll('.rkt-item-check:checked'));
    const totalYen = checkedBoxes.reduce((sum, cb) => {
      const idx = parseInt(cb.getAttribute('data-index'), 10);
      const item = scannedItems[idx];
      return sum + (item ? parseInt(item.priceNum || '0', 10) || 0 : 0);
    }, 0);

    if (countEl) countEl.textContent = String(checkedBoxes.length);
    if (totalEl) totalEl.textContent = `¥${totalYen.toLocaleString('ja-JP')}`;
    if (downloadBtn) {
      downloadBtn.disabled = checkedBoxes.length === 0;
      downloadBtn.style.opacity = checkedBoxes.length === 0 ? '0.5' : '1';
    }
  }

  function renderPreviewList(items) {
    const wrap = document.getElementById('rkt-preview-wrap');
    const listEl = document.getElementById('rkt-preview-list');
    const filterInput = document.getElementById('rkt-filter-input');

    if (!wrap || !listEl) return;
    if (!items.length) {
      wrap.style.display = 'none';
      return;
    }

    if (filterInput) filterInput.value = '';

    listEl.innerHTML = items
      .map(
        (it, idx) => `
        <label class="rkt-item-row" data-search="${escapeHtml((it.title + ' ' + it.orderId + ' ' + (it.dateIso || it.date)).toLowerCase())}" style="
          display:flex; align-items:flex-start; gap:6px; padding:5px 4px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:11px;
        ">
          <input type="checkbox" class="rkt-item-check" data-index="${idx}" checked style="margin-top:2px;" />
          <div style="flex:1; min-width:0;">
            <div style="display:flex; justify-content:space-between; font-weight:bold; color:#111;">
              <span>${escapeHtml(it.dateIso || it.date)}</span>
              <span>${escapeHtml(it.priceStr)}</span>
            </div>
            <div style="color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(it.title || it.orderId)}</div>
          </div>
        </label>`
      )
      .join('');

    listEl.querySelectorAll('.rkt-item-check').forEach((cb) => {
      cb.addEventListener('change', updateSelectionSummary);
    });

    wrap.style.display = 'block';
    updateSelectionSummary();
  }

  async function injectControlUI() {
    // 領収書・注文詳細・印刷ページなどではパネルを表示しない（クエリの l-id 等での誤爆を防ぐ）
    const path = window.location.pathname || '';
    const search = window.location.search || '';
    if (/receipt|ryoshusho|invoice|detail|print/i.test(path) || /[?&]act=(detail|receipt|print)/i.test(search)) {
      return;
    }
    if (document.getElementById('rkt-invoice-panel')) return;
    injectPanelStyles();

    const [{ settings, downloadedOrderIds, panelPos }, license] = await Promise.all([
      loadSettings(),
      fetchLicenseStatus()
    ]);

    const initTop = panelPos ? Math.min(window.innerHeight - 80, Math.max(8, panelPos.top)) : 64;
    const initLeft = panelPos ? Math.min(window.innerWidth - 310, Math.max(8, panelPos.left)) : 16;

    const panel = document.createElement('div');
    panel.id = 'rkt-invoice-panel';
    panel.style.cssText = `
      position: fixed;
      top: ${initTop}px;
      left: ${initLeft}px;
      z-index: 999999;
      width: 300px;
      padding: 12px 14px;
      background: #ffffff;
      border: 2px solid #BF0000;
      border-radius: 8px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
      font-family: "Segoe UI", "Hiragino Sans", sans-serif;
      font-size: 12.5px;
      color: #111;
    `;

    panel.innerHTML = `
      <div id="rkt-drag-handle" title="ドラッグで移動" style="
        display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; cursor:move;
      ">
        <span style="font-weight:bold; font-size:13.5px; color:#BF0000;">⠿ 楽天領収書PDF一括取得</span>
        <button id="rkt-toggle-btn" title="最小化" style="
          background:none; border:none; cursor:pointer; font-size:14px; color:#555; padding:0 4px;
        ">－</button>
      </div>

      <div id="rkt-panel-body">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:8px;">
          <span id="rkt-plan-badge" style="
            font-size:11px; font-weight:bold; padding:3px 7px; border-radius:4px; border:1px solid #ffe082;
          ">確認中...</span>
          <button id="rkt-upgrade-inline-btn" type="button" style="
            display:none; background:#111; color:#fff; border:none; border-radius:4px;
            padding:3px 8px; font-size:11px; font-weight:bold; cursor:pointer;
          ">Proへ</button>
        </div>

        <div style="margin-bottom:8px;">
          <label style="display:block; margin-bottom:3px; color:#444; font-size:11.5px;">取得対象ページ数</label>
          <select id="rkt-fetch-depth" style="width:100%; padding:5px; border:1px solid #ccc; border-radius:4px;">
            <option value="1">このページのみ</option>
            <option value="3">3ページ分巡回</option>
            <option value="5">5ページ分巡回</option>
            <option value="99">全ページ巡回（最大99ページ）</option>
          </select>
        </div>

        <div style="display:flex; gap:6px; margin-bottom:8px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:2px; color:#444; font-size:11px;">開始日</label>
            <input type="date" id="rkt-date-from" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px;" />
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:2px; color:#444; font-size:11px;">終了日</label>
            <input type="date" id="rkt-date-to" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px;" />
          </div>
        </div>

        <details id="rkt-advanced-details" style="margin-bottom:8px; border:1px solid #eee; border-radius:4px; padding:6px 8px; background:#fafafa;">
          <summary style="cursor:pointer; font-size:11.5px; color:#333; font-weight:bold;">詳細設定（ファイル名・CSV等）</summary>
          <div style="margin-top:8px;">
            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">領収書の宛名（未発行の注文に自動入力）</label>
            <input type="text" id="rkt-receipt-name" placeholder="例: 株式会社〇〇 / 氏名" style="width:100%; padding:4px 6px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:8px;" />

            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">ファイル名プリセット</label>
            <select id="rkt-filename-preset" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:6px;">
              <option value="custom">カスタム（下の入力欄を編集）</option>
              <option value="{date}_{price}_Rakuten_{orderId}">標準（日付_金額_Rakuten_注文番号）</option>
              <option value="{year}/{year}-{month}/{date}_{price}_{orderId}">年/月別フォルダ分け</option>
              <option value="{dateIso}_Rakuten_{title}_{price}">freee・MF向け（日付_商品名_金額）</option>
            </select>
            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">ファイル名形式（{date} {dateIso} {price} {orderId} {title} {year}）</label>
            <input type="text" id="rkt-filename-tpl" style="width:100%; padding:4px 6px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:8px;" />

            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11.5px; cursor:pointer;">
              <input type="checkbox" id="rkt-skip-downloaded" />
              <span>取得済みの注文をスキップ (<span id="rkt-history-count">${downloadedOrderIds.length}</span>件)</span>
            </label>

            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11.5px; cursor:pointer;">
              <input type="checkbox" id="rkt-export-csv" />
              <span id="rkt-csv-label">注文一覧CSVも同時に保存</span>
            </label>

            <button id="rkt-clear-history-btn" type="button" style="
              background:#fff; border:1px solid #ccc; border-radius:4px; padding:3px 8px; font-size:11px; color:#555; cursor:pointer;
            ">取得済み履歴をリセット</button>
          </div>
        </details>

        <div id="rkt-preview-wrap" style="display:none; margin-bottom:8px; border:1px solid #ddd; border-radius:6px; padding:7px; background:#fff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:11px;">
            <span style="font-weight:bold;">対象: <span id="rkt-selected-count">0</span>件（<span id="rkt-selected-total">¥0</span>）</span>
            <div>
              <button id="rkt-select-all-btn" type="button" style="background:none; border:none; color:#bf0000; cursor:pointer; font-size:11px; padding:0 4px;">全選択</button>
              <button id="rkt-deselect-all-btn" type="button" style="background:none; border:none; color:#bf0000; cursor:pointer; font-size:11px; padding:0 4px;">解除</button>
            </div>
          </div>
          <input type="text" id="rkt-filter-input" placeholder="商品名・注文番号で絞り込み..." style="
            width:100%; padding:4px 6px; margin-bottom:5px; border:1px solid #ddd; border-radius:4px; font-size:11px;
          " />
          <div id="rkt-preview-list" style="max-height:150px; overflow-y:auto; border-top:1px solid #eee;"></div>
          <button id="rkt-download-selected-btn" type="button" class="rkt-primary-btn" style="
            width:100%; margin-top:6px; color:#fff; font-weight:bold;
            border:1px solid #990000; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">選択した注文をPDF保存</button>
        </div>

        <div id="rkt-progress-wrap" style="display:none; margin-bottom:8px;">
          <div style="width:100%; height:6px; background:#eee; border-radius:3px; overflow:hidden;">
            <div id="rkt-progress-bar" style="width:0%; height:100%; background:#BF0000; transition:width 0.2s;"></div>
          </div>
        </div>

        <div id="rkt-status-text" style="color:#555; font-size:11.5px; margin-bottom:8px; min-height:18px; line-height:1.4;">待機中</div>

        <div style="display:flex; gap:6px;">
          <button id="rkt-scan-btn" class="rkt-primary-btn" style="
            flex:1; color:#fff; font-weight:bold;
            border:1px solid #990000; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">注文をスキャン</button>
          <button id="rkt-cancel-btn" style="
            display:none; background:#f3f3f3; color:#333;
            border:1px solid #ccc; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">中止</button>
        </div>

        <button id="rkt-retry-btn" type="button" style="
          display:none; width:100%; margin-top:6px; background:#fff3cd; color:#856404;
          border:1px solid #ffeeba; padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size:11.5px;
        ">失敗した注文を再取得</button>
      </div>
    `;

    document.body.appendChild(panel);
    enableDrag(panel, document.getElementById('rkt-drag-handle'));

    document.getElementById('rkt-fetch-depth').value = settings.fetchDepth;
    document.getElementById('rkt-date-from').value = settings.dateFrom;
    document.getElementById('rkt-date-to').value = settings.dateTo;
    document.getElementById('rkt-receipt-name').value = settings.receiptName || '';
    document.getElementById('rkt-filename-tpl').value = settings.filenameTemplate;
    document.getElementById('rkt-skip-downloaded').checked = settings.skipDownloaded;
    document.getElementById('rkt-export-csv').checked = settings.exportCsv;

    const presetEl = document.getElementById('rkt-filename-preset');
    const tplEl = document.getElementById('rkt-filename-tpl');
    const matchPreset = Array.from(presetEl.options).some((opt) => opt.value === settings.filenameTemplate);
    presetEl.value = matchPreset ? settings.filenameTemplate : 'custom';

    renderLicenseUI(license);

    const syncSettings = () => {
      saveSettings({
        fetchDepth: document.getElementById('rkt-fetch-depth').value,
        dateFrom: document.getElementById('rkt-date-from').value,
        dateTo: document.getElementById('rkt-date-to').value,
        receiptName: document.getElementById('rkt-receipt-name').value.trim(),
        filenameTemplate: tplEl.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
        skipDownloaded: document.getElementById('rkt-skip-downloaded').checked,
        exportCsv: document.getElementById('rkt-export-csv').checked
      });
    };

    presetEl.addEventListener('change', () => {
      if (presetEl.value !== 'custom') {
        tplEl.value = presetEl.value;
        syncSettings();
      }
    });

    tplEl.addEventListener('input', () => {
      const matched = Array.from(presetEl.options).some((opt) => opt.value === tplEl.value.trim());
      presetEl.value = matched ? tplEl.value.trim() : 'custom';
    });

    [
      'rkt-fetch-depth',
      'rkt-date-from',
      'rkt-date-to',
      'rkt-receipt-name',
      'rkt-filename-tpl',
      'rkt-skip-downloaded',
      'rkt-export-csv'
    ].forEach((id) => {
      document.getElementById(id).addEventListener('change', syncSettings);
    });

    document.getElementById('rkt-upgrade-inline-btn').addEventListener('click', openUpgradePage);

    document.getElementById('rkt-toggle-btn').addEventListener('click', () => {
      const body = document.getElementById('rkt-panel-body');
      const toggleBtn = document.getElementById('rkt-toggle-btn');
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '－' : '＋';
    });

    document.getElementById('rkt-clear-history-btn').addEventListener('click', () => {
      if (confirm('取得済みの注文履歴記録をリセットしますか？')) {
        chrome.storage.local.set({ downloadedOrderIds: [] }, () => {
          document.getElementById('rkt-history-count').textContent = '0';
          updateStatus('取得済み履歴をリセットしました');
        });
      }
    });

    document.getElementById('rkt-filter-input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#rkt-preview-list .rkt-item-row').forEach((row) => {
        const hay = row.getAttribute('data-search') || '';
        row.style.display = !q || hay.includes(q) ? 'flex' : 'none';
      });
    });

    document.getElementById('rkt-select-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#rkt-preview-list .rkt-item-row').forEach((row) => {
        if (row.style.display !== 'none') {
          const cb = row.querySelector('.rkt-item-check');
          if (cb) cb.checked = true;
        }
      });
      updateSelectionSummary();
    });

    document.getElementById('rkt-deselect-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#rkt-preview-list .rkt-item-row').forEach((row) => {
        if (row.style.display !== 'none') {
          const cb = row.querySelector('.rkt-item-check');
          if (cb) cb.checked = false;
        }
      });
      updateSelectionSummary();
    });

    document.getElementById('rkt-scan-btn').addEventListener('click', scanOrdersProcess);
    document.getElementById('rkt-download-selected-btn').addEventListener('click', startDownloadSelected);
    document.getElementById('rkt-cancel-btn').addEventListener('click', cancelBatchProcess);
    document.getElementById('rkt-retry-btn').addEventListener('click', retryFailedItems);

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.devProMode || changes.monthlyUsage) {
        fetchLicenseStatus().then(renderLicenseUI);
      }
    });
  }

  // 注文番号を含む最小のカード要素を汎用的に特定
  function findOrderCardContainers(doc) {
    const orderIdRegex = /\b\d{6}-\d{8}-\d{6,12}\b/;
    const candidates = Array.from(doc.querySelectorAll('section, article, li, div'));
    const orderContainers = [];

    for (const el of candidates) {
      if (el.id === 'rkt-invoice-panel' || el.closest('#rkt-invoice-panel')) continue;
      const text = el.innerText || el.textContent || '';
      const matches = text.match(/\b\d{6}-\d{8}-\d{6,12}\b/g);
      // ちょうど1件の注文番号のみを含むブロックを抽出
      if (matches && new Set(matches).size === 1) {
        orderContainers.push(el);
      }
    }

    // 親要素がすでに含まれている場合はより大きい（カード全体の）親を残し、子要素を除外
    const filtered = orderContainers.filter((el) => {
      const hasParentInList = orderContainers.some((other) => other !== el && other.contains(el));
      return !hasParentInList;
    });

    return filtered;
  }

  // 楽天市場の購入履歴から注文情報を抽出
  function extractOrdersFromDoc(doc, { filenameTemplate }) {
    const cards = findOrderCardContainers(doc);
    const items = [];

    for (const card of cards) {
      const text = card.innerText || card.textContent || '';
      const orderIdMatch = text.match(/(\d{6}-\d{8}-\d{6,12})/);
      if (!orderIdMatch) continue;

      const orderId = orderIdMatch[1];
      if (items.some((x) => x.orderId === orderId)) continue;

      // 注文日抽出 (YYYY年M月D日 または YYYY/MM/DD)
      const dateMatch = text.match(/(\d{4})[年\/\-]\s*(\d{1,2})[月\/\-]\s*(\d{1,2})日?/);
      const dateStr = dateMatch
        ? `${dateMatch[1]}${dateMatch[2].padStart(2, '0')}${dateMatch[3].padStart(2, '0')}`
        : '不明日付';
      const dateIso = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
        : '';

      // 合計金額を優先抽出
      const totalMatch =
        text.match(/(?:合計|支払金額|ご請求額)[^\d￥¥]*[￥¥]?\s*([0-9,]+)\s*円?/) ||
        text.match(/([0-9,]+)\s*円/) ||
        text.match(/[￥¥]\s*([0-9,]+)/);
      const priceNum = totalMatch ? totalMatch[1].replace(/,/g, '') : '0';
      const priceStr = `${priceNum}円`;

      // 商品名・ショップ名を抽出
      let itemTitle = '';
      const productLinks = card.querySelectorAll('a[href*="item.rakuten.co.jp"], a[href*="/item/"], a[href*="detail"]');
      for (const link of productLinks) {
        const t = (link.textContent || '').trim().replace(/\s+/g, ' ');
        if (t && !/領収書|注文詳細|詳細を見る|再購入/.test(t)) {
          itemTitle = t.slice(0, 80);
          break;
        }
      }

      // 領収書リンクを最優先で探し、なければ注文詳細リンクを使用
      const allLinks = Array.from(card.querySelectorAll('a[href]'));
      const receiptLink =
        allLinks.find((a) => /領収書/.test(a.textContent || '')) ||
        allLinks.find((a) => /receipt|ryoshusho|invoice/i.test(a.getAttribute('href') || ''));
      const detailLink =
        allLinks.find((a) => /注文詳細|詳細/.test(a.textContent || '')) ||
        allLinks.find((a) => /detail|order/i.test(a.getAttribute('href') || ''));

      const targetLink = receiptLink || detailLink;
      if (!targetLink) continue;

      const href = targetLink.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) continue;

      const url = new URL(href, window.location.origin).href;

      const baseItem = {
        orderId,
        url,
        date: dateStr,
        dateIso,
        priceNum,
        priceStr,
        title: itemTitle
      };
      baseItem.filename = buildFilename(filenameTemplate, baseItem);

      items.push(baseItem);
    }

    return items;
  }

  // 次ページURLを検出
  function getNextPageUrl(doc, currentPage) {
    const selectors = [
      'a[rel="next"]',
      'a[aria-label*="次"]',
      'a[aria-label*="Next"]'
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const href = el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:')) {
          return new URL(href, window.location.origin).href;
        }
      }
    }

    const links = Array.from(doc.querySelectorAll('a[href]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) continue;
      const text = (a.textContent || '').trim();
      if (/^(次のページ|次へ|次|›|»|>)$/.test(text) || /次へ/.test(text)) {
        return new URL(href, window.location.origin).href;
      }
      if (href.includes(`page=${currentPage + 1}`) || href.includes(`p=${currentPage + 1}`)) {
        return new URL(href, window.location.origin).href;
      }
    }

    return null;
  }

  function setRunningState(running) {
    isProcessing = running;
    const scanBtn = document.getElementById('rkt-scan-btn');
    const dlBtn = document.getElementById('rkt-download-selected-btn');
    const cancelBtn = document.getElementById('rkt-cancel-btn');
    const progressWrap = document.getElementById('rkt-progress-wrap');

    scanBtn.disabled = running;
    scanBtn.style.opacity = running ? '0.6' : '1';
    if (dlBtn) {
      dlBtn.disabled = running;
      dlBtn.style.opacity = running ? '0.6' : '1';
    }
    cancelBtn.style.display = running ? 'block' : 'none';
    progressWrap.style.display = running ? 'block' : 'none';
  }

  function updateStatus(text, percent = null) {
    const statusEl = document.getElementById('rkt-status-text');
    const barEl = document.getElementById('rkt-progress-bar');
    if (statusEl) statusEl.textContent = text;
    if (barEl && percent !== null) {
      barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  async function runScanStep(state) {
    isCancelled = false;
    setRunningState(true);
    updateStatus(`スキャン中 (${state.currentPage}ページ目 / 現在 ${state.items.length}件)...`, 0);

    try {
      const downloadedSet = new Set(state.downloadedOrderIds || []);
      const pageOrders = extractOrdersFromDoc(document, {
        filenameTemplate: state.filenameTemplate
      });

      let datedCount = 0;
      let olderThanFromCount = 0;

      for (const order of pageOrders) {
        if (order.dateIso) {
          datedCount++;
          if (state.dateTo && order.dateIso > state.dateTo) continue;
          if (state.dateFrom && order.dateIso < state.dateFrom) {
            olderThanFromCount++;
            continue;
          }
        }

        if (state.skipDownloaded && downloadedSet.has(order.orderId)) {
          state.skippedCount++;
          continue;
        }

        if (!state.items.some((x) => x.orderId === order.orderId)) {
          state.items.push(order);
        }
      }

      const allOlderThanFrom = Boolean(state.dateFrom) && datedCount > 0 && olderThanFromCount === datedCount;
      const nextUrl = getNextPageUrl(document, state.currentPage);
      if (!allOlderThanFrom && state.currentPage < state.maxPages && nextUrl && !isCancelled) {
        const nextState = {
          ...state,
          currentPage: state.currentPage + 1
        };
        updateStatus(`次ページへ移動中 (${state.currentPage}ページ目完了: ${state.items.length}件)...`, 0);
        chrome.storage.local.set({ rktScanState: nextState }, () => {
          setTimeout(() => {
            if (!isCancelled) {
              window.location.href = nextUrl;
            }
          }, 1000);
        });
        return;
      }

      chrome.storage.local.remove('rktScanState');
      setRunningState(false);

      scannedItems = state.items;
      renderPreviewList(scannedItems);

      if (scannedItems.length === 0) {
        const msg = state.skippedCount > 0
          ? `新規対象の注文はありませんでした（取得済みスキップ: ${state.skippedCount}件）`
          : '条件に一致する注文が見つかりませんでした。';
        updateStatus(msg);
      } else {
        updateStatus(`${scannedItems.length}件見つかりました。対象を選んで保存を押してください。`);
      }
    } catch (err) {
      console.error('[楽天領収書PDF] スキャンエラー:', err);
      chrome.storage.local.remove('rktScanState');
      setRunningState(false);
      updateStatus(`エラー: ${err.message}`);
    }
  }

  async function scanOrdersProcess() {
    if (isProcessing) return;

    const dateFrom = document.getElementById('rkt-date-from').value;
    const dateTo = document.getElementById('rkt-date-to').value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      alert('開始日は終了日より前の日付を指定してください。');
      return;
    }

    lastFailedItems = [];
    document.getElementById('rkt-retry-btn').style.display = 'none';

    const { downloadedOrderIds } = await loadSettings();
    const initialState = {
      isScanning: true,
      currentPage: 1,
      maxPages: parseInt(document.getElementById('rkt-fetch-depth').value, 10),
      dateFrom: document.getElementById('rkt-date-from').value,
      dateTo: document.getElementById('rkt-date-to').value,
      filenameTemplate: document.getElementById('rkt-filename-tpl').value.trim() || DEFAULT_SETTINGS.filenameTemplate,
      skipDownloaded: document.getElementById('rkt-skip-downloaded').checked,
      downloadedOrderIds,
      skippedCount: 0,
      items: []
    };

    await runScanStep(initialState);
  }

  async function startDownloadSelected() {
    if (isProcessing) return;

    const checkedIndices = Array.from(document.querySelectorAll('#rkt-preview-list .rkt-item-check:checked'))
      .map((cb) => parseInt(cb.getAttribute('data-index'), 10));
    const selectedItems = checkedIndices.map((idx) => scannedItems[idx]).filter(Boolean);

    if (!selectedItems.length) {
      alert('保存する注文を1件以上選択してください。');
      return;
    }

    await launchDownload(selectedItems);
  }

  async function retryFailedItems() {
    if (isProcessing || !lastFailedItems.length) return;
    await launchDownload([...lastFailedItems]);
  }

  async function launchDownload(itemsToDownload) {
    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }

    const license = await fetchLicenseStatus();
    renderLicenseUI(license);

    if (!license.isPaid && license.remaining <= 0) {
      if (confirm(`今月の無料枠（${license.monthlyLimit}件）を使い切りました。\nProプランにアップグレードしますか？`)) {
        openUpgradePage();
      }
      return;
    }

    let targetItems = itemsToDownload;
    if (!license.isPaid && itemsToDownload.length > license.remaining) {
      const proceed = confirm(
        `選択された注文は ${itemsToDownload.length}件 ですが、今月の無料枠は残り ${license.remaining}件 です。\n` +
        `OK: 最初の ${license.remaining}件 のみ保存する\n` +
        `キャンセル: Proプラン（無制限）の案内を開く`
      );
      if (!proceed) {
        openUpgradePage();
        return;
      }
      targetItems = itemsToDownload.slice(0, license.remaining);
    }

    lastFailedItems = [];
    document.getElementById('rkt-retry-btn').style.display = 'none';
    isCancelled = false;
    setRunningState(true);
    updateStatus(`${targetItems.length}件のPDF生成を開始します...`, 0);

    const exportCsv = license.isPaid && document.getElementById('rkt-export-csv').checked;
    const receiptName = document.getElementById('rkt-receipt-name').value.trim();
    try {
      chrome.runtime.sendMessage({
        action: 'START_DOWNLOAD',
        payload: { items: targetItems, exportCsv, receiptName }
      });
    } catch (_) {
      setRunningState(false);
      handleInvalidContext();
    }
  }

  function cancelBatchProcess() {
    isCancelled = true;
    setRunningState(false);
    updateStatus('中止しました');
    if (isContextValid()) {
      try {
        chrome.storage.local.remove('rktScanState');
        chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD' });
      } catch (_) {}
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PROGRESS_UPDATE') {
      const { current, total, statusText, done, historyCount, licenseStatus, failedItems } = message;
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      updateStatus(statusText, percent);
      if (typeof historyCount === 'number') {
        const countEl = document.getElementById('rkt-history-count');
        if (countEl) countEl.textContent = String(historyCount);
      }
      if (licenseStatus) {
        renderLicenseUI(licenseStatus);
      }
      if (done) {
        setRunningState(false);
        if (Array.isArray(failedItems) && failedItems.length > 0) {
          lastFailedItems = failedItems;
          const retryBtn = document.getElementById('rkt-retry-btn');
          retryBtn.textContent = `失敗した ${failedItems.length}件 を再取得する`;
          retryBtn.style.display = 'block';
        }
      }
    }
  });

  injectControlUI().then(() => {
    if (!isContextValid()) return;
    chrome.storage.local.get(['rktScanState'], (res) => {
      if (res && res.rktScanState && res.rktScanState.isScanning) {
        setTimeout(() => runScanStep(res.rktScanState), 600);
      }
    });
  });
})();
