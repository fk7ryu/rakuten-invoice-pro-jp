const planStatusEl = document.getElementById('plan-status');
const upgradeBtn = document.getElementById('upgrade-btn');
const restoreBtn = document.getElementById('restore-btn');
const devToggleBtn = document.getElementById('dev-toggle-btn');

// ライセンス状態を表示
function refreshLicenseUI() {
  chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (res) => {
    if (!res) return;

    if (res.isPaid) {
      planStatusEl.textContent = '✨ Proプラン（無制限＋会計CSV有効）';
      planStatusEl.classList.add('pro');
      upgradeBtn.style.display = 'none';
      restoreBtn.style.display = 'none';
    } else {
      planStatusEl.textContent = `無料プラン（今月残り ${res.remaining}/${res.monthlyLimit}件）`;
      planStatusEl.classList.remove('pro');
      upgradeBtn.style.display = 'block';
      restoreBtn.style.display = 'block';
    }

    devToggleBtn.style.display = res.isUnpackedDev ? 'block' : 'none';
  });
}

document.getElementById('open-orders').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://order.my.rakuten.co.jp/' });
});

document.getElementById('open-guide').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

upgradeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'OPEN_PAYMENT_PAGE' }, (res) => {
    if (res && !res.ok && res.reason === 'NOT_CONFIGURED') {
      alert(
        'ExtensionPay ID（EXTPAY_EXTENSION_ID）が未設定です。\n' +
        'テストする場合は下の「[開発用] Pro / Free 切替」ボタンをお使いください。'
      );
    }
  });
});

restoreBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'OPEN_LOGIN_PAGE' }, (res) => {
    if (res && !res.ok && res.reason === 'NOT_CONFIGURED') {
      alert('ExtensionPay ID（EXTPAY_EXTENSION_ID）を設定するとライセンス復元が有効になります。');
    }
  });
});

devToggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'TOGGLE_DEV_PRO' }, () => {
    refreshLicenseUI();
  });
});

refreshLicenseUI();
