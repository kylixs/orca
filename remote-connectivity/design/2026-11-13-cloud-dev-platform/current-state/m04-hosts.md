# M4 主机（现状）

> 基线提交：`664a91e0322`（2026-11-16）｜来源：`cloud-platform/apps/web/app.js`（主机列表/注册弹框/详情抽屉/权限卡片）、`cloud-platform/apps/api/src/server.ts`（hosts 端点、心跳、routeKey）、`cloud-platform/apps/api/src/ldap.ts` 外的相关模块代码阅读 + 既有套件。
> 本次未启动 18787（探测 `000`），界面以代码为准；安装命令的现场可执行性未做真实机验证。

## 1. 页面/界面布局

**主机列表（`#/hosts`）**

- 页头：标题「主机」、说明「已注册开发机、心跳状态与直连/中继路径。」；右侧「注册主机」。
- 提示条：「中继路由由平台单向同步；未知 SNI 默认黑洞。下载默认策略：允许/禁止（vN）。」
- 表格列：`主机 / 直连地址 / 中继路由 / 中继 / 版本 / 心跳 / 状态 / 操作`。
  - 主机：名称 + 下一行 zone。
  - 直连地址：多地址换行展示，空为「—」。
  - 中继路由：`relayRoute` 或「—」。
  - 中继：`relayTarget`（绑定目标，等宽）；当有 route 且 `relayOnline === false` 时追加「中继离线」徽标与「直连不受阻」（有直连地址时）。
  - 路由确认（U146）：中继列下方第二行——`relayRouteUpdatedAt` 为空显示「—」；`relayRouteStale === true` 显示 `.badge.warn`「路由陈旧」；否则「路由确认于 N 秒前」。手机卡片同款一行，抽屉「信息」页签有「路由确认」行。
  - 版本：`orcaVersion` + 协议 `pN`。
  - 心跳：相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）。
  - 状态：颜色点 + 在线 / 离线 / 维护中 / 已吊销（吊销优先）。
  - 操作：「详情」。
- 空态「尚未注册主机」。

**注册主机弹框（标题「注册主机」）**

- 说明：「在目标开发机执行以下命令完成注册。脚本会写入环境配置并生成自签证书，令牌 24 小时内有效且只能使用一次。」
- 等宽命令块：`bash <(curl -fsSL <平台 origin>/install/host.sh?token=<token>)`。
- 底部按钮：「复制命令」（复制后 toast「已复制」，弹框保持）+「关闭」。

**主机详情抽屉（右侧 `.drawer`，标题「主机 <名称>」）**

- 页签：`信息` / `权限`。
- 信息页 `dl.kv`：主机 ID、指纹、E2EE 公钥、版本（`orcaVersion` + 协议 vN）、网络位置（zone）、直连地址（逗号分隔）、中继路由、中继绑定（`relayTarget`，离线时追加「中继离线（直连不受阻）」）、路由确认（U146：确认秒数/「路由陈旧」/「—」）、能力列表、最近心跳；已吊销时追加「状态：已吊销（时间）」。
- 信息页底部工具条：「进入维护模式」/「结束维护」（已吊销 disabled，title「主机已下线」）、「下线主机」（danger；已吊销 disabled）；下方说明「下线后该主机的项目立即不可打开，已签发凭证失效。」
- 权限页：三张卡片——`查看`（view）、`控制`（view + provision）、`管理`（provision + maintain）；卡头显示权限位与主体数，卡下说明；每卡可添加组/用户（datalist），芯片可移除；顶部说明「三张卡片是主机授权位的分组视图…项目级授权不扩大到主机级」，底部脚注「变更即时保存…降级保存将断开该主体当前全部云会话」。

## 2. 菜单与入口（权限门槛）

| 入口                    | 位置                               | 门槛                                                                       |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| 主机                    | 侧栏「管理」组                     | `platform:admin`；`GET /v1/hosts` 非管理员 403 + denied 审计               |
| 注册主机                | 列表页头                           | `platform:admin`；`POST /v1/hosts/tokens` 同门槛                           |
| 详情（含信息/权限页签） | 行内                               | 页面 admin-only；`GET /v1/hosts/:id/grants`、`PUT` 均 admin-only           |
| 进入/结束维护           | 抽屉信息页                         | 接口允许 admin 或主机 `maintain` 授权（委派）；控制台入口仅在 admin 页面内 |
| 下线主机                | 抽屉信息页                         | `platform:admin`（`DELETE /v1/hosts/:id`；主机授权不能吊销）               |
| 主机自助建项目可见性    | 开发者侧 `GET /v1/hosts/available` | 无凭证投影；`provisionAllowed`/`accessLevel` 加性字段                      |

## 3. 操作清单

| #   | 触发面                   | 结果                                                                                                                                                                                                                                                                                                    | 弹窗/确认                                                                         | 失败态                                                                                     | 权限门槛                                   |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| D1  | 进入「主机」             | 并发 `GET /v1/hosts` + `GET /v1/policies/download`，渲染列表                                                                                                                                                                                                                                            | 无                                                                                | 内容区「加载失败」+ 重试                                                                   | `platform:admin`                           |
| D2  | 「注册主机」             | `POST /v1/hosts/tokens` 签发一次性令牌（24h，仅存 hash，审计 `host_token_create`），弹框展示命令                                                                                                                                                                                                        | 弹框                                                                              | 签发失败 toast「注册主机失败：…」，不打开弹框（try/catch）                                            | `platform:admin`                           |
| D3  | 「复制命令」             | 剪贴板写入整条 `bash <(curl …)` 命令，toast「已复制」，弹框不关                                                                                                                                                                                                                                         | 无                                                                                | 剪贴板不可用时仍 toast                                                                     | 同上                                       |
| D4  | 目标机执行命令（向导外） | `GET /install/host.sh?token=…` → 校验管理员会话与未使用令牌 → 输出脚本（内嵌平台地址、`HOST_TOKEN`/`ORCA_CLOUD_HOST_TOKEN`、HOST_NAME、ADVERTISE_HOST、PROJECTS_ROOT、TLS 证书路径、`openssl req -x509` 自签步骤、systemd/`orca --host-mode`）；审计 `install_script`（不含令牌明文）                   | 无                                                                                | 缺令牌 400 `INSTALL_TOKEN_REQUIRED`；无效/已用/过期 401 `HOST_TOKEN_INVALID`；非 admin 403 | 见「存疑①」                                |
| D5  | 宿主脚本注册             | `POST /v1/hosts/register`（Bearer=一次性令牌）→ 令牌置已用；按名称 upsert 主机；写入指纹/TLS 指纹/E2EE 公钥/版本/协议/zone/直连地址/能力/项目根/项目目录/状态=online/最近心跳；生成长期凭证；写中继路由表项；审计 `host_register`；返回 `hostId/credential/policyVersion`                               | 无                                                                                | 令牌无效/已用/过期 401                                                                     | 令牌                                       |
| D6  | 行内「详情」             | 打开右侧抽屉，先渲染列表缓存，再异步拉 grants 填充权限页                                                                                                                                                                                                                                                | 抽屉                                                                              | grants 失败→权限页「授权加载失败：…」                                                      | `platform:admin`                           |
| D7  | 信息/权限页签切换        | 纯视图态切换，不改 URL                                                                                                                                                                                                                                                                                  | 无                                                                                | —                                                                                          | 同上                                       |
| D8  | 「进入维护模式」         | `POST /v1/hosts/:id/maintenance {enabled:true, reason:'管理员操作'}` → 关闭抽屉、重绘列表；主机状态=维护中，项目打开入口随 `hostStatus` 置灰                                                                                                                                                            | 无确认                                                                            | 已吊销→409 `HOST_REVOKED`；请求异常 toast「进入维护模式失败：…」，抽屉保持                              | admin 或 `maintain` 授权（UI 在 admin 页） |
| D9  | 「结束维护」             | 同接口 `{enabled:false}` → 状态回 online，重绘列表                                                                                                                                                                                                                                                      | 无确认                                                                            | 同 D8；失败 toast「结束维护失败：…」，抽屉保持                                              | 同上                                       |
| D10 | 「下线主机」             | `DELETE /v1/hosts/:id` → 状态 offline、`revokedAt` 记录、删除中继路由、撤销该主机所有项目凭证；关抽屉、重绘；审计 `host_revoke`                                                                                                                                                                         | `confirmDialog('确认下线该主机？')`（原生 confirm）                               | 非 admin 403 + denied 审计；请求异常 toast「下线主机失败：…」，抽屉保持                     | `platform:admin`                           |
| D11 | 权限页「添加」           | 组/用户切换 datalist；添加=把卡片位并集进该主体整行，`PUT /v1/hosts/:id/grants`；成功 toast 合成级别并重绘                                                                                                                                                                                              | 主体已有行→「覆盖现有授权」确认（显示级别变化与会话断开提示）                     | toast「授予失败：…」，输入保留，请求期间控件冻结；非法位/未知组显示平台文案                | `platform:admin`                           |
| D12 | 权限页芯片「✕」          | 从该行减去卡片位并 `PUT`；剩余非空→toast 级别变化并重绘                                                                                                                                                                                                                                                 | 剩余为空→「移除全部授权」确认（组：宿主无法解析组成员；用户：失去该主机全部授权） | toast「移除失败：…」                                                                       | 同上                                       |
| D13 | 心跳（宿主，周期上报）   | `POST /v1/hosts/:id/heartbeat`：更新直连地址/projectDirs/E2EE/TLS 指纹/状态（维护中不被覆盖）/项目根/开通回报；响应 `hostRevoked`、`projectsRootRejected`、`provisionAssignments`、`auditCapabilities`、`policyVersion`、`policies`、`revoked`、`maintenance`、`serverTime`；写 `host.audit_gap` 等审计 | 无                                                                                | 凭证不符 401；坏 `directAddrs` 400 `HOST_DIRECTADDRS_INVALID`（整拍拒绝）                  | 主机凭证                                   |
| D14 | 主机在线判定             | 列表 `/v1/hosts` 用 `online = revokedAt==null && status==='online' && now-lastHeartbeat<=hostOfflineMs`（默认 60s，`ORCA_CLOUD_HOST_OFFLINE_MS` 可覆盖）；状态列按心跳推导，不沿用存储的 online                                                                                                         | 无                                                                                | 静默超窗→离线                                                                              | 已登录（主机页 admin）                     |
| D15 | routeKey 派生/迁移       | 注册时 `relayRoute = body.relayRoute                                                                                                                                                                                                                                                                    |                                                                                   | routeKeyFromDirectAddrs(directAddrs, name)`；路由目标=`relayTarget                         |                                            | directAddrs[0]`；重注册改 key 时删除旧路由；心跳上报新直连地址时 `syncHostRoute + ensureHostRoute` 补/迁移表项；吊销删除表项 | 无  | 路由表缺项时中继 unknown-route 丢弃（U39/U64 族） | 无  |
| D16 | 中继离线可见性           | 列表/抽屉读 `relayTarget` + `relayOnline`；中继全挂时受影响宿主标「中继离线」，有直连则提示「直连不受阻」                                                                                                                                                                                               | 无                                                                                | —                                                                                          | 同上                                       |

## 4. 数据来源

| 面             | 来源                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 列表/抽屉      | `GET /v1/hosts`（`online`、`browserEntryUrl`、`relayTarget`、`relayOnline`、`relayRouteUpdatedAt`/`relayRouteAgeSec`/`relayRouteStale`〔U146 加性〕由服务端计算）、`GET /v1/policies/download` |
| 注册           | `POST /v1/hosts/tokens` → `GET /install/host.sh?token=` → 宿主 `POST /v1/hosts/register`                               |
| 心跳           | 宿主 `POST /v1/hosts/:id/heartbeat`；平台响应策略/撤销/维护/开通指派；在线窗默认 60s                                   |
| 权限           | `GET/PUT /v1/hosts/:id/grants`；`GET /v1/directory`（用户/组 datalist）                                                |
| 维护/吊销      | `POST /v1/hosts/:id/maintenance`、`DELETE /v1/hosts/:id`；审计 `host_maintenance` / `host_revoke`                      |
| 中继路由       | 平台内存 `relayRoutes`（routeKey → hostId/target/version/`updatedAt`〔U146：写入时间或在线心跳确认时间〕）；宿主注册/心跳写入，吊销删除；中继侧单向同步 |
| 开发者主机选择 | `GET /v1/hosts/available`（无凭证；online/provisionable/projectDirs/provisionAllowed/accessLevel）                     |

- 维护端点必填 `enabled`（布尔）：缺失/字符串/`null`/`0` → 400 `HOST_MAINTENANCE_INVALID`，不再默认进入维护；校验在认证/授权/`auditAllowsMutations`、`HOST_REVOKED` 之后（`server.ts:5803-5811`，`097025df563`）。

## 5. 已知缺陷（台账）

- 🟢 U19：项目登记未校验主机在线（主机页状态与项目创建共用 `hostOnline` 判定）。
- 🟢 U21：`projectsRoot` 变更不迁移已建项目（现活跃项目在册拒绝换根，心跳加性 `projectsRootRejected`）。
- 🟢 U37：repo-ful 项目 provisioning 死锁（心跳下行 `provisionAssignments`）。
- 🟢 U38 / M114b：安装脚本 env 命名与向导命令（现状脚本双写 `HOST_TOKEN` 与 `ORCA_CLOUD_*`）。
- 🟢 U39：中继路由表空（心跳直连地址分支补写 `ensureHostRoute`）。
- 🟢 U57：坏心跳字段（`directAddrs` 等）整拍拒绝，不落库。
- 🟢 U64：宿主重启端口漂移传播窗口（心跳同步路由）。
- 🟢 U79：宿主-中继绑定 `relayTarget`/`relayOnline` 可见。
- 🟡 U146（P2 观测）：陈旧路由可观测已实现（`a3603b825b9`：`updatedAt` + 三加性字段 + 确认秒数/陈旧徽标）；「陈旧」判定=离线窗口 3 倍心跳（180s）或路由目标不在宿主直连地址。
- 🟢 M114a：未显式命名路由的宿主按直连地址派生 `ip-<IP>`，显式键不随 IP 抖动。
- 🟢 M116-QA-005/006/008：静默主机不再显示在线；已吊销主机不可再进入维护；维护原因在项目列表可见。
- 🔴 U65 / U67 / U67b：主机授权语义（全权/只读/不扩大）与「详情抽屉权限 tab 三卡片」UI 仍被用户判定不达标（现状代码已有三卡）。
- 🟢 U62：主机授权拒绝审计、subjectType/权限位校验。

## 6. 测试覆盖

- `cloud-platform/test/e2e/install-wizard.e2e.test.ts`：relay.sh 内嵌、host.sh 缺令牌 400/无效 401、开发者 403、审计不含令牌明文、Web 向导命令文本与端点一致。
- `cloud-platform/test/e2e/web-host-permission-drawer.e2e.test.ts`：AA6-1…5（一次 grants、三卡片、添加/覆盖、非 admin 零请求、失败保留输入）。
- `cloud-platform/test/e2e/host-authorization.e2e.test.ts`：AA2/AA3 三端点门禁、授权写入、restricted 门禁、available 加性、维护委派、吊销恒 admin-only。
- `cloud-platform/test/e2e/host-revocation.e2e.test.ts`：吊销后心跳仍达并携带 `hostRevoked`，新连接 409 `HOST_REVOKED`。
- `cloud-platform/test/e2e/host-offline.e2e.test.ts`：心跳过期→offline 且拒绝打开，恢复心跳→online。
- `cloud-platform/test/e2e/host-route-key-follow.e2e.test.ts`：未命名路由派生 `ip-<IP>`、显式键不随 IP 变、派生键迁移且旧键失效、注册拍无地址由心跳补齐。
- `cloud-platform/test/e2e/u64-host-port-drift.e2e.test.ts`：端口漂移传播。
- `cloud-platform/test/e2e/u79-host-relay-binding.e2e.test.ts`：U79-1/2（载荷与列表列、中继静默标记）。
- `cloud-platform/test/e2e/web-relay-route-staleness.e2e.test.ts`：U146 四例（新鲜/地址漂移陈旧负控/无路由 null+「—」/抽屉 390px 不溢出）；`u64-host-port-drift` 同地址断言改为比较路由字段。
- `cloud-platform/test/e2e/projects-root-change-guard.e2e.test.ts`：换根护栏。
- `cloud-platform/test/e2e/host-key-change-audit.e2e.test.ts`：E2EE/TLS 指纹变更审计。
- `cloud-platform/test/e2e/mtls-control-channel.e2e.test.ts`、`control-plane-isolation.e2e.test.ts`：控制面通道与隔离。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-005/006/008。
- `cloud-platform/test/e2e/web-host-lifecycle-feedback.e2e.test.ts`（G09/T72）：抽屉进入维护→行维护中+项目打开禁用；下线 confirm 取消零 DELETE/确认后行已吊销；注册弹框复制命令（剪贴板+toast「已复制」+弹框保持）；令牌/维护/下线 500 → `<动作>失败：原因` toast、抽屉与平台状态不变。
- 证据目录参考：`cloud-platform/evidence/aa2-host-grants/`、`aa6-host-drawer/`。

## 7. 未覆盖 / 存疑

- **① 复制出的安装命令与脚本端点鉴权不一致——已坐实 = U115**：向导命令为无 `Authorization` 的 `curl`，而 `GET /install/host.sh` 在服务端先 `requireAuth()` 再 `isAdmin()`，`resolveToken()` 只认 Bearer 头。18787 实测：照抄命令（host.sh 与 relay.sh）均 401 `SESSION_EXPIRED`，同一 URL 加 admin Bearer 才 200（evidence/u115/）。`install-wizard.e2e` 的「命令一致」用例实际是带 `adminToken` 头再取脚本，并未验证「照抄命令即执行」。
- 主机详情「信息」页签无专门 e2e（AA6 只覆盖权限页签）。
- ~~「进入/结束维护」「下线主机」的**控制台 UI** 无 e2e；维护请求失败无 toast~~ **closed（T72）**：抽屉维护/下线成功态、confirm 取消/确认、三类失败 toast 与状态保持均已覆盖。
- ~~注册主机弹框的成功/失败 UI（令牌签发失败）、复制按钮无 e2e~~ **closed（T72）**：复制写入完整命令 + toast「已复制」、弹框保持；签发失败 toast「注册主机失败：…」且不打开弹框。
- 真实宿主执行安装脚本 → 注册 → 首次心跳的端到端浏览器/真机用例不在本套件内（脚本内容与端点分别断言）。
- 心跳窗口文案「心跳 15 秒」（工作台统计卡）与默认 60s 不一致，见 M2 §7。
- `relayRoute` 为空、`directAddrs` 为空等边界在列表/抽屉的呈现无 e2e。
