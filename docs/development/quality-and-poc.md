# 品質チェックとPoC公開環境

## 品質チェック

[quality.yml](../../.github/workflows/quality.yml) は全PRと `main` へのpushで実行します。手動実行にも対応します。

| ジョブ | 確認内容 |
|---|---|
| Lint, types, unit tests and build | `npm ci` → lint → typecheck → 単体テスト → 本番ビルド |
| PostgreSQL integration tests | `npm ci` → 使い捨てPostgreSQL 17でDB結合テスト |
| Browser end-to-end tests | `npm ci` → Chromiumの導入 → 使い捨てPostgreSQL 17の起動・初期化 → 本番ビルドに対するE2E |

Node.jsは `web/.nvmrc` の24.x固定版、依存関係は `web/package-lock.json` を使用します。いずれかのコマンドが失敗するとジョブも失敗します。実行中の同じPRへの更新は古い検査を中止します。

CIはGitHub/Vercel/NeonのSecretsを参照しません。DB結合テストとE2Eの認証情報は、実行ごとに破棄するローカルDB専用です。E2Eのレポート・トレース・スクリーンショットはアップロードしないため、失敗の内容はジョブのログで確認し、必要ならローカルで再現します。forkのPRも公開環境の資格情報を使わず検査できます。

ローカルではアプリコンテナで `npm run check`、DB結合テストは専用Composeを使います。

```sh
docker compose exec app npm run check
docker compose -p team-b-quality -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p team-b-quality -f compose.test.yaml down
```

通常開発用のComposeと異なるプロジェクト名にしてください。テストDBはtmpfs上にあり、停止時に破棄されます。

### ホストでのE2E

E2E（[Playwright設定](../../web/playwright.config.ts)）は品質CIでも実行します。CIでは並列にせず、失敗したテストを2回まで再試行します（再試行で通ったテストは `flaky` としてログに出ます）。ローカルでは `web/` で、ポート3100にビルド済みアプリを起動して確認します。アプリはホストから接続できる初期化済みDBとアプリ用ロールを必要とします。開発Composeの `db` はホストにポートを公開しないため、E2E専用の使い捨てDBをホストの `127.0.0.1:5432` に起動して初期化します。開発Composeの `team_b_dev` とは別のDBで、通常開発のデータには触れません。

[home.spec.ts](../../web/tests/e2e/home.spec.ts) は seed の利用者で実セッションを作るため、そのDBを初期化したときに生成された seed の認証情報を使います。ホストで `npm run db:setup` を実行すると、Git対象外の `web/.seed/accounts.json` に生成されます。この既定の場所なら `E2E_ACCOUNTS_FILE` は不要です。別のDBの認証情報は、そのDBのパスワードと一致しないため使えません。

`db:setup` はローカルの `team_b_dev`・管理ロール `team_b`・ポート5432だけを受け付けます（[DB開発ガイド](database.md)）。ホストの5432番を使用中の場合は、そのサービスを停止してから実行してください。以下は bash の例です。管理ロールのパスワードは任意の開発用の値、アプリ用ロールのパスワードは [local-db-grants.sql](../../web/scripts/local-db-grants.sql) の開発用の値に置き換えます。

```sh
# 1. E2E専用の使い捨てDBを起動する。起動に失敗したときに docker logs で原因を確認できるよう、--rm は付けない
docker run -d --name team-b-e2e-db -e POSTGRES_DB=team_b_dev -e POSTGRES_USER=team_b \
  -e POSTGRES_PASSWORD='<管理ロールの開発用パスワード>' -p 127.0.0.1:5432:5432 postgres:17.11-alpine \
  -c cluster_name=team-b-e2e

# 2. 接続情報を設定する
cd web
export DATABASE_URL_DIRECT='postgresql://team_b:<管理ロールの開発用パスワード>@127.0.0.1:5432/team_b_dev'
export DATABASE_URL='postgresql://team_b_app:<アプリ用ロールの開発用パスワード>@127.0.0.1:5432/team_b_dev'
export BETTER_AUTH_URL='https://127.0.0.1:3100'
export BETTER_AUTH_SECRET='<32文字以上の開発用の値>'

# 3. TCP接続の受付を最大60秒待つ。docker run は受付前に戻り、db:setup は再試行しないため。
#    コンテナが終了した場合や時間内に準備できない場合は、原因の確認方法を表示して失敗する
wait_for_e2e_db() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' team-b-e2e-db 2>/dev/null)" != true ]; then
      echo "E2E用DBのコンテナが起動していません。docker logs team-b-e2e-db で原因を確認してください。" >&2
      return 1
    fi
    docker exec team-b-e2e-db pg_isready -q -h 127.0.0.1 -U team_b -d team_b_dev && return 0
    sleep 1
  done
  echo "E2E用DBが60秒以内に接続を受け付けませんでした。docker logs team-b-e2e-db で原因を確認してください。" >&2
  return 1
}

# 4. DBの準備ができた場合だけ、マイグレーション・権限設定・seed（web/.seed/accounts.json の生成）とE2Eを実行する
npm run test:e2e:install   # 初回のみ
wait_for_e2e_db && npm run db:setup && npm run test:e2e

# 5. 終了後（失敗時も）にDBを破棄する
docker rm -f team-b-e2e-db
```

| 環境変数 | 設定値 |
|---|---|
| `DATABASE_URL_DIRECT` | `db:setup` だけが使う管理ロールの接続 |
| `DATABASE_URL` | E2Eで起動するアプリのアプリ用ロールの接続 |
| `BETTER_AUTH_SECRET` | 32文字以上の開発用の値 |
| `BETTER_AUTH_URL` | `https://127.0.0.1:3100`。本番ビルドはHTTPSの正規オリジンだけを受け付けます。E2Eは同じオリジンを `Origin` に送ります |
| `E2E_ACCOUNTS_FILE` | `accounts.json` のパス。既定は `web/.seed/accounts.json` です。ファイルがない場合、実セッションのテストは失敗し、この変数の確認を案内します |

`web/.seed/accounts.json` が残っている場合、`db:setup` はそのパスワードを再利用してアカウントを作成します。そのため、DBを作り直しても同じファイルを使えます。

実セッションのテストは、パスワードを画面に入力せず要求コンテキストからサインインし、トレース・スクリーンショット・動画を無効にします。失敗時のレポートにパスワードを残さないためです。`web/.seed/` と `web/test-results/` はコミットしないでください。

[admin-profiles.spec.ts](../../web/tests/e2e/admin-profiles.spec.ts)・[graduation.spec.ts](../../web/tests/e2e/graduation.spec.ts)・[questions.spec.ts](../../web/tests/e2e/questions.spec.ts) は、画面からまだ用意できない状態（アプリ管理者の権限解除、非表示・削除済みの質問など）を、テストの実行環境の `DATABASE_URL` でE2E用DBに直接設定します（[database.ts](../../web/tests/e2e/database.ts)）。繰り返し実行できるよう、テスト用の利用者の再公開申請と通知の削除、一時的な利用者と質問の作成と削除も行います。そのため、手順1の `-c cluster_name=team-b-e2e` を付けて起動した使い捨てDB以外では、状態を変更せずに失敗します（ホスト名・DB名だけでは、ポートを公開した開発DBと区別できないため）。また、`DATABASE_URL` が手順2と同じ形（`127.0.0.1:5432` の `team_b_dev`、ロール `team_b_app`、クエリーなし）でなければ、接続せずに失敗します。

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

`DATABASE_URL` はDDL・監査ログ変更権限を持たない専用アプリロールへ切り替えます。管理用直接接続とは別ロールが必要です。切り替え手順は [DB接続・権限・ローカル初期化](./database.md#neonの専用アプリロール) を参照してください。管理用のローカルマイグレーションコマンドでは従来どおり `.env.neon.local` の `DATABASE_URL_DIRECT` を使います。

ProductionのDB接続・秘密値はPreview/DevelopmentやGitHub Actionsへコピーしません。Previewは現時点では最小ページとビルドの確認用です。業務機能でDBが必要になった時点で別のPreview用DB・秘密値を用意してください。

## Vercel上での読み書き確認

`web/vercel.json` のビルドコマンドは `npm run poc:verify && npm run build` です。

Productionでは、接続URL・HTTPS正規URL・認証秘密値の設定、TLSの実接続、31テーブル、アプリロールの権限、専用カテゴリ行への読み書きとロールバックを確認します。アプリ用の `DATABASE_URL` を使用し、管理用接続で代用しません。どれかが失敗するとビルドへ進みません。URL・秘密値・DBの生例外・行データはログに出力しません。

アプリ用の確認は `qa_categories` にUUIDで識別する専用行を作成し、INSERT / UPDATE / SELECT / DELETEの後に必ずrollbackします。既存行・認証セッションは変更せず、マイグレーション・seedは行いません。TEMP権限を含むDDL権限を持つロールや、監査ログを変更できるロールは拒否します。共通DBクライアントと権限分離の詳細は [DBガイド](./database.md) を参照してください。

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
6. Issue #4 の AC-07 は、ローカルがCompose DB、PoCがNeonを使用し、認証秘密値を共有しないことを確認します。認証実装後は、両環境で発行したセッションCookieが互いの環境で拒否されることを確認します。[Issue #6 の AC-14](https://github.com/after-school-project/team-b/issues/6#受入条件)

環境変数を変更した場合、既存のデプロイへは反映されません。最新mainを `force` 付きで再デプロイする手順と、失敗時の復旧は [Vercelデプロイ制御](./vercel-deployment.md#再実行障害復旧) を参照してください。

## Issue #4 の確認記録（2026-11-17）

以下はマージ前の確認記録です。マージ後に残っていた項目の結果は次節に記載します。

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

## Issue #4 のマージ後確認（2026-11-18・日本時間）

PR #27で品質チェックとPoC環境の設定、PR #28で専用アプリロールによる接続がmainへ反映されています。2026-11-18の確認で、前節に残っていたmainのCIとVercel上のDB検証が成功していることを確認しました。再デプロイや環境変数の変更は行っていません。

| 項目 | 確認結果・証跡 |
|---|---|
| 対象コミット | `2d397f19001e381ae6415e04dc31847a93beab0f`（PR #28のマージコミット） |
| AC-01・AC-03 | [mainのApplication quality](https://github.com/after-school-project/team-b/actions/runs/44126181440)で2ジョブが成功。`npm ci`、lint、typecheck、単体テスト、本番ビルド、PostgreSQL結合テストの各ステップが成功 |
| デプロイ要求 | [Productionデプロイ要求](https://github.com/after-school-project/team-b/actions/runs/44126181339)が成功。要求だけでなく、次行のVercelの状態も確認 |
| AC-04 | [Vercelデプロイ詳細](https://vercel.com/tku-labs/after-school-project/4FnC2EWjhrRLr9ZxBhGKfFGWUPRW)で対象SHA、Production / Current、Readyを確認。[公開URL](https://after-school-project-two.vercel.app/)で「After School Project」「学校・在校生・卒業生をつなぐコミュニティ」「ただいま準備中です。」を確認 |
| AC-05 | 同デプロイのBuild Logsで `npm run poc:verify && npm run build` の実行と「PoC DB確認成功: TLS有効、31テーブル、書き込み・読み取り・後片付け成功。」を確認。これはVercel上から専用アプリロールを使ったINSERT / UPDATE / SELECT / DELETEとロールバックの実行結果 |
| AC-06 | 確認したビルドログ・公開ページにDB接続文字列や認証秘密値の表示なし。環境変数の秘密値の取得・開示は行っていない。CIは公開環境のSecretsを参照しない構成を維持 |
| AC-07（環境設定） | `DATABASE_URL`・`DATABASE_URL_UNPOOLED`・`BETTER_AUTH_SECRET` はSecret / Production、`BETTER_AUTH_URL` はConfig / Productionのみであることを確認。Productionの `poc:verify` で、同一Neon DBを指すURLに異なるロールが設定されていること、アプリ用接続のTLS、認証秘密値が32文字以上でCompose既定値と異なること、`BETTER_AUTH_URL` がHTTPSオリジン形式であることを確認した。公開ホストとの一致はこのスクリプトの検証対象外。[環境変数一覧](https://vercel.com/tku-labs/after-school-project/settings/environment-variables)・[検証コード](../../web/scripts/lib/poc-environment.ts) |

AC-02のlint・型エラーの失敗検出は前節の検証済みActionsを参照してください。今回の変更は確認記録のみで、アプリ・CI・DB設定は変更していません。

実セッションの相互拒否は、ログイン機能の実装後に Issue #6 の AC-14 で確認します。両環境でセッションが有効なことを確かめた上で、もう一方の環境のセッション確認APIにCookieを提示し、どちらの方向でも未認証になることを確認します。[Issue #6 の確認方法](https://github.com/after-school-project/team-b/issues/6#確認方法)

## 公式仕様

- [GitHub setup-node](https://github.com/actions/setup-node) — Node.js固定版・npmキャッシュ・lockfileの指定。
- [Vercel環境変数](https://vercel.com/docs/environment-variables) — Production/Preview/Developmentの分離と再デプロイ。
- [Neonの接続セキュリティ](https://github.com/neondatabase/website/blob/main/content/docs/security/security-overview.md) — 証明書・ホスト名を検証する `verify-full` 接続を使用。
