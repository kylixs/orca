# PC 端连接云端 Orca 服务 —— 方案文档

| 项       | 值                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 状态     | 调研完成（可实现、部分已实现）                                                                              |
| 面向版本 | orca 1.4.214                                                                                                |
| 结论摘要 | PC 连远端/云端 Orca **已是一等公民功能**，走**直连**；云端 relay 当前**只服务移动端**，但其协议层对 PC 开放 |

---

## 1. 背景与目标

**问题**：目前感觉"只有移动端支持远程连接开发"，PC 端能否连云端 Orca？

**结论**：

1. PC 端连云端 Orca **早就支持**，而且比移动端更原生——支持三条路径（Remote Orca Server 直连 / SSH 托管 / 浏览器客户端）。
2. 云端 relay（`relay.onorca.dev`）是**为移动端专门建的**，PC 不用它。
3. relay 的**协议层是平台无关的**，PC 连 relay 缺的是"桌面端接线"，不是协议能力。

**目标**：讲清 PC 连云端 Orca 的现状、可选项、操作步骤，以及"若要让 PC 也走 relay"需要补什么。

---

## 2. 架构总览

### 2.1 runtime（服务端） vs client（界面端）

Orca 是 C/S 结构：**runtime** 拥有 repo、worktree、terminal、agent 进程、provider 账号与凭据；**client** 只是界面。已实现的 client：

| Client               | 连远端 server 的方式                       |
| -------------------- | ------------------------------------------ |
| 桌面 Electron        | `ws` / `wss` **直连**（+ 可选的 SSH 托管） |
| 浏览器（web client） | 直连，runtime server 托管 web bundle       |
| 移动 App             | **直连 LAN** 或**经云端 relay**（E2EE v2） |

### 2.2 连接形态矩阵

```text
                     ┌──────────────────────────────┐
                     │        Orca runtime          │
   直连 ws/wss  ────► │  repos · worktrees · agents  │
   (PC / 浏览器)      │  terminals · provider creds  │
                     └──────────────────────────────┘
                                  ▲
                                  │ ws/wss 直连（LAN / Tailscale / SSH 隧道 / 反代）
                                  │
                     ┌────────────┴────────────┐
                     │                         │
              桌面客户端 / 浏览器          移动 App
                                                │
                                                │ 蜂窝网/无稳定私网
                                                ▼
                                    云端 relay（WSS splice, E2EE）
```

### 2.3 relay 的定位

`cloud/README.md` 首句即定位：

> The relay that connects the Orca **mobile app** to a desktop host. Phones and desktops never talk to each other directly: each opens an outbound WebSocket to a relay cell, the relay pairs the two sessions, and it splices frames between them.

- relay **只做配对 + 帧中转**，E2EE 在 client↔host 之间，relay 只见密文。
- 一个镜像按 `ORCA_RELAY_ROLE` 跑 `combined` / `director` / `cell` 三种角色。
- 与之并列的 `apps/push`（APNs/FCM 推送网关）是移动专属，但**不在 relay 数据路径上**。

---

## 3. PC 连接的三条路径

### 3.1 Remote Orca Server（主推，直连）

**定位**：一台机器常驻 Orca 作为 server，PC/浏览器/手机作为 client 连它，共享同一套会话。

**服务端准备**（二选一）：

- **桌面 App**：`Settings → Remote Orca Servers → Advertise this app as a server → New Link`，选连接地址（Tailscale/LAN），`Generate Access Link`。
- **Headless**：

  ```bash
  orca serve --pairing-address <server-tailscale-ip-or-hostname>
  # Linux 上 CLI 名为 orca-ide（/usr/bin/orca 被 GNOME Orca 屏读占用）
  orca-ide serve --pairing-address <server-tailscale-ip-or-hostname>
  ```

  `--pairing-address` 只影响**客户端该拨哪个地址**；可选 `--port 6768` 固定端口。

**客户端（PC）操作**（二选一）：

- 侧边栏 **Add remote server** → "Pair with Orca running on another computer" → 粘贴 access link。
- `Settings → Remote Orca Servers → Add Server` → 填名称 + 粘贴 access link → `Connect`。

**传输与解析**：

- 传输：`ws://` / `wss://` 直连服务端 runtime endpoint（`src/shared/remote-runtime-request-websocket.ts`，底层 `ws`）。
- 解析：`parseHostAccessLink`（`src/shared/remote-pairing-address.ts`）只接受 `ws:` / `wss:`，endpoint 分成 `loopback | tailscale | lan | public | custom`。
- 校验：客户端拨号后发 `status.get` 校验 host 身份并持久化（`src/main/ipc/runtime-environment-pairing-verification.ts:26,42`）。

**代码入口**：

| 关注点                            | 位置                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 侧边栏入口                        | `src/renderer/src/components/sidebar/AddRepoHostSelector.tsx:150`                                                             |
| 添加对话框（`'ssh' \| 'server'`） | `src/renderer/src/components/sidebar/AddRemoteHostDialog.tsx:23`                                                              |
| IPC handler                       | `src/main/ipc/runtime-environment-connectivity-handlers.ts:85`（`verifyAndAddFromPairingCode`，另含 connect/disconnect/call） |
| 握手校验                          | `src/main/ipc/runtime-environment-pairing-verification.ts`                                                                    |
| Settings 面板                     | `src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx`                                                            |
| 客户端能力声明                    | `src/shared/electron-remote-runtime-client-capabilities.ts`                                                                   |

**网络前提**：官方推荐 **Tailscale**（两端同 tailnet，地址通常 `100.x.y.z`）。也支持 LAN、SSH 本地端口转发（loopback link + 勾选 "I am using an SSH tunnel"）、反向代理。**不要**把端口直接暴露公网，**不要**选 `127.0.0.1` 给另一台机器。

**激活为默认**：连上后，`Advanced → Active Server` 可把新工程/终端/provider 检查/browser 与 mobile 交接默认路由到该 server。仅添加 server **不会**强制所有新工程都走它。

### 3.2 SSH 托管（PC 独有）

**定位**：PC SSH 到远端机器，把 `orcad` 部署上去并建隧道；与"PC 拥有 runtime"的 SSH worktree 模式不同，这里是**远端拥有 runtime**。

- 代码：`src/main/ssh/`（约 300 文件，如 `ssh-relay-deploy.ts`、`orcad-remote-deploy.ts`、`orcad-managed-tunnel-manager.ts`）。
- 入口：`Settings → SSH`；添加 SSH host 走 `AddRemoteHostDialog` 的 `ssh` 模式。
- 扩展：SSH host 可被**发布成对其他 client 的 pairing 目标**（`src/main/ssh/orcad-tunneled-pairing.ts`，把 loopback pairing offer 重指到隧道端口）。

### 3.3 浏览器客户端

runtime server 可托管 web bundle（`pnpm build:web` → `out/web`；renderer 侧 `src/renderer/src/web/`、`vite.web.config.ts`）。`orca serve` 的说明：

> When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.

即：不装桌面 App，直接用浏览器连云端 server 也可行。

### 3.4 Cloud VM / per-workspace environment

若要"按 workspace 现开的云 VM"，路径是 **recipe**（repo 里的 `orca.yaml` + 生命周期脚本）：recipe 启动 `orca serve` 并返回 pairing URL，Orca 把它当作 remote server 接入。属于 **BYO 云**（Vercel Sandbox / Fly / Modal / SSH / Docker），**Orca 不自营 VPS**。

---

## 4. 与移动端的对比：为什么 relay 是移动独有的

### 4.1 复用与差异

PC 与移动端**复用同一套 pairing 协议与传输**：

- pairing code：`src/shared/pairing.ts`（`orca://pair?code=<base64url(JSON)>`）
- 传输：WebSocket
- 地址解析：`parseHostAccessLink` / `classifyRemotePairingHostname`

**唯一的非对称**：移动端多了 relay 路径（以及 relay 特有的凭据续期），PC 多了 SSH 托管路径。

### 4.2 为什么手机需要 relay

| 维度     | PC                              | 移动端                   |
| -------- | ------------------------------- | ------------------------ |
| 网络路径 | 可建私网（Tailscale）/ 自建隧道 | 蜂窝网，无稳定私网       |
| 公网可达 | 不必要                          | 必要 → 需 relay          |
| 直连代价 | 更少一跳、不经第三方、更安全    | 不可行 / 不可靠          |
| 结论     | 直连                            | 直连 LAN，或经云端 relay |

### 4.3 scope 硬隔离

pairing offer 带 `scope`（`mobile` / `runtime`，`src/shared/mobile-relay-pairing-offer.ts:10,79`），构成硬边界：

- 桌面 client **拒绝** mobile-scope 链接：`src/shared/remote-pairing-address.ts:101` 报 "This link grants mobile-only access. Generate a link for another Orca client."
- 反向：mobile-scope 会话的工作区功能被禁用，提示改用 "browser access link from Settings → Runtime Environments → Share this Orca server"。
- 约束：`offer.relay && offer.scope === 'runtime'` 被视为非法（`mobile-relay-pairing-offer.ts:83`）——**即 relay 只在 mobile scope 下出现**。

**这解释了现象**：PC 端 UI 里根本看不到 relay 选项，因为 relay 只在 mobile-scope 的 offer 里。

---

## 5. relay 的 PC 扩展性差距分析

### 5.1 协议层：平台无关 ✅

- client 被建模为通用 "device"（`relayDeviceId` + device credential install/resume）。
- client socket = 普通 WSS + 首帧 `RelayAuth { mode, credential }`。
- E2EE 在 client↔host 之间（host 持 E2EE keypair，`src/main/runtime/relay/desktop-relay-service.ts`）。
- **一个实现 `relay-contract` 的 PC client 在协议上可以连。**

### 5.2 实现层：当前偏移动端 ⚠️

- relay 连接账本按"手机座位"预留（`tryReservePhone` / `phoneAdmission`，`cloud/apps/relay/src/relay-server.ts`）。
- 桌面端**只被接成 relay 的 HOST 端**（`DesktopRelayService` / `RelaySessionBroker`），没被接成 CLIENT 端。
- client 侧 E2EE keypair / session 代码目前**仅存在于 `mobile/src/transport/`**。
- `apps/push`（APNs/FCM）是移动专属，但不在 relay 数据路径上。

### 5.3 结论

让 PC 走云端 relay，**缺的是"桌面 client 侧接线"**（移植 client E2EE 会话 + 放开 phone-seat 约束），**不是协议能力**。若只是"PC 连云端 Orca"，**根本不需要** relay——直连即可。

---

## 6. 推荐方案

### 6.1 决策树

```text
我要在 PC 上连一台云端/远端 Orca，选哪条路？

├─ 想要"一个常驻 runtime + 多端共享会话（含手机/自动化）"
│     └─► Remote Orca Server（直连）        ★ 推荐，覆盖 PC + 浏览器 + 手机
│
├─ 只想让远端跑部分 worktree/终端，PC 自己拥有 runtime
│     └─► SSH worktree（Settings → SSH，Run on 选目标）
│
├─ 远端是 headless / 无法开桌面窗口
│     └─► orca serve --pairing-address <ip>，PC 粘贴链接
│
└─ 每个任务要一次性干净的云 VM
      └─► Cloud VM recipe（orca.yaml + 生命周期脚本，BYO 云）
```

### 6.2 标准落地步骤（PC → 云端 Server）

1. 云端机器装 Orca；headless 则 `orca serve --pairing-address <Tailscale IP>`。
2. 两端装 Tailscale，登录同一 tailnet。
3. PC：侧边栏 **Add remote server** 粘贴链接（或 Settings → Remote Orca Servers → Add Server）。
4. 显示 **Connected** 后正常使用；需要默认路由时到 `Advanced → Active Server`。
5. 免 Tailscale 方案：SSH 本地端口转发 + loopback link，勾选 "I am using an SSH tunnel"。
6. 安全：用 `Shared Server Access` 逐个吊销 client 的独立 token；不要公网暴露端口。

### 6.3 安全与网络要点

- 每个配对 client 一个**可吊销** token；吊销即断开在用 client。
- 重新生成链接会替换**上一个未使用**的链接；已配对 client 保留各自 grant。
- Tailscale ACL/grants 尽量收紧。
- 不要 `127.0.0.1`、不要通配地址给远端 client。

---

## 7. 附录：关键文件索引

| 主题                                   | 文件                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| 官方文档：Remote Orca Servers          | `docs/site/content/docs/remote-servers.mdx`                 |
| 官方文档：运行方式全景                 | `docs/site/content/docs/ways-to-run.mdx`                    |
| 官方文档：移动端                       | `docs/site/content/docs/mobile.mdx`                         |
| relay 说明                             | `cloud/README.md`                                           |
| pairing 编解码                         | `src/shared/pairing.ts`                                     |
| pairing offer schema（含 scope/relay） | `src/shared/mobile-relay-pairing-offer.ts`                  |
| 地址解析 / mobile-scope 拒绝           | `src/shared/remote-pairing-address.ts`                      |
| 环境 schema / 端点                     | `src/shared/runtime-environments.ts`                        |
| 桌面 remote client 传输                | `src/shared/remote-runtime-request-websocket.ts`            |
| PC 作 client 的 IPC                    | `src/main/ipc/runtime-environment-connectivity-handlers.ts` |
| 配对校验                               | `src/main/ipc/runtime-environment-pairing-verification.ts`  |
| 桌面作 relay HOST                      | `src/main/runtime/relay/desktop-relay-service.ts`           |
| 移动端 transport（含 relay client）    | `mobile/src/transport/`                                     |
| relay 服务端                           | `cloud/apps/relay/src/relay-server.ts`                      |
| CLI 规格：serve                        | `src/cli/specs/serve.ts`                                    |
| CLI 规格：environment/托管 server      | `src/cli/specs/managed-server.ts`                           |

---

## 8. 后续可选项

- **(A)** 实机跑通一次 `orca serve` + Add Server。
- **(B)** 梳理完整连接/handshake 时序（直连 + relay 两条）。
- **(C)** 评估"让 PC 也走 relay"的具体改动面（client E2EE 会话移植、phone-seat 约束放开、UI 入口）。
