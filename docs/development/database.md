# DB接続・権限・ローカル初期化

## アプリ用と管理用の接続

サーバー処理は `web/src/db/client.ts` の `db` を使用します。`server-only` によりクライアントコンポーネントからの読み込みを拒否します。`DATABASE_URL` だけを参照し、管理用URLへフォールバックしません。

```ts
import { db } from "@/db/client";
import { qaCategories } from "@/db/schema";

const categories = await db.select().from(qaCategories);
```

pgの接続プールはプロセスごとに最大5接続、接続待ちは10秒、SQLは15秒、アイドル接続は30秒で切断します。開発時の再読み込みでは同じプールを再利用します。リクエスト終了時に `pool.end()` を呼ばないでください。URL変更時はサーバーを再起動します。Neonではプール接続URLを使用します。複数プロセス・インスタンス間でプールは共有されません。

ローカルは `db` / `localhost` / loopbackへの非TLS接続、NeonはTLS必須です。Neonの `sslmode=require` / `verify-full` はいずれも証明書・ホスト名を検証する設定へ変換します。任意のSSL上書きパラメーターは拒否します。接続文字列・ドライバーの生例外は管理コマンドのログに出しません。

Next.jsサーバー起動時は接続とアプリ用ロールの権限を検査し、設定不足や過剰権限では起動を停止します。通常の型チェック・ビルドにはDB接続情報は不要です。アプリ起動・E2E確認にはDBと権限設定が必要です。

| 接続・コマンド | 用途 |
|---|---|
| `DATABASE_URL` | アプリ専用ロールによる通常の読み書き |
| `DATABASE_URL_DIRECT` | 所有者・管理ロールの直接接続。マイグレーション、権限設定、ローカルseed |
| `npm run db:migrate` | 管理権限の検査後に全マイグレーションを適用 |
| `npm run db:permissions` | `APP_DATABASE_ROLE` に既存31テーブルの権限を設定 |
| `npm run db:setup` | ローカルのマイグレーション → ロール作成・権限設定 → seed |
| `npm run db:seed` | ローカルseedのみ。既存アカウントやサンプルは維持 |
| `npm run db:reset` | ローカルDBを明示消去 → マイグレーション → 権限設定 → seed |

アプリロールはスキーマ・テーブル・DBの所有者にせず、管理権限や他ロールへの所属を与えません。既存テーブルにはSELECT / INSERT / UPDATE / DELETEのみを付与し、`audit_logs` はSELECT / INSERTのみです。CREATE、ALTER、DROP、TRUNCATE、一時テーブル作成、マイグレーション管理表へのアクセスを許可しません。PUBLICからもスキーマ作成・DBのCREATE/TEMP権限を外します。このDBはアプリ専用としてください。将来テーブルを追加したら、マイグレーション後に権限コマンドを再実行します。将来のテーブルへの包括的な既定GRANTは設けません。

## 学校発行アカウントの初期発行

開発担当者は、対象DBのマイグレーションを適用したうえで、`web/` から実行します。`DATABASE_URL_DIRECT`、`BETTER_AUTH_URL`、`BETTER_AUTH_SECRET` を対象環境用に設定します。Neonの場合は管理用マイグレーションと同じ接続先照合の設定も必要です。

```sh
npm run account:issue -- --input <発行情報JSON> --output <新規の受渡用JSON>
```

発行情報JSONの例です。学校による利用資格確認が済んだ架空のアカウントに使います。

```json
{
  "username": "poc_new_staff",
  "displayName": "架空の職員",
  "baseRole": "staff",
  "schoolManager": true,
  "appManager": false,
  "schoolVerified": true,
  "privateRealName": "架空の本人確認名",
  "schoolReference": "DEMO-STAFF-01"
}
```

`baseRole` は `student`・`alumni`・`staff` のいずれかです。学校管理者は `staff` のみ、任意の `isGraduating` を `true` にできるのは `student` のみです。`verificationNote`、`department`、`entryYear`、`graduationYear` も任意で指定できます。

入力・出力とも、リポジトリ外の実行者だけがアクセスできる場所を指定してください。正常終了後、出力JSONのログインIDとパスワードを対象者に個別に渡します。出力ファイルは新規作成され、既存ファイルとの衝突や同じログインIDの再実行時はエラーになります。Windowsでは出力先フォルダーのアクセス権も確認してください。

## ローカルの停止・再起動・リセット

```sh
# データを保持して停止
docker compose down

# 既存データ・権限・開発用パスワードを保持して再起動
docker compose up --build --watch

# 明示的な初期状態への復元（DB起動後、処理中リクエストがない状態で実行）
docker compose exec app npm run db:reset

# appが停止している場合も、DBを起動して同じリセットを実行できる
docker compose run --rm app npm run db:reset
```

リセットは `public` と `drizzle` のスキーマを削除し、全マイグレーション、権限設定、seedの順に実行します。架空アカウント10件、カテゴリ4件、プロフィール、Q&A、お知らせ・イベントの公開版と申請、通報・証拠、通知、監査などを再作成します。手動で追加したデータやアカウントの変更は消去されます。`.seed/accounts.json` は保持し、開発用パスワードを再利用します。ファイルがない場合だけ生成します。

URLはローカルの `team_b:5432/team_b_dev` に限定し、実接続先のDB名とロールも照合します。リセットには `NODE_ENV=development` とCompose内の `LOCAL_DATABASE_RESET=team-b-compose-local` が必要です。Production、Vercel、Neon、異なるDB・ロール・ポート、URLへの追加パラメーターでは実行できません。これらの設定をPoC環境へコピーしないでください。

通常起動・リセット・マイグレーションは同じadvisory lockで直列化します。リセット開始後にマイグレーションやseedが失敗した場合、部分的な初期化状態になることがあります。原因を修正してリセットを再実行してください。通常の停止に `docker compose down --volumes` は使用しません。

## Neonの専用アプリロール

公開先の権限切り替えはデプロイ前に実施します。既存のNeon管理ロールの権限を削る操作はしません。

1. 管理用接続でマイグレーションを適用します。従来の [Neon専用コンテナ](../../.env.neon.example) の `DATABASE_URL_DIRECT` は管理用のままにします。
2. Neon SQL Editorまたは安全な管理クライアントで、SQLから `team_b_app` を作成します。`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` を指定し、他ロールへの所属・所有権を与えません。パスワードは安全な管理クライアントで設定し、履歴・ログ・チャットに残さずSecretへ保存します。Neon Console/APIで作成した既定の管理ロールをアプリへ流用しません。
3. `.env.neon.local` に `APP_DATABASE_ROLE=team_b_app` を追加し、次を実行します。パスワードはこのコマンドに渡しません。管理URLとロールの状態を検査した後、権限を設定します。

```sh
docker compose -f compose.neon.yaml build migrate
docker compose -f compose.neon.yaml run --rm --no-deps migrate npm run db:permissions
```

4. Vercel Productionの `DATABASE_URL` を同じDBの `team_b_app` のプール接続URLに変更します。`DATABASE_URL_DIRECT`（または `DATABASE_URL_UNPOOLED`）は別の管理ロールの直接接続を維持します。両URLのロールが同じ場合、Productionの設定検証は失敗します。
5. Productionビルドの `poc:verify` と起動時の権限検査が成功することを確認します。`poc:verify` は専用カテゴリ行のINSERT / UPDATE / SELECT / DELETEをトランザクション内で行い、必ずロールバックします。既存カテゴリは変更しません。管理用 `--database-only` は従来の一時テーブル確認です。

NeonのConsole/APIで作るロールには `neon_superuser` 所属が付くため、制限付きアプリロールはSQLで作成します。[Neon公式のロール管理](https://github.com/neondatabase/website/blob/main/content/docs/manage/roles.md)を参照してください。

## 制約・権限の検証

```sh
docker compose -p team-b-issue5-test -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p team-b-issue5-test -f compose.test.yaml down
```

使い捨てPostgreSQL 17の `team_b_test` クラスタ内に空の検証DBを作り、31テーブルの主キー、複合外部キー、不正データのCHECK、一意制約、pendingの部分UNIQUE、一覧・審査・通知・管理索引、実接続での権限拒否、再読み込み時のプール再利用を検証します。同じクラスタ内に開発Compose相当のDBとロールを再現し、通常再起動のデータ保持、リセットの再現性、主要seedとパスワードの維持も確認します。通常開発DBやNeonには接続しません。

索引は [DB・ER設計書](../After_School_Project_PoC_DB・ER設計書_v0.1.md)6節と照合します。認証テーブルはBetter Auth生成モデルの物理名（`user` / `session` / `account` / `verification` / `rate_limit`）を使用します。各機能固有の認可・DB操作、RLS、本番の物理消去は後続工程です。

接続・権限の実装根拠: [pgのSSL設定](https://node-postgres.com/features/ssl)、[pg.Pool](https://node-postgres.com/apis/pool)、[PostgreSQL 17の権限](https://www.postgresql.org/docs/17/ddl-priv.html)。
