// 外部ライブラリ不要の標準ZIPビルダー（Store方式 / UTF-8ファイル名完全対応）
// Chrome拡張機能の Service Worker (Manifest V3) 内でそのまま動作します

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function calcCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS 形式の日時（2バイト時刻＋2バイト日付）に変換
function getDosDateTime(date = new Date()) {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const year = Math.max(1980, date.getFullYear());
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * 複数ファイル（{ name: string, data: Uint8Array }[]）から標準ZIPバイナリ（Uint8Array）を生成
 */
function buildZipArchive(entries) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = getDosDateTime(new Date());

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // 同名ファイルの重複を回避
  const usedNames = new Map();

  for (const entry of entries) {
    let safeName = String(entry.name || 'file.bin').replace(/^\/+/, '');
    if (usedNames.has(safeName)) {
      const count = usedNames.get(safeName) + 1;
      usedNames.set(safeName, count);
      const dotIdx = safeName.lastIndexOf('.');
      safeName = dotIdx > 0
        ? `${safeName.slice(0, dotIdx)}_${count}${safeName.slice(dotIdx)}`
        : `${safeName}_${count}`;
    } else {
      usedNames.set(safeName, 1);
    }

    const nameBytes = encoder.encode(safeName);
    const dataBytes = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = calcCrc32(dataBytes);
    const size = dataBytes.length;

    // ローカルファイルヘッダ (30 bytes + name)
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true); // シグネチャ
    lv.setUint16(4, 20, true);         // 必要バージョン 2.0
    lv.setUint16(6, 0x0800, true);     // UTF-8 ファイル名フラグ
    lv.setUint16(8, 0, true);          // 圧縮方式: 0 (Store)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(localHeader, 30).set(nameBytes);

    localParts.push(new Uint8Array(localHeader), dataBytes);

    // セントラルディレクトリヘッダ (46 bytes + name)
    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    new Uint8Array(centralHeader, 46).set(nameBytes);

    centralParts.push(new Uint8Array(centralHeader));
    offset += 30 + nameBytes.length + size;
  }

  const centralSize = centralParts.reduce((sum, arr) => sum + arr.length, 0);

  // エンドオブセントラルディレクトリレコード (22 bytes)
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + 22;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    output.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    output.set(part, pos);
    pos += part.length;
  }
  output.set(new Uint8Array(eocd), pos);
  return output;
}
