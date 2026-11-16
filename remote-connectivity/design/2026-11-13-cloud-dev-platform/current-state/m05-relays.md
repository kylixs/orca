# M5 中继（列表 / 状态 / 绑定关系可见性 / 安装向导）

> 基线提交：`664a91e0322`（2026-11-16 工作区快照）。当前工作树另有未提交的 U106-R3 详情深链改动（`cloud-platform/apps/web/app.js`），不改变中继页行为；本文件按 HEAD 记录。
> 平台前端：`cloud-platform/apps/web/app.js`（`renderRelays` / `addRelayDialog` / `relayRow`，约 L1508-1550）。后端：`cloud-platform/apps/api/src/server.ts`（`GET /v1/relays`，约 L3015）。

## 1. 页面/界面布局

路由 `#/relays`，面包屑「平台设置 / 中继」。

- **页头**（`.page-head`）：标题「中继」；副标题「已注册中继节点、客户端拨号地址与在线状态。」；右侧两个按钮：`添加中继`（primary，`#addRelayBtn`）、`刷新`（`#refreshRelaysBtn`）。
- **说明条**（`.note`）：客户端地址是客户端实际拨号的 host:port；中继显式上报的可达地址优先，未上报时取注册来源 IP；路由表由平台单向同步。
- **列表**（`.table-wrap > table`），固定 4 列：
  1. `节点 ID`（等宽字体，平台下发的 relay id）
  2. `客户端地址`（`host:port`，等宽字体）
  3. `状态`（`dot online/offline` + 文案「在线」/「离线」）
  4. `最近注册时间`（`new Date(lastSeenAt).toLocaleString()`，非相对时间）
- **空态**：单行 `colspan="4"` 文案「尚未注册中继」。
- **无**：详情抽屉、编辑/删除、搜索/筛选、分页、排序、自动刷新轮询；页面不会展示每个中继承载的路由/宿主清单。
- 中继本身没有「绑定关系」面板；宿主侧绑定（`relayTarget` / `relayOnline`）在 M4 主机页与主机详情抽屉展示（见 §3.6）。

## 2. 菜单与入口

- 侧栏管理分组 `#adminNav` 中的「中继」按钮（`index.html` L60）。仅 `platform:admin` 可见；auditor/developer 该按钮 `hidden=true`。
- 直达 `#/relays`：非管理员由 `routeAllowed()` 判为无权 → 渲染「无权访问」页（保留 URL）；不发起 `/v1/relays` 请求。
- 权限门槛：页面数据 `GET /v1/relays` 与安装脚本 `GET /install/relay.sh` 均为 admin-only；非 admin 直调 403 `PERMISSION_DENIED`。
- 「刷新」= 重新调用 `renderRelays()` 拉一次列表；再次点击当前侧栏项也会强制重绘（`navigate` 的 force 语义）。

## 3. 操作清单

| #   | 触发                               | 结果                                                                                                                                                                             | 弹窗/确认                                                                         | 失败态                                                                                                             |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 3.1 | 打开 `#/relays`                    | `GET /v1/relays` → 表头 + 行；空列表显示「尚未注册中继」                                                                                                                         | 无                                                                                | `loadContent` 兜底：「加载失败」+ 错误文本 + 「重试」按钮                                                          |
| 3.2 | 点击「刷新」                       | 重新 `GET /v1/relays` 并整体重绘 tbody                                                                                                                                           | 无                                                                                | 失败提示：`.note.warn` 横幅显示「刷新失败：<原因>」+「重试」；旧表保留；重试成功后提示清除；不自动轮询（U136②） |
| 3.3 | 点击「添加中继」                   | 打开 `dialog('添加中继')`：说明「在中继机执行以下命令完成注册上线」+ 一行命令 `<pre id="relayInstallCmd">` + 灰字「仅管理员可见。RELAY_PUBLIC_HOST 缺省时平台记录注册来源 IP。」 | 唯一动作「复制命令」（复制 + toast「已复制」，弹框保持）；「关闭」/Esc/点遮罩关闭 | 无网络请求，弹框必然打开                                                                                           |
| 3.4 | 执行向导命令（在中继机）           | 命令为 `bash <(curl -fsSL <platform>/install/relay.sh)`；脚本端点内嵌 `ORCA_CLOUD_API_URL` 与 `ORCA_CLOUD_INTERNAL_TOKEN`，内部令牌不出现在 URL 中（e2e 断言）                   | 无                                                                                | 脚本端点 admin-gated（401/403）；命令本身不带凭据，见 §5 观察 2                                                    |
| 3.5 | 中继静默超过存活窗口               | `online=false` → 行显示「离线」；页面不自动轮询，需「刷新」或重进页面才看到                                                                                                      | 无                                                                                | 无                                                                                                                 |
| 3.6 | 中继离线的影响面（在 M4 主机页看） | 宿主表「中继」列显示 `relayTarget`，并附 `badge warn`「中继离线」；若宿主有直连地址再加「直连不受阻」；主机详情抽屉「中继绑定」行同样标注                                        | 无                                                                                | 无                                                                                                                 |
| 3.7 | 客户端连接中继                     | `/connect` 只下发存活中继端点（`wss://<host>:<port>/`，SNI=`<routeKey>.relay.local`）；中继死亡后客户端在 5 次内切换存活节点（AC-23）                                            | 无（客户端行为）                                                                  | 无存活中继时不下发端点；未知 SNI 黑洞                                                                              |

补充语义：

- 在线判定：`now - lastSeenAt <= relayAliveMs`（默认 30s，`RELAY_ALIVE_DEFAULT_MS`）；中继每 2s 心跳注册。
- 客户端地址优先级：中继宣告的 `host`（`RELAY_PUBLIC_HOST`）> 注册请求来源 IP。
- 「状态」只有在线/离线两态，没有维护中/已下线等中继状态。
- 无「删除中继」；中继退出靠静默超时。

## 4. 数据来源

- `GET /v1/relays` → `{ relays: [{ id, host, browserHost, port, online, lastSeenAt }] }`（admin-only；`browserHost` 未在表格中展示）。
- `GET /install/relay.sh` → shell 脚本（admin-only；写 `install_script` success，`metadata.type='relay'`）。
- 中继注册：`POST /v1/internal/relay-endpoint`（`x-internal-token`，非浏览器路径），记录 `host/port/browserHost/lastSeenAt`。
- 宿主绑定展示：`GET /v1/hosts` 的 wire-additive 字段 `relayTarget`、`relayOnline`、`relayRoute`（M4 页面消费）。
- 审计事件：
  - `relay_list`：仅拒绝时落链（`denyPrivileged`）；管理员成功拉取列表**不写** success 事件。
  - `install_script`：拉取 relay.sh 成功/被拒均落链；metadata 不含令牌明文。
  - 注册/心跳类事件不在中继页展示，见 M12。

## 5. 已知缺陷与观察

已登记且已修（台账 `remote-connectivity/design/2026-11-13-cloud-dev-platform/defect-ledger.md`）：

- **U38**（🟢）：安装脚本 env 命名与 relay 进程读取不一致（`API_URL` vs `ORCA_CLOUD_API_URL`），已双读兼容并消除静默失败。
- **U39**（🟢）：中继路由表为空（注册拍缺 relayTarget/directAddrs 时不写表项），已修。
- **U43**（🟢）：`mtlsFetch` https 分支丢请求体导致 relay announce 400，已修。
- **U64**（🟢）：宿主重启端口漂移后 `ensureHostRoute` 不更新 target，已修。
- **U79**（🟢）：宿主-中继绑定 `relayTarget` 不可见（爆炸半径不可见），已在中继页之外的宿主表/抽屉落地。
- 非缺陷：中继页无详情页/无删除/无分页，当前设计与需求未承诺，不作为缺陷。

未登记观察（建议后续登记 U 号）：

1. 「刷新」失败原有可见反馈缺口：`#refreshRelaysBtn` 直接调用 `renderRelays()`，不经过 `loadContent` 的错误兜底。U136② 已修复：失败时保留旧数据并显示 `.note.warn` 横幅 +「重试」，成功后清除。
2. 向导命令的可执行性依赖部署侧鉴权：`/install/relay.sh` 要求 admin Bearer，而 UI 命令（e2e 断言）不含 token；在干净 shell 中直接执行会 401。e2e 只验证「管理员带 Bearer 拉脚本」和「命令字符串等于端点 URL」，未端到端验证粘贴执行。是否由反代/部署层补鉴权待 M12 明确。
3. 页面无自动刷新：中继掉线后状态可能长期停留在「在线」，直到人工刷新。

## 6. 测试覆盖

已覆盖（绝对路径）：

- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：M114b 管理员中继页导航可见、渲染 `relay-web`/`relay.example.test:18443`/「在线」；开发者直达 `#/relays` 渲染无权访问且页面不出现「尚未注册中继」；`/v1/relays` 403 + `relay_list` denied 审计。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/relay-endpoint-address.e2e.test.ts`：列表来源地址注册、`RELAY_PUBLIC_HOST` 优先、`/connect` 端点与 SNI、开发者 403 + denied 审计。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/install-wizard.e2e.test.ts`：relay.sh 内嵌平台地址/内部令牌、开发者 403 + `install_script` 审计（无令牌明文）、Web 向导命令与端点逐字一致且 URL 无 token。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u79-host-relay-binding.e2e.test.ts`：`relayTarget/relayOnline` 载荷、中继静默后宿主表「中继离线/直连不受阻」与抽屉「中继绑定」。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/relay-hardening.e2e.test.ts`：SNI 白名单、未知路由黑洞、非 TLS 拒绝、并发限制、连接元数据不含负载。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/relay-failover.e2e.test.ts`：AC-23 双中继、杀一后不下发、客户端 5 次内切换。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/relay-browser-entry.e2e.test.ts`、`relay-browser-mode.e2e.test.ts`、`relay-browser-edge-hygiene.e2e.test.ts`：browserHost/browserEntryUrl 与 `/h/` 边缘卫生。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/relay-nodes.test.ts`：注册体解析、routeKey 形状、地址推导。
- 证据：`/Users/gongdewei/work/projects/orca/cloud-platform/evidence/m114-relay-page/`、`.../u79-relay-binding/`、`.../m83-relay-failover/`、`.../m86-relay-data-path/`。

未覆盖：

- 「刷新」失败态（观察 1）由 T06 QA-013 覆盖（U136②：提示+重试、旧表保留、成功清除）。
- 中继离线行的 UI（dot/文案）无直接断言；u79 只覆盖宿主侧离线标注。
- 无自动刷新为既定语义；T06 QA-013 断言 1.2s 内无轮询。
- 向导命令从干净 shell 粘贴执行（观察 2）无端到端测试。

## 7. 基线提交

`664a91e0322d90e4d32ce9d092526159c3052854`（分支 `feat/mobile-file-browser-terminal-html`）。工作树对 `cloud-platform/apps/web/app.js` 的 U106-R3 未提交改动不影响本模块。
