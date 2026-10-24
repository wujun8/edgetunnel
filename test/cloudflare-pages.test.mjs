import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CloudflareApi, CloudflareError, runDeployment, stageAssets, validateConfig } from '../scripts/cloudflare-pages.mjs';

const ACCOUNT = 'a'.repeat(32);
const ZONE = 'b'.repeat(32);
const KV = 'c'.repeat(32);
const PROJECT = `/accounts/${ACCOUNT}/pages/projects/test-edge`;
const NAMESPACES = `/accounts/${ACCOUNT}/storage/kv/namespaces`;
const DNS = `/zones/${ZONE}/dns_records`;
const DOMAIN = { name: 'edge.example.com', zoneId: ZONE };
const TARGET = 'test-edge-unique.pages.dev';
const config = (overrides = {}) => validateConfig({ accountId: ACCOUNT, projectName: 'test-edge',
  secrets: { ADMIN: 'sample-test-password' }, domains: [DOMAIN], ...overrides }, { env: {} });
const project = (overrides = {}) => ({ name: 'test-edge', subdomain: TARGET, production_branch: 'release',
  deployment_configs: { production: { kv_namespaces: { KV: { namespace_id: KV } } } }, ...overrides });
const quiet = () => {};

// 通过真正的 API 封装发送到本地 fetch stub，拒绝任何未显式声明的调用。
function apiFixture(handler) {
  const calls = [];
  const api = new CloudflareApi('test-api-token', { secrets: ['sample-test-password'],
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.cloudflare.com');
      assert.equal(options.headers.Authorization, 'Bearer test-api-token');
      const call = { method: options.method, path: parsed.pathname.replace('/client/v4', ''),
        query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const result = await handler(call, calls);
      assert.notEqual(result, undefined, `Unexpected API call: ${call.method} ${call.path}`);
      if (result instanceof Response) return result;
      return Response.json({ success: true, result });
    } });
  return { api, calls };
}
const errorResponse = (status, code, message = 'error') => Response.json({ success: false,
  errors: [{ code, message }] }, { status });

test('配置校验拒绝明文 ADMIN、重复变量、占位 secret 和无效域名', () => {
  assert.throws(() => config({ secrets: {} }), /ADMIN/);
  assert.throws(() => config({ vars: { ADMIN: 'hidden' } }), /ADMIN/);
  assert.throws(() => config({ vars: { KEY: 'x' }, secrets: { ADMIN: 'ok', KEY: 'y' } }), /同时/);
  assert.throws(() => config({ secrets: { ADMIN: 'CHANGE_ME' } }), /占位/);
  assert.throws(() => config({ vars: { KV: 'x' } }), /绑定名/);
  assert.throws(() => config({ domains: [{ ...DOMAIN, name: 'https://edge.example.com' }] }), /域名/);
  assert.throws(() => config({ compatibilityDate: '2025-02-30' }), /日期/);
  assert.throws(() => config({ typo: true }), /未知/);
  assert.throws(() => config({ vars: false }), /必须是对象/);
  assert.throws(() => config({ domains: false }), /必须是数组/);
  assert.throws(() => config({ productionBranch: '' }), /非空/);
});

test('账号可从环境读取；仅绑定域名不要求 ADMIN', () => {
  const value = validateConfig({ projectName: 'test-edge', domains: [DOMAIN] }, {
    command: 'domains', env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  assert.equal(value.accountId, ACCOUNT);
  assert.deepEqual(value.secrets, {});
});

test('首次发布：先设置变量/KV再上传，之后才绑定域名和 CNAME', async () => {
  let created = false;
  let uploaded = false;
  const events = [];
  const { api, calls } = apiFixture(call => {
    events.push(`${call.method} ${call.path}`);
    if (call.path === PROJECT && call.method === 'GET') return created ? project() : errorResponse(404, 8000007);
    if (call.path === `/zones/${ZONE}`) return { name: 'example.com', account: { id: ACCOUNT }, status: 'active' };
    if (call.path === DNS) {
      if (call.method === 'GET') return [];
      assert.ok(uploaded);
      assert.deepEqual(call.body, { type: 'CNAME', name: DOMAIN.name, content: TARGET, ttl: 1, proxied: true });
      return { id: 'dns-id' };
    }
    if (call.path === `/accounts/${ACCOUNT}/pages/projects`) {
      created = true;
      assert.deepEqual(call.body, { name: 'test-edge', production_branch: 'main' });
      return project({ production_branch: 'main', deployment_configs: {} });
    }
    if (call.path === NAMESPACES) return call.method === 'GET' ? [] : { id: KV };
    if (call.path === PROJECT && call.method === 'PATCH') return project();
    if (call.path === `${PROJECT}/domains`) {
      assert.ok(uploaded);
      return call.method === 'GET' ? [] : { name: DOMAIN.name, status: 'pending' };
    }
    if (call.path === `${PROJECT}/domains/${DOMAIN.name}`) return { status: 'pending' };
  });
  await runDeployment(config({ vars: { OFF_LOG: 'true' } }), { api, log: quiet, upload: async branch => {
    assert.equal(branch, 'main');
    assert.equal(calls.at(-1).method, 'PATCH');
    assert.deepEqual(calls.at(-1).body, { deployment_configs: { production: {
      compatibility_date: '2025-11-04', always_use_latest_compatibility_date: false,
      env_vars: { OFF_LOG: { type: 'plain_text', value: 'true' }, ADMIN: { type: 'secret_text', value: 'sample-test-password' } },
      kv_namespaces: { KV: { namespace_id: KV } },
    } } });
    events.push('UPLOAD');
    uploaded = true;
  } });
  assert.ok(events.indexOf('UPLOAD') < events.indexOf(`POST ${PROJECT}/domains`));
  assert.ok(events.indexOf(`POST ${PROJECT}/domains`) < events.indexOf(`POST ${DNS}`));
});

test('重复发布复用现有项目、KV、域名和正确的 DNS，沿用真实生产分支', async () => {
  const { api, calls } = apiFixture(call => {
    if (call.path === PROJECT) return project();
    if (call.path === `/zones/${ZONE}`) return { name: 'example.com', account: { id: ACCOUNT }, status: 'active' };
    if (call.path === `${NAMESPACES}/${KV}`) return { id: KV };
    if (call.path === DNS) return [{ type: 'CNAME', content: `${TARGET}.` }];
    if (call.path === `${PROJECT}/domains`) return [{ name: DOMAIN.name, status: 'active' }];
    if (call.path === `${PROJECT}/domains/${DOMAIN.name}`) return { status: 'active' };
  });
  await runDeployment(config(), { api, log: quiet, upload: async branch => assert.equal(branch, 'release') });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
});

test('8000119 封禁优先于 404：不重建项目、不创建 KV、不上传', async () => {
  const { api, calls } = apiFixture(() => errorResponse(404, 8000119, 'Your Pages project has been blocked.'));
  await assert.rejects(runDeployment(config(), { api, log: quiet,
    upload: () => assert.fail('must not upload') }), /8000119.*封禁.*abusereply/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('未知 404 / 403 不会被误判为项目不存在', async () => {
  for (const status of [403, 404]) {
    const { api, calls } = apiFixture(() => errorResponse(status, 10000, 'Authentication error'));
    await assert.rejects(runDeployment(config(), { api, log: quiet }), /Authentication error/);
    assert.equal(calls.length, 1);
  }
});

test('DNS 冲突在任何写入或上传前停止', async () => {
  const { api, calls } = apiFixture(call => {
    if (call.path === PROJECT) return project();
    if (call.path === `/zones/${ZONE}`) return { name: 'example.com', account: { id: ACCOUNT }, status: 'active' };
    if (call.path === DNS) return [{ type: 'A', content: '192.0.2.1' }];
  });
  await assert.rejects(runDeployment(config(), { api, log: quiet, upload: () => assert.fail('must not upload') }), /冲突/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('其他账号的 zone 在任何写入前停止', async () => {
  const { api, calls } = apiFixture(call => call.path === PROJECT ? project()
    : { name: 'example.com', account: { id: 'd'.repeat(32) }, status: 'active' });
  await assert.rejects(runDeployment(config(), { api, log: quiet }), /不属于指定/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('显式切换已绑定 KV 或生产分支会停止', async () => {
  for (const overrides of [{ kvNamespaceId: 'd'.repeat(32) }, { productionBranch: 'wrong' }]) {
    const { api, calls } = apiFixture(call => {
      assert.equal(call.path, PROJECT);
      return project();
    });
    await assert.rejects(runDeployment(config({ domains: [], ...overrides }), { api, log: quiet }), /不同|不符/);
    assert.ok(calls.every(call => call.method === 'GET'));
  }
});

test('多个同名 KV 需要明确选择，不会再创建', async () => {
  const { api, calls } = apiFixture(call => call.path === PROJECT
    ? project({ deployment_configs: {} })
    : [{ title: 'test-edge-kv', id: KV }, { title: 'test-edge-kv', id: 'd'.repeat(32) }]);
  await assert.rejects(runDeployment(config({ domains: [] }), { api, log: quiet }), /多个同名 KV/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('Wrangler 失败后不继续操作域名', async () => {
  const { api, calls } = apiFixture(call => {
    if (call.path === PROJECT) return project();
    if (call.path === `${NAMESPACES}/${KV}`) return { id: KV };
  });
  await assert.rejects(runDeployment(config({ domains: [] }), { api, log: quiet,
    upload: async () => { throw new Error('upload failed'); } }), /upload failed/);
  assert.equal(calls.at(-1).method, 'PATCH');
});

test('域名命令只处理域名/DNS，不修改项目环境或调用 KV', async () => {
  const { api, calls } = apiFixture(call => {
    if (call.path === PROJECT) return project();
    if (call.path === `/zones/${ZONE}`) return { name: 'example.com', account: { id: ACCOUNT }, status: 'active' };
    if (call.path === DNS) return [{ type: 'CNAME', content: TARGET }];
    if (call.path === `${PROJECT}/domains`) return [{ name: DOMAIN.name }];
    if (call.path === `${PROJECT}/domains/${DOMAIN.name}`) return { status: 'active' };
  });
  await runDeployment(config(), { api, log: quiet, command: 'domains', upload: () => assert.fail('must not upload') });
  assert.ok(calls.every(call => call.method === 'GET' && !call.path.includes('/storage/')));
});

test('API 错误不打印 Token 和 secret；网络错误同样不包含敏感细节', async () => {
  const api = new CloudflareApi('private-token', { secrets: ['private-admin'], fetchImpl: async () =>
    errorResponse(400, 1000, 'reflected private-token private-admin') });
  await assert.rejects(api.request('PATCH', '/test', {}), error => {
    assert.ok(error instanceof CloudflareError);
    assert.ok(!error.message.includes('private-'));
    return true;
  });
  const network = new CloudflareApi('private-token', { fetchImpl: async () => { throw new Error('private-token'); } });
  await assert.rejects(network.request('GET', '/test'), error => !error.message.includes('private-token'));
});

test('API 列表遍历分页', async () => {
  const api = new CloudflareApi('test', { fetchImpl: async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ success: true, result: [page], result_info: { total_pages: 2 } });
  } });
  assert.deepEqual(await api.list('/test?name=hello'), [1, 2]);
});

test('Pages 域名是单页列表，正好 100 项也只请求一次', async () => {
  let count = 0;
  const api = new CloudflareApi('test', { fetchImpl: async url => {
    count++;
    assert.equal(new URL(url).search, '');
    return Response.json({ success: true, result: Array.from({ length: 100 }, (_, id) => ({ id })) });
  } });
  assert.equal((await api.list('/domains', { singlePage: true })).length, 100);
  assert.equal(count, 1);
});

test('暂存区只包含两个部署文件，配置和仓库内容不会上传', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edgetunnel-fixture-'));
  let stage;
  try {
    for (const name of ['_worker.js', '_routes.json', 'secrets.json']) await writeFile(join(root, name), name);
    stage = await stageAssets(root);
    assert.deepEqual((await readdir(stage)).sort(), ['_routes.json', '_worker.js']);
    assert.equal(await readFile(join(stage, '_worker.js'), 'utf8'), '_worker.js');
  } finally {
    await rm(root, { recursive: true, force: true });
    if (stage) await rm(stage, { recursive: true, force: true });
  }
});

test('实际 CLI dry-run 离线运行且不泄漏普通变量值和 secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edgetunnel-plan-'));
  try {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify(config({ vars: { KEY_HINT: 'hidden-variable-value' } })));
    const result = spawnSync(process.execPath,
      [resolve('scripts/cloudflare-pages.mjs'), 'deploy', '--dry-run', '--config', file], {
        encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '' }, timeout: 5000,
      });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dryRun, true);
    assert.ok(!result.stdout.includes('sample-test-password'));
    assert.ok(!result.stdout.includes('hidden-variable-value'));
    assert.deepEqual(JSON.parse(result.stdout).secrets, ['ADMIN']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
