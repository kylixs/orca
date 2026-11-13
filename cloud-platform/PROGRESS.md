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

## 下一步（设计已调整：见 `remote-connectivity/design/2026-11-13-cloud-dev-platform/design-adjustment-native-ui.md`）

**已完成**：M41–M67（路径边界、文件面板、终端/agent 边界、工作区侧车、浏览器取票与 E2EE、原生界面回归、多项目连接、管理员会话页、初始导航、类型工程边界、项目创建 provisioning、准备失败可见与重试、开发者自助创建项目、创建后失败并入重试、会话自动续期、浏览器会话续期、云设备 token 清理、签到准备有界并行、项目归档闭环、云端会话持久化、云端 agent.launch 真实执行）。**用户决策**（普通开发者直接进入原生界面、管理员用独立浏览器会话页、每项目独立连接、文件面板随管理员页保留）均已落地。

**建议下一步**：
1. **人工验收**：按 design/test-plan 逐条核对验收标准；重点看桌面真实界面（登录 → 侧栏项目 → 本人 checkout → 终端/文件/git/agent）与管理员浏览器会话页。
2. 真机/跨平台：Windows、WSL、SSH 主机各跑一遍关键路径（provisioning、路径边界、PTY、会话持久化权限位）。
3. 结构化 agent 会话路径的端到端验证（需要真实 Claude 会话宿主）。
4. L4 全量回归：发版前单独执行，含桌面 Electron 渲染验证。
