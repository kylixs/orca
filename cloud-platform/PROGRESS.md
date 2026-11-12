# 开发进度

> 更新时间：2026-11-13 10:25
> 规则：每轮只推进一个模块；失败必须如实记录。

## 模块状态

| 模块 | 状态 | 证据 | 备注 |
|---|---|---|---|
| M0 契约 | ✅ 完成 | `evidence/e2e-platform/` + 单元 10/10 | 凭证 Ed25519、方法映射、路径边界、审计链 |
| M1 平台 API | ✅ 完成 | E1–E8 | 登录锁定、会话纪元、ACL、凭证、策略、审计、内部接口 |
| M2 中继 | ✅ 完成 | E2、E10 | SNI ClientHello 解析、纯 TCP、黑洞、路由同步 |
| M3 运行时 + 策略网关 | ✅ 完成 | E3–E6 | 升级期验签、方法权限、路径边界、导出拦截 |
| M4 客户端 | ✅ 完成 | E1、E2 | 无凭证预检、直连优先、中继回落 |
| M5 Agent | ✅ 完成 | Web 主机页在线 | 注册、心跳、撤销同步 |
| M6 Web 前端 | ✅ 完成 | `evidence/web-ui/*.png` | 6 个页面 + 403 + 角色门禁 |
| M7 端到端 | ✅ 完成 | `evidence/e2e-platform/*.json` | 14 条用例全通过 |
| M8 管控面服务端门禁 | ✅ 完成 | `evidence/m8-admin-gating/` | 13 条用例：8 个管理接口 403、401、denied 审计、存在性不泄露 |
| M9 内部通道 mTLS | ✅ 完成 | `evidence/m9-mtls/` | 8 条用例：有效证书放行、无证书/异 CA 握手失败、CN 白名单、路径范围、令牌双重校验、中继与 Runtime 实际走 mTLS |
| M10 中继 SNI 白名单 | ✅ 完成 | `evidence/m10-relay/` | 8 条用例：后缀白名单、裸主机名/异后缀/多层子域拒绝、未知路由黑洞、非 TLS 拒绝、单 IP 并发上限、元数据不含负载 |
| M11 撤销关闭已建连接 | ✅ 完成 | `evidence/m11-revocation/` | 设备吊销后 4.2 秒内 `close(4403, device_revoked)`；合并入升级期同一撤销快照 |
| M12 控制面挂起韧性 | ✅ 完成 | `evidence/m12-control-plane-resilience/` | 请求可中止（Runtime active≤4，修复前 9）；响应体挂起时轮询继续；中继单飞 + 3 秒超时，首次同步不阻塞监听 |
| M13 真实 Orca Runtime 升级期准入 | ✅ 完成 | `evidence/m13-orca-admission/` | 在真实 `OrcaRuntimeRpcServer` 的 WS 升级前校验云端凭证：8 条真实升级用例；平台/主机验签实现一致性 7 条 |
| M14 开发机侧云端接入 | ✅ 完成 | `evidence/m14-cloud-agent/` | Agent 轮询 JWKS/撤销快照（单飞 + 超时）；`orca serve` 按 env 开启云端模式；4 条真实平台进程 + 真实 Runtime 端到端 |
| M15 云端会话撤销关闭（真实 Runtime） | ✅ 完成 | `evidence/m15-cloud-session-revocation/` | 准入时按凭证登记设备（`adoptCloudDevice`）；平台吊销后 `close(4403)`；3 条真实 E2EE 会话用例 |
| M16 控制面三路隔离与撤销快照 fail-closed | ✅ 完成 | `evidence/m15-cloud-session-revocation/isolation.txt` | 评审 07 F1/F2：三路独立落地（allSettled + 每请求独立 timeout）、非法撤销体保留上一快照；3 条真实进程用例 |
| M17 评审 07 遗留用例 | ✅ 完成 | `evidence/m17-review07-gaps/` | 4 条：公网内部路由 404（N6）、非默认 INTERNAL_TOKEN（M8）、TLS 中止分支、allow 正向放行；每条均做过回退变红对照 |
| M18 开发机自注册与心跳 | ✅ 完成 | `evidence/m18-host-enrollment/` | 一次性令牌注册、凭证持久化复用、心跳下发撤销/策略/维护态、心跳上报真实绑定端口与 E2EE 公钥；7 条真实平台进程 + 真实 Runtime 用例 |
| M19 桌面端云端连接客户端 | ✅ 完成 | `evidence/m19-desktop-connect/` | 登录/项目列表/选路/升级/E2EE/加密 RPC；Runtime 支持 WSS；4 条真实平台 + 真实 TLS Runtime 用例 |
| M20 渲染进程 IPC 会话面 | ✅ 完成 | `evidence/m20-cloud-ipc/` | `cloud:*` 六个通道 + 连接事件推送；会话状态不含任何令牌；5 条真实平台 + 真实 Runtime 用例 |
| M21 客户端界面（登录/工作台） | ✅ 完成 | `evidence/m21-cloud-ui/` | `CloudApp` + 登录面板 + 工作台列表；8 条界面用例（happy-dom），路由接入 `App.tsx` |

## 最近一次测试结果

```
node --test test/contract.test.ts            11 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts   16 pass / 0 fail
node --test test/e2e/admin-gating.e2e.test.ts 13 pass / 0 fail
node --test test/e2e/mtls-control-channel.e2e.test.ts 8 pass / 0 fail
node --test test/e2e/relay-hardening.e2e.test.ts 8 pass / 0 fail
node --test test/e2e/revocation.e2e.test.ts 1 pass / 0 fail
node --test test/e2e/control-plane-resilience.e2e.test.ts 3 pass / 0 fail
node --test test/cloud-admission-parity.test.ts 7 pass / 0 fail
node --test test/e2e/control-plane-isolation.e2e.test.ts 3 pass / 0 fail
node --test test/e2e/review07-gaps.e2e.test.ts 4 pass / 0 fail
合计 74 pass / 0 fail
```

M13（Orca 主进程侧，vitest）：

```
npx vitest run src/main/runtime/runtime-rpc-cloud-admission.test.ts  8 pass / 0 fail
npx vitest run src/main/cloud-platform                              12 pass / 0 fail
npx tsc --noEmit -p config/tsconfig.node.json                        通过
回归：runtime-rpc-websocket-bind-host / pairing-offer / device-revocation  33 pass
```

E2E 覆盖：
- E1 登录 → 项目列表 → 直连打开
- E2 直连不可达 → SNI 中继回落
- E3 伪造凭证升级被拒
- E4 方法级权限（无 file:write 被拒）
- E5 导出类方法拒绝
- E6 路径穿越 / 跨工作区写越界
- E7 撤销后旧凭证失效、新登录不可见
- E8a 畸形策略值：真实会话下 `files.download` 仍为 `EXPORT_DENIED`，Runtime 存活（不再指向已停机的 API）
- E8 平台停机 3.5 秒（跨过 3 次轮询）后 Runtime 存活、会话仍可读写
- E7a 符号链接写逃逸被拒（realpath + 分隔符感知）
- E7b 凭证移植到另一设备被拒（原设备同凭证仍可用）
- E7b2 缺失设备公钥头一律拒绝（不允许省略绕过）
- E7c 客户端版本过低返回 426
- E7d 托管工作区创建幂等且落在 workspaceRoot
- E9 证据汇总
- E10 中继未知 SNI 黑洞

M8 管控面门禁：
- 开发者访问主机/注册令牌/登记项目/授权/策略/归档/审计 8 个接口均 403
- 未登录访问管控面 401
- 被拒操作写入 denied 审计
- 未知项目与无权限项目响应完全一致（除 traceId），不泄露存在性

M9 内部通道：
- 中继与 Runtime 改用专用 HTTPS 监听（客户端证书 + CN 白名单）
- 无证书、异 CA 证书均在 TLS 握手期失败
- 内部监听只暴露 `/v1/internal/*`，其他路径 404
- mTLS 通过后仍需内部令牌（双重校验）
- JWKS 走公开监听，policy/revocations 走内部 mTLS；Runtime 日志 `policy synced v=1` 证明实际使用

## 第 5 轮评审修复

- MAJOR C-01：畸形 200 策略响应导致 Runtime 未处理拒绝退出 → 加响应形状校验（保留上一份策略）+ `authorize` 移入 try，新增 E8a 回归用例（配伪造控制面，实测进程存活）
- 控制面请求加 3 秒超时 + 单飞，平台黑洞时不再堆积悬挂连接
- 设备吊销写入撤销集合并经心跳/内部接口下发，Runtime 消费 `device_revoked`
- JWKS 加 5 分钟 TTL，超期拒绝新连接（`jwks_stale`）
- `createManaged` 幂等键按 project+device 命名空间；分支名含 `..` 直接拒绝而非改写
- 内部令牌同时接受 `INTERNAL_TOKEN` 与 `ORCA_CLOUD_INTERNAL_TOKEN`

M10 中继边界：
- SNI 必须命中 `<routeKey><suffix>` 形状（默认后缀 `relay.local`），裸主机名、异后缀、多层子域全部拒绝
- 白名单内但路由不存在 → 黑洞
- 非 TLS 首字节直接断开；单 IP 并发默认 100（测试用 5）
- 记录连接元数据（源 IP、SNI、routeKey、target、结果、原因），不含任何负载或凭证
- 说明：中继是 TLS 透传，**看不到也固定不了主机证书**；主机身份固定由客户端 TOFU 完成，中继只保证「只转发到已注册目标」

## 第 6 轮评审修复（终审 REJECTED → 3 MAJOR 已闭环）

- N1 策略覆盖值未校验：`{"proj_payment":123}` 被当成「非 deny」放行导出 → `parsePolicy()` 逐项校验，非法整份丢弃
- N2 撤销不关闭已建连接（AC-25）：Runtime 每秒对活动连接复查撤销快照，命中 `close(4403)` + 1 秒后 `terminate()`；实测吊销后 4.2 秒断开
- N3 超时不中止底层请求（M2 残留）：`mtlsFetch` 支持 `AbortSignal`，Runtime/中继改 `AbortSignal.timeout()` 并加单飞；实测 active 9 → ≤4，中继启动不再被首次同步阻塞
- N4 畸形 200 刷新新鲜度：仅接受合法策略时更新 `policyFreshAt`
- N5 E8a 曾指向已停机的 API（修复前也能通过）→ 重写为自包含真实会话用例
- N6/M8：配置 mTLS 后公网监听不再暴露 `/v1/internal/*`；平台同时接受 `INTERNAL_TOKEN`
- N8：撤销集合按目标去重；删除死代码 `usedJtis`
- 修复前/后对照：4 条新老用例在 stash 回退源码后实跑变红，恢复后全绿（详见 `reviews/design-review-06.md` §3）

## 阻塞

无。

## M13 真实 Orca Runtime 升级期准入（本轮）

在 Orca 主进程接入，而不是把替身逻辑搬过去：

- `src/main/cloud-platform/cloud-credential.ts`：Ed25519 验签（仅 `node:crypto`，可被平台测试进程导入）
- `src/main/cloud-platform/cloud-upgrade-admission.ts`：读 `Sec-WebSocket-Protocol` 的 `orca-cred.<token>` 与 `x-orca-device-pubkey`，校验主机绑定、撤销集合、设备公钥；拒绝时返回 `401` + `x-orca-reject`
- `WebSocketTransport` 新增可选 `upgradeAdmission`，经 `verifyClient` 在握手前执行（未传时行为与之前完全一致）
- `OrcaRuntimeRpcServer({ upgradeAdmission })` 透传，`orca serve` 后续接线只差取 JWKS 与撤销快照
- 平台与主机两份验签实现的**一致性测试**（`cloud-platform/test/cloud-admission-parity.test.ts`）覆盖合法/过期/篡改/未知 kid/结构损坏/未来签发

实测：真实服务端 + 真实 WS + 真实 Ed25519，8 条升级用例全过。

## M14 开发机侧云端接入（本轮）

- `src/main/cloud-platform/cloud-agent-client.ts`：10 秒轮询 `/v1/jwks` 与 `/v1/internal/revocations`，单飞 + 3 秒超时；响应结构非法时保留上一份，不清空
- `src/main/startup/cloud-runtime-admission.ts`：`ORCA_CLOUD_API_URL` 存在才启用云模式；缺 `INTERNAL_TOKEN`/`HOST_ID`/`HOST_NAME` 时**抛错拒绝启动**，不静默跳过准入
- `main-process-runtime-launch.ts`：把准入作为 `upgradeAdmission` 注入 `OrcaRuntimeRpcServer`；无 env 时展开为空对象，配对模式行为不变
- 顺带把 E2E WS 端口解析抽到 `e2e-runtime-ws-port.ts`（该文件已到 max-lines 上限，规则禁止禁用）

实测（真实平台子进程 + 真实 `OrcaRuntimeRpcServer` + 真实 Ed25519）：
- 从平台拉到 JWKS/撤销快照
- 平台 `/connect` 签发的凭证在真实 Runtime 升级成功
- 凭证换设备头 → 401 `device_mismatch`
- 吊销设备 → 下一轮轮询拿到 `device_revoked`，旧凭证升级 401

已知与本轮无关的既有失败：`src/main/startup` 有 5 条测试在改动前即失败（Electron 拷贝/资源类用例，环境相关），stash 对照确认非本轮引入。

## M15/M16（本轮）

**M15 真实 Runtime 的云端会话撤销**
- `DeviceRegistry.adoptCloudDevice()`：准入时用凭证里的 `deviceId`/`deviceToken` 登记，E2EE 握手才能通过（此前云端凭证过了升级闸门仍会卡在 `e2ee_auth`）
- `MobileSocketWiring.closeDeviceConnections()` + `WebSocketTransport.closeClientConnections()`：发 4403 关闭帧，1 秒未完成握手则 terminate
- `OrcaRuntimeRpcServer.closeCloudDeviceSessions(tokens)`：云端 Agent 轮询到撤销时调用
- 实测：真实平台进程 + 真实 E2EE 握手，吊销后 4403；未吊销的会话不受影响

**M16 评审 07 的 F1/F2**
- F1：三路控制面请求改 `Promise.allSettled`，每请求独立 `AbortSignal.timeout`（共享 signal 会在单端点挂起时连带中止健康响应）；`closeRevokedSessions()` 移出 try；首轮轮询不再阻塞 listen
- F2：撤销体结构非法（`{}`、字段类型错、单条畸形）一律返回 null 并保留上一份快照——此前会被当作「无撤销」覆盖，等于重新放行已吊销凭证
- 同类问题在主机侧 `cloud-agent-client.ts` 一并修复；JWKS 失败改为记录 `lastError` 而不是抛出，避免跳过撤销处理

## M17 评审 07 遗留用例（本轮）

评审 07 的 F7：四个已修行为缺少能失败的用例。

| 用例 | 断言 | 回退后 |
|---|---|---|
| 公网监听对 `/v1/internal/*` 404（mTLS 已配置） | 三条路由 × 三种令牌全部 404；`relay-endpoint` 仍可用真实令牌 200、错误令牌 401 | 改判定为 `false` → 变红 |
| 非默认 `INTERNAL_TOKEN` | mTLS + 非默认令牌 200；默认测试令牌 401 | — （实现已支持，此前无用例） |
| TLS 控制面挂起中止 | 真实 HTTPS 服务端，3.5 秒后 total≥3 且 active≤4 | 移除 abort 监听 → 变红 |
| allow 策略正向 | 项目策略 allow + 组授权含 `download` → `files.download` 返回 `NOT_IMPLEMENTED`（说明已过授权） | 让 exportClass 无条件拒绝 → 变红 |

F7-d 顺带确认了一条容易漏的语义：**allow 需要策略与授权两半都在**。仅把全局策略改 allow 仍会得到 `PERMISSION_MISSING`，因为种子授权里没有 `download`；显式项目策略又优先于全局默认，所以测试同时改项目策略与组授权。

## M18 开发机自注册与心跳（本轮）

此前开发机的身份（hostId/hostName）由 env 硬塞，平台侧不知道自己有这台机器，`/v1/hosts` 里看不到它。

- `cloud-host-enrollment.ts`：`POST /v1/hosts/register` 用一次性令牌换 `{hostId, credential}`；凭证写入 `orca-cloud-host.json`（`writeSecureJsonFile` + 加固权限）
- `cloud-agent-client.ts`：新增 `heartbeat` 模式，撤销/策略/维护态改由 `POST /v1/hosts/{id}/heartbeat` 下发；未配置时保持 M14 的内部路由轮询
- `cloud-runtime-admission.ts`：`ORCA_CLOUD_HOST_TOKEN` 存在即进入注册模式；注册完成前**拒绝所有升级**（`x-orca-reject: not_enrolled`），不会出现"没注册却照常服务"的窗口
- 两种模式共用同一套设备收养逻辑（`withDeviceAdoption`），否则校验通过后仍会卡在 `e2ee_auth`

实测（真实平台进程 + 真实 Runtime + 真实 E2EE 握手）：
- 注册后平台 `/v1/hosts` 显示该机在线，hostId 由平台分配（测试全程不读 env）
- 重启时复用持久化凭证，即使再给一个已消费的令牌也能起来
- 平台为这台机签发凭证 → 它自己的 Runtime 完成 E2EE 握手
- 吊销设备 → 心跳带回撤销 → 已建会话 4403
- 维护开关 → 心跳 `maintenance.reason` 可见

### 心跳上报真实地址（本轮补充）

注册时还没有监听，所以那一刻上报的地址只能是配置值。心跳改为每次实时解析：

- `advertisedAddrs(endpoint, advertiseHost, extras)`：取 Runtime 实际绑定的端口拼成 `host:port`
- 回环绑定（`127.0.0.1` / `::1` / `localhost`）在未配置 `ORCA_CLOUD_ADVERTISE_HOST` 时**返回空**——报一个别处拨不通的地址，客户端只会在连接时才发现，不如让它走中继
- `ORCA_CLOUD_ADVERTISE_HOST` 用于 NAT / 容器 / 反向代理后声明对客户端可见的主机名

实测：平台侧 `directAddrs` 等于 Runtime 的真实端口（不是 6768，也不是注册时的空值）。

## M19 桌面端云端连接客户端（本轮）

主进程侧的连接栈，是客户端补丁层的地基：

- `cloud-connect-client.ts`：`login` → `listProjects` → `requestTicket` → **无凭证 TCP 预检**（失败不消耗一次性凭证）→ 升级 → E2EE 握手 → 加密 RPC
- `chooseRoute()`：直连按优先级最多试 2 个，全部不通才试中继；直连能通时中继不会被选
- 主机侧新增真实 WSS：`OrcaRuntimeRpcServer({ webSocketTls })` 透传到 `WebSocketTransport`，端点格式随之变成 `wss://`

**过程中发现两个真实缺陷**：

1. **客户端没有主机公钥就无法建 E2EE**。注册发生在 Runtime 启动前，平台存的 `e2eePublicKey` 是空串；客户端用空 key 派生共享密钥会抛 `bad public key size`，而且是在 ws 的 message 监听里抛——表现为测试超时而不是报错。修法是心跳上报 `e2eePublicKeyB64`（平台接收并更新），客户端对长度非 32 的 key 显式拒绝（`HOST_KEY_INVALID`）。
2. `sessions.whoami` 是模拟器的方法，真实 Runtime 没有；用例改用真实方法 `status.get`，否则"加密通道打通"会被一个 method_not_found 掩盖成通过。

实测（真实平台进程 + 真实 TLS Runtime + 真实 E2EE）：登录/列表/直连打开/加密 RPC 全通；无权项目 404 且不出现在列表；选路纯函数覆盖直连优先、回落、全不可达；吊销后已建加密会话 4403。

## M20 渲染进程 IPC 会话面（本轮）

渲染进程不接触平台：token、设备密钥、WSS 都在主进程。

| 层 | 内容 |
|---|---|
| `shared/cloud-platform-ipc.ts` | 通道名 + 渲染进程可见的类型（无 token 字段） |
| `main/cloud-platform/cloud-session-service.ts` | 登录/登出/列表/打开/RPC，持有 `CloudConnectClient`；连接关闭时清空当前项目 |
| `main/ipc/cloud-platform.ts` | 六个 `ipcMain.handle` + 关闭事件广播；`installCloudPlatformIpc()` 在无 `ORCA_CLOUD_API_URL` 时返回 null |
| `preload/api/cloud-platform-*.ts` | `window.api.cloud.*`，订阅返回取消函数 |

**刻意约束**：`getState()`/`login()` 的返回值里没有 token、devicePubKey、deviceToken、credential——用例直接对序列化结果断言这些字段与 `eyJ` 前缀都不出���，防止以后有人"顺手"把凭证塞进 UI 状态。

实测（真实平台进程 + 真实 TLS Runtime）：
- 登录后状态只含展示名与项目摘要
- 项目列表区分下载受限（同用户下授权含/不含 `download` 各一）
- 打开项目返回选路与 workspaceRoot，加密 RPC 通
- 吊销后推送 `closeCode: 4403` 事件并清空 `connectedProjectId`
- 登出后 RPC 返回 `NOT_SIGNED_IN`

## M21 客户端界面（本轮）

| 文件 | 内容 |
|---|---|
| `renderer/src/cloud/use-cloud-session.ts` | 会话 hook：加载/不可用/未登录/登录中/已登录；宿主关闭连接时清空已打开项目 |
| `renderer/src/cloud/cloud-login-panel.tsx` | 域账号登录；平台错误码 → 中文文案，未知码原样显示 |
| `renderer/src/cloud/cloud-workbench.tsx` | 工作台：项目列表、线路徽标、主机离线禁开、下载受限标注、吊销提示 |
| `renderer/src/cloud/cloud-mode-gate.tsx` | 有 `window.api.cloud` 才切换到云端工作台，否则原样渲染本地 shell |
| `App.tsx` | 用 `CloudModeGate` 包住工作区与根浮层 |

全部使用 `components/ui` 原语与语义 token，无新增颜色；滚动容器按 lint 要求带 `scrollbar-sleek`。

**测试说明（如实记录）**：界面用例使用**脚本化 bridge**，因为 happy-dom 阻止跨源 fetch 到真实平台进程（实测报 `Cross-Origin Request Blocked`）。真实链路（平台进程 + TLS 运行时 + E2EE 套接字）由 M19 `cloud-connect-client.test.ts` 与 M20 `cloud-session-service.test.ts` 覆盖，本模块只保证"用户看到什么"。迁移过程中还修了两处测试自身问题：`import.meta.url` 在 web 变换下是 `/@fs/...`（需剥离），以及 vitest globals 关闭时 RTL 不会自动 cleanup（需显式 `afterEach(cleanup)`）。

实测 8 条：不可用态不显示登录表单；错误码文案与未知码回退；列表标注（离线 1 条、下载受限 2 条）；打开后显示"直连"；打开失败显示错误码且无"已打开"；4403 关闭显示"已被管理员收回"并清除线路；退出登录回到登录页。回归：`app-shell` 89 条全过。

## 下一步

1. 项目视图：打开项目后进入 Orca 工作区（把云端连接接到现有 TabGroup/终端），而不是停留在工作台。
2. 平台在授权变更后立即撤销全部项目凭证，同秒内重连可能被拒（`iat*1000 <= since`）；客户端重试可绕过，但值得确认是否需要秒级宽限。
3. 遗留：M1 设备 PoP、M6 `relativePath` 契约、`jwks_stale` 与分支名 `..` 补用例。
