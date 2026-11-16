# M2 工作台与导航框架（现状）

> 基线提交：`664a91e0322`（2026-11-16）｜来源：`cloud-platform/apps/web/{index.html,app.js,router/routes.js}`、`cloud-platform/apps/api/src/server.ts` 代码阅读 + 既有套件。
> 本次未启动 18787（探测 `000`），布局以代码为准。

## 1. 页面/界面布局

**框架（`.shell`）**
- 左栏 `.sidebar`：品牌（ORCA CLOUD）、导航 `#nav`、底部用户盒（头像 / 显示名 / 部门 / 退出）。
- 主区 `.main`：顶栏 `.topbar`（左「面包屑」= 当前路由标题；右「角色 chip」+「查看无权限页」按钮）＋ 内容区 `#content`（渲染时先显示「加载中…」）。

**工作台（`#/workbench`）**
- 页头：问候语（凌晨/上午/下午/晚上好 + 显示名）与一句概览「你有 N 个可访问项目，其中 M 个所在主机在线」。
- 四张统计卡 `.grid-4`：`可访问项目`（按 ACL 过滤）、`主机在线`（提示文案「心跳 15 秒」）、`禁用下载项目`（导出入口已隐藏）、`下载默认策略`（允许/禁止 + 策略版本 vN）。
- 「最近项目」区：取列表前 3 个，卡片含在线点、名称、归档徽标、仓库/路径、主机、默认分支徽标、创建相对时间、主机状态徽标、下载徽标、「打开」按钮；无项目时显示空态卡。
- 「全部项目」表：列 `项目 / 仓库 / 主机 / 可见范围 / 状态 / 操作`；行内操作同下方操作清单；空态「没有可访问的项目」。

**我的项目（`#/projects`）**
- 页头：标题「我的项目」、说明「仅展示你有『打开项目』权限的项目」；右侧「登记项目」（仅管理员）／「刷新」（整页 reload）。
- 工具栏：单个搜索框（项目名/仓库/主机，客户端即时过滤）。
- 表：列 `项目 / 仓库 / 主机 / 权限 / 下载策略 / 操作`；无分页、无筛选 chip；空态「没有匹配的项目」。

**403 / 404 页**
- 403（`.forbidden`）：盾牌图标、「无权访问」、说明「当前账号没有平台管理权限…」、「返回工作台」。
- 404：标题「页面不存在」、等宽显示当前非法 hash（含「（空）」）「返回工作台」。

## 2. 菜单与入口（权限门槛）

| 菜单/入口 | 可见性 | 门槛 |
| --- | --- | --- |
| 工作台 | 始终 | 已登录 |
| 我的项目 | 始终 | 已登录 |
| 管理组（`#adminNav`） | 管理员或审计员才显示整组 | — |
| └ 主机 | 管理员 | `platform:admin` |
| └ 中继 | 管理员 | `platform:admin` |
| └ 用户管理 | 管理员 | `platform:admin` |
| └ 审计日志 | 管理员 **或审计员** | `platform:admin` 或 `platform:auditor` |
| └ 平台设置 | 管理员 | `platform:admin` |
| 角色 chip | 始终 | 文案：平台管理员 / 审计员 / 开发者 |
| 查看无权限页 | **仅非管理员** | 无（管理员隐藏，U74-P3 裁定） |
| 项目「详情」 | 管理员 | `platform:admin` |

**URL 路由现状（U106 已落地的部分）**

hash 形态 `#/<路径>?<查询>`，路由表在 `cloud-platform/apps/web/router/routes.js`：

| hash | 路由名 | 当前渲染 |
| --- | --- | --- |
| `#/workbench`、空 hash、`#/` | workbench | 工作台（默认路由） |
| `#/projects` | projects | 我的项目列表 |
| `#/projects/:id` | projects | **仍渲染列表**（`:id` 未消费；代码注明详情由 R3/R4 接管） |
| `#/workspace/:id` | workspace | **无 renderer，回落工作台** |
| `#/hosts`、`#/hosts/:id` | hosts | 主机列表（`:id` 未消费，不打开详情抽屉） |
| `#/relays` | relays | 中继列表 |
| `#/users`、`#/users/:id` | users | 用户管理列表（`:id` 未消费） |
| `#/audit` | audit | 审计日志 |
| `#/settings` | settings | 平台设置 |
| `#/forbidden` | forbidden | 403 页 |
| `#/not-found` 或未知形态 | not-found | 404 页（保留原 URL） |
| `#/login` | login | 已登录时跳默认路由；未登录显示登录页 |

解析规则：字面段大小写敏感；参数段 `decodeURIComponent`（畸形编码→404）；缺失前导 `/`→404；尾斜杠按同一路由；空查询值被丢弃；未知查询键保留但**当前没有页面消费 `routeQuery`**。写入统一经 `navigate()`（改 `location.hash` + 强制重绘）；`hashchange` 对同一「路由名+参数+查询」签名去重，只有显式导航/重复点当前项会强制重绘。未登录时 `hashchange` 不消费，保留目标 hash 供登录后回跳。

## 3. 操作清单

| # | 触发面 | 结果 | 弹窗/确认 | 失败态 | 权限门槛 |
| --- | --- | --- | --- | --- | --- |
| B1 | 点击侧栏任一菜单 | `navigate(route)` 写 hash 并渲染；面包屑切标题、导航高亮 | 无 | 渲染异常→内容区「加载失败」+「重试」（M116-QA-011） | 菜单显隐见上表；直达仍二次判定 |
| B2 | 重复点击当前菜单 | 强制重绘当前页（等价刷新数据） | 无 | 同上 | 同上 |
| B3 | 浏览器前进/后退或手改 hash | `hashchange`→`applyRoute`；相同签名不重复请求 | 无 | 未知→404；无权→403 | 已登录 |
| B4 | 登录后进入 | 空 hash/`#/login` → `#/workbench`；其他 hash 原样恢复 | 无 | 恢复失败→登录页（M1 A8） | 已登录 |
| B5 | 访问未知 hash | 保留地址，渲染 404，面包屑「页面不存在」 | 无 | — | 已登录 |
| B6 | 非管理员直达 `#/hosts|relays|users|settings` | 保留地址，渲染 403；导航不高亮 | 无 | — | 无平台管理权限 |
| B7 | 审计员直达 `#/audit` | 正常渲染审计页 | 无 | — | admin 或 auditor |
| B8 | 非管理员点击「查看无权限页」 | 进入 `#/forbidden` 403 页 | 无 | — | 非管理员（管理员按钮隐藏） |
| B9 | 403/404 页「返回工作台」 | `navigate('workbench')` | 无 | — | 已登录 |
| B10 | 工作台「查看全部」 | 跳 `#/projects` | 无 | — | 已登录 |
| B11 | 工作台最近项目卡「打开」 | 走项目打开入口（handoff→同页覆盖层，详见 M3/M9） | 失败时覆盖层重试/新标签 | 签发失败→覆盖层失败态；未就绪 20s→超时态 | 有 open 权限 + 主机在线且非维护 + 未归档 |
| B12 | 工作台/我的项目行内「打开」 | 同上；不可打开时按钮 disabled，title 给原因 | 无 | 见原因：已归档 / 主机维护中 / 主机离线 / 管理员未授权 | 同上 |
| B13 | 行内「授权并打开」（管理员且无 open） | 确认后 `PUT /v1/projects/:id/grants` 自授 5 位（open/terminal/agent/file:read/file:write），再打开 | 「授权并打开」确认框，提示会断开当前全部云会话 | toast「授权失败：…」；主机离线/维护按钮 disabled | `platform:admin` |
| B14 | 行内「详情」（管理员） | 打开项目详情弹框（M3） | 无 | 刷新失败→弹框顶部黄条 | `platform:admin` |
| B15 | 行内「Orca Web」（有 open 权限） | `POST web-handoff`（web surface）→ 新标签打开 | 无 | toast「打开失败：…」；离线/维护 disabled 带原因 | 项目 `open` 权限 |
| B16 | 我的项目搜索框输入 | 客户端按 `name + repoUrl + hostName` 小写包含过滤；即时重绘 | 无 | 无匹配→「没有匹配的项目」 | 已登录 |
| B17 | 我的项目「刷新」 | `location.reload()` | 无 | — | 已登录 |

## 4. 数据来源

| 面 | 来源 |
| --- | --- |
| 工作台 / 我的项目 | `GET /v1/projects`（仅活跃项目，ACL 过滤）、`GET /v1/policies/download` |
| 项目行权限摘要 | `/v1/projects` 返回的 `permissions`、`hostAccess`、`hostStatus/hostMaintenanceReason` |
| 打开/Orca Web | `POST /v1/projects/:id/web-handoff` |
| 自授 | `PUT /v1/projects/:id/grants` |
| 角色与导航 | 登录响应或 `GET /v1/me` 的 `permissions`（`platform:admin` / `platform:auditor`） |
| 当前页 | `location.hash`（唯一恢复载体）；用户态在 `state` 内存，无 store |

## 5. 已知缺陷（台账）

- 🟡 **U106**：全站唯一 URL 路由需求。已落地：页级 hash 解析/生成、登录回跳、403/404 保留地址、深链刷新（C1/C4/C5/C6/C8）。未落地：项目/主机详情与弹框不可深链、`projects/:id`/`hosts/:id` 参数未消费、`workspace/:id` 回落工作台、查询参数无消费者。
- 🟢 U72：审计员导航与直达路由门禁（已修；现状 admin 或 auditor 可见审计）。
- 🟢 U74-P3：管理员隐藏「查看无权限页」，避免管理员跳过 403 预览。
- 🟢 U53③：归档项目曾混入在营视图；现状 `GET /v1/projects` 默认排除归档。
- 🟢 U46：项目行三操作语义（打开=同页覆盖层、详情=弹框、Orca Web=新标签）。
- 🟢 U40 / AA5：管理员无授权时的「授权并打开」自授入口。
- 🟢 U65/U67b：主机/项目授权卡片语义仍在收敛（联动 M3/M4/M11）。

## 6. 测试覆盖

- `cloud-platform/test/console-routes.test.ts`：解析/生成往返、查询保序、编码、未知路由 404、空 hash 默认路由、尾斜杠、构造异常。
- `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`：C1/C4 深链刷新（projects/hosts/audit）、C6 未知路由 404、C5/C8 登录回跳与非管理员 403、C8 `#/login` 兼容与空 hash 规范化。
- `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者管理导航隐藏/直达 403/接口 403+审计；管理员全可见；中继页渲染。
- `cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts`：U72-1/2/3 侧栏按角色显隐与直达门禁。
- `cloud-platform/test/e2e/web-project-entry.e2e.test.ts`：打开/Orca Web/详情三入口、离线与维护置灰、无 open 权限不渲染 Orca Web。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-005/007/010/011（状态推导、三入口禁用原因、未授权管理员、加载失败重试）、R5-②（归档排除与徽标）。
- `cloud-platform/test/e2e/web-workbench-latency.e2e.test.ts`、`workbench-project-list-latency.e2e.test.ts`：工作台首屏与项目列表时延。
- `cloud-platform/test/e2e/web-project-registration.e2e.test.ts`：登记入口仅管理员（联动 M3）。

## 7. 未覆盖 / 存疑

- 工作台统计卡数值（四项）无 e2e 断言；卡片提示「心跳 15 秒」与后端默认离线窗 `HOST_OFFLINE_DEFAULT_MS = 60_000`（`ORCA_CLOUD_HOST_OFFLINE_MS` 可覆盖）不一致，属文案/实现差异，台账未见 U 号。
- `#/projects/:id`、`#/hosts/:id`、`#/users/:id`、`#/workspace/:id` 无 e2e（当前行为=列表/工作台回落）。
- 弹框、详情抽屉、权限 tab 均不在 URL 中，刷新即丢失；U106 未覆盖部分。
- 浏览器前进/后退与手改 hash 的专门 e2e 未见（`u106` 覆盖登录回跳与刷新，不等于历史栈）。
- 查询参数无任何页面消费，也无测试钉住「保留但不生效」。
- 面包屑标题仅按路由名映射；参数路由（如 `projects/:id`）无法区分列表/详情。
