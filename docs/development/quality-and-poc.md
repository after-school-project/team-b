# 品質チェックとPoC公開環境

## 品質チェック

[quality.yml](../../.github/workflows/quality.yml) は全PRと `main` へのpushで実行します。手動実行にも対応します。

| ジョブ | 確認内容 |
|---|---|
| Lint, types, unit tests and build | `npm ci` → lint → typecheck → 単体テスト → 本番ビルド |
| PostgreSQL integration tests | `npm ci` → 使い捨てPostgreSQL 17でDB結合テスト |

Node.jsは `web/.nvmrc` の24.x固定版、依存関係は `web/package-lock.json` を使用します。いずれかのコマンドが失敗するとジョブも失敗します。実行中の同じPRへの更新は古い検査を中止します。

CIはGitHub/Vercel/NeonのSecretsを参照しません。DBジョブの認証情報は実行ごとに破棄するローカルサービス専用です。forkのPRも公開環境の資格情報を使わず検査できます。

ローカルではアプリコンテナで `npm run check`、DB結合テストは専用Composeを使います。

```sh
docker compose exec app npm run check
docker compose -p team-b-quality -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p team-b-quality -f compose.test.yaml down
```

通常開発用のComposeと異なるプロジェクト名にしてください。テストDBはtmpfs上にあり、停止時に破棄されます。

## 接続済みの公開環境

| 項目 | 接続先・設定 |
|---|---|
| Vercel | [tku-labs / after-school-project](https://vercel.com/tku-labs/after-school-project) |
| PoC公開URL | [after-school-project-two.vercel.app](https://after-school-project-two.vercel.app/) |
| Git / Root Directory | `after-school-project/team-b` の `main` / `web` |
| Neon | `after-school-project-db`（Productionのみ接続） |
| ローカルDB | Compose専用の `team_b_dev`。Neonへ接続しない |

新規プロジェクト・DBの作成は不要です。PoC公開先はVercel上のProductionですが、実利用向けの本番環境ではありません。

## マージ前に確認する環境変数

Vercelの [Environment Variables](https://vercel.com/tku-labs/after-school-project/settings/environment-variables) でProduction向けに設定します。秘密値はチャット・Issue・PR・Gitへ記載しません。**本変更からProductionのビルド前に下表の設定を検証するため、不足したままマージすると新しいデプロイは失敗します。**

| 変数 | 型 | 用途 |
|---|---|---|
| `DATABASE_URL` | Secret | Neon連携のアプリ用接続。TLS必須 |
| `DATABASE_URL_UNPOOLED` | Secret | Neon連携の直接接続。`DATABASE_URL_DIRECT` でも受け付ける |
| `BETTER_AUTH_SECRET` | Secret | 32文字以上のランダムな値。ローカル開発用と異なる値を使用 |
| `BETTER_AUTH_URL` | Config | `https://after-school-project-two.vercel.app` |

Neon連携が登録した接続URLを読み出し・複製する必要はありません。管理用のローカルマイグレーションコマンドでは従来どおり `.env.neon.local` の `DATABASE_URL_DIRECT` を使います。

ProductionのDB接続・秘密値はPreview/DevelopmentやGitHub Actionsへコピーしません。Previewは現時点では最小ページとビルドの確認用です。業務機能でDBが必要になった時点で別のPreview用DB・秘密値を用意してください。

## Vercel上での読み書き確認

`web/vercel.json` のビルドコマンドは `npm run poc:verify && npm run build` です。

Productionでは、接続URL・HTTPS正規URL・認証秘密値の設定、TLSの実接続、31テーブル、一時テーブルへの書き込み・読み取り・後片付けを確認します。アプリ用の `DATABASE_URL` を使用し、管理用接続で代用しません。どれかが失敗するとビルドへ進みません。URL・秘密値・DBの生例外・行データはログに出力しません。

一時テーブルは専用接続のトランザクション内で作り、commitで破棄します。失敗時もrollback・切断で破棄します。業務テーブル・認証セッションの作成や更新、マイグレーション・seedは行いません。接続ロールにはDBのTEMP権限が必要です。通常のアプリ用共通DBクライアントと権限分離の整備は #5 で行います。

Previewとローカルビルドではこの確認を省略し、Productionの資格情報を要求しません。したがって、Previewの成功はProductionのDB接続確認を意味しません。

管理者の手元から既存Neonの接続・マイグレーション履歴・一時テーブル読み書きを確認する場合は、次を実行できます。

```sh
docker compose -f compose.neon.yaml build migrate
docker compose -f compose.neon.yaml run --rm --no-deps migrate npm run poc:verify -- --database-only
```

これはローカルからの**管理用接続**の確認です。Vercel上のアプリ用接続確認とは区別してください。`--database-only` はVercel上では拒否します。

## デプロイと受入確認

1. PRの品質チェック2ジョブとPreviewの成功を確認します。CIの失敗を検証する場合は検証ブランチへ一時的なlint/型エラーを追加し、失敗したActions URLを記録してから変更を取り除きます。
2. 上記のProduction環境変数を確認してから、レビュー・承認を経てマージします。
3. [Vercelデプロイ制御の手順](./vercel-deployment.md) に沿ってActionsの要求対象SHAとVercelのデプロイを照合します。品質チェックとデプロイ要求は独立したワークフローです。必須チェックの設定は #4 の対象外です。
4. VercelのBuild Logsに `PoC DB確認成功` があり、ビルドと公開がReadyになったことを確認します。Actionsの要求成功だけではDB接続・ビルド成功と判断しません。
5. PoC公開URLで最小ページを確認します。HTML・ログ・Git差分に秘密値が含まれないことを確認します。
6. ローカルがCompose DB、公開先がNeonで、認証秘密値が別であることを確認します。実際のCookie・セッションの相互拒否は #6 の認証実装後に確認します。現在の最小ページにはログイン機能がありません。

環境変数を変更した場合、既存のデプロイへは反映されません。最新mainを `force` 付きで再デプロイする手順と、失敗時の復旧は [Vercelデプロイ制御](./vercel-deployment.md#再実行障害復旧) を参照してください。

## Issue #4 の確認記録（2026-11-17）

- ブラウザーで既存ProductionがReady、公開SHAが `7e55be7`、PoC公開URLに最小ページが表示されることを確認。
- Vercel Storageで `after-school-project-db` がAvailable、対象プロジェクトのProductionへ接続されていることを確認。
- Vercel環境変数一覧で `DATABASE_URL`・`DATABASE_URL_UNPOOLED` がSecret / Productionとして登録済みであることを確認。値は開示・取得していない。
- 利用者による登録後、同一覧で `BETTER_AUTH_SECRET` がSecret / Production、`BETTER_AUTH_URL` がConfig / Productionとして登録済みであることを確認。秘密値は取得していない。
- ローカルから証明書・ホスト名検証付きTLSでNeonへ接続し、31テーブル・マイグレーション3件、一時テーブルの書き込み・読み取り・後片付けを確認。これはVercelからの実行確認ではない。
- VercelのDBデータエディターは追加認証が必要だったため、データエディターでの操作は未実施。
- Vercel上での新しい検証処理の実行と、登録値の検証はレビュー・マージ後に残る。公開環境の切り替えやProductionの秘密値のPreviewへの複製は行っていない。Issue全体の完了とはしない。

| 受入条件 | 確認結果 |
|---|---|
| AC-01 | PRで品質CIが自動実行されることを確認。mainでの初回実行はマージ後に確認する |
| AC-02 | [lintエラー](https://github.com/after-school-project/team-b/actions/runs/44027434463)と[型エラー](https://github.com/after-school-project/team-b/actions/runs/44027726835)の両方で、該当ステップとワークフロー全体の失敗を確認。検証ファイルは最終差分から削除 |
| AC-03 | Docker・GitHub Actionsの双方でlockfileからの `npm ci` が成功 |
| AC-04 | 既存の公開URLでHTTP 200と日本語の最小ページを確認 |
| AC-05 | ローカル→Neonは読み書き成功。Vercel→Neonは新しいProductionビルドの実行が残る。業務アプリ実行時の共通接続は #5 |
| AC-06 | 実際のNeon接続URL・パスワードが追跡ファイル・公開HTML・確認済みCIログに含まれないことを値を表示せず照合。CIでは公開環境のSecretsを使わない |
| AC-07 | Compose DBとNeonの分離、認証2変数がProductionのみであることを確認。利用者が新規生成した秘密値を登録済み。長さ・ローカル既定値との差異の検証はProductionビルド時、実セッションの相互拒否は #6 の実装後 |

## 公式仕様

- [GitHub setup-node](https://github.com/actions/setup-node) — Node.js固定版・npmキャッシュ・lockfileの指定。
- [Vercel環境変数](https://vercel.com/docs/environment-variables) — Production/Preview/Developmentの分離と再デプロイ。
- [Neonの接続セキュリティ](https://github.com/neondatabase/website/blob/main/content/docs/security/security-overview.md) — 証明書・ホスト名を検証する `verify-full` 接続を使用。
