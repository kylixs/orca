# M12 · 宿主/中继接入后端面（注册→心跳→路由→审计）

> **基线提交**：`664a91e0322`（2026-11-16）。
> 代码：`cloud-platform/apps/api/src/server.ts`（端点）、`store.ts`（Host/RelayRoute 模型）、`relay-nodes.ts`（routeKey/中继注册表）、`host-audit-ingest.ts`、`audit.ts`；中继进程 `cloud-platform/apps/relay/src/relay.ts`。
> 设计：`tasks.md` T107/T108/T212/T216–T220、`design.md` §5、`u37-provision-kick-design.md`、`deployment-real-link.md`。

---

## 1. 后端面全链路

```
管理员建令牌/安装脚本 → 宿主一次注册(令牌) → 平台发长期凭证
      → 宿主心跳(凭证)：地址/能力/projectsRoot/projectDirs/审计上报
      → 平台心跳响应：撤销集合/策略/维护态/开通指派/审计能力
      → relayRoutes 表 → 中继 GET /v1/internal/relay-routes 同步
客户端打开项目：connect 选路（直连/中继 edge）→ 云票据
```

## 2. 菜单与入口（管理台/接口）

| 入口             | 方法/路径                                                              | 权限与行为                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生成主机注册令牌 | `POST /v1/hosts/tokens`                                                | admin-only；返回明文 token（24 h 过期、一次性），库中只存 hash；写 `host_token_create` 审计；拒绝落 denied                                                                                    |
| 主机安装脚本     | `GET /install/host.sh?token=<token>`                                   | admin-only；缺 token → 400 `INSTALL_TOKEN_REQUIRED`；无效/已用/过期 → 401 `HOST_TOKEN_INVALID`；脚本内嵌平台地址（请求来源 scheme+host）+令牌，写 `install_script` 审计（**审计不含 token**） |
| 中继安装脚本     | `GET /install/relay.sh`                                                | admin-only；内嵌 `ORCA_CLOUD_INTERNAL_TOKEN`（内部控制令牌）；写 `install_script` 审计                                                                                                        |
| 安装向导         | 管理台「添加宿主/中继」                                                | 复制一行命令；`host.sh` 生成 `~/.orca-cloud/host.env`、自签 TLS（SAN=localhost/127.0.0.1）、健康检查、systemd 用户单元模板；`relay.sh` 写 relay.env + systemd 模板                            |
| 主机列表/详情    | `GET /v1/hosts`                                                        | admin-only；加性字段 `online`、`browserEntryUrl`、`relayTarget`、`relayOnline`                                                                                                                |
| 可选主机         | `GET /v1/hosts/available`                                              | 登录用户；仅返回 id/name/online/provisionable/projectDirs/provisionAllowed/accessLevel，不泄露凭证与指纹                                                                                      |
| 维护             | `POST /v1/hosts/{id}/maintenance`                                      | admin 或主机 `maintain` 位；已下线主机 409 `HOST_REVOKED`；写 `host_maintenance` 审计                                                                                                         |
| 主机授权         | `GET/PUT /v1/hosts/{id}/grants`、`PUT /v1/hosts/{id}/provision-policy` | admin-only（M11）                                                                                                                                                                             |
| 下线             | `DELETE /v1/hosts/{id}`                                                | admin-only；status=offline、revokedAt 置位、删 relayRoute、撤销项目凭证；写 `host_revoke` 审计                                                                                                |

## 3. 注册（`POST /v1/hosts/register`）

- 鉴权：`Authorization: Bearer <token>` 与 `hostTokens` 表 hash 比对；无效/已用/过期 401 `HOST_TOKEN_INVALID`；成功后 `usedAt` 置位（一次性）。
- 请求体：`name`、`fingerprint`、`tlsFingerprint`、`e2eePublicKeyB64`、`orcaVersion`、`protocolVersion`、`networkZone`、`directAddrs[]`、`relayRoute`、`runtimeCapabilities[]`、`projectsRoot`、`projectDirs[]`、`relayTarget`。
- Host 初始值：`capabilities=[]`、`projectsRoot=null`、`projectDirs=[]`、`status=online`、`protocolVersion=3`；同名重注册复用原 Host 行（保留 id）。
- **routeKey 派生**（`relay-nodes.ts`）：
  - 显式 `relayRoute` 优先；
  - 否则 `routeKeyFromDirectAddrs` 取第一个可解析 IP，`ip-<IP>`，点/冒号全部替换为 `-`（SNI 标签不允许点）；无地址回落主机名。
  - `ip-…` 键随心跳地址跟随（`syncHostRoute`）；显式命名键不自动改名。
- 路由表：`relayTarget || directAddrs[0]` 非空则写 `store.relayRoutes.set(routeKey,{hostId,target,version})`；重注册改键时删除旧键表项。
- 审计：`host_register`（actor=agent，metadata=name/zone）；注册后返回 `hostId`、一次性长期 credential、`policyVersion`。

## 4. 心跳（`POST /v1/hosts/{id}/heartbeat`）

凭证：Host 行 `credentialHash` 与 Bearer 比对，失败 401 `HOST_CREDENTIAL_INVALID`。

| 上行字段              | 处理                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directAddrs[]`       | 先做形式校验（非法 → 400 `HOST_DIRECTADDRS_INVALID`，不持久化任何字段）；更新后 `syncHostRoute` + `ensureHostRoute`，漂移主机保持派生标签可解析             |
| `projectDirs[]`       | `parseProjectDirs` 规范化后覆盖（FR-3.7 一级目录清单）                                                                                                      |
| `projectsRoot`        | `applyProjectsRoot` 护栏：活跃项目在册时拒绝换根（旧根保留），响应加性 `projectsRootRejected:'PROJECTS_ROOT_CONFLICT'`；同根重报静默；归档项目不阻塞（U21） |
| `e2eePublicKeyB64`    | 变化写 `host_e2ee_key_changed` 审计（指纹，不存旧键）                                                                                                       |
| `tlsFingerprint`      | 变化写 `host_tls_fingerprint_changed` 审计                                                                                                                  |
| `status`              | online/offline；维护态主机不被心跳覆盖                                                                                                                      |
| `provisioned[]`       | `applyProjectProvisionReports`：克隆/准备回报推进项目状态，清/写 `provisioningError`                                                                        |
| `audit[]`             | `appendHostAuditReports`：宿主拒绝事件落链（含已撤销主机最后一拍）                                                                                          |
| `auditGap`            | `noteHostAuditGap`：宿主上报缺口计数成为可见链事件（U66-rfix NF-2），每拍 100 条上限                                                                        |
| `runtimeCapabilities` | 注册时写入 `host.capabilities`（种子 `['pty','files','git','managed-credential']`）                                                                         |

心跳响应（全部 wire-additive，旧宿主白名单解析时自然忽略新键）：

```jsonc
{
  "hostRevoked": true,                      // 仅已下线
  "projectsRootRejected": "PROJECTS_ROOT_CONFLICT", // 仅冲突
  "provisionAssignments": [...],            // U37 下行指派，每拍上限 1 批
  "auditCapabilities": { "fileEvents": true }, // U66 §2.9 文件事件投递能力
  "policyVersion": 12,
  "policies": { "downloadDefault", "projectOverrides", "readRatePerHour", "rateOverrides" },
  "revoked": { "users": [], "projects": [], "devices": [], "jtis": [] },
  "maintenance": { "reason": "..." },        // 或 null
  "serverTime": 0
}
```

- 已撤销主机仍接受心跳（用于下发撤销结果），但不更新存活状态/地址/根目录/能力。
- `provisionAssignments` 在撤销或维护态不生成；非空时写 1 条批量 `provision_assign` 审计。
- 离线判定基于 `lastHeartbeatAt`（`hostOnline`，默认心跳窗 `HOST_OFFLINE_DEFAULT_MS`）。

## 5. projectsRoot / projectDirs 语义

- `projectsRoot`：平台可自助创建项目的父目录（FR-3.7）。`projectDirs`：该根下宿主回报的一级目录名，供新建向导选择。
- 自助建项目门禁（当前）：`projectsRoot` 存在 **且** `canCreateProjectOnHost`（admin 或持主机 `provision` 位）；旧 `provisionPolicy` 开关不再作为主判据（U65/U67），端点仍保留。
- 根目录变更只允许在无活跃项目时；已建项目 path 不迁移（U21 护栏），避免旧票据指向旧根。
- `/v1/hosts/available` 的 `provisionable=Boolean(projectsRoot)`、`provisionAllowed` 同步上述语义。

## 6. 能力协商

| 协商点                         | 方向                  | 内容                                                                                                                                                  |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeCapabilities`          | 宿主→平台（注册）     | 宿主能力名数组，落 `Host.capabilities`；当前种子 `pty/files/git/managed-credential`                                                                   |
| `workspace.info.capabilities`  | 宿主→客户端           | 云会话能力（M9）：`cloud.session-tabs-restore.v1`；缺失=旧宿主，客户端零探测降级                                                                      |
| `auditCapabilities.fileEvents` | 平台→宿主（心跳响应） | 平台声明理解文件事件族；U68+ 宿主据此门控投递；旧宿主看不到该键，缺省语义为「不投递」以保持兼容                                                       |
| 文件事件上报                   | 宿主→平台             | `POST /v1/internal/audit/file-events`（内部令牌，`host-audit-ingest.ts` 白名单+字段上限），落 `file_download`/`file_copy`/`download_blocked` 等链事件 |

## 7. 中继接入与路由

| 端点                               | 行为                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/internal/relay-endpoint` | `x-internal-token` 校验；`parseRelayRegistration` 校验端口（非法 400 `RELAY_PORT_INVALID`）；`relayNodes.register`（id 缺省 `relay:<port>`，host 缺省=注册来源 IP，`browserHost` 非粘滞）；返回 `relayPort/id/healthyRelays` |
| `GET /v1/internal/relays`          | 全量节点 + `online`（30 s 存活窗）                                                                                                                                                                                           |
| `GET /v1/internal/relay-routes`    | `{version, routes: [{routeKey,hostId,target,version}]}`；中继定时同步，陈旧 5 分钟拒绝新连接（中继侧消费）                                                                                                                   |
| 浏览器 edge                        | `browserEntryUrlFor(routeKey)` → `https://<browserHost>/h/<routeKey>/web-index.html`；routeKey 必须匹配 `^[A-Za-z0-9_-]+$`（中继拒绝带点键）                                                                                 |
| 中继自注册地址                     | `RELAY_PUBLIC_HOST` 显式优先，否则注册来源 IP；NAT/跨机部署不回落 127.0.0.1                                                                                                                                                  |

- 中继脚本 / 进程环境名：`relay.ts` 双读 `ORCA_CLOUD_*` 优先 + 旧 `API_URL`/`INTERNAL_TOKEN` 兼容（U38）。
- host.sh 同时写 `ORCA_CLOUD_*` 生效名与旧裸名（`HOST_TOKEN` 等）双写（U38）；TLS 路径用 `ORCA_CLOUD_TLS_*_PATH`。
- 真实链路部署：中继 `100.67.197.59:18443`、宿主 `192.168.2.202`、平台本机（`deployment-real-link.md`，T220）。

## 8. 审计落链清单

| 事件                                                                     | 触发                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `host_token_create`                                                      | 管理员建令牌                                                                     |
| `install_script`                                                         | 生成 host/relay 安装脚本（`type`、`tokenEmbedded`、`platformUrl`；绝不记 token） |
| `host_register`                                                          | 宿主注册成功（actor=agent）                                                      |
| `host_e2ee_key_changed` / `host_tls_fingerprint_changed`                 | 心跳发现密钥/指纹变化                                                            |
| `host_maintenance`                                                       | 进入/退出维护（含 `via:'host_grant'`）                                           |
| `host_grant_read` / `host_grant_update` / `host_provision_policy_update` | 主机授权读写与拒绝                                                               |
| `host_revoke`                                                            | 管理员下线主机                                                                   |
| `provision_assign`                                                       | 心跳下行开通指派（每拍批 1 条）                                                  |
| `host_audit_gap`                                                         | 宿主上报审计缺口                                                                 |
| `file_download` / `file_copy` / `download_blocked`                       | 宿主文件事件 ingest（U66）                                                       |

审计写入为单写入序列哈希链；变更类端点经 `auditAllowsMutations`（链不可用即 fail-closed 拒绝写）。

## 9. 已知缺陷（台账链接）

| U                                                               | 状态 | 说明                                                                                        |
| --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| [U37](../defect-ledger.md#L44)                                  | 🟢   | repo-ful 项目 provisioning 死锁：心跳下行指派 + 宿主执行器 + 端到端已修；遗留 UX 观察见 U44 |
| [U38](../defect-ledger.md#L45)                                  | 🟢   | 中继/宿主安装脚本 env 命名不一致；已双读/双写                                               |
| [U39](../defect-ledger.md#L46)                                  | 🟢   | 中继路由表空：心跳 `ensureHostRoute` 补写已修                                               |
| [U43](../defect-ledger.md#L50)                                  | 🟢   | mtlsFetch 丢弃请求体导致 relay announce 400；已修（终验 `/v1/relays online:true`）          |
| [U64](../defect-ledger.md#L70)                                  | 🟢   | 宿主重启端口漂移传播窗口；`ensureHostRoute` 对已存在键不更新 target，已修                   |
| [U21](../defect-ledger.md#L28)                                  | 🟢   | projectsRoot 变更不迁移项目：换根护栏 + `projectsRootRejected`                              |
| [U18](../defect-ledger.md#L25) / [U19](../defect-ledger.md#L26) | 🟢   | 项目 key/name 校验、登记校验主机在线                                                        |
| [U79](../defect-ledger.md)                                      | 🟢   | 主机↔中继绑定加性字段（台账见 host relay binding 行）                                       |
| [U66](../defect-ledger.md#L75)                                  | 🟢   | 审计增强总需求；文件事件 ingest/能力协商已落地，下载硬拦二期见 U65                          |
| [U68](../defect-ledger.md#L78)                                  | 🟢   | U66 一期 R-01~R-05；`recordFileEvent` RPC、捕获点、能力协商已补                             |

**尚未实现/风险项**：

- 下载/复制二期宿主硬拦（U65 §5.3）——当前仅前端体验层与既有导出方法拦截。
- `runtimeCapabilities` 只在注册时接入；心跳中不更新能力（宿主升级后能力变化需重注册或后续扩展）。
- 中继路由陈旧 5 分钟拒绝依赖中继进程实现，平台侧无「陈旧路由」显式状态。
- 无独立主机健康指标（连接数/资源）落链，仅心跳时延与审计缺口。
- **心跳不重建记录（2026-11-16）**：`/v1/hosts/:id/heartbeat` 对未知 hostId 返回 404 `HOST_NOT_FOUND`，平台重启若丢失注册态，运行中宿主无法自愈。dev 平台已加快照持久化（`ORCA_PLATFORM_STORE_FILE`，U131）：`--platform-only` 重启后宿主同 id 在线、PTY 存活、项目与授权保留；平台同步启用 `AUDIT_LOG_PATH` 持久审计链（U133 修校验器对 null actor 的误判）。快照审计仅保留 10k 事件，完整链以审计文件为准。

## 10. 测试覆盖

| 类型        | 文件                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主接入    | `cloud-platform/test/e2e/host-authorization.e2e.test.ts`、`host-offline.e2e.test.ts`、`host-revocation.e2e.test.ts`、`host-key-change-audit.e2e.test.ts`、`host-route-key-follow.e2e.test.ts`、`u64-host-port-drift.e2e.test.ts`                                                   |
| 安装/令牌   | `install-wizard.e2e.test.ts`、`u67-...`（安装令牌域外）、`evidence/m114-relay-page/` 冒烟                                                                                                                                                                                          |
| 路由/中继   | `relay-endpoint-address.e2e.test.ts`、`relay-browser-mode.e2e.test.ts`、`relay-browser-entry.e2e.test.ts`、`relay-browser-edge-hygiene.e2e.test.ts`、`relay-failover.e2e.test.ts`、`relay-hardening.e2e.test.ts`、`u79-host-relay-binding.e2e.test.ts`、`test/relay-nodes.test.ts` |
| 心跳/开通   | `provision-assignment-downlink.e2e.test.ts`、`projects-root-change-guard.e2e.test.ts`、`project-connect-readiness.e2e.test.ts`、`project-registration-validation.e2e.test.ts`                                                                                                      |
| 审计 ingest | `test/host-audit-file-ingest.test.ts`、`u71-audit-gap-heartbeat.e2e.test.ts`、`u66-audit-file-events.e2e.test.ts`、`audit-fail-closed.e2e.test.ts`、`audit-verify.e2e.test.ts`                                                                                                     |
| 控制面      | `control-plane-isolation.e2e.test.ts`、`mtls-control-channel.e2e.test.ts`、`test/internal-fetch-tls-body.test.ts`                                                                                                                                                                  |
| 部署        | `deployment-real-link.md`、`cloud-platform/evidence/env-repair-2026-11-14/`                                                                                                                                                                                                        |

**未覆盖/薄弱**：旧版本宿主与新平台心跳字段矩阵（仅 U21/U66 有 wire-additive 单例）、Windows/CentOS7 宿主安装脚本真机、`runtimeCapabilities` 升级路径、路由陈旧拒绝的平台侧可观测性。
