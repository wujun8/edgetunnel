import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = 'https://api.cloudflare.com/client/v4';
const ID = /^[a-f0-9]{32}$/i;
const HELP = `Cloudflare Pages 本地发布（Node.js >= 22）
  npm run cf:plan                         离线检查配置，不访问 Cloudflare
  npm run cf:deploy                       创建/复用项目、绑定变量/KV、发布、绑定域名
  npm run cf:domains                      仅绑定域名和 DNS，不发布代码
  npm run cf:deploy -- --config FILE      指定配置（默认 .cloudflare/deploy.json）
配置模板：deploy/cloudflare-pages.example.json
真实操作需要 CLOUDFLARE_API_TOKEN；账号可由 CLOUDFLARE_ACCOUNT_ID 提供。`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, name) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${name} 必须是对象。`);
}

function strings(value, name) {
  object(value, name);
  for (const [key, text] of Object.entries(value)) {
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== 'KV', `${name}.${key}：变量名无效或占用了 KV 绑定名。`);
    check(typeof text === 'string', `${name}.${key} 必须是字符串。`);
  }
}

export function validateConfig(raw, { env = process.env, command = 'deploy' } = {}) {
  object(raw, '配置');
  const allowed = new Set(['accountId', 'projectName', 'productionBranch', 'compatibilityDate',
    'kvNamespaceId', 'kvNamespaceTitle', 'vars', 'secrets', 'domains']);
  for (const key of Object.keys(raw)) check(allowed.has(key), `未知配置字段：${key}`);
  const config = {
    ...raw,
    accountId: raw.accountId || env.CLOUDFLARE_ACCOUNT_ID,
    compatibilityDate: raw.compatibilityDate ?? '2025-11-04',
    kvNamespaceTitle: raw.kvNamespaceTitle ?? `${raw.projectName}-kv`,
    vars: raw.vars ?? {},
    secrets: raw.secrets ?? {},
    domains: raw.domains ?? [],
  };
  check(ID.test(config.accountId || ''), 'accountId 或 CLOUDFLARE_ACCOUNT_ID 必须是 32 位十六进制账号 ID。');
  check(typeof config.projectName === 'string' && /^[a-z0-9][a-z0-9-]{0,57}$/.test(config.projectName),
    'projectName 必须以小写字母或数字开头，仅含小写字母、数字、横线，最长 58 位。');
  check(config.productionBranch === undefined || (typeof config.productionBranch === 'string' && config.productionBranch.trim()),
    'productionBranch 必须是非空字符串。');
  check(/^\d{4}-\d{2}-\d{2}$/.test(config.compatibilityDate)
    && !Number.isNaN(Date.parse(config.compatibilityDate))
    && new Date(config.compatibilityDate).toISOString().slice(0, 10) === config.compatibilityDate,
  'compatibilityDate 必须是有效的 YYYY-MM-DD 日期。');
  check(!config.kvNamespaceId || ID.test(config.kvNamespaceId), 'kvNamespaceId 必须是 32 位十六进制 ID。');
  check(typeof config.kvNamespaceTitle === 'string' && config.kvNamespaceTitle.trim(), 'kvNamespaceTitle 不能为空。');
  strings(config.vars, 'vars');
  strings(config.secrets, 'secrets');
  for (const key of Object.keys(config.secrets)) {
    check(!Object.hasOwn(config.vars, key), `${key} 不能同时出现在 vars 和 secrets。`);
    check(config.secrets[key].trim() && !/^(CHANGE_ME|YOUR_|REPLACE_)/i.test(config.secrets[key]),
      `secrets.${key} 不能为空或保留示例占位值。`);
  }
  check(!Object.hasOwn(config.vars, 'ADMIN'), 'ADMIN 请放在 secrets 中作为加密变量。');
  if (command === 'deploy') check(config.secrets.ADMIN, '发布必须配置 secrets.ADMIN。');
  check(Array.isArray(config.domains), 'domains 必须是数组。');
  const names = new Set();
  for (const domain of config.domains) {
    object(domain, 'domains 项');
    check(Object.keys(domain).every(key => ['name', 'zoneId'].includes(key)), 'domains 项仅支持 name 和 zoneId。');
    check(typeof domain.name === 'string' && domain.name.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain.name),
    '域名必须是小写完整域名，不含协议、端口、路径或通配符。');
    check(ID.test(domain.zoneId || ''), `域名 ${domain.name} 的 zoneId 必须是 32 位十六进制 ID。`);
    check(!names.has(domain.name), `重复域名：${domain.name}`);
    names.add(domain.name);
  }
  if (command === 'domains') check(config.domains.length, 'cf:domains 需要至少配置一个 domains 项。');
  return config;
}

export class CloudflareError extends Error {
  constructor(message, status, codes) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

export class CloudflareApi {
  constructor(token, { fetchImpl = fetch, secrets = [] } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.sensitive = [token, ...secrets].filter(Boolean);
  }

  redact(text) {
    for (const secret of this.sensitive) text = text.split(secret).join('[REDACTED]');
    return text;
  }

  async envelope(method, path, body) {
    let response;
    try {
      response = await this.fetch(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Cloudflare ${method} ${path} 网络请求失败或超时；检查网络后重新运行。`);
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error(`Cloudflare ${method} ${path} 返回了非 JSON 响应（HTTP ${response.status}）。`);
    }
    const codes = (payload.errors || []).map(error => Number(error.code));
    if (codes.includes(8000119)) {
      throw new CloudflareError('8000119：Pages 项目已被 Cloudflare 封禁。请联系 abusereply@cloudflare.com；本地发布不能解除封禁，操作已停止。', response.status, codes);
    }
    if (!response.ok || payload.success !== true) {
      const detail = (payload.errors || []).map(error => `${error.code}: ${error.message}`).join('; ');
      throw new CloudflareError(this.redact(`Cloudflare ${method} ${path} 失败（HTTP ${response.status}）：${detail || '未知错误'}`), response.status, codes);
    }
    return payload;
  }

  async request(method, path, body) {
    return (await this.envelope(method, path, body)).result;
  }

  async list(path, { singlePage = false } = {}) {
    if (singlePage) {
      const result = await this.request('GET', path);
      check(Array.isArray(result), `Cloudflare ${path} 返回了无效列表。`);
      return result;
    }
    const all = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.envelope('GET', `${path}${separator}per_page=100&page=${page}`);
      check(Array.isArray(response.result), `Cloudflare ${path} 返回了无效列表。`);
      all.push(...response.result);
      const total = response.result_info?.total_pages;
      if (total ? page >= total : response.result.length < 100) return all;
    }
  }
}

function projectPath(config) {
  return `/accounts/${config.accountId}/pages/projects/${config.projectName}`;
}

async function getProject(config, api) {
  try { return await api.request('GET', projectPath(config)); } catch (error) {
    // Wrangler 使用 8000007 识别项目不存在，不能将任意 404 当成允许创建。
    if (error instanceof CloudflareError && error.codes.includes(8000007)) return null;
    throw error;
  }
}

function sameTarget(record, target) {
  return record.type === 'CNAME' && record.content.toLowerCase().replace(/\.$/, '') === target.toLowerCase();
}

async function dnsRecords(domain, api) {
  return api.list(`/zones/${domain.zoneId}/dns_records?name=${encodeURIComponent(domain.name)}`);
}

async function preflightDomains(config, api, project) {
  for (const domain of config.domains) {
    const zone = await api.request('GET', `/zones/${domain.zoneId}`);
    check(zone.account?.id === config.accountId, `${domain.name} 的 DNS zone 不属于指定 Cloudflare 账号。`);
    check(zone.status === 'active', `${domain.name} 的 DNS zone 尚未激活。`);
    check(domain.name === zone.name || domain.name.endsWith(`.${zone.name}`), `${domain.name} 不属于 zone ${zone.name}。`);
    const records = await dnsRecords(domain, api);
    if (records.length) {
      check(project?.subdomain && records.length === 1 && sameTarget(records[0], project.subdomain),
        `${domain.name} 已有 DNS 记录；请先核对并手动处理冲突，本工具不会覆盖。`);
    }
  }
}

async function ensureKv(config, api, project, log) {
  const path = `/accounts/${config.accountId}/storage/kv/namespaces`;
  const boundId = project?.deployment_configs?.production?.kv_namespaces?.KV?.namespace_id;
  if (boundId && config.kvNamespaceId && boundId !== config.kvNamespaceId) {
    throw new Error('现有项目的 KV 与 kvNamespaceId 不同；为避免后台数据切换，操作已停止。请核对配置。');
  }
  const id = config.kvNamespaceId || boundId;
  if (id) {
    const namespace = await api.request('GET', `${path}/${id}`);
    check(namespace?.id === id, 'KV 命名空间验证失败。');
    log(`复用 KV：${id}`);
    return id;
  }
  const matches = (await api.list(path)).filter(item => item.title === config.kvNamespaceTitle);
  check(matches.length <= 1, `存在多个同名 KV（${config.kvNamespaceTitle}）；请显式指定 kvNamespaceId。`);
  const namespace = matches[0] || await api.request('POST', path, { title: config.kvNamespaceTitle });
  check(ID.test(namespace?.id || ''), 'Cloudflare 未返回有效 KV ID。');
  log(`${matches.length ? '复用' : '创建'} KV：${namespace.id}`);
  return namespace.id;
}

export async function bindDomains(config, { api, project, log = console.log }) {
  check(project?.subdomain, 'Cloudflare 未返回 Pages 的实际 subdomain，停止域名配置。');
  for (const domain of config.domains) {
    const path = `${projectPath(config)}/domains`;
    const existing = (await api.list(path, { singlePage: true })).find(item => item.name === domain.name);
    if (!existing) await api.request('POST', path, { name: domain.name });
    // 先登记 Pages 自定义域名，再配置 DNS；只有 CNAME 而无关联会导致 522。
    const records = await dnsRecords(domain, api);
    if (records.length) {
      check(records.length === 1 && sameTarget(records[0], project.subdomain),
        `${domain.name} 已有冲突 DNS 记录，停止；不会覆盖或删除记录。`);
    } else {
      await api.request('POST', `/zones/${domain.zoneId}/dns_records`, {
        type: 'CNAME', name: domain.name, content: project.subdomain, ttl: 1, proxied: true,
      });
      log(`创建 CNAME：${domain.name} -> ${project.subdomain}`);
    }
    const result = await api.request('GET', `${path}/${encodeURIComponent(domain.name)}`);
    log(`域名 https://${domain.name}：${result.status || 'unknown'}。`);
    if (result.status !== 'active') log('域名尚未激活：DNS/证书生效后重跑 npm run cf:domains 查看状态。');
  }
}

export async function runDeployment(config, { api, upload, command = 'deploy', log = console.log }) {
  let project = await getProject(config, api);
  if (command === 'domains') check(project, '指定的 Pages 项目不存在；请先执行 cf:deploy。');
  if (config.productionBranch && project) {
    check(project.production_branch === config.productionBranch, 'productionBranch 与现有项目不符；本工具不会更改云端生产分支。');
  }
  // 在创建任何资源前，验证 zone 所属账号和已存在的 DNS，避免误改解析。
  await preflightDomains(config, api, project);
  if (command === 'domains') return bindDomains(config, { api, project, log });
  if (!project) {
    project = await api.request('POST', `/accounts/${config.accountId}/pages/projects`, {
      name: config.projectName, production_branch: config.productionBranch || 'main',
    });
    log(`创建 Direct Upload Pages 项目：${config.projectName}`);
  } else {
    log(`复用 Pages 项目：${config.projectName}`);
  }
  check(project.production_branch, 'Cloudflare 未返回项目的生产分支。');
  const namespaceId = await ensureKv(config, api, project, log);
  const envVars = Object.fromEntries([
    ...Object.entries(config.vars).map(([name, value]) => [name, { type: 'plain_text', value }]),
    ...Object.entries(config.secrets).map(([name, value]) => [name, { type: 'secret_text', value }]),
  ]);
  await api.request('PATCH', projectPath(config), {
    deployment_configs: {
      production: {
        compatibility_date: config.compatibilityDate,
        always_use_latest_compatibility_date: false,
        env_vars: envVars,
        kv_namespaces: { KV: { namespace_id: namespaceId } },
      },
    },
  });
  log(`已配置生产环境变量：${Object.keys(envVars).join(', ')}；KV 绑定名：KV。`);
  await upload(project.production_branch);
  // 使用 API 返回的真实 pages.dev 域名，不能假设一定是 <projectName>.pages.dev。
  project = await api.request('GET', projectPath(config));
  check(project?.subdomain, '发布后未获取到 Pages subdomain，请检查 Cloudflare 控制台。');
  log(`Pages 发布完成：https://${project.subdomain}/admin`);
  await bindDomains(config, { api, project, log });
}

export async function stageAssets(root = ROOT) {
  const directory = await mkdtemp(join(tmpdir(), 'edgetunnel-pages-'));
  try {
    for (const name of ['_worker.js', '_routes.json']) await copyFile(join(root, name), join(directory, name));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function uploadAssets(config, token, directory, branch) {
  const cli = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, 'pages', 'deploy', directory,
      '--project-name', config.projectName, '--branch', branch, '--commit-dirty=true'], {
      cwd: directory,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: config.accountId,
        CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(ROOT, '.cloudflare/logs') },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(
      `Wrangler 发布失败（退出码 ${code}）；操作已停止，未继续绑定域名。若报 8000119，请联系 abusereply@cloudflare.com。`,
    )));
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  let command = 'deploy';
  let configFile = join(ROOT, '.cloudflare/deploy.json');
  let dryRun = false;
  if (args[0] && !args[0].startsWith('-')) command = args.shift();
  check(['deploy', 'domains'].includes(command), '命令只能是 deploy 或 domains；使用 --help 查看用法。');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--config') {
      check(args[i + 1] && !args[i + 1].startsWith('--'), '--config 需要文件路径。');
      configFile = resolve(args[++i]);
    } else throw new Error(`未知参数：${args[i]}`);
  }
  let raw;
  try { raw = JSON.parse(await readFile(configFile, 'utf8')); } catch {
    throw new Error(`无法读取 JSON 配置：${configFile}；请从 deploy/cloudflare-pages.example.json 复制并填写。`);
  }
  const config = validateConfig(raw, { command });
  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true, command, accountId: config.accountId, projectName: config.projectName,
      productionBranch: config.productionBranch || '沿用现有项目；新项目为 main',
      compatibilityDate: config.compatibilityDate,
      kv: config.kvNamespaceId || `优先复用现有绑定，否则查找或创建 ${config.kvNamespaceTitle}`,
      vars: Object.keys(config.vars), secrets: Object.keys(config.secrets), domains: config.domains,
      uploadFiles: command === 'deploy' ? ['_worker.js', '_routes.json'] : [],
    }, null, 2));
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  check(token?.trim(), '请先设置环境变量 CLOUDFLARE_API_TOKEN。');
  if (command === 'deploy') {
    try { await access(join(ROOT, 'node_modules/wrangler/bin/wrangler.js')); } catch {
      throw new Error('未安装 Wrangler，请先运行 npm install。');
    }
  }
  const api = new CloudflareApi(token, { secrets: Object.values(config.secrets) });
  const directory = command === 'deploy' ? await stageAssets() : null;
  try {
    await runDeployment(config, { api, command,
      upload: branch => uploadAssets(config, token, directory, branch),
      log: message => console.log(api.redact(message)),
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
}
