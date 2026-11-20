# W13 设计方案 · Orca Web 云工作区视图（宿主 `workspace.info` + web 工作区视图）

> 状态：设计稿，待主会话审定后派实现代理（本令只设计不实现）
> 日期：2026-11-14 · 缺陷账：U16🟡（defect-ledger）· 回归基准：B 线旅程 B4–B6 全绿
> 依据：work-orders-2026-11-14.md（W13 立项与 W5c 节）· PROGRESS.md「W9b 中程读数 + W13 立项」裁定 ·
> `cloud-platform/evidence/journey-golden-b/findings.json`（B4 红线）·
> `cloud-platform/evidence/w7c-startup-scope/w7c-change-manifest.json`（O2 已知边界 + cloudMethodTable.extended=false 裁定）·
> design.md §7.3（默认拒绝/权限模型/写边界=workspaceRoot）§8.3（step 3 checkout ensure）§9（路径边界与下载管控）· FR-3.9 / FR-3.12

---

## 0. 结论摘要

1. **宿主**：新增云专属方法 `workspace.info`（镜像 `project.provision` 的登记方式：独立 `WORKSPACE_INFO_METHODS`，仍排除在 `ALL_RPC_METHODS` 之外，仅在 `cloudAdmissionOption` 的云方法表扩展里注册）。**云权限表零改动**——`cloud-rpc-permission.ts` 的 `SESSION_METHODS` 早已列名 `workspace.info`（`'session'` 级），这次只是把宿主侧缺失的实现补上（O2）。
2. **返回值**：只从票据字段（projectId/projectRoot/workspaceRoot/repoUrl/defaultBranch）+ 一次限定在 workspaceRoot 内的 checkout 查询推导，外加票据 `perms` 回显。无参数、只读、幂等；未 ensure 时 `workspace.path=null` 是正常态而非错误。
3. **web**：不新造工作区组件。在 web 启动链的云分支（W7c 跳过原生目录加载的位置）插入一段**云工作区 bootstrap**：`workspace.info` → 复用共享的 `openCloudWorkspaceOverRpc`（provision + worktree.list + worktree.createManaged，幂等键防重复建检出）→ `repo.add`（宿主把 path 钉死到票据 projectRoot）→ `fetchWorktrees` → `setActiveWorktree`。此后**现有 App 原生面**（侧栏项目/工作区行、文件树 explorer、编辑器、终端、git 面板）原样点亮，满足 FR-3.12「功能面对等」与被 skip 的 B4 流式用例（`[data-orca-explorer-shell]` + editor + `.xterm-rows`）。
4. **边界**：W7c 的云会话跳过清单、`CloudSessionEmptyState` 兜底、原生侧栏骨架、云权限表、移动/配对路径——全部不动。越权负向面（repo.list / ssh.* / worktree.ps / terminal.list / download 策略等）继续被拒并走既有 `method_denied`/`path_denied` 审计。
5. **与 W9b 裁定的关系**：裁定「不走 repo.add hack（绕过平台登记语义）」针对的是**客户端自行猜测/拼路径**绕开宿主边界。本方案的 `repo.add` 调用 path 唯一来源是宿主 `workspace.info`（=票据），且宿主侧 `checkProjectRootTarget` 会把任何非票据 projectRoot 的 path 拒绝（`project_scope`）——平台登记语义由宿主执行而非客户端自觉，属既有云方法表内的正路（桌面云入口同语义）。替代方案（宿主侧在 workspace.info 里做登记/建检出）因把只读自省方法变成变异方法被否（本文 §10）。
6. **两个翻转前提（W9b 审计补充，本文 §7）**：① web bundle 从不传 `--mode e2e`，被 skip 用例依赖的 `window.__monacoEditorE2E` 编辑器 oracle 永不安装——探针门改为复用既有 `VITE_EXPOSE_STORE` 信号（方案 a）；② 旅程 spec 内 `W13_CLOUD_WORKSPACE_VIEW_LANDED` 常量、B4 tripwire（`throw 'W13 landed: flip this step…'`）与流式用例 skip 三处必须同一提交联动翻转。验收=B 线旅程 B4（重写后）–B6 与流式用例全绿。

---

## 1. 背景与根因（B4 红线）

- journey-golden-b `findings.json` B4：handoff 自动进入后侧栏仅有 `Cloud project session` 空态；store 零 repo、无 active worktree；`repo.list` 按票据范围被拒（设计如此）；`worktree` 目录无 repo 可列——**浏览器里没有任何可驱动的终端/文件树入口**。
- 根因两条（与工单一致）：
  1. 宿主 `workspace.info` 在 `src/main/cloud-platform/cloud-rpc-permission.ts:13` 列为 session 方法，但 runtime 方法表（`ALL_RPC_METHODS` / 云扩展表）**没有该方法**——云会话拿不到自己票据对应的项目根/工作区信息。票据本身携带 `projectRoot/workspaceRoot/repoUrl?/defaultBranch?`（`cloud-credential.ts`），但 web 渲染层只持有 pairing offer 的 `credential + devicePublicKey`（`web-pairing.ts`），**拿不到票据字段**，必须问宿主。
  2. web 云会话未挂工作区视图：`WorktreeList.tsx:267` 在云会话且无行时渲染 `SidebarCloudSessionEmptyState`，App 主面没有任何入口。
- 已知边界出处：w7c manifest `knownBoundaries[0]`（本工单）、`knownBoundaries[1]`（流式订阅需 W5c 重签，已落地）、W7c「云方法表不扩充」裁定（防宿主全域泄露——W13 同样**不扩充表**）。
- 目标验收：B4–B6 全绿 = 侧栏出现该项目行并激活工作区、终端流式回显（W5c 重签订阅断言 ≥2 次 `/connect`）、explorer 打开种子文件进编辑器、旧链接重放 410 回落、证据落盘。

---

## 2. 复用资产清单（Reuse Before Reimplementing）

| 资产                                                         | 位置                                                                                                         | 在 W13 中的角色                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `openCloudWorkspaceOverRpc` / `provisionCloudProjectOverRpc` | `src/shared/cloud-workspace-open.ts`                                                                         | ensure checkout（provision→list→createManaged，幂等键 `cloud-open:<projectId>:<branch>`），桌面 main 与管理台桥已在用，web 直接复用 |
| `selectCloudInitialWorktreeId`                               | `src/shared/cloud-initial-worktree.ts`                                                                       | 按 workspacePath 精确匹配选中初始工作区                                                                                             |
| `cloudProjectRepoTarget` / `syncCloudProjectRepos`           | `src/renderer/src/cloud/cloud-project-repos.ts`                                                              | repo 行目标构造与幂等去重语义参考（web 侧取数源不同：workspace.info 而非平台环境对象）                                              |
| `addRepoPath` / `fetchWorktrees` / `setActiveWorktree`       | App store（web preload shim 已覆盖：`web-repositories-api.ts` / `web-worktrees-api.ts`）                     | 侧栏行与工作区目录水合、激活                                                                                                        |
| `WebRuntimeClient`（`call` + `subscribe`）                   | `src/renderer/src/web/web-runtime-client.ts`                                                                 | 一元 RPC 走主 socket；流式订阅自动走 W5c 重签子 socket                                                                              |
| W5c 重签订阅                                                 | `web-runtime-child-ticket-offers.ts` + `attachTicketReSigner`（handoff 接线已在 `web-cloud-connect.ts:238`） | 终端 `terminal.multiplex` 子连接的短票（AC-29 主机键钉扎已含）                                                                      |
| W9A-7 multiplex 云准入                                       | `cloud-terminal-multiplex-boundary.ts` + `terminal-multiplex-method.ts`                                      | 云会话订阅帧级 workspace-scope 边界（唯一解析点 + path_denied 审计）                                                                |
| W5b files.* 权限映射                                         | `cloud-rpc-permission.ts` READ/WRITE + `cloud-file-path-params.ts` 路径参数声明表                            | explorer 读写全部走既有映射与路径护栏，**零表改动**                                                                                 |
| `project.provision` 方法范本                                 | `src/main/runtime/rpc/methods/project-provision.ts`                                                          | 云专属方法的登记/上下文/错误形态范本                                                                                                |
| W9A-6 槽位记账                                               | `cloud-session-limits.ts`（≤3 设备/用户/项目、≤12 socket/设备会话、≤32/主机）                                | bootstrap 零新增 socket，预算不变                                                                                                   |
| W9A-5 pairing 身份                                           | `cloud-runtime-environment.ts`（同键不轮换）                                                                 | web bootstrap 全程渲染层 RPC，不触发 main 登记路径，pairing 零轮换                                                                  |

---

## 3. 宿主 `workspace.info` 设计

### 3.1 方法契约

```ts
// src/main/runtime/rpc/methods/workspace-info.ts（新文件，命名对齐 project-provision.ts）
export const WORKSPACE_INFO_METHODS = [
  defineMethod({
    name: 'workspace.info',
    permission: 'workspace',          // RpcMethodPermission：非云调用方的静态档位
    params: null,                     // 无参数 = 无可伪造的寻址面
    handler: async (_params, context) => {
      const cloud = context.cloud
      if (!cloud) {
        return { ok: false, code: 'CLOUD_SESSION_REQUIRED', message: '...' }  // 同 project.provision
      }
      // 1) 票据字段直出；2) 在 workspaceRoot 内查既有 checkout；3) 读其分支
      ...
    }
  })
] as const
```

- **登记位置**：`src/main/startup/cloud-runtime-admission.ts:349` 的扩展表 `[...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS, ...WORKSPACE_INFO_METHODS]`。与 `project.provision` 同理：非云宿主的方法表根本没有该方法。
- **云权限表零改动**：`cloudMethodAccess('workspace.info')` 已返回 `'session'`，`cloudMethodDenial` 直接放行（任何通过准入的云会话可调，含仅 `open` 权限者）。W7c「不扩充表」裁定保持。
- **非云调用方**：owner（桌面自己）与 `runtime-paired`（配对桌面/web）静态档位均为 `workspace`，会进入 handler 然后收到 `CLOUD_SESSION_REQUIRED` 普通错误回包（与管理台域一致，不写云拒绝审计——该审计只属于票据会话的拒绝）。mobile 走 allowlist，未列名 → `forbidden`，行为不变。

### 3.2 返回值

```ts
type CloudWorkspaceInfo = {
  project: {
    id: string // = 票据 payload.project（平台项目 id）
    root: string // = 票据 payload.projectRoot
    repoUrl: string // = 票据 payload.repoUrl ?? ''（旧票缺省空串，与 CloudRpcSession 对齐）
    defaultBranch: string // = 票据 payload.defaultBranch ?? ''
  }
  workspace: {
    root: string // = 票据 payload.workspaceRoot（该用户在该项目下的检出根）
    path: string | null // 已存在的检出路径；null = 尚未 ensure（首次打开是正常态）
    branch: string | null // 该检出的当前分支；path 为 null 或 git 读取失败时为 null
  }
  perms: CloudPermission[] // 票据 perms 回显（渲染层据此做权限感知降级，免二次探测）
}
```

- `path` 的取法：宿主内部调用 `worktree.list` 等价逻辑（`runtime.listManagedWorktrees('path:<projectRoot>')`），过滤出位于 workspaceRoot 内的第一行（谓词与 `cloud-workspace-open.ts` 的 `existingWorkspacePath`/`isInside` 同一语义，实现时把该判定提升为共享函数复用，不写第二份）。**返回的是路径，不返回 App 行 id**——工作区行 id 由渲染层在 `fetchWorktrees` 后用 `selectCloudInitialWorktreeId` 解析，宿主不耦合 App 的 `repoId::path` 行格式。
- `branch`：对 `path` 做 `git rev-parse --abbrev-ref HEAD` 级读取（宿主本地、加超时与失败即 null）；不成功不使整个调用失败。
- **字段即白名单**：结构测试断言响应键集合恰为上表（`workspace.info` 是自省方法，多吐一个字段就是一次边界事故）。

### 3.3 per-project 票据语义下的信息边界（不得泄露宿主全域）

| 数据                                                                                           | 是否返回                                               | 理由                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| 本票据 project/workspace 根、repoUrl、defaultBranch、perms                                     | 是                                                     | 票据本来就在准入时签给该会话                                           |
| workspaceRoot 内该用户自己的检出路径/分支                                                      | 是                                                     | §8.3 step 3 的自省目的                                                 |
| workspaceRoot 内**其他成员**的检出路径                                                         | 否（`workspace.path` 只取本票据 workspaceRoot 内的行） | 见下「已知共享边界」                                                   |
| 宿主全域 repo 目录、其他项目、其他用户会话、SSH 目标、设备/配对表、宿主自身路径（userData 等） | **否**                                                 | W7c 裁定的泄露面，一个字段都不加                                       |
| 工作区之外的文件系统信息                                                                       | 否                                                     | 读边界=projectRoot（resolveRealPath 后），写边界=workspaceRoot（§7.3） |

> **已知共享边界（如实记录，不在 W13 扩面）**：既有 `worktree.list` 对云会话按 repo 粒度放行（`checkRepoScopedRead` 只验 repo 在 projectRoot 内），因此同一 repo 下队友检出的路径/名称对会话「读可达、写不可驱」——W9A-7 审计已实证并接受。`workspace.info` 不扩大它（只返回本 workspaceRoot 内的第一条）；可选硬化（宿主侧对云会话的 `worktree.list` 结果按票据 workspaceRoot 过滤）列为本文 §9 开放问题 Q3，不在本令实施。

### 3.4 幂等与错误路径

- **只读、无参数、无副作用**：可在每次 boot、每次传输重连后重复调用；不写宿主状态、不建检出（ensure 是客户端显式走 `openCloudWorkspaceOverRpc`）。
- `workspace.path=null`（未 ensure）与 `branch=null`（git 读取失败）是**正常应答**，不是错误——首开、克隆中、竞态删除都不该让调用方降级。
- 唯一错误形态：`CLOUD_SESSION_REQUIRED`（非云调用方）。其余失败（内部异常）走 dispatcher 既有 `internal_error` 兜底。
- **旧宿主兼容（混合版本常态）**：老宿主方法表无此方法，且 `denyRpcMethodForCaller` 对「本构建未注册的方法」放行到 dispatcher → 云会话收到 `method_not_found`（不会是 `forbidden`，因为 session 级在表内已放行）。web 端把 `method_not_found` 明确解释为「宿主早于 W13」→ 保留 W7c 云空态（§4.4），**不重试、不降级启动**。
- 限速：`meteredRead` 仅作用于 `file:read`（`runtime-rpc-websocket-dispatch.ts:104`），session 级不计读配额；调用频率由渲染层约束（每次 boot 一次 + 重连后一次）。

### 3.5 与 W9A-5 / W9A-6 的衔接

- **W9A-5（pairing 身份）**：bootstrap 全部是渲染层 → WebRuntimeClient 的 RPC，不经过 main 的 `registerCloudRuntimeEnvironment`，不产生 pairingRevision 轮换、不触发 `purgeStaleRuntimeHostState`。侧栏行的 `runtimeOwnerEnvironmentId` 直接取 web 环境记录 id（`toRuntimeExecutionHostId(environment.id)`，与 `cloudProjectRepoTarget` 同法）。
- **W9A-6（槽位记账）**：bootstrap 新增 **0 条 socket**——`workspace.info`、`repo.add`、`project.provision`、`worktree.list`、`worktree.createManaged` 都是一元 RPC，走已准入的主连接。点亮工作区后的稳态 socket 清单：主连接 ×1 + `terminal.multiplex` 子连接 ×1（W5c 重签票）+（可选）agent 流子连接 ×1；`files.watch` 走主连接共享订阅（`SHARED_CONNECTION_SUBSCRIPTION_METHODS`）。预算 ≤12 socket/设备会话、≤3 设备/用户/项目、≤32/主机均不收紧；测试断言稳态 ≤3（旅程里已有 `/connect` 计数探针可复用）。

### 3.6 权限点与拒绝审计（宿主侧汇总见 §5 表）

- `workspace.info` 自身：`'session'`；拒绝审计不新增代码——云会话的权限/路径拒绝仍由 `onCloudDenial` 落 `method_denied`/`path_denied`；非云调用方的 `CLOUD_SESSION_REQUIRED` 是普通错误回包（同 `project.provision` 先例）。
- 票据字段仅来自 `context.cloud`（宿主只读副本，`runtime-rpc-websocket-dispatch.ts:244` 注入），参数通道不存在 → 客户端无法借该方法是出越权地址。

---

## 4. web 云会话工作区视图设计

### 4.1 总体：以 `workspace.info` 为权威的启动期 bootstrap

三阶段，全部走已准入主连接：

```
① info      workspace.info → {project, workspace, perms}
            失败/method_not_found → 维持 W7c 云空态（见 4.4）
② ensure    openCloudWorkspaceOverRpc(rpc 适配器, project.id, roots)   ← 共享模块原样复用
            project.provision → worktree.list → worktree.createManaged（幂等键防重复检出）
③ adopt     repos.add({path: project.root, kind:'git', displayName: 项目名})   ← 宿主钉 path
            fetchWorktrees(repo.id) → selectCloudInitialWorktreeId(workspace.path)
            setActiveWorktree(worktreeId, runtimeExecutionHostId)
→ 现有 App 面点亮：侧栏项目/工作区行、explorer 文件树、编辑器、终端、git 面板
```

- **接线点**：`use-app-startup-hydration.ts` 云分支。现状 `cloudRuntimeSession=true` 时跳过 `fetch-repos-local`/项目组/文件夹工作区（W7c）；W13 在同一位置**启动** `runWebCloudWorkspaceBootstrap(...)`（独立模块，保持 hydration 钩子 max-lines 棘轮不破）。时序语义：启动点在 `hydrateWorkspaceSession` 之前（凡是先完成，首次稳定渲染即工作区形态）；但启动链**不 await** 它——ensure（首开含克隆）可达分钟级，等待会把云会话重新拖回慢启动/降级风险区。侧栏先呈现云卡（bootstrap 态），repo/worktree 行就绪后自然替换。
- **每页一次**：模块级 in-flight promise 去重；传输重连（statusOwner 回到 ready）后允许幂等重跑一次。
- **无桌面环境参与**：不触 `cloud:openWorkspace` IPC、不触平台 API（handoff 已换得会话），全程一张票一个 socket。

### 4.2 模块与命名（避免 generic 名）

| 新文件                                                                                       | 职责                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/main/runtime/rpc/methods/workspace-info.ts`                                             | `WORKSPACE_INFO_METHODS`（宿主实现）                                                                                   |
| `src/shared/cloud-workspace-info.ts`                                                         | 响应字段清单 + `readCloudWorkspaceInfo` 读取器（宿主/web/测试三方同一契约）                                            |
| `src/renderer/src/web/preload-api/web-cloud-workspace-api.ts`                                | web preload 新可选命名空间 `cloudWorkspace`（`info()` + `ensure()`，内部走 `callRuntimeResult`；桌面侧该命名空间缺席） |
| `src/renderer/src/web/web-cloud-workspace-bootstrap.ts`                                      | 三阶段 bootstrap + 状态机（供 hydration 调用；`resetWebCloudWorkspaceBootstrap` 供测试）                               |
| `src/renderer/src/components/sidebar/worktree-list/listing/CloudSessionEmptyState.tsx`（改） | 增 bootstrap 态呈现（connecting/failed + 原因文案），不改动原生骨架                                                    |

### 4.3 权限感知降级（perms 回显的用途）

| 票据 perms                | 呈现                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| 仅 `open`                 | 侧栏项目行出现（repo.add 允许），无工作区激活（worktree.list 需 `terminal`）→ 云卡显示「未授予终端权限」 |
| +`terminal`               | ensure + 激活工作区；终端可用；explorer 仅在也有 `file:read` 时挂载                                      |
| +`file:read`/`file:write` | explorer/编辑器按既有面板能力呈现；`download` 缺失或策略 deny → 导出项按既有隐藏/禁用语义                |
| 任一步被宿主拒            | 该面降级为占位/空态（同 W5a 管理台「无授权占位」语义），**不报错弹窗、不降级启动**                       |

### 4.4 状态机与失败回落（含 W7c 兜底保留）

```
bootstrap: idle → loading(info) → ensuring → seeding → done
                    ↘ method_not_found / 任一步失败 → fallback（云空态 + 原因行）
```

- **`method_not_found`**（旧宿主）：fallback 文案 =「此开发机版本尚不支持云工作区视图」，无重试按钮（重试无意义）。
- **ensure 失败**（克隆失败 / `PROJECT_NOT_PREPARED` / 超时）：fallback 文案带可重试（重试 = 重跑 ensure+seeding；幂等键防重复检出；与 W12 的 PROJECT_NOT_PREPARED 闭环兼容——本项目场景下 W12 是前置条件而非本令范围）。
- **W7c 兜底不动**：`repo.list/projectGroup.list/folderWorkspace.list/ssh.*/worktree.lineageList/runtime.clientEvents.subscribe/worktree.ps` 的跳过清单、`runtime-client-ipc-bridge`/`direct-ssh-state-ipc-bridge` 的云分支、降级 toast 断言，全部保持；bootstrap 的失败被自身 try/catch 吸收，**不允许**把降级启动重新引入云会话。
- **云空态组件保留**：行就绪前/失败时仍渲染（升级为可带 bootstrap 态），`data-worktree-sidebar-container` 与 context-tour 锚不变。

### 4.5 原生侧栏并存原则

- 云项目的 repo 行是**该云环境作用域内的一行**，挂在 web 环境的 runtime execution host 下；桌面目录族仍被拒，因此除这一行外侧栏不会出现任何桌面目录内容——「云是附加通道，不破坏原生形态」不变。
- 行为对齐桌面云入口（`cloud-entry-workspace-sync.ts`）的同构语义：同 `(executionHostId, path)` 幂等、displayName 取平台项目名（`repo.update` 对云拒绝 → 沿用 `renameRepo` 的渲染层本地改名技巧，`cloud-project-repos.ts:24` 先例）。
- 宿主侧效果：`repo.add` 在宿主 repo 目录登记 projectRoot（幂等，`runtime-repository-registration-controller.ts:51` 同路径返回既有行）——与桌面云入口今天的行为一致，非新增宿主状态类别。

### 4.6 点亮面清单与「仍被拒」预期（O1 边界）

**点亮（既有护栏内）**：explorer（`files.readDir/listAll/stat/readPreview/readDocPreview/searchPaths/pathsExist`，project-relative 路径护栏）、编辑器（`files.read/readChunk`）、写操作（`files.write/createFile/rename/delete/...`，写边界=workspaceRoot）、文件监视（`files.watch` 共享连接）、终端（`terminal.create`（worktree 选择器 → workspaceRoot）+ `terminal.multiplex` 流（W5c 子票 + W9A-7 帧级边界）+ `terminal.send/updateViewport/close`）、git 面板（`git.*` → `terminal` 权限 + cloud-git-scope）、agent 面（`agent.*` → `agent` 权限）。

**仍被拒（预期内，渲染层须容忍）**：`repo.list`、`projectGroup.list`、`folderWorkspace.list`、`ssh.*`、`worktree.lineageList`、`worktree.ps`、`worktree.set`、`worktree.create`（提示走 managed）、`runtime.clientEvents.subscribe`、`terminal.list/split/closeAll/focus/...`（宿主窗面族）、`files.browseServerDir`、`files.readTerminalArtifact*`、`files.resolveTerminalPath`、`sessions.*`、download 族（无 `download` 权限或策略 deny 时）。

**执行要求**：实现代理必须跑一次「点亮面清单」——在真栈云会话里驱动 explorer/终端/git 各一次，收集全部 `not available to cloud sessions` 控制台拒绝，逐条归类「预期内已容忍」或「新发现的坏路径」；后者**不修**（记入 O1 清理单），只保证不出现白屏/崩溃/卡死。

---

## 5. 权限与安全（逐项）

### 5.1 cloudMethodAccess 权限点表（W13 流实际触碰的方法）

| 方法                                        | cloudMethodAccess                                                   | 路径/目标护栏                                                                                     | 拒绝审计                                                   |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `workspace.info`                            | `session`（既有，**零改动**）                                       | 无参数；宿主只回票据域内数据                                                                      | 非云调用 → `CLOUD_SESSION_REQUIRED` 普通回包（不入云审计） |
| `project.provision`                         | `open`（既有）                                                      | 宿主只读 `context.cloud`                                                                          | 既有                                                       |
| `worktree.list`                             | `terminal`（既有）                                                  | `checkRepoScopedRead`：repo 须在 projectRoot 内                                                   | `path_denied / PATH_OUTSIDE_ROOT`                          |
| `worktree.createManaged`                    | `terminal`（既有）                                                  | 绝对目标须在 workspaceRoot 内                                                                     | 同上                                                       |
| `repo.add`                                  | `open`（既有）                                                      | `checkProjectRootTarget`：resolveRealPath 后恰等于票据 projectRoot                                | 同上                                                       |
| `files.readDir/read/...`                    | `file:read`（既有）                                                 | `CLOUD_FILE_PATH_PARAMS` 声明 + projectRoot 读边界；未声明路径段的方法一律 `path_unverifiable` 拒 | 同上                                                       |
| `files.write/...`                           | `file:write`（既有）                                                | workspaceRoot 写边界（符号链接解析后）                                                            | 同上                                                       |
| `files.watch/unwatch`                       | `file:read`（既有）                                                 | 同读边界                                                                                          | 同上                                                       |
| `git.*`                                     | `terminal`（既有前缀）                                              | cloud-git-scope（工作目录边界）                                                                   | 同上                                                       |
| `terminal.create/send/updateViewport/close` | `terminal`（既有前缀）                                              | create：worktree→workspaceRoot；handle 族：句柄→workspaceRoot                                     | 同上                                                       |
| `terminal.multiplex`                        | `terminal`（既有）                                                  | 信封无条件、**每条订阅帧**在唯一解析点验 workspace-scope（W9A-7）                                 | 帧级 `path_denied`（reason=workspace_scope）               |
| `agent.*`                                   | `agent`（既有前缀）                                                 | 既有 agent 边界                                                                                   | 同上                                                       |
| download 族                                 | `download` + 策略 `downloadAllowed` 优先（§9.3 策略 outranks 票据） | 既有                                                                                              | `method_denied`                                            |

**结论：云权限表（`cloudMethodAccess`）零新增行、零改动；`SESSION_METHODS` 不变；契约包 `METHOD_RULES`（含 `workspace.info: null`）本就一致，无平台侧改动。**

### 5.2 越权负向设计（必须做成可回归断言）

1. `workspace.info` 由配对桌面 / mobile / CLI 调 → `CLOUD_SESSION_REQUIRED`（mobile 为 `forbidden`/allowlist）；响应结构测试钉死字段白名单（§3.2）。
2. 伪造票据（自签 projectRoot 含 `..`）→ 准入/注册层拒绝（既有 `cloud-project-root.test.ts` 语义），不因新方法产生新通路。
3. `workspace.info` 拿到的 `project.root` 不能扩大后续调用：路径护栏始终从 `context.cloud` 重新取根，客户端声称的路径零效力（负向：`repo.add` 传相邻目录、`files.write` 传 `../`、`terminal.create` 指向队友检出 → 全部 `path_denied` 且审计入库）。
4. 越权探测不产生副作用：`workspace.info` 只读；bootstrap 的 ensure 幂等键 `cloud-open:<projectId>:<branch>` 保证重试/并发不重影检出（既有语义复用）。
5. 下载策略 deny 下，explorer 的导出项被客户端隐藏 + 宿主 `files.download` 仍拒（双层既有语义，补一条云会话断言）。
6. 订阅越界：`terminal.multiplex` 订阅队友检出句柄 → 流错误 + 零快照 + `path_denied`（W9A-7 既有断言迁移复跑即可）。

---

## 6. 测试设计

### 6.1 分层

| 层                 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                     | 形态                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主单测           | `workspace-info`：云上下文→票据字段直出；无检出→`path/branch=null`；有检出→路径+分支；git 读失败→branch=null；非云→`CLOUD_SESSION_REQUIRED`；响应键白名单                                                                                                                                                                                                                                                                | 纯 vitest（伪造 context）                                                                                                                                              |
| 真宿主方法表       | `cloud-runtime-admission` 扩展表含 `WORKSPACE_INFO_METHODS`；**production 方法表真实宿主**：真平台+TLS 云宿主上 `workspace.info` 可答、返回值与登记项目一致；非云宿主对该方法 `method_not_found`（owner 侧）                                                                                                                                                                                                             | 真栈套件，**必须登记 `config/scripts/vitest-node-runtime-files.mjs` 的 `NODE_RUNTIME_INCLUDE`**（W5b 缺陷 B1 / W9A-7 MAJ-1 同型教训：bun 池过不了自签 TLS + node-pty） |
| web bootstrap 单测 | 三阶段成功路径（repo 行+激活）；`method_not_found`→空态保留；ensure 失败→可重试空态；失败不降级启动（hydrationSucceeded 仍 true）；W7c 跳过清单不被触碰；重连重跑幂等；每页一次去重                                                                                                                                                                                                                                      | renderer vitest（VITE_EXPOSE_STORE 探针可复用旅程的 `window.__store` 断言法）                                                                                          |
| 旅程翻转           | `tests/e2e/cloud-golden-journey-orca-web.spec.ts`：`W13_CLOUD_WORKSPACE_VIEW_LANDED = true`（与 W13b 同提交翻转）——B4 改为断言工作区表面（侧栏行、`repos.length===1`、`activeWorktreeId` 非空、无降级 toast、**零 cloud-denial 控制台错**）；启用被 skip 的「终端流式回显 + 文件树打开」用例（≥2 次 `/connect`、回显 marker、`[data-orca-explorer-shell]` 开种子文件→编辑器内容断言、宿主审计零 `replayed`）；B5/B6 不动 | Playwright 真栈（既有 spec，隔离 worktree 构建）                                                                                                                       |
| 越权负向           | §5.2 全表                                                                                                                                                                                                                                                                                                                                                                                                                | 宿主单测 + 真栈负向（`path_denied`/`method_denied` 审计断言，沿 W9A7-2 断言口径：事件类型 + reason + 无意外同级事件）                                                  |
| 零回归             | ① mobile：allowlist/移动流式套件双 runner；② 配对 web（非云）与桌面：web+ipc-events+sidebar+App 云入口族、cloud-admin session e2e（W5b）、平台 web e2e（handoff 24 例）；③ W7c 套件原样全绿（空态组件测试更新为含新 bootstrap 态）；④ 原生桌面逐字节不变（不触 `ALL_RPC_METHODS`、不触桌面启动链）                                                                                                                       | 既有套件矩阵                                                                                                                                                           |
| 点亮面清单         | §4.6 的实测拒绝清单落 JSON 证据                                                                                                                                                                                                                                                                                                                                                                                          | 真栈探针                                                                                                                                                               |

### 6.2 门禁与证据

- 证据目录：`cloud-platform/evidence/w13-workspace-view/`（gitignored；timeline + 截图 + 拒绝清单 + 回归日志）。
- 提交切分（沿 W5b MAJ-2 强化规则：安全路径与测试分提交、提交前 `git diff --cached --name-only` 逐文件核对）：
  1. `feat(cloud): host workspace info for cloud sessions`（宿主方法 + 共享契约 + 单测/真栈测试可同提交，或测试另起 `test(cloud): ...`）；
  2. `feat(web): cloud session workspace view`（bootstrap + preload 命名空间 + 空态升级 + §7.1 探针门 + §7.2 三处旅程翻转，**同一提交**）。
- 冒烟生命线：W9b B 线旅程属第一层，**失败即阻断收口**；每波集成后必跑；翻转前提（§7）未齐前不得宣称 B4–B6 绿。

---

## 7. 与既有旅程/门禁的衔接（翻转前提，W9b 审计补充）

W13 的产品改动不自动等于旅程转绿——有两个独立的翻转前提，缺一个 B4–B6 都不会全绿。

### 7.1 web bundle 的 e2e 可观测性：编辑器 oracle 缺失

**事实**：被 skip 的 B4 流式用例用 `window.__monacoEditorE2E.snapshot().valueTail` 断言编辑器内容（`tests/e2e/cloud-golden-journey-orca-web.spec.ts` 末尾 `window_snapshotEditorValueTail`）。该探针的安装被 `monaco-e2e-probe.ts:31` 的 `import.meta.env.MODE !== 'e2e'` 门死——只有桌面 e2e 构建（`global-setup.ts:60` 的 `electron-vite build --mode e2e`）满足；**web 构建走 `pnpm run build:web`（`vite.web.config.ts`，不传 mode → `MODE='production'`）**，探针永远不装。web bundle 现有的 e2e 观测面只有 `VITE_EXPOSE_STORE`（build 时 env → `e2eConfig.exposeStore` → `window.__store`，`store/index.ts:158`；global-setup `:94` 已传），B3 的 store 断言因此可用，编辑器断言不行。

**方案取舍**：

| 方案                                                         | 内容                                                                                                                                                                                          | 评价                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a（采纳）· 探针门复用既有 e2e 信号**                       | `monaco-e2e-probe.ts:31` 的门改为 `MODE !== 'e2e' && String(import.meta.env.VITE_EXPOSE_STORE) !== 'true'` 时跳过安装（与 `web-e2e-config.ts:4` 同一表达式，本地内联，不引 web preload 依赖） | 零构建脚本改动；web e2e 构建已传该 env，探针随之就位；生产 web/desktop bundle（env 缺省）不装探针；桌面 `--mode e2e` 行为不变（全仓 `MODE==='e2e'` 仅此一处使用，无连带面） |
| a'· global-setup 给 `run-vite-web-build.mjs` 传 `--mode e2e` | 脚本已透传 argv（`run-vite-web-build.mjs:19`）                                                                                                                                                | 需改 global-setup 且绕开/重排 `pnpm run build:web` 的链条（build:packages 与 verify 的执行序），改动面大无收益，弃                                                          |
| b（备选）· 断言改 DOM oracle                                 | 删 `valueTail` 断言，改断 `.editor-header-path` + `.view-lines` 可视行含 marker                                                                                                               | 弱断言（Monaco 只渲染视口行，marker 行可能不在可视范围），仅当 a 被否时使用                                                                                                 |

**门禁兼容性**：

- `verify-web-build.mjs` 只检查 `out/web/*.html` 的资源引用相对性——探针在 JS chunk 内、不产 HTML 资源引用，门禁不受影响；`pnpm run build:web` 生产路径（含 `build:web-from-renderer`）不传该 env，门在运行时求值为不安装，行为不变。
- **如实记录的代价**：`import.meta.env.VITE_EXPOSE_STORE` 未定义时不会被 define 期静态替换，生产 web 包里会**保留探针代码体**（仅运行时不可达）——这与既有 `web-e2e-config.ts`/`store/index.ts:158` 的 e2e 门完全同型，不是新暴露面（探针只读编辑器状态，无写通道）。若主会话要求生产包零探针字节，则需把信号改成可静态折叠的 `MODE`（即方案 a'），由主会话定夺。
- 相应地，生产负向断言取**运行时形态**：默认 `build:web`（无 env）下打开编辑器后断言 `window.__monacoEditorE2E === undefined`；不做产物 grep 断言（非常量门分支不保证被剔除，grep 会误报）。
- `e2e-api`/`web-e2e-config` 等既有 e2e 面不动。

### 7.2 主旅程 tripwire 与 skip 引用的同步翻转

`cloud-golden-journey-orca-web.spec.ts` 内三处必须**同一提交**内联动（任一遗漏都会让旅程假绿或假红）：

| 位置                                                                      | 现状     | W13b 动作                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:55` `const W13_CLOUD_WORKSPACE_VIEW_LANDED = false`                     | 关       | 翻 `true`（或直接删常量、内联条件，删更干净——避免留下第二个「永远 true 的开关」）                                                                                                                       |
| `:493` B4 步 `if (LANDED) throw new Error('W13 landed: flip this step…')` | tripwire | **重写 B4 断言块**（该 throw 的注释即交接说明）：侧栏出现项目行（云空态不再匹配）、`repos.length===1`、`activeWorktreeId` 非空、bootstrap 后无降级 toast、`denialLogs===[]`；红线证据截图改拍工作区形态 |
| `:603` 流式用例 `test.skip(!LANDED, …)`                                   | skip     | 启用（断言体已是现成的：≥2 次 `/connect`（W5c 重签）、回显 marker、`[data-orca-explorer-shell]` 开种子文件、编辑器内容（依赖 §7.1 方案 a）、宿主审计零 `replayed`）                                     |

**验收口径**：B 线旅程 **B4（重写后）–B5–B6 + 启用后的流式用例全绿**，跑两遍（首跑 + 复跑，沿 W9b 惯例）；时间线 JSON 与截图（含新 `06-b4-terminal-stream-and-file`）更新进 `cloud-platform/evidence/journey-golden-b/`（W13c 或 W13b 证据目录另存一份引用）。

### 7.3 既有断言的兼容矩阵（W13 不得破坏的现行口径）

| 既有断言                                                                           | 位置          | W13 后必须仍成立                                                                                                                                                                                                | 风险点              |
| ---------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| B3：8s settle 内 `denialLogs === []`（控制台零 `not available to cloud sessions`） | 旅程 B3       | **成立**——bootstrap 只发允许方法；点亮面若新产生被拒调用且打到控制台，B3 即红。这是 §4.6 点亮面清单的硬约束：**任何新拒绝路径必须被既有 skip/守门覆盖或 fail-soft 吞掉，不允许以未处理 rejection 形态上控制台** | 高（R1 的量化形态） |
| B3：`environment.name` 含项目名、hash 清空、会话持久化                             | 旅程 B3       | 不动 bootstrap 不影响（bootstrap 在 B3 断言的 8s 窗口内应已完成或仍在 loading，二者都不断言失败——B3 不断言 `repos.length`）                                                                                     | 中                  |
| W5c：宿主审计零 `replayed`；每订阅恰一张新票                                       | W5c 证据/用例 | 终端流式走既有 W5c 通道，不新增取票路径                                                                                                                                                                         | 低                  |
| W7c：`web-cloud-session-scope` 跳过清单、桥接云分支、空态兜底                      | W7c 套件      | 全部原样；空态组件测试更新仅限新增 bootstrap 态呈现                                                                                                                                                             | 低                  |
| W9a 桌面黄金线 / W5b cloud-admin e2e / 平台 web e2e 24 例                          | 各证据        | 不触桌面启动链、不触 `ALL_RPC_METHODS`、不触 cloud-admin 域 → 逐字节不变                                                                                                                                        | 低                  |
| `verify-web-build` / `pnpm tc:web` / code-quality                                  | 构建门        | §7.1 方案 a 不改构建；新文件走既有 lint/tc 门                                                                                                                                                                   | 低                  |

---

## 8. 实施切分建议（每代理 ≤15 分钟口径）

| 子令 | 组件域                       | 内容                                                                                                   | 提交                                                  |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| W13a | 宿主（src/main）             | `workspace-info.ts` + 共享契约 + 登记扩展 + 单测 + 真宿主方法表套件（入 node 池）                      | `feat(cloud): host workspace info for cloud sessions` |
| W13b | web（renderer web + 启动链） | preload 命名空间 + bootstrap + 空态升级 + §7.1 探针门 + §7.2 旅程翻转（B4 重写 + skip 启用，同一提交） | `feat(web): cloud session workspace view`             |
| W13c | 测试工程                     | 越权负向补全 + 点亮面清单探针 + 生产 web 包探针运行时负向断言 + 零回归矩阵跑批                         | `test(cloud): cloud workspace boundary negatives`     |

依赖：W13a → W13b → W13c；三权分立（实现→测试→审计）照 work-orders 总纲执行。

---

## 9. 风险与开放问题

**风险**

| #   | 风险                                                                                               | 缓解                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| R1  | 激活工作区把大量 App 面带进云会话，新面可能撞上未在 W7c 清单里的被拒 RPC（坏路径：白屏/卡死/噪声） | §4.6 点亮面清单为硬性执行步骤；新发现只记账不修（O1）；bootstrap 全程 fail-soft                                       |
| R2  | 首开 ensure（克隆）可达分钟级，用户停在云卡上无反馈                                                | 空态升级为 bootstrap 态呈现（loading/ensuing 文案）；ensure 超时/失败可重试；克隆预算沿用 `PROVISION_TIMEOUT_MS=600s` |
| R3  | `repo.add` 会在宿主 repo 目录登记项目根（宿主全局状态），同宿主多用户语义                          | 与桌面云入口同语义且幂等（同路径返回既有行）；侧栏行仅在各自环境作用域内可见；写/读边界仍按各自票据                   |
| R4  | 混合版本：老宿主 + 新 web                                                                          | `method_not_found` → 云空态保留（明确归因文案）；不重试不降级                                                         |
| R5  | W9b 裁定的「repo.add hack」误读风险                                                                | §0.5 明确边界论证：path 唯一来源=宿主票据域 + 宿主侧 pin（`project_scope` 拒绝其余），实现代理须在交付说明引用本节    |
| R6  | 真栈测试在默认 bun 池不可达（W5b-B1/W9A7-MAJ-1 同型）                                              | 新真栈套件强制登记 `NODE_RUNTIME_INCLUDE`；`pnpm test` 全量无红作为收口条件                                           |
| R7  | explorer/编辑器部分动作调桌面专属 preload（web 侧为「unavailable in paired web clients」抛错）     | 点亮面清单覆盖高频动作；W13 只保证不崩不卡，桌面专属动作的云会话隐藏属 O1/后续 UX 令                                  |
| R8  | §7.1 方案 a 使探针代码体进入生产 web 包（运行时不可达，与既有 e2e 门同型）                         | 已在 §7.1 如实声明代价；若主会话要求生产包零探针字节，改用方案 a'（`--mode e2e` 静态折叠门）或方案 b（DOM oracle）    |

**开放问题（请主会话裁定）**

- Q1 云卡 bootstrap 态的文案与重试交互是否需要 UI 评审（涉及 STYLEGUIDE；本方案仅给状态机）。
- Q2 云会话下应隐藏哪些 App 供面（terminal.split、下载导出、browser pane、SSH 相关菜单）——本方案只做「被拒不崩」，系统化隐藏建议另立 UX 令。
- Q3 可选硬化：宿主对云会话 `worktree.list` 结果按票据 workspaceRoot 过滤（收敛队友检出可见性）——是否随 W13 做或另立安全硬化令（涉及桌面云入口同路径回归）。
- Q4 `workspace.info` 是否补 `worktreeId/repoId` 以省一次 `worktree.list` 往返——建议不做（宿主不耦合 App 行格式），留作 YAGNI 记录。
- Q5 O1 的 7 个被拒族（skills/ui/settings/preflight/linear）在云会话点亮工作区后是否会新增触发点——W13c 清单产出数据后决定是否扩 O1 清单。

---

## 10. 备选方案与不采办理由

| 备选                                                                          | 不采纳理由                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主在 `workspace.info` 内做登记（repo 行）与 ensure（建检出）                | 把只读自省方法变成变异方法：幂等/审计语义混浊、失败路径变长（克隆超时占据自省调用）、与 §8.3「ensure 由 open 动作驱动」的既有分工冲突                                                                 |
| web 端跳过宿主、直接从平台 API 取项目 path 再 `repo.add`                      | 正是 W9b 裁定否掉的 hack：绕开宿主票据边界（宿主 pin 是唯一执行点），且平台 path 与票据 projectRoot 可能不一致（登记后变更）                                                                          |
| 专用云工作区组件（复用 cloud-admin 的 `CloudFilePanel`/`CloudTerminalPanel`） | 与 FR-3.12「功能面对等」冲突：被 skip 的 B4 用例断言的是原生 explorer 壳与编辑器；再造一套面板 = 第二套文件/终端管线，违背 Reuse 原则，且管理台组件的 rpc 缝（cloud-browser-bridge）与 web 传输不同型 |
| 给云表新增 `worktree.ensure`/批量目录方法等新行                               | 违反 W7c「不扩充表」裁定；现有 `open`/`terminal`/`file:*` 覆盖已足                                                                                                                                    |
| 把 W7c 的空态组件替换为「云工作区视图」组件（侧栏内嵌文件树）                 | 破坏「原生侧栏并存」原则；主面已有完整工作区形态，侧栏内嵌第二份文件树是重复面                                                                                                                        |
