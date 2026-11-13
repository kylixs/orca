# 设计调整：桌面回归原生界面，会话页归管理员（2026-11-13）

> 状态：已确认（用户决策）
> 影响模块：M19–M25（桌面云端壳子）、M42（文件面板）、M46–M51（浏览器链路）

## 1. 决策记录

| 问题 | 决定 |
|---|---|
| 普通开发者登录后看到什么 | Orca 客户端**默认工作界面**，左侧项目列表，终端/文件/git/agent 与本地用法一致 |
| 自造的云端会话页 | **保留**，作为管理员功能 |
| 管理员入口形态 | 从**平台的项目列表页**打开，可**单独用 PC 浏览器**访问，不依赖桌面端 |
| 普通开发者登录入口 | 云端构建的**首启登录页**；已登录则直接进入工作界面 |
| 侧栏多个云项目 | **每项目独立连接** |
| `cloud-file-panel` | **保留**，仅在管理员会话页内使用 |

## 2. 目标形态

```text
普通开发者（桌面）
  首启登录 → 平台返回项目列表 → 每个项目注册为 repo(executionHostId=runtime:<envId>)
  → 自动打开上次/首个项目 → Orca 原生 shell（左侧项目列表 → worktree → 原生面板）

管理员（浏览器）
  平台管理台 → 项目列表 → “打开会话页” → 独立 web 入口
  → 登录平台 → 项目列表 → 打开项目 → 会话信息 + 文件面板（cloud-file-panel）
```

平台仍只做登记与鉴权，不在数据路径上；主机侧边界（M36–M44）对两种界面同样生效。

## 3. 与现状的差距（已核实）

1. `src/renderer/src/App.tsx:97` 用 `<CloudModeGate>` 把整个工作区替换成 `CloudApp` —— 与目标相反。
2. 云项目只注册了运行时环境，**没有注册成 repo**；侧栏数据源是 `repos`，而 `Repo.executionHostId` 已支持 `runtime:<environmentId>`（`src/shared/repo-types.ts:73`）。
3. `CloudSessionState` 丢弃了平台返回的 `roles`，无法区分管理员。
4. `CloudSessionService` 只有一个 `client` + `currentProjectId`（`cloud-session-service.ts:48-50`），不支持多项目并存。
5. `cloud:rpc` / `cloud:closeProject` 没有 projectId 参数，只能作用于"当前项目"。
6. `src/preload/index.ts:185` 无条件暴露 `api.cloud`，而主进程只在 `ORCA_CLOUD_API_URL` 下注册 handler。
7. 会话页组件依赖 `CloudBridge = window.api.cloud`（Electron IPC），**不能在浏览器里直接运行**，需要浏览器侧实现。
8. M45 已把 `workspacePath` 写进环境侧车，原生界面尚未用它做初始导航。

## 4. 调整设计

### 4.1 桌面端：云项目即 repo

- 登录成功后对每个项目 `addRepo({ path: projectRoot, executionHostId: 'runtime:<envId>' })`，侧栏按原生逻辑展示。
- 打开项目走现有 `cloud:openWorkspace`（建工作区 + 注册环境 + 返回 `workspacePath`）；原生面板按 `environmentId` 寻址。
- `CloudSessionService` 改为**按 projectId 的多客户端**：`Map<projectId, {client, environmentId, workspacePath}>`；`cloud:rpc(method, params, projectId)` 与 `cloud:closeProject(projectId)` 显式路由。每项目一条连接，符合设计 §8.4 的每用户每项目 3 会话上限。
- 断线：该项目的 repo 行标记"需重新登录"；M51 的结束信号扩展到多项目（按 projectId 去重）。
- 退出登录：移除全部云 repo、运行时环境与连接。
- 非云端构建行为逐字节不变：`api.cloud` 仅云端构建暴露，`CloudModeGate` 删除。

### 4.2 管理员：浏览器独立会话页

- 新增独立 web 入口（如 `src/renderer/cloud-admin.html` + `src/renderer/src/cloud-admin/main.tsx`），与 Orca Web 分开打包。
- 新增 `CloudBridge` 的**浏览器实现**：登录/项目列表/取票复用 `web-cloud-session.ts`，RPC 复用 `WebRuntimeConnectionTransport`，文件浏览复用 `cloud-file-browser.ts`。组件层（`cloud-app`/`cloud-workbench`/`cloud-project-workspace`/`cloud-file-panel`）不改语义。
- 会话页**独立登录**，不从平台 URL 传递令牌（避免令牌进入浏览器历史/代理日志）。若后续要免二次登录，用一次性短期码换取会话，不复用访问令牌。
- 平台管理台（`cloud-platform/apps/web/`）在每个项目行增加"打开会话页"链接；目标地址可配置（部署时注入），未配置时隐藏。
- 管理员页面只读 + 文件浏览；写操作仍受主机边界与下载策略约束，不因"管理员"放宽。

### 4.3 角色

- 平台登录响应已含 `user.roles`；`CloudSessionState` / `CloudProjectSummary` 增加 `roles`。
- 桌面端不需要管理员入口（管理员改用浏览器会话页），因此角色只用于：会话页显示、以及桌面端是否展示"打开管理台"链接（可选）。

### 4.4 初始导航

- 原生工作区视图在注册环境时读取侧车 `workspacePath`（`cloudWorkspacePathOf`，M45），首次进入直接定位到本人 checkout，而不是停在"未选择工作区"。

## 5. 模块拆分与验收

| 模块 | 内容 | 验收 |
|---|---|---|
| M52 | 桌面端：移除 `CloudModeGate`、`api.cloud` 按构建暴露、登录后注册 repo、删除桌面端对 `CloudApp` 的引用 | 普通桌面构建行为不变（回归测试）；云端构建登录后侧栏出现项目 |
| M53 | `CloudSessionService` 多客户端 + `cloud:rpc(projectId)` 路由 + 断线按项目标记 | 真实平台 + 真实 TLS Runtime：两个项目同时在线，各自 RPC 成功；断开一个不影响另一个 |
| M54 | 管理员浏览器会话页：独立入口 + 浏览器 `CloudBridge` + 平台项目列表链接 | 浏览器打开会话页登录 → 列项目 → 打开项目 → 文件面板列出真实文件；越界路径被拒 |
| M55 | 原生初始导航使用 `workspacePath`；清理桌面端残留 | 进入项目即定位到本人 checkout |
| M56 | 渲染侧云端 e2e 从 `tsconfig.tc.web.json` 拆到独立工程 | `pnpm tc:web` 0 错；新工程 0 错 |
| M57 | 项目创建 provisioning：平台记录 `repoUrl`/`defaultBranch`，主机首次打开时真实 clone 到 `projectRoot`，心跳回报 `ready`/`failed`，客户端显示准备进度 | 真实平台 + 注册主机 + TLS Runtime + 真实 git 远端：新建项目首次打开完成克隆并可建工作区；成功后平台状态 `ready`，失败为 `failed` 且带错误；旧主机（`method_not_found`）仍可打开已有仓库 |

| M58 | 准备失败可见 + 可修复/可重试：`registerProjects` 上报失败项，原生入口显示项目名与错误码并提供重试；平台新增管理员修正 `repoUrl`/`defaultBranch` 并重置为 `provisioning` | 真实平台 + 主机 + TLS + git：坏 repoUrl 首次注册上报失败 → 管理员修正 → 客户端重试真实 clone → 心跳后 `ready`、侧栏 repo 出现 |

| M59 | 开发者自助创建项目：主机上报 `projectsRoot`，平台据此推导路径（开发者不能指定 `path`），创建者自动获得项目权限；客户端新建对话框 → provisioning → 侧栏出现 | 真实平台 + 主机 + TLS + git：非管理员创建 → 主机 clone 到 `projectsRoot/<key>` → 心跳 `ready` → 侧栏 repo 行 |

| M60 | 创建成功但准备失败的项目并入失败横幅：IPC 失败结果带 `projectId`，对话框关闭，条目可走 M58 重试 | 真实平台 + 主机 + TLS + git：坏 repoUrl 创建 → 失败条目含 projectId → 管理员修正 → 重试 clone 成功 → `ready` + 侧栏行 |

### 5.1 M57 项目创建 provisioning（平台不在数据通道）

- **平台**：`POST /v1/projects` 仍 admin-only；有 `repoUrl` → `status: 'provisioning'`，无 → `ready`（路径由管理员备好）。连接票据新增可选 claim `repoUrl`、`defaultBranch`（旧主机忽略未知 claim）。
- **主机**：新增云端专用 RPC `project.provision`（`open` 权限）。路径/URL/分支**全部取自签名票据**，不接受客户端参数；已是 git 仓库 → 直接返回；否则真实 `git clone` 到 `projectRoot`。克隆拒绝 `ext::`、以 `-` 开头的 URL 与非法分支名，失败不留半成品目录，并发打开共用同一路径锁。
- **状态回报**：主机把成功/失败放进下一次心跳 `provisioned: [{projectId, ok, error?}]`；平台只接受本项目所属主机的报告，写审计并把状态改为 `ready`/`failed`。poll 模式主机无心跳，状态停留在 `provisioning`（记为限制）。
- **客户端**：`openCloudWorkspaceOverRpc`（桌面与管理员页共用）在建工作区前先 `project.provision`；`method_not_found` 视为旧主机并跳过。原生入口在准备期间显示非阻塞提示，不隐藏工作区。
- **为什么不做平台推送队列**：平台仍不持有执行路径；首次打开是唯一需要 clone 的时刻，票据已经携带全部所需事实。代价是新项目在第一次打开前不会自动出现在主机上（侧栏在签到注册时触发准备，等价于首次打开）。

## 6. 风险与取舍

- **多连接**：每项目一条 WSS + 一条 E2EE 会话，内存与主机会话配额随之增加；上限仍由主机 3/项目、32/主机约束，客户端不做额外限制。
- **浏览器会话页**：与 Orca Web 是两套入口，但共用取票/传输/数据层，避免第二套协议实现。
- **独立登录**：管理员需在会话页再登录一次。接受这一成本以换取"令牌不进 URL"。
- **保留自造面板**：文件面板与原生的文件树功能重叠，但它只存在于管理员页，不进入开发者主路径，维护成本可控。
