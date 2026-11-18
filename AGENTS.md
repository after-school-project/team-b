# AGENTS.md

After School Project は、学校・在校生・卒業生をつなぐコミュニティの PoC です。このガイドはリポジトリ全体に適用します。アプリは `web/` にあり、Next.js App Router、React、TypeScript、Better Auth、Drizzle ORM、PostgreSQL 17 を使います。

## 作業範囲と参照先

- 関連 Issue がある場合は作業範囲と受入条件を確認する。PoC の対象と例外は実装ロードマップの決定記録に従い、未決の学校協議事項を実装で確定しない。設計間の食い違いが作業に影響する場合は、決定記録と該当箇所を照合する。[PoC 実装ロードマップ](docs/After_School_Project_PoC実装ロードマップ_v0.2.md#poc-scope) · [要件・設計資料の索引](docs/readme.md)

| 変更対象 | 作業場所と参照先 |
| --- | --- |
| 画面・遷移 | `web/src/app/`。画面 ID、URL、状態と操作条件を確認する。[画面遷移・状態遷移設計書](docs/After_School_Project_PoC_画面遷移・状態遷移設計書_v0.1.md) · [UI デザインガイド](docs/DESIGN.md) |
| 認証・認可 | `web/src/auth/` の設定と、対象のサーバー処理。[技術構成・認証方式決定書](docs/After_School_Project_PoC_技術構成・認証方式決定書_v0.1.md) · [共通認可条件表](docs/After_School_Project_PoC_共通認可条件表_v0.1.md) |
| 業務 API | `web/src/app/api/v1/` に Route Handler を置き、`web/src/api/` の共通処理を使う。[API 設計書](docs/After_School_Project_PoC_API設計書_v0.1.md) · [共通業務 API の使い方](docs/development/common-api.md) |
| DB・開発データ | `web/src/db/` のスキーマ、`web/drizzle/` のマイグレーション、`web/scripts/` の管理・seed 処理。[DB・ER 設計書](docs/After_School_Project_PoC_DB・ER設計書_v0.1.md) · [DB 開発ガイド](docs/development/database.md) |
| CI・公開環境 | `.github/workflows/`、`.github/scripts/`、`web/vercel.json`。[品質チェックと PoC 公開環境](docs/development/quality-and-poc.md) · [Vercel デプロイ制御](docs/development/vercel-deployment.md) |

## AI エージェントの作業原則

- 作業開始時に関連 Issue、設計資料、既存実装、現在のブランチと未コミットの変更を確認する。他者や別エージェントの作業を上書き・削除しない。
- 指定された作業範囲を超える機能追加、大規模なリファクタリング、依存関係・技術構成の変更は、必要性と影響範囲を説明して承認を得る。
- 仕様の矛盾や未決事項が実装に影響する場合は、根拠となる資料と選択肢を示して確認する。推測で仕様や権限を確定しない。
- 既存の Issue・設計資料を、実装に合わせて無断で書き換えない。仕様変更が必要な場合は先に合意を得る。
- 作業用ブランチでの実装・検証を基本とする。`main` への直接 Push、PR のマージ、公開環境の変更、破壊的操作は明示的な承認なしに実行しない。
- 実行していないテストや確認できていない動作を、成功・完了と報告しない。

## 実装時の契約

- アプリの TypeScript は `strict` 設定と既存のスタイルに従う。`@/` は `web/src/` を指す。UI の文言は日本語とし、既存の CSS 構成を尊重する。色・余白・共通部品は [UI デザインガイド](docs/DESIGN.md) を基準に実装し、未定義のデザイントークンは必要に応じて追加する。画面変更ではモバイル表示、キーボード操作、状態ラベルを確認する。
- 認証は学校発行 ID を前提とし、Better Auth の `authOptions()` と `authWebOptions()` を再利用する。公開する認証経路は API 設計書に従う。認可は毎回サーバーで、セッションと DB 上の現在の利用資格、停止・非表示状態、所属・追加管理権限、所有者、対象状態を照合する。非公開項目は DTO から除外し、一覧・検索・件数にも同じ公開条件を適用する。[共通認可条件表](docs/After_School_Project_PoC_共通認可条件表_v0.1.md)
- 業務 API は `defineApiRoute` と共通の入力検証・応答処理を使う。更新は `commitMutation` のロック順、権限確認、版番号、再送の契約に従い、業務更新と付随する通知・履歴・監査を同じトランザクションで扱う。再送時も現在の権限を確認する。[共通業務 API の使い方](docs/development/common-api.md)
- サーバーの通常アクセスは `@/db/client` の `db` と専用アプリロールの `DATABASE_URL` を使う。管理用直接接続はマイグレーション・権限設定などの管理処理に限定する。`audit_logs` のアプリ権限は `SELECT` と `INSERT` に限る。[DB 開発ガイド](docs/development/database.md)
- 認証モデルの変更時は `web/` で `npm run auth:generate` を使う。DB スキーマの変更時は `npm run db:generate` で追加マイグレーションを生成し、適用済み SQL を保持する。生成前後の差分を確認し、手動で追加した定義・制約を失わないことを検証する。生成 SQL・スナップショット・ジャーナルを確認し、新規テーブルがある場合はアプリロールの権限と DB 結合テストも確認する。[生成コマンド](web/package.json) · [Drizzle 設定](web/drizzle.config.ts)

## 起動と検証

- Docker Desktop を起動し、ルートで `docker compose up --build --watch` を実行する。アプリは既定で [http://localhost:3000](http://localhost:3000)。起動時に開発 DB のマイグレーション・権限設定・seed が実行される。通常の停止は `docker compose down` でデータを保持する。[README](README.md)
- ホストで npm を使う場合は `web/` で、[`web/.nvmrc`](web/.nvmrc) の Node.js と [`web/package.json`](web/package.json) の npm を使用し、`npm ci` でインストールする。依存関係の変更は `web/package-lock.json` も確認する。

| 確認対象 | コマンドと前提 |
| --- | --- |
| アプリの lint・型・単体・ビルド | `web/` で `npm run check`。開発 Compose の起動中はルートで `docker compose exec app npm run check` も可。通常の品質チェックには公開環境の接続情報は不要。 |
| DB・権限・更新トランザクション | ルートで `docker compose -p team-b-quality -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests`。終了後は `docker compose -p team-b-quality -f compose.test.yaml down`。並行実行時は `-p` に別の名前を使う。`npm run test:integration` を直接実行する場合は `NODE_ENV=test` と使い捨て DB の `TEST_DATABASE_URL` を設定する。 |
| ブラウザーでのスモーク確認 | `web/` で `npm run test:e2e:install`（初回）と `npm run test:e2e`。Playwright がポート `3100` でビルド済みアプリを起動するため、実行環境から接続できる初期化済みローカル DB とアプリ用ロールが必要。[Playwright 設定](web/playwright.config.ts) |
| デプロイ制御スクリプト | ルートで `node --test .github/scripts/vercel-deploy.test.mjs`。実デプロイや Vercel トークンは不要。 |
| 文書のみ | 記述を実装・設定と照合し、リンクと差分を確認する。 |

単体・DB 結合・E2E のテストはそれぞれ `web/tests/unit/`、`web/tests/integration/`、`web/tests/e2e/` に置く。認可や更新処理の変更では、受入条件に沿って拒否時の返却範囲、競合、再送時の副作用も該当するテストで確認する。PR・`main` の品質 CI はアプリの品質チェックと使い捨て PostgreSQL での結合テストを実行する。[CI 設定](.github/workflows/quality.yml)

## 環境の取り扱いと変更の提出

- ローカル検証には開発用または使い捨てのテスト DB を使う。`db:reset` は開発 Compose の `team_b_dev` を消去する操作なので、明示的にリセットを依頼された場合だけ使う。Neon へのマイグレーション、Vercel のデプロイや設定変更は対象環境と作業範囲が明示された場合に行う。接続文字列、トークン、認証シークレット、seed のパスワード、実利用者データは Git・ログ・チャット・Issue・PR に含めない。[DB 開発ガイド](docs/development/database.md) · [品質チェックと PoC 公開環境](docs/development/quality-and-poc.md)
- 公開版からの差分はパス単位で判定される。現行ルールではルートの `AGENTS.md` もデプロイ判定の対象。公開確認を行う場合は GitHub Actions の要求結果に加え、Vercel で対象 SHA の `Ready` と公開反映を確認する。[Vercel デプロイ制御](docs/development/vercel-deployment.md)
- ブランチは原則 `codex/<Issue番号>-<変更の要約>`。提出は PR 経由とし、コミットは `type: 変更内容`、PR タイトルは `type: #Issue番号 変更内容` で日本語の変更内容を書く。PR 本文には受入条件に対応する確認内容と結果を記載し、未実施の項目には理由を添える。[CONTRIBUTING](CONTRIBUTING.md) · [PR 作成ガイド](docs/development/pull-request-guide.md) · [PR テンプレート](.github/pull_request_template.md)

## 作業完了時の報告

作業終了時は日本語で、次の内容を簡潔に報告する。

1. 対象 Issue と実施内容
2. 主な変更ファイルと変更理由
3. 実行したテスト・動作確認とその結果
4. 未実施のテスト・確認と理由
5. 未解決事項・残存リスク
6. 作成した PR の URL（作成した場合）

部分実装、テスト未実施、環境依存で未確認の内容を完了済みとして扱わない。
