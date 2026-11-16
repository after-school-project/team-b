# Vercelデプロイの制御

## 構成

`main`の更新をGitHub Actionsが受け取り、現在公開しているProductionデプロイとのGit差分を判定します。アプリに関係する変更がある場合だけ、Vercel REST APIにリポジトリ・`main`・コミットSHAを指定してデプロイを要求します。Vercelがソースを取得して依存関係のインストールとビルドを行います。

デプロイ用ワークフローはNode.js標準機能だけを使い、`npm ci`、`next build`、`vercel build`、`--prebuilt`は使用しません。ビルド完了までポーリングしないため、Actionsの成功は**要求処理の成功**です。アプリのビルド成功・公開完了はVercelで確認してください。

| 項目 | 設定・参照先 |
|---|---|
| GitHubリポジトリ | `after-school-project/team-b` |
| Vercelプロジェクト | [tku-labs / after-school-project](https://vercel.com/tku-labs/after-school-project) |
| 公開先 | [after-school-project-two.vercel.app](https://after-school-project-two.vercel.app/) |
| 対象ブランチ・Vercel環境 | `main` / Production（既存のPoC公開先） |
| Root Directory | `web` |
| ワークフロー | [vercel-production.yml](../../.github/workflows/vercel-production.yml) |
| 判定・要求処理 | [vercel-deploy.mjs](../../.github/scripts/vercel-deploy.mjs) |

この変更で新しい公開環境やDBは作成しません。既存の品質チェック（[#4](https://github.com/after-school-project/team-b/issues/4)）の役割も変更しません。

## 除外する変更

次のパスだけに差分がある場合、デプロイ要求を行いません。Vercelにキャンセル済みデプロイを作成して省略扱いにする方式ではありません。

- `docs/**`
- リポジトリ直下の`README.md`、`CONTRIBUTING.md`
- `.github/ISSUE_TEMPLATE/**`
- `.github/pull_request_template.md`

上記以外を1ファイルでも含む場合は要求します。`web/**`、lockfile、設定ファイル、ワークフロー・判定処理の変更は対象です。`web/README.md`なども対象で、Markdown全体は除外しません。

Gitの比較元は直前のpushではなく、Vercelプロジェクトの`targets.production`が指す**現在の公開版**です。初回、公開版のSHAが不明、比較元がcheckoutした履歴にない場合などは、デプロイを省略しません。Vercel/GitHub APIの取得失敗は、公開状況や実行中ビルドを確認できないため、要求せずActionsを失敗させます。

ワークフローに`paths-ignore`は設定していません。アプリ変更のビルドが失敗した後、ドキュメントだけの更新が届いた場合も、公開版から未反映のコードを検出して再要求するためです。ドキュメントだけの更新でもActionsの短い判定処理は実行されます。

複数コミットをまとめたpushは公開版から対象SHAまで全体を比較します。削除を含め、移動は移動元と移動先の両方を判定します。将来`docs/`をアプリの表示やビルドに使用する場合は、先に除外ルールを見直してください。

## 切り替え前の準備

**このPRをマージする前に準備してください。** `web/vercel.json`は`main`のGit自動デプロイを停止します。Secrets・Variablesが未設定のままマージすると、従来経路だけが停止して公開版の更新が止まります。

1. Vercelの指定プロジェクトで、接続先が`after-school-project/team-b`、Production Branchが`main`、Root Directoryが`web`であることを確認します。プロジェクト名は`after-school-project`です。スクリプトもこれらを照合し、違う場合は要求しません。
2. VercelでIgnored Build Stepを`Automatic`にします。以前のカスタムスクリプトやProductionの自動ドメイン割り当て停止が残っていないことを確認します。この運用の公開要求と同時に、別の手動デプロイ・プロモート・ロールバックを行わないでください。
3. GitHubのSettings → Environmentsで`production`環境を用意し、Deployment branches and tagsを`main`に制限します。チームの保護ルールに従って設定します。
4. 下表のSecrets・Variablesを設定します。トークンは管理担当者がVercelで発行し、GitHubの入力画面へ直接登録してください。チャット、Issue、PR、リポジトリには記載しません。
5. PRのテスト結果と設定をレビューしてからマージし、最初の要求・ビルド・公開完了を確認します。

| 名前 | 保存先 | 内容 |
|---|---|---|
| `VERCEL_TOKEN` | `production`環境のSecret | 対象チームのプロジェクト照会・デプロイ作成・キャンセルに必要な権限を持つVercelトークン。対象チームと有効期限を限定する |
| `VERCEL_PROJECT_ID` | `production`環境のVariable | 指定プロジェクトのSettingsで確認した`prj_...` |
| `VERCEL_ORG_ID` | `production`環境のVariable | `tku-labs`のSettingsで確認した`team_...`。GitHub OrganizationのIDではない |
| `VERCEL_DEPLOY_ENABLED` | **リポジトリ**のActions Variable | `true`で有効。job開始条件で参照するためEnvironment Variableには置かない |
| `GITHUB_TOKEN` | 自動提供 | `contents: read`だけを使用。個人用GitHubトークンの登録は不要 |

アプリ用のDB接続情報・認証秘密値は引き続きVercelのProduction環境変数で管理します。Actionsへ複製・ダウンロードしません。VercelのGitHub Appがリポジトリを取得できる状態を維持してください。

設定は`main`のGit自動デプロイだけを無効にします。未指定ブランチの既存Previewデプロイは従来どおりです。そのため、Preview側のドキュメント変更によるデプロイ回数は今回の節約対象に含みません。公開リポジトリのPR・forkでは認証情報を持つデプロイ用ジョブを実行せず、別のテストワークフローだけが動きます。

## 通常の確認

1. GitHub Actionsの`Request Vercel production deployment`を開きます。
2. Summaryの対象SHA、`skipped` / `stale` / `requested` / `reused`、理由、デプロイID・URLを確認します。
3. `requested` / `reused`の場合は[Vercel Deployments](https://vercel.com/tku-labs/after-school-project/deployments)で該当ID・SHAを開き、`Ready`と公開ドメインへの反映を確認します。APIでビルドを受け付けた後に失敗しても、既に終了したActionsの結果は成功のままです。

同じSHAのビルドが実行中なら再利用し、新しいデプロイを作成しません。Actionsの要求処理はconcurrencyで直列化します。待機中に新しいpushが届いた古い実行は、GitHub APIで最新SHAと照合して要求を省略します。GitHubは待機中の実行を後続で置き換える場合がありますが、最後の実行が公開版から全差分を比較するため、途中の変更を見落としません。

前のSHAがVercelで実行中の場合は、このワークフローが作成した公開デプロイだけをキャンセルし、停止状態を確認してから新しい版を要求します。これにより古いビルドが後から公開版を上書きすることを防ぎます。キャンセルはVercelのデプロイ回数に含まれます。ドキュメントだけの更新で未反映コードがない場合は、新しいデプロイ自体を作りません。

このワークフロー以外の公開デプロイが実行中、キャンセル停止未確認、ドメイン割り当て未完了、承認・権限の問題で`BLOCKED`の場合は、新しい要求を作らず失敗します。別の運用者の公開作業を自動で中止しません。状態を確認してから最新`main`を再実行してください。

## 再実行・障害復旧

- **API要求が失敗した場合**：HTTP状態、設定・権限・Vercelの稼働状況を確認します。通信エラーは要求だけ受理済みの可能性があるため、先にVercelのデプロイ一覧を確認します。POSTは自動リトライしません。
- **Vercelでビルドが失敗した場合**：Vercelのログから原因を修正して`main`へマージします。公開版のSHAは成功分のままなので、次回は失敗分を含めて再判定されます。
- **修正コミットなしで再試行する場合**：GitHub Actions → このワークフロー → Run workflowで`main`を選びます。未反映のコードがある場合は`force`なしで再要求できます。
- **環境変数の変更などで同じ公開版を再ビルドする場合**：上記の手動実行で`force`を有効にします。同一SHAが実行中ならforceでも再利用します。古い実行のRe-runは、既に`main`が進んでいると`stale`で省略されるため、最新`main`を手動実行してください。
- **以前のビルドの停止・ドメイン割り当てが未確認の場合**：Vercelでその完了または中止を確認し、最新`main`を再実行します。
- **トークン期限切れの場合**：管理担当者がGitHub Secretを更新してから手動実行します。

`force`の実行も通常のデプロイ回数を消費します。操作は元リポジトリの`main`だけで利用できます。

## 元のGit自動デプロイに戻す

1. リポジトリVariableの`VERCEL_DEPLOY_ENABLED`を`false`にしてActionsからの新しい要求を停止します。実行中のActionsジョブが終了したことも確認します。この値だけではGit自動デプロイは復活しません。
2. Vercel上のこのワークフローの実行中デプロイを確認し、完了または中止を確認します。
3. PRで`web/vercel.json`の`git.deploymentEnabled.main`を`true`に戻すか、この設定を削除します。
4. マージ後、Git自動デプロイが復帰して二重要求がないことを確認します。復帰コミットが自動反映されなかった場合はVercel Dashboardから最新`main`を1回デプロイし、その後のGit更新で動作を確認します。

## 検証

ローカルで以下を実行できます。Vercelトークンやアプリ依存関係は不要で、実デプロイも行いません。

```sh
node --test .github/scripts/vercel-deploy.test.mjs
```

テストは実Gitによる複数コミット・削除・移動と、API応答を模した判定・再実行・キャンセル・エラー処理を確認します。PRでは同じテストが実行されます。

導入時には実環境でも、ドキュメントのみで新規デプロイが作られないこと、コードとの混在で対象SHAが1回だけ要求されること、連続更新・ビルド失敗・再実行からの復旧を確認してください。APIのモックテストだけではVercelの権限・Git連携・ドメイン反映までは検証できません。

## 公式仕様

- [Git自動デプロイの無効化](https://vercel.com/docs/project-configuration/git-configuration#gitdeploymentenabled)
- [コミットを指定したデプロイの作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- [デプロイの取得](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url)
- [デプロイのキャンセル](https://vercel.com/docs/rest-api/deployments/cancel-a-deployment)
- [Ignored Build Stepの制約](https://vercel.com/docs/monorepos#ignoring-the-build-step)
