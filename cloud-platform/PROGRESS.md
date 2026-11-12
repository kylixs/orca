# 开发进度

> 更新时间：2026-11-13 13:55
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
| M22 项目链接（凭证 → Orca 配对） | ✅ 完成 | `evidence/m22-project-link/` | 云端票据转成现有 `PairingOffer` + `cloudUpgrade`，现有 `subscribeRemoteRuntimeRequest` 直接建链（请求与订阅两条通道）；5 条真实平台 + 真实 TLS Runtime 用例，含"不带凭证必被拒"对照 |
| M23 质量门禁清理 | ✅ 完成 | `evidence/m23-quality-gate/` | 74 条 `consistent-type-assertions` → 0；JSON 字段读取器 + 票据/项目解析器；门禁 7 项扫描 0 新发现，79 条用例回归全过 |
| M24 项目工作区视图 | ✅ 完成 | `evidence/m24-project-workspace/` | 打开项目进入工作区（线路/根目录/能力/实时 status.get）；返回工作台只关连接可再开；21 条用例 + 78 条回归 + 门禁绿 |
| M25 云端项目 → 运行时环境 | ✅ 完成 | `evidence/m25-cloud-environment/` | 项目注册为环境（侧车 cloudProject），现有 selector/RPC/订阅直达；每次连接重签票据；顺带修复主机侧票据重放缺陷；7 条真实端到端 + 81 条回归 + 门禁绿 |
| M26 撤销时间语义 | ✅ 完成 | `evidence/m26-revocation-precision/` | 凭证新增 `iatMs`，消除同秒"收回→重授权"误拒；旧版无 `iatMs` 保持秒级比较；4 条真实平台 + 真实签名用例（修复前用例 2 为红） |
| M27 主机侧公钥过期 | ✅ 完成 | `evidence/m27-jwks-staleness/` | 真实主机新增 `jwks_stale`：超过 TTL 未成功拉取 JWKS 即拒绝新连接；吊销原因优先；3 条真实平台 + 真实 Ed25519 用例（回退后 2 条变红） |
| M28 设备公钥持有证明 | ✅ 完成 | `evidence/m28-device-pop/` | 主机把票据设备公钥登记并在 E2EE 认证时比对握手公钥，票据不再等于持有证明；拒绝原因透传；3 条真实端到端（关掉检查后负例变红） |
| M29 文件寻址契约对齐 | ✅ 完成 | `evidence/m29-file-contract/` | 模拟器改为真实 Orca 的 `worktree + relativePath`（旧 `path` 明确拒绝）；新增 readDir；分支名 `///` ��陷修复；6 条新用例 + 整仓 80 条全过 |
| M30 项目根路径规范化 | ✅ 完成 | `evidence/m30-project-root/` | 登记处拒绝 `..`/相对/重复或尾随分隔符/控制字符；主机对旧平台票据做同形状复核（`workspace_root_invalid`）；4 条真实平台 + 真实签名用例（关掉检查后 2 条变红） |
| M31 审计链落盘与校验 | ✅ 完成 | `evidence/m31-audit-verify/` | 审计 JSONL 只追加落盘、重启续链；`GET /v1/audit/verify`（409 + brokenAtSeq）；弃坏行拒绝启动；14 条（含"改写文件后重启"真实进程用例） |
| M32 审计 fail-closed | ✅ 完成 | `evidence/m32-audit-fail-closed/` | 先写审计再改状态；写失败/断链时 6 类敏感写返回 503 且状态未变；读与登录保持可用；`GET /v1/audit/status`；3 条真实进程用例（chmod 只读、篡改后重启、全覆盖） |

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

M22（本轮）：

```
npx vitest run src/main/cloud-platform/cloud-project-link.test.ts     5 pass / 0 fail
npx vitest run --config config/vitest.config.ts \
  cloud-session-service / use-cloud-session / connect-bound 回归        24 pass / 0 fail
npx tsc --noEmit -p config/tsconfig.node.json --composite false       通过（0 错）
npx tsc --noEmit -p config/tsconfig.web.json  --composite false       通过（0 错）
npx oxlint <改动文件>                                                  0 错
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

## M22 项目链接：云端票据 → Orca 配对（本轮）

| 文件 | 内容 |
|---|---|
| `src/shared/remote-runtime-subscription-contract.ts` | 新增可选 `cloudUpgrade { credential, devicePubKey, servername?, tlsRejectUnauthorized? }`；缺省即普通配对主机，行为不变 |
| `src/shared/remote-runtime-upgrade-socket.ts` | 从会话传输中抽出开套接字：有 `cloudUpgrade` 时在升级子协议带 `orca-cred.<ticket>`、请求头带 `x-orca-device-pubkey`，并按线路设置 SNI / 证书校验 |
| `src/shared/remote-runtime-subscription-transport.ts` | 改用上面的开套接字函数；其余握手/心跳/清理逻辑不变（回归 62 条） |
| `src/main/cloud-platform/cloud-pairing-offer.ts` | 票据 → `PairingOffer` + `cloudUpgrade`；主机未上报 32 字节 E2EE 公钥时返回 `null`，避免把"握手超时"当失败 |
| `src/main/cloud-platform/cloud-connect-client.ts` / `cloud-session-service.ts` | `prepareProjectLink()`：只探测线路并取票，**不开连接、不消耗一次性票据** |
| `src/shared/cloud-platform-ipc.ts` + preload | `cloud:prepareProjectLink` 通道，返回值不含平台令牌 |
| `src/main/cloud-platform/cloud-route-selection.ts` | 抽出 `probeEndpoint` / `chooseRoute`（满足 300 行上限，未禁用规则） |

**为什么这么做**：工作区的终端、文件、流式通道都走同一套 `subscribeRemoteRuntimeRequest`。把云端票据表达成它已有的 `PairingOffer`（+ 一个可选升级参数），就不用再造一个并行客户端，M19 的 `CloudConnectClient` 只保留"预处理/选路/取票"的职责。

**端到端验证（真实平台进程 + 真实 TLS Runtime + 真实 Ed25519/NaCl）**：5 条全部通过，见 `evidence/m22-project-link/cases.txt`：

1. 预处理返回 `wss://` 链接与 `workspaceRoot`，且 `connectedProjectId` 仍为 null（票据未被消耗）。
2. 现有客户端带 `cloudUpgrade` 完成 E2EE 握手，收到真实 `status.get` 响应（`result`）。
3. 订阅通道（终端/流式所用）同样可建立。
4. **不带** `cloudUpgrade` 时主机拒绝升级——证明通过的第 2、3 条不是空转。
5. 主机缺 E2EE 公钥时立即返回 null，而不是等 30 秒超时。

回归：`cloud-session-service`、`use-cloud-session`、传输连接绑定 共 24 条通过；`tsc` node/web 均 0 错；oxlint 0 错（`evidence/m22-project-link/regressions.txt`、`checks.txt`）。

**质量门禁**：本轮修掉设计系统 1 条（`Badge` 上多余的 `text-muted-foreground`），并把 `cloud-platform/` 加入根门禁排除前缀（与 `PLAN.md` §0 一致）。当时仍有 74 条 `consistent-type-assertions`，已在 M23 全部清掉。

**如实记录**：渲染进程用 node 项目配置直接跑 `use-cloud-session.test.tsx` 会因 `@/` 别名未注册而失败（`Failed to resolve import "@/components/ui/button"`），必须带 `--config config/vitest.config.ts`；这不是代码问题，已按正确配置复跑通过。

## M23 质量门禁清理（本轮）

**问题**：M22 结束时 `check:code-quality:changed` 有 74 条 `typescript/consistent-type-assertions`，全部在 `src/main/cloud-platform/**` 与 `src/renderer/src/cloud/**`。多数是 `(await res.json()) as {...}`：形状错了不会报错，只会让 `undefined` 沿调用链传播。

| 文件 | 内容 |
|---|---|
| `src/shared/json-fields.ts`（新） | `readField/readString/readNumber/readArray/readStringArray/readObjectValue/ownEntries/errorCodeOf/parseJsonText`；形状不符返回 null，由调用方决定失败语义 |
| `src/main/cloud-platform/cloud-connect-response.ts`（新） | 票据/项目/端点/workspace 逐字段解析；缺字段返回 null |
| `src/shared/cloud-project-link-offer.ts`（新） | IPC 载荷 → `PairingOffer` 的结构化转换（`v===2 && scope==='runtime'` 才返回），M24 可直接复用 |
| `src/shared/http-header-text.ts`（新） | `x-orca-reject` 等响应头统一取文本 |
| `cloud-connect-client.ts` | 登录/列表/票据/握手消息全部走解析器；解析失败抛明确错误 |
| `cloud-agent-client.ts` / `cloud-agent-revocations.ts` | JWKS 与撤销快照改字段读取，撤销结构非法仍返回 null（保留 fail-closed） |
| `cloud-host-enrollment.ts` / `cloud-credential.ts` / `cloud-pairing-offer.ts` / `cloud-session-service.ts` | 同上一并替换；`cloud-session-service` 新增只读 `currentDeviceId`（只暴露标识，不含令牌） |
| `src/main/ipc/cloud-platform.ts` | Electron 参数边界保留 1 处 line-specific disable，带 SAFETY 说明 |
| 测试（6 个 cloud-platform 文件 + renderer hook） | 响应改读字段；吊销改用同一用户另行登录的令牌；不再访问私有 `session.client` / `client.accessToken` |

**结果（证据 `evidence/m23-quality-gate/`）**：

- `gate.txt`：`check:code-quality:changed` 7 项扫描全部 **0 new finding**，`Changed-code quality gate passed`（220 个改动文件）；`tsc` node/web 均 exit=0。
- `cases.txt`：10 个文件 **79 条** 全过——6 个 cloud-platform 用例文件仍是真实平台进程 + 真实 TLS Runtime + 真实 Ed25519/NaCl（撤销 4403、令牌不外泄、项目链接 5 条），runtime 准入 8 条，renderer happy-dom 8 条，门禁脚本自身 32 条。
- `regressions.txt`：shared 传输/配对回归 44 条全过。

**行为等价性**：替换都是"先读字段、再判空"；失败路径从 `undefined` 静默传播变为显式错误，正常路径字段与类型不变。

## M24 项目工作区视图（本轮）

**问题**：M21 打开项目后界面停在列表；M22 打通链路但用户看不到"进了工作区"。

| 文件 | 内容 |
|---|---|
| `renderer/src/cloud/cloud-project-workspace.tsx`（新） | 工作区：项目名、线路徽标、下载受限、工作区根目录、开发机能力、实时运行时状态（`status.get`）、刷新、返回工作台 |
| `renderer/src/cloud/cloud-app.tsx` | 有已打开项目 → 工作区；否则 → 工作台 |
| `renderer/src/cloud/use-cloud-session.ts` | 新增 `opened{projectId,workspaceRoot,capabilities,route}` 与 `closeProject()`；4403/登出/返回都会清空 |
| `shared/cloud-platform-ipc.ts` + preload + main ipc | 新增 `cloud:closeProject` |
| `main/cloud-platform/cloud-session-service.ts` | `closeProject()` 只关连接，保留令牌与设备密钥；再次打开同一项目无需重新登录 |

**端到端验证（`evidence/m24-project-workspace/`）**：

- `cases.txt` 21 条：界面 10 条（进入工作区显示根目录/能力/`已连接 · rt-1`、检查失败显示 `NOT_CONNECTED`、返回工作台调用 `closeProject`、吊销后回列表并提示）；真实平台进程 + 真实 TLS Runtime 会话 6 条（新增"返回工作台只关连接：会话仍在，可再次打开且 RPC 仍通"）；M22 项目链接 5 条。
- `regressions.txt` 9 个文件 78 条全过。
- `gate.txt`：7 项扫描 0 新发现、gate passed（221 文件）；tsc node/web exit=0。

**如实说明**：界面用例用脚本化 bridge（happy-dom 跨源限制），真实链路由同批真实进程用例覆盖；运行时 id 仅在主机上报时显示，否则只显示"已连接"；终端/文件面板尚未嵌入，界面文案已明确写出来。

## M25 云端项目 → 运行时环境（本轮）

**问题**：终端、文件、流式通道都按"环境 id"访问开发机，而 M24 到工作台为止，云端项目还没有身份。

| 文件 | 内容 |
|---|---|
| `shared/runtime-environments.ts` / `runtime-environment-sidecar.ts` | `cloudProject` 字段走侧车（`orca-environments.json` 保持旧版本可读） |
| `main/cloud-platform/cloud-runtime-environment.ts`（新） | 注册/移除环境；`callCloudRuntimeProject` / `subscribeCloudRuntimeEnvironment` 每次连接经 `prepareProjectLink` **重签一次性票据** |
| `main/cloud-platform/cloud-runtime-session.ts`（新） | 当前平台会话出口（传输层无 IPC 上下文） |
| `main/ipc/runtime-environment-transport-routing.ts` | `cloudProject` 环境走云端专用路径，**跳过**共享控制/缓存连接（否则会绕过票据） |
| `main/ipc/cloud-platform.ts` | 新通道 `cloud:openWorkspace`（打开 + 注册，返回 `environmentId`）；关闭时移除 |
| `shared/remote-runtime-request-socket.ts` | 一次性请求支持 `cloudUpgrade`，复用 `openRemoteRuntimeSocket` |

**顺带修复的真实缺陷**：测试"同一张票据只能握手一次"最初**失败**——真实主机只登记 jti 从不拒绝重放，被复制的票据在有效期内可重复建链。已加 jti 重放缓存（到期清理、吊销优先），并把 `401 + x-orca-reject` 透传为 `upgrade rejected (401, replayed)`；此前用户只能看到"连接失败"。

**验证（`evidence/m25-cloud-environment/`）**：7 条新增真实端到端（真实平台进程 + 真实 TLS Runtime + Ed25519/NaCl）：环境落盘带标记、连续两次 RPC 成功、无会话 `NOT_SIGNED_IN`、设备吊销 `SESSION_EXPIRED`、授权收回后 `PROJECT_NOT_FOUND`、票据重放被拒、移除后不可解析。回归 12 个文件 **81 条**全过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M26 撤销时间语义（本轮）

**问题**（此前列为待确认）：凭证 `iat` 是整秒、撤销 `since` 是毫秒，比较为 `iat*1000 <= since`。管理员在同一秒内"收回→重新授权"后，新票与旧票同秒，被当成旧票拒绝，用户被多锁最多 1 秒。

**做法（不放宽 fail-closed）**：凭证载荷新增可选 `iatMs`（毫秒），平台签发时写入；主机准入用 `iatMs ?? iat*1000` 比较。旧版不签 `iatMs` 时行为完全不变；模拟器 runtime 的 policy-gateway 同步。

**验证（`evidence/m26-revocation-precision/`）**：4 条真实平台进程 + 真实 Ed25519 用例：

1. 撤销前签发的票据，撤销后被拒（`project_revoked`）——撤销立即生效不受影响。
2. 同一秒内收回→重新授权，新票据被接受。**该用例先跑红**（`expected {ok:true}` / `received {ok:false}`）才改代码。
3. 旧版无 `iatMs` 的票据仍按秒级比较（同秒内被拒）——向后兼容。
4. 授权收回期间平台拒绝签发新票（`PROJECT_NOT_FOUND`）。

平台自身契约 + M11 撤销 e2e 28 条通过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M27 主机侧签名公钥过期（本轮）

**问题**：设计文档与模拟器都有 `jwks_stale`，**真实 Orca 主机没有**。主机只在启动时拉一次 `/v1/jwks`，平台长期不可达时仍用旧公钥验票，平台轮换掉的密钥在主机上永久有效。

| 改动 | 内容 |
|---|---|
| `cloud-upgrade-admission.ts` | 新增 `keysFetchedAt` / `keysTtlMs`（默认 5 分钟）；超窗返回 `jwks_stale` + `x-orca-reject` |
| `cloud-agent-client.ts` | 只在**成功**拉取 JWKS 时记录时间戳；新增可注入 `now` / `keysTtlMs`（测边界用） |

顺序上吊销优先：被撤销的连接仍报 `project_revoked`，不给用户看"公钥过期"。

**验证（`evidence/m27-jwks-staleness/`）**：3 条真实平台进程 + 真实 Ed25519 票据——TTL 内放行/超窗拒绝/刷新恢复、刷新失败不延长新鲜度、吊销原因优先。**把修复注释掉后用例 1、2 变红**（2 failed / 1 passed），恢复后转绿。回归 11 个文件 61 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M28 设备公钥持有证明（本轮）

**问题**（评审 05/06 的 M1 遗留）：票据带 `devicePubKey`，客户端只需在升级头里复述它；主机只比对「头 == 票据」，任何拿到票据的人都能过升级检查——票据是持票证明，不是设备持有证明。

| 改动 | 内容 |
|---|---|
| `runtime/device-registry.ts` | 云设备登记保存票据公钥 `publicKeyB64` |
| `startup/cloud-runtime-admission.ts` | 准入通过后把 `devicePubKey` 交给 `adoptCloudDevice` |
| `runtime/rpc/e2ee-channel.ts` | 认证成功且设备登记了公钥时，比对握手公钥；不一致 → `e2ee_error(device_proof_failed)` + close 4001 |
| `shared/remote-runtime-*-contract/transport/socket` | 新增 `clientKeyPair`，握手使用设备密钥；一次性请求同样支持 |
| `cloud-session-service` / `cloud-connect-client` | `deviceKeyPair()`（仅主进程，不经 IPC） |
| `shared/remote-runtime-client-handshake.ts` | 解析 `e2ee_error` 的 code 并给出可行动文案 |
| `shared/cloud-platform-ipc.ts` + preload | 删除无效的 `cloud:prepareProjectLink`（renderer 从未调用、无 handler、且会把票据送进渲染进程） |

**验证（`evidence/m28-device-pop/`）**：3 条新增真实端到端（真实平台 + 真实 TLS Runtime）——设备密钥握手成功并拿到真实响应；**换一对密钥被拒且无任何响应**（注释掉检查后该用例变红）；主机确实登记了票据公钥。M22/M25 既有用例现在必须显式携带设备密钥才能通过，即 PoP 已生效。回归 17 个文件 117 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

**如实记录**：全量 `src/main/runtime` 有 17 条既有失败（`agent-launch-*`、`agent-session-conversation-clear-commit`），把本模块改动 stash 后在 HEAD 上同样失败，确认与本轮无关；另有一次并行运行中 `cloud-revocation-precision` 单条抖动，单独与整目录运行均通过。

## M29 文件寻址契约对齐（本轮）

**问题**（评审 05/06 的 M6 遗留）：真实 Orca 用 `{ worktree, relativePath }` 寻址文件，模拟器却接受项目绝对 `path`。按模拟器写的客户端能通过全部评审，接上真实主机后每个文件操作都会失败。

| 改动 | 内容 |
|---|---|
| `apps/runtime/src/file-request-paths.ts`（新） | 只接受真实契约；缺 `relativePath`/只传 `path` → `MISSING_RELATIVE_PATH`；绝对路径/`..` → `PATH_OUTSIDE_ROOT`；未知 worktree → `WORKTREE_NOT_FOUND`；写只允许本人工作区 |
| `policy-gateway.ts` | 授权同样按 `worktree + relativePath` 判定（不再有"先授权后解析"两套规则）；新增 `executeReadDir` |
| `runtime-sim.ts` | 接入解析器；新增 `files.readDir`（真实 `FileTreePath`） |
| 既有 e2e | 全部改用 `worktree + relativePath`（`projectFile`/`workspaceFile` 助手） |

**顺带修的缺陷**：分支名 `///` 清洗成 `---` 后被接受，会造出与任何分支无关的目录；现在要求清洗后必须含字母或数字。

**验证（`evidence/m29-file-contract/`）**：6 条新用例（真实平台进程 + 真实 TLS Runtime + 真实 Ed25519）——真实形状读写、旧形状明确拒绝、绝对/穿越/未知 worktree 拒绝、写边界、符号链接逃逸、分支名非法与幂等回放。整仓 cloud-platform **80 条全过**（含迁移后的 platform.e2e 16 条）。

**如实记录**：迁移后整仓首次运行 `cloud-admission-parity.test.ts` 失败——M23 给 `cloud-credential.ts` 引入 `shared/json-fields` 导入，违背该模块"零依赖、可被平台测试直接导入"的不变量；已收回 5 行 `ownEntries` 并注明原因。该测试此前一直红而未被发现（M23 只跑了 vitest 侧，未跑整仓 `node --test`）。

## M30 项目根路径规范化（本轮）

**问题**（评审 M5 遗留）：`path` 被原样签进票据。`/srv/work/svc/../../etc` 在平台与主机两侧都按 `..` 规范化，凭证实际覆盖 `/srv/etc` 一类没被授权的目录——"以为的路径"与"生效的路径"不一致。

| 改动 | 内容 |
|---|---|
| `packages/contract/src/project-path.ts`（新） | 拒绝相对路径、`.`/`..` 段、重复/尾随分隔符、控制字符、POSIX 混用反斜杠；返回 `PROJECT_PATH_INVALID` |
| `apps/api/src/server.ts` | 登记处校验，拒绝时写 `result: denied` 审计（含原始路径），不创建项目 |
| `src/main/cloud-platform/cloud-upgrade-admission.ts` | 主机对票据 `projectRoot`/`workspaceRoot` 做同形状复核，不符合 → `workspace_root_invalid`（兼容仍会签发旧路径的旧平台） |

**验证（`evidence/m30-project-root/`）**：4 条真实平台进程 + 真实 Ed25519 用例——非法路径 400 且不留项目；合法路径票据 `projectRoot` 逐字节一致；主机拒绝真实签名但根含 `..` 的票据、同签名者合法根放行；被拒登记无残留。**把两处检查分别注释掉后用例 1、3 变红**。整仓 cloud-platform 80 条全过；门禁通过、tsc node/web 0 错。

**如实记录**：首版把 POSIX 前导 `/` 当成空段，合法路径被误拒（用例 2 先红），已修正；控制字符检查原用字符类正则触发 `no-control-regex`，改为按码点判断（未用 disable）。

## M31 审计链落盘与完整性校验（本轮）

**问题**：设计要求"单写入序列 + 哈希链 + WORM"，但审计链只在内存里——重启即归零，无从篡改也无可校验；同时 `AuditChain.verify()` 没有任何出口，运维只能读事件、无法判断是否被改过。

| 改动 | 内容 |
|---|---|
| `apps/api/src/audit-log-file.ts`（新） | 只追加 JSONL；解析失败报 `AUDIT_LOG_CORRUPT`（跳过坏行等于静默截断链） |
| `apps/api/src/audit.ts` | 可选持久化 sink；`restore()` 在服务前回填历史链（seq/tip），重启后 `prevHash` 续接不分叉；`verify()` 报告 `checked`/`tip`/`brokenAtSeq` |
| `apps/api/src/server.ts` | 新增 `GET /v1/audit/verify`：通过 200、断链 **409**、无权限 403；每次校验尝试本身入链。`AUDIT_LOG_PATH` / `AuditConfig.auditLogPath` 启用落盘，未设置时保持纯内存 |

**验证（`evidence/m31-audit-verify/`）**：14 条。进程内 7 条用真实 SHA-256 证明改正文、删事件、只改 hash、改 metadata 都会被检出并定位；真实进程 7 条证明校验入链、权限与拒绝审计、翻页无重复、无令牌不泄露、**重启续链**、**改写日志文件后重启返回 409 且 brokenAtSeq 命中**、**坏行时拒绝启动**。整仓 87 条全过。

**如实记录**：没有用进程内篡改冒充端到端——先补落盘再做"改文件重启"的真实用例。断链时平台仍启动并服务（运维需要排查入口），是否对敏感操作 fail-closed 留待下一轮决定；既有 `contract.test.ts` 的 `deepEqual(verify(), {ok:true})` 已随返回值扩展更新。

## M32 审计 fail-closed（本轮）

**问题**：设计 §13.2 要求"审计写入失败时拒绝该敏感操作"，但实现是先改状态再写审计，写失败只变成 500——**变更已经生效却没有任何记录**；断链也只影响 verify 接口，敏感操作照常执行。

| 改动 | 内容 |
|---|---|
| `apps/api/src/audit.ts` | 健康状态：`write_failed`（瞬时，成功写入后自动清除）/ `chain_broken`（持续到修复并重启）；`appendBestEffort` 供非变更事件 |
| `apps/api/src/server.ts` | **write-ahead audit**：`recordAudit()` 先写事件，失败即 503 且不执行变更；覆盖项目创建/归档、授权、设备吊销、主机令牌、维护、策略 |
| 同上 | 预检只拦 `chain_broken`；`write_failed` 放行以便磁盘恢复后自愈 |
| 同上 | 登录/读取/`/health`/`/v1/jwks` 保持可用；新增 `GET /v1/audit/status` |

**验证（`evidence/m32-audit-fail-closed/`）**：3 条真实进程用例——日志 chmod 0400 后创建项目 503 且**项目确实没建**、chmod 恢复后自动回到 201；篡改日志重启后 503 `AUDIT_CHAIN_BROKEN`、verify 仍 409、用原始日志重启即恢复；一次覆盖 5 类敏感写全部 503 且逐项复核状态未变。整仓 **97 条**全过。

**如实记录**：两版实现都是被测试推翻的——首版只做预检 + 后置审计，实测首次失败是 500 且项目已创建；次版把状态锁死导致永远无法恢复。最终为"先写审计再变更 + write_failed 可自愈"。副作用：崩溃在两步之间会多记一条未生效事件（over-report），已在注释与 summary 中说明。

## 下一步

1. 面板接入：在工作区内用 M25 的 `environmentId` 挂载终端/文件面板（现有环境 selector 已可用，剩余是界面与 TabGroup 状态接线）。
2. 遗留：M4 `isInsideRoot` 对 Windows 段大小写敏感（fail-closed，误拒而非误放；按需放宽）。
