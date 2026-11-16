import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const OWNER = 'after-school-project/team-b';
const MANAGER = 'team-b-vercel-production-v1';
const TERMINAL = new Set(['READY', 'ERROR', 'CANCELED']);

export function isIgnoredPath(path) {
  return path.startsWith('docs/') || path.startsWith('.github/ISSUE_TEMPLATE/') ||
    ['README.md', 'CONTRIBUTING.md', '.github/pull_request_template.md'].includes(path);
}

export function relevantChanges(base, head, git = (args) => execFileSync('git', args)) {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) {
    return { deploy: true, reason: '比較元がないためデプロイします。' };
  }
  try {
    // --no-renamesで移動元・移動先を両方判定する。NUL区切りで改行を含む名前も扱う。
    const paths = git(['diff', '--name-only', '-z', '--no-renames', base, head, '--'])
      .toString().split('\0').filter(Boolean);
    const deploy = paths.some((path) => !isIgnoredPath(path));
    return { deploy, reason: deploy ? '公開版からアプリに関係する変更があります。' : '公開版との差分は除外パスのみです（差分なしを含む）。' };
  } catch {
    return { deploy: true, reason: 'Git差分を取得できないためデプロイします。' };
  }
}

function sourceSha(deployment) {
  return deployment?.gitSource?.sha ?? deployment?.meta?.githubCommitSha;
}

function deploymentState(deployment) {
  return deployment.readyState ?? deployment.state;
}

function deploymentId(deployment) {
  const id = deployment.id ?? deployment.uid;
  if (!/^dpl_[a-zA-Z0-9]+$/.test(id ?? '')) throw new Error('VercelのデプロイIDを確認できません。');
  return id;
}

function deploymentResult(status, reason, deployment) {
  const result = { status, reason };
  if (deployment) {
    result.deploymentId = deploymentId(deployment);
    result.deploymentSha = sourceSha(deployment);
    result.state = deploymentState(deployment);
    if (/^[a-zA-Z0-9.-]+\.vercel\.app$/.test(deployment.url ?? '')) {
      result.url = `https://${deployment.url}`;
    }
  }
  return result;
}

class ApiError extends Error {
  constructor(service, method, status) {
    super(`${service} API ${method}が失敗しました（HTTP ${status}）。`);
    this.status = status;
  }
}

export function apiClient({ token, teamId, githubToken, fetchImpl = fetch }) {
  return async function request(service, path, { method = 'GET', body } = {}) {
    const origin = service === 'vercel' ? 'https://api.vercel.com' : 'https://api.github.com';
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('APIの接続先が不正です。');
    if (service === 'vercel') url.searchParams.set('teamId', teamId);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${service === 'vercel' ? token : githubToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'team-b-vercel-deployment',
          ...(service === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // fetchの例外やAPI本文には認証情報が含まれ得るのでそのまま出力しない。
      // POSTは通信エラーでも受理済みの可能性があるため自動再送しない。
      throw new Error(`${service} API ${method}の通信に失敗しました。Vercelの状態を確認してから再実行してください。`);
    }
    if (!response.ok) throw new ApiError(service, method, response.status);
    try {
      return await response.json();
    } catch {
      throw new Error(`${service} APIの応答を解析できません。`);
    }
  };
}

function validateProject(project, config, repoId) {
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || project.name !== 'after-school-project' ||
      project.id !== config.projectId || project.accountId !== config.teamId ||
      project.link?.type !== 'github' || String(project.link.repoId) !== String(repoId) ||
      project.link.productionBranch !== 'main' || project.rootDirectory !== 'web') {
    throw new Error('Vercelのチーム・プロジェクト・接続リポジトリ・Production Branch（main）・Root Directory（web）を確認してください。');
  }
}

async function listProductionDeployments(api, projectId) {
  const deployments = [];
  let until;
  // 履歴が増えても実行中だけを走査する。ページ途中で「実行中なし」と判断しない。
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ projectId, target: 'production', state: 'INITIALIZING,QUEUED,BUILDING,BLOCKED', limit: '100' });
    if (until) query.set('until', until);
    const data = await api('vercel', `/v7/deployments?${query}`);
    if (!Array.isArray(data.deployments)) throw new Error('Vercelのデプロイ一覧を確認できません。');
    deployments.push(...data.deployments);
    const next = data.pagination?.next;
    if (next == null) {
      // READY直後のドメイン割り当ては非同期の場合がある。直近のREADYも確認する。
      const readyQuery = new URLSearchParams({ projectId, target: 'production', state: 'READY', limit: '1' });
      const ready = await api('vercel', `/v7/deployments?${readyQuery}`);
      if (!Array.isArray(ready.deployments)) throw new Error('Vercelの公開状態を確認できません。');
      return [...deployments, ...ready.deployments];
    }
    if (String(next) === until) break;
    until = String(next);
  }
  throw new Error('Vercelのデプロイ一覧を最後まで確認できません。手動で状態を確認してください。');
}

export async function requestDeployment(config, { api, git } = {}) {
  const getHead = async () => {
    const ref = await api('github', `/repos/${OWNER}/git/ref/heads/main`);
    if (!SHA.test(ref.object?.sha ?? '')) throw new Error('mainの最新SHAを確認できません。');
    return ref.object.sha;
  };
  const stale = () => deploymentResult('stale', 'mainに新しい更新があるため、この実行からは要求しません。');
  if (await getHead() !== config.sha) return stale();

  const repository = await api('github', `/repos/${OWNER}`);
  const projectPath = `/v9/projects/${config.projectId}`;
  let project = await api('vercel', projectPath);
  validateProject(project, config, repository.id);
  const deployments = await listProductionDeployments(api, config.projectId);
  const pending = [];
  for (const item of deployments) {
    const state = deploymentState(item);
    // READY直後でドメイン割り当てが未完了のケースも確認する。
    if (TERMINAL.has(state) && state !== 'READY') continue;
    const detail = await api('vercel', `/v13/deployments/${deploymentId(item)}`);
    const currentState = deploymentState(detail);
    if (currentState === 'READY') {
      if (!detail.aliasAssigned || detail.aliasError) {
        throw new Error('公開ドメインの割り当てが未完了です。Vercelで確認してから再実行してください。');
      }
      continue;
    }
    if (TERMINAL.has(currentState)) continue;
    if (currentState === 'BLOCKED') {
      throw new Error('保留中の公開デプロイがあります。Vercelで権限・状態を確認し、古い要求を中止してから再実行してください。');
    }
    if (detail.meta?.deploymentManager !== MANAGER || detail.meta?.deploymentRepository !== OWNER) {
      throw new Error('このワークフロー以外の公開デプロイが実行中です。完了・中止を確認してから再実行してください。');
    }
    pending.push(detail);
  }

  if (await getHead() !== config.sha) return stale();
  const same = pending.find((deployment) => sourceSha(deployment) === config.sha);
  for (const deployment of pending) {
    if (deployment === same) continue;
    const id = deploymentId(deployment);
    try {
      await api('vercel', `/v12/deployments/${id}/cancel`, { method: 'PATCH' });
    } catch (error) {
      // キャンセル直前に完了した場合だけ、状態を読み直して判断する。
      if (!(error instanceof ApiError) || error.status !== 400) throw error;
    }
    const stopped = await api('vercel', `/v13/deployments/${id}`);
    if (!TERMINAL.has(deploymentState(stopped)) ||
        (deploymentState(stopped) === 'READY' && (!stopped.aliasAssigned || stopped.aliasError))) {
      throw new Error('以前の公開デプロイの停止を確認できません。新しい要求は行いません。');
    }
  }
  if (same) return deploymentResult('reused', '同一SHAのビルドは既に実行中です。新しい要求は行いません。', same);

  // キャンセルとの競合で公開版が変わった場合も、最新の公開先を比較元にする。
  project = await api('vercel', projectPath);
  validateProject(project, config, repository.id);
  let base;
  const published = project.targets?.production;
  if (published) {
    const detail = await api('vercel', `/v13/deployments/${deploymentId(published)}`);
    if (deploymentState(detail) === 'READY' && detail.aliasAssigned && !detail.aliasError &&
        (detail.gitSource?.ref ?? detail.meta?.githubCommitRef) === 'main') {
      base = sourceSha(detail);
    }
  }
  const decision = relevantChanges(base, config.sha, git);
  if (!config.force && !decision.deploy) return deploymentResult('skipped', decision.reason);
  if (await getHead() !== config.sha) return stale();

  const deployment = await api('vercel', '/v13/deployments?forceNew=1', {
    method: 'POST',
    body: {
      name: project.name,
      project: config.projectId,
      target: 'production',
      gitSource: { type: 'github', repoId: String(repository.id), ref: 'main', sha: config.sha },
      meta: { deploymentManager: MANAGER, deploymentRepository: OWNER },
    },
  });
  if (sourceSha(deployment) !== config.sha) throw new Error('要求したSHAとVercelの応答が一致しません。Vercelで確認してください。');
  if (['ERROR', 'CANCELED', 'BLOCKED'].includes(deploymentState(deployment))) {
    throw new Error('Vercelがデプロイを受け付けませんでした。Vercelで状態を確認してください。');
  }
  return deploymentResult('requested', config.force ? '手動操作で再ビルドを要求しました。' : decision.reason, deployment);
}

export function readConfig(env) {
  if (env.GITHUB_REPOSITORY !== OWNER || env.GITHUB_REF !== 'refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('この処理は元リポジトリのmainへのpush・手動実行だけで利用できます。');
  }
  if (!SHA.test(env.GITHUB_SHA ?? '') || !/^prj_[a-zA-Z0-9]+$/.test(env.VERCEL_PROJECT_ID ?? '') ||
      !/^team_[a-zA-Z0-9]+$/.test(env.VERCEL_ORG_ID ?? '') || !env.VERCEL_TOKEN || !env.GITHUB_TOKEN) {
    throw new Error('GitHub/VercelのSHA・Secrets・Variablesの設定を確認してください。');
  }
  return {
    sha: env.GITHUB_SHA,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_ORG_ID,
    force: env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.FORCE_DEPLOY === 'true',
  };
}

async function main() {
  try {
    const config = readConfig(process.env);
    const api = apiClient({ token: process.env.VERCEL_TOKEN, teamId: config.teamId, githubToken: process.env.GITHUB_TOKEN });
    const result = await requestDeployment(config, { api });
    const summary = [
      `対象SHA: ${config.sha}`,
      `結果: ${result.status}`,
      result.reason,
      ...(result.deploymentId ? [`デプロイID: ${result.deploymentId}`, `状態: ${result.state}`, `URL: ${result.url ?? 'Vercel Dashboardで確認'}`] : []),
      'requested/reusedは要求受付・実行中を表します。ビルド成功・公開完了はVercel Dashboardで確認してください。',
    ].join('\n\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
