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
