# Cloudflare Pages 本地 CLI 发布

本指南说明如何使用项目提供的本地 CLI 将 edgetunnel 发布到 Cloudflare Pages。此项目使用 Pages advanced mode：CLI 从临时目录上传 `_worker.js` 和 `_routes.json`。

## 环境与配置

需要 Node.js 22 或更高版本。项目脚本固定使用 Wrangler 4.152.0；在仓库根目录安装依赖后即可调用 `cf:*` 命令。

先复制配置样例，并填写自己的 Cloudflare 信息：

```sh
npm install
mkdir -p .cloudflare
cp deploy/cloudflare-pages.example.json .cloudflare/deploy.json
```

编辑 `.cloudflare/deploy.json`，至少替换 `accountId`、`projectName` 和 `secrets.ADMIN`。如果配置了 `domains`，也要替换每个域名的 `zoneId`。样例里的 `YOUR_ACCOUNT_ID`、`YOUR_ZONE_ID` 和 `CHANGE_ME` 都是占位值，不能直接用于发布。

配置字段如下：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `accountId` | 否 | 32 位十六进制 Cloudflare 账号 ID；未填写时从 `CLOUDFLARE_ACCOUNT_ID` 环境变量读取。 |
| `projectName` | 是 | Pages 项目名，只能使用小写字母、数字和横线。 |
| `productionBranch` | 否 | 新建项目默认使用 `main`；已有项目沿用云端分支。若填写的分支与已有项目不一致，CLI 会停止，不会修改云端分支。 |
| `compatibilityDate` | 否 | Workers 兼容日期，默认 `2025-11-04`。 |
| `kvNamespaceId` | 否 | 32 位十六进制 KV 命名空间 ID。迁移已有站点时强烈建议填写原 ID，以保留后台数据。未提供时 CLI 会按项目配置创建或复用 KV。 |
| `kvNamespaceTitle` | 否 | 创建 KV 时使用的标题，默认 `<projectName>-kv`。 |
| `vars` | 否 | 普通环境变量的字符串键值对象，例如 `{"OFF_LOG":"true"}`。 |
| `secrets` | 发布时必填（含 `ADMIN`） | Secret 字符串键值对象。发布需要配置 `ADMIN`；仅绑定域名时可以省略。可按需将 `KEY` 等敏感值放在这里。配置文件中的 Secret 值不会被 CLI 打印。 |
| `domains` | 否 | 自定义域名数组，每项包含 `name` 和 32 位十六进制 `zoneId`。仅支持 Cloudflare 同账号内的 DNS Zone。 |

`accountId` 可以放在配置中，也可以从 `CLOUDFLARE_ACCOUNT_ID` 读取；API Token 只能从 `CLOUDFLARE_API_TOKEN` 环境变量读取，不要将 Token 写入配置文件。`.cloudflare/` 已加入忽略规则，但配置仍含有敏感信息，请勿提交真实配置文件。

迁移旧站点时，使用原有 KV 的 `kvNamespaceId`，并沿用原来的 `ADMIN`、`KEY` 和 `UUID` 值，以保留 KV 后台数据和订阅身份。不要把样例的 `ADMIN` 占位值留在正式配置中。

## 首次发布

创建 Cloudflare API Token，并将权限限制到目标账号和目标 Zone。发布至少需要以下权限：

- Account：Cloudflare Pages Edit。
- Account：Workers KV Storage Edit。
- 绑定域名时，目标 Zone：Zone Read、DNS Edit。

设置 Token 后先运行离线计划，再发布：

```sh
export CLOUDFLARE_API_TOKEN='你的 Cloudflare API Token'
npm run cf:plan
npm run cf:deploy
```

`cf:plan` 执行 `deploy --dry-run`，只在本地校验并生成 dry-run 结果，不访问 Cloudflare，不需要 API Token，也不会创建或修改云端资源。它不能证明账号权限、项目状态、域名或证书在线上可用。

`cf:deploy` 会先校验配置，然后复用指定 Pages 项目；项目不存在时会创建 Direct Upload 项目。CLI 创建或复用 KV，在生产环境设置本次配置中的 vars、secrets 和 `KV` 绑定，再通过 Wrangler 从临时目录上传 `_worker.js` 与 `_routes.json`。远端未显式配置的变量和 KV 绑定会保留。该流程不操作预览环境，也不会自动删除资源。

Wrangler 运行日志保存在被 Git 忽略的 `.cloudflare/logs/`。如果中途失败，已创建的资源或已更新的生产配置会保留；排除错误后可重新执行，脚本不会自动回滚或删除云资源。

可用 `--help` 查看命令用法，也可以通过 `--config /path/to/deploy.json` 指定配置文件；默认路径是 `.cloudflare/deploy.json`。例如：

```sh
node scripts/cloudflare-pages.mjs --help
node scripts/cloudflare-pages.mjs deploy --config /path/to/deploy.json
```

## 自定义域名与重复执行

`cf:deploy` 会处理配置中声明的域名。若只需绑定域名和 DNS，可运行：

```sh
npm run cf:domains
```

CLI 通过 Pages API 绑定每个域名，再将缺失的 CNAME 指向 Cloudflare 返回的实际 `project.subdomain`。已有且指向正确的 CNAME 会复用；同名记录若指向其他目标，CLI 会明确报告冲突并停止，不会覆盖或删除该记录。DNS 传播和证书签发可能需要时间，命令会如实报告 pending 状态；完成 DNS 调整或等待后可重跑 `cf:domains` 查询并继续处理。

`cf:domains` 需要 `CLOUDFLARE_API_TOKEN`、Cloudflare Pages Edit 和目标 Zone 的 Zone Read、DNS Edit 权限，不需要 KV 权限或 `ADMIN`；它只处理域名绑定与 DNS，不会重新上传代码。

重复运行会复用已有 Pages 项目、KV 和正确的 DNS 记录。若 `productionBranch` 与已有项目的分支不同，CLI 会停止并要求配置与云端一致；它不会替你修改远端分支。

已有 Git 连接的 Pages 项目可以手动使用 Wrangler 部署，但 CLI 不会关闭 Git 自动构建，也不承诺将 Git 项目转换为 Direct Upload 项目。请考虑 Git 自动构建可能与手动发布同时发生。

## 参考资料

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages 自定义域名](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages Projects API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/)

本地 dry-run 或文档说明不代表已完成线上发布、域名绑定或证书验收；实际结果以目标 Cloudflare 账号中的执行输出为准。
