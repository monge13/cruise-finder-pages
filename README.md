# Cruise Finder Pages

GitHub Pagesで公開する、クルーズ旅行比較用の静的サイトです。

公開ページは `index.html` です。データは `cruises.json` を正とし、更新スクリプトが `index.html` 内の `DATA` に埋め込みます。

## ファイル構成

- `index.html`: GitHub Pagesで公開する本体。データも埋め込み済み。
- `cruises.json`: クルーズ一覧の正データ。
- `cruises.csv`: 表計算確認用のデータ。
- `affiliate_links.csv`: バリューコマースなどのアフィリエイトURL登録用テンプレ。
- `import_best1_cruises.mjs`: ベストワンクルーズの一覧APIから取得。
- `import_partner_cruises.mjs`: BUTEを巡回取得し、クルーズプラネットの確認済み詳細ページを取り込む。
- `update_cruises.mjs`: 掲載URLの到達確認と `lastChecked` 更新。
- `apply_affiliate_links.mjs`: `affiliate_links.csv` の `affiliateUrl` をデータとHTMLへ反映。
- `.github/workflows/update-cruises.yml`: 月1自動更新と手動更新用のGitHub Actions。

## 通常更新

ローカルで更新する場合:

```sh
npm run import:best1
npm run import:partners
npm run update
npm run affiliate
```

`npm run import:best1` はベストワンクルーズ、`npm run import:partners` はBUTEとクルーズプラネット由来のデータを取り込みます。船名と出発日が同じものは重複とみなし、最安値の掲載元だけを残します。

`npm run update` は各 `bookingUrl` / `sourceUrl` にアクセスし、到達可否、HTTPステータス、ページタイトル、最終確認日を更新します。

`npm run affiliate` は `affiliate_links.csv` の `affiliateUrl` を `cruises.json`、`cruises.csv`、`index.html` に反映します。

## GitHub Actions

毎月1日に自動実行します。GitHubの `Actions` タブから `Update cruise finder` を手動実行することもできます。

Actionsの処理:

1. `npm run import:best1`
2. `npm run import:partners`
3. `npm run update`
4. `npm run affiliate`
5. 変更があれば `index.html` / `cruises.json` / `cruises.csv` / `affiliate_links.csv` を自動コミット

GitHub Pagesは `main` ブランチのルートを公開対象にします。

## アフィリエイト登録

バリューコマースのMyLinkなどで広告リンクを発行し、`affiliate_links.csv` の `affiliateUrl` に貼ります。

```csv
source,title,bookingUrl,affiliateUrl,memo
阪急交通社,飛鳥III 日本周遊クルーズ,https://...,https://ck.jp.ap.valuecommerce.com/...,バリューコマースのMyLinkなどで発行したURLをaffiliateUrlに貼る
```

反映:

```sh
npm run affiliate
```

画面の `詳細・予約へ` ボタンは `affiliateUrl` があればそれを優先し、空欄なら `bookingUrl` に飛びます。`sourceUrl` が同じURLの場合は、余計な `掲載元を見る` ボタンは表示しません。

## データ設計

重要な項目:

- `bookingUrl`: ユーザーを送る通常の詳細・予約URL。
- `affiliateUrl`: アフィリエイトURL。空欄可。
- `sourceUrl`: 掲載元確認用URL。`bookingUrl` と同じなら画面には出さない。
- `clubRoom`: 飛鳥スイート以上、グリル級、コンシェルジュ/スイート級などをまとめた「クラブルーム級」絞り込み用フラグ。
- `clubRoomLabel`: 画面に表示する上位客室の目安。
- `clubRoomNote`: 客室分類の補足。正確な客室名・特典は販売会社側で確認する。
- `lastChecked`: 自動/手動更新で確認した日付。
- `sourceReachable`: 掲載URLに到達できたか。
- `updateNote`: 更新結果の補足。

クルーズ販売サイトはURL構造や掲載状況が変わりやすいので、商品詳細URLが取れない場合は、該当船・該当方面の特集/検索結果ページを入れます。トップページだけを入れるのは避けます。

## デザイン方針

一休のような比較しやすさを意識しつつ、派手にしすぎない静的サイトです。

- カード一覧、フィルタ、価格、日程を優先。
- 日程は `2026-06-13（土） から` / `2026-06-21（日）` の2行表記に統一。
- ボタンは `詳細・予約へ` を主導線にする。
- 船会社ごとの上位客室名はばらつくため、UI上は `クラブルーム級` でまとめる。
- デザイン変更は、余白、影、線、見出し色、CTA程度に留める。
- スマホ幅で横スクロールが出ないことを確認する。

## 注意

価格、空席、寄港地、子ども条件は変わります。サイト上では比較と導線提供に留め、予約前の最終確認は販売会社ページに任せます。
