# team-b

After School Project のローカル開発環境です。

## 起動

Docker Desktop を起動して、リポジトリのルートで実行します。Node.js 24 と PostgreSQL 17 は Compose が起動します。

```sh
docker compose up --build --watch
```

[http://localhost:3000](http://localhost:3000) で `web/` の Next.js アプリを開けます。
PostgreSQL の準備ができると、アプリコンテナが Drizzle マイグレーションと seed を実行してから起動します。
`web/src` の変更は Compose Watch で同期されます。依存関係、マイグレーション、初期化スクリプトの変更時は再ビルドされます。
ポートを変更する場合は、`.env.example` を `.env` にコピーして `APP_PORT` を変更してください。

## 開発用データ

マイグレーションはDB・ER設計書の31テーブルを作成します。既存の開発DBにも次回の起動時に追加分が適用されます。
seed は架空アカウント10件、Q&Aカテゴリ4件に加え、プロフィール、Q&Aの質問とスレッド、お知らせとイベントの公開版・申請、通報・証拠、通知、監査などのサンプルを投入します。
認証セッションや認証の回数制限などのテーブルには、開発中の操作に応じてデータが入ります。

| ログインID | 状態 |
|---|---|
| `poc_s001` / `poc_s002` | 在校生 / 卒業予定の在校生 |
| `poc_a001` / `poc_staff` | 卒業生 / 学校職員 |
| `poc_school` | 学校管理者 |
| `poc_s_mgr` / `poc_a_mgr` / `poc_staff_mgr` | 在校生・卒業生・学校職員のアプリ管理者 |
| `poc_hidden` / `poc_suspended` | プロフィール再公開審査待ち / アカウント停止中 |

開発用パスワードは初回に個別生成されます。アカウントとパスワードの一覧は、起動後に自分のローカル環境で確認できます。

```sh
docker compose exec app cat /app/.seed/accounts.json
```

PostgreSQL のデータと開発用パスワードは名前付きボリュームに保存されます。通常の再起動では既存アカウント・権限・パスワードが維持されます。
ログイン画面と業務機能はロードマップの後続工程です。

## 停止と確認

```sh
docker compose logs app
docker compose exec app npm run lint
docker compose exec app npm run typecheck
docker compose down
```

## 開発ガイド・設計資料

Issue・PRの作成、ブランチ、コミット、レビュー・マージのルールは[開発・コントリビューションガイド](./CONTRIBUTING.md)を参照してください。

設計資料と詳細ガイドは[ドキュメント案内](./docs/readme.md)にまとまっています。
