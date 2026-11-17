# U181 设计令 v3 · 宿主接入的自启载具（FR-4.11）

- 日期：2026-11-17
- 版本：v3。在 v2 上按 `cloud-platform/test-reports/u181-design-v2-review.md` 修正 3 项 P1（退出码 3 死配置、`--reenroll` 锁归属、尾段拆分超时）；架构结论与 v2 附录保留。
- 性质：设计（只设计，未改产品代码）
- 输入：v1（`50104e6d2b5`）、`test-reports/u181-design-review.md`（CHANGES-REQUIRED）、`cloud-platform/test-reports/u181-design-v2-review.md`（CHANGES-REQUIRED，仅文档级）、`cloud-platform/test-reports/install-script-audit.md`、`defect-ledger.md` U181/U182、`requirements.md` FR-4.11、`manual-acceptance-matrix.md` G24
- 结论：**载具定为 A2——扩展 `orcad`（纯 Node 运行时）加载云准入**，`orca-ide --host-mode` 作为唯一入口；不引入 Xvfb，不要求 display，不复制注册逻辑。
- 复核基线：当前工作树（含未提交的 U182 批 1）。行号会漂移，本文同时给出符号名；引用以「文件:符号」为准，行号为撰写时位置。
- 范围：只解决「安装后谁注册、谁常驻、脚本如何自证、失败如何判别」。脚本的 Host 头注入、`hostname -I`、openssl 回退、systemd 探测、命令预检、relay 安装属于 **U182 批 2**（`defect-ledger.md` U182 ⑥⑦），本设计只声明依赖与串行顺序。

---

## 0. 结论摘要

| 项 | v2 结论 |
| --- | --- |
| 载具 | **A2：`orcad` + 云准入**。Linux 服务器/容器无 display 也能注册、心跳、提供 PTY/RPC；不需要 Xvfb 与 Chromium 运行库 |
| 为什么不选 A1 | Electron `--serve` 在 Linux 无 display 时直接 `app.exit(1)`（`main-process-preflight.ts:388-391`）；即使装 Xvfb，还要整套 Chromium 依赖（`config/docker/headless-pairing/Dockerfile:15-42`）与约 300MB 级运行时 |
| 为什么不选 A3 | 两套载具＝两条失败面、两套验收；A2 在有/无 display 的主机上行为一致 |
| 注册载体 | 仍由 `startCloudRuntimeAdmission` 拥有；A2 只是把它的宿主从 Electron 主进程换到 `orcad`，单一凭据所有者不变 |
| CLI | Linux 名称为 **`orca-ide`**（`config/electron-builder.config.cjs:640`；`resources/linux/packaging/after-install.sh:12`）。入口 `orca-ide --host-mode`，内部等价 `serve --host-mode`；不新增 wrapper 二进制 |
| unit | `ExecStart=<安装时解析的绝对路径>/orca-ide --host-mode`；`RestartPreventExitStatus=78`（不含 3，见 §3.3） |
| 退出码 | `0` 正常；`1` 可重试；`78` 不可重试配置/身份错误（含 orcad 实例锁）；`3` 仅 Electron `single-instance-lock`，A2 不产生，不入 unit |
| REENROLL | 改为 **一次性 CLI 参数 `--reenroll`**，由宿主进程实现；**禁止**写入 `host.env` 或任何 EnvironmentFile |
| 就绪判据 | 结构化状态文件（schema v2）＋ `pid`/`startedAt` 防伪在线；脚本不读日志、不依赖 `/health` |
| 与 U182 | U182 批 2 是 H9a/H10a 的**硬前置**；H8/H9b/H11b/H12 已按 v3 重拆，全部令 ≤20 分钟（共 24 令） |
| 验收 | 干净 Debian 12 容器、**无 display、无 Xvfb**、已装 Orca 包；one-liner 启动的 orcad 产生 201＋首心跳；脚本以状态文件退出 0 |

### 0.1 评审处置

| 评审项 | v2 处置 | 位置 |
| --- | --- | --- |
| P0-1 干净容器验收矛盾 | 改为 A2；验收环境明确「已安装 Orca 包（含 orcad 模板与 pinned Node）、无 display」，删除 Xvfb 依赖；删除 v1「serve 已在容器/G24 验证」的错误表述 | §1、§7.1 |
| P1-1 CLI 名称 | 统一 `orca-ide`；给出解析顺序与 unit 的绝对路径写法 | §2 |
| P1-2 不可重试退出契约 | 定义 0/1/78/3，unit 加 `RestartPreventExitStatus`；`HOST_NAME_REQUIRED` 的同步抛错纳入映射 | §3.3、§5.1 |
| P1-3 就绪判据脆弱 | `CloudAgentSnapshot` 增加结构化心跳字段；`refresh()` 的 catch 也通知监听者；`ready` 不再被当作「首心跳成功」 | §4.4 |
| P1-4 REENROLL 归属/安全 | 一次性 `--reenroll`，宿主实现，live 宿主拒绝；绝不进 EnvironmentFile | §3.2 |
| P1-5 与 U182 批 2 重叠 | 明确 ⑥⑦ 归 U182 批 2；H9/H10 只做宿主增量；批 2 为硬前置 | §6 |
| P1-6 201 丢失不可判别 | 状态文件 `host_token_invalid` + `httpStatus=401` + `phase`；脚本给出「平台可能已注册」文案 | §3.4、§4.3 |
| P2-1 行号漂移 | 符号引用为主 | 全文 |
| P2-2 时长不可信 | H1–H10 重估并拆分，全部 ≤20 分钟 | §8 |
| P2-3 并行矛盾 | 重画依赖图 | §8.3 |
| P2-4 nohup 不 source env | wrapper 显式 `set -a; . host.env; set +a; exec …` | §5.3 |
| P2-5 伪在线竞态 | `startedAt`＋`pid`＋启动即写 `starting` | §4.2 |
| P2-6 hostOnline 漏 revoked | 验收断言加入 `revokedAt===null`（`server.ts:1781-1785`） | §7.2 |
| P2-7 Windows/G24 | Windows 移出 v1；macOS 降为非目标，责任人注明 | §7.5、§5.4 |

### 0.2 v3 评审处置（v2 评审 P1）

| 评审项 | v3 处置 | 位置 |
| --- | --- | --- |
| P1-1 尾段超时（H8/H9b/H11b/H12a/H12b） | 重切为 H8a/H8b/H8c、H9b/H9c、H11b/H11c、H12a–H12e；总令数 17→24，全部 ≤20 分钟 | §8 |
| P1-2 退出码 `3` 是 A2 死配置 | unit 删除 `3`（`RestartPreventExitStatus=78`）；§3.3 标注 `3` 仅 Electron 单实例锁；H10a 断言 unit 不含 `RestartPreventExitStatus=3` | §0、§3.3、§5.1、H10a |
| P1-3 `--reenroll` 锁归属 | 写死 re-enroll 必须在 orcad 实例锁区内（`orcad-lifecycle.ts:112` 之后）；CLI 不得在 spawn 前读写凭据；新增 H8c 与验收断言 | §3.2、§7.2、H8c、§8 |

---

## 1. 载具裁定（P0-1 核心）

### 1.1 三案

| 案 | 形态 | 依赖 |
| --- | --- | --- |
| **A1** | Electron `--serve`（强制 `ORCA_SERVE_RUNTIME=electron`）＋ 安装 Xvfb | Xvfb、Chromium 运行库、~300MB 应用运行时 |
| **A2** | 扩展 `orcad`（pinned Node 运行时）加载 `startCloudRuntimeAdmission` | 仅 orcad 槽（Orca 包已携带模板与 pinned Node） |
| **A3** | 探测 display：有则 A1，无则 A2/报错 | A1 + A2 两套 |

### 1.2 代码事实

#### A1：Electron + Xvfb

- Linux headless 的 `serve` 在 display 初始化后**硬退出**：
  `main-process-preflight.ts:384-391` 调 `ensureVirtualDisplayForHeadlessServe`，失败即打印 `MISSING_LINUX_DISPLAY_MESSAGE` 并 `app.exit(1)`。
- Xvfb 由 Orca 自己拉起，但前提是主机已安装：`ensure-virtual-display.ts:261` `spawn('Xvfb', …)`；缺失时返回 false → 上面的 `app.exit(1)`。
- 即使有 Xvfb，Electron 还需要整套 Chromium 运行库：`config/docker/headless-pairing/Dockerfile:15-42` 安装 `dbus-x11 / libatk-bridge / libgbm / libgtk-3 / libnss3 / xvfb` 等十余个包。
- 体积：Electron 运行时与应用资源是桌面包规模；每个宿主还要多一个 Xvfb 进程。
- 与桌面共存：必须使用独立 profile（v1 §4.1 仍成立），A1 不改善这一点。
- 另一个隐蔽风险：v1 以为 `orca serve` 一定走 Electron；实际 `serveOrcaApp` 默认交给选择器（`src/cli/runtime/launch.ts:117-141`），选择器**默认选 orcad**（`orcad-local-serve-selection.ts:5-9`），只有 `ORCA_SERVE_RUNTIME=electron` 才强制 Electron。A1 必须额外写死这个 env。

**结论**：A1 可行但重，且把「宿主上线」与「主机是否装了图形栈」绑定，正是评审 P0-1 的根因。

#### A2：扩展 orcad

`orcad` 是 Orca 官方的纯 Node 运行时（`src/main/orcad/orcad-entry.ts`），已经启动 PTY、RPC、agent hooks、profile store、daemon、push，`startOrcad` 在 `:134`，RPC server 在 `:353-366`。关键事实：

1. **同一个 RPC 类**：orcad 构造的 `OrcaRuntimeRpcServer` 与 Electron 主进程是同一种类。该类完整实现了 `CloudRuntimeTarget` 的全部成员：
   `runtime-rpc-pairing.ts:35`（`getDeviceRegistry`）、`:43`（`getE2EEPublicKey`）、`:135-153`（access guard/provision/audit/file-event 注入）、`:158-170`（`provisionCloudProject`/`closeCloudDeviceSessions`/`getWebSocketEndpoint`）。
2. **同一套构造选项**：`OrcaRuntimeRpcServer` 接受 `upgradeAdmission`、`connectionGate`、`methods`、`webSocketTls`（`runtime-rpc-pairing-types.ts:58-70`）；Electron 路径通过 `cloudAdmissionOption(...)` 一次性传入（`main-process-runtime-launch.ts:94`）。
3. **同一套认证/心跳模块**：`cloud-runtime-admission.ts` 的 `startEnrolled`（`:175-256`）读已存凭据（`:197`）、无则 `enrollCloudHost`（`:199`）、持久化（`:217`）、首刷新与 10s 心跳（`:254-255`）。
4. **orcad 无需 display**：全链路没有 Chromium/BrowserWindow；`main-process-preflight.ts` 的 display 检查只属于 Electron 路径。
5. **profile 已可固定**：CLI 读 `ORCA_USER_DATA_PATH`（`launch-user-data-path.ts:15-16,33`），`serveWithOrcad` 映射为子进程的 `ORCA_USER_DATA`（`serve-orcad-launch.ts:104`）；orcad 用 `ORCA_USER_DATA` 解析（`orcad-app-paths.ts:21-23`）。

**结论**：A2 不是「新写一个宿主」，而是「给既有 orcad 宿主装上既有的云准入」。注册、凭据、心跳、E2EE、TLS、策略、吊销全部复用，代码增量集中在入口与就绪判定。

#### A3：按显示探测混合

否决理由：
- 有 display 的服务器（远程桌面/CI）与无 display 的容器会走不同载具，产生两套行为、两套日志、两套故障语义；状态文件与退出码必须同时兼容二者。
- A1 的 Xvfb/Chromium 依赖仍然要写进验收，P0-1 并未消失。
- 只有「Electron 提供 orcad 没有的能力」时才值得混合；FR-4.11 的 online 判据不需要这些能力（见 §1.5 的能力边界）。

### 1.3 裁定

**选 A2。** 决定性理由：

1. 宿主上线与 display 解耦；`orca-ide --host-mode` 在 Debian 12 最小容器、WSL、无桌面的服务器上都能跑。
2. 复用同一个 `OrcaRuntimeRpcServer` 与同一个 admission，单一凭据所有者、单一注册语义，不产生 v1 §2.3 担心的双所有者。
3. 增量最小：唯一硬阻塞是 admission 模块图里的一行 Electron import（§1.4），不是重写。
4. orcad 已经是 `serve` 的默认运行时（`orcad-local-serve-selection.ts:5-9`）；host mode 与普通 `serve` 只差「强制 orcad + 等云就绪 + 不建 pairing」。

### 1.4 `startCloudRuntimeAdmission` 能否在纯 Node（orcad）运行

**今天不能直接运行；改一行模块边界后可以。**

- 硬依赖只有一处：
  `cloud-runtime-admission.ts:13` `import { attachRuntimeToCloudAdmission } from './cloud-runtime-attach'`；
  `cloud-runtime-attach.ts:4` `import { installCloudPlatformIpc } from '../ipc/cloud-platform'`；
  `src/main/ipc/cloud-platform.ts:1` `import { BrowserWindow, app, ipcMain } from 'electron'`。
- orcad 的 bundle 把 `electron` 标为 external（`config/scripts/orcad-entry-build.mjs:26,54`），运行在 pinned Node 上；一旦模块图触达该 import，宿主启动即失败。
- 除这一处外，admission 的传递依赖都是纯 Node 或类型：
  `cloud-agent-client.ts:1-24`、`cloud-host-enrollment.ts:1-4`、`cloud-host-tls.ts:1-2`、`cloud-project-dirs.ts`、`cloud-access-guard.ts`、`cloud-provision-assignment.ts` 只依赖 `node:*`、`shared/*` 与同域纯模块；`cloud-runtime-admission.ts` 其余 import 均为 `import type` 或 RPC 方法声明（orcad 本来就在用）。

**最小改造点**（按顺序，合计 H1/H2/H6）：

1. **移除 admission 模块图的 Electron 边**：把 `installCloudPlatformIpc()` 从 `attachRuntimeToCloudAdmission` 中删掉，改由 Electron 启动路径在 `attachCloudRuntime(runtimeRpc)` 之后显式调用一次（`main-process-runtime-launch.ts:96` 附近）。调用时机与顺序不变（仍是 RPC 构造后立即安装），`installCloudPlatformIpc` 的唯一生产调用点从 `cloud-runtime-admission` 移到 Electron 专属文件。这样 orcad 导入 admission 不会再触达 `electron`。
2. **orcad 接入 admission**（`orcad-entry.ts:353-366`）：
   ```ts
   const admission = cloudRuntimeAdmission(process.env, { userDataPath: runtimeUserDataPath })
   const rpc = new OrcaRuntimeRpcServer({
     runtime,
     userDataPath: runtimeUserDataPath,
     enableWebSocket: true,
     pinnedBindHost: bindHost,
     ...cloudAdmissionOption(process.env, { userDataPath: runtimeUserDataPath })
   })
   // Electron 路径用 attachCloudRuntime(runtimeRpc) 完成 bind + 策略/上报器安装；
   // H1 之后 attachRuntimeToCloudAdmission 已是 Node 安全的，orcad 直接复用。
   attachRuntimeToCloudAdmission(rpc, admission)
   await rpc.start()
   ```
   注意：attach 必须发生在 `rpc.start()` 之前，与 Electron 路径一致；它同时完成 `bindRuntime`、access guard、provision/audit 上报器与 assignment executor 的安装。`ready` 的 rejection 由 host mode 等待并映射退出码，普通 `serve` 只记日志。
3. **补版本 env**：admission 的注册 payload 与心跳读 `ORCA_APP_VERSION`（`cloud-runtime-admission.ts:207,236`），而它只由 Electron preflight 设置（`main-process-preflight.ts:182`）。orcad 的版本来自 `ORCA_VERSION`（`orcad-entry.ts:67`；该 env 由 `serve-orcad-launch.ts:105` 注入）。在 `startOrcad` 里、构造 admission 之前补：
   `process.env.ORCA_APP_VERSION ??= getAppEnvironment().getVersion()`。
4. **错误契约**（见 §3.3）：`enrollCloudHost` 目前把 HTTP 错误压成字符串（`cloud-host-enrollment.ts:135-138`），host mode 无法区分。H6 把它改为结构化 `{ code, retryable, httpStatus, detail }`。

**明确失败边界**：orcad 没有 Electron 的浏览器/SSH 能力。FR-4.11 的「上线、PTY、RPC、文件、agent」由 orcad 覆盖；`runtimeCapabilities` 当前固定声明 `['pty','files','agent','managed-credential']`（`cloud-host-enrollment.ts:127`），与 orcad 能力一致。浏览器自动化与 SSH 目标不在 host mode v2 的承诺内，验收不测；若后续要求，应单独扩 orcad，而不是回退 A1。

### 1.5 载具对比（v2）

| 维度 | A1 Electron+Xvfb | **A2 orcad** | A3 混合 |
| --- | --- | --- | --- |
| 无 display 可用 | 需 Xvfb，失败即 exit 1 | **是** | 分情况 |
| 运行库重量 | Chromium 全套 + Xvfb | pinned Node + 既有原生模块 | 两者都要 |
| 注册语义 | 复用 admission | **复用同一 admission** | 复用 |
| 代码增量 | 入口/选项/就绪 | **入口/选项/就绪 + 一行边界重构** | A1+A2 |
| 单一凭据所有者 | 是 | **是** | 是 |
| 失败面 | display、Xvfb、Chromium、profile | profile、pinned Node、网络 | 两者 |
| 验收环境 | 需图形栈 | **最小 Linux 容器** | 两套 |

---

## 2. 入口与 CLI 契约

### 2.1 Linux CLI 名称

Linux 包的可执行名是 `orca-ide`，不是 `orca`：

- `config/electron-builder.config.cjs:640` `executableName: 'orca-ide'`；
- `:656-657` 把 `resources/linux/bin/orca-ide` 放进 `bin/`；
- `resources/linux/packaging/after-install.sh:12` 安装 `/usr/bin/orca-ide` 符号链接；
- `/usr/bin/orca` 在 Ubuntu 上是 GNOME Orca 屏幕阅读器（同文件注释），因此绝不能默认使用裸 `orca`。

`resources/linux/bin/orca-ide` 是 bash launcher：以 `ELECTRON_RUN_AS_NODE=1` 执行包内 `out/cli/index.js`，不初始化 Chromium。host mode 复用它即可。

### 2.2 统一入口

不新增 wrapper 二进制。两种写法归一：

```bash
orca-ide --host-mode                 # 脚本/unit 使用（顶层别名）
orca-ide serve --host-mode           # 等价、可发现
```

- 顶层解析位置：`src/cli/index.ts` 在 spec dispatch 之前，照 `--version` 的特判（`:69-80`）增加 `--host-mode` 分支。
- `serve` 子命令增加 `host-mode` flag：`src/cli/specs/serve.ts:6-24` 的 `allowedFlags` 与 usage；handler `src/cli/handlers/core.ts:100-125` 透传。
- 两者都调用 `serveOrcaApp({ hostMode: true, noPairing: true })`；`--host-mode` 强制：
  - 不进入 `resolveLocalServeRuntime` 的 Electron 回退：选择器可以运行，但结果必须是 `kind==='orcad'`，否则以 `runtime_unavailable` 退出 78（**不静默降级到 Electron**）；
  - 忽略/拒绝 `--mobile-pairing`、`--grant-desktop-control`、`--pairing-address`、`--recipe-json`（host mode 没有交互式 pairing）；冲突在参数解析阶段报错。
- `serveWithOrcad` 增加 `--host-mode` 传递（`serve-orcad-launch.ts` 的 `orcadServeArgs`）。

### 2.3 CLI 解析顺序（脚本预检用）

1. `ORCA_CLI`（显式覆盖，测试/运维用）；
2. `command -v orca-ide`（deb/rpm 的 `/usr/bin/orca-ide`，或 CliInstaller 的 `~/.local/bin/orca-ide`）；
3. macOS：`command -v orca`（无 GNOME 冲突）；
4. 都找不到：打印「请安装 Orca 包，或设置 ORCA_CLI」并退出 78，**不消耗令牌**。

Linux 上**不使用**裸 `orca`（除非 `ORCA_CLI` 明确指向）。这也修正了 v1 §3.1 步骤 1 与 §4.2 的 `orca` 写法。

### 2.4 `--preflight`（不碰令牌）

`orca-ide --host-mode --preflight` 只做配置与运行时检查，然后退出：

- 校验 `ORCA_CLOUD_API_URL` / `ORCA_CLOUD_HOST_TOKEN` / `ORCA_CLOUD_HOST_NAME`、profile 目录可写；
- 解析并物化 orcad 槽与 pinned Node（复用选择器的 materialize 路径，可能首次下载，超时 10 分钟）；
- 检查 profile 实例锁是否被占；
- **不构造 admission、不发注册/心跳 HTTP**，因此不会消耗令牌。
- 退出码：0 就绪；78 配置/运行时不可用。

脚本在启动服务前先跑 preflight，把「运行时坏了」从「注册失败」中分离出来。这是 P0-1 的正面修复：验收不再依赖安装脚本临时补图形栈。

### 2.5 systemd 的 ExecStart

`ExecStart` 必须是**安装时解析出的绝对路径**，不能依赖 user manager 的 PATH：

```ini
ExecStart=/usr/bin/orca-ide --host-mode
# 或 CliInstaller 场景：ExecStart=%h/.local/bin/orca-ide --host-mode
```

脚本用 `command -v orca-ide` 得到路径后写入 unit；解析失败则 unit 不安装，退出 78。绝不写 `/usr/bin/orca`（GNOME Orca）。

---

## 3. 生命周期、幂等与失败语义

### 3.1 正常时序（A2）

| # | 执行者 | 动作 | 失败语义 |
| --- | --- | --- | --- |
| 1 | 脚本 | 预检命令/CLI 路径/profile 可写（U182 批 2 的 helper） | 非 0，不消耗令牌 |
| 2 | 脚本 | 原子写 `host.env`（`ORCA_USER_DATA_PATH`、`ORCA_CLOUD_*`、TLS 路径） | 非 0，不启动 |
| 3 | 脚本 | `/health` 可达性检查（已有，2xx） | 非 0，不消耗令牌 |
| 4 | 脚本 | `orca-ide --host-mode --preflight` | 78，不消耗令牌 |
| 5 | 脚本 | 安装并 `enable --now` 服务 | 安装失败 78；服务启动失败由状态文件/退出码判定 |
| 6 | 宿主 | `startEnrolled`：有 `orca-cloud-host.json` 则跳过注册 | 见 §3.3 |
| 7 | 宿主 | 无凭据：`POST /v1/hosts/register`；201 后持久化凭据 | 401/409/400 不重试；网络可重试 |
| 8 | 宿主 | `refresh()` 首心跳；成功即 `status=online` | 失败保持 `registered/degraded`，10s 后重试 |
| 9 | 脚本 | 轮询状态文件（默认 120s） | 超时非 0，打印状态文件与日志尾部 |

令牌焚毁点仍只有注册成功：`server.ts:3525`（`entry.usedAt = now()`），在主机名校验（`:3523`）之后。第 1–6 步与任何本地失败都不消耗令牌。

### 3.2 幂等与 REENROLL

| 场景 | 行为 | 令牌 |
| --- | --- | --- |
| 首次注册成功 | 写 `orca-cloud-host.json` | 已焚 |
| 进程崩溃/重启 | 读到凭据，跳过注册，直接心跳 | 不再需要 |
| 脚本重跑（同一 profile，新命令） | 默认**不重新注册**；只重启服务并复用凭据 | 新令牌不使用，仍在 TTL 内 |
| 运维显式要求重新注册 | `orca-ide --host-mode --reenroll` | 新令牌被焚；旧 credential 失效 |
| 同 profile 已有 live 宿主 | 拒绝 `--reenroll`，退出 78 | 不换掉线上凭据 |
| 同名且平台已吊销 | 服务端 409 `HOST_REVOKED`，且**该令牌已在 409 前被焚**（`server.ts:3525` 先于 `:3537-3539`） | 必须由管理员恢复/换名并重新生成命令 |

**REENROLL 归属与安全（P1-4）**：

- 归属：宿主进程（orcad host mode），不是安装脚本，也不是 CLI 前置步骤。
- **锁归属（硬约束）**：re-enroll 的凭据读取、改名、删除与重注册**必须**在 orcad 已取得 profile 实例锁之后执行，即 `startOrcadWithHost` 内、`orcad-lifecycle.ts:112` 之后；`startOrcad`（`orcad-entry.ts:134`）在锁之外，不得作为 re-enroll 实现点。CLI 层（`src/cli/**`、`serve-orcad-launch.ts`）只解析并转发 `--reenroll`，**不得**在 spawn 前读取、改名或删除 `orca-cloud-host.json`。否则 live 宿主仍在线时凭据被换，旧宿主下次重启即永久 401。
- 形态：**一次性命令行参数 `--reenroll`**。不引入 `ORCA_CLOUD_REENROLL` 环境变量，绝不写入 `host.env`。EnvironmentFile 每次启动都会注入变量；若把「删凭据」做成常驻 env，systemd 每次重启都会删除凭据并用已焚令牌注册，主机永久下线。
- 删除前检查（锁区内）：若状态文件为 `online` 且 `pid` 存活，拒绝并提示「先停服务」。通过后把旧凭据重命名为 `orca-cloud-host.replaced-<epoch>.json`（0600），新注册成功后再删除；失败则恢复旧文件。
- 安装脚本重跑时**不自动**带 `--reenroll`；只在输出里作为运维显式命令给出。

### 3.3 错误分类、退出码与 unit 重试

| 失败 | 稳定码 | 可重试 | 退出码 | 说明 |
| --- | --- | --- | --- | --- |
| 网络/DNS/连接超时/5xx | `network` / `http_5xx` | 是 | 1 | 宿主内先做有界重试（3 次，1s/5s/15s），仍失败退出 1；systemd 再拉起 |
| 401 `HOST_TOKEN_INVALID` | `host_token_invalid` | 否 | 78 | 令牌无效/已用/过期；见 §3.4 |
| 409 `HOST_REVOKED` | `host_revoked` | 否 | 78 | 平台吊销；令牌已焚 |
| 400 `HOST_NAME_REQUIRED` | `host_name_required` | 否 | 78 | 缺 `ORCA_CLOUD_HOST_NAME`；注意它在 `ready` 之外**同步抛出**（`cloud-runtime-admission.ts:181-184`），host mode 必须 try/catch 映射 |
| 201 响应丢失/畸形 | `protocol` | 否 | 78 | 本地无凭据；重试只会得到 401；提示「平台可能已注册」 |
| 凭据写盘失败 | `credential_write_failed` | 否 | 78 | profile 权限/磁盘 |
| 缺 api/token/host name，或 admission 为 null | `host_config_invalid` | 否 | 78 | host mode 明确要求云配置 |
| orcad 槽/pinned Node 不可用 | `runtime_unavailable` | 否 | 78 | preflight 已拦截 |
| profile 实例锁被占 | `profile_in_use` | 否 | 78 | 与桌面/另一宿主冲突 |
| 在线后心跳 401 `HOST_CREDENTIAL_INVALID` | `heartbeat_unauthorized` | 否 | 78 | 凭据被同名重注册替换（`server.ts:3628-3629`） |
| 在线后心跳网络失败 | `heartbeat_failed` | 是 | 不退出 | 状态 `degraded`，10s 重试 |
| 平台心跳 revoke | `host_revoked` | 否 | 78 | 客户端置 `hostRevoked` 并停表（`cloud-agent-client.ts:196-197,222-223`），host mode 退出 |
| SIGTERM/SIGINT | — | — | 0 | 写 `stopped` 后正常退出 |

退出码常量沿用/扩展 `src/main/orcad/orcad-exit-code.ts`：`0` 成功、`1` 失败、`78` 配置类（`ORCAD_EXIT_CONFIGURATION`，已有）。A2 的实例锁/绑定/槽/profile 错误全部映射 `78`（`orcad-exit-code.ts:15-22`）。`3` 只由 Electron `single-instance-lock.ts:12` 产生；host mode 禁止 Electron 回退（§2.2），因此在 A2 下 `3` 是**永不出现的死配置**，unit 不写 `3`；仅当未来引入 Electron 载体时才恢复。

`RestartPreventExitStatus` 只阻止 **78**；`1` 继续重启，直到 `StartLimit`。系统级 `StartLimitIntervalSec/StartLimitBurst` 放 `[Unit]`；老 systemd（<229，如 CentOS 7）不支持这些键时由 U182 批 2 的 systemd 探测降级为 `Restart=no` + 宿主内有界重试，并明确日志，而不是写一个解析不了的 unit。

### 3.4 201 后响应丢失（P1-6）

平台在写响应前已置 `usedAt`（`server.ts:3525`）并可能已 upsert 主机（`:3576-3580`）。代理断连时客户端拿不到 credential，于是：

1. 本次运行：`enrollCloudHost` 的 `res.json()` 失败/超时/字段缺失 → `protocol` → 退出 78，状态文件 `phase=enrolment`、`lastErrorCode=protocol`、`retryable=false`；
2. 若 systemd/人工再启动一次：服务端返回 401 `HOST_TOKEN_INVALID` → `host_token_invalid`、`httpStatus=401`；
3. 脚本对 401 的文案必须包含可操作分支：
   「令牌已被使用或过期。若平台 `/v1/hosts` 已存在同名主机，则上一次注册已成功但响应丢失；请确认该主机后重新生成安装命令（不要重复使用本命令）。」

这样「网络没到」与「令牌已焚」在状态文件和脚本输出上可判别，而不是都表现为 90s 超时。

---

## 4. 状态文件与就绪判据（P1-3、P2-5）

### 4.1 路径

`<userData>/orca-cloud-host-state.json`。host mode 固定 profile（`ORCA_USER_DATA_PATH=${ORCA_HOST_PROFILE:-$HOME/.orca-cloud/profile}`），因此脚本可预测为：

```
$HOME/.orca-cloud/profile/orca-cloud-host-state.json
```

profile 隔离同时解决桌面共存与实例锁（沿用现有 `serve-user-data-path-guard` / profile 锁）。

### 4.2 schema v2 与写入时机

```json
{
  "schemaVersion": 2,
  "status": "starting|enrolling|registered|online|degraded|error|stopped",
  "phase": "config|runtime|enrolment|heartbeat|serving",
  "hostId": "host_…",
  "hostName": "dev-001",
  "platformUrl": "https://…",
  "pid": 12345,
  "startedAt": 1730000000000,
  "registeredAt": 1730000001000,
  "lastHeartbeatAt": 1730000010000,
  "lastHeartbeatOk": true,
  "lastHeartbeatHttpStatus": 200,
  "lastErrorCode": null,
  "lastErrorDetail": null,
  "retryable": true,
  "updatedAt": 1730000010000
}
```

写入时机（单写者，只有宿主进程）：

1. **进程启动、任何网络请求之前**：原子写 `status=starting`、`phase=config`、新的 `startedAt`、新的 `pid`，清空 `lastErrorCode`。这一条专治 P2-5：旧文件的 `online` 不会在本进程启动后继续冒充。
2. preflight 通过：`phase=runtime`。
3. 进入注册：`phase=enrolment`、`status=enrolling`。
4. `ready` 解析（凭据存在）：`status=registered`、`phase=heartbeat`、写 `hostId/registeredAt`。
5. 每次心跳成功：`status=online`、`lastHeartbeatAt=now`、`lastHeartbeatOk=true`、`lastHeartbeatHttpStatus=200`、清错误。
6. 心跳失败：`status=degraded`、`lastHeartbeatOk=false`、`lastHeartbeatHttpStatus`（如 401 或 null）、`lastErrorCode=heartbeat_failed|heartbeat_unauthorized`；保留最后一次成功的 `lastHeartbeatAt`。
7. 致命错误：`status=error`、`phase` 停在出错阶段、写稳定码与 `retryable`，然后按 §3.3 退出。
8. 正常停止：`status=stopped`。

原子性：临时文件 + `fsync` + `rename`；权限 0600；目录 0700。状态文件不得包含 credential 或 host token。

### 4.3 脚本判据

脚本**不读日志字符串，也不把 `/health` 当上线依据**。全部满足才退出 0：

1. 文件存在且 `schemaVersion=2`；
2. `pid` 为正且 `kill -0 "$pid"` 成功（本地守护形态）；
3. `startedAt >= ORCA_INSTALL_STARTED_AT`（脚本在启动服务前记录的 epoch），防旧状态；
4. `status=online` 且 `lastHeartbeatOk=true`；
5. `lastHeartbeatAt` 在 `now-30s` 与 `now` 之间；
6. `hostId` 非空；`platformUrl` 等于本次配置；
7. systemd 形态可附加 `systemctl --user is-active`。

超时默认 120s（preflight 已把首次下载移出该窗口）；超时非 0，打印状态文件 JSON 与 `journalctl`/日志尾部。

### 4.4 让判据成为结构化字段（P1-3）

现有实现不足（评审 F13）：

- `ready` 只等注册；`created.refresh()` 内部吞掉心跳失败（`cloud-agent-client.ts:277-284`），所以 `ready` 解析 ≠ 首心跳成功；
- `lastRefreshAt` 在心跳失败时也置位（`:216`），不能代表心跳成功；
- `onRefresh` 在 `refreshOnce` 抛异常时完全不触发（通知在 `:217-222`，异常路径在 `:280-283`）。

H5 的改动：

1. `CloudAgentSnapshot` 增加 `lastHeartbeatAt`、`lastHeartbeatOk`、`lastHeartbeatHttpStatus`、`lastErrorCode`；
2. `sendHeartbeat` 从 `HeartbeatResult | null` 改为能保留 HTTP 状态（200/401/5xx）与网络错误；
3. 成功、心跳被拒、抛异常三条路径都更新上述字段并通知 `onRefresh` 监听者；
4. host mode 的「首心跳成功」只认 `lastHeartbeatOk === true`，不认 `lastRefreshAt`，也不比对 `lastError === 'heartbeat failed'` 字符串。

`ready` 的桌面语义保持不变（注册完成即解析），只有 host mode 额外等待首心跳。

---

## 5. 守护形态

### 5.1 systemd（Linux 默认）

```ini
# ~/.config/systemd/user/orca-host.service
[Unit]
Description=Orca Cloud host agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
EnvironmentFile=%h/.orca-cloud/host.env
ExecStart=/usr/bin/orca-ide --host-mode
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
```

- `ExecStart` 路径由安装时 `command -v orca-ide` 解析（§2.5）。
- `RestartPreventExitStatus=78`：78 覆盖配置/身份终态与 orcad 实例锁（`orcad-exit-code.ts`），这类不再空转。`3` 只属 Electron 单实例锁、A2 不产生，故不写入 unit。`1` 仍会被重启，但受 `StartLimit` 有界。
- `StartLimit*` 在 `[Unit]`（systemd ≥229）；老版本由 U182 批 2 探测后降级为 `Restart=no`（§3.3）。
- `Type` 保持默认 `simple`；不做 `Type=notify`，避免要求 sd_notify。
- 宿主收到 SIGTERM 走 orcad 既有 shutdown（`installOrcadShutdownSignals`），写 `stopped`，退出 0。

### 5.2 linger

`loginctl enable-linger "$USER"` 必须执行；失败时：

- 打印「SSH 登出后 user manager 会停止该服务，平台 60s 后 offline」；
- 继续安装并等待状态文件（服务在当前会话内仍能上线）；
- 不谎报持久化成功。

### 5.3 无 systemd（容器/WSL/精简镜像）

使用显式 wrapper，避免 v1 的 P2-4（依赖前文 `source` 副作用）：

```bash
# ~/.orca-cloud/run-host.sh  （<ORCA_CLI_ABS> 在安装时由 command -v orca-ide 解析后写入）
#!/usr/bin/env bash
set -euo pipefail
set -a
. "$HOME/.orca-cloud/host.env"
set +a
exec "<ORCA_CLI_ABS>" --host-mode
```

启动：`nohup setsid "$HOME/.orca-cloud/run-host.sh" >>"$HOME/.orca-cloud/host.log" 2>&1 &`，写 `host.pid`。脚本明示「不随开机自启；重启后需重跑或交给容器 restart policy」。不被允许伪造 systemd 成功。

### 5.4 macOS

v2 **非目标**。FR-4.11 只定义 bash one-liner，验收矩阵的 Linux 行是硬要求。技术上 `orcad` 槽在 macOS 包内同样存在，可后续加 launchd plist；但 orcad 没有 Electron 的自动更新 handoff（`serve-orcad-launch.ts:37-46` 明确 packaged macOS serve 留在 Electron 就是为了更新），host mode 会放弃更新通道，需单独设计。责任人：U181 后续令，不在本次验收。

### 5.5 停止/卸载

- systemd：`systemctl --user disable --now orca-host.service`，删除 unit，`daemon-reload`；
- nohup：读 `host.pid`，`TERM`，等待退出；
- 删除 `host.env`、状态文件、TLS（可选保留）、凭据（仅显式卸载）；
- 平台侧吊销由管理员操作，本设计不新增接口。

---


> 归属同步（2026-11-17 17:3x，U183 v3 §5.3）：命令预检/systemd 探测 helper 由 **U183 R12** 新建并拥有（`cloud-platform/apps/api/src/install-script-command.ts`），H9/H10 消费，不再依赖 U182 批 2。

## 6. 与 U182 的边界与串行顺序（P1-5）

U182 批 2 的范围（`defect-ledger.md` U182 ⑥⑦）：可移植 hostname/IP、openssl 回退与 SAN、**systemd 探测**、**命令预检**、relay 安装。

| 能力 | 归属 | 说明 |
| --- | --- | --- |
| `require_command` / `command -v` 预检 | **U182 批 2** | H9 只调用，不重写 |
| systemd 能力探测（user bus、版本、`RestartPreventExitStatus` 支持） | **U182 批 2** | H10a 只消费结果 |
| `hostname -I` 可移植 IP | **U182 批 2** | 安装脚本既有逻辑 |
| openssl 回退/SAN | **U182 批 2** | 安装脚本既有逻辑 |
| relay 安装/启动 | **U182 批 2** | 不在 U181 范围 |
| `ORCA_USER_DATA_PATH`、host-mode 调用、状态轮询、错误文案 | **H9a/H9b/H9c** | 宿主特有编排 |
| unit 内容、`RestartPreventExitStatus`、linger、无 systemd wrapper | **H10a/H10b** | 宿主特有守护 |

**硬前置**：U182 批 2 合入后才能派 H9a；H10a 还依赖 H9b/H9c。不得在 U181 内复制 systemd 探测/命令预检，否则同一函数被两条令反复改写。

**串行顺序**：

```
U182 b1（已完成）
  → U182 b2
  → [H1 → H2 → H3 → H4] ∥ [H5 → H6 → H7]   （H5 可最先派）
  → H8a → H8b → H8c
  → H9a → H9b → H9c
  → H10a → H10b
  → H11a → H11b → H11c → H12a → H12b → H12c → H12d → H12e → H13
```

H1–H8c 不依赖 U182 批 2，可先并行推进；H9 起被批 2 阻塞。

---

## 7. 测试与验收

### 7.1 环境前置（P0-1 修正）

验收环境必须明确写：

- Debian 12 amd64（或等效 glibc 基线），**无 display、无 Xvfb、无 Chromium**；
- 已安装 Orca 包（deb/rpm/AppImage 解包），包含 `orcad` 模板与 pinned Node；或安装脚本显式执行 `--preflight` 完成槽物化；
- 目标机有 `bash/curl/openssl`（脚本本身仍需要），但**不要求** `xvfb`/`libgtk` 等；
- 无既有 Orca profile，无外部 `ORCA_*`；
- `orca-ide` 在 PATH（deb 的 `/usr/bin/orca-ide`），或设置 `ORCA_CLI`。

删除 v1 §1.4「serve 已在容器/G24 验证」的表述：G24 只跑过安装脚本，从未启动 serve。

### 7.2 验收断言

1. 管理员生成 host 安装命令，目标机执行 one-liner；
2. 脚本退出 0，满足 §4.3 的 1–6；
3. 宿主进程是 `orcad`（pinned Node），不是 Electron；`ps` 中无 `Xvfb`；
4. 平台 `/v1/hosts`：该主机 `online=true`、`revokedAt===null`、`lastHeartbeatAt` 在 30s 内（`server.ts:1781-1785`）；
5. 审计恰一条本次 `host_register` success，`actor='agent'`；
6. 再次使用同一 host token 注册 → 401 `HOST_TOKEN_INVALID`（`server.ts:3516-3517`）；
7. 无人工执行 `orca-ide --host-mode`，无 curl 重放；
8. 证据：脚本 stdout/stderr、状态文件、进程树（含 `orcad.js` 与无 Xvfb）、平台主机 JSON、审计、令牌复用 401；
9. `--reenroll` 锁归属：live 宿主时退出 78 且凭据未改名；停服后只在实例锁区（`orcad-lifecycle.ts:112` 之后）改名并重注册；CLI spawn 前无任何凭据读写。

### 7.3 故障注入

| # | 注入 | 期望 |
| --- | --- | --- |
| F1 | 首次注册前断网 30s 后恢复 | 宿主有界重试；恢复后注册成功 online；令牌未提前焚 |
| F2 | 201 后代理丢弃响应 | 首次 `protocol`/78；再次启动 `host_token_invalid`/401，状态与文案可区分；不重复焚 |
| F3 | 409 `HOST_REVOKED` | 状态 `error/host_revoked`；退出 78；不重启（`RestartPreventExitStatus`） |
| F4 | 注册成功后杀宿主 | systemd 重启；不产生第二条 `host_register`；回到 online |
| F5 | 心跳持续失败 >60s | 平台 offline；状态 `degraded/heartbeat_failed`；进程不退出，恢复后 online |
| F6 | 无 `systemctl --user` | wrapper + nohup；明示不随开机自启 |
| F7 | SSH 登出（linger 成功） | 60s 后仍 online |
| F8 | 同 profile 已有桌面/宿主实例 | 退出 78 `profile_in_use`，文案可操作；不抢锁 |
| F9 | 无 `orca-ide` / orcad 槽损坏 | preflight 78，不消耗令牌 |
| F10 | 在线后心跳 401（同名重注册替换 credential） | 状态 `heartbeat_unauthorized`；退出 78，不空转 |
| F11 | 容器无 display | host mode 正常启动并 online（本设计的核心断言） |

### 7.4 单元/集成

- H1：在 `Module._load` 对 `electron` 抛错的进程里导入/启动 admission，返回 null 而非崩溃；esbuild metafile 断言 admission 子树无 `electron` 边。
- H2：orcad 用夹具平台注册、写凭据、首心跳；`ORCA_APP_VERSION` 出现在注册 payload。
- H3：参数矩阵；`--host-mode` → `serveOrcaApp({hostMode:true})`；Electron 选择器不被用于最终启动；冲突参数报错。
- H4：`--preflight` 成功/失败；fetch 调用次数为 0；令牌未被使用。
- H5：心跳成功/失败/401/抛异常四路径的 snapshot 与 listener 计数。
- H6：400/401/409/5xx/network/timeout/畸形 201 的码与 `retryable`。
- H7：原子写、0600、schema、启动即 `starting`、旧 `startedAt` 不被判 online。
- H8a：`ready` 解析但无心跳 → 不发布 online；首心跳后发布。
- H8b：退出码映射 `78`/`1`（不含 `3`）；`orca_host_online` 单行 JSON 字段。
- H8c：`--reenroll` 仅在实例锁内改名凭据；锁外在线拒绝；CLI 层无凭据 I/O。
- H9a/H9b/H9c/H10a/H10b：生成文本与状态夹具断言（见 §8）。
- 回归：`cloud-runtime-admission-env.test.ts` 继续证明仅 `ORCA_CLOUD_HOST_TOKEN` 进入注册；Electron 桌面行为不变（IPC 安装点从 admission 内部移到启动路径，调用顺序一致）。

### 7.5 非目标

- Windows 安装脚本（需求未定义；G24 Windows 行移出 v1，责任人：需求方）；
- relay `--relay-mode`；
- macOS launchd（§5.4）；
- 平台侧注册幂等键（Q5 保留）；
- 自动安装 Orca 运行时（Q1 保留：包由管理员安装或已有部署流程）。
- orcad 的浏览器自动化/SSH 目标能力（FR-4.11 不要求；若要求另立设计）。

---

## 8. 实现拆分（每令 ≤20 分钟）

> 约定：每令独立提交；H2/H3/H4 动 `orcad-entry.ts` 与 CLI，串行；H5/H6/H7 相互独立，可并行。时间含测试。v3 重拆后共 **24 令**（v2 为 17 令），每令 ≤20 分钟。

| 令 | 内容 | 主要文件 | 依赖 | 验收机检点 | 估时 |
| --- | --- | --- | --- | --- | --- |
| **H1** | 解除 admission 的 Electron 边：`attachRuntimeToCloudAdmission` 去掉 `installCloudPlatformIpc`，Electron 启动路径显式调用 | `cloud-runtime-attach.ts`、`main-process-runtime-launch.ts`、测试 | 无 | `electron` load 抛错时 admission 可导入/启动；metafile 无 electron 边；Electron 测试仍过 | 15 |
| **H2** | orcad 接入 admission：`ORCA_APP_VERSION`、`cloudRuntimeAdmission`/`cloudAdmissionOption`、`attachRuntimeToCloudAdmission(rpc, admission)` | `orcad-entry.ts`、测试 | H1 | 夹具平台 201＋首心跳；payload 含版本；access guard/provision reporter 已安装；无 DISPLAY 仍起 | 20 |
| **H3** | CLI 入口：顶层 `--host-mode`、`serve --host-mode`、强制 orcad、冲突参数、`ORCA_CLI`/`orca-ide` 解析 | `src/cli/index.ts`、`specs/serve.ts`、`handlers/core.ts`、`serve-orcad-launch.ts`、测试 | H2 | 参数矩阵；最终启动为 orcad；缺 CLI 时 78 | 20 |
| **H4** | `--host-mode --preflight`：配置/槽/锁检查，不发 HTTP、不焚令牌 | `orcad-entry.ts`、`orcad-command-arguments.ts`、测试 | H2,H3 | 成功 0/失败 78；fetch 计数 0；令牌未用 | 20 |
| **H5** | 心跳结构化：snapshot 四字段、`sendHeartbeat` 保留 HTTP 状态、四路径通知 | `cloud-agent-client.ts`、`cloud-host-enrollment.ts`、测试 | 无 | 成功/失败/401/异常快照；listener 计数 | 20 |
| **H6** | 注册错误契约：`CloudHostEnrolmentError{code,retryable,httpStatus}`；admission 原样抛 | `cloud-host-enrollment.ts`、`cloud-runtime-admission.ts`、测试 | 无 | 七类错误码/可重试性断言 | 20 |
| **H7** | 状态文件模块：schema v2、原子写/0600、启动即 starting、生命周期 | 新 `src/main/startup/cloud-host-state.ts`、测试 | H5,H6 | 权限/schema/伪在线/重启竞态/`startedAt` 断言 | 20 |
| **H8a** | host 就绪等待：新建 readiness 模块，等 `lastHeartbeatOk`、超时与状态迁移；orcad 接线 | 新 `src/main/startup/host-mode-readiness.ts`、`orcad-entry.ts`、测试 | H4,H7 | `ready` 解析但无心跳不发布 online；首心跳后发布；超时/状态夹具 | 20 |
| **H8b** | 退出码与上线输出：`78`/`1` 映射（不含 `3`）、SIGTERM→0、`orca_host_online` 单行 JSON（`event`/`hostId`/`platformUrl`/`lastHeartbeatAt`，仅供日志，脚本仍以状态文件为准） | `host-mode-readiness.ts`、`orcad-entry.ts`、测试 | H8a | 退出码矩阵无 `3`；JSON schema 快照 | 15 |
| **H8c** | `--reenroll`（锁内）：CLI 只转发参数；orcad 在实例锁后判 online/改名/失败恢复 | `src/cli/specs/serve.ts`、`handlers/core.ts`、`serve-orcad-launch.ts`、`orcad-lifecycle.ts`、`orcad-entry.ts`、测试 | H4,H8a | live 宿主退出 78 且凭据未动；改名仅在锁获取后（顺序断言）；CLI spawn 前凭据 I/O 为 0 | 15 |
| **H9a** | 脚本 host 侧（上）：`ORCA_USER_DATA_PATH`、CLI 解析、`orca-ide --host-mode`、状态路径；复用 U182 预检 | `server.ts`（`hostInstallScript`）、脚本测试 | H8c + **U182 b2** | 生成文本含 `orca-ide --host-mode`、无 `orca --host-mode`、无 REENROLL env | 20 |
| **H9b** | 脚本 host 侧（下）：preflight 调用、守护启动、状态轮询与 120s 超时 | `server.ts`、脚本测试 | H9a | 状态夹具（online/starting/degraded/error/旧 startedAt）；超时输出 | 20 |
| **H9c** | 脚本错误文案：401/409/201 三类分支与操作提示 | `server.ts`、脚本测试 | H9b | 401 文案含 re-issue；409/201 可区分；证据/日志尾部 | 15 |
| **H10a** | systemd unit：`ExecStart=<abs orca-ide>`、`Restart=on-failure`、`RestartPreventExitStatus=78`、StartLimit、linger | `server.ts`、脚本夹具 | H9c + U182 b2 | unit 文本断言（不含 `RestartPreventExitStatus=3`）；`systemd-analyze verify`（可用时） | 20 |
| **H10b** | 无 systemd：wrapper 显式 source env、nohup/setsid、pid；老 systemd 降级 | `server.ts`、脚本夹具 | H10a | wrapper 断言、无 systemctl 分支不谎报持久 | 20 |
| **H11a** | 容器环境夹具：预装 Orca 包（orcad 模板＋pinned Node）、无 display/Xvfb、临时 HOME | `cloud-platform/test/e2e/` 夹具/脚本 | H10b | 环境自检：`DISPLAY` 空、无 `Xvfb`、`orca-ide` 可执行 | 20 |
| **H11b** | 容器 e2e 脚手架与 happy path：镜像/装包/平台夹具、one-liner → 201/online、证据目录骨架 | e2e 测试 | H11a | 首次跑通 201＋online；进程树无 Xvfb；证据带 `generatedAt` | 20 |
| **H11c** | §7.2 全断言与证据：8 条断言、令牌复用 401、审计一条、证据归档 | e2e 测试 | H11b | §7.2 全断言；证据完整性 | 20 |
| **H12a** | 故障注入 F1/F4：断网恢复注册、注册后杀进程重启 | e2e/单测 | H11c | 两项断言 | 20 |
| **H12b** | 故障注入 F5/F7：心跳失败 >60s、SSH 登出 linger | e2e/单测 | H11c | 两项断言 | 20 |
| **H12c** | 故障注入 F2/F3：201 响应丢失、409 revoked | e2e/单测 | H11c | 两项断言 | 20 |
| **H12d** | 故障注入 F6/F8：无 systemd、profile 被占 | e2e/单测 | H11c | 两项断言 | 20 |
| **H12e** | 故障注入 F9/F10：CLI/槽损坏、在线心跳 401 | e2e/单测 | H11c | 两项断言 | 20 |
| **H13** | 文档/台账：U181 关闭、G24 口径、运维说明 | `defect-ledger.md`、`manual-acceptance-matrix.md`、运维文档 | H12e | 文本一致，无「协议重放」表述 | 10 |

### 8.1 依赖图

```
        ┌─ H5 ─ H7 ─┐
H1 ─ H2 ─ H3 ─ H4 ─ H8a ─ H8b ─ H8c ─ H9a ─ H9b ─ H9c ─ H10a ─ H10b ─ H11a ─ H11b ─ H11c ─ H12a ─ H12b ─ H12c ─ H12d ─ H12e ─ H13
        └─ H6 ──────┘                         ▲
                                    U182 b2 ──┘（硬前置，进 H9a/H10a）
```

- H5 可第一天派，不依赖任何宿主改动。
- H6 与 H5 可并行。
- H7 需要 H5/H6 的字段与错误码。
- H1→H2→H3→H4→H8a→H8b→H8c 为宿主主链，严格串行（同一批文件）。
- H9a 起被 U182 批 2 阻塞；若批 2 未合入，停在 H8c。
- H12a–H12e 各两项注入，可并行（共享 H11c 的容器夹具）。

### 8.2 可机检性

每令的测试必须是确定性、无外部依赖的：

- H1 用 `Module._load` 钩子或 esbuild metafile，不靠人工审阅；
- H2/H4/H8a/H8b 用本地夹具平台/假 transport，断言 HTTP 计数与状态；
- H3 用参数矩阵快照；
- H8c 用 mock fs 顺序断言：CLI spawn 前零凭据访问、改名仅在锁获取后；
- H7/H9b/H9c/H10a 用生成文本/状态 JSON 夹具；
- H11b/H11c/H12 用容器脚本，证据目录带 `generatedAt`。

### 8.3 并行修正（P2-3）

v1 的「H5 可与 H6 前半并行」在依赖上不成立。v2/v3 的并行边界只有：

- `{H5, H6}` 与 `{H1→H2}` 并行；
- H3/H4 必须等 H2；
- H7 等 H5/H6；
- H8a 等 H4/H7；H8b/H8c 与 H8a 串行（同一批文件）；
- H12a–H12e 在 H11c 后可并行；
- 所有脚本令（H9a 起）等 U182 批 2。

---

## 9. 开放问题

| # | 问题 | v3 默认 | 影响 |
| --- | --- | --- | --- |
| Q1 | 脚本自身是否必须发注册 POST？ | **不必须**：脚本启动的宿主产生 201；禁止人工步骤与协议重放 | 若验收方坚持 bash 自己发 POST，A2 不满足；但那会复制运行时自描述，已否决 |
| Q2 | 宿主 profile | 独立 `~/.orca-cloud/profile` | 状态/凭据可预测，桌面共存 |
| Q3 | 无 systemd 默认 | wrapper + nohup，明示不持久 | 容器「看起来成功但重启即失」 |
| Q4 | live 宿主时重注册 | 默认拒绝；`--reenroll` 一次性显式 | 不换掉线上 credential |
| Q5 | 注册幂等键 | v2 不做；用 §3.4 的状态码与文案覆盖 | 服务端 wire/存储变更 |
| Q6 | Windows | 不做；G24 Windows 行移出，需求方确认 | 需新需求与实现 |
| Q7 | macOS launchd | v3 不做（更新通道缺失） | 后续令 |
| Q8 | orcad 浏览器/SSH 能力 | 不在 host mode 承诺内 | 若要求，另立设计，不回退 A1 |

---

## 10. 附录 A：v1 关键对比（保留）

v1 在「谁注册」上比较了三条路线；v2 保留其结论（注册必须由运行时产生），但更换了承载运行时的进程。

| 维度 | A：运行时入口 ＋ Electron | B：脚本内注册＋守护 | C：脚本注册＋CLI 运行 |
| --- | --- | --- | --- |
| 代码复用 | 高（serve + admission） | 最低（bash 重写注册/凭据） | 中（两段式） |
| 注册正确性 | 与桌面一致：TLS 指纹、版本、capability、E2EE 心跳补齐 | 脚本无法产出 `tlsFingerprint`/`e2eePublicKeyB64`/`runtimeCapabilities` | 同 B，或退化为 A |
| 凭据所有者 | 单一（`storeHostCredential`） | 脚本复刻路径/格式 | 两段式，失败面更大 |
| 单实例 | 复用 profile 锁 | 绕过实例锁 | 同 B |
| 升级 | 复用 supervisor/包升级 | 自行替换 | 两处升级 |

v2 的修正：v1 的「A」实际绑定 Electron；评审 P0-1 证明 Electron 在无 display 的服务器上不可用。v2 保留 A 的**语义**（运行时注册、单一凭据所有者、脚本自证），把**载具**换成 orcad，从而同时满足 F8/F9 与无 display 要求。v1 的 B/C 否决理由（脚本无法自描述、双所有者）在 v2 中仍然成立。

v1 的 systemd/launchd/nohup、状态文件、重试分类、G24 口径等章节已被 v2 §3–§7 取代；v1 的具体行号与「serve 已验证」表述作废。

---

## 11. 待审表

| # | 审阅意见 | 结论（采纳/修改/否决） | 审阅人 | 日期 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
|  |  |  |  |  |

---

## 12. 附录 B：v2 → v3 变更记录（v2 结论保留）

v3 只改三处文档级问题，载具 A2、注册归属、单实例/profile、状态文件 schema、错误码体系、U182 边界与验收环境均沿用 v2。

| 项 | v2 | v3 |
| --- | --- | --- |
| 退出码 `3` | `RestartPreventExitStatus=3 78`，并称「保留在 unit 中以防未来切换」 | unit 仅 `RestartPreventExitStatus=78`；`3` 标注为 Electron-only，A2 永不产生 |
| `--reenroll` 实现位置 | 「先获取 profile 实例锁」但未写死锁区 | 写死必须在 `orcad-lifecycle.ts:112` 之后（`startOrcadWithHost` 内）；CLI spawn 前不得读写凭据；新增 H8c |
| 拆分 | 17 令；H8/H9b/H11b/H12a/H12b 超 20 分钟 | 24 令；新增 H8a/H8b/H8c、H9c、H11c、H12c–H12e；全部 ≤20 分钟 |
| 附录 | 附录 A（v1 对比） | 附录 A 原样保留，新增本附录 B |
