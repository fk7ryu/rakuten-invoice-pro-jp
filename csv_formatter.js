// 会計ソフト別CSVフォーマッタ（標準 / freee / マネーフォワード / 弥生会計）

function escapeCsvCell(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toSlashDate(item) {
  if (item.dateIso) return item.dateIso.replace(/-/g, '/');
  if (item.date && /^\d{8}$/.test(item.date)) {
    return `${item.date.slice(0, 4)}/${item.date.slice(4, 6)}/${item.date.slice(6, 8)}`;
  }
  return item.date || '';
}

function toHyphenDate(item) {
  if (item.dateIso) return item.dateIso;
  if (item.date && /^\d{8}$/.test(item.date)) {
    return `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-${item.date.slice(6, 8)}`;
  }
  return item.date || '';
}

/**
 * 指定フォーマットのCSVテキストを生成
 * @param {Array} items - 完了した注文アイテム一覧
 * @param {'standard'|'freee'|'mf'|'yayoi'} format - 出力形式
 * @param {string} vendorName - 取引先名（例: 'Amazon.co.jp' / '楽天市場'）
 */
function buildFormattedCsv(items, format, vendorName) {
  let header = [];
  let rows = [];
  let fileSuffix = '一覧';

  if (format === 'freee') {
    // freee会計「エクセルインポート（取引）」準拠フォーマット
    fileSuffix = 'freee用';
    header = ['収支区分', '管理番号', '発生日', '決済期日', '取引先', '勘定科目', '税区分', '金額', '税計算区分', '税額', '備考', '品目', '部門', 'メモタグ'];
    rows = items.map((it) => [
      '支出',
      it.orderId,
      toHyphenDate(it),
      '',
      vendorName,
      '消耗品費',
      '課対仕入10%',
      it.priceNum || '0',
      '内税',
      '',
      `${it.orderId} ${it.title || ''}`.trim().slice(0, 100),
      '',
      '',
      vendorName
    ]);
  } else if (format === 'mf') {
    // マネーフォワード クラウド会計「仕訳帳インポート」準拠フォーマット
    fileSuffix = 'マネーフォワード用';
    header = ['取引No', '取引日', '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '摘要', 'メモ'];
    rows = items.map((it, idx) => [
      String(idx + 1),
      toSlashDate(it),
      '消耗品費',
      '',
      '',
      vendorName,
      '課仕 10%',
      '',
      it.priceNum || '0',
      '未払金',
      '',
      '',
      vendorName,
      '対象外',
      '',
      it.priceNum || '0',
      `${vendorName} (${it.orderId}) ${it.title || ''}`.trim().slice(0, 100),
      it.filename || ''
    ]);
  } else if (format === 'yayoi') {
    // 弥生会計 仕訳インポート形式（主要項目）
    fileSuffix = '弥生会計用';
    header = ['識別フラグ', '伝票No.', '決算', '取引日付', '借方勘定科目', '借方補助科目', '借方部門', '借方税区分', '借方金額', '借方税金額', '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方税区分', '貸方金額', '貸方税金額', '摘要'];
    rows = items.map((it, idx) => [
      '2000',
      String(idx + 1),
      '',
      toSlashDate(it),
      '消耗品費',
      '',
      '',
      '課対仕入10%',
      it.priceNum || '0',
      '',
      '未払金',
      '',
      '',
      '対象外',
      it.priceNum || '0',
      '',
      `${vendorName} ${it.orderId} ${it.title || ''}`.trim().slice(0, 64)
    ]);
  } else {
    // 標準サマリー形式
    fileSuffix = '一覧';
    header = ['注文日', '注文番号', '金額(円)', '商品名', 'PDF種別', '保存ファイル名', '領収書URL'];
    rows = items.map((it) => [
      toHyphenDate(it),
      it.orderId,
      it.priceNum || '0',
      it.title || '',
      it.pdfType || '',
      it.filename || '',
      it.url || ''
    ]);
  }

  const csvText = [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n');

  return { csvText, fileSuffix };
}
