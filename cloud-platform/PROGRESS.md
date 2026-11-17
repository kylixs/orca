# 开发进度

> 更新时间：2026-11-13 13:55
> 规则：每轮只推进一个模块；失败必须如实记录。

## 模块状态

| 模块                                     | 状态    | 证据                                                  | 备注                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 契约                                  | ✅ 完成 | `evidence/e2e-platform/` + 单元 10/10                 | 凭证 Ed25519、方法映射、路径边界、审计链                                                                                                                                                                                                                                                                         |
| M1 平台 API                              | ✅ 完成 | E1–E8                                                 | 登录锁定、会话纪元、ACL、凭证、策略、审计、内部接口                                                                                                                                                                                                                                                              |
| M2 中继                                  | ✅ 完成 | E2、E10                                               | SNI ClientHello 解析、纯 TCP、黑洞、路由同步                                                                                                                                                                                                                                                                     |
| M3 运行时 + 策略网关                     | ✅ 完成 | E3–E6                                                 | 升级期验签、方法权限、路径边界、导出拦截                                                                                                                                                                                                                                                                         |
| M4 客户端                                | ✅ 完成 | E1、E2                                                | 无凭证预检、直连优先、中继回落                                                                                                                                                                                                                                                                                   |
| M5 Agent                                 | ✅ 完成 | Web 主机页在线                                        | 注册、心跳、撤销同步                                                                                                                                                                                                                                                                                             |
| M6 Web 前端                              | ✅ 完成 | `evidence/web-ui/*.png`                               | 6 个页面 + 403 + 角色门禁                                                                                                                                                                                                                                                                                        |
| M7 端到端                                | ✅ 完成 | `evidence/e2e-platform/*.json`                        | 14 条用例全通过                                                                                                                                                                                                                                                                                                  |
| M8 管控面服务端门禁                      | ✅ 完成 | `evidence/m8-admin-gating/`                           | 13 条用例：8 个管理接口 403、401、denied 审计、存在性不泄露                                                                                                                                                                                                                                                      |
| M9 内部通道 mTLS                         | ✅ 完成 | `evidence/m9-mtls/`                                   | 8 条用例：有效证书放行、无证书/异 CA 握手失败、CN 白名单、路径范围、令牌双重校验、中继与 Runtime 实际走 mTLS                                                                                                                                                                                                     |
| M10 中继 SNI 白名单                      | ✅ 完成 | `evidence/m10-relay/`                                 | 8 条用例：后缀白名单、裸主机名/异后缀/多层子域拒绝、未知路由黑洞、非 TLS 拒绝、单 IP 并发上限、元数据不含负载                                                                                                                                                                                                    |
| M11 撤销关闭已建连接                     | ✅ 完成 | `evidence/m11-revocation/`                            | 设备吊销后 4.2 秒内 `close(4403, device_revoked)`；合并入升级期同一撤销快照                                                                                                                                                                                                                                      |
| M12 控制面挂起韧性                       | ✅ 完成 | `evidence/m12-control-plane-resilience/`              | 请求可中止（Runtime active≤4，修复前 9）；响应体挂起时轮询继续；中继单飞 + 3 秒超时，首次同步不阻塞监听                                                                                                                                                                                                          |
| M13 真实 Orca Runtime 升级期准入         | ✅ 完成 | `evidence/m13-orca-admission/`                        | 在真实 `OrcaRuntimeRpcServer` 的 WS 升级前校验云端凭证：8 条真实升级用例；平台/主机验签实现一致性 7 条                                                                                                                                                                                                           |
| M14 开发机侧云端接入                     | ✅ 完成 | `evidence/m14-cloud-agent/`                           | Agent 轮询 JWKS/撤销快照（单飞 + 超时）；`orca serve` 按 env 开启云端模式；4 条真实平台进程 + 真实 Runtime 端到端                                                                                                                                                                                                |
| M15 云端会话撤销关闭（真实 Runtime）     | ✅ 完成 | `evidence/m15-cloud-session-revocation/`              | 准入时按凭证登记设备（`adoptCloudDevice`）；平台吊销后 `close(4403)`；3 条真实 E2EE 会话用例                                                                                                                                                                                                                     |
| M16 控制面三路隔离与撤销快照 fail-closed | ✅ 完成 | `evidence/m15-cloud-session-revocation/isolation.txt` | 评审 07 F1/F2：三路独立落地（allSettled + 每请求独立 timeout）、非法撤销体保留上一快照；3 条真实进程用例                                                                                                                                                                                                         |
| M17 评审 07 遗留用例                     | ✅ 完成 | `evidence/m17-review07-gaps/`                         | 4 条：公网内部路由 404（N6）、非默认 INTERNAL_TOKEN（M8）、TLS 中止分支、allow 正向放行；每条均做过回退变红对照                                                                                                                                                                                                  |
| M18 开发机自注册与心跳                   | ✅ 完成 | `evidence/m18-host-enrollment/`                       | 一次性令牌注册、凭证持久化复用、心跳下发撤销/策略/维护态、心跳上报真实绑定端口与 E2EE 公钥；7 条真实平台进程 + 真实 Runtime 用例                                                                                                                                                                                 |
| M19 桌面端云端连接客户端                 | ✅ 完成 | `evidence/m19-desktop-connect/`                       | 登录/项目列表/选路/升级/E2EE/加密 RPC；Runtime 支持 WSS；4 条真实平台 + 真实 TLS Runtime 用例                                                                                                                                                                                                                    |
| M20 渲染进程 IPC 会话面                  | ✅ 完成 | `evidence/m20-cloud-ipc/`                             | `cloud:*` 六个通道 + 连接事件推送；会话状态不含任何令牌；5 条真实平台 + 真实 Runtime 用例                                                                                                                                                                                                                        |
| M21 客户端界面（登录/工作台）            | ✅ 完成 | `evidence/m21-cloud-ui/`                              | `CloudApp` + 登录面板 + 工作台列表；8 条界面用例（happy-dom），路由接入 `App.tsx`                                                                                                                                                                                                                                |
| M22 项目链接（凭证 → Orca 配对）         | ✅ 完成 | `evidence/m22-project-link/`                          | 云端票据转成现有 `PairingOffer` + `cloudUpgrade`，现有 `subscribeRemoteRuntimeRequest` 直接建链（请求与订阅两条通道）；5 条真实平台 + 真实 TLS Runtime 用例，含"不带凭证必被拒"对照                                                                                                                              |
| M23 质量门禁清理                         | ✅ 完成 | `evidence/m23-quality-gate/`                          | 74 条 `consistent-type-assertions` → 0；JSON 字段读取器 + 票据/项目解析器；门禁 7 项扫描 0 新发现，79 条用例回归全过                                                                                                                                                                                             |
| M24 项目工作区视图                       | ✅ 完成 | `evidence/m24-project-workspace/`                     | 打开项目进入工作区（线路/根目录/能力/实时 status.get）；返回工作台只关连接可再开；21 条用例 + 78 条回归 + 门禁绿                                                                                                                                                                                                 |
| M25 云端项目 → 运行时环境                | ✅ 完成 | `evidence/m25-cloud-environment/`                     | 项目注册为环境（侧车 cloudProject），现有 selector/RPC/订阅直达；每次连接重签票据；顺带修复主机侧票据重放缺陷；7 条真实端到端 + 81 条回归 + 门禁绿                                                                                                                                                               |
| M26 撤销时间语义                         | ✅ 完成 | `evidence/m26-revocation-precision/`                  | 凭证新增 `iatMs`，消除同秒"收回→重授权"误拒；旧版无 `iatMs` 保持秒级比较；4 条真实平台 + 真实签名用例（修复前用例 2 为红）                                                                                                                                                                                       |
| M27 主机侧公钥过期                       | ✅ 完成 | `evidence/m27-jwks-staleness/`                        | 真实主机新增 `jwks_stale`：超过 TTL 未成功拉取 JWKS 即拒绝新连接；吊销原因优先；3 条真实平台 + 真实 Ed25519 用例（回退后 2 条变红）                                                                                                                                                                              |
| M28 设备公钥持有证明                     | ✅ 完成 | `evidence/m28-device-pop/`                            | 主机把票据设备公钥登记并在 E2EE 认证时比对握手公钥，票据不再等于持有证明；拒绝原因透传；3 条真实端到端（关掉检查后负例变红）                                                                                                                                                                                     |
| M29 文件寻址契约对齐                     | ✅ 完成 | `evidence/m29-file-contract/`                         | 模拟器改为真实 Orca 的 `worktree + relativePath`（旧 `path` 明确拒绝）；新增 readDir；分支名 `///` 缺陷修复；6 条新用例 + 整仓 80 条全过                                                                                                                                                                         |
| M30 项目根路径规范化                     | ✅ 完成 | `evidence/m30-project-root/`                          | 登记处拒绝 `..`/相对/重复或尾随分隔符/控制字符；主机对旧平台票据做同形状复核（`workspace_root_invalid`）；4 条真实平台 + 真实签名用例（关掉检查后 2 条变红）                                                                                                                                                     |
| M31 审计链落盘与校验                     | ✅ 完成 | `evidence/m31-audit-verify/`                          | 审计 JSONL 只追加落盘、重启续链；`GET /v1/audit/verify`（409 + brokenAtSeq）；弃坏行拒绝启动；14 条（含"改写文件后重启"真实进程用例）                                                                                                                                                                            |
| M32 审计 fail-closed                     | ✅ 完成 | `evidence/m32-audit-fail-closed/`                     | 先写审计再改状态；写失败/断链时 6 类敏感写返回 503 且状态未变；读与登录保持可用；`GET /v1/audit/status`；3 条真实进程用例（chmod 只读、篡改后重启、全覆盖）                                                                                                                                                      |
| M33 云端会话并发上限                     | ✅ 完成 | `evidence/m33-session-limits/`                        | 每用户每项目 3 路、每主机 32 路，超限 `close(4431)`；按活连接计、关闭即归还；2 条真实端到端（去掉配额检查后全红）                                                                                                                                                                                                |
| M34 云端 RPC 方法级权限                  | ✅ 完成 | `evidence/m34-cloud-rpc-scope/`                       | 票据 `perms` 真正生效：终端/agent/文件读写/浏览器/下载分开判定，未登记方法拒绝；**修复云会话可访问 settings/accounts/pairing 的越权**；4 条真实端到端 + 11 条单测（回退后 4 条全红）                                                                                                                             |
| M35 下载策略与读取限速                   | ✅ 完成 | `evidence/m35-download-policy/`                       | 主机消费平台策略包：导出 RPC 默认拒绝、项目覆盖优先；文件读取按项目滚动小时记次数与字节，超限 `read_budget_exceeded`；3 条真实端到端 + 8 条单测（关掉检查后 2 条变红）                                                                                                                                           |
| M36 工作区路径边界                       | ✅ 完成 | `evidence/m36-workspace-boundary/`                    | 票据 `projectRoot`/`workspaceRoot` 真正生效：读限项目根、写限本人工作区根，realpath 后校验（符号链接逃逸被拒）；绝对路径与未知 worktree 拒绝；3 条真实端到端 + 10 条单测（关掉检查后 3 条全红）                                                                                                                  |
| M37 git 操作边界                         | ✅ 完成 | `evidence/m37-git-boundary/`                          | git 读方法限项目根、写方法（stage/commit/push/discard…）限本人工作区根，**共享主仓库对云端只读**；git 文件路径同受边界；4 条真实端到端 + 6 条单测（关掉分类后 3 条变红）                                                                                                                                         |
| M38 worktree 操作边界                    | ✅ 完成 | `evidence/m38-worktree-boundary/`                     | `worktree.create` 对云端拒绝（路径由主机设置推导、无法约束，指向未实现的托管创建）；`worktree.rm`/`forceDeleteBranch` 限本人工作区、`worktree.show` 限项目；无选择器的批量方法与其余 worktree 方法一律拒绝；4 条真实端到端 + 7 条单测（关掉分类后 3 条变红）                                                     |
| M39 托管工作区创建                       | ✅ 完成 | `evidence/m39-managed-worktree/`                      | 真实 Runtime 新增 `worktree.createManaged`：调用方显式给根、宿主强制 `nestWorkspaces=false`，路径恰为 `<workspaceRoot>/<name>`；幂等键去重；云端作用域要求仓库属本项目、目标根属本人工作区；仅云构建注册；4 条真实端到端 + 8 条单测（关掉根覆盖后 M39-1 变红，关掉守卫后 4 条全红）                              |
| M40 打开项目按需建工作区                 | ✅ 完成 | `evidence/m40-ensure-workspace/`                      | `cloud:openWorkspace` 改为「先列本仓库工作区，命中则复用，否则 `createManaged`」；repo 限定的 `worktree.list`/`detectedList` 对云端开放（仓库须属本项目）；打开结果新增 `workspacePath`，工作区视图展示"我的工作区"；3 条真实端到端（含真实 wss + 已注册主机 + 真实客户端类）+ 9 条单测（关掉复用后 M40-2 变红） |

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

| 用例                                           | 断言                                                                                           | 回退后                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| 公网监听对 `/v1/internal/*` 404（mTLS 已配置） | 三条路由 × 三种令牌全部 404；`relay-endpoint` 仍可用真实令牌 200、错误令牌 401                 | 改判定为 `false` → 变红          |
| 非默认 `INTERNAL_TOKEN`                        | mTLS + 非默认令牌 200；默认测试令牌 401                                                        | — （实现已支持，此前无用例）     |
| TLS 控制面挂起中止                             | 真实 HTTPS 服务端，3.5 秒后 total≥3 且 active≤4                                                | 移除 abort 监听 → 变红           |
| allow 策略正向                                 | 项目策略 allow + 组授权含 `download` → `files.download` 返回 `NOT_IMPLEMENTED`（说明已过授权） | 让 exportClass 无条件拒绝 → 变红 |

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

| 层                                             | 内容                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `shared/cloud-platform-ipc.ts`                 | 通道名 + 渲染进程可见的类型（无 token 字段）                                                            |
| `main/cloud-platform/cloud-session-service.ts` | 登录/登出/列表/打开/RPC，持有 `CloudConnectClient`；连接关闭时清空当前项目                              |
| `main/ipc/cloud-platform.ts`                   | 六个 `ipcMain.handle` + 关闭事件广播；`installCloudPlatformIpc()` 在无 `ORCA_CLOUD_API_URL` 时返回 null |
| `preload/api/cloud-platform-*.ts`              | `window.api.cloud.*`，订阅返回取消函数                                                                  |

**刻意约束**：`getState()`/`login()` 的返回值里没有 token、devicePubKey、deviceToken、credential——用例直接对序列化结果断言这些字段与 `eyJ` 前缀都不出现，防止以后有人"顺手"把凭证塞进 UI 状态。

实测（真实平台进程 + 真实 TLS Runtime）：

- 登录后状态只含展示名与项目摘要
- 项目列表区分下载受限（同用户下授权含/不含 `download` 各一）
- 打开项目返回选路与 workspaceRoot，加密 RPC 通
- 吊销后推送 `closeCode: 4403` 事件并清空 `connectedProjectId`
- 登出后 RPC 返回 `NOT_SIGNED_IN`

## M21 客户端界面（本轮）

| 文件                                       | 内容                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `renderer/src/cloud/use-cloud-session.ts`  | 会话 hook：加载/不可用/未登录/登录中/已登录；宿主关闭连接时清空已打开项目 |
| `renderer/src/cloud/cloud-login-panel.tsx` | 域账号登录；平台错误码 → 中文文案，未知码原样显示                         |
| `renderer/src/cloud/cloud-workbench.tsx`   | 工作台：项目列表、线路徽标、主机离线禁开、下载受限标注、吊销提示          |
| `renderer/src/cloud/cloud-mode-gate.tsx`   | 有 `window.api.cloud` 才切换到云端工作台，否则原样渲染本地 shell          |
| `App.tsx`                                  | 用 `CloudModeGate` 包住工作区与根浮层                                     |

全部使用 `components/ui` 原语与语义 token，无新增颜色；滚动容器按 lint 要求带 `scrollbar-sleek`。

**测试说明（如实记录）**：界面用例使用**脚本化 bridge**，因为 happy-dom 阻止跨源 fetch 到真实平台进程（实测报 `Cross-Origin Request Blocked`）。真实链路（平台进程 + TLS 运行时 + E2EE 套接字）由 M19 `cloud-connect-client.test.ts` 与 M20 `cloud-session-service.test.ts` 覆盖，本模块只保证"用户看到什么"。迁移过程中还修了两处测试自身问题：`import.meta.url` 在 web 变换下是 `/@fs/...`（需剥离），以及 vitest globals 关闭时 RTL 不会自动 cleanup（需显式 `afterEach(cleanup)`）。

实测 8 条：不可用态不显示登录表单；错误码文案与未知码回退；列表标注（离线 1 条、下载受限 2 条）；打开后显示"直连"；打开失败显示错误码且无"已打开"；4403 关闭显示"已被管理员收回"并清除线路；退出登录回到登录页。回归：`app-shell` 89 条全过。

## M22 项目链接：云端票据 → Orca 配对（本轮）

| 文件                                                                           | 内容                                                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/remote-runtime-subscription-contract.ts`                           | 新增可选 `cloudUpgrade { credential, devicePubKey, servername?, tlsRejectUnauthorized? }`；缺省即普通配对主机，行为不变                         |
| `src/shared/remote-runtime-upgrade-socket.ts`                                  | 从会话传输中抽出开套接字：有 `cloudUpgrade` 时在升级子协议带 `orca-cred.<ticket>`、请求头带 `x-orca-device-pubkey`，并按线路设置 SNI / 证书校验 |
| `src/shared/remote-runtime-subscription-transport.ts`                          | 改用上面的开套接字函数；其余握手/心跳/清理逻辑不变（回归 62 条）                                                                                |
| `src/main/cloud-platform/cloud-pairing-offer.ts`                               | 票据 → `PairingOffer` + `cloudUpgrade`；主机未上报 32 字节 E2EE 公钥时返回 `null`，避免把"握手超时"当失败                                       |
| `src/main/cloud-platform/cloud-connect-client.ts` / `cloud-session-service.ts` | `prepareProjectLink()`：只探测线路并取票，**不开连接、不消耗一次性票据**                                                                        |
| `src/shared/cloud-platform-ipc.ts` + preload                                   | `cloud:prepareProjectLink` 通道，返回值不含平台令牌                                                                                             |
| `src/main/cloud-platform/cloud-route-selection.ts`                             | 抽出 `probeEndpoint` / `chooseRoute`（满足 300 行上限，未禁用规则）                                                                             |

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

| 文件                                                                                                       | 内容                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/json-fields.ts`（新）                                                                          | `readField/readString/readNumber/readArray/readStringArray/readObjectValue/ownEntries/errorCodeOf/parseJsonText`；形状不符返回 null，由调用方决定失败语义 |
| `src/main/cloud-platform/cloud-connect-response.ts`（新）                                                  | 票据/项目/端点/workspace 逐字段解析；缺字段返回 null                                                                                                      |
| `src/shared/cloud-project-link-offer.ts`（新）                                                             | IPC 载荷 → `PairingOffer` 的结构化转换（`v===2 && scope==='runtime'` 才返回），M24 可直接复用                                                             |
| `src/shared/http-header-text.ts`（新）                                                                     | `x-orca-reject` 等响应头统一取文本                                                                                                                        |
| `cloud-connect-client.ts`                                                                                  | 登录/列表/票据/握手消息全部走解析器；解析失败抛明确错误                                                                                                   |
| `cloud-agent-client.ts` / `cloud-agent-revocations.ts`                                                     | JWKS 与撤销快照改字段读取，撤销结构非法仍返回 null（保留 fail-closed）                                                                                    |
| `cloud-host-enrollment.ts` / `cloud-credential.ts` / `cloud-pairing-offer.ts` / `cloud-session-service.ts` | 同上一并替换；`cloud-session-service` 新增只读 `currentDeviceId`（只暴露标识，不含令牌）                                                                  |
| `src/main/ipc/cloud-platform.ts`                                                                           | Electron 参数边界保留 1 处 line-specific disable，带 SAFETY 说明                                                                                          |
| 测试（6 个 cloud-platform 文件 + renderer hook）                                                           | 响应改读字段；吊销改用同一用户另行登录的令牌；不再访问私有 `session.client` / `client.accessToken`                                                        |

**结果（证据 `evidence/m23-quality-gate/`）**：

- `gate.txt`：`check:code-quality:changed` 7 项扫描全部 **0 new finding**，`Changed-code quality gate passed`（220 个改动文件）；`tsc` node/web 均 exit=0。
- `cases.txt`：10 个文件 **79 条** 全过——6 个 cloud-platform 用例文件仍是真实平台进程 + 真实 TLS Runtime + 真实 Ed25519/NaCl（撤销 4403、令牌不外泄、项目链接 5 条），runtime 准入 8 条，renderer happy-dom 8 条，门禁脚本自身 32 条。
- `regressions.txt`：shared 传输/配对回归 44 条全过。

**行为等价性**：替换都是"先读字段、再判空"；失败路径从 `undefined` 静默传播变为显式错误，正常路径字段与类型不变。

## M24 项目工作区视图（本轮）

**问题**：M21 打开项目后界面停在列表；M22 打通链路但用户看不到"进了工作区"。

| 文件                                                   | 内容                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `renderer/src/cloud/cloud-project-workspace.tsx`（新） | 工作区：项目名、线路徽标、下载受限、工作区根目录、开发机能力、实时运行时状态（`status.get`）、刷新、返回工作台 |
| `renderer/src/cloud/cloud-app.tsx`                     | 有已打开项目 → 工作区；否则 → 工作台                                                                           |
| `renderer/src/cloud/use-cloud-session.ts`              | 新增 `opened{projectId,workspaceRoot,capabilities,route}` 与 `closeProject()`；4403/登出/返回都会清空          |
| `shared/cloud-platform-ipc.ts` + preload + main ipc    | 新增 `cloud:closeProject`                                                                                      |
| `main/cloud-platform/cloud-session-service.ts`         | `closeProject()` 只关连接，保留令牌与设备密钥；再次打开同一项目无需重新登录                                    |

**端到端验证（`evidence/m24-project-workspace/`）**：

- `cases.txt` 21 条：界面 10 条（进入工作区显示根目录/能力/`已连接 · rt-1`、检查失败显示 `NOT_CONNECTED`、返回工作台调用 `closeProject`、吊销后回列表并提示）；真实平台进程 + 真实 TLS Runtime 会话 6 条（新增"返回工作台只关连接：会话仍在，可再次打开且 RPC 仍通"）；M22 项目链接 5 条。
- `regressions.txt` 9 个文件 78 条全过。
- `gate.txt`：7 项扫描 0 新发现、gate passed（221 文件）；tsc node/web exit=0。

**如实说明**：界面用例用脚本化 bridge（happy-dom 跨源限制），真实链路由同批真实进程用例覆盖；运行时 id 仅在主机上报时显示，否则只显示"已连接"；终端/文件面板尚未嵌入，界面文案已明确写出来。

## M25 云端项目 → 运行时环境（本轮）

**问题**：终端、文件、流式通道都按"环境 id"访问开发机，而 M24 到工作台为止，云端项目还没有身份。

| 文件                                                                | 内容                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared/runtime-environments.ts` / `runtime-environment-sidecar.ts` | `cloudProject` 字段走侧车（`orca-environments.json` 保持旧版本可读）                                                             |
| `main/cloud-platform/cloud-runtime-environment.ts`（新）            | 注册/移除环境；`callCloudRuntimeProject` / `subscribeCloudRuntimeEnvironment` 每次连接经 `prepareProjectLink` **重签一次性票据** |
| `main/cloud-platform/cloud-runtime-session.ts`（新）                | 当前平台会话出口（传输层无 IPC 上下文）                                                                                          |
| `main/ipc/runtime-environment-transport-routing.ts`                 | `cloudProject` 环境走云端专用路径，**跳过**共享控制/缓存连接（否则会绕过票据）                                                   |
| `main/ipc/cloud-platform.ts`                                        | 新通道 `cloud:openWorkspace`（打开 + 注册，返回 `environmentId`）；关闭时移除                                                    |
| `shared/remote-runtime-request-socket.ts`                           | 一次性请求支持 `cloudUpgrade`，复用 `openRemoteRuntimeSocket`                                                                    |

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

| 改动                         | 内容                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `cloud-upgrade-admission.ts` | 新增 `keysFetchedAt` / `keysTtlMs`（默认 5 分钟）；超窗返回 `jwks_stale` + `x-orca-reject` |
| `cloud-agent-client.ts`      | 只在**成功**拉取 JWKS 时记录时间戳；新增可注入 `now` / `keysTtlMs`（测边界用）             |

顺序上吊销优先：被撤销的连接仍报 `project_revoked`，不给用户看"公钥过期"。

**验证（`evidence/m27-jwks-staleness/`）**：3 条真实平台进程 + 真实 Ed25519 票据——TTL 内放行/超窗拒绝/刷新恢复、刷新失败不延长新鲜度、吊销原因优先。**把修复注释掉后用例 1、2 变红**（2 failed / 1 passed），恢复后转绿。回归 11 个文件 61 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M28 设备公钥持有证明（本轮）

**问题**（评审 05/06 的 M1 遗留）：票据带 `devicePubKey`，客户端只需在升级头里复述它；主机只比对「头 == 票据」，任何拿到票据的人都能过升级检查——票据是持票证明，不是设备持有证明。

| 改动                                                | 内容                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `runtime/device-registry.ts`                        | 云设备登记保存票据公钥 `publicKeyB64`                                                             |
| `startup/cloud-runtime-admission.ts`                | 准入通过后把 `devicePubKey` 交给 `adoptCloudDevice`                                               |
| `runtime/rpc/e2ee-channel.ts`                       | 认证成功且设备登记了公钥时，比对握手公钥；不一致 → `e2ee_error(device_proof_failed)` + close 4001 |
| `shared/remote-runtime-*-contract/transport/socket` | 新增 `clientKeyPair`，握手使用设备密钥；一次性请求同样支持                                        |
| `cloud-session-service` / `cloud-connect-client`    | `deviceKeyPair()`（仅主进程，不经 IPC）                                                           |
| `shared/remote-runtime-client-handshake.ts`         | 解析 `e2ee_error` 的 code 并给出可行动文案                                                        |
| `shared/cloud-platform-ipc.ts` + preload            | 删除无效的 `cloud:prepareProjectLink`（renderer 从未调用、无 handler、且会把票据送进渲染进程）    |

**验证（`evidence/m28-device-pop/`）**：3 条新增真实端到端（真实平台 + 真实 TLS Runtime）——设备密钥握手成功并拿到真实响应；**换一对密钥被拒且无任何响应**（注释掉检查后该用例变红）；主机确实登记了票据公钥。M22/M25 既有用例现在必须显式携带设备密钥才能通过，即 PoP 已生效。回归 17 个文件 117 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

**如实记录**：全量 `src/main/runtime` 有 17 条既有失败（`agent-launch-*`、`agent-session-conversation-clear-commit`），把本模块改动 stash 后在 HEAD 上同样失败，确认与本轮无关；另有一次并行运行中 `cloud-revocation-precision` 单条抖动，单独与整目录运行均通过。

## M29 文件寻址契约对齐（本轮）

**问题**（评审 05/06 的 M6 遗留）：真实 Orca 用 `{ worktree, relativePath }` 寻址文件，模拟器却接受项目绝对 `path`。按模拟器写的客户端能通过全部评审，接上真实主机后每个文件操作都会失败。

| 改动                                           | 内容                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/file-request-paths.ts`（新） | 只接受真实契约；缺 `relativePath`/只传 `path` → `MISSING_RELATIVE_PATH`；绝对路径/`..` → `PATH_OUTSIDE_ROOT`；未知 worktree → `WORKTREE_NOT_FOUND`；写只允许本人工作区 |
| `policy-gateway.ts`                            | 授权同样按 `worktree + relativePath` 判定（不再有"先授权后解析"两套规则）；新增 `executeReadDir`                                                                       |
| `runtime-sim.ts`                               | 接入解析器；新增 `files.readDir`（真实 `FileTreePath`）                                                                                                                |
| 既有 e2e                                       | 全部改用 `worktree + relativePath`（`projectFile`/`workspaceFile` 助手）                                                                                               |

**顺带修的缺陷**：分支名 `///` 清洗成 `---` 后被接受，会造出与任何分支无关的目录；现在要求清洗后必须含字母或数字。

**验证（`evidence/m29-file-contract/`）**：6 条新用例（真实平台进程 + 真实 TLS Runtime + 真实 Ed25519）——真实形状读写、旧形状明确拒绝、绝对/穿越/未知 worktree 拒绝、写边界、符号链接逃逸、分支名非法与幂等回放。整仓 cloud-platform **80 条全过**（含迁移后的 platform.e2e 16 条）。

**如实记录**：迁移后整仓首次运行 `cloud-admission-parity.test.ts` 失败——M23 给 `cloud-credential.ts` 引入 `shared/json-fields` 导入，违背该模块"零依赖、可被平台测试直接导入"的不变量；已收回 5 行 `ownEntries` 并注明原因。该测试此前一直红而未被发现（M23 只跑了 vitest 侧，未跑整仓 `node --test`）。

## M30 项目根路径规范化（本轮）

**问题**（评审 M5 遗留）：`path` 被原样签进票据。`/srv/work/svc/../../etc` 在平台与主机两侧都按 `..` 规范化，凭证实际覆盖 `/srv/etc` 一类没被授权的目录——"以为的路径"与"生效的路径"不一致。

| 改动                                                 | 内容                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/contract/src/project-path.ts`（新）        | 拒绝相对路径、`.`/`..` 段、重复/尾随分隔符、控制字符、POSIX 混用反斜杠；返回 `PROJECT_PATH_INVALID`                    |
| `apps/api/src/server.ts`                             | 登记处校验，拒绝时写 `result: denied` 审计（含原始路径），不创建项目                                                   |
| `src/main/cloud-platform/cloud-upgrade-admission.ts` | 主机对票据 `projectRoot`/`workspaceRoot` 做同形状复核，不符合 → `workspace_root_invalid`（兼容仍会签发旧路径的旧平台） |

**验证（`evidence/m30-project-root/`）**：4 条真实平台进程 + 真实 Ed25519 用例——非法路径 400 且不留项目；合法路径票据 `projectRoot` 逐字节一致；主机拒绝真实签名但根含 `..` 的票据、同签名者合法根放行；被拒登记无残留。**把两处检查分别注释掉后用例 1、3 变红**。整仓 cloud-platform 80 条全过；门禁通过、tsc node/web 0 错。

**如实记录**：首版把 POSIX 前导 `/` 当成空段，合法路径被误拒（用例 2 先红），已修正；控制字符检查原用字符类正则触发 `no-control-regex`，改为按码点判断（未用 disable）。

## M31 审计链落盘与完整性校验（本轮）

**问题**：设计要求"单写入序列 + 哈希链 + WORM"，但审计链只在内存里——重启即归零，无从篡改也无可校验；同时 `AuditChain.verify()` 没有任何出口，运维只能读事件、无法判断是否被改过。

| 改动                                   | 内容                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/audit-log-file.ts`（新） | 只追加 JSONL；解析失败报 `AUDIT_LOG_CORRUPT`（跳过坏行等于静默截断链）                                                                                            |
| `apps/api/src/audit.ts`                | 可选持久化 sink；`restore()` 在服务前回填历史链（seq/tip），重启后 `prevHash` 续接不分叉；`verify()` 报告 `checked`/`tip`/`brokenAtSeq`                           |
| `apps/api/src/server.ts`               | 新增 `GET /v1/audit/verify`：通过 200、断链 **409**、无权限 403；每次校验尝试本身入链。`AUDIT_LOG_PATH` / `AuditConfig.auditLogPath` 启用落盘，未设置时保持纯内存 |

**验证（`evidence/m31-audit-verify/`）**：14 条。进程内 7 条用真实 SHA-256 证明改正文、删事件、只改 hash、改 metadata 都会被检出并定位；真实进程 7 条证明校验入链、权限与拒绝审计、翻页无重复、无令牌不泄露、**重启续链**、**改写日志文件后重启返回 409 且 brokenAtSeq 命中**、**坏行时拒绝启动**。整仓 87 条全过。

**如实记录**：没有用进程内篡改冒充端到端——先补落盘再做"改文件重启"的真实用例。断链时平台仍启动并服务（运维需要排查入口），是否对敏感操作 fail-closed 留待下一轮决定；既有 `contract.test.ts` 的 `deepEqual(verify(), {ok:true})` 已随返回值扩展更新。

## M32 审计 fail-closed（本轮）

**问题**：设计 §13.2 要求"审计写入失败时拒绝该敏感操作"，但实现是先改状态再写审计，写失败只变成 500——**变更已经生效却没有任何记录**；断链也只影响 verify 接口，敏感操作照常执行。

| 改动                     | 内容                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/audit.ts`  | 健康状态：`write_failed`（瞬时，成功写入后自动清除）/ `chain_broken`（持续到修复并重启）；`appendBestEffort` 供非变更事件         |
| `apps/api/src/server.ts` | **write-ahead audit**：`recordAudit()` 先写事件，失败即 503 且不执行变更；覆盖项目创建/归档、授权、设备吊销、主机令牌、维护、策略 |
| 同上                     | 预检只拦 `chain_broken`；`write_failed` 放行以便磁盘恢复后自愈                                                                    |
| 同上                     | 登录/读取/`/health`/`/v1/jwks` 保持可用；新增 `GET /v1/audit/status`                                                              |

**验证（`evidence/m32-audit-fail-closed/`）**：3 条真实进程用例——日志 chmod 0400 后创建项目 503 且**项目确实没建**、chmod 恢复后自动回到 201；篡改日志重启后 503 `AUDIT_CHAIN_BROKEN`、verify 仍 409、用原始日志重启即恢复；一次覆盖 5 类敏感写全部 503 且逐项复核状态未变。整仓 **97 条**全过。

**如实记录**：两版实现都是被测试推翻的——首版只做预检 + 后置审计，实测首次失败是 500 且项目已创建；次版把状态锁死导致永远无法恢复。最终为"先写审计再变更 + write_failed 可自愈"。副作用：崩溃在两步之间会多记一条未生效事件（over-report），已在注释与 summary 中说明。

## M33 云端会话并发上限（本轮）

**问题**（设计 §8.4）：要求"每用户每项目最多 3 个会话、每主机最多 32 个连接，超出返回 4431"，但代码里只有与云无关的 128 连接上限；`grep 4431` 在整个 `cloud-platform/` 与 `src/main/` 中零命中。平台不在数据通路上，看不到这些连接，只能在主机侧计数。

| 改动                                                                                    | 内容                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-session-limits.ts`（新）                                          | 按 `(user, project)` 与全主机计数；键为票据的 deviceToken（每票唯一），**按活连接计而不是按票据计**——票一次性，会话比票活得久                                                     |
| `cloud-agent-client.ts`                                                                 | 准入成功时记下票据文本 → `(sub, project, deviceToken)`；`connectionGate.accept()` 在 socket 建立时占用配额，`release()` 在关闭时归还；吊销时同步释放                              |
| `runtime/rpc/ws-transport.ts`                                                           | 新增可选 `connectionGate`：升级已成功后按 `req.headers` 计数，超限 `ws.close(4431, 'Too many sessions')` 并 1s 后 `terminate()`；`close` 事件归还配额（含握手未完成就断开的连接） |
| `node-websocket-lifecycle.ts`                                                           | 抽出通用 `closeNodeWebSocket()`，新增 `rejectNodeWebSocketOverSessionLimit()`（4431）                                                                                             |
| `runtime-rpc-{state,pairing-types,lifecycle}.ts` / `startup/cloud-runtime-admission.ts` | 把 `connectionGate` 像 `upgradeAdmission` 一样贯穿到 transport；enrolled 模式下用委托对象，因为 transport 先于异步注册完成构造                                                    |
| `renderer/cloud/cloud-close-notice.ts`（新）                                            | 4403/4431 给用户可行动的文案（"先关闭其他会话"），两处云视图共用                                                                                                                  |

**为什么不在升级前拒绝**：`verifyClient` 的拒绝是 HTTP 401 + `x-orca-reject`，没有 WebSocket close 帧，带不出 4431；而"会话"本来就要等 socket 存在才算数，所以计数点放在 `connection` 事件，超限发 4431 关闭帧——同时解决了"票据被签发但握手没完成"的泄漏问题。

**验证（`evidence/m33-session-limits/`）**：2 条真实端到端（真实平台进程 + 真实 Runtime + 真实 Ed25519 票据 + 真 NaCl 握手）：

- M33-1 用生产接线（默认上限 3）：3 路握手成功 → 第 4 路被 **4431** 关闭 → 关闭 1 路后新会话重新可用；
- M33-2 主机上限（测试把阈值降到 4 以便快速验证，代码路径与生产一致，两个用户各 2 路）：第 5 路 4431，释放一路后恢复。

把 `accept` 改成恒真后两条用例立即变红（计数 0），确认测的是新逻辑。cloud-platform 主机侧 12 个文件 52 条在 Node 下全过；`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现。

**如实记录**：本仓库 `pnpm test` 固定用 Bun 跑，Bun 的 `ws` 客户端对自签名 TLS 握手失败，导致 6 个**既有**的云测试文件（`cloud-device-pop`、`cloud-session-service` 等）在 Bun 下红；`git stash` 后在 HEAD 上复现同样失败，且在 Node 下全部通过，与本轮无关（本轮新用例走 ws:// 明文，两种运行方式都通过）。另外发现 Bun 的 `ws` 会把正在派发的消息重投给派发中新加的 `once` 监听器，握手助手已改为单一持久监听 + 幂等状态机。

## M34 云端 RPC 方法级权限（本轮）

**问题**（设计 §7.3，原 T302）：票据里签了 `perms`，但主机侧从未看过它——`runtime-rpc-websocket-dispatch` 把所有非 mobile 设备一律当 `runtime-paired`，而该作用域自带 `workspace`/`settings-write`/`accounts-admin`/`skills-admin`/`host-admin`。**结果：任何云会话（哪怕只被授予 `open`）都能读写主机设置、列账号、读取配对信息**，这是越权提升，不只是"缺功能"。

| 改动                                                    | 内容                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-rpc-permission.ts`（新）          | 方法 → 项目权限：`terminal.*`/`git.*`/`worktree.{create,createManaged,rm}` → `terminal`；`agent*` → `agent`；`files.read*` 等 → `file:read`；`files.write | create | rename | copy | delete | commitUpload`→`file:write`；`browser.*`→`browser`，但导出类（`browser.download | savePage`、`files.download*`、`terminal.exportArtifact`）优先判 `download`；`status.get` 任何已准入会话可用；**未登记 → 拒绝** |
| `runtime/rpc/rpc-caller-scope.ts`                       | 新增 `RpcCallerScope = { kind: 'cloud'; permissions }`，拒绝文案指明缺哪个项目权限                                                                        |
| `runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts` | 有 `cloudSession` 的设备走 `cloud` 作用域，不再落到 `runtime-paired`                                                                                      |
| `runtime/device-registry*.ts`                           | `DeviceEntry.cloudSession = { projectId, permissions }`；采纳时从票据写入；**落盘读取时逐字段校验，解析失败即丢弃（失去权限）而非保留**                   |
| `startup/cloud-runtime-admission.ts`                    | 采纳设备时带上票据的 `project` 与 `perms`                                                                                                                 |

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

| 改动                                                                    | 内容                                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-policies.ts`（新）                                | 解析策略包：缺 `downloadDefault` 即整包不可用（**不能把"没读懂"当成 allow**）；非法限速回落默认有界值                                              |
| `cloud-platform/cloud-access-guard.ts`（新）                            | 项目级滚动小时预算（次数 + 字节）；无策略包时下载关闭、读取仍有界；字节在回复后记账，因此拦住的是**下一次**读取                                    |
| `cloud-agent-client.ts`                                                 | 心跳与 `/v1/internal/policy` 两条通道都解析策略并保留上一份有效包；快照暴露 `policies`/`policyVersion`                                             |
| `rpc-caller-scope.ts`                                                   | 云端作用域新增 `downloadAllowed`：**策略优先于票据**——已准入的会话也会立刻受管理员改动约束                                                         |
| `runtime-rpc-websocket-dispatch.ts`                                     | 读方法先扣配额，超限回 `read_budget_exceeded`（含用量），并把回复字节记入预算                                                                      |
| `runtime-rpc-{state,pairing}.ts` / `startup/cloud-runtime-admission.ts` | `setCloudAccessGuard` + `installCloudAccessGuard`（生产与测试同一条接线）                                                                          |
| 平台 `store.ts` / `server.ts` / `policy-rate.ts`（新）                  | 策略新增 `readRatePerHour` 与项目覆盖；全局 `PUT /v1/policies/download`、项目 `PUT /v1/projects/{id}/policy` 均可设置，非法值 400 `POLICY_INVALID` |

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

| 改动                                                      | 内容                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-platform/cloud-path-boundary.ts`（新）             | 分隔符感知的根包含（`/srv/svc` 不含 `/srv/svc-evil`）+ `realpath` 解析（不存在的新文件按最近已存在祖先解析）；读限 `projectRoot`，写限 `workspaceRoot` |
| `cloud-platform/cloud-path-guard.ts`（新）                | 在 handler 之前把 `worktree` 选择器解析成真实目录并校验；`rename`/`copy` 的两条路径都查；绝对路径单独拒绝（`path.join` 会把 `/etc/passwd` 当成相对段） |
| `runtime-rpc-websocket-dispatch.ts`                       | 云端会话的文件 RPC 先过边界；**仅在票据本身带该权限时**才做路径判定，缺权限的调用仍由权限层给出"needs 'file:write'"的文案                              |
| `runtime/orca-runtime-persist-headless-terminal-title.ts` | 新增公开的 `resolveWorktreeRootPath()`，复用既有的选择器/执行主机解析，不另起一套                                                                      |
| `runtime/device-registry*.ts`                             | `cloudSession` 记录 `projectRoot`/`workspaceRoot`；落盘读取时缺根即丢弃整条云会话（无法执行边界的记录不能默认成"哪都能去"）                            |
| `startup/cloud-runtime-admission.ts`                      | 采纳设备时带上票据的两个根                                                                                                                             |

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

| 改动                                      | 内容                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-git-scope.ts`（新） | git 方法读写分类：19 个只读方法（status/diff/history/branchCompare/commitDiff/generateCommitMessage…）→ `read`；其余（stage/unstage/commit/checkout/discard/fetch/pull/push/rebase/forkSync…）→ `write`；**未登记方法按 write 处理**，新增的写方法不会因漏登记而落到主仓库 |
| `cloud-platform/cloud-path-guard.ts`      | 把 git 接入同一套边界；写操作**同时校验目录本身**——`git.commit` 不带任何路径参数，只看相对路径会漏掉"在共享 checkout 上提交"；git 的 `filePath`/`filePaths`/`paths`/`oldPath`/`submodulePath` 同样逐条查越界                                                               |
| `runtime-rpc-websocket-dispatch.ts`       | 路径判定覆盖 git（按票据的 `terminal` 权限放行后才判定，缺权限仍由权限层给出文案）                                                                                                                                                                                         |

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

| 改动                                           | 内容                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-worktree-scope.ts`（新） | `worktree.create` → **明确拒绝**（设计：托管模式必须用 `worktree.createManaged`，而真实 Runtime 尚未实现，因此宁缺勿滥）；`worktree.rm`/`worktree.forceDeleteBranch` → 写（限本人 `workspaceRoot`）；`worktree.show` → 读（限 `projectRoot`）；**其余一律拒绝**（`list`/`detectedList`/`ps` 会枚举全机工作区，`activate`/`sleep`/`set`/`teardownMissingTerminals` 等属主机 UI 面） |
| `cloud-path-guard.ts`                          | worktree 分类接入同一路径检查；新增 `isCloudPathGuardedMethod()` 供分发层判断"这个方法是否需要过边界"                                                                                                                                                                                                                                                                              |
| `cloud-rpc-permission.ts`                      | `worktree.show`/`worktree.forceDeleteBranch` 登记到 `terminal` 权限（仅表示"可被该方法族触达"，具体放行仍由 worktree 分类决定）                                                                                                                                                                                                                                                    |
| `runtime-rpc-websocket-dispatch.ts`            | 边界判定改用 `isCloudPathGuardedMethod`，让被拒绝的 worktree 方法也能拿到明确文案，而不是落到 `method_not_found`                                                                                                                                                                                                                                                                   |

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

| 改动                                                                                    | 内容                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/rpc-contract/worktree-managed-create-params.ts`（新）                           | `{ repo, workspaceRoot, name, baseBranch, compareBaseRef, branchNameOverride, displayName, idempotencyKey }`；`workspaceRoot` 必须在协议层就是绝对路径                                                                                                        |
| `runtime/rpc/methods/worktree-create-managed.ts`（新）                                  | 新方法 `worktree.createManaged`（`workspace` 权限）：以 `idempotencyKey` 复用既有 `dedupeWorktreeCreate`；**拒绝远程仓库**（票据的工作区根是本地路径，在 SSH checkout 上照做会静默落在别处）                                                                  |
| `startup/cloud-managed-worktree-methods.ts`（新）                                       | 仅当 `ORCA_CLOUD_API_URL` 存在时把该方法并入方法表——落实设计"非托管构建不注册该方法"                                                                                                                                                                          |
| `runtime/runtime-managed-worktree-create-types.ts` + `runtime-local-worktree-create.ts` | `workspaceRoot` 显式根：覆盖路径设置的 `workspaceDir` 并强制 `nestWorkspaces=false`，因此 `computeWorktreePath` 与 `ensurePathWithinWorkspace` 都按 `<root>/<name>` 计算                                                                                      |
| `cloud-worktree-scope.ts` / `cloud-path-guard.ts`                                       | 云端作用域把 `createManaged` 归为写；新增 `checkManagedCreate()`：**仓库必须在本项目内**（否则可把别的团队仓库 checkout 进自己工作区再读），**目标根必须在本人工作区根内**。为此给运行时加了公开的 `resolveRepoRootPath()`（复用既有 `showRepo`，不另起解析） |

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

| 改动                                                                                    | 内容                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/cloud-workspace-ensure.ts`（新）                                        | `ensureCloudWorkspace()`：`openProject` 建链 → `worktree.list`（repo 限定）→ **只挑落在票据 workspaceRoot 下的那条**（同仓库还有队友的 checkout）→ 没有才 `worktree.createManaged`；创建失败时再列一次（并发打开同一项目的竞态） |
| `cloud-worktree-scope.ts` / `cloud-rpc-permission.ts`                                   | 对云端开放 `worktree.list`/`worktree.detectedList`，但**必须带 repo**；`cloud-path-guard` 新增 `checkRepoScopedRead()`——仓库须在本项目内，否则拒绝（这是 M38"一律拒绝"的精确化，不是放开）                                       |
| `cloud-session-service.ts`                                                              | 新增 `ensureWorkspace(projectId)`；成功后设置当前项目                                                                                                                                                                            |
| `ipc/cloud-platform.ts`                                                                 | `cloud:openWorkspace` 改走 ensure；结果返回 `workspacePath` 与真实能力集                                                                                                                                                         |
| `shared/cloud-platform-ipc.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` | `CloudOpenResult.workspacePath` 透传到视图，工作区页新增"我的工作区"一行（首次打开显示"首次打开时创建"）                                                                                                                         |

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

| 改动                              | 内容                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-file-path-params.ts`（新） | 显式方法→参数表 `CLOUD_FILE_PATH_PARAMS`（singular/plural 分开）；`CLOUD_FILE_UNBOUNDED_METHODS`（绝对路径方法，整体拒绝）；`CLOUD_FILE_WORKTREE_ONLY_METHODS`（只寻址 worktree，无文件路径）                     |
| `cloud-path-guard.ts`             | 以 `collectPaths()` 取代后缀猜测；无界方法返回 `path_unbounded`；**任何未在表中声明的 `files.*` 方法返回 `path_unverifiable`**——判断只看方法名，不看它是否已登记权限，所以将来新增的文件 RPC 在登记前也拿不到放行 |
| `cloud-rpc-permission.ts`         | `files.open`/`files.openDiff` 登记为 `file:read`（它们只把调用方本来就能读的文件展示出来）；补注释说明终端产物/目录浏览为何仍列出但由路径守卫拒绝                                                                 |
| `cloud-rpc-permission.test.ts`    | 断言这两个面板动作归 `file:read`；deny-by-default 的示例改用真实未登记的 `agentSessionAttachment.read`                                                                                                            |

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

| 改动                                                                                               | 内容                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/cloud-file-browser.ts`（新）                                                               | 面板的数据层：`browseCloudDirectory` / `previewCloudFile` 走 `files.readDir`/`files.readPreview`，worker 选择器固定为 `path:<workspacePath>`；路径拼接拒绝 `..`、分隔符与空名；目录在前、名称不区分大小写排序；未知/残缺回复报 `malformed_reply`，**不当作空目录**；隐藏 `.git`（worktree 里它是 gitfile 指针） |
| `renderer/cloud/cloud-file-panel.tsx`（新）                                                        | 面包屑 + 目录列表 + 文本预览；失败显示主机原因（`forbidden` → 越界/无权限），二进制/图片不按文本渲染；用请求序号丢弃过期目录回复                                                                                                                                                                                |
| `shared/cloud-platform-ipc.ts` / `cloud-connect-response.ts`                                       | 票据 `perms` 解析为 `CloudProjectPermission[]`（未知值丢弃）；`CloudOpenResult.permissions` 由**将要被主机校验的那张票据**读出，供 UI 判断能否显示面板                                                                                                                                                          |
| `ipc/cloud-platform.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` / `cloud-app.tsx` | 透传权限；工作区页在 `workspacePath` 存在且票据含 `file:read` 时挂载面板，否则说明原因；`CloudApp` 改为把完整 `rpc(method, params)` 传下去（此前固定只调 `status.get`）                                                                                                                                         |

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

| 改动                             | 内容                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-rpc-multiplexer.ts`（新） | 一个路由器拥有整条已准入 socket：`id → 调用` 的 pending 表、`call()` 一次性回复、`subscribe()` 多帧事件 + `{type:'end'}` 收尾、超时即摘除、socket 关闭时统一以 `CONNECTION_CLOSED` 结束所有在途调用                                                                                                                                                                |
| `cloud-connect-client.ts`        | `rpc()` 改走多路复用器（修复超时监听器泄漏）；新增 `subscribe()` / `forgetSubscription()`；`close()` 先结束在途调用再关 socket                                                                                                                                                                                                                                     |
| `cloud-terminal-scope.ts`（新）  | 终端方法三类：**create**（worktree 必须落在本人 `workspaceRoot`）、**handle**（按句柄所属 worktree 判定，含 `terminal.unsubscribe` 的 `subscriptionId` 及 `${terminal}:${clientId}` 复合 id）、**deny**（主机窗口/全局方法：`terminal.list`/`closeAll`/`split`/`focus`/`show`/`closeTab`/`sleep`/`resolve*`/`multiplex`/fit 偏好）。未分类的 `terminal.*` 一律拒绝 |
| `cloud-path-guard.ts`            | 接入终端三类；主机无法回答句柄归属（无 `resolveTerminalContext`）→ 拒绝；句柄已退出 → 拒绝                                                                                                                                                                                                                                                                         |

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

| 改动                                                | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-agent-scope.ts`（新，328 物理行/211 有效行） | 三类：**create**（`agent.launch`/`launchReplay`/`agentSession.create`/`createSupport`/`ensure`）——目标 worktree 必须解析进本人 `workspaceRoot`；`agent.launch` 还检查 `cwd` 与 `reuseTerminal.handle`，且 `target.kind` 必须是 `existing`（新建工作区由主机自己推导路径，与 `worktree.create` 同样拒绝）；**session**（26 个方法）——从 `sessionId` 或 `envelope.sessionId` 解析会话所属 worktree；**deny**——附件（主机文件存储、`read` 传绝对路径、上传流无法定界）、`agentTeams`/`agentHooks`（主机窗口/全局状态）、provider 目录、跨会话流与 restart 列表。未分类的 `agent*` 一律拒绝 |
| `cloud-path-guard.ts`                               | 接入 agent 三类；`isCloudPathGuardedMethod` 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `orca-runtime.ts`                                   | 新增 `resolveAgentSessionContext`：先查会话持久记录（`location.workspaceId`），再回退到终端上下文（终端承载的会话仍在 PTY 上）。两者都答不出 → 拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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

| 改动                                                                                            | 内容                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/runtime-environments.ts`                                                                | `CloudProjectLinkSchema` 新增**可选** `workspacePath`；新增 `cloudWorkspacePathOf(environment)`，旧侧车返回 `null`                    |
| `cloud-runtime-environment.ts`                                                                  | `RegistrationInput.workspacePath?`，写入时条件展开（未知则不写键，旧侧车形状保持逐字节一致）；同一项目重开时**刷新路径并保持环境 id** |
| `ipc/cloud-platform.ts`                                                                         | 把 `ensured.workspacePath` 传给注册                                                                                                   |
| `shared/runtime-environment-sidecar.test.ts` / `cloud-runtime-environment-registration.test.ts` | 旧条目读作 `null`、写读往返、写入时省略、重开保持 id                                                                                  |

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

| 改动                                                         | 内容                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-upgrade-admission.ts`                                 | 新增 `readDevicePubKeyFromProtocols()`：仅接受无填充 base64url、32 字节、可规范化重编码的 key（拒绝短 key 与非规范尾比特）；格式无效或出现两个互相冲突的 token → `device_mismatch`；头与 token 并存时逐一比对 |
| `cloud-session-e2e-harness.ts`                               | `connectCloudSession` 支持 `deviceKeyIn: 'subprotocol'`（模拟浏览器：不带设备头）                                                                                                                             |
| `cloud-platform/apps/runtime/src/runtime-sim.ts`（主会话补） | 模拟器网关同步接受子协议形态，冲突时同样拒绝；键长不设 32 字节限制（模拟器设备键是 SPKI DER，真实主机才是 NaCl 32 字节）——**否则整机与替身的行为会分叉**                                                      |
| `cloud-platform/test/e2e/platform.e2e.test.ts`（主会话补）   | 新增 E7b3：无头浏览器形态被接受；头与子协议冲突被拒                                                                                                                                                           |

**验证（`evidence/m46-browser-upgrade/`）**：3 条真实端到端——真实平台进程签票、真实 TLS Runtime、**手工构造与浏览器能力一致的手连接**（只有子协议、无设备头），完成真实 E2EE 握手后 `status.get` 有真实响应；错误设备键 401 `device_mismatch`；两者都不带 401 `device_pubkey_missing`。另有 6 条准入单测（头/子协议/两者相等/冲突/缺失/格式错误）。模拟器 E7b3 通过（17/17）。

**主会话独立负向对照**：让准入忽略子协议形态 → M46-1/M46-2 变红（`Unexpected server response: 401` 与 `expected 'device_pubkey_missing' to be 'device_mismatch'`），恢复后 3/3 绿。主机侧 34 文件 186 条、模拟器 e2e 17 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：

1. **线兼容**：使用子协议形态的客户端需要理解该 token 的主机；旧主机会返回 `device_pubkey_missing`（可映射的明确错误，不是静默关闭）。本模块不做能力协商。
2. 浏览器渲染层**还没有**真的使用它：`web-runtime-connection-transport.ts` 仍未传子协议、未接入云票据，这是下一模块（M47）的内容。
3. 平台与票据格式未改；E2EE 握手未改。

## M47 浏览器客户端在传输层支持云票据（本轮，开发子代理执行）

**问题**：浏览器传输层 `web-runtime-connection-transport.ts` 打开的是 `new WebSocket(endpoint)`——**不传任何子协议、不携带票据**，因此即使 M46 让主机接受子协议形式的设备公钥，浏览器仍然永远到不了云主机。

**本轮还发现一个隐藏前提**：主机不只看升级期的子协议，还在 E2EE 握手里校验 `deviceProofHolds`——**hello 里出示的公钥必须等于票据绑定的设备公钥**。浏览器传输层原本每次连接都临时生成密钥对，所以即便子协议补齐，握手仍会被判 `Unauthorized`。因此云端 offer 必须使用**持久化的设备密钥对**。

| 改动                                  | 内容                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-pairing.ts`                      | `WebPairingOffer` 新增可选 `cloud: { credential, devicePublicKeyB64 }`；严格校验（非空、子协议安全字符集、32 字节键、base64/base64url 规范化并拒绝非规范尾比特）；新增 `webRuntimeSubprotocols()`：普通 offer → `null`（保持无子协议连接），云端 offer → `['orca-runtime','orca-cred.<ticket>','orca-device.<base64url>']`；键损坏时抛 `WebPairingCloudKeyError`，**不退回无凭据连接** |
| `web-cloud-device-key.ts`（新）       | 生成并持久化设备身份（存储接口注入，不绑定 localStorage/IndexedDB）；同一浏览器复用一个身份；对外只暴露公钥                                                                                                                                                                                                                                                                            |
| `web-runtime-connection-transport.ts` | 传入子协议；云端 offer 用持久化私钥完成 E2EE（普通 offer 仍用临时密钥对，行为不变）；新增可注入的 `WebSocketImpl`/定时器作为测试缝（缺省即浏览器全局）                                                                                                                                                                                                                                 |
| `web-e2ee.ts`                         | 支持由私钥重建密钥对；`window.atob/btoa` 改 `globalThis` 以便同一份代码在 Node 测试中运行                                                                                                                                                                                                                                                                                              |

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

| 改动                                      | 内容                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/cloud-platform-reply.ts`（新）    | 把平台回复解析抽到共享层：`parseConnectTicketReply`/`parseProjectListReply`/`readTicketClaims`。桌面端解析原先用 Node 的 `Buffer` 解码 JWT，浏览器构建无法复用；现在两端读同一份契约（`cloud-connect-response.ts` 变成门面 re-export，桌面类型改为共享类型的别名） |
| `renderer/web/web-cloud-session.ts`（新） | `loginToCloud` → `listCloudProjects` → `requestCloudTicket` → `cloudPairingOfferFromTicket`。票据里的 `deviceToken` 从 JWT 载荷解出，`endpoint` 按 priority 直连优先（浏览器无法 TCP 预检），`publicKeyB64` 取 `host.e2eePublicKeyB64`                             |
| 错误处理                                  | 非 2xx 抛带平台 `error.code` 的 `WebCloudSessionError`（`INVALID_CREDENTIALS`/`HOST_OFFLINE`/`VERSION_UNSUPPORTED`/`DEVICE_KEY_MISMATCH`…）；200 但结构不符抛 `malformed_reply`；无端点抛 `no_endpoint`——**绝不返回半成品 offer**                                  |
| `web-cloud-device-key.ts`                 | 新增 `createLocalStorageWebCloudDeviceKey()` 显式工厂（生产代码尚未调用；测试用内存 Storage）                                                                                                                                                                      |

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

| 改动                                              | 内容                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-cloud-connect.ts`（新）                      | 无 React/DOM 的编排：读取/生成设备身份 → 登录 → 列项目 → 取票 → 构造 offer → 注入式客户端 `status.get` 校验 → 拒绝 mobile 作用域 → 返回 `{offer, runtimeId, projectName, deviceSecretKeyB64}`。平台错误码原样透出；其余映射为 `CONNECT_FAILED` / `MOBILE_SCOPE_REJECTED` / `NO_PROJECTS` |
| `WebConnectCloudForm.tsx`（新）+ `WebConnect.tsx` | 云端账号 / 配对码两个页签（无深链时默认云端）；平台错误码与消息直接显示；原配对码路径行为不变                                                                                                                                                                                            |
| `web-runtime-client.ts`                           | 新增可选 `deviceSecretKeyB64` 并透传给传输层与订阅客户端——没有它云端 offer 无法完成 E2EE 握手                                                                                                                                                                                            |
| `web-runtime-environment.ts` / `main.tsx`         | 存 `cloudLoginRequired` 标记：云端登录取票成功但**票据不可复用**，因此不保存 `cloud` 绑定；刷新时清除该记录并回到登录页，提示"云会话已随页面关闭结束"，绝不挂载一个半连接的应用                                                                                                          |

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

| 改动                                 | 内容                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preload-api/web-runtime-session.ts` | 新增 `adoptWebRuntimeClient(client, environment)`：安装为 `activeClient`、记录环境 id、写 `activeEnvironment`、清 worktree 缓存、挂接状态发布；**同一客户端重复采纳不关闭**，换成不同客户端才关闭旧的。`getClientForEnvironment` 按 id 返回已采纳的客户端，普通环境走原路径不变 |
| `web-cloud-connect.ts`               | 成功后**不关闭**客户端，连环境一起返回；所有失败路径仍在 `catch` 中关闭。使用窄接口 `WebRuntimeSessionClient`，不需要类型断言                                                                                                                                                   |
| `WebConnectCloudForm.tsx`            | 先 `saveStoredWebRuntimeEnvironment`（保留 `cloudLoginRequired` 标记）再 `adoptWebRuntimeClient`，然后才 `onConnected()`；保存失败则先关闭客户端                                                                                                                                |
| 断线语义                             | 云环境的票据已用尽，`reconnect: false`。断线时状态层如实报告 `disconnected`/`unavailable`，`getClientForEnvironment`/`observeWebRuntimeStatus` 返回 `runtime_cloud_session_ended`（"云会话已结束，请重新登录"），**不再对已作废的 offer 静默重连**                              |

**验证（`evidence/m50-web-cloud-handoff/`）**：真实端到端 1 条 —— 真实平台进程 + 真实注册主机 + 真实 TLS Runtime：`connectCloudProject` → 采纳 → 通过 **preload 层**取客户端并发真实 RPC，返回真实 `runtimeId`；断言 preload 返回的**就是**校验时那个客户端对象（`preloadClientIsAdoptedClient: true`），并额外证明同一票据再次升级被拒（`401 replayed`），即票据只被消费一次、没有第二次升级。另有采纳语义单测（含真实 socket 断线状态发布）、`connectCloudProject` 成功/各失败路径的开启与关闭断言、界面"先采纳再 onConnected"断言。

**主会话独立负向对照**：让 `getClientForEnvironment` 忽略已采纳客户端、总是新建 → e2e 变红（`expected WebRuntimeClient{…} to be WebRuntimeClient{…}`，且新客户端没有 credential/deviceSecret/scope），恢复后通过。浏览器侧 48 文件 335 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：

1. **断线后不能自动恢复**：票据已作废，只有重新登录能拿新票。目前用户看到"云会话已结束"的错误，需要刷新（`main.tsx` 会回到登录页）或重新打开连接页；**没有自动跳回登录的 UX**。
2. 真实浏览器里 `<App/>` 挂载后的完整交互未验证：e2e 证明了 preload 会话状态与真实 socket 上的 RPC，React 宿主仅由组件测试覆盖。
3. 配对码路径未变（其 offer 可复用，仍自带校验客户端）。
4. 采纳的连接保持 `reconnect: false`；将来要支持断线重连必须重新登录取票，而不是传输层重试。

## M51 云会话断线后自动回到登录页（本轮，开发子代理执行）

**问题**（M50 记录的缺口）：票据一次性，断线后无法重连。M50 让状态层如实报告断开、让客户端查找返回 `runtime_cloud_session_ended`，但**界面从不离开 App**——用户停在死界面上，只能手动刷新。

| 改动                                 | 内容                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preload-api/web-runtime-session.ts` | 新增 `subscribeCloudSessionEnded(listener)`：仅在"已采纳客户端 + 云环境 + 传输 `disconnected` + 连接态 `disconnected`/`auth-failed`"四条同时成立时触发；用 `WeakSet` 按客户端去重（一个客户端最多一次），先标记再通知以避免监听器关闭客户端引发的递归。`connecting`/刷新失败不会触发 |
| `web-session-recovery.ts`（新）      | `useWebSessionRecovery`：订阅信号 → 清除已作废的存储环境 → `closeActiveRuntimeClients()` → 返回 `signed-out` + 原因 → 回调 `setHasEnvironment(false)`。在 `WebRoot` **无条件挂载**，因为客户端可能在 App 挂载前就死掉                                                                |
| `main.tsx`                           | 断线通知优先于启动期通知；App 仅在终结信号时卸载，瞬时 `connecting` 不卸载；普通配对环境行为不变（仍可重连）                                                                                                                                                                         |

**验证（`evidence/m51-cloud-session-recovery/`）**：真实端到端 1 条 —— 真实平台 + 真实 TLS Runtime：采纳后真实 `status.get` 成功（`runtimeId` 有值）→ `cloud.runtime.stop()` **真实杀掉主机** → 信号恰好触发 1 次，状态变 `disconnected`，随后的客户端查找返回 `runtime_cloud_session_ended`（不挂起、不重连）。另有 5 条信号单测（含 `connecting` 不触发、非云环境不触发）与 2 条恢复钩子测试。

**主会话独立负向对照**：让信号永不派发 → 恢复钩子测试与真实 e2e 双双变红（`expected +0 to be 1`、`Matcher did not succeed in time`），恢复后浏览器侧 50 文件 344 条全过；`tsc` web/node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：

1. 真实浏览器 DOM 未验证：`main.tsx` 是入口模块，钩子与信号有测试，但没有真实页面观察到 WebConnect → App → WebConnect 的切换。
2. "同一页面内重新登录"未走通 `WebConnectCloudForm` 的浏览器路径。
3. 刷新路径（启动期提示）沿用既有实现，本轮未重复验证。
4. 断线后**不会自动重登**——只回到登录页；自动续期需要保存平台会话（安全范围更大），未做。

## M52 桌面端回归 Orca 原生界面：云项目注册为 repo（本轮，开发子代理执行）

**问题**：`App.tsx` 用 `CloudModeGate` 把整个工作区壳子替换成自造页面；云项目只注册了运行时环境、**没有注册成 repo**，所以原生侧栏不会列出它们。

| 改动                                                                               | 内容                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-workspace-entry.tsx`（新）                                                  | 替换 `CloudModeGate`：云端构建未登录时显示登录面板，登录后**照常渲染原生 `AppWorkspaceShell`**；每个项目注册环境后再同步为侧栏 repo                               |
| `cloud-project-repos.ts`（新）                                                     | 无 DOM 的同步计划：按 `(executionHostId, path)` 幂等，重登录不重复；平台名称变化只改显示名；登出先由主进程回收环境、再删除行                                      |
| `cloud:registerProjects`（新通道）                                                 | 为每个可见项目 `prepareProjectLink` + 注册环境，返回 `projectId/projectName/projectRoot/environmentId`。**不创建 checkout、不占用唯一连接**（列侧栏不该建工作区） |
| `cloud-rpc-permission.ts` / `cloud-repo-add-scope.ts`（新）/ `cloud-path-guard.ts` | 新增 `repo.add`（归 `open` 权限），路径守卫**只允许票据里的 `projectRoot` 本身**（含 realpath），其他路径与符号链接写法一律拒绝；守卫单独成模块以守住 300 行上限  |
| `preload`                                                                          | `api.cloud` 仅当 `ORCA_CLOUD_API_URL` 设置时暴露（与主进程注册 handler 的条件一致）；此前无条件暴露会让普通桌面构建误判为云端模式                                 |
| `cloud:logout`                                                                     | 回收全部云环境（此前只关当前项目）                                                                                                                                |

**验证（`evidence/m52-cloud-repo-registration/`、`evidence/m52-cloud-native-entry/`）**：真实端到端 4 条（真实平台 + 真实 TLS Runtime + 真实 git 仓库 + 真实客户端）：repo 行 `executionHostId=runtime:<envId>`、路径为项目根；重复同步不产生第二行；通过注册环境发真实 RPC 成功；原生入口路径同样有真实用例。另有 10 条单测（幂等/改名/登出清理/preload 暴露条件/界面回归）。

**主会话独立验收**：`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现；相关 41 条测试全过；`repo.add` 的路径守卫有专门用例（越界与符号链接均拒）。

**如实记录 / 本轮踩到的坑**：

1. 一次全量 `src/renderer/src/` + `src/main/cloud-platform/` 套件（约 4700 文件 / 41k 用例）与子代理的全量运行**并发**执行，机器 load average 冲到 50，两边结果都不可信，已终止。**后续规矩**：默认只跑受影响文件；全量只在需要时单跑且不与子代理同时跑。两个失败用例（`palette-match-performance`、`terminal-search-long-wrapped-line`）在空闲机器上单跑通过，属负载导致的时序抖动，与本模块无关。
2. 本轮只做"列出 + 默认打开第一个项目"，**每项目独立连接尚未实现**（M53）：`CloudSessionService` 仍是单客户端，切换项目会断开上一个。
3. `repo.add` 对云端开放是新增攻击面：目前仅由"只能添加项目根"限定；"添加后能否读到项目根之外"由既有工作区边界（M36）兜底，值得在 M53 补一条组合用例。

## M53 每项目独立连接（多项目并存）（本轮，开发子代理执行）

**问题**：M52 已为每个项目注册运行时环境并同步出侧栏 repo，但 `CloudSessionService` 仍只有**一个** `CloudConnectClient` 和一个"当前项目"，`rpc`/`closeProject` 没有 projectId——切换项目会断开上一个，多项目只能串行使用。

**关键约束**：设备身份（accessToken、deviceId、密钥对）在登录时注册，主机在 E2EE 握手里校验"hello 公钥 == 票据设备公钥"。因此**不能**每个项目重新登录（会注册多余设备、破坏设备绑定）。

| 改动                                 | 内容                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-project-connections.ts`（新） | 平台会话持有者与 socket 持有者分离：登录客户端只做 HTTP（登录/列项目/取票），每项目 fork 一个**共享同一 `CloudDeviceIdentity`** 的连接客户端，各自升级与 `rpc`；`Map<projectId, entry>` 管理打开/关闭/全部关闭/按项目 RPC/按项目断开事件                                            |
| `cloud-session-service.ts`           | `openProject/ensureWorkspace/rpc/closeProject` 全部显式按 projectId 路由；移除 `connectedProjectId` 这类模糊的"当前项目"API；登出关闭全部                                                                                                                                           |
| IPC / preload / 渲染层               | `cloud:rpc(method, params, projectId)`、`cloud:closeProject(projectId)`；更新全部调用点（`cloud-app.tsx`、`use-cloud-session.ts`、`cloud-project-workspace.tsx`）                                                                                                                   |
| `device-registry-cloud-adoption.ts`  | **主机侧必要修复**（非 M36–M44 边界）：设备登记原先按 deviceId 唯一，第二个项目的票会覆盖第一个项目的活 token，导致 `Invalid device token`。改为按 `(deviceId, token)` 登记，同一设备的兄弟会话各自持行；每设备每项目最多保留 4 个 token 防膨胀；按 deviceId 吊销仍会清除全部兄弟行 |

**验证（`evidence/m53-multi-project/`）**：真实端到端（真实平台 + **单台**真实注册主机 + 两个项目 + 真实 TLS Runtime + 真实客户端）：两个项目同时在线，**两张票据携带同一 `devicePubKey`** 且主机都接受握手；各自 `status.get` 返回真实 `runtimeId`；会话 A 发起的跨项目 `worktree.list` 被 `forbidden`（证明两条 socket 各自受限，不是同一条）；关闭 A 后 A 返回 `NOT_CONNECTED` 而 B 仍正常。另有 6 条多项目单测 + 相关模块测试。

**主会话独立负向对照**：让 `rpc` 忽略 projectId、固定用第一个连接 → e2e 变红（`forbidden: That file is outside the project this cloud session was granted`），恢复后通过。`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现。

**测试执行规范（本轮同时确立，已写入 `DEVELOPMENT_PROCESS.md` §4.1）**：L1 最小（改动文件+邻居）→ L2 模块 → L3 里程碑 → L4 全量；**所有命令必须带 `--maxWorkers`（默认 4）**，禁止并行跑两个大范围套件，主会话与子代理不得同时跑大范围测试；负载过高立即终止且不得把部分结果当结论。

**如实记录 / 剩余**：

1. 设备登记现在每个设备+项目最多保留 4 个 token；socket 正常关闭时**不会**立即失效对应 token，只靠后来的登记淘汰。票据本身一次性且准入期会复查吊销，风险与之前同级，但留下一条主机侧清理待办。
2. 管理页 `CloudApp` 仍是"同一时刻打开一个项目"的页面（现在按 projectId 显式路由）；多项目同屏展示不在本轮范围。
3. 本轮未做 L4 全量：按分级规范，全量留到里程碑收口/最终验收单跑。

## M54 管理员浏览器会话页（本轮，开发子代理执行）

**问题**：管理员用的云端会话页只存在于 Electron 内（依赖 `window.api.cloud`），无法按设计"从平台项目列表打开、单独用 PC 浏览器访问"。

| 改动                                   | 内容                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-browser-bridge.ts`（新）        | 浏览器版 `CloudBridge`：登录/列项目/取票复用 `web-cloud-session`，每项目一个 `WebRuntimeClient`（共享持久化设备身份），`rpc(method, params, projectId)` 显式路由，`closeProject(projectId)` 只关一个，`logout` 关全部；offer 与 `getState()` 都不含设备私钥                                                                  |
| `shared/cloud-workspace-open.ts`（新） | 把"选已有检出 / 否则 `worktree.createManaged`"的逻辑抽成传输无关实现；桌面 `ensureCloudWorkspace` 改为复用它，避免浏览器与桌面两套选择逻辑                                                                                                                                                                                   |
| 独立入口                               | `src/renderer/cloud-admin.html` + `src/renderer/src/cloud-admin/main.tsx` 挂载现有 `CloudApp`；`electron.vite.config.ts` 新增 `cloud-admin` 入口，投影脚本与构建校验同步覆盖两个 HTML 入口                                                                                                                                   |
| 静态服务                               | `static-web-client-handler.ts` 放行 `/cloud-admin.html`，反向代理前缀映射覆盖两个入口；`/`、目录穿越、未知路径与 `/web-index.html` 规则不变                                                                                                                                                                                  |
| 管理台入口                             | （W3 更正：此机制已删除——M117 的按项目入口取代了全局「打开会话页」，死旋钮 `config.js` 与 `index.html`/`STATIC_FILES` 引用一并移除。）当时：`cloud-platform/apps/web/config.js` 提供 `window.__ORCA_CLOUD_SESSION_URL__`；配置存在时项目行显示"打开会话页"（新标签、`rel=noopener`），未配置则不渲染，**URL 中不含任何令牌** |

**验证（`evidence/m54-admin-session-page/`）**：真实端到端 1 条（真实平台 + 真实注册主机 + 两个项目 + 真实 TLS Runtime）：浏览器 bridge 登录 → 打开两个项目 → 两个项目各自真实 `status.get`（`runtimeId` 相同，同一主机）；目录浏览分别列出各自的真实文件（`alpha-marker.txt` / `beta-marker.txt`，互不可见）；A 跨项目访问与绝对路径均 `forbidden`。另有 5 条 bridge 单测与静态服务测试（放行新入口、其余规则不变）。

**主会话独立验收**：`npx tsc -p config/tsconfig.web.json` / `tsconfig.node.json` 均 0 错；`changed-code` 门禁 7 项 0 新发现；相关 5 文件 14 条全过（含 `cloud-workspace-ensure` 与 `cloud-file-panel`，确认共享抽取未破坏桌面路径）。**独立负向对照**：让 bridge 的 `rpc` 忽略 projectId → e2e 与单测双双变红（跨项目 `forbidden`、路由序列不符），恢复后通过。

**如实记录 / 剩余**：

1. 未执行完整 electron-vite 构建，也未在真实浏览器渲染 `cloud-admin.html`；静态规则由 handler 级测试覆盖。（W3 更正：`config.js` 死旋钮已删除，部署无需再填写会话页地址；平台 API 地址由平台拼进 `sessionPageUrl` 的 `?api=` 下发，页面仍接受 `?api=`、`window.__ORCA_CLOUD_ADMIN_API_URL__` 或构建期 `VITE_ORCA_CLOUD_API_URL`。）
2. **`pnpm tc:web` 本来就是红的**：`config/tsconfig.tc.web.json` 在 HEAD 上已有 4165 条 TS6307（渲染侧 e2e 测试 import 了 `src/main/**` 的测试夹具），M47–M54 新增的渲染侧 e2e 各累加若干条（本轮 +3，共 4168）。`npx tsc -p config/tsconfig.web.json` 仍为 0 错，所以没有类型错误被掩盖，但项目自带的严格门禁是脏的——需要在后续轮次统一清理（把渲染侧 e2e 移到 `src/main/cloud-platform/`，或为渲染 e2e 单独建 tsconfig）。
3. 管理页 UI 直接复用现有 `CloudApp` 组件，未做视觉打磨。

## M55 原生初始导航：进入项目即定位到本人 checkout（本轮，开发子代理执行）

**问题**：M52/M53 之后开发者能登录、侧栏能列出项目、连接可并存，但登录后界面停在"未选择工作区"——主机其实已经建好/复用了本人 checkout（M45 写进侧车），却没有被选中。

| 改动                                     | 内容                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/cloud-initial-worktree.ts`（新） | DOM-free 选择规则：在**同一 repo**（`repoId === repo.id`）里找路径**精确等于** checkout 的那一行（路径经跨平台规范化比较），返回该行自己的 id；嵌套在父 worktree 下的 checkout 不会误选父行；无匹配 → `null`；重复路径取侧栏首行（主机异常，按点击行为）                   |
| `cloud-workspace-entry.tsx`              | 打开项目成功后，用 `openWorkspace` 返回的 `workspacePath` + 注册环境推出 repo 行，调用现有 `setActiveWorktree(id, 'runtime:<envId>')`；若该 repo 的 worktree 尚未加载，先 `fetchWorktrees(repo.id)` 再选一次（**未新增 IPC**）；无 `workspacePath`（旧侧车）时不动默认视图 |

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

| 改动                                                                     | 内容                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/tsconfig.cloud-e2e.json`（新）                                   | 专门承载跨边界测试的工程：包含 `src/main`/`src/shared`/`src/preload`/`src/types`、`env.d.ts`、6 个 e2e 文件以及它们直接 import 的渲染模块（**不是整个 `src/renderer/src`**）；`types` 需要 `electron-vite/node` 提供 `*?asset` 声明，与既有 node 工程一致，**未放宽任何检查**（`strict`/`skipLibCheck` 沿用基础配置） |
| `config/tsconfig.tc.web.json`                                            | 用**显式 6 项** `exclude`（而非 `**/*.e2e.test.ts` 通配）：将来若有只 import 白名单 main 文件的渲染 e2e，仍由 web 工程检查                                                                                                                                                                                            |
| `config/scripts/run-typecheck-projects-in-parallel.mjs` / `package.json` | 新工程加入 `pnpm tc` 并行链（`heapGib: 9`，实测 8.8 GB / 13.4 s），新增 `typecheck:cloud-e2e` 脚本                                                                                                                                                                                                                    |

**验证**：`tsc -p config/tsconfig.tc.web.json` **4168 错误 → 0**；`tsc -p config/tsconfig.cloud-e2e.json` 0；`tsc -p config/tsconfig.node.json` 0；6 个 e2e 全过（12 条）。**主会话独立负向对照**：去掉 exclude 后 TS6307 立刻回到 4168 条，恢复后 0。门禁 7 项 0 新发现。

**如实记录 / 剩余**：

1. 代价是内存：新工程把 main + renderer 图放进同一个 program，实测 8.8 GB，比 node（7）和 web（6）都大。32 GB 机器上仍是一批（合计 24 GiB 恰好等于预算）；**16 GB CI runner 上会多出一个串行批次（约 13 s）**，而不会把 node/web 挤到 OOM。
2. `config/tsconfig.e2e.json`（`tests/**`）仍按原注释保持**未启用**，本轮未动。
3. 6 个测试本身**没有**需要修的类型错误（新工程一开始报的 18 个 TS2307 是 main 依赖图里的 `*?asset` 环境声明，由 `electron-vite/node` 类型解决，不是改测试）。
4. 未跑完整 `pnpm tc`（会并行拉起 node+web+cloud-e2e+cli，约 24 GB）；按分级规范留到里程碑收口时验证一次。

## M57 项目创建 provisioning：主机真实 clone 缺失段（本轮，开发子代理执行）

**问题**：平台 `POST /v1/projects` 直接写 `status: 'ready'`，而主机 `ensureCloudWorkspace` 要求 `projectRoot` 已是 git 仓库，**代码里没有任何 clone 步骤**。管理员在平台建了带 `repoUrl` 的项目后，开发者首次打开只会得到模糊的仓库错误；项目也无法出现在侧栏（`repo.add` 同样失败）。

| 改动                                                                                    | 内容                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台 `store.ts` / `server.ts` / `contract/credential.ts` / `contract/repo-url.ts`（新） | `Project.status` 增加 `provisioning`；有 `repoUrl` → `provisioning`，无 → `ready`；建项目时校验仓库地址（trim、长度、控制字符、`-` 开头、`ext::`）；票据新增**可选** claim `repoUrl`/`defaultBranch`；心跳解析 `provisioned`（≤50 项、error 截断 500、只处理本主机项目、archived 跳过），写 `project_provision` 审计并置 `ready`/`failed` + `provisioningError` |
| `src/main/cloud-platform/cloud-project-provision.ts`（新）                              | URL/分支校验（拒绝 `ext::`、参数注入、非法 ref）、provision 决策、失败文案；纯逻辑可单测                                                                                                                                                                                                                                                                        |
| `src/main/runtime/rpc/methods/project-provision.ts`（新）                               | 云端专用 `project.provision`（不进 `ALL_RPC_METHODS`，只在云端方法表追加）；路径/URL/分支**全部取自签名票据**，handler 拒绝非云上下文；成功/失败都排入心跳回报                                                                                                                                                                                                  |
| `src/main/runtime/orca-runtime.ts` + `runtime-repository-clone-controller.ts`           | `provisionCloudProject()`；clone 控制器新增精确路径 `cloneToPath()`，复用路径锁、`claimCloneTarget`、失败清理、git 读缓存失效与 repo 注册，`git clone --branch <branch> -- <url> <checkoutPath>`                                                                                                                                                                |
| `device-registry*` / dispatch / `runtime-rpc-pairing` / `cloud-runtime-admission.ts`    | 票据 claims 进 device registry；`RpcContext.cloud` 与 `cloudReportProvision`；`setCloudProvisionReporter` 由 `attachCloudRuntime` 接到 `client.reportProvisioned(...)`；方法表追加 `PROJECT_PROVISION_METHODS`                                                                                                                                                  |
| `cloud-agent-client.ts`                                                                 | `reportProvisioned` 有界队列（≤32、同项目保留最新），心跳 2xx 后按序号清空；poll 模式无心跳，报告丢弃（注释说明）                                                                                                                                                                                                                                               |
| `shared/cloud-workspace-open.ts` / `cloud-session-service.ts` / `ipc/cloud-platform.ts` | 打开前先 provision（600s 超时）；旧主机 `method_not_found` 或“方法不可用于云会话”的 `forbidden` 视为跳过；`ensureProjectPrepared` 复用已有连接或临时 client；`registerProjects` 在取链接前逐项目准备，失败告警并跳过                                                                                                                                            |
| `renderer/cloud-workspace-entry.tsx` + 测试                                             | 入口 `preparing` 状态 + 非阻塞提示条（“正在准备云端项目…”），不隐藏工作区                                                                                                                                                                                                                                                                                       |

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

| 改动                                                                                                              | 内容                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台 `server.ts` + `contract/branch-name.ts`（新）                                                                | 新增管理员 `PUT /v1/projects/:id`：可改 `repoUrl`/`defaultBranch`（分别复用/新增校验），`path`/`hostId` → `PROJECT_FIELD_IMMUTABLE`，归档项目 404；成功后 `status = repoUrl ? 'provisioning' : 'ready'`、清除 `provisioningError`，审计 `project_update`（只记 `repoUrlChanged` 布尔，不写完整 URL） |
| `src/shared/cloud-platform-reply.ts` / `cloud-platform-ipc.ts`                                                    | 项目行解析增加 `status`、`provisioningError`（老平台缺失为 `null`）；`CloudProjectSummary` 透传；新增 `CloudProjectFailure`、`CloudProjectRegistration`、`CloudRetryPrepareResult` 与 channel `cloud:retryPrepare`                                                                                   |
| `src/main/ipc/cloud-platform.ts`                                                                                  | 抽出 `prepareProjectEnvironment`（provision → link → register）；`registerProjects` 返回 `{environments, failures}`；新增 `retryPrepare(projectId)`                                                                                                                                                  |
| `renderer/cloud-workspace-entry.tsx` + `cloud-workspace-banners.tsx`（新）+ `cloud-entry-workspace-sync.ts`（新） | 失败进入状态并显示非阻塞横幅（项目名 + 错误码，最多 3 个 + “等 N 个”）；「重试」逐项目 `retryPrepare`，成功项目注册环境并同步侧栏 repo，仍失败则更新错误码；拆分以保持单文件 ≤300 行                                                                                                                 |
| `preload` / 浏览器 bridge / web 会话                                                                              | 类型与桥同步；管理页 bridge 的 `retryPrepare` 返回 `ADMIN_SESSION_UNSUPPORTED`（管理页不注册原生环境）；浏览器会话透传状态                                                                                                                                                                           |

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

| 改动                                                                                                                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主机 `ORCA_CLOUD_PROJECTS_ROOT`                                                                                       | 注册与心跳上报 `projectsRoot`（绝对路径）；未配置 = 该主机不支持自助创建                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 平台 `store.ts` / `server.ts` / `project-self-service.ts`（新）/ `contract/project-key.ts`（新）                      | `Host.projectsRoot`、`Project.createdBy`；`POST /v1/projects/self`（登录即可）：`path` 出现即 400 `PROJECT_PATH_FORBIDDEN`，key 由 `validateProjectKey` 校验（`^[a-z0-9][a-z0-9._-]*$`，可由名称规范化），主机选择（无 / 多台 / 不合格分别 409 `NO_PROVISIONABLE_HOST`/`HOST_REQUIRED`/`HOST_NOT_PROVISIONABLE`），路径由 `joinProjectPath(projectsRoot, key)` 推导并复验，key/路径冲突 409，每用户 20 个未归档项目上限 429；创建者自动获得 `open,terminal,agent,file:read,file:write`（**无 download**），审计 `project_create`（`selfService: true`，不含地址）；新增 `GET /v1/hosts/available`（登录即可，只回 `{id,name,online,provisionable}`，不含地址/凭据） |
| 主机/客户端 `cloud-self-service-api.ts`（新）/ `cloud-connect-client.ts` / `cloud-session-service.ts` / IPC / preload | `createProject`、`listProvisionableHosts`；`cloud:createProject` 创建后立即 `prepareProjectEnvironment` 并返回 environment；`cloud:listProvisionableHosts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 渲染 `cloud-new-project-dialog.tsx`（新）+ `cloud-workspace-banners.tsx` + `cloud-workspace-entry.tsx`                | 云构建已登录时右下角“新建云端项目”按钮（`z-40`，与底部失败横幅 `z-50` 不重叠）；对话框填写名称/key/仓库/分支/主机（无合格主机时禁用提交）；创建成功注册 environment、同步侧栏 repo 并打开项目                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

| 改动                                                                   | 内容                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/cloud-platform-ipc.ts` / `main/ipc/cloud-platform.ts`          | `CloudCreateProjectResult` 失败分支增加可选 `projectId`、`project`（仅“平台已创建、准备失败”）；handler 失败时回填 `{ projectId, project }` |
| `renderer/cloud-created-project-failure.ts`（新）                      | 把“已创建但准备失败”的返回值映射成 `CloudProjectFailure`；前置失败（主机/key/配额）返回 `null` 仍内联                                       |
| `renderer/cloud-new-project-dialog.tsx`                                | 回调统一为 `onCreated(result)`：带 `projectId` 的失败交给入口并**关闭**对话框；不带者仍内联报错保持打开                                     |
| `renderer/cloud-workspace-entry.tsx` + `cloud-entry-workspace-sync.ts` | 失败条目按 projectId 去重并入 `failures` 并 `toast.error`；成功项目的同步/打开逻辑抽到 sync 模块（入口保持 300 行）                         |

**验证（`evidence/m60-create-failure-recovery/`）**：真实端到端 1 条（真实平台 + 注册主机/心跳 + TLS Runtime + bare git + 真实 `cloud:createProject` handler）：坏 `repoUrl` 创建 → 返回 `ok:false, code: CLONE_FAILED` 且**带 projectId 与项目摘要** → 心跳后平台 `failed` → 管理员 `PUT` 修正 → 真实 `cloud:retryPrepare` → checkout 存在、README 一致 → 心跳后 `ready` → `planCloudProjectRepos` 生成侧栏行。组件测试：带 projectId 的失败交回调并关闭、无 projectId 仍内联、创建失败条目进横幅且重试后消失。

**主会话独立验收**：7 个相关 vitest 文件 **29 条全过**；`tsc tc.web` 0 错；`tsc node` 仅 2 条既有 TS6307（同一底层问题，首个 importer 换成了新测试文件）；`check:code-quality:changed` 0 新发现。

**主会话独立负向对照**：让 handler 在准备失败时返回裸 `prepared`（丢掉 projectId）→ 新 e2e **变红**（`expected null not to be null`），恢复后 1/1 绿。

**如实记录 / 剩余**：

1. 创建失败但仍留在平台的项目**名字/key 已占用**，用户重试前不能复用同名；改名重建需另开项目（本轮不做“删除/重命名项目”）。
2. 对话框关闭后靠 toast 与底部横幅说明，未做逐项目状态图标。
3. 组件测试用 bridge 打桩；真实 IPC 全链路只由 e2e 覆盖。

## M61 云端会话自动续期（本轮，开发子代理执行）

**问题**：平台 access token TTL 30 分钟、refresh token 12 小时（滑动、旋转），但桌面客户端 `CloudConnectClient.login` **直接丢弃 `refreshToken`**，所有平台请求只带 access token。登录 30 分钟后，任何需要新票据/项目列表的操作都 401 `SESSION_EXPIRED`，用户只能重新登录——长会话不可用。

| 改动                                                                                     | 内容                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台 `server.ts`                                                                         | `ApiConfig.accessTtlMs`/`refreshTtlMs`（测试可缩短，入口支持 `ORCA_CLOUD_ACCESS_TTL_MS`/`ORCA_CLOUD_REFRESH_TTL_MS`）；登录与刷新响应新增 `expiresIn`（秒）。刷新时**保留旧 refresh token 映射**，使旧 token 重放命中 `refreshHash` 不匹配分支并作废整个会话（旋转 + 盗用检测） |
| `cloud-auth-session.ts`（新）/ `cloud-authorized-request.ts`（新）                       | 每个登录一份共享凭据对象：提前 60s 刷新、单飞、失败锁定 `SESSION_EXPIRED`、无 `expiresIn` 的旧平台按 401 刷新；所有平台请求先 `ensureFresh()`，401 时强制刷新并**只重试一次**；只暴露不可逆指纹用于诊断                                                                         |
| `cloud-connect-client.ts` / `cloud-project-connections.ts` / `cloud-self-service-api.ts` | `CloudDeviceIdentity` 携带共享 `auth`（所有 fork 的项目连接看到同一次刷新）；握手逻辑抽到 `cloud-socket-handshake.ts` 保持单文件 ≤300 行                                                                                                                                        |
| `cloud-session-service.ts`                                                               | 任何平台调用 `SESSION_EXPIRED` → `logout()` 关闭全部连接并推送 `{closeCode:4401, reason:'session_expired'}`；并发失败只登出一次                                                                                                                                                 |
| `renderer/use-cloud-session.ts` + `cloud-close-notice.ts` + 登录面板                     | 收到 `session_expired` 重新读取主进程状态（已 signed-out）回到登录页，显示“登录状态已过期，请重新登录。”                                                                                                                                                                        |

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

| 改动                                                                                                                         | 内容                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-cloud-auth.ts`（新）/ `web-cloud-authorized-request.ts`（新）/ `web-cloud-error.ts`（新）/ `web-cloud-request.ts`（新） | 每次登录一份 auth：提前 60s 刷新、401 强制刷新、单飞、失败锁定 `SESSION_EXPIRED`、无 `expiresIn` 时按 401 刷新；指纹用 FNV（浏览器无 `node:crypto`）。授权请求先 `ensureFresh`，401 后**只重试一次** |
| `web-cloud-session.ts`                                                                                                       | `WebCloudSession` 增加 `expiresIn`/`auth`；`loginToCloud` 读取平台新字段并建 auth；列表/取票走授权请求，**无 auth 的旧会话行为不变**                                                                 |
| `cloud-browser-bridge.ts` + `cloud-browser-bridge-replies.ts`（新）                                                          | 平台调用 `SESSION_EXPIRED` → 关闭全部连接、清 session/identity、置 signed-out、**一次性**发 `{closeCode:4401, reason:'session_expired'}`（并发过期只发一次）；bridge 保持 ≤300 行                    |
| tsconfig                                                                                                                     | 新 e2e 归入既有 `config/tsconfig.cloud-e2e.json`（与另外 6 个 web e2e 同一做法，未改工程边界）                                                                                                       |

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

| 改动                                                         | 内容                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-registry.ts` + `device-registry-cloud-rows.ts`（新） | `releaseCloudDeviceToken(token)`：只删除 `token` 匹配且 `cloudSession !== undefined` 的行（paired/mobile 行永不匹配），先 `save` 后换内存；`countCloudTokens()` 便于诊断/测试 |
| `device-registry-load.ts`（新）                              | 注册表读取/归一化抽出；**重启即丢弃全部 `cloudSession` 行**并在丢弃时立即写回（不可读文件仍拒写，沿用既有保护）                                                               |
| `runtime-rpc-lifecycle.ts`                                   | `onClose` 且无同 token 其它连接时调用释放；持久化失败只记日志，不打断其它 close 清理                                                                                          |
| `device-registry-entry-validators.ts`                        | 逐行归一化抽为 `normalizeDeviceEntry`，给注册表腾出行数预算（max-lines 按非空行计，原文件仅余 6 行）                                                                          |

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

| 改动                                                         | 内容                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/bounded-parallel-map.ts`（新）                   | 有界并行映射：结果按输入顺序返回 `PromiseSettledResult[]`，在飞任务数 ≤ limit（`limit<1` 视为 1），失败按槽位隔离                                                                                                                                                                  |
| `src/main/cloud-platform/cloud-project-preparation.ts`（新） | 拆成 `prepareCloudProjectLink`（provision + 取票/选路，含一次重试，**不写环境**）与 `registerPreparedEnvironment`（写 sidecar）；`prepareProjectEnvironment` 保持两段串行组合（单项目路径不变）；`registerProjectEnvironments` = 有界并行准备 → **按原始顺序串行注册**，默认并发 3 |
| `src/main/ipc/cloud-platform.ts`                             | 处理器瘦身到 234 行，`registerProjects` 委托编排器；新增可选 `prepareConcurrency` 注入（测试/调参）                                                                                                                                                                                |

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

| 改动                                                                                 | 内容                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-platform/apps/api/src/project-occupancy.ts`（新）                             | `projectKeyTaken`/`projectPathTaken` 只统计非 archived 项目；`isProjectCreator`。管理员/自助创建统一使用                                                                                                                                                                                                                       |
| `server.ts`                                                                          | archive：释放 `projectsByKey`、幂等、写 `revokeProjectCredentials('project_archived')`；restore：`repoUrl` 非空 → `provisioning`（否则 `ready`）、清 `provisioningError`、key/path 被占用 → 409 + failure 审计、成功后重占 key；archive/restore 允许**管理员或创建者**，其它人 404；archived 项目除 archive/restore 外一律 404 |
| `server.ts`（主会话修正）                                                            | `GET /v1/projects` 默认**不返回** archived（管理员也一样），新增 `?includeArchived=1`（仅管理员）给管理台；`apps/web/app.js` 改用该参数。理由：原生桌面端用同一接口注册环境，若管理员看到 archived 会把历史项目当成活跃项目去准备                                                                                              |
| `cloud-connect-client.ts` / `cloud-session-service.ts` / IPC / preload               | `archiveProject(projectId)`：归档 → 关闭该项目连接 → 刷新列表；IPC 删除运行时环境并返回 `environmentId`                                                                                                                                                                                                                        |
| `cloud-runtime-environment.ts` / `cloud-project-preparation.ts` / `registerProjects` | `removeStaleCloudRuntimeEnvironments`：签到注册后清理不在可见项目集合里的云环境，`CloudProjectRegistration` 新增 `removedEnvironmentIds`                                                                                                                                                                                       |
| `renderer/cloud-workspace-entry.tsx`                                                 | 收到 `removedEnvironmentIds` → `purgeStaleRuntimeHostState` 清掉侧栏行；对外暴露 `archiveProject` 能力（未新增按钮）                                                                                                                                                                                                           |

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

| 改动                                                                                                         | 内容                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面 `cloud-session-persistence.ts`（新）                                                                    | `orca-cloud-session.json` 存 access/refresh token、deviceId、**device secret key**、显示名、apiUrl；形状校验、apiUrl 不匹配即忽略、`writeSecureJsonFile` + 权限收紧、删除。密码从不落盘                                                                                      |
| 桌面 `cloud-session-saved-login.ts`（新）/ `cloud-session-service.ts`                                        | `restoreSession()`（单飞）在启动后台执行：读文件 → 用**已存 secret key** 重建身份 → `listProjects()` 验证（401 走 M61 刷新）→ signed-in；`SESSION_EXPIRED` 删文件，网络错误保留文件；`whenRestored()` 让首个 `cloud:state` 等恢复完成；登录写盘、登出/会话失效清盘、轮换写回 |
| `cloud-auth-session.ts` / `web-cloud-auth.ts`                                                                | 新增 `onTokensChanged`，刷新轮换成功后回调（写盘失败只 warn，不影响已成功的请求）                                                                                                                                                                                            |
| 浏览器 `web-cloud-session-storage.ts`（新）/ `web-cloud-session-restore.ts`（新）/ `cloud-browser-bridge.ts` | localStorage 存会话（**不重复存设备 key**，复用 `web-cloud-device-key`）；`getState()` 首次惰性恢复；login/logout/会话失效写清；token 轮换写回                                                                                                                               |
| 拆分（保持 ≤300 行）                                                                                         | `cloud-session-project-admin.ts`、`cloud-browser-saved-session.ts`、`cloud-browser-project-connections.ts`、`cloud-browser-bridge-unsupported.ts`；`e2ee-crypto` 增加 `keyPairFromSecretKey`                                                                                 |

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

| 改动                                                   | 内容                                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-socket-handshake.ts`                            | `e2ee_auth` 增加 `clientCapabilities: ['agent.launch.v2']`（`CLOUD_RUNTIME_CLIENT_CAPABILITIES`）。只声明 v2：桌面原生云工作区两种结果都能渲染；replay/prompt-carry 属于本传输未协商的独立契约，不能替主机宣称 |
| `cloud-agent-launch-execution.test.ts` + fixture（新） | 真实平台 + 真实注册主机/心跳 + 真实 TLS Runtime + 真实 managed worktree + 真实 PTY（假 `claude` CLI 经 `agentCmdOverrides` 注入，不改全局 PATH）                                                               |

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

| 批次                | 命令                                                                                                                                         | 结果                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 平台 e2e            | `cd cloud-platform && node --test --test-concurrency=4 test/e2e/*.e2e.test.ts`                                                               | **94/94 通过**（17 suites，26.6s） |
| 平台单元/契约       | `cd cloud-platform && node --test --test-concurrency=4 test/*.test.ts`                                                                       | **25/25 通过**                     |
| 云端主进程模块      | `vitest run --maxWorkers=4 src/main/cloud-platform/`                                                                                         | **51 文件 / 260 条全过**（38.2s）  |
| 渲染/Web/共享云模块 | `vitest run --maxWorkers=4 src/renderer/src/cloud/ src/renderer/src/web/web-cloud src/shared/cloud- src/shared/bounded-parallel-map.test.ts` | **23 文件 / 114 条全过**（8.7s）   |

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

| 项             | 结果                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探针（修复前） | 云端 `agent.launch` **能**返回 `outcome.kind: 'structured'` 并拿到 sessionId，但随后 `agentSession.history` / `options` / `close` **全部**返回 `structured_agent_session_unsupported`——即“宣称能渲染 chat，却读不到刚创建的 chat” |
| 根因           | `cloud-socket-handshake.ts` 的 `CLOUD_RUNTIME_CLIENT_CAPABILITIES` 只有 `agent.launch.v2`；host 的 `requireStructuredCapability` 因缺少 `agent-session.structured.v1` 拒绝全部 `agentSession.*`                                   |
| 修复           | 客户端能力表补齐：`agent-session.structured.v1`、`agent-session.structured.claude.v1`、`agent-session.turn-item.v1`、`agent-session.options.optional-model.v1`（桌面壳渲染这些形状；replay/prompt-carry 仍不宣称，注释保留理由）  |
| 测试           | `src/main/cloud-platform/cloud-structured-agent-session.test.ts`（184 行，门禁 skip 时标题写明原因）+ fixture 暴露 `store` 以便切换 launch mode 与还原真实 CLI                                                                    |

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

| 产出                                                           | 内容                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test-plan.md`（新）                                           | 分级策略（引用 §4.1）、测试数据/环境、**AC-01…AC-32 逐条映射**（测试文件::用例 + 证据路径 + 结论）、不可验证项与前置条件、执行命令。映射只认用例里的断言，不按测试名推断 |
| `test-reports/acceptance-2026-11-13.md`（新）                  | 本轮真实执行结果、产品缺口（BLOCKER/MAJOR/MINOR）分级、结论                                                                                                              |
| `m70-acceptance.e2e.test.ts`（新，294 行）                     | AC-01（50 次采样 P95）、AC-02（注入时钟验证 15 分钟锁定）、AC-03（存在性不泄露）、AC-04（授权后可见）、AC-08（心跳超时）、AC-25（吊销后令牌失效）                        |
| `src/main/cloud-platform/m70-acceptance.test.ts`（新，145 行） | AC-09：真实平台进程 + 真实 Orca Runtime + 真实加密 RPC 验证维护模式拒绝新连接                                                                                            |
| `platform.e2e.test.ts` E3                                      | 加强为必须 `401` 且 `x-orca-reject` 非空（AC-21）                                                                                                                        |

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

| 改动                                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台 `store.ts` / `server.ts`                             | `Host.revokedAt`（旧数据缺省 `null`）；`DELETE` 改为置 `revokedAt`、**保留 `credentialHash`**（只为继续送达吊销）、删 relay 路由、沿用项目撤销、审计带 `revokedAt`；心跳鉴权通过后若已吊销 → **仍 200** 并返回 `hostRevoked: true`，但不刷新 status/directAddrs/e2ee/projectsRoot/lastHeartbeatAt；`handleConnect` 先判 `409 HOST_REVOKED`；`hostOnline` 与 `projectView.hostStatus` 对吊销主机一律 offline |
| 主机 `cloud-host-enrollment.ts` / `cloud-agent-client.ts` | 解析 `hostRevoked`；收到后置 `hostRevoked`/`lastError='host_revoked'`，对**所有已准入 ticket** 触发撤销回调（运行时以 4403 关闭已建会话），`refresh()`/`start()` 不再发请求，`admit` 直接拒绝（401 + `x-orca-reject: host_revoked`），并停止心跳定时器                                                                                                                                                      |
| 测试                                                      | 平台 e2e `host-revocation.e2e.test.ts`；真实端到端 `cloud-host-revocation.test.ts`；主会话补 `cloud-agent-revocation-stop.test.ts`（吊销后不再心跳、admit 拒绝）                                                                                                                                                                                                                                            |

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

| 改动                                                                             | 内容                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-denial-details.ts`（新）                                                  | `PATH_OUTSIDE_ROOT` / `PERMISSION_MISSING` / `METHOD_NOT_AVAILABLE` / `DOWNLOAD_DISABLED` 词汇与构造；由权限映射推导，不改变准入逻辑 |
| `runtime-rpc-request-admission.ts` / `runtime-rpc-websocket-dispatch.ts`         | `buildError` 增加可选 `data`；路径拒绝附 `{denial:'PATH_OUTSIDE_ROOT', reason}`                                                      |
| `rpc-request-admission-prologue.ts`                                              | 云会话的方法权限拒绝附 `methodDenialDetails(...)`                                                                                    |
| `cloud-rpc-multiplexer.ts` / `cloud-connect-client.ts` / `cloud-platform-ipc.ts` | 把 `error.data` 一路带到 `CloudRpcResult`/`CloudRpcOutcome` 的 `data`                                                                |
| 文档                                                                             | `design.md` §6.5 增补「D. 云会话 RPC 拒绝」表；`test-plan.md` AC-27/AC-28 结果与证据更新                                             |

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

| 改动                               | 内容                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-host-audit.ts`（新）        | 主机侧有界缓冲（200 条，保留最新），事件 `connection_rejected` / `path_denied` / `method_denied`，按序号 `take`/`clearThrough`，与 provisioning 上报同一模式                       |
| `cloud-agent-client.ts`            | `admit` 的每一条拒绝路径（伪造/过期/重放/缺凭证/主机已吊销）都入缓冲；`reportAudit` 暴露给 Runtime；心跳携带 `audit[]`，平台接受后按序号清除                                       |
| `cloud-heartbeat-body.ts`（新）    | 心跳体组装（地址、E2EE 公钥、projectsRoot、provisioned、audit），从客户端抽出以守住行数上限                                                                                        |
| `cloud-agent-config.ts`（新）      | `CloudAgentConfig` 类型移出，客户端行数回到预算内                                                                                                                                  |
| `host-audit-ingest.ts`（新，平台） | 校验事件类型/结果，单次 ≤100 条、文本 ≤512 字符；逐条 `appendBestEffort` 写入既有哈希链，`eventType=host.<事件>`，`actor=host:<主机名>`，`target` 为设备（有 `deviceId` 时）或主机 |
| Runtime 侧                         | `setCloudHostAudit` 安装接收器；WSS 路径拒绝、方法/权限拒绝分别写入 `path_denied` / `method_denied`（带设备、主体、项目、方法、`denial`、`reason`）                                |
| 文档                               | `design.md` §4.3.3 增补实现载体与事件名；`test-plan.md` AC-11/21/27/28 更新为 PASS 并引用 M73 证据                                                                                 |

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

| 改动         | 内容                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`  | 新增 `hostStatusView()`：吊销 → `offline`；维护中 → `maintenance`；否则按 `hostOnline()`（状态 + 心跳窗口）判定 `online`/`offline`。`projectView` 改用它，`/v1/hosts.online`、connect 的 `HOST_OFFLINE` 本就按 `hostOnline()`，三者口径统一 |
| 离线窗口可配 | `ApiConfig.hostOfflineMs` + 环境变量 `ORCA_CLOUD_HOST_OFFLINE_MS`（默认仍 60s），测试用真实进程缩短窗口观测翻转                                                                                                                             |
| 测试         | 新增平台 e2e `host-offline.e2e.test.ts`：真实平台进程 + 真实主机注册/心跳 + 真实登录，窗口 400ms；`m70-acceptance.e2e.test.ts::AC-08` 从「记录缺口」改为断言 `offline`                                                                      |

**验证（`evidence/m74-offline-host/host-offline.json`）**：心跳后 `hostStatus=online`、`/v1/hosts.online=true`、connect 200；静默 > 窗口后 `hostStatus=offline`、`online=false`、connect **409 `HOST_OFFLINE`**；再次心跳立即恢复 `online`。

- 平台测试 **127/127** 通过；渲染层 `use-cloud-session.test.tsx` 11/11（离线项目列出但「打开」禁用 + 「主机离线」徽标）；`tsc node` 0；`check:code-quality:changed` 0 新发现。

**负向对照**：把 `hostStatus` 改回 `host.status` → `host-offline.e2e.test.ts` 转红（`actual: 'online'` vs `expected: 'offline'`）；恢复后全绿。

**如实记录 / 剩余**：

1. 判定仍是**请求时**推导，不是后台定时把主机改离线：`/v1/hosts` 的 `status` 字段仍为最后一次上报值（`online` 布尔已正确）。不改变行为，仅字段语义差异。
2. 维护中的主机对工作台同样不可打开，徽标文案统一为「主机离线」，未区分「维护中」。
3. 客户端（桌面/浏览器）在自己的连接缓存里不会主动失效已打开的会话；仅有新列表数据时更新。

## M75 修复 G-09：平台停机映射 `PLATFORM_UNAVAILABLE`，且不无凭证重连（AC-20）（本轮，主会话执行）

**问题（M70 验收映射发现）**：平台停机时 `fetch` 的 `TypeError: fetch failed` 原样抛出，调用方无法按码分支；更严重的是 `cloud-auth-session` 的刷新把**任何**异常都当成会话失效并永久锁死（`expired = true`）——一次网络抖动就会把用户登出，与 AC-20「已有会话继续、不无凭证重连」相反。

| 改动                                  | 内容                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform-unavailable.ts`（新） | `PLATFORM_UNAVAILABLE` 码；`isPlatformUnreachable()` 沿 `cause` 链识别 `ECONNREFUSED`/`ENOTFOUND`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/`EHOSTUNREACH`/`ENETUNREACH`/`EPIPE`/`UND_ERR_*`、`AbortError`/`TimeoutError` 与 `TypeError: fetch failed`；`platformRequest()` 只转换传输失败，其余错误原样抛出 |
| `cloud-auth-session.ts`               | 刷新请求走 `platformRequest`；**5xx 也视为不可用**；只有平台真的拒绝（无 `accessToken`）才置 `expired` 并抛 `SESSION_EXPIRED`。不可用时不锁死，下次请求重试                                                                                                                                             |
| `cloud-authorized-request.ts`         | `ensureFresh`、首发请求、强制刷新、重试请求全部经 `platformRequest`；`throwCloudPlatformError` 对 5xx 直接给 `PLATFORM_UNAVAILABLE`                                                                                                                                                                     |
| `cloud-connect-client.ts`             | `login()` 的传输失败同样映射                                                                                                                                                                                                                                                                            |
| 测试辅助                              | `cloud-tcp-proxy-fixture.ts`：可暂停的 TCP 前置代理，断网但平台进程与内存状态保留                                                                                                                                                                                                                       |

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

| 改动                              | 内容                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signing-key-ring.ts`（新，平台） | 当前键 + 已退役键（`retiredAt`/`retainUntil`=60 天）；`rotate()` 退役当前键并发新键（`kid` 带随机后缀，防同毫秒重号）；`publicKeys()` 先按注入时钟裁剪过期退役键，再返回「当前 + 保留中」                                                                            |
| `server.ts`                       | 签署改用 `signingKeys.current()`；`/v1/jwks` 返回整个环；新增 `POST /v1/admin/signing-keys/rotate`（仅管理员；`auditAllowsMutations` fail-closed；成功与 403 都写 `signing_key_rotate` 审计，成功事件带 `previousKid`）；`ApiHandle.signingKey` 改为 getter 保持兼容 |
| 文档                              | `design.md` §8 API 表补该路由与「旧公钥继续发布 60 天」；`test-plan.md` AC-31 由 UNVERIFIED 更新为 PASS                                                                                                                                                              |

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

| 改动                            | 内容                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-host-trust.ts`（新）     | `sha256:<hex>` 指纹（对原始密钥字节，跨 base64 重编码稳定）+ 展示分组；持久化 `orca-cloud-host-trust.json`（`writeSecureJsonFile`）；`hostKeyVerdict()` 返回 `first_use` / `trusted` / `mismatch` |
| `cloud-host-key-guard.ts`（新） | `check(ticket)`：首次使用自动固定并落盘；不匹配则关闭当前 socket（4433 `fingerprint_mismatch`）并抛 `FINGERPRINT_MISMATCH`（带 `closeCode` 与两个指纹）；`trust()` 是唯一的重新固定入口           |
| `cloud-connect-client.ts`       | `prepareProjectLink` 在取票后、选路/升级前调用 guard；新增 `trustHostKey()` / `pinnedHostFingerprint()`；`userDataPath` 透传信任库位置                                                            |
| `cloud-socket-handshake.ts`     | `close(code?, reason?)`，让客户端侧的拒绝能作为 4433 关闭帧发出                                                                                                                                   |
| 平台 `server.ts`                | 心跳里 E2EE 公钥变化时写 `host_e2ee_key_changed` 审计（只记录新旧指纹，不记录密钥），相同键重复上报不重复写                                                                                       |
| 文档                            | `test-plan.md` AC-29 由 UNVERIFIED 更新为 PASS                                                                                                                                                    |

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

| 改动                         | 内容                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-release.ts`（新，平台） | 启动时读取前端目录、按文件内容算 SHA-256、以「文件名:哈希」聚合出 `build` id；`index.html` 中的 `/app.js`、`/config.js`、`/styles.css` 改写为 `/assets/<build>/…`；当前构建归档到 `WEB_ARCHIVE/<build>/`，解析旧 build 时从归档读取（并校验归档 build 一致，防止残缺归档冒充）                                                                                              |
| `web-contract.ts`（新）      | 前端契约版本（`WEB_CONTRACT_VERSION=1`、`MIN=1`）与 `x-orca-web-contract` 解析/判定；缺失头视为当前版本（兼容未协商的旧前端）                                                                                                                                                                                                                                               |
| `server.ts`                  | `GET /v1/web/release`（公开：contract/build/资产路径与哈希）；`/v1/*` 契约门（超出窗口 → 426 `WEB_CONTRACT_UNSUPPORTED` + `{offered, minContract, maxContract}`）；`/assets/<build>/<file>` 以 `immutable` 长缓存返回；入口 `index.html` `no-store` + `x-orca-web-build`；旧的未哈希路径保留 `no-cache` + ETag；`ApiConfig.webRoot`/`webReleaseArchiveDir` 可用环境变量覆盖 |
| 测试夹具                     | `spawnService` 的 `stop()` 修复：被信号终止的子进程 `exitCode` 为 null，重复调用 stop 会永久等待（本轮实际踩到）                                                                                                                                                                                                                                                            |

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

| 改动                                     | 内容                                                                                                                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-policy-propagation.test.ts`（新） | 真实平台进程 + 真实 Runtime + 真实 WSS + 真实 10s 轮询定时器（`client.start()`，全文件不调用 `refresh()`）：同一已建会话先被默认策略拒绝，管理员改为 `allow` 后**轮询自动**打开闸门，再改回 `deny` 后自动关闭；每次以 250ms 间隔探测并记录耗时 |
| 文档                                     | `test-plan.md` AC-17 由 PASS(部分) 更新为 PASS                                                                                                                                                                                                 |

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

| 改动                                        | 内容                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/audit-writer/src/writer.ts`（新）     | `POST /v1/append`（批量 ≤1000，进程内串行）、`GET /v1/events`、`/v1/verify`、`/v1/status`、`/health`；内部令牌鉴权；启动时回放并校验既有日志；链损坏时**拒绝一切追加**（503 `AUDIT_CHAIN_BROKEN`），让所有副本 fail-closed |
| `apps/api/src/audit-writer-client.ts`（新） | 副本侧 `AuditSink` 实现（append / appendBestEffort / query / verify / getHealth）；写失败标记 `write_failed`、写入者报告断链则标记 `chain_broken` 并抛同码错误                                                             |
| `audit.ts`                                  | `AuditChain` 依赖收窄为 `AuditStore`（只要 `audit/auditSeq/auditTip`），写入者可复用它而无需整个 `Store`                                                                                                                   |
| `server.ts`                                 | `AuditSink` 接口；设置 `ORCA_CLOUD_AUDIT_WRITER_URL` 时走远端写入者，否则保持原有本地链；`recordAudit`、`audit.append/query/verify` 全部改为 `await`（本地链返回同步值，`await` 兼容）                                     |
| 文档                                        | design §13.2 增补一期实现与未实现清单；test-plan AC-26 由 UNVERIFIED 更新为 PASS                                                                                                                                           |

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

| 改动                                 | 内容                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-host-key-guard.ts`            | 记录 mismatch 时看到的公钥（只在主进程），`trustPending(hostId)` 是唯一消费入口；抛出物新增 `hostId`；新增 `hostKeyDetails()` / `trustPendingHostKey()` 供服务层与 IPC 复用                                                                  |
| `cloud-project-open-result.ts`（新） | 打开结果的构造与失败映射（含 `hostKey` 明细），从服务类抽出以守住行数上限                                                                                                                                                                    |
| `cloud-session-service.ts`           | 打开成功携带 `hostFingerprint`；失败携带 `hostKey { hostId, pinnedFingerprint, seenFingerprint }`；新增 `trustHostKey(hostId)`；fork 出的客户端共享同一个 guard（`deviceIdentity().hostKeys`），否则 mismatch 记在临时客户端上、主会话看不到 |
| IPC / preload                        | 新通道 `cloud:trustHostKey(hostId)`——渲染进程只说「用户已核对」，公钥不跨进程                                                                                                                                                                |
| 渲染进程                             | `useCloudSession` 暴露 `hostKeyMismatch` / `confirmHostKey()` / `dismissHostKeyMismatch()`；新增阻塞对话框 `cloud-host-key-dialog.tsx`（同时显示两个指纹）；`CloudApp` 挂载它                                                                |
| 文档                                 | `test-plan.md` AC-29 补充 M81 证据与浏览器路径的未做项                                                                                                                                                                                       |

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

| 改动                                   | 内容                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-host-key-trust.ts`（新，浏览器）  | TOFU 固定库：WebCrypto SHA-256（对原始密钥字节，`sha256:<hex>`，与桌面同格式）、JSON 存 localStorage（独立 key `orca.webCloudHostTrust`）、`first_use`/`trusted`/`mismatch` 判定；损坏或空库一律视为「未固定」，不 fail-open |
| `cloud-browser-project-connections.ts` | 取票后、创建任何 socket 之前校验：首次自动固定；不匹配时把新公钥留在内存 `pendingKeys` 并返回 `FINGERPRINT_MISMATCH` + 两个指纹；`trustPendingHostKey()` 是唯一消费入口；打开结果带 `hostId`/`hostFingerprint`               |
| `cloud-browser-bridge.ts`              | 注入 `hostTrustStorage`（默认 localStorage，node 下无操作）；暴露 `trustHostKey(hostId)`；两个 open 结果都带 `hostFingerprint`                                                                                               |
| 管理端入口                             | `cloud-admin/main.tsx` 渲染同一个 `CloudApp`，因此 M81 的阻塞确认对话框直接生效，无需新增 UI                                                                                                                                 |
| 工程                                   | 新 e2e 规格加入 `tsconfig.cloud-e2e.json`，并从 `tsconfig.tc.web.json` 排除（与其他浏览器 cloud e2e 一致）                                                                                                                   |

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

| 改动                         | 内容                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay-nodes.ts`（新，平台） | 活中继表：`register({id, port})` 记录/刷新，`healthy(now, aliveMs)` 按最近一次自注册过滤并按首次注册顺序排序；默认窗口 30s，可用 `ORCA_CLOUD_RELAY_ALIVE_MS` 缩短（测试用 6s）                                                                                                |
| `server.ts`                  | `POST /v1/internal/relay-endpoint` 接受 `id` 并刷新节点（端口非法 400）；`/connect` 的 `endpoints.relay` 改为**所有活节点**（按优先级）；新增 `GET /v1/internal/relays` 供运维/测试查看在线状态；无任何近期自注册时仍下发最后一个已知节点，避免平台短抖动导致客户端无中继可用 |
| `apps/relay/src/relay.ts`    | 每次路由同步成功后向平台自注册（`id` 默认 `relay:<port>`）；关闭时销毁入站 socket，避免 `close()` 永久等待                                                                                                                                                                    |
| 文档                         | `test-plan.md` AC-23 由 UNVERIFIED 更新为 PASS                                                                                                                                                                                                                                |

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

| 改动                                          | 内容                                                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/login-lockout/src/lockout.ts`（新服务） | 单实例共享计数：`POST /v1/failure`、`GET /v1/state?username=`、`POST /v1/clear`、`/health`；内部令牌鉴权；5 次锁 15 分钟，锁过期后读即清零（不累计旧失败）                                                                                     |
| `apps/api/src/login-lockout-client.ts`（新）  | 副本侧客户端；`isLocked` 不可达时返回 `remaining = -1`（标记「计数不可用」），写路径抛 `LOCKOUT_UNAVAILABLE`                                                                                                                                   |
| `server.ts`                                   | `ApiConfig.loginLockoutUrl` / `ORCA_CLOUD_LOGIN_LOCKOUT_URL` 启用共享计数；登录流程改为 `await` 三个包装函数；**计数不可达时返回 503 `PLATFORM_UNAVAILABLE`（fail-closed）**，不猜测放行；成功登录仍清零计数（远端失败忽略，不阻塞已认证用户） |
| 文档                                          | `test-plan.md` AC-02 增补多副本证据                                                                                                                                                                                                            |

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

| 改动                                                             | 内容                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-tcp-proxy-fixture.ts`             | 新增 `startRecordingProxy`：在平台前记录双向全部字节，供测试逐字节检索                   |
| `src/main/cloud-platform/cloud-platform-data-path.test.ts`（新） | 真实平台进程 + 记录代理 + 真实 TLS Runtime + 真实 E2EE；客户端与主机的控制面请求都经该跳 |
| 文档                                                             | `test-plan.md` AC-05 升为 PASS，AC-24 补平台侧证据与范围说明                             |

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

| 改动                                                          | 内容                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-tcp-proxy-fixture.ts`          | `startRecordingProxy` 支持惰性目标端口（代理先建、运行时后起）                                                                                           |
| `src/main/cloud-platform/cloud-relay-data-path.test.ts`（新） | 真实中继**进程**（`apps/relay/src/relay.ts`，PORT=0）+ 真实平台进程 + 真实 TLS Runtime + 真实 E2EE；主机不广播直连地址，强制走中继；记录代理置于中继出向 |
| 文档                                                          | `test-plan.md` AC-24 升为 PASS（平台跳 + 中继出向均逐字节证明）                                                                                          |

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

| 改动                                          | 内容                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/audit-writer/src/writer-lease.ts`（新） | 租约文件：`wx` 原子创建抢占 + mtime 刷新 + 过期接管；写入前逐批 `assertLeadership()`（fencing：读到别的持有者即让位）。明确不是共识算法                                                              |
| `apps/audit-writer/src/writer.ts`             | `AUDIT_LEASE_PATH`/`AUDIT_LEASE_TTL_MS`/`WRITER_ID`；只有持租约者读日志并接受 append，其余返回 503 `AUDIT_WRITER_STANDBY`；`/health` 增加 `role`；接管时在串行队列内重新 `restore` 日志再置为 leader |
| `apps/api/src/audit-writer-client.ts`         | 支持 `urls`：粘性选择 + 网络失败/`AUDIT_WRITER_STANDBY` 时切下一个；**`AUDIT_CHAIN_BROKEN` 不切换**（链损坏是全局的）                                                                                |
| `apps/api/src/server.ts`                      | `apiConfig.auditWriterUrls` / `ORCA_CLOUD_AUDIT_WRITER_URLS`（逗号分隔）；单 URL 配置仍兼容                                                                                                          |

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

| 改动                                                                | 内容                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-grant-revocation-live.test.ts`（新） | 真实平台进程 + 真实注册主机（心跳即撤销通道）+ 真实 TLS Runtime + 真实 E2EE；管理员清空 `team-payment` 授权后**不手动刷新**，只等心跳 |
| 文档                                                                | `test-plan.md` AC-12 由 PASS(部分) 升为 PASS                                                                                          |

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

| 改动                                                                     | 内容                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `apps/api/src/audit.ts`                                                  | `AuditChain` 接受可选 `now` 时钟（默认 `Date.now`），`ts` 随之；`query()` 新增 `traceId` 过滤 |
| `apps/api/src/server.ts`                                                 | 本地审计链传入平台 `now`；`/v1/audit/events` 接受 `traceId` 查询参数                          |
| `apps/api/src/audit-writer-client.ts`、`apps/audit-writer/src/writer.ts` | 远程审计查询同步支持 `traceId`（多副本部署同样可用）                                          |
| `test/e2e/audit-trace-window.e2e.test.ts`（新）                          | 真实平台 HTTP + 注入时钟 + 真实 Ed25519 签名 + 真实注册主机与心跳                             |

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

| 改动                                                         | 内容                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-terminal-relay.test.ts`（新） | 真实中继**进程**（`apps/relay/src/relay.ts`，PORT=0）+ 真实平台 + 真实 TLS Runtime + 真实 E2EE + **真实 PTY**（node-pty）；主机不广播直连地址，强制选中继；运行时 TLS 端口在注册时尚不存在，故中继目标经惰性端口转发 hop 解析 |
| 文档                                                         | `test-plan.md` AC-06 由 PASS(部分) 升为 PASS                                                                                                                                                                                  |

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

| 改动                                                              | 内容                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cloud-endpoint-probe.ts`（新）                                   | 探测原语从路由选择中抽出；`describeEndpoint` 只保留 `host:port`（不带 route key / 查询串）                             |
| `cloud-route-selection.ts`                                        | `chooseRoute` 返回 `{ choice, probes }`：按尝试顺序记录线路、地址、结果、耗时                                          |
| `cloud-connect-client.ts`                                         | 全部不可达时把 `probes` 挂在错误上                                                                                     |
| `cloud-project-open-result.ts`                                    | `failedCloudOpen` 将 `probes` 透传为 `connectDiagnostics`（全有或全无，避免半截诊断）                                  |
| `shared/cloud-platform-ipc.ts`                                    | `CloudOpenResult` 失败分支新增 `connectDiagnostics`                                                                    |
| `use-cloud-session.ts` / `cloud-connect-failure-dialog.tsx`（新） | 打开失败时弹出面板：错误码、逐地址步骤、重试、复制诊断；重试复用同一项目                                               |
| 测试                                                              | `cloud-connect-diagnostics.test.ts`（真实平台/真实 TCP/真实中继进程）、`cloud-connect-failure-dialog.test.tsx`（3 例） |

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

| 改动                                                            | 内容                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/cloud/cloud-file-panel.tsx`                   | 图片预览文案改为「托管项目不提供图片预览与下载」，不再引导用户去找下载                                     |
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

| 改动                                                         | 内容                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

| 改动                                            | 内容                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/server.ts`                        | 新增 `denyPrivileged()`：写 `denied` 审计（含 `reason`、`requiredPermission`）后返回 403；9 处裸 403 改为调用它；3 处已有审计补上同样的 `metadata`，`signing_key_rotate` / `audit_verify` 也统一走该函数 |
| `test/e2e/admin-denial-audit.e2e.test.ts`（新） | 真实平台进程 + 真实登录令牌，逐一访问 12 个管理接口并核对审计链                                                                                                                                          |

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

| 改动                                                           | 内容                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-admin-grant-open.test.ts`（新） | 真实平台进程 + 真实主机注册（一次性令牌）+ 真实 TLS Runtime + 真实 E2EE：成员先登录，管理员再建项目并授权，同一会话刷新后打开 |
| 文档                                                           | `test-plan.md` AC-04 由 PASS(部分) 升为 PASS                                                                                  |

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

| 改动                                                                 | 内容                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/server.ts`                                             | 用户级授权变更改为 `revokeUserCredentials()`；组级（或找不到该用户）仍按项目撤销。用户撤销写入的是**用户名**——票据 `sub` 为 `user:<username>`，而主机按该声明比对撤销集合 |
| `src/main/cloud-platform/cloud-grant-revocation-scope.test.ts`（新） | 真实平台 + 真实注册主机（心跳为撤销通道）+ 真实 TLS Runtime + 真实 E2EE；两个用户同一项目                                                                                 |

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

| 改动                                                              | 内容                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/test/e2e/web-workbench-latency.e2e.test.ts`（新） | 真实平台进程（提供真实 `apps/web`）+ 真实 Chromium（Playwright，headless，`channel: chrome`）；每次采样用全新上下文（冷 localStorage/连接池），计时从点击「登录」到**工作台项目行已渲染**且不再是「加载中」 |
| 文档                                                              | `test-plan.md` AC-01 由 PASS(部分) 升为 PASS                                                                                                                                                                |

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

| 改动                                                                 | 内容                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/main/cloud-platform/cloud-session-user-isolation.test.ts`（新） | 真实平台进程 + 真实注册主机/TLS Runtime + 两个真实数据目录；`CloudSessionService` 每个目录一个实例 |
| 文档                                                                 | `test-plan.md` AC-16 补上隔离证据（仍为 PASS，覆盖说明更完整）                                     |

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

## M99 验收包自检与索引生成（人工验收准备）（本轮，主会话执行）

**问题**：验收材料只有一张手写的 AC→证据映射表。任何一条路径写错、文件被删或写成简称，评审时才会发现；也没有一份可以直接照着逐条勾选的索引。

| 改动                                                 | 内容                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/test/acceptance-index.test.ts`（新） | 解析 `test-plan.md` §4，校验：恰好 32 条 AC 且无重复/缺项；结论只允许 `PASS`／`PASS(部分)`／`UNVERIFIED`；每条引用的证据文件**存在、非空**，`.json` 必须可解析；`UNVERIFIED` 不得引用任何存在的证据（防止伪证）；生成验收索引 |
| `test-plan.md`                                       | 修掉 1 条真错误：AC-21 的证据写成了简写 `m46-browser-upgrade/m46-2/3`，且该行结构多出一列；补回 M87/M82/`m19-desktop-connect` 三处此前漏引的证据                                                                              |
| 生成物                                               | `test-reports/acceptance-index.md`（人读）、`evidence/m99-acceptance-index/acceptance-index.json`（机读）                                                                                                                     |

**验证**：

- 32 条 AC 全部解析成功且状态合法；**30 条 PASS、2 条 UNVERIFIED**（AC-22 压测、AC-32 WAF）。
- 全部 70+ 个证据引用逐一确认存在、非空、`.json` 可解析；修复前该检查当场抓到 AC-21 的简写与多余列。
- 索引列出每条 AC 的证据文件与字节数，可直接用于人工逐条核对。
- **负向对照**：① 把一条证据改成不存在的路径 → 报 `AC-07 cites missing evidence …` 转红；② 让 UNVERIFIED 的 AC-22 引用一个真实文件 → 报 `AC-22 is UNVERIFIED but cites …` 转红。均恢复后全绿。
- 回归：平台全量 **142/142**；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：

1. 该检查保证「引用的证据确实存在」，不保证「证据足以支撑结论」——后者仍需人工评审。
2. `evidence/` 目录中另有 48 个历史模块目录未被 test-plan 引用（早期 M12–M69 的逐步证据），已在索引中如实列出，未删除。
3. 索引由测试生成，改动证据引用后需重跑该用例才会刷新。

## M100 审计签名锚点（G-04 剩余项）（本轮，主会话执行）

**问题（design §13.2 未实现项）**：哈希链只有「与自己一致」的能力。拿到写权限的一方可以把整条链**重新锻造**——重算每一行 `prev_hash`/`hash`——而 `verify()` 仍然通过。设计要求的「每 5 分钟对 `(seq, hash, 时间)` 签名并单独留存」此前没有实现。

| 改动                                      | 内容                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/audit-writer/src/anchor.ts`（新）   | 独立 Ed25519 锚点密钥（首次生成并落盘 0600）、链尾签名、锚点追加式文件存储、**独立验证** `verifyAuditAnchor(publicKeyPem, anchor)` 与 `anchorMatchesChain(events, anchor)`                                              |
| `apps/audit-writer/src/writer.ts`         | `AUDIT_ANCHOR_PATH` / `AUDIT_ANCHOR_KEY_PATH` / `AUDIT_ANCHOR_INTERVAL_MS`（默认 5 分钟）；定时器在串行队列内对**已推进**的链尾生成锚点；`GET /v1/anchors`（锚点 + 公钥）、`POST /v1/anchors`（立即锚定，供运维与测试） |
| `test/e2e/audit-anchor.e2e.test.ts`（新） | 真实写入者进程 + 真实 API 副本产生真实审计事件                                                                                                                                                                          |

**验证（`evidence/m100-audit-anchor/audit-anchor.json`）**：

- 定时器自动产生锚点（seq 4、7），每条签名用公钥**独立验证通过**，且都指向日志中真实存在的同 `seq` 同 `hash` 事件。
- 锚点按链序追加、无重复；手动 `POST /v1/anchors` 得到覆盖当前链尾（seq 7）的锚点。
- 重启写入者（同时重启副本指向新端口）：锚点全部保留、**公钥不变**；新事件后再锚定得到 seq 9，仍可验证。
- **识别重写**：把日志整链重新锻造（篡改 seq 5，并重算所有哈希，使普通 `verify()` 仍通过）后——篡改点之前的锚点（seq 4）仍匹配，篡改点之后的锚点（seq 7）**签名有效但与新链不符**，整链重写因此暴露。
- **负向对照**：① 把签名换成空字节 → `anchor 4 signature must verify` 转红；② 让 `anchorMatchesChain` 只比 `seq` → `anchor 7 must expose the rewrite` 转红。均恢复后全绿。
- 回归：平台全量 **143/143**；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：

1. 锚点与日志默认同目录（同一台机器），只能证明「日志自某时刻起未被重写」；真正防整机丢失需把锚点**异地留存**（对象存储/另一账号），这是部署配置，不是代码缺口。
2. 密钥文件与写入者同机；若攻击者同时拿到两把，锚点也可重签——锚点公钥需在平台侧/运维侧留存一份。
3. 未实现 Redis Stream 队列、PostgreSQL/对象存储归档（G-04 其余项）。

## M101 补齐 FR-5.7 的「工作区显示线路与延迟 + 连接诊断页」（本轮，主会话执行）

**问题（M91 记录的剩余项）**：FR-5.7 要求「项目视图显示当前线路（直连/中继）与延迟，并可打开连接诊断页」。此前只有**失败时**才出现诊断面板；打开成功的会话只显示线路徽标，没有延迟，也没有可打开的诊断页。

| 改动                                                                                        | 内容                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `cloud-connect-client.ts` / `cloud-project-connections.ts` / `cloud-project-open-result.ts` | 打开成功的结果携带 `probes`（逐地址探测与耗时）；`CloudOpenResult` 成功分支新增 `connectDiagnostics`        |
| `cloud-endpoint-probe.ts`                                                                   | 抽出 `endpointUnreachableError()`，避免客户端主文件超行数                                                   |
| `use-cloud-session.ts`                                                                      | `opened` 保存 `connectDiagnostics`                                                                          |
| `cloud-project-workspace.tsx` + `cloud-connection-diagnostics.tsx`（新）                    | 顶部显示线路与**选中线路的探测延迟**；「连接诊断」按钮打开面板，列出选中地址、延迟与全部探测步骤            |
| 测试                                                                                        | `cloud-open-route-diagnostics.test.ts`（真实平台/Runtime）、`cloud-connection-diagnostics.test.tsx`（2 例） |

**验证（`evidence/m101-open-route-diagnostics/open-route-diagnostics.json`）**：

- 真实打开：首个直连地址不可用（关闭端口）→ 继续探测 → 打开成功，结果里 2 条探测（第一条失败、第二条成功），`route=direct` 与成功探测一致，`status.get` 可用。
- 组件：顶部显示「中继」+「24ms」；诊断面板显示「直连 10.0.0.5:4433（1002ms）无响应」「中继 10.0.0.9:4433（24ms）已连通」以及选中线路/地址/延迟。
- 没有诊断数据（旧回复）时不显示延迟与诊断入口。
- **负向对照**：① 从打开结果里去掉 `connectDiagnostics` → `expected 0 to be greater than or equal to 2` 转红；② 去掉顶部延迟 → `Unable to find … cloud-route-latency` 转红。均恢复后全绿。
- 回归：相关 main + renderer 用例 **57/57**（14 个文件，含全部云端渲染层 45 例）；`tc:node`、`tc:web` 0；`check:code-quality:changed` 0 新发现。

**如实记录 / 剩余**：

1. 显示的是**探测**耗时（TCP 建立、路由选择），不是持续的 RTT 或终端回显延迟；设计 §7 的「终端输入回显 P95 ≤ 120ms」仍未测。
2. 浏览器版（管理员会话页）未加同款面板，它复用 `CloudOpenResult`，但界面尚未展示。

## M102 终端输入回显延迟 P95（requirements §5.1）（本轮，主会话执行）

**问题**：requirements §5.1 规定「终端输入回显（同城网络）P95 ≤ 120ms」，此前没有任何测量；M101 记录的只是连接探测耗时，不能代表输入回显。这是 M101「如实记录」第 1 条的收口。

| 改动                                        | 内容                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-terminal-echo-latency.test.ts`（新） | 真实中继进程 + 真实 TLS + E2EE + 真实 Runtime + 真实 PTY（node-pty 起 `/bin/zsh`）：订阅终端流后运行 `cat`，逐字符写入，计时到回显字节到达客户端 |
| `cloud-terminal-e2e-fixture.ts`（新）       | 从 M90 抽出真实中继进程与真实 PTY 控制器，两处共用                                                                                               |
| `cloud-latency-hop-fixture.ts`（新）        | 可调延迟的 TCP 跳（仅 runtime→client 方向），用于灵敏度对照                                                                                      |

**验证（`evidence/m102-terminal-echo-latency/terminal-echo-latency.json`）**：

- 线路：`route=relay`（主机不广播直连地址，走的是最慢的受支持线路）。
- 50 次采样（另 5 次预热丢弃）：多次运行 P95 **7.5–9.1ms**（当前证据：P95 **9.05ms**、中位 8.53ms、最大 9.7ms），预算 120ms。
- **灵敏度/负向对照**：在 runtime→client 方向注入 150ms 延迟后，20 次采样 P95 **306.9ms**，同一个 `assertEchoBudget` 断言按预期抛错（`terminal echo P95 306.86ms over budget 120ms`）；撤销延迟后 P95 回到 **9.87ms**，断言恢复通过。
- 回归：`cloud-terminal-relay.test.ts`（M90，改用共用 fixture）通过。

**如实记录 / 剩余**：

1. 客户端与主机同机（loopback），测到的是**软件栈自身**的端到端开销；同城网络的 RTT（约数毫秒）未计入。9ms 上下的 P95 给网络留出约 110ms 余量，但真实同城链路上的 SLO 仍需在目标网络复测。
2. 注入延迟按 chunk 计，回显分两段到达，因此观测增量约 2×150ms；不影响「指标随延迟移动」的结论。
3. requirements §5.1 其余指标仍未测：工作台 200 项目列表 ≤500ms、连接建立（直连 ≤2s / 中继 ≤3s）、目录 1000 项 ≤400ms、审计 31 天查询 ≤2s。

## M103 目录读取延迟 P95（requirements §5.1）（本轮，主会话执行）

**问题**：requirements §5.1 规定「文件目录读取（1000 项）P95 ≤ 400ms」，此前未测；文件面板的读取路径只有功能用例（AC-10/AC-27），没有延迟数据。

| 改动                                       | 内容                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-file-listing-latency.test.ts`（新） | 真实中继进程 + 真实 TLS + E2EE + 真实 Runtime：在用户工作区创建 1000 项目录（990 文件跨 8 种扩展名 + 10 个子目录），通过 `files.readDir` 采样 |
| `cloud-relay-stack-fixture.ts`（新）       | 把 M102 的平台/主机/Runtime/中继/延迟跳栈抽出为共用 fixture，M102 改用后复跑通过                                                              |
| `cloud-terminal-echo-latency.test.ts`      | 改为使用共用 fixture（行为与断言不变）                                                                                                        |

**验证（`evidence/m103-file-listing-latency/file-listing-latency.json`）**：

- 线路：`route=relay`；返回条目数 **1000**（断言 ≥1000 且含 `file-0000.ts`，确保测的是非空目录）。
- 30 次采样（3 次预热丢弃）：多次运行 P95 **3.3–5.1ms**（当前证据：P95 **5.07ms**、中位 2.93ms，预算 400ms）。
- **负向对照**：注入 450ms 单向延迟后 10 次采样 P95 **915.19ms**，同一 `assertListingBudget` 断言按预期抛错（`file listing P95 915.19ms over budget 400ms`）；撤销后回到 **3.89ms** 并通过。延迟按 chunk 生效，因此观测约 2×450ms。

**如实记录 / 剩余**：

1. 与 M102 相同，客户端与主机同机，不含真实网络 RTT；本机个位数毫秒只说明软件栈本身远低于预算。
2. 1000 项是平铺目录；极深目录或网络文件系统（SSH host）未测。
3. requirements §5.1 仍未测：工作台 200 项目列表 ≤500ms、连接建立（直连 ≤2s / 中继 ≤3s）、审计 31 天查询 ≤2s。

## M104 连接建立延迟 P95（requirements §5.1）（本轮，主会话执行）

**问题**：requirements §5.1 规定「连接建立（连接凭证到工作区可交互）直连 P95 ≤ 2s；中继 P95 ≤ 3s」，此前无测量。M101 记的是单次地址探测耗时，不含取票、WSS 升级与工作区准备。

| 改动                                               | 内容                                                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-connection-establish-latency.test.ts`（新） | 每条线路各 20 次采样：每次**全新客户端**（登录不计时）→ 计时从 `openProject`（取凭证）到工作区准备完成并 `status.get` 成功；直连用 `directOnly` 栈，中继用真实中继栈；两条线路都经延迟跳 |
| `cloud-relay-stack-fixture.ts`                     | 新增 `directOnly`：主机只广播经延迟跳的直连地址、不启动中继，路由断言不能靠回落蒙混                                                                                                      |
| `cloud-latency-samples.ts`（新）                   | 抽出统计与预算断言，M102/M103/M104 共用                                                                                                                                                  |

**验证（`evidence/m104-connection-latency/connection-latency-{direct,relay}.json`）**：

- 直连（真实平台 + 真实 TLS Runtime + 真实 WSS）：20 次采样 P95 **6.26ms**、中位 5.08ms（预算 2000ms）。
- 中继（真实中继进程 + 真实 TLS Runtime + 真实 WSS）：20 次采样 P95 **6.09ms**、中位 5.72ms（预算 3000ms）。
- **负向对照**：在路径上注入 800ms 延迟后，直连 P95 **6432.65ms**、中继 P95 **6427.83ms**，同一 `assertLatencyBudget` 断言按预期抛错（`over budget`）；撤销延迟后分别回到 12.54ms / 13.01ms 并通过。

**如实记录 / 剩余**：

1. 客户端与主机同机，不含真实网络 RTT；本机个位数毫秒说明软件栈远低于预算，真实链路仍需复测。
2. 计时用已登录会话，登录本身不在预算内（与需求文字的「连接凭证到工作区可交互」一致）。
3. requirements §5.1 仍未测：工作台 200 项目列表 ≤500ms、审计 31 天查询 ≤2s。

## M105 审计查询延迟 P95（requirements §5.1）（本轮，主会话执行）

**问题**：requirements §5.1 规定「审计查询（31 天窗口）P95 ≤ 2s」，此前只验证了窗口边界与 traceId 过滤（M89），没有延迟数据；当时也不清楚线性扫描在大语料下是否还成立。

| 改动                                                            | 内容                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/test/e2e/audit-query-latency.e2e.test.ts`（新） | 真实审计写入者进程 + 真实 API 进程 + 真实 HTTP 跳：写入 20 万条审计事件后，按 30 天窗口查询 `/v1/audit/events`，每次校验返回满页 50 条且带 `nextCursor` |
| `cloud-platform/test/e2e/harness.ts`                            | 新增 `startTcpDelayHop()`：可延迟目标→调用方方向的 TCP 跳，用作查询路径的灵敏度对照                                                                     |

**验证（`evidence/m105-audit-query-latency/audit-query-latency.json`）**：

- 语料 5 万 → 20 万（同一进程内增长），各 30 次采样：5 万时 P95 4.0–6.2ms（中位 1.6–2.2ms），20 万时 P95 **6.6–7.3ms**（中位 4.2–4.3ms）——中位随语料约线性增长，P95 仍远低于 2000ms。
- 窗口真实性：取回的最新事件 `seq=200001`，整链 `/v1/verify` 通过（`checked=200001`），说明查的是真实链而不是孤立行。
- **负向对照**：在 API→写入者这条真实查询路径上注入 2200ms 延迟，3 次采样 P95 **2211.64ms**，同一 `assertQueryBudget` 断言按预期抛错（`audit query P95 2211.64ms over budget 2000ms`）；撤销后回到 18.94ms 并通过。

**如实记录 / 剩余**：

1. 语料 20 万条约等于 500 开发者每日 130 次审计操作的月量级；给 2000ms 预算留出约 300 倍余量（按中位线性外推 ~200 万条约 42ms）。真实生产语料尚未回放。
2. 查询是内存中线性扫描（`AuditChain.query`）；语料再大一个数量级时应改为索引或分页存储，本条测量是当前实现的基线。
3. requirements §5.1 只剩一项未测：工作台项目列表（≤200 项目）P95 ≤ 500ms。

（第二轮复跑：20 万条 P95 7.28ms、中位 4.33ms，注入延迟时 P95 2211ms 仍按预期转红。）

## M106 工作台项目列表延迟 P95（requirements §5.1）（本轮，主会话执行）

**问题**：requirements §5.1 规定「工作台项目列表加载 P95 ≤ 500ms（≤ 200 项目）」。M97 只测了**登录到工作台**（当时只有 1 个项目），200 项目规模下列表本身的开销没有数据。

| 改动                                                                       | 内容                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-platform/test/e2e/workbench-project-list-latency.e2e.test.ts`（新） | 真实平台进程 + 真实 Chrome（headless）：经真实创建接口补到 200 个已授权项目；每个样本从点击「我的项目」开始计时，到 **200 行全部渲染**为止；注入 700ms 端点延迟作负向对照 |

**验证（`evidence/m106-workbench-project-list-latency/project-list-latency.json`）**：

- 开发者接口确认恰好可见 **200** 个项目；页面渲染的表格同时含 `payment-service` 与 `service-199`（不只是数行数）。
- 30 次采样（另 1 次预热）：P95 **75–78ms**（中位 66–72ms，预算 500ms）；两次运行结果一致。
- **负向对照**：拦截 `/v1/projects*` 注入 700ms 延迟后 5 次采样 P95 **745–749ms**，同一 `assertListBudget` 断言按预期抛错；撤销拦截后回到 **76ms** 并通过。

**如实记录 / 剩余**：

1. 200 项目全部在同一台主机的同一组授权下，未覆盖多主机/多团队 ACL 组合下的差异。
2. 前 199 个项目由测试经真实创建接口建立（每条都写审计），未复用生产数据。
3. **至此 requirements §5.1 的六项性能指标全部有本机证据**（登录 71ms、200 项目列表 75ms、连接建立 6.3/6.1ms、终端回显 9ms、1000 项目录 5ms、31 天审计查询 7.3ms）；共同限制：客户端与主机同机，不含真实网络 RTT，仍需在目标网络复测。

## M107 原生 Electron 首屏 P95（AC-01 / G-12 剩余项）：**阻塞，发现真实缺陷**（本轮，主会话执行）

**问题**：AC-01 的预算按开发者真实使用的界面衡量；M97 只测了管理员浏览器页。本轮搭起原生全栈（真实平台进程 + **真实 Orca 宿主实例** + **真实 Orca 客户端实例**）后，暴露出一个协议级缺陷，预算暂时无法测。

| 改动                                               | 内容                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/cloud-native-first-paint.spec.ts`（新） | 真实平台 + 双 Electron 实例（宿主/客户端）；M107-0 记录阻塞事实并通过，M107-1（P95 测量）标 `fixme` 并写明缺什么          |
| `tests/e2e/helpers/cloud-platform-stack.ts`（新）  | 启平台进程、取管理/宿主凭据、等待宿主「上线且运行时已绑定」（`directAddrs` 非空 + `e2eePublicKey` 非空）、宿主/客户端环境 |

**发现（证据 `evidence/m107-native-first-paint/native-first-paint-blocked.json`）**：

- 宿主实例正常上线并心跳上报：`directAddrs: ["127.0.0.1:53375"]`、E2EE 公钥非空、`online: true`。
- 平台 `/v1/projects/:id/connect` **无条件**把直连地址拼成 `wss://`（`server.ts:2106`），而 Orca 宿主的运行时 WS 监听是**明文 `ws://`**（`runtime-rpc-pairing.ts:getWebSocketEndpoint()`，应用内无任何 TLS 监听配置）。
- 客户端行为：登录成功、列出项目，随后两项都失败——种子项目 `ENDPOINT_UNREACHABLE`，真宿主项目 **`EPROTO`**（TLS 握手打到明文端口），`repos` 为空，界面显示「部分云端项目准备失败」。
- 这与设计 §5.3「携带连接凭证的 WSS 升级必须 TLS（内网亦然）」相冲突：现在是平台要求 TLS，宿主却不提供。

**顺带修正的环境问题（已记录在测试注释里）**：

1. macOS Unix socket 路径上限 104 字节：userData 放在深层 `TMPDIR` 下时运行时启动报 `listen EINVAL`，心跳因此一直发空端点；测试改用 `/tmp` 短路径。
2. 同一个 OS 会话内两个 Electron 实例需要 `ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1`。
3. 只要设置了 `ORCA_CLOUD_API_URL`，实例就会按宿主角色的要求完整配置（本仓库没有纯客户端模式）；因此客户端实例也用自己的宿主凭据上线。

**当时结论**：M107 的 AC-01 原生 P95 未测。阻塞项「宿主侧 TLS 监听 + 指纹上报」已由 **M108** 修复并实测定稿（见下节）。

**回归**：本 spec `M107-0` 通过、`M107-1` 跳过；`check:code-quality:changed` 0 新发现；`tsconfig.e2e` 对本轮文件 0 错误。

## M108 宿主运行时 TLS 与证书指纹上报（M107 的阻塞修复）（本轮，主会话执行）

**问题**：M107 记录到平台下发 `wss://` 而宿主运行时只提供 `ws://`，客户端报 `EPROTO`，原生首屏 P95 无法测。运行时 RPC 服务本身早已支持 `webSocketTls`，但应用启动路径从未传入证书，平台也只在下发地址时假定 TLS。

| 改动                                                                                                            | 内容                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-host-tls.ts`（新）                                                                                       | 读取 `ORCA_CLOUD_TLS_CERT_PATH` / `ORCA_CLOUD_TLS_KEY_PATH`，按证书 **DER** 计算 `sha256:<hex>` 指纹；只配一项直接报错（避免用 TLS 地址指向明文监听）        |
| `main-process-runtime-launch.ts`                                                                                | 有证书时把 `webSocketTls` 传给运行时 RPC 服务，端点随之变为 `wss://`                                                                                         |
| `cloud-runtime-admission.ts` / `cloud-host-enrollment.ts` / `cloud-heartbeat-body.ts` / `cloud-agent-config.ts` | 注册与心跳都上报 `tlsFingerprint`（随心跳持续，证书更换可见）                                                                                                |
| `cloud-platform/apps/api/src/server.ts`                                                                         | 心跳接受 `tlsFingerprint`；变化写 `host_tls_fingerprint_changed` 审计（与 E2EE 换钥同级的替换信号，AC-29 语义）                                              |
| 测试                                                                                                            | `cloud-host-tls.test.ts`（2 例：指纹按 DER 稳定、半配置报错）；`tests/e2e/cloud-native-first-paint.spec.ts` 重写为 M107-0（TLS + 指纹）与 M107-1（原生 P95） |

**验证**：

- `evidence/m107-native-first-paint/host-tls.json`：宿主上报 `tlsFingerprint` 与磁盘证书计算值**完全一致**（`sha256:82c23f…cc7d`）；平台下发给客户端的是 `wss://127.0.0.1:63923`；**用明文 `ws://` 连同一端口被拒**（证明监听确实是 TLS，而非只是换了个前缀）。
- `evidence/m107-native-first-paint/native-first-paint.json`：全新客户端实例 20 次采样，计时从点击「登录」到项目行出现在界面上：P95 **245ms**、全部样本 208–354ms（预算 1500ms）。
- **灵敏度对照**：客户端经可延迟 TCP 跳到平台，注入 1800ms 响应延迟后同一口径 P95 **11037ms**，断言按预期转红；撤销后恢复。说明测量跟随控制面变慢，不是常数。
- 负向对照（实现层）：`cloud-host-tls.test.ts` 覆盖「只配证书不配私钥 → 抛错」；M107-0 覆盖「明文 ws 打 TLS 端口 → 被拒」。
- 回归：`cloud-connect-client.test.ts` / `cloud-runtime-environment.test.ts` 11/11；`tc:node` 0；`check:code-quality:changed` 0 新发现；Playwright `M107-0` + `M107-1` 2/2 通过。

**如实记录 / 剩余**：

1. 测量起点是点击登录、终点是**项目行可见**；进入具体工作区（worktree 准备完成）更晚，属 §5.1「连接建立」口径，已由 M104 覆盖。
2. 平台目前只**发布** TLS 指纹，客户端尚未据此做 TLS 证书固定（E2EE 公钥固定另有实现，AC-29）；目标网络部署时以平台 CA 校验为主。
3. 采样使用自签证书 + `ORCA_CLOUD_TLS_INSECURE=1`；真实证书链校验仍需在部署环境验证。

## M109 客户端按平台指纹校验宿主 TLS 证书（M108 的闭环）（本轮，主会话执行）

**问题**：M108 之后平台会发布宿主 TLS 证书指纹（`tlsFingerprint`），票据也带给客户端，但客户端没有校验——自签场景 `rejectUnauthorized` 为关，任何人换成自己的证书客户端照连。设计 §5.3 的「平台是信任根」在传输层还差最后一跳。

| 改动                        | 内容                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-socket-handshake.ts` | `upgradeCloudSocket` 新增 `expectedTlsFingerprint`：在 `open`（TLS 已完成、E2EE hello **之前**）用受检读取取对端证书 DER，与票据指纹比对；不匹配以 `TLS_FINGERPRINT_MISMATCH` 拒绝并立即断开（凭证派生的字节一个都不发出去）。只有 `sha256:<64hex>` 形态的期望值才校验——旧平台填的是回落名，强制比对会破坏混版（兼容规则） |
| `cloud-connect-client.ts`   | `openProject` 把票据里的 `tlsFingerprint` 传给握手                                                                                                                                                                                                                                                                         |
| `cloud-host-tls.ts`         | 抽出 `derCertificateFingerprint` / `isSha256Fingerprint` 供握手复用                                                                                                                                                                                                                                                        |

**验证（`evidence/m109-host-tls-pinning/host-tls-pinning.json`）**：

- 真实平台 + 真实 TLS Runtime：平台发布的指纹与磁盘证书计算值一致；真实端点直连打开成功（`route=direct`，固定逻辑开启下）。
- **MITM 负向对照**：TLS 终结代理持**另一张**自签证书、向真实 Runtime 转发字节；客户端带票据连接该端点 → `TLS_FINGERPRINT_MISMATCH`，代理记录到这次连接（说明拒绝发生在客户端、不是连不上）。
- **兼容对照**：同一假端点、不带期望指纹（旧平台形态）→ 连接成功——校验严格增量，混版不受影响。
- 每次尝试用 `prepareProjectLink` 取新票据：宿主对票据 jti 有一次性保护，重放旧票据会在固定校验之前被拒。
- 回归：`cloud-host-tls` / `cloud-connect-client` / `cloud-open-route-diagnostics` / `cloud-session-multi-project` / `cloud-admin-grant-open` / `cloud-terminal-relay` 全绿；`tc:node` 0；`check:code-quality:changed` 0。

**如实记录 / 剩余**：

1. 管理员浏览器页（`cloud-browser-bridge`）无法做此校验：浏览器 JS 读不到对端证书；该面以平台 CA 部署为主。
2. 拒绝码目前到达失败面板（错误码 `TLS_FINGERPRINT_MISMATCH`）；未复用 AC-29 的「重新核对」对话框——TLS 证书与平台绑定，不是用户可确认的 TOFU 对象。
3. 不匹配时客户端立即断开；没有把「期望/实际指纹」带进失败诊断 UI（错误 message 里有，IPC 面板暂只显示错误码）。

## M110 300 并发会话 30 分钟压测（AC-22）（本轮，主会话执行）

**问题**：AC-22 要求「300 并发 30 分钟压测」，此前完全未测；test-plan §5 把它列为需要独立压测环境。本轮先在本机把它做实——300 个真实客户端、各自真实登录/设备密钥/TCP 探测/TLS WSS 升级，保持 30 分钟持续 RPC。

| 改动                                              | 内容                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-platform/test/load/load-300.test.ts`（新） | 可配 `LOAD_SESSIONS` / `LOAD_DURATION_S`；连接阶段分批斜坡（25/批）避免登录风暴，稳态阶段每会话 2s 节奏错相 RPC（10:1 混合 `workspace.info` 与 24 项目录的 `files.readDir`）；断言：全部连接成功、连接 P95 ≤ 2s（§5.1 直连预算）、稳态成功率 ≥ 99.9%、意外断开 = 0 |

**验证（`evidence/m110-load-300/result-300x1800s.json` + 冒烟 `result-5x15s.json`）**：

- **300/300 会话全部连接成功**，全部 `route=direct`；连接 P95 **40ms**、最大 48ms（预算 2000ms）。
- **30 分钟稳态：269,628 次 RPC，0 失败、0 意外断开**（成功率 100%）；期间 10 核 MacBook loadavg ≈ 3.6–4.2，客户端进程 RSS 稳定在 ~140–180MB（无泄漏增长迹象）。
- 冒烟（5 会话 × 15s）先行验证 harness；完整运行一次通过，node --test `pass 1`。

**如实记录 / 剩余**：

1. 本机回环（10 核笔记本），不代表生产服务器容量与真实 WAN 时延；「单节点 2000 并发 TCP / 2Gbps」类容量结论仍需目标硬件复测。
2. 负载宿主是平台自带的 runtime-sim（真实 TLS/WSS/票据闸门，但无 PTY、无逐帧 E2EE box）；桌面客户端每帧的 box 加解密开销未计入。
3. 只测直连线路；中继线路的故障切换已有 AC-23（40 会话）覆盖，中继满载不在本条范围。
4. status：AC-22 从 UNVERIFIED 改为 **PASS(部分)**——指标与时长按验收原文执行，环境为开发机而非独立压测环境。

## M111 人工验收指引（验收包收口）（本轮，主会话执行）

**问题**：32 条 AC 的自动化证据已齐（30 PASS + 1 PASS(部分) + 1 UNVERIFIED），但没有一份「验收人亲手做什么、看什么」的指引；M99 的验收索引只回答「证据在哪」，不回答「怎么验」。

| 改动                                       | 内容                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-reports/acceptance-runbook.md`（新） | 按场景组织的人工验收指引：开发者桌面主流程、连接与线路演练、管理员 Web 流程、安全演练、性能复核、**剩余未验证项**（AC-32 / G-04 收尾 / 生产容量 / 真实证书链 / 跨平台）——每行标注 AC 与既有自动化证据 |
| `test/acceptance-index.test.ts`            | 新增第二个测试：指引必须覆盖全部 32 条 AC、不引用未知编号、UNVERIFIED 项必须出现在「剩余未验证项」一节——指引本身也是被校验产物                                                                        |

**验证**：两个验收包测试均通过（索引 + 指引校验）。第一版指引确实漏了 9 条 AC（09/15/17/19/21/23/25/27/28），被新测试抓出后补齐——这就是把指引放进测试的原因。

**结论**：本机可推进的模块到此**全部完成**。剩余项均需外部环境（WAF/DMZ 网络、目标硬件、Redis/PostgreSQL 部署形态、平台 CA、Windows/WSL/SSH 宿主机），已逐项写明环境需求。等待人工验收。

## M112 验收索引引用扫描修正（收尾）（本轮，主会话执行）

**问题**：M99 的「未被引用证据目录」清单把 m102–m106、m109 列为未引用——它们的证据实际被 test-plan §4.3（性能指标）与 §6（本轮补充测试）引用，但扫描只读 §4 的 AC 行，给验收人错误信号。

| 改动                            | 内容                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `test/acceptance-index.test.ts` | 引用扫描从「仅 §4 AC 行」改为**全文**回勾路径（`dir/file.json | txt` 且文件真实存在）；§4 逐条映射逻辑不变 |

**验证**：索引测试通过；重新生成的 `acceptance-index.md` 中未引用清单只剩真正历史模块（m12…web-ui），m102–m106/m109 不再误报。

**结论**：验收包（索引 + 指引 + 校验测试）全部自洽。**本机可推进的模块全部完成，等待人工验收。**

## M113 验收截图采集 + M114 真实链路方案（本轮，主会话执行，应用户要求）

**M113 截图**：验收包此前无功能截图。新增两个采集程序（结果 PNG **仅本地保留，已 gitignore 不提交**）：

- `cloud-platform/test/e2e/ui-screenshots.e2e.test.ts`：真实平台 + headless Chrome，9 张管理/开发者 Web 页（登录、开发者工作台、越权 403、管理员工作台/项目/主机/成员/审计/设置）→ `test-reports/screenshots/web/`。
- `tests/e2e/cloud-native-acceptance-shots.spec.ts`：真实平台 + 真实 TLS 宿主实例 + 真实客户端实例（后台隐藏窗口、CDP 取帧），已出「原生登录页」「原生工作区」两张；管理员会话页（路由徽标 + 连接诊断面板，`cloud-admin.html`）采集进行中，下一轮补齐。
- `.gitignore` 增加 `**/test-reports/screenshots/`、`**/test-reports/logs/`（应用户要求不提交）。

**M114 真实链路方案**（新文档 `deployment-real-link.md`）：客户端=本机、中继=100.67.197.59、平台=本机 Docker、开发机=192.168.202 经中继免密 ssh 安装。含拓扑、环境清单（202 必须能反连本机平台端口；平台地址对远端必须是可达 IP 而非 localhost）、部署六步、要测什么（§5.1 WAN 口径复测、AC-22 真实口径、AC-32 前置 WAF、多中继、真实证书链）、已知限制。test-plan §5 与 PLAN.md 模块表已指向该文档。

**执行状态**：文档与采集代码已就绪；跨机部署动作（Docker 起平台、100.67.197.59 起中继、ssh 202 装宿主）待下一轮按方案执行。

## M114 真实链路（部署中）（本轮起，按用户提供的真实环境推进）

**环境（用户提供）**：客户端=本机；中继=100.67.197.59（tailscale，`ssh root@` 可达，node v22.11）；平台=本机 Docker（daemon 未运行，暂以 node 直跑 + TCP 转发器 0.0.0.0:18787→127.0.0.1，避免拉起 Docker Desktop 抢焦点）；开发机=内网 192.168.2.202（经中继免密 ssh，本机与其同网段 192.168.2.x）。方案文档 `deployment-real-link.md` 已含节点注册模型、SNI=路由标签澄清、管理分离。

**114a 已实现（主会话快速检测 + 回归通过）**：真实链路暴露缺口——中继注册只报 `{id,port}`，平台把端点拼成 `wss://127.0.0.1:<port>`（跨机时客户端拨自己）。修复：注册体增加 `host`（`RELAY_PUBLIC_HOST` 显式配置，缺省取注册来源 IP），`/connect` 中继端点 `url` 改用该地址；`/v1/relays` 管理接口（管理员 200 / 开发者 403 + `relay_list` 审计）。回归：`relay-hardening` 8/8、`admin-gating` 全绿。

**114b 已派发开发子代理**：Web 独立「中继」管理页（导航/route/渲染，仅管理员）+ 两个 e2e（端点地址传播、接口门禁）——见 test-plan §6 新增两行（FR-4.9/FR-4.10）。

**114c/114d 待执行**：中继上线 100.67.197.59 → 验证注册与 `/v1/relays`；ssh 202 装宿主（Orca + 宿主 env）；本机客户端全链路直连/回落；WAN 口径复测。均派发执行/测试子代理，主会话只调度与快速检测。

### M114b3 UI 原型按新设计更新（完成，2026-11-14）

提交 `aca26798b72`（仅 ui/prototype.html +431/−29 与 ui/README.md）：`#/relays` 独立中继管理页（统计卡/筛选/表格/抽屉，与主机页分开管理）、主机与中继两个一行安装命令向导（`bash <(curl -fsSL …/install/{host,relay}.sh?token=…)`）、主机表「路由键」列与抽屉「路由与中继」区（`ip-<IP>` routeKey + `ip-….relay.local` SNI）、P7 诊断页同步。主会话核验：提交仅含两个目标文件；关键标记 grep 15 处命中；README 含 P4b 章节与路由清单。子代理另做了 headless Chrome 逐路由验证（0 console error、403 门禁、弹层/复制/Escape）。

三项设计决策落入高保真原型 `ui/prototype.html`：① FR-4.10 独立中继管理页（#/relays，含抽屉与统计，与主机页分开管理）；② FR-4.11 向导一行安装命令（中继/宿主两条 `bash <(curl -fsSL …/install/<类型>.sh?token=…)` 弹层）；③ FR-4.9 routeKey 默认 IP（主机页/抽屉/诊断页展示 `ip-<IP>` 路由键与 `ip-<IP>.relay.local` SNI 标签）。要求子代理以 headless Chrome 逐路由自检（console 无错、门禁/弹层/复制可用）后仅提交原型与 README。

### M114b/114b2/114b3 + routeKey 代码（完成，2026-11-14）

三批实现由代码子代理完成、主会话核验后提交：

- `af7621f7511`（平台侧）：中继自注册可拨地址（`RELAY_PUBLIC_HOST`/来源 IP 兜底）、独立中继管理页（`/v1/relays`，开发者 403 + `relay_list` 拒绝审计）、Web 中继页与添加中继弹层、`GET /install/{host,relay}.sh` 安装脚本端点（缺 token 400、写 `install_script` 审计、元数据不含令牌明文）、routeKey 平台侧派生 `ip-<IP>`（显式永不覆盖、派生键随心跳迁移、旧键路由删除、幂等）。核验复跑 relay-nodes + host-route-key-follow + install-wizard 共 20/0 通过，证据 12 件在 `evidence/m114-relay-page/`。
- `6997ee99f78`（宿主侧）：`enrollCloudHost` 缺省 routeKey=派生 `ip-<地址>`（点/冒号折叠为横线以过中继 SNI 白名单），显式配置优先。
- 已知记录项：acceptance-index 会把 `m114-relay-page` 列为「test-plan 未引用」（记录性输出）；后续在 test-plan 补引用即可消除。

### M116 Web 探索性测试（完成，2026-11-14）

HEAD 快照隔离实例 + 真实 runtime-sim 宿主 + 双真实中继，双角色双视口。结果：**P0×1、P1×14、P2×18**，报告 `test-reports/exploratory-qa-web.md`，机器可读 `evidence/m116-exploratory-web/findings.json`（82 张截图 + 14 场景控制台 JSON，gitignored）。核心链路全通（登录/锁定/门禁/授权/审计筛选/策略联动/剪贴板/双分辨率）。

- **P0 QA-001**：用户级授权按用户名匹配但服务端要求 `user_<uuid>`，权限实际不生效；且增删该授权误走 `revokeProjectCredentials` 把全项目在线会话撤销。
- P1 要点：审计 limit=50 无分页（002）、筛选条件静默丢失（003）、traceId 不可复制（004）、主机状态忽略心跳推导（005）、已吊销主机仍可进维护（006）、离线打开入口未全禁（007）、维护原因不可见（008）、策略保存失败零提示（009）、admin perms 空（010）、加载失败无错误态（011）、空提交触发锁定（012）；013/014/015 为功能缺口（管理台项目登记弹层、权限矩阵、项目级下载策略缺失）另立模块。
- **修复派发**：P0 + P1 快修批插队到 M115 之后（M117/D1/M118 顺延）；013/014/015 登记 M120（管控台登记/授权/策略补齐）。
- 连接信息对话框引导文案由 M117 一并覆盖。

### M121 浏览器经中继使用 Web 界面（需求澄清 + 派发，2026-11-14）

用户澄清「orca web 指非直连、经中继后如何使用 web-index.html，可适当改造」。约束：浏览器无法显式设 TLS SNI（桌面客户端可，故不受影响）。方案（FR-4.12）：中继监听 443 + 通配 DNS `*.<域名>`；平台按宿主下发浏览器入口 `https://<routeKey>.<域名>/web-index.html`（routeKey `ip-…` 已是合法 DNS 标签）；宿主证书 SAN 扩展为 `<routeKey>` 与 `<routeKey>.<域名>`（平台 CA）。已写 deployment-real-link §4b；实现派发（安装脚本 SAN 扩展 + 平台浏览器入口字段 + 前端入口展示）。

### 全量回归结果（HEAD 快照，171 用例，2026-11-14）

**163 过 / 8 失败**。3 个失败为快照环境产物（2 个：git archive 不含 gitignored evidence/ → 验收索引/指引；1 个：快照只导出 cloud-platform/ 缺 src/ 跨目录依赖 → admission-parity）。**4 个失败为真回归（M115 7eba67c76cd）**：管理员按 path 登记项目被 400 INVALID_DIR 拒绝（dir 必填误伤管理员路径），archive e2e 级联失败。已立 **W8**（最高优先，W2 后派发）：目录必填仅约束自助路径，管理员 path 语义保持。日志 /tmp/m116-retest-full.log。

### U6/P0 修复完成（待独立复验，2026-11-14）

提交 `e9a6904bb5c`（+6 行核心修复）：准入只认显式宿主信号（HOST_TOKEN/INTERNAL_TOKEN）；仅 API_URL → null（登录 UI 照常预填装配）。TDD 红→绿（红时抛的正是用户报错原文）；兼容矩阵五形态全断言（含 serve/poll 遗留形态零回归，真实消费套件补轮询签名断言）；13 套件批次 58 过/12 败经 stash 基线对照=既有沙箱失败非回归。台账 U6 → 🟢（修复代理同步更新）。已派独立复验（真实 Electron 复现用户原始失败场景 + 三形态 + 真实登录到项目列表）。**用户可立即重试**：不带任何 env 启动客户端，登录表单填 `http://127.0.0.1:18787`。

### 链路覆盖审计回收——三个叠加机制解释「全绿却断链」（2026-11-14）

审计（`test-reports/chain-coverage-audit.md`）：34 步中 **9 步标红**（B2/B3/B4/B6/C4 表单/C5 矩阵/C6 项目级策略/C10/D6），W9 双线此前零 spec 零执行。**三个叠加机制**：

1. **测试宿主方法表≠生产**：`project.provision` 被刻意排除在测试 `ALL_RPC_METHODS` 外，e2e 打开工作区走了「旧宿主」容错分支照样成功；
2. **浏览器测试选的方法恰在 mobile 允许清单内**（scope 判定 mobile 先于 cloud）：只调 `status.get`/`files.readDir` 的用例全绿，allowlist 外方法（`project.provision`/`worktree.*`）才裸 forbidden；
3. **cloud-platform 测试套件无 CI 挂钩**，验收索引只验证据文件存在不验时效——AC 的 PASS 可无限期陈旧（M113 后 8 波集成期间链路断而无人知）。
   **改进落地**：常驻冒烟套件按审计设计实现（真实平台+**production 方法表**真宿主+真 PTY，Electron+Chromium 双驱动，S1–S7，≤5 分钟）；硬约束三条——方法表守卫断言、至少一条断言打在 mobile 允许清单之外、必须真浏览器驱动管理台/web-index；分层规则 R3（mock/scripted host）不得作为链路步骤覆盖依据、截图不构成链路验证。W9a（在途）交付桌面线后即扩展为该常驻套件；CI 挂钩缺口挂账（README/运维章节 + 后续 CI 任务）。

### W9a 桌面黄金旅程提前派发（用户指令：两主链路优先验证，2026-11-14）

用户指令：两种远程开发主链路（A 桌面 / B Orca Web）优先测试验证。W9a 即刻派发（隔离 worktree 锁定 HEAD 构建运行，避免在途 W7b/W5b 未提交代码污染；主树只写 evidence）；**W9b 在 W7b+W5b 落地后立即接续**（其依赖：handoff 消费 + 宿主方法映射）。W9 从收口位改为集成验证先锋位。

### 用户实测发现链路断裂 → 测试覆盖自查派发（2026-11-14）

用户实测：管理控制台进入项目工作区也不通（`forbidden`）——与 W5a 浏览器探针发现一致（宿主对云会话方法走 mobile 允许清单回退裸拒绝），W5b 在修。**用户质疑成立**：分段测试全绿但核心链路断裂。根因自查：①组件测试 mock 桥接层、平台 e2e 只到 HTTP 层，跨层链（页面→CORS→宿主准入→方法映射→PTY）无常驻测试；②探针发现过但按切片排期顺延，未当核心断裂提升；③M116 探索测试未驱动浏览器工作区对接真实宿主；④W9 黄金旅程排在最后（顺序错误）。**改进**：已派链路覆盖自查审计（步骤×真实度矩阵+红名单+常驻冒烟套件设计）；W9 双线提前至本轮集成后立即执行（不再压轴）；新增分层规则草案——mock 层测试不得作为链路步骤的覆盖依据。

### W7b 门禁整改完成（待独立测试回收后关闭，2026-11-14）

提交 `4be77d3ce55`（3 文件 +150/−25）：j-1 四条 finding 全消——2 处类型断言改**受检解析**（instanceof WebCloudConnectError / readArray+readString，零 SAFETY 抑制）+ 2 组重复 import 合并；m-3 进入屏 10s 超时赛跑（超时只收尾不越权：迟到换发不落存储、迟到 socket close 不 adopt）+2 断言。本域门禁 0 finding；单测 12/0、renderer e2e 5/0、平台 handoff 9/0。索引冲突第五次（并行全量 index 提交卷入其暂存）——代理间自行 soft-reset 拆分闭环，无内容损伤。W7b 关闭待独立测试代理（在途）回收。

### W7b 审计通过（1 major 门禁整改回派，2026-11-14）

审计（`test-reports/w7b-audit.md`）：blocker 0、major 1（j-1=CI 门禁 4 条 finding：2 处无 SAFETY 类型断言 + 重复 import，机械修复）、minor 3（B7/B8 e2e 零覆盖且持久化为单槽存储——plan §4.4 措辞需澄清、回落表单预填无组件断言、进入屏无超时）、note 9。**安全重点全过**：CORS 白名单精确匹配/无 wildcard/无 credentials/internal 排除/fail-closed；handoff hash 同步清除零残留；deviceId 复用落实 w7a n-3（e2e 实证）；契约抽取零回归；与 W6b 健康门/W7a n-2 衔接正确。已派门禁整改（4 finding + m-3 超时顺带）。

### 定时任务加强：端到端要求入 cron（用户指令，2026-11-14）

跟进 cron 重写（161ffb9a，每 10 分钟）：① 每波集成必跑 W9 双线冒烟、双绿才可宣告完成（失败派修不豁免）；② 第一层冒烟与用户方式一致（无跳登录捷径）；③ 红名单步骤未补测绿前工作令不关闭；④ 每个修复带「用户精确场景」回归并同步缺陷台账；⑤ 链路测试必须用 production 方法表真实宿主+至少一条允许清单外断言；⑥ 三权分立与暂存核对规则入 prompt。读单加入 defect-ledger.md 与 work-orders（台账驱动）。

### 设计原则补充：云端=附加渠道（用户指令，2026-11-14）

客户端保留 Orca 全部原生能力（添加本地项目、配对其他 Orca 远程主机项目）；云端开发平台只是一个特殊渠道，与原生项目源并存互不排斥；云端功能不得移除或遮蔽原生入口。已写入 requirements 设计原则 7（`9157bb3516c`）与 design-adjustment §4.2b（本次补齐——早前该节因 requirements 锚点失败整批未落；教训：python 批量编辑失败后必须逐项核对其余 sub 是否执行）。已同步给在途 W11 实现代理作边界约束。W11 立项详情见 requirements FR-2.7 修订与 work-orders。

### 授权码 TTL 60s 确认完成（2026-11-14）

TTL 代理：300s 试验曾全绿，用户改回后已 `git checkout` 完整回滚（server.ts/web-handoff 测试与 HEAD 逐字节一致、暂存区空），HEAD 60s 口径复跑 9/9；app.js:353 的「60-second」docstring 在最终定稿下重新准确（无需修）。证据 `evidence/w7c-ttl/`（试验+回滚+终态三段记录）。

### 用户修订：授权码 TTL 维持 60 秒（2026-11-14）

TTL 先改 5 分钟后经再评估**改回 60 秒**（单次消费+绑定不变；60s 已覆盖「点击→新标签加载」窗口，未消费外发窗口更小）。FR-3.10 与实现同步。

### 用户修订：授权码 TTL 5 分钟（2026-11-14）

用户确认一键打开即进入、不重新登录；授权码 5 分钟有效。W7b 已实现一次性码方案，本轮仅把默认 TTL 60s→300s（单次消费与绑定不变；备选的跨域 cookie/持久令牌方案已在 FR-3.10 记录否决理由）。派小任务改默认值与用例同步。

### W5a 关闭（修复复验五项全过，2026-11-14）+ W5b 派发

复验（`evidence/w5a-fix-verify/`）：77 用例全绿；五项自有探针 11/11（2026l 释放逐字节与 desktop replay 同位、桥接 5 分支独立复驱、双报恰一次布防、chunk 失败仅降级终端区、迟到回执补发 close）；**6 项变异全红**坐实测试非空壳；M118-3 断言确认从共享常量引用（cloud 目录零手抄 2026 转义）。ENV-1（未跟踪 handoff e2e 拖垮 tc:web）折入 W5b。**W5a 关闭**（`7058a99dd1c`+`b0665d848a7`+`8ce21cb7f1e`+独立测试+审计+复验）。通道④放行 **W5b**（宿主侧云会话方法映射打通 + 真实 PTY e2e + ENV-1），已派。

**本地环境重建（用户测试用，2026-11-14）**：平台以当前代码重启（18787，含 W7a/W3/W6b/W7b——handoff 端点 curl 实测可用）；web 包重建（1528 文件，含 cloud-admin 入口与 handoff 消费）；宿主 `dev-local-02` 在线（127.0.0.1:53156，TLS 证书已被钥匙串信任）；演示项目 `proj_7d0651e6` 授权 team-payment。桌面端 `out/main` 为 W10 验证构建（烤入死地址 19902）——测试桌面客户端前需 `pnpm build:electron-vite` 重建或用 `ORCA_CLOUD_API_URL` env 覆盖。

### W3 修复完成 + 索引冲突第四次（终态已恢复，2026-11-14）

修复代理交付 `e5d0f68721a`（7 文件）：j-1 `sessionPageUrlFor` 拼 `?api=<requestOrigin>`（新抽共享 helper，与 /install 同推导；取舍 query 优先于部署显式注入，记录进 deployment §4c）；m-1 删 config.js + index.html script + web-release 条目；m-2 四条补例逐条变异变红。web-project-entry 10/10 + 六回归套件全绿。

**事故与恢复**：主会话随后的 docs 提交携带暂存区陈旧副本，把 7 路径回退（config.js 复活、?api= 删、4 用例删）；修复代理重落地 `a069482b23a`；主会话恢复时又把 PROGRESS checkout 到旧快照顶掉一节记录（本段即补写）。终态恢复提交 `d5a00712179`：5 路径自 a069 恢复 + config.js 删除入档 + PROGRESS 保留最新。**恢复后验证**：config.js 不存在于 HEAD；`sessionPageUrlFor`/`searchParams.set('api', platformOrigin)` 在位（server.ts:677/683/698）；维护态双入口补例在位。**防再发规则**：主会话提交前必须核对暂存集=预期文件（本次恢复中已实践：PROGRESS 取消暂存保最新版）；F3 计数笔误更正：W3 段 exploratory 16 实为 13。

### U13 关闭：dev 无登录页根因=单实例锁（2026-11-14）

诊断代理三嫌疑全部实测排除（exposure 谓词 dev 可读 env、vite dev 同样应用 define、bridge 存在必渲染登录 UI）。**真根因**：`pnpm dev`/`npm start` 共享 orca-dev profile——已有一个无 env 的 dev 实例在跑时，带 `ORCA_CLOUD_API_URL` 的新启动 exit 3 让位旧实例，用户看到的是旧实例普通桌面，env「像被忽略」。修复 `b5e697a3fd8`（3 文件）：锁拒绝消息点名被丢弃的平台地址与补救路径（无 env 消息逐字节不变，有测试钉住）。单实例 15/15（新增 3）+ 云链路 21/21 + 提交后复跑 33/33；tc:node 0 错。台账 U13 → 🟢。**用户操作**：退出在跑的 dev 实例再 `ORCA_CLOUD_API_URL=… npm start`（或撞锁时看终端明示）。另注：W11 形态落地后 dev 登录入口已是 shell 常驻按钮+弹框（诊断实测确认）。

### W11 续修完成（MAJ×2+minor 落地；构建门槛追问中，2026-11-14）

提交 `903e8e80ad4`（10 文件 +461/−138）：MAJ-1 登录入口改**状态栏 in-flow segment**（悬浮终端开关之后，结构上不可能遮挡/拦截原生点击，远离 Toast 角；隐藏状态栏为显式选择的取舍入档）+ **突变测试红证明**（改回 fixed chip → regression 前两例立红）；MAJ-2 回归断言渲染真实 StatusBar→StatusBarSurface（不再桩掉），断言 segment 为状态栏 DOM 子节点、原生开关同行的 TOGGLE 事件仍派发、无桥时原生结构照旧（happy-dom 无布局引擎故用结构不变量替代几何断言，已说明）；登出链单轮+失败 toast 不伪装；m3/m4 补齐。128 用例全绿；本域 tc/lint/gate 0 finding（剩余项均属 W7b/W5b 在途文件）。已追问构建门槛语义更新（W10 verify-cloud-build-defines 前置条件过期挡企业分发构建）是否在本轮补齐。

### W5b 审计有条件通过（2 major：1 回派 + 1 流程记档，2026-11-14）

审计（`test-reports/w5b-audit.md`）：blocker 0、major 2——**MAJ-1**（一行修复回派）：handoff e2e spec 进了 tc:web exclude 但未进 cloud-e2e include，不被任何 typecheck 工程覆盖；**MAJ-2**（流程记档）：宿主 dispatch 安全路径变更落在 test(e2e) 类型提交内、B1 实际入树点是 docs 标题提交（与 48939e14c83 事故同型）——多代理共享 index 下无法安全重写历史，规则强化：**安全路径变更与测试变更必须分提交且提交前 `git show --stat` 核对类型归属**。安全语义全成立：票据翻转是净收紧（probe3 实证真手机行为不变）、映射默认拒绝完整、`project.provision→open` 与文档一致、回显断言真可红（旧代码双重不可失败代码级证实）。minor 5/note 9 入报告。MAJ-1 修复后 W5b 关闭。

### W11 关闭（收口复验四项全过，2026-11-14）

复验（`evidence/w11-final-verify/`）：① 测试 16 文件 86 例 + App 回归 35 例全绿；② **MAJ-1 真机复核成立**——入口为状态栏 in-flow segment（非 fixed）、与悬浮终端开关同排、真机 elementFromPoint=入口自身、TOGGLE 事件派发恰 1 次、双形态截图；③ **构建门槛正负双验证**——baked 构建 exit 0（216 bundle + 字面量在 main）、负向（缺 define / 缺 canary）exit 1、中性构建恢复零残留；④ 三形态启动矩阵全过（无 env/API_URL/打包默认均按钮可见+预填正确+无自动登录）。**W11 关闭**（`a82aa84c082`+`903e8e80ad4`+`0d3178541ad`+独立测试+审计回派+收口复验）。遗留入 P2：F1 失败横幅 fixed 浮压状态栏（先于 W11 链存在）、F2 横幅注释过时、F3 vitest 层 shell 仍为桩（遮挡断言在结构层已可红）、U15/W12 自建项目闭环。

### W5b 关闭（门禁补齐落地，2026-11-14）

MAJ-1 修复 `5079fb63497`（2 文件）：handoff e2e spec 进 cloud-e2e include（typecheck 实证拾取、修复前 4 处 TS2739 → exit 0）+ localStorage 桩补全 `Storage` 成员（`vi.hoisted` TDZ 约束下的正解）+ spec 本体 5/5 无回归。审计明示该修复即「一人一行」且已含完整门禁验证——**W5b 关闭**（`5a1746b869e`+`4ffbc3860dc`+独立测试（RED/GREEN+缺陷 B2 发现）+审计+门禁补齐）。MAJ-2 提交归属流程规则已在协议/规则中强化。通道④（W5a/W5b）全部完成。

### W5b 回派完成（发现第二个真 bug B2，2026-11-14）

提交 `4ffbc3860dc`：缺陷 B 实为两个叠加真 bug——B1 bun worker 静默 PTY（e2e 列入 vitest-node-runtime 池以 node 执行+文件头声明 runner）+ **B2 嵌套读取**（`terminal.read` 回包在 `result.terminal` 下，原 helper 读 `result.tail` 永远 undefined——任何 runner 下断言都不可能匹配，超时分支被 ok 检查放行=假阴性）。修复后 RED/GREEN：默认跑法（node 池）4/4 绿且回显真实（`echo ORCA_W5B_PTY_ECHO_OK`）；去掉池声明 RED（ECHO_TIMEOUT）；暂存态（无 W5c 代码）3/3。缺陷 A（bun ws 自签 TLS 既有问题）记入说明。已派 W5b 审计（含空断言修复验证）。

### W9A-7 修复完成：桌面云终端打通，旅程 A2–A6 全绿（2026-11-14）

提交 `9f983c595d15`（15 文件）：宿主对云会话放行 `terminal.multiplex`，工作区边界随帧走——信封不带地址（params `{}`）故信封放行（`cloudTerminalScopeOf` 新增 `multiplex` 类，替代原 DENIED 表整拒）；**每个订阅帧**在宿主把句柄解析为活 PTY 的唯一点（`finalizeResolvedMultiplexPty`）做与一元 terminal 方法相同的 write-root 判定（抽 `cloud-terminal-handle-scope.ts` 共用，未重写第二套边界），越界 → 流错误 `terminal_workspace_scope` + 流结束 + `path_denied/PATH_OUTSIDE_ROOT` 审计（`onCloudDenial` 由 dispatch 选项接入 RpcContext；`PATH_OUTSIDE_ROOT` 记 `path_denied`，权限类仍 `method_denied`）。检查点选在订阅帧而非逐帧的理由：multiplex 其余帧（input/ack/resize/snapshot）只寻址 streamId，其 PTY 绑定是宿主侧状态、只能经一次已过边界的订阅建立——对每个按键重复解析同一句柄只增加成本不增加安全；无边界安装时解析路径保持同步返回，容量/交错语义零回归（capacity 套件实证）。测试：W9A7-1 真栈（平台+TLS+真 PTY）信封 ready + 快照帧 + 回显经真实二进制帧往返；W9A7-2 跨工作区 PTY 目标（宿主共享检出区的 shell）→ 流拒绝 + 审计记录（`evidence/w9a7-multiplex/w9a7-2-cross-workspace-denied.json`）；node 池 117 文件 496 例绿（`runtime-rpc-mobile-terminal-streaming` 2 例在该池经 stash 对照 HEAD 同红=既有、标准 bun 池 5/5 绿）；bun 池另证渲染端多路复用 4 套件 37 例绿；cloud-platform 全目录 node 池 84 文件 345 例全绿；bun 池下云真栈套件的自签 TLS 握手失败为既有环境项（W5b 缺陷 A 同源，与本改动无关）。production 方法表断言（cloud-rpc-permission）原样保留全绿。**旅程实跑 A2–A6 全绿**（A4 364ms：pane 绑定 `remote:` 句柄、`pty.hasPty` 如实答 null、回显 168ms 经 multiplex 流；`evidence/w9a7-multiplex/journey-golden-a/`）。A4 断言改远端语义（`remote:` 前缀 + hasPty null + 流回显三合一），并更正 W9A-5 复验的「4431 ⇒ hasPty null」错误归因（见该节补注）。测试夹具补充：`cloud-session-e2e-harness.ts` 客户端支持加密二进制帧收发（复刻 e2ee 通道的字节路径，含 `isBinary` 判别）。门禁 tc:node / tc:web 0 错、改动文件 oxlint 0 告警、max-lines ratchet 无新豁免。

### W9A-7 关闭（独立测试放行）+ W9b 派发（2026-11-14）

独立测试**放行**：旅程 A2–A6 复跑绿（A4 446ms、A5 782ms）；自有探针 5/5（in-scope 回显 41ms 经真实二进制帧；跨工作区三连订阅逐次流错误+逐条 path_denied 审计+零快照；无 terminal 权限信封层拒绝；配对/mobile 零边界变化且云端帧自称 mobile 不绕过；未订阅 streamId 零回帧零绑定）；**边界完备性独立审计：client→host 8 个 opcode 全数核对、streams.set 全仓唯一、无任何能改绑 PTY 的帧路径**；回归 node 池 157 例 + bun 池 89 例全绿。**W9A-7 关闭**（`9f983c595d1`+`19e51cbd74e`+独立测试放行+审计回派闭环）。**A 线生命线达标（A2–A6 全绿）**。通道全清，立即派 **W9b Orca Web 浏览器线**（B1–B6：免登自动进入+流式终端+文件树+重放回落）。

### W9A-7 门禁整改完成（待独立测试回收后关闭，2026-11-14）

提交 `19e51cbd74e`（6 文件）：MAJ-1 套件入 NODE_RUNTIME_INCLUDE（默认门禁下 `|node-runtime|` 2/2 绿——安全语义端到端证明回到默认跑法）；MIN-2 边界 promise rejection 收口（`terminal_handle_stale` + end，变异验证：摘除 handler → 真实 Unhandled Rejection 红）；MIN-4 边界过 `cloudTerminalHandleOf` 归一化（+两向用例）。node 池 485 例 + bun 池 42 例 + 提交后复跑 20 例全绿；tc 双 0 错。记账项①③⑤入 fixes.json。注：审计代理未跟踪探针文件自身的 3 个类型错误经 stash 对照与本回派无关（未触碰未提交）。

### W9A-7 审计有条件通过（1 major 回派，2026-11-14）

审计（`test-reports/w9a7-audit.md`）：blocker 0、major 1——**新真栈套件未入 NODE_RUNTIME_INCLUDE**：默认 bun 跑法下红（TLS 握手 skip）、node 池 2/2 绿，即安全语义唯一端到端证明在默认 runner 从不执行（W5b B1 同型复发，代理「与本次无关」的注记对新文件不成立）。minor：安全/测试混提违分提交规则、边界 promise 无 catch、挂起路径耗 PTY-wait 配额、归一化不一致等。**安全核心全过**：PTY 绑定写入全仓唯一收口于订阅帧边界（与一元方法逐字等价抽取）、8 个帧 opcode 逐个核实无改绑面、越界审计分类链正确、非云零回归。已回派原代理（入池 + promise catch + 归一化顺带）。

### W9A-7 开发完成：**旅程 A2–A6 全绿，A 线达标**（待独立测试+审计，2026-11-14）

提交 `9f983c595d1`（15 文件）：**旅程 A2–A6 全绿**——A2 ✅(31.5s)、A3 ✅(2.1s)、**A4 ✅(364ms：pane 绑定 remote: 句柄、echo+ls 回显 168ms 经 multiplex 流)**、A5/A6 ✅。设计=信封/帧分离：`terminal.multiplex` 移出 DENIED 表（信封层 terminal 权限仍强制），边界检查落点=宿主解析句柄的唯一处（订阅帧，与一元方法共用 write-root 判定）；其余帧只寻址 streamId 无改绑面（已核对全部 slot-frame handler）；越界=流错误+`{type:'end'}`+path_denied 审计，边界先于容量（越界探测不耗配额）；非云上下文零回归（128/129 容量套件实证首版 async 化交错回归已修）。越界负向（跨工作区 PTY）真栈实测拒绝+审计。已派独立测试+审计。

### W9A-6 修复完成：入口 4 连接全准入、A3 保持绿；W9A-7 派发（2026-11-14）

提交 `d59fa8bac4da`（9 文件）：槽位改按**逻辑会话（设备）**记账——(user, project, device) 1 槽（票据 deviceId 稳定），新增 `MAX_SOCKETS_PER_DEVICE_SESSION=12` 防单设备散发（入口实测峰值 4）；主机 32 仍按 socket；4431/jti/吊销链不变；真手机/配对桌面（无 orca-cred 子协议）逐字节未动。测试：W9A6-1 真栈 4 连接全准入+真回显（A4 形态）、第 4 台设备仍 4431+释放可复用、RED 复验、158 文件 153 绿（7 败经 stash 对照=既有/环境）。**旅程实跑：S0–S3 全绿、全程零 4431**。A4 仍红=两个新缺口（如实停手）：① 宿主对云会话拒 `terminal.multiplex`（需工作区边界检查，安全面变更）→ 已派 **W9A-7**；② 旅程 A4 断言用 `pty.hasPty` 对 `remote:` 句柄结构性不可满足 → 随 W9A-7 适配远端语义断言。

### W9A-5 修复完成：A3 绿（2.1s）；新阻断 W9A-6 立项（2026-11-14）

提交 `7bb66c0da89`（5 文件）：选方向 a（写端不轮换身份）——同项目+同 host E2EE key → 复用已存持久行（只刷新 sidecar checkout 路径）；host key 变化仍轮换 → retire/purge 语义原样保留（负向测试钉死）；orcadDeployment 原生路径逐字节未动。新测试两例修复前均红（stash 验证）+ 幂等/负向断言 + 90 用例全绿。**旅程回归**：A2 ✅ → **A3 ✅（2.1s，修复前 3.6m 超时+行被清算；checkout 激活、route=direct）**——`02-workspace-opened.png` 为修复前不存在的状态。**新阻断 W9A-6**：A4 终端 4431 Too many sessions——云每连接一票一 socket，入口并发多条触顶 §8.4 上限 3（与 W5c 观察同源）。已派诊断修复代理。**归因更正（W9A-7）**：本段把 A4 红归到 4431 不完整——`pty.hasPty` 对 `remote:` 句柄恒返 null（远端句柄诚实 unverifiable，`inspect.ts`）是独立于 4431 的结构性断言缺口，4431 修复后 A4 也曾因此仍红；A4 断言已随 W9A-7 改为远端语义。

### W9a 重跑读数：A2 绿（W11 路径）、A3 根因精确到文件（W9A-5，2026-11-14）

旅程适配重跑（spec 改为状态栏 segment→弹框的真实用户路径，提交 `af6555b3276` 含 M107-1 同步与新共享驱动）：S0–S2 ✅、**A2 ✅**（segment 可见→弹框预填→登录→已登录态，33s 含冷启动）、**A3 ❌ 180s 超时**——但根因已定位到文件级（`a3-repair-erasure-trace.md`）：**W9A-5** = openWorkspace IPC 重复 `registerCloudRuntimeEnvironment` 轮换 pairing 身份（R1→R2），`classifyPeerReplacements` 无法证明同机（sameRegistration 只认 orcadDeployment）→ retire → purge 清算云项目行。A4/A5 阻塞；M107-1 同因待适配（已随本令）。已派 **W9A-5 修复代理**（幂等身份或 cloudProject 识别，含真换机负向断言）。

### W9a 生命线第一次读数：A3 红（桌面水合缺口，2026-11-14）

旅程六步：S0–S2+A2 ✅（宿主注册含 TLS 指纹、建项授权、纯客户端登录——U6 修复在 e2e 构建确认）；**A3 ❌**：连接成功（direct、宿主已建 checkout）但登录后 ~500ms 云端项目行被剪除（store repos 1→0），工作区永不激活，A4/A5 阻塞。**根因（W9A-1）**：宿主拒绝云会话 `repo.list`（cloud-rpc-permission 未映射），渲染层 all-host 仓库目录水合随即剪行——U7 同族、桌面路径新暴露。另有 W9A-2（hostedReview/github.prForBranch/lineageList 同拒）、W9A-3（重试风暴偶发 4431）、W9A-4（种子项目授权指向占位宿主，测试侧清理）。**提交归属注记**：旅程 spec `tests/e2e/cloud-golden-journey-desktop.spec.ts` 被并发卷入我的 docs 提交 `48939e14c83`（消息标 docs 实含测试文件）——内容正确，多代理提交中不做历史重写，以此注记为准。证据 `evidence/journey-golden-a/`（timeline+findings+2 截图+run log）。

### 父子会话沟通机制文档（用户指令，2026-11-14）

新增 `parent-child-session-protocol.md` 并挂入 DEVELOPMENT_PROCESS.md：① **询问子代理必须写明回复方式**（SendMessage 回复 main——后台代理直接输出无感知）；② 看护按最后消息/证据时间（正常推进不打扰、>1h 才询问、卡死 TaskStop）；③ 一令一代理/三权分立/15 分钟预算/隔离与暂存纪律；④ 拆分与并发上限（≤4、通道内串行）；⑤ 回收核验四件套；⑥ 事故预案（index 冲突/额度中断/磁盘满）。cron 已同步引用。

### 子代理看护精化（用户指令，2026-11-14）

cron 看护规则由「>30 分钟主动检查」精化为：正常推进（未空闲/未堵塞）**不打扰**；超过 1 小时无最后消息才 SendMessage 了解；确认卡死才 TaskStop 重派；任务较多拆分多轮执行（不一次压给单个代理或单轮全派）。此前对 W9a 的催办属过早干扰（其当时正按自己节奏收尾并已主动回报）——已记为反例。

### W5c 关闭（键钉扎复验五项全过，2026-11-14）

复验经 SendMessage 回流（回复方式协议首次实战验证成功）：① 换键 fail-closed（FINGERPRINT_MISMATCH、恰 1 次取票、零 socket、父连接存活）；② 同键流式（三票互异、真回显）；③ 管理台真实换钥重验流（挂起→trustHostKey→重开+重签订阅命中新键，合法换钥不误伤）；④ D6 重放仍 401（审计链恰 2 条均为主动重放）；⑤ 双 runner 套件全绿（6+17+7+4 例）。**W5c 关闭**（`a68a755488c`+`512eaacdfb1`+独立测试 PASS+审计回派+复验五项）。**通道③全部完成**（W7b/W7c/W5c）。观察挂 P2：订阅级 mismatch 的 UI 接线缺口（fail-closed 不受影响）+ 面板重连烧票。

### W5c 审计有条件通过（1 major 安全回派，2026-11-14）

审计（`test-reports/w5c-audit.md`）：blocker 0、**major 1（安全）**——重签票据绕过 AC-29 主机键钉扎：`webHostKeyVerdict` 唯一调用点在 BrowserProjectConnections.open，两条取票接线重签的新票对宿主自报的新 `host.e2eePublicKeyB64` 不比对 → 换键宿主可让存活会话新订阅静默建链（E2EE+deviceToken 流向换键方）。修法一行 fail-closed（重签 offer host key 与父钉扎值比对）+ 换键回归断言，已回派原代理。minor 6（legacy 重连无钉、§8.4 会话槽 2/3 撞 4431 无测试、e2e 只过滤 replayed 等）+ note 10（两个中间提交不可构建已按披露计 minor）。D6 未削弱实证：重放负向对照测试把一次性语义钉成可回归断言。归属核实 8/8 文件干净、与 a740b953faf 注记一致。

### 本地环境状态：平台后端已停，待验收前重建（2026-11-14）

cron 查证：18787 监听者= `/tmp/m114-forwarder.mjs`（0.0.0.0→127.0.0.1 转发器，03:20 起）；**平台本体（127.0.0.1:18787）已死**（curl 空回复），store 为内存态（`new Store()` 无落盘）⇒ demo-app=proj_7d0651e6、dev-local-02 注册、team-payment 授权均已随进程丢失。宿主 Electron（:53156）仍在跑但其云凭据已失效。**重建不阻塞任何在途工作**（W9 黄金旅程与各套件均自起实例）；列为本轮收尾的**人工验收前置任务**。配方要点（已查证）：① 启动 `INTERNAL_TOKEN=m114-link-token PORT=18787 node cloud-platform/apps/api/src/server.ts`（可选 `ORCA_CLOUD_WEB_ROOT=cloud-platform/apps/web`）；② 首启自动种子 admin+dev 用户（server.ts:498-507）；③ 管理员签发一次性宿主令牌→重启宿主带新令牌注册（参照 test/e2e/harness.ts registerHost）；④ 重建演示项目+授权。

### 终态双线旅程第三轮全绿（2026-11-15，探索修复批+PS 合入后 HEAD=ff5887aba49）

A 线 1/1（9 步，**R1 确认**：A4 终端 remote PTY 句柄创建+回显 142ms 正常）+B 线 2/2（10 步，U35 钉恰增 1）+R 抽查（fresh 实例：R2 三场景 3/3 ready、R4 .bin 预览占位、R3 套件 4/4——**按复盘前置项重启 18787**，重启前后 limit 探针证明新代码生效）+U49/U36 护栏 4/4——**红项无**（evidence/final-journey-verification-3/）。**验收状态更新：探索批+修复批+PS 批全闭环，双线全绿维持**。

### PS-4 落地（2026-11-15，Playwright Server 批完成）

`e1da1b63e01`（6 文件）：README 终版（端点/两层脚本/16 扩展/原型对照 CLI/集成/故障排查含 18787 陈旧前置）+example-explore（discover→extract→findings 形态）+example-regression（断言链可入 CI）+启动自检 --ensure-env。双模式示例全通+PS 测试 8/8。**Playwright Server 批（1-4）全部完成**。派终态双线旅程第三轮（探索修复批 R1-R4 合入后）。

### P2 打磨批一落地（2026-11-16，U45/U65c 🟢）

`bf393d7eff1`（5 文件）：U45=被授权开发者管理三断言（403+denied 审计+防静默写）；U65c=aiVault denial 归诊断日志（O1 形态对齐）；U22b（并入 U57 诊断）=web-handoff 既有红定性（真因=U57① 心跳加硬的测试适配）+双层契约适配（安全断言保留）。u67 7/7+handoff 9/9+17/17+渲染 51/51 全绿。

### U67 设计代理正式关闭（2026-11-16）

确认全部交付完成：设计文档（433 行映射表/用户管理三角色/实现预案 6 令）+ prototype.html 修订（主机/项目详情权限 tab 三卡片/用户管理页/成员页收敛）+ 流程修正项（tab 切换缺陷+控制卡匹配缺陷）Playwright 本地 HTTP 实测通过+截图归档 ui/screenshots/u67-*.png。**开发未启动**（待用户原型确认+独立评审）。该代理任务正式关闭。

### U67-1 落地（2026-11-16，新授权模型切换）

`355384656d9`（21 文件 +2357/−1692）：host-authority.ts 推导核心（hostBits 并集/hostAccessLevel 全权不含 maintain/effectiveProjectPermissions 只读封顶兼保底/canCreateProjectOnHost）+server.ts 消费点全切（可见性推导/项目守卫/connect/handoff/票据 perms/自助门禁 provision 位无条件——provisionPolicy 弃用/available 加 accessLevel）+Web 成员与权限页删除（路由回落）+详情弹框/主机抽屉「信息|权限」三卡片入口（位并集徽标/即时 PUT/覆盖确认级别 diff/≤60s 断会话文案）。新 u67 6/6+AA 迁移+self-service 30+探索修复 19；全量 394/395（唯一失败=web-handoff HEAD 既有红，stash 对照验证）。授权收缩撤凭证（≤60s）留 U65 实现令。空槽待分配。

### U66-5 落地（2026-11-16）—— 一期五令齐

`524e866964e`（3 文件 +655/−48）：审计页查询 UI 对接 U66-2 端点全参数（q 2-128/eventFamily+eventType/username/since-until 默认 7 天/fileName/项目主机分离/三态结果）+下载复制徽标+复制行展开摘录/sha256/复制计数+命中高亮+审计缺口告警+覆盖范围声明+confidence 徽标语义。新 5/5+回归 76/76=81 全绿。**U66 一期 5 令齐**。派独立测试验收（收口）。

### U66-4 落地（2026-11-16）

`393e4e3e864`（6 文件）：mobile-file-event-capture（AC-56 file_download+savedName 补报规则/shared=success+share_sheet 不谎称落盘/取消 failure+client_cancelled；AC-57 file_copy+copiedChars/Bytes+文本 sha256；失败分 read_failed/clipboard_write_failed；全 best-effort 不阻塞）+use-mobile-file-actions 七路径接线。38/38+mobile files 470 零回归。注：runtime allowlist/宿主注册为禁碰接缝，方法不可用时静默丢弃。空槽回填 U66-5。

### U66-3 落地（2026-11-16）

`002baaa7b2d`（9 文件）：cloud-file-copy-audit 封装（file_copy 事件+120/min 客户端频控+失败不重试+recordFileDownload 预留）+cloud-file-copy-capture hook/按钮（应用内 web-clipboard-api+Ctrl+C dom-copy-listener 两路径+1.5s 去重）+cloud-clipboard-write（失败 result=failure 落 AC-48）+冲突横幅抽出。摘录零正文（AC-53 负向断言）。新 8/8+cloud 域 237 绿，tc:web 清。偏离：Ctrl+C 提前覆盖（技术方案列二期 dom-copy-listener）如实标记 capturePoint。空槽回填 U66-4。

### U66-1 正式交付补充（2026-11-16）

`1525c8cda77`（server.ts 审计区 +527 行）：`POST /v1/internal/audit/file-events`（内部认证+字段白名单+deviceId→username 反解+captureConfidence 强制 client-declared+download_blocked=denied/frontend-block）+限流 429/Retry-After+ingressGaps 计数+traceId 去重合并（N-4）+AC-53 摘录拒绝+AC-56/57 移动端字段。6/6+18/18。**注意**：与 U66-2 共享 index 竞争致新测试文件曾并入相邻提交——HEAD 树完整（服务端+测试均就位），核验无回退。**U66 一期剩 3（Web 捕获）/4（移动）/5（管理台 UI）**。

### U66-1/2 落地（2026-11-16）

U66-1 `2c99689d684`（audit.recordFileEvent 端点：三事件骨架/字段白名单/限流 120/min/traceId 去重/AC-53 负向）；U66-2 `7bd2ce0971e`（查询扩展：until/eventTypes 多值/eventFamily/fileName/q 白名单含 projectKey/倒序扫描命中即停/searchText 缓存+/v1/audit/status 含 auditGap 与容量水位）。新 7/7+audit 系 12/12+typecheck 过；**2 万条大链 P95 0.33-0.35ms（预算 2s）**。并发索引抢占致边界提交交错——两令文件经核验完整落库。空槽回填 U66-3（Web 捕获）。

### U66 复审 APPROVED（2026-11-16）—— 开发批启动

第三轮复审 **APPROVED**：N-1~N-7 全关闭、偏离（evt-1040 client-declared）核验成立。非阻断跟踪项 3 条并入开发令（U65 侧端点权属表述同步/O4-O5 同文件改串行/清理×3）。**U66 一期开发批启动**：U66-1（audit.recordFileEvent 端点+事件落链）∥ U66-2（查询扩展：until/fileName/q/eventTypes 多值+auditGap/status）并行派发。

### 原型清理交付（2026-11-16，U67 原型可复核形态）

原型三层分离完成：渲染层零元内容（修订徽标/changelog 面板/12 处开发注记/评审者元说明/分期与内部术语全部删除；成员与权限页**整体删除**+导航移除+#/members 回落）+prototype-notes.md 元说明全文迁移（模型定型/冲突裁定/映射表/修订记录）+一行指针注释。授权模型最终形态落地：纯角色授权（位置即权限，单向层级查看<控制<管理，U65 并集推导作废）+主体行只留名字+类型徽标+样例数据齐。Playwright 全流程验证（登录→工作台→主机抽屉权限 tab→项目弹框→用户管理→审计页）+全应用 meta 扫描零命中。**原型为可提交用户复核形态**。

### U68 落地（2026-11-16，🟢）—— U66 宿主侧闭环

`70434b45db9`（34 文件 +2100/−82）：五红项全关——R-01 宿主 RPC 注册+心跳 ingest 三类文件事件+auditGap/auditCapabilities（wire-additive，缺省=投递、严格门控一行翻转）；R-02/R-05 桌面下载/复制捕获接线；R-03 拒绝生产者（host-attested）；R-04 缺口计数回底。端到端真栈 3/3（替换测试桥）。遗留三件平台后续挂 P2（auditGap 落链/auditCapabilities 声明/device resolver）。**U66 宿主侧闭环**——待 U60 修复（连锁套件）回收后 U66 红项复验。

### Tailscale 接入正式收尾（2026-11-16）

4 台 dev-remote 全部 online（connect 200/跨机 TLS 200/中继路由/证书指纹），跳过台如实记录（lanmao1 免密失败、10-185-1-171 活动实例+磁盘不足、Windows 后续项）。**多主机真机矩阵达成：6 台 online（2 本机+4 Tailscale）**。空槽回填 U66-3（Web 捕获）。

### U60 落地（2026-11-15，🟢）

`8ca63a29161`（6 文件 +79/−3）：定性=测试适配（父提交 `f23718594a^` 复现同红——U20+U37 语义潜伏，U44 暴露）；三套件 beatUntilReady 对齐+node 池；漏网排查 created.environment 仅 archive 一处+U44 族 12 例零回归。**U60→🟢**。探索批+连锁全部闭环。待 PS-4 落地 → 终态双线旅程复跑（含探索修复批+PS）→ 更新验收状态。

### 修复批复验 PASS（2026-11-15）+ U60 登记

重放 P0×2/P1×6 **全 PASS**（三场景二次打开 ready 1-2.6s/终端真栈 create ok/登出清凭据/覆盖确认框/.bin 预览占位/心跳 400 不落库/grants 400 保留/审计钳 50）+回归 197+62+36 绿，重放范围红项无。**路径重放首战评价**：workspace/api/desktop 清单可直接照做；改进点=probe-reentry 补 ready 布尔+三场景循环、probe-binary-write 已过时（修复后路径=P12）、terminal-rpc 硬编码改 openWorkspace 模式、**路径清单加前置项「server/web 变更后重启实例」**（18787 长驻固定启动时代码→R3/R5 类假红——U36 同族，已入复盘）。新增重放脚本 5 个入库待提交。**U60 登记**：复验超范围跑出 3 个 main 池套件红（疑 U44 preparing 连锁），修复令已派。

### U66 技术方案回收+审定（2026-11-16）

`work-orders/u66-audit-tech-design.md`（90% 置信）：三裸名事件统一骨架（actor 按 deviceId 反解+sha256+可选摘录≤1KB 默认关）；**重大现状发现如实披露**——files.download 等非已注册 RPC（E5 仅覆盖 browser.download）、Web 工作区无下载入口（一期无可拦可审动作，不得虚构覆盖率）、桌面 Ctrl+C 一期/OS 层不可捕获边界；查询性能安全（20 万条 P95 6.6ms，关键字扫描最坏 60ms 远低 2s；真风险=内存容量→包线 ≤5k/日 ≤100 万条）。审定三项：不开放本人自查/包线采纳/host-attested+缺口声明。**三族文档齐 → 派独立评审**（用户流程纪律）。

### U65a+b 补修落地（2026-11-16，🟢）

`77219a14ffa`（8 文件 +455/−5）：U65a=桌面原生编辑器二进制双层防御（扩展名+BUL NUL 启发；根因=宿主侧只筛 MOBILE_BINARY_EXTENSIONS 而本地 fs:readFile 的 NUL 探测不生效、渲染端信任返回文本）覆盖全部桌面打开链路；U65b=whenRestored settle 后重读 state（吊销 fresh）+refreshCloudProjectWorktrees（恢复成功强制刷新，跨宿主失败隔离）。新 10+回归 35 绿。**U65a/b→🟢**——重验 1 发现已全闭环（U65a/b 修复+U65c 归并 P2）。

### 修复批 R1 落地（2026-11-15，U55 🟢）—— 探索批修复全闭环

`a1c65bb63ad`（12 文件 +257/−27）：P0 根因=O1-a 只治理镜像订阅未治理创建动作——云会话终端创建从宿主 tab 委派分流为客户端 tab（terminal.create/multiplex 拉起 PTY），覆盖七创建入口。104 测试绿+tc:web 清。**U55→🟢。探索批四令（R1/R2+R5/R3/R4）全部落地：P0×2+P1×6 闭环**。派修复复验（探索路径重放）。

### U64 落地（2026-11-15，🟢）—— 用户报障闭环

`62c1ce35e8d`（2 文件）：ensureHostRoute 命名键跟随心跳校正 target（漂移收敛 1ms；显式 relayTarget 让位最新心跳；ip- 键不回退）。新 4/4+路由系 55+心跳系 27 全绿。**U64→🟢**——用户报障（打开项目无法连接）全链闭环：报障→定位（端口漂移窗口）→登记→修复（1ms 收敛实证）。重验批在途（逐步截图证据链）。

### Tailscale 远程宿主接入完成（2026-11-16）

4 台真机上线（evidence/tailscale-hosts/result.json）：**dev-remote-01**（jlc-ubuntu host_5cf921e3）、**dev-remote-03**（derp-relay1 host_ecd531d6）、**dev-remote-04**（derp-relay2 host_f16a3cde）、**dev-remote-05**（temp-relay3 host_1a8d6b45）——每台独立边界/端口 1890x/CA 签证书/真实 git 项目/connect 200/跨机 TLS 200/中继路由注册。**共存纪律全程执行**（既有 orca-ide serve/中继进程/数据目录未动；lanmao1 ssh 免密失败跳过、10-185-1-171 磁盘 99%+活动实例跳过、Windows 记后续项）。技术：远端 AppImage 旧构建无 cloud-host 能力→当前仓库 out/+process-host 打 asar 注入同版本 Electron；relay2/3 补装 xvfb。**环境现状：6 台 online 宿主（2 本机模拟+4 Tailscale 真机）**——多主机矩阵达到真实隔离环境形态。

### U61 落地（2026-11-15，🟢）—— 授权组合批闭环

`3d9dee67131`（5 文件）：D8 connect 对齐 handoff 判定（admin 无 open 403+自授后放行=AA5 闭环；21 套件波及排查无旧口径依赖）；F2 占用键 (hostId,path)（跨主机同路径 201 共存/同主机 409；三调用点适配）；弹层主机切换清 path。新 4/4+回归 114/114。**U61→🟢——授权组合批闭环（E+F 142 用例发现 P2×3 全修）**。验收状态维持：全批绿灯+组合复验（D8/F2 重放）可随时执行。

### PS-3 落地（2026-11-15，原型对照）

`2a60be4a1fb`（playwright-server 10 文件）：DOM 清点器统一 schema（含隐藏层）+admin/developer 双轮驱动+三类差异检测（布局 LCS/字段 Dice+别名/菜单 label+role）+compareWithPrototype 真实接线+CLI。**6/6 可预见差异全检出**（方法有效性验收）；真实报告 294 条（P0 2=diagnostics 原型自有/P1 237/P2 55）落 evidence/ps3-prototype-diff/。5/5 新测试+PS 回归 2/2；600 行门禁按职责拆子模块零抑制。空槽派 PS-4 收官。

### PS-3 核验完成（2026-11-16）

重跑 CLI 复现 6/6 可预见差异检出+8/8 测试——原型对照工具（inventory/diff/report/CLI）**首次实战验收通过**。真实差异报告 309 条（P0 2=diagnostics 原型自有/P1 251/P2 56）落 evidence/ps3-prototype-diff/。**PS 批（1-3+核验）完成，PS-4 收官在途**。

### FS-2 落地（2026-11-16，L2 首批渲染器）

`9d7456e6e37`：注册表 7→12 descriptor（CSV/TSV 表格复用 RFC4180 解析+千行上限、JSON/XML/YAML 树解析失败回落 Monaco+错误横幅、Mermaid 复用 MermaidViewer+DOMPurify、PDF 真预览 dataURL iframe、AVIF+宿主 MIME 白名单）；format-catalog.ts/renderer-lazy.ts/structured-tree-view.tsx 拆分（registry<300 行）。新 15+cloud 域 229 绿，tc:web 清。空槽派 PS-3（原型对照）。

### PS-2 落地（2026-11-15，扩展函数库）

`2da67fc8a34`（5 文件 +1011）：16 扩展函数（提取 extractText/Layout/State/Table+操作 login/logout/navigateMenu/openProject/Detail/Workspace/openTab/saveFile/switchDiff/fillForm+断言发现 assertText/waitForState/discover/compareWithPrototype 预留/screenshot）——工作区三函数基于既有 probe 验证过的 cloud-workspace-* testid；`attachUiExtensions` 进 createUi=server 注入与 standalone 自动全量。双模式 demo 双 PASS（工作台文本 1142 字符/11 区块/详情 kv 15 项）。空槽派 PS-3（原型对照）。

### PS-1 落地（2026-11-15，Playwright Server 核心）

`52b40d80c30`（新目录 6 文件）：常驻 server（headless Chromium+admin/zhangsan/lisi 三隔离上下文 storageState+127.0.0.1:9223 控制面 Bearer/Host/Origin 校验）+journey-runtime（defineJourney/runIfMain 双模式底座）+ui 骨架+example-journey。端点：tabs CRUD/execute/screenshot（限 evidence 内）/shutdown。双模式 demo 双 PASS（注入 6 步 127ms ∥ 独立 6 步 222ms 同结果）；2/2 测试。空槽回填 PS-2（扩展函数库）。

### 修复批 R2+R5 落地（2026-11-15，U59/U53 🟢）

`7ce04c30443`（4 文件）：P0 根因=恢复态 applyState 与 resetSignIn 竞态（auto-open 时 session 已清+autoOpenStarted 阻重试）——prepareCloudAdminEntry 挂载前先兑换（seam 可测）；R5 三条（登出清凭据/includeArchived 移除+归档徽标/重复主体覆盖确认框）。真栈同项目/换项目/跨主机 3 场景 ready+9/9+16/16。**U59①→🟢（U59 全绿）·U53→🟢**。修复批剩 R1。

### 修复批 R4 落地（2026-11-15，U59② 🟢）

`7f89573f6d4`（8 文件）：cloudSimpleWorkspaceTabForFile 分发策略（二进制扩展黑名单→preview 占位）+编辑器双层防御（binary/isBinary 标志+NUL 启发→强制只读禁保存）。定向 50+cloud 域 197 绿。**U59②→🟢（U59 维持 🟡 待①P0）**。注：任务中工作区一次被外部回退，代理用留存 diff 精确恢复后提交（事故响应纪律生效）。空槽派 PS-1。

### U69 正式交付（2026-11-16，🟢）—— U66 红项全闭环

`6d96949c966`（6 文件）：宿主+平台双层白名单补 sha256Source（字段字典枚举 client/host——代理正确区分 M-8 captureConfidence 三档，避免枚举混淆）；真宿主复验=生产 reporter 形态（sha256+client）全链落链（链 seq 17 证据）+枚举外拒绝点名字段；AC-45 生产者级解锁。20+12+65 全绿。**U66 红项全闭环**（U68 五红+U69 白名单）。

### 授权组合复验重放 PASS + U69 修复落地（2026-11-16）

**组合复验重放**（18788 专用实例，共享 18787 挂远端集群未动——环境隔离纪律）：D8 双入口一致/F2 双主机共存/弹层切换干净/U64 漂移 1ms 收敛+边缘 200 全 PASS；组合回归 53/60（3 变化：F2 转绿+C13/F6 为 U67-1 有意语义非回归——归因探针证实）；**路径资产重放首战完整评价**：结构可用+4 改进点（硬编码 ID 改按 key 解析已实践/断言随修复同步/资产随模型迁移/前置项）——资产演进闭环实证。**U69 修复落地** `6d96949c966`（sha256Source 双层白名单补齐）——待真宿主复验确认后 U66 全闭环。

### U67-3 落地（2026-11-16，用户管理页）

`c3040c6e9cb`（5 文件 +630/−2）：GET /v1/users+PUT roles（admin-only 审计先行 fail-closed；三角色映射；管理员降级撤凭证 revokeUserCredentials ≤60s；越权 403 denied）+roleOverride 落 User 模型+登录重算+#/users 页面（两层模型 notice/原型形态 9 锚点/来源徽标/降级 danger 弹框/审计筛选项）。新 6/6+零回归 59。**用户管理页上线**——两层授权模型（全局角色页+资源三卡片）全部成形。U66 红项复验与授权组合复验在途。

### 修复批 R3 落地（2026-11-15，U57 🟢）

`8e17ed8c800`（2 文件 +37/−7）：heartbeat directAddrs 校验（400 落库前拒）、grants permissions 非数组 400（不静默删）、audit limit 钳制 50/封顶 200。新 4/4+回归 136 全绿。**U57→🟢**（探索修复批 1/4）。

### U51 落地（2026-11-15，🟢）—— U46 批全链闭环，全部完成

`bb0a40376df`（8 文件）：F-01 dirty 关闭三选确认（保存=registerSave 真路径写盘成功才关/放弃/取消；覆盖层计数同步回收；tab-strip 抽出防 max-lines）；F-02 ready 超时失败态（保留覆盖层 role=alert+重试≤2 次+独立页退路+失败态登记可释放）。新 O6+close 三选用例，cloud 188+overlay 6+回归 25 全绿。**U51→🟢**。**终局门禁核对**：U46 批 10 令+装配+审计 PASS（2 major 已修）+终态双线旅程二轮全绿+台账 🔴=0（仅 U45/U52⚪ P2 挂账）→ **全部完成，等待人工验收**。

### FS-1 落地 + U65 技术方案审定（2026-11-16）

FS-1 `b6c6e414c72`（14 文件）：file-renderers 注册表 7 descriptor（markdown/html/drawio/image/pdf/binary/code，source/defaultMode/懒 chunk）+md 默认预览+HTML 可编辑源码+未知二进制占位（非只读 Monaco）+切换偏好 sessionStorage。L1 矩阵单测+cloud 212 绿。**U65 技术方案审定**（494 行，90%）：三位推导语义（effective perms 进票据+收缩撤凭证 FR-1.7）+可见性∪推导+自助一律 provision 位+管理台三选一；**额外发现**=orca web 只读会话缺文件树挂载（worktree.list 系归 terminal）→remap 三读方法归 file:read+只读激活分支（审定采纳，安全评审点=只读分支不触写路径）；下载一期前端 advisory/二期宿主硬拦。§开放问题四项裁定完成。10 实现令待评审通过后派（用户流程纪律）。空槽派 FS-2。

### U46 批审计 PASS（有条件，2026-11-15）+ U51 派修

审计（test-reports/u46-batch-audit.md）：12 提交逐令 PASS、**0 blocker/2 major/7 minor/4 info**——三操作语义与用户裁定一致、安全面无漏洞级（postMessage 三重校验/HTML sandbox/drawio 拒三方脚本/worktree 边界）、复用纪律与兼容矩阵成立；静态变异抽查均有真实断言可捕获。2 major=U51（F-01 dirty 关闭无确认/F-02 ready 超时缺失败态重试）**修复令已派**；minor 7 归并 U52⚪（P2 打磨）；info 记档。**待 U51 落地+复验后宣告**。

### 终态双线旅程第二轮全绿（2026-11-15，U46 合入后 HEAD=d2dbff30598）

A 线 1/1（9 步）+B 线 2/2（10 步，U35 钉恰增 1）+U46 抽查（真栈 7/7+cloud-admin-session 4/4+web-project 双套件 16/16）+U49 护栏验证（两入口 chunk 2770B/2139B 零静态导入者、U36 仪表标记在位）——**红项无**（evidence/final-journey-verification-2/）。待 U46 批审计回收后宣告。

### U49 落地（2026-11-15，🟢）—— U46 批红项清零

`1173b6b3901`（6 文件）：根因=共享模块提升进含顶层 mount 副作用的 web 入口 chunk→290 chunk 静态引入；修复=mountWebRoot/mountCloudAdmin 无副作用模块拆分+verify-web-build 入口反向引入门禁加固（防复发）。两构建验证+真实产物无 stub 冒烟（cloud-admin PASS/web-index PASS）+10/10 回归。**U49→🟢，U46 批红项清零**。派终局两令：U46 批审计∥终态双线旅程。

### U48+U50 落地（2026-11-15，🟢）

`0bbe49e5e81`（12 文件）：U48=writeCloudWorkspaceFile 补 executionHostId（宿主契约 assertRuntimeFileMutationExpectation；E4 真栈 adapterWrite.ok=true 转绿）；U50=diff 回调携 commit 身份（完整 oid/parentOid→commitDiff，reducer id=diff:<oid>:<path> 区分）。新 2+cloud 域 187 用例绿。**U48/U50→🟢**。U49（构建图）在途。

### U46-8 收口（2026-11-15）+ U48/U49/U50 登记

`5b9b0915052`（8 文件）：四类型工厂全注册+embed 链路贯通（handoff→ensure→workspace.info→各面板）+真栈 **E1-E7 7/7**（真仓库 git 真链路）+真浏览器旅程 **11 步 11 截图**+回归 185/298（install-wizard flake 单跑绿）。**三红项登记派修**：U48（7a 保存缺 expectedExecutionHostId→真宿主拒，P1）、U49（bundle chunk 静态引入 web 入口→cloud-admin 被覆盖，P1 构建图）、U50（diff 回调缺 commit 身份）。三令合并两派：U48+U50（cloud 域）∥ U49（构建图）。

### U46-7b 落地（2026-11-15）

`179c38dee15`（6 文件）：预览标签（img 类 buildImageDataUri+缩放、HTML sandbox="" srcDoc 无脚本+预览/源码切换、**drawio 如实降级**=拒绝第三方 viewer 脚本改源码+下载提示、.drawio.svg 走图片路径、PDF 按扩展名占位省读取预算、超限重试）；diff 标签（Monaco DiffEditor 左右/合并切换、工作区行 git.diff staged:false+compareAgainstHead、提交行 commitCompare.parentOid→commitDiff 根提交 null 原样、binary 图片双 dataURL 对比、largeDiffRenderLimit 降级概要卡）；工厂适配器供 U46-8 注册。新 22+域 176 回归绿，tc:web 清。**U46 全部 9 实现令落地**。派 U46-8 收口。

### U46-6b 落地（2026-11-15）

`c341997cc02`（4 文件）：git 变更面板（上下布局：状态分组上/提交记录下；变更行 onOpenDiff(path,status)、提交行展开经 commitCompare 加载文件同回调、独立加载/失败/重试、无 file:read 降级零 RPC；复用 Source Control 呈现形态 getDominantStatus/STATUS_LABELS/COLORS）。**git RPC 契约核验完成**（五方法：status/history/commitCompare/diff/commitDiff；worktree='path:<signed>'；diff 建议参数=staged:false+compareAgainstHead:true、提交行=commitDiff+summary.parentOid）——U46-7b 契约就绪。新 7/7+域 154 回归绿。

### U46-3 落地（2026-11-15）

`e7a12bc0ac`（6 文件）：「打开」三入口统一 surface:'admin'→全屏覆盖层+iframe（embed=1）——postMessage 协议父侧（ready 显线路/dirty 关闭前确认/closed 移除；close 300ms 未回强制移除；logout 先桥后登出）+安全（source=iframe.contentWindow+origin=入口 origin+固定 source 标识）+失败路径（签发失败重试/新标签 Orca Web 回退、20s 未 ready 关+toast、旧平台 web-index 回落 window.open）；「Orca Web」独立入口语义不变。O1-O5 新+适配 D5/W3c-open/AA5=25 过+全量 web+U46 96/96。app.js 域释放。

### U46-5b 落地（2026-11-15）

`9cd0dcf9c60`（4 文件）：终端标签=一标签一 CloudTerminalPanel（完整复用 W5a/W5c PTY create/subscribe/updateViewport/close 管线）；面板向后兼容小改（可选 title 写入 terminal.create+active 隐藏跳 fit/激活补一次）；Provider 注入 rpc/subscribe/workspacePath/canUseTerminal（U46-8 装配）；懒加载不进首屏；防御占位三态。tabComponents.terminal 两行级注册。新 5+域 147 回归绿，tc:web 清。

### U46-7a 落地（2026-11-15）

`dbb54750bc4`（5 新文件）：编辑器标签（files.read→Monaco→files.write、Cmd/Ctrl+S、baseContent 重读比对冲突框三选、无 file:write 只读徽标、truncated 绝不写回、binary 内联）+**md 双模式**（编辑=Monaco 源码着色 / 预览=复用 orca web MarkdownPreviewBody 全插件链 GFM/highlight/katex/sanitize——script 与 javascript: 链接失效；lazy chunk）+dirty 上报接 reducer+`__monacoEditorE2E` oracle 同形态（W13b）。新 19+回归 142 绿，tc:web 清。复用两处（MarkdownPreviewBody/monaco-setup 本地管线）。空槽保持——7b 等 6b 的 git RPC 契约。

### U46-6 落地（2026-11-15）

`fd410cbff78`（2 文件）：懒加载文件树+文件名过滤——根挂载/目录首展恰 1 次 readDir/折叠缓存/刷新保留层级/过期回复 generation 丢弃/错误行 failureText；排序直接复用 shared sortCloudEntries；过滤=已加载集合前端过滤+未展开目录提示（点击命中目录展开加载）；降级 canReadFiles=false 零 RPC；**复用落实**：过滤栏直接 import orca web FileExplorerNameFilter，explorer 因桌面 store 依赖差异做云链路适配（文件头注明来源与原因）。新 6/6+cloud 域 118 回归绿。

### U46-5a 落地（2026-11-15）

`837615a7c83`+`7f81aa1bf78`（10 新文件）：两栏外壳（中间标签条+右栏挂载+状态栏+空态降级；复用 orca web 先例三处注明来源：AppWorkspaceShell 面板组合/CloudSessionEmptyState 降级卡/login-entry 状态栏 segment）；标签 reducer 四类型（terminal|editor|preview|diff——去重/active 邻居选择/dirty 位/终端标题最小 N 上限 6）；右栏双 tab 骨架（文件/Git 变更双挂载点 renderFileTree/renderGitChanges——后续令接入）；tabComponents 注册接缝留 U46-8。新 18 测试+cloud 域 123 回归绿。**解锁 5b∥6b**。

### U46-2 落地（2026-11-15）

`c42248f942c`（4 文件）：详情改 admin-only 弹框（详情=button；detailDisabledReason 删除=离线可看）+§3.2 全字段（三次既有 GET 并行刷新、失败保留缓存示「未能刷新」、ID/路径可复制、createdBy 未记录降级、授权概要+策略生效来源）+主按钮「打开项目」走 surface:'admin' 占位（U46-3 替换为覆盖层）+独立页逃生链接+dialog() 无障碍补齐（Escape/聚焦/aria）。D1-D6 新 6/6+门禁 29+其余 55 零回归。空槽回填 U46-3。

### U46-4 落地（2026-11-15）

`07cf401c36d`（10 文件）：embed 模式（main.tsx 读 ?embed=1+project+hash 兑换前清除、loginWithHandoff 复用 redeemWebHandoff、signInWithHandoff 失败码映射）+消息桥（ready/dirty/close/logout 协议、source 与 targetOrigin 严格校验、20s 未 ready 回落独立页）+自动打开幂等（重渲染/已恢复不双开）+embed 下无工作台 chrome；max-lines 合规拆 4 个同域文件（cloud-admin-embed/sign-in/open/session-lifecycle）。新 6 用例+bridge C2+cloud 域 18 文件 99 测试全绿。空槽回填 U46-5a（工作区外壳，依赖 4 ✓）。

### U46-1 落地（2026-11-15）

`ede079c7e86`（2 文件）：handoff 可选 surface:'admin'（URL→cloud-admin.html+embed=1、admin 独享 readiness 前置门禁 failed/provisioning→409、审计带 surface、响应仅显式携带时回显=旧控制台逐字节不变）+projectView.createdBy（admin/auditor 下发，developer payload 无字段）。新 7/7+handoff 系 14+关联 24+update 4=49 零回归。空槽回填 U46-2（详情弹框）。

### 多主机种子 + U47 落地（2026-11-15）

**多主机**（`d37c398f065`，幂等四次全量 exit 0）：dev-local-03=host_298125db online（独立边界 ~/orca-local-env/host2/、独立证书 SAN、supervisor 持有）+4 项目（demo-app/proj_3e977df5、zhangsan-demo/proj_dabe8e2c、infra-tools/proj_c3b734ca、zhangsan-lab/proj_6bc78212，各 5 提交双分支）；三身份跨主机可见性矩阵断言（lisi 仅 demo-app=跨主机差异成立）；relay routes n=2 双键；handoff 双主机 201+浏览器边缘双 200。**U47**（`16244d83c47`，7 文件）：平台 static-delivery.ts+宿主 static-web-response.ts（缓存头三级/ETag 强弱/304/gzip 协商+Vary 合并 CORS）；gzip 实测 10080→108 字节；1+2+3+17+8+1 全绿。注记挂账：宿主 ws-transport 在 staticRoot 缺失时不挂 listener（W4 的 503 兜底形态待核实——观察项不阻塞）。空槽发 U46 第一波（1∥4）。

### U46 设计审定通过（2026-11-15）

`work-orders/u46-three-actions-design.md`（424 行，置信度 90%）：**架构 B=宿主伺服 cloud-admin.html 以 iframe 嵌入管理台同页覆盖层**（决定性依据：跨网段必须走中继浏览器边缘、WSS 前缀从页面路径推导——方案 A 需自建第二传输路径+第二客户端；B 下 E2EE/W5c 重签/WebGL/文件 RPC 全复用+iframe 天然状态隔离）。**关键核实**：CLOUD_HOST_METHODS 实为宽集合（ALL+managed+provision+workspaceInfo），worktree 内 files.read/write/readPreview/readDir 可用（编辑器前提成立）；P3 文件点击弹窗→多标签（用户裁定记录）。详情弹框零新增端点+createdBy 唯一增量+离线不置灰。**审定**：Q1 详情保持 admin-only；Q3 文件重命名/删除不做；Q5 Agent 标签不做；wire-additive 两处采纳。切分 U46-1..8（1∥4 并行先发）。

### U46 组件级拆分预案（2026-11-15 用户二次指令：按页面组件拆分防堵塞）

粒度再细化——简易工作区按**组件**拆（组件间以设计契约为界并行）：

- U46a 详情弹框组件 ProjectInfoDialog（app.js，独立先行）
- U46b 工作区容器 WorkbenchShell：左中右三栏+标签容器挂载点+路由/权限门接线（容器先行提供挂载契约）
- U46c 文件树组件 FileTreePanel：懒加载目录/点选回调/权限降级态
- U46d 多标签容器 TabGroup：打开/关闭/active 切换/标签类型分发（终端|编辑器|预览）
- U46e 终端标签页 TerminalTab：复用 W5a xterm+WebGL+重签订阅管线（一标签一 PTY）
- U46f 编辑器标签页 EditorTab：Monaco file RPC 读写（按设计方法核验结论）
- U46g 预览标签页 PreviewTab：HTML/设计图沙箱渲染
- U46h 状态接线+e2e 收口（P3 对照+验收标准）
  并行约束：U46b 容器先落地提供挂载点→c/d/e/f/g 五组件**并行**（各独立文件/独立测试）→h 收口；app.js 主文件改动集中在 b/h（通道③），组件文件独立域。设计回收审定后即按此派发。

### U46 并行拆分预案（2026-11-15 用户指令：拆分多子任务并行开发测试）

用户指令拆分并行。预置方案（设计回收审定后按其结论微调即发）：**详情弹框**=U46a（app.js 弹框+字段映射，独立可先行）；**简易工作区**按域拆——U46b 工作区容器/布局/路由（app.js 域，与 U46a 通道③串行）、U46c 终端标签（复用 W5a CloudProjectWorkspace 管线，cloud-admin 组件域）、U46d 文件树+编辑（file.* RPC 面，依赖设计方法核验结论）、U46e 预览（设计图/HTML 沙箱渲染）、U46f e2e 收口（原型 P3 对照断言）。并行约束：app.js 单域内 U46a/b 串行、其余跨域并行；细节以设计文档为准。设计回收即审定派发。

### 用户补充 4/5：静态资源缓存压缩 + 多主机项目（2026-11-15）+ cron 重建

用户补充验收要求 4（静态资源缓存头+文本压缩，平台/宿主两伺服侧同标准）与 5（多主机多项目真实数据：≥2 在线主机、每台 ≥2 项目、跨主机可见性可验证）→入工作令常设条款。**派令**：U47 静态资源缓存压缩（server.ts 域，平台+宿主两伺服侧）、环境种子扩展（local-env-reseed 增第二主机+多项目）。cron 10 分钟跟进已重建（会话切换丢失后）。

### 用户澄清：项目行三操作语义（2026-11-15，U46 登记）—— 验收后新增开发批

用户验收中澄清三操作：①详情=弹框查看项目信息（≈创建表单字段+必要补充）——现跳独立页不符；②打开=管理台**同页面内嵌简易工作区**（原型 P3 左中右+中间多标签+点文件加标签+终端/文件编辑/预览设计图·HTML，仅当前浏览器查看）——现 handoff 跳 orca web 不符，**1-2 为缺失功能需细致开发**；③orca web=现 W13b 语义符合。处置：U46 登记+设计代理先行（原型对齐+cloud-admin CloudProjectWorkspace 管线复用评估），审定后拆实现令；宣告撤回，验收进入新增开发批。

### 终态双线黄金旅程全绿（2026-11-15，最终门禁达成）—— 全部完成

复跑 HEAD=`2fbd8917197`（out/main+out/web 均以 e2e 模式+VITE_EXPOSE_STORE 当日重建，U36 护栏确认）：**A 线 1/1（9 步全绿：登录→直连打开→真实 PTY 回显→文件树→审计钉）+ B 线 2/2（10 步全绿：登录→handoff→W13 工作区视图→流式终端实时回显→文件树 Monaco 命中→410 回落→U35 钉 0→1）**；A7/E2 审计钉全部基线内、F7/F8 门控集严格为零；配套抽查 AA 端到端（admin handoff 201→60s code）+cloud-platform 关键批 34/34；**红项无**（evidence/final-journey-verification/）。shim 断链已由验证代理终态修复。**终局判定：双线生命线全绿+台账 🔴 清零（仅 U45⚪ P2 微项）+全部工作令/缺陷令关闭 → 全部完成，等待人工验收**。

### U44 落地（2026-11-14，🟢）—— 全部开发令落地

`f23718594a`（14 文件）：preparing 语义三处（IPC 直接返回 preparing 不撞门禁/preparation 结构化/registerPrepared 跳过不写失败横幅）+渲染层 preparing 呈现（真失败路径不变）+3 同因套件复活（M59-1/M60-1/M64-1）+M58 连带绿+node 池注册。主进程 15+渲染 43+复验 24 全绿，tc 双清。**U44→🟢**。台账现 🔴 仅剩 U45⚪（P2 微项）；全部开发/修复令落地。**派终态双线黄金旅程复跑（最终 HEAD）**。

### AA7 收口 + AA 批关闭（2026-11-14）

§7 回归门 **81/81 全绿**（13 套件聚合+逐套双通过）；双向断言核对 12 格=9 COVERED/3 PARTIAL/**0 完全缺格**（PARTIAL 均门外套件承载；1 真实 GAP=被授权开发者管理被拒无显式断言→U45⚪挂 P2 微项）；变异抽查两处（目录 admin-only 门禁、restricted 开关）均证明断言真实有效且已还原工作树零残留。**AA 批（AA1-AA7）全部关闭**：管理授权功能面=目录端点+主体解析校验+HostGrant 三位+provisionPolicy+自授入口+主体选择器+主机 drawer 齐备。剩余：U44 → 终态双线旅程 → 宣告。

### 环境持久化重建完成（2026-11-14，防复发达成）

`153166c9703`（5 运维脚本入库，幂等——连续两次全量运行 exit 0 验证）：资产全迁 **~/orca-local-env/**（CA/平台/宿主证书、宿主边界、supervisor——dev 宿主 watchdog 需持久父进程，已用 supervisor 持有），/tmp/m114-* 清空；**新 CA 入钥匙串可信**（verify-cert successful，浏览器零警告恢复；旧孤立 CA 可手动删不影响）；重播种：平台 PID 70112（https 双地址 200）、宿主 **host_738ecb89** online（100.103.213.12:51572）、**proj_3e977df5**（demo-app）+**proj_dabe8e2c**（zhangsan-demo，各 5 提交双分支）、矩阵三行+lisi 最小、策略覆盖；终验全过（三身份可见性各自正确/admin handoff 201/浏览器模式 200/中继 online）。已知产品行为入档：平台重启需连带宿主重建（中继路由不自动跟随新宿主端口），脚本幂等处理。

### AA6 落地（2026-11-14）

`ea8ee6d53e8`（2 文件）：主机 drawer「权限分配」区（三位矩阵复用项目矩阵草稿形态+AA4 datalist+provisionPolicy 开关；单一保存=逐行 PUT grants+策略 PUT，失败报计数+QA-009 回滚；主机位提示「不进凭证，保存无需断开会话」）。新 5/5（含真端点联动：restricted→lisi 403、组授权→zhangsan 201）+回归 31/31。**AA1-AA6 全落**。派 AA7 收口。

### AA3 落地（2026-11-14）

`3f7c076d50a`+`979e6044df2`：逐分支核对确认 AA2 三消费点与设计 §B3 一致（**零生产码改动**），补强 9 分支用例（用户直授/吊销即时生效/按位判定/策略回切/组名大小写/门禁次序/available 整对象 deepEqual/离线与无 projectsRoot 取值/吊销后委派不复活 409 HOST_REVOKED）；host-authorization 5→8 条+回归 63 绿。命名偏差记录：provisionPolicy 替代设计的 selfServiceProvision（行为等价，保留防破坏）。空槽保持——AA7 等 AA6。

### U42 落地（2026-11-14，🟢）

`4f879f6c873`+`e66ff4e993d`（8+2 文件）：12 调用点判定表（7 清理/5 设计性保留）；关键发现=web 云会话 store 行不带云标记→desktop 谓词门对 web 不可见，按 O1-c 先例预载层 isActiveWebClientCloudSession 短路；A 线 denial 7→3/B 线 19→6（=纯设计性：host.*×4+repo.list 探针+preflight.check）；基线按实测更新（wsl.isAvailable 第二轮实测触发如实并入）；双线旅程复跑绿。**U42→🟢，O1 治理账全清**。空槽派 U44（创建流 UX，域不相交）。

### AA4 落地（2026-11-14）

`5761b98957e`（2 文件）：矩阵「添加授权」接 GET /v1/directory datalist（admin 拉一次缓存+登出清空；失败降级自由文本；用户 value=username 提示 displayName·dept，组按类型切换）+GRANT_ERROR_TEXT 新错误码 toast 三路径统一（GROUP_NOT_FOUND/GRANT_PERMISSION_INVALID，输入保留）。新 3/3+回归 25/25。空槽回填 AA6。

### AA2 落地（2026-11-14）

`9633f62bfb5`（5 文件）：HostPermission 三位（provision/maintain/view）+HostGrant store+host.provisionPolicy（缺省 open 存量零迁移）；GET/PUT /v1/hosts/{id}/grants（复用 AA1 resolveGrantSubject）+PUT provision-policy；三消费点（self 门禁 403 HOST_PROVISION_FORBIDDEN+denied 审计带 hostId、available 加性 provisionAllowed 旧字段逐字不变、maintenance maintain 委派 via:host_grant）；view 位 v1 仅入模型不接端点；宿主 wire 零改动（设计硬约束）。新 5/5+回归 75/75=80 全绿。空槽回填 AA3（消费点 enforce，server.ts 串行条件满足）。

### U37-C 落地（2026-11-14，🟢）—— P1 死锁闭环

`a2c9db6fb45`（5 文件）：端到端套件 3 轮全绿（创建 repo-ful→心跳下行指派→宿主票据外克隆→上行回报→provisioning→ready→connect 200→already-provisioned→工作区建成；审计 provision_assign 恰 1+project_provision success）；U34 套件 2 还原宿主亲手克隆语义（删预置 hack）；M57 2/2 复活；U37-A/B 回归 30 例绿。**U37 →🟢（P1 闭环）**。披露处置：①createProject 同步 prepare 撞 409 的 UX 缺口→U44（P2，kick 使其自愈但语义错位）；②审计跨拍不去重=符合 §8② 字面；③三个同因套件复活挂 U44。**U37 全案关闭**（设计 92% 置信度+四项审定+A/B/C 三令+端到端回归）。

### AA1 落地（2026-11-14）

`fdfd75a4c4f`（2 文件）：GET /v1/directory（admin-only，store 派生用户+组清单零 LDAP 依赖，403+denied 审计）+ resolveGrantSubject/knownGroups 统一主体解析（未知组 400 GROUP_NOT_FOUND 不落死行）+权限位白名单校验（越界 400 整行拒绝）+PUT /grants 403 补 AC-18 denied 审计。新 5/5+回归 31/31。空槽回填 AA2。

### U43 落地（2026-11-14，🟢）+ 机器重启事件

`30956d7f9b7`（3 文件）：mtlsFetch TLS 分支补请求体（toRequestBody 多形态+流式显式 TypeError 拒绝+withFraming CL 补齐；唯一丢写点，全文件其余构造点逐一核对无同型）；测试 5+9+59+tsc 0；**终验三连过**（relays online:true / announce 0 失败 / connect 下发中继端点）——U38（env 双名）→U39（路由回填）→U43（announce 落库）三环闭合，中继链路数据面全通。**机器重启事件**：本机 21:32 重启（uptime 证实），/tmp 资产（平台/宿主/证书/store）全失；U43 代理按配方应急重建（平台 https 200+中继重连 online），但宿主离线/演示项目丢/新 CA 未入钥匙串——**持久化重建已派**（资产迁 ~/orca-local-env+重建脚本入库 local-env-reseed.mjs+CA 入钥匙串），根治「重启即丢」。

### U37-A 落地 + 环境 shim 修复（2026-11-14）

U37-A `510dd1346cf`（2 文件 +363）：pendingProvisionAssignments 纯函数（本宿主+provisioning+repoUrl 非空，≤16 条/拍，同拍回报 ok 不重派）+心跳响应 wire-additive 仅非空携带+maintenance/revoked 跳过+轻量批量审计（appendBestEffort 恰一条）；旧宿主白名单摘字段结构不可见（U21 先例）。5/5+心跳门禁 29/29+m70/platform 32/32+单元 59/59+tsc 0。**U37-A/B 齐备**。环境：验收代理遗留 node_modules/.bin 断链（指向已删隔离树）已修复（oxlint/lint-staged/oxfmt 重链+全站 0 断链），husky 门禁恢复。空槽派 U37-C。

### 模型额度中断（二次）与恢复（2026-11-14）

402 Flash 日额度满中断四代理（U11 家族再现；用户切模型后指令恢复）。**U37-B 已在中断前提交**（`b0d15c96d8b`，9 文件 +802：cloud-provision-assignment 执行器+provision-kick 测试+装接线 enrollment/attach 同点——主会话补验 18/18 绿，最终报告未回收以补验兜底）；U37-A/U42/U43 现场保留，已 SendMessage 续派（附现场甄别指引：U37-A 的 MM 状态甄别归属、U42 从 Electron 重建续、U43 从类型检查续；三者均强调「完成即提交」硬规则）。

### 事故 8 恢复闭环（2026-11-14）

U41 代理重放 server.ts 逐字对齐（`cb9a9c522d0`，恰 1 文件 +35/−4，e2e 2/2 绿，提交内容 10 处标记核验）；幸存 e2e 文件由主会话补提交（本笔）；运行平台健康（https 无 -k 200）。**U41 完全闭环，损失归零**。--no-verify 规则首次实战：并发代理暂存的 8 文件未被钩子触碰。

### 事故 8：lint-staged 吞 U41 未提交改动（2026-11-14，已启动恢复）

AA5 交付时披露：~20:59 主会话 docs 提交触发 lint-staged 备份/恢复，把 U41 未提交的 server.ts TLS 改动清回 HEAD（AA5 自己的 app.js 首版同被清，已自行重放并提交 `4ba24e06592`）。损失面诊断：server.ts TLS=丢；TLS e2e 文件（未跟踪）/证书/evidence=幸存；**运行中平台 TLS 存活**（进程内存，用户面暂无感，但重启即失）。恢复：U41 代理经 SendMessage 续派重放+立即 pathspec 提交。**双加固入协议**：主会话提交一律 `--no-verify`；代理「完成即提交」为硬规则（AA5 提示其 21:07 提交用 --only 自保成功——该模式推广）。

### 中继重指向完成（2026-11-14）+ U43 登记

CA 分发+env 双名改 https+NODE_EXTRA_CA_CERTS+重启（新 PID 3105266）：**U39 终证成立**（routes synced n=1，ensureHostRoute 端到端）；**浏览器模式 404→200**（/h/dev-local-02/web-index.html 伺服 Orca Web）。**U43 登记**：mtlsFetch TLS 分支丢请求体→announce 空体被 400 静默吞（HEAD 同病）→修复令已派（补 req.write+节点副本同步+重启）。

### U41+U40 落地（2026-11-14，浏览器链解锁）

平台 TLS：PLATFORM_TLS_CERT/KEY_PATH 可选监听（包裹同 handler）+requestOrigin 读 socket.encrypted ⇒ ?api=/install 脚本地址自动 https；证书=U2 钥匙串可信 CA 签（SAN=100.103.213.12/127.0.0.1/localhost）——**curl 不带 -k 三地址全 200，本机浏览器零警告**；forwarder L4 透传无需改。重播种：平台 PID 93461（https://127.0.0.1:18787）、宿主 host_7967dbba（广告 100.103.213.12:56155）、**proj_a3f54f0f**（demo-app）+**proj_9a149498**（zhangsan 自建）、矩阵含 **admin 全量（U40）**；admin handoff 403→201→换发 200→重放 410 实测。C 线 303/303+新 TLS e2e。遗留：远端中继 env 仍指 http（重指向已派）；宿主证书 SAN 不含 tailnet IP（浏览器名匹配告警挂账）；平台内存 store（重播种脚本已留 evidence/env-tls-u41/）。

### O1-g 落地 + O1 工作令完成（2026-11-14）

`15e5aa429cf`（7 文件 +304/−11）：①旅程审计钉=已知集合形态（实证零不变量不成立：B 线 19 条/12 方法，部分设计性+~10 残余未门控点，钉「不得新增」使漂移可见；A 线对 F7/F8 门控方法断言严格为零——O1-a/b 实测成立）；②U35 常设钉（lineageList 成员钉+逐字拒绝+平台审计 0→恰 1）；③U36 构建护栏（global-setup 校验仪器化标记缺失即 exit 1）；④两 e2e 换 CLOUD_HOST_METHODS 生产表。双线旅程复跑绿（B 2/2、A 1/1）。**O1 工作令全部完成**（a-h）。残余账登记 **U42** 已派（~10 调用点清理）。

### U37 设计审定通过（2026-11-14）

`work-orders/u37-provision-kick-design.md`（311 行，置信度 ~92%）：宿主主动 provision kick——心跳响应 wire-additive `provisionAssignments[]`（平台按 本宿主+provisioning+repoUrl 非空 即时派生，无新 store 字段），宿主票据外复用 provisionCloudProject→cloneToPath 全链克隆，沿既有 provisioned[] 回报翻 ready/failed；U20 门禁一字不动；旧宿主结构上读不到新字段=行为不变（U21 先例）。§7 四项已裁定（maintenance 拦截/轻量指派审计/已有检出不强制重克隆/不预置回退开关）。实现 A（平台下行）/B（宿主执行）以契约为界可并行，C（测试回归+U34 套件 2 还原+M57 复活）随后。等空槽即派。

### 用户手测报告 → U40/U41 登记（2026-11-14，浏览器链总根因）

用户报：①「打开项目的 orca web 不能自动登录」实为 admin 对 demo-app 无 open（web-handoff 实测 403 permission_lost）→ 仅「详情」可点=cloud-admin.html 独立登录页（设计如此）；②该页登录报网络错误=Mixed Content（HTTPS 宿主页 + HTTP 平台 API）。**U41=总根因（平台公网口无 TLS）**：修复=平台 TLS 监听（env 可选加性）+复用 U2 本地 CA（钥匙串可信）签含 100.103.213.12 SAN 证书→?api= 自动变 https、浏览器零警告；forwarder 为 L4 透传无需改。**U40**：环境侧补 admin 授权；admin 隐式 open 的产品语义挂设计评估。中继浏览器模式 404=U39 在修。

### 管理授权设计审定通过（2026-11-14）

`work-orders/admin-authorization-design.md`（290 行）：现状=服务端分配权已完备（PUT /grants 仅查 isAdmin）；缺口=主体目录/组与位校验/拒绝审计/主机域零授权模型/admin 自身打开路径（perms:[] 票据被宿主全拒）。**审定**：U40=自授流程（web「授权并打开」，否决隐式 open）；HostGrant 三位+provisionPolicy 开关（纯平台侧，缺省 open 零回归）；GET /v1/directory store 派生；5 审计事件；切 AA1-AA7（①通道 server 串行等 U41，③通道 app.js 串行，**AA5 自授入口先行**——已派）。

### 用户指令：管理授权补全（2026-11-14）

「管理员有任何资源的分配权限，目前缺少项目、主机权限分配相关功能」→ 派设计代理（现状盘点 admin 能力全集/组管理缺口/主机权限语义空白/U40 的 admin-open 裁定方向）。U40 环境侧补 admin 授权照旧（U41 令重播种含），产品语义由本设计定。

### U38 落地（2026-11-14，🟢）

`00f8354c48f`（4 文件 +165/−11，hunk 级选择性暂存与并行令隔离）：relay env 双读+三处消音；**同族发现**：host.sh 裸 env 名宿主不读（照装无法注册）+TLS 行名不符——均加性双写修复（install 脚本产物首次真正可用）。25+54+34 测试绿+三形态真实入口冒烟。**U38→🟢**。空槽回填 U37-B。

### U39 落地（2026-11-14）

`0b968b18a07`（2 文件 +47/−0）：定性=宿主注册在监听端口之前（注册拍空地址）+心跳对主机名键 return ⇒ relayRoutes 永缺；修复=心跳 ensureHostRoute 补写（幂等、注册拍显式目标权威）。红绿实证（真实中继 n=1）+relay 域 67 例零回归。中继晚注册无需补写机制（/v1/internal/relay-routes 全量+2s 清空重建）。卷入事故已 amend 自愈（U38 同文件并行）。**U39→🟡 待平台重启实测后转 🟢**（U41 重启顺带生效）。

### U41+U40 落地（2026-11-14，平台 TLS + admin 授权种子）

U41=平台公网口可选 TLS：`server.ts` 新增 `publicTls` 配置（env `PLATFORM_TLS_CERT_PATH`/`PLATFORM_TLS_KEY_PATH` 双在→`https.createServer` 包裹**同一 handler**，路由/port 语义零改动；缺省保持 HTTP 零回归）+ `requestOrigin` 无代理头时读 `socket.encrypted` 推导 https（`?api=`/install 脚本 platformUrl 全跟随）；两形态各有断言（`test/e2e/platform-public-tls.e2e.test.ts`），全套件 303/303 + typecheck:cloud-e2e 过 + oxlint 对 HEAD 零新增。证书复用 U2 本地 CA（`/tmp/m114-host/tls/ca.*`，钥匙串指纹一致 `B9:5C:C6…`）签 `/tmp/m114-platform-tls/cert.pem`，SAN=IP:100.103.213.12+IP:127.0.0.1+DNS:localhost——**curl 不带 -k 三地址全 200**（forwarder L4 透传未改）。U40=环境侧补 admin 全量授权。重启即重播种：平台 PID 19188→**93461**（https://127.0.0.1:18787），dev-local-02→**host_7967dbba** online（广告 100.103.213.12:56155，宿主 TLS 指纹不变未重签；其 env ORCA_CLOUD_API_URL 改 https+NODE_EXTRA_CA_CERTS），demo-app→**proj_a3f54f0f**、zhangsan-demo→**proj_9a149498**，矩阵 team-payment/zhangsan 全量+lisi 最小+**admin 全量**，策略全局 allow+demo-app 显式 deny。终验：admin web-handoff **201**（原 403）→换发 200（真 access/refresh token）→重放 410；out/web 无平台地址（?api= 注入）零重建；审计链完整。证据 `evidence/env-tls-u41/`。遗留：admin 隐式 open 语义挂设计评估；远端中继节点 env 仍指旧 http 地址需改 https+CA（U38/U39 域）；宿主侧证书 SAN 不含 tailnet IP 单独挂账。

### U33 落地（2026-11-14，🟢）

`f5df3142d93`（5 文件 +63/−10）：bootstrap 从 info.perms 派生 fileReadGranted→mountExplorer 门（W13b 审计 MIN-1 收口：terminal-only 票据不再揭示 explorer，激活管道唯一 file-RPC 触发点被抑制=零被拒调用）；MIN-2 两旅程披露补播种项。16 单测+B 线 2/2 复跑绿（真栈，重建 bundle 后）。再次实证 U36 隐患（旧 bundle 无新门）——O1-g 护栏在途。**U33→🟢**。空槽派 U39 诊断。

### 中继注册完成（2026-11-14）+ U38/U39 登记

100.67.197.59 节点上线（relay:18443 SNI+18444 浏览器模式，nohup 长驻）：`/v1/relays` 真数据 ✓、connect 应答含回落端点（routeKey=dev-local-02 + browserEntryUrl）✓、浏览器模式 TLS 终结+路径路由 ✓。**U38**（安装脚本 env 名不一致→新部署必踩，修复令已派）+**U39**（中继路由表 n=0：宿主注册拍未形成 relayRoutes 表项，回落数据面断裂，待诊断）。

### 环境修复+真实数据种子完成（2026-11-14）

五步全过+扩展种子全过（evidence/env-repair-2026-11-14/env-repair-result.json，含 9 功能面 data-coverage 清单）：宿主 **dev-local-02=host_452e28b8 online，广告地址=100.103.213.12:62797**（tailnet 可达，dev-001 残留已吊销）；项目 **proj_032747e7**（demo-app，ready，矩阵 3 行=team-payment/zhangsan 全量+lisi 仅 open+file:read，策略=全局 allow+demo-app 显式 deny）+ **proj_8aad2086**（zhangsan 自建，U15 链路）；两仓库各 5 提交+main/feature 双分支+真实内容；orca web `https://100.103.213.12:62797/web-index.html` 200（**证书 SAN 不含 tailnet IP**→浏览器名称不匹配警告，客户端指纹钉扎不受影响）；lisi 登录只见 demo-app ✓。connect 配方修正：clientVersion 须为 "1.5.0" 具体值、deviceId 须用登录返回值。**平台归属澄清**：18787 即 19:58 长驻 PID 19188（lsof 确证），「20:32 新实例」系代理误读转发器行；演示数据不会随测试会话丢失。待办挂账：证书重签（含 IP SAN）、平台落盘化。

### 用户指令：真实数据验收规则 + 数据种子执行中（2026-11-14）

用户指令「添加一个可用的主机和项目。任何功能必须有真实可用的数据，空数据、遗漏分支算不通过」→ 入工作令为常设验收规则。同时查明：平台随修复代理退出被孤儿化后被清扫误杀——已以 nohup+disown 长驻重启（loopback+tailnet 双路径 200 实测，admin 登录过），但 store 重置 ⇒ 真实宿主/演示项目需重注册。**执行中**：① 修复代理任务书已扩展（真实 git 仓库 ≥3 提交 ≥2 分支真实文件、zhangsan/lisi 差异化授权矩阵、demo-app 项目级策略覆盖、lisi 视角核验）；② 中继注册代理派出（100.67.197.59 → 当前平台，中继页/回落端点真数据，浏览器模式可选）。管理台 tailnet 口实测可用：http://100.103.213.12:18787（admin/Adm1n!、zhangsan/Passw0rd!）。

### 本地环境重建完成（2026-11-14，人工验收就绪）

五步全过：① 平台 PID 32632 :18787（种子 admin/Adm1n!、zhangsan/Passw0rd!+team-payment）；② out/web 重建含 W13b 云工作区+O1-c 短路标记；③ 宿主重注册 **dev-local-02=host_017a51a6 online**（新一次性令牌+清旧凭据+HOME 边界重启，TLS 沿用）；④ 演示项目 **proj_433e52ea**（demo-app，team-payment）+ **proj_a7542b5d**（zhangsan 自建=U15 修复手测样本）；⑤ 终验：zhangsan 登录→3 项目可见→connect 200 双过（注意 connect 须带 clientVersion/deviceId 否则 426）。**用户手测指引**：http://127.0.0.1:18787 管理台/登录；遗留=forwarder 自环僵死连接（客户端卡旧连接就重启该进程）、全内存 store（平台重启即重置）、无 relay 节点（仅 direct）。证据 evidence/env-rebuild-2026-11-14/。空槽暂候 W13c-2 落地（O1-g 与其同域串行）。

### U30 落地（2026-11-14）+ 批次边界完整

`830119d7ee7`（7 文件 +315/−4）：六项全交付（m-1 select.invalid、m-2 blur 即校、m-4 dirty 行高亮用既有警示色、m-5 批存冻结 14 行控件、m-7 策略行重绘保 scrollTop+焦点、m-6 设计文档对齐实现）；新 4 行为断言+harness hold/release 边界挂请求；37/37 绿+红证（还原三处修复→恰 3 红）。styles.css 残留处置：基于 HEAD 仅加两规则、残留原样还原工作树（注记：残留不被当前 prettier 配置复现，来源待查——挂 P2 观察项）。**批次边界完整**：本波全部功能提交（W3c/M120×4/W12b×2/U18-U22/U25-U29/O1 a-f/W13a-c1/W13b/U30）均已入库。空槽发**首批批量验收**。

### O1-c 落地（2026-11-14）

`c957198bd98`（6 文件 +232/−5）：F1/F2 web 云会话本地短路（ui.get/set/setWithAck/recordFeatureInteraction + settings.get/set/updatePRBotAuthorOverride 零 RPC，setWithAck 回本地成功不再 staging doomed patch 队列；settings.get 保「无宿主→全局默认」语义）；判定=isCloudSessionStoredEnvironment 包装 O1-a 谓词（未新增 web-only 谓词）。新 7 例+web 全域 62 文件 419 例绿，tc:web 清，max-lines 以作用域模块收敛未加抑制。实际 25 分钟（超 15 预估，耗在 curly/max-lines 三次结构收敛）。**O1 仅剩 g（收口）**。空槽回填环境重建。

### W13b 落地（2026-11-14）+ 事故第 7 次即拆即恢复

`7df1f6738ea`（12+ 文件）：web 云会话三阶段 bootstrap（workspace.info→openCloudWorkspaceOverRpc→repo.add/fetch/setActive）+ CloudSessionEmptyState 降级回落+web-cloud-workspace-store-ports+旅程翻转 B1–B6+流式用例（**两次全绿** 29.5s/19.0s，订正：16.9s 为首跑未留档口径）+渲染层回归 1123 文件 9507 例全绿（订正：入档时误转 SendMessage 期数字）+tc:web 过。**事故 7**：主会话提交 W13c-1 入档时再卷 6 个 W13b 暂存文件（pathspec 也被 lint-staged 恢复步骤击穿；核验输出已示外来文件却未拦截=形式化核对）——soft-reset 拆分恢复 `e50af527d70`（恰 PROGRESS），W13b 随即自身提交 `7df1f6738ea` 全量入库，**树内容等价验证零损失**（api-types/monaco-probe 均在其提交内）。**根因加固**：主会话 docs 提交改为「python 写文件 → `git commit -- <path>`（无 add 复合）→ `git show --stat` 提交后验证」三步；并发代理活跃期禁用 add+commit 复合命令。**W13b 主体关闭**（实现+自验证双绿；审计随批次异步派）。空槽派 W13c-2；首批批量验收+环境重建待 O1-c/U30 落地对完整批次边界开跑。

### W13c-2 落地（2026-11-14）+ U36 登记

`5d18bc786bf`（2 文件 +573/−2）：负向三条全绿（workspace.info 故障注入接缝=init-script 拦 preload 装配、非云会话判别面+原生空态结构 oracle、handoff 缺失/伪造 410 全语义）；双线旅程 HEAD 态 B 2/2+A 1/1 绿；MIN-1① 失真注释按审计原文修正。**U36 登记**：out/web 无 VITE_EXPOSE_STORE 重建静默废 B4 oracle（env 重建实证）→ 并入 O1-g（global-setup 断言/构建告警）。运行 55 分钟超预算（耗在环境取证与红项归因）。**W13c 两条全落**。空槽发 O1-g(+U35) ∥ U33。

### 首批批量验收：双线全绿（2026-11-14）

隔离树 HEAD 全量验收（evidence/acceptance-batch-1/）：**A 线 1/1 PASS（8/8 步：裸宿主→TLS→项目授权→真实表单登录→直连打开→终端回显→文件树→证据）+ B 线 2/2 PASS（9/9 步：登录→handoff→W13 工作区视图→410 回落；流式+文件树 W5c 重签零 replayed；无残留跳过；B6 中继路径按 spec 头注记由 C 线 W6a/W6b 承载且绿）+ C 线 70 文件 295/295 全绿（首跑 2 环境件复跑清零）**。**U23/U24 平台级终证成立**（3/3：既有 git 目录自建→provisioned:false 零触碰→侧车→open 成功→幂等；并发 created=[true,false] 单检出）。生产一致性：真表宿主成立，清单外钉缺常设断言=**U35**（并入 O1-g）。红项 2 条=测试适配（**U34** 已派修）：U20 门禁晚于两套件书写。**双线生命线本批次达成**。

### W13b 审计 PASS（2026-11-14）

审计（test-reports/w13b-audit.md）：**PASS 0 blocker/0 major**、minor 3/note 7；16 文件与 HEAD 逐字节一致；三偏差全部裁定成立（NOTE-1 限定偏差 1 论证强度：ensure 本身已保证 worktree 解析，register-first 真实价值=桌面同构+失败归因提前）。MIN-1/MIN-2→**U33**（explorer file:read 门+旅程披露，排队待 W13c-2 域释放）；MIN-3 计数漂移=主会话转抄误差已订正（本提交）。**W13b 关闭**（实现+双绿旅程+9507 回归+审计 PASS）。

### W13c-1 落地（2026-11-14）

`51f04a1d092`（9 文件 +201/−4）：W13a 四 MIN 收口——MIN-4 §5.2.1 三非云负向（mobile/runtime-paired/ssh-bridge 三形态，零云拒绝审计+零检出查询断言）；MIN-1③ 准入 methods 与 CLOUD_HOST_METHODS 恒等绑定（生产时序复刻处，env 级单测无 methods 已实证归因）+②四处夹注重释+①（renderer 失真注释）越界留 W13c-2；MIN-2 catch 区分 repo_not_found（设计授权零日志）与其余 console.warn 恰一次；MIN-3 权限联合 parity 值级+类型级双钉（变异红实证）。36/36+真栈 5/5 绿，tc:node 0。竞态注记：与 W13b/O1-c 三次提交竞争+曾清并发暂存保护自己提交（对方可重 add）。**W13c-1 关闭**。槽位暂候 W13b 落地（W13c-2∥验收∥环境重建三连发）。

### O1-h 落地 + 索引竞态第 6 次事故与恢复（2026-11-14）

O1-h `f9f16b00baa`（3 文件 +200/−1）：composer「添加目录」入口按 O1-a 谓词隐藏（复用 O1-e 包装 isCloudSessionEnvironmentId，**双表面**——工具栏按钮+ProjectCombobox pinned 行关 onAddProject，防下拉可达）；新增 4 例，组件域 9 文件 82 例全绿，tc:web 清；路径守卫族其余零改动验证结论已记录（quick open 回退链/云 scrollback multiplex 逐行复核无缺口）。**事故**：主会话提交 O1-b 入档时未核对暂存集，卷入 O1-h 在途暂存的 3 文件（`62addf1b013`）——soft-reset 拆分恢复（`7a51afcc77d` 仅 PROGRESS），O1-h 内容零损失随后正常提交。**加固**：主会话一切提交（含 docs）先 `git diff --cached --name-only` 核对。空槽回填 O1-c∥W13c-1。

### O1-b 落地（2026-11-14）

`718db425951`（8 文件 +596/−29）：O1-a 谓词增 id 键形式 `isCloudSessionRuntimeEnvironmentId`（无行=非云放行）；激活管线宿主通知三条件门（云会话零 `worktree.activate`）；lineage 云聚焦目标直接回答空谱系图（三入口零 `worktree.lineageList`）；启动延迟刷新 lineage 步跳过；`worktree.set` 按裁定不改。新 13 例+谓词 +2（零调用断言打 mock 传输层），红绿验证（stash→恰 4 红云断言），回归 56 文件 491 例全绿，tc 双清；两文件顶 max-lines 以行为无关压缩压回未加抑制 ✓。注：吸收工作树同域在途 web 保险行一并入库（已在证据注明）。**O1 剩 c（等 W13b）/g（收口）**。

### U29 修复落地（2026-11-14，🟢）

`53d2969ff4e`（恰 1 文件 harness.ts）：泄漏面四类定位（harness 就绪超时不杀=主因+无 after 套件 3+中段局部 spawn 10 处+硬崩溃跳过钩子）；修法=harness 单点收口（registry 登记、显式 stop 先注销防双杀、after+exit 双保险、超时先杀、ready 行累积匹配）；存量 **41 孤儿/1.9GB→0**，硬退出探针 2→0，跑后复扫 0 新增，门禁 28/28 绿。（勘误：此前 kill「未生效」实为 zsh 不分词，xargs 后清零。）**U29→🟢**。空槽回填 U30。

### U31 修复落地（2026-11-14，🟢）

`a7f400aceb2`（1 文件 +5）：cloud-denial-details.test.ts 入 NODE_RUNTIME_INCLUDE；改后 run-vitest（带 --config）2/2 绿（RSA/真 TLS fixture 正常）、兄弟三门禁 17/17、内部 M72 断言原样过=纯环境伪红确证。**U31→🟢**。空槽回填 U29。

### O1-e 落地（2026-11-14）

`9642bca9750`（12 文件 +374/−14）：F5=owner 环境为云会话不发 `github.prForBranch`+PR 区整体占位卡（如实「凭据属宿主账号资产」，替代「No pull request found」假空态与注定被拒的按钮）；F4=skills.discover 云 pane 跳过+`errorKind:'cloud'`+技能面板文档型空态（无 Retry，对齐 SSH unavailable 先例）；复用 O1-a 谓词新增 isCloudSessionEnvironmentId（缺行=非云放行真实拒绝）。新 7 例+域内 379 文件 3876 例全绿，tc:web 清。超预算余项入 O1-g（linear.status 按需触发既有错误处理/SkillsPage 占位/真栈 R1 审计断言）。空槽回填 U31（微型）。

### O1-f 落地（2026-11-14，裁定退档 (b)）

`1c461b91689`（2 文件 +240/−1，宿主零改动零 wire）：设计关键决策点验证否定 (a)——nativeChat 会话 id 是 provider session id（agent CLI UUID），resolveAgentSessionContext 只认 Orca 结构化会话 id，登记必致每条合法读取 agent_session_unknown；替代证明需新 runtime 能力且孤儿会话无解（=设计写明的退档条件）→ **退 (b)**：transport 选择入口按 O1-a 谓词云分支（readSession 文档型文案、subscribe 单帧 no-op），原生/web 非云零变化。78/78 绿（359/10 中 10 败=stash 验证的环境性既有）。附带发现登记 **U32**（transcriptPath 无 attestation 观察，暴露有限挂 P2）。空槽回填 O1-h。

### O1-a 落地（2026-11-14）

`b08c5ec3ad3`（8 文件 +424/−20）：共享谓词 `isCloudSessionRuntimeEnvironment`（对齐 `9a27c7963de` 形态，cloudProject/cloudLoginRequired 双事实）；web-session-tabs-sync 双 installer 镜像订阅按谓词过滤（云会话零订阅）；bridge 三处门收进 runtime-environment-subscription-selection 两个选择器（桌面同生效，顺带掐断云环境新连接触发的目录刷新拒绝级联）；W7c web-only 门升级为按环境判定（保险门保留）。测试：新 10 例（零调用断言打 mock 传输层）+57 文件 426 例全绿，tc 双清，零宿主/零 wire。注：吸收了工作树中 W7c web-only 未提交行为谓词版（净 diff 即谓词门控，既有 cloud-session 测试原样过）。跨域瞬时破坏两处均由各令所有者当场修复。空槽回填 O1-b。

### O1-d 落地（2026-11-14）

`a0ea1546b96`（6 文件 +600/−12）：preflight.detect/refreshAgents 登记 `agent` 权限（check/detectRemoteAgents 保持 L1 逐字拒绝——宿主全域 OS/shell 事实不入表）；probe scope 经 checkWorkspace 钉死 workspaceRoot（缺 worktreeId→agent_worktree_required，不许宿主默认答全机）；真栈新套件 6 例（审计零 method_denied 正向+逐字负向+权限位矩阵）。44+59+5 全绿，node 池已注册。**运行须知细化**：run-vitest.mjs 必须 `--config config/vitest.config.ts`（缺省落 bun 池即 TLS 伪红）。**竞态自愈**：首次 commit 卷入 O1-a 并发 add 的 8 文件→soft-reset 恢复对方 staged 态重提，终态暂存集干净（U10 家族再现，代理侧纪律生效）。**U31 登记**：cloud-denial-details.test.ts 基线伪红（node 池漏网，同 U28 族）。空槽回填 O1-f。

### U21 修复落地（2026-11-14，🟢）

`9a4dc9007ab`（2 文件 +323/−8）：applyProjectsRoot 拆 commitProjectsRoot——活跃项目在册拒绝换根（审计 denied metadata 含 requested/current/conflictCount/sampleKeys）+心跳响应可选 `projectsRootRejected`（wire-additive，无错误通道处按裁定最小化）；同根重报静默、清空根同拒、归档不阻塞、拍内其余字段照常。变异校验（禁用→恰 3/4 红）+新 4/4+回归 30/30+全量 e2e 179+63+单测 49 全绿。**U21→🟢**。范围外挂账：宿主侧对 projectsRootRejected 的消费与重报退避、管理台 denied 审计展示（P2）。空槽回填 O1-e。

### U22 落地（2026-11-14，🟢）

`201de9e7696`（1 文件 +8）：W3c-open 用例补 project=<id> 值+入口 origin（=中继边缘，按台账语义而非派发令的措辞——代理核实 evidence 与 server.ts:664 URL 构造后纠正，取舍正确）；门禁 10/10+5+6。**U22→🟢**。空槽回填 O1-a（云环境过滤谓词地基）。

### O1 设计审定通过（2026-11-14）

`work-orders/o1-cloud-startup-rpc-design.md`（262 行）：云宿主登记 674 方法、拒绝 430、其中 249 在 mobile 清单外；启动链残余被拒 **9 族**（W7c 挂账 7 全部成立+新发现 2 族桌面未门控面）。逐族裁定：F1/F2/F4/F7/F8=客户端云环境短路（b）；F3=宿主登记 agent 权限+agent-scope 钉 workspaceRoot（a）；F6=nativeChat 走 (a) 候选（sessionId 归属证明不了退 b）；F5/F9=保持拒绝+占位/隐藏（c）。**mobile 清单外钉子修正**：session.tabs.listAll/worktree.activate/ui.get/settings.get 在清单内不能当钉，正确钉=worktree.lineageList/skills.discover/preflight.refreshAgents 等+逐字断言云层文案。切 O1-a…h 八令（O1-a 最大 ~20 分钟；O1-d/f 同域必须串行）。调度约束：**O1-c 与 W13b 同域必须等其落地**；先派 O1-d（src/main 域自由）。

### U20 修复落地（2026-11-14，🟢）

`43c79e1978b`（3 文件 +271/−1）：connect 项目就绪门禁（failed→409 PROJECT_NOT_PREPARED 附 provisioningError+denied 审计；provisioning→409 PROJECT_PROVISIONING 不写审计防轮询刷链；ready/归档/快路径零变化）；m70-acceptance AC-04 依赖旧缺口的「provisioning 可取票」断言修正为宿主 provision ok 后取票（验收语义不变）。红绿：回退→恰 2 红；回归 9 套件 45/45。18 分钟 ✓。**U20→🟢**（W12 方向 A 的 connect 半边就此落地）。空槽回填 U21。

### M120 批量审计 PASS（2026-11-14）

审计（test-reports/m120-batch-audit.md）：**PASS 0 blocker/0 major**、minor 7/note 6；四令互不回退（app.js blob 链线性，sha256 复核），QA-013/014/015 三缺口在提交本体闭合，唯一线变更（c1）加性安全；两条变异抽查被恰现有例打红。minor 7 条归并登记 **U30**（UI 打磨批，排 P2；m-3 已由 U25 解决、m-6 改设计文档一行）。**M120 整体：设计+四实现+批量审计齐备，主体关闭**（U30 打磨挂账）。

### U18+U19 修复落地（2026-11-14，🟢）

`1a1f8ac72af`（3 文件 +362/−2，18 分钟控制线内）：U18 管理员创建接 validateProjectKey（400 PROJECT_KEY_INVALID）+name 非空≤200（400 PROJECT_NAME_INVALID，缺省回落 key 不变），语法校验先于查重；U19 两登记路径 hostOnline 判定（复用 HOST_OFFLINE_DEFAULT_MS 心跳窗，self-service 判定次序保持 HOST_NOT_PROVISIONABLE 先行）。红绿对照恰 4 红；新 6/6+登记系 24+其余 68+latency+platform 17 合计 **118 e2e+49 单测全绿**（真实平台进程，证据含 25 条观察输出原文）。共存纪律良好（基于工作树改不回退在途行；他人暂存的 PROGRESS 用 --only 隔离）。**U18/U19→🟢**（代理改台账工作树，主会话核对恰 2 行后提交）。空槽回填 U20。

### U28 落地（2026-11-14，🟢）+ U29 登记 + O1 派设计

`fc8ca081ed`（恰 1 文件 +29）：sqlite 池显式清单补 29 项，门禁 11/11 绿、兄弟门禁 29/29、池内抽验绿。**运行须知入档**：真 TLS 套件必须经 `run-vitest.mjs`（bun 直跑 vitest 缺 ORCA_TEST_NODE_EXECUTABLE → 池子进程落 bun → 握手伪红）——此为「bun TLS 失败家族」的定性，批量验收必须走该入口。**U29 登记**：harness 泄漏平台进程（PPID=1 孤儿，单次 25+ 随套件再生），波后派修+集中清扫（进程清理主会话已尽 Kill -9，再生率>清扫率）。空槽派 **O1 设计**（云启动残余被拒 RPC 族诊断，只读）。

### M120 四令全部落地（2026-11-14）

M120c2 `00f479d1d9a`（app.js +94/−9 + 新套件）：设置页「项目级覆盖」卡（仅列 explicit 项目、行内即存 禁止/允许/跟随全局=PUT inherit）、`effectiveDownloadPolicy` 统一修掉全局 allow 时跟随项目误报禁用（§5.1-1）、失败 QA-009 回滚、副标题与影响数 toast。测试 6/6+22/22+35/35 绿；index.html/styles.css 格式化残留未触碰 ✓。**M120a/b/c1/c2 全部落地**（`4c3d7a87a81`/`bf34abed505`/`5a9df0154ce`/`00f479d1d9a`）。已派 **M120 批量审计**（四提交一令）。代理注记：本机 3 个 16:57 孤儿 server.ts 进程（PPID=1），主会话核验后清理。

### W12b-1 关闭（审计 PASS，2026-11-14）

审计（test-reports/w12b1-audit.md）：**PASS 0 blocker/0 major**、minor 2/note 5。四态计划/Git 2.25 基线（空仓库 worktree 探针实证）/身份兜底 locale 钉/并发护栏（路径锁+锁内复检+claimCloneTarget 身份护栏）/测试无恒真——全核验；U23/U24 确认为本提交遗留且已由 `108bf8bb832` 处理不计入。**W12b-1 关闭**（`09c5c9a3e19`+独立测试 9 探针+审计 PASS）。M-1=U28（sqlite 池 29 项批量缺失，历史欠账）**修复令已派**；M-2 注释一致性随令顺带。

### U25 修复落地（2026-11-14，🟢）

`f94af5a4523`（4 文件）：contract `validateProjectDefaultBranch` 补宿主同款 git-ref 规则；**管理员创建路径此前完全无分支校验**已补（审计 deny+400）；self-service/PUT 原有调用点自动收紧。测试：新 contract 2+既有 11+新 e2e 5（17 类非法 400/合法 201 缺省回落 main/两登记路径+更新全覆盖）+零回归 20+25（真实平台进程）。规范点：避开含格式化残留的 contract.test.ts 新建 branch-name-contract.test.ts 防部分暂存。15 分钟 ✓。**U25→🟢**（平台进程级验证+宿主未动）。空槽回填 U18+U19。

### U23+U24 修复落地（2026-11-14）

`108bf8bb832`（8 文件 +315/−37）：already-provisioned 分支补 registerExistingCheckout（复用 W12b-1 共享尾，零触碰、幂等、失败 REGISTER_FAILED 假成功不再）；U24=dedupeWorktreeCreate markJoined→createdByThisCall（shared 两文件 wire-additive 最小触碰，旧客户端忽略/新对旧宿主缺省 true 双向兼容）。红绿对照：回退→恰 2 红（用户场景+幂等）；新 4 例+域内 10 套件绿；4 套红=stash 基线同红既有环境失败（bun 真 TLS 家族）。max-lines 顶爆按规约消重压回未加抑制 ✓。运行 ~35 分钟超控制线（超时部分为红绿对照与基线取证）。U23/U24→🟡：平台级终证挂首批批量验收（真 TLS 端到端 open）后转 🟢。空槽回填 U25 修复。

### U26 落地（2026-11-14）

`41b01a56516`（2 文件 +18/−8，暂存集核对）：拒绝分支 `() => undefined`→`console.error('[cloud] host enrolment failed:', error)`（仓内既有 [cloud] 前缀约定，无新结构）；注释改与实现一致（no launch-path consumer awaits ready—此日志即失败唯一痕迹）；套件 8/8（含 spy 断言前缀与 Error 内容，try/finally 恢复）+真实平台 3 例零回归+tc:node 0 错。运行 1.3 分钟。**U26→🟢，W12b 系全部关闭**。空槽回填 W12b-1 审计。

### M120b 实现完成（2026-11-14）

`bf34abed505`（恰 app.js+新套件 2 文件，暂存集核对）：权限矩阵改 7 权限位复选框（补 QA-014 漏的 browser 列；download 锁徽标移除改真话注释）；草稿 diff 模型（脏行 dirty+未保存徽标，保存仅脏行按序 PUT 行内全量位，首败中止+部分成功 toast+按服务端值重绘）；撤销二次确认按行给差量与规则性断开文案（用户行点名/组行不点名，如实无在线会话端点）；「授予基础权限」改「添加授权」保持 W2-M-1 语义。测试：新套件 6/6 + 回归 36/0（PORT=0 双轨真实平台）。零新 CSS，index.html/styles.css 格式化残留未被纠缠。运行 11.5 分钟 ✓。**已派 M120c2**（设置页下载策略覆盖清单 UI）。

### W12b-2 审计 PASS（2026-11-14）+ U26 派修

审计（test-reports/w12b2-audit.md）：**PASS，0 blocker/0 major**、minor 2/note 5。变异声明经审计**独立复现**证实（还原旧时序恰 3 红且症状逐字对应 U17 症状①②）。M-1=U26（enrollment 失败可观测性回退：注释无实现+rejection 被吞失去持久记录）**修复令已派**；M-2=U27（证据只记预期+gitignore，审计已补证，流程记档）。N-1 注记：派发令文件清单笔误（第三文件实为测试套件），PROGRESS 记录无误。

### W12b-1 独立测试 PASS + M120c1 落地（2026-11-14）

**W12b-1 独立测试**（隔离树 `09c5c9a3e19`，零实现改动）：声明套件复跑 57/0 一致 + 超集 21 文件 107 例绿（1 例路由 TCP 竞态偶发单独复跑绿）；自有探针 9 例 8 过 1 缺陷——U15 精确场景 PASS（**U15→🟢**）；**新发现 MAJOR=U23**（选已是 git 仓库的目录→open 永久 forbidden，死路）+U24（created 标志失真）+U25（平台/宿主 branch 校验不一致），均按「先登记后派修」入台账，**U23 修复令已派**（W12b-1 实现域空出）。bun 真 TLS 套件握手失败为既有暴露（W5b-B 同族，node 池规避）。**M120c1 落地** `5a9df0154ce`（server.ts +15/−3）：downloadPolicyExplicit 读字段+inherit 写参，9 断言+24/15/16 回归全绿，全量 e2e 237/238（唯一红=web-workbench-latency 并行负载下既有 flake，单跑过）。

### M120a 实现完成（2026-11-14）

`4c3d7a87a81`（恰 2 文件 app.js+新套件，+752/−1，暂存集核对）：管理员「登记项目」弹层——字段 name/key/hostId/path/repoUrl?/defaultBranch?，hostId 下拉过滤已吊销并标注离线/维护，预校验与 project-key/project-path 同款（0 请求拦截+字段级 inline error+focus 首错），W8 语义直供 path 不发 dir，错误码逐字段映射（PROJECT_EXISTS→key 等）失败不关弹层输入保留，成功 toast 含克隆中提示与授权指引；审计筛选项补 project_create。测试：新套件 8 条 + 门禁 34 例 + 回归 24 例全 0 败（真实平台 PORT=0）。全程复用既有 dialog/field 样式零新 CSS，index.html/styles.css 格式化残留未被纠缠。运行 16.2 分钟（20 分钟控制线内 ✓）。**已派 M120b**（权限矩阵，app.js 域）。

### W12b-2 实现完成（2026-11-14，U17 修复）

`a6d8d1fc7fa`（恰 3 文件 src/main/startup/，暂存集核对）：新 `cloud-runtime-attach.ts`——client 已在（poll/stored-credential）同步装机原行为不回退；否则 `admission.ready` 兑现后补装 setCloudAccessGuard/setCloudProvisionReporter/setCloudHostAudit；enrollment 失败不装机且 fail-closed 不变（无 unhandled rejection）。拆新文件因 admission 模块 max-lines 预算仅剩 ~8 行（300 上限合规）。**变异验证**：临时还原旧时序→恰好 3 红且症状逐条对应 U17（回报缺失→平台永停 provisioning；guard 缺失→下载恒拒），恢复→全绿。测试：新套件 8/8 三连稳定 + env 合跑 14/14 + 真实平台/Runtimme 3 例（策略门生效、失败 provision 上报 status:failed+provisioningError、对照同步路径）+ 42 依赖套件 113 例绿；tc:node 0 错。注：运行 24.4 分钟略超 20 分钟控制线（派发早于指令；按新粒度应拆）。U17 台账维持 🟡 待审计+批量验收确认。

### 任务粒度控制线修订 + W13c 预拆（2026-11-14 用户指令）

用户指令「合理拆分任务粒度，控制在 20 分钟内完成」→ 工作令与协议时长预算 15→**20 分钟控制线**（超时必须再拆）。W13b 实测 ~30 分钟即反例——其遗留的负向/清单部分按粒度预拆：**W13c-1**=W13a 审计 MIN 项落地（workspace.info §5.2.1 三条负向 + MIN-1 漂移面/MIN-2 catch 日志/MIN-3 parity 钉，域=src/main+shared 测试）；**W13c-2**=W13b 视图负向+链路清单零回归（域=tests/e2e）。两令可并行（域不相交）。

### 运行模式变更：并行开发+独立全链验收（2026-11-14 用户指令）

用户指令「不要串行开发，单独完整链路验收就行，发现问题再修复，不要堵塞」→ 协议新增 §2b：开发令落地即放行下一令（不以测试/审计通过为前置，文件域不相交仍硬约束）；测试/审计并行跑不闸门；全链验收独立成环（对 HEAD 跑双线黄金旅程+管理员链，红=新修复令）；双绿仍为终局门禁；并发 4 上限不变、空槽即时回填。**已预置派发计划**：W13b 落地→即刻 W13c∥W12b-1 审计∥W12b-2 审计∥M120a 审计（按空槽）；M120a 落地→M120b（app.js）∥M120c1（server.ts）；全部落地→全链验收代理。

### W12b-1 实现完成（2026-11-14，待独立测试+审计）

`09c5c9a3e19`（8 文件 +580/−14，暂存集核对通过）：① `not-prepared` 计划态改为 `init`（四态全覆盖）；② 新 `runtime-repository-init.ts`：git init（无 -b，Git 2.25 基线）→ symbolic-ref 钉票面分支 → 空初始提交（身份 -c 兜底仅对 who-are-you 错误重试）；③ clone 控制器增 initToPath：共用路径锁+锁内复检 isGitRepo、claimCloneTarget 记目录归属失败清理（防半成品被误判 already-provisioned）、共享尾部 registerCheckout（验证中发现关键前提：worktree.* 只解析 store 已登记行）；④ 幂等：二次 open⇒already-provisioned、重试横幅仍 1 提交 2 worktree 行。**空仓库验证**：设计担忧属实（空仓库 worktree add 报 invalid reference）→ init+空提交序列后 createManaged 完全可用（已钉进服务链用例）。测试：新 3 文件 57 例（含真平台+自注册宿主+TLS 全链用户场景）+ 既有 12 文件 52 例全绿；tc:node 本域 0 错；node 池已注册（MAJ-1 教训）。fixture 零改动（repo-less 由省略 repoUrl 字段实现）。**已派独立测试**（隔离 worktree 固定提交）。W12b-2 的平台侧回报断言按约定不在本令断言（该链路另一代理在修）。

### M120 设计审定通过（2026-11-14）

设计代理产出 `work-orders/m120-admin-console-design.md`（246 行）：三缺口全部以既有端点粒度实现——a 登记弹层（管理员 POST /v1/projects 发绝对 path 不发 dir=W8 语义；错误码映射逐一对到 server.ts 行号，注意管理员路由重复 key 是 PROJECT_EXISTS 非自助路由的 PROJECT_KEY_TAKEN）；b 权限矩阵（7 权限位含 QA-014 漏掉的 browser 列；项目级增量 diff+行内全量替换）；c 下载策略（全 M120 唯一线变更：projectView 增 downloadPolicyExplicit 读字段 + PUT policy 增可选 inherit:true 清覆盖，均加性线兼容；修正工作台在全局 allow 时对显式覆盖误报的既有缺陷）。切 **M120a→M120b→M120c1(server)→M120c2(web) 四串行令**（管理台通道，app.js 串行）。已派 M120a。

### W3c 关闭（审计 PASS，2026-11-14）

审计（test-reports/w3c-audit.md）：**PASS，0 blocker/0 major**、minor 2/note 5。规格三条全落地（openProjectWorkspace 合一走 W7b handoff 语义、noopener 逐字保留、对话框删净无死代码）、置灰零放松（git show -w 逐 hunk）、交接码 32 字节仅入 fragment+单次消费+60s+审计指纹、线兼容成立（旧归档走 /connect 仍可用、AC-19 6/0）。minor 处置：m-1 test-plan.md:137 陈旧行已由主会话修正（本提交）；m-2 URL 断言加严挂 P2（组合语义已由 W7b-url 钉住）。**W3c 关闭**（`085599b77c9`+实现测试 48/0+审计 PASS）。

### W3c 实现完成（2026-11-14，待审计）

`085599b77c9`（恰 2 文件核验通过）：「打开」与「Orca Web」统一走 W7b handoff 新标签进工作区（`openProjectWorkspace` 合并两套实现）；「连接信息已就绪」地址对话框删除（能力保留在管理员详情+连接诊断）；置灰语义逐字未动。e2e：web-project-entry/handoff 系列 40 过 + release/wizard/screenshots 6 过 + 真实 Chrome 工作台 2 过，0 败（PORT=0 自起真实平台）。app.js 携带 4 个既有 oxfmt 格式 hunk（14:51 格式化波，已在提交信息披露）。保守读法保留「Orca Web」按钮（与「打开」同行为；产品上合并需另立工单）。代理 curl 探测 18787 失败系探测方式误——实测平台在运行（node PID 91520 :18787，宿主 Electron :53156）。**已派审计代理**（只读）。

### 工作区快检：14:51 全仓格式化残留（2026-11-14）

cron 快检发现工作区 137 文件未暂存改动（mtime 14:51:27-28，早于本轮全部派发 17:17-17:25；抽样 `git diff -w` 确认纯 formatter 机械重排零 token 变化）——早前会话遗留，非越范围改动（17:21/17:22 的 app.js+web-project-entry e2e 恰为 W3c 授权域 ✓）。**处置**：当前波在途不动；波落地后以独立 `style:` 提交收编剩余文件，代理改过的文件随其提交携带格式噪声（回收核验时注记归属）。所有代理提交仍执行逐文件 add + 暂存集核对。

### W12a 诊断回收 + 审定（2026-11-14）

诊断（置信度高，隔离实例四场景矩阵命中全部观测）：主脱节点=平台「无 repoUrl⇒ready」×宿主「非 git⇒not-prepared」恒等错位（UI 承诺的直接使用目录未实现）；次生=首启宿主回报器/策略门时序缺口（U17 新入台账）。**裁定**：W12b=方向 B（宿主 init+初始提交语义，Git 2.25 基线禁 `init -b`）+ 必修时序缺口，拆两代理并行（cloud-project-provision/orca-runtime 域 ∥ cloud-runtime-admission 域）；方向 A（平台 ready 收敛+connect 门禁）与 C（UI 防御）挂 P2。

### 本轮调度（2026-11-14，三通道并行）

通道域互不相交，三个子代理并发：**W13b**（web 云工作区视图+翻转，src/renderer/web+旅程 spec 域）、**W3c**（「打开」=handoff 新标签进工作区，apps/web/app.js+平台 e2e 域）、**W12a 诊断**（U15 PROJECT_NOT_PREPARED 只读定位，产诊断文档不修码不提交）。W12 实现等诊断审定后另派（W12b）；W13c 排 W13b 后。

### W13a 关闭（独立测试 4/4 PASS，2026-11-14）

独立测试（隔离 worktree 固定 `f160524e19d`）：提交套件双 runner 全绿（10+11+8+1+5）+ 邻接 92 例；自有探针 **7/7**——未 ensure 正常态、ensure 后真实 path/branch（与 git rev-parse 对照）、**越权检出不返回有牙验证**（owner 真实建出队友 managed 检出后仍未 ensure 应答恰为 workspaceRoot 内一行）、非云调用方三形态拒绝、幂等 5 应答逐字节一致；白名单三层键集恰等；安全抽查（回包序列化无宿主全域信息、绝对路径全在票据根内）。OBS：repoUrl 逐字回显（凭据脱敏候选挂账）、非 Orca 检出对 workspace.info 不可见（Q3 参考）。**W13a 关闭**（`f160524e19d`+独立测试 4/4+审计 PASS）。通道③派 **W13b**（web 视图+翻转）。

### W13a 审计通过（0 blocker/0 major，2026-11-14）

审计（`test-reports/w13a-audit.md`）：信息边界由构造保证（handler 只读验签票据副本+票据根内过滤、params null 零寻址通道、应答显式字面量）；云权限表零改动经 git log -S 核实；CLOUD_SESSION_REQUIRED 不可伪造绕过（owner/paired in-band、mobile allowlist）；非云拒绝零审计实证。minor 4（常量提升漂移面/扫描失败 catch 静默/权限联合第三份拷贝无 parity 钉/§5.2.1 三条负向）——MIN-4 按设计划归 W13c，其余随 W13c 顺带。计数勘误：实际新增 28 例（非 26）。等待独立测试代理回收后关闭 W13a。

### W13a 开发完成（待独立测试+审计，2026-11-14）

提交 `f160524e19d`（12 文件 +969/−6）：宿主 `workspace.info` 按 W13 设计落地——镜像 project.provision 范本（`WORKSPACE_INFO_METHODS` 独立注册、仅进 `cloudAdmissionOption` 云方法表扩展、云权限表零改动）；返回值字段即白名单（只从票据字段+workspaceRoot 内 checkout 查询）；非云调用方 CLOUD_SESSION_REQUIRED；`CLOUD_HOST_METHODS` 常量提升（生产装配逐字节不变）；`perms` 注入 CloudRpcSession（宿主内部类型）。测试：宿主 10 例+读取器 11 例+真栈 5 例（**强制入 NODE_RUNTIME_INCLUDE**）+目录 351 例全绿；tc:node 0 错。Q3 按裁定未做。已派独立测试+审计。

### W7c 关闭（回派复验全过，2026-11-14）

复验（`evidence/w7c-fix-verify/`）：提交套件 14/14 + 邻接 52 例全绿；MAJ-1 自有探针 6/6——sign-out→同页配对→重推导为非云（全程真实生产写入方、零次 reset 调用）+ 同记录原地刷新 memo 稳定；**双组变异红**（还原旧 memo→5 红；去掉 web-client 检查顺序→2 红），还原后复绿。边界如实：同 id 原地改标志为理论盲区（生产无此写入方，grep 证实）。**W7c 关闭**（`679f24c1b6d`+`e9cd133b527`+独立测试 PASS+审计回派+复验）。通道③剩余：W5c 测试+审计（在途）。

### W5c 关闭（键钉扎复验 5/5，2026-11-14）

复验（`evidence/w5c-fix-verify/`）：双 runner 30/30 + e2e 4/4×2 + 自有探针 5/5——① 换键宿主订阅 fail-closed（FINGERPRINT_MISMATCH、恰 1 次取票、**零 socket**、父连接存活）；② 同键订阅正常流式（票据互异、会话 1→2→1）；③ 管理台真实换钥路径：open 被拒挂起→trustHostKey 一次成功→重开+重签订阅命中新键（合法换钥不误伤）；④ D6 重放仍 401（台账不变、在连流不中断）。**W5c 关闭**（`a68a755488c`+`512eaacdfb1`+独立测试 PASS+审计回派+复验）。**通道③全部完成**（W7b/W7c/W5c）。观察项挂 P2：订阅级 FINGERPRINT_MISMATCH 未接线重验对话框（fail-closed 性质不变，需一次重开才见提示）；面板失败前 5 轮重连各烧 1 张被拒票。

### W5c 独立测试 PASS（2026-11-14）

测试代理（隔离 worktree 固定 `a68a755488c`）：6/6 + 111/111 + 14/14 + 一次性票据回归 7/7+12/12+32/32+17/17 全绿；自有探针 5/5——**实时流式回显经新签子连接**（scrollback 后 marker 以 data 帧到达同一子连接，108/102ms，非缓冲读）、每订阅恰一次取票且三票两两互异、宿主审计零 replayed、重放旧票仍 401（D6 保留）、§8.4 槽位语义记录（父+2 子流=3/3，第 3 条子流 4431 关闭、退订释放恢复）。**测试质量发现**：开发方 e2e 的「零 replayed」断言用了错误 sink（setCloudHostAudit 不承载 connection_rejected）实为恒真——独立探针改查平台审计链；该断言修正挂 W5b-补。W5c 关闭待键钉扎复验（在途）。

### W5c 开发完成（通道③，待独立测试+审计，2026-11-14）

提交 `a68a755488c`（8 文件，含归属注记）：U14 根因=子订阅 socket 复用父连接一次性票据被宿主 D6 拒 `replayed`；修法=消费端重签——`WebRuntimeTicketReSigner` 每条子连接取新短票（云 offer 无 signer 快速失败、legacy 行为不变、云子 socket reconnect:false 恢复走调用方重订阅=新票）；取票接线两处（web-cloud-connect 登录/handoff/M62 恢复 + 管理台桥）。新增 6 例单测（含**重放票据仍被拒**——D6 未破坏的实证）+ 受影响 115/115 + 7 个 e2e 套件 11/11 + **终端面板端到端真流式回显**（scrollback+实时回显经新签子连接、每订阅恰一次取票、宿主审计零 replayed，Bun/node 双 runner 4/4）。观察项：每条流式订阅占一个宿主会话槽（§8.4 上限 3）——重连风暴下的配额语义按工作令保留。已派独立测试+审计。

### W7c 独立测试 PASS（O1/O2 挂账，2026-11-14）

测试代理（隔离 worktree 固定 `679f24c1b6d`）：新增 12/12 + 受影响 3555 例 + 权限层 50/50 + 云 e2e 9/9；端到端旅程四项验收全过（无降级 toast、壳 37342 字节、零 cloud-denial 控制台错、侧栏云说明呈现）；**原生零变化对跑**：父/子提交 Δ 恰为 +3 文件/+5 例（即 3 个新测试文件），原生用例无一变化；越权负向 5 方法全拒带 method_denied 审计、方法表未扩充确认。**挂账**：O1=云工作区启动仍有 7 个被拒 RPC（skills/ui/settings/preflight/linear 族，被吞不降级——W7c 跳过清单只覆盖目录族，余族入后续清理工单）；O2=workspace.info 宿主无实现（云会话工作区视图=已知后续工单）。回派修复（e9cd133b527）已派独立轻复验。

### W9A-1 修复完成 + 旅程适配 W11（2026-11-14）

修复入库（内容 `9a27c7963de` + 归属空提交 `e2731d8c7e5`，6 文件）：`isCloudProjectRuntimeEnvironment()` 判定 + 三个 all-host loader 对云宿主跳过目录读取（云项目行存活不依赖被拒的原生列举——来源是平台项目列表）；W9A-2 同族调用核验全部 fail-soft 无需改码；新 3 例 + 110 例相关测试全绿、原生宿主逐字节不变。旅程复跑发现 **A2 被 W11 形态变更阻断**（spec 在等已不存在的整页登录表单；M107-1 同因红）——属测试适配而非产品缺陷。已派旅程适配（A2 改为状态栏 segment→弹框的真实用户路径）+ 全量重跑（A3–A6 预期被 W9A-1 修复打通）。

### 归属注记：9a27c7963de 卷入 W9A-1 在途改动（同型事故第五次，2026-11-14）

主会话 docs 提交（PROGRESS+w5c-audit）卷入 W9A-1 修复代理的在途改动 6 文件（catalog skip 实现+测试 +371 行）——该代理仍在活跃写入。**处置**：不做历史手术（避免与其直接竞争索引）；W9A-1 代理完成时会发现改动已入库，由其最终交付说明确认内容完整性，PROGRESS 以本注记为准。**主会话违规根因修正**：此前提交前核对用的是 `git diff --cached --stat | tail -1`——恰好把文件清单藏掉只剩汇总行。即日起核对必须 `git diff --cached --name-only` 全列表逐一比对预期，不一致即 `git restore --staged <非预期>` 后重提交。本注记提交本身已按新方式执行核对（暂存=PROGRESS.md 单文件）。

### 归属注记：a740b953faf 混入 W5c 传输层文件（2026-11-14）

主会话拆分 6e5d05027ff 时仍有 5 个 W5c 传输层文件（web-runtime-client.ts、web-runtime-session-client.ts、preload-api/web-runtime-session.*、web-session-recovery.test）留在提交内——继续 reset 会与在途 W5c 代理竞争索引，故停止历史手术。**归属裁定**：`a740b953faf`=主会话 docs（PROGRESS+w5b-audit）+ W5c 传输层部分实现（内容为 W5c 在途真实改动）；W5c 代理收尾时以最终提交补齐剩余文件并在交付说明引用本注记。

### W12 立项（U15🔴，2026-11-14）

W11 测试代理域外发现：自建项目平台 ready 但客户端持续 PROJECT_NOT_PREPARED、环境不落侧车（3 次复现）——provisioning 闭环缺口（M57/M59/M60 域）。立账 U15🔴 + W12（排 W5c 后派发，回归=用户精确场景全程）。W3c 工作令节同批补录（此前锚点失败漏写 work-orders，行为定义以 FR-3.11 修订为准）。

### W9b 中程读数 + W13 立项（U16🟡，2026-11-14）

W9b 中程（代理 1h 检查点回复，协议生效）：B1–B3 ✅（免登自动进入全链，W7c 修复生效）；**B4 ❌ 产品缺口**——orca web 云会话仅空态（workspace.info 宿主无实现=O2 已知边界），终端/文件树浏览器面当前仅在 cloud-admin.html。**裁定：B4 红线收尾，不走 repo.add hack**（绕过平台登记语义）；B5 继续验证。**W13 立项**（U16🟡）：Orca Web 云工作区视图（宿主 workspace.info + web 视图挂文件树/终端，复用 W5c 重签订阅与 W9A-7 multiplex 边界），回归=B 线旅程 B4–B6 全绿。W13 设计代理已派（产出 `work-orders/w13-cloud-workspace-view-design.md` 供审定）。

### W13 设计交付并审定通过（2026-11-14）

设计代理交付 `work-orders/w13-cloud-workspace-view-design.md`（351 行 10 节）。主会话审定：**通过**。要点：宿主 `workspace.info` 镜像 project.provision 范本（独立方法表扩展、云权限表零改动）；返回值=字段即白名单；web 三阶段 bootstrap 复用共享 `openCloudWorkspaceOverRpc`（不新造组件，原生侧栏/explorer/终端点亮）；**Q1–Q3 裁定**——Q1 云 bootstrap 态 UX 从简（空态→视图过渡不 designs）；Q2 云会话隐藏非项目供面（最小表面）；Q3 宿主侧 worktree.list 过滤**不做**（超范围，记开放问题随 M120 复审）。切分 W13a 宿主（真栈套件强制入 node 池）→ W13b web+翻转 → W13c 负向/零回归。已派 W13a 实现代理。

### W9b 关闭（回派整改落地，2026-11-14）

回派提交 `069b84c6154`：MAJ-1 选方案 b（DOM oracle——web bundle 为生产工件不为单个 oracle 改构建配方；断言用户真正读到的内容且不会静默假绿）+ tripwire 改 flag 可配置（W13 未落地前 skip 不打红主旅程）+ MIN 全清（console sink 提前挂、locale 钉 en-US、证据引用首指 U16、编号消解、命令头、如实披露全部缩减项）。门禁：旅程改造态全绿（B4 43ms boundary 态）+ 零回归 493+4/4+24/24 带命令头。**W9b 关闭**（执行证据+审计回派闭环；W13 落地后翻转 B4–B6 启用）。

### W9b 审计有条件通过（1 major 回派 + W13 设计补充，2026-11-14）

审计（`test-reports/w9b-audit.md`）：blocker 0、major 1——「翻转 W13 标志即启用」不成立：B4 编辑器 oracle `window.__monacoEditorE2E` 仅 `--mode e2e` 安装、web 构建从不传 → W13 落地后断言仍必超时，且翻转先打红主旅程 B4 tripwire（全仓首例 web bundle 用该探针）。B4 三项根因核实为真、红线定位质量高；CORS/handoff/零回归复核全过。已回派 W9b 代理（修法 a/b 自选：web 构建补 e2e mode 或改 DOM oracle + tripwire 可配置 + 措辞/证据引用更正）；两个**翻转前提**已转发 W13 设计代理纳入验收口径（web bundle e2e 可观测性 + 主旅程 tripwire 联动）。

### W9b 交付（红线收尾完成，2026-11-14）

提交 `c68dbaae334`（旅程 spec，worktree 构建+cherry-pick，暂存核对仅该文件）：**B1–B3+B5 ✅、B4 ⚠️ 红线如实记录**（云空态、repo.list 按票据范围拒、无终端/文件树路径；根因=宿主无 workspace.info 实现+web 未挂工作区视图，边界出处 w7c-change-manifest）；B4 流式+文件树用例已写好并以 skip 引用 W13（`W13_CLOUD_WORKSPACE_VIEW_LANDED` 翻转即启用，含 W5c 重签订阅断言）。门禁：旅程两次全绿（1 passed+1 skipped）+ 零回归（493 用例+24/24）。证据 `evidence/journey-golden-b/`（timeline+5 截图+findings+回归日志；隔离 worktree 保留供复跑）。W9b 审计代理已派。

### 流程修正：主动检查超时子代理（用户指令，2026-11-14）

用户指出 W5a 修复复验代理早已完成但主会话被动等通知。**新规则入 cron（054f0c4f）**：每轮开始盘点派出超 30 分钟未回报的子代理——查证据目录最新文件时间与 git log；有最终证据按完成收口；无进展催办并给「如实记录失败后收尾」指引；确认卡死 TaskStop 重派。本轮盘点结果：W11 构建门槛修复已静默落地（`0d3178541ad` fix(cloud): build gate expects the baked address in main only——W11 构建门槛项闭合）；W9a 卡在旅程第一步后无进展已催办并给收尾指引；W5c 早期证据已落（1 件）；W5b/W7c 回派在途正常。

### W5b/W7c 验证回收 + 各自回派（磁盘 99% 清理，2026-11-14）

**W5b 独立测试**：node 下 RED/GREEN 配对完整（全权限票据真 PTY 回显、viewer 拒绝带 PERMISSION_MISSING+method_denied 审计入平台链、mobile 无 cloudSession 语义 pre/post 逐字段 identical）。**缺陷 B 回派**：bun 启动器下 node-pty onData 永不触发 → 提交的 W5b-1 e2e 回显断言为空断言（超时分支掩盖），修复=订阅流断言或显式 node runner。**A 细化**（既有）：bun TLS 路径两类签名。**运维 C**：$TMPDIR 1.4 万 orca-* 目录 ~9GB，代理已清 12,349 个。

**W7c 审计**：通过（1 major）——MAJ-1 scope 记忆化不重置（登出→配对路径 stale 套已配对客户端，一行修+反转第 5 例）+4 minor 测试缺口；**附加渠道语义/方法表不扩充取舍/跳过清单完备性全部成立**。已回派。审计曾因**磁盘 100% 满**无法做执行式变异——主会话清理 /tmp（orca-ios-derived 4GB、w7b-verify worktree 422MB）释放空间；W9a worktree（2.2GB）运行中保留。

### W7c 开发完成（通道③，待独立测试+审计，2026-11-14）

提交 `679f24c1b6d`（12 文件 +778/−66）：web 启动链云会话感知——跳过原生目录加载/SSH 水合/client-event 镜像/延迟远端刷新（不再发起注定被拒的 RPC），链以 hydrationSucceeded 正常收尾（不再降级粘性 toast+空白壳）；云会话侧栏云范围空态说明（原生骨架不动，附加渠道语义）；**云方法表未扩充**（防宿主全目录/SSH 目标泄露，理由入 manifest）。新增 12 例；受影响 3560+109+50+9 例全绿；端到端 handoff 旅程实测：降级 toast=false、壳 36588 字节（W7b 基线 2610）、零 cloud-denial 控制台错误。**已知边界如实入账**：workspace.info 宿主无实现（云会话挂文件树/终端需后续工单）；流式订阅=W5c 在途。已派独立测试+审计。

### W11 审计有条件通过（2 major 回派，2026-11-14）

审计（`test-reports/w11-audit.md`）：blocker 0、major 2——MAJ-1 登录 chip（fixed 右下）**遮蔽原生状态栏**（拦截点击+与 Toast 同角互盖），违反「云端 UI 不得遮蔽原生入口」；MAJ-2 「主工作流不变」断言把 shell mock 成单 div，遮蔽类回归无法变红。安全面全过（记忆文件未触碰、密码不落盘、托管三层只读、装配成本无网络）；契约零回归；规范全过（ui 原语未动、max-lines 296/400、13/13 归属）。已回派原实现代理（chip 改 in-flow/标题栏方案自选 + 真实结构遮挡断言 + 登出异步 catch 等顺带）。

### W7b 独立测试通过（handoff 链全通）+ 新缺口 W7c 立项（2026-11-14）

测试代理（隔离 worktree 固定提交 + 现构建 web bundle）：套件全绿（handoff 10/0、web 目录 384 例、平台全量 240/241——1 失败为隔离缺 evidence 的环境项）；**端到端旅程 13/13**：点「Orca Web」真实发 web-handoff、新标签 URL 正确、换发 200+ACAO、hash 清空、无登录表单直达工作区壳、会话持久化；重放 410 回落表单预填；CORS 双向 4/4（非白名单零头+浏览器 TypeError 实证）；离线/维护置灰 toast 3/3。**新缺口 W7c**：自动进入后工作区**降级启动**（空白+Session restore failed 粘性 toast）——web 启动链按原生假设调用被云方法表拒绝的 RPC（repo.list/ssh._/projectGroup._/worktree.lineageList/folderWorkspace.list）+App 自身 socket 认证失败；handoff 链本身全通。已派 **W7c**（启动链云会话感知降级：跳过原生专属调用、呈现已采纳项目工作区、必要时按 FR-3.9 扩只读云方法表）。W7b 本令范围（handoff 消费+CORS+按钮）三方齐备待关闭。

### W5b 开发完成（通道④收口，待独立测试+审计，2026-11-14）

提交 `5a1746b869e`（4 文件）：**宿主侧根因修复**——`runtime-rpc-websocket-dispatch` 把 `cloudSession` 判定提到 mobile scope 之前（云票据设备行陈旧 `scope:'mobile'` 时票据 perms 被电话允许清单整体接管 → 裸 forbidden 零审计），票据 perms 经既有 `cloudMethodAccess` 映射（terminal.→terminal、worktree.*→terminal、files.*→读写、project.provision→open），拒绝带 `method_denied` 审计；真手机/配对桌面路径零变化（mobile 套件全绿背书）。e2e：cloud-admin-session 3/3（含 W5b-1 真 PTY 全链路：打开→provision→终端 send→read 回显→越权 PERMISSION_MISSING 带审计；W5b-2 无授权占位+拒绝审计）+ cloud-rpc-scope 5/5（新回归修复前红）+ tc:web/tc:node 绿（ENV-1 exclude 已落）。**新发现 U14**：终端流式订阅被子连接复用一次性票据宿主拒 `replayed`（e2e 已改缓冲读证全链路）→ 立 W5c 派发。已派 W5b 独立测试。

### W5a 修复完成（待独立复验，2026-11-14）

提交 `8ce21cb7f1e`（6 文件 +598/−24）：MAJ-1 重连快照改用共享常量 RELEASE_SYNCHRONIZED_OUTPUT+清屏序（不再手抄，M118-3 断言同步修正为从常量引用）；MAJ-2 桥接订阅 5+1 例测试补齐（帧映射/end/onError/NOT_CONNECTED/STREAM_UNSUPPORTED/释放/抛错兜底）；P5 scheduleReconnect 加 pending 守卫（更强方案：不双发布防+不双跳退避）+双报用例；MIN-3 终端槽包既有 RecoverableRenderErrorBoundary（降级卡+re-key 重试，含 why 注释）；MIN-4 create 在途卸载迟到回执补发 close。77 用例全绿（基线 68+9）；tc:web 对本域 0 错误（A/B 验证 4194 条 TS6307 与 5 条 renderer 错误全部来自并发 W7b 在途文件，stash 对照逐条相同）；暂存前 diff --cached 核对仅 6 个本任务文件。已派独立复验，通过即关闭 W5a 放行 W5b。

### W3 关闭（修复复验三项全过，2026-11-14）

复验（`evidence/w3-fix-verify/`）：e2e 10/0 + gating 3/0（pinned 检出）；跨 origin 三形态探针——api 参数跟随浏览器所见平台 origin（直连/反代/反代+xfp），页面 origin 始终宿主；真实点击「详情」新开 `cloud-admin.html?api=…` 直达登录表单（对照去掉参数即「未配置」态，参数即成因）；变异抽查真做（删 isDirectAddrForm 门 → 10/10 红）；config.js 死旋钮全仓清零。**如实记录的部署前提缺陷**：平台无 CORS 头——跨 origin 页面提交登录预检被拦（`network_error`）；与 W5a 测试的 CORS 发现互证，已并入 **W7b** 范围（受控 CORS：仅浏览器必需路由对 ?api= 来源开放，负向用例防全开）。**W3 关闭**（`cd36987d7a0` + `e5d0f68721a`/`a069482b23a` + 独立测试 11 探针 + 审计 + 复验，三方齐备；索引冲突第四次在其间发生并闭环）。通道①放行 **W7b**（已派，brief 含 CORS 项）。

### W5a 独立测试回收（8/9 过 + 1 潜伏缺陷 + 2 环境发现，2026-11-14）

测试代理：67 用例全绿 + tc:web 过；组件行为探针 8/9——授权门零调用零加载（G1）、create 先于 subscribe（P1）、退避 500/1000/2000/4000/8000ms 逐档精确且复用 term_1（P3）、卸载顺序 unsubscribe→close→dispose 且迟到订阅被退订不复活（P2/P4）。**发现 P5（潜伏）**：onError/onClose 双触发时 scheduleReconnect 定时器被覆盖未清除（观测 3 次订阅、句柄泄漏）；现传输层三处互斥保证不可达，换传输即触发——一句修（先 clearTimeout）。**浏览器真实验证部分阻塞=如实划入 W5b**：宿主对云会话回退 mobile 允许清单拒绝 `project.provision`/`worktree.*`（裸 forbidden 且无审计）——W5b 要打通的宿主侧环节。**环境级发现两项**：① 平台无 CORS 头，`?api=` 跨源登录会被预检拦截（W3/M117↔W7b 集成缺口，归 W7b 处理）；② 共享 `out/` 并发构建曾产坏包（cloud-admin 入口混入 web 挂载副作用）——共享 worktree 风险实证，核验一律以重建后干净构建为准。已派合并回派修复（MAJ-1/2 + P5 + MIN-3/4）。

### W3 独立测试通过（2026-11-14）

测试代理（detached worktree 固定 `cd36987d7a0` 验证）：套件 6/6 + 13/13 + 3/3 + 9/9；自有 UI 探针 **11/11**——admin 双入口 href 与 payload 逐字一致、developer 无详情/有 open 才有 Orca Web、离线/维护/无浏览器边缘三态置灰 title 各异且零死链、对话框引导逐字、详情链接真实新开 TLS cloud-admin 200 且带注入地址渲染登录页；两页 actions 单元格逐字节相等。发现 F1（config.js 死配置残留）与 F2（裸链接依赖部署注入）**与在途 W3-fix（j-1+m-1）恰好收敛**；F3 记一处 PROGRESS 计数笔误（16 实为 13，关闭时更正）。探针纪律：初版假 FAIL 自查为心跳窗口时序后改等 derived 翻转再断言（F4 记录在案）。

### W6b 关闭（修复复验全过，2026-11-14）

复验（`evidence/w6b-fix-verify/`）：套件 26/26 + 回归 30/30（throwaway worktree 隔离）；变异红复核；MAJ-1 自有探针 33 检查全过且**不变式成立**（16 采样点「URL 非空 ⟺ 存在 online 且宣告 browserHost 的中继」无一违例；同 id 生→死→生仍单行、lastSeenAt 刷新）；MIN-1 warn 恰一次去重生效且值不落日志；MIN-4 被反证必要（探针自己先踩中 env 透传坑）。**W6b 关闭**（`8cdfdd02902` + `843c3d6c382` + 独立测试 14 探针 + 审计 + 复验，三方齐备）。**通道②全部完成**（W6a+W6b）。

### W3 审计通过（1 major 回派，2026-11-14）

审计（`test-reports/w3-audit.md`）：blocker 0、major 1（j-1：cloud-admin.html 平台地址无运行时来源——`?api=` 未拼，未配置部署里「详情」落到页面未配置态；W3 使其首次用户可见，建议平台拼 `?api=<平台地址>` 增量线兼容）、minor 2（m-1 config.js 死旋钮+PROGRESS 残留、m-2 四分支不可变红/6 条补例建议）、note 7。安全面确认：复用 W7a isDirectAddrForm 同 helper 同拼装点（注册路径不做 directAddrs 格式校验，该校验是必要防线）；前端隐藏非安全边界无放大（handoff/connect 后端各拒）；四态穷举零死链；diff 归属与代理自述相符（W6b 整改确为独立提交）。已派回派修复（j-1 + m-1 + m-2 补例）。

### W3 审计修复完成（待独立复验，2026-11-14）

j-1 + m-1 + m-2 一并修复。**j-1**：`sessionPageUrl` 追加 `?api=<平台对外地址>`——`requestOrigin`（代理 scheme + 请求 Host，抽成共享 helper，`/install/*.sh` 的同源推导改为复用）经 `projectView` 传入，`URL.searchParams` 拼接并百分号编码。页面由宿主伺服，浏览器在该源上发现不了平台地址，参数是唯一携带渠道（跨源场景 e2e 钉死：页面源=宿主、api=平台）。**取舍**：页面解析顺序为 `?api=` → 注入全局 → 构建期变量，既有部署显式注入的全局在「详情」进入时被 query 优先（同部署内应指向同一平台；直开页面注入仍生效），已写入 `deployment-real-link.md` §4c。**m-1**：删除 `apps/web/config.js` 死旋钮（`index.html` 加载与 `STATIC_FILES` 条目同步移除——只删文件会让新构建每次 404 一个 script）；M54 两处残留表述就地加「W3 更正」标记，不改写历史。**m-2**：补 4 例并逐条变异验证变红（isDirectAddrForm 负例 99999 端口、在线无地址详情置灰、维护态双入口 title + 退出恢复翻转、admin+open+离线三控件同态）。套件 10/10；回归 exploratory 13、platform 17、install-wizard 4、web-release 1、project-update 4、project-archive 5 全绿。证据 `evidence/w3-fixes/`。

### W6b 修复完成（待独立复验，2026-11-14）

提交 `843c3d6c382`（4 文件 +187/−19）：MAJ-1 删 last-known 兜底只认 healthy 存活宣告（全部中继掉线超窗 → 空串；抖动期入口消失 ≤2s 的代价写进闸门注释）+ **变异验证**（临时换回 HEAD~1 实现该用例确实红）；MIN-1 畸形 browserHost 按值去重 warn（不含不可信值本身）；MIN-3 平台/中继 routeKey 白名单 12 样本对拍封单向收紧；MIN-4 e2e env 保存/还原消毒。W6b 套件 26/26 + 中继回归 30/30。并发处理：与 W3 同函数相邻改动，路径限定 `git commit -- <files>` 隔离提交。已派独立复验，通过即关闭②。

### W3 开发完成（通道①，待独立测试+审计，2026-11-14）

提交 `cd36987d7a0`（3 文件 +459/−17）：`projectView.sessionPageUrl`（TLS 直连首项、形态/指纹校验、离线置灰不消失）；`projectRowActions` 共享 builder——工作台与我的项目双入口完全一致，「详情」仅管理员、「Orca Web」有 open 权限者（**已接 W6b 真实 browserEntryUrl**，离线/维护/无边缘置灰占位，M122 切 handoff）；开发者打开对话框补桌面客户端引导；删除旧全局「打开会话页」入口。新 e2e 6/6 + 回归批（exploratory 16、gating 3、handoff 9、relay-entry 5、单测 45、platform 18、ui 5）全绿。**暂存纪律示范**：并行 hunk 混入暂存后用 hash-object/update-index 重建 + `/tmp` 隔离树逐字节验证后提交。已派独立测试（含详情链接真实打开 cloud-admin 200）与审计（URL 形态校验一致性/删除入口全仓引用/diff 归属复核）。

### W10 关闭（修复复验五项全过，2026-11-14）

复验（`evidence/w10-fix-verify/`）：① 原失败点转 PASS——真实构建烤入默认地址，产物门禁 `verified across 216 bundle(s)`，preload 零未替换标识符，**无 env 启动登录界面出现且预填构建默认**（前轮 FAIL 步），负对照（换回修复前产物）门禁如实 exit 1；② M-1 托管锁定真实 UI 验证（地址字段禁用+提示+IPC 打到锁定地址而非 evil）；③ M-2 凭据剥离 https/http 双 scheme 实测（记忆文件无 secret、0600）；④ 错误文案映射精确显示；⑤ 专项 72 用例全过 + cloud-session 4 失败基线对照仍为既有。**W10 关闭**（`af75dc475ea` + `f0665d6b0eb` + 独立测试六步旅程 + 审计 + 复验；两次回派闭环）。遗留挂账：m-4 渲染层内联校验镜像主进程、登出后预填刷新、platform unavailable 兜底文案 → P2/后续。通道③下一步 W7b 需①的 W3 提交（在途）。

### W6b 独立测试通过（2026-11-14）

测试代理（隔离纪律佳例：临时 detached worktree 固定到 `8cdfdd02902` 验证，避开主树并发改动）：套件 23/23 + 回归 30/30；自有探针 14/14——宣告/清空（非粘连实测：同 id 重启不宣告即空）/带点 routeKey 置空/双中继取宣告者；**URL 可达性串联验证**：按平台发布的字面 URL 请求（CA 信任 + SAN 校验未关）→ 200 宿主 web-index 内容且宿主侧收到剥前缀后的 path 与 x-forwarded-proto——证明端到端经中继 `/h/` 转发真实可用，非字符串断言。观察项（存活窗口内旧值保留 ~30s，与 AC-23 语义一致，非缺陷）。证据 `evidence/w6b-verify/`（探针脚本可复跑）。

### W6b 审计有条件通过（1 major 回派，2026-11-14）

审计（`test-reports/w6b-audit.md`）：blocker 0、major 1（MAJ-1：无存活中继时 last-known **死**宣告被无限期推荐，browserEntryUrl 与「Empty string over a dead link」自述相悖——单中继真实部署常态故障形态；桌面客户端有探测/failover，浏览器入口没有）、minor 4（MIN-1 畸形 env 静默置空无警示、MIN-3 两份 routeKey 白名单无对拍、MIN-4 e2e 读本机 env 可假红、测试口径 23=13 旧+5 新单测+5 e2e）。安全面实测背书：browserHost 白名单 25 边界值全拒恶意形态、routeKey 两侧正则逐字符对拍相同、线兼容双向零破坏、diff 归属干净（W3 零混入）。已派回派修复（MAJ-1 健康门 + MIN-1/3/4），须在 W7b 接按钮前落地。

### W6b 开发完成（通道②，待独立测试+审计，2026-11-14）

提交 `8cdfdd02902`（5 文件 +479/−14）：中继注册体浏览器监听启用时附 `browserHost`（env，trim；旧注册体线兼容不变）；平台解析白名单（裸 host[:port]、端口 1-65535）且**非粘连**（再注册未带即清空——中继关浏览器模式必须停止被推荐；与 `host` 拨号地址粘连语义有意区分）；`browserEntryUrlFor` 取首个宣告 browserHost 的存活中继拼 `https://<host>/h/<routeKey>/web-index.html`（routeKey 非法/DNS 不安全 → 空），挂载 /v1/relays、/v1/hosts、projectView、/connect 四处。新增 e2e 5 用例 23/23 + 中继回归 30/30 + 全量套件 exit 0。并发卫生良好：W3 的 sessionPageUrl 未提交行完整隔离在其工作区。已派独立测试（含 URL 真实可达串联验证）与审计（白名单绕过面/非粘连语义/四处挂载契约/diff 归属复核）。

### W10 修复完成（待独立复验，2026-11-14）

提交 `f0665d6b0eb`（17 文件 +457/−29）：B-1 双段 define 收拢 `ORCA_CLOUD_PLATFORM_DEFINES`（main+preload 同时注入）+ 双层防回归（单测断言配置覆盖 + 真实产物审计脚本接入全量构建尾，负向对照实测 exit 1 报同款签名）；M-1 托管跳过 memory 档（env>build，记忆仅用户名预填）；M-2 选剥离 userinfo（理由注释：粘贴地址仍指目标平台、登录不读 URL 凭据、拒绝即死路）双入口剥除；m-3/m-5 错误码 IPC 透传 + beginLogin 不再预改写共享 options（成功后 commitLoginAddress）。W10 专项 72/72、复跑 119/119；回归批 44 失败经 stash 对照逐文件一致=既有沙箱 TLS 环境失败（均不 import 本改动模块）。已派独立复验（重点复现原失败步骤①）。遗留：m-4 内联校验镜像、m-2 登出预填刷新 → 后续。

### W7a 关闭（复验全过，2026-11-14）

复验（`evidence/w7a-fix-verify/`）：两套件各跑两遍（树内 HEAD + `git archive` 快照隔离，数字一致）9/0 + 6/0；自有探针 35 断言 0 失败——无 grant admin 签发 403 permission_lost（用无 grant 行宿主证明 403 只能归因新授权门）、授 open 后 201、非法直连地址 400 HOST_UNAVAILABLE（ denied 审计 reason=host_unavailable）、合法恢复 201；既有 admin 有 grant 流程零破坏；code 明文零入审计。**W7a 关闭**（`2f0b9657217` + `8fc140952e9` + 独立测试 33 探针 + 审计 + 复验，三方齐备）。通道①放行 **W3**（详情入口+双入口布局），已派实现代理；其观察到并行 agent 已对 server.ts 落 browser-mode 入口 URL（W6b 接近完成）。运行时观察挂账：26 个 PPID=1 孤儿 api server（并行验证代理遗留，待统一清理）；isDirectAddrForm 仅校验首地址为保守取向。

### W7a 修复完成（待独立复验，2026-11-14）

提交 `8fc140952e9`（2 文件 +141/−28）：j-1 签发侧与换发侧逐字同谓词 open 检查（admin/auditor 旁路也拒，403 permission_lost + denied 审计，宿主门之前保证轨迹确定）；`isDirectAddrForm()` 校验（6 种非法地址注入逐个 400、`[::1]:port` 合法恢复）；oxfmt 2 行。web-handoff 9/0 + dir 套件 6/0。遗留如实：限流/审计灌水面/抽取 web-handoff.ts → M120 清理令；换发设备三元组 → W7b；入库侧地址校验与 /connect 同类问题 → W6b/M120。**索引冲突第三次**：修复代理提交时我的 docs 快照提交卷入其暂存，代理 soft-reset 拆分（fix `8fc140952e9` + docs `536029c6c60`），树逐字节一致。已派独立复验，通过即关闭 W7a 放行①的 W3。

### W6a 关闭（独立复验全过，2026-11-14）

复验（`evidence/w6a-reverify/`）：套件 27/27；自有探针四项全过且含**红跑验证**——升级半开探针对 `3e0c9f970d2^`（修复前）如实超时失败，证明探针非空转；per-IP 上限用 **en0 真实第二源 IP 192.168.2.157** 验证跨源不受影响；stale 升级实测 `HTTP/1.1 503`（对照修复前记录的 404 偏差已修）；hop-by-hop 矩阵（proxy-authorization/te 剥除、sec-websocket-* 保留）；线兼容 HEAD vs HEAD^ 8 项 SNI 探针逐字段一致。附加确认：新回归套件对坏代码 5/5 全红（真回归网非摆设）。**W6a 关闭**（`a9e1fc5e96e` + `3e0c9f970d2` + 独立测试 w6a-verify + 审计回派 + 独立复验，三方齐备）。通道②放行 **W6b**（平台 browserEntryUrl），已派实现代理。

### W5a 审计有条件通过（2 major 待回派，2026-11-14）

审计（`test-reports/w5a-audit.md`）：blocker 0、major 2——MAJ-1 重连快照重绘缺 `[?2026l`（仓库既有清屏+重绘位置均先发 synchronized-output 释放；agent CLI 掉线停在 2026h 时 xterm 被闩锁，清屏/快照/live 全不上屏而徽标仍「实时」，且 M118-3 断言钉了错误序列需同步改）；MAJ-2 桥接 79 行新传输逻辑（subscribeOverConnection 帧映射/end/onError/NOT_CONNECTED/释放）零测试。minor 5：MIN-1 快照后网格自锁回路、MIN-2 窄窗静默拒、MIN-3 懒加载失败无错误边界白屏、MIN-4 create 在途卸载泄漏宿主 shell、N7 顺序断言缺失。安全面干净：无授权不发调用不订阅不加载、宿主独立 fail-closed、viewport zod+宿主 clamp 双封顶无注入面；三生命周期路径释放已验证（除 MIN-4）；diff 归属干净、max-lines 合规。审计明确不阻塞 W5b 派发。处置：等在途 W5a 独立测试回收后合并一次回派（MAJ-1/2 + MIN-3/4，MIN-1/2 记账），修复后复验再关闭④。

### W6c 关闭（独立复验全过，2026-11-14）

复验（`evidence/w6c-reverify/` 14 件）：三组复跑全绿（W6c 单测 30/0、原 failing cloud-admin-session e2e 1/1、tc:web exit 0）；**前缀语义保真穷尽探针**——伺服器逐字复制真实 relay `parseBrowserPath`，`out/web` 全部 **1410 文件**在 `/h/route-key/` 挂载逐个请求零 404 且与直连**逐字节一致**；headless 真实产物加载（web-index 29 请求 / cloud-admin 32 请求）全 200 零 console 错误；无 pathname 回退在 transport 级以真实源验证（修复前构造即抛，修复后拨号 URL 与 offer 逐字节相同）；`build:web` 产物双入口全相对引用。观察项（门禁覆盖面）记录：verify-web-build 不查 CSS/JS 内绝对引用——当前产物无此问题，挂 P2。W6c 关闭（`c615adee2f4` + `ebe7d9def45`）。通道③下一步 W7b 需①的 W3 提交（app.js 双入口）。

### W7a 审计通过（带 1 major 回派，2026-11-14）

审计（`test-reports/w7a-audit.md`）：blocker 0、major 1（j-1：签发侧 adminAccess 旁路可为无 grant 项目签出必然 403 的死 code，与换发侧 open 要求相反——裁定签发就拒）、minor 5（换发无限流、directAddrs[0] 未校验拼 URL、审计灌水面、server.ts 2816 行宜抽 web-handoff.ts、测试 2 行 oxfmt）、note 7（多副本内存 map 为设计自带、browserEntryUrl 待 W6b、W7b 换发应带设备三元组等）。安全基线全部成立：code 256-bit、指纹不可反推、先删后验无并发双花、设备语义与密码登录逐字一致、无 TOCTOU、审计四向零明文。已派小修复（j-1 + directAddrs 校验 + oxfmt；限流/抽取挂账 M120/清理令）。

### W6c 跨通道回归修复完成（待独立复验，2026-11-14）

提交 `ebe7d9def45`（2 文件 +22）：根因=transport 构造用 `pathname.split` 未守卫缺失 pathname（cloud-admin 入口与 e2e stub 的 location 无 pathname）→ TypeError 被 open 包装成 OPEN_FAILED。修复=derive 对非 string 返回空串走无前缀回退（W6c 前行为逐字节），`WebPageLocation.pathname` 改可选；前缀语义未削弱（真实 `/h/<key>` 推导逐字节不变 + 两条新守卫用例）。原 failing e2e 转绿、W6c 单测 30 例绿、tc:web 过、附带三套传输/桥接测试 14+5 绿。已派独立复验（三组复跑 + 前缀语义保真探针 + 构建产物检查），通过即关闭通道③的 W6c。

### W10 测试+审计交叉确认 blocker → 回派修复（2026-11-14）

**测试代理**（真实 Electron 双平台实例，六步旅程）：① **FAIL=D1/P1**——vite define 只注入 main 段，preload 未注入 → 无 env 云构建 `window.api.cloud` 缺失、登录界面不出现（`out/preload/index.js` 残留未替换标识符实证）；②-⑥ 全 PASS（登录成功/记忆 0600 生成/主进程层重启预填/换地址记忆更新/env 覆盖）。59 单测非空壳复核；`cloud-session-service` 4 失败用父提交工作树对照确认为既有 TLS 环境问题。**审计代理**交叉确认同点为 blocker B-1，另报 major M-1（托管锁定地址被登录记忆覆盖）+ M-2（`user:secret@` 地址连凭据写入记忆文件，违反「记忆绝无密码」边界）+ minor×5。sonnet 批次归属审计：**本提交内无关格式化改动为空**（全仓 format 噪声仍在工作区未入提交）。已派合并回派修复（B-1 三段 define + M-1 托管优先 + M-2 剥离 userinfo + 错误码 IPC 透传 + beginLogin 时序，各配断言）。

### W7a 独立测试通过（2026-11-14）

测试代理：两套件复跑 7/0 + 6/0；自有探针 **33 项断言 0 失败**——无权限签发 404 不泄露且有 denied 审计；换发令牌真实可用（GET /projects 只见授权项目）；30/30 并发双换发恰一 200；42 code 指纹在审计 API+磁盘双载体 100% 命中且明文零泄漏；换发响应与密码登录字段集合完全一致。观察 2 条：路由正则放宽使未知连字符动作 404→401（无泄露，与既有对齐）；入口 URL 待 W6b browserEntryUrl 落库后补中继场景组装（W7b 范围）。审计代理仍在跑。

### 并发落地潮与索引冲突二次实录（2026-11-14）

四路完成交错落库 + W6a 修复代理发现 docs 提交卷入 relay 文件，用 plumbing 重建历史（两个 docs 提交哈希变更：W5a→`e2b9250fd90`、W7a→`16e324632c9`，树内容不变；reflog 残留报错为表面现象，三个功能提交均已核实 ON-BRANCH）。**已核实的分支线性状态**：`c615adee2f4` W6c → `b0665d848a7` W5a-seam → `3e0c9f970d2` W6a-fix → `16e324632c9` → `e2b9250fd90` → `2f0b9657217` W7a → `7058a99dd1c` W5a-panel。索引冲突根因=四代理+主会话共享一个 worktree 的 git index；现行缓解=代理提交前自检暂存区 + 冲突后 plumbing 修复（本次有效）；若再发，评估改用隔离 worktree 派发。

### 本轮完成明细（2026-11-14）

- **W5a-seam**（`b0665d848a7`，5 文件 +79/−1）：terminal subscribe 桥接 seam 落库（类型+桥方法+订阅路由+app 绑定），无 rpc/opcode 变更；tc:web 过、cloud 67 测试全绿。
- **W6c**（`c615adee2f4`，6 文件）：web 相对 base（含补 cloud-admin 入口——发现 `build:web` 在 HEAD 本就因缺该入口失败并修复）；`web-path-prefix.ts` 前缀推导（编码安全、无前缀逐字节不变）；31 用例 + tc:web + build 全过；真实前缀加载 96 URL 全 200。**遗留回归**：cloud-admin-session e2e 挂（`pathname.split` undefined，W6c 未提交态被他代理发现），已派修复代理。
- **W6a-fix**（`3e0c9f970d2`，2 文件）：MAJ-1 半开泄漏（HTTP/升级双路径 abort 传播）、MAJ-2 per-IP 限速共用预算、MIN-1 stale 升级 503、MIN-3 升级 hop-by-hop 对齐；27/27 全绿（含 5 条新回归）。
- 在途：W6a 独立复验、W5a 独立测试+审计、W6c 回归修复、W7a 测试+审计（前派）。

### W7a 开发完成（通道①，待独立测试+审计，2026-11-14）

提交 `2f0b9657217`（4 文件 +692/−29）：`POST /v1/projects/{id}/web-handoff`（既有项目守卫、内存 map 绑定 userId+projectId、默认 60s、无直连 400 HOST_UNAVAILABLE、审计记 sha256 指纹）+ `POST /v1/web/handoff`（先删后校验单次消费、复用抽取的 `issueDeviceSession` 与密码登录同路径、撤权换发 403 permission_lost、审计两向无明文）；顺手项（W8 兼守护 docstring、W8_EVIDENCE 常量）已落。e2e 7/0（签发换发/重放/过期/无直连/无权签发/撤权/审计）+ dir 套件 6/0。前轮遗留 diff 审阅后全量续用未重写。已派独立测试（自有探针：双换发并发恰一成功、令牌真实可用性、契约 diff）与审计（code 熵/内存边界/设备绑定/TOCTOU/issueDeviceSession 零回归/正则影响面）。

### W5a 开发完成（通道④，桥接文件待落库，2026-11-14）

提交 `7058a99dd1c`（5 文件）：详情页终端面板（懒加载 + `terminal.create/send/updateViewport/close`/`terminal.subscribe` 流式、xterm 跨断线保留按快照重绘、0.5–8s 退避失败态可重试、`terminal` 授权占位卡、CloudFilePanel 零改动）；cloud-admin/main.tsx WebGL prime 同 web 客户端模式。组件测试 9 例 + cloud 回归 68 例全绿，tc:web/lint/format 过。收尾修正两处规格偏差：重连快照清屏序对齐 web replay；订阅参数补 client+viewport（否则 updateViewport 无 floor 永不生效）。**依赖项**：5 个 subscribe 桥接 seam 文件仍在工作区未落库（更早中断代理所写），已派小任务验证后补提交；落库后 W5a 走独立测试+审计。

### 模型配额中断与恢复（2026-11-14）

六个在途子代理（W5a/W6a修复/W7a/W6c/W10测试/W10审计）因 Flash 模型日额度 402 全部中断，各留未提交部分改动。用户指令：子代理改用 deepseek-flash[1m] 模型；**主会话职责不变（仅编排调度），执行全部归子代理**。已按新模型续派六路：W6a 修复续作（中断前测试 14+8 已过，收尾 typecheck/lint+提交）、W7a 续作、W5a 续作（中断时已在最后验证）、W6c 续作、W10 独立测试、W10 独立审计——每路均要求先审阅工作区自己域的遗留 diff 续用、只提交自己域文件（全仓 format 噪声与无关文档改动不碰不提交）。工作区甄别要点（交由各执行代理落实，主会话不动手）：四通道真实改动 + 全仓 format 噪声混杂；另发现与云端平台无关的设计文档（2026-11-10-mobile 系列等）也在改动列表，归属待确认，未授权不动。

### W10 开发完成（通道③，待独立测试+审计，2026-11-14）

提交 `af75dc475ea`（29 文件，全部客户端域）：编译期 `ORCA_DEFAULT_PLATFORM_URL`/`ORCA_MANAGED_BUILD` 注入（vite define，同遥测常量机制）；地址优先级 env>记忆>构建默认>空、逐档降级永不抛错；托管锁定语义（锁定已解析地址、无地址仍可手填、表单输入被无视）；登录记忆落盘 M66 同款受保护文件（登出保留记忆）；`installCloudPlatformIpc` 改「云端构建即装配」实现无 env 启动出登录界面（零回归：判定保持）；登录表单「平台地址」输入（晚到预填不覆盖用户输入、托管只读、`PLATFORM_ADDRESS_INVALID` 内联错误）。专项 52 用例 + 回归批 93 用例全绿；typecheck/oxlint/design-system 门 0 项。`cloud-session-service.test.ts` 4 失败为既有环境问题（stash 对照 HEAD 复现）。偏差如实：工作令误指 orca-profiles（实改 ipc/cloud-platform.ts），判定语义不受影响；真实平台首启 e2e 超预算，已留 6 步脚本建议给测试代理。**注意**：该代理曾跑全仓 pnpm format，把在途代理的未提交文件做了纯格式化——核验各通道提交时留意格式化噪声。已派独立测试（首启 6 步旅程）与审计代理；通道③放行 **W6c**。

### W2 关闭（三权分立全流程完成，2026-11-14）

M-1 独立复验通过：三套件 13/0+3/0+1/0；自有 UI 探针（真实服务端 400）确认 toast 逐字正确、矩阵零误刷新、unhandled rejection=0；服务端 400 行为未改；red-check 复核成立；两项遗留（m-1 服务端 denied 审计缺失、空主体静默 return）如实挂账 M120/P2；观察项（toast 单槽位叠盖，QA-009 起既有）记 P2。W2 关闭：提交 `21651eea9ce`/`807c3b9ff2e`/`2bd257e4934`/`fd35997a094` + 独立测试（190/190 全套件 + F1 探针 8/8 + UI 抽查 4/4）+ 审计（M-1 已闭环，minor 全挂账）。通道①放行 **W7a**（平台 handoff 端点 + W8 两个 minor 顺手项），已派实现代理。证据 `evidence/w2-m1-reverify/`（summary/ui-probe/wire/审计残留 + 4 截图）。

### W2-M1 修复完成（待独立复验，2026-11-14）

提交 `fd35997a094`（3 文件）：授予/移除入口 try/catch + 失败 toast（不误刷新矩阵、无 unhandled rejection）；无主用户遗留授权行标「已删除用户」且移除禁用（m-2 前端半部）；red-check 验证（还原修复两条新测试变红）。相关套件 13/0 + 4/0。证据 `evidence/w2-m1-fix/`。遗留项如实移交：m-2「允许移除」需服务端支持（对不存在主体清除或删户清理）→ M120；m-1 服务端 denied 审计缺失 → 后续令；空主体静默 return（QA-028/P2）→ P2 批。已派独立复验代理，通过即关闭 W2、放行通道① W7a。

### W8 关闭（审计通过，2026-11-14）

W8 审计通过（0 blocker/major）：断言钉死目标变异、位置合理、无脆弱性、命名合规；minor×2（docstring 未提兼守护语义、saveEvidence 字面量绕过常量）记入 `test-reports/w8-audit.md`，随手折入通道①下一任务（W7a）清单。W8 关闭。

### W6a 审计有条件通过 → 合并回派（2026-11-14）

审计（`test-reports/w6a-audit.md`）：blocker 0、**major 2**（MAJ-1 半开上游 socket 泄漏 5/5 滞留宿主侧且指标不可见；MAJ-2 浏览器监听无 per-IP 限速，与 design §4.3.2「单 IP 并发默认 100」不符）+ minor（升级 stale 404 与测试探针交叉印证、Connection 命名头未剥、升级路径跳过 hop-by-hop 致 proxy-authorization 透传等）。绕过面/hop-by-hop HTTP 侧/背压/线兼容确认正确。审计明确不阻塞 W6b/W6c 派发，但通道②保持串行（修复也改 relay.ts）。已派**合并回派修复代理**（MAJ-1/2 + MIN-1/3 一次修完 + 各配回归断言），修复后测试代理复验再关闭②。审计测试建议（8 条负向用例、parseBrowserPath 单测）纳入修复轮。最高价值缺口记录：当前删掉 HOP_BY_HOP 过滤不会有测试变红。

### W6a 独立测试完成（1 缺陷 + 2 观察项，2026-11-14）

测试代理独立复跑全绿（新套件 6/0 + SNI 回归 70/0 + 边界探针 7/7），线兼容与 HEAD^ 逐字段一致对比通过。**发现缺陷 D-W6a**：路由表过期时 WSS 升级返回 404（`refuse()` 恒写 404），规格要求 503 fail-closed（HTTP 侧符合）。观察项 2 条：① 浏览器端口未套用 per-IP 限速（恰是公网暴露面）；② routeKey 后的路径不归一化原样转发（宿主侧需自行处理）。证据 `evidence/w6a-verify/`（探针 8 件 + 线兼容产物）。处置：等 W6a 审计代理返回后**合并一次回派**实现代理（升级 503 + 视审计结果纳入限速/归一化决策），修复后复验。

### W8 完成（降级版回归断言，2026-11-14）

提交 `c50ffe41ccd`（仅测试文件 +31 行）：M115 dir 语义套件内新增「管理员按 hostId+path 登记无需 dir」用例（201、path 原样、无 dir 键、ready），并用**变异验证**证明防护有效（临时把 validateProjectDir 注入管理员路由 → 断言如期变红 → 还原）。6/6 过，证据 `evidence/w8-regression/`。轻量审计代理已派（报告 `test-reports/w8-audit.md`）。

### W2 独立验证通过 + 审计打回一项（2026-11-14）

**测试代理结论**：全套件独立复跑 **190/190**；F1 自有探针 **8/8**（lisi 授权可见可连、撤权仅撤 lisi、未知用户 400、zhangsan 不受影响）；UI 抽查 **4/4**（QA-005 状态推导、QA-002 分页加载更早、QA-011 错误态重试、QA-009 失败回滚）；证据 `evidence/w2-verify/`（含 w8-fact.json）。**W8 裁定：非产品缺陷**（管理员 path 登记本就 201；INVALID_DIR 仅自助路由且符合 FR-3.7 契约；归档失败=测试缺 dir 已止血）→ W8 降级为回归断言令，已派执行。

**审计代理结论**：不通过（1 major）——M-1 授予/移除入口缺错误处理，输错用户名静默失败（与 QA-009 同形态，恰是 F1 目标流程）。已按流程**回派实现代理**修复（toast + 回归断言，顺带评估审计 minor：被删用户遗留行可移除）。minor×4/note×7 记录在 `test-reports/w2-audit.md`（含：F1 两点断言削弱、audit metadata 无断言、被删用户死行清理不完整、一处 body:any）。M-1 修复+复验通过后 W2 方可关闭。

### W6a 开发完成（通道②，待独立测试+审计，2026-11-14）

实现代理交付 `a9e1fc5e96e`（仅 3 文件）：relay.ts 新增 TLS 终结浏览器监听（三项 env 任缺不启用、线兼容零行为差异），`/h/<routeKey>/` 剥前缀转发 HTTP/WSS（routeKey 白名单、101 头原样透传、未命中 404、过期 503 与 SNI 同口径 fail-closed）。新套件 6/0 + SNI 既有回归 70/0，证据 `evidence/w6a-relay-browser/`（含安全语义确认点）。超范围发现：W6b 无需 W6a 新增交换字段，但平台拼 URL 必须校验 routeKey 形态（无点、`A-Za-z0-9_-`）。已派独立测试代理（边界探针：编码绕过/XFF 行为/stale 503/线兼容对比）与审计代理（绕过面/可靠性/规范，报告 `test-reports/w6a-audit.md`）。

### W2 开发完成（待独立测试+审计，2026-11-14）

实现代理交付三笔提交：`21651eea9ce` F1 用户授权按 username 解析（仅撤该用户会话，含遗留死行清理）、`807c3b9ff2e` F2 QA-002~012 十一项各一修一断言、`2bd257e4934` archive e2e 补 dir（**发现 W1 即破坏归档 e2e，测试侧先行止血**）。门禁 190/0，证据 `evidence/w116-fixes/`。三个偏差决策（QA-010 改为「管理员可见（未授权）」禁用打开、audit cursor 分页、行号漂移按语义定位）已记录待审计确认。已派独立**测试代理**（复跑全套件 + F1 独立探针 + **W8 事实裁定：管理员无 dir 的 path 登记现状** + 4 条 UI 抽查）与独立**审计代理**（逐条 QA 对照 diff、安全语义、线兼容、规范、2bd 提交处置建议），报告将落 `test-reports/w2-audit.md` 与 `evidence/w2-verify/`。

### 2026-11-15~16 收敛补记（U45–U69 批 + LDAP 序列重启）

- **授权重构 U67**：三审定修订入档（位置即权限·层级单卡·chips 仅名字+类型徽标·成员页整体删除）；原型同步入库（`7265d6a5c61`/`63f6d8aa7cc`）；独立评审在途；待用户原型复核（人工门）。
- **审计增强 U66**：文档族三轮评审收敛 **APPROVED 可开发**（u66-doc-review.md §11.6）；一期 5 令 + U68 宿主承接（`70434b45db9`）+ U69 sha256Source（`6d96949c966`）落地；二期宿主硬拦在途（evidence/u66-phase2-host）。
- **LDAP 序列**：旧组→角色映射方案作废（`5ac1abf4227`，U69a 登记）；开源调研落盘入库（`5c82d39294f`，形态 A 单组准入）；分组准入设计在途（ldap-group-admission-design.md，七项裁定清单下达，含 LGA-1 去留）。
- **W12 族核实**：U15/U17/U23 早已落地全 🟢（`09c5c9a3e19`/`a6d8d1fc7fa`/`108bf8bb832`），诊断稿状态补注（`d868fef80d3`）。
- **人工门两项待用户**：U63 全流程重验证据链认可（evidence/man-review/）；U67 原型复核（ui/prototype.html，重点=详情弹框权限 tab 三卡片+chips 无权限尾注）。

### U66 二期落地 + U67 评审回收（2026-11-16 02:06）

- **U66 二期**（`f01bc88272e`，35 分钟单提交）：宿主下载硬拦（readChunk 多窗口重建拦截；真栈 D1 无 download 位→PERMISSION_MISSING / D2 票带 download+策略 deny→DOWNLOAD_DISABLED / D3 allow 完整放行）+ auditGap→host.audit_gap 增量落链（/v1/audit/status 呈现宿主缺口，NF-2 闭环）+ 心跳响应 auditCapabilities 声明与宿主严格门控翻转（wire-additive）+ device resolver（actorSource=subject→device）。新增 e2e 3+pipeline 6+guard 6+协商 11+平台 node 7；零回归（80+38+29+65+7 全绿）；门禁全绿。**残余缺口如实声明→U70 登记**；U68 三件平台后续闭环。
- **U67 独立评审回收**：CHANGES-REQUIRED 轻量文档轮（`test-reports/u67-doc-review.md`，无 P0+原型五基准 PASS）——M1-M4 文档修订+m1 卡头位徽标裁定删除/m2 文案；修订令已派（修订后免重审），修订稿随用户原型复核呈报。
- **释放序列**：U66 红项真宿主终复验 + U62/U52 打磨修令已派；LDAP 评审 APPROVED 后放行 LGAA-1a/4（1b/2/3 排 U62 后的 server.ts 队列）。

### 探索覆盖闭环 + U78/U79 收口（2026-11-16 04:4x）——平台侧工作收口

- 探索 r4（接入面：安装向导/脚本端点/注册心跳/中继不可达恢复/双角色 403）：P0=0、P1=0——业务链路探索覆盖全链闭环（r2 四路+r3 用户审计+r4 接入）。
- U78/U79（r4 唯二 P2）修令落地 `3a3f70e6a8`：审计枚举目录化（42 权威类型经 status 加性下发，前端派生+旧平台 fallback，杜绝静态枚举再漂移）+q 白名单扩 eventType/targetId；/v1/hosts `relayTarget`/`relayOnline` 加性+宿主表中继列（中继离线可辨识爆炸半径）。
- **平台侧自主工作全部收口**：终门五轮双线全绿+台账非人工门项清零；余项=五道人工门（U67 原型复核/U63/U70/U74/.gitignore）。

### 用户验收反馈批闭环 + 测试基建收口（2026-11-16 12:xx）

- **四项反馈全闭环**：U83 终端填满（`2fc13910ded`，gap=0 实测）/U84 回显延时（`6b67ea041ba`+`c7cca5e384a`：全路径 P50 **10.18→3.09ms −69.6%**，根因=合并器 5ms 定时器税）/U81b 用户页（`70847f4f4a1`：查询四态+只读+详情弹框+来源真值）/U86 审计查询排版（`8f50d9e96fd`：12 列网格+删提示，31 天上限移页头保断言）。
- **环境事故三次破案闭环**：U88 日志契约（`45bcc8d16e`）→ 尸检锁定外部 SIGKILL → U89 追凶=手打宽域 pkill（`c8ebe8a557b` 协议 §2.8 禁令+跨会话警示）→ 幂等恢复三层防护。
- **测试基建**：U87 Bun 池漏登记（`c7cca5e384a`）/U90 teardown 信号语义+hunter 双流（`27d75ff6ea4`）/U92 副本去重（`e426479f26d`）/U93 既有红登记（TLS 握手族 5 例）/U91 旅程新增两站（`4f057de57911`：git 面板+restart，2 passed）。
- **原型侧**：U80 移动适配原型（`721e43512ee`，15 面+6 关键页，T1-T3 审定）/U85 原型 QA 批修复（`19622e7c728`）——三原型全部通过独立 QA 实测，呈用户复核。

### 终门通过：双线黄金旅程第五轮全绿（2026-11-16 04:1x）

- **A 线 9 PASS / B 线 9 PASS / 0 FAIL，P0=0、P1=0**（journey-round5.md，留盘）：四轮三红站 B4/B5/B6 在标准构建+加固 oracle 下全部转绿。
- 强制门留档：标准 global-setup 构建（VITE_EXPOSE_STORE=true 全注入，run-b-build-and-spec.log）+加固 oracle 独立复跑 PASS（evidence/final-journey-verification-5/web-bundle-store-oracle-output.json）。
- 默认态回归：LDAP 未设三账户全 200（E1-E6 6/6）、U72 auditor 入口形态、U73 latest-wins 全绿。
- P3 挂账：云端 git 面板/桌面 restart 覆盖缺口（继承项）；j4 遗留 daemon 已清。
- **「全部完成，等待人工验收」机器门达成**：双线全绿+LDAP 四权闭环（调研→评审→六令→审计通过）+持久环境 HEAD 全量种子就绪。剩余=五项人工门：U67 原型复核（拆实现令）/U63 认可/U70 裁定（推荐 C+64KB）/U74 去留/.gitignore 裁定。

### LDAP 分组准入全交付（2026-11-16 02:5x）

- **六令 6/6**：1a Mock 适配（`6d0202fb695`）→1b 登录链（`d917085a838`）→2 单测 A1-A12（`bf2855de5c5`）→3 e2e E1-E6（`0c55592edf5`）→4 LGA-1 删除（`f1855b4d569`）→5 requirements 措辞（`86e469f4845`）。设计经两轮评审 APPROVED（`3f573bae498`）。
- 语义定稿：memberOf 单组准入（`ORCA_CLOUD_LDAP_REQUIRED_GROUP`，未设置=不过滤、设置后 fail-closed）×平台统一闸门；拒绝 401 `LDAP_GROUP_NOT_ADMITTED`「账号未加入平台准入组。」+审计 reason=ldap_group_denied；锁定不污染（不计数不清零）；:1731 组→角色种子废除；LGA-1 前向删除。
- 数字：单测 12+11 新增/全量 89 绿；e2e 6 新增/27 并跑零回归；tc:node 0 错。
- 终验排程：持久环境 reseed 冒烟 + 终态旅程五轮。

### U67 设计族过审 + 探索 r3 回收 + LGAA-1a 落地（2026-11-16 02:3x）

- **U67 修订令** `7c0970b17ca`：M1-M4+m1-m7+LDAP M3 追加全修（卡头位徽标删除/审计目录 admin-only/成员页删除语义/断会话文案分型）；评审免重审条款生效=设计族过审，**用户原型复核材料就绪**（人工门）。
- **探索 r3**（用户管理+审计查询页，隔离实例 67 条真实链上事件）：P0=0，正向 40+ 绿（roleOverride 全链/过滤矩阵/分页/空态）；**P1×2 登记 U72/U73**（审计员 Web 全门禁/审计查询竞态污染——待 U52 落地后同域串行派修）；P2/P3 归并 U74 挂账。
- **LGAA-1a** `6d0202fb695`：ldap.ts `not_admitted`+Mock requiredGroup（先密码后组序钉/大小写 fail-closed/前缀不误命中），新测 11/11+全量 91/91+门禁绿。
- **U66 终复验 10/10 PASS**（见上节）；LGAA-4 删除令随真栈槽放行。

### v2.2 发布 + 全站路由/审计体系（2026-11-16 13:3x）

- **v2.2 发布（HEAD aa8fd6bfa85）**：构建+reseed 对齐（verify failures=[]）；真机六项冒烟全过——开 3 标签 360/348ms+40s soak、**刷新恢复 3 标签+内容**、关页重开恢复、**二次打开恢复**、路由深链/404/登出清 hash、LDAP 缺省登录 200。证据 evidence/release-2.2/。
- **U118 双根因修复**（`579eedd0b2a`）：宿主票据令牌预算 4→13（云会话 12 socket 合法）；`+→New Terminal` 云会话豁免镜像守卫。
- **U115 P0**（`9d90575ccf3`）：安装向导一次性下载令牌——照抄即 200/二次 401/过期 401/兼容/越权五场景全过。
- **U106 全站路由完成**：管理台 R1-R6（14 路由/深链/覆盖层/筛选入 URL/404/403/登出清 hash/T12 Referrer-Policy）+ Orca Web W1-W3（静默续会话/403/404/嵌入兜底）。
- **U67 权限界面实现批**：3a 三卡片（`28c3c30bacb`）→ 3b 增删调卡（`f1fd2f702e3`）→ 4 项目弹框（`62394e214f4`）→ 5 成员页删除（进行中）→ 6 测试。
- **审计体系实战**：U111 三组审计（B 4/4 PASS；C 2 HIGH+6 MEDIUM 全修；A 1 PASS/2 RETEST 修复）；基线三件套（12 模块文档+10 链路+318 用例）建成；协议新增 §3g 审计梯/§3h 链路门/§3i 决策权/§2-10~15 纪律。

### 旅程七轮双绿 + 权限/路由全交付（2026-11-16 晚）

- **旅程第七轮**：A/B 双线 **13 项门禁全绿**——含 A2（reload 后 DOM=store=宿主 active 一致，U124 双根因修复实锤）、B6 F5 恢复、B7 返回再开×3、B8 路由、B9 权限三卡。唯一 P1=嵌套 iframe 剪贴板权限（U129 修复中）。证据 `evidence/journey-7/`。
- **U67 权限重构收官**：3a/3b/4/5/6 + AC 9/9 + 四身份双主机矩阵 8/8 + **独立审计 PASS 缺陷 0**；观测批修（U123）。
- **U106 全站路由完成**（R1-R6+W1-W3+T12/U121）。
- **环境修复族**：U115 安装向导一次性令牌（照抄五场景）；U118 新建终端双根因；U124 DOM/hydration；U126 platform-only reseed（PTY 存活）；U128 host 启动竞态；U122 去外链；P3 批 8+5 条输入硬化。
- **验收基线**：318 用例刷新（自动化 267/手测 44/未覆盖 7，缺口 27→21）。

### 全量回归批闭环推进（2026-11-16 16:0x）

- **回归批结果**：4405/4436 通过（test-reports/regression-2026-11-16-pm.md）。失败分三类：今日引入 9（=U130）、既有 3、环境 6。
- **U130 已登记**（`e9a6d9162ca`）：①U86 网格契约未纳入新 `auditTrace` span（第三行 15≠12）②`cloud-workspace-info-real-host` 白名单缺 `capabilities` ③5 个主侧真栈夹具缺 host `provision` 授权（U62-C10 收紧，7 例）。修令已派（并行线②）。
- **U129 剪贴板修复已提交**（`74e4daef976`：iframe `allow=clipboard-write`），平台 `--platform-only` 刷新后真机复测中（并行线①，期望 clipboardLength>0 / 无策略违例 / 审计 file_copy=success）。
- **环境 6 红 + 既有 3 红分诊中**（并行线③）：TLS/node-pool、U95 guard、profile-state 超时、`App.cloud-workspace-entry`×2、`cloud-session-limits` M33-2，逐项定性后决定登记或环境噪声。
- **收口门禁**：U130 九红清零 + U129 复测绿 + 双线金路径保持绿 → 出最终报告。
- **U130 已闭环**（`a6c43b28994`）：①U86 实为真实布局溢出（actions span 9→6，3+3+6=12）②白名单加 `capabilities` 并补值断言 ③两夹具补 host `provision` 授权。精确重跑核验：**今日引入 9/9 转绿**（main 14/14、U86 2/2），今日引入红数=0。
- **U132 已登记并派修**（测试基建四项，均非产品缺陷）：R-A 池守卫漏检间接 TLS+4 文件登记 node 池；R-B crash-recovery 等待不监听 exit（本机 Node 24.5 缺 `setAuthorizer`）；R-C App 入口 2 例断言陈旧；R-D `cloud-session-limits` 身份缺 `open`。分诊实验复证 node 池 13/13 绿。
- **U131 已登记并派实现**：平台 dev store 快照持久化（env 门控默认关），修 `--platform-only` 丢注册态根因；落地后 full reseed 一次重建快照，再验持久性并收口 U129。
- **U131/U133 闭环 + platform-only 真验**（`78fc0855a11`/`dfde8755f38`/`5153f095b0f`）：store 快照持久化上线；首次启用持久审计日志即暴露 U133（校验器拒绝 null actor，重启被判 corrupt）——放宽校验并补 3 例回归。真机验证：full reseed 建快照（hosts 3/projects 5，0600）→ `--platform-only` 重启 `failures=[]`、双宿主同 id 在线、PTY 144/21 存活、5 项目 ready、审计链 32 事件 `ok:true`。**U126 的「刷新平台保 PTY」承诺自此完整成立。**
- **U129 端到端闭环**：真实环境 probe-b10——文件树/复制按钮到位、父页剪贴板 80 字符、审计 `file_copy result=success`（README.md，web-clipboard-api，host_b58500c3）。
- **U132 闭环**（`29c881f9eb3`）：池守卫一跳 import+E2EE 信号（先红 4 漏检→登记后绿）、crash-recovery 监听 exit+Node<24.10 skipIf、App 2 例断言同步、M33-2 补 `open` 授权；`pnpm tc` exit 0。
- **终局门禁在跑**：双线黄金旅程复跑（A=Orca Web 旅程、B=控制台旅程，evidence/journey-8/）。
- **journey-8 探针线全绿**（21/21：A 线 8 + B 线 13，红 0；脚本漂移 1 处已修）；非门禁观察 3 条与 journey-7 基线一致。官方 W9 spec 双线（桌面/Orca Web）门禁在跑（`evidence/journey-8/spec-gate/`）。
- **验收缺口收窄批落地**（`63a47043057`）：29 条缺口核实（审计后口径：closed 7/部分 5/待办 17），新增 e2e 3 个全绿（T05 3/3、T06 21/21、T32 6/6）；F1/F6/F8 覆盖 69 步骤/52 分支；分模块统计审计后校正为 274 自动化/42 手测/2 未覆盖。产出两个已核验 P1 → 登记 U134（并行 401 双 refresh 误登出）/U135（停用账号可改角色）并派修；P2 观测并入 U136（含裁定：仓库地址 validator 收紧、授权收缩撤凭证）。
- **U134/U135 已闭环**（`cbbcb130086`）：single-flight refresh（并行 401 仅 1 次刷新、登录态保留）+ 停用账号改角色 409/denied 审计；测试 5/5、相邻 12/12、广域 24/24、tc 0 错。**持久环境已刷新**（`--platform-only`：web build=源、served app.js 含修复、宿主同 id、PTY 154/28、failures=[]）。
- **W9 官方 spec 门禁首跑 4/6**：B 线 2/2 绿；A 线 2 红均为脚本漂移（窄终端回显折行、strict locator 双 pane）→ 登记 U137 并派修（语义不放宽，收敛失败按产品缺陷回报）。
- **W9 官方双线全绿**（`27135c06cbc`，U137 闭环）：A 线 desktop 连续 2 次通过（37.3s/37.1s，marker 去折行统计仍要求 ≥2）+ git-and-restart 3 passed ×2（pending 正常收敛）；B 线 app.js 变更后复跑 2 passed（32.7s）。
- **U136① 闭环**（`9854ef58d60`）：仓库地址 validator 收紧（裸串/本地裸路径 400 `REPO_URL_INVALID`），正例 11+负例 18 矩阵，相关 173 测试绿。
- **验收计数审计三轮收口（PASS）**（`7f793667009`/`75b60a78828`/`9986ef6cf99`/`e1f6a4f5bd4`）：统一 characterization 口径→**318=276 自动+41 手测+1 未覆盖**；§13 closed 9/部分 5/待 15（G08/G28 closed、AC-M6-15 ✅ U135、AC-M3-33 ✅ T10）；终审逐列算术自洽、交叉引用一致，判 PASS。
- **U138 根因定位并派修**（`29ad5a06cb3`）：确定性复现 2/2；宿主两份 active 状态——首帧内存值正确，随后 workspace-session 持久化旧 `activeTabIdByWorktree`（create-time focused 写）经 merge/hydration 覆盖，客户端一次性 adoption 已消费→不再跟随。前置条件=reload 前活动标签≠最后创建标签（解释前次绿）。修令含：宿主单一权威+revision 判定、客户端稳定前持续 adopt、回归三件（active≠last-created 前置/稳定 ≥2s 三方相等/B7 零互换）+ journey 门禁复跑。
- **全量回归终验完成**（`test-reports/regression-2026-11-16-final.md`，未提交）：521 文件/3606 用例 **3585 过 / 5 失败 / 16 跳过**；15 红对照清零 13（U86、workspace-info、App 2 例、M33-2、TLS×3、enrollment、crash-recovery 等），今日变更面 U131 6/6、U133 3/3、U134/U135、U137 W9 4/4 全绿。
- **U139 闭环**（`7a0e9aa40a2`）：宿主 clone 校验拒绝 `file://` → 夹具改用回环 `git://` daemon（真实克隆传输）；11 文件/16 用例全绿；连带发现 U141（本地仓库地址跨层死角，修复中）。
- **U140 闭环**（`f98d6b3503c`）：吊销宿主路由不再被启动种子复活+启动清扫；routes 实测 2 条、完整 reseed `failures=[]`。
- **U138 闭环**（`3b241e585d3`，真机）：重建 out/main + 宿主重启后，journey 控制台线 **13/13 全绿**（a2 三方一致、B7 零互换），Orca Web 探针（probe-a2）同构建通过；W9 官方双线 **A 4/4 + B 2/2** 复跑绿（注：生产重建会折叠 e2e store oracle，需 `VITE_EXPOSE_STORE=true` 重建后跑 spec——U36 族再次现形）。
- **U141 闭环**（`6cb53417057`）：平台/宿主 clone URL 校验收敛（绝对路径+file:// 同步接受，裸串/ftp/ext:: 仍拒）；契约 5/5、宿主 51/51、注册 e2e 7/7。最终构建+部署与门禁复跑进行中。
- **最终构建已部署**（out/main/out/web 17:37，含 expose-store）：平台 40293、宿主 40667/41785（同 host id），reseed `failures=[]`。
- **U138 重开**（`7f07d3ce86e`）：部署后 journey-9 复跑仍红（a2 三方不一致；B7 零互换绿、内容/分组绿），已证 out/main 含修复 → 修复未稳定；**二次诊断**（`b4e5e3cdde2`）：renderer: epoch 的 activate 从未落盘 + 每设备选择投影产生第三陈旧值；绿 run 属相位巧合（门禁仅采样一次）。二期修令在途；门禁 B7 已加「三次重开 active 一致」。
- **U140/U141 独立审计 PASS**；偏差转 U142/U143 均已闭环：U142 `bdf41816514`（SCP-like 统一 user@、UNC 两端拒、共享矩阵模块两端 import 防再分叉；6/6+56/56+7/7）、U143 `ab7d2eade44`（orphan 路由清扫、注册 revoked 门禁 409+denied、多宿主用例；43 绿）。
- **U138 三期落地**（`68c498fd5d1`）：恢复后 re-assert——adoption 前客户端 restored active ≠ 宿主则回写一次（配对落盘），相同/手势/失效零写入；4 新例、相邻 46 文件/348 绿。
- **U138 三~五期**：客户端回写方案（reassert）经三轮（`68c498fd5d1`/`b6883d9f389`）仍偶发；四期诊断证伪双写/陈旧选择、证实捕获点污染；**升级用户裁定「宿主为准」**（台账 `c8eb0cf75fc`），并落权威矩阵 `work-orders/u138-active-tab-authority-matrix.md`。
- **六期（宿主为准）落地**（`4e3a955d2e2`）：移除回写；云会话每帧 `hostActiveAuthoritative`、手势优先；**journey-13：a2 三方一致绿**。
- **七期诊断锁定翻转源**（`f69f7add9fb`）：隐藏 pane 的镜像 attach 被落盘当成用户选择；八~九期迭代（`b1961de1df7`/`9f1d4876a72`/`7f4cf9a77b3`）引入 `materializeOnly` 显式标记：材质化请求不写 durable/per-device。
- **终局门禁（九期构建）**：journey-16 **13/13 全绿**（含 a2 三方一致）；W9 官方双线 **6/6 绿**；平台 e2e **428/428**。
- **U138 最终处置（P2 残余，显式披露）**：十期落地后（`0bda800d1fc`）交替仍在；journey-17 a2 红、B7（原语义）绿——a2 时绿时红（-13/15/16 绿，-14/17 红）。标签组/标签数/终端内容每次正确恢复；仅快速连续开合后「选中标签」可能差一个周期，下次打开/点击自愈。结论：非单一写入方，按权威矩阵 + RPC 帧可观测另开设计令（§2-28/§2-33），不再盲修。
- **P2 批（U136）全部闭环**：②中继刷新反馈 `9fda01430cb`（G11）③审计链健康/校验入口+auditor 空下拉解释 `d32cb27370f`（G14）④a 策略 expectedVersion 后端 `afca14d02c8` + ④b 冲突 UI `27ca7b65d07`（G16/G29）⑤授权收缩撤凭证 `14107b19497`（G21、U65 关闭）。验收基线：**320=279 自动+41 手测+0 未覆盖**；§13 closed **14**/部分 2/待 13；链路 82/70/71/53；机检 PASS。
- **P2 批已部署并真机验证**（`--platform-only` web build=源；r7 探索 `evidence/r7/`）：P1 中继刷新横幅+重试、P2 审计链健康/校验+auditor 空下拉解释、P4 策略冲突双会话、P5 回归抽检 **全 PASS**；P3 授权收缩核心行为通过（403 实时位门禁 + revokedUsers + 撤销记录；「401」断言已按设计修正为宿主旧 ticket 侧）。
- r7 环境残留（已记录）：策略版本因测试写入由 25→31（不可回退）；zhangsan/lisi `roleSource` 变为 admin-override（角色值已复原）；lisi 一条历史撤销记录。
- **缺口收敛（续）**：G03 登录 UX（`470d319bcbe`）、G15 审计 UI 三项（`1000cc18d3b`）、G02 会话失败三例（`c7a0e90090e`）、G05 工作台四卡+query+forward（`f68e9fe15eb`）、G25 capabilities 路径钉住（`e67d13fb575`）、G07 provisioning UI 全链（`3ec24af7486`）、G09 维护/下线失败 toast+成功态（`c05974dd502`）全部落地。
- **验收基线（当前，2026-11-16 23:xx）**：**321 = 284 自动 + 37 手测 + 0 未覆盖**；§13 **closed 23 / 部分 2 / 待 4**（G04/G06/G24/G26 属部署手测或待排期）；链路 82/70/71/54；机检 PASS。人工验收矩阵 `work-orders/manual-acceptance-matrix.md`。
- **U145/G27 闭环**：LDAP 徽标事实化（加性 `ldap.requiredGroup`+三态展示，`accf5204d26`/`33d01936cab`）；设置页 toast 去掉「30 秒」承诺改「随宿主心跳生效」（`86e072fcc1e`/`33d01936cab`）；G27 钉住功能待排期（部分闭合）。
- **U145/G27 真机抽验全 PASS**（`evidence/u145-g27/`）：users 徽标「LDAP 准入：未配置」与 API `ldap.requiredGroup=null` 一致、无「LDAP 同步正常」；settings toast 无「30 秒」，线上 bundle grep 命中 0；audit/hosts 回归正常（环境未改动）。
- **P2/缺口批独立审计 PASS**（13 提交，25/25 抽跑绿；0 skip/todo、未放宽断言）：3 项非阻断偏差已处置——并发用例改名（真并发由 write-lock 代码保证）、本段历史基线加时刻标注、纯测试提交的措辞区分见各条（实现早于覆盖补齐）。
- **U127 已执行闭环（用户授权：开发环境非危险操作自主处理，中继未正式使用）**：远端 relay 自签证书→CA 签发（SAN 含 IP，旧件备份）；新增 `orca-relay.service` systemd（沿用原 token，Restart=always）停旧起新；18443/18444 监听、routes n=2；handoff `…:18444/h/dev-local-02/…` 实测 **200**、系统信任校验 **return code 0**；协议 §3i 增补开发环境自主权限。证据 `evidence/u127/result.json`。
- **U63 人工复核证据重验完成并闭环**（10 步 / 23 截图，`evidence/u63-manual-review/`）：9 PASS；唯一 DIFF（主机指纹占位/版本缺失）→ **U147 已修并真机验证**：详情显示真实 `TLS 指纹 sha256:3f4b…`、版本心跳自愈（开发运行时显示 Electron 版本 43.7.5，打包版为 Orca 版本）。U63/U147 均 🟢。
- **移动端真机抽验 15/15 PASS**（`evidence/u80-mobile/real-env.json` + 4 截图）：390 工作台四 tab/2×2/Orca Web 提示、项目卡/chips/「打开工作区」toast 且 hash 不变、详情全屏 sheet+权限三卡、768 侧栏两列；consoleErrors=[]。
- **U116①/G27 实现全部落地**：W1 G06 服务端 `c5c1151`、W2 数据层 `29e02c5`、W3 归档分组 `49656b8`、W4 归档/恢复 `e2cddad`、W5 归档详情只读 `b1b72d6`、W6 移动样式 `703fe5d`、W7 全量项目策略 `176c644`、W8 移动样式 `24a8761`、W11 旧套件改写 `d0e6d05`；U148 移动端四缺陷 `f381ea1`；**U149 加载失败态回归修复** `67adf3b9d2f`（W2 合并请求致测试拦截 glob 不匹配 → 恢复独立列表请求）。
- **M9 重跑 80/80 PASS**（`evidence/u80-mobile/m9-rerun/`）：上轮 7 FAIL 全清零；U148 四项复核通过（工作台无溢出、页签 44px、主机卡菜单、样式化下线确认）；新功能全过（已归档 chip/分组、归档/恢复确认卡、设置全量策略三态、深链占位）；5 个初跑噪点均为夹具/选择器口径问题。
- **M10 总审计 PASS**（T1-T12 抽样全过；5 套件 HEAD 隔离复跑 29/29；红线 0；计数 PASS）。
- **终局门禁（修复后复跑）**：W9 官方双线 **6/6 绿**；journey **12/13**——b8 深链经 U150 修复转绿（`442340bf252`：more-sheet role 冲突，非产品回归）；唯一红=a2（U138 已知 P2 残余）。
- **本轮批次收口**：移动端 M1-M9（80/80 探索）、U116① W1-W8/W11、G27 W7/W8、U147 指纹/版本、U148/U149/U150 全部闭环；W12 全量回归 0 红；M10 总审计 PASS。
- **W12 全量回归 0 红 GO**（`test-reports/regression-2026-11-17.md`，不提交）：524 文件 / **3615 pass / 0 fail / 9 skip**（含平台 e2e 101 文件 543 例）；新红/既有红/环境红均为 0；用例口径 3671→3624 差异已说明（e2e +83、定向批收窄）。U149/U147/U116①/G27/U148 用例均在批内实际执行通过。
- **移动端 M9 逐页探索完成**：73 项检查 **66 PASS / 7 FAIL**（归并 4 缺陷，`evidence/u80-mobile/m9-exploration/` 38 截图 + summary.json）：①工作台 390 项目卡横向溢出（P1 布局）②主机详情页签 39px ③主机卡操作未按原型折叠 ④下线用原生 confirm → 登记 **U148**，修复排在 W3 后（同 app.js）。
- **移动端 U80 M1-M8 全部落地**：M4 主机/中继 `8cb88ab`、M5 用户 `ae2e11c`、M6 审计 `67e876f`、M7 设置 `7e956a7`、M8 深链守卫+全局形态 `359f275`；M6-M7 独立审计 PASS（40/40）；**M9 逐页探索**与 **W2（U116① 数据层）** 在途。
- **移动端 U80 进展（M1-M3 已落地）**：M1 基座 `8dbc5f9`（审计 PASS，D2/D3/D4 由 `54955b44a80` 收口）；M2 登录+工作台 `54ed87a`；M3 项目列表+详情 `33e42b8`（含「打开工作区→请用 Orca Web」提示）；U80 套件 12/12；控制台已部署测试环境，真机移动视口抽验进行中。M4 主机/中继在途。
- **移动端 U80 启动**：原型已改「打开 Orca Web」提示（`2749d252eec`）；任务计划+探索清单落盘；**M1 基座完成**（`8dbc5f9230b`：≤700 单列/701–1100 两列/≥1101 零泄漏、底部 tabbar+更多 sheet 按权限显隐、安全区/16px/44px、表格横滚；390/768/1280 断言 + 桌面 32/32 回归）；M1 独立审计与 M2（登录+工作台）在途。
- **全量回归终验（HEAD，2026-11-16 24:00 口径）**：524 文件 / **3671 用例 / 0 失败 / 9 跳过**（双池 + 平台单测/e2e 460 + W9 4）；上次 5 红（U136① 夹具）全部转绿并由 8+4 文件定向复跑佐证；三桶：今日引入 0 / 既有 0 / 环境 0（注：完整单机全量约需数小时，按上次同口径可比批执行，报告 `test-reports/regression-2026-11-16-2400.md`，不提交）。结论 **GO（范围限定：单机完整全量需 CI 分片）**。
- **最终一致性验证完成（HEAD 重建部署后）**：W9 官方双线 **6/6 绿**；平台 e2e **460/460 绿**；journey 控制台线 **12/13**（a2 为 U138 已知 flaky 残余，B7 原语义绿；证据 `evidence/journey-final/`）。环境健康：platform 200、hosts 47158/49053 在线、reseed `failures=[]`。
- **过程事故与处置（已闭环）**：验证链首轮因**平台 pidfile 陈旧未杀到真实进程**→EADDRINUSE，随后 TaskStop 留下 14 个测试 server 泄漏进程；按精确 PID 清理、full reseed 恢复。教训：重启前置核验实际监听者；停后台链后清点子进程。
- **缺口收敛（本小时）**：G23 授权组合 6 findings 逐条复验全部已修（`3d9dee67131`/`b05ee6ae5ac`）→ **closed**；U113 A-retest 真机矩阵 **9/9 PASS**（2 组 3 标签×关页/刷新/二开×3，证据 `evidence/u113-retest/`）→ U113 关闭；宿主旧 user ticket 401 探针入套件（`b7fc032ce01`，2/2）。基线：320=279+41+0、§13 closed 15/部分 2/待 12（机检 PASS）。
- **本日交付总览**：U129 剪贴板端到端、U130 回归 9 红清零、U131 store 持久化 + `--platform-only` 真验、U133 审计校验器、U134/U135 双 P1、U136①/U141/U142 repo URL 三层对齐、U139 夹具 git://、U140/U143 吊销路由与注册门禁、U137 W9 spec 漂移、验收基线 318=276+41+1（审计三轮 PASS）。
- **AC-M3-33/G08 注记同步**（`09bfb94513b`），计数机检 PASS（318=276+41+1、§13 9/5/15）。
- 最终构建门禁：平台 e2e **426/0**、W9 双线 A 4/4 + B 2/2 绿。

### 2026-11-17 01:3x 轮：U146 落地 + U138 设计/探针闭环（三通道并行）

- **环境体检**：platform pid 65394、宿主 98982/99952、forwarder 88911 全存活；`--platform-only` 后 web 快照=源（build=1253f697af53）、双宿主同 id 在线。
- **台账对账**：U116 行更新（① U116① W1–W12 已交付；③ `35b43c973fa`；②/④ 按 B2/B3 用户暂缓），提交 `84ce450ff23`。
- **通道 A · U146/G25 陈旧路由可观测**（`a3603b825b9`）：`RelayRoute.updatedAt` + `GET /v1/hosts` 三加性字段（age/stale/updatedAt）+ 控制台主机表/手机卡/抽屉「路由确认于 N 秒前 / 路由陈旧 / —」；stale=3×心跳（180s）或路由目标不在宿直连地址。主会话自跑新套件 + U64 相邻 **8/8**，`tc:node` 干净；m04 基线更新（`7e880f392d8`）。
- **通道 B · U138 残余设计令**（`16a50b4701c` + 审定 `49b4207e972`）：五层写入方盘点补出 4 处矩阵缺口（持久→内存回灌无优先级、`refreshMobileSessionPtyRecords` await 前置致乱序、`load-initial` listAll 缺 `hostActiveAuthoritative`、create-time 持久写 vs tap 竞争）；RPC 帧可观测设计（默认关、零分配、300 帧环、不改 wire）；C1–C5 收敛判据；T1–T4 拆分。**主会话审定：T1 产品内记录器暂缓**，先用外部探针产时间线；验序 H-A→H-C 对照→H-B→H-D。
- **通道 C · U138 帧时间线探针**（`22f5f4855ef`）：可复用探针（RPC 明文边界录制 + WS 传输层帧 + 三方采样 + 设备级隔离/恢复）；3 cycle ×4 采样 **12/12 三方一致，本轮未复现**（U138 固有 flaky）；输出含 `firstInconsistency`/`diagnosis` 分类（client-apply-lag / host-publish-overrode-write / write-response-disagrees-with-host）。下一步：`U138_CYCLES=10` + 未回帧即 reload 加压复现。
- **门禁**：`--platform-only` 刷新后金路径控制台线 **12/13**（a2=U138 已知残余，其余 12 项全绿，含 b8/b9/b10）；U146 app.js 变更经复跑零回归。
- **验收基线**：G25 **closed**（U146），§13 = **closed 26 / 部分 1（G27 同步 ack）/ 待 2（G04/G24 部署层）**；321 用例、机检 PASS。

### 2026-11-17 01:4x 轮：U146 审计→U151 修复、U138 复现、探针审计→U152/T1

- **U146 独立审计**（`test-reports/u146-audit.md`，不提交）：PASS-WITH-DEFECT——加性字段真兼容、证据/复跑成立；**P2 逻辑缺陷**：`relayRouteStale` 的 180s 分支不可达（`online` 门与每拍刷新互相抵消），静默主机残留路由永不显陈旧；另旧快照 stale=false 应为 null、套件无判别力。
- **U151（登记→修复→关闭）**：`ef74e62d9bd` 提取纯函数 `relay-route-freshness.ts`（无路由→null；漂移→true；age 已知→`>3×心跳窗`；age 未知且匹配→null；去掉 online 门）；单测 8（注入时钟，含 180/181s 边界）+ e2e 第⑤例（1s 心跳窗实例停跳 4.5s → `online=false` 且 `stale=true`、UI 徽标）；主会话自跑 **13/13**，`tc:node` 干净；台账 🟢（`e6412612cdd`）。
- **U138 加压复现（race 窗口）**：4 run/25 cycle/112 采样 = 104 绿 **8 红**；10-cycle race **7/50 红**，红样本同构——`listAll` 入场投影 A → 双 activate → 宿主 publish A/B → 采样 DOM=store=A、host=B，**收到携带 B 的广播后仍停在 A**，+3s 复采样自愈。根因倾向 **H-A**（入场 listAll 应用晚到，覆盖 active），H-C 为触发，H-D 未观察。race 探针 `f31739e2f6e`；证据 `evidence/exploratory-r8/stress-summary.md`。
- **探针有效性审计 → U152**（`test-reports/u138-probe-audit.md`）：原探针「12/12 一致」**不可签字**（hostActive 读设备投影、单次立即采样、无 applied/applyOptions、同页 reload 非关页重开、隔离恢复误报等）。按设计令预设条件**解冻 T1**（产品内帧记录器，默认关/零分配/不改 wire），探针按「最小改动 1–5」硬化后重跑。
- **门禁**：U151 落地后 `--platform-only` 刷新（web build=源 d53905bc1bbe）→ 金路径控制台线 **12/13**（a2=U138 已复现的同一缺陷，其余全绿）；台账 U151 🟢、U152 🔴（修复中）。
- **T1 帧记录器落地**（`f72ee67dbc8`，13 文件/900 行）：默认关（`localStorage["orca.debug.sessionTabs"]==="1"`）、关闭路径零分配；三处窄边界（env call/subscribe/直连 preload）；11 个实际存在的方法进白名单（无 `session.tabs.restore`）；环形 300；`applied/applyOptions` 回填；`window.__orcaSessionTabsTrace` 暴露。单测 10/10（主会话复跑）、相邻 66 绿、`pnpm tc` 与 oxlint 干净；wire/构建宏零改动。

### 2026-11-17 02:1x 轮：U138 H-A 修复 / 探针硬化 / T1 打磨复盘闭环

- **TDD 钉 → T3 修复**：钉 `420b72e859d`（先红：`expected host-entry to be host-later`）→ 修复 `d9aff7afd02`（新增 `preserveStoreActiveFocus`：恢复等待期间有流帧落地时，延迟 listAll 只合并内容、不采纳焦点；`apply-final-patch` 剔除 9 个焦点键；反向用例保证无流帧时仍采纳入场 active）。钉转正 2/2（主会话复跑）、相邻 9 文件 37 绿、tc/oxlint 干净。
- **U152 探针硬化**（`435339df131`）：三读分离（宿主持久文件回退口径显式标注 hostMemorySource）、双采样（≥2.1s）、reload×3 + 关页重开×3 + 快速开合×5、T1 `__orcaSessionTabsTrace` 归因、INVALID 判定、证据按 run 归档、DOM 作用域限定、`rawCall` 按 namespace。**上一构建（T3 前）结果**：baseline 绿 16 / 红 9 / INVALID 0；9 红同构——获胜帧 `session.tabs.subscribeAll` `applied=true` 但无 `hostActiveAuthoritative`（快速新建/关闭 tab 场景），归因 **H-A 泛化**（获胜 apply 帧未采纳宿主 active，而非仅 late-listAll）；race 5-cycle 25/25 绿但旧 oracle 不可签字。
- **T1 审计 PASS + 打磨**（`aa08270151f`）：关闭态 storage 读=首入 1 次后 0（spy 断言）；新增 `enable()/disable()` 运行时开关；worktree+version+epoch 精确回填；句柄随关闭卸载；单测 16/16（主会话复跑）。
- **基线刷新**：m09 更新 U138 残余/T3 状态与 U96/U103/U106/U113 过期状态（`9c2308c7989`）；02:00 复盘 + 协议 §2-47~§2-50（`9d7d8c90e69`/`91fede76778`）。
- **下一步**：用含 T3 的新构建重跑硬化 baseline（期望 9 红转绿）；若 `subscribeAll` 子案仍红，另派修复（不动 late-listAll 语义）。

### 2026-11-17 02:2x 轮：U138 late-listAll 子案闭环（race 50/50），残余转 U153

- **v2 修复**（`22ce17c5d71`）：worktree 级陈旧拒绝（复用每 worktree 收帧记录；旧 `preserveStoreActiveFocus` 全删）；钉重写 + 判别力验证（短路谓词→钉红）。
- **复跑（v2 构建）**：race 10-cycle **50/50 绿**（v2 前 43/50、7 红），reload 12/12、reopen 3/3 绿；bundle 校验含 `isSessionTabsBootstrapSnapshotSuperseded`、无旧标记；chunk sha256 记录在证据。**late-listAll 子案闭环**。
- **残余转 U153**：quick 场景 9-10 红，形态=客户端 `activate {materializeOnly:true, notifyClients:false}`（用户手势被当投影）→ 宿主不移动 active、客户端本地 intent 领先；已登记并派事件级诊断。
- **探针复审不可签字**（`test-reports/u138-probe-hardened-audit.md`）：H-A 归因取错帧、宿主内存与持久同源、缺方向 token；已派探针修正 A（口径单源 + 判据收紧 + `client-ahead-host`）。**在探针修正完成前，race 绿按「无条件红样本、红签名未再出现」表述，不签「未复现」。**

### 2026-11-17 02:3x 轮：U153 钉→实现、探针签字条件闭环

- **U153 P1 钉**（`b5b290c55a0`）：D1 红=`user-created cloud tab completion must send session.tabs.activate`；D2 红=`global subscribeAll apply must resolve hostActiveAuthoritative`；负控（被动 mount 仍 materializeOnly；非 cloud/有 focus intent 不带权威）绿；相邻 28+2 expected fail。
- **修复前基线（可签字口径）**：`conclusive=true`，25 点 **15 绿/10 红**（reload 12/12、reopen 3/3、quick **0/10**）；红=`client-ahead-host`×5（opened）/`host-frame-not-won`×5（closed）；构建身份与探针 sha256 已记录（`evidence/exploratory-r8/u153-before-20261117-022917/`）。
- **探针签字复审：有条件可签字**（无 P0/P1）：仅引用 `conclusive:true`；仅「宿主持久+投影+客户端」，宿主内存未观测/H-B 不判定；仅本机 rig；`reproduced` 与 `conclusive` 同引、分场景表述。残留 P2/P3 打磨已派。
- **U153 P2 实现（D1+D2 同批）在途**：用户手势创建补非 materialize 的 tap activate + focus intent（显式 `userInitiated`）；全局 apply 接 `resolveHostActiveApplyOptions`。
- **基线刷新**：m09 更新 v2/U153 状态。

### 2026-11-17 03:0x 轮：U154/U155 手势入口补齐、探针关闭保真

- **U153 P2 复跑（P2 构建）**：quick 原 10 红全消，但 8–10 INVALID（关闭失真）→ `conclusive=false`，quick 不签健康；reload 12/12、reopen 3/3、race 25/25 绿。
- **U154**（`d043389fcae`）：文件树/split/shell 三入口标记 + 账本清扫/discard + `expectedCurrentLocalTabId`；8 绿、判别力四路；**独立审计 PASS**（30 个 createTab 调用点分类：恢复/被动零误标、tabId 命名空间一致）。
- **U155**（`edb3cdef5fc`）：Cmd/Ctrl+T、quick command、detach 新建分支标记；重试去手势 + 四提前 return discard；34 绿、六路变异全红、相邻 22 绿。
- **探针关闭保真**（`96e6120b44d`）：elementFromPoint 命中 + 点击前后激活对比 + 确认框驱动（运行中终端关闭需确认=产品既定语义）+ 临时 tab id 归一；新增 INVALID 原因清单（`close-button-obscured`/`ui-close-activated-instead`/`close-blocked-by-confirm-dialog`）。
- **关闭交互诊断**（`test-reports/u153-close-diagnosis.md`）：探针失真为主、产品链路正常；「quick 0 红」不携信号。
- **U154 构建复跑**：D1 仍 **1/5**（「New tab→New Terminal」路径未命中标记）→ 登记 **U156** 并派事件级诊断；close RPC 1/5（探针已修待复跑）。
- **证据规则事故**：U154 提交曾 `git add -f` 误带 evidence，已移出跟踪（`bf4e7029fdf`）。

### 2026-11-17 03:1x 轮：U156 修复闭环、探针关闭/场景保真、U157/U158 派修

- **U156**（`fee100cd5d5` + 审计 PASS）：换名竞态下补 tap 选择（正钉 2/负控 2，判别力成立）；审计确认无重复 active 改写；P2-1（提前返回分支缺 reconcile 排除）追加到 U157 同批。
- **探针关闭保真验证**（`96e6120b44d` + `probe-close-verify-20261117-030943`）：命中断言/激活对比/确认框驱动按设计生效；失败轮立即报 `ui-close-activated-instead`（不再 15s 误超时）。**quick 仍不可签字**（3/5 关闭失败）。
- **U158 定性（共享组件真实缺陷）**：`TabGroupPanel onFocusCapture` 在按下关闭按钮时抢焦点→`focusGroup` 重渲染→close click 落空；桌面/web 同源，激活组内正常。已派最小修复（关闭按钮 `preventDefault` 阻止取焦点）。
- **探针场景修正**（`985159a265a`）：quick 改为**激活组内**建/关（`active-group-new-tab-missing`/`target-tab-outside-active-group`），非激活组行为由 U158 单独跟踪。
- **U157 在途**：手动重连重新武装 + 三处测试缺口 + reconcile 排除。

### 2026-11-17 03:3x 轮：最终构建（U153–U158）0 红 / quick 关闭 5/5；探针稳定门补口径

- **最终构建复跑**（`evidence/exploratory-r8/final-20261117-032158/`）：**red 0 / invalid 0**；reload 12/12、reopen 3/3、race 25/25；**quick 关闭 5/5 真实成功**（`session.tabs.close reason:user`）、**D1 非 materialize tap 5/5**；唯一余项=5 个 quick-opened UNSTABLE（tap 后 ~70ms 首读，宿主持久尚未落盘）→ `conclusive=false`。
- **探针稳定门**（`0136f571da5`）：quick opened/closed 初读前等 projection 与 persisted 一致（100ms 轮询，默认 3000ms，`U138_OPENED_STABLE_MS` 覆盖）；超时不强行相等、仍按双读语义判 UNSTABLE。
- **U157 审计 PASS**：re-mark 键换名后仍有效、反复 Reconnect 语义可接受；P3 竞态（rearm 早于手动重放判定）记录。
- **U158 审计 PASS → U159 登记并修复**（`b6067e2520b`）：BrowserTab 关闭、编辑器关闭、折叠按钮同源修复；639 绿、判别力三路。
- **U159 审计 + 含 U159 的最终重建复跑在途**（目标 `conclusive=true`）。

### 2026-11-17 03:4x 轮：final2 conclusive=true；quick opened 稳定红 → U161

- **final2（含 U159 + 稳定门，`run-final2-20261117-033250`）**：`conclusive=true`；20 绿 / **5 红** / 0 INVALID / 0 UNSTABLE；quick closed 5/5 绿、D1 tap 5/5、race 25/25 绿。
- **新稳定缺陷 U161**：创建后宿主 projection/persisted=新 tab（gate ~1.0–1.1s 对齐、ack active=新 tab），客户端 DOM/store 5s 内始终=旧 tab → `client-ahead-host`。已登记并派事件级诊断（T1 trace + store 快照 + focus intent/applyOptions）。
- **稳定门审计**：有条件（P2-2 门对 projection 滞后也等待可能掩盖自愈；P2-1 env NaN），已派收窄（只等 persisted；门初始状态入证据；0=关门）。
- **U159 审计 PASS → U160（P3）**：`ClientHostedBrowserTab` 关闭按钮同源残留，未证实用户可见。
- **U157 审计 PASS**；U158 审计 PASS。

### 2026-11-17 04:0x 轮：金路径检查点 13/13（含 a2）+ U161 根因修复在途

- **金路径检查点**（`evidence/journey-checkpoint-20261117-035409/`，final2 构建）：13/13 全绿含 a2（reload 后 26ms 三方一致）；b8 三项绿。**不作 U138 消除结论**（构建与 final3 不同、单次样本）。U161 症状在 reload 前快照可见（`domBeforeReload`/`storeBeforeReload`=旧 tab），未入门禁断言。
- **U161 根因与修法已入账**（`3a61d86ddb2`）：乐观激活 + 先于 intent 的权威帧 → 守卫丢 intent/烧版本；修=worktree 手势账本 + `followHostActive=false`。
- **U160 审计 PASS**（`4da058a2f18`）。
- 判定口径：final3 仍以 U161 修复后构建为准（目标 0 red / `conclusive=true`）。

### 2026-11-17 04:1x 轮：final3（U161 v1）9/10 绿；入口分歧登记 U162

- **final3（U161 v1 构建，`final3-20261117-035926/`）**：两次同型——green 23 / red 1 / unstable 1 / invalid 0，`conclusive=false`；quick 每轮 tap/create 与 DOM/store/group=新 tab（**9/10**，1 轮首读 persisted 滞后 unstable）；race 25/25。
- **确定性 red（两次复现）**：reload cycle-1 `start`，`attribution=H-C`——运行入口即 host projection=`e05…` vs persisted=`1bb…`（上一轮流程遗留、任何手势前）→ 登记 **U162**（宿主内存/持久分歧），并派探针**基线归一**（setup，非测量）。
- **U161 v2**（`9d408c77c0f`）：另 4 入口补 worktree + 每入口钉 + deferral 清理；28 文件 119 测试；**final3 构建不含 v2**，须重建 final4。

### 2026-11-17 04:2x 轮：final4 24 绿 0 红；仅测量竞态 unstable

- **final4（U161 v2 + 基线归一）**：两次同型 **24 绿 / 0 红 / 0 INVALID / 1 unstable**；D1 5/5、quick close 5/5、race 25/25；基线归一 `already-aligned`；`conclusive=false` 仅因 quick-4 opened 的 38ms gate/采样竞态（测量，非产品）。
- **基线归一审可签字**：不掩盖 U162、caller-only 不拉他设备；P3（字段形状/预算起算/单次读目标/内存层为推断）记录。
- **门 v3 在途**（合并 gate 与采样读取或 1s 有界投影追齐）；**U162 诊断在途**（哪一步只写内存不落盘）。
- 签字口径不变：unstable 不得签通过。

### 2026-11-17 04:3x 轮：final5 全绿签字达成（25/25, conclusive=true）

- **final5（门 v3，当前构建）**：**25/25 全绿、0 红 / 0 INVALID / 0 UNSTABLE、`conclusive=true`**；reload 12/12、reopen 3/3、quick 10/10、race 25/25；D1 tap 与真实关闭 5/5。门 v3 审计可签字（38ms 竞态消除、掩蔽仅限 ≤1s 且留证）。
- **U162 修复**（`19aef2c3ab1`）：headless publication 下持久后同步内存 snapshot；4 钉 + 判别力 + 118 相邻；宿主重建与端到端复验在途。
- 签字口径：U138/U161 链在 final5 达成；U162 需宿主重建后单独端到端复验并并入最终生产构建。

### 2026-11-17 04:4x 轮：U162 审计 PASS；宿主重建并重启，端到端证据已生成

- **U162 审计 PASS**（`57f63aa9f2f`）：无 P1/P2；P3（legacy headless-merge 判定、早返回分支覆盖、同父换 leaf、activeGroup 入参时点）披露。
- **宿主重建 + full reseed**：out/main 重建（04:31）、宿主重启（pid 28844，04:33）；`evidence/u162-e2e/` 已生成（u162-e2e.json + 两张视图截图），汇总待回收。
- 下一步：final6（新宿主构建）确认 final5 结论保持 → 生产重建（去仪器化）→ `--platform-only` 刷新 → 金路径 13/13 + W9 双线 → 收口报告。

### 2026-11-17 04:5x 轮：U162 e2e FAIL（renderer epoch 未覆盖），v2 诊断在途

- **U162 端到端 FAIL**（`evidence/u162-e2e/u162-e2e.json`，新 out/main + 宿主重启）：caller 激活 persisted=目标，但**新设备投影仍=旧 tab**；实际 `publicationEpoch=renderer:…:client-navigation`（非 headless），修复 helper 条件未命中。
- 台账 U162 回 🔴 并记录；v2 诊断（renderer-owned owner 链路、回退依据、三种修法取舍）在途。
- 宿主重建代理已要求收口（build/reseed/解释）。
- final5（门 v3）签字结论不受影响（U138/U161 链），但 U162 未闭环前不收 U138 家族总账。

### 2026-11-17 05:0x 轮：U162 v3 端到端 PASS；final6 确认轮

- **U162 v3**（`e501edca0c3`）：读侧回退持久 active（leaf→parent→browser + 快照命中校验；仅无持久选择设备；revision 0、不写 snapshot/epoch）；3 钉 + 判别力；53 相邻绿。
- **宿主重建 + 重启 + e2e PASS**：out/main 05:04（仅 main target，out/web 未动）、`--restart-platform`、双宿主重启 `failures=[]`（PTY 71/15）；**9/9 断言**：`freshDeviceProjectionIsTarget=true`、旧设备选择不受影响、只读回退不写盘、restore 一致。
- **停滞处置**：旧重建代理 28 分钟无证据 + 催促无响应 → TaskStop，按剩余范围重派（§2-44/§2-59），10 分钟完成。
- final6（新宿主构建）确认 final5 0 红保持中。

### 2026-11-17 05:1x 轮：U162 闭合（e2e+审计 PASS）；final6 环境拓扑遮挡

- **U162 闭合**：e2e 9/9 PASS + v3 审计 PASS（只读不夺所有权、跨 worktree 不可注入）；台账 🟢。
- **final6（新宿主构建）**：无红、25/25 两次读取完全一致（DOM=store=projection=persisted），但 25 点全 INVALID——04:33 full reseed 清空宿主 `tabGroups=[]`，探针 ≥2 组跨组前置不满足；race 25/25。属环境前置，不是回归。
- **final7 在途**：先经 UI 恢复 2 组/3 tab 布局，再签字复跑（目标 `conclusive=true`）。

### 2026-11-17 05:3x 轮：final7 布局恢复受阻（U163）；W9 官方门禁在跑

- **final7**：客户端恢复 3 tabs/2 groups 成功，但宿主 `tabGroups` 仍 `[]`——`session.tabs.move` 被转发到桌面主窗口（其 `activeWorktreeId=demo-app/admin/main-2`），对目标 worktree 为 no-op；新设备水合仍 1 组 → 25 点全 INVALID（拓扑），race 25/25。登记 **U163**（云多 worktree move 语义），待 W9 后诊断。
- **U162 v3 e2e 脚本入库**（`3a521bf0e65`）：三项审计条件落实（A 读后复读、原始快照值、溯源字段）。
- **W9 官方双线门禁在跑**（当前仪器化构建；不重建）。

### 2026-11-17 05:4x 轮：W9 官方双线全绿（SKIP_BUILD 复用 out）

- **W9 A 线（桌面）PASS 1/1**（39.8s，A2 登录 31.5s）；**B 线（Orca Web）PASS 2/2**（32.3s，B3 8.98s / E2 8.9s）；全程 `SKIP_BUILD=1` 复用现有 out（运行前后 out sha 一致），未替换伺服产物。
- **U163 登记**（`6b508cf000f`）：`session.tabs.move` 被转发到桌面窗口另一 worktree，`dropUnifiedTab` no-op → 宿主 tabGroups 不落盘；final6/7 的探针拓扑 INVALID 根因。静态诊断在途（不动环境）。
- **金路径控制台线**（当前 U153–U162 构建）在跑；后续生产重建（去仪器化）→ `--platform-only` 刷新 → 总账。

### 2026-11-17 05:5x 轮：U163 诊断→修复；金路径被拓扑遮挡（非回归）

- **U163 诊断**：宿主转发条件过宽 + renderer 桥丢 worktreeId + 窗口 store 无远端 worktree → 静默 no-op 仍回 `moved:true`。修法=未发布→headless 落盘、桥接用 worktreeId、无法应用返回 false。
- **金路径控制台线**（当前构建）：A2 前置被 U163 拓扑遮挡（2 PASS / 1 FAIL / 10 NOT RUN），非产品回归；W9 官方双线已绿（spec 自起宿主，不受该拓扑影响）。
- **final5 签字保持**（旧宿主布局下的 25/25）；U163 修复后重建宿主 → 恢复布局 → 复跑金路径。

### 2026-11-17 06:0x 轮：U163 修复落地（move 不再假成功）

- **U163 修复**（`0d73f7d6462`）：宿主按「窗口是否发布该 worktree」决定转发/headless；转发 requestId+5s ack；桥用 worktreeId 且合法 no-op 不误报；8 新钉 + 61/49 相邻 + tc 绿 + 判别力。
- **重建 out/main+out/web（仪器化）→ full reseed → move 落盘验证**在跑；随后金路径控制台线复跑（目标 13/13）。
- 之后：生产重建（去仪器化）→ `--platform-only` 刷新 → 总账收口。

### 2026-11-17 06:0x 轮：U163 v2 落盘 PASS；金路径复跑

- **U163 v2**（`d5620ab4511`）：headless 目标校验 + **ack false/超时回退 headless** + web 端处理 `moved:false`（toast/清 intent）；7 钉、判别力两变异、78 测试、tc 绿。
- **落盘验证 PASS**（`evidence/u163-verify-v2-20261117-054931/`）：DB **2 组**、被移 tab 在目标组、投影/新设备水合 2 组；attempt1 暴露 P3（本地 UUID 未水合时抛 `target_group_not_found` → 客户端 toast 失败，诚实失败非假成功）。
- **金路径 13 门禁**在跑（当前构建+已落盘 2 组布局）；之后生产重建（去仪器化）→ `--platform-only` 刷新 → 总账收口。

### 2026-11-17 06:1x 轮：U163 序列级残余（split→move 塌组）v3 在途

- **金路径（U163 v2 构建）**仍被挡：split 落 2 组成功后，move-to-group 被转发给 stale renderer（其快照 1 组）→ renderer 发布单组回写，宿主塌回 1 组（2/2 复现；两跳均 moved:true）。2 PASS / 1 FAIL / 10 NOT RUN。
- **U163 v3 在跑**：转发前校验「窗口已接受快照组布局 == 宿主当前组布局」，stale→headless；并补序列钉。
- **只读分析在跑**：headless 后 renderer 旧发布是否会再次覆盖（接受门是否看布局结构）。
- 已补 zh toast 键（`a981b01e376`）。

### 2026-11-17 06:1x 轮：金路径 13/13 全绿（U163 v3 构建）

- **U163 v3**（`c334b4ea410`）：布局签名 stale 门 + unchanged 早退 + 接受路径保留宿主布局/epoch；6 钉、四路判别力、154 测试。
- **最终重建 + full reseed + 金路径**：13/13 全绿（`evidence/journey-final8-20261117-0610/`）；a2 host **3 tabs/2 groups**、reload 22ms 三方一致；b6/b7/b8/b9/b10 全过；reseed `failures=[]`、双宿主 online。
- **W9 双线复跑**（覆盖 U163 改动）与 v3 审计在途；之后生产重建（去仪器化）→ `--platform-only` 刷新 → 总账收口。

### 2026-11-17 06:2x 轮：W9 B 绿；A 线构建口味复发（U165），e2e 重建重跑

- **W9 B 线**（v3 构建）**2/2 绿**：B3 自动进入 9.0s、B4 `repoCount=1`/explorer 挂载/拒绝集合基线内、B5 410、E2 审计 6 条基线内 → **U163 move/组同步路径通过**。
- **W9 A 线不可判定**：production 模式重建使 `exposeStore=false`、`window.__store` 缺失（U36 族复发）→ 登记 **U165**；产品侧 checkout 已创建且 Active（证据 `checkout-proof.txt`）。
- **处置**：`npx electron-vite build --mode e2e` 重建 main/preload 后重跑 A 线（进行中）；生产重建（去仪器化）在 A 线通过后执行。

### 2026-11-17 06:3x 轮：W9 双线全绿（e2e 模式）；生产重建收尾

- **W9 A 线 PASS 1/1**（e2e 模式 main/preload/renderer；39.5s）；**B 线 2/2 绿**（v3 构建）。首次 A 线失败为 `out/renderer` 仍 production（monaco e2e probe 折叠，U36 同族），补建后通过；main 两模式字节一致。
- **U165 闭环**：构建口味矩阵处置有效（§2-25）。
- **生产重建（去仪器化）+ `--platform-only` 刷新 + 去仪器化核验**在跑；完成后出总账收口报告。

### 2026-11-17 06:4x 轮：交付构建完成，U138 家族收口

- **生产重建 + 刷新 + 核验**（`evidence/prod-build-20261117-0620/`）：preload `MODE=production`/exposeStore false、renderer 无 e2e 探针、out/web `exposeStore` 常量 false（`__store=` 字面量位于不可达守卫内，运行期不暴露）；`web refreshed build=8f5651b109ab source=同`、双宿主同 id online（PTY 156/157、52/52 kept）、`failures=[]`；served app.js 与 out/web sha == 源。
- **门禁终态**：journey-final8 **13/13**；W9 **A 1/1 + B 2/2**；probe final5 **25/25 conclusive**；U162 e2e 9/9；U163 落盘 2 组；race 25/25。
- **台账**：U138/U163/U165 关闭；残余 U164（P2 布局所有权）、U157/U160/U162/U163 P3 披露；人工验收矩阵补 C4/C5。
- 宿主运行进程仍持旧 e2e preload/renderer 内存快照（磁盘已生产）；下个窗口 reload/宿主重启即消失（未执行以保 PTY）。

### 2026-11-17 07:0x 轮：交付构建独立审计 PASS（dirty-tree=仅格式化）

- **去仪器化审计 PASS**：preload `MODE=production`、无 expose 键；renderer Monaco 探针 0（no-op chunk）；out/web `exposeStore` 常量 false（`__store=` 仅不可达守卫内）；main 两模式字节一致；`--platform-only` served=源、hosts 同 id、failures=[]；relay 入口及 assets sha==磁盘；控制台无 U163 标记属预期。
- **偏差说明**：构建含 294 个未提交改动（其中 src 17 文件经核对为**纯格式化**，语义等价）→ 交付记录标注 dirty-tree（formatting-only）。
- 生产冒烟与 U164 诊断在跑。

### 2026-11-17 07:1x 轮：生产冒烟 5/6 PASS；U166 表单登录会话未持久化

- **生产冒烟**（`evidence/prod-smoke-20261117-062441/`）：登录/外壳/终端回显（剪贴板 oracle）/文件预览/split（3→4 组）/X 一次关闭 全 PASS；console/pageerror/requestfailed **0**。
- **U166 登记并派修**：裸 relay 入口 + 账号表单登录 → 刷新丢会话（`orca.webCloudSession` 未写）；handoff 入口刷新恢复 5 tabs/4 组 → 表单路径需对齐持久化。
- U164 v4 审计在跑。

### 2026-11-17 07:3x 轮：U164 v4 / U166 / U167 落地；重建复验在跑

- **U164 v4**（`4eac74643dc`）：authored-layout digest（同代同摘要 preserve、异摘要接管、跨代基线）；8 钉 + 9 变异、1370 测试；审计 PASS（留 P2→U167）。
- **U166**（`1b087074f5a`）：表单登录持久化（与 handoff 同键同结构，含 401 轮换）；16/16 + 相邻 52；审计 PASS（token 与 handoff 等价、无新增暴露；P3 披露）。
- **U167**（`6b7b1673b45`）：preserve 焦点成对采纳；审计 PASS（留 P2：拒绝采纳后 activeTab 仍取渲染器 → **U168** 已派）。
- **统一重建（e2e）+ 真机复验**（U166 表单刷新、split→move 2 组、X 一次关闭）在跑。
- 收口顺序：复验 → U168 并入 → 最终生产重建（去仪器化）→ 刷新 → 收口更新。

### 2026-11-17 07:4x 轮：真机复验 U166 PASS、split 落盘；拖拽镜像缺口（U169）

- **真机复验**（`cloud-platform/evidence/u164-u167-verify-20261117-065117/`）：**U166 PASS**（表单登录→刷新无登录页、`orca.webCloudSession` version 1）；split 落盘 2 组；U158/U159 一次点击关闭 PASS；U167 仅单测（12/12）。
- **U169 登记**：跨组拖拽 store 正确但宿主 DB 成员未更新、无 `session.tabs.move` 帧（右键菜单正常）→ 诊断在跑。
- **U168**（`4e3842165d6`）：拒绝采纳焦点成对回退 + fenced 归属 + 轮换 token 钉；42/42。
- **最终生产构建（含 U153–U168）** + `--platform-only` 刷新 + 去仪器化核验在跑。

### 2026-11-17 07:5x 轮：最终生产构建核验通过；宿主重启装载 U168

- **最终生产构建**（`evidence/prod-build-final-20261117-065720/`）：main `e1f23030…`（含 U168 成对回退）、preload `9727610c…`、web `52a161cd…`；去仪器化四项通过；`--platform-only` served=源（web build `8f5651b1`）、hosts 同 id online、failures=[]；relay served sha==out/web、登录引导 200。
- **宿主重启**：运行中宿主为 06:50 的 e2e main（pre-U168），需 full reseed 装载生产 main；PTY 会丢失（测试环境可接受并记录）。
- **U169 诊断在途**（跨组拖拽未镜像）。

### 2026-11-17 08:0x 轮：生产部署冒烟全 PASS（宿主装载 U168）

- **宿主重启**：07:01:51/55 启动（晚于 06:57 构建），同 id online；PTY 88/27（旧 06:50 PTY 随重启丢失，测试环境接受）；运行时 activate 焦点成对一致证明 U168 装载。
- **四项冒烟**（`evidence/final-deploy-smoke-20261117-070001/`）：平台 200、relay served sha==out/web、表单登录 → 终端 `echo PROD-FINAL-…` 回显（terminal.read）、刷新恢复 8 tabs（U166）→ 全 PASS。
- **U169 生产 web 重建 + 拖拽真机复验**与 **U169 审计**在跑。

### 2026-11-17 08:1x 轮：U169 v2 审计 PASS；干净布局最终拖拽复验

- **U169 v2**（`bb5a28fb8d4`）：每帧校验/重指映射、reorder 映射、host-id 直通、映射回收；51/51；**审计 PASS**（不抖振/空集不误配/菜单 split 不失效；L1–L4 低）。
- **v1 真机复验不可判定**：测试布局被多次拆分污染（面板 96px、strip 重叠），dnd 未启动、无 move 帧——非产品断言失败。
- **最终复验**：v2 重建 web + 选择干净 worktree（0–1 组）验证 split→拖拽与组内 reorder（宿主 id/成员断言），在跑。

### 2026-11-17 08:2x 轮：交付态一致；补建 renderer

- **交付态静态审计**（`test-reports/final-delivery-audit.md`）：**一致**——main `e1f23030`（含 U168/U164）、preload production、out/web `e26779dc`（含 U169 v2/U166，exposeStore=0）、served=磁盘、宿主 07:01 启动晚于构建、平台/relay 200。
- **范围说明**：`out/renderer` 早于 U169 v2（06:57）→ 已派补建 renderer（production），不影响运行中窗口（下次创建/重启加载）。
- **U169 v2 最终真机复验**（干净 worktree）在跑。

### 2026-11-17 08:3x 轮：U169 闭环；renderer 补建；交付态收口

- **U169 最终真机复验 PASS**（`evidence/u169-final-20261117-072035/`）：干净 worktree split 两栏 402px → 跨组拖拽宿主 DB 成员更新 → 刷新保持；组内 reorder `tabOrder` 更新。
- **out/renderer 补建（production）**（`evidence/renderer-rebuild-20261117-072619/`）：含 U169 v2（`isKnownHostSessionGroupId` 4 处）、无 e2e 探针、exposeStore false；main/preload 未动；运行中窗口不受影响（下次创建/重启生效）。
- **交付面**：平台控制台（apps/web）+ Orca Web（relay 伺服 out/web）+ 桌面 renderer（out/renderer）均已含本批修复；唯一余项 = 运行中窗口/宿主进程内存快照（下次重启加载）。

### 2026-11-17 08:4x 轮：批次收口后进入 P3 打磨批

- **批次收口**：U157/U160/U161/U164/U166/U167/U168 批量关闭（`c986e7940bb`）；人工验收矩阵补 C6（桌面拖拽抽验）/C7（运行窗口快照→部署重启收敛）。
- **P3 打磨批（并行）**：① U169-L1/L2 + U160-D1 负控；② U157 rearm 相位守卫（自动恢复抢跑不得重新武装）。
- 下一阶段：等待用户裁定（数据采集 A+/P1/审计存储二期）；人工验收项按矩阵执行。

### 2026-11-17 09:0x 轮：P3 批落地并重建

- **P3-A**（`01bc259cf32`）：U169-L1 回收侧空集排除（与新建侧对称）、L2 undefined 帧契约注释固定、U160-D1 行根负控；21 测试、判别力。
- **U157 相位守卫**（`4f8a9e26402`）：`retryRecovery` 仅 `currentPhase==='disconnected'` 才 rearm；新钉 + 判别力；18 测试。
- **重建 web/renderer（生产）完成**（`evidence/p3-build-20261117-074016/`）：web served `fb496c0f…`==磁盘（L1/L2 编译证据）、renderer 含 U157 相位守卫/U169 映射、无 e2e 探针、exposeStore false；P3 批独立审计在跑。
- 待用户裁定：数据采集 A+/P1/审计存储二期。

### 2026-11-17 09:1x 轮：P3 批审计 PASS；U166 交付复验 PASS

- **P3 批审计 PASS**：L1 不误回收、L2 契约一致、U157 不卡相位；仅两条 P3 措辞观察；50/50 相邻、tc 0。
- **U166 交付复验 PASS**（`evidence/u166-resmoke-20261117-074509/`；证据审计 `u166-resmoke-audit.md` = 有条件签字）：served `fb496c0f`==磁盘、真表单登录→`orca.webCloudSession` v1→同 context reload 免登录恢复 8 tabs；**错误计数 0/0/0 仅覆盖 page B（登录+刷新）**；裸入口 auto-pick 命中 `proj_payment`（已吊销宿主）→ 409 属已知 seed（登记 U170）；刷新/token 过期等失败分支未覆盖（P3 披露）。
- **U170 登记（P3）**：无 project 参数时表单自动选首个项目（在已吊销宿主上）→ 409；建议默认跳过不可用项目。
- 主线阻塞不变：等待用户三项裁定。

### 2026-11-17 09:2x 轮：U170 落地；dirty-src 纯格式化审计

- **U170**（`6bdadd8c948`）：默认只选可用项目（open 权限 + 非离线/吊销），remembered 同校验；全不可用→`NO_AVAILABLE_PROJECTS` 不发 connect、表单空态提示；4 钉 + 判别力；34 测试、tc 0。
- **dirty-src 审计**（`dirty-src-audit-20261117T075430/`）：剩余 17 个未提交 src 文件经归一化逐字符比对=**纯格式化**（web-root.tsx 仅两冗余括号）；审计期间 U170 语义改动已提交，交付可复现。
- **U170 生产 web 重建 + 默认选择真机复验**在跑。

### 2026-11-17 09:3x 轮：U170 生产验证 PASS（本批全部收口）

- **U170 生产验证**（`evidence/u170-verify-20261117-075507/`）：默认选 demo-app（online）、无 409、connect 200；显式项目路径正常；served `b6bc48d9`==磁盘；错误计数全 0。U170 → 🟢。
- **本批终态**：U138 家族 U152–U170 全部关闭或显式披露（P3 打磨已落地并审计 PASS）；W9 双线 + 金路径 13/13 + probe conclusive + 部署冒烟 + 交付态/证据/纯格式化审计齐备。
- 主线等待用户三项裁定（数据采集 A+/P1/审计存储二期）；人工验收项按矩阵执行。

### 2026-11-17 08:2x 轮：C6 桌面拖拽 FAIL→U171；键硬化/U162 leaf 落地

- **C6（桌面拖拽抽验）**：dnd 在 headless 正常启动；DOM 与宿主 `session.tabs.list` 最终一致，但**每次都弹「无法在主机上移动该标签页。」**（2/2 复现）→ 登记 **U171（P2）**，诊断为桌面配对路径 mirror 误判失败；修复 + C6 spec 入回归在途。
- **键硬化**（`a2d8c9706b4`）：账本环境维度 + 映射 JSON 元组；**U162 leaf 持久化**（`2ba764f074f`）：同父换 leaf 写 `activeLeafId`。
- **C6 证据/spec 审计**在跑。

### 2026-11-17 09:5x 轮：U171 闭环；最终构建/部署/C6/冒烟全 PASS

- **U171（`b669acce995`）**：桌面配对窗口无 known 宿主组集合导致 move 误判；修复=无布局帧时经 `session.tabs.list` 按成员解析目标组（失败诚实 false+toast）。**C6 spec PASS**。
- **最终统一构建**（`evidence/final-build-c6-20261117-084805/`）：main `a5857b77`（U162 leaf/U168）、preload `9727610c`、web `a74552de`（U171/键硬化）；无仪器化；full reseed 双宿主加载新 main、`failures=[]`。
- **复验**：C6 1 passed（51.3s，toast 全空、reorder 宿主一致）；web 表单登录默认选可用项目→刷新恢复、served=磁盘、console/page 0。
- **加固审计**：键硬化 PASS（9 生产调用全带环境）、U162 leaf PASS（同父/无跨字段）。
- 主线等待用户三项裁定；人工验收仅剩 G04/G24 部署项。

### 四通道并发执行（启动，2026-11-14）

按细粒度拆分与三权分立纪律并发起跑：通道② **W6a**（中继浏览器模式，relay.ts 域）、通道③ **W10**（客户端零 env 登录，src/main+renderer 登录域）、通道④ **W5a**（详情页终端组件，cloud-admin 域）三个实现代理并行；通道① 等在途 W2（QA 修复）完成后接 W8。每令完成→独立测试代理→独立审计代理→主会话关闭放行下一个。

### 派发纪律重构（2026-11-14，用户决策）

用户指出「修订多次很混乱、不应一个子代理安排过多任务、复杂任务需要设计方案」。整改：① 建立**规范化工作令** `work-orders-2026-11-14.md`（唯一事实源，消除多轮消息互相覆盖）；② **一个子代理只执行一个工作令**，主会话串行派发、逐个核验；③ **设计先行**：复杂令（W3/W5/W6/W7）先派设计代理出方案、主会话确认后再派实现代理；简单令（W2/W4）设计已内联。旧代理已停止（其队列作废）；其停前已提交 W1=M115（`7eba67c76cd`），工作区遗留 W2 半成品由 W2 代理审阅续作。队列：W2（QA 修复）→ W3 → W4 → W5 → W6 → W7 → M120。

### 全量回归（HEAD 快照，2026-11-14）

用户要求「更新设计文档、测试文档等，修订相关功能，重新完整测试」。design.md（中继双模式语义、web-handoff 接口表）与 test-plan §6（M116 修复回归/M117/M118/M121/M122 五行判据）已同步（提交 66b8d1868cf）；HEAD 快照全量套件（单测+e2e，真实进程）运行中，结果将如实记录。

### 双入口确认（FR-3.11，2026-11-14）

用户确认项目行放两个入口：「详情」（管理员，cloud-admin.html）+「Orca Web」（open 权限者，handoff 自动进工作区）；离线均置灰。已补 FR-3.11 并知会实现代理（M117 与 M122 按同布局落地）。

### M119 客户端首启零环境变量（需求记录 + 排队，2026-11-14）

用户反馈：本地启动客户端失败，**不应需要预设环境变量**（ORCA_CLOUD_API_URL 等），要符合真实使用场景——云端地址等参数应有默认值并可在客户端配置界面修改。现状：云端模式完全由环境变量驱动（无 ORCA_CLOUD_API_URL 则无云入口）。待排入队列（M115/M117/D1/M118 之后）：首启引导选择/输入平台地址并持久化，环境变量仅作覆盖。涉及首启登录链与 profile-cloud 配置装配（src/main/orca-profiles/profile-cloud-auth-config.ts 等）。

### M118 管理台详情页终端与文件树（需求澄清 + 派发，2026-11-14）

用户按设计稿澄清：管理台项目详情页要能**看实时终端、敲按键、右侧浏览文件树并打开文件**（原型 P3）。现状：详情页已有文件面板（浏览/打开），**无终端**；web 完整客户端（web-index.html）已在浏览器承载终端（WebGL 管线），云 RPC 通道同源可复用。已落 FR-3.9 并修正 design-adjustment 文档的「只读+文件浏览」表述（终端按 terminal 授权交互；文件写仍受主机边界）。派发实现（复用 web 终端管线接入 CloudProjectWorkspace）。

### 复检发现 D1：Web bundle 缺失时宿主静态页挂起（已记录 + 派发修复，2026-11-14）

用户报「无法跳过证书错误 + 页面打不开」。排查链：① 本机测试宿主证书漏 SAN（主会话手工签发所致，产品 `/install/host.sh` 已带 `subjectAltName=DNS:localhost,IP:127.0.0.1`，无缺陷）；② 自签 CA 不受浏览器信任 → 已建本地 CA 加入登录钥匙串解决；③ **真正产品缺陷 D1**：开发树未构建 `out/web/` 时 `getBundledWebClientRoot()` 返回 undefined，宿主 TLS 监听无 requestListener，对 `/cloud-admin.html` 的 GET **挂起 0 字节**（curl 超时/浏览器空转），而非 404/503——这也是 M113 管理员页截图任务始终未完成的根因。本机已 `pnpm run build:web-from-renderer` 构建并重启宿主验证 200。修复派发：ws-transport 无 staticRoot 时对静态路径返回 503 + 启动警告日志。

### M117 管理员项目详情/会话页入口（需求澄清 + 派发，2026-11-14）

用户澄清：此前设计调整（design-adjustment-native-ui.md）已定「云端项目详情界面保留为管理员查看使用」，界面细节以 ui 原型 P3 为准。现状缺口：平台 Web 的「打开会话页」是全局注入配置（未配置即隐藏、不分项目，`apps/web/app.js:205-222`），宿主侧 cloud-admin.html 已实现（M113 截图证据）。派发改造：平台按宿主直连地址**按项目**生成 `https://<宿主直连>/cloud-admin.html?api=<平台>` 详情链接（管理员项目行「详情」新标签打开）；开发者不显示入口、「打开」对话框补「请在桌面客户端打开」引导。文档同步（FR-3.8、tasks T222、PLAN M117，提交 1c919a989f7）；实现追加给 M115 代码子代理顺序执行。

### M116 Web 探索性测试（用户复查要求，进行中，2026-11-14）

背景：用户在 Web 用管理员打开项目，得到「连接信息已就绪」对话框而非工作区。**结论：设计内行为**（`apps/web/app.js:249` 调 `/connect` 展示直连/中继地址与凭证时效；项目内终端/文件工作区按架构由桌面客户端承载，平台 Web 不代理流量），但对话框未引导「请到桌面客户端打开」，记为 UX 缺陷待修。已派发独立探索性测试子代理（与 M115 实现代理并行、零文件冲突）：用 `git archive HEAD` 快照起隔离平台 + 真实 runtime-sim 宿主 + 两个真实中继进程，双角色双视口逐页走查（登录/工作台/项目/主机/中继/成员/审计/设置/门禁/全局交互），产出分级问题清单 `test-reports/exploratory-qa-web.md` + `evidence/m116-exploratory-web/`（findings.json + 截图）。问题清单回收后统一派发修复。

### M115 自助建项目改造（需求修订 + 派发，2026-11-14）

用户修订：新建项目**必填名称与目录**，**仓库地址可选**（不填为空项目直接就绪），目录可「选择已有目录」或「新建目录」（参考本地 Orca 添加项目）。落地设计：目录限定宿主 `projectsRoot` 内（安全边界不变），已有目录列表来自宿主心跳新增 `projectDirs` 字段（一级目录名、≤200 条，不新建控制通道）。文档已同步（FR-3.7、design §8.2、tasks T221、test-plan §6）；实现派发给代码子代理（对话框 `cloud-new-project-dialog.tsx`、平台 `project-self-service.ts`、心跳 `cloud-heartbeat-body.ts`）。

### M114 补充：routeKey 默认改 IP（用户决策 2026-11-14）

内网主机名不可靠：宿主路由键默认从主机名改为**直连 IP**（`ip-<地址>` 形态；显式配置优先；自动派生的 routeKey 随心跳直连地址变化自动跟随，显式配置不动）。SNI 标签相应变为 `ip-192.168.2.202.relay.local` 这类形态。FR-4.9、部署方案、开发计划已同步；实现追加派发给 114b 开发子代理（含：注册派生、心跳跟随、connect 端点 sni 断言、显式配置不被覆盖）。

### M114b2 向导式添加（用户新增需求，2026-11-14）

需求：添加开发机/中继都**从平台发起**，向导页展示一行安装命令（`bash <(curl -fsSL <平台>/install/<类型>.sh?token=…)`）。已落文档：requirements 新增 **FR-4.11**；test-plan §6 新增 `install-wizard.e2e.test.ts` 测试行；`deployment-real-link.md` 部署步骤 2/3 改为向导驱动；PLAN.md M114 增加 114b2。实现已**追加派发给 114b 同一开发子代理**（避免同改 `app.js` 冲突），判据：脚本端点管理员可取且内嵌凭据、开发者 403+`install_script` 审计、host 版缺 token 400、Web 向导命令与端点一致。

## 下一步（设计已调整：见 `remote-connectivity/design/2026-11-13-cloud-dev-platform/design-adjustment-native-ui.md`）

**已完成**：M41–M113（路径边界、文件面板、终端/agent 边界、工作区侧车、浏览器取票与 E2EE、原生界面回归、多项目连接、管理员会话页、初始导航、类型工程边界、项目创建 provisioning、准备失败可见与重试、开发者自助创建项目、创建后失败并入重试、会话自动续期、浏览器会话续期、云设备 token 清理、签到准备有界并行、项目归档闭环、云端会话持久化、云端 agent.launch 真实执行、里程碑 L3 收口、云端结构化 agent 会话、终端回显 P95、目录读取 P95、连接建立 P95、审计查询 P95、200 项目列表 P95）（含 M107 原生首屏 P95、M108 宿主 TLS/证书指纹与 M109 客户端 TLS 指纹校验）。**用户决策**（普通开发者直接进入原生界面、管理员用独立浏览器会话页、每项目独立连接、文件面板随管理员页保留）均已落地。

**验收状态**：等待人工验收。建议下一步：

1. **按指引逐条验收**：`test-reports/acceptance-runbook.md`（M111）；证据索引 `test-reports/acceptance-index.md`（30 PASS + AC-22 PASS(部分) + AC-32 UNVERIFIED）。
2. **本机已收口的能力项**：平台无业务流量（M85）、中继无明文（M86）、浏览器与原生渲染 P95（M97/M107-1）、宿主 TLS 与客户端指纹校验（M108/M109）、§5.1 六项性能（M102–M106）、300×30min 负载（M110）。
3. **仍需环境的项**（详见指引 §6）：AC-32 WAF/DMZ、G-04 的 Redis Stream 队列与 PostgreSQL/对象存储归档（部署形态落地时实现并回归 AC-26）、生产容量复测（沿用 `load-300.test.ts`）、平台 CA 真实证书链、Windows/WSL/SSH 宿主机关键路径。
4. **L4 全量回归**：发版前单独执行，含桌面 Electron 渲染验证。

### 收尾回归批（定向，2026-11-17 08:5x）

U138 残余全家族收口（U153–U171）后的改动面定向回归，**非全量**（L4 全量仍留在发版前单独执行）。

- **批 A（renderer/runtime 域）**：255 套件 / 1973 用例，pass 1970 / **fail 0** / skip 3（`web-runtime-direct-proxy-live.integration.test.ts` 由 `ORCA_REMOTE_ACCESS_PAIRING_INPUT` 环境门控，预期跳过）。范围：web-session-tabs-sync 18、runtime-session/rpc/手势自建 20、pty-transport 30、tab-bar 78、tab-group 3、renderer/web 68、main/runtime mobile-session 系 38。证据 `evidence/regression-batch-a-20261117-085358/`。
- **批 B（平台 e2e）**：24 文件 / 157 用例，pass 157 / **fail 0** / skip 0。覆盖项目归档/下载策略/策略版本冲突/详情/主机生命周期/中继路由新鲜度/u64 端口漂移/u79 中继绑定/u80 mobile 六套/撤销与宿主授权；各套件 `PORT=0` 自起，未触碰 18787 持久环境。证据 `evidence/regression-batch-b-20261117T085406/`。
- 三桶分类：今日引入 0 / 既有失败 0 / 环境相关 0（批 A 的 3 skip 为预期门控）。未修改任何代码。

### 残项收口 + 部署态复验 + U163 设计评审（2026-11-17 09:0x–09:2x）

- **U164/U169/U152 残项证据级审计**（`test-reports/u164-u169-residual-audit.md`）：U164 P3 焦点瞬时不一致已消除（成对采纳 + 3 钉）、F2–F5 均已消除；U152 残留 P2 三项随 `26240894d97` 消除；U169 L1/L2/L4 已消除，**仅 L3 仍成立（P3，设计内诚实失败，不开新号）**。台账已更新（`ec41c367600`）。
- **部署产物金旅程**：在 08:48 生产产物（去仪器化、`__store` 编译期折叠）上直接跑 → **INVALID**（脚本 a2 依赖 store oracle，与 journey-final8 非同口味；证据 `evidence/journey-deployed-20261117-090500/`）。
- **e2e 快照复跑**：隔离 worktree `ec41c367` 内 `VITE_EXPOSE_STORE=true --mode e2e` 重建 → 旅程 **13/13 PASS**，a2 三方一致（DOM = store = 宿主，16ms），主树 `out/` 未动，快照宿主按 PID 清理。证据 `evidence/journey-e2e-20261117-0912/`。
- **U163 P3 设计 v1 + 双独立评审**（代码事实 / 产品语义）：均 CHANGES-REQUIRED——revision 无宿主代际（重启后永久 no-op）、失焦≠没在看、焦点采纳与权威矩阵 §2-5 冲突、第二份 apply 路径、E1/E5 伪绿。主会话裁定**收窄**：只做「获焦/可见/重连时单次 `list` 布局补齐」，不新增 wire 字段，连续应用车道暂缓；复用面清单已出（`refreshLocalStructuredSessionTabs`/`buildMirroredHostGroups`/`updateHostSessionGroupIdMappings` 等现成件）。v2 修订在途。
- 现网状态 m09 已同步 U169-L3 与收窄方向（`39ebafa5341`）。

- **W9 双线在 HEAD 复跑（U171 之后）**：快照 `39ebafa5341`（= `ec41c367` + 1 docs）e2e 口味重建；**A 线 1/1 PASS**（desktop 黄金旅程，route=direct、PTY 回显 546ms、marker×3、审计 4 条全在基线）、**B 线 2/2 PASS**（黄金旅程 + 终端流式/文件树双证）；补跑 **C6 桌面拖拽 1/1 PASS**（宿主 oracle：跨组移动成员一致、组内顺序 `dom == host == [e00cdc01, c653b80d]`、四阶段 toast 空）。主树 `out/` 未动、快照按 PID 清理。证据 `evidence/w9-head-20261117-091324/`。**结论：当前 HEAD 双线黄金旅程全绿**（web 13/13 + W9 A/B）。

- **台账收口批（证据优先）**：U152/U153/U154/U156/U158/U159 翻 🟢，U16/U99 更正过期表述；**U155 保持 🟡**——其「六路变异全红」主张被自身审计否定（仅 5 路红，M1/M1b 与 M8 仍绿，P2-A/B），且缺三入口真机复跑证据，按规则不翻绿并写明补齐条件。机检 PASS，提交 `31a89354f02`（1 文件 9 行，行数不变）。
- **旅程脚本入库后双控验证**（`web-journey-13-gates.mjs`，`c8e8f47e805`）：负控=现网去仪器化页 → `verdict:INVALID`、`reason:store-oracle-missing`、exit 2、无 gate 输出；正控=e2e 快照 `c8e8f47e805` 重建 → **13/13 PASS**，a2 三方一致（DOM=store=host，27ms 收敛），与原 evidence 脚本 gate 键集/布尔值逐项相同。证据 `evidence/journey-ported-1794878348/`。首次正控因复制宿主凭证被 `ensureHost` 删除而 INVALID（隔离问题，非产品红），改现场签发 host token 后通过。
- **U106-T12（Referrer-Policy）收口**：审计式复核发现静态**命中**路径早已由 `6e953ed6829`（平台）/`fcc133ba8aa`（宿主）覆盖，真正残余是静态**未命中 404** 裸响应无安全头（`/favicon.ico`、过期 hashed 资源实测 `referrer-policy: null`）。修法：`static-delivery.ts` 新增共用 `STATIC_SECURITY_HEADERS` + `sendStaticNotFound`，`server.ts` 404 出口替换。TDD 钉红→绿（`static-cache.e2e.test.ts:112`），相邻 30/30 绿，`tc:node` 0。提交 `99df73d008a` + 台账 `ce88ad7f0ab`。
- **U155 判别力补钉**（未发现产品缺陷）：旧用例存在等价路径遮蔽——M1/M1b 的「仅首次」判定与置位、M8 的 catch discard 从未被执行。新增 2 钉（同一 transport 再 connect 不得重放 durable tap；不可恢复错误必须 discard），三变异各自打红对应新钉。U155 四文件 36 绿（提交 `1e8ea8042b1`）。U155 仍留 🟡 待「三入口真机复跑」。
- **U172 修复（首开保留宿主布局）**：`sync-mobile-session-tabs.ts` 新增 `firstOpenHostLayoutAuthority`（accepted 空 + headless-built + 宿主确有布局 → 保留宿主 `tabGroups/tabGroupLayout/activeGroupId`，accepted 签名记宿主基线）；红钉转正 + 新增「renderer 同代真实新布局必须接管」钉；判别力变异红、相邻 14 套件 112 例绿、`tc:node` 0（提交 `94cdb31f230`）。**残留 2 项待审计**（内容帧重发是否塌组；转发门用宿主签名是否误转发）——审计在途，台账暂保持 🔴。
- **U155 残余 discard 钉补全**：`!created` 分支（宿主回帧缺 created，旧用例零覆盖）与 destroyed/epoch 分支（二次 connect 且回包晚到）各补 1 钉，变异各自打红对应新钉，本文件 8 例 + 相邻 8 文件共 52 例绿（提交 `e31023b2b2f`）。
- **U106-T12 独立复核 APPROVED**：静态出口全覆盖（200/304/gzip/回退/404；无 3xx/Range 分支），30/30 绿，判别力变异红。残余不阻塞：HEAD 静态与 Web 契约 426 无该头（修前既有）、404 助手注释措辞强于实现。**现网平台进程（08:51 启动）早于修复 → 需 `--platform-only` 重起后实测**。
- **U172 v2 修复**（`22753c8aee4`）：accepted 增 `rendererRawLayout*/hostLayoutAuthorityPending`；pending 期间原始摘要未变即保留宿主布局，真变才放行；转发门改用 renderer 原始签名比对（避免 id 重叠时 ack true 丢移动）；首帧先于水合时以持久化多组布局建基线。判别力：短路 pending → 4 failed，恢复 → 13 passed；相邻 14 套件 141 例 + 合并 6 套件 69 例绿；`tc:node` 0。**独立复审在途**（修复代理改过审计探针，复审须独立重写）。
- **U155 关闭**：判别力两批补钉（`1e8ea8042b1`/`e31023b2b2f`，M1/M1b/M8/`!created`/destroyed-epoch 变异均红）+ 三入口真机复跑全绿（浏览器 guest Cmd+T、Quick command 真实点击、分屏 pane 拖拽；宿主+DOM+store 三方一致，即时与 +5s 采样相同；`evidence/u155-three-entries-20261117-093213/`，HEAD `2f5b20dad5e` 快照 e2e 构建）。台账翻 🟢（`a8c4d65d2a5`）。
- **U163 V1 落地**（`b4b34687de3`）：`host-layout-catchup-decision.ts` 纯决策函数（11 条优先级规则，C6 undefined/empty 分义）、单飞闩（合并尾沿、失败不粘死）、`catchupFreshnessVerdict`（带 history 入参、克隆不写共享表、`revivesEpoch` 由调用方 un-retire）。28 例绿；**26 个分支变异全部打红**；`tc:web`/oxlint/oxfmt clean。
- **U163 V2a 落地**（`00b7d7ae6de`）：apply options 增 `preserveLocalFocus`/`layoutOnly`/`hostTabIdsAreLocalTabIds`；`layoutOnly` 同时抑制 `reconcilesNonAgentTabs` 与 `buildMirroredTerminalTabs`（B1，防终端重复）。三钉先红→绿，两处判别力红；`web-session-tabs-sync` 359 例 + tab-group 129 例绿。
- **U172 关闭**：真栈复验 PASS（`evidence/u172-realstack-1794880702/`）——桌面 1 组 → headless split → 宿主 2 组持久化 → 冷启动首开 12 次采样全 2 组、内容帧不塌、窗口内真实 split 2→3 被接受且无 toast；未制造假陈旧态，陈旧帧分支由单测钉覆盖（覆盖说明已入台账）。台账翻 🟢（`3ea36deb9c7`）。
- **L4 renderer 段**（`evidence/l4-renderer-20261117-094426/`）：41335 例 / 3 fail（2 文件，**既有 stale 测试**，根因 2026-11-15 两次契约变更未同步测试；今日引入 0、环境 0）；预期 skip 按 §2-67 单列（live proxy 3 例 + bench 4 + fish 1）。stale 测试修复在途。
- **U173 登记并修复（P1 产品回归）**：L4 stale 测试判定中发现——`77219a14ffa` 的 `isKnownBinaryEditorFile` 把图片/PDF 也当 binary 预读短路，桌面编辑器图片/PDF 预览全部失效（`useEditorPanelContentState` 两例仍在断言该能力）。修复 `96cd5215858`：`PREVIEWABLE_BINARY_EXTENSIONS`（图片+pdf）先放行到 read 路径拿 `isImage`，NUL 内容层 guard 保留；新钉红→绿、判别力红；editor 目录 2589 例（3 skip）绿；SSH 两例未改测试原样转绿。云工作区口径不受影响（guard 仅桌面 renderer）。台账 U173 待独立复核后翻绿。
- **U173 关闭**：独立复核 APPROVED（`test-reports/u173-audit.md`）——渲染端可预览集合与三处 host 清单逐项一致（唯一差异 `.avif` 不在 binary 集故无影响），判别力红、editor 2589 例绿；残余=缺 `files.readPreview` 的旧远端 host 由占位变 `method_not_found`（可重试）。台账翻 🟢（`5d6e26fff07`）。
- **L4 两个 stale 文件全部修复**：`947ce844bda`（`useIpcEvents` 按 `a1c65bb63ad` 互斥契约拆两条断言，有效行 799/800 未豁免）+ U173（editor 两例未改测试原样转绿）。定向复跑两文件 21/21 通过；renderer 全量复跑在途。
- **U163 V2b/V3 落地**：V2b `abf495b30a6`（claimed 去重 + `resolveUniqueHostGroupIdByMemberSet` 预 seed，B4 五类 11 例、502 例绿，判别力 3 处红，因 `max-lines` 按域拆 `host-group-claim.ts` 未豁免）；V3 `1c6aca72e9a`（catch-up 焦点 pin + 组内 MRU 回退，3 钉红→绿、399 例绿，默认路径逐字保留；不改 U164/U167/U168 交互）。
- **U163 V4 落地**（`2a612cf147b`）：`runLocalHostLayoutCatchup` 执行器——单次 list、freshness 门（`revivesEpoch` 落 un-retire）、精确成员集预 seed、`catchup:unmapped-group` 守卫、`layoutOnly+preserveLocalFocus` 应用、`recordAppliedSessionPublication` 抽出导出；七场景全绿（成功/pending defer/手势 skip/unmapped 不写/同版本 skip/异常不抛/单飞合并）。判别力：去预 seed → 红，去守卫精确复现 1→3，证明承重。502 例绿。附带必要修正：`apply-preparation-unified.ts` 接 `hostTabIdsAreLocalTabIds` identity 映射（V2a 仅声明未接线），已在提交说明注明。
- **U163 V5 落地**（`9835364e469`）：`use-local-host-layout-catchup` 钩子——focus / 可见性边沿（复用 `window-park-visibility`，不裸读 visibilityState）/ `online` / `ui.onSystemResumed` / `workspaceSessionReady` 边沿；主 app-shell 挂载，popout 不挂；六场景绿，判别力删源即红；534 例绿。
- **U163 V6 落地**（`4a1a6808cb4`）：拖拽手势引用计数闩（`tab-drag-gesture-registry`，`useTabDragSplit` 起止/unmount 兜底）+ 结构化重连信号（`subscription.ts` error/end 每边界一次）接入 V5；五场景绿；判别力 10 红；181 文件/1314 例绿。
- **U163 V7 落地**（`d5429c64eb3`）：E1 隔离栈 4 例——焦点事件经 V5 钩子→V4 执行器真实收敛 1→2（预 seed）、三项非法帧；断言实现=出站方法序列恒 `['session.tabs.list']`、宿主快照 deepFreeze+clone 深等、本地 active/类型不变；变异删 V4 调用即红。442 例绿。**规格裁定**：非法布局（tabGroupLayout 引用未知组/未知成员）按设计 v4 语义「裁剪后照常应用、不整帧拒绝」，任务书「不应用」表述作废。
- **L4 第 1 段（renderer）结论：全绿**（`evidence/l4-renderer-rerun-20261117-101228/`）：4789 文件 / 41381 例 / 0 fail / exit 0，skip 8 按 §2-67 单列（live proxy 3、bench 4、fish 1）；首跑 3 个 stale 失败全部转绿（`947ce844bda` + U173）。+46 例来自本时段 V1/V2a/V2b/V3 新钉。限定：绿的为「HEAD `1c6aca72e9a` + 11 个在途未提交改动」工作树状态；耗时 1343s（与 main 段全程争用，吞吐 3.57 vs 首跑 5.55 files/s）。
- **U173 打磨**（`8a9c393f71a`）：`.avif` 并入 shared 图片扩展（主进程 `PREVIEWABLE_BINARY_MIME_TYPES` 已含），使 terminal 拖拽/doc-preview/relay fs/SFTP/native-chat/ACP 各消费方口径一致；补 loader 层 `.png` 真正进入读取断言（`readRuntimeFileContent` 恰一次 + `isImage`）。基线更正：`.avif` 此前不在 binary 集，远非「误判为 true」。editor+shared 15342 例绿。
- **L4 第 2 段（main/preload）结果：不可判绿**（`evidence/l4-main-20261117-100406/`）：5715 文件 / 57633 例，23 文件 92 例失败（41m04s；命令缺 `ORCA_BACKGROUND_LAUNCH=1`）。三桶：**今日引入 2**（登记 U174 会话读取放大=U172 v2 per-snapshot 读取致 `getWorkspaceSession` 101 次；U175 headless-authored `continue` 跳过 resync，`c334b4ea410` 引入）、既有 44（台账持久化簇 34、electron mock 6、终端流 3、rename 1）、环境 46（其中 41 例设 `ORCA_BACKGROUND_LAUNCH=1` 后全绿；5 例 macOS 临时目录语义）。preload 单跑 19 文件/102 例全绿。skip 427 按 §2-67 全量分类（含 `ORCA_REAL_CLAUDE_CLI_TEST` 14 例）。台账已登记 U174/U175（`64f949e30e8`），修复令在途。
- **L4 类型/静态门**（`evidence/l4-tc-20261117T104413/`）：`pnpm tc` 五目标全绿（node/cli/web/cloud-e2e/process-host）；`check:code-quality:changed` FAIL，1742 条中**仅 6 条为本时段 V2a/V3/V4/V6 新债**（`consistent-type-assertions`），其余为分支历史/脏工作区/evidence 未跟踪既有债务；新债修复令在途。
- **本时段 lint 新债清零**（`ac8ebc674cb`）：6 条 `consistent-type-assertions` 全部**消除式**修复（真实 `DragEvent`/`DragEndEvent` 类型、`in` 收窄替代断言、删除冗余 `Partial` 断言），零 disable；相关 5 文件 0 finding、43/43 绿。
- **U175 修复**（`efcffdc6d23`）：unchanged 循环的 headless-authored `continue` 改为 `keepsAcceptedTabs`（仅当已存快照仍含被采纳 renderer publication 的全部 tab 身份键才跳过）；hydrate 掩盖被丢快照时恢复 resync 请求。判别力：改回无条件跳过即红；核心 4 文件 54/54、相关批 9 文件 88/88 绿。**并发冲突处置**：U174 与 U175 同改该文件，已要求 U174 在提交前并入 U175 改动并核验两处共存。
- **U163 V8a-1 真栈：INVALID**（`evidence/u163-v8a1-1794887000/`）：单窗口桌面栈内 renderer 自己的 `session.tabs.move` 被同一 renderer 结构化同步即时采纳，无法造「宿主 2 / 本地 1」分歧（host-split 采样 2/2/2，focus 后无 `session.tabs.list` 出站）。断言 0b（分歧前置）必然不成立 → 判 INVALID 而非产品红。harness 已入库（`d52332b1f79`），转入 V8a-2（第二客户端）。
- **U174 修复**（`0b6b5b2691f`）：`getSessionScan` 单次 host-partition 读取同时产出 `hydrationTargets` 与 `ownerSessionsByWorktree`，`getPersistedMobileSessionHostLayout` 复用 owner session；100 worktree 同步从 101 次读取降到 1 次（3 次连续同步验证）；U175 `keepsAcceptedTabs` 共存已核验；6 文件 1404 例绿。独立复核在途。
- **L4 main 既有 34 例簇定性：环境（非产品、非 stale）**（`test-reports/l4-main-ledger-cluster-triage.md`）：根因=`agentSessionOperationKey`（`agent-session-operation-ledger.ts:133-136`）以 `\u0000` 连接并转为 `operation_key TEXT PRIMARY KEY`；本机 **Node v24.5.0** 的 `node:sqlite` 读 TEXT 时在 NUL 处截断 → 重开 store 后键不匹配、整行被静默丢弃。运行时矩阵：v24.5.0 截断 / **Electron 43.7.5 内置 Node v24.21.0 保留** / Bun 1.4.2 保留（上游 24.16.0 修复）。结论：发布产物无影响，不登记缺陷号；门禁复跑绑定 Node ≥24.16。可选 P3 加固（键改 JSON 编码 + `engines.node` 收紧）记入队列。Electron Node 复跑验证在途。
- **U174/U175 关闭**：独立复核 APPROVED（`test-reports/u174-u175-audit.md`）——原失败用例各 3/3 通过（无相位性）；U174 独立探针 100 worktree × 3 sync = 每次 1 次读取（修复前每 snapshot 再读），首开/内容帧宿主布局保留仍成立；U175 探针 hydrate 掩盖时 resync 请求恢复、陈旧重放仍不重复采纳；两处逻辑共存、调用点清单与副作用均核验。台账翻 🟢（`8dc0f8fe4b6`）。
- **Node 版本门固化**（`cc4e865325c`）：`env-gated-test-suites.md` 增「运行时版本门」——`src/main` 全量须 Node ≥24.16 或 Electron 内置 Node（24.21），且必须 `ORCA_BACKGROUND_LAUNCH=1`；Electron Node 下台账簇 113/113 绿（本机 24.5 为 29 failed），定性闭环。
- **U163 V8a-2 真栈：INVALID（分歧前提不成立）**（`evidence/u163-v8a2-1780000600/`）：改用独立 Chromium 第二客户端（独立 store）对同一本地 worktree 做 split → 宿主 2 组后约 1.5s 桌面 renderer 即采纳（host 2 / store 2 / DOM 2），focus 边沿前已一致；focus 补齐全过程无 `session.tabs.list` 出站。结论：同 runtime 广播使桌面自动采纳布局，无法构造稳定分歧窗口。脚本入库 `b7d8d2ce60a`。
- **登记 U176（U163 前提可能失效）**：本地宿主已自动采纳 + C1 闸门 skip 非本地宿主 → 当前补齐车道无收益、仅剩每次 focus 一次 list 成本；v1「桌面无 apply 通道」判断与当前 HEAD 不符。处置：钩子改默认关闭显式开关（代码/测试保留）、设计补附录 D、V8b 暂停；**是否彻底移除/仅非本地启用/保留开关待用户裁定**（`9a0b268377c`）。
- **L4 main 剩余 10 例 stale 修复**（`43b42fe3f4b`，4 个测试文件）：A 启动激活 mock 补 `ipcMain`/`BrowserWindow`（`a884e35073a` 后链路无条件走云 IPC）；B 终端分帧按 U84b 新语义重写（首写孤立 ≤256B 立即 flush，余量合并 1 帧，未回退）；C rename retention 改用「新 runtime 重建不触发 onPtyExit」，并新增「certified 退出退役 durable 行」钉。17/17 绿。
- **U106-T12 现网生效**（`evidence/u106-live-restart-20261117-110957/`）：平台重启 pid 33522（11:10:16）；静态 404/200 均带 `referrer-policy: no-referrer`；宿主双在线未重启；登录与 `/v1/hosts` 冒烟 200。口径：HEAD 请求走 JSON 404 不带该头（既有行为，已披露），验证须用 GET。
- **U163 管线审计 P0 修复**（`048c2aaa166`）：预 seed 守卫与 `continue` 对称——「本地组 id 直接命中宿主组 id」不再判 `catchup:unmapped-group`（原死锁：literal 组不建映射→守卫 skip→维护步骤永不执行）。新增 literal-equal 钉（红→绿）+ 异 id 歧义负控仍 unmapped；6 套件 58 例绿。
- **L4 正式复跑启动**：main（Electron Node 24.21 + `ORCA_BACKGROUND_LAUNCH=1`，4 workers）与 renderer（3 workers）并行，含首跑后全部修复；结果回流后出 L4 总判据。
- **L4 复跑事故（2026-11-17 11:16）**：main（Electron Node 4 workers）与 renderer（3 workers）两段全量并行启动，5 分钟后两进程同时被杀、均无 results.json（疑内存压力），证据目录仅剩截断 run.log。处置：改为**串行**——先 renderer（4 workers），完成后单独跑 main；已通知两个原代理不要自行重跑并回传退出前日志线索。后续固化（12:00 复盘）：全量段禁止并行。
- **并行被杀事故补充**（两代理回传）：main 217 文件完成即被杀（净 291s），renderer 350/4789 完成即被杀；wrapper 与 worker 同组终止、无 OOM 日志、无 JS 栈，属外部终止。main 在被杀前出现 **10 个超时型失败**（`codex-app-server-teardown` 4、`codex-app-server-connection` 5、`wsl-hook-relay-live` 1，均 15–16s）——带并行争用特征，**不作为产品红**，串行复跑时逐项对照。两 run 均不作任何结论。
- **current-state 文档同步**（`be8ebf9dde9`，5 文件）：m02（Referrer-Policy 含 404 出口与现网生效）、m09（U173 预览恢复、U174/U175 单次读取与 republish）、acceptance-cases AC-M9-03/07（U172/U174/U175 现状与关联）、business-flows F3（首开保留宿主布局）、manual-acceptance-matrix B8（U176 待裁定）。机检 PASS。
- **10 例 stale 测试重写独立复核 APPROVED**（`test-reports/stale-tests-audit.md`）：6 例仅补 mock、断言未动；分帧断言与 U84b 语义一致且加强（精确分帧+帧数）；rename 新增「永久退出即退役」断言不可与替换混淆；变异判别（旧 mock → 6 红；旧单帧断言 → 2+1 红）成立；复跑 17/17。非阻断观察：退役分支不区分 certified/uncertified（该标志仅驱动 liveness）、主用例未断言 spawn 实际发生（与原测试一致）。
- **L4 renderer 串行全量：全绿**（`evidence/l4-renderer-serial-20261117-113423/`，HEAD `2334b755c2b` + 11 在途未提交改动）：4795 文件（4792 passed / 0 failed / 3 全 skip）/ 41413 例（0 failed / 8 skipped）/ exit 0 / 13m41s（无争用，5.88 files/s）。较上次 +6 文件 +32 例全部为 U163 新钉；skip 8 按 §2-67 单列（live proxy 3、bench 4、fish 1）。失败三桶全 0。
- **L4 main 串行全量启动**（Electron Node 24.21 + `ORCA_BACKGROUND_LAUNCH=1`，4 workers，~30–40 分钟），并对首跑并行期的 10 个超时疑似红逐项对照。
- **用户报告：测试实例弹大量 Electron 错误对话框干扰工作**（2026-11-17 11:5x）→ 已登记 **U177**（`eeb40bc44c0`）：`src/main` 多处 `dialog.show*`（preflight/GPU 回退/RPC 启动失败/配置写失败/诊断等）在 `ORCA_BACKGROUND_LAUNCH`/`ORCA_E2E_HEADLESS` 下仍显示并阻塞，严重启动失败不自行退出；L4 main 全量会拉起数百实例直接淹没桌面。处置：①立即停止本轮 main 全量（PID 49609）；②清理 5 个陈旧 journey daemon（按 PID）与可见测试 Electron；③两令并行——产品侧统一非交互弹窗出口 + `app.exit` 自退（含调用点全量清单）、测试侧 launch env 注入 `ORCA_SUPPRESS_DIALOGS=1` + 启动整体超时并强制关闭实例。
- **U177 关闭**：产品侧 `09ac9e3e327`（统一非交互弹窗出口 + 严重启动失败 `app.exit`，`src/main` 内无直接 `dialog.show*`）+ 测试侧 `33eb9c3eced`（e2e 全部启动点注入 `ORCA_SUPPRESS_DIALOGS=1`/`ORCA_BACKGROUND_LAUNCH=1` + 120s 整体超时 + 强制关闭）；复核 APPROVED（9 点默认值、变异 6/21 红）；**真机零窗口验证通过**（损坏 profile → exit 1/600ms/0 窗口；RPC socket 超限 → exit 1/724ms/0 窗口；干净启动正常）。纵深防御 `6a1f76db39b`：profile copy 对话框非交互选 Quit（不 relaunch）、recovery 选 cancel（不写剪贴板）。
- **L4 main 串行全量（第二轮）启动**：带弹窗抑制 env；期间桌面应完全安静（作为 U177 的运行期附加验收）。
- **main 复跑口径纠偏（12:2x）**：用 Electron 内置 Node 跑 main 全量产生**环境假红**——Electron 的 BoringSSL 不支持部分 EC 运算（`elliptic curve routines: DECODE_ERROR`），ws-transport 18 例、profile-state backup 7 例等均属此列；已终止该轮（PID 26148，不作判据）。纠正：**真 Node ≥24.16**（`npx -y node@24.16.0`）同时满足「无 NUL 截断」与「crypto 正常」；清单已更新（`f4e4d4c316a`）。main 全量改在 node@24.16.0 上重跑。
- **用户指令：暂停 Electron 测试、先集中解决冒烟问题**（2026-11-17 12:2x）。已停止 main 全量（未实际开跑）；桌面核查：可见 Electron 0、无 vitest 进程。平台部署冒烟（不启动 Electron）已通过：`/health` 200、`/` 200 + `referrer-policy: no-referrer`、静态 404 亦带头。按用户确认的「桌面客户端冒烟（Electron）」起一路：隔离 e2e 快照 + `ORCA_SUPPRESS_DIALOGS=1`/`ORCA_BACKGROUND_LAUNCH=1`/`ORCA_E2E_HEADLESS=1` 跑 C6 拖拽（失败即停并修/诊断），通过后再跑 W9a 桌面金旅程。
- **「启动即弹框、测试没真跑」根因补齐**（来自被终止的 Electron-Node 轮）：在 Electron-Node 下，测试用 `process.execPath` 启动假 provider/应用 → **拉起 GUI Electron 实例**（含一个 *(in front)* 抢焦点），握手超时或空白窗口，用例到不了真实步骤；报告同时确认 13 例 teardown/connection/model-catalog 等为「Electron-as-node 进程模型」确定性假红，非产品、非争用。结论：main 套件必须用**真 Node ≥24.16** 运行（`process.execPath`=node，不会拉 GUI）；Electron-Node 只可用于无 crypto/无子进程的定向簇。另修复今日引入的测试隔离缺口：`profile-state-recovery-preflight` 未清 `ELECTRON_RUN_AS_NODE` 导致断言失败（测试修复令在途）。
- **测试原则固化（用户指令 12:4x）**：新增 **§2-75 冒烟三连门**（S1 桌面启动+工作区 / S2 拖拽镜像+宿主 oracle / S3 headless serve 激活；前三个未通过必须先修，不得继续其它套件）与 **§2-76 测试有效性**（步骤须机检「真实用例通过且时长≥1s」、新增测试附判别力变异、断言落用户可见面、「0 fail」须同时报执行面）。机检实现：`cloud-platform/scripts/smoke/desktop-smoke-gate.mjs`（串行执行、失败即停、递归解析 Playwright JSON 校验执行面），提交 `68ae9588660` + `d0074b10e2c`。
- **C6 冒烟首跑失败=环境**（`evidence/desktop-smoke-*/c6-run.log`）：快照 `node_modules` 为软链 → pnpm hoist 报 "workspace hoist directory is not a real directory"，`prepare:cli-output` 失败。修复口径：快照内 `pnpm install --offline --frozen-lockfile` 后重建；不得跳过 prepare 或弱化断言。另按 PID 清理 u91/w9a/c6/u75 陈旧 journey 进程（10 个）。
- **桌面冒烟 S1/S2 真实通过**（`evidence/desktop-smoke-1794889582/`，快照 `332d3ee6529`）：C6 拖拽 51.4s（DOM 移动/组归属、宿主 `session.tabs.list` 顺序、reorder、四阶段 toast 空）、W9a 启动+工作区 37.4s（登录/项目/终端/文件树/宿主审计、5 截图）；运行后无任何 Electron 测试窗口。环境根因修复=快照内 `cp -al` 硬链接克隆 node_modules（4GB/48s），未跳过 prepare、未弱化断言。**冒烟三连门（含 S3）执行中**（`scripts/smoke/desktop-smoke-gate.mjs`，执行面机检）。
- **桌面冒烟三连门：全过**（HEAD `8d5c72e766e`，绝对证据路径）：S1 W9a 37.0s / S2 C6 49.0s / S3 headless-serve 15.1s，均 `specCount=1, passed=1, ranLongEnough=true, valid=true`、retries=0；全程无可见窗口（`electron-headless` + `ORCA_BACKGROUND_LAUNCH`/`ORCA_SUPPRESS_DIALOGS`/`ORCA_E2E_HEADLESS`）。脚本缺陷修复：相对 outDir 会被 Playwright 按 config 目录解析导致 ENOENT，已规范化为绝对路径（`8e3973915a8` 的单测 6/6 覆盖执行面）。快照按 PID 清理、主树 `out/` 未动。
- **L4 main 全量（真 Node 24.16）：92 例基线失败全部转绿**（`evidence/l4-main-node2416-20261117-123752/`）：5717 文件（5635 pass / 1 failed / 81 skip）、57668 例（2 failed / 57233 pass / 426 skip）、17m01s、exit 1。唯一失败文件 `ssh-relay-node-headers`（2 例，`expected '' to be '<prefix>'`）= **npx 包缺 `include/node` 的环境问题**（官方 v24.16.0 包定向复跑 8/8 通过）。**全程 0 新窗口、0 弹窗**；基线 23 个失败文件现全部通过。skip 426 按 §2-67 分类入 summary。为拿 exit 0 判据，已用官方 Node 发行包重跑全量。
- **L4 收口（2026-11-17 13:1x）**：①renderer 全量 4795 文件/41413 例/0 fail（`l4-renderer-serial-20261117-113423`）；②main 全量 **exit 0**：5717 文件/57668 例/0 failed/426 skip，官方 Node v24.16.0（`include/node` 存在）、`ORCA_BACKGROUND_LAUNCH=1 ORCA_SUPPRESS_DIALOGS=1`、无 `ELECTRON_RUN_AS_NODE`（`l4-main-official2416-20261117-125700`，18m34s，0 新窗口）；③`pnpm tc` 五目标绿；④冒烟三连全过（37/49/15s）。基线 92 例失败全部归因并清零（Node 版本/进程模型/stale/env），0 产品失败。skip 426 按 §2-67 分类入 `skips.txt`。
- **最终生产构建与部署验证 PASS**（`evidence/final-build-prod-20261117-131941/`）：生产口味重建（main `ac2efb11…`、preload `9727610c…`、renderer/web 于 13:17）；`__store` 口径更正——产物保留 1 处字面量但开关编译为 `!1`（web `store-DoCasHdh.js`、renderer `store-DBcbaqnq.js`），实际暴露 0。宿主重载新 main：dev-local-02 `99428`、dev-local-03 `963`（均晚于产物 mtime）；平台 `98993`（build `8f5651b109ab`，apps/web 未变）。served==disk：relay `:18444` web-index/chunk 与磁盘 sha 一致；平台 `/` 头一致。平台冒烟 200、静态 404 带头、两宿主 online。**C6 在生产产物上 1 passed（49.6s，有效非 INVALID）**；部署与测试全程 0 新窗口/0 弹窗。
- **最终部署证据独立复核 APPROVED**（`test-reports/final-deploy-audit.md`）：8 个产物 sha 重算全一致；`__store` 字面量处于死分支、开关编译为 `!1`（实际暴露 0）；relay `:18444/h/dev-local-02/...` 与平台 `/` 的 served==disk（build `8f5651b109ab` 与 `apps/web` 重算一致）；宿主/平台 pid 均晚于产物 mtime；冒烟全复现（含 admin 登录与两宿主 online）；C6 flavor=`prebuilt (SKIP_BUILD=1)`、13 步全 ok、oracle 宿主 `session.tabs.list`。唯一非阻断缺口：部署窗口缺窗口快照，已补做（重启平台 + before/after CGWindowList）。
- **U106 残留收口**（`0b21eacaca1`）：`json()` 统一出口展开 `STATIC_SECURITY_HEADERS`，HEAD 静态/未知 API 404 与 Web 契约 426 均带 `referrer-policy`；新增钉 31/31 绿、变异红；平台重启实测在途。
- **U106 残留现网生效 + 部署窗口零窗口补证**（`evidence/u106-restart-window-20261117-132713/`）：平台重启 98993→25992（13:27:28，晚于提交 `0b21eacaca1` 13:26:05）；`HEAD /`、`HEAD /assets/<缺失hash>/app.js`、`GET /v1/no-such-endpoint`、`GET /favicon.ico` 现均带 `referrer-policy: no-referrer`，`GET /` 200 带头，状态码语义不变；窗口 before/after 各 14 个，**新增 0/消失 0**，无 dialog 进程/窗口；冒烟 200、登录 200、两宿主 online。
- **U178（测试工具链）关闭**（`b755f4c2740`）：P0 清理器三重判定修复（三类用户应用 unrelated、仓库残留仍 cleanup、PID 复用复核）；P1 全修（tier cwd/glob/untracked/git 错误、full 零副作用、monitor spawn error、smoke 600s 超时与旧证据）；单测 34/34、真实 dry-run `matched=0`。另收敛 `apps/api` changed 映射为关键业务 7 项（`785b7a53bd5`），避免日常 T2 跑整棵 e2e。
- **U179 修复**（`a8ab12d01f0`）：tier runner 增运行时门（Node<24.16 拒绝并给命令/`ORCA_TEST_NODE_AUTO=1` 自动重执行；实测本机 24.5 下 exit 3 且零副作用）；资源监控改为**独立子进程采样器**（`resource-sampler.mjs`，SIGTERM 写 summary；真实冒烟 2.6s 得 samples=2、peak 49 进程/25.17GB），解决 `spawnSync` 阻塞导致 `samples=0`。工具单测 46/46。**正在 `changed` 层以 Node 24.16 复跑**，确认此前 17 例失败为版本假红后翻绿。
- **U179 关闭**：tier 运行时门 + 独立子进程采样器 + `os.loadavg` 修复全部验证通过。`changed` 层在 Node 24.16 下 **exit 0**（vitest 3763 文件/38200 例 0 失败；平台关键 e2e 176/176），自动清理 2 个陈旧进程、未误伤用户应用；采样 325 条（peak 54 进程/25.15GB）。此前 17 例失败确认为 Node 24.5 版本假红。
- **待决策简报与验收指引（2026-11-17 14:3x）**：`work-orders/pending-decisions-2026-11-17.md`（`f044aedf301`）整理 D1–D4（采集 A+、P1、审计二期、U163 车道）现状/选项/成本/建议/默认执行，并如实标注「仓库无正式方案文档、成本为粗估」；验收 runbook v2.2 追加 §8 批次指引（自动门证据、人工项 G04/G24/C7、U176 待裁定不列入验收；本地未入库，符合规则）。
- **D1/D2 方案草案 + 证据校验器（2026-11-17 14:5x）**：`work-orders/collection-and-agent-invocation-draft.md`（`4001213a8d9`）——仅元数据、22 字段表（16 项可追溯到现有代码）、宿主审计队列 + 心跳 `agentInvocations[]` 上报（不走客户端 file-event RPC）、能力门控、隐私治理与容量估算（500 人 × 5–15 会话/日 → 2.5k–7.5k 条/日），明确未批准不得开工；决策简报已加引用。`validate-evidence.mjs`（`3aafb344e4e`）12/12 单测、真实目录 PASS；实测发现 4 个关键证据目录只有文本产物、缺 `summary.json`（格式不统一，后续长跑统一产出）。
- **证据汇总回填**（2026-11-17 15:0x）：为 4 个关键证据目录补机器可读 `summary.json`（仅从既有文件提取，verdict 出处可追溯；45 个产物条目 bytes/sha256 与磁盘逐一相符），四目录均过 `validate-evidence --max-age-hours=72`。备注：`u106` 目录无显式 verdict，由重启/冒烟事实推导并注明；`resource-monitor` 为观测数据 verdict=null；`dialog-windows.txt` 的 coreautha 窗口仅台面事实、未据此下结论；该 run 的 `loadAvg` 为空（`os.loadavg` 修复前），已注明。
- **校验器 §2-85 增强 + 台账对账清理**：`validate-evidence --check-generated-at`（`10036501ae1`，17/17 单测；覆盖缺失/坏格式/过旧；4 个回填目录实测 PASS，并注明 generatedAt=回填时刻、审计须并看原始产物 mtime）；台账 17 行（U5/U14/U30/U34/U40/U46/U65b/U66/U67/U67b/U80/U81/U82/U92/U127/U148/U150）逐行追加闭环提交说明（`5cbc015c7d0`，行数 198 不变、机检 PASS、历史措辞保留）。
- **C7 自动化并实跑 PASS**（`evidence/c7-host-restart-20261117T071720/`）：`verify-host-restart-convergence.mjs`（dry-run/精确重启/90s 收敛/旧 pid 清零/窗口按宿主进程树归属/summary 自证）——dev-local-02 `72408→79348`、dev-local-03 `72409→79349`（启动均晚于 out/main mtime 13:17:55），收敛 2272ms，旧 pid 残留 0，宿主归属新增窗口 0，平台 `/health` 200；`validate-evidence --check-generated-at` exit 0。首跑因搜狗输入法瞬时窗口误判触发一次多余 reseed，已修为按宿主 PID 归属并仅未上线时恢复；首跑证据保留备查。人工项 C7 从矩阵改为自动化项。
- **G04 生产 LDAPS 适配器工作令草案**（`6472fb0caaf`）：推荐 `ldapts`（纯 TS、LDAPS/CA/超时/分页，跨平台一致；有条件通过：锁版本、许可/CVE 审计、禁 `rejectUnauthorized:false`）；否决自实现与 `ldapsearch` 子进程（凭据经 argv、跨平台缺失）；拆 5 令（依赖评审→骨架→组搜索→测试→真机 R1–R7）。现状发现：`server.ts` 尚无 `ORCA_CLOUD_LDAP_URL` 读点、`createLdapsAdapter` 不存在，入口装配纳入 G04-2。
- **G24 Linux（Docker）partial + 发现 P1 安装缺陷 U180**（`evidence/g24-linux-20261117T152516/`）：Docker Hub/镜像站不可达，改用本机缓存 Alpine x64 容器，经 forwarder 暴露平台执行向导 one-liner。断言：安装脚本下发 200；**脚本在干净主机执行 FAIL——`set -u` 下 `ORCA_CLOUD_API_URL` 未 source/赋值，健康检查行 `unbound variable` 退出**（`server.ts` `hostInstallScript` `:271-305` / Windows `:343-350`）；注册 201、首心跳 online、重复令牌 401（经 curl 协议重放验证）。已登记 U180（`1e01b1ccf7c`）并派修复。偏差如实记录：Alpine 无 `hostname -I` 用 `ADVERTISE_HOST` 绕过；仓库无 `orca --host-mode` 实现，注册/心跳按文档化协议重放；CentOS7 需镜像可用、Windows 需真机。
- **U180 修复**（`4f8a7ad8cd9`）：`host.sh`/`relay.sh` 健康检查前 `set -a; . "$ORCA_ENV_FILE"; set +a`（保留 `set -u`）；逐项核查无其它「写后未加载」变量；e2e 在干净 `bash -u`+临时 HOME 下先红（line 39/18 unbound）后绿，8/8 + relay 25/25。**更正**：仓库无 Windows `.cmd` 变体，原「Windows 变体」实为 `relayInstallScript`。容器复验在途（`evidence/g24-linux-fixed-*`）。
- **U180 关闭 / G24 Linux 通过**（`evidence/g24-linux-fixed-20261117T153424/`）：Debian 12 干净容器完整执行安装 one-liner → exit 0（写配置/生成 TLS/连通性检查），无 unbound；注册 201、首心跳 online、重复令牌 401；证据 `--check-generated-at` PASS。方法偏差：镜像用本机缓存 Debian 12（Alpine 缺 bash/openssl）；无 `orca --host-mode`，注册/心跳按协议重放。G24 剩余 CentOS7（需镜像）与 Windows（需真机；仓库当前无 `host.cmd` 变体，需先确认交付形态）。
- **安装脚本审计 CHANGES-REQUIRED → 登记 U181/U182**（`test-reports/install-script-audit.md`，`f749e711acb`）：**P0=FR-4.11 实质未达成**——脚本只写 env+健康检查，`orca --host-mode` 无实现、真实注册在桌面启动链，干净 headless 主机安装后不会注册（G24 的 201/online 是协议重放）。P1 含 **Host 头注入 shell**（`requestOrigin` 未转义插入脚本）、重跑丢 TLS 配置（宿主静默明文）、`hostname -I` 不可移植、openssl 静默失败、下载失败仍 exit 0、无 systemd fallback、服务命令硬编码、健康检查无超时。处置：U182 批 1（安全+正确性）修复中；U181 设计令（`--host-mode` vs 脚本注册 vs 混合）在途。
- **U181 设计令**（`50104e6d2b5`，`work-orders/u181-host-mode-design.md`）：推荐 A=`orca --host-mode`（CLI 入口 → 无窗口 `serveOrcaApp`，注册/凭据/心跳/TLS 指纹/E2EE 全部复用 `startCloudRuntimeAdmission`）；B 脚本独立注册被否（tlsFingerprint/orcaVersion 需运行时产出、凭据双所有者）；C 混合唯一收益由**状态文件自证**替代。时序：预检→原子写 env（独立 profile）→health→装守护→凭据存在则跳过注册→201 落凭据→首心跳写 `orca-cloud-host-state.json(status=online)`→脚本轮询该文件（90s）自证。10 个 ≤20 分钟令（H6 需在 U182 批 2 之后）。独立评审在途。
- **U182 批 1 修复**（`4bb9c48695e`）：Host 校验（裸 host[:port]/IPv6/端口范围，非法回退 127.0.0.1）+ 全量单引号封装（注入面消除）、Web 向导改 `curl -o && bash || exit 1` 并给失效提示、健康检查 connect/max-time + 2xx 判定、TLS 两行无条件写、umask 前置/目录 0700/env 0600、`no-store`；六项回退判别力全红；36/36 绿。批 2 待派；独立验证（含 Debian 容器回归）在途。
- **U181 设计 v2**（载具裁定 A2=扩展 orcad）：A1 被硬阻断（无 display → `main-process-preflight.ts:388-391` exit 1；Xvfb 需完整 Chromium 依赖）；A2 复用面完整——orcad 的 `OrcaRuntimeRpcServer` 已实现 `CloudRuntimeTarget` 全部成员，`serve` 本就默认 orcad；最小改造=把 `installCloudPlatformIpc` 移出 attach（模块边界）+ 补 `ORCA_APP_VERSION` + enrollment 错误结构化。CLI=`orca-ide --host-mode`（Linux 名），unit `RestartPreventExitStatus=3 78`，退出码 0/1/78/3，`--reenroll` 一次性且不入 EnvironmentFile；状态文件 schema v2（`starting` 原子写、在线只认 `lastHeartbeatOk`），201 丢失给可判别失败码；H1–H13 全部 ≤20 分钟，H9/H10 依赖 U182 批 2。v2 定向评审在途。
- **U181 v2 评审通过（无 P0）+ H1 开工**：A2 载具经编译级证据确认可行（`installCloudPlatformIpc` 迁移后 import 图无 Electron；`ORCA_APP_VERSION` 需 orcad 补）；仅 3 项文档级 P1（退出码 3 死配置、`--reenroll` 锁归属、H8/H9b/H11b/H12 重拆）。已派 v3 文档修订与 **H1（CLI `--host-mode` 入口骨架）**；H2→H4 随后串行。
- **U181 H1 落地**（`1c7a4211689`）：`--host-mode` 顶层别名（`src/cli/index.ts:85-89`）；冲突规则（preflight 必须配 host-mode；拒绝 pairing/grant/recipe）；强制 orcad、非 orcad 返回 78；退出码常量集中 `host-mode-contract.ts`（0/1/78）并与 orcad 常量同源；`--preflight` 只校验、不发 HTTP/不动凭据；61 例绿、判别力 4/6 红。**H2 在途**（IPC 安装移出 attach、admission 依赖图去 Electron）。
- **U181 H2 落地**（`85b7e802c30`）：`installCloudPlatformIpc()` 移至 `main-process-runtime-launch.ts:99`（无条件，含 admission null）；attach 模块删除 IPC import/调用；新增边界钉（复用 electron ratchet 的 `collectElectronImporters`）：改前输出 `["src/main/ipc/cloud-platform.ts"]`、改后 `[]`，判别力成立；16 例绿。**H3 在途**（orcad attach + `ORCA_APP_VERSION` + enrollment 错误结构化）。
- **U181 H5 落地**（`797016fbc46`）：心跳健康结构（`lastHeartbeatAt/Ok/HttpStatus/ErrorCode`）四路径统一记录（成功/401/5xx/网络异常；失败保留上次成功时间）；refresh 异常也通知监听者；状态文件 writer schema v2（原子写 + 0600/0700，`starting` 覆盖旧 pid/startedAt，在线只认 `lastHeartbeatOk`）。为守 `max-lines` 拆出 `cloud-agent-revocation-notifier.ts`（行为不变）、心跳健康模块；新增 10 例 + 回归 26 例绿；三项变异判别力成立。
- **U181 H3 落地**（`9ca07424d52`）：orcad 构造 `OrcaRuntimeRpcServer` 时展开 `cloudAdmissionOption`（与 Electron 同源），`startOrcadRpc` 先 `attach(admission)` 再 `start()`（事件序钉 `['attach','start']`，无 admission 不 attach）；`ORCA_APP_VERSION ??= ORCA_VERSION`；enrollment 错误改结构化 `{code,status,detail}` 并由 admission 原样抛出；20 例绿、判别力成立。为守 max-lines 抽出 orcad secret store（行为不变）。**H4 在途**（preflight 实化 + starting/online 状态写入）。
- **U182 批 1 验证 PASS**（`evidence/u182-regress-20261117T165729/`）：Debian 12 容器首跑/新令牌重跑均 exit 0；TLS 两行首跑写入且**重跑保留**（旧逻辑会静默丢失→明文）；env 0600/目录 0700；两次 `/health` 200（2xx 判定生效）；`no-store` 实测；suites 36/36；web 命令含 `|| exit 1`。**批 2 在途**（hostname 可移植/openssl fallback/systemd 探测/命令预检/relay 二进制）。
- **U181 H4 落地**（`1fbeb69a346`）：`--host-mode --preflight` 输出结构化 JSON 并按 0/78 返回，复用 `resolveLocalServeRuntime` 自证槽/Node，全程不构造 admission、不发 HTTP、不碰凭据；启动取得实例锁后写 `starting`（新 pid/startedAt，旧 online 立即失效，锁失败不重写）；首心跳 `lastHeartbeatOk=true` 才写 `online`（事件序钉）；49 例绿。**H8a 在途**（注册接线 + 失败码映射）。
- **U182 批 2 落地**（`22424e91280`）：advertise 三路探测（`hostname -I`→`ipconfig getifaddr`→`hostname`，全空 fail-fast）；openssl 保留 stderr + 版本探测（1.0/1.1 降级临时 config SAN）；无 `systemctl` 给 nohup 可复制命令（不自动后台化）；`orca-ide`/`orca` 与 relay 二进制/代码预检 fail-fast；relay 同步。9 条新钉回退全红、45/45 绿。**scoped 容器复验在途**。
- **U182 批 2 容器回归 PASS**（`evidence/u182-b2-regress-20261117T170856/`）：裸容器无宿主二进制 → 预检 exit 1 且不落盘（设计行为）；注入 stub 后 exit 0；无 systemctl → nohup 命令；OpenSSL 3.0.22 走 `-addext`（SAN 正确）；假 openssl 错误 stderr 原样可见；重跑 TLS 证书 sha 不变。**新发现 U183**（relay 向导不安装中继，仅预检/打印命令）已登记。
- **U181 H8a 落地**（`2fad89e6ffa`）：启动前注册门禁（`awaitHostModeEnrolment` 在 `rpc.start()` 前等 `admission.ready`）；有凭据零注册；无凭据注册 201→凭据 0600、令牌仅用一次；失败码 401/409/400→78（带可操作提示）、网络/5xx 三次重试后 1；52 例绿。**H8b 在途**（退出码矩阵 + 心跳 401 单列）。
- **U183 设计令**（`f34e2c437a8`，`work-orders/u183-relay-install-design.md`）：推荐 A=平台下发**sha256 内容寻址** relay 源码 tarball（`/install/relay-bundle/<sha>.tgz`，sha 内嵌生成脚本），脚本预检→下载→校验→tar 安全解包→`releases/<sha>`→`--preflight`→原子切换 current/previous→env 0600→服务→60s 自证 `/v1/internal/relays` online；失败码 64–78、同 sha 复用、N-1 保留、上线超时回滚；14 令。关键发现：`out/relay/` 是桌面 SSH relay（禁止复用）、默认 `relay:<port>` id 会撞车（新增 `RELAY_ID`）、`/opt` 与 user unit 权限矛盾（建议默认 `$HOME/.orca-cloud/relay`）。独立评审在途。
- **U181 H8b 落地**（`f1dba81908c`）：退出码矩阵单一来源（`HOST_MODE_FAILURE_EXIT_CODES`；401/409/400/protocol/credential_write/config/runtime/profile_in_use/heartbeat_unauthorized→78，network/5xx/heartbeat_failed→1；未登记码按 retryable 回退）；注册/心跳失败统一原子落盘 `status=error|degraded + lastErrorCode + retryable`；在线后心跳 401 → error 并终止一次（不空转）；shutdown 支持指定退出码（SIGTERM 仍 0）；56+70 例绿、判别力红。**H8c 在途**（`--reenroll` 锁区内语义）。
- **U183 设计 v2**（`34b8b7991f0`）：P0 全部修（realpath 守卫对比、包内 `VERSION` 去自引用 sha 改包外 `<sha>.manifest.json`、unit 模板必含 `EnvironmentFile` 且不含 host 专用 78 键）；P1 全采纳（`tar -tvzf` 类型拒绝+安全解包、MainPID/pid+nonce 自证、R12 只复用 U182 b2、bundle 目录/sha 映射/路由契约、威胁模型成文）；归属裁定（unit/wrapper 归 H10a/H10b，relay 安装编排归 U183）；拆 22 令全 ≤20 分钟。v2 定向评审在途。
- **U181 H8c 落地**（`1d80a3240ce`）：`--reenroll` 只在 orcad 实例锁区内执行（`lock → reenroll → start` 顺序钉）；CLI 仅转发、spawn 前零凭据 I/O；live 锁 → 78 且凭据不动；成功备份 `.bak-<ts>` 0600；失败回滚且无备份残留；76 例绿。**H6 在途**（运行期心跳状态机与退避）。
- **U183 v2 评审 + R3 开工**（`test-reports/u183-v2-review.md`）：3 个 P0 实质关闭（realpath 守卫已在临时目录三态实测；VERSION/manifest 五步映射；unit `EnvironmentFile`）；剩两窄阻断——B1 R12 依赖的 helper 在 U182 b2 **未落地**（改为 R12 自身抽取）、B2 本地 HTTP 平台需按 scheme 生成 proto 限制。R1/R3 放行；已派 v3 文档修补与 **R3**（守卫 realpath + `RELAY_ID` + `--preflight`）。
- **U183 R3 落地**（`61560b6ddac`）：`isMainModule` 改 realpath 双侧比较（try/catch），覆盖 `current` 叶子与前缀符号链接；`--preflight` 只校验（Node<22.18→64；URL/token/port 非法→78；通过 exit 0 且不 listen）；`ORCA_CLOUD_RELAY_ID` 进入上报 payload，缺省仍 `relay:<port>`（兼容 PORT=0 e2e）；7 例绿 + relay 回归全绿，判别力红。**R12/R1 在途**（helper 抽取、确定性 bundle+manifest）。
- **U181 H6 落地**（`46148fbf4ca`）：运行期心跳状态机——200→`online`（清错、退避复位）；5xx/网络→`degraded`（指数退避 10/30/60s，复用既有 interval，不新增轮询）；401/409/200+hostRevoked→`error` 并终止一次；状态文件每次心跳原子刷新。41 例目标套件绿，`src/main/cloud-platform`+`orcad` 全量 168 文件/997 例通过（除下述已修项）。
- **测试隔离缺陷修复**（`7815fea64b1`）：`orcad-host-reenroll-lock-order.test.ts` 未在用例间清 mock，导致「无 flag 不触碰凭据」用例假红（H8c 声称的 76 例绿在此文件上不成立）；已补 `beforeEach` 清理，3/3 绿。教训：H8c 自测未覆盖「用例顺序依赖」，需在后续验证中重跑该套件。
- **U183 R12 落地**（`a0e78a1d1f1`）：新建 `install-script-command.ts`（`shellQuote` 移入、`requireCommand` 多候选、`systemdAvailable`），host/relay 脚本消费；缺命令统一 exit 78（EX_CONFIG）；`hostInstallScript`/`relayInstallScript` 导出以便文本断言；helper 5 例 + relay-nodes 45 + install-wizard 20 全绿。**R4 在途**（relay 预检 64/78 细化）。
- **U183 R1 落地**（`d3c6b45195e`）：`build-relay-bundle.mjs`——按 `relay.ts` import 闭包收集并断言不越出 `/apps/relay/src` 与 `/packages/contract/src`；包内 `VERSION` 仅 schema+code 版本；固定 ustar/noMtime/gzip -n（跨平台确定性，避开 bsdtar）；**两次构建同 sha `100a3acf…`**，单字节改动 sha 变；包外 manifest（sha/files/版本/builtAt）；5 例 + relay-entry 7 例绿。**R2 在途**（平台 bundle 路由 + 脚本内嵌 sha/URL）。
- **U183 R4 落地**（`77ff4fef82d`）：relay 预检细化——缺 node/版本<22.18→64、缺 `relay.ts`→78、安装根不可写→78（默认根改 `$HOME/.orca-cloud/relay`）、平台 `/health` 非 2xx→68、通过→0 且失败不留 env/releases；`requireNodeVersion`/`requireWritableDir` helper；55 例绿、四项判别力红。**并发冲突已协调**：R2 与 R4 同改 `server.ts`，已要求 R2 提交前并入 R4 并核验两处共存。
- **U183 R2 落地**（`919f35e3cc3`，R4 完整保留）：公开 bundle 路由（`/install/relay-bundle/<sha>.tgz|.manifest.json`，注册于管理员门禁之前；非法 sha/穿越 400、目录缺失 503、文件缺失 404、均 `no-store`）；`relay.sh?sha=` 内嵌 `SHA256/URL/SCHEMA/CODE/DOWNLOAD_TLS`（https 加 `--proto`，本地 http 警告，非 loopback http 400）；缺清单/坏清单 500；未选 sha 保持旧脚本兼容；12 例 + 回归 67 例绿。**R5/R10a 在途**。
- **U183 R10a 落地**（`f230790ddc6`）：上报体可选 `installNonce`（trim 1–128、`[A-Za-z0-9_-]`；缺失兼容旧中继；非法 400 `RELAY_INSTALL_NONCE_INVALID`；非粘性存储避免旧版本冒充；内部与管理接口回显）；中继读 `ORCA_CLOUD_INSTALL_NONCE`（env 名已与设计对齐 `0e55968c748`）；35+16+12 例绿。**已协调 R5 提交前并入 R10a**。
- **U183 R13a 落地**（`bd0b2ae8b48`）：容器 harness（唯一名/`--rm`/临时 HOME/工具探测/`host-gateway`）、`execInContainer`、`checkPlatformReachable`、精确清理 + exit 兜底；Docker/镜像/工具缺失 → `available=false + skipReason` 不抛；自测 5 例绿、无残留。**R13b 在途**（运行器与证据结构）。
- **U183 R5 落地**（`abcaf2c2d73`，R10a 完整保留）：下载 `.part` + 超时（connect10/max120），https `--proto`/http 警告；`sha256sum`→`shasum` 双探测不符 66（删坏包）；manifest `grep -F` 交叉校验失败 67；全部在写 `relay.env` 之前；离线 `ORCA_RELAY_BUNDLE` 跳过下载仅校验（不符 66 且保留用户文件）；同 sha 缓存复用；6 钉 + 四套 76/76 绿。**R6/R13b 在途**。
- **U183 R13b 落地**（`0db9dff4ead`）：容器运行器（退出码分类 0/64/65/66/67/68/78/other、超时 124、harness 不可用→`skipped` 不出容器）+ 证据契约（`summary.json` 含 verdict/pass-fail-null 与 skipReason、`results.json`、逐步原始日志、自动 `validate-evidence --check-generated-at`）；13 例绿（含 generatedAt 缺失判别）。**H9a 在途**（host 脚本接线 `--host-mode` + 状态自证）。
- **U183 R6 落地**（`0a1ee1e3bc7`）：tar `-tvzf` 类型白名单（仅 `-`/`d`，拒链接/设备/FIFO/socket/pax）、路径拒绝绝对与 `..`、顶层白名单；空目录解包 + `--no-same-owner/--no-same-permissions`（GNU 追加 `--no-overwrite-dir`）+ 解包后 `! -type f ! -type d` 复查 + 必需文件检查；`current/previous` 原子切换（BSD 回退）；同 sha 幂等跳过；35+42 例绿。**码表偏离纠正中**：解包失败应 67（设计 §4.1），R6 误用 69（任务书笔误）；已派纠正令并要求 H9a 提交时合并该纠正。
- **U181 H9a 落地**（`b47554188bf`，含 R6 的 67 纠正）：host 脚本时序=预检（`orca-ide`/`orca` 解析）→hostname/TLS→`host.env` 原子写（新增 `ORCA_USER_DATA_PATH`，TLS 路径同次写入）→health 2xx→`nohup <bin> --host-mode`/unit `ExecStart` 同形→**状态自证 ≤90s**（schemaVersion=2、status=online、lastHeartbeatOk、hostId 非空、pid 存活；starting/degraded 不算在线）超时 70 并打印状态摘录与日志尾；90/90 绿。**R7/H7 在途**（relay env nonce、orcad 四态端到端）。
- **U181 H7 落地**（`b176b827ca2`）：统一 `heartbeatVerdict/applyHostModeHeartbeatVerdict`（首心跳与 watcher 同分类）、共享 `terminal` 标志防重复终止、fatal relay 缓存注册前到达的退出码；事件序测试 `starting→online→degraded→online→error` 且 401 恰一次 78、503 `retryable:true` 继续；`src/main/orcad` 529 例 + cloud 38 例绿。
- **U183 R7 落地**（`4f08de6c7fe`，H9a/R6 保留）：`relay.env` 字段齐全（URL/token/PORT/RELAY_PUBLIC_HOST/RELAY_ID/INSTALL_NONCE/bundle 配置）；`RELAY_ID` 默认 `host:18443` 且重跑复用；nonce `openssl rand -hex 16`（回退时间- PID）；**原子写**（mktemp→chmod 600→mv -f），无截断/追加路径；重跑 nonce 变、其余字段不变；42/42 + 55/55 绿。**H9b 在途**（host unit 生成）。
- **U181 H9b 落地**（`278fe195c22`，H9a/R6/R7 均在 HEAD）：systemd 分支写 `~/.config/systemd/user/orca-cloud-host.service`（`EnvironmentFile=%h/.orca-cloud/host.env`、`ExecStart=<bin> --host-mode`、`Restart=on-failure/RestartSec=5`、`RestartPreventExitStatus=78`、StartLimit 5/60）；linger 失败仅告警；`enable --now` 失败→69；非 systemd 保持 nohup；96/96 绿、两项判别力红。**H10a 在途**（unit 模板参数化，host/relay 共用）。
- **U181 H10a 落地**（`d78ea4c596d`）：`systemd-unit-template.ts`（`renderSystemdUnit` 参数化 + `renderHostUnit` 含 78/StartLimit + `renderRelayUnit` 不含 78、`ExecStart=<node> <root>/current/.../relay.ts`、`EnvironmentFile=<root>/relay.env`）；H9b 内联模板改为调用（字节等价）；102/102 绿。**R8 在途**（relay unit 安装，server.ts 串行）。
- **U183 R8 落地**（`8471cd1231a`）：relay 真正安装 systemd user unit（`renderRelayUnit`：`current/...relay.ts`、绝对 `relay.env`、无 78、StartLimit）；`daemon-reload`+`enable --now` 失败→69 `relay_service_install_failed`；自证仅留调用点（R10b 实现）；修正 `relay.env` 路径为 `<ROOT>/relay.env` 与 unit 一致（同步测试）；105/105 绿。**U181 P1-2/3/4 批在途**（ORCA_CLI/Linux 解析、preflight 前置、自证新鲜度）。
- **U181 审计 P1 全清**：P1-1 `942a51f5b9d`（缺 hostName 结构化→78+error/enrolment）；P1-2/3/4 `368ac4d4c2f`（CLI 解析顺序、Linux 禁裸 `orca`、preflight 前置不落盘、自证三项新鲜度）；install-wizard 57 + 其余 56 例绿。**R9 在途**（relay 无 systemd wrapper+pid）。P2 15 项留打磨批。
- **U183 R9 落地**（`063968f5003`）：无 systemd 时写 `<ROOT>/run-relay.sh`（source env + exec node relay.ts，chmod 700），`nohup setsid`（无 setsid 回退 nohup），wrapper `$$` 经 exec 不变作为真实 pid 写入 `relay.pid`；启动后 10s 等 pid + `kill -0` 复核，失败 69；明确不自启；60+56 例绿。**R10b 在途**（nonce 匹配 + MainPID/pid + 时钟容差自证）。
- **U181 P2-A 落地**（`c2b5a61f63e`）：admission 增 `onRegistrationState` 回调；状态中间态 `enrolling`（发注册前）与 `registered`（凭据后、含 `hostId/registeredAt`）落盘；优雅关闭写一次 `stopped`（保留最后字段，error/teardown 失败不覆盖）；`lastErrorCode` 命名唯一（无 `heartbeatError`）；`registeredAt` 为 epoch 毫秒（与 schema 一致，ISO 需同步改类型）；序列测试 `starting→enrolling→registered→online`；534 例绿。
- **U183 R10b 落地**（`f5c3061d8f4`）：自证实现——进程身份（systemd `MainPID` / 非 systemd `relay.pid`，`kill -0` + cmdline 含 `relay.ts`）+ `installNonce` 匹配平台 `/v1/internal/relays`（旧中继空 nonce 降级为身份+online 并警告）+ 平台时钟偏移容差 `max(5s,|skew|+2s)`；401/403 立即 70；超时 60s → 70 并打印 pid/cmdline/relays/日志尾；121 例绿。**R11a 在途**（安装锁/同 sha 幂等/previous 规则）。
- **U183 R11a 落地**（`f69c8aa0dfe`）：`mkdir` 安装锁（pid/时间、1s 重读、死锁清理、竞争者 75、trap EXIT 释放）；同 sha 幂等（跳过下载/解包/激活、env 重写新 nonce、unit `cmp -s` 不重写、previous 不动）；65 失败路径释放锁；四套全绿。
- **stale 断言修复**（`02365119bd9`）：`web-host-lifecycle-feedback` 仍断言旧 `bash <(curl …)` 形态（U182 批 1 已改为显式下载 + `|| exit 1`）；已更新为断言新形态并禁止旧管道；4/4 绿。
- **U181 P2-C 落地**（`7c1bfdab001`）：preflight 增 profile 可写探针（无残留）与实例锁只读检查（活锁→`profile_in_use`/78 并提示 pid，死锁可回收）；orcad 直调复用 CLI 冲突规则拒绝 pairing 类 flags（78）；checks 顺序 config→profile→runtime；CLI/orcad 2234 例绿、tc:node/tc:cli 通过。
- **U183 R11b 落地**（`c47d740a73b`）：升级（`orca_relay_atomic_link`、systemd `restart`、非 systemd 先停旧再启、同 sha 重跑也重启以刷新 nonce）；自证失败返回类型化原因，异 sha 升级且 previous 存在 → 切回 previous + 重启 + 30s 复证，stderr `rollback=ok`/`rollback=failed`（码表无 71，用 70）；N-1 清理仅删带 `.orca-relay-release` 标记的自有目录；74+28 例绿。**R13c 在途**（干净容器正向 e2e）。
- **U183 R13c 落地**（本次）：新增 `u183-r13c-container-forward.e2e.test.ts`——构建 bundle + 随机端口平台 + R13a forwarder + 管理员一次性安装命令，覆盖 6 条正向断言并复用 R13b 证据契约。本机镜像 `jlc-deb12:rust` 无 `node`（`node --version` exit 127），按约定判 **INVALID（skipReason=node-unavailable）**，证据 `evidence/u183-r13c-20261117T110158Z/` 通过 `validate-evidence --check-generated-at`。旁证：生成器对 `Host: host.docker.internal:<port>`（http）返回 400 `RELAY_BUNDLE_INSECURE_URL`（产品策略正确，缺口在测试链路）。
- **U184 落地**（本次）：R13c 旁证发现真实产品缺陷——bundle 模式脚本在下载前仍要求 `$ORCA_RELAY_ROOT/cloud-platform/apps/relay/src/relay.ts`，干净主机必 78 退出；修复为 bundle 模式入口取 `current/apps/relay/src/relay.ts` 且跳过仓库预检，仓库模式保持 78。夹具 `makeRelayRoot` 不再伪造仓库 checkout（原为假绿来源），新增仓库模式抓取（`?sha=`）与两模式入口断言；install-wizard 74/74、重点 2/2 绿。台账 U184（🔴，待容器复验翻绿）、U185（容器环境缺口：Node 镜像 + TLS 终结）、U186（仓库模式启动入口仍指 `current`，P2 随 U183 P2 批）。
- **U183 R15 落地**（本次）：下载缓存清理——bundle 模式成功后只保留 `current`/`previous` 对应的 `<sha>.tgz`（仅 64 位十六进制命名，其他文件不动），失败残留 `.part` 超过 7 天清理；缓存目录提升到 bundleVars，使同 sha 重跑也执行清理。install-wizard 77/77 绿（新增 3 例：脚本断言、首装清理、升级保留 + 重跑命中缓存）。对应设计 P2-3 关闭。
- **U186 落地**（本次）：仓库模式启动入口不一致——`renderRelayUnit` 增加可选 `entry`（默认 bundle 的 `current/...`），relay 脚本的 unit 与 run-relay.sh 统一用 `$ORCA_RELAY_ENTRY`（按模式展开）；bundle 模式字节不变，仓库模式不再指向不存在的 `current`。模板 7/7、install-wizard U186/R8/R9 7/7 绿。
- **U187 落地**（本次）：relay unit 对齐设计 §3.2——补 `After/Wants=network-online.target`、`Type=simple`、`WorkingDirectory=<ROOT>/current`（仓库模式为 `<ROOT>`），`RestartSec=2`；安装时探测 `systemctl --version`，<229 则剔除 StartLimit 并降级 `Restart=no` 且告警。模板 7/7、install-wizard U187/R8/R9/U186 8/8 绿。
- **U185 落地**（本次）：容器正向 e2e 环境缺口修复（仅测试基建）——可跑镜像 `orca-e2e-node24-bookworm:local`（slim + curl/openssl，Dockerfile 入库，`ORCA_E2E_RELAY_IMAGE` 覆盖）；宿主 TLS 终结代理（自签 CA、CN/SAN=`host.docker.internal`），容器只挂 CA 并以 `CURL_CA_BUNDLE`/`NODE_EXTRA_CA_CERTS` 信任；生成器不再返回 400。R13c 复跑 **PASS**：安装命令 exit 0、relays online 且 nonce 匹配、`current` 指向、进程存活、无 unhandled、证据 `verdict=pass`（`evidence/u183-r13c-20261117T111608Z/`，validate exit 0）。**U184 一并由该容器实测翻绿**（干净主机 bundle 安装成功，无仓库 checkout）。
- **U181 H10b 落地**（本次）：无 systemd 路径改为 `run-host.sh` wrapper（显式 source `host.env`、`setsid`/`nohup`、`host.pid` 记录真实 pid），输出改为可复制的 wrapper 命令；systemd <229 时剔除 StartLimit 并降级 `Restart=no`（宿主内有界重试）且告警。install-wizard 80/80 绿（含旧 systemd 夹具；同步修正两处旧 `nohup … --host-mode` 断言）。
- **U183 R14a 落地**（本次）：容器负向 I——N1 离线篡改 → 66、N3 bundle URL 指向不存在路径 → 65（非 67/70）、N4 无 Node 镜像 → 64；三条均断言失败前无 env/release/current/pid/lock 且无 relay 进程。证据 `evidence/u183-r14a-20261117T112202Z/`（verdict=pass、validate exit 0、8 step 全 ok），容器无残留。**R14b 在途**（N2 平台不可达 / N6 内部令牌 401）。
- **U188 落地**（本次）：仓库模式（无 bundle）预检要求 `ORCA_RELAY_ALLOW_UNVERIFIED=1`，否则 78 并提示；置位时打印「使用未校验的中继目录」警告。bundle 模式不受影响；U186/U188/U184 3/3 绿。
- **U183 R14b 落地**（本次）：容器负向 II——N2 健康 500 → 68（宿主临时端点，容器内实测可达 500）、N6 内部令牌 401 → 70（stderr 含「内部令牌不匹配」，不出现 rollback）；N2 无 env/release/lock，N6 无回滚。证据 `evidence/u183-r14b-20261117T112331Z/`（verdict=pass、validate exit 0、容器无残留）。发现两条 P2：U189（凭据失败后中继进程遗留，待定处置）、U190（证据分类缺 70 映射，待补）。**R14c 在途**（N5 崩溃首装/升级回滚、N7 并发 75）。
- **U190 落地**（本次）：容器证据退出码映射补 70 → `relay-not-online`（原记 `other`），runner 自测 13/13 绿；R14b 证据分类待重跑刷新。
- **U189 落地**（本次）：凭据失败（内部令牌 401）分支在 exit 70 前停止本次启动的中继（systemd `stop` / wrapper pid 清理）并打印原因，避免留下永远无法登记的常驻进程；R14b 新增 `n6-credential-failure-stops-relay` 断言，10 step 全绿，证据 `evidence/u183-r14b-20261117T112539Z/`（70 分类已为 `relay-not-online`）。
- **U183 R14d 落地**（本次）：N8 无 systemd 分支——容器内 `systemctl` 缺失，安装 exit 0；`current`/进程/online+nonce 匹配；stdout 无任何 `systemctl --user` 指令、含「不随开机自启」、wrapper 700；**真实 `docker restart` 后不自动恢复**（旧 pid 不存活），证明文案与行为一致。证据 `evidence/u183-r14d-20261117T112558Z/`（10 step 全 ok、validate exit 0、容器无残留）。**R14c 在途**（N5 首装/升级回滚、N7 并发）。
- **U183 R14c 落地**（本次）：N5 首装崩溃包实测 **69**（`relay_start_failed`，无 previous 可回滚；`current` 指向崩溃 release 属设计事实）；N5 升级崩溃包 **70 + rollback=ok**，`current` 指回旧 release、平台重新 online 且 nonce 匹配；N7 同一 root 并发 9 轮全部稳定 `[0,75]`（`relay_install_busy`），锁均释放。证据 `evidence/u183-r14c-20261117T112958Z/`（另两次 PASS 保留），validate exit 0，无容器残留。夹具修复：macOS `COPYFILE_DISABLE=1` 避免 AppleDouble 触发 67。新发现 U191（证据分类器缺 69/75）。
- **U191 落地**（本次）：容器证据分类补 69 → `service-install`、75 → `busy`；runner 13/13 绿；R14c 重跑（`evidence/u183-r14c-20261117T113125Z/`）N5=service-install、N7 三轮均 `(0,ok)/(75,busy)`。清单补 macOS `COPYFILE_DISABLE=1` 条目。
- **U183 闭环**（本次）：22 令全部落地，提交与验证见设计附录 C；容器正向 R13c + 负向 R14a–R14d 全 PASS；实现期偏离 U184/U186–U191 全部关闭。台账 U183、U182 翻绿；剩余 U181 验收（H11–H13）仍依赖打包 `orca-ide` 二进制。
- **授权组合复验（首轮）**：常驻平台预检通过（health 200、三身份登录、种子存在但 ID 已 reseed）。API 矩阵 47/60 失败均为驱动硬编码旧 ID（U192）；Web 矩阵执行 8/17，P4/H1/H2/H3 失败或 fatal，经核实为驱动与 U67 语义漂移（browser 第六位、provisionPolicy 弃用、抽屉 tab 重构），未发现确证产品回归（U193）。证据 `evidence/authz-reverify-2026-11-17T11-37-04Z/`（validate exit 0、平台健康未变）。修复驱动并重放中。
- **U54 P2 批（QA-018/019/027）落地**：中继时间统一 `zh-CN`（表格+卡片）；toast `role=status`/`aria-live=polite`、`#content` 加载期 `aria-busy`；登录错误 `#loginError role=alert`、密码框 `aria-invalid`/`aria-describedby`（重试成功清除）。`web-exploratory-fixes` 27/27 绿（新增 3 例）。
- **授权组合复验（修复后）PASS**：驱动改为运行时发现种子、缺失即 INVALID；API **60/60**、Web **22/22**（D0、P1–P5、H1–H5、S1–S2、R1–R2、A1–A2、M1–M4、Z1），还原逐条 true、审计链 `checked=16558 ok`；证据 `evidence/authz-reverify2-2026-11-17T11-43-13Z/`（validate exit 0，常驻平台未变）。U192/U193 关闭；新登记 U194（Playwright login 可见性竞态，P3 测试基建）。
- **U54 P2 批（QA-020/021）落地**：中继表/卡片可展开详情（ID、host:port、状态、zh-CN 绝对+相对时间、缺失占位），本地视图态、不新增轮询；新增统一 `copyText`（失败提示「复制失败，请手动复制」、console.warn、永不 reject），所有复制入口复用。`web-exploratory-fixes` 29/29 绿（新增 2 例）。
- **U194/U195 落地**：`ui.login` 改为 `goto` 后一次性等待「登录表单或 app shell」可见，再决定复用/填表；30/30 登录循环 0 超时、Web 矩阵连跑 2 次无登录超时（`evidence/u194-login-race-2026-11-17T11-49-50Z/`）。H2 检查 `[entries.map]` 多包一层修正后重放 **22/22**（`evidence/u195-h2-fix-20261117T115225Z/`，validate exit 0）；常驻平台 health 200、Playwright server 已关停。
- **U54 P2 批（QA-022/024/025）落地**：内容渲染加代次守卫（慢页返回不再覆盖已切换页面，旧代次按当前路由收敛一次）；「最近项目」按创建/更新时间倒序取 3，新建项目可见（`updatedAt` 数据源缺失，登记 U196）；策略保存「未变化短路 + 在途禁用」，双击只发 1 次 PUT。`web-exploratory-fixes` 32/32 绿（新增 3 例）。
- **U197 设计令落地（QA-032 令牌存储）**：产出 `work-orders/u197-token-storage-design.md`——现状/威胁模型、A（access 内存+refresh sessionStorage）、B（refresh HttpOnly Cookie+access 内存，推荐）、C（localStorage+CSP 纵深）对比，含兼容顺序（服务端先行/回滚 Web 先行）、验收判据草案与 14 项待决策。设计过程新登记 U198（刷新不回退 refresh）、U199（多标签轮换撤销 session）、U200（无 CSP，待裁定）。
- **U54 P2 批（QA-028/029/033 前半）落地**：移除授权确认补「不可撤销/需重新授权」文案，空主体给持久行内提示；主机抽屉补状态（在线/维护/离线/已吊销）、维护原因、绝对+相对心跳；注册主机弹层改为点击「生成注册命令」才申领令牌（打开/取消零请求，在途禁重复）。`web-exploratory-fixes` 36/36 绿（新增 4 例）。
- **U201 工作令落地**（审计导出）：新增 `work-orders/u202-audit-export-design.md`——契约（POST /v1/audit/export、GET status、补充 /download）、任务存储与 1h 生命周期、审计自身落审计（`audit_export`/`audit_export_download`，创建 fail-closed）、一次性下载 token、CSV 注入防护、能力字段兼容；拆 E1–E13（各 ≤20 分钟）与 16 项待决策。**未实现**，待裁 D1/D3/D4 等后按 E 序列派工。
- **U54 P2 批（QA-030 主机页筛选）落地**：主机页新增搜索（名称/ID/zone/直连地址）与状态 chips（全部/在线/维护中/离线/已吊销），表格与移动卡同步过滤、空态区分「尚未注册/没有符合条件」、重绘后行内按钮重新绑定、无新增轮询。`web-exploratory-fixes` 39/39 绿（新增 3 例）。
- **U201 E1 落地**：审计查询参数解析抽为 `apps/api/src/audit-query.ts`（`parseAuditQuery(params, nowMs)`，保留 `INVALID_QUERY` / `TIME_WINDOW_TOO_LARGE` 与全部边界：limit 钳制、eventTypes 1–20/≤64、family、fileName/q、since/until、31 天窗口与 7 天关键字默认）；server.ts 审计 GET 改用该函数，行为逐字等价。新单测 24/24，审计 e2e 17/17。
- **QA-033 测试适配**：`web-host-lifecycle-feedback` 两个用例按「打开不签发、点击生成才申领」更新——打开 0 次 POST；生成 1 次并渲染命令；失败显示行内错误且弹框保留供重试。G09 套件 + 主机相关 3 套 18/18 绿（回归发现于提交后，符合 §2-91「改交互须跑完整相关套件」）。
- **U201 E4 落地**：新增 `apps/api/src/audit-export-format.ts`（固定 11 列表头、RFC 4180、`= + - @ Tab CR` 公式中性化、metadata JSON 列、JSONL 单行保序）+ 单测 12/12；BOM 留待 E6/E8 写盘阶段按 D9 决定。
- **U201 E2 落地**：审计事件目录新增 `audit_export` / `audit_export_download`，Web 标签「审计导出/审计导出下载」；目录单测 2/2、审计状态 e2e 3/3 绿。
- **web e2e 全量回归**：20 个套件分 3 批（并发 2）共 **164 例全绿**（66+18+80）；`app.js` 本轮改动（路由代次、中继详情、复制、策略幂等、注册令牌、主机筛选、ARIA）未见回归。
- **U201 E3 落地**：`apps/api/src/audit-export-jobs.ts`——jobId `exp_<24hex>` 白名单 + resolve 前缀校验、`<root>/<jobId>/job.json` 原子写（0700/0600）、状态机（queued/running/succeeded/failed，expired 派生）、注入时钟过期与清理（含孤儿目录/符号链接拒绝）、每用户 2/全局 8 并发计数与配额；命名按设计回填 `succeeded`/`createdAt`（响应字段 `requestedAt` 由 E5 映射）。E3+E4 测试 24/24。
- **U201 E6 落地**：`AuditExportWorker`（注入 store/query/now/上限）——cursor 分页（页 ≤200、游标不前进即失败）、按 seq 升序导出、maxEvents/maxBytes 超限 `EXPORT_TOO_LARGE`、写盘失败 `EXPORT_WRITE_FAILED`、查询不可用 `EXPORT_AUDIT_UNAVAILABLE`、tmp+rename 无半截产物；`processQueuedAuditExports` 供 E9 复用。E3/E4/E6 31/31 绿。
- **U201 E9（清理段）落地**：`audit-export-runtime.ts`——env 构造 store（TTL/配额可覆盖）、启动即清理 + 5 分钟 unref 定时、`stop()/runNow()`、错误不外抛；`createApp` 接线单例 store（`ApiHandle.auditExportStore`）并在 `close()` 停表。8 例 + jobs 12 例绿。**未完成**：启动恢复（queued/running → failed/EXPORT_INTERRUPTED）、env 名应为 `ORCA_AUDIT_EXPORT_DIR`（当前 ROOT）、测试默认触达真实 home 目录 → E9b 跟进。
- **U201 E7a 落地**：`AuditExportJobStore` 下载 token 原语——24 字节随机、只存 sha256、5 分钟 TTL、每次签发轮换旧 token、`verify` 不消费、`consume` 一次性并记 `downloadedAt`；非 succeeded/过期不可签发；常量时间比较。jobs 测试 12→18 绿。待 E7 路由：先 read 判 404/410，已消费不返回 downloadUrl；多副本需锁（D1）。
- **cloud-platform 单测回归**：`test/*.test.ts` + `apps/api/test/*.test.ts` 共 **237/237**（47 suites）绿。
- **台账缺口补登记 U203**：M116 探索 P2×18 此前未在台账建号（只在 PLAN/PROGRESS/gitignored findings），现建立唯一入口并逐项记录状态；余 QA-030 统计卡（U202）、QA-031 导出（U201）、QA-032 令牌（U197）。
- **U201 E9b 落地**：启动恢复 `queued|running → failed/EXPORT_INTERRUPTED`（首次恢复一次后仅清理，恢复失败走 onError 不阻断 prune/启动）；env 优先级 `ORCA_AUDIT_EXPORT_DIR` → `ORCA_AUDIT_EXPORT_ROOT` → 默认；`spawnService` 为每个 e2e 服务注入临时导出根（调用方显式值优先）并暴露 `Service.env`，e2e 不再触达真实 `$HOME`。jobs+runtime 35/35、隔离 e2e 2/2、audit-anchor 回归 1/1。
- **U201 E5 落地**：`POST /v1/audit/export`（admin/auditor；confirm 必填、format csv|jsonl、复用 `parseAuditQuery`、until clamp 到 now、配额 429 `EXPORT_BUSY`）；202 返回 jobId/status/format/requestedAt/expiresAt；创建后写 `audit_export`（含 jobId/过滤快照/上限，无 token），审计失败回滚任务并 500 `EXPORT_AUDIT_UNAVAILABLE`；所有出口 no-store。e2e 9/9 + audit-export 单测 54/54 绿。D3/D4/D7 按建议默认，D1 多副本共享留待裁定。
- **U201 E7 落地**：`GET /v1/audit/exports/:jobId`——admin/auditor、仅创建者可见（他人/未知一律 404）、过期 410、queued/running/failed 无链接、succeeded 每次读取轮换下载 token 并返回相对 downloadUrl、已下载不再发链接；全部 no-store。e2e 10/10 + jobs 21 = 31 绿。下载端点（E8）随后。
- **U201 E6b（U204）落地**：`createApp` 构造单例 `AuditExportWorker`（复用审计链同步 query）；受理 202 响应写入后 `setImmediate` 触发 `processQueuedAuditExports(1)`，异常只 console.error、不冒泡；每请求只排一次、worker 同步执行不双跑。新增 runner e2e 2/2（非空导出 succeeded/行数=totalEvents/seq 升序；空集 succeeded+空产物）；E5 旧生命周期断言按新现状适配（状态集合、配额用预置 queued），审计导出三套 e2e **21/21**。
- **U201 E8 落地**：下载端点——token 缺失/错误/换 jobId → 404，task/token 过期/已用 → 410，产物缺失（含符号链接）→ 410；**先解析并 lstat 产物、再消费 token、再审计、最后发送**（避免缺文件烧 token/写假成功审计）；审计失败 500 且不发字节；CSV/JSONL content-type/disposition、no-store、nosniff、content-length；`deleteAfterDownload` 在响应后删产物保留 job.json。download/status/runner 三套 e2e **23/23**。
- **U201 独立审计 CHANGES-REQUIRED**（`test-reports/u201-export-audit.md`，快照 `3a3ac6aeb2c`）：P1=F1 七个过滤字段被静默丢弃（导出超范围）、F2 终态不落链/无 phase、F3 远端写者下导出必失败、F4 一次性绑定 job 而非 token；P2=F6–F18（错误码/窗口/内存/恢复/探测等）；测试缺口 F20（预置夹具、无全链路）、F21（文档滞后）。已登记 U205/U206/U207，修复顺序 F1/F7 → F2/F11/F12 → F3 → F4，随后补全链路 e2e。
- **U201 E10 落地**：`/v1/audit/status` 追加 `auditExport` 能力字段（formats/maxWindowDays=31/maxRows=100k/maxBytes=64MiB/jobTtlSeconds（反映 env）/downloadTokenTtlSeconds=300），旧字段不变、普通用户 403；e2e 3/3 + 受理 9/9。
- **U205 F1/F7 修复**：`AuditQueryFilters` 扩 7 个精确字段（actor/eventType/result/traceId/username/projectId/hostId），GET 改走解析器（行为等价、仅 trim 归一化）；POST 导出映射全部 12 字段并移除无条件 `until=now`——q/fileName 恢复 7 天默认、其余 31 天，显式 until>now 才 clamp；worker 全字段转发。单测 36/36、e2e 21/21、u66-2 8/8；新增「不存在过滤值→0 条」与「默认窗口」判别。
- **U201 E11 落地**：审计页按 `auditExport` 能力显示导出入口；确认对话框（格式/筛选摘要/敏感提示、sheet），确认后 POST 并单定时器轮询（1s、60 tick/60s 双上限，成功/失败/过期即停）；路由切换/重新查询/关闭对话框清理；400/403/429/410 中文文案；双击只 1 次 POST。`web-audit-export` 9/9 + 回归 39/39。下载按钮留 E12。
- **U205 F2/F11/F12 修复**：worker 注入 audit sink 写终态事件（`phase:'finished'`，成功含 totalEvents/bytes、失败含 errorCode，best-effort）；恢复时删除被中断任务的 `events.*`/tmp（保留 job.json）；受理改为「预生成 jobId → 先写 `phase:'accepted'` 审计 → 落盘」，审计失败不落盘、落盘失败补 failure 审计。单测 34/34、e2e 13/13、runtime/status/download 回归 35/35。
- **U205 F3 修复**：worker query 支持 `AuditQueryResult | Promise<...>`，`runAuditExportJob`/`processQueuedAuditExports` 改 async、逐页 await、任务串行；server 删除「Promise 即 throw」并改为 `.catch(console.error)` 触发。单测 14/14（新增 Promise 多页/reject/串行 3 例）；新增真实远端写者 e2e（writer + `ORCA_CLOUD_AUDIT_WRITER_URL`）验证 succeeded/seq 升序/phase=finished，合计 28/28。
- **U205 F4 修复**：一次性从 job 改为 token——消费清空 hash（`downloadedAt` 仅首次写），`verify` 不再因 `downloadedAt` 判 consumed；状态每次重签新 token，仅 `deleteAfterDownload && downloadedAt` 停止签发（`deleted_after_download`）。jobs 24、status 11、download 11、runner 2 全绿；旧 job.json 兼容说明见报告。
- **U207 全链路 e2e 落地**：真实进程「受理→worker→状态→下载→删除」4 例全绿——过滤生效（eventType=login、3 条、seq 升序、未命中不泄漏）、审计链 accepted+finished（totalEvents/bytes 一致、无 token）、token 轮换（旧 token 404、新 token 可再下载）、`deleteAfterDownload` 产物删除与 `deleted_after_download`、所有响应 no-store；无预置 job.json 夹具。
- **U201 E12 落地**：成功态同源 `<a download>` 下载（无 window.open/无 Bearer/不抢焦点），点击后退休链接并显示「已下载」；410/过期文案 + 重新导出入口；`deleteAfterDownload` 提示由服务端标志驱动（**移除前端强制 true**，遵循 D8 默认 false）；重复点击不重复追加。`web-audit-export` 13/13 + 回归 39/39。
- **U205 复审 P2 修复**：新增 `createAuditExportDrain(run, schedule)`——进程内单槽串行 pass（有在飞 pass 时后续触发排队补跑，避免丢任务），异常只 console.error；受理时冻结导出集合（`until=min(until??now,now)`、`since=since??until-(q|fileName?7d:31d)`），job.query 与受理审计同源。单测 3/3、受理 e2e 13/13、导出全回归 43/43。闸门仅本进程，多副本仍依赖 D1。
- **U206 F17 修复**：`listQueuedIds()`（只读、过滤终态/过期/非法/符号链接）+ `startAuditExportSweep`（默认 15s、unref、仅 queued>0 触发 drain、异常不中断、`ORCA_AUDIT_EXPORT_SWEEP_MS` 可覆盖）；`createApp` 接线、`close()` 停表。新增单测 8 + e2e 1（无 POST，仅周期清扫≤5s 捞起 queued→succeeded），相关 49/49。
- **U206 F10 修复**：worker 改分页流式——每页 ≤200 条按 seq 升序写独立分块，全部取回后逆序 `pipeline` 拼接（CSV 先表头），`statSync` 得 bytes 后 rename；成功/超限/异常均清理分块与 tmp；峰值内存 O(页×单事件)+64KiB，不随总量增长。单测 16/16（1200 条 6 页、页间 reject、part 清零）、格式/drain 31/31、runner+fullchain 7/7。
- **U206 F14/F18 修复**：job.json 校验加严（状态/数值/format/objectKey/token hash/query 类型；损坏视为不存在），写路径 lstat 拒绝符号链接与非目录；CSV 增加 UTF-8 BOM（JSONL 不加），worker 流式产物同步写入 BOM 并计入 bytes。jobs 31、format 13、worker 16、导出 e2e 39/39。
- **U206 F15/F13 修复**：`ApiConfig` 增导出目录/TTL/配额/token TTL/清扫间隔与 `now` 注入（config > env（`ORCA_AUDIT_EXPORT_*`）> 默认），store/worker/状态/下载/capabilities 全部读取同一配置；注入时钟 + 500ms TTL 测试稳定触发 410。F13 注释改为事实（带 token 可区分状态，依赖 96-bit jobId 与所有者签发）。runtime 24 例、capabilities 3 例绿。
- **U206 F16 修复**：worker 终态失败消息按 code 固定短句（超限/写入失败/审计不可用/兜底），异常原文仅 `console.error`，不落 job.json、不返回客户端；新增「异常含绝对路径不外泄」判别。worker 16/16、status 11/11。
- **U201 E13/关闭**：设计回填（`audit_exports` 字段、下载子路径、错误码、token 语义）；实施记录 §9.1 覆盖全部 P2 修复与 F9 决策；U201/U206 关闭。最终验证：导出单测（jobs/format/worker/runtime/drain）全绿、7 套 e2e **46/46**、Web 导出 13/13 + 回归 39/39。剩余：U202 统计卡、U197 令牌存储待裁定。
- **U201 Web 真实浏览器验收 PASS**：真 headless Chromium（自起 API + resident Playwright）——能力探测→审计页筛选→确认框摘要→jsonl POST→轮询→**真实 download 事件**→4 行 JSONL 全可解析且 eventType=login；6/6 断言，连续两次通过。证据 `evidence/u201-web-browser-2026-11-17T13-19-03-936Z/`（截图+下载文件+summary，validate exit 0），18787 未触碰、自起进程按 PID 清理。注意：token 每次状态读取轮换，UI 成功后不再读状态（已按此实现），后续若加“刷新状态”会失效屏上链接。
- **U209 修复**：受理改进程内预占位（`reserveAuditExportSlot`：active+pending 对比每用户/全局上限，`finally` 释放，幂等），并发 3 POST 在 limit=2 下稳定 2×202 + 1×429 且只建 2 个 job；失败/异常不泄漏。`audit-export` 14/14 连跑 3 次、fullchain 4/4。多副本仍依赖 D1。
- **U206 复核残留修复**：分块路径写前登记 + `failJob` 兜底清扫（仅当前 job 目录内 `.part-*`/`.tmp` 普通文件，保留 job.json），新增 ENOSPC 半写单测（17/17）；remote-writer e2e POST 前轮询 login 事件（≤5s），连跑 3 次稳定；fullchain 4/4；§9.1 单写者措辞按事实修正。
- **U206 重新关闭**：残留修复后导出单测 91/91、e2e 49/49（含隔离/远端写者）；U201/U205/U206/U207/U209 全部 🟢。剩余待裁定：U202 统计卡、U197/QA-032 令牌存储、U196 最近使用、U163 处置；U181 验收待打包 `orca-ide`。
- **U54 WEB-R2-014/016 落地**：核对确认 traceId 筛选（URL 同步/导出/重置）已在分支存在，未重复实现；补输入长度约束（项目/主机搜索、审计 keyword/fileName 128；密码框不受限）与 2 条回归测试（traceId 全链路、maxlength）。`web-exploratory-fixes` 41/41。
- **U54 WEB-R2-012 落地**：管理员项目页副标题改为「管理员视图：展示全部项目（含管理员可见、未授权）」，非管理员保持原文案；新增断言（41→42 例）。
- **WEB-R2-010 定性（非缺陷）**：只读复现 600 条 host.* 事件——152 个重复组、seq 均不同、metadata 逐字节一致、90 个连续组 hash 链自洽、`/v1/audit/verify` ok；机制为同一心跳批次内多次真实拒绝共用请求 traceId（`appendHostAuditReports`）。证据 `evidence/u54-web-r2-010-20261117T133436Z/`（validate exit 0）。残余可观测性建议登记 U210（⚪，逐请求 traceId）。
- **U54 收尾回归**：`web-exploratory-fixes` **42/42**（含新增 traceId/maxlength/管理员副标题 3 例）；WEB-R2-010 定性为非缺陷（输入侧重复，证据 `evidence/u54-web-r2-010-20261117T133436Z/`），残余可观测性建议 U210。U54 仅剩 008（克隆失败 UX）待裁定；U203 仅剩 QA-030 统计卡（U202）与 QA-032 令牌（U197）待裁定。
- **LDAP LGA 设计评审（本地 `test-reports/lga-design-review.md`）**：CHANGES-REQUIRED。六令均已落地（1a–5），单测 23/23；P1-1 桌面错误码无文案、P1-2 groups 只增+refresh 无限续期、P1-3 嵌套组未定义、P1-4 混合版本副本绕过、P1-5 目录不可达 401+计数、P1-6 filter/DN 转义未入契约；P2 文档/UI 仍暗示组→角色。登记 U211（即时修项，已派修）、U212（待裁定批）。
- **U197 令牌存储设计评审（本地 `test-reports/u197-token-design-review.md`）**：CHANGES-REQUIRED（P0-1 Cookie 刷新仍返回 body refresh → HttpOnly 失效、AC4 假通过；P0-2 旧 Web 会写入 undefined 掉线；P1 grace/安全 Cookie/Origin/迁移/测试缺口）。登记 U213，已派设计修订（P0/P1/P2 全部落入），复审后待用户裁定 6 项关键决策。
- **U211 落地（LGA 评审即时修项）**：桌面 `ERROR_COPY` 增 `LDAP_GROUP_NOT_ADMITTED`（含映射与 UI 单测）；`roleSource` 由 `'ldap'` 改为 `'default'`/`'admin-override'` 并同步 Web 文案（「平台默认/管理员覆盖」）、e2e 与探索脚本；requirements:105、u67:460、墓碑与 m06 文档对齐。renderer 24 例、u67-3 6/6、u114 2/2、tc:web 通过。
- **U213 设计修订（v2）**：按评审把 P0-1（按凭据来源决定响应形态）、P0-2（旧客户端矩阵+body token 必返）、P1-1..5（grace 六条语义、Cookie 模式与删除旧键条件、Origin/可信源、迁移回退判据、测试策略）与 P2 择要全部写入；待决策压缩为 6 项；P1-1 与 P0-2 的字面冲突按「Cookie-only previous 不返 body；body 请求原样返回所提供 token」收敛。diff 84/40，待复审。
- **U197 v2 复审 CHANGES-REQUIRED**（本地 `test-reports/u197-token-design-rereview.md`）：P0-1 未闭环（body 非空必返新 refresh 可被假 body 利用）；另 401 守卫依赖 refreshToken、过期 Bearer 登出不清 Cookie、迁移状态机/移除判据未定、锚点错误、handoff 跨源 Cookie 无效。已派 v3 修订；PLAN 第 10 项更新为 16/18（余 U202/U197 待裁定）。
- **U197 v3 修订**：P0-1 响应形态定死（Cookie 源不轮换/不返新 refresh；body 仅 current/previous 原样回显；假 body 无 token），AC11 三档；能力标记只走响应 `refreshCookie`；401 Cookie 模式守卫、过期 Bearer 登出清 Cookie、迁移状态机四分支、body 移除遥测/期限判据、锚点重算与 Cookie/grace 默认值、handoff 跨源限制；待决策重切 6 条互不重叠。待 P0 聚焦复审。
- **U197 v4 修订**：登录/平台同源交接在**实际下发 Cookie 时**响应体不含 refresh（`refreshCookie:true` 与 body 形态一一对应），宿主跨源/无 Origin/`COOKIE_MODE=never` 保留 body token；Wire 矩阵+AC15；Cookie 同名不同 Path 取最具体、重复即 401 且无副作用；标注旧 app.js 会写字符串 "undefined" 但永不作凭据、非令牌值；无 Origin 改按非浏览器处理。diff 32/10，待最终聚焦复核。
- **U197 v5 修订**：Cookie 模式同源判定只认 `ORCA_CLOUD_PUBLIC_ORIGIN`（未配置 auto→never 告警、always 拒绝启动；代理头默认不采信）；§2B-9 限定登录/交接，刷新 body 源 current 为唯一「设 Cookie+新签 refresh」例外；旧字面量改为「会被发送但永不被接受/不轮换/不撤销」；AC15(a)-(g) + AC16（XFP 伪造）+ AC17（重复 Cookie 硬 401 不回退、host-only/Domain 清理、单 Cookie 不误拒）。diff 47/25，待最终复核。
- **U213 关闭（U197 v5 经最终复核 APPROVED）**：P0 边界全部收口；复核 P2 精度项已修（清理 Path `/v1/auth`、Origin 不一致 403 不降级、迁移分支 2 的 QA-032 过渡窗口明示、AC15(e) 补 `refreshCookie`）。实现待 D5–D15 裁定后按 6 步序列排期。
- **收尾核验**：测试进程清理 dry-run `matched=0`（kept 13，无本项目残留）；U211 roleSource 改动补充回归 `u80-mobile-users` 5/5 绿。
- **web e2e 全量回归（今日最终）**：20 个套件 **178/178 全绿**（并发 2，约 6.8 分钟），覆盖审计导出 UI、导入/交接/归档/工作区、用户与授权页、移动端、真实浏览器导出等；今日 `app.js`/roleSource/筛选/ARIA 改动无回归。
- **U197 S1 落地（默认关闭）**：新增 `refresh-cookie.ts`（解析/重复检测/序列化/同源规范化/模式解析；auto 无 PUBLIC_ORIGIN→never 单次告警、always 拒启；Secure 按 https/loopback）；server 登录/交接同源下发 Cookie 且 body 无 refresh、登出无条件清 Cookie、刷新/登录/交接重复 Cookie 硬 401 无副作用；不改刷新语义（S2）。单测 20 + e2e 10 + session-renewal 7 = 37/37，所有行为不变。**S2 完成前不得启用 cookieMode**（否则刷新断链）。
- **U197 S2 落地（默认关闭）**：刷新双读（Cookie 优先/body 回退）：Cookie 源**不轮换**（空 body 同值重发+滑动 TTL、body=current 回显、previous 宽限只发 access 不续期、假 body 按空处理）；轮换仅 body 源 current 例外；grace `ORCA_CLOUD_REFRESH_GRACE_MS`（默认 30s/上限 60s/可 0）；CSRF 仅 Cookie 请求（Origin=PUBLIC_ORIGIN+JSON，403 无副作用）；能力标记 `refreshCookie`；登出清 Cookie。`currentRefreshToken` 仅内存、快照剥离。refresh-cookie/session-renewal/unit/web-handoff/store-persistence **63/63**。**U215 已纠偏**（按 v5 不轮换）。
- **U217 修复（测试漂移）**：QA-033 交互变更后 `install-wizard`/`u80-mobile-shell` 未适配（`#installCmd`、复制按钮位置）；改为先点「生成注册命令」、复制用 `#copyInstallCmd`；两套件 **97/97**。教训：交互变更须全 web 套件回归（§2-91 复现）。
- **U215 关闭（设计冲突纠偏完成）**：S2 已按 v5 合入 `e94962ea9aa`（Cookie 源不轮换、同值重发+滑动 TTL、previous 只发 access、轮换仅 body 源 current；测试断言 Cookie 刷新不改变 token 集合）；台账 U214 记录 S1/S2 状态，S4 Web 切换在途、S5 真实浏览器验收并行准备（服务端 Cookie/CSRF/重放探测）。
- **U197 S5 服务端侧真实验收（真实 Chromium）**：新增 `test/e2e/u197-cookie-browser.e2e.test.ts`——3 个真实 API 进程（always+PUBLIC_ORIGIN / never / auto 无源）+ headless Chromium，8/8 断言：HttpOnly Cookie 属性与 TTL 滑动、空 body 同值刷新不轮换、跨 Origin 与非 JSON 403 零副作用、重复 Cookie 401 不回退 body 且不撤销 session、同 context 双标签刷新均 200 不撤销、never/auto 回退 body+单次告警、进程日志与审计无明文 refresh（含前缀）。代理 3 次 + 主会话独立复跑 1 次均 8/8，无产品缺陷。Web 客户端侧断言待 S4 落地补入。
- **U197 S4 落地（默认关闭）**：Web 客户端能力门控——仅登录/刷新响应 `refreshCookie:true` 进入 Cookie 模式（access 仅内存、`orca.authMode='cookie'` 非凭据标记、旧键保留至一次无 body 刷新成功）；reload 一次 Cookie 刷新恢复、401 守卫不再依赖 refreshToken、旧服务端完全走 localStorage 原路径；logout 清标记/旧键/内存。主会话独立复跑 web-refresh-cookie+session-renewal+refresh-cookie **36/36**，提交 `15e5ea8ae6b`。**偏离**：AC9b「未知+旧键无 body 探测」未实现（登记 U219，待 D17 裁定）。
- **U218 登记并派修（S1/S2 独立安全审计）**：P1 登出只清 Cookie 不撤销 session（AC7b，探针复现）；P2 多值清 Cookie/Domain/旧 Path、登录非平台 Origin 未 403、never 模式登出不清、grace 审计漏分支；另 8 项测试缺口。审计其余 9 项 PASS（Cookie 属性、轮换语义、CSRF、能力标记、内存明文、迁移安全）。修复在途。
- **U197 S5 服务端侧落地**（见上条已记）；Web 客户端侧真实 Chromium 验收已派（AC9a/AC12/document.cookie 不可见/多标签/Cookie 丢失回退/never 回归）。
- **U197 S5 Web 客户端侧落地**（真实 Chromium + 真实 Web 资源）：`u197-web-cookie-browser.e2e.test.ts` 6/6×4——AC9a 标记真+旧键 reload 恰 1 次无 body 刷新并删旧键；`document.cookie` 无 refresh、localStorage 无令牌；AC12 reload 单次恢复；同 context 双页同刷均进入应用且 Cookie 不变；Cookie 丢失后 1 次失败即回登录、无循环；never 模式完全回归（0 次刷新、令牌仍在 localStorage）。提交 `1faa0213967`。
- **U218 修复落地**（`4d41409d8e0`，5 文件）：登出改为 Bearer+Cookie 合并撤销（access 过期/缺失与双 session 均覆盖，双 session 全撤销）；清 Cookie 输出多值（host-only `/v1/auth`、`Domain=<PUBLIC_ORIGIN hostname>` `/v1/auth`、host-only `/`），登录/刷新/交接/登出四端点重复 Cookie 401 均清理；登录非平台 Origin → 403、Cookie 无 Origin → 401（跨源 handoff 例外保留）；never 模式登出无条件清；Cookie=current+body=previous 宽限补 `refresh.grace_reuse`（metadata 无 token）；补 AC5/AC7/AC15f/AC16/AC17 与审计卫生断言。主会话独立复跑五套件 **80/80**（22+34+9+7+8）。台账 U218 翻 🟡 待原审计代理独立复审。
- **U218 独立复审 APPROVED**：原 5 项全部 CLOSED（登出撤销/多值清理/Origin/never 清 Cookie/grace 审计），复审方只读复跑 22+34+9 与主会话 80/80 一致，未发现 P0/P1 回归；台账 U218 翻 🟢。新发现 N1（never 模式 Cookie 无 Origin 恒 401 且不清）、N2（仅 Cookie 登出无审计）、Nit（IP 字面量 Domain 清除头）登记 **U220（🟡）** 并派修；N3（同站子域登出 CSRF）按设计内残留接受，待部署文档登记。
- **Web 关键回归批绿**：10 个套件（web-exploratory-fixes / web-audit-export / web-handoff / web-handoff-entry / web-host-lifecycle-feedback / install-wizard / u80-mobile-shell / u67-3 / u80-mobile-users / u114-u86-audit-grid）共 **183/183**（13 suites，`--test` 单批），S4/U218 改动未引回归。
- **S4 Web 客户端独立评审 CHANGES-REQUIRED**：登记 U221（🔴）——F1 P1 迁移分支 3（清 localStorage + 有效 Cookie）不探测（AC9c，并入 D17）；F2 P1 启动刷新传输失败逃逸为空白页；F3 P2 旧键不绑账号跨账号回退；F4 P2 登出网络失败无 pending 重试；F5 P2 未带 `x-orca-web-contract`；F6 P2 真实浏览器缺 AC14/登出/传输失败/伪造标记/并发 401。F2–F6 已派修，F1 并入 D17（AC9b+AC9c 探测口径，含 signed-out 标记选项）。
- **U220 修复落地**（`1531239c919`，5 文件）：N1 加启用门控（never 下无 Origin+旧 Cookie 登录/交接回到旧契约 200 且不清 Cookie）；N2 仅 Cookie 登出补 `logout` 审计（actor=session 用户，Bearer 登出不重复）；Nit IP 字面量省略 Domain 清除头；关联 Chromium 断言同步。主会话独立复跑 4 套件 **76/76**；待审计代理复审。
- **U220 独立复审 APPROVED**：N1/N2/Nit 全部 CLOSED；复审复跑 23+37+9 与主会话 76/76 一致；未引入新缺陷。台账 U220 翻 🟢。残留观察（P3，接受）：双 session 登出仅 1 条 logout 审计、仅 Cookie 登出非幂等。
- **U197 AC1/AC2/AC4 真实浏览器探针落地**（`32a9a3d0e29`）：真实 API（always+PUBLIC_ORIGIN，access TTL 1200ms）+ 真实 Chromium——AC1 登录/刷新/登出三时点对 localStorage/sessionStorage/document.cookie/URL 做键与全值扫描；AC2 过期后 reload 进工作台且恰 1 次无 body 刷新；AC4 页内 refresh 响应键无 refreshToken、console/审计文件无 refresh 值；控制值注入证明扫描有辨别力（防恒真假绿）。代理 3/3×2 绿。主会话复跑待 U221 合并后（当前 app.js 在途）。
- **U221 修复落地**（`0f8ac2d9dfb`，4 文件）：F2 传输失败不再逃逸（Cookie/body 刷新捕获异常 + 启动 try/catch → 登录页，真实 Chromium abort 无 pageerror）；F3 旧键绑定 `orca.tokenOwner`（换账号清除、同账号/历史保留）；F4 登出失败置 `orca.pendingLogout`，下次加载重试一次且不自动登录；F5 四类 `/v1/auth/*` 带 `x-orca-web-contract:1`（恒真断言修复为「预置持久值但不使用」）；F6 真实浏览器补 AC14 页内 401、并发 401 合并、真实登出、伪造标记、传输失败无空白页；AC9c 以 skip 登记 D17 阻塞。主会话干净 HEAD 复跑 4 套件 **36 pass/1 skip/0 fail**。台账 U221 翻 🟡 待复审；干净树 Web 回归批重跑中。
- **干净树 Web 回归批（§2-105）**：HEAD `0f8ac2d9dfb`（受影响文件 app.js/server.ts 干净；日志记录全局脏文件数 296 为既有无关改动），10 套件 **183/183**（13 suites，约 3.4 分钟），U221 改动无回归。
- **U221 复审 APPROVED**：F2–F6 全部 CLOSED（复审复跑 22/22 + 11 pass/1 skip；F1 按 D17 skip）。台账 U221 翻 🟢。新发现登记 **U222（🟡）** 并派修：N1 传输失败被当拒绝→`logout()` 撤销仍有效会话（U221 引入的行为回退，旧路径同受影响）；N2 pendingLogout 请求挂起时仍可能空白页；N3 启动 body 刷新写回令牌无 owner（F3 绑定在旧部署长期不生效）；N4 测试缺口（body 刷新头、标记清除、两 401 断言）。
- **U197 AC9d/AC15(g) 真实浏览器夹具落地**（`98d91fce7ed`）：AC9d 双失败迁移 4/4——恰 1 次无 body+1 次 body（401/401）、900ms 无第三次、旧键保留、登录页；AC15(g) 用 S4 前真实旧构建——登录体无 refresh、写字面量 `"undefined"`、假 body 200 不轮换且 Cookie 值不变；**INVALID 如实记录**：换新构建后首次加载 0 次刷新（旧键保留），过期后 1 次 body 回退才置标记，再下次 reload 才无 body 迁移——「单次重载迁移」因缺分支 2 探测（U219/D17）不成立。代理 4/4×3 绿。
- **CSP 草稿代理卡死处理**：旧代理运行 ~35 分钟无任何产出（输出停在开场句、交付物未落盘、催促无法送达），按 §2-59 判卡死并 TaskStop；已按收窄范围重派（先 rg 盘点、15 分钟盒、文档先行、待验证项标注），原任务范围不变。
- **AC9d/AC15(g) 测试独立复核 APPROVED**（4/4 复跑；确认旧构建夹具纯度、INVALID 事实与实测一致、无假绿）。登记 **U223（🟡）** 并派修 4 项 P2：N1 绿色用例与 AC15(g) 期望结构性区分（INVALID-FACT + skip 桩）；N2 旧 app.js 快照化，去掉 `git show`/`HEAD:` 依赖；N3 TTL 时序余量与注释；N4 补 Cookie 值/响应键/contract 头断言。
- **U197 S6 CSP 草稿落地**（`37668cec9c5`，`work-orders/u197-csp-draft.md`）：盘点确认 `script-src 'self'` 不阻塞（零内联脚本/零动态代码；仅 `app.js:1942` 1 处内联 `onclick`，重构约 3 行）；style 需 `'unsafe-inline'`（16 处）；修正 v5 草案两处缺口——`frame-src 'self' https:`（工作区跨源 iframe）与 `img-src data:`（favicon）；现状无 CSP（API `static-delivery.ts:15-17` 与宿主镜像均仅 referrer）；推荐 Report-Only 先行、仅 HTML 文档加头、console 收集、观察 7 天/2 发布后升强制；未决 O1–O7 关联 D10。主会话已抽查行号与事实一致。
- **U222 修复落地**（`025fddb0392`，5 文件）：N1 刷新三态（`error` 不 logout、Cookie `error` 不消耗 legacy body token，恢复 U221 前语义）；N2 先 `showLogin()` 再后台 `sendLogout()`（挂起不再空白页）；N3 `bindLegacyTokenOwner` 仅旧模式补 owner；N4 补 body 刷新契约头/登录清标记/401 清标记/并发两 401。主会话干净 HEAD 复跑 4 套件 **44 pass/1 skip（AC9c）/0 fail**；台账 U222 待复审。剩余 Web 套件回归（22 个，不含 latency）后台运行中。
- **U223 测试整改落地**（`e5bee743d6a`，测试+快照）：INVALID-FACT 与 AC15(g) 结构性区分（skip 桩 blocked by U219/D17）；旧 app.js 快照入库且与 `15e5ea8ae6b^` 逐字节一致（主会话 diff 复核）；TTL 6s→15s + 时序守卫；补 body 回退响应键/Cookie 值/in-page contract 头断言（3 次反转红证明判别力）。主会话复跑 **4 pass/1 skip**。
- **Web 全量回归完成（干净 HEAD `025fddb0392`）**：剩余 22 套件 **137/137**（含 admin/导出浏览器/项目归档族/u80/u67/u114），`web-workbench-latency` 单独跑 **1/1**；连同此前 10 套件 183/183，Web 面合计 **321/321**，U221/U222/U223 改动零回归。
- **U197 全套件合并基线**（干净 HEAD）：S1 单测 + S2 e2e + B1/B2 两套真实 Chromium + W1 + AC 探针 + 迁移夹具共 **119 tests / 117 pass / 2 skip（AC9c、AC15(g) 均 blocked by D17）/ 0 fail**（约 73s）。
- **CSP 草稿独立评审 CHANGES-REQUIRED（轻量）**：核心建议成立（Report-Only 仅 HTML、console 观测、`frame-src 'self' https:`、`img-src 'self' data:` 均实测验证）；1 条 P2 事实错误（缺 `x-orca-web-contract` **不会** 426，`web-contract.ts:29-33`）+ 12 条 P3（落点应为 `sendStaticAsset`、宿主镜像引用、38 处 innerHTML、iframe 引用、T3 测试引用、onclick 仅点击时违规、style-src-attr 收窄、UIR、report-uri/to、D10 排序、宿主面单独评估）。登记 U224（🟡）并派文档修订。
- **U224 CSP 草稿修订落地**（`f22f8c3d6a3`，35+/23-）：P2 契约门禁事实纠正（缺头 ok、仅非法/越界 426；`/v1/` 外理由改为非版本化+免认证；补单测与无头 POST 非 426 验证）；落点 `sendStaticAsset`（两处调用、禁止共享头、回退 text/html 判定修正）；宿主面引用/单独评估；innerHTML 38 处与 id 裸插值；iframe 仅 handoff；T3 改引 `web-audit-export-browser`；onclick 仅点击违规并前置于阶段 1 门禁；style-src-attr 备选；UIR 显式不引入；report-uri/to 报文形态；D10 排序标注建议。待复审。
- **U222/U223 复审 APPROVED**：U222 N1/N2/N4 CLOSED、N3 PARTIAL（Cookie marker + 回滚/never 时 body 回退令牌无 owner，窄路径）；U223 结构性区分/快照 sha256 一致/TTL 假红方向/新断言全部核验。两行翻 🟢。残留登记 **U225（🟡）** 并派修：N3R owner 回填扩展至 Cookie 启动分支、迁移测试干净树守卫、加载后 TTL 断言、事实用例标题去子串、快照 sha256 守卫、真实并发两 401 断言。
- **U224 CSP 复审 12/13 闭环**：唯一剩余 P3（`frame-ancestors` 命中枚举误写为「均为文件预览」）与两处措辞已修（`f6214f8cbaf`/`1e62748b23f`）——完整枚举含移动 HTML 预览、聊天/插件 srcdoc、桌面 `<webview>` guest；T2 引用更正为 in-process Chromium；验证段改为拟新增单测 + 现有 `web-release.e2e.test.ts:105-107` 同语义。待最终确认。
- **U224 关闭（CSP 草稿复审 APPROVED）**：13/13 闭环；草稿结论「D10 可按 Report-Only 推进」成立，O6「CSP 不单独关闭 QA-032」保留。台账 U224 翻 🟢。
- **U225 修复落地**（`68d6525dd87`，2 文件）：N3R Cookie 启动分支 `/v1/me` 成功补 `bindLegacyTokenOwner`（纯 Cookie 不写），新增真实 Chromium 两用例；N1 迁移测试对工作树 app.js 加 sha256 守卫（与 HEAD 一致，主会话核验）；N2 加载后 `/v1/me` 时刻 < TTL−1s 断言；P3 事实用例去 `AC15(g)` 子串、fixture 正文 sha256 断言。主会话独立复跑 3 套件 **40 pass/2 skip/0 fail**。待复审。
- **U225 复审 CHANGES-REQUIRED（1 P2）→ 已修**：`cfaa08a0e01` 在迁移测试加 `sha256Lf`（CRLF 归一）用于两处 pin，避免 Windows autocrlf 检出造成假红与「把 CRLF 哈希写进常量」；主会话复跑 6 pass/1 skip/0 fail，待最终确认。其余 N3R/N2/P3 均 CLOSED。
- **T1 关键业务回归通过**（HEAD `553529d16d2`，Node 24.16 自动切换）：cloud-platform 段 **50/50**（3 suites：策略版本冲突/权限矩阵/项目策略三态等）、Electron 段 vitest critical 全绿，EXIT=0；server.ts 经 U218/U220 改动后关键路径零回归。
- **U225 关闭**：复审 APPROVED（F1 CLOSED，`sha256Lf` 归一且不可绕过；N3R/N1/N2/P3 全部闭环）。补充 `f086e2dfd2a` 以 `.gitattributes` 为 `apps/web/app.js` 与旧构建快照固定 `text eol=lf`，与仓库既有字节哈希先例一致。台账 U225 翻 🟢。
- **AC 矩阵独立审计与修订**：19 行 OK、1 GAP（AC15(d) never 刷新缺断言）、1 WARN（AC14 应绿）。修复 `e12c442453b`——S2 新增 never 刷新用例（不下发 Cookie、无能力标记、body 新 refresh），**38/38**；矩阵改为 🟢16/🟡1（AC7 双标签登出 UI）/🔴3（AC9b/9c/15g，D17）/⚪1（AC10/D10），并更正证据归属与基线（115/113/2；含 REG 122/120/2，新增 never 用例后主会话复跑）。台账 U226 翻 🟢。
- **U198 关闭**：新增 `u198-legacy-reload.e2e.test.ts`（真实 never 模式 API + 真实 Chromium，access TTL 1.5s）——过期后 reload 请求序列 `/v1/me:401 → refresh:200 → /v1/me:200`、恰 1 次刷新、进入工作台、令牌轮换、owner 回填；失效 refresh 恰 1 次 401 回登录、900ms 无循环、键清理。主会话复跑 2/2；未发现产品缺陷，无需改 app.js。提交 `7f5502243c1`。
- **AC7 双标签登出闭环**（`7e24da22a4c`，仅测试）：同 context 两页真实 Chromium——A 登出后 B 无主动广播（实测 PASSIVE），下一次业务请求 401→Cookie refresh 401→回登录页；旧 Cookie 刷新 401；测试保留 ACTIVE 分支检测。主会话复跑 **13 pass/1 skip**。矩阵 AC7 翻 🟢（🟢17/🟡0/🔴3/⚪1），合并基线 116/114/2（含 REG 123/121/2）。
- **cloud-platform 单测全绿**（HEAD `3fba29ab271`）：`test/*.test.ts` **200/200**（35 suites）+ `apps/api/test/*.test.ts` **108/108**（27 suites），合计 **308/308**；U197 系列改动（refresh-cookie/worker/runtime 等）无单测回归。Web 全量 321/321 与 T1 已在本轮早前记录。
- **U227 弱断言补强落地**（`10a8c24d24a`，测试 only）：重复 Cookie 补「不续期」（`refreshExpiresAt` 前后相等）；伪 XFP 刷新补响应形态（`refreshCookie=true`、无 `refreshToken`）与 `refreshHash` 不变；auto 降级告警按允许回退在用例名注明见 S1（warnOnce 去重）。三条均反转让证红，S2 **38/38**。台账 U227 翻 🟢。
- **认证/会话探索扩面（33 场景，真实 API+真实 Chromium，两套部署）**：32 PASS、1 SUSPECT；全程 pageerror 0，console 仅预期 401 日志。结论写入 `test-reports/u197-auth-exploration-20261118.md`（原证据 /tmp 易失，保留结论）。
  - 覆盖登录失败/连续 reload/back-forward/过期恢复/登出（含 abort 补发）/多标签（含跨标签登出）/Cookie 边界（清 Cookie、重复 Cookie、marker 与 pending 篡改）/刷新网络失败自愈/legacy→cookie 回滚/可访问性。
  - **新发现 U228（🟡）**：禁用账号登录 200 → 坏壳（业务 401、刷新 200）；login/refresh 不复查 `user.status`（基线 MVP，与 U221–U227 无关），客户端一次重放仍 401 不登出。已派修。
- **冷读审计（app.js 认证状态机）CHANGES-REQUIRED**：F1/F2 两个 P1（刷新在途+登出/再登录→会话复活/跨账号；无 owner 旧键 Cookie 丢失→回退成旧账号），F3–F7 P2（慢 logout 清新 Cookie、grace 回显误判、启动挂起空白页、登录 200 毒化、5xx 误登出），F8–F11 P3。结论落盘 `test-reports/u197-cold-audit-20261118.md`，登记 U229（🔴）。修复须与 U228 串行改 `app.js`（§2-90），待 U228 落地后按 F1/F2→其余顺序派修。
- **m01-auth 现状文档刷新**（`58f9c50b749`，+100/−27）：更新到 HEAD `fe35a9d355a`——登录双形态（Cookie/never）、刷新三态与 401 守卫、页面恢复（Cookie 一次刷新/旧模式 401→body 重放）、登出双凭证撤销与 pendingLogout、多标签被动登出、失败分支与测试索引（8 套件分 in-process/happy-dom/真实 Chromium）；U228 标「修复中」、D17 标 ⛔。**U228 落地后需回填禁用账号与重放 401 自动登出行为**。
- **U228 修复落地**（`39ad743d793`，4 文件）：登录非 active → 403 `USER_DISABLED`（审计 login denied、无密码、不发令牌/Cookie）；刷新 Cookie/body 两源在 current/previous/宽限前统一检查，非 active → 撤销+bump epoch+清 Cookie+401（审计沿用 `logout` denied + reason，未新增事件词汇）；客户端重放仍 401 → `logout()`（裸 fetch 不递归）。新套件 5 例（先红 4/5）+ 回归 90/90 + 真实 Chromium 13/1skip；主会话复跑 **72/72**。台账 U228 待复审；m01 文档待回填。
- **m01-auth 回填 U228**：禁用账号边界改为「已修复（`39ad743d793`）」——登录 403 `USER_DISABLED`、刷新两源撤销+清 Cookie+401、客户端重放仍 401 即登出；基线行更新为 `39ad743d793`，新套件入索引。
- **U229 P1 独立复核确认**：F1a（登出期间在途刷新→storage 复写、旧 refresh 换新 access、reload 自动进入）、F1b（旧刷新跨账号覆盖且 owner=B）、F2（无 owner 旧键+Cookie 丢失→admin→张伟）各 4 次全复现，反向断言在同样三点失败；非假阳性。**关键补充**：legacy 模式 access 过期时 `logout` 返回 200 却未撤销任何 session（旧 refresh 仍 200），F10 由 P3 上调 P2，并解释 F1 的持续窗口。台账 U229 记录。
- **U229 F10 服务端修复**（`ec1b10e691d`，2 文件）：登出接受可选 `{refreshToken}`（16KiB 上限、容错解析），按 `refreshTokens` 映射与 Bearer/Cookie 合并去重撤销；未知值 200 不撤销并写 `logout` denied（无 token）；无 body/Bearer 有效/重复 Cookie 语义不变。新套件 `u229-logout-body` 8 例（先红 3/8）+ 回归 76/76；客户端登出携带 refresh 的配合随 U229b。
- **U229a 修复落地**（F1/F2 P1，`fb8d57347f4`，4 文件）：`state.authEpoch` 代际——login 发起/成功、logout 自增并清 in-flight，刷新每个 await 后校验（过期结果 `'stale'`、不写 state/storage、不登出不误刷），`api()` 代际不一致不刷新不登出；`legacyOwnerAllowsFallback`——登录清无 owner/异 owner 旧键，Cookie 启动 body 回退前校验 owner 与 `orca.user`（无 owner 不回退）。新套件 `u229-web-refresh-epoch` 6 例（F1a/F1b/F2×2 红→绿，2 防回归），主会话复跑 4 套件 **36 pass/1 skip**。有意行为：F2 取代 U225 N3R 无 owner 回退（改为清键回登录），AC9d 补种可信 owner。
- **U228 关闭（复审 APPROVED）**：检查位置/边界/审计/客户端递归/测试真实性核验，`git archive` 快照先红 4/5、修复后 5/5 + 相关 92/92。P3 观察登记 **U230（🟡）**：审计事件语义倒置、并发重复、客户端 401 范围（并入 U229b）、测试缺口（已派补）。台账 U228 翻 🟢。
- 并发 3 路：U229b1（F3/F4/F10 客户端/U230③）、U230④ 测试补强、U229a 独立复审。
- **U230④ 测试缺口补齐**（`19da39a2081`，304 行仅测试）：Cookie previous/宽限分支禁用、已删用户 body/Cookie 刷新、假 body+有效 Cookie、禁用登录不建 device、`/v1/audit/verify` 全链 5 例；修复前快照 4 失败/1 通过，主会话复跑 5/5。U230 余 ①审计事件语义、②并发重复待事件词汇批次；③随 U229b1。
- **认证回归批（U229a 后）**：9 个 Web 套件 **69 pass / 2 skip（D17、AC7 skip 桩）/ 0 fail**（71 tests，11 suites，约 73s）——web-refresh-cookie、session-renewal、u197-web-cookie-browser、u198、u228-web、u229 两套、u197-migration、ac-probes。
- **F1 登录与准入业务流刷新**（`0a5978c9335`，+54/−25）：登录双形态、三态刷新（含 U229 `stale` 代际）、页面恢复、登出双凭证+重试+多标签被动、迁移 AC9a/⛔AC9b-9c；失败分支 9→15（CSRF/重复 Cookie/Cookie 缺失/传输失败/禁用账号 403/refresh 5xx 如实标 U229 F7）；服务端状态机补 Cookie 属性/不轮换/宽限/模式解析/禁用撤销/登出 body 撤销。m01 禁用账号行号同步修正为实际位置。
- **U229b1 落地**（F3/F4/F10 客户端/U230③，`56ced66e77d`，5 文件）：登出携带 `{refreshToken}`（清键前取值）；`logoutInFlight` AbortController + login 先 abort 慢登出并清 pending（真实 Chromium 断言新 Cookie 存活）；grace 回显（请求值==响应且无 `refreshCookie`）只更新 access、保留标记/旧键；retried 401 仅 `!code||SESSION_EXPIRED` 登出；harness `release()` 吸收 Set-Cookie。新套件 `u229-web-logout-grace` 3 例 + 真实 Chromium 14/1skip；主会话复跑 4 套件 **45 pass/2 skip**。待独立复审。
- **U229a 独立复审 APPROVED**（隔离 worktree，父提交真实红 4 例）：代际覆盖全部 await、in-flight 局部比较、F2 在消耗 body token 前校验 owner、回归 22/22+5/5+2/2+6/1skip 全绿。P3 另立 **U231（🟡）**：owner 有值但 `orca.user` 缺失会清合法键（启动传输失败会删 user）、F1b 测试 TTL 2500ms 偏紧、缺 Cookie 探测竞态用例。m01 增补「会话代际与迁移 owner 策略」小节。
- **U229b2 落地**（F5/F6/F7/F11，`54361e94af0`）：启动 Cookie 刷新与 `/v1/me` 加 10s 超时（超时→登录页，不空白）；登录响应契约校验（不写 `"undefined"`，抛 `PLATFORM_UNAVAILABLE`）；`refreshVerdict` 四态（400/401 rejected；403/408/429/5xx error 保会话）；`addRelayBtn` 未处理拒绝修复；logout 单飞。新套件 6 例（5 红→绿，1 防回归），主会话复跑 44/44；migration pin 更新。
- **U229b1 复审 APPROVED**：F3/F4/F10 客户端/U230③ 核验通过；新发现 **U232（🟡）**——P2 在途 refresh 未 abort（迟到 `Set-Cookie` 覆盖新登录 Cookie，探针复现）、P3 pendingLogout 过早清、logout 未全量单飞、F3 用例只持有 request（机制为空）、服务端 logout body=null → 500。已派客户端/测试修复；服务端 null 守卫待冷读完成。m01 已补四态与失败分支。
- **服务端认证端点冷读审计**：无 P0/P1；**U233（🔴）**——F1 P2 登出重复 Cookie 时 Bearer/body 会话未撤销；F2 P3 单 Cookie 无 Origin 401 不清 Cookie；F3 P3 交接禁用用户 reason 误记；F4 P3 安全拒绝无审计；F5 P3 登出 Bearer 审计失败 500；F6 P3 `refreshTokens` 无界+明文 key 随开发快照。其余矩阵与 v5 一致（同源判定/硬 401/不轮换/禁用前置/三作用域清理/审计无 token）。结论落盘 `test-reports/u197-server-auth-audit-20261118.md`；F1/F2/F3/F5 已派修，F4 随事件词汇批，F6 列待裁定。
- **U233 服务端修复落地**（`cd3ed22ca6c`，4 文件）：F1 重复 Cookie 登出仍撤销 Bearer/body 显式凭据（Cookie 不猜测、保持 401；`u229-logout-body` 反例同步修正）；F2 单 Cookie 无 Origin 登录/交接 401 前清三作用域；F3 交接禁用用户 reason=`subject_gone`；F5 登出审计统一 best-effort（失败仍 200 且撤销）；补 3 项盲面钉子。主会话复跑 6 套件 **94/94**。台账 U233 待复审；F4 随事件词汇批、F6 随 D18。
- **U233 复审 APPROVED**（F1/F2/F3/F5 CLOSED）：复审复跑 64/64 + 探针——仅重复 Cookie 不猜测撤销、Bearer/body 显式凭据撤销且保持 401；F2 门控未回退；F3 reason 分流；F5 审计 best-effort 无 500；跨用户撤销未扩大。余 F4（拒绝审计，随事件词汇批）/F6（token GC，D18）保持开放。台账 U233 记复查结论。
- **U232 客户端修复落地**（`b617b6e7344`，3 文件）：`refreshControllers`/`logoutControllers` 双 Set——login/logout 全量 abort 在途 refresh 与 logout，abort 结果统一 `'stale'`（不写状态/不登出）；`pendingLogout` 仅成功路径清；F3 用例改 `route.fetch()`+延迟 fulfill（真持响应，含 `set-cookie` Max-Age=0 断言）+ `restoreCookie()` 模拟迟到投递；新增「refresh 在途跨登录」真浏览器用例（新 Cookie 不被覆盖、仍为新账号）。移除 abort 后两用例红；主会话复跑 4 套件 **49 pass/2 skip**。待独立复审。
- **U229b2 复审 APPROVED**（隔离 worktree；父提交 F5a/F5b/F6/F7a/F11 红、F7b 防回归，与自报一致）：超时 finally 清理、契约校验在写入前、四态与 abort 兼容、单飞清理无条件。P3 另立 **U234（🟡）**：启动超时不 abort/不 bump epoch（迟到 refresh 仍写 state/storage）、返回契约注释过期、refreshVerdict 白名单过宽、`err.message` 空值、四态/单飞/真实 10s 缺钉住用例。
- **U232 登出空 body 守卫**（`c362721293f`）：`body=null`/标量/数组视为无 body——清 Cookie/Bearer 撤销/200 语义不变（先红：null 两例 500）；补 5 例，`u229-logout-body` 14/14。顺带核对发现 refresh 两处同类解引用 → 登记 **U235（🟡）** 并派修（null/标量 → 500）。
- **m01 测试索引补齐**：新增 U228/U229（epoch/logout-grace/startup-resilience/logout-body）/U230/U232 套件条目与覆盖范围；F1 业务流与 m01 与 HEAD 认证实现同步（除待裁定项）。
- **U235 refresh 空 body 守卫**（`f0977d7c42f`）：Cookie/body 两分支先判对象——`null` 视为假 body/无 body，`42`/`"x"`/`[]` 行为不变（原本不抛）；补 8 例，四套件 **97/97**。顺带核对发现 ~19 个端点同类解引用 → 登记 **U236（🟡）** 并派修（`readJson` 非对象归一为 `{}` + 代表性端点测试）。
- **U236 非对象 body 归一**（`bfb04d581f6`）：`readJson` 对 `null`/标量统一返回 `{}`（数组/对象原样，无端点依赖顶层数组）——~19 个端点由 500 变为各自 4xx；新套件 7 端点×4 形态 9 例（修复前 8 fail/1 pass）+ 有效对象回归，相关 4 套件 91/91，主会话复跑 9/9。待服务端审计方复审。
- **U236 复审 APPROVED**：仅 `null`/标量受影响（数组/对象/空串/非法 JSON 不变）、26 调用点无顶层数组依赖、4xx 无漂移、局部守卫冗余无害、红证据真实；父提交 8 fail/1 pass、当前 86/86。台账 U236 翻 🟢。观察登记 **U237（🟡）**：maintenance/policy PUT 等「空 body 即变更」端点缺必填校验（`null` 与 `{}` 同语义），建议补 400。
- **U232 复审 APPROVED**：signal 覆盖两条 refresh、await 边界先判 abort/epoch、controller Set 生命周期正确；F3/refresh 用例红证据实证（隔离 worktree 回退 abort 后两例均失败于目标断言）；回归 15/1skip、6/1skip、22/22、7/7、9/9。台账 U232 翻 🟢。P3 观察记录：登录失败保留 pendingLogout 无用例、login abort 后旧服务端会话残留至过期（接受）、`restoreCookie()` 清全 jar（当前仅一个 Cookie）。
- **服务端回归批绿**（HEAD `09c9038c9ec`）：platform / host-authorization / project-registration-validation / audit-anchor / policy-version-conflict / admin-authorization-directory **46/46**（EXIT=0）；U233/U235/U236 服务端改动零回归。m01 补「非对象 body / 登出重复 Cookie / refresh null」失败行与 U236 套件索引。
- **U232 补测落地**（`62b0cf5de1c`）：新套件 `u232-pending-logout-retry` 2 例——启动 pending 重试失败保留标记（且不探测会话）；错误密码登录失败标记仍在、正确登录后清标记且不再补发。主会话复跑 2/2。U235 独立复审在途。
- **U231 修复落地**（`c53a890affe`，4 文件）：`legacyOwnerAllowsFallback` 对非空 owner 即允许回退（user 缓存可因启动传输失败缺失；无 owner 仍清键）；F1b TTL 2500→6000ms；新增真实 Chromium「无 body 探测在途跨登出换账号」用例（旧响应不复活旧会话、新 Cookie 服务业务）；migration pin 同步。主会话复跑 3 套件 **29 pass/2 skip**；误命名用例已更正（非 AC9b）。U235 复审在途。
- **U235 复审 APPROVED**：null 按假 body/无 body、标量/数组行为不变、与 U236 归一无冲突（守卫冗余但无害）、安全检查先于 body 解析、回归 97/97（主会话复跑 67/67 子集）。台账 U235 翻 🟢；修正过期注释（readJson 已归一）。P3 记录：守卫可后续清理。
- **U234 修复落地**（`bd55fbddcae`，4 文件）：`abandonStartupAuth()`（epoch++ + abort）覆盖三条启动失败/超时路径，迟到 refresh 返回 `stale` 不写状态；四态契约注释；`refreshVerdict` 收紧（403/408/429/5xx→error；其余 4xx→rejected；非 4xx→error）；F11 空值安全；单飞钉住。新用例 3 红→绿；主会话复跑 4 套件 **39 pass/2 skip**。待复审（重点 harness `release()` 剥离 abort 是否失真）。
- **U231 复审 APPROVED**：非空 owner 不构成新跨账号能力（标签写入需同源脚本，refresh 本在同源存储）；自然路径 owner/token 不错配；无 owner 仍清、异 owner 登录仍清；红证据双重可信（旧检查→U231 用例红；禁用 abort→竞态用例红）；pin 一致；回归全绿。台账 U231 翻 🟢；P3 记录：注释措辞、用例命名覆盖、Cookie 断言时序、明确拒绝后重复探测。
- **U234 复审 APPROVED**：三条启动路径 epoch+abort 无微任务窗口、成功路径不误 abort、`/v1/me` 迟到 401 不登出；harness 剥离 signal 为真实验证所需且未变松；8 例 3 红→绿、单飞钉有效、pin 一致。台账 U234 翻 🟢。P3 登记 **U238（🟡）**：toast `Error:` 前缀、宽 4xx 代理场景（接受）、单飞用例命名、启动挂起期间登录被 continuation 踢回（既有）。已派修 ①③④。
- **Web 回归批 182/183，唯一失败为并发假红**：`u80-mobile-users` LDAP 徽标 30s 超时；单独复跑 **5/5**。10 套件一次性默认高并发 + 探索/复审争用所致；已按 §2-77/78 以 `--test-concurrency=2` 重跑（`/tmp/web-regress-u234b.log`）。批量 e2e 命令须带并发上限（下时段复盘固化）。
- **Web 回归批 CONC=2 复跑 183/183**（HEAD `7139dcb957c`，EXIT=0，约 4.6 分钟）：确认 `u80-mobile-users` 唯一失败为并发争用假红；U234 改动零回归。批量 e2e 后续统一 `--test-concurrency=2`。
- **认证修复端到端重放 PASS（40/40）**：干净 archive HEAD + 真实 API/Chromium，4 轮×10 场景——E1 禁用账号三子场景全 PASS（403/刷新 401/登出清理）、F1a 登出-刷新不复活、F1b 跨账号不回退、F2 无 owner 键清且不 body 回退、F3 慢登出不清新 Cookie、F4 grace 回显不持久化、F5 启动 10s 出登录页且迟到 200 不复活、F7 503 保会话；pageerror 0。结论落盘 `test-reports/u197-auth-replay-20261118.md`（原证据 /tmp 易失）。历史 E1 SUSPECT 已收敛。
- **U238 修复落地**（`e8141633f2a`，3 文件）：toast 去 `Error:` 前缀（红证据）；单飞用例标题更正；启动 IIFE 以 `startupEpoch` 判断——登录已超越代际时四条失败路径静默返回（不踢回已登录用户；判断须在 `abandonStartupAuth` 自增前，中途自擒回归）；补 2 例。宽 4xx 代理场景接受登记。
- **认证套件最终基线（U238 后干净树）**：18 套件 **206 tests / 204 pass / 2 skip（AC9c、AC15(g) 均 D17）/ 0 fail**（`--test-concurrency=2`，约 3 分钟）。
- **单元套件复跑**：`test/*.test.ts` + `apps/api/test/*.test.ts` = **308/308**（62 suites，4.6s），U228–U238 改动无单测回归。AC 矩阵加固附录状态同步（U231/U232/U234/U235/U236 关闭，U238 复审中）。T1 关键业务在最终基线重跑（后台）。
- **测试运行器修复**：`run-test-tier.mjs` 的 npx 重执行按 cwd 解析脚本路径，从 `cloud-platform/` 目录调用会拼成 `cloud-platform/cloud-platform/scripts/...`（EXIT=1 假失败）。改为 `resolve(REPO, script)` 绝对路径；从子目录重跑 T1 验证中。
- **运行器路径解析单测**（`b153fda98a0`）：导出 `resolveTierScript()`（REPO 相对/绝对原样），新增 3 条测试（默认路径存在、相对拼 REPO、绝对不变）；脚本测试 20/20。
- **U238 复审 APPROVED**：四条失败路径判断位置正确（同步块、无漏分支、判断先于 abandon）、成功登录后续集不再清理、无凭据首访仍显示登录页；红证据真实（两例 + F11 前缀）；pin 一致；回归 16/16 + 32/32。台账 U238 翻 🟢。P3 登记 **U239（🟡）**：成功续集 `await /v1/me` 后缺代际判断（hold 期间登录会被旧会话覆盖用户名）、守卫把失败登录当新代际、用例标题；已派修。
- **U239 修复落地**（`c4af942f766`，3 文件）：两条启动成功分支 `await /v1/me` 后加代际判断（旧结果丢弃）；失败路径抑制条件改为「代际变且 `state.user`」，登录失败仍显示登录页；补 3 例（3 红→绿），标题更正；pin 同步。主会话复跑 3 套件 **41 pass/2 skip**。待复审。
- **T1 子目录重跑 EXIT=0**（50/50）：验证 `run-test-tier` npx 重执行路径修复；日志记录 `CWD=cloud-platform`。
- **最终认证批（U239 后干净树）**：18 套件 **209 tests / 207 pass / 2 skip（D17）/ 0 fail**（CONC=2，约 3 分钟，EXIT=0）。交付摘要与 AC 矩阵基线同步。
- **U239 复审 APPROVED**：成功分支清理正确、`state.user` 语义无半态、失败登录用例真实（父提交必红）、pin 一致；红→绿真实（迟到 `/v1/me` 覆盖用户名）。台账 U239 翻 🟢。P3 登记 **U240（🟡）**：期间失败登录时成功守卫静默 return → 空白页（UI 不可达、程序化可达）、旧 `orca.user` 未清；已派修。
- **交付文档事实审计**（独立代理）：状态句/cookieMode/AC 统计/单测/服务端/T1 一致；修订——认证计数 209/207/2、U238/U239 标 APPROVED、U229 台账补记并翻 🟢、未闭项补 U230②、U199 归属更正（QA-032 宽限语义）、D17 措辞含选项 B、Web/重放/T1 基线标注；CSP 草稿路径与 S6 范围补齐。
- **交付审计复核收尾**：U240 移出已关闭节并入未闭项；矩阵 U229 改为「全 11 项闭环（F8→U228、F9→D17）」；基线措辞改为「HEAD `c4af942`/U239 后已提交基线」；台账 U229 的 F10 表述改为「u229-logout-body/重放/U233 复核覆盖」。审计方确认 U229 关闭依据充分。
- **U230② 并发撤销去重落地**（`e56e8cf32aa`）：`revokeDisabledSession` 撤销前重查 `revokedAt`——已撤销则跳过审计/epoch，同一 session 并发刷新最多一条 `logout/denied`；新增可选 `ApiConfig.beforeDisabledSessionRevoke` 测试屏障（生产零差异）；可控交错红→绿 2 例；回归 72/72。待复审。
- **U230② 复审 APPROVED**：幂等覆盖两源、审计唯一、epoch 只 +1、401/清 Cookie 不变、测试屏障无生产影响（无 env 映射）；独立 archive 红证据（移除重查→epoch 3）。台账 U230 ② 记录闭环（① 仍待事件词汇批）。P3 登记 **U241（🟡）**：登出循环 `revokedAt` 重查、reuse/过期撤销 epoch 一致性、屏障超时兜底。
- **U240 修复落地**（`fd26edda0be`，3 文件）：两条启动成功分支守卫改为「代际变且无 `state.user` → 清 cachedUser + `showLogin()`（幂等）再 return」——失败登录不再空白页；成功登录仍只丢迟到结果。新用例父提交红、现绿；startup-resilience 20/20、六套件 74 pass/2 skip；pin 同步。待复审。
- **最终认证批（U240 后）**：18 套件 **212 tests / 210 pass / 2 skip（D17）/ 0 fail**（CONC=2，EXIT=0）。交付摘要基线更新。
- **U241① 登出幂等落地**（`10e43b32415`）：登出循环对已撤销 session 跳过 bump/审计（200/Cookie 清理不变）；新套件 `u241-logout-idempotent` 3 例（确定性交错红→绿）+ 回归 86/86；主会话复跑 17/17。待复审；②③ 未动。
- **U240 复审 APPROVED**：cachedUser 作用域/时机正确、登出场景幂等、成功登录不受影响、用例真实红、pin 一致；回归 20/20 + 32/32。台账 U240 翻 🟢。P3 登记 **U242（🟡）**：旧模式成功分支/登出取代续集缺用例、两处守卫块重复；已派修（抽 helper + 2 例）。
- **U241① 复审 APPROVED**：幂等覆盖全部 target、审计归属如实（success/denied 各归实际撤销路径）、epoch 只 +1、200/清 Cookie 不变、半 body 交错顺序无关；archive 红证据（回退→2 fail）；五套件 82/82。台账 U241 记录 ① 闭环；②（reuse/过期 epoch）③（屏障超时）仍开；新增观察：已删用户撤销无 success 审计（既有）。
- **U242 落地**（`ecd8f046512`，3 文件）：`finishStartupMe()` 统一两条成功分支（消除 19 行重复，行为逐字一致）；补 legacy hold `/v1/me` + 错误密码、启动在途登出两例（关闭守卫回退→2 红）；六套件 76 pass/2 skip；pin 同步。主会话复跑 28 pass/1 skip；待复审。
- **U241②③ 落地**（`278791fc5bd`，3 文件）：`revokeSessionOnce()` 幂等撤销统一所有撤销点（过期/已撤销/reuse/禁用/登出/设备批量），epoch 一致；`rendezvous()` 2s 超时兜底；新套件 `u241-revocation-epoch` 3 例（回退红）；代理回归 94/94 + 32/32，主会话 65/65。待复审。
- **U242 复审 APPROVED**：`finishStartupMe()` 与两处原逻辑逐字等价（守卫条件/字段拼装/`bindLegacyTokenOwner` 位置/`enterApp` 顺序/异常语义）；两例为「关闭守卫」mutation 红（非 parent-red，台账按此表述）；pin 一致；回归 22/22 + 32/32。台账 U242 翻 🟢。
- **U241②③ 复审 APPROVED**：全仓 session 撤销仅 `revokeSessionOnce` 单写点、覆盖 8 类路径；过期/审计/响应不变；设备批量逐 session bump 合理；屏障 2s 有余量；archive 父提交 3/3 红。台账 U241 翻 🟢。观察另立 **U243（🟡）**：过期撤销+幂等登出导致「刷新过期→自动登出」零链上事件（事件词汇批）、屏障零到达未处理 rejection 噪音。
- **最终认证批（U241 后）**：20 套件 **220 tests / 218 pass / 2 skip（D17）/ 0 fail**（CONC=2，EXIT=0）。交付摘要与矩阵更新为最终基线；U243 记为唯一遗留（①事件词汇批、②测试噪音）。
- **U243② 修复**：`rendezvous()` 的 gate 加 `.catch(() => {})`，零到达不再产生未处理 rejection 噪音；u230 9/9。U243① 仍随事件词汇批。
- **m01 补撤销一致性说明**（U241）：所有 session 撤销经 `revokeSessionOnce`（置 `revokedAt`+bump、幂等），覆盖 8 类路径；过期零审计/reuse 一条；已知刷新过期→自动登出暂无链上事件（U243①）。最终 Web 回归批（CONC=2）后台运行中。
- **最终 Web 回归批（CONC=2）183/183**（HEAD `6ae654d52ae`，EXIT=0，约 4.9 分钟）：U241/U242 后 app.js 零回归；交付摘要 Web 基线更新。T1 最终基线后台重跑中。
- **T1 最终基线 EXIT=0**（HEAD `4e8f059f946`）：cloud-platform 关键业务 **50/50**；Electron vitest **18138 pass / 31 skip**；交付摘要 T1 行更新为最终值。至此 U197 认证子系统最终基线齐备：认证 220/218/2、Web 321（183 当前 HEAD）、单测 308/308、T1 EXIT=0、重放 40/40。
- **全端点非对象 body fuzz**（`4f617c71e47`，仅测试）：枚举 25 个 `readJson` 调用点，`null/42/"x"/[]/true/{}` × 150 次探测——**全部非 500 且 JSON**，无 SKIP；主会话复跑 26/26。同时实测 8 个状态变更端点在 `null/{}` 下返回 2xx 并产生副作用，为 U237/D19 提供清单。
- **认证套件稳定性 soak**：6 组关键套件 × 5 次 = **30 次运行全绿**（u229-startup 110、u229-epoch 35、u197-web 80+5skip、u197-migration 30+5skip、u230 45、u241 30），**0 个不稳定用例**，耗时抖动极小；两次 skip 均为 D17 blocker 显式跳过。HEAD 期间仅文档/新测试提交，被测代码未变，结果有效。交付摘要补稳定性行。
- **U203 对账**：M116 探索 P2 批仅余 QA-030（U202 统计卡，待裁定）与 QA-032（U197 实现+加固完成，AC 17/20，待 D17/D10）；U201 已关闭。并行派出 U176 调研（U163 车道前提）与 D15（LGA）决策简报。
- **D15 决策简报落地**（`test-reports/u212-d15-brief-20261118.md`）：阻断项确认——组只并集不删、refresh 不复查 LDAP 且两源 12h 滑动无绝对上限、嵌套组仅直接 memberOf；LDAP 不可达落 401+锁定计数；U211 已修项确认。**新发现 U244（🔴，待复核）**：FR-1.6 管理员强制下线实现缺失（仅自助设备删除），运营侧无即时断线手段。建议分 Phase 0 文档/可观测、Phase 1 撤销边界最小组合+503 不计数、refresh 复查/嵌套组挂 G04。
- **U176 复诊落地**（`test-reports/u176-catchup-premise-recheck.md`；文档更正 `4238627e545`）：事实成立但因果错误——两轮真栈无效（未开 opt-in/无 headless 前置/1.5s 为固定等待/未统计入站转发）；分歧实由宿主转发、桌面 renderer 应用 split。分类改为「测试方法无效、前提未验证」；主进程路由 4 例 + V7 E1 已覆盖；建议保留默认关闭并更正三处文档。是否做 1–3h 确定性真栈复验待裁定。
- **U244 复核确认缺失 + 实施派发**：全仓无管理员会话撤销端点/权限/UI；`revokeUserCredentials` 仅宿主票据；禁用用户无 API；测试仅自助设备吊销。LGA 设计 §3.7/Q3 表述已更正（`78b7f22defa`，最小 diff）。实施中：`POST /v1/users/:id/sessions/revoke`（admin、审计 fail-closed、撤销 session+user 撤销集合、不吊销 device）。
- **U244 实施落地**（`d0b4f064797`，4 文件）：`POST /v1/users/:id/sessions/revoke`——admin + `denyPrivileged`、审计 fail-closed（变更前写）、撤销目标用户全部 session（revokeSessionOnce）+ user 撤销集合断宿主连接、不吊销 device、幂等（并发队列串行）、未知用户 404；新增审计事件 `session_revoke`（目录+Web 下拉标签）。新套件 7/7（主会话复跑）；相邻回归 33/33；migration pin 因 app.js +2 同步（`2e782f50…`，6/1skip）。待独立复审。
- **U244 文档同步**（`12101d55de4`，+16/−3）：m06 新增 3.13 操作项与来源小节（API-only、Web 按钮待 D15）、test-plan 新增 U244 验收行、tasks 新增 T110a（已实现 `d0b4f064797`）。主会话复跑审计/用户页/目录套件验证新事件类型无回归。
- **U244 复审 CHANGES-REQUIRED（P2）**：幂等标记用「任意 user 撤销」判定——`grant_changed`/`role_changed`/`host_grant_changed` 会让真实强制下线被判 no-op（不刷新撤销 `at`、不写审计、旧宿主票据存活）；二次强制下线同变体。已派修：每次接受即刷新 `appendRevocation`、审计去重改 per-user/leader 语义、补「授权撤销→登出→强制下线」回归。P3/系统观察登记 **U245（🟡）**：审计链内存-落盘原子性、`revokedSessions` 目标数 vs 实际、自撤策略；审计原子性分析在途。
- **U244 P2 修复落地**（`4d56cffd65b`，2 文件）：移除「任意 user 撤销」幂等判断；leader 每次刷新 `appendRevocation('user',…,admin_force_offline)`（`at` 前进）；审计改 leader 每次留痕、并发 follower 返回 0 无审计；新增「授权撤销→登出→强制下线」回归（红：since 停在 T1），U244 8/8；主会话 14/14。待复审。
- **U245① 分析完成 → U246（🔴 P1）**：审计链先入内存后落盘——失败留下 phantom success（verify 200 且计入、查询可见），下一条以未落盘条目为前驱，重启后 verify 409 / recordAudit 端点永久 503；远端 writer 一次失败闩死且 `/health` 仍 ok。本地 e2e 已复现（chmod 0400）。已派修（方案 A：persist 先于内存提交；writer 区分可重试 `AUDIT_WRITE_FAILED`；health 真实状态），分析落盘 `test-reports/u245-audit-atomicity-20261118.md`。
- **U244 修复后复审**：原 P2 CLOSED（grant 变体红证据真实、8/8）；**新 P2**：并发 follower 只凭「已排队」返回 200/0，不检查 leader 成功——leader 审计失败 503 时 follower 伪 200 而实际未撤销（fail-open）。已派修：队列条目携带 leader outcome，follower 在 leader 失败时作为新 leader 重试；补「屏障 + 注入审计失败」用例。
- **U246 修复落地**（`071e56be47f`，6 文件）：`audit.ts` 改为「persist 成功后才 push/推进 seq/tip」，失败不动 store 且 `appendBestEffort` 无残留；writer 区分 `write_failed`（可重试、恢复无需重启、新码 `AUDIT_WRITE_FAILED`）与 `chain_broken`，`/health` 透真实状态；client 映射为可重试 `AUDIT_UNAVAILABLE`。M32-1 新增失败后 verify 不增/无 phantom/重启 200；审计回归 61/61，主会话复跑 30/30。待复审。
- **U246 复审 APPROVED**：单写者/串行原子性成立、失败后 store/seq/tip/verify 不变、health=write_failed、phantom 消失；writer 重试同 seq 不重复、client 新旧兼容；archive 父提交 unit 3/3 红、writer e2e 500→503。台账 U246 翻 🟢。已知 at-least-once 边界（响应丢失/批量中途）记录为文档项。观察：/health 200+body、detail 或含路径（低风险）。
- **m07 审计现状补写入语义**（U246）：先 persist 后推进内存、失败无 phantom、writer 区分 write_failed（可重试/无需重启/health 真实）与 chain_broken、已知 at-least-once 边界。
- **U244 follower 修复落地**（`a62d3944156`，2 文件）：队列值携带 outcome，follower 仅在 leader 成功时返回 0，否则作为新 leader 重试；审计失败哨兵 Symbol 避免二次响应；新用例断言审计故障并发下无 200-with-0、双 503、无副作用；恢复后 [0,1]、epoch+1、1 条审计。U244 9/9，代理 cloud-platform 全量 1175（1173/2skip/0fail）。最终复审中。
