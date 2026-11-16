import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apiClient, isIgnoredPath, readConfig, relevantChanges, requestDeployment } from './vercel-deploy.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const MANAGER = 'team-b-vercel-production-v1';
const repository = 'after-school-project/team-b';
const config = { sha: B, projectId: 'prj_test', teamId: 'team_test', force: false };

function deployment(id, sha, state = 'READY', managed = true) {
  return {
    id, uid: id, gitSource: { type: 'github', repoId: '123', ref: 'main', sha },
    readyState: state, state, aliasAssigned: state === 'READY', aliasError: null,
    url: 'after-school-project-test.vercel.app',
    meta: managed ? { deploymentManager: MANAGER, deploymentRepository: repository } : {},
  };
}

function fixture(options = {}) {
  const calls = [];
  const published = options.published === undefined ? deployment('dpl_published', A) : options.published;
  const project = {
    id: config.projectId, accountId: config.teamId, name: 'after-school-project', rootDirectory: 'web',
    link: { type: 'github', repoId: 123, productionBranch: 'main' },
    targets: published ? { production: published } : {},
    ...options.project,
  };
  const entries = options.entries ?? [];
  const details = new Map([...(published ? [[published.id, published]] : []), ...entries.map((d) => [d.id, { ...d }])]);
  let headCall = 0;
  const api = async (service, path, request = {}) => {
    calls.push({ service, path, ...request });
    if (path.endsWith('/git/ref/heads/main')) {
      const heads = options.heads ?? [B];
      return { object: { sha: heads[Math.min(headCall++, heads.length - 1)] } };
    }
    if (path === `/repos/${repository}`) return { id: 123 };
    if (path === `/v9/projects/${config.projectId}`) return project;
    if (path.startsWith('/v7/deployments?')) {
      const query = new URL(path, 'https://api.vercel.com').searchParams;
      if (options.listError) throw new Error('一覧の取得失敗');
      if (query.get('state') === 'READY') return { deployments: entries.filter((d) => d.readyState === 'READY').slice(0, 1), pagination: { next: null } };
      if (options.pages) return options.pages[query.has('until') ? 1 : 0];
      return { deployments: entries.filter((d) => !['READY', 'ERROR', 'CANCELED'].includes(d.readyState)), pagination: { next: null } };
    }
    const cancel = path.match(/^\/v12\/deployments\/(dpl_\w+)\/cancel$/);
    if (cancel) {
      if (options.cancelError) throw new Error('キャンセル失敗');
      const item = details.get(cancel[1]);
      if (options.onCancel) options.onCancel(item, project);
      if (options.cancelApiError) throw options.cancelApiError;
      if (!options.cancelPending) item.readyState = 'CANCELED';
      return item;
    }
    const detail = path.match(/^\/v13\/deployments\/(dpl_\w+)$/);
    if (detail) return options.getDetail?.(detail[1], details) ?? details.get(detail[1]);
    if (path === '/v13/deployments?forceNew=1') {
      if (options.postError) throw new Error('要求失敗');
      return options.response ?? deployment('dpl_requested', B, 'BUILDING');
    }
    throw new Error(`Unexpected request: ${service} ${path}`);
  };
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args);
    if (options.gitError) throw new Error('比較元がない');
    return Buffer.from((options.paths ?? ['web/src/app/page.tsx']).map((p) => `${p}\0`).join(''));
  };
  return { api, git, calls, gitCalls };
}

function mutations(f) { return f.calls.filter((c) => c.method && c.method !== 'GET'); }

test('除外は合意したパスだけ。web内のMarkdownや未分類ファイルはデプロイ対象', () => {
  for (const path of ['docs/設計.md', 'docs/a/b.csv', 'README.md', 'CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/task.yml', '.github/pull_request_template.md']) assert.equal(isIgnoredPath(path), true, path);
  for (const path of ['web/README.md', 'README.MD', 'compose.yaml', '.github/workflows/vercel-production.yml', 'web/vercel.json', 'web/package-lock.json', 'new.config', 'docs-code/main.js']) assert.equal(isIgnoredPath(path), false, path);
});

test('空の差分・除外パスだけはスキップし、混在・改行を含むパスは見落とさない', () => {
  assert.equal(relevantChanges(A, B, () => Buffer.from('')).deploy, false);
  assert.equal(relevantChanges(A, B, () => Buffer.from('docs/日本語.md\0README.md\0')).deploy, false);
  assert.equal(relevantChanges(A, B, () => Buffer.from('docs/日本語.md\0web/new\nfile.md\0')).deploy, true);
});

test('初回・比較元の欠落・Git失敗ではデプロイを省略しない', () => {
  assert.equal(relevantChanges(undefined, B).deploy, true);
  assert.equal(relevantChanges('invalid', B).deploy, true);
  assert.equal(relevantChanges(A, B, () => { throw new Error('missing'); }).deploy, true);
});

test('実Gitで複数コミット・削除・docsへの移動・webへの移動を判定する', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'team-b-deploy-test-'));
  const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (message) => {
    git(['add', '.']);
    git(['-c', 'user.name=Deployment Test', '-c', 'user.email=deployment-test@example.invalid', 'commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).toString().trim();
  };
  try {
    git(['init']);
    mkdirSync(join(cwd, 'web'));
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'web/app.txt'), 'one');
    const base = commit('initial');
    writeFileSync(join(cwd, 'web/app.txt'), 'two');
    commit('code');
    writeFileSync(join(cwd, 'docs/設計 資料.md'), 'doc');
    const docs = commit('docs');
    assert.equal(relevantChanges(base, docs, git).deploy, true);
    const docsBase = docs;
    writeFileSync(join(cwd, 'docs/設計 資料.md'), 'new doc');
    assert.equal(relevantChanges(docsBase, commit('docs only'), git).deploy, false);
    renameSync(join(cwd, 'web/app.txt'), join(cwd, 'docs/app.txt'));
    const movedToDocs = commit('move to docs');
    assert.equal(relevantChanges(docsBase, movedToDocs, git).deploy, true);
    renameSync(join(cwd, 'docs/app.txt'), join(cwd, 'web/app.txt'));
    const movedToWeb = commit('move to web');
    assert.equal(relevantChanges(movedToDocs, movedToWeb, git).deploy, true);
    rmSync(join(cwd, 'web/app.txt'));
    assert.equal(relevantChanges(movedToWeb, commit('delete code'), git).deploy, true);
  } finally {
    assert.ok(cwd.startsWith(join(tmpdir(), 'team-b-deploy-test-')));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('公開版との差分がdocsだけならPOSTもキャンセルも行わない', async () => {
  const f = fixture({ paths: ['docs/guide.md', 'README.md'] });
  const result = await requestDeployment(config, f);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(mutations(f), []);
  assert.deepEqual(f.gitCalls[0], ['diff', '--name-only', '-z', '--no-renames', A, B, '--']);
});

test('アプリ変更はexact SHAを指定し、Vercelへ非同期に1回要求する', async () => {
  const f = fixture();
  const result = await requestDeployment(config, f);
  assert.equal(result.status, 'requested');
  assert.equal(result.state, 'BUILDING');
  assert.equal(result.url, 'https://after-school-project-test.vercel.app');
  assert.equal(mutations(f).length, 1);
  const body = mutations(f)[0].body;
  assert.deepEqual(body.gitSource, { type: 'github', repoId: '123', ref: 'main', sha: B });
  assert.equal(body.project, config.projectId);
  assert.equal(body.target, 'production');
  assert.equal('projectSettings' in body, false);
});

test('前回のERRORを比較元にせず、最後の公開版から未反映コードを含める', async () => {
  const f = fixture({ entries: [deployment('dpl_failed', C, 'ERROR')] });
  assert.equal((await requestDeployment(config, f)).status, 'requested');
  assert.equal(f.gitCalls[0][4], A);
});

test('公開版がない・Git差分失敗でも要求する', async () => {
  for (const options of [{ published: null }, { gitError: true }]) {
    const f = fixture(options);
    assert.equal((await requestDeployment(config, f)).status, 'requested');
  }
});

test('古いActions実行は要求しない。要求直前にmainが進んだ場合も停止', async () => {
  for (const heads of [[C], [B, C], [B, B, C]]) {
    const f = fixture({ heads });
    assert.equal((await requestDeployment(config, f)).status, 'stale');
    assert.deepEqual(mutations(f), []);
  }
});

test('同じSHAの実行中ビルドはforce指定でも再利用する', async () => {
  const f = fixture({ entries: [deployment('dpl_running', B, 'BUILDING')] });
  assert.equal((await requestDeployment({ ...config, force: true }, f)).status, 'reused');
  assert.deepEqual(mutations(f), []);
});

test('古い実行中ビルドを中止・停止確認した後に新しい要求を行う', async () => {
  const f = fixture({ entries: [deployment('dpl_old', C, 'BUILDING')] });
  assert.equal((await requestDeployment(config, f)).status, 'requested');
  assert.deepEqual(mutations(f).map((c) => c.method), ['PATCH', 'POST']);
  const cancelIndex = f.calls.findIndex((c) => c.method === 'PATCH');
  assert.equal(f.calls[cancelIndex + 1].path, '/v13/deployments/dpl_old');
});

test('同一SHAを再利用するときも別SHAの古いビルドを先に中止する', async () => {
  const f = fixture({ entries: [deployment('dpl_old', C, 'QUEUED'), deployment('dpl_same', B, 'BUILDING')] });
  assert.equal((await requestDeployment(config, f)).status, 'reused');
  assert.deepEqual(mutations(f).map((c) => c.method), ['PATCH']);
});

test('アプリ変更をrevertした場合、差分なしでも古いビルドを残さない', async () => {
  const f = fixture({ paths: [], entries: [deployment('dpl_old', C, 'BUILDING')] });
  assert.equal((await requestDeployment(config, f)).status, 'skipped');
  assert.deepEqual(mutations(f).map((c) => c.method), ['PATCH']);
});

test('停止未確認・キャンセル失敗・外部の実行中デプロイでは新規要求しない', async () => {
  for (const options of [
    { cancelPending: true, entries: [deployment('dpl_old', C, 'BUILDING')] },
    { cancelError: true, entries: [deployment('dpl_old', C, 'BUILDING')] },
    { entries: [deployment('dpl_other', C, 'BUILDING', false)] },
  ]) {
    const f = fixture(options);
    await assert.rejects(requestDeployment(config, f));
    assert.equal(mutations(f).some((c) => c.method === 'POST'), false);
  }
});

test('READYでも公開ドメイン割り当て中なら新規要求しない', async () => {
  for (const managed of [true, false]) {
    const item = { ...deployment('dpl_ready', C, 'READY', managed), aliasAssigned: false };
    const f = fixture({ entries: [item] });
    await assert.rejects(requestDeployment(config, f), /割り当てが未完了/);
    assert.deepEqual(mutations(f), []);
  }
});

test('キャンセル直前にREADYになった場合、公開完了を確認して比較元を更新する', async () => {
  const client = apiClient({ token: 'test', teamId: config.teamId, fetchImpl: async () => new Response('{}', { status: 400 }) });
  let cancelApiError;
  try { await client('vercel', '/cancel', { method: 'PATCH' }); } catch (error) { cancelApiError = error; }
  const f = fixture({
    entries: [deployment('dpl_old', C, 'BUILDING')], cancelApiError,
    onCancel: (item, project) => {
      item.readyState = 'READY';
      item.aliasAssigned = true;
      project.targets.production = item;
    },
  });
  assert.equal((await requestDeployment(config, f)).status, 'requested');
  assert.equal(f.gitCalls[0][4], C);
  assert.deepEqual(mutations(f).map((c) => c.method), ['PATCH', 'POST']);
});

test('BLOCKEDの公開要求が残る場合、新規要求や再利用を行わない', async () => {
  const f = fixture({ entries: [deployment('dpl_blocked', B, 'BLOCKED')] });
  await assert.rejects(requestDeployment(config, f), /保留中/);
  assert.deepEqual(mutations(f), []);
});

test('従来のCLIデプロイのGit metadataを比較元として利用できる', async () => {
  const published = { ...deployment('dpl_cli', A), gitSource: undefined, meta: { githubCommitSha: A, githubCommitRef: 'main' } };
  const f = fixture({ published, paths: ['docs/guide.md'] });
  assert.equal((await requestDeployment(config, f)).status, 'skipped');
  assert.equal(f.gitCalls[0][4], A);
});

test('別ブランチの公開版やSHA不明の場合は比較を省略せず要求する', async () => {
  for (const published of [
    { ...deployment('dpl_unknown', A), gitSource: undefined, meta: {} },
    { ...deployment('dpl_otherbranch', A), gitSource: { sha: A, ref: 'other' } },
  ]) {
    const f = fixture({ published, paths: ['docs/guide.md'] });
    assert.equal((await requestDeployment(config, f)).status, 'requested');
  }
});

test('ページをまたぐ実行中ビルドも確認する', async () => {
  const old = deployment('dpl_old', C, 'BUILDING');
  const f = fixture({ entries: [old], pages: [
    { deployments: [], pagination: { next: 100 } },
    { deployments: [old], pagination: { next: null } },
  ] });
  assert.equal((await requestDeployment(config, f)).status, 'requested');
  assert.equal(mutations(f)[0].method, 'PATCH');
});

test('一覧取得失敗はdocsだけでも省略成功にせずエラーにする', async () => {
  const f = fixture({ listError: true, paths: ['docs/guide.md'] });
  await assert.rejects(requestDeployment(config, f));
  assert.deepEqual(mutations(f), []);
});

test('チーム・プロジェクト・リポジトリ・main・webが違う場合に停止する', async () => {
  for (const project of [
    { id: 'prj_wrong' }, { accountId: 'team_wrong' }, { rootDirectory: '.' },
    { link: { type: 'github', repoId: 999, productionBranch: 'main' } },
    { link: { type: 'github', repoId: 123, productionBranch: 'develop' } },
  ]) {
    const f = fixture({ project });
    await assert.rejects(requestDeployment(config, f), /確認してください/);
    assert.deepEqual(mutations(f), []);
  }
});

test('手動forceは公開版と差分なしでも要求できる', async () => {
  const f = fixture({ paths: [] });
  assert.equal((await requestDeployment({ ...config, force: true }, f)).status, 'requested');
});

test('要求エラー・応答SHA不一致を成功扱いせず、POSTを再送しない', async () => {
  for (const options of [{ postError: true }, { response: deployment('dpl_wrong', C, 'BUILDING') }, { response: deployment('dpl_blocked', B, 'BLOCKED') }]) {
    const f = fixture(options);
    await assert.rejects(requestDeployment(config, f));
    assert.equal(mutations(f).filter((c) => c.method === 'POST').length, 1);
  }
});

test('push・手動main実行だけを許可し、forceは手動だけで有効', () => {
  const env = {
    GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: B,
    VERCEL_PROJECT_ID: config.projectId, VERCEL_ORG_ID: config.teamId, VERCEL_TOKEN: 'secret', GITHUB_TOKEN: 'github-secret', FORCE_DEPLOY: 'true',
  };
  assert.equal(readConfig(env).force, false);
  assert.equal(readConfig({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }).force, true);
  for (const override of [{ GITHUB_REPOSITORY: 'fork/team-b' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REF: 'refs/heads/feature' }, { VERCEL_TOKEN: '' }, { VERCEL_PROJECT_ID: '../wrong' }]) assert.throws(() => readConfig({ ...env, ...override }));
});

test('API認証を接続先ごとに分離し、HTTPエラー本文や通信エラーに秘密値を出さない', async () => {
  const calls = [];
  const client = apiClient({ token: 'vercel-secret', githubToken: 'github-secret', teamId: 'team_test', fetchImpl: async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify({ error: 'vercel-secret' }), { status: 403 });
  } });
  await assert.rejects(client('vercel', '/v9/projects/prj_test'), (error) => error.message.includes('403') && !error.message.includes('vercel-secret'));
  await assert.rejects(client('github', '/repos/a/b'));
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team_test');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer vercel-secret');
  assert.equal(calls[1].request.headers.Authorization, 'Bearer github-secret');
  assert.equal(calls[1].url.searchParams.has('teamId'), false);
  assert.equal(calls[0].request.redirect, 'error');
  const broken = apiClient({ token: 'secret', teamId: 'team_test', fetchImpl: () => { throw new Error('secret'); } });
  await assert.rejects(broken('vercel', '/v13/deployments', { method: 'POST' }), (error) => !error.message.includes('secret'));
  await assert.rejects(client('vercel', 'https://evil.example/'), /接続先/);
});

test('設定はmainだけの自動デプロイを停止する', () => {
  const config = JSON.parse(readFileSync(new URL('../../web/vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.git.deploymentEnabled, { main: false });
});
