# Orca Cloud 平台 — 开发计划（按模块）

> 版本：1.0（2026-11-13）
> 需求与设计：[../remote-connectivity/design/2026-11-13-cloud-dev-platform/](../remote-connectivity/design/2026-11-13-cloud-dev-platform/)
> 进度：[PROGRESS.md](./PROGRESS.md) · 证据：`evidence/`（已 gitignore，不提交）

## 0. 工程形态

- 独立 workspace `cloud-platform/`，不进入 Orca 根工程 lint / typecheck 流程。
- Node ≥ 22.18 直接执行 TypeScript（type stripping），无构建步骤。
- 零运行时依赖，仅复用仓库已有的 `ws`（通过 `node_modules` 软链）。
- 测试：`node --test`，单元 + 真实进程端到端。

## 1. 模块划分

| 模块 | 目录 | 职责 | 出口条件 |
|---|---|---|---|
| M0 契约 | `packages/contract` | 凭证签名/验签、方法→权限映射、路径边界 | 单元测试全绿 |
| M1 平台 API | `apps/api` | LDAP 登录、会话纪元、项目 ACL、主机注册/心跳、凭证签发、策略、审计哈希链、内部路由/撤销接口 | 单元 + E2E 覆盖 |
| M2 中继 | `apps/relay` | TLS ClientHello SNI 解析、纯 TCP 转发、路由表同步、默认黑洞 | E2E 中继回落通过 |
| M3 运行时替身 + 策略网关 | `apps/runtime` | 升级期凭证闸门、方法级授权、路径边界、导出拦截 | E2E 越权用例通过 |
| M4 客户端 | `apps/client` | 无凭证 TCP 预检、直连优先、中继回落、凭证升级、RPC | E2E 直连/回落通过 |
| M5 Agent | `apps/agent` | 注册、心跳、撤销同步、维护模式 | Web 主机页显示在线 |
| M6 Web 前端 | `apps/web` | 登录、工作台、项目、主机、成员、审计、设置、403 | 浏览器实测截图 |
| M7 端到端 | `test/e2e` | 真实进程 / TCP / TLS / Ed25519 | 全用例通过 + 证据 |
| M114 真实链路 | `deployment-real-link.md`（设计目录） | **114a** 中继注册上报可达地址（已实现）；routeKey 默认改直连 IP `ip-<地址>`（显式配置优先、随心跳自动跟随）；**114b** 独立「中继」管理页 + `/v1/relays` 接口与门禁（已完成 af7621f7511）；**114b2** 向导式添加：主机/中继页一行安装命令 + 平台脚本端点（FR-4.11，已完成）；**114b3** 高保真原型同步（已完成 aca26798b72）；**M115** 自助建项目改造（FR-3.7：名称+目录必填、仓库可选、目录选自心跳清单或新建，已派发）；**M117** 管理员项目详情/会话页入口（FR-3.8：按宿主直连地址生成 cloud-admin.html 链接，已派发）；**M118** 管理台详情页终端+文件树（FR-3.9：实时终端查看与输入、文件树浏览与只读预览，已派发）；**M120** 管控台登记/授权/策略补齐（QA-013/014/015 功能缺口，待派发）；**M121** 浏览器经中继访问宿主 Web 界面（FR-4.12：按宿主浏览器入口 URL + 宿主证书 SAN 扩展，已派发）；**114c** 跨机部署执行（客户端本机 / 中继 100.67.197.59 / 平台 Docker / 开发机 202）；**114d** WAN 口径复测（§5.1、AC-22、多中继） | 直连与中继两条线在真实网络上全通 + §5.1 复测 |

## 2. 证据约定

- 目录：`cloud-platform/evidence/<suite>/`
- 内容：用例 JSON 结果、服务日志、浏览器截图
- `.gitignore` 已忽略 `cloud-platform/evidence/` 与 `**/ui/screenshots/`，不进入提交

## 3. 常用命令

```bash
cd cloud-platform
node --test test/contract.test.ts          # 单元
node --test test/e2e/platform.e2e.test.ts  # 端到端
node apps/api/src/server.ts                # 本地起平台
```

## 当前排期（2026-11-14 回顾，依据工作令与测试缺口）

| 序 | 项 | 来源 | 测试判据 |
|---|---|---|---|
| 1 | W2 QA 修复（P0 用户授权 + P1×11） | M116 探索性测试 | findings.json 逐条回归断言 |
| 2 | **W8 M115 兼容回归**（管理员 path 登记被 INVALID_DIR 拒） | 全量复测 | project-archive e2e 全绿 + 新增回归 |
| 3 | W3 详情入口+双入口（先设计） | FR-3.8/3.11 | test-plan §6 M117 行 |
| 2b | W9 黄金旅程端到端（加主机→建项目→开项目→终端→文件） | 用户要求 | 旅程时间线 + 每步断言 |
| 4 | W4 静态 503 兜底 | 复检 D1 | 单测 503 + 有 bundle 不回归 |
| 3c | W10 客户端首启零环境变量（先设计） | 用户反馈 M119 | 无 env 启动可登录；env 仅预填；设置可改 |
| 5 | W5 详情页终端（先设计） | FR-3.9 | test-plan §6 M118 行 |
| 6 | W6 中继双模式（先设计） | FR-4.12 修订 | test-plan §6 M121 行 |
| 7 | W7 handoff 自动进入（先设计） | FR-3.10 | test-plan §6 M122 行 |
| 8 | M120 管控台补齐（登记弹层/权限矩阵/项目级策略，先设计） | QA-013/014/015 | FR-3.1/9.3/9.4 对应用例 |
| 9 | M119 客户端首启零环境变量（先设计） | 用户反馈 | 首启引导 + 配置界面 + env 仅覆盖 |
| 10 | QA P2×18 打磨批 | M116 | findings.json P2 逐条 |
| 11 | src/renderer+main 全量回归 | 队列清空后 | vitest + tc:web + 相关 e2e |
| 12 | M114c/d 真实链路部署与 WAN 复测 | deployment-real-link | §4 全表 + §5.1 复测 |
| 13 | 环境依赖项（AC-32 WAF、G-04 队列/归档、生产容量、真实 CA、跨平台宿主） | 验收剩余项 | 各 AC 行，待环境 |

