# Chrome Web Store 公開・審査申請ガイド（楽天版）

## 1. 公開前の必須チェックリスト
- [ ] [ExtensionPay](https://extensionpay.com/) で楽天版の拡張機能ID（例: `rakuten-invoice-pro-jp`）を作成し、`background.js` 4行目の `EXTPAY_EXTENSION_ID` を本番IDに書き換える（書き換え後にZIPを再作成する）
- [ ] スクリーンショット（1280×800 または 640×400、JPEG）を1〜2枚撮影してアップロードする
- [ ] プロモーションタイル（`store_assets/promo_tile_440x280.jpg`）をアップロードする

---

## 2. ストア掲載用テキスト（コピペ用）

### タイトル
`楽天領収書一括ダウンローダー - 公式PDF・CSV自動保存`

### 概要（132文字以内）
`楽天市場の購入履歴から公式領収書PDFを一括保存！宛名自動入力、日付・金額での自動リネーム、期間指定、注文一覧CSV出力に対応し、確定申告や経理作業を効率化します。`

### 詳細説明
```text
確定申告や月次経理、経費精算で毎回楽天市場の購入履歴から注文詳細を開いて領収書を1枚ずつ発行・保存・リネームする作業をワンクリックで自動化します。

【主な機能】
■ 楽天公式領収書PDFの一括保存
・指定したページ数や期間（開始日〜終了日）の注文をスキャンし、チェックした注文だけをまとめてPDF保存します。
・宛名入力が必要な未発行の注文も、設定した宛名を自動入力して「発行する」を実行します。

■ 会計ソフト向けにファイル名を自動リネーム
・「20261117_5100円_Rakuten_注文番号.pdf」のように日付・金額・注文番号を含めたファイル名で自動整理されます。
・{date} {price} {orderId} {title} {year} などの変数やプリセットで自由な命名ルール・月別フォルダ分けが可能です。

■ 取得済み注文のスキップ＆検索フィルタ
・一度保存した注文番号を記録し、毎月の経理作業での重複ダウンロードを防ぎます。
・スキャン結果から商品名・注文番号で絞り込み検索ができます。

■ 注文一覧CSVの同時出力（Proプラン）
・保存した全注文の「注文日・注文番号・金額・商品名・保存ファイル名」をまとめたUTF-8（BOM付き）CSVファイルを出力します。Excelで文字化けせずそのまま開けます。

【料金プラン】
・無料プラン：月10件までPDF一括保存が可能
・Proプラン：PDF保存無制限 ＋ 注文一覧CSV出力

【プライバシーとセキュリティ】
・購入履歴や領収書データはすべてお客様のブラウザ内のみで処理され、外部サーバーへ送信・保存されることは一切ありません。
```

---

## 3. 審査フォーム用回答テンプレート（権限・単一目的）

### Single purpose description（単一目的の説明）
> Batch-collects order receipts and invoices from Rakuten (order.my.rakuten.co.jp) purchase history pages, saves them as PDF files with customizable filenames, and optionally exports a summary CSV for bookkeeping.

### Permission justifications（各権限の理由）
- **`downloads`**
  - Used to save downloaded/generated receipt PDF files and the summary CSV file directly into the user's Downloads folder with formatted filenames.
- **`storage`**
  - Used to persist user preferences (recipient name, filename template, date filters), downloaded order IDs to prevent duplicates, and monthly free-tier usage count locally.
- **`tabs`**
  - Used to open order detail and receipt pages sequentially in a background tab so receipts can be issued and exported as PDFs.
- **`debugger`**
  - Used solely to automate issuing receipts and invoke `Page.printToPDF` / intercept PDF responses on the temporary background order tab without triggering interactive print dialogs. The debugger is detached immediately after processing and never inspects or transmits user browsing data.
- **`notifications`**
  - Used to notify the user when a batch PDF download job completes or encounters an error.
- **`host_permissions` (`https://order.my.rakuten.co.jp/*`, `https://*.rakuten.co.jp/*`)**
  - Required to read order metadata (date, order ID, price, detail URL) from Rakuten purchase history pages and fetch/issue receipt PDFs using the user's authenticated session.
