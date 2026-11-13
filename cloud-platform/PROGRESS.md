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
| M29 文件寻址契约对齐 | ✅ 完成 | `evidence/m29-file-contract/` | 模拟器改为真实 Orca 的 `worktree + relativePath`（旧 `path` 明确拒绝）；新增 readDir；分支名 `///` 缺陷修复；6 条新用例 + 整仓 80 条全过 |
| M30 项目根路径规范化 | ✅ 完成 | `evidence/m30-project-root/` | 登记处拒绝 `..`/相对/重复或尾随分隔符/控制字符；主机对旧平台票据做同形状复核（`workspace_root_invalid`）；4 条真实平台 + 真实签名用例（关掉检查后 2 条变红） |
| M31 审计链落盘与校验 | ✅ 完成 | `evidence/m31-audit-verify/` | 审计 JSONL 只追加落盘、重启续链；`GET /v1/audit/verify`（409 + brokenAtSeq）；弃坏行拒绝启动；14 条（含"改写文件后重启"真实进程用例） |
| M32 审计 fail-closed | ✅ 完成 | `evidence/m32-audit-fail-closed/` | 先写审计再改状态；写失败/断链时 6 类敏感写返回 503 且状态未变；读与登录保持可用；`GET /v1/audit/status`；3 条真实进程用例（chmod 只读、篡改后重启、全覆盖） |
| M33 云端会话并发上限 | ✅ 完成 | `evidence/m33-session-limits/` | 每用户每项目 3 路、每主机 32 路，超限 `close(4431)`；按活连接计、关闭即归还；2 条真实端到端（去掉配额检查后全红） |
| M34 云端 RPC 方法级权限 | ✅ 完成 | `evidence/m34-cloud-rpc-scope/` | 票据 `perms` 真正生效：终端/agent/文件读写/浏览器/下载分开判定，未登记方法拒绝；**修复云会话可访问 settings/accounts/pairing 的越权**；4 条真实端到端 + 11 条单测（回退后 4 条全红） |
| M35 下载策略与读取限速 | ✅ 完成 | `evidence/m35-download-policy/` | 主机消费平台策略包：导出 RPC 默认拒绝、项目覆盖优先；文件读取按项目滚动小时记次数与字节，超限 `read_budget_exceeded`；3 条真实端到端 + 8 条单测（关掉检查后 2 条变红） |
| M36 工作区路径边界 | ✅ 完成 | `evidence/m36-workspace-boundary/` | 票据 `projectRoot`/`workspaceRoot` 真正生效：读限项目根、写限本人工作区根，realpath 后校验（符号链接逃逸被拒）；绝对路径与未知 worktree 拒绝；3 条真实端到端 + 10 条单测（关掉检查后 3 条全红） |
| M37 git 操作边界 | ✅ 完成 | `evidence/m37-git-boundary/` | git 读方法限项目根、写方法（stage/commit/push/discard…）限本人工作区根，**共享主仓库对云端只读**；git 文件路径同受边界；4 条真实端到端 + 6 条单测（关掉分类后 3 条变红） |
| M38 worktree 操作边界 | ✅ 完成 | `evidence/m38-worktree-boundary/` | `worktree.create` 对云端拒绝（路径由主机设置推导、无法约束，指向未实现的托管创建）；`worktree.rm`/`forceDeleteBranch` 限本人工作区、`worktree.show` 限项目；无选择器的批量方法与其余 worktree 方法一律拒绝；4 条真实端到端 + 7 条单测（关掉分类后 3 条变红） |
| M39 托管工作区创建 | ✅ 完成 | `evidence/m39-managed-worktree/` | 真实 Runtime 新增 `worktree.createManaged`：调用方显式给根、宿主强制 `nestWorkspaces=false`，路径恰为 `<workspaceRoot>/<name>`；幂等键去重；云端作用域要求仓库属本项目、目标根属本人工作区；仅云构建注册；4 条真实端到端 + 8 条单测（关掉根覆盖后 M39-1 变红，关掉守卫后 4 条全红） |
| M40 打开项目按需建工作区 | ✅ 完成 | `evidence/m40-ensure-workspace/` | `cloud:openWorkspace` 改为「先列本仓库工作区，命中则复用，否则 `createManaged`」；repo 限定的 `worktree.list`/`detectedList` 对云端开放（仓库须属本项目）；打开结果新增 `workspacePath`，工作区视图展示"我的工作区"；3 条真实端到端（含真实 wss + 已注册主机 + 真实客户端类）+ 9 条单测（关掉复用后 M40-2 变红） |

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

**刻意约束**：`getState()`/`login()` 的返回值里没有 token、devicePubKey、deviceToken、credential——用例直接对序列化结果断言这些字段与 `eyJ` 前缀都不出现，防止以后有人"顺手"把凭证塞进 UI 状态。

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

## M33 云端会话并发上限（本轮）

**问题**（设计 §8.4）：要求"每用户每项目最多 3 个会话、每主机最多 32 个连接，超出返回 4431"，但代码里只有与云无关的 128 连接上限；`grep 4431` 在整个 `cloud-platform/` 与 `src/main/` 中零命中。平台不在数据通路上，看不到这些连接，只能在主机侧计数。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-session-limits.ts`（新） | 按 `(user, project)` 与全主机计数；键为票据的 deviceToken（每票唯一），**按活连接计而不是按票据计**——票一次性，会话比票活得久 |
| `cloud-agent-client.ts` | 准入成功时记下票据文本 → `(sub, project, deviceToken)`；`connectionGate.accept()` 在 socket 建立时占用配额，`release()` 在关闭时归还；吊销时同步释放 |
| `runtime/rpc/ws-transport.ts` | 新增可选 `connectionGate`：升级已成功后按 `req.headers` 计数，超限 `ws.close(4431, 'Too many sessions')` 并 1s 后 `terminate()`；`close` 事件归还配额（含握手未完成就断开的连接） |
| `node-websocket-lifecycle.ts` | 抽出通用 `closeNodeWebSocket()`，新增 `rejectNodeWebSocketOverSessionLimit()`（4431） |
| `runtime-rpc-{state,pairing-types,lifecycle}.ts` / `startup/cloud-runtime-admission.ts` | 把 `connectionGate` 像 `upgradeAdmission` 一样贯穿到 transport；enrolled 模式下用委托对象，因为 transport 先于异步注册完成构造 |
| `renderer/cloud/cloud-close-notice.ts`（新） | 4403/4431 给用户可行动的文案（"先关闭其他会话"），两处云视图共用 |

**为什么不在升级前拒绝**：`verifyClient` 的拒绝是 HTTP 401 + `x-orca-reject`，没有 WebSocket close 帧，带不出 4431；而"会话"本来就要等 socket 存在才算数，所以计数点放在 `connection` 事件，超限发 4431 关闭帧——同时解决了"票据被签发但握手没完成"的泄漏问题。

**验证（`evidence/m33-session-limits/`）**：2 条真实端到端（真实平台进程 + 真实 Runtime + 真实 Ed25519 票据 + 真 NaCl 握手）：
- M33-1 用生产接线（默认上限 3）：3 路握手成功 → 第 4 路被 **4431** 关闭 → 关闭 1 路后新会话重新可用；
- M33-2 主机上限（测试把阈值降到 4 以便快速验证，代码路径与生产一致，两个用户各 2 路）：第 5 路 4431，释放一路后恢复。

把 `accept` 改成恒真后两条用例立即变红（计数 0），确认测的是新逻辑。cloud-platform 主机侧 12 个文件 52 条在 Node 下全过；`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现。

**如实记录**：本仓库 `pnpm test` 固定用 Bun 跑，Bun 的 `ws` 客户端对自签名 TLS 握手失败，导致 6 个**既有**的云测试文件（`cloud-device-pop`、`cloud-session-service` 等）在 Bun 下红；`git stash` 后在 HEAD 上复现同样失败，且在 Node 下全部通过，与本轮无关（本轮新用例走 ws:// 明文，两种运行方式都通过）。另外发现 Bun 的 `ws` 会把正在派发的消息重投给派发中新加的 `once` 监听器，握手助手已改为单一持久监听 + 幂等状态机。

## M34 云端 RPC 方法级权限（本轮）

**问题**（设计 §7.3，原 T302）：票据里签了 `perms`，但主机侧从未看过它——`runtime-rpc-websocket-dispatch` 把所有非 mobile 设备一律当 `runtime-paired`，而该作用域自带 `workspace`/`settings-write`/`accounts-admin`/`skills-admin`/`host-admin`。**结果：任何云会话（哪怕只被授予 `open`）都能读写主机设置、列账号、读取配对信息**，这是越权提升，不只是"缺功能"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-rpc-permission.ts`（新） | 方法 → 项目权限：`terminal.*`/`git.*`/`worktree.{create,createManaged,rm}` → `terminal`；`agent*` → `agent`；`files.read*` 等 → `file:read`；`files.write|create|rename|copy|delete|commitUpload` → `file:write`；`browser.*` → `browser`，但导出类（`browser.download|savePage`、`files.download*`、`terminal.exportArtifact`）优先判 `download`；`status.get` 任何已准入会话可用；**未登记 → 拒绝** |
| `runtime/rpc/rpc-caller-scope.ts` | 新增 `RpcCallerScope = { kind: 'cloud'; permissions }`，拒绝文案指明缺哪个项目权限 |
| `runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts` | 有 `cloudSession` 的设备走 `cloud` 作用域，不再落到 `runtime-paired` |
| `runtime/device-registry*.ts` | `DeviceEntry.cloudSession = { projectId, permissions }`；采纳时从票据写入；**落盘读取时逐字段校验，解析失败即丢弃（失去权限）而非保留** |
| `startup/cloud-runtime-admission.ts` | 采纳设备时带上票据的 `project` 与 `perms` |

**验证（`evidence/m34-cloud-rpc-scope/`）**：4 条真实端到端（真实平台进程签发的真实 Ed25519 票据 + 真实 Runtime + 真 NaCl 加密 RPC）：
- M34-1 只授 `file:read` 的项目：`files.read` 通过网关（失败原因是 handler 的未知 worktree，不是 `forbidden`），`files.write`/`terminal.create` 被 `forbidden` 且文案指明缺 `file:write`/`terminal`；
- M34-2 只授 `terminal` 的项目：`terminal.list` 成功，`files.read` 被拒；
- M34-3 `settings.get`、`accounts.list`、`pairing.getEndpoints`、`host.platform` 全部 `forbidden`，`status.get` 仍可用；
- M34-4 同一用户同一主机两张票据各自生效。

另有 11 条映射单测。**把 dispatch 的 cloud 分支去掉后 4 条端到端全部变红**（报 `runtime_unavailable`，因为回落到配对作用域后又被 `files.read` 的 handler 拒绝，正好说明权限来自票据而非别处）。cloud-platform 主机侧 14 文件 67 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 已知取舍**：
1. `files.open`、`files.openDiff` 等面板会用到的方法目前**未登记 → 默认拒绝**。这是设计要求的 deny-by-default 直接后果，接入文件面板时必须逐条登记（届时一并补用例），不能靠"先加上"绕过。
2. 主机现有 `files.*` 方法仍只声明粗粒度 `workspace` 权限；本轮在云端作用域上先做项目级细分，仓库全局的方法权限模型未改动（避免影响非云配对设备）。
3. 本轮顺带发现：`settings.get` 的声明权限是 `workspace`，所以此前云会话确实能读主机设置；现在被云端映射拒绝。

## M35 下载策略与读取限速（本轮）

**问题**（设计 §9 / AC-10、AC-17，原 T304）：平台每次心跳都下发策略包（`policies.downloadDefault`、`projectOverrides`），**主机侧解析心跳时直接把它扔了**；`/v1/internal/policy` 接口存在，但轮询模式的客户端从不调用。结果 §9 的"专用导出 RPC 由主机拒绝"只有 ACL 一层：被授予 `download` 的用户在策略禁止的项目上照样能调 `browser.download`；`files.read` 也完全没有记账限速。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-policies.ts`（新） | 解析策略包：缺 `downloadDefault` 即整包不可用（**不能把"没读懂"当成 allow**）；非法限速回落默认有界值 |
| `cloud-platform/cloud-access-guard.ts`（新） | 项目级滚动小时预算（次数 + 字节）；无策略包时下载关闭、读取仍有界；字节在回复后记账，因此拦住的是**下一次**读取 |
| `cloud-agent-client.ts` | 心跳与 `/v1/internal/policy` 两条通道都解析策略并保留上一份有效包；快照暴露 `policies`/`policyVersion` |
| `rpc-caller-scope.ts` | 云端作用域新增 `downloadAllowed`：**策略优先于票据**——已准入的会话也会立刻受管理员改动约束 |
| `runtime-rpc-websocket-dispatch.ts` | 读方法先扣配额，超限回 `read_budget_exceeded`（含用量），并把回复字节记入预算 |
| `runtime-rpc-{state,pairing}.ts` / `startup/cloud-runtime-admission.ts` | `setCloudAccessGuard` + `installCloudAccessGuard`（生产与测试同一条接线） |
| 平台 `store.ts` / `server.ts` / `policy-rate.ts`（新） | 策略新增 `readRatePerHour` 与项目覆盖；全局 `PUT /v1/policies/download`、项目 `PUT /v1/projects/{id}/policy` 均可设置，非法值 400 `POLICY_INVALID` |

**顺带修的两个真实缺陷**：
1. **全局开关此前是死的**：平台把每个项目的 `downloadPolicy` 都当作覆盖下发，而项目默认 `deny`，所以"全局 allow"对任何项目都不生效。改为只有管理员显式写过策略的项目才作为覆盖下发（`downloadPolicyExplicit`），未动过的项目继承全局默认。
2. **项目策略写入绕过了 M32 的 fail-closed**：项目级 `/policy` 用的是 `audit.append` 而非 write-ahead，审计不可写时仍会改策略。已改为 `auditAllowsMutations` + `recordAudit`。

**验证（`evidence/m35-download-policy/`）**：3 条真实端到端（真实平台进程 + 真实 Ed25519 票据 + 真实 Runtime + 真 NaCl 加密 RPC）：
- M35-1 票据有 `download` 权限但策略默认 deny → `browser.download` 被 `forbidden` 且文案指出是策略；管理员放开全局 → 同一会话立即可通过网关（失败点变成 handler）；再写项目级 deny → 又立刻被策略拒绝；`policy_update` 事件已入审计且链仍通过 verify。
- M35-2 项目限速 3 次/小时：前 3 次 `files.read` 通过网关（失败原因是 handler），第 4 次 `read_budget_exceeded`（`3/3`）；放宽到 50 次后**无需重连**即可继续读。
- M35-3 `calls: 0` 被平台 400 拒绝；`readRatePerHour: null` 清除覆盖并回落到全局预算。

另有 8 条单测（策略解析、deny-by-default、覆盖优先级、滚动窗口、字节记账、项目隔离）。**分别关掉策略判定与配额检查后 M35-1、M35-2 立即变红**。cloud-platform 主机侧 16 文件 78 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：设计 §9.1 的三层里，本轮做实了"主机拒绝专用导出 RPC + 读取记账限速"；**受管客户端隐藏下载入口（UI）与主机 `will-download` 拦截尚未接入**——前者属于后续面板接入，后者需要 host-hosted 浏览器面板落地后才有效；`files.download`/`files.downloadFolder` 在当前 Mainline RPC 中并不存在，映射表先按设计登记，将来新增即自动受约束。

## M36 工作区路径边界（本轮）

**问题**（设计 §8.3 第 4 步 / AC-11 / AC-27，原 T301b、T303）：票据里签了 `projectRoot` 与 `workspaceRoot`，但真实 Runtime 的文件 RPC **完全按客户端给的 `worktree` 选择器解析**——`files.read`/`files.write` 只校验相对路径形状，不校验解析出来的目录在不在项目里。也就是说：任何云会话都能读**主机上任意 worktree**（别的团队的项目、别人未提交的分支），有 `file:write` 的还能往里写。M34 只解决了"能不能调这个方法"，没有解决"能碰哪些文件"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-path-boundary.ts`（新） | 分隔符感知的根包含（`/srv/svc` 不含 `/srv/svc-evil`）+ `realpath` 解析（不存在的新文件按最近已存在祖先解析）；读限 `projectRoot`，写限 `workspaceRoot` |
| `cloud-platform/cloud-path-guard.ts`（新） | 在 handler 之前把 `worktree` 选择器解析成真实目录并校验；`rename`/`copy` 的两条路径都查；绝对路径单独拒绝（`path.join` 会把 `/etc/passwd` 当成相对段） |
| `runtime-rpc-websocket-dispatch.ts` | 云端会话的文件 RPC 先过边界；**仅在票据本身带该权限时**才做路径判定，缺权限的调用仍由权限层给出"needs 'file:write'"的文案 |
| `runtime/orca-runtime-persist-headless-terminal-title.ts` | 新增公开的 `resolveWorktreeRootPath()`，复用既有的选择器/执行主机解析，不另起一套 |
| `runtime/device-registry*.ts` | `cloudSession` 记录 `projectRoot`/`workspaceRoot`；落盘读取时缺根即丢弃整条云会话（无法执行边界的记录不能默认成"哪都能去"） |
| `startup/cloud-runtime-admission.ts` | 采纳设备时带上票据的两个根 |

**验证（`evidence/m36-workspace-boundary/`）**：3 条真实端到端——真实平台进程签发的真实 Ed25519 票据、真实 Runtime、真实 `OrcaRuntimeService` + 真实 SQLite store，store 里**真的注册了两个 git 仓库**（本项目与另一团队的项目），并且用 `git worktree add` 造出真实的工作区：
- M36-1 项目内 `files.read` 成功并拿到真实内容；另一团队的 worktree 被 `forbidden`（`This worktree is outside the project...`）；`../..` 穿越与项目内 `escape` 符号链接（指向另一团队目录）都被拒；
- M36-2 `files.write` 在工作区根内成功；写项目共享目录被 `forbidden`（`Writes are limited to your own workspace root`），**并且重新读取确认共享文件未被改动**；
- M36-3 绝对路径被拒、未知 worktree 选择器被拒（`not available to the cloud session`）。

另有 10 条单测（分隔符感知、真实符号链接、不存在文件的祖先解析、rename 双路径、绝对路径）。**关掉路径判定后 3 条端到端全部变红。** cloud-platform 主机侧 18 文件 91 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录**：
1. 首次跑整仓模拟器测试时出现一次 `unknown_kid`（期望 `device_revoked`），与质量门禁并行运行；单独重跑 97/97 通过，判定为并行负载下的既有抖动，本轮未改动模拟器任何代码。
2. 本轮只覆盖**文件类 RPC**（`files.*`）。`terminal.*`/`git.*` 的 `worktree` 选择器仍只受"M34 权限层"约束，尚未做根包含校验——终端一旦打开就能 `cat` 任意文件，设计 §9.4 已把它列为**不可阻断**、靠出网白名单与命令审计缓解；git 的根包含留待下一轮（需同时确认 `git` 命令本身的工作目录边界）。

## M37 git 操作边界（本轮）

**问题**（设计 §8.3「主仓库目录默认只读」、§7.3 git 随 terminal 授予，原 T303 的 git 部分）：M36 只给 `files.*` 加了路径边界，`git.*` 仍只受 M34 的"方法级"权限约束——票据带 `terminal` 就能对**任意 worktree** 执行 `git.stage`/`git.commit`/`git.discard`。也就是说：任何云用户都能直接在**共享主仓库**上提交或丢弃别人的改动。M36 的备注里已如实写明这块留待本轮。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-git-scope.ts`（新） | git 方法读写分类：19 个只读方法（status/diff/history/branchCompare/commitDiff/generateCommitMessage…）→ `read`；其余（stage/unstage/commit/checkout/discard/fetch/pull/push/rebase/forkSync…）→ `write`；**未登记方法按 write 处理**，新增的写方法不会因漏登记而落到主仓库 |
| `cloud-platform/cloud-path-guard.ts` | 把 git 接入同一套边界；写操作**同时校验目录本身**——`git.commit` 不带任何路径参数，只看相对路径会漏掉"在共享 checkout 上提交"；git 的 `filePath`/`filePaths`/`paths`/`oldPath`/`submodulePath` 同样逐条查越界 |
| `runtime-rpc-websocket-dispatch.ts` | 路径判定覆盖 git（按票据的 `terminal` 权限放行后才判定，缺权限仍由权限层给出文案） |

**验证（`evidence/m37-git-boundary/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 真实 git 仓库与 `git worktree`）：
- M37-1 `git.status` 在本人 worktree 成功、在另一团队仓库被 `forbidden`；
- M37-2 `git.stage`/`git.commit` 指向共享主仓库被拒，且用主机侧 `git rev-parse HEAD` 确认**主仓库 HEAD 未变**；
- M37-3 本人工作区里 `git.stage` + `git.commit` 成功，主机侧 `git log -1` 读到真实提交主题；主仓库仍是 `init`；
- M37-4 `filePath: '../../other-team/README.md'` 被拒，另一团队仓库的 `git status --porcelain` 为空（路径从未到达 git）。

另有 6 条分类单测。**把 git 分类关掉后 M37-1/2/4 变红**（M37-3 仍绿属预期：它只断言"本工作区允许写"，禁用分类后依然允许）。主机侧 20 文件 101 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `git.remoteCommitUrl`/`git.remoteFileUrl` 归为只读，但它们会拼远端 URL，需 `terminal` 权限——本轮不涉及网络出站管控（设计 §9.4 的出网白名单属部署项）。
2. `worktree.create`/`worktree.createManaged`/`worktree.rm` 仍未纳入路径边界（平台票据的 `workspaceRoot` 应约束 createManaged 的目标）。留着下一轮，因为需要同时确认托管创建所用的路径推导。
3. 终端本身仍是"打开后可 `cat` 任意文件"，设计 §9.4 已把它列为不可阻断、靠出网白名单与命令审计缓解，非本轮范围。

## M38 worktree 操作边界（本轮）

**问题**（设计 §8.3 / T301a，M37 备注里留的下一项）：`worktree.*` 仍未纳入 M36/M37 的边界。其中两处是真实逃逸：
- **`worktree.create` 的目标路径不由调用方给出**，而是主机按自己的 `workspaceDir` 推导——云会话可以指定**任意 repo 选择器**（包括别的团队的仓库）让主机在机器上建出 checkout；
- **`worktree.rm` 可以删除主机上任意 worktree**，包括别人正在用的分支和共享主仓库。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-worktree-scope.ts`（新） | `worktree.create` → **明确拒绝**（设计：托管模式必须用 `worktree.createManaged`，而真实 Runtime 尚未实现，因此宁缺勿滥）；`worktree.rm`/`worktree.forceDeleteBranch` → 写（限本人 `workspaceRoot`）；`worktree.show` → 读（限 `projectRoot`）；**其余一律拒绝**（`list`/`detectedList`/`ps` 会枚举全机工作区，`activate`/`sleep`/`set`/`teardownMissingTerminals` 等属主机 UI 面） |
| `cloud-path-guard.ts` | worktree 分类接入同一路径检查；新增 `isCloudPathGuardedMethod()` 供分发层判断"这个方法是否需要过边界" |
| `cloud-rpc-permission.ts` | `worktree.show`/`worktree.forceDeleteBranch` 登记到 `terminal` 权限（仅表示"可被该方法族触达"，具体放行仍由 worktree 分类决定） |
| `runtime-rpc-websocket-dispatch.ts` | 边界判定改用 `isCloudPathGuardedMethod`，让被拒绝的 worktree 方法也能拿到明确文案，而不是落到 `method_not_found` |

**验证（`evidence/m38-worktree-boundary/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 两个真实 git 仓库与 `git worktree`）：
- M38-1 `worktree.create` 被 `forbidden` 且文案指向托管创建；**主机的 `workspaceDir` 下确实为空**（普通创建本会在此落盘）；
- M38-2 `worktree.rm` 目标为另一团队的 worktree 被拒且目录仍在；目标为共享主仓库被拒（`workspace root`）且 `README.md` 仍在；
- M38-3 `worktree.show` 在本人工作区成功、跨项目被拒；
- M38-4 `worktree.list`/`detectedList`/`ps` 全部 `forbidden`。

另有 7 条分类单测。**关掉 worktree 分类后 M38-1/2/3 变红**（M38-4 仍绿属预期：这三个方法根本没登记在云权限映射里，由权限层先拒）。主机侧 22 文件 112 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 本轮是**收紧**而非补齐：真实 Runtime 仍然没有 `worktree.createManaged`，云端用户目前只能打开已存在的工作区。这是设计 §8.3 明确要求的正向路径，**下一轮实现**（需把显式 `workspaceRoot` + `nestWorkspaces=false` 贯穿 `createManagedWorktree` 的路径推导，非托管构建不注册）。
2. `worktree.prefetchCreateBase` 一并被拒：它服务于创建流程，托管创建落地后应随 `createManaged` 一起开放。
3. 终端仍可 `cat` 任意文件（设计 §9.4 已列为不可阻断）。

## M39 托管工作区创建（本轮）

**问题**（设计 §8.3 / T301a）：M38 把 `worktree.create` 对云端关掉了（它按主机自身的 `workspaceDir` 推导路径，无法约束），但设计要求的正向路径 `worktree.createManaged` **在真实 Runtime 里根本不存在**——于是云端用户能连上项目，却无法创建自己的工作区，只能打开已存在的。

| 改动 | 内容 |
|---|---|
| `shared/rpc-contract/worktree-managed-create-params.ts`（新） | `{ repo, workspaceRoot, name, baseBranch, compareBaseRef, branchNameOverride, displayName, idempotencyKey }`；`workspaceRoot` 必须在协议层就是绝对路径 |
| `runtime/rpc/methods/worktree-create-managed.ts`（新） | 新方法 `worktree.createManaged`（`workspace` 权限）：以 `idempotencyKey` 复用既有 `dedupeWorktreeCreate`；**拒绝远程仓库**（票据的工作区根是本地路径，在 SSH checkout 上照做会静默落在别处） |
| `startup/cloud-managed-worktree-methods.ts`（新） | 仅当 `ORCA_CLOUD_API_URL` 存在时把该方法并入方法表——落实设计"非托管构建不注册该方法" |
| `runtime/runtime-managed-worktree-create-types.ts` + `runtime-local-worktree-create.ts` | `workspaceRoot` 显式根：覆盖路径设置的 `workspaceDir` 并强制 `nestWorkspaces=false`，因此 `computeWorktreePath` 与 `ensurePathWithinWorkspace` 都按 `<root>/<name>` 计算 |
| `cloud-worktree-scope.ts` / `cloud-path-guard.ts` | 云端作用域把 `createManaged` 归为写；新增 `checkManagedCreate()`：**仓库必须在本项目内**（否则可把别的团队仓库 checkout 进自己工作区再读），**目标根必须在本人工作区根内**。为此给运行时加了公开的 `resolveRepoRootPath()`（复用既有 `showRepo`，不另起解析） |

**验证（`evidence/m39-managed-worktree/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 真实 git 仓库，主机 `nestWorkspaces` 故意设为 `true`）：
- M39-1 在票据工作区根下创建成功：路径恰为 `<workspaceRoot>/cloud-feature`，**没有多出一层 `<repoName>`**，`git rev-parse --show-toplevel` 指向该路径（是真 worktree 而非拷贝），主机自己的 `workspaceDir` 仍为空；
- M39-2 同一 `idempotencyKey` 重试返回同一 worktree；
- M39-3 目标根写在工作区之外被 `forbidden`，磁盘上没有建出目录；
- M39-4 用另一团队的仓库创建被 `forbidden`（`outside the project`），本人工作区内没有出现该目录。

另有 8 条单测（分类、库/根双重校验、缺字段）。**把显式根覆盖去掉后 M39-1 变红；把 `checkManagedCreate` 关掉后 4 条全部变红**。主机侧 23 文件 117 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 本轮只开放了"创建"；`worktree.prefetchCreateBase`（服务于创建预取）仍对云端拒绝，`worktree.create` 也仍拒绝——托管模式只走 `createManaged` 一条路，避免出现两条语义不同的创建通道。
2. 客户端侧尚未调用它：`cloud-runtime-environment` 打开项目时仍是"打开已有工作区"，把 `createManaged` 接到 `openProject`（按需创建 + 失败码映射）留给面板接入那一轮。
3. 远程（SSH）仓库的托管创建返回 `managed_workspace_remote_unsupported`，未做跨主机路径翻译——一期云主机都是本地/容器路径。

## M40 打开项目时按需创建工作区（本轮）

**问题**（设计 §8.3 第 3 步）：M39 让主机能够创建托管工作区，但**没有任何一端去调用它**——`cloud:openWorkspace` 仍然是"拿到票据就注册环境"，首次打开项目时用户的工作区目录里空无一物，面板拿到的是一个没有 checkout 的路径。设计写的是"连接后先查现有 worktree，存在则直接打开，否则创建"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-workspace-ensure.ts`（新） | `ensureCloudWorkspace()`：`openProject` 建链 → `worktree.list`（repo 限定）→ **只挑落在票据 workspaceRoot 下的那条**（同仓库还有队友的 checkout）→ 没有才 `worktree.createManaged`；创建失败时再列一次（并发打开同一项目的竞态） |
| `cloud-worktree-scope.ts` / `cloud-rpc-permission.ts` | 对云端开放 `worktree.list`/`worktree.detectedList`，但**必须带 repo**；`cloud-path-guard` 新增 `checkRepoScopedRead()`——仓库须在本项目内，否则拒绝（这是 M38"一律拒绝"的精确化，不是放开） |
| `cloud-session-service.ts` | 新增 `ensureWorkspace(projectId)`；成功后设置当前项目 |
| `ipc/cloud-platform.ts` | `cloud:openWorkspace` 改走 ensure；结果返回 `workspacePath` 与真实能力集 |
| `shared/cloud-platform-ipc.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` | `CloudOpenResult.workspacePath` 透传到视图，工作区页新增"我的工作区"一行（首次打开显示"首次打开时创建"） |

**验证（`evidence/m40-ensure-workspace/`）**：3 条真实端到端，且**用的是桌面端真实客户端类 `CloudConnectClient`**——主机以注册模式运行（心跳上报真实端口与 E2EE 公钥），Runtime 用真实自签 TLS 提供 `wss://`，客户端按票据里的地址连接：
- M40-1 首次打开 → 创建工作区，路径恰为 `<workspaceRoot>/main`，`README.md` 存在，`git rev-parse --show-toplevel` 指向该目录；
- M40-2 再次打开 → `created: false`，路径相同，`git worktree list` 仍只有 2 条（主仓库 + 本人），没有就地再造一份；
- M40-3 `worktree.list` 指向他人仓库被 `forbidden`（`outside the project`），不带 repo 的调用也被拒。

另有 9 条单测（含目录读取的 repo 要求与越界）。**把"复用已有工作区"关掉后 M40-2 变红。** 主机侧与渲染侧 25 文件 131 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `files.open`/`files.openDiff` 仍**未登记**（M34 的 deny-by-default），文件面板打开文件前必须先登记它们——这是下一轮面板接入的前置项。
2. 首次打开的创建发生在 `cloud:openWorkspace` 内，**耗时已计入打开时延**（同步等待 worktree 创建）；设计允许后台创建 + 先显示进度，本轮选择了简单实现，压测（T507）时再评估。
3. 客户端拿到的 `workspacePath` 目前只用于展示与后续面板寻址；`cloud-runtime-environment` 注册的侧车仍只带 projectId，尚未把 worktree 路径写进环境元数据。

## M41 文件面板接入：方法登记与路径参数收口（本轮）

**问题**：M36 的路径守卫用 `key.endsWith('relativePath')` 猜哪些参数是路径。这个猜测有真实缺口，而 M40 记录的前置项（`files.open`/`files.openDiff` 未登记）正好会让面板打不开文件。排查后发现两类问题：

1. **漏检**：`files.pathsExist` 的 `relativePaths`（复数批量）、`files.readDocPreview` 的 `entryRelativePath`/`implicitRootRelativePath`/`authorizedRootRelativePaths` 都不是 `…relativePath` 后缀，**整类调用完全没做路径检查**；一个 `file:read` 会话可以借批量存在性检查探测项目外文件是否存在。
2. **无界**：`files.browseServerDir`、`files.readTerminalArtifact`、`files.readTerminalArtifactPreview`、`files.writeTerminalArtifact`、`files.resolveTerminalPath` 只认绝对路径，项目根无法约束它们，却因为"没找到 relativePath"被当作无路径放行。

| 改动 | 内容 |
|---|---|
| `cloud-file-path-params.ts`（新） | 显式方法→参数表 `CLOUD_FILE_PATH_PARAMS`（singular/plural 分开）；`CLOUD_FILE_UNBOUNDED_METHODS`（绝对路径方法，整体拒绝）；`CLOUD_FILE_WORKTREE_ONLY_METHODS`（只寻址 worktree，无文件路径） |
| `cloud-path-guard.ts` | 以 `collectPaths()` 取代后缀猜测；无界方法返回 `path_unbounded`；**任何未在表中声明的 `files.*` 方法返回 `path_unverifiable`**——判断只看方法名，不看它是否已登记权限，所以将来新增的文件 RPC 在登记前也拿不到放行 |
| `cloud-rpc-permission.ts` | `files.open`/`files.openDiff` 登记为 `file:read`（它们只把调用方本来就能读的文件展示出来）；补注释说明终端产物/目录浏览为何仍列出但由路径守卫拒绝 |
| `cloud-rpc-permission.test.ts` | 断言这两个面板动作归 `file:read`；deny-by-default 的示例改用真实未登记的 `agentSessionAttachment.read` |

**验证（`evidence/m41-file-panel/`）**：3 条真实端到端，复用 M36 的真实平台票据 + 真实 Runtime + 真实 git 仓库（含另一个团队的仓库与指向它的符号链接），另给主机装了记录型 `RuntimeNotifier`：
- M41-1 `files.open`/`files.openDiff` 返回 `opened: true`，且主机的窗口确实收到解析后的绝对路径 `<projectRoot>/README.md`——证明守卫放行后真实 `stat` 与开标签动作都执行了；
- M41-2 `files.pathsExist(['README.md','../../other-team/secret.txt'])` 整批被 `forbidden`（`outside the project`），全在项目内的批次正常返回；
- M41-3 `files.browseServerDir` / `files.readTerminalArtifact` 被 `forbidden`，消息指明绝对路径方法不开放。

另有 7 条单测（表的三类互斥、复数批量、doc preview 入口路径、改名目标落点、无界方法、未声明方法、面板动作放行）。**三组负向对照**：删掉 `relativePaths` 字段 → 单测与 M41-2 变红；取消 `files.open` 登记 → M41-1 变红且报 `not available to cloud sessions`；把 `browseServerDir` 移出无界集合 → M41-3 变红。主机侧 25 文件 131 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `files.open` 在主机的**无渲染窗口**模式下返回 `runtime_error: renderer_unavailable`——它要求宿主窗口开标签。云主机（无桌面的容器/服务器）上因此不可用，这是宿主能力限制而非边界漏洞；远端面板应走 `files.read`/`files.readPreview` 由客户端自己渲染，`files.open` 只对 CLI/agent 与带窗口的宿主有意义。
2. 表是人工维护的：新增文件 RPC 时必须同步登记，否则会被 `path_unverifiable` 拒绝。这是有意的 fail-closed，但需要加一条"新增 `files.*` 方法必须进表"的评审清单项。
3. `files.searchPaths` 的 `excludePaths` 已纳入检查，但 `query`/`followSymlinks` 等语义未变——搜索仍可能沿工作区内的符号链接读到项目外内容（取决于 `files.search` 实现是否跟随），列为后续核查项。

## M42 云端文件面板（本轮，T206 第一片）

**问题**：M25/M40 之后云端项目有了 `environmentId` 与真实 checkout，但工作区页只显示连接信息，用户看不到自己工作区里的任何文件。T206「项目视图接入」要挂终端与文件面板；终端需要云端链路上的流式通道（当前 `CloudConnectClient` 只有请求/响应，见剩余项），文件面板则只依赖已就绪的 `files.readDir`/`files.readPreview`（M41 已登记并收口路径），因此本轮先交付文件面板。

| 改动 | 内容 |
|---|---|
| `shared/cloud-file-browser.ts`（新） | 面板的数据层：`browseCloudDirectory` / `previewCloudFile` 走 `files.readDir`/`files.readPreview`，worker 选择器固定为 `path:<workspacePath>`；路径拼接拒绝 `..`、分隔符与空名；目录在前、名称不区分大小写排序；未知/残缺回复报 `malformed_reply`，**不当作空目录**；隐藏 `.git`（worktree 里它是 gitfile 指针） |
| `renderer/cloud/cloud-file-panel.tsx`（新） | 面包屑 + 目录列表 + 文本预览；失败显示主机原因（`forbidden` → 越界/无权限），二进制/图片不按文本渲染；用请求序号丢弃过期目录回复 |
| `shared/cloud-platform-ipc.ts` / `cloud-connect-response.ts` | 票据 `perms` 解析为 `CloudProjectPermission[]`（未知值丢弃）；`CloudOpenResult.permissions` 由**将要被主机校验的那张票据**读出，供 UI 判断能否显示面板 |
| `ipc/cloud-platform.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` / `cloud-app.tsx` | 透传权限；工作区页在 `workspacePath` 存在且票据含 `file:read` 时挂载面板，否则说明原因；`CloudApp` 改为把完整 `rpc(method, params)` 传下去（此前固定只调 `status.get`） |

**验证（`evidence/m42-file-panel/`）**：3 条真实端到端——真实平台进程签票、真实 TLS Runtime、真实 git 仓库与托管 worktree、真实 `CloudConnectClient`，且**直接调用面板自己的数据层函数**：
- M42-1 根目录列出 `src/`（目录在前）与 `logo.bin`、`README.md`；进入 `src/` 列出 `app.ts`；预览内容为主机真实读到的 `# payment service`；
- M42-2 `../../../../other-team` 被拒 `forbidden`（`outside the project`），预览他人仓库文件同样被拒；
- M42-3 管理员收回 `file:read` 后，平台新签票据的 `perms` 不再含它，同一工作区读取被 `forbidden` 且提示缺少 `'file:read'`；结束后恢复授权。

另有 9 条数据层单测（路径拼接/排序/过滤/残缺回复/错误透传）与 3 条面板组件测试（导航、越界提示、二进制不按文本显示）。**负向对照**：把 `files.readDir` 临时放进 `SESSION_METHODS`（绕过 `file:read`）后 M42-2、M42-3 变红——同时暴露了权限表与路径守卫的耦合：`cloudPathAccessOf` 依据 `cloudMethodAccess` 判断读/写，归为 `session` 的方法会连路径检查一起跳过，因此文件方法**不能**登记为 `session`。主机侧 + 渲染侧 + 共享 29 文件 156 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 面板是只读的（列表 + 预览）。写/新建/删除虽已登记为 `file:write`，但 UI 未接；等 M41 的写路径在面板上做完整错误呈现后再开放。
2. 图片预览只显示 MIME，不解码 base64；`files.readPreview` 返回 base64 内容，渲染成 `<img>` 需要内容类型协商（设计 §9 的下载管控也应在此处生效），列入下载策略接入轮次。
3. 终端面板需要云端链路的流式 RPC（PTY 输出推送），`CloudConnectClient` 目前只做请求/响应；这是 T206 剩余的最大一块，也是下一轮候选。

## M43 云端终端：流式订阅传输 + 终端工作区边界（本轮）

**问题**：两件事，缺一不可。

1. **传输**：`CloudConnectClient` 只有请求/响应——每个调用各自 `on('message')` 过滤自己的 id，超时后监听器不摘除（泄漏），且无法接收流式方法的多帧回复。没有它，`terminal.subscribe` 一个事件也到不了客户端。
2. **边界（真实漏洞）**：M34 只按 `terminal` 前缀授权，主机对终端方法**不做任何地址检查**。`terminal.create` 的 `worktree` 由客户端指定，`terminal.send`/`subscribe` 的句柄也是——一个有 terminal 权限的云端用户可以在**共享检出区**或**其他团队仓库**里开 shell 并任意执行命令、读标题/cwd、驱动他人终端。

| 改动 | 内容 |
|---|---|
| `cloud-rpc-multiplexer.ts`（新） | 一个路由器拥有整条已准入 socket：`id → 调用` 的 pending 表、`call()` 一次性回复、`subscribe()` 多帧事件 + `{type:'end'}` 收尾、超时即摘除、socket 关闭时统一以 `CONNECTION_CLOSED` 结束所有在途调用 |
| `cloud-connect-client.ts` | `rpc()` 改走多路复用器（修复超时监听器泄漏）；新增 `subscribe()` / `forgetSubscription()`；`close()` 先结束在途调用再关 socket |
| `cloud-terminal-scope.ts`（新） | 终端方法三类：**create**（worktree 必须落在本人 `workspaceRoot`）、**handle**（按句柄所属 worktree 判定，含 `terminal.unsubscribe` 的 `subscriptionId` 及 `${terminal}:${clientId}` 复合 id）、**deny**（主机窗口/全局方法：`terminal.list`/`closeAll`/`split`/`focus`/`show`/`closeTab`/`sleep`/`resolve*`/`multiplex`/fit 偏好）。未分类的 `terminal.*` 一律拒绝 |
| `cloud-path-guard.ts` | 接入终端三类；主机无法回答句柄归属（无 `resolveTerminalContext`）→ 拒绝；句柄已退出 → 拒绝 |

**验证（`evidence/m43-cloud-terminal/`）**：3 条真实端到端——真实平台票据、真实 TLS Runtime、真实 git 仓库与托管 worktree，主机 PTY **由 node-pty 起真实 shell 进程**（`/bin/sh`，真实 pid），输出经 `onPtyData` 进入 Runtime 自己的数据通道：
- M43-1 在本人工作区 `terminal.create` → 订阅收到 `scrollback` → `terminal.send("echo ORCA_CLOUD_TERMINAL_OK")` → 收到含该标记的 `data` 帧 → `terminal.unsubscribe{requestId}` 后流正常结束；
- M43-2 在共享检出区、其他团队仓库、以及不带 worktree 的创建全部 `forbidden`；`terminal.list`/`closeAll`/`focus` 被拒；
- M43-3 不存在的句柄 `forbidden`，不会落到 handler。

另有 12 条单测（三类互斥、未分类默认拒绝、create/handle 的越界、复合 subscriptionId、句柄未知、主机无法回答）。**两组负向对照**：把 create/handle 交给"不检查"分支 → 10 条用例变红（含 M43-2/M43-3）；把流事件改成投递 `undefined` → M43-1 在 15 秒后超时变红（`saw [null,null]`），证明用例真的在看主机输出。主机侧 28 文件 147 条全过；模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 终端面板 UI 尚未挂载：本轮交付的是**可用的传输 + 边界**（客户端已能创建、订阅、写入、退订）。渲染层还需要 xterm 组件与工作区布局接线。
2. `terminal.multiplex`（手机用的二进制流通道）与 `agentSession`/`session.tabs.*` 仍对云端关闭——它们有各自的帧协议与窗口语义，需要单独一轮做帧级边界，不能靠本表覆盖。
3. 云端客户端以"桌面客户端"身份订阅（不带 `client.type=mobile`），走 JSON 订阅；手机端若直连云主机需要二进制流能力协商，属后续项。
4. `terminal.create` 在无桌面窗口的云主机上返回 `warning`（"could not make it discoverable"），PTY 本身可用——与 M41 的 `files.open` 同类：无窗口宿主只能后台运行。

## M44 agent 家族工作区边界（本轮，由开发子代理执行）

**问题**：`agent` 权限通过前缀一次性放行了 `agent.` / `agentSession.` / `agentProvider.`，而路径守卫对这些方法**没有任何规则**（与 M36 之前的 files、M43 之前的 terminal 相同）。agent CLI 会执行命令，结构化会话会驱动一个正在运行的 agent；两者的目标工作区与会话 id 都由客户端指定。因此一个有 `agent` 权限的云端用户可以在**共享检出区或队友仓库**里启动 agent、读取他人的会话历史、并向他人的会话发送消息。

| 改动 | 内容 |
|---|---|
| `cloud-agent-scope.ts`（新，328 物理行/211 有效行） | 三类：**create**（`agent.launch`/`launchReplay`/`agentSession.create`/`createSupport`/`ensure`）——目标 worktree 必须解析进本人 `workspaceRoot`；`agent.launch` 还检查 `cwd` 与 `reuseTerminal.handle`，且 `target.kind` 必须是 `existing`（新建工作区由主机自己推导路径，与 `worktree.create` 同样拒绝）；**session**（26 个方法）——从 `sessionId` 或 `envelope.sessionId` 解析会话所属 worktree；**deny**——附件（主机文件存储、`read` 传绝对路径、上传流无法定界）、`agentTeams`/`agentHooks`（主机窗口/全局状态）、provider 目录、跨会话流与 restart 列表。未分类的 `agent*` 一律拒绝 |
| `cloud-path-guard.ts` | 接入 agent 三类；`isCloudPathGuardedMethod` 覆盖 |
| `orca-runtime.ts` | 新增 `resolveAgentSessionContext`：先查会话持久记录（`location.workspaceId`），再回退到终端上下文（终端承载的会话仍在 PTY 上）。两者都答不出 → 拒绝 |

**验证（`evidence/m44-agent-boundary/`）**：4 条真实端到端——真实平台票据、真实 TLS Runtime、真实 git 仓库与托管 worktree、真实 `CloudConnectClient`：
- M44-1 本人工作区的会话调用**到达 handler**（返回 `structured_agent_session_unsupported`，不是 `forbidden`）——证明边界放行后真的执行；
- M44-2 共享检出区与队友仓库的 `history`/`send` 被 `forbidden`；
- M44-3 向共享检出区、队友仓库、以及不指定工作区的 `agent.launch` 全部 `forbidden`；
- M44-4 全车级与主机侧方法（`subscribeStatus`、附件、`agentTeams`）被拒。

另有 13 条单测。**主会话独立负向对照**（不只看子代理报告）：把 `cloudAgentScopeOf` 改为恒返回 `null` → 3 条 e2e 变红（`expected 'runtime_error' to be 'forbidden'`），恢复后 4/4 绿。主机侧 + 渲染侧 + 共享 33 文件 186 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 会话归属的**记录存储路径未端到端验证**：真实结构化会话需要启动真实 provider CLI。e2e 走的是终端回退路径，记录查询只有单测覆盖。
2. `agentProvider.list` 现在被守卫拒绝（provider 目录是主机全局的）。若后续让云端复用 Orca 原有 agent 面板，需要重新评估：面板启动前要读 provider 目录，届时应改为"只按本人工作区过滤"而不是整体拒绝，并给出目录内容不跨租户的依据。
3. `agentSessionAttachment.*`、`agentTeams.*`、`agentHooks.*` 在当前分支本就未登记权限（`cloudMethodAccess` 返回 null，权限层已拒）；本表仍显式分类，是为将来放宽前缀时守卫依然正确。

## M45 云端运行时环境携带工作区路径（本轮，由开发子代理执行）

**问题**：M40 在打开项目时创建了用户的 checkout 并把 `workspacePath` 返回给渲染层，但**运行时环境本身不携带它**。任何按 `environmentId` 寻址的面板（包括我们准备复用的 Orca 原有界面）只能看到主机的整个 worktree 目录——包含队友的检出区——无法知道哪一份是当前用户的。这正是「复用 Orca 原有界面」的前置条件。

| 改动 | 内容 |
|---|---|
| `shared/runtime-environments.ts` | `CloudProjectLinkSchema` 新增**可选** `workspacePath`；新增 `cloudWorkspacePathOf(environment)`，旧侧车返回 `null` |
| `cloud-runtime-environment.ts` | `RegistrationInput.workspacePath?`，写入时条件展开（未知则不写键，旧侧车形状保持逐字节一致）；同一项目重开时**刷新路径并保持环境 id** |
| `ipc/cloud-platform.ts` | 把 `ensured.workspacePath` 传给注册 |
| `shared/runtime-environment-sidecar.test.ts` / `cloud-runtime-environment-registration.test.ts` | 旧条目读作 `null`、写读往返、写入时省略、重开保持 id |

**验证（`evidence/m45-workspace-path-sidecar/`）**：3 条真实端到端（真实平台票据 + 真实 TLS Runtime + 真实 git 仓库与托管 worktree + 真实客户端）：
- M45-1 侧车落盘的 `workspacePath` 等于主机创建的 `.orca-worktrees/zhangsan/main`，且 `realpath` 与 `git rev-parse --show-toplevel` 一致——证明写进去的是真实 worktree 而不是回显；
- M45-2 重开保持环境 id 不变、路径被新检出的真实 worktree 刷新；
- M45-3 去掉该字段的旧条目读作 `null`，不抛错。

**主会话独立负向对照**：把 `cloudWorkspacePathOf` 改为恒返回 `null` → M45-1/M45-2 变红（`expected null to be '/private/var/…'`），恢复后 3/3 绿。主机侧 + 共享 + 渲染侧 35 文件 190 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 字段只是数据管道：还没有任何面板**读取**它来决定打开哪个工作区（那属于界面改造那一轮）。
2. 向后兼容是双向的：旧构建忽略未知键（zod strip）；但旧构建若重写侧车，新字段会丢失，新构建退化为 `null`——不会抛错，也不会误判。
3. 本模块不涉及传输路由、路径守卫与面板 UI，均未改动。

## M46 无自定义头客户端的设备绑定（本轮，开发子代理 + 主会话补模拟器对齐）

**问题**（浏览器接入的硬阻塞）：云端准入在**升级期**要求设备公钥走 HTTP 头 `x-orca-device-pubkey`，并与票据里的 `devicePubKey` 精确比对。**浏览器无法为 `new WebSocket()` 设置自定义头**，因此任何浏览器都永远连不上云主机——`src/renderer/src/web/web-runtime-connection-transport.ts` 连子协议都不传。而「复用 Orca 原有浏览器界面」正是产品方向，所以这是必须先拆掉的阻塞。

**做法（不放宽安全性）**：浏览器可以控制子协议列表，因此设备公钥也可作为 `orca-device.<base64url>` 与凭证 `orca-cred.<ticket>` 并列传递；主机**对存在的每一种声明都比对**，任一与票据不符即 `device_mismatch`（头与子协议冲突时不会"择优放行"），两者都缺席仍是 `device_pubkey_missing`。E2EE 握手依旧用票据绑定的密钥完成，持有证明不变。

| 改动 | 内容 |
|---|---|
| `cloud-upgrade-admission.ts` | 新增 `readDevicePubKeyFromProtocols()`：仅接受无填充 base64url、32 字节、可规范化重编码的 key（拒绝短 key 与非规范尾比特）；格式无效或出现两个互相冲突的 token → `device_mismatch`；头与 token 并存时逐一比对 |
| `cloud-session-e2e-harness.ts` | `connectCloudSession` 支持 `deviceKeyIn: 'subprotocol'`（模拟浏览器：不带设备头） |
| `cloud-platform/apps/runtime/src/runtime-sim.ts`（主会话补） | 模拟器网关同步接受子协议形态，冲突时同样拒绝；键长不设 32 字节限制（模拟器设备键是 SPKI DER，真实主机才是 NaCl 32 字节）——**否则整机与替身的行为会分叉** |
| `cloud-platform/test/e2e/platform.e2e.test.ts`（主会话补） | 新增 E7b3：无头浏览器形态被接受；头与子协议冲突被拒 |

**验证（`evidence/m46-browser-upgrade/`）**：3 条真实端到端——真实平台进程签票、真实 TLS Runtime、**手工构造与浏览器能力一致的手连接**（只有子协议、无设备头），完成真实 E2EE 握手后 `status.get` 有真实响应；错误设备键 401 `device_mismatch`；两者都不带 401 `device_pubkey_missing`。另有 6 条准入单测（头/子协议/两者相等/冲突/缺失/格式错误）。模拟器 E7b3 通过（17/17）。

**主会话独立负向对照**：让准入忽略子协议形态 → M46-1/M46-2 变红（`Unexpected server response: 401` 与 `expected 'device_pubkey_missing' to be 'device_mismatch'`），恢复后 3/3 绿。主机侧 34 文件 186 条、模拟器 e2e 17 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. **线兼容**：使用子协议形态的客户端需要理解该 token 的主机；旧主机会返回 `device_pubkey_missing`（可映射的明确错误，不是静默关闭）。本模块不做能力协商。
2. 浏览器渲染层**还没有**真的使用它：`web-runtime-connection-transport.ts` 仍未传子协议、未接入云票据，这是下一模块（M47）的内容。
3. 平台与票据格式未改；E2EE 握手未改。

## M47 浏览器客户端在传输层支持云票据（本轮，开发子代理执行）

**问题**：浏览器传输层 `web-runtime-connection-transport.ts` 打开的是 `new WebSocket(endpoint)`——**不传任何子协议、不携带票据**，因此即使 M46 让主机接受子协议形式的设备公钥，浏览器仍然永远到不了云主机。

**本轮还发现一个隐藏前提**：主机不只看升级期的子协议，还在 E2EE 握手里校验 `deviceProofHolds`——**hello 里出示的公钥必须等于票据绑定的设备公钥**。浏览器传输层原本每次连接都临时生成密钥对，所以即便子协议补齐，握手仍会被判 `Unauthorized`。因此云端 offer 必须使用**持久化的设备密钥对**。

| 改动 | 内容 |
|---|---|
| `web-pairing.ts` | `WebPairingOffer` 新增可选 `cloud: { credential, devicePublicKeyB64 }`；严格校验（非空、子协议安全字符集、32 字节键、base64/base64url 规范化并拒绝非规范尾比特）；新增 `webRuntimeSubprotocols()`：普通 offer → `null`（保持无子协议连接），云端 offer → `['orca-runtime','orca-cred.<ticket>','orca-device.<base64url>']`；键损坏时抛 `WebPairingCloudKeyError`，**不退回无凭据连接** |
| `web-cloud-device-key.ts`（新） | 生成并持久化设备身份（存储接口注入，不绑定 localStorage/IndexedDB）；同一浏览器复用一个身份；对外只暴露公钥 |
| `web-runtime-connection-transport.ts` | 传入子协议；云端 offer 用持久化私钥完成 E2EE（普通 offer 仍用临时密钥对，行为不变）；新增可注入的 `WebSocketImpl`/定时器作为测试缝（缺省即浏览器全局） |
| `web-e2ee.ts` | 支持由私钥重建密钥对；`window.atob/btoa` 改 `globalThis` 以便同一份代码在 Node 测试中运行 |

**验证（`evidence/m47-web-cloud-transport/`）**：2 条真实端到端 + 1 条构造期失败用例——真实平台进程、真实 TLS Runtime、**真实的 `WebRuntimeConnectionTransport` 类**（只注入 Node 的 `ws` 与定时器）：
- M47-1 服务端收到的子协议就是 `['orca-runtime','orca-cred.<ticket>','orca-device.<base64url>']`，状态机 `connecting → handshaking → connected`，`status.get` 返回真实 `runtimeId`；
- M47-2 设备键与票据不符时永不进入 `connected`，另用原始升级探测证明原因是 `401 device_mismatch`（DOM API 不暴露状态码）；
- M47-3 云端 offer 缺少设备私钥时在构造期抛错。

另有 31 条单测（offer 解析/规范化/子协议构造/设备身份持久化）。**主会话独立负向对照**：子协议只带票据、去掉 `orca-device.` → M47-1、M47-2 变红（`Could not connect…` 与 `expected 'device_pubkey_missing' to be 'device_mismatch'`），恢复后 3/3 绿。浏览器侧 41 文件 299 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. **还没有生产代码构造云端 offer**：平台登录、取票、把 offer 交给传输层这一段尚未接线（本轮只到传输层为止）。
2. 设备密钥持久化只是接缝：真实浏览器需要接 IndexedDB 并把公钥注册到平台登录接口。
3. 端到端用的是 Node 的 `ws`（协议列表与浏览器一致），不是真实 DOM WebSocket。
4. 这一轮改了 `config/tsconfig.web.json`（加入 `src/types/**/*`），因为渲染侧测试引用了主进程测试夹具的类型；如后续不希望 web 工程依赖该目录，应改为在测试文件内本地声明。

## M48 浏览器云端登录与取票（本轮，开发子代理执行）

**问题**：M47 让浏览器传输层能携带云票据，但**没有任何浏览器代码去拿票**——登录平台、列项目、取一次性票据、把它变成 `WebPairingOffer` 这一步完全缺失，浏览器侧仍然只能靠人工配对码。

| 改动 | 内容 |
|---|---|
| `shared/cloud-platform-reply.ts`（新） | 把平台回复解析抽到共享层：`parseConnectTicketReply`/`parseProjectListReply`/`readTicketClaims`。桌面端解析原先用 Node 的 `Buffer` 解码 JWT，浏览器构建无法复用；现在两端读同一份契约（`cloud-connect-response.ts` 变成门面 re-export，桌面类型改为共享类型的别名） |
| `renderer/web/web-cloud-session.ts`（新） | `loginToCloud` → `listCloudProjects` → `requestCloudTicket` → `cloudPairingOfferFromTicket`。票据里的 `deviceToken` 从 JWT 载荷解出，`endpoint` 按 priority 直连优先（浏览器无法 TCP 预检），`publicKeyB64` 取 `host.e2eePublicKeyB64` |
| 错误处理 | 非 2xx 抛带平台 `error.code` 的 `WebCloudSessionError`（`INVALID_CREDENTIALS`/`HOST_OFFLINE`/`VERSION_UNSUPPORTED`/`DEVICE_KEY_MISMATCH`…）；200 但结构不符抛 `malformed_reply`；无端点抛 `no_endpoint`——**绝不返回半成品 offer** |
| `web-cloud-device-key.ts` | 新增 `createLocalStorageWebCloudDeviceKey()` 显式工厂（生产代码尚未调用；测试用内存 Storage） |

**验证（`evidence/m48-web-cloud-session/`）**：真实端到端 1 条 —— 真实平台进程 + 真实注册主机 + 真实 TLS Runtime + 真实设备身份，**完整走浏览器链路** `loginToCloud → listCloudProjects → requestCloudTicket → cloudPairingOfferFromTicket → WebRuntimeConnectionTransport`，`status.get` 返回真实 `runtimeId`；另 2 条负向：错误口令 → `INVALID_CREDENTIALS`（401），不可见项目 → `PROJECT_NOT_FOUND`（404）。另有 12 条单测（offer 构造、子协议产物、错误码映射、残缺回复、无端点）。

**主会话独立负向对照**：把 offer 构造里的 `cloud` 字段改名 → M48-1 变红（`expected undefined to be 'eyJhbGciOiJFZERTQSIs…'`），恢复后 4/4 绿。浏览器侧 + 主机侧 76 文件 487 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. **没有 UI 接线**：`web-shell`/`WebConnect` 仍只认配对码；`App` 尚未在登录取票后挂载。
2. 令牌只存内存，无刷新（`/v1/auth/refresh`）与持久化；调用方负责续期。
3. 无端点探测/测速（浏览器不能做 TCP 预检），仅按 priority 直连优先。
4. 一次性票据被消费后不自动重取；工作区/环境注册未涉及。
5. 真实 DOM WebSocket 页面上下文未验证（e2e 用 Node `ws`，协议列表一致）。

## M49 浏览器界面的云端登录入口（本轮，开发子代理执行）

**问题**：M47/M48 把传输与取票能力做齐了，但浏览器**没有任何入口**用到它们——`WebConnect` 仍只认配对码。

| 改动 | 内容 |
|---|---|
| `web-cloud-connect.ts`（新） | 无 React/DOM 的编排：读取/生成设备身份 → 登录 → 列项目 → 取票 → 构造 offer → 注入式客户端 `status.get` 校验 → 拒绝 mobile 作用域 → 返回 `{offer, runtimeId, projectName, deviceSecretKeyB64}`。平台错误码原样透出；其余映射为 `CONNECT_FAILED` / `MOBILE_SCOPE_REJECTED` / `NO_PROJECTS` |
| `WebConnectCloudForm.tsx`（新）+ `WebConnect.tsx` | 云端账号 / 配对码两个页签（无深链时默认云端）；平台错误码与消息直接显示；原配对码路径行为不变 |
| `web-runtime-client.ts` | 新增可选 `deviceSecretKeyB64` 并透传给传输层与订阅客户端——没有它云端 offer 无法完成 E2EE 握手 |
| `web-runtime-environment.ts` / `main.tsx` | 存 `cloudLoginRequired` 标记：云端登录取票成功但**票据不可复用**，因此不保存 `cloud` 绑定；刷新时清除该记录并回到登录页，提示"云会话已随页面关闭结束"，绝不挂载一个半连接的应用 |

**验证（`evidence/m49-web-cloud-connect/`）**：2 条真实端到端（真实平台进程 + 真实注册主机 + 真实 TLS Runtime + 真实设备身份）：`connectCloudProject` 返回真实 `runtimeId`；返回的 offer 能被真实 `WebRuntimeConnectionTransport` 接受并进入 `connected`；连续两次调用各自拿到**不同票据**且都成功。另有 7 条编排单测 + 3 条界面组件测试。

**主会话独立负向对照**：把 `status.get` 探测替换为固定成功值 → 3 条单测变红（runtime 绑定、mobile 作用域、CONNECT_FAILED），恢复后 7/7 绿。浏览器侧 46 文件 327 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 未达成用户价值（重要）**：
1. **登录成功后挂载的 `App` 实际连不上运行时**：本轮用一次 `status.get` 校验票据，而票据是**一次性**的——该次校验已消费它。保存的普通环境没有 `cloud` 绑定，App 自己的 runtime client 再次连接必然被拒，界面表现为"已进入但运行时断开"。这不是"完整可用"的登录，只是入口与编排打通。
2. 因此下一模块（M50）必须做**会话交接**：把 `WebConnect` 已验证的实时传输交给 `installWebPreloadApi`/`WebRuntimeClient` 复用，而不是校验后丢弃再重连；或在 App 侧实现**按需重新取票**（持有内存中的平台会话 + 设备身份）。二者取其一，否则云端登录对用户无价值。
3. 未做：令牌刷新（`/v1/auth/refresh`）、会话持久化、IndexedDB 迁移、启动期重取票、真实 DOM 页面上下文验证（e2e 用 Node `ws`）。
4. `VITE_ORCA_CLOUD_API_URL` 是构建期变量，尚无运行时配置发现。

## M50 云会话交接：登录后的连接直接服务 App（本轮，开发子代理执行）

**问题**（M49 记录的阻断）：登录时用一次 `status.get` 校验，**这一次校验就消费了一次性票据**；`WebConnect` 随后关闭客户端、保存一个没有 `cloud` 绑定的环境、挂载 App。App 的 preload 层再自建 `WebRuntimeClient`，升级必然被拒——用户"进了界面但运行时是死的"。云端登录对用户毫无价值。

**做法**：把校验用的**同一条活连接**交给 App，不再二次升级。

| 改动 | 内容 |
|---|---|
| `preload-api/web-runtime-session.ts` | 新增 `adoptWebRuntimeClient(client, environment)`：安装为 `activeClient`、记录环境 id、写 `activeEnvironment`、清 worktree 缓存、挂接状态发布；**同一客户端重复采纳不关闭**，换成不同客户端才关闭旧的。`getClientForEnvironment` 按 id 返回已采纳的客户端，普通环境走原路径不变 |
| `web-cloud-connect.ts` | 成功后**不关闭**客户端，连环境一起返回；所有失败路径仍在 `catch` 中关闭。使用窄接口 `WebRuntimeSessionClient`，不需要类型断言 |
| `WebConnectCloudForm.tsx` | 先 `saveStoredWebRuntimeEnvironment`（保留 `cloudLoginRequired` 标记）再 `adoptWebRuntimeClient`，然后才 `onConnected()`；保存失败则先关闭客户端 |
| 断线语义 | 云环境的票据已用尽，`reconnect: false`。断线时状态层如实报告 `disconnected`/`unavailable`，`getClientForEnvironment`/`observeWebRuntimeStatus` 返回 `runtime_cloud_session_ended`（"云会话已结束，请重新登录"），**不再对已作废的 offer 静默重连** |

**验证（`evidence/m50-web-cloud-handoff/`）**：真实端到端 1 条 —— 真实平台进程 + 真实注册主机 + 真实 TLS Runtime：`connectCloudProject` → 采纳 → 通过 **preload 层**取客户端并发真实 RPC，返回真实 `runtimeId`；断言 preload 返回的**就是**校验时那个客户端对象（`preloadClientIsAdoptedClient: true`），并额外证明同一票据再次升级被拒（`401 replayed`），即票据只被消费一次、没有第二次升级。另有采纳语义单测（含真实 socket 断线状态发布）、`connectCloudProject` 成功/各失败路径的开启与关闭断言、界面"先采纳再 onConnected"断言。

**主会话独立负向对照**：让 `getClientForEnvironment` 忽略已采纳客户端、总是新建 → e2e 变红（`expected WebRuntimeClient{…} to be WebRuntimeClient{…}`，且新客户端没有 credential/deviceSecret/scope），恢复后通过。浏览器侧 48 文件 335 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. **断线后不能自动恢复**：票据已作废，只有重新登录能拿新票。目前用户看到"云会话已结束"的错误，需要刷新（`main.tsx` 会回到登录页）或重新打开连接页；**没有自动跳回登录的 UX**。
2. 真实浏览器里 `<App/>` 挂载后的完整交互未验证：e2e 证明了 preload 会话状态与真实 socket 上的 RPC，React 宿主仅由组件测试覆盖。
3. 配对码路径未变（其 offer 可复用，仍自带校验客户端）。
4. 采纳的连接保持 `reconnect: false`；将来要支持断线重连必须重新登录取票，而不是传输层重试。

## M51 云会话断线后自动回到登录页（本轮，开发子代理执行）

**问题**（M50 记录的缺口）：票据一次性，断线后无法重连。M50 让状态层如实报告断开、让客户端查找返回 `runtime_cloud_session_ended`，但**界面从不离开 App**——用户停在死界面上，只能手动刷新。

| 改动 | 内容 |
|---|---|
| `preload-api/web-runtime-session.ts` | 新增 `subscribeCloudSessionEnded(listener)`：仅在"已采纳客户端 + 云环境 + 传输 `disconnected` + 连接态 `disconnected`/`auth-failed`"四条同时成立时触发；用 `WeakSet` 按客户端去重（一个客户端最多一次），先标记再通知以避免监听器关闭客户端引发的递归。`connecting`/刷新失败不会触发 |
| `web-session-recovery.ts`（新） | `useWebSessionRecovery`：订阅信号 → 清除已作废的存储环境 → `closeActiveRuntimeClients()` → 返回 `signed-out` + 原因 → 回调 `setHasEnvironment(false)`。在 `WebRoot` **无条件挂载**，因为客户端可能在 App 挂载前就死掉 |
| `main.tsx` | 断线通知优先于启动期通知；App 仅在终结信号时卸载，瞬时 `connecting` 不卸载；普通配对环境行为不变（仍可重连） |

**验证（`evidence/m51-cloud-session-recovery/`）**：真实端到端 1 条 —— 真实平台 + 真实 TLS Runtime：采纳后真实 `status.get` 成功（`runtimeId` 有值）→ `cloud.runtime.stop()` **真实杀掉主机** → 信号恰好触发 1 次，状态变 `disconnected`，随后的客户端查找返回 `runtime_cloud_session_ended`（不挂起、不重连）。另有 5 条信号单测（含 `connecting` 不触发、非云环境不触发）与 2 条恢复钩子测试。

**主会话独立负向对照**：让信号永不派发 → 恢复钩子测试与真实 e2e 双双变红（`expected +0 to be 1`、`Matcher did not succeed in time`），恢复后浏览器侧 50 文件 344 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 真实浏览器 DOM 未验证：`main.tsx` 是入口模块，钩子与信号有测试，但没有真实页面观察到 WebConnect → App → WebConnect 的切换。
2. "同一页面内重新登录"未走通 `WebConnectCloudForm` 的浏览器路径。
3. 刷新路径（启动期提示）沿用既有实现，本轮未重复验证。
4. 断线后**不会自动重登**——只回到登录页；自动续期需要保存平台会话（安全范围更大），未做。

## M52 桌面端回归 Orca 原生界面：云项目注册为 repo（本轮，开发子代理执行）

**问题**：`App.tsx` 用 `CloudModeGate` 把整个工作区壳子替换成自造页面；云项目只注册了运行时环境、**没有注册成 repo**，所以原生侧栏不会列出它们。

| 改动 | 内容 |
|---|---|
| `cloud-workspace-entry.tsx`（新） | 替换 `CloudModeGate`：云端构建未登录时显示登录面板，登录后**照常渲染原生 `AppWorkspaceShell`**；每个项目注册环境后再同步为侧栏 repo |
| `cloud-project-repos.ts`（新） | 无 DOM 的同步计划：按 `(executionHostId, path)` 幂等，重登录不重复；平台名称变化只改显示名；登出先由主进程回收环境、再删除行 |
| `cloud:registerProjects`（新通道） | 为每个可见项目 `prepareProjectLink` + 注册环境，返回 `projectId/projectName/projectRoot/environmentId`。**不创建 checkout、不占用唯一连接**（列侧栏不该建工作区） |
| `cloud-rpc-permission.ts` / `cloud-repo-add-scope.ts`（新）/ `cloud-path-guard.ts` | 新增 `repo.add`（归 `open` 权限），路径守卫**只允许票据里的 `projectRoot` 本身**（含 realpath），其他路径与符号链接写法一律拒绝；守卫单独成模块以守住 300 行上限 |
| `preload` | `api.cloud` 仅当 `ORCA_CLOUD_API_URL` 设置时暴露（与主进程注册 handler 的条件一致）；此前无条件暴露会让普通桌面构建误判为云端模式 |
| `cloud:logout` | 回收全部云环境（此前只关当前项目） |

**验证（`evidence/m52-cloud-repo-registration/`、`evidence/m52-cloud-native-entry/`）**：真实端到端 4 条（真实平台 + 真实 TLS Runtime + 真实 git 仓库 + 真实客户端）：repo 行 `executionHostId=runtime:<envId>`、路径为项目根；重复同步不产生第二行；通过注册环境发真实 RPC 成功；原生入口路径同样有真实用例。另有 10 条单测（幂等/改名/登出清理/preload 暴露条件/界面回归）。

**主会话独立验收**：`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现；相关 41 条测试全过；`repo.add` 的路径守卫有专门用例（越界与符号链接均拒）。

**如实记录 / 本轮踩到的坑**：
1. 一次全量 `src/renderer/src/` + `src/main/cloud-platform/` 套件（约 4700 文件 / 41k 用例）与子代理的全量运行**并发**执行，机器 load average 冲到 50，两边结果都不可信，已终止。**后续规矩**：默认只跑受影响文件；全量只在需要时单跑且不与子代理同时跑。两个失败用例（`palette-match-performance`、`terminal-search-long-wrapped-line`）在空闲机器上单跑通过，属负载导致的时序抖动，与本模块无关。
2. 本轮只做"列出 + 默认打开第一个项目"，**每项目独立连接尚未实现**（M53）：`CloudSessionService` 仍是单客户端，切换项目会断开上一个。
3. `repo.add` 对云端开放是新增攻击面：目前仅由"只能添加项目根"限定；"添加后能否读到项目根之外"由既有工作区边界（M36）兜底，值得在 M53 补一条组合用例。

## M53 每项目独立连接（多项目并存）（本轮，开发子代理执行）

**问题**：M52 已为每个项目注册运行时环境并同步出侧栏 repo，但 `CloudSessionService` 仍只有**一个** `CloudConnectClient` 和一个"当前项目"，`rpc`/`closeProject` 没有 projectId——切换项目会断开上一个，多项目只能串行使用。

**关键约束**：设备身份（accessToken、deviceId、密钥对）在登录时注册，主机在 E2EE 握手里校验"hello 公钥 == 票据设备公钥"。因此**不能**每个项目重新登录（会注册多余设备、破坏设备绑定）。

| 改动 | 内容 |
|---|---|
| `cloud-project-connections.ts`（新） | 平台会话持有者与 socket 持有者分离：登录客户端只做 HTTP（登录/列项目/取票），每项目 fork 一个**共享同一 `CloudDeviceIdentity`** 的连接客户端，各自升级与 `rpc`；`Map<projectId, entry>` 管理打开/关闭/全部关闭/按项目 RPC/按项目断开事件 |
| `cloud-session-service.ts` | `openProject/ensureWorkspace/rpc/closeProject` 全部显式按 projectId 路由；移除 `connectedProjectId` 这类模糊的"当前项目"API；登出关闭全部 |
| IPC / preload / 渲染层 | `cloud:rpc(method, params, projectId)`、`cloud:closeProject(projectId)`；更新全部调用点（`cloud-app.tsx`、`use-cloud-session.ts`、`cloud-project-workspace.tsx`） |
| `device-registry-cloud-adoption.ts` | **主机侧必要修复**（非 M36–M44 边界）：设备登记原先按 deviceId 唯一，第二个项目的票会覆盖第一个项目的活 token，导致 `Invalid device token`。改为按 `(deviceId, token)` 登记，同一设备的兄弟会话各自持行；每设备每项目最多保留 4 个 token 防膨胀；按 deviceId 吊销仍会清除全部兄弟行 |

**验证（`evidence/m53-multi-project/`）**：真实端到端（真实平台 + **单台**真实注册主机 + 两个项目 + 真实 TLS Runtime + 真实客户端）：两个项目同时在线，**两张票据携带同一 `devicePubKey`** 且主机都接受握手；各自 `status.get` 返回真实 `runtimeId`；会话 A 发起的跨项目 `worktree.list` 被 `forbidden`（证明两条 socket 各自受限，不是同一条）；关闭 A 后 A 返回 `NOT_CONNECTED` 而 B 仍正常。另有 6 条多项目单测 + 相关模块测试。

**主会话独立负向对照**：让 `rpc` 忽略 projectId、固定用第一个连接 → e2e 变红（`forbidden: That file is outside the project this cloud session was granted`），恢复后通过。`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现。

**测试执行规范（本轮同时确立，已写入 `DEVELOPMENT_PROCESS.md` §4.1）**：L1 最小（改动文件+邻居）→ L2 模块 → L3 里程碑 → L4 全量；**所有命令必须带 `--maxWorkers`（默认 4）**，禁止并行跑两个大范围套件，主会话与子代理不得同时跑大范围测试；负载过高立即终止且不得把部分结果当结论。

**如实记录 / 剩余**：
1. 设备登记现在每个设备+项目最多保留 4 个 token；socket 正常关闭时**不会**立即失效对应 token，只靠后来的登记淘汰。票据本身一次性且准入期会复查吊销，风险与之前同级，但留下一条主机侧清理待办。
2. 管理页 `CloudApp` 仍是"同一时刻打开一个项目"的页面（现在按 projectId 显式路由）；多项目同屏展示不在本轮范围。
3. 本轮未做 L4 全量：按分级规范，全量留到里程碑收口/最终验收单跑。

## M54 管理员浏览器会话页（本轮，开发子代理执行）

**问题**：管理员用的云端会话页只存在于 Electron 内（依赖 `window.api.cloud`），无法按设计"从平台项目列表打开、单独用 PC 浏览器访问"。

| 改动 | 内容 |
|---|---|
| `cloud-browser-bridge.ts`（新） | 浏览器版 `CloudBridge`：登录/列项目/取票复用 `web-cloud-session`，每项目一个 `WebRuntimeClient`（共享持久化设备身份），`rpc(method, params, projectId)` 显式路由，`closeProject(projectId)` 只关一个，`logout` 关全部；offer 与 `getState()` 都不含设备私钥 |
| `shared/cloud-workspace-open.ts`（新） | 把"选已有检出 / 否则 `worktree.createManaged`"的逻辑抽成传输无关实现；桌面 `ensureCloudWorkspace` 改为复用它，避免浏览器与桌面两套选择逻辑 |
| 独立入口 | `src/renderer/cloud-admin.html` + `src/renderer/src/cloud-admin/main.tsx` 挂载现有 `CloudApp`；`electron.vite.config.ts` 新增 `cloud-admin` 入口，投影脚本与构建校验同步覆盖两个 HTML 入口 |
| 静态服务 | `static-web-client-handler.ts` 放行 `/cloud-admin.html`，反向代理前缀映射覆盖两个入口；`/`、目录穿越、未知路径与 `/web-index.html` 规则不变 |
| 管理台入口 | `cloud-platform/apps/web/config.js` 提供 `window.__ORCA_CLOUD_SESSION_URL__`；配置存在时项目行显示"打开会话页"（新标签、`rel=noopener`），未配置则不渲染，**URL 中不含任何令牌** |

**验证（`evidence/m54-admin-session-page/`）**：真实端到端 1 条（真实平台 + 真实注册主机 + 两个项目 + 真实 TLS Runtime）：浏览器 bridge 登录 → 打开两个项目 → 两个项目各自真实 `status.get`（`runtimeId` 相同，同一主机）；目录浏览分别列出各自的真实文件（`alpha-marker.txt` / `beta-marker.txt`，互不可见）；A 跨项目访问与绝对路径均 `forbidden`。另有 5 条 bridge 单测与静态服务测试（放行新入口、其余规则不变）。

**主会话独立验收**：`npx tsc -p config/tsconfig.web.json` / `tsconfig.node.json` 均 0 错；`changed-code` 门禁 7 项 0 新发现；相关 5 文件 14 条全过（含 `cloud-workspace-ensure` 与 `cloud-file-panel`，确认共享抽取未破坏桌面路径）。**独立负向对照**：让 bridge 的 `rpc` 忽略 projectId → e2e 与单测双双变红（跨项目 `forbidden`、路由序列不符），恢复后通过。

**如实记录 / 剩余**：
1. 未执行完整 electron-vite 构建，也未在真实浏览器渲染 `cloud-admin.html`；静态规则由 handler 级测试覆盖。部署需填写 `config.js` 的会话页地址，并给会话页注入平台 API 地址（`window.__ORCA_CLOUD_ADMIN_API_URL__` 或 `VITE_ORCA_CLOUD_API_URL`）。
2. **`pnpm tc:web` 本来就是红的**：`config/tsconfig.tc.web.json` 在 HEAD 上已有 4165 条 TS6307（渲染侧 e2e 测试 import 了 `src/main/**` 的测试夹具），M47–M54 新增的渲染侧 e2e 各累加若干条（本轮 +3，共 4168）。`npx tsc -p config/tsconfig.web.json` 仍为 0 错，所以没有类型错误被掩盖，但项目自带的严格门禁是脏的——需要在后续轮次统一清理（把渲染侧 e2e 移到 `src/main/cloud-platform/`，或为渲染 e2e 单独建 tsconfig）。
3. 管理页 UI 直接复用现有 `CloudApp` 组件，未做视觉打磨。

## M55 原生初始导航：进入项目即定位到本人 checkout（本轮，开发子代理执行）

**问题**：M52/M53 之后开发者能登录、侧栏能列出项目、连接可并存，但登录后界面停在"未选择工作区"——主机其实已经建好/复用了本人 checkout（M45 写进侧车），却没有被选中。

| 改动 | 内容 |
|---|---|
| `shared/cloud-initial-worktree.ts`（新） | DOM-free 选择规则：在**同一 repo**（`repoId === repo.id`）里找路径**精确等于** checkout 的那一行（路径经跨平台规范化比较），返回该行自己的 id；嵌套在父 worktree 下的 checkout 不会误选父行；无匹配 → `null`；重复路径取侧栏首行（主机异常，按点击行为） |
| `cloud-workspace-entry.tsx` | 打开项目成功后，用 `openWorkspace` 返回的 `workspacePath` + 注册环境推出 repo 行，调用现有 `setActiveWorktree(id, 'runtime:<envId>')`；若该 repo 的 worktree 尚未加载，先 `fetchWorktrees(repo.id)` 再选一次（**未新增 IPC**）；无 `workspacePath`（旧侧车）时不动默认视图 |

工作树 id 形状：`` `${repo.id}::${gitWorktree.path}` ``（主机 `runtime-managed-worktree-queries.ts:171`，共享 `shared/worktree/id.ts:21`）。

**验证（`evidence/m55-initial-worktree/`）**：真实端到端 1 条（真实平台 + 注册主机 + 真实 TLS Runtime + 真实 git 仓库）：侧车路径与 `openWorkspace` 返回一致；选中的 worktree 行路径的 `git rev-parse --show-toplevel` 与被选中目录**相等**（`equalToplevel: true`），且该 checkout 嵌套在仓库主 worktree 下时仍选嵌套行而非父行。另有 5 条 helper 单测（精确/嵌套/无匹配/跨仓库/重复）+ 5 条入口组件测试。

**主会话独立负向对照**：让 helper 恒返回 `null` → 4 条用例变红（`expected null not to be null`、`expected null to be 'repo-a::/srv/work/feature-x'`），恢复后 13/13 绿。`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 只处理**第一个项目**；其他项目打开时不会自动定位。
2. 不恢复上次使用的 worktree/标签布局，只定位到本人 checkout（有意为之）。
3. 侧车里没有 `workspacePath` 的旧环境不会补选（有意保守）。
4. 未跑真实 Electron 界面；覆盖为 happy-dom 组件测试 + 真实平台/TLS/git e2e。
5. Windows/UNC 路径只由共享规范化函数的单测覆盖，无真实 Windows 主机验证。
6. 子代理报告 `pnpm test`（Bun 运行器）在本机会让所有云端 TLS e2e 报 `TLS handshake failed`（M45 既有用例同样失败），因此 e2e 用 `pnpm test:node` 执行——与本轮改动无关，属于既有环境限制。

## M56 修复 `pnpm tc:web` 的 TS6307 工程边界（本轮，开发子代理执行）

**问题**：`pnpm tc:web`（`tsc -p config/tsconfig.tc.web.json`）长期是红的——**4168 条 TS6307**。渲染侧 6 个 Node 环境的云端 e2e 测试 import 了主进程测试夹具（`cloud-session-e2e-harness`、`cloud-runtime-admission`），把整个 `src/main` 依赖图拖进浏览器工程，而该工程的 include 只列了手挑的一部分 main 文件，于是其余每个 main 文件都被判"不在工程文件列表内"。

| 改动 | 内容 |
|---|---|
| `config/tsconfig.cloud-e2e.json`（新） | 专门承载跨边界测试的工程：包含 `src/main`/`src/shared`/`src/preload`/`src/types`、`env.d.ts`、6 个 e2e 文件以及它们直接 import 的渲染模块（**不是整个 `src/renderer/src`**）；`types` 需要 `electron-vite/node` 提供 `*?asset` 声明，与既有 node 工程一致，**未放宽任何检查**（`strict`/`skipLibCheck` 沿用基础配置） |
| `config/tsconfig.tc.web.json` | 用**显式 6 项** `exclude`（而非 `**/*.e2e.test.ts` 通配）：将来若有只 import 白名单 main 文件的渲染 e2e，仍由 web 工程检查 |
| `config/scripts/run-typecheck-projects-in-parallel.mjs` / `package.json` | 新工程加入 `pnpm tc` 并行链（`heapGib: 9`，实测 8.8 GB / 13.4 s），新增 `typecheck:cloud-e2e` 脚本 |

**验证**：`tsc -p config/tsconfig.tc.web.json` **4168 错误 → 0**；`tsc -p config/tsconfig.cloud-e2e.json` 0；`tsc -p config/tsconfig.node.json` 0；6 个 e2e 全过（12 条）。**主会话独立负向对照**：去掉 exclude 后 TS6307 立刻回到 4168 条，恢复后 0。门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 代价是内存：新工程把 main + renderer 图放进同一个 program，实测 8.8 GB，比 node（7）和 web（6）都大。32 GB 机器上仍是一批（合计 24 GiB 恰好等于预算）；**16 GB CI runner 上会多出一个串行批次（约 13 s）**，而不会把 node/web 挤到 OOM。
2. `config/tsconfig.e2e.json`（`tests/**`）仍按原注释保持**未启用**，本轮未动。
3. 6 个测试本身**没有**需要修的类型错误（新工程一开始报的 18 个 TS2307 是 main 依赖图里的 `*?asset` 环境声明，由 `electron-vite/node` 类型解决，不是改测试）。
4. 未跑完整 `pnpm tc`（会并行拉起 node+web+cloud-e2e+cli，约 24 GB）；按分级规范留到里程碑收口时验证一次。

## M57 项目创建 provisioning：主机真实 clone 缺失段（本轮，开发子代理执行）

**问题**：平台 `POST /v1/projects` 直接写 `status: 'ready'`，而主机 `ensureCloudWorkspace` 要求 `projectRoot` 已是 git 仓库，**代码里没有任何 clone 步骤**。管理员在平台建了带 `repoUrl` 的项目后，开发者首次打开只会得到模糊的仓库错误；项目也无法出现在侧栏（`repo.add` 同样失败）。

| 改动 | 内容 |
|---|---|
| 平台 `store.ts` / `server.ts` / `contract/credential.ts` / `contract/repo-url.ts`（新） | `Project.status` 增加 `provisioning`；有 `repoUrl` → `provisioning`，无 → `ready`；建项目时校验仓库地址（trim、长度、控制字符、`-` 开头、`ext::`）；票据新增**可选** claim `repoUrl`/`defaultBranch`；心跳解析 `provisioned`（≤50 项、error 截断 500、只处理本主机项目、archived 跳过），写 `project_provision` 审计并置 `ready`/`failed` + `provisioningError` |
| `src/main/cloud-platform/cloud-project-provision.ts`（新） | URL/分支校验（拒绝 `ext::`、参数注入、非法 ref）、provision 决策、失败文案；纯逻辑可单测 |
| `src/main/runtime/rpc/methods/project-provision.ts`（新） | 云端专用 `project.provision`（不进 `ALL_RPC_METHODS`，只在云端方法表追加）；路径/URL/分支**全部取自签名票据**，handler 拒绝非云上下文；成功/失败都排入心跳回报 |
| `src/main/runtime/orca-runtime.ts` + `runtime-repository-clone-controller.ts` | `provisionCloudProject()`；clone 控制器新增精确路径 `cloneToPath()`，复用路径锁、`claimCloneTarget`、失败清理、git 读缓存失效与 repo 注册，`git clone --branch <branch> -- <url> <checkoutPath>` |
| `device-registry*` / dispatch / `runtime-rpc-pairing` / `cloud-runtime-admission.ts` | 票据 claims 进 device registry；`RpcContext.cloud` 与 `cloudReportProvision`；`setCloudProvisionReporter` 由 `attachCloudRuntime` 接到 `client.reportProvisioned(...)`；方法表追加 `PROJECT_PROVISION_METHODS` |
| `cloud-agent-client.ts` | `reportProvisioned` 有界队列（≤32、同项目保留最新），心跳 2xx 后按序号清空；poll 模式无心跳，报告丢弃（注释说明） |
| `shared/cloud-workspace-open.ts` / `cloud-session-service.ts` / `ipc/cloud-platform.ts` | 打开前先 provision（600s 超时）；旧主机 `method_not_found` 或“方法不可用于云会话”的 `forbidden` 视为跳过；`ensureProjectPrepared` 复用已有连接或临时 client；`registerProjects` 在取链接前逐项目准备，失败告警并跳过 |
| `renderer/cloud-workspace-entry.tsx` + 测试 | 入口 `preparing` 状态 + 非阻塞提示条（“正在准备云端项目…”），不隐藏工作区 |

**验证（`evidence/m57-project-provisioning/`）**：真实端到端 2 条（真实平台进程 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 `git init --bare` 远端）：
- M57-1：平台建项目（repoUrl=真实裸仓库，目标路径不存在）→ `status: provisioning` → 登录 → `ensureWorkspace` → 主机真实 clone；README 与源一致、`rev-parse --show-toplevel` 等于 checkout 路径；工作区 worktree 在 `workspaceRoot` 内且自成 toplevel；两次心跳后平台 `ready`、无 error、审计 success。
- M57-2：repoUrl 指向不存在的远端 → `CLONE_FAILED`、**目标目录未残留**；心跳后平台 `failed` + `provisioningError`，审计 failure。
- 另有 4 个测试文件 55 条（URL/分支/决策、旧主机跳过、入口提示）。

**主会话独立验收**：12 个相关测试文件 **87 条全过**（含 `cloud-workspace-ensure`、`cloud-repo-registration`、`cloud-native-entry`、`cloud-agent-client`、`cloud-rpc-permission/scope`、多项目、managed worktree、共享打开函数、入口组件）；平台 `node --test` 18 条（parity/contract）与 e2e 39 条（admin-gating 13、platform/revocation/mtls 26）全过。`tsc -p config/tsconfig.tc.web.json` **0 错**；`tsc -p config/tsconfig.node.json` 仅 2 条既有 TS6307（`cloud-project-root`/`cloud-repo-registration` 的旧工程边界，本轮未触碰）。`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让 `provisionCloudProject()` 直接返回成功而不 clone（临时改动后已恢复）→ M57-1/M57-2 **双双变红**（后续 `worktree.list` 报 `forbidden: That repository is not available to the cloud session`，失败路径也拿不到 `CLONE_FAILED`）；恢复后 2/2 绿。

**如实记录 / 剩余**：
1. **旧主机兼容**依赖错误文案：真实旧主机对未注册方法在权限阶段返回 `forbidden`（`Method 'project.provision' is not available to cloud sessions`）而不是 `method_not_found`；客户端同时接受两者，但这是对固定英文文案的依赖，未用真实旧版二进制验证。新主机+旧平台（票据无 `repoUrl`）时，已有仓库照常打开，未准备路径返回 `PROJECT_NOT_PREPARED`。
2. **poll 模式主机**（无心跳）只拿到同步 RPC 结果，平台状态不会更新，停留在 `provisioning`。
3. `registerProjects` 在签到期间**串行**准备所有项目：首次签到若含未克隆的大仓库，侧栏出现时间等于克隆耗时（提示条可见，但会拖慢首屏）。
4. 目标路径若是管理员预先创建的**非空目录**，git 自身拒绝且不会清理（`cloneToPath` 只清理自己创建的目录）；常规“目录不存在”路径已由 e2e 验证无残留。
5. Windows 未实机验证；克隆使用既有跨平台 git runner。
6. 平台侧“非本主机回报被忽略”只有代码路径，未单独补 HTTP 用例（e2e 覆盖合法主机回报）。

## M58 准备失败可见 + 可修复/可重试（本轮，开发子代理执行）

**问题**：M57 之后，准备失败的项目在 `cloud:registerProjects` 里被 `console.warn` + `continue` **静默丢弃**——侧栏少一项、用户看不到原因、也没有重试入口；管理员在平台上也无法修正写错的 `repoUrl`，失败项目永远无法恢复。

| 改动 | 内容 |
|---|---|
| 平台 `server.ts` + `contract/branch-name.ts`（新） | 新增管理员 `PUT /v1/projects/:id`：可改 `repoUrl`/`defaultBranch`（分别复用/新增校验），`path`/`hostId` → `PROJECT_FIELD_IMMUTABLE`，归档项目 404；成功后 `status = repoUrl ? 'provisioning' : 'ready'`、清除 `provisioningError`，审计 `project_update`（只记 `repoUrlChanged` 布尔，不写完整 URL） |
| `src/shared/cloud-platform-reply.ts` / `cloud-platform-ipc.ts` | 项目行解析增加 `status`、`provisioningError`（老平台缺失为 `null`）；`CloudProjectSummary` 透传；新增 `CloudProjectFailure`、`CloudProjectRegistration`、`CloudRetryPrepareResult` 与 channel `cloud:retryPrepare` |
| `src/main/ipc/cloud-platform.ts` | 抽出 `prepareProjectEnvironment`（provision → link → register）；`registerProjects` 返回 `{environments, failures}`；新增 `retryPrepare(projectId)` |
| `renderer/cloud-workspace-entry.tsx` + `cloud-workspace-banners.tsx`（新）+ `cloud-entry-workspace-sync.ts`（新） | 失败进入状态并显示非阻塞横幅（项目名 + 错误码，最多 3 个 + “等 N 个”）；「重试」逐项目 `retryPrepare`，成功项目注册环境并同步侧栏 repo，仍失败则更新错误码；拆分以保持单文件 ≤300 行 |
| `preload` / 浏览器 bridge / web 会话 | 类型与桥同步；管理页 bridge 的 `retryPrepare` 返回 `ADMIN_SESSION_UNSUPPORTED`（管理页不注册原生环境）；浏览器会话透传状态 |

**验证（`evidence/m58-provision-recovery/`）**：真实端到端 1 条（真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 bare git）：
坏 `repoUrl` → `registerProjects` 返回 `failures: [{code: CLONE_FAILED}]`、`environments: []` → 心跳后平台 `failed` + `provisioningError`、`listProjects` 摘要带状态 → 管理员 `PUT` 指向新建的真实裸仓库 → `status: provisioning` → 真实 `cloud:retryPrepare` → 真实 clone，README 一致 → 心跳后平台 `ready` → 再次 `registerProjects` 无失败，`planCloudProjectRepos`/`syncCloudProjectRepos` 在真实 store 中生成侧栏行。
平台侧 `project-update.e2e` 4 条：非管理员 403（先授权使项目可见）、状态重置与错误清除、非法 URL/分支 400、归档 404、审计不含 URL。组件测试 4 条（失败提示、重试失败更新码、重试成功消失、准备中）。

**主会话独立验收**：10 个相关 vitest 文件 **84 条全过**；平台 e2e 4 条全过；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307（`cloud-project-root` 与新的 recovery 测试沿用 `cloud-repo-registration` 的同一渲染导入模式，非语义错误）；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让平台 `PUT` 忽略 `repoUrl`（只改状态）→ recovery e2e **变红**（`expected false to be true`，重试仍打旧地址）；恢复后 1/1 绿。子代理另有对照：去掉 `failures.push` → 失败收集用例变红。

**如实记录 / 剩余**：
1. 管理页浏览器 bridge 不支持 `retryPrepare`（管理页不注册原生环境）；管理员重试仍走平台修正 + 开发者端重试。
2. UI 仅 happy-dom 组件测试，未做真实 Electron 渲染截图；样式只用既有 shadcn Button 与 token。
3. 重试失败的项目错误码会更新，但 `provisioningError` 的**完整消息**只在平台侧；原生横幅只显示 code（避免把主机内部文案当 UI 文案）。
4. 首次签到仍**串行**准备所有项目（M57 遗留），失败项目不再拖慢其它项目——它们只是被并行计入失败列表。

## M59 开发者自助创建云端项目（本轮，开发子代理执行）

**问题**：`POST /v1/projects` 一直是 **admin-only**，而用户需求是"普通开发者可以在平台上创建项目，创建后本地拉取到并打开使用，连接过程不需要感知"。缺口不只是权限：平台还必须**自己**决定项目落在主机哪个目录（开发者指定 `path` 等于允许在共享主机上任意落盘），并且创建后客户端要自动出现该项目。

| 改动 | 内容 |
|---|---|
| 主机 `ORCA_CLOUD_PROJECTS_ROOT` | 注册与心跳上报 `projectsRoot`（绝对路径）；未配置 = 该主机不支持自助创建 |
| 平台 `store.ts` / `server.ts` / `project-self-service.ts`（新）/ `contract/project-key.ts`（新） | `Host.projectsRoot`、`Project.createdBy`；`POST /v1/projects/self`（登录即可）：`path` 出现即 400 `PROJECT_PATH_FORBIDDEN`，key 由 `validateProjectKey` 校验（`^[a-z0-9][a-z0-9._-]*$`，可由名称规范化），主机选择（无 / 多台 / 不合格分别 409 `NO_PROVISIONABLE_HOST`/`HOST_REQUIRED`/`HOST_NOT_PROVISIONABLE`），路径由 `joinProjectPath(projectsRoot, key)` 推导并复验，key/路径冲突 409，每用户 20 个未归档项目上限 429；创建者自动获得 `open,terminal,agent,file:read,file:write`（**无 download**），审计 `project_create`（`selfService: true`，不含地址）；新增 `GET /v1/hosts/available`（登录即可，只回 `{id,name,online,provisionable}`，不含地址/凭据） |
| 主机/客户端 `cloud-self-service-api.ts`（新）/ `cloud-connect-client.ts` / `cloud-session-service.ts` / IPC / preload | `createProject`、`listProvisionableHosts`；`cloud:createProject` 创建后立即 `prepareProjectEnvironment` 并返回 environment；`cloud:listProvisionableHosts` |
| 渲染 `cloud-new-project-dialog.tsx`（新）+ `cloud-workspace-banners.tsx` + `cloud-workspace-entry.tsx` | 云构建已登录时右下角“新建云端项目”按钮（`z-40`，与底部失败横幅 `z-50` 不重叠）；对话框填写名称/key/仓库/分支/主机（无合格主机时禁用提交）；创建成功注册 environment、同步侧栏 repo 并打开项目 |

**验证（`evidence/m59-self-service-projects/`）**：
- 平台 e2e 10 条（真实平台进程）：非管理员创建 201 + `path === projectsRoot/key` + 自动权限（无 download）；显式 `path` 400；无合格主机 409；多主机未选 409 并附列表；key 冲突 409；配额 429；非创建者 `GET /v1/projects` 不可见；`/v1/hosts/available` 不含 `credentialHash`/`directAddrs`；非法 `projectsRoot` 被忽略且写审计。
- 主机端到端 1 条（真实平台 + 真实注册主机上报 `projectsRoot` + 真实心跳 + 真实 TLS Runtime + 真实 bare git + 真实 `cloud:createProject` handler）：开发者创建 → checkout 真实位于 `projectsRoot/<key>`、README 一致 → 心跳后平台 `ready` → `planCloudProjectRepos`/真实 `repo.add` 生成侧栏行。
- 组件测试：对话框（打开/关闭、无主机禁用、成功回调）+ 入口按钮共存。

**主会话独立验收**：11 个相关 vitest 文件 **48 条全过**；平台 e2e 10 条全过；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：去掉 `POST /v1/projects/self` 的 `path` 拒绝 → 2 条用例变红（显式 path 与配额用例，路径冲突掩盖了上限判定）；恢复后 10/10 绿。子代理另有对照：把路径推导改成 `${root}/../escape` → 3 条变红（POSIX/Windows 路径与限额），恢复后全绿。

**如实记录 / 剩余**：
1. 创建成功但**准备失败**（仓库地址错等）时平台项目已存在、对话框显示错误且不关闭；该项目的失败不会进入 M58 的重试横幅，需重新登录后走注册失败路径或改名重建。这是后续 UX 改进点。
2. 多主机时要求显式选择，未做“记住上次主机/默认主机”偏好。
3. Windows 根目录路径推导有平台 e2e 覆盖，但未在真实 Windows 主机跑 clone。
4. 新建对话框仅 happy-dom 组件测试，未做真实 Electron 渲染截图。
5. 自助项目全局 key 唯一（跨主机也不能重名），避免平台 key 语义不一致；用户需改名。
6. `server.ts`（1813 行）为既有大文件，本次新增 180 行；新增文件均 ≤300 行。

## M60 创建成功但准备失败的项目并入重试横幅（本轮，开发子代理执行）

**问题**：M59 的创建对话框里，平台创建成功但 `prepareProjectEnvironment` 失败（典型：仓库地址错）时 IPC 只返回 `{ ok:false, code }`，**不带 projectId**。结果项目已在平台上存在，却既不在侧栏也不在 M58 失败横幅：对话框停在错误上，管理员修正 `repoUrl` 后用户也无法重试。

| 改动 | 内容 |
|---|---|
| `shared/cloud-platform-ipc.ts` / `main/ipc/cloud-platform.ts` | `CloudCreateProjectResult` 失败分支增加可选 `projectId`、`project`（仅“平台已创建、准备失败”）；handler 失败时回填 `{ projectId, project }` |
| `renderer/cloud-created-project-failure.ts`（新） | 把“已创建但准备失败”的返回值映射成 `CloudProjectFailure`；前置失败（主机/key/配额）返回 `null` 仍内联 |
| `renderer/cloud-new-project-dialog.tsx` | 回调统一为 `onCreated(result)`：带 `projectId` 的失败交给入口并**关闭**对话框；不带者仍内联报错保持打开 |
| `renderer/cloud-workspace-entry.tsx` + `cloud-entry-workspace-sync.ts` | 失败条目按 projectId 去重并入 `failures` 并 `toast.error`；成功项目的同步/打开逻辑抽到 sync 模块（入口保持 300 行） |

**验证（`evidence/m60-create-failure-recovery/`）**：真实端到端 1 条（真实平台 + 注册主机/心跳 + TLS Runtime + bare git + 真实 `cloud:createProject` handler）：坏 `repoUrl` 创建 → 返回 `ok:false, code: CLONE_FAILED` 且**带 projectId 与项目摘要** → 心跳后平台 `failed` → 管理员 `PUT` 修正 → 真实 `cloud:retryPrepare` → checkout 存在、README 一致 → 心跳后 `ready` → `planCloudProjectRepos` 生成侧栏行。组件测试：带 projectId 的失败交回调并关闭、无 projectId 仍内联、创建失败条目进横幅且重试后消失。

**主会话独立验收**：7 个相关 vitest 文件 **29 条全过**；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307（同一底层问题，首个 importer 换成了新测试文件）；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让 handler 在准备失败时返回裸 `prepared`（丢掉 projectId）→ 新 e2e **变红**（`expected null not to be null`），恢复后 1/1 绿。

**如实记录 / 剩余**：
1. 创建失败但仍留在平台的项目**名字/key 已占用**，用户重试前不能复用同名；改名重建需另开项目（本轮不做“删除/重命名项目”）。
2. 对话框关闭后靠 toast 与底部横幅说明，未做逐项目状态图标。
3. 组件测试用 bridge 打桩；真实 IPC 全链路只由 e2e 覆盖。

## M61 云端会话自动续期（本轮，开发子代理执行）

**问题**：平台 access token TTL 30 分钟、refresh token 12 小时（滑动、旋转），但桌面客户端 `CloudConnectClient.login` **直接丢弃 `refreshToken`**，所有平台请求只带 access token。登录 30 分钟后，任何需要新票据/项目列表的操作都 401 `SESSION_EXPIRED`，用户只能重新登录——长会话不可用。

| 改动 | 内容 |
|---|---|
| 平台 `server.ts` | `ApiConfig.accessTtlMs`/`refreshTtlMs`（测试可缩短，入口支持 `ORCA_CLOUD_ACCESS_TTL_MS`/`ORCA_CLOUD_REFRESH_TTL_MS`）；登录与刷新响应新增 `expiresIn`（秒）。刷新时**保留旧 refresh token 映射**，使旧 token 重放命中 `refreshHash` 不匹配分支并作废整个会话（旋转 + 盗用检测） |
| `cloud-auth-session.ts`（新）/ `cloud-authorized-request.ts`（新） | 每个登录一份共享凭据对象：提前 60s 刷新、单飞、失败锁定 `SESSION_EXPIRED`、无 `expiresIn` 的旧平台按 401 刷新；所有平台请求先 `ensureFresh()`，401 时强制刷新并**只重试一次**；只暴露不可逆指纹用于诊断 |
| `cloud-connect-client.ts` / `cloud-project-connections.ts` / `cloud-self-service-api.ts` | `CloudDeviceIdentity` 携带共享 `auth`（所有 fork 的项目连接看到同一次刷新）；握手逻辑抽到 `cloud-socket-handshake.ts` 保持单文件 ≤300 行 |
| `cloud-session-service.ts` | 任何平台调用 `SESSION_EXPIRED` → `logout()` 关闭全部连接并推送 `{closeCode:4401, reason:'session_expired'}`；并发失败只登出一次 |
| `renderer/use-cloud-session.ts` + `cloud-close-notice.ts` + 登录面板 | 收到 `session_expired` 重新读取主进程状态（已 signed-out）回到登录页，显示“登录状态已过期，请重新登录。” |

**验证（`evidence/m61-session-renewal/`）**：
- 平台 e2e 2 条（真实 `createApp` + HTTP）：短 TTL 过期 → 401 `SESSION_EXPIRED` → 刷新成功且新 token 可用 → **旧 refresh token 重放 → 401 且新 token 一并失效**；refresh TTL 过期 → 401。
- 主机端到端 1 条（真实平台进程 `accessTtlMs: 1200` + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 bare git）：等 access token 过期后 `ensureWorkspace` **仍成功**（内部刷新 2 次，access/refresh 指纹均变化，票据与真实 checkout 正常）；随后该用户会话被另一登录撤销 → `prepareProjectLink` 返回 `SESSION_EXPIRED`、`getState()` 为 `signed-out`、连接清空、收到 `4401/session_expired`。
- 单测 8 条（提前刷新阈值、单飞、失败锁定、旋转、旧平台无 `expiresIn`）+ 渲染钩子用例（`session_expired` → signed-out + notice）。

**主会话独立验收**：11 个相关 vitest 文件 **49 条全过**；平台 e2e **全套 89 条全过**（16 suites）；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让 `cloudAuthorizedFetch` 在 401 后不刷新不重试（直接返回首个响应）→ renewal e2e **变红**（`expected { ok: false } to match object { ok: true, route: 'direct' }`），恢复后 1/1 绿。

**如实记录 / 剩余**：
1. **仅桌面主进程**做了续期；管理员浏览器会话页（`src/renderer/src/web/*`）仍无刷新流程，30 分钟后回到登录页。
2. refresh token 只在内存，**进程重启需重新登录**（未落盘，避免新增凭据文件）。
3. 刷新失败的判定较粗：任何刷新错误（含瞬时网络抖动）都视为 `SESSION_EXPIRED` 并登出，可能在弱网下放大影响；仍符合“宁可让用户重登，不可长期半死”的取向。
4. 旧 refresh token 映射为支持重放检测而保留，未按会话清理；条目数受刷新次数约束（每会话每 30 分钟一条，12 小时内 ≤24）。
5. 会话过期时主进程直接 `logout()`，未走 IPC 层的 `removeCloudRuntimeEnvironments`；重新登录时 `registerProjects` 会按 projectId 覆盖环境，但登出瞬间侧栏环境记录残留（界面已切回登录页，不可见）。

## M62 浏览器云端会话续期（本轮，开发子代理执行）

**问题**：M61 只给桌面主进程做了续期。浏览器侧（Orca Web + 管理员会话页共用 `src/renderer/src/web/`）保存了 `refreshToken` 却从不使用：30 分钟后 `listCloudProjects` / `requestCloudTicket` 全部 401 `SESSION_EXPIRED`，管理员会话页与浏览器工作区只能重新登录。

| 改动 | 内容 |
|---|---|
| `web-cloud-auth.ts`（新）/ `web-cloud-authorized-request.ts`（新）/ `web-cloud-error.ts`（新）/ `web-cloud-request.ts`（新） | 每次登录一份 auth：提前 60s 刷新、401 强制刷新、单飞、失败锁定 `SESSION_EXPIRED`、无 `expiresIn` 时按 401 刷新；指纹用 FNV（浏览器无 `node:crypto`）。授权请求先 `ensureFresh`，401 后**只重试一次** |
| `web-cloud-session.ts` | `WebCloudSession` 增加 `expiresIn`/`auth`；`loginToCloud` 读取平台新字段并建 auth；列表/取票走授权请求，**无 auth 的旧会话行为不变** |
| `cloud-browser-bridge.ts` + `cloud-browser-bridge-replies.ts`（新） | 平台调用 `SESSION_EXPIRED` → 关闭全部连接、清 session/identity、置 signed-out、**一次性**发 `{closeCode:4401, reason:'session_expired'}`（并发过期只发一次）；bridge 保持 ≤300 行 |
| tsconfig | 新 e2e 归入既有 `config/tsconfig.cloud-e2e.json`（与另外 6 个 web e2e 同一做法，未改工程边界） |

**验证（`evidence/m62-web-session-renewal/`）**：
- 真实端到端 1 条（真实平台 `accessTtlMs: 1200` + 真实注册主机 + 真实 TLS Runtime + 真实 Ed25519 票据 + 真实 WSS）：登录 → 等到客户端估算仅剩 ~500ms（服务端已过期）→ `listCloudProjects` 与 `requestCloudTicket` **仍成功**（access/refresh 指纹均变化，票据可用于真实 WSS）→ 用该用户 token `/v1/auth/logout` 作废会话 → 下一次取票抛 `SESSION_EXPIRED`。
- 单测：提前阈值、无 `expiresIn` 不提前请求、单飞、旋转、失败锁定、网络异常；session 401 刷新重试成功后不二次刷新；bridge 过期时关连接、signed-out、只发一次 4401、只刷新一次。
- 回归：4 个 web 云端 e2e（8 条）全过；6 个相关 vitest 文件 46 条全过。

**主会话独立验收**：6 个 vitest 文件 **46 条全过**；4 个 web e2e **8 条全过**；`tsc tc.web` 0 错、`tsc cloud-e2e` 0 错；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让 `authorizedRequest` 在 401 时直接抛 `SESSION_EXPIRED`（不刷新不重试）→ renewal e2e **变红**，恢复后 1/1 绿。

**如实记录 / 剩余**：
1. 浏览器没有保活定时器：标签页休眠恢复时靠 `ensureFresh` 或首个 401 刷新，多一次往返。
2. refresh token 只在内存，**刷新页面/重载需重新登录**；Orca Web 的会话持久化不在本轮范围。
3. 刷新成功但平台持续 401 时不锁定（只有刷新失败才结束会话），会每次重试一次刷新——可接受，但极端情况下多打平台。
4. e2e 依赖本地 `openssl` 与真实平台进程（沿用既有 harness）。

## M63 主机清理云设备 token（断连释放 + 重启清理）（本轮，开发子代理执行）

**问题**：云会话在主机设备注册表里每个 `(deviceId, token)` 一行，`adoptCloudDeviceInList` 只在新票进入时按 4 行上限淘汰。因此 socket 关闭后死 token 仍留在注册表（`validateToken` 仍认可），并且 `load()` 通过 `validCloudSession()` 把 `cloudSession` 行从磁盘加载回来——重启后没有任何 live socket，这些死票却继续被承认，直到被新票挤掉。

| 改动 | 内容 |
|---|---|
| `device-registry.ts` + `device-registry-cloud-rows.ts`（新） | `releaseCloudDeviceToken(token)`：只删除 `token` 匹配且 `cloudSession !== undefined` 的行（paired/mobile 行永不匹配），先 `save` 后换内存；`countCloudTokens()` 便于诊断/测试 |
| `device-registry-load.ts`（新） | 注册表读取/归一化抽出；**重启即丢弃全部 `cloudSession` 行**并在丢弃时立即写回（不可读文件仍拒写，沿用既有保护） |
| `runtime-rpc-lifecycle.ts` | `onClose` 且无同 token 其它连接时调用释放；持久化失败只记日志，不打断其它 close 清理 |
| `device-registry-entry-validators.ts` | 逐行归一化抽为 `normalizeDeviceEntry`，给注册表腾出行数预算（max-lines 按非空行计，原文件仅余 6 行） |

**验证（`evidence/m63-cloud-device-release/`）**：单测 3 条（只删云行、持久化、重启丢弃并写回、不可读不写）+ 真实端到端 1 条（真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 git + `ensureWorkspace` 打开真实 WSS）：
云 token 计数 `0 → 1（打开）→ 0（关闭）→ 1（重开）→ 0（重启加载）`；paired 设备行 `2 → 2 → 2` 始终不变，关闭后 paired token 仍有效、云 token 已失效；重启后磁盘 `cloudSession` 键为 0、paired token 仍有效。

**主会话独立验收**：8 个相关测试文件 **21 条全过**（含 multi-project / revocation / session-limits / mobile-socket-wiring / renewal）；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：移除 `onClose` 中的释放调用 → e2e **变红**（`expected 1 to be +0`，关闭后计数未归零），恢复后 4/4 绿。

**如实记录 / 剩余**：
1. 断线即释放：已确认客户端连接始终重新取票（`prepareProjectLink` → `requestTicket`），不存在复用旧票重连的路径；旧票重试会被拒（预期内）。
2. 重启模拟在同一测试进程内完成（关闭旧 runtime → 恢复崩溃快照 → 新 runtime 加载），未重启真实 Electron 进程。
3. 释放时若持久化失败（磁盘只读等）只记日志，token 留在内存直到重启；重启清理的写回失败同理，但内存已丢弃死票、不会放行。
4. 未改移动端配对、revocation（4403）与云端 admission 语义；WSL/SSH 主机未单独验证（逻辑在 runtime 进程内，与执行主机无关）。

## M64 签到准备有界并行化（本轮，开发子代理执行）

**问题**：登录后 `cloud:registerProjects` 逐个串行准备每个项目（provision → 取票/选路 → 注册环境），侧栏出现时间等于**所有项目准备时间之和**；含未克隆大仓库时首屏被长时间拖住。不能简单整段并行：`registerCloudRuntimeEnvironment` 是 sidecar 的读-改-写，并发调用会互相覆盖。

| 改动 | 内容 |
|---|---|
| `src/shared/bounded-parallel-map.ts`（新） | 有界并行映射：结果按输入顺序返回 `PromiseSettledResult[]`，在飞任务数 ≤ limit（`limit<1` 视为 1），失败按槽位隔离 |
| `src/main/cloud-platform/cloud-project-preparation.ts`（新） | 拆成 `prepareCloudProjectLink`（provision + 取票/选路，含一次重试，**不写环境**）与 `registerPreparedEnvironment`（写 sidecar）；`prepareProjectEnvironment` 保持两段串行组合（单项目路径不变）；`registerProjectEnvironments` = 有界并行准备 → **按原始顺序串行注册**，默认并发 3 |
| `src/main/ipc/cloud-platform.ts` | 处理器瘦身到 234 行，`registerProjects` 委托编排器；新增可选 `prepareConcurrency` 注入（测试/调参） |

**验证（`evidence/m64-parallel-prepare/`）**：真实端到端 1 条（真实平台进程 + 真实注册主机/心跳 + 真实 TLS Runtime + 3 个真实 git 项目，其中 1 个 repoUrl 指向不存在路径）：真实 `cloud:registerProjects` handler，spy `ensureProjectPrepared` 记录真实调用区间（仍在区间内执行真实 clone/取票）→ 最大重叠 2（= 注入上限），区间真实交叠；`environments` 按 `state.projects` 顺序、只含 2 个成功项目；`failures` 只含坏项目且 `code: CLONE_FAILED`、目标目录未残留；成功项目 README 与源一致、`rev-parse --show-toplevel` 等于自身。另有 pool 单测（在飞上限、顺序、空数组、limit<1、失败隔离）。

**主会话独立验收**：10 个相关测试文件 **25 条全过**（含 repo-registration / provision-recovery / self-service / create-failure / device-release / multi-project / 入口组件）；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：把编排器并发强制为 1（等价于串行）→ e2e **变红**（`expected 1 to be greater than or equal to 2`），恢复后 1/1 绿。

**如实记录 / 剩余**：
1. N 个项目按 `ceil(N/limit)` 波次完成：某个特别慢的仓库仍决定其所在波次的墙钟时间；未做自适应并发。
2. 并发会同时开多个一次性项目 socket/取票；默认 3 远低于主机 32 会话上限，但提高上限前需要按平台/主机限流复核。
3. 注册阶段（sidecar 写入）在所有准备完成后串行执行，尾段仍是 O(N)（很小）。
4. 任务**抛出**异常（不同于 `{ok:false}`）仍会中断整次 `registerProjects`，保持 M58 之前的行为。
5. 并发证明依赖测试侧在真实调用外包 150ms 的观测窗口（真实 clone 太快不足以稳定交叠）；串行实现下该断言必然失败，负向对照已验证。

## M65 项目归档闭环（本轮，开发子代理执行 + 主会话修正）

**问题**：平台早就有 `POST /v1/projects/:id/archive|/restore`（admin-only，archive 会写项目撤销），但没有闭环：归档项目**永久占用 key 与路径**（自助/管理员建项目判重都遍历含 archived 的项目）；restore 无条件置 `ready`（带 `repoUrl` 且从未克隆的项目恢复后被当成已就绪）；restore 不防撞车；创建者不能归档自己的项目；客户端在项目归档后**不清理**已注册的 runtime environment 与侧栏 repo 行。

| 改动 | 内容 |
|---|---|
| `cloud-platform/apps/api/src/project-occupancy.ts`（新） | `projectKeyTaken`/`projectPathTaken` 只统计非 archived 项目；`isProjectCreator`。管理员/自助创建统一使用 |
| `server.ts` | archive：释放 `projectsByKey`、幂等、写 `revokeProjectCredentials('project_archived')`；restore：`repoUrl` 非空 → `provisioning`（否则 `ready`）、清 `provisioningError`、key/path 被占用 → 409 + failure 审计、成功后重占 key；archive/restore 允许**管理员或创建者**，其它人 404；archived 项目除 archive/restore 外一律 404 |
| `server.ts`（主会话修正） | `GET /v1/projects` 默认**不返回** archived（管理员也一样），新增 `?includeArchived=1`（仅管理员）给管理台；`apps/web/app.js` 改用该参数。理由：原生桌面端用同一接口注册环境，若管理员看到 archived 会把历史项目当成活跃项目去准备 |
| `cloud-connect-client.ts` / `cloud-session-service.ts` / IPC / preload | `archiveProject(projectId)`：归档 → 关闭该项目连接 → 刷新列表；IPC 删除运行时环境并返回 `environmentId` |
| `cloud-runtime-environment.ts` / `cloud-project-preparation.ts` / `registerProjects` | `removeStaleCloudRuntimeEnvironments`：签到注册后清理不在可见项目集合里的云环境，`CloudProjectRegistration` 新增 `removedEnvironmentIds` |
| `renderer/cloud-workspace-entry.tsx` | 收到 `removedEnvironmentIds` → `purgeStaleRuntimeHostState` 清掉侧栏行；对外暴露 `archiveProject` 能力（未新增按钮） |

**验证（`evidence/m65-project-archive/`）**：
- 平台 e2e 5 条（真实平台进程）：创建者归档自己的项目 200、非创建者 404、管理员可归档他人；归档后创建者列表/详情均不可见，管理员默认列表也不可见、`includeArchived=1` 可见且 `status: archived`；同 key 再建 201（新 id）而对活跃 key 仍 409；restore 撞 key → 409 `PROJECT_KEY_TAKEN`，撞车解除后 restore → `provisioning`；archive 写入项目撤销（internal revocations 可查）。
- 真实端到端 1 条（真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 bare git + 真实 `cloud:archiveProject`）：归档后该项目的 **live WSS 会话在 9.4s 被主机以 4403 关闭**、侧车环境已删除、管理员状态 archived/详情 404、`cloudProjectReposOnHosts` 选中该行；同 key 重建成功（见限制 1）。
- 回归：10 个相关 vitest 文件 **36 条全过**；平台 e2e **全套 94 条全过**；`tsc tc.web` 0 错、`tsc node` 仅 2 条既有 TS6307；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：子代理把归档权限改回仅管理员 → 平台 e2e 5/5 全红（创建者归档 404），恢复后全绿。主会话另发现并修正了管理员列表泄露 archived 的问题（见上表第 3 行），并同步改了 `admin-gating` 用例与真实 e2e fixture 的列表参数（`admin-gating` + `project-archive` 18 条全过）。

**如实记录 / 剩余**：
1. **主机目录不回收**：归档只删平台记录，`projectsRoot/<key>` 目录仍在。同 key 重建时该目录仍是 git 仓库，provisioning 判定“已准备”，因此**复用旧 checkout**（`oldCheckoutSurvived: true`、`reborn.ok: true`），而不是全新克隆。是否删除用户磁盘必须由用户/管理员显式决定，本轮不自动删。
2. 路径冲突判定不区分主机（沿用自助创建既有语义）：不同主机上的同路径项目也算冲突。
3. 未新增归档按钮；能力通过 `useCloudWorkspaceEntry().archiveProject` 暴露。
4. 管理台（`apps/web`）通过 `includeArchived=1` 看到归档项目以便恢复；原生云会话列表默认不含。
5. 归档后侧栏行的清理只在下次签到注册或显式调用时发生；若归档由管理员在平台侧完成，当前已登录会话在主机刷新周期内收到 4403 关闭，但侧栏行要等重新注册。

## M66 云端会话持久化（桌面重启 / 浏览器重载免登录）（本轮，开发子代理执行）

**问题**：M61/M62 只做了进程内续期，refresh token 仅在内存：桌面重启、浏览器刷新后都必须重新登录（两轮 PROGRESS 都记为遗留）。用户要的是“打开即用”。

| 改动 | 内容 |
|---|---|
| 桌面 `cloud-session-persistence.ts`（新） | `orca-cloud-session.json` 存 access/refresh token、deviceId、**device secret key**、显示名、apiUrl；形状校验、apiUrl 不匹配即忽略、`writeSecureJsonFile` + 权限收紧、删除。密码从不落盘 |
| 桌面 `cloud-session-saved-login.ts`（新）/ `cloud-session-service.ts` | `restoreSession()`（单飞）在启动后台执行：读文件 → 用**已存 secret key** 重建身份 → `listProjects()` 验证（401 走 M61 刷新）→ signed-in；`SESSION_EXPIRED` 删文件，网络错误保留文件；`whenRestored()` 让首个 `cloud:state` 等恢复完成；登录写盘、登出/会话失效清盘、轮换写回 |
| `cloud-auth-session.ts` / `web-cloud-auth.ts` | 新增 `onTokensChanged`，刷新轮换成功后回调（写盘失败只 warn，不影响已成功的请求） |
| 浏览器 `web-cloud-session-storage.ts`（新）/ `web-cloud-session-restore.ts`（新）/ `cloud-browser-bridge.ts` | localStorage 存会话（**不重复存设备 key**，复用 `web-cloud-device-key`）；`getState()` 首次惰性恢复；login/logout/会话失效写清；token 轮换写回 |
| 拆分（保持 ≤300 行） | `cloud-session-project-admin.ts`、`cloud-browser-saved-session.ts`、`cloud-browser-project-connections.ts`、`cloud-browser-bridge-unsupported.ts`；`e2ee-crypto` 增加 `keyPairFromSecretKey` |

**验证（`evidence/m66-session-persistence/`）**：
- 桌面真实端到端：真实平台（access TTL 1200ms）+ 真实注册主机/心跳 + 真实 TLS Runtime + 真实 git；登录 → **同 userDataPath 三次新建服务实例**每次 `restoreSession()` 都 signed-in 且 deviceId 始终一致（证明密钥复用 + 轮换 token 已写回）→ 平台作废会话后第四次恢复为 signed-out 且**文件已删除**。
- 浏览器真实端到端：登录 → 同 storage 新建 bridge `getState()` → signed-in、列项目、真实 TLS Runtime 打开工作区；作废后新 bridge 为 signed-out 且存储已清除。
- 单测：桌面存储 5 条（往返/malformed/apiUrl 不匹配/权限位/删除）+ 浏览器存储 4 条。
- 回归：14 个相关测试文件 **57 条全过**（含 renewal、auth、service、connect-client、provision-recovery、browser-bridge、入口组件）。

**主会话独立验收**：14 个 vitest 文件 **57 条全过**；`tsc node` 仅 2 条既有 TS6307、`tsc tc.web` 0 错；`check:code-quality:changed` 0 新发现；证据中不含 token/refreshToken/密码。

**主会话独立负向对照**：让 `cloud-auth-session` 的轮换不再写回 → 桌面重启 e2e **变红**（`expected 'signed-out' to be 'signed-in'`），恢复后 1/1 绿。子代理另有浏览器对照：跳过 `getState()` 恢复 → 重载 e2e 变红。

**如实记录 / 剩余**：
1. **浏览器 localStorage 可被同源脚本（XSS）读取**；这是管理页/内网工具的明确取舍，token 不进 URL、日志、证据。若将来做公网部署，应改用 HttpOnly cookie 或短期一次性码。
2. 桌面首屏：`cloud:state` 等待恢复完成，网络慢时登录态判定会延迟；启动本身不被阻塞（后台恢复）。
3. 平台换 `apiUrl` 时旧文件保留但被忽略，必须重新登录。
4. 设备 key 存储被单独清空而会话文件仍在时，能恢复登录态，但后续取票/打开工作区会失败（会话文件不重复存 key）。
5. 轮换写盘失败只 warn：请求不受影响，但下次重启可能需要重新登录。
6. Windows 无法断言 POSIX 权限位，该断言在非 POSIX 平台跳过。

## M67 云端会话真实执行 `agent.launch`（本轮，开发子代理执行）

**问题（M44 起一直记录的遗留）**：云端桌面会话**永远无法**调用 `agent.launch`。分发器把 `clientKind: device.scope` 传给方法上下文，云设备 scope 是 `'runtime'`；而 `supportsAgentLaunch` 要求 `clientKind === undefined` 或 E2EE 认证里声明 `agent.launch.v2`。云客户端 `e2ee_auth` 只发 `{type, deviceToken}`，从不声明能力 → 每个云会话都得到 `agent_launch_unsupported`。M44 只验证了“在自己工作区应被允许”的路径被边界拦截，真实执行从未发生。

| 改动 | 内容 |
|---|---|
| `cloud-socket-handshake.ts` | `e2ee_auth` 增加 `clientCapabilities: ['agent.launch.v2']`（`CLOUD_RUNTIME_CLIENT_CAPABILITIES`）。只声明 v2：桌面原生云工作区两种结果都能渲染；replay/prompt-carry 属于本传输未协商的独立契约，不能替主机宣称 |
| `cloud-agent-launch-execution.test.ts` + fixture（新） | 真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 managed worktree + 真实 PTY（假 `claude` CLI 经 `agentCmdOverrides` 注入，不改全局 PATH） |

**修复前/后对比（`evidence/m67-cloud-agent-launch/`）**：
- `m67-0`：修复前 `agent.launch` → `{ok:false, code:'runtime_error', message:'agent_launch_unsupported'}`。
- `m67-1`：修复后 `outcome.kind === 'terminal'`、真实 `terminal` handle；PTY 输出含假 CLI 唯一标记 `M67_FAKE_CLAUDE_STARTED` 与本人 checkout 的 `realpath`（证明 cwd 正确）；同一 handle 再经云端 `terminal.read` 读到标记。
- `m67-2`：共享检出与他人仓库仍 `forbidden` + `workspace root`（边界未降低）。
- `m67-3`：用真实票据做一次**不带 clientCapabilities** 的 legacy 握手 → 仍 `agent_launch_unsupported`（常驻负向对照）。

**主会话独立验收**：6 个相关测试文件 **41 条全过**（含 agent boundary/scope/permission、renewal、mobile socket wiring）；`tsc node` 仅 2 条既有 TS6307；`tsc tc.web` 0 错；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：移除 `e2ee_auth` 里的 `clientCapabilities` → M67-1 **变红**（`agent_launch_unsupported`），M67-2/3 仍绿；恢复后 3/3 绿。

**如实记录 / 剩余**：
1. **假 CLI ≠ 真实 Claude**：用 `agentCmdOverrides.claude` 注入临时脚本，仍走真实启动命令构建、真实 node-pty、真实 runtime；但不覆盖 Claude 的信任询问、登录、TUI 就绪检测。
2. **结构化会话路径未验证**：测试关闭 native chat，host 走终端 agent；`agent.launch.v2` 声明覆盖“两种结果都可渲染”，但结构化 outcome 未端到端跑通（需要真实 Claude 会话宿主）。
3. Windows 未验证（PTY 控制器用 `/bin/sh -c`）。
4. 若云客户端将来切到 E2EE v2 握手（`e2ee_hello.v === 2`），v2 认证消息是严格键集形状，新增的 `clientCapabilities` 会被拒；当前云客户端固定 legacy 握手，不受影响，但切换时需同步契约。

## M68 里程碑收口（L3）（本轮，主会话执行）

按 `DEVELOPMENT_PROCESS.md` §4.1 分级执行：先看负载（10 核，1 分钟负载 4.3–5.2，低于半数阈值 5 之外仅瞬时越线），全部命令带并发上限，不使用全量 L4。

| 批次 | 命令 | 结果 |
|---|---|---|
| 平台 e2e | `cd cloud-platform && node --test --test-concurrency=4 test/e2e/*.e2e.test.ts` | **94/94 通过**（17 suites，26.6s） |
| 平台单元/契约 | `cd cloud-platform && node --test --test-concurrency=4 test/*.test.ts` | **25/25 通过** |
| 云端主进程模块 | `vitest run --maxWorkers=4 src/main/cloud-platform/` | **51 文件 / 260 条全过**（38.2s） |
| 渲染/Web/共享云模块 | `vitest run --maxWorkers=4 src/renderer/src/cloud/ src/renderer/src/web/web-cloud src/shared/cloud- src/shared/bounded-parallel-map.test.ts` | **23 文件 / 114 条全过**（8.7s） |

**类型检查（四个工程，逐个串行执行，未与测试并行）**：`tsc node` **0**、`tsc tc.web` **0**、`tsc cloud-e2e` **0**、`tsc tc.cli` **0**。

**本轮修复（收口时发现的既有门禁债）**：`config/tsconfig.node.json` 长期有 2 条 TS6307（云跨边界主进程测试 import 渲染模块 / 平台 credential 孪生文件不在工程内）——与 M56 同样处理：
- 5 个 import 渲染模块的主进程云测试（create-failure / project-archive / provision-recovery / repo-registration / self-service）**改由 `tsconfig.cloud-e2e.json` 拥有**（node 工程 `exclude`，cloud-e2e 增列 `cloud-project-repos.ts`）；
- node 工程 `include` 平台 `packages/contract/src/credential.ts`（仅此一个依赖无关的文件，未放宽 `internal-fetch.ts` 等其余平台代码）。
→ `tsc node` 由 2 条基线错误变为 **0**，没有放宽任何检查。

**证据目录核对**：`cloud-platform/evidence/` 共 **63 个目录，无空目录**；m41–m68 每个模块目录都有 JSON/日志证据，本轮结果写入 `evidence/m68-milestone-l3/m68-milestone.json`。

**质量门禁**：`check:code-quality:changed` 0 新发现（409 个变更文件）。

**如实记录 / 剩余**：
1. 本轮是 **L3 里程碑级**，不是 L4 全量：未跑整个仓库（`pnpm test` 全量 / 全部 renderer 套件）。桌面 Electron 真实界面（截图/交互）仍未做，UI 覆盖为 happy-dom 组件测试 + 真实平台/TLS/git e2e。
2. Windows / WSL / SSH 主机未实机验证（PTY、路径、权限位、conhost 行为）。
3. 结构化 agent 会话（native chat）outcome 未端到端验证，仅终端 agent 路径（M67）。
4. 浏览器 localStorage 存 token 的 XSS 暴露面（M66）与主机目录不回收（M65）是已记录的产品取舍。
5. 平台 e2e 用 `--test-concurrency=4` 而非默认并发，属按 §4.1 的主动限流。

## M69 云端结构化 agent 会话（native chat）端到端验证（本轮，开发子代理执行）

**问题**：M67 只验证了终端 agent outcome；`agent.launch.v2` 的语义是“客户端两种 outcome 都能渲染”，而**结构化会话在云端会话下从未真正可读**。本轮用本机真实 Claude CLI（2.1.316，已登录；`ORCA_REAL_CLAUDE_CLI_TEST=1` 门禁）做探针，发现一个真实缺陷。

| 项 | 结果 |
|---|---|
| 探针（修复前） | 云端 `agent.launch` **能**返回 `outcome.kind: 'structured'` 并拿到 sessionId，但随后 `agentSession.history` / `options` / `close` **全部**返回 `structured_agent_session_unsupported`——即“宣称能渲染 chat，却读不到刚创建的 chat” |
| 根因 | `cloud-socket-handshake.ts` 的 `CLOUD_RUNTIME_CLIENT_CAPABILITIES` 只有 `agent.launch.v2`；host 的 `requireStructuredCapability` 因缺少 `agent-session.structured.v1` 拒绝全部 `agentSession.*` |
| 修复 | 客户端能力表补齐：`agent-session.structured.v1`、`agent-session.structured.claude.v1`、`agent-session.turn-item.v1`、`agent-session.options.optional-model.v1`（桌面壳渲染这些形状；replay/prompt-carry 仍不宣称，注释保留理由） |
| 测试 | `src/main/cloud-platform/cloud-structured-agent-session.test.ts`（184 行，门禁 skip 时标题写明原因）+ fixture 暴露 `store` 以便切换 launch mode 与还原真实 CLI |

**验证（`evidence/m69-cloud-structured-agent/`）**：
- `m69-probe.json`：修复前/后对比（三条 `structured_agent_session_unsupported` → 全部成功）。
- `m69-structured.json`：真实云端会话 structured launch → sessionId 归属本人 worktree → `history` 命中（user 1 / assistant 1）→ 真实 turn 1.7s 内出现 assistant 文本 → `agentSession.close` 清理。
- `m69-boundary.json`：对**共享检出**的 structured launch 仍 `forbidden`（`Writes are limited to your own workspace root inside this project.`）。

**主会话独立验收**：设门禁运行 3 个文件 **9 条全过**（M69 2 条 + M67 3 条 + M44 边界 4 条）；不设门禁时 M69 为 skip；`tsc node` **0**、`tsc tc.web` **0**；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：
1. 只保留 `agent.launch.v2`（去掉 `agent-session.structured.v1`）→ M69 **变红**（`structured_agent_session_unsupported`），恢复后绿。
2. 只去掉 `claude`/`turn-item`/`optional-model` 三项、保留基础项 → 当前断言**仍通过**（如实记录：这 3 项只影响 host 的降级形状与模型选择呈现，现有断言不覆盖；它们仍按“桌面壳能渲染”宣称）。

**如实记录 / 剩余**：
1. 真实 CLI 用量超出原定“1–2 个 turn”：探针 2 次 launch + 正式测试 2 次 turn（均完成回复）。
2. 断言只要求“出现非空 assistant 文本”，未断言内容等于 `pong`。
3. 结构化会话依赖本机已登录的真实 Claude；CI 默认 skip（门禁保护），因此该项在无凭据环境不会被自动执行。
4. 云端客户端能力表扩大到结构化读取面：云端会话现在可读/关闭结构化会话，工作区边界不变（共享检出仍 forbidden）。

## M70 验收标准映射与缺失项真实验证（本轮，验证子代理执行 + 主会话复核）

**问题**：`requirements.md` §8 有 AC-01…AC-32，`DEVELOPMENT_PROCESS.md` G8 要求「每条验收标准有通过证据」，但仓库既无 `test-plan.md`，也没有任何 AC → 测试/证据映射；早期 `test-reports/automated-test-report.md` 只覆盖最初模块。无法判断哪些验收标准真的通过。

| 产出 | 内容 |
|---|---|
| `test-plan.md`（新） | 分级策略（引用 §4.1）、测试数据/环境、**AC-01…AC-32 逐条映射**（测试文件::用例 + 证据路径 + 结论）、不可验证项与前置条件、执行命令。映射只认用例里的断言，不按测试名推断 |
| `test-reports/acceptance-2026-11-13.md`（新） | 本轮真实执行结果、产品缺口（BLOCKER/MAJOR/MINOR）分级、结论 |
| `m70-acceptance.e2e.test.ts`（新，294 行） | AC-01（50 次采样 P95）、AC-02（注入时钟验证 15 分钟锁定）、AC-03（存在性不泄露）、AC-04（授权后可见）、AC-08（心跳超时）、AC-25（吊销后令牌失效） |
| `src/main/cloud-platform/m70-acceptance.test.ts`（新，145 行） | AC-09：真实平台进程 + 真实 Orca Runtime + 真实加密 RPC 验证维护模式拒绝新连接 |
| `platform.e2e.test.ts` E3 | 加强为必须 `401` 且 `x-orca-reject` 非空（AC-21） |

**映射结论**：**PASS 7**、**PASS(部分) 17**、**UNVERIFIED 8**（AC-14/19/22/23/26/29/31/32，均写明前置条件，不伪造）。

**本轮真实执行（`evidence/m70-acceptance/`）**：`m70-acceptance.e2e.test.ts` **6/6**、`m70-acceptance.test.ts` **1/1**、`platform.e2e.test.ts::E3` **1/1**；`tsc node` 0、`tsc tc.web` 0、`check:code-quality:changed` 0 新发现。主会话独立复跑平台 6 条与真实 Runtime 1 条，均通过。

**本轮发现的缺口（已写入验收报告，未在本轮修复）**：
- **BLOCKER ×4**：G-01 主机吊销通知不到已登记主机（`DELETE /v1/hosts/:id` 清空 `credentialHash` → 下次心跳 401 → 主机拿不到撤销集合 → 已建会话不会 60 秒内断开）；G-02 无 4433 公钥固定；G-03 无签名密钥轮换/旧钥保留；G-04 审计链单进程单文件、不支持多副本并发。
- **MAJOR ×6**：心跳超时后项目仍显示 online 且「打开」未禁用（G-05）；AC-27 文档「读允许」与真实主机跨工作区读取被拒不一致（G-06）；文档错误码 `PATH_OUTSIDE_ROOT`/`PERMISSION_MISSING` 与实现 `forbidden` 不一致（G-07）；主机侧拒绝路径无审计事件（G-08）；平台停机网络错误未映射 `PLATFORM_UNAVAILABLE`（G-09）；无前端/API 版本兼容策略（G-10）。
- **MINOR ×4**：登录锁计数为进程内存；AC-01/05 只测 API 段时延、无抓包；AC-17 用手动刷新；AC-16 未测多用户隔离。

**主会话复核**：已确认 G-01 的代码路径（`server.ts:1454` 清空 `credentialHash`；`:1366` 心跳 401；`cloud-agent-client.ts` 心跳失败即放弃本轮回撤）——是真实 BLOCKER，不是映射误差。

**如实记录 / 剩余**：
1. **暂不进入人工验收**：4 BLOCKER + 6 MAJOR。
2. 8 条 UNVERIFIED 需要独立环境（压测、多中继、多副本审计、MITM、跨轮换窗口、WAF）。
3. 本轮未修任何产品缺口（映射任务范围），下一模块应优先修 G-01。

## M71 修复 G-01：主机吊销能到达主机并关闭已建会话（AC-14）（本轮，开发子代理执行 + 主会话补测）

**问题（M70 验收映射发现）**：`DELETE /v1/hosts/:id` 把 `credentialHash` 清空，主机下一次心跳直接 401 → **永远收不到撤销集合**；已建云会话不会在 60 秒内断开，AC-14 无法满足。

| 改动 | 内容 |
|---|---|
| 平台 `store.ts` / `server.ts` | `Host.revokedAt`（旧数据缺省 `null`）；`DELETE` 改为置 `revokedAt`、**保留 `credentialHash`**（只为继续送达吊销）、删 relay 路由、沿用项目撤销、审计带 `revokedAt`；心跳鉴权通过后若已吊销 → **仍 200** 并返回 `hostRevoked: true`，但不刷新 status/directAddrs/e2ee/projectsRoot/lastHeartbeatAt；`handleConnect` 先判 `409 HOST_REVOKED`；`hostOnline` 与 `projectView.hostStatus` 对吊销主机一律 offline |
| 主机 `cloud-host-enrollment.ts` / `cloud-agent-client.ts` | 解析 `hostRevoked`；收到后置 `hostRevoked`/`lastError='host_revoked'`，对**所有已准入 ticket** 触发撤销回调（运行时以 4403 关闭已建会话），`refresh()`/`start()` 不再发请求，`admit` 直接拒绝（401 + `x-orca-reject: host_revoked`），并停止心跳定时器 |
| 测试 | 平台 e2e `host-revocation.e2e.test.ts`；真实端到端 `cloud-host-revocation.test.ts`；主会话补 `cloud-agent-revocation-stop.test.ts`（吊销后不再心跳、admit 拒绝） |

**验证（`evidence/m71-host-revocation/`）**：
- 平台 e2e（真实平台进程 + 真实注册主机）：注册 → 心跳 200 无标记 → 管理员 DELETE → 心跳 **200 + `hostRevoked: true`** 且仍带项目撤销集合 → 管理端 `status: offline`、`revokedAt` 非空、无 `credentialHash` → 项目 `hostStatus: offline` → connect **409 `HOST_REVOKED`**。
- 真实端到端（真实平台 + 注册主机/心跳 + TLS Runtime + 真实 WSS）：开发者建立云会话 → 吊销 → **9.9s 内以 4403 `session_revoked` 关闭**（远低于 60s）；随后新票据 `HOST_REVOKED`；旧票据在主机预握手被 `401 host_revoked` 拒绝。
- 主会话补测：吊销后 `heartbeats === 1`（不再轮询）、`admit` 返回 `host_revoked`。

**主会话独立验收**：平台 e2e 1/1；真实端到端 1/1；补测 1/1；回归 5 个文件 11 条全过；`tsc node` 0、`tsc tc.web` 0；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：子代理把 `DELETE` 改回清空 `credentialHash` → 平台 e2e 心跳 `401 !== 200`、真实端到端 **55s 未关闭**（`expected -1 to be 4403`），恢复后全绿。

**如实记录 / 剩余**：
1. 吊销主机的 `credentialHash` 保持有效（仅为送达吊销）；它仍可拉公开 JWKS，`/v1/internal/*` 走独立 token 不受影响——有意的取舍。
2. 用同一 `name` 重新注册会复用原记录且**保留 `revokedAt`**（fail-closed）；“解除吊销”未定义，需另开需求。
3. 平台 `store` 仍是进程内内存：撤销只在处理 DELETE 的实例生效（与既有撤销设计一致，多副本同步未实现，AC-26 仍 UNVERIFIED）。
4. 吊销后主机重启：持久化凭证仍指向已吊销主机，首次 refresh 即得知并停止，不会自动重新注册。
5. 心跳定时器停止属卫生性改动：`refresh()` 本身已短路，测试无法单独区分，已在证据中注明。

## M72 修复 G-07：云端拒绝携带机器可读原因（AC-27/AC-28）（本轮，主会话执行）

**问题（M70 验收映射发现）**：真实主机对越界路径/缺权限只返回顶层 `forbidden` + 英文消息，文档写的是 `PATH_OUTSIDE_ROOT` / `PERMISSION_MISSING`；客户端/CLI 按码分支无法匹配。

| 改动 | 内容 |
|---|---|
| `cloud-denial-details.ts`（新） | `PATH_OUTSIDE_ROOT` / `PERMISSION_MISSING` / `METHOD_NOT_AVAILABLE` / `DOWNLOAD_DISABLED` 词汇与构造；由权限映射推导，不改变准入逻辑 |
| `runtime-rpc-request-admission.ts` / `runtime-rpc-websocket-dispatch.ts` | `buildError` 增加可选 `data`；路径拒绝附 `{denial:'PATH_OUTSIDE_ROOT', reason}` |
| `rpc-request-admission-prologue.ts` | 云会话的方法权限拒绝附 `methodDenialDetails(...)` |
| `cloud-rpc-multiplexer.ts` / `cloud-connect-client.ts` / `cloud-platform-ipc.ts` | 把 `error.data` 一路带到 `CloudRpcResult`/`CloudRpcOutcome` 的 `data` |
| 文档 | `design.md` §6.5 增补「D. 云会话 RPC 拒绝」表；`test-plan.md` AC-27/AC-28 结果与证据更新 |

**顶层 `code` 保持 `forbidden`**：已发布客户端把它读作「主机拒绝」，精确原因只放在 `data.denial`，属于向后兼容的加字段。

**G-06（读语义）核实结论**：实现读限 `projectRoot`、写限 `workspaceRoot`——AC-27 的「项目内跨工作区读允许」本来就成立；M36-1 中被拒的是**另一个项目**的仓库（在 `projectRoot` 之外），不是同项目同伴 worktree。`cloud-path-boundary.test.ts::工作区根内的写入放行，项目其它位置只读` 即该语义的真实用例，已补进 AC-27 引用。

**验证（`evidence/m72-denial-details/`）**：
- 真实平台 + 真实 TLS Runtime + 真实 WSS（`cloud-denial-details.test.ts`）：越界写 → `forbidden` + `data.denial=PATH_OUTSIDE_ROOT`、带 `reason`；`settings.update` → `forbidden` + `data.denial=METHOD_NOT_AVAILABLE`。证据 `m72-path-denial.json`、`m72-method-denial.json`。
- 单元（`rpc-caller-scope.test.ts` 新增 3 条）：`PERMISSION_MISSING` + `permission=file:write`；`METHOD_NOT_AVAILABLE`；`DOWNLOAD_DISABLED`（`browser.download` 且策略关闭下载）。
- 合并重跑 **40/40 通过**；回归 `cloud-workspace-boundary.test.ts` + `cloud-agent-boundary.test.ts` 10 条通过；`tsc node` 0、`tsc tc.web` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：从 dispatch 的 `buildError` 去掉 `pathDenialDetails(...)` → M72-1 失败（`expected undefined to match object { denial: 'PATH_OUTSIDE_ROOT' }`），M72-2 仍通过（方法级路径独立）；恢复后全绿。

**如实记录 / 剩余**：
1. `data` 只走内存回程：不进审计、不落日志（审计缺失见 G-08）。
2. `files.download` 不是已注册方法，`DOWNLOAD_DISABLED` 用 `browser.download` 验证。
3. 主机侧拒绝仍无审计事件（G-08）；`PLATFORM_UNAVAILABLE` 映射（G-09）与离线主机禁用（G-05）未动。

## M73 修复 G-08：主机侧拒绝进入平台审计链（AC-11/AC-21/AC-27/AC-28）（本轮，主会话执行）

**问题（M70 验收映射发现）**：主机是唯一能看到「升级前拒绝」的一侧，但它不写任何审计；平台审计链因此对伪造/过期票据、路径越界、权限越界完全没有记录，AC-11/21/27/28 的「审计」子项无法满足。

| 改动 | 内容 |
|---|---|
| `cloud-host-audit.ts`（新） | 主机侧有界缓冲（200 条，保留最新），事件 `connection_rejected` / `path_denied` / `method_denied`，按序号 `take`/`clearThrough`，与 provisioning 上报同一模式 |
| `cloud-agent-client.ts` | `admit` 的每一条拒绝路径（伪造/过期/重放/缺凭证/主机已吊销）都入缓冲；`reportAudit` 暴露给 Runtime；心跳携带 `audit[]`，平台接受后按序号清除 |
| `cloud-heartbeat-body.ts`（新） | 心跳体组装（地址、E2EE 公钥、projectsRoot、provisioned、audit），从客户端抽出以守住行数上限 |
| `cloud-agent-config.ts`（新） | `CloudAgentConfig` 类型移出，客户端行数回到预算内 |
| `host-audit-ingest.ts`（新，平台） | 校验事件类型/结果，单次 ≤100 条、文本 ≤512 字符；逐条 `appendBestEffort` 写入既有哈希链，`eventType=host.<事件>`，`actor=host:<主机名>`，`target` 为设备（有 `deviceId` 时）或主机 |
| Runtime 侧 | `setCloudHostAudit` 安装接收器；WSS 路径拒绝、方法/权限拒绝分别写入 `path_denied` / `method_denied`（带设备、主体、项目、方法、`denial`、`reason`） |
| 文档 | `design.md` §4.3.3 增补实现载体与事件名；`test-plan.md` AC-11/21/27/28 更新为 PASS 并引用 M73 证据 |

**验证（`evidence/m73-host-audit/`）**：真实平台进程 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 WSS：
- 越界写 → 平台审计 `host.path_denied`：`actor=host:dev-m67`、`targetType=device`、`metadata={denial:PATH_OUTSIDE_ROOT, reason:workspace_scope, method:files.write, subject:user:zhangsan, projectId}`。
- `settings.update` → `host.method_denied`：`metadata.denial=METHOD_NOT_AVAILABLE`。
- 伪造票据直连 → 主机预握手 `401 x-orca-reject: malformed`；同一心跳内出现 `host.connection_rejected`（`metadata.reason=malformed`，target 为主机）。
- `GET /v1/audit/verify` → `ok: true`，`checked` 覆盖上述事件（链未分叉）。
- 回归：platform 测试 **126/126**；主机侧 5 个文件 14 条全过；`tsc node` 0、`tsc tc.web` 0；oxlint 无新增（`server.ts` 的 curly 报错为存量）。

**负向对照**：移除心跳处理里的 `appendHostAuditReports(...)` → M73-1 失败（`expected 0 to be greater than 0`）；恢复后全绿。

**如实记录 / 剩余**：
1. 缓冲在内存：断网不丢，主机重启会丢（设计原文只承诺「断网不丢」；若需重启不丢要另建落盘队列与保留策略）。
2. 仅 enrolled（心跳）主机上报；legacy poll 模式主机无携带通道，事件不产生。
3. 事件按主机批次到达，`traceId` 是平台处理心跳的 trace，不与原始请求 trace 关联。
4. 成功/计量类事件（读预算、导出放行）未上报，本轮只覆盖拒绝类。
5. 平台审计链损坏时主机事件静默丢弃（`appendBestEffort`），心跳不断——与「审计不可写则敏感操作 fail-closed」不同，因为心跳本身不是授权动作。

## M74 修复 G-05：项目列表按心跳窗口显示离线并禁用打开（AC-08）（本轮，主会话执行）

**问题（M70 验收映射发现）**：`projectView.hostStatus` 直接返回持久化的 `host.status`，主机 60 秒无心跳后仍显示 `online`，工作台的「打开」按钮因此保持可用，用户直到 connect 才收到 409。

| 改动 | 内容 |
|---|---|
| `server.ts` | 新增 `hostStatusView()`：吊销 → `offline`；维护中 → `maintenance`；否则按 `hostOnline()`（状态 + 心跳窗口）判定 `online`/`offline`。`projectView` 改用它，`/v1/hosts.online`、connect 的 `HOST_OFFLINE` 本就按 `hostOnline()`，三者口径统一 |
| 离线窗口可配 | `ApiConfig.hostOfflineMs` + 环境变量 `ORCA_CLOUD_HOST_OFFLINE_MS`（默认仍 60s），测试用真实进程缩短窗口观测翻转 |
| 测试 | 新增平台 e2e `host-offline.e2e.test.ts`：真实平台进程 + 真实主机注册/心跳 + 真实登录，窗口 400ms；`m70-acceptance.e2e.test.ts::AC-08` 从「记录缺口」改为断言 `offline` |

**验证（`evidence/m74-offline-host/host-offline.json`）**：心跳后 `hostStatus=online`、`/v1/hosts.online=true`、connect 200；静默 > 窗口后 `hostStatus=offline`、`online=false`、connect **409 `HOST_OFFLINE`**；再次心跳立即恢复 `online`。
- 平台测试 **127/127** 通过；渲染层 `use-cloud-session.test.tsx` 11/11（离线项目列出但「打开」禁用 + 「主机离线」徽标）；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把 `hostStatus` 改回 `host.status` → `host-offline.e2e.test.ts` 转红（`actual: 'online'` vs `expected: 'offline'`）；恢复后全绿。

**如实记录 / 剩余**：
1. 判定仍是**请求时**推导，不是后台定时把主机改离线：`/v1/hosts` 的 `status` 字段仍为最后一次上报值（`online` 布尔已正确）。不改变行为，仅字段语义差异。
2. 维护中的主机对工作台同样不可打开，徽标文案统一为「主机离线」，未区分「维护中」。
3. 客户端（桌面/浏览器）在自己的连接缓存里不会主动失效已打开的会话；仅有新列表数据时更新。

## M75 修复 G-09：平台停机映射 `PLATFORM_UNAVAILABLE`，且不无凭证重连（AC-20）（本轮，主会话执行）

**问题（M70 验收映射发现）**：平台停机时 `fetch` 的 `TypeError: fetch failed` 原样抛出，调用方无法按码分支；更严重的是 `cloud-auth-session` 的刷新把**任何**异常都当成会话失效并永久锁死（`expired = true`）——一次网络抖动就会把用户登出，与 AC-20「已有会话继续、不无凭证重连」相反。

| 改动 | 内容 |
|---|---|
| `cloud-platform-unavailable.ts`（新） | `PLATFORM_UNAVAILABLE` 码；`isPlatformUnreachable()` 沿 `cause` 链识别 `ECONNREFUSED`/`ENOTFOUND`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/`EHOSTUNREACH`/`ENETUNREACH`/`EPIPE`/`UND_ERR_*`、`AbortError`/`TimeoutError` 与 `TypeError: fetch failed`；`platformRequest()` 只转换传输失败，其余错误原样抛出 |
| `cloud-auth-session.ts` | 刷新请求走 `platformRequest`；**5xx 也视为不可用**；只有平台真的拒绝（无 `accessToken`）才置 `expired` 并抛 `SESSION_EXPIRED`。不可用时不锁死，下次请求重试 |
| `cloud-authorized-request.ts` | `ensureFresh`、首发请求、强制刷新、重试请求全部经 `platformRequest`；`throwCloudPlatformError` 对 5xx 直接给 `PLATFORM_UNAVAILABLE` |
| `cloud-connect-client.ts` | `login()` 的传输失败同样映射 |
| 测试辅助 | `cloud-tcp-proxy-fixture.ts`：可暂停的 TCP 前置代理，断网但平台进程与内存状态保留 |

**验证（`evidence/m75-platform-unavailable/`）**：真实平台进程（`accessTtlMs=2000`，使每次请求都先刷新，确保断网打在刷新路径上）+ 可暂停代理 + 真实 TLS Runtime + 真实 WSS：
- 断网期间：已建立的会话 `status.get` 仍成功（数据面独立）；新客户端登录、`listProjects`、`openProject` 全部得 **`PLATFORM_UNAVAILABLE`**（不是 `SESSION_EXPIRED`，也不是裸 `TypeError`）；未取到票据即未尝试升级 socket。
- 恢复后：**同一会话不重新登录**即可重新列出项目、重新取票、直连打开并 RPC 成功 → 会话未被判死。
- 单元（`cloud-platform-unavailable-unit.test.ts`）：三层 `cause` 链、`TimeoutError`、裸 `{code}` 均识别；`SESSION_EXPIRED` 不被误判；`platformRequest` 只转换传输失败。
- 回归：`cloud-auth-session.test.ts`、`cloud-connect-client.test.ts`、`cloud-session-renewal.test.ts`、M73/M72/M36/M66 相关 4 个文件全过；渲染层 `use-cloud-session.test.tsx` 11/11；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把刷新异常处理改回「任何异常都置 `expired`」→ M75-1 得 `SESSION_EXPIRED` 而非 `PLATFORM_UNAVAILABLE`、M75-2 恢复后仍失败（会话被锁死）；恢复后全绿。第一次对照未触发刷新路径（TTL 30 分钟），因此把测试平台改成 2s 访问令牌重做对照。

**如实记录 / 剩余**：
1. 不做自动重连/退避重试：客户端在用户再次打开或下一次列表刷新时重试；「无凭证重连」因此不成立（结构上取票在升级之前）。
2. 平台 5xx 一律按不可用处理，包括平台真的有 bug 时的 500——客户端会重试而不是登出，这是有意的方向。
3. 断网检测依赖 `fetch` 的错误形状；未来 Node 改变 `TypeError: fetch failed` 文案时需同步（`code` 分支不受影响）。
4. 心跳/控制面侧（主机）已有独立退避，不在本轮范围。

## M76 修复 G-03：凭证签名密钥轮换（AC-31）（本轮，主会话执行）

**问题（M70 验收映射发现）**：平台启动时只生成一个 `kid`，`/v1/jwks` 只返回当前公钥，没有任何轮换入口。轮换密钥（或密钥泄露后重建）会让所有在途票据立即 `unknown_kid`，60 天旧钥保留更无从谈起。

| 改动 | 内容 |
|---|---|
| `signing-key-ring.ts`（新，平台） | 当前键 + 已退役键（`retiredAt`/`retainUntil`=60 天）；`rotate()` 退役当前键并发新键（`kid` 带随机后缀，防同毫秒重号）；`publicKeys()` 先按注入时钟裁剪过期退役键，再返回「当前 + 保留中」 |
| `server.ts` | 签署改用 `signingKeys.current()`；`/v1/jwks` 返回整个环；新增 `POST /v1/admin/signing-keys/rotate`（仅管理员；`auditAllowsMutations` fail-closed；成功与 403 都写 `signing_key_rotate` 审计，成功事件带 `previousKid`）；`ApiHandle.signingKey` 改为 getter 保持兼容 |
| 文档 | `design.md` §8 API 表补该路由与「旧公钥继续发布 60 天」；`test-plan.md` AC-31 由 UNVERIFIED 更新为 PASS |

**验证（`evidence/m76-signing-key-rotation/`）**：
- 平台 e2e（真实 `createApp` + 真实 Ed25519 签名 + 注入时钟）：轮换前取票 → 轮换 → JWKS 同时含新旧 `kid`，旧票据验签成功、新票据用新 `kid`；第 59 天旧公钥仍在并验签成功；第 60 天+1 旧公钥从 JWKS 消失，旧票据判 `unknown_kid`；成功/拒绝均可在审计查询中看到。
- 真实主机 e2e（真实平台进程 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 WSS）：取票 → 管理员轮换 → 主机 `refresh()` 后 `snapshot().kids` 变为两个 → **用轮换前签发的票据完成升级、E2EE 与 `status.get`**。
- 回归：平台测试 **129/129**；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把 `publicKeys()` 改成只返回当前键 → 平台 e2e 在「轮换后新旧 kid 并行」处转红、真实主机 e2e 因 `kids` 只有一个而转红；恢复后全绿。

**如实记录 / 剩余**：
1. 密钥环仍在进程内存：平台重启即换新键（旧键不保留），多副本之间也不共享。生产需要 KMS/HSM + 持久化 `schema_keys`（设计 §13.2 已有表结构，未实现）。
2. 没有自动轮换调度与「密钥到期前告警」；轮换是管理员显式操作。
3. 退役键只在 `publicKeys()`/`rotate()` 被调用时裁剪；没有后台任务。
4. `ApiHandle.signingKey` 现在指向当前键，测试/日志读取到的 `kid` 会随轮换变化。

## M77 修复 G-02：主机公钥 TOFU 固定与 4433 中断（AC-29）（本轮，主会话执行）

**问题（M70 验收映射发现）**：`/connect` 由平台下发主机 E2EE 公钥，客户端直接使用，不做任何固定——平台（或能改写主机记录的人）可以在用户无感的情况下替换主机公钥，AC-29 的 4433 中断、重新核对与审计全都不存在。设计 §10.4/§14.2 已明确口径：固定的是**主机自签 E2EE 公钥**（X25519），TOFU。

| 改动 | 内容 |
|---|---|
| `cloud-host-trust.ts`（新） | `sha256:<hex>` 指纹（对原始密钥字节，跨 base64 重编码稳定）+ 展示分组；持久化 `orca-cloud-host-trust.json`（`writeSecureJsonFile`）；`hostKeyVerdict()` 返回 `first_use` / `trusted` / `mismatch` |
| `cloud-host-key-guard.ts`（新） | `check(ticket)`：首次使用自动固定并落盘；不匹配则关闭当前 socket（4433 `fingerprint_mismatch`）并抛 `FINGERPRINT_MISMATCH`（带 `closeCode` 与两个指纹）；`trust()` 是唯一的重新固定入口 |
| `cloud-connect-client.ts` | `prepareProjectLink` 在取票后、选路/升级前调用 guard；新增 `trustHostKey()` / `pinnedHostFingerprint()`；`userDataPath` 透传信任库位置 |
| `cloud-socket-handshake.ts` | `close(code?, reason?)`，让客户端侧的拒绝能作为 4433 关闭帧发出 |
| 平台 `server.ts` | 心跳里 E2EE 公钥变化时写 `host_e2ee_key_changed` 审计（只记录新旧指纹，不记录密钥），相同键重复上报不重复写 |
| 文档 | `test-plan.md` AC-29 由 UNVERIFIED 更新为 PASS |

**验证（`evidence/m77-host-key-pinning/`）**：
- 真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 WSS（`cloud-host-key-pinning.test.ts`）：首次打开固定真实指纹 → 心跳改写平台侧公钥（模拟替换）→ `openProject` 抛 `FINGERPRINT_MISMATCH`、`closeCode=4433`、原 socket 已断（`status.get` 返回非 ok）、固定值保持不变 → `trustHostKey()` 后才更新；新客户端实例读到持久化的固定值，且对恢复后的真实公钥仍报不匹配。
- 平台 e2e（`host-key-change-audit.e2e.test.ts`）：换钥写 `host_e2ee_key_changed`（`targetType=host`、`previousFingerprint`/`fingerprint` 均为 `sha256:` 前缀截断值，事件体不含密钥）、同键重复上报不增加事件、`/connect` 下发最新公钥。
- 回归：平台 **130/130**；主机侧 4 个文件 8 条；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：去掉 `prepareProjectLink` 里的 `hostKeys.check(ticket)` → M77-1/M77-2 均转红（`pinnedHostFingerprint` 为 null）；恢复后全绿。

**如实记录 / 剩余**：
1. 首次连接的「展示指纹并请用户确认」弹窗未做：当前是静默 TOFU + 固定后可见 `pinnedHostFingerprint()`，比设计少一个确认步骤。
2. 固定值按 `userDataPath` 存本机：换机器/清数据即重新 TOFU；没有跨设备同步（设计也未要求）。
3. 客户端侧的拒绝是本地错误码 + 4433 关闭帧，不进入平台审计；平台审计覆盖的是「公钥变更」本身。
4. 平台侧 E2EE 公钥只由主机心跳写入，平台管理员无审批环节。

## M78 修复 G-10：Web 前端契约版本 + 静态资源独立发布（AC-19）（本轮，主会话执行）

**问题（M70 验收映射发现）**：平台把前端与 API 同进程同版本发布，静态资源没有内容哈希、没有版本协商、没有旧版本保留。前端独立发版时，浏览器缓存的旧页面会拿到新构建的 `app.js`，或在新构建部署后请求到 404——白屏；旧前端调用不存在的新路由也只会得到裸 404。

| 改动 | 内容 |
|---|---|
| `web-release.ts`（新，平台） | 启动时读取前端目录、按文件内容算 SHA-256、以「文件名:哈希」聚合出 `build` id；`index.html` 中的 `/app.js`、`/config.js`、`/styles.css` 改写为 `/assets/<build>/…`；当前构建归档到 `WEB_ARCHIVE/<build>/`，解析旧 build 时从归档读取（并校验归档 build 一致，防止残缺归档冒充） |
| `web-contract.ts`（新） | 前端契约版本（`WEB_CONTRACT_VERSION=1`、`MIN=1`）与 `x-orca-web-contract` 解析/判定；缺失头视为当前版本（兼容未协商的旧前端） |
| `server.ts` | `GET /v1/web/release`（公开：contract/build/资产路径与哈希）；`/v1/*` 契约门（超出窗口 → 426 `WEB_CONTRACT_UNSUPPORTED` + `{offered, minContract, maxContract}`）；`/assets/<build>/<file>` 以 `immutable` 长缓存返回；入口 `index.html` `no-store` + `x-orca-web-build`；旧的未哈希路径保留 `no-cache` + ETag；`ApiConfig.webRoot`/`webReleaseArchiveDir` 可用环境变量覆盖 |
| 测试夹具 | `spawnService` 的 `stop()` 修复：被信号终止的子进程 `exitCode` 为 null，重复调用 stop 会永久等待（本轮实际踩到） |

**验证（`evidence/m78-web-release/web-release.json`）**：两个真实平台进程 + 真实 HTTP：
- 构建 A：`/v1/web/release` 返回契约与 build；`index.html` 为 `no-store`、带 `x-orca-web-build`、引用 `/assets/<A>/app.js`；该资源 200 + `public, max-age=31536000, immutable`；旧路径 `/app.js` 200 + `no-cache` + ETag。
- 旧前端（`x-orca-web-contract: 1`）调用 `/v1/projects` 得 401（路由存在，非 404/426）；`2` 与 `beta` 得 426；不带头的请求按当前契约 401。
- 构建 B 在同一归档目录启动：build 变化、index 指向 `/assets/<B>/`；**旧页面的 `/assets/<A>/app.js` 仍 200 且返回旧字节**；契约 1 仍可用。
- 回归：平台测试 **131/131**；`tsc node` 0；新模块独立 `tsc --strict` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：让 `resolve()` 不再回退归档 → 断言「a cached old page must not white-screen after a deploy」转红（旧资源 404）；恢复后全绿。

**如实记录 / 剩余**：
1. 归档目录需持久化（默认未启用：未配置 `webReleaseArchiveDir` 时只有当前构建可用，旧页面会 404）；生产应挂载持久卷。
2. 归档无保留期清理策略，构建多了会累积。
3. 契约版本目前只有一个（1/1）；提高 `MIN` 就是关闭兼容窗口，属于发布决策。
4. 前端没有实际发送 `x-orca-web-contract` 头（`apps/web/app.js` 未改），当前由「缺失=当前」兜底；后续前端发版应显式带上。
5. 426 是 JSON；前端页面需自行渲染提示（当前未做 UI）。

## M79 修复 G-13：策略变更经主机轮询在 30 秒内生效（AC-17）（本轮，主会话执行）

**问题（M70 验收映射发现）**：M35 的策略用例在每次变更后手动调用 `client.refresh()`，证明的只是「闸门读当前快照」，而不是产品实际使用的 10 秒轮询投递路径——轮询停摆或间隔写错都不会被发现。

| 改动 | 内容 |
|---|---|
| `cloud-policy-propagation.test.ts`（新） | 真实平台进程 + 真实 Runtime + 真实 WSS + 真实 10s 轮询定时器（`client.start()`，全文件不调用 `refresh()`）：同一已建会话先被默认策略拒绝，管理员改为 `allow` 后**轮询自动**打开闸门，再改回 `deny` 后自动关闭；每次以 250ms 间隔探测并记录耗时 |
| 文档 | `test-plan.md` AC-17 由 PASS(部分) 更新为 PASS |

**验证（`evidence/m79-policy-propagation/m79-policy-propagation.json`）**：轮询间隔 10s、上限 30s；放开 **10.09s**、收回 **10.11s** 生效；期间同一 socket 仍可 `status.get`（未重连）；`policy_update` 审计可查。
- 回归：`cloud-download-policy.test.ts` + 本用例 4/4 通过；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把 `client.start()` 换成一次性 `client.refresh()`（首次能取到策略，但之后不再轮询）→ 用例等满 **30035ms** 后失败，报 `gate did not open within 30000ms`；恢复定时器后全绿。

**如实记录 / 剩余**：
1. 只验证了下载闸门这一条策略路径；读取预算（`readRatePerHour`）走同一快照，未单独计时。
2. 未覆盖轮询连续失败时的行为（已有 `jwks_staleness` 与 `control-plane-isolation` 用例覆盖策略拉取失败）。
3. 生效时延 = 轮询间隔 + 一个请求往返，25 秒内的请求仍可能看到旧策略——这是「30 秒内生效」口径的固有语义。

## M80 修复 G-04：三副本共用一个审计写入者（AC-26）（本轮，主会话执行）

**问题（M70 验收映射发现）**：审计链只在单个 API 进程内维护，`auditLog` 是每副本各自的文件。部署 3 个副本时，每个副本各自从自己的 `GENESIS` 开始分配 `seq`/`prevHash`，链必然分叉；篡改也只会被读过该文件的副本发现。AC-26 的「3 副本 10 万条并发无分叉」不可能成立。

**设计决策（本轮确定）**：按 design §3 已列出的 `orca-cloud-audit-writer`，先实现「单写入者 + 串行定序 + 文件回放」：API 副本把事件投递给写入者，写入者一个进程分配全局 `seq`/`prev_hash`。leader 选举/standby、Redis Stream 与 PG/对象存储归档留待部署阶段（已在 design §13.2 标注为未实现）。

| 改动 | 内容 |
|---|---|
| `apps/audit-writer/src/writer.ts`（新） | `POST /v1/append`（批量 ≤1000，进程内串行）、`GET /v1/events`、`/v1/verify`、`/v1/status`、`/health`；内部令牌鉴权；启动时回放并校验既有日志；链损坏时**拒绝一切追加**（503 `AUDIT_CHAIN_BROKEN`），让所有副本 fail-closed |
| `apps/api/src/audit-writer-client.ts`（新） | 副本侧 `AuditSink` 实现（append / appendBestEffort / query / verify / getHealth）；写失败标记 `write_failed`、写入者报告断链则标记 `chain_broken` 并抛同码错误 |
| `audit.ts` | `AuditChain` 依赖收窄为 `AuditStore`（只要 `audit/auditSeq/auditTip`），写入者可复用它而无需整个 `Store` |
| `server.ts` | `AuditSink` 接口；设置 `ORCA_CLOUD_AUDIT_WRITER_URL` 时走远端写入者，否则保持原有本地链；`recordAudit`、`audit.append/query/verify` 全部改为 `await`（本地链返回同步值，`await` 兼容） |
| 文档 | design §13.2 增补一期实现与未实现清单；test-plan AC-26 由 UNVERIFIED 更新为 PASS |

**验证（`evidence/m80-audit-writer/audit-writer.json`）**：1 个真实写入者进程 + 3 个真实 API 副本 + 真实 TCP：
- 集成：3 个副本各自的审计写操作经写入者落链，`/v1/events` 可查。
- 规模：3 个并发生产者（与副本同一条 append 路径）写入 **100,000** 条，用时 **2.35s（≈42,500 条/秒）**；`seq` 无重复无缺口，`/v1/verify` → `ok: true, checked: 100006`（含副本自身事件）。
- 篡改：改写日志中间一行（第 50004 行）并重启写入者 → `/v1/verify` 报 `brokenAtSeq: 50004`；3 个副本的敏感写操作（建项目）全部 **503 `AUDIT_CHAIN_BROKEN`**。
- 回归：平台测试 **132/132**；新模块独立 `tsc --strict` 0；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：移除写入者追加前的健康检查 → 篡改后副本仍返回 **201**（授权被静默铸出），断言 503 失败；恢复后全绿。

**如实记录 / 剩余**：
1. 写入者仍是单实例：无 leader 选举/standby，写入者宕机即全部敏感操作 fail-closed（可用性问题，不是分叉问题）。
2. 事件投递是同步 HTTP（每个审计写一次往返），不是 design 里的 Redis Stream 异步队列；副本在写入者不可达时直接拒绝敏感操作。
3. 持久层是单文件（行追加 + 重启回放），不是 PostgreSQL + 对象存储 WORM；5 分钟签名锚点未实现。
4. 10 万条规模测试由 3 个并发客户端直接打 append 端点完成（与副本同一条路径），副本侧只做了端到端集成验证——用 10 万次用户操作驱动会超出单轮时间预算，此处如实说明。
5. `appendBestEffort` 在远端模式下立即返回 true（失败只在健康状态里体现），与本地模式语义略有差异。

## M81 补齐 AC-29 的确认与重新核对 UI（本轮，主会话执行）

**问题**：M77 让主机公钥固定生效，但界面上没有任何确认环节——设计 §10.4 要求「首次连接展示主机指纹并固定（TOFU）」「不匹配即 4433 中断并强提示」，而实际是静默固定、错误码只落在日志里；用户无法完成「重新核对」。

| 改动 | 内容 |
|---|---|
| `cloud-host-key-guard.ts` | 记录 mismatch 时看到的公钥（只在主进程），`trustPending(hostId)` 是唯一消费入口；抛出物新增 `hostId`；新增 `hostKeyDetails()` / `trustPendingHostKey()` 供服务层与 IPC 复用 |
| `cloud-project-open-result.ts`（新） | 打开结果的构造与失败映射（含 `hostKey` 明细），从服务类抽出以守住行数上限 |
| `cloud-session-service.ts` | 打开成功携带 `hostFingerprint`；失败携带 `hostKey { hostId, pinnedFingerprint, seenFingerprint }`；新增 `trustHostKey(hostId)`；fork 出的客户端共享同一个 guard（`deviceIdentity().hostKeys`），否则 mismatch 记在临时客户端上、主会话看不到 |
| IPC / preload | 新通道 `cloud:trustHostKey(hostId)`——渲染进程只说「用户已核对」，公钥不跨进程 |
| 渲染进程 | `useCloudSession` 暴露 `hostKeyMismatch` / `confirmHostKey()` / `dismissHostKeyMismatch()`；新增阻塞对话框 `cloud-host-key-dialog.tsx`（同时显示两个指纹）；`CloudApp` 挂载它 |
| 文档 | `test-plan.md` AC-29 补充 M81 证据与浏览器路径的未做项 |

**验证（`evidence/m81-host-key-confirmation/m81-host-key-confirmation.json`）**：
- 主进程（真实平台 + 真实主机心跳 + 真实 TLS Runtime + 真实 WSS，`cloud-session-service.test.ts` 新增用例）：首次打开固定指纹 → 改写平台侧公钥 → `openProject` 返回 `FINGERPRINT_MISMATCH` 且带 `hostId`/两个指纹 → `trustHostKey` 首次 `ok`、再次 `HOST_KEY_NOT_PENDING` → 恢复真实公钥后仍判 mismatch（固定值未动）→ 再次核对后打开成功、`hostFingerprint` 回到原值。
- 渲染层（`use-cloud-session.test.tsx` 新增 2 条）：被拒时出现 `alertdialog` 并展示两个指纹；「我已核对，信任新公钥」→ 调用 `trustHostKey('host-1')` 并自动重开、对话框消失；「取消」→ 不固定、留在工作台。
- 回归：渲染层 4 个文件 **27/27**；主进程 4 个文件 **26/26**；`tsc node` 0、`tsc tc.web` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把对话框的确认按钮改成执行「取消」→ 渲染层用例失败（12 passed / 1 failed）；恢复后 13/13。

**如实记录 / 剩余**：
1. 浏览器（管理员会话页）走的是另一套取票路径（`requestCloudTicket` + web 客户端），**没有公钥固定**；`CloudBridge.trustHostKey` 在该桥接上缺失，UI 只能返回 `HOST_KEY_PINNING_UNSUPPORTED`。补齐需要浏览器侧固定值存储（localStorage）与独立测试。
2. 首次连接仍是「静默固定 + 打开成功后可见指纹」：没有在首次连接时强制用户点确认（那会让所有既有云会话首次打开都被拦一次，影响面大，未在本轮改）。
3. 重新核对后若新公钥无法完成 E2EE（如平台被攻击者指向假主机），打开会以握手失败结束——这一层由 TLS/E2EE 自身兜底。

## M82 修复浏览器侧主机公钥固定（AC-29 剩余一半）（本轮，主会话执行）

**问题**：M81 让原生桌面完成固定与确认，但管理员会话页（浏览器）走的是另一条取票路径——`requestCloudTicket` + `WebRuntimeClient`，**完全没有公钥固定**；`CloudBridge.trustHostKey` 在该桥接上缺失，UI 只能返回 `HOST_KEY_PINNING_UNSUPPORTED`。也就是说同一平台下，浏览器用户可以无感接受被替换的主机公钥。

| 改动 | 内容 |
|---|---|
| `web-host-key-trust.ts`（新，浏览器） | TOFU 固定库：WebCrypto SHA-256（对原始密钥字节，`sha256:<hex>`，与桌面同格式）、JSON 存 localStorage（独立 key `orca.webCloudHostTrust`）、`first_use`/`trusted`/`mismatch` 判定；损坏或空库一律视为「未固定」，不 fail-open |
| `cloud-browser-project-connections.ts` | 取票后、创建任何 socket 之前校验：首次自动固定；不匹配时把新公钥留在内存 `pendingKeys` 并返回 `FINGERPRINT_MISMATCH` + 两个指纹；`trustPendingHostKey()` 是唯一消费入口；打开结果带 `hostId`/`hostFingerprint` |
| `cloud-browser-bridge.ts` | 注入 `hostTrustStorage`（默认 localStorage，node 下无操作）；暴露 `trustHostKey(hostId)`；两个 open 结果都带 `hostFingerprint` |
| 管理端入口 | `cloud-admin/main.tsx` 渲染同一个 `CloudApp`，因此 M81 的阻塞确认对话框直接生效，无需新增 UI |
| 工程 | 新 e2e 规格加入 `tsconfig.cloud-e2e.json`，并从 `tsconfig.tc.web.json` 排除（与其他浏览器 cloud e2e 一致） |

**验证（`evidence/m82-web-host-key/m82-web-host-key.json`）**：真实平台进程 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 WSS + 真实浏览器桥接：
- 首次打开：`hostFingerprint` 为 `sha256:…` 64 hex（`sockets=1`）。
- 心跳改写平台侧 E2EE 公钥 → 再次打开：`FINGERPRINT_MISMATCH`，带 `hostId` 与两个指纹，**socket 计数仍为 1（建连前就拒绝）**。
- `trustHostKey` 首次 `{ok:true}`、再次 `HOST_KEY_NOT_PENDING`；固定库已写入新指纹。
- 恢复真实公钥 → 仍判 mismatch（固定值是新指纹）→ 再次核对 → 打开成功、指纹回到原值。
- 单元（`cloud-browser-bridge.test.ts` 新增 2 条）：确认流程与「取消后固定值不变」。
- 回归：浏览器桥接 4 个文件 **21/21**；`tsc tc.web` 0、`tsc node` 0、`tsc cloud-e2e` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：移除 `BrowserProjectConnections.open()` 里的 `checkHostKey` 调用 → M82-1 转红（换钥后仍打开成功）；恢复后全绿。

**如实记录 / 剩余**：
1. 浏览器固定库在 localStorage：XSS 可改固定值，与 saved-session 同一威胁模型（已在该文件头注明取舍）。
2. 首次连接仍是静默固定（与桌面一致），没有强制确认步骤。
3. 浏览器侧没有 4433 关闭帧——它在建 socket 之前拒绝，本来就没有可关闭的连接；UI 表现为打开失败 + 确认对话框。
4. 两套固定库（桌面文件 / 浏览器 localStorage）不互通，符合「每端各自 TOFU」。

## M83 修复 AC-23：多中继注册与故障切换（本轮，主会话执行）

**问题（验收映射发现）**：平台只保存**一个** `relayPort`，`/connect` 只下发一个 relay 端点。一旦这个中继宕机，客户端没有任何可切换的节点——AC-23 的「单中继宕机后 5 次退避内重连、新开会话成功率 ≥99%」在实现上不可能成立。中继也从不向平台声明自己还活着。

| 改动 | 内容 |
|---|---|
| `relay-nodes.ts`（新，平台） | 活中继表：`register({id, port})` 记录/刷新，`healthy(now, aliveMs)` 按最近一次自注册过滤并按首次注册顺序排序；默认窗口 30s，可用 `ORCA_CLOUD_RELAY_ALIVE_MS` 缩短（测试用 6s） |
| `server.ts` | `POST /v1/internal/relay-endpoint` 接受 `id` 并刷新节点（端口非法 400）；`/connect` 的 `endpoints.relay` 改为**所有活节点**（按优先级）；新增 `GET /v1/internal/relays` 供运维/测试查看在线状态；无任何近期自注册时仍下发最后一个已知节点，避免平台短抖动导致客户端无中继可用 |
| `apps/relay/src/relay.ts` | 每次路由同步成功后向平台自注册（`id` 默认 `relay:<port>`）；关闭时销毁入站 socket，避免 `close()` 永久等待 |
| 文档 | `test-plan.md` AC-23 由 UNVERIFIED 更新为 PASS |

**验证（`evidence/m83-relay-failover/relay-failover.json`）**：真实平台进程 + **2 个真实中继进程** + 真实 HTTPS/WSS 上游：
- 两台中继自注册后，`/connect` 下发 2 个 relay 端点（端口与两台一致）。
- 杀掉中继 A，活窗口过期后 `/connect` 只下发中继 B；`/v1/internal/relays` 显示 A `online:false`。
- **40 次新会话全部成功（100%）**，中继 B 转发 41 次、丢弃 0 次，最长尝试 1 次。
- 仍指向死节点的过期端点列表：第 1 次失败、**第 2 次**切到 B 并完成真实 TLS + WSS 握手（AC 要求 ≤5 次）。
- 回归：平台测试 **133/133**；`relay-hardening.e2e.test.ts::M10` 仍通过；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把 `/connect` 的候选从 `healthy()` 改回 `all()`（仍下发死节点）→ 用例在「the dead relay must not be handed out」处转红（`actual` 含已死端口）；恢复后全绿。

**如实记录 / 剩余**：
1. 自注册随路由同步每 2s 一次，因此「中继已死」最多滞后一个活窗口（默认 30s，可配）；期间客户端可能拿到死节点，靠端点回退兜底（本用例已覆盖，2 次尝试内成功）。
2. 「5 次退避」在客户端由优先级遍历实现（最多 5 个端点），没有指数退避计时；连接层重连策略仍按既有实现。
3. 多平台副本时中继表只在处理注册的那个副本内存中（与撤销集合同一限制），需要共享存储；属部署阶段。
4. 中继健康只依据「最近自注册」，不探测转发能力；转发异常由客户端回退覆盖。

## M84 修复 G-11：登录失败锁计数改为多副本共享（AC-02）（本轮，主会话执行）

**问题（M70 验收映射发现）**：`Store.loginAttempts` 是每进程内存。部署 3 个副本时，5 次错误密码分散到不同副本各自只记 1–2 次，**账号永远锁不上**；AC-02 的「连续 5 次锁定」只在单进程成立。

| 改动 | 内容 |
|---|---|
| `apps/login-lockout/src/lockout.ts`（新服务） | 单实例共享计数：`POST /v1/failure`、`GET /v1/state?username=`、`POST /v1/clear`、`/health`；内部令牌鉴权；5 次锁 15 分钟，锁过期后读即清零（不累计旧失败） |
| `apps/api/src/login-lockout-client.ts`（新） | 副本侧客户端；`isLocked` 不可达时返回 `remaining = -1`（标记「计数不可用」），写路径抛 `LOCKOUT_UNAVAILABLE` |
| `server.ts` | `ApiConfig.loginLockoutUrl` / `ORCA_CLOUD_LOGIN_LOCKOUT_URL` 启用共享计数；登录流程改为 `await` 三个包装函数；**计数不可达时返回 503 `PLATFORM_UNAVAILABLE`（fail-closed）**，不猜测放行；成功登录仍清零计数（远端失败忽略，不阻塞已认证用户） |
| 文档 | `test-plan.md` AC-02 增补多副本证据 |

**验证（`evidence/m84-shared-login-lockout/`）**：3 个真实 API 进程 + 1 个独立计数服务进程 + 真实 HTTP：
- 5 次错误密码轮流打到 3 个副本 → `[401,401,401,401,423]`（第 5 次锁定，而非第 15 次）。
- 换一个副本用**正确密码**登录仍 423 `ACCOUNT_LOCKED`（锁是账号级）。
- 另一账号两次失败后用正确密码成功（200），随后连续 3 次错误仍为 401（计数已清零，未残留）。
- 停掉计数服务 → 3 个副本的登录全部 **503 `PLATFORM_UNAVAILABLE`**（fail-closed，而不是放行）。
- 回归：平台测试 **135/135**；新模块独立 `tsc --strict` 0；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：不让副本使用共享计数（去掉 `ORCA_CLOUD_LOGIN_LOCKOUT_URL`）→ 用例在「fifth failure must lock」处转红（`[401,401,401,401,401]`），恢复后全绿。

**如实记录 / 剩余**：
1. 计数服务是单实例且无持久化：宕机期间登录全部 503（有意 fail-closed），重启后计数清零（攻击者可利用重启窗口）。
2. 与审计写入者、中继表一样，多副本共享靠「集中一个进程」，不是 Redis/PG；生产应替换为 Redis 或数据库实现同一接口。
3. 锁定状态本身仍用平台注入时钟（AC-02 的 15 分钟恢复由 M70 用例覆盖）。
4. 令牌校验用常量时间比较，但**没有** mTLS：计数服务应只在内网监听（当前绑定 127.0.0.1）。

## M85 补齐 G-12 的「平台无业务流量」证明（AC-05、AC-24）（本轮，主会话执行）

**问题（M70 验收映射发现）**：AC-05/AC-24 只有「中继元数据不含负载」与 E2EE 可用性用例，没有任何测量证明**平台跳本身**不承载会话业务流量。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-tcp-proxy-fixture.ts` | 新增 `startRecordingProxy`：在平台前记录双向全部字节，供测试逐字节检索 |
| `src/main/cloud-platform/cloud-platform-data-path.test.ts`（新） | 真实平台进程 + 记录代理 + 真实 TLS Runtime + 真实 E2EE；客户端与主机的控制面请求都经该跳 |
| 文档 | `test-plan.md` AC-05 升为 PASS，AC-24 补平台侧证据与范围说明 |

**验证（`evidence/m85-platform-data-path/platform-not-in-data-path.json`）**：
- 55,296 字节负载经 `files.write` → `files.read` 原样读回，磁盘内容一致（数据确实走了会话）。
- 该交换期间平台跳新增 **0 字节**；累计捕获的 7,900 字节控制面流量不含负载标记。
- 平台审计（`/v1/audit/events`，200 条）中无负载标记。
- 对照：故意发往平台的请求携带独立标记，同一记录器能检出（证明测量不是空转）。
- **负向对照**：临时把负载标记泄漏到平台跳 → 用例在 `payloadMarkerInPlatformBytes` 处转红；移除后全绿。
- 回归：`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 只证明了平台跳；中继链路的逐字节记录仍缺（AC-24 保持 PASS(部分)）。
2. G-12 的另一半「浏览器渲染 P95」（AC-01）仍未测，需 Electron/CDP 或独立环境。

## M86 补齐 G-12 的「中继无明文」证明（AC-24）（本轮，主会话执行）

**问题**：M85 只记录了平台跳；中继链路仍只有「元数据不含负载」的用例，没有测量中继实际转发的字节与其日志。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-tcp-proxy-fixture.ts` | `startRecordingProxy` 支持惰性目标端口（代理先建、运行时后起） |
| `src/main/cloud-platform/cloud-relay-data-path.test.ts`（新） | 真实中继**进程**（`apps/relay/src/relay.ts`，PORT=0）+ 真实平台进程 + 真实 TLS Runtime + 真实 E2EE；主机不广播直连地址，强制走中继；记录代理置于中继出向 |
| 文档 | `test-plan.md` AC-24 升为 PASS（平台跳 + 中继出向均逐字节证明） |

**验证（`evidence/m86-relay-data-path/relay-ciphertext-only.json`）**：
- 路由为 `relay`（平台只下发中继端点），37,500 字节负载写入后读回一致。
- 中继出向该会话捕获 **101,692 字节**，负载明文标记不出现；中继自身日志 2 行，也不含该标记。
- 对照：同一记录器对直写明文能命中（`tapSeesPlaintextWhenPresent=true`），证明「未命中」不是空转。
- **负向对照**：把断言临时改指向含明文的捕获 → 用例在 `expected true to be false` 处转红，恢复后全绿。
- 回归：`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 中继入向（客户端→中继）未单独记录；由于 TLS 终止在主机侧，出向记录已覆盖中继可见的全部业务字节。
2. 未对中继进程做内存转储或全量日志全文扫描，只检视了它实际输出的日志行。

## M87 审计写入者主备（G-04 部署形态）（本轮，主会话执行）

**问题（M80 遗留）**：审计写入者是单实例。它一死，所有副本的敏感操作都 503 `AUDIT_UNAVAILABLE`——fail-closed 是对的，但没有可接管者，平台等于停摆。G-04 的 standby/leader 选举一直未实现。

| 改动 | 内容 |
|---|---|
| `apps/audit-writer/src/writer-lease.ts`（新） | 租约文件：`wx` 原子创建抢占 + mtime 刷新 + 过期接管；写入前逐批 `assertLeadership()`（fencing：读到别的持有者即让位）。明确不是共识算法 |
| `apps/audit-writer/src/writer.ts` | `AUDIT_LEASE_PATH`/`AUDIT_LEASE_TTL_MS`/`WRITER_ID`；只有持租约者读日志并接受 append，其余返回 503 `AUDIT_WRITER_STANDBY`；`/health` 增加 `role`；接管时在串行队列内重新 `restore` 日志再置为 leader |
| `apps/api/src/audit-writer-client.ts` | 支持 `urls`：粘性选择 + 网络失败/`AUDIT_WRITER_STANDBY` 时切下一个；**`AUDIT_CHAIN_BROKEN` 不切换**（链损坏是全局的） |
| `apps/api/src/server.ts` | `apiConfig.auditWriterUrls` / `ORCA_CLOUD_AUDIT_WRITER_URLS`（逗号分隔）；单 URL 配置仍兼容 |

**验证（`evidence/m87-audit-writer-standby/standby-takeover.json`）**：2 个真实写入者进程 + 2 个真实 API 副本 + 真实 HTTP：
- 启动后恰好 1 leader / 1 standby。
- 写入一次审计后 SIGKILL 主写入者；**空窗期内**的敏感操作返回 503（fail-closed，不产生乱序事件）。
- 备用在 **2.4s** 接管（租约 TTL 2s），接管时 `events=3` 说明从磁盘完整续链。
- 接管后敏感操作恢复 201；`/v1/verify` `ok=true, checked=4`；日志 `seq` 为 1..4 连续且唯一（不分叉），两次成功的 `project_create` 各 1 条。
- **负向对照**：去掉 `AUDIT_LEASE_PATH`（两台都自认 leader）→ 用例在「恰好一个 leader」处转红。
- 回归：平台全量 **136/136**；`typecheck:cloud-e2e` 0；新模块独立 `tsc --strict` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 租约靠文件 mtime，不是分布式共识：主机级时钟跳变或长时间暂停（超过 TTL）存在双写窗口，fencing 只能缩小、不能消除；生产应换成 etcd/Redis 租约或数据库单写约束。
2. 租约文件与日志需在同一存储上（当前为同目录）；跨机主备需要共享文件系统或改为网络库。
3. 未实现 Redis Stream 队列、PostgreSQL/对象存储归档与签名锚点（G-04 其余项）。

## M88 补齐 AC-12 的「已建立会话被收回」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-12 有「旧票据被拒、新登录 404、控制面挂起仍撤销」，但**没有用例断言已建立的连接在 60 秒内被关闭**——而这是撤销能否生效的关键路径。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-grant-revocation-live.test.ts`（新） | 真实平台进程 + 真实注册主机（心跳即撤销通道）+ 真实 TLS Runtime + 真实 E2EE；管理员清空 `team-payment` 授权后**不手动刷新**，只等心跳 |
| 文档 | `test-plan.md` AC-12 由 PASS(部分) 升为 PASS |

**验证（`evidence/m88-grant-revocation-live/`）**：
- `grant-revocation-live.json`：存活会话在 **9,902ms**（一个 10s 心跳周期内，预算 60s）被 **4403** 关闭；`refreshedManually=false`。
- `grant-restore.json`：收回期间新登录的项目列表不含该项目、取票 **404**；恢复授权后 **11ms** 内列表可见、取票 **200**、重开会话 `authenticated`。
- **负向对照**：临时让主机忽略 project 撤销集合（删掉 `isRevokedTicket` 的项目分支）→ 会话 60 秒内未关闭（`expected -1 to be 4403`），恢复后全绿。
- 回归：本案与邻近撤销用例 **5/5**；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 关闭时延取决于主机心跳周期（默认 10s）；平台侧降低心跳频率会等比例拉长，60 秒预算要求心跳间隔远小于 60s。
2. 只覆盖「收回组授权」；用户级/设备级撤销由 M11/M26 用例覆盖，主机吊销由 M71 覆盖。

## M89 补齐 AC-13 的「近 7 天窗口」与「traceId 关联」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-13 的 7 天 `since` 过滤与 traceId→连接日志关联**都没有断言**。进一步看，实现本身有两处缺口：
1. 审计事件的 `ts` 用 `Date.now()`，不跟随平台可注入时钟——注入时钟的测试里审计时间与授权/锁定时钟不一致，"近 7 天"无法被真实验证；
2. `traceId` 虽写进事件，但 `/v1/audit/events` **不能按 traceId 查询**，审计员无法从一个请求的 traceId 反查事件。

| 改动 | 内容 |
|---|---|
| `apps/api/src/audit.ts` | `AuditChain` 接受可选 `now` 时钟（默认 `Date.now`），`ts` 随之；`query()` 新增 `traceId` 过滤 |
| `apps/api/src/server.ts` | 本地审计链传入平台 `now`；`/v1/audit/events` 接受 `traceId` 查询参数 |
| `apps/api/src/audit-writer-client.ts`、`apps/audit-writer/src/writer.ts` | 远程审计查询同步支持 `traceId`（多副本部署同样可用） |
| `test/e2e/audit-trace-window.e2e.test.ts`（新） | 真实平台 HTTP + 注入时钟 + 真实 Ed25519 签名 + 真实注册主机与心跳 |

**验证（`evidence/m89-audit-trace-window/audit-trace-window.json`）**：
- 第 0 天产生一条带 traceId 的 `project_connect`（旧客户端被 426 拒绝，响应回显同一 traceId）；第 6 天与第 10 天各一条成功连接。
- 在第 10 天以 `since=now-7d` 查询：第 0 天事件**被排除**，第 6/10 天事件**在窗口内**，且返回的每条事件 `ts` 都不早于 `since`。
- 分页（`limit=1`）逐页走完窗口，得到的事件集合与一次性查询完全一致、无重复。
- `?traceId=` 精确命中 1 条（`project_connect`/`zhangsan`）；未使用过的 traceId 返回 0 条。
- 全链 `verify.ok`（12 条），窗口是"过滤后的可校验视图"，不是脱离链的查询。
- **负向对照**：① 去掉服务端 traceId 过滤 → 命中 12 条，断言转红；② 审计链改回 `Date.now()` → 第 6 天事件落到窗口外，边界断言转红。两者恢复后全绿。
- 回归：相关套件 22/22；平台全量 **137/137**；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 查询仍是内存数组线性扫描；事件量大时应加 `traceId` 索引（部署阶段与持久层一起做）。
2. 7 天窗口的语义由调用方传 `since`；平台只强制 31 天上限，不强制"7 天"——这与需求一致（审计员按需查询），默认窗口由前端预设。
3. platform 的"连接日志"目前即审计链中的 `project_connect` 事件；独立的结构化连接日志文件仍属部署阶段（design §13.1 的 JSON 日志）。

## M90 补齐 AC-06 的「中继下终端可交互」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-06 已验证「回落中继 + RPC 通过中继」，但**中继线路下的终端交互从未单独复测**——而终端是开发者最核心的交互面。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-terminal-relay.test.ts`（新） | 真实中继**进程**（`apps/relay/src/relay.ts`，PORT=0）+ 真实平台 + 真实 TLS Runtime + 真实 E2EE + **真实 PTY**（node-pty）；主机不广播直连地址，强制选中继；运行时 TLS 端口在注册时尚不存在，故中继目标经惰性端口转发 hop 解析 |
| 文档 | `test-plan.md` AC-06 由 PASS(部分) 升为 PASS |

**验证（`evidence/m90-terminal-over-relay/terminal-over-relay.json`）**：
- `route=relay`：平台只下发中继端点，客户端确实走中继。
- 终端流事件 `scrollback → data → end`，`echo ORCA_M90_RELAY_TERMINAL_OK` 的**shell 真实输出**被读回（`sawMarker=true`）。
- 同一中继 socket 上的 `files.write` 成功（`fileWriteOverRelay=true`），说明不是终端专用旁路。
- **负向对照**：会话建立后杀掉中继进程 → `terminal.create` 返回 `CONNECTION_CLOSED`，用例转红；恢复后全绿。
- 回归：本案与直连终端用例 **4/4**；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 只验证了终端与文件 RPC；中继下的 agent/结构化会话与长时流（scrollback 大回放）未复测。
2. 中继目标通过测试内的惰性转发 hop 解析（运行时端口后于注册出现）；生产部署里中继目标应指向固定的主机侧入口。

## M91 补齐 AC-07 的「分步诊断 + 重试」（本轮，主会话执行）

**问题（M70 验收映射）**：线路全不可达时只抛 `ENDPOINT_UNREACHABLE` 与一句英文消息，**没有逐地址诊断，也没有重试入口**。用户无法判断是直连还是中继失败，也无法把信息交给管理员（FR-5.6 / J4.2）。

| 改动 | 内容 |
|---|---|
| `cloud-endpoint-probe.ts`（新） | 探测原语从路由选择中抽出；`describeEndpoint` 只保留 `host:port`（不带 route key / 查询串） |
| `cloud-route-selection.ts` | `chooseRoute` 返回 `{ choice, probes }`：按尝试顺序记录线路、地址、结果、耗时 |
| `cloud-connect-client.ts` | 全部不可达时把 `probes` 挂在错误上 |
| `cloud-project-open-result.ts` | `failedCloudOpen` 将 `probes` 透传为 `connectDiagnostics`（全有或全无，避免半截诊断） |
| `shared/cloud-platform-ipc.ts` | `CloudOpenResult` 失败分支新增 `connectDiagnostics` |
| `use-cloud-session.ts` / `cloud-connect-failure-dialog.tsx`（新） | 打开失败时弹出面板：错误码、逐地址步骤、重试、复制诊断；重试复用同一项目 |
| 测试 | `cloud-connect-diagnostics.test.ts`（真实平台/真实 TCP/真实中继进程）、`cloud-connect-failure-dialog.test.tsx`（3 例） |

**验证（`evidence/m91-connect-diagnostics/connect-diagnostics.json`）**：
- 直连地址是关闭端口、中继进程被杀后打开项目 → `ENDPOINT_UNREACHABLE`，`probes` 依次为 `direct 127.0.0.1:64528 不可达 1ms` 与 `relay 127.0.0.1:64541 不可达 0ms`。
- 该记录经 `failedCloudOpen` 出现在 IPC 结果里（`connectDiagnostics.probes` 长度 2），渲染层拿到的是同一份数据。
- 面板测试：显示错误码与两步诊断、重试回调触发、重试中禁用、复制文本与界面一致。
- 重申：重启中继后**同一客户端不重新登录**重试成功（`route=relay`，`status.get` 可用）。
- **负向对照**：① 去掉 IPC 诊断透传 → `connectDiagnostics` 为 undefined，断言转红；② 不记录探测步骤 → 步骤数 0，断言转红。均恢复后全绿。
- 回归：相关套件 **10/10**；`tc:node`、`tc:web` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 诊断步骤是「TCP 可达性」，不是 TLS 握手或鉴权失败原因；这两类失败有各自错误码（如 426/401、`FINGERPRINT_MISMATCH`），面板只在全不可达时出现。
2. 未实现 FR-5.7 的「连接诊断」常驻页与延迟展示；面板只在失败时出现。
3. 复制依赖浏览器/Electron 的 clipboard 权限；不可用时文本仍在屏幕上。

## M92 补齐 AC-10 的「受管 UI 无下载/导出入口」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-10 已证明主机拒绝导出 RPC 与读预算，但**从未断言受管界面真的没有下载/导出入口**。检查时还发现一处实际错误：图片预览文案写着「预览请使用文件下载或本地面板」——指向一个按策略不存在、也不应存在的入口。

| 改动 | 内容 |
|---|---|
| `src/renderer/src/cloud/cloud-file-panel.tsx` | 图片预览文案改为「托管项目不提供图片预览与下载」，不再引导用户去找下载 |
| `src/renderer/src/cloud/cloud-managed-no-export.test.tsx`（新） | 渲染真实受管工作区 + 文件面板（记录型 RPC）：遍历全部可点控件核对标签，完整走一遍浏览流程核对 RPC 方法集合 |

**验证（`evidence/m92-managed-no-export/managed-no-export.json`）**：
- 可点控件共 6 个：返回工作台 / 刷新状态 / 上一级 / 工作区 / 目录 docs / 文件 README.md；**匹配「下载/导出/另存/download/export」的为 0 个**。
- 走完「文本预览 → 进 docs → 打开 logo.png」后，实际发出的 RPC 只有 `status.get`、`files.readDir`、`files.readPreview`；导出族（`files.download`、`files.downloadFolder`、`terminal.exportArtifact`、`browser.download`、`browser.savePage`）调用数为 **0**。
- 图片提示文案为「托管项目不提供图片预览与下载」，且不含任何引导下载的措辞。
- **负向对照**：① 往文件面板加一个「下载」按钮 → 控件标签断言转红（`expected [ '下载' ] to deeply equal []`）；② 让预览额外调用 `files.download` → RPC 断言转红（`expected [ 'files.download', … ] to deeply equal []`）。均恢复后全绿。
- 回归：云端渲染层全部用例 **43/43**（9 个文件）；`tc:web` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 这里证明的是**当前受管 UI** 无入口，不是「永远不可能有」；主机侧拒绝（M35-1）才是控制，UI 只是便利。
2. 未覆盖 Electron 原生菜单/右键菜单中是否出现下载项（云模式复用的是本地工作区外壳）；如需覆盖应在 Electron/CDP 环境做一次菜单枚举。

## M93 补齐 AC-18 的「导航隐藏 + 直接路由拦截」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-18 的接口 403 与 denied 审计已自动化，但 `#adminNav.hidden` 与「直接访问管理路由」**只有截图/人工检查**。这两条正是管理界面"看起来可用"与"确实不可用"的分界。

| 改动 | 内容 |
|---|---|
| `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`（新） | 真实平台进程 + **真实前端文件**（`apps/web/index.html`、`apps/web/app.js`）+ happy-dom：脚本在注入 fetch shim 后执行，登录走真实表单提交与真实 Ed25519 令牌 |

**验证（`evidence/m93-web-admin-gating/web-admin-gating.json`）**：
- 开发者登录：外壳可见，角色徽标「开发者」，`#adminNav.hidden = true`，4 个管理导航项均不可见。
- 强行点击被隐藏的「主机」导航项：面包屑变「无权访问」，内容区显示无权限页（含「没有平台管理权限」、不含「注册主机」），无导航项残留 active。
- 同一会话接口：`GET /v1/hosts`、`GET /v1/audit/events`、`PUT /v1/policies/download`、`GET /v1/audit/verify` 全部 **403**，其中 `audit_verify` 的拒绝写入审计（按 actor + result + eventType 精确断言）。
- 管理员用例：导航组可见、角色「平台管理员」、`hosts` 路由正常渲染（不是无权限页）。
- **负向对照**：① 无条件显示管理导航 → 「the admin nav group must be hidden」转红；② 删掉 `navigate()` 的 `ADMIN_ROUTES` 守卫 → 强行点击后主机页直接请求平台并因 403 抛错，用例转红。均恢复后全绿。
- 回归：平台全量 **139/139**；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 这是 happy-dom 驱动的真实前端脚本 + 真实后端，不是真实浏览器渲染；CSS 层面的可见性（如被遮挡）不在覆盖范围。
2. `/v1/hosts`、`/v1/audit/events`、`PUT /v1/policies/download` 的 403 **不写审计**（只有 `audit_verify` 等少数路径写）。若要求"每个被拒的管理操作都留痕"，需在服务端统一补 denied 审计——这是实现缺口，未在本轮擅自扩大范围。
3. `#adminNav` 的隐藏依赖登录响应里的 `permissions`；若平台返回的角色集变化，前端按权限判定而非硬编码角色名，已如此实现。

## M94 补齐 AC-18 的「所有管理接口拒绝都写审计」（本轮，主会话执行）

**问题（M93 记录的实现缺口）**：AC-18 要求被拒的管理操作写审计，但 12 个管理/审计接口里只有 `project_create`、`project_update`、`signing_key_rotate`、`audit_verify` 留痕；`GET /v1/hosts`、`POST /v1/hosts/tokens`、主机维护/吊销、下载策略、项目策略、`GET /v1/audit/events|status` 全部只返回 403。「谁尝试过进入管理台」无法回答。

| 改动 | 内容 |
|---|---|
| `apps/api/src/server.ts` | 新增 `denyPrivileged()`：写 `denied` 审计（含 `reason`、`requiredPermission`）后返回 403；9 处裸 403 改为调用它；3 处已有审计补上同样的 `metadata`，`signing_key_rotate` / `audit_verify` 也统一走该函数 |
| `test/e2e/admin-denial-audit.e2e.test.ts`（新） | 真实平台进程 + 真实登录令牌，逐一访问 12 个管理接口并核对审计链 |

**验证（`evidence/m94-admin-denial-audit/admin-denial-audit.json`）**：
- 12 个接口（hosts 列表、主机令牌、维护、吊销、全局下载策略、项目策略、审计事件、审计状态、审计校验、密钥轮换、项目创建、项目更新）开发者访问 **全部 403**。
- 开发者名下的 `denied` 事件 **12 条**，逐条带 `targetType`／`targetId`／`requiredPermission`（`platform:admin` 或 `platform:auditor`）；`missingEventTypes` 为空。
- 管理员读取 `/v1/hosts` 成功（200），且管理员名下无 denied 事件——过滤条件真实生效，不是把所有 403 都算数。
- 新增 12 条后整链 `verify.ok, checked=14`。
- **负向对照**：把 `GET /v1/hosts` 改回裸 403 → 用例报 `no denied event for: host_list` 转红；恢复后全绿。
- 回归：平台全量 **140/140**；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 拒绝审计用 best-effort 写入：调用方已被拒绝，审计盘坏不该把 403 变成 500；若要求「拒绝也绝不丢」，需在审计不可用时改返回 503。
2. 未对「已登录但越权的普通接口」（如跨项目 404）补审计——那是 AC-03 的 `project_access` denied，已覆盖。
3. 拒绝事件的 `eventType` 复用各接口的成功事件名（`host_list`、`policy_update` 等），靠 `result=denied` 区分；审计查询需同时按 result 过滤。

## M95 补齐 AC-04 的「成员真实打开新项目」（本轮，主会话执行）

**问题（M70 验收映射）**：AC-04 只验证到「成员刷新可见 + 取票 200」，**没有对新登记的项目做过一次真实打开**——而取票成功不等于工作区可用。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-admin-grant-open.test.ts`（新） | 真实平台进程 + 真实主机注册（一次性令牌）+ 真实 TLS Runtime + 真实 E2EE：成员先登录，管理员再建项目并授权，同一会话刷新后打开 |
| 文档 | `test-plan.md` AC-04 由 PASS(部分) 升为 PASS |

**验证（`evidence/m95-admin-grant-open/admin-grant-open.json`）**：
- 授权前：成员列表不含 `m95-granted-project`。
- 授权后**同一会话刷新**（不重新登录）：项目出现，`hostStatus=online`，`permissions` 含 `open`。
- 真实打开：`ensureCloudWorkspace` 返回 `ok`，`route=direct`，检出位于该用户自己的路径下（`zhangsan/main`）。
- 打开后 `status.get` 成功，`files.read` 读到工作区内的 `README.md`。
- 组外开发者 `lisi` 刷新后仍看不到该项目。
- 首轮失败如实记录：未设置 `ORCA_CLOUD_ADVERTISE_HOST` 时平台不下发直连地址、客户端也没有中继可回落，报 `ENDPOINT_UNREACHABLE`——补上广播地址后通过（这正是 AC-07 诊断面板会展示的那类失败）。
- **负向对照**：① 授权改为空权限 → 刷新后不可见转红；② 用创建前的旧列表冒充刷新 → 同样转红。均恢复后全绿。
- 回归：本案与多项目用例 2/2；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 项目路径直接指向已存在的仓库目录；未覆盖「从 repoUrl 克隆」的 provisioning 路径（已有 M64/M65 用例覆盖准备与失败重试）。
2. 只验证了直连打开；中继下的打开由 M90 覆盖。

## M96 修正授权撤销范围（AC-12）（本轮，主会话执行）

**发现的缺陷（写真实用例时暴露）**：`PUT /v1/projects/:id/grants` 无论 `subjectType` 是什么，都调用 `revokeProjectCredentials()` 写入**项目级**撤销。也就是说，移除某个用户的个人授权，会把该项目**所有在线用户**一起 4403 断开；组授权变更则整项目断开（这一条是必要的，主机无法解析组成员）。设计 §7.4 要求"把该用户/项目的 `jti` 族与 `userId` 写入撤销集合"，用户级变更本就该是精确的。

| 改动 | 内容 |
|---|---|
| `apps/api/src/server.ts` | 用户级授权变更改为 `revokeUserCredentials()`；组级（或找不到该用户）仍按项目撤销。用户撤销写入的是**用户名**——票据 `sub` 为 `user:<username>`，而主机按该声明比对撤销集合 |
| `src/main/cloud-platform/cloud-grant-revocation-scope.test.ts`（新） | 真实平台 + 真实注册主机（心跳为撤销通道）+ 真实 TLS Runtime + 真实 E2EE；两个用户同一项目 |

**验证（`evidence/m96-grant-revocation-scope/grant-revocation-scope.json`）**：
- 移除 lisi 的个人授权后，lisi 的会话在 **9,901ms** 内以 **4403** 关闭（预算 60s）。
- 同一项目、组授权未变的 zhangsan，在 lisi 关闭后继续等待 12.9 秒，会话状态仍为 **OPEN**。
- **负向对照**：改回项目级撤销 → zhangsan 被误断（`expected 3 to be 1`，3=CLOSED），用例转红；恢复后全绿。
- 回归：M88（组授权收回）与本案 **3/3**；平台全量 **140/140**；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 组授权变更仍是项目级撤销——同一项目其它组的用户会被一并断开。这是主机侧信息不足（无 LDAP 组数据）后的保守选择；若要精确，需要平台在票据里带上受影响用户集合，或主机上报成员映射。
2. 用户撤销以用户名为键：若未来支持改用户名，历史撤销记录会失配（当前用户不可改名）。
3. 未撤销 `jti` 族；单张票据失效仍靠短 TTL（60 秒凭据）加项目/用户撤销兜底。

## M97 补齐 AC-01 的「浏览器渲染到工作台可交互」（G-12 最后一半）（本轮，主会话执行）

**问题（M70 验收映射与 G-12）**：AC-01 只测了 API 段（登录→项目列表 50 次采样 P95=1.3ms）。验收原文是「**从提交到工作台可交互** P95 ≤ 1.5s」——API 快不代表用户看到界面。

| 改动 | 内容 |
|---|---|
| `cloud-platform/test/e2e/web-workbench-latency.e2e.test.ts`（新） | 真实平台进程（提供真实 `apps/web`）+ 真实 Chromium（Playwright，headless，`channel: chrome`）；每次采样用全新上下文（冷 localStorage/连接池），计时从点击「登录」到**工作台项目行已渲染**且不再是「加载中」 |
| 文档 | `test-plan.md` AC-01 由 PASS(部分) 升为 PASS |

**验证（`evidence/m97-workbench-latency/workbench-latency.json`）**：
- 50 次采样：P95 **71ms**、中位 64ms、最小 58ms、最大 72ms（预算 1500ms）。
- 每次采样都断言：工作台列出了有权限项目（`payment-service`），开发者看不到管理导航。
- **测量有效性（灵敏度对照）**：对 `/v1/projects` 注入 400ms 延迟后，同一口径 P95 为 **485ms**（+414ms）——指标确实随后端变慢而移动。
- **负向对照**：把注入延迟加大到 1600ms → 断言按预期失败（`P95 1677ms over budget 1500ms`）；恢复后全绿。
- 回归：平台全量 **141/141**；`typecheck:cloud-e2e` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 测的是**浏览器版工作台**（平台自带的 `apps/web`）。开发者日常使用的原生 Orca 界面的首屏渲染未在 Electron/CDP 下测量，需要一套带 CDP 的 Electron 启动环境。
2. 无头 Chromium 不等于用户的办公机：没有真实网络 RTT、代理与安全软件开销。预算在本地 71ms 达成，真实网络下应重测。
3. 每次采样是全新上下文（冷启动），比长时间使用后的有缓存状态更严格，这与「不含首次安装」的口径相符。

## M98 补齐 AC-16 的「多用户/多目录会话隔离」（G-14）（本轮，主会话执行）

**问题（验收报告 G-14）**：AC-16 的文档口径是「刷新令牌有效」，真实实现还依赖磁盘会话文件；此前只验证了**单用户、单目录**的重启恢复，多用户/多目录隔离未测。

| 改动 | 内容 |
|---|---|
| `src/main/cloud-platform/cloud-session-user-isolation.test.ts`（新） | 真实平台进程 + 真实注册主机/TLS Runtime + 两个真实数据目录；`CloudSessionService` 每个目录一个实例 |
| 文档 | `test-plan.md` AC-16 补上隔离证据（仍为 PASS，覆盖说明更完整） |

**验证（`evidence/m98-session-user-isolation/session-user-isolation.json`）**：
- 目录 A 登录 zhangsan、目录 B 登录 lisi：设备 ID 不同（`deviceIdsDistinct=true`）。
- 项目可见性各自正确：A 能列出项目（`proj_…`），B 列表为空（lisi 不在 `team-payment`）。
- 两个目录各自重启（新服务实例）：分别恢复为「张伟」/「李四」，设备 ID 与各自登录时一致。
- A 目录登出：A 的会话文件被删除，B 的文件保留；B 重启仍 signed-in 且身份为李四；A 再启动为 `signed-out`。
- **负向对照**：让会话文件忽略 `userDataPath` 落到同一路径 → 两个目录互相覆盖，隔离断言转红；恢复后全绿。
- 回归：本案 + 持久化单测 + M66 重启用例 **7/7**；`tc:node` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：
1. 隔离边界是**数据目录**：同一目录同时跑两个实例会共享同一会话文件与设备身份（后写覆盖），这是 Electron 的既定假设（一个用户一个 userData）。
2. 会话文件本身就是凭据（含刷新令牌与设备私钥）；把文件复制到另一目录/机器会带着该身份继续用。文件权限已收紧到仅当前用户可读写（M66 用例），磁盘加密依赖操作系统。
3. 未覆盖 Windows 的 %APPDATA% 路径差异（权限位用例在 win32 上跳过）。

## 下一步（设计已调整：见 `remote-connectivity/design/2026-11-13-cloud-dev-platform/design-adjustment-native-ui.md`）

**已完成**：M41–M98（路径边界、文件面板、终端/agent 边界、工作区侧车、浏览器取票与 E2EE、原生界面回归、多项目连接、管理员会话页、初始导航、类型工程边界、项目创建 provisioning、准备失败可见与重试、开发者自助创建项目、创建后失败并入重试、会话自动续期、浏览器会话续期、云设备 token 清理、签到准备有界并行、项目归档闭环、云端会话持久化、云端 agent.launch 真实执行、里程碑 L3 收口、云端结构化 agent 会话）。**用户决策**（普通开发者直接进入原生界面、管理员用独立浏览器会话页、每项目独立连接、文件面板随管理员页保留）均已落地。

**建议下一步**：
1. **G-12 已收口**：平台无业务流量（M85）、中继无明文（M86）、浏览器渲染 P95（M97）均已有证据；仅剩原生 Electron 界面的渲染 P95 未测（需 CDP 环境）。
2. **人工验收准备**：整理验收清单与证据索引（AC-29 桌面与浏览器两半均已覆盖）。
   - AC-18 的「所有被拒的管理接口写审计」已由 M94 补齐（12 个接口、逐条含 requiredPermission）。
3. **G-04 部署形态**：单写入者定序与 fail-closed（M80）、主备租约接管（M87）已完成；Redis Stream 队列、PostgreSQL/对象存储归档与签名锚点仍待部署阶段实现。
4. **人工验收**：按 design/test-plan 逐条核对验收标准；重点看桌面真实界面（登录 → 侧栏项目 → 本人 checkout → 终端/文件/git/agent）与管理员浏览器会话页。
4. 真机/跨平台：Windows、WSL、SSH 主机各跑一遍关键路径（provisioning、路径边界、PTY、会话持久化权限位）。
5. L4 全量回归：发版前单独执行，含桌面 Electron 渲染验证。
