# U181 设计令 · 宿主接入的「自动注册并上线」载体（FR-4.11）

- 日期：2026-11-17
- 性质：设计（只设计，未改产品代码）
- 输入：`cloud-platform/test-reports/install-script-audit.md`（下称「审计」）、`defect-ledger.md` U181、`requirements.md` FR-4.11、`manual-acceptance-matrix.md` G24
- 结论：**推荐方案 A**——实现 `orca --host-mode`，作为无窗口前台入口复用现有 `serve` 运行时与 `startCloudRuntimeAdmission`；注册/心跳仍由 Electron 主进程拥有，安装脚本负责落配置、装守护、轮询状态文件自证 online。
- 范围：只解决「安装后谁注册、谁常驻、脚本如何自证」；脚本的 Host 头注入、重跑丢 TLS、`hostname -I`、openssl 静默失败等属于 **U182**，本设计不重复实现，只声明依赖。
- 复核基线：本设计撰写时 `server.ts` 已含 U182 批 1 的部分修复（`umask`/目录 0700/恒写 TLS 路径/健康检查超时与状态码/`shellQuote`），审计中的部分行号已过期，本文一律引用**当前**行号。

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 阻塞缺口 | 脚本只写 env + 健康检查；打印的 `orca --host-mode` 全仓无实现（仅脚本两处文本）；真实注册只发生在桌面/无窗口 Electron 主进程的 `startCloudRuntimeAdmission` |
| 选定方案 | **A：实现 `orca --host-mode`**，CLI 只做入口与进程监督，注册/心跳复用主进程既有链路 |
| 不选 B 的核心理由 | 脚本无法独立产出注册所需的 TLS 指纹、E2EE 公钥、版本与 capability，且必须复制 Electron 的凭据存储路径；bash 解析/持久化 JSON 风险高 |
| 不选 C 的核心理由 | 注册与运行拆成两个进程后，凭据交接只能落 env 或复制私有文件，安全性与升级路径都更差；收益仅是「脚本能直接看到 201」 |
| headless 载体 | 复用 `orca serve` 的无窗口运行时（PTY/RPC/agent/浏览器），但强制走 Electron runtime（`orcad` 尚未加载云准入），关闭本地 pairing，改为云端 readiness |
| online 自证 | 主进程在注册成功且首次心跳成功后原子写 `<userData>/orca-cloud-host-state.json`；脚本轮询该文件，不依赖管理员 API，也不靠 curl 重放 |
| systemd | 优先 `systemctl --user` + `loginctl enable-linger`；无 systemd 时 `nohup/setsid`（明示不持久）或前台阻塞；macOS 用 launchd LaunchAgent |
| 拆分 | 10 个 ≤20 分钟实现令（§8），域基本不相交；H2 与 H3 动同一启动文件，需串行 |
| 验收 | 干净 Debian 12 容器执行 one-liner 后，由脚本启动的宿主进程产生 201 与首次心跳，脚本以状态文件退出 0；平台侧显示 online；**禁止**用协议重放冒充 |

---

## 1. 现状与缺口

### 1.1 安装脚本实际做了什么

`cloud-platform/apps/api/src/server.ts:287-366`（host）与 `:369-423`（relay）：

| 阶段 | host 脚本行为 | 位置 |
| --- | --- | --- |
| 写 env | `ORCA_CLOUD_API_URL/HOST_TOKEN/HOST_NAME/ADVERTISE_HOST/PROJECTS_ROOT` + 旧别名 | `:298-315` |
| TLS | 证书不存在则 `openssl` 自签；**U182 已改为无条件写路径** | `:317-331` |
| 健康检查 | `curl` 平台 `/health`，仅 2xx 通过；只证明平台可达 | `:333-343` |
| 上线 | **什么都不做**，只打印「后续命令」：前台 `orca --host-mode`、systemd 单元 | `:345-365`（`:350`、`:358`） |

relay 脚本同样只写 env，后续打印 `node cloud-platform/apps/relay/src/relay.ts`（`:406`）与 unit（`:411`），不安装、不启动。

因此脚本的「环境已就绪」（`:343`）只等于「配置已写入且平台 `/health` 可达」，既未注册，也未启动宿主。

### 1.2 真实注册发生在哪里

唯一注册载体是 Electron 主进程：

- `src/main/startup/cloud-runtime-admission.ts:150-163` `startCloudRuntimeAdmission`：有 `ORCA_CLOUD_HOST_TOKEN` 才进入注册路径。
- `:175-255` `startEnrolled`：
  - `:197` 先读已持久化凭据（`readStoredHostCredential`）；
  - `:199-215` 无凭据才 `enrollCloudHost`（`POST /v1/hosts/register`）；
  - `:216-218` 成功后 `storeHostCredential`；
  - `:254-255` `created.refresh()`（首心跳）后 `created.start()`（10s 周期）。
- 挂载点：`src/main/startup/main-process-runtime-launch.ts:65-96` 的 `installRuntimeRpc`，在构造 RPC server 时调用 `cloudAdmissionOption`（`:94` → `cloud-runtime-admission.ts:352-372`）。

也就是说：**没有 Electron 主进程，就没有注册**。CLI 进程（`ELECTRON_RUN_AS_NODE`）本身不拥有 RPC server，不能直接“在 CLI 里调用一下 `startCloudRuntimeAdmission`”了事。

### 1.3 `orca --host-mode` 不存在

`rg` 全仓只在安装脚本文本 `server.ts:350`、`:358` 命中；`src/cli/specs/*`、`src/cli/handlers/*`、`src/cli/index.ts` 无该 flag/子命令。脚本打印的 systemd 单元因此必然启动失败。

### 1.4 无窗口运行时已经存在

`orca serve` 已经提供所需的一切：

- CLI：`src/cli/handlers/core.ts:119` → `serveOrcaApp`（`src/cli/runtime/launch.ts:109-120`）；
- 启动：`serveWithElectron`（`:144-193`）拼 `--serve`（`:155`）拉起 Electron；
- 主进程：`main-process-runtime-launch.ts:124-216` `launchServeMode` 启动 PTY、RPC、agent hooks、SSH、浏览器、自动化，最后 `printServeReady`（`:215`）；
- 云准入在同一构造路径已安装（`:94`）。

**缺的不是运行时，而是一个“云端托管”的启动形态**：无 pairing、等云注册/首心跳、输出 host readiness，而不是 `orca_server_ready` + pairing offer。

### 1.5 平台侧 online 判据

- `POST /v1/hosts/register`：`server.ts:3508-3612`；令牌单次使用 `entry.usedAt = now()`（`:3520`），失败 401 `HOST_TOKEN_INVALID`（`:3511-3512`），成功返回 `201 { hostId, credential }`（`:3606`），并立即置 `status='online'`、`lastHeartbeatAt=now()`（`:3525-3526`）。
- online 真源：`hostOnline` 要求 `status==='online'` 且 `now - lastHeartbeatAt <= hostOfflineMs`（`:1734`）；默认 60s（`:101`、`:769-771`）。
- 心跳周期：10s（`src/main/cloud-platform/cloud-agent-client.ts:104`）；失败只记 `lastError='heartbeat failed'`（`:199-201`），进程不退出。

因此「上线」应定义为：**注册 201 成功（拿到 hostId/credential）且至少一次心跳被平台接受**，而不是注册瞬间的 `status=online`。

### 1.6 缺口清单

| # | 缺口 | 证据 |
| --- | --- | --- |
| G1 | 脚本不注册、不启动 | `server.ts:333-365` |
| G2 | `--host-mode` 无实现 | 仅 `server.ts:350/358` 文本 |
| G3 | 脚本无法观察注册/心跳结果 | 无状态文件/readiness 契约 |
| G4 | 非 systemd 无载体 | 只打印 `systemctl --user`（`:363-364`） |
| G5 | 干净 headless Linux 无桌面应用 | 审计 P0-1；G24 的 201/online 为协议重放 |
| G6 | relay 脚本同样不启动 | `server.ts:401-423` |

---

## 2. 方案对比与推荐

### 2.1 三条路线

**A. `orca --host-mode`（推荐）**

- CLI 新增顶层模式入口（`orca --host-mode`，与脚本/systemd 文本一致）；内部转调 `serveOrcaApp` 的 host 变体。
- Electron 主进程新增 host-mode 选项：走 `launchServeMode` 同一套启动序列，但 `noPairing=true`，等待云准入 `ready` + 首次心跳成功后发布 host readiness，并原子写状态文件。
- 注册、凭据持久化、心跳、策略/吊销、E2EE、TLS 指纹、项目供给全部复用 `startCloudRuntimeAdmission`。

**B. 脚本内独立注册 + 守护**

- bash 直接 `POST /v1/hosts/register`，解析 `hostId/credential`，自行持久化，写 unit，启动一个只负责 RPC 的宿主。
- 不依赖 CLI 完成注册。

**C. 混合（脚本注册 + CLI 运行）**

- 脚本先注册拿到凭据，再以 env/文件交给 `orca --host-mode` 或 `serve` 运行；或脚本调用一个新的 `orca cloud register`。

### 2.2 对比表

| 维度 | A：`orca --host-mode` | B：脚本内注册+守护 | C：混合 |
| --- | --- | --- | --- |
| 代码复用 | **最高**：复用 `serve` 启动链 + `startCloudRuntimeAdmission`；新增仅为入口、host 选项、readiness | 最低：在 bash 重写注册 payload、重试、凭据落盘；宿主仍需另写启动 | 中：注册逻辑一份、启动复用 serve，但要设计凭据交接 |
| 注册正确性 | **与桌面一致**：`enrollCloudHost` 生成/读取 TLS 指纹、版本、capability、relayRoute；E2EE 公钥由后续心跳补齐 | 脚本无法取得 `tlsFingerprint`、`e2eePublicKeyB64`、`runtimeCapabilities`；只能伪造/留空，平台可见字段与真实宿主不一致 | 若由脚本拼 payload，同样缺失；若调用新 CLI 注册，则退化为 A 的变体 |
| headless 可靠性 | **高**：`serve` 已在容器/G24 验证；无窗口、可 systemd 守护 | 中：注册成功后若宿主启动失败，脚本需自行回滚/重试；两份状态不一致 | 中：两段式失败面更大（注册成功、启动失败 → 令牌已焚） |
| 单实例/daemon | 复用既有 profile 锁与 `serve` 的 userData 守卫；host 模式强制 Electron，避开无云准入的 `orcad` | 脚本绕开实例锁，可能启动第二个写同一 profile 的宿主 | 同 B，且脚本与 CLI 可能各持一份凭据 |
| 升级路径 | **复用 `serveWithElectron` 的更新 handoff/supervisor**；systemd `Restart` 兜底 | 脚本需自行处理二进制替换与重启；无更新 handoff | 脚本与 CLI 各自升级，易错位 |
| 测试成本 | 中：新增 CLI 映射、host readiness、状态文件；复用大量 serve/admission 测试 | 高：bash 注册、JSON 解析、凭据权限、失败回滚、跨发行版 | 高：A + B 的测试面 |
| 跨平台 | **可延伸**：CLI/Electron 跨平台；未来 Windows 只需 PowerShell 包装 | bash 限定 Linux/macOS；Windows 无路径 | 同 B |
| 与 FR-4.11 措辞 | 脚本执行后自动注册上线 | 同上，但注册者不是产品运行时 | 同上 |

### 2.3 推荐与理由

**推荐 A。** 决定性理由：

1. **注册不是 HTTP 调用，而是运行时自描述**：`enrollCloudHost` 的 payload 含 `tlsFingerprint`、`orcaVersion`、`runtimeCapabilities`、`relayRoute`（`cloud-host-enrollment.ts:113-150`），E2EE 公钥要等 RPC server 存在后才能由心跳上报（`cloud-runtime-admission.ts` 的 heartbeat `e2eePublicKeyB64`）。bash 无法在不复制整套密码学/运行时逻辑的前提下产出这些字段。
2. **凭据落点唯一**：`storeHostCredential` 写 Electron userData 下的 `orca-cloud-host.json`（`cloud-host-enrollment.ts:14,85-104`）。B/C 要么让脚本复刻该路径与格式，要么新增“凭据从 env 注入”的通道，后者把长期凭据放进 systemd EnvironmentFile，安全性更差。
3. **已有 90% 的载体**：`serve` 的无窗口启动序列、profile 锁、更新 handoff、日志与退出处理都可复用（§5）。A 的增量最小。
4. **C 的唯一收益是脚本能直接看到 201**，但状态文件契约（§6）同样能让脚本自证，且不牺牲单一凭据所有者。

**不选 B/C**：B 让主机身份出现两个所有者；C 把一次注册拆成两段，令牌在脚本侧焚毁后若宿主启动失败，恢复路径更差。

### 2.4 对「脚本自身产生 201/online」的口径

本设计将验收口径定义为：**脚本执行后，由脚本安装/启动的宿主进程产生 201 与首次心跳；脚本以本地状态文件退出 0；平台台账出现一条 `host_register` success**。脚本本身不发注册 POST，但注册不是人工步骤，也不是重放。若验收方坚持「bash 进程必须自己发 POST」，则本设计的 A 不满足，需回到 B——但那会让 §2.3 的 1/2 两项正确性退化，建议在 Q1 中确认口径。

---

## 3. 注册与启动时序（方案 A）

### 3.1 正常时序

| # | 执行者 | 动作 | 失败语义 |
| --- | --- | --- | --- |
| 1 | 脚本 | 预检：`bash`/`curl`/`openssl`、`HOME`、`orca` 二进制、`PROJECTS_ROOT` 可写；探测 `systemctl --user` | 任一缺失：打印可操作错误，退出非 0，**不消耗令牌** |
| 2 | 脚本 | 原子写 env（tmp + `chmod 600` + `mv`），含 `ORCA_USER_DATA_PATH`、`ORCA_CLOUD_*`、TLS 路径 | 写失败：退出非 0；不启动 |
| 3 | 脚本 | 平台 `/health` 预检（`--connect-timeout 5 --max-time 10`，仅 2xx） | 不可达：退出非 0，不消耗令牌 |
| 4 | 脚本 | 安装守护：systemd user unit（或 launchd/nohup），`enable --now` | 安装失败：退出非 0，给出替代前台命令 |
| 5 | 宿主 | 读 env；`startEnrolled` 先查已存凭据 | 有凭据：跳过注册，直接心跳 |
| 6 | 宿主 | 无凭据：`POST /v1/hosts/register`；成功持久化 `orca-cloud-host.json` | 401/409/网络错误：见 §3.3 |
| 7 | 宿主 | `refresh()` 发首心跳 | 失败：`lastError='heartbeat failed'`，10s 后重试 |
| 8 | 宿主 | 首次心跳成功后原子写 `orca-cloud-host-state.json`（`status=online`） | 写失败：日志告警，继续服务 |
| 9 | 脚本 | 轮询状态文件（默认 90s，可 `ORCA_HOST_READY_TIMEOUT` 覆盖），要求 `status=online` 且 `lastHeartbeatAt` 新鲜 | 超时：打印日志尾部 + 退出非 0 |

**令牌焚毁点**：仅第 6 步注册 201 成功后，服务端 `entry.usedAt=now()`（`server.ts:3520`）。第 1–5 步失败都不消耗令牌。

### 3.2 重跑/重启的幂等性

| 场景 | 行为 | 令牌状态 |
| --- | --- | --- |
| 首次安装，注册成功 | 写凭据；后续重启直接复用 | 已焚 |
| 宿主崩溃/重启 | 读 `orca-cloud-host.json`，跳过注册 | 无关（已焚但不再需要） |
| 脚本重跑（同一 env/profile） | 检测到凭据 → 不重新注册；启动/重启守护 | 新命令内嵌的令牌**不会被使用**，仍在 24h TTL 内 |
| 脚本重跑且用户要求重新注册 | 仅 `ORCA_CLOUD_REENROLL=1` 时删除凭据并重新注册 | 新令牌被焚；旧宿主进程的 credential 失效（同名注册会替换 `credentialHash`） |
| 两个宿主同时启动 | profile 实例锁只允许一个；第二个明确失败 | 不会双焚同一令牌 |

同名重注册会使旧进程心跳 401（`server.ts` 心跳校验 `credentialHash`）。因此默认**拒绝在检测到 live 宿主时重注册**，避免把线上主机的凭据换掉（见 Q4）。

### 3.3 失败分类与重试

| 响应/错误 | 含义 | 是否重试 | 用户动作 |
| --- | --- | --- | --- |
| 网络不可达 / DNS / 连接超时 | 请求未到达或未完成 | 是：宿主每 10s 心跳自然重试；注册阶段 `enrollCloudHost` 已有 10s 超时（`cloud-host-enrollment.ts:113-150`），systemd `Restart=on-failure` 再拉起 | 等平台恢复；令牌通常仍有效 |
| 5xx | 平台暂时故障 | 是（有界退避：`RestartSec=5`，`StartLimitBurst=10`） | 同上 |
| 400 `HOST_NAME_REQUIRED` | env 缺主机名 | 否 | 检查 `ORCA_CLOUD_HOST_NAME` |
| 401 `HOST_TOKEN_INVALID` | 令牌无效/已用/过期 | **否** | 平台重新生成安装命令；明确提示 |
| 409 `HOST_REVOKED` | 主机被吊销 | **否** | 需管理员处理吊销状态 |
| 201 后响应丢失（代理断连） | 服务端已焚令牌，客户端未拿到 credential | 否（本地无凭据，下一次 401） | 重新生成命令；见 Q5 |

宿主侧错误分类应保持在 `startEnrolled` 的 `ready` rejection 中，并映射为稳定机器可读码（`HOST_TOKEN_INVALID` / `HOST_REVOKED` / `network`），供状态文件与日志使用。

### 3.4 状态文件契约

路径：`<userData>/orca-cloud-host-state.json`。host 模式通过 `ORCA_USER_DATA_PATH` 固定 profile（§4.1），因此脚本可预测为 `$HOME/.orca-cloud/profile/orca-cloud-host-state.json`。

```json
{
  "schemaVersion": 1,
  "status": "starting|registered|online|offline|error",
  "hostId": "host_…",
  "hostName": "dev-001",
  "platformUrl": "https://…",
  "registeredAt": 1730000000000,
  "lastHeartbeatAt": 1730000010000,
  "lastErrorCode": null,
  "pid": 12345,
  "updatedAt": 1730000010000
}
```

写入规则：临时文件 + `fsync` + rename；权限 0600；每次心跳成功/失败更新 `lastHeartbeatAt`/`lastErrorCode`。`status=online` 仅在「有 hostId 且至少一次心跳成功」后出现。

---

## 4. 守护形态（systemd / 非 systemd）

### 4.1 统一前提：独立 profile

host 模式固定 `ORCA_USER_DATA_PATH=${ORCA_HOST_PROFILE:-$HOME/.orca-cloud/profile}`（脚本写入 env）。理由：

- 凭据/状态文件路径可预测，脚本能自证；
- 与用户桌面 Orca 的默认 profile 隔离，避免单实例锁互相拒绝；
- systemd/launchd 的 `ExecStart` 不依赖登录会话的 appData 解析。

同一 profile 仍只允许一个宿主：`desktop-profile-instance-lock.ts:44-52` / `serve-user-data-path-guard.ts` 的既有约束。若用户想桌面与宿主共机，必须使用不同 profile。

### 4.2 Linux + systemd（默认）

```ini
# ~/.config/systemd/user/orca-host.service
[Unit]
Description=Orca Cloud host agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=%h/.orca-cloud/host.env
ExecStart=%h/.local/bin/orca --host-mode
Restart=on-failure
RestartSec=5
StartLimitBurst=10

[Install]
WantedBy=default.target
```

脚本步骤：

1. 写 unit（路径用 `command -v orca` 解析，不硬编码 `/usr/bin/orca`）；
2. `systemctl --user daemon-reload`；
3. `systemctl --user enable --now orca-host.service`；
4. `loginctl enable-linger "$USER"`（失败则明示“SSH 登出后会离线”，并继续/退出由 Q3 默认决定）。

**linger 是必须的**：没有它，最后一个会话结束时 user manager 会停掉 unit，平台在 60s 后翻 offline。

### 4.3 Linux 无 systemd（容器/WSL/精简镜像）

检测 `systemctl --user show-environment` 失败或 `XDG_RUNTIME_DIR` 无 user bus：

- 首选：`nohup setsid orca --host-mode >> ~/.orca-cloud/host.log 2>&1 &`，写 `host.pid`；脚本轮询状态文件确认 online；
- 明示：**不随开机自启，重启后需重跑**；给出加入容器 entrypoint 的提示；
- 不伪造 systemd 成功。若用户要求持久，建议容器编排的 restart policy 或启用 systemd 的 WSL。

### 4.4 macOS（launchd）

`~/Library/LaunchAgents/com.orca.cloud-host.plist`：

- `ProgramArguments = [<orca>, --host-mode]`
- `RunAtLoad = true`，`KeepAlive = { SuccessfulExit = false }`
- `StandardOutPath/StandardErrorPath = ~/Library/Logs/orca-cloud-host.log`
- `EnvironmentVariables` 或包装脚本 source `host.env`（launchd 无 `EnvironmentFile`）

`launchctl bootstrap gui/$UID <plist>`；卸载 `bootout`。不依赖 systemd。

### 4.5 前台模式

当用户显式 `ORCA_HOST_FOREGROUND=1`，或无法安装任何守护时：`exec orca --host-mode`。脚本会一直阻塞；`Ctrl-C`/SIGHUP 即下线。仅用于调试，输出明确警告。`--host-mode` 本身必须响应 SIGTERM/SIGINT 优雅退出（复用 serve 的 quit handling）。

### 4.6 停止/卸载

- systemd：`systemctl --user disable --now orca-host.service` + 删除 unit；
- launchd：`launchctl bootout` + 删除 plist；
- nohup：读 pid 文件 `TERM`；
- 删除 `host.env`、`orca-cloud-host.json`、状态文件、TLS（或保留 TLS）；平台侧吊销主机（不在本设计新增接口）。

---

## 5. 与 `--serve` / daemon 的关系

### 5.1 形态关系

| 形态 | 入口 | pairing | 云端准入 | 就绪输出 |
| --- | --- | --- | --- | --- |
| 桌面 | GUI | 可选 | env 有 host token 时启用 | 无 |
| `orca serve` | `--serve` | 有（除非 `--no-pairing`） | 同左 | `orca_server_ready` + pairing |
| **host mode** | `--serve --serve-host-mode`（内部） | **强制关闭** | **必须启用**，否则启动失败 | `orca_host_online` + 状态文件 |

### 5.2 实现复用点

- **CLI 层**：`orca --host-mode` 作为顶层模式在 `src/cli/index.ts` 早期解析（类似 help/version），转调 `serveOrcaApp({ hostMode: true, noPairing: true })`。`serveOrcaApp` 在 host 模式下**跳过 `resolveLocalServeRuntime`**，直接 `serveWithElectron`（`:118`），因为 `src/main/orcad` 未加载 `startCloudRuntimeAdmission`（已用 `rg` 复核；orcad 走独立 `orcad-entry`，不含云准入）。
- **argv/选项**：`serve-mode-argv.ts` 增加 `--host-mode` → `--serve-host-mode`；`serve-options.ts` 增加 `hostMode`，并强制 `noPairing`。若同时出现 `--mobile-pairing` 等冲突参数，`getServeOptions` 抛错。
- **主进程**：复用 `launchServeMode`（`main-process-runtime-launch.ts:124-216`）。差异只有两处：
  1. 在 `printServeReady`（`:215`）之前，`await cloudRuntimeAdmission()?.ready`，再等待首心跳成功（轮询 `client.snapshot()`：`lastRefreshAt !== null` 且 `lastError !== 'heartbeat failed'`，有界超时）；
  2. 就绪发布改为 host readiness（`orca_host_online` + 状态文件），不创建 pairing offer。
- **禁止**：不要在 CLI 的 Node 进程里直接调用 `startCloudRuntimeAdmission`。它需要绑定 runtime 的 `CloudRuntimeTarget`（`bindRuntime`），而 CLI 没有 RPC server；硬接会得到没有 `getWebSocketEndpoint`/E2EE 的假宿主。

### 5.3 单实例与桌面共存

- host 模式与桌面默认共用同一套 profile 锁；使用 §4.1 的独立 profile 后互不干扰。
- `serve-user-data-path-guard` 的既有守卫继续生效：host 模式不得落到别的 profile。
- 若同 profile 已有桌面实例，host 模式应退出并打印「请用 `ORCA_USER_DATA_PATH` 指定独立 profile，或先退出桌面 Orca」，而不是抢锁/静默重启。

### 5.4 升级路径

- 复用 `serveWithElectron` 的 `superviseForegroundServe` 与 macOS update handoff（`launch.ts:144-193`），自动更新后由 supervisor 重新拉起；
- systemd `Restart=on-failure` 处理 Linux 包升级后的进程退出；
- 凭据持久化在 profile，升级/重启不重新注册（§3.2）；
- `--host-mode` 必须与 `serve` 共用同一版本协商与 profile 迁移逻辑，不新增独立升级通道。

### 5.5 与 relay 的关系

relay 脚本不在本设计范围（FR-4.11 的 relay 侧同样只写 env）。本设计的 CLI/守护/状态文件模式可复制给 relay，但 relay 没有云准入链路，需要单独设计 `orca --relay-mode`；本设计只保证不与之冲突。

---

## 6. 日志 / 健康 / 就绪判据

### 6.1 日志

| 形态 | 位置 |
| --- | --- |
| systemd | `journalctl --user -u orca-host.service`（host 模式输出结构化行到 stdout/stderr） |
| launchd | `~/Library/Logs/orca-cloud-host.log` |
| nohup | `~/.orca-cloud/host.log` |

日志必须包含：版本、profile、platform URL、hostName、注册结果（成功 hostId / 失败码）、每次心跳失败原因、revoked/maintenance 状态。不得打印 host token 或 credential。

### 6.2 就绪判据（脚本自证）

脚本不接受「平台 `/health` 可达」作为上线依据。判据按顺序：

1. 状态文件存在且 `schemaVersion=1`；
2. `hostId` 非空，`registeredAt` 非空；
3. `status=online` 且 `lastHeartbeatAt` 在最近 30s 内；
4. `pid` 对应进程存活（`kill -0`，仅本地形态）；
5. 可选：unit 处于 active（systemd）或 launchd job 存在。

任一不满足且超过 `ORCA_HOST_READY_TIMEOUT`（默认 90s）→ 退出非 0，打印日志尾部与下一步。

### 6.3 平台侧核对（验收用，非脚本依赖）

验收时由管理员查询平台：

- `GET /v1/hosts` 中该 host `online=true` 且 `lastHeartbeatAt` 新鲜；
- 审计出现且仅出现一条本次 `host_register` success；
- 重复使用同一 host token 得到 401（证明令牌确由本次注册焚毁）。

脚本本身不需要管理员凭据，避免把平台管理员 token 下发到目标机。

### 6.4 健康与离线翻转

- 心跳成功 → 状态文件 `online`；
- 连续心跳失败 → 状态文件保留 `online` 但 `lastErrorCode='heartbeat_failed'`，并更新 `updatedAt`；平台在 60s 后翻 offline；
- 宿主被吊销 → `status=error`，`lastErrorCode='host_revoked'`，进程按既有逻辑停止；
- 脚本只在安装阶段等待 online，不在常驻期轮询平台。

---

## 7. 测试与验收

### 7.1 干净容器验收（G24 重写口径）

环境：Debian 12 amd64，无桌面、无既有 Orca profile、无 `ORCA_*` 环境变量；仅预装 bash/curl/openssl/awk。

步骤与断言：

1. 管理员在平台生成 host 安装命令；目标机执行 one-liner；
2. 脚本退出码 0，且满足 §6.2 的 5 条；
3. 平台 `/v1/hosts` 该主机 `online=true`，`lastHeartbeatAt` 在 30s 内；
4. 审计恰有一条 `host_register` success，`actor='agent'`；
5. 再次使用同一 host token 注册 → 401 `HOST_TOKEN_INVALID`；
6. 全过程无人工执行 `orca --host-mode`，无 curl 重放注册；
7. 证据目录记录：脚本 stdout/stderr、状态文件、平台主机 JSON、审计事件、令牌复用 401。

### 7.2 故障注入

| # | 注入 | 期望 |
| --- | --- | --- |
| F1 | 首次注册前断网，30s 后恢复 | 宿主有界重试；恢复后注册成功并 online；令牌未被提前焚毁 |
| F2 | 注册返回 201 后代理丢弃响应 | 宿主报 `HOST_TOKEN_INVALID`（本地无凭据）；脚本非 0；提示重新生成命令（记录为已知边界，Q5） |
| F3 | 平台返回 409 `HOST_REVOKED` | 宿主停止，状态文件 `error/host_revoked`；脚本非 0；不重试 |
| F4 | 注册成功后杀掉宿主 | systemd/launchd 重启；不产生第二条 `host_register`；状态回到 online |
| F5 | 心跳持续失败 > 60s | 平台 online → offline；状态文件 `lastErrorCode=heartbeat_failed`；进程不退出，恢复后 online |
| F6 | 无 `systemctl --user` | 走 nohup 或前台；脚本明确“不随开机自启” |
| F7 | SSH 登出（systemd + linger） | 60s 后仍 online |
| F8 | 同 profile 已有桌面实例 | host 模式拒绝启动，错误可操作 |
| F9 | 无 `orca` 二进制 / 版本不匹配 | 脚本预检失败，非 0，不消耗令牌 |
| F10 | 容器无 X display | host 模式按 `serve` 既有 headless 能力启动；若失败，脚本给出 xvfb/显示依赖提示 |

### 7.3 单元/集成测试

- CLI：`--host-mode` → `serveOrcaApp({hostMode:true,noPairing:true})`；host 模式跳过 orcad 选择；与 `--mobile-pairing` 冲突时报错。
- `serve-options`：`--serve-host-mode` 强制 `noPairing`；`--host-mode` 归一化。
- 主进程：host 模式在 `printServeReady` 前等待 `admission.ready` + 首心跳；超时返回非 0；不创建 pairing offer。
- 状态文件：原子写、0600、online 只在首心跳成功后出现、心跳失败更新 `lastErrorCode`。
- 准入错误映射：401/409/network 的稳定码。
- 回归：`cloud-runtime-admission-env.test.ts`（`:150-190`）继续证明仅有 `ORCA_CLOUD_HOST_TOKEN` 才进注册；新增 host 模式 e2e 不改变该判定。

### 7.4 非目标

- Windows 安装脚本（Q6）；
- relay `--relay-mode`；
- 平台侧幂等注册键/令牌重放（Q5）；
- 自动安装 Orca 运行时（Q1）；
- TLS 证书续期/SAN（U182/M121）。

---

## 8. 实现拆分（每令 ≤20 分钟）

> 约定：每令独立提交，`--no-verify` + `pathspec=该令文件`；H2/H3 同动 `main-process-runtime-launch.ts`，必须串行；其余可并行。时间含测试。

| 令 | 内容 | 主要文件 | 依赖 | 验收 | 预估 |
| --- | --- | --- | --- | --- | --- |
| H1 | CLI 顶层 `--host-mode` 解析与转调；host 模式跳过 orcad，强制 Electron；`--mobile-pairing` 等冲突报错 | `src/cli/index.ts`、`src/cli/runtime/launch.ts`、`serve-orcad-launch.ts`（类型）、对应测试 | 无 | `orca --host-mode` 调用 `serveOrcaApp` 且 argv 含 `--serve --serve-host-mode`；orcad 选择函数不被调用 | 15–20 |
| H2 | argv/选项归一化：`--host-mode`→`--serve-host-mode`；`ServeOptions.hostMode`；强制 `noPairing` | `src/main/startup/serve-mode-argv.ts`、`serve-options.ts`、`main-process-serve.ts`、测试 | H1 | 参数矩阵测试：host-mode 无 pairing；冲突组合抛错 | 15 |
| H3 | 主进程 host 启动分支：复用 `launchServeMode`，在就绪前等待云 `ready` + 首心跳；不创建 pairing offer | `main-process-runtime-launch.ts`、`cloud-runtime-admission.ts`（暴露 whenOnline 或 snapshot 访问）、测试 | H2 | 假 admission：ready 前不发布；首心跳后发布；超时非 0 | 20 |
| H4 | host 状态文件模块：原子写、0600、schema、online 判定、错误码 | 新 `src/main/startup/cloud-host-state.ts` + 测试 | H3 | 原子性/权限/schema/online 条件测试 | 15 |
| H5 | host readiness 输出：`orca_host_online` 行 + 人类可读摘要；错误分类 401/409/network | 新 `src/main/startup/host-mode-readiness.ts`、`cloud-host-enrollment.ts`（错误码）、测试 | H3,H4 | 三类错误输出稳定码；成功输出含 hostId/hostName | 15–20 |
| H6 | 安装脚本 host 侧改造：预检、原子 env、独立 profile、装守护、轮询状态文件 | `cloud-platform/apps/api/src/server.ts`（`hostInstallScript`）、`install-wizard.e2e.test.ts` | H4,H5 | 干净 HOME 执行：退出 0、状态 online、无人工步骤 | 20 |
| H7 | systemd unit + linger + 无 systemd fallback + macOS launchd | `server.ts`（脚本生成）、脚本测试/夹具 | H6 | 四种形态的生成文本断言；无 systemctl 分支不谎报持久 | 15–20 |
| H8 | 平台 e2e：干净容器 one-liner 产生 201/online；令牌复用 401；审计一条 | `cloud-platform/test/e2e/install-wizard.e2e.test.ts` 或新 host 安装 e2e | H6,H7 | §7.1 全部断言；证据落盘 | 20 |
| H9 | 故障注入：F1–F5、F7、F8 | 同上 + 单元测试 | H8 | 表 §7.2 通过 | 20 |
| H10 | 文档/台账：defect-ledger U181 关闭、G24 口径更新、使用说明 | `defect-ledger.md`、`manual-acceptance-matrix.md`、运维文档 | H8 | 文本一致，无“协议重放”表述 | 10 |

**并行建议**：H1→H2→H3→H4 串行（启动链）；H5 可与 H6 前半并行；H6/H7 只在 `server.ts` 内，注意与 U182 批 2 的冲突——若 U182 仍在改 `hostInstallScript`，H6 必须排在 U182 之后或由同一代理合并。

---

## 9. 开放问题（Q1–Q6）与建议默认

| # | 问题 | 建议默认 | 影响 |
| --- | --- | --- | --- |
| Q1 | 「脚本自身产生 201/online」是否允许由脚本启动的宿主进程产生？ | **允许**：脚本负责启动与自证，注册由宿主运行时产生；禁止人工步骤与协议重放 | 若不允许，只能选 B，需接受 §2.3 的注册正确性退化 |
| Q2 | host 模式用独立 profile 还是桌面默认 profile？ | **独立** `~/.orca-cloud/profile`（`ORCA_USER_DATA_PATH`） | 决定状态文件/凭据路径与桌面共存策略 |
| Q3 | 无 systemd 时的默认行为？ | 优先 nohup 后台并明示不持久；`ORCA_HOST_FOREGROUND=1` 时前台阻塞 | 决定脚本是否在容器中“看起来成功但重启即失” |
| Q4 | 已有 live 宿主时，新安装命令是否允许重新注册（同名替换 credential）？ | **拒绝**，复用已存凭据；仅 `ORCA_CLOUD_REENROLL=1` 强制重注册 | 避免把线上主机的 credential 换掉 |
| Q5 | 是否为注册增加客户端幂等键，解决「201 后响应丢失、令牌已焚」？ | **v1 不做**；返回可操作 401 指引，列为后续平台增强 | 需要服务端 wire/存储变更，超出本设计 |
| Q6 | Windows 是否在 v1 范围？ | **不在**；FR-4.11 只定义 bash one-liner，仓库无 `host.cmd`/`.ps1`；G24 的 Windows 行移出或标注待需求 | 决定是否需要 Windows 安装脚本与 CI |

---

## 10. 待审表

| # | 审阅意见 | 结论（采纳/修改/否决） | 审阅人 | 日期 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
