# orca web（web-index.html）改造方案（汇总页）

> 背景需求：FR-3.10（handoff 自动进入）、FR-3.12（开发者双形态）、FR-4.12 修订（经中继访问）。
> 实施令：W6（经中继 + 相对 base + WSS 前缀）、W7（handoff 自动进入）。工作令细节以
> work-orders-2026-11-14.md 为准；本文是该客户端组件的**单页汇总**。

## 1. 改造点总览

| # | 改造点 | 内容 | 涉及文件（现状） | 令 |
|---|---|---|---|---|
| 1 | handoff 自动进入 | 启动读 `location.hash` 的 `handoff=<code>&project=<id>` → `POST /v1/web/handoff` 换正式会话 → 自动打开指定项目工作区；hash 用后即清（参照 web-pairing 对 pairing 串的做法）；失败/过期回落登录表单（预填平台地址） | `src/renderer/src/web/main.tsx`（新增 `web-cloud-handoff*`，复用 `web-cloud-session` 换发） | W7 |
| 2 | WSS 路径前缀推导 | 经中继时页面在 `/h/<routeKey>/` 下，运行时构造 runtime WSS URL 需从 `location.pathname` 推导前缀拼在固定 rpc 路径前；直连（无前缀）行为不变 | web 云连接/传输层 URL 构造处（`web-cloud-connect`、runtime transport builder） | W6 |
| 3 | 资源相对 base | 构建产物资源改相对路径（vite `base: './'`），使 `/h/<routeKey>/web-index.html` 引用 `/h/<routeKey>/assets/...`；直连无前缀天然兼容；verify-web-build 校验保持 | vite web 构建配置 + `verify-web-build.mjs` | W6 |
| 4 | 会话恢复优先级 | 启动决策顺序：显式 handoff > localStorage 已存会话（M62）> 登录表单；handoff 成功后覆盖存储 | `web-session-recovery` / `web-runtime-environment` | W7 |
| 5 | 错误回落 | code 410/403/网络错误分别提示；清 hash 回登录表单（WebConnectCloudForm 预填平台地址） | `WebConnect.tsx` / `WebConnectCloudForm.tsx` | W7 |

## 2. 打开链路（改造后）

平台 Web 项目行「Orca Web」→ `POST /v1/projects/{id}/web-handoff`（一次性 60s code）→ 新标签
`https://<宿主直连 | 中继/h/<routeKey>>/web-index.html#handoff=<code>&project=<id>` → 页面换会话 →
自动进工作区 → 终端/文件（WSS+E2EE：直连宿主 或 经中继 TLS 终结路径转发）。平台不在数据路径。

## 3. 分支与错误

- code 过期/重放 → 410；无权限 → 403；网络失败 → 内联错误 + 回落登录表单。
- 浏览器会话恢复失效 → 清存储回登录表单（既有 M62 语义）。
- 同浏览器多项目：每项目独立会话与连接（对齐 M53 桌面语义，W7 验证）。

## 4. 测试（判据随 test-plan §6 M121/M122 行）

- 平台侧：签发→换发→重放 410→过期 410→无权限 403；审计 `web_handoff`。
- web 侧：hash 清除、自动打开、回落表单、WSS 前缀构造、相对 base 资源加载（无 404）、直连回归。
- e2e：链路 B 冒烟（B1–B8）随 W9 双线黄金旅程收口。

## 5. 相关文档索引

- 链路与安全语义：`deployment-real-link.md` §4b、`design.md` §4.3.2（中继双模式）
- 验收判据：`test-plan.md` §6（M121/M122 行）、`business-chain-tests.md` §2（链路 B）
- 工作令细节：`work-orders-2026-11-14.md` W6/W7 及附录设计要点
