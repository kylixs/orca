# 桌面客户端链路 A 探索路径（可重放）

> 用途：对云端开发平台的桌面 Electron 客户端链路做可重放的探索性回归。
> findings 与截图落在 `cloud-platform/evidence/exploratory-r2/`，本文只描述路径。
> 纪律：`ORCA_BACKGROUND_LAUNCH=1`、`ORCA_E2E_HEADLESS=1`、隔离 HOME/userData；不调用
> `show()/showInactive()/bringToFront()/app.focus()`；截图只走隐藏渲染端的 Playwright/CDP。

## 1. 前置条件

| 项            | 值                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| 仓库          | `/Users/gongdewei/work/projects/orca`（主 worktree）                                                              |
| 构建          | `pnpm build:electron-vite`（成功后再启动；入口 `out/main/index.js`）                                              |
| 平台          | `https://127.0.0.1:18787`（**主实例，勿杀**）                                                                     |
| 账号          | `zhangsan / Passw0rd!`                                                                                            |
| 开发 CA       | `/Users/gongdewei/orca-local-env/tls/ca.pem`                                                                      |
| 宿主          | dev-local-02（host/projects，demo-app、zhangsan-demo），dev-local-03（host2/projects，infra-tools、zhangsan-lab） |
| 每人 checkout | `<project>/.orca-worktrees/zhangsan/<branch>`（云票据唯一可写根）                                                 |

### 1.1 本地自签平台的环境约束

- 桌面主进程的 **HTTP 控制面** 仍做默认 Node TLS 校验；`ORCA_CLOUD_TLS_INSECURE=1` 目前只作用于
  宿主 WebSocket 升级。仅设置它登录 `https://127.0.0.1:18787` 会得到
  `登录失败（platform unavailable）`。
- 重放时必须同时设置 `NODE_EXTRA_CA_CERTS=/Users/gongdewei/orca-local-env/tls/ca.pem`，
  或给平台换可信证书。
- 若 `dev-local-02` 掉线，走查改用 dev-local-03 的 `infra-tools` / `zhangsan-lab`。

## 2. 启动形态

所有形态共用 `desktop-harness.mjs` 的 `launchDesktop({ userDataDir, extraEnv })`：
从 `out/main/index.js` 启动，隔离 HOME/userData，剥离环境里的 `ORCA_CLOUD_*`，
再按需注入下面的 env。

| 形态             | extraEnv                                              | 预期                                                                                                          |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A0 无 env 裸启动 | 无（仅 CA/TLS 用于后续登录）                          | 原生 shell 直接出现；状态栏有 `登录云端平台`；对话框地址/用户名空；空表单提交禁用                             |
| A1 手输地址登录  | `ORCA_CLOUD_TLS_INSECURE=1` + `NODE_EXTRA_CA_CERTS`   | 输入 `https://127.0.0.1:18787`、zhangsan、密码；错密码显示 `账号或密码不正确。`；正确后状态栏变 `张伟 / 登出` |
| A2 重启记忆      | 同 A1（不带 `ORCA_CLOUD_API_URL`）                    | 再次打开登录对话框：地址/用户名预填，密码空，signed-out                                                       |
| A3 自动恢复      | `ORCA_CLOUD_API_URL=https://127.0.0.1:18787` + CA/TLS | 启动后无需对话框直接 signed-in（主进程 restoreSession）                                                       |
| A4 全新 profile  | 新建 userData 目录 + 同 A1                            | 首次登录路径；工作树目录最完整                                                                                |

固定 profile 约定（便于跨重启）：

```
/tmp/orca-explore-r2/ud-main        # 跨重启记忆/自动恢复
/tmp/orca-explore-r2/ud-fresh*      # 每次全新首次登录
/tmp/orca-explore-r2/ud-final       # 编辑/agent/登出
```

## 3. 链路步骤与检查点

### Path A：裸启动 → 登录 → 水合

1. 启动 A0；若 onboarding 覆盖层存在，按 `Escape` → 点击
   `[data-slot="dialog-content"] button[data-variant="outline"]` 跳过。
2. 点击 `[data-status-bar] [data-cloud-login-entry]`；检查点：
   - `#cloud-platform-address` / `#cloud-username` 为空；
   - 提交按钮 `disabled=true`。
3. 填错密码提交；检查点：对话框 `role=alert` 文本为 `账号或密码不正确。`。
4. 改正确密码提交；检查点：状态栏不再有 `data-cloud-login-entry`，出现账号与 `登出`。
5. 等待 8–15s 水合；检查点：
   - `[data-worktree-id]` 出现可见项目的行；
   - 失败 banner 只应列真正准备失败的项；
   - 网络/主机失败不应出现英文 toast 或小写原始码。

### Path B：打开项目与线路

1. 点击侧栏工作树行的 `[data-worktree-card-surface]`（点击外层行不会激活）。
2. 记录 `window.api.cloud.openWorkspace(projectId)` 的返回；检查点：
   - `ok=true`；
   - `route` 为 `direct` 或 `relay`；
   - `workspacePath` 位于 `<project>/.orca-worktrees/zhangsan/...`。
3. 当前桌面 native shell **没有** 直连/中继徽标；线路只能从桥接结果读取（已记为 P3）。
4. 幂等边界：并发两次 `openWorkspace` 同一项目、再打开另一项目、再打开回原项目；
   检查点：均 `ok=true`，同一项目返回同一 `workspacePath`，无重复行。

### Path C：终端（UI 与 RPC 分开验证）

UI 路径（预期当前失败，P0）：

1. 选中任一云工作区（项目根或每人 checkout 均可）。
2. `Meta+T` 或点击 `button[aria-label="新标签页"]` → `以 新终端 结尾的 role=menuitem`。
3. 检查点：应出现 `.xterm` 与 `.xterm-helper-textarea`。
4. 当前实际：无终端，console 出现
   `[web-runtime-session] failed to create terminal: Method 'session.tabs.createTerminal' is not available to cloud sessions`。

RPC 路径（证明宿主/票据正常，也用于覆盖输入与滚动能力）：

```js
// 在渲染端 page.evaluate 内
const opened = await window.api.cloud.openWorkspace('proj_85ef155c')
const envs = await window.api.runtimeEnvironments.list()
const env = envs.find((e) => e.name === 'infra-tools')
const call = (method, params) =>
  window.api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 25000 })
const created = await call('terminal.create', {
  worktree: `path:${opened.workspacePath}`,
  clientMutationId: 'explore-r2'
})
const handle = created.result.terminal.handle
await call('terminal.send', {
  terminal: handle,
  text: 'pwd && echo ECHO && echo 中文回声',
  enter: true
})
await call('terminal.read', { terminal: handle })
await call('terminal.send', {
  terminal: handle,
  text: 'for i in $(seq 1 300); do echo LONG_$i; done',
  enter: true
})
await call('terminal.read', { terminal: handle, limit: 200000 })
await call('terminal.close', { terminal: handle })
```

检查点：`terminal.create/send/read/close` 均 `ok=true`；读回包含 `中文回声` 与 `LONG_300`。
注意：`worktree: path:<项目根>` 会被宿主以 `PATH_OUTSIDE_ROOT` 拒绝，必须用每人 checkout。

### Path D：文件树 / 编辑器 / 预览 / 二进制

1. 点击右栏 `button[aria-label^="Explorer"]`；检查点：`[data-orca-explorer-shell]` 出现，
   行元素为 `button[data-file-explorer-row]`。
2. 单击 `README.md`；检查点：`.editor-header-path` 指向每人 checkout 内路径，
   富文本编辑表面为 `.ProseMirror[contenteditable="true"]`。
3. 编辑：聚焦 `.ProseMirror`，`Meta+ArrowDown` → `Enter` → `insertText(marker)` → `Meta+S`；
   检查点：磁盘文件（宿主本机路径）包含 marker。
4. Markdown 预览：README.md 打开后即渲染标题/正文；检查点：body 含渲染后的标题文本。
5. 二进制：在 checkout 写 9 字节含 `0x00/0xFF` 的 `.bin`，刷新 Explorer 后单击；
   检查点（当前缺陷）：按文本展示控制字符、无二进制提示。

### Path E：Agent / Skills（O1 降级）

1. 点击右栏 `button[aria-label="Agents"]`；检查点：
   - 显示 `未找到智能体会话`；
   - 当前实际还会显示 `Method 'aiVault.listSessions' is not available to cloud sessions`（应只进日志）。
2. 点击 `button[aria-label="设置"]` → `分享技能`；注意这是 Orca 账号分享页，
   不是云会话技能列表；云会话技能降级只覆盖到 Agent 会话面板。

### Path F：重启 / 登出 / 会话中断

1. 关闭应用，用 A2 重启：检查登录对话框预填；再用 A3 重启：检查自动 signed-in。
2. UI 登出：点击状态栏 `登出`；检查点：状态栏回到 `登录云端平台`，云项目行清空，
   项目列表显示 `尚未添加项目`。
3. 会话吊销（代替“杀平台”）：登录后读取 userData 的 `orca-cloud-session.json`，
   用其 `accessToken` 调 `POST /v1/auth/logout`，再调用 `cloud:listProjects` / `openWorkspace`。
   检查点（当前缺陷）：操作报 `session expired` / `NOT_SIGNED_IN`，但 UI 仍显示已登录。
   该路径以 `ORCA_CLOUD_API_URL` 启动时必现：`cloud:getState` 走 `whenRestored()`，
   会话吊销后仍返回启动时缓存的 signed-in。
4. 断线恢复（第 7 项）不在主实例上执行；如需覆盖，必须另起测试副本平台。

### Path G：边界操作

- 快速切换：连续点击 5 次不同工作树，进程不崩、最终有活动工作区。
- 重复打开：同一项目并发/连续 `openWorkspace` 幂等。
- 登录会话过期中操作：见 Path F.3。
- 重启后的目录：重点检查 `NOT_SIGNED_IN` 日志是否让侧栏停留在不可写的项目根行。

## 4. 结构化脚本

| 脚本                                                                  | 作用                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `desktop-harness.mjs`                                                 | 启动、onboarding、登录对话框、shell/worktree 读取、终端与截图工具 |
| `driver-fresh.mjs`                                                    | 全新 profile 首次登录 + 工作树行 + 终端菜单 + Explorer            |
| `driver-fresh2.mjs`                                                   | 每人 checkout 的文件树/编辑器/预览/二进制/agent/skills/快速切换   |
| `driver-final.mjs`                                                    | 富文本编辑保存回环、Agents、设置、UI 登出                         |
| `driver-restore.mjs`                                                  | `ORCA_CLOUD_API_URL` 自动恢复 + UI 登出                           |
| `driver-boundary.mjs`                                                 | 并发/重复打开 + 平台会话吊销                                      |
| `driver-terminal-rpc2.mjs`                                            | 每人 checkout 上 `terminal.*` RPC 的输入/中文/长输出证明          |
| `driver-terminal-ui2.mjs`                                             | 重启后侧栏目录与 UI 终端缺陷复现                                  |
| `driver-login.mjs` / `driver-activate.mjs`                            | 首轮登录错误态 / 重启预填                                         |
| `driver-smoke.mjs` / `driver-rowdom.mjs` / `driver-runtime-probe.mjs` | 启动、DOM、桥接诊断                                               |

运行示例：

```bash
# 构建一次
pnpm build:electron-vite

# 全新首次登录（含终端/文件树）
ORCA_BACKGROUND_LAUNCH=1 NODE_EXTRA_CA_CERTS=/Users/gongdewei/orca-local-env/tls/ca.pem \
  node_modules/.bin/tsx cloud-platform/scripts/exploratory-r2/driver-fresh.mjs

# 每人 checkout 编辑保存 + agent/登出
ORCA_BACKGROUND_LAUNCH=1 NODE_EXTRA_CA_CERTS=/Users/gongdewei/orca-local-env/tls/ca.pem \
  node_modules/.bin/tsx cloud-platform/scripts/exploratory-r2/driver-final.mjs

# 并发/会话吊销边界
ORCA_BACKGROUND_LAUNCH=1 NODE_EXTRA_CA_CERTS=/Users/gongdewei/orca-local-env/tls/ca.pem \
  node_modules/.bin/tsx cloud-platform/scripts/exploratory-r2/driver-boundary.mjs
```

## 5. 已知环境噪声

- 并发运行的 web/API 探索会创建 `r2-*` / `self-*` 项目与主机，污染项目列表和失败 banner；
  判读时以 seed 项目为准。
- `dev-local-02` 可能在运行中转为 offline/maintenance；此时改用 dev-local-03。
- evidence 截图前缀 `00`–`09` 及部分 web/api 产物属于并发探索，不是本链路。
