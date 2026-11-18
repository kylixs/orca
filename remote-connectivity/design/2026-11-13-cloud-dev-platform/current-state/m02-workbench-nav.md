# M2 工作台与导航框架（现状）

> 基线提交：`42c9d905e11`（2026-11-16，U106-R6 收口）｜来源：`cloud-platform/apps/web/{index.html,app.js,router/routes.js}`、`cloud-platform/apps/api/src/server.ts` 代码阅读 + 既有套件。
> 本次未启动 18787（探测 `000`），布局以代码为准。

## 1. 页面/界面布局

**框架（`.shell`）**

- 左栏 `.sidebar`：品牌（ORCA CLOUD）、导航 `#nav`、底部用户盒（头像 / 显示名 / 部门 / 退出）。
- 主区 `.main`：顶栏 `.topbar`（左「面包屑」= 当前路由标题；右「角色 chip」+「查看无权限页」按钮）＋ 内容区 `#content`（渲染时先显示「加载中…」）。

**工作台（`#/workbench`）**

- 页头：问候语（凌晨/上午/下午/晚上好 + 显示名）与一句概览「你有 N 个可访问项目，其中 M 个所在主机在线」。
- 四张统计卡 `.grid-4`（D11 口径，2026-11-18）：`可访问项目`（按 ACL 过滤）、`主机在线`（值=所在主机在线的可访问项目数；提示文案「60 秒无心跳转离线」，对应后端默认离线窗 `HOST_OFFLINE_DEFAULT_MS`；按 D11 更名为「在线项目」的标签改动在 U322 实施中，代码当前仍为「主机在线」）、`禁用下载项目`（导出入口已隐藏）、`下载默认策略`（允许/禁止 + 策略版本 vN）。「今日会话」「待审批下载」属二期（FR-2.5）。
- 「最近项目」区：取列表前 3 个，卡片含在线点、名称、归档徽标、仓库/路径、主机、默认分支徽标、创建相对时间、主机状态徽标、下载徽标、「打开」按钮；无项目时显示空态卡。
- 「全部项目」表：列 `项目 / 仓库 / 主机 / 可见范围 / 状态 / 操作`；行内操作同下方操作清单；空态「没有可访问的项目」。

**我的项目（`#/projects`）**

- 页头：标题「我的项目」；说明按角色区分——管理员「管理员视图：展示全部项目（含未授权项目）。」，非管理员「仅展示你有『打开项目』权限的项目。」；右侧「登记项目」（仅管理员）／「刷新」（整页 reload）。
- 工具栏：单个搜索框（项目名/仓库/主机，客户端即时过滤）。
- 表：列 `项目 / 仓库 / 主机 / 权限 / 下载策略 / 操作`；无分页、无筛选 chip；空态「没有匹配的项目」。

**403 / 404 页**

- 403（`.forbidden`）：盾牌图标、「无权访问」、说明「当前账号没有平台管理权限…」、「返回工作台」。
- 404：标题「页面不存在」、等宽显示当前非法 hash（含「（空）」）「返回工作台」。未知/畸形 hash（`#/members`、`#/diagnostics`、旧原型 `#/project/<key>`、畸形编码、多余段）统一走此页且保留 URL；窄视口与 403 同 schema（R6）。

## 2. 菜单与入口（权限门槛）

| 菜单/入口             | 可见性                   | 门槛                                   |
| --------------------- | ------------------------ | -------------------------------------- |
| 工作台                | 始终                     | 已登录                                 |
| 我的项目              | 始终                     | 已登录                                 |
| 管理组（`#adminNav`） | 管理员或审计员才显示整组 | —                                      |
| └ 主机                | 管理员                   | `platform:admin`                       |
| └ 中继                | 管理员                   | `platform:admin`                       |
| └ 用户管理            | 管理员                   | `platform:admin`                       |
| └ 审计日志            | 管理员 **或审计员**      | `platform:admin` 或 `platform:auditor` |
| └ 平台设置            | 管理员                   | `platform:admin`                       |
| 角色 chip             | 始终                     | 文案：平台管理员 / 审计员 / 开发者     |
| 查看无权限页          | **仅非管理员**           | 无（管理员隐藏，U74-P3 裁定）          |
| 项目「详情」          | 管理员                   | `platform:admin`                       |

**URL 路由现状（U106 已落地的部分）**

hash 形态 `#/<路径>?<查询>`，路由表在 `cloud-platform/apps/web/router/routes.js`：

| hash                         | 路由名    | 当前渲染                                                                              | 来源  |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------- | ----- |
| `#/workbench`、空 hash、`#/` | workbench | 工作台（默认路由）                                                                    | R2    |
| `#/projects`                 | projects  | 我的项目列表；`?q=` 还原搜索                                                          | R2/R5 |
| `#/projects/:id`             | projects  | 列表 + 详情弹框（管理员；非管理员 403）；`?tab=info\|perms`                           | R3    |
| `#/workspace/:id`            | workspace | 顶层覆盖层（项目可见才挂载；不可见 404）；关闭走 history.back                         | R4    |
| `#/hosts`、`#/hosts/:id`     | hosts     | 主机列表 + 详情抽屉；`?tab=perms` 选中权限页签                                        | R3    |
| `#/relays`                   | relays    | 中继列表                                                                              | R2    |
| `#/users`、`#/users/:id`     | users     | 用户管理列表 + 详情弹框；`?query=&role=&status=` 入 URL                               | R3/R5 |
| `#/audit`                    | audit     | 审计日志；筛选键入 URL（cursor 与展开行不入）                                         | R2/R5 |
| `#/settings`                 | settings  | 平台设置                                                                              | R2    |
| `#/forbidden`                | forbidden | 403 页（保留 URL）                                                                    | R2    |
| `#/not-found` 或未知形态     | not-found | 404 页（保留原 URL；含 `#/members`、`#/diagnostics`、旧 `#/project/<key>`、畸形编码） | R2/R6 |
| `#/login`                    | login     | 已登录时跳默认路由；未登录显示登录页（兼容别名）                                      | R2    |

解析规则：字面段大小写敏感；参数段 `decodeURIComponent`（畸形编码→404）；缺失前导 `/`→404；尾斜杠按同一路由；空查询值被丢弃；未知查询键保留。R5 后 `routeQuery` 已被 projects/users/audit 消费（见上表），cursor 与审计展开行不入 URL。写入统一经 `navigate()`（改 `location.hash` + 强制重绘）；`hashchange` 对同一「路由名+参数+查询」签名去重，只有显式导航/重复点当前项会强制重绘。未登录时 `hashchange` 不消费，保留目标 hash 供登录后回跳。

**静态服务运维语义（U125）**：平台进程**启动时**把 `cloud-platform/apps/web/{index.html,app.js,styles.css,router/routes.js}` 读入内存并冻结为 release build（`apps/api/src/web-release.ts`，哈希内容寻址 `/assets/<build>/…`，build 会归档供旧页面继续取用），运行期**不再回读源文件**。因此改了 app.js/styles.css（或 routes.js）后，必须**重启平台**才对 18787 外显：`node cloud-platform/scripts/local-env-reseed.mjs --restart-platform`。排障「改了 UI 没变化」时先核对 served 与源哈希：`curl -fsS https://127.0.0.1:18787/v1/web/release` 的 `build` 及各资源 `sha256` 应与源文件 `shasum -a 256` 一致（静态响应头 `x-orca-web-build` 同源于该 build）；不一致即进程仍在服务启动时快照，重启后复验。

**CSP 现状（U197 S6 / D10 阶段 1，2026-11-18）**：仅 HTML 文档下发 `Content-Security-Policy-Report-Only`——入口 `/`、`/index.html`、哈希入口 `/assets/<build>/index.html` 与文件系统回退的 `.html`；JS/CSS/JSON/审计导出/404 均不带，避免策略扩散。策略常量 `STATIC_CSP_REPORT_ONLY`（`apps/api/src/static-delivery.ts:23-24`）故意不入共享 `STATIC_SECURITY_HEADERS`（`:15-17`），后者会被 JSON（`server.ts:273-275`）与审计导出（`:7081-7082`）继承；写头在 `sendStaticAsset`（`static-delivery.ts:141-143`），三处调用按文件名是否为 `.html` 判定而非 contentType（`server.ts:7769,7814,7831`），304 与 200 共用同一 headers，故重验证同样带/不带（`:147-149`）。开关 `ORCA_CLOUD_CSP_REPORT_ONLY` 默认开，仅 `trim().toLowerCase()` 后等于 `off` 才关闭（`server.ts:7753-7755`；`false`/`0` 仍开）。测试 `cloud-platform/test/e2e/web-document-csp.e2e.test.ts` 覆盖上述范围、304 继承、env 语义与策略指令字面量；真实浏览器零违规观测与内联 `onclick` 重构已由 `dd37b0004a2`（`u197-csp-zero-violation.e2e.test.ts`）完成。**已知未完成**：上报端点（`report-uri`/`report-to`）、宿主侧 `cloud-admin.html`/`web-index.html` 独立策略评估。落地 `0fd4062f33c`，补强 `9e8f51b4852`；草稿 `work-orders/u197-csp-draft.md`。

**R1-R6 收口清单（对照设计 T1-T14，2026-11-16）**

| 终审项 | 状态   | 差异说明                                                                                                |
| ------ | ------ | ------------------------------------------------------------------------------------------------------- |
| T1     | 已实现 | R1 纯解析/生成 + R2 `pushState`/`hashchange`；静态服务无 SPA fallback。                                 |
| T2     | 已实现 | 路由表仅设计路由；旧 `#/project/<key>` 不设别名，按未知路由 404。                                       |
| T3     | 已实现 | R3 项目/主机/用户详情深链 + `?tab=info\|perms`；写操作确认弹框不入 URL。                                |
| T4     | 已实现 | R4 `#/workspace/<id>`：列表打开 push、关闭 back、刷新重新 mint。                                        |
| T5     | 已实现 | 403 保留 URL；项目/详情不可见 404；未知路由 404；`#/members` 由回落工作台改 404（R6）。                 |
| T6     | 已实现 | R2 登录保留目标 hash、`#/login` 兼容别名；R6 同步 U67 设计与 AC 文本。                                  |
| T7     | 已实现 | R5 projects `q`、users `query/role/status`、audit 全筛选入 URL；cursor 与展开行不入。                   |
| T8     | 未做   | Orca Web `?api=&project=` 恢复属 W1-W3，不在 R1-R6 范围。                                               |
| T9     | 未做   | 静默续会话失败分支属 W1/W2。                                                                            |
| T10    | 未做   | URL project 权威性（无 fallback）属 W1/W2。                                                             |
| T11    | 未做   | 嵌入页失效改登录表单属 W3。                                                                             |
| T12    | 已实现 | 控制台 URL 无 token/code、project id 可分享；静态响应统一 `Referrer-Policy: no-referrer`（比 same-origin 建议更严），e2e 覆盖 hashed/HTML/unhashed/304/静态未命中 404（`99df73d008a`）；`json()` 统一出口补 `STATIC_SECURITY_HEADERS`，`HEAD /`、`HEAD /assets/<缺失>/x.js`、未知 API 404 与 Web 契约 426 同带头（`0b21eacaca1`）。**现网生效（2026-11-17 13:27:28，平台 pid 25992，`evidence/u106-restart-window-20261117-132713/`）**：GET 静态命中/未命中、HEAD 根与 HEAD 缺失资源实测均带 `Referrer-Policy: no-referrer`，部署窗口 before/after diff 0。 |
| T13    | 未做   | 多标签各自 URL/重新 mint 无专门实现与 e2e。                                                             |
| T14    | 偏差   | 404/403 窄视口同 schema 已实现并测试（R6）；管理台其余页面未做响应式；原生 App 不接（符合）。           |

R1-R5 交付提交：`f4eae1c2ebd`/`53941ff9fb1`/`9e436334e88`/`402517832b7`/`b5cb2c53599`；R6 为本次提交（未知路由矩阵、移动视口与文档收口）。

## 3. 操作清单

| #   | 触发面                                | 结果                                                                                                    | 弹窗/确认                                      | 失败态                                                | 权限门槛                                 |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| B1  | 点击侧栏任一菜单                      | `navigate(route)` 写 hash 并渲染；面包屑切标题、导航高亮                                                | 无                                             | 渲染异常→内容区「加载失败」+「重试」（M116-QA-011）   | 菜单显隐见上表；直达仍二次判定           |
| B2  | 重复点击当前菜单                      | 强制重绘当前页（等价刷新数据）                                                                          | 无                                             | 同上                                                  | 同上                                     |
| B3  | 浏览器前进/后退或手改 hash            | `hashchange`→`applyRoute`；相同签名不重复请求                                                           | 无                                             | 未知→404（保留 URL）；无权→403；二者不混用            | 已登录                                   |
| B4  | 登录后进入                            | 空 hash/`#/login` → `#/workbench`；其他 hash 原样恢复                                                   | 无                                             | 恢复失败→登录页（M1 A8）                              | 已登录                                   |
| B5  | 访问未知 hash                         | 保留地址，渲染 404，面包屑「页面不存在」；`#/members`/`#/diagnostics`/旧 `#/project/<key>`/畸形编码同径 | 无                                             | 非管理员也是 404（不被 403 吞并）                     | 已登录                                   |
| B6  | 非管理员直达 `#/hosts                 | relays                                                                                                  | users                                          | settings`                                             | 保留地址，渲染 403；导航不高亮           | 无  | —   | 无平台管理权限 |
| B7  | 审计员直达 `#/audit`                  | 正常渲染审计页                                                                                          | 无                                             | —                                                     | admin 或 auditor                         |
| B8  | 非管理员点击「查看无权限页」          | 进入 `#/forbidden` 403 页                                                                               | 无                                             | —                                                     | 非管理员（管理员按钮隐藏）               |
| B9  | 403/404 页「返回工作台」              | `navigate('workbench')`                                                                                 | 无                                             | —                                                     | 已登录                                   |
| B10 | 工作台「查看全部」                    | 跳 `#/projects`                                                                                         | 无                                             | —                                                     | 已登录                                   |
| B11 | 工作台最近项目卡「打开」              | 走项目打开入口（handoff→同页覆盖层，详见 M3/M9）                                                        | 失败时覆盖层重试/新标签                        | 签发失败→覆盖层失败态；未就绪 20s→超时态              | 有 open 权限 + 主机在线且非维护 + 未归档 |
| B12 | 工作台/我的项目行内「打开」           | 同上；不可打开时按钮 disabled，title 给原因                                                             | 无                                             | 见原因：已归档 / 主机维护中 / 主机离线 / 管理员未授权 | 同上                                     |
| B13 | 行内「授权并打开」（管理员且无 open） | 确认后 `PUT /v1/projects/:id/grants` 自授 5 位（open/terminal/agent/file:read/file:write），再打开      | 「授权并打开」确认框，提示会断开当前全部云会话 | toast「授权失败：…」；主机离线/维护按钮 disabled      | `platform:admin`                         |
| B14 | 行内「详情」（管理员）                | 打开项目详情弹框（M3）                                                                                  | 无                                             | 刷新失败→弹框顶部黄条                                 | `platform:admin`                         |
| B15 | 行内「Orca Web」（有 open 权限）      | `POST web-handoff`（web surface）→ 新标签打开                                                           | 无                                             | toast「打开失败：…」；离线/维护 disabled 带原因       | 项目 `open` 权限                         |
| B16 | 我的项目搜索框输入                    | 客户端按 `name + repoUrl + hostName` 小写包含过滤；即时重绘                                             | 无                                             | 无匹配→「没有匹配的项目」                             | 已登录                                   |
| B17 | 我的项目「刷新」                      | `location.reload()`                                                                                     | 无                                             | —                                                     | 已登录                                   |

## 4. 数据来源

| 面                | 来源                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| 工作台 / 我的项目 | `GET /v1/projects`（仅活跃项目，ACL 过滤）、`GET /v1/policies/download`               |
| 项目行权限摘要    | `/v1/projects` 返回的 `permissions`、`hostAccess`、`hostStatus/hostMaintenanceReason` |
| 打开/Orca Web     | `POST /v1/projects/:id/web-handoff`                                                   |
| 自授              | `PUT /v1/projects/:id/grants`                                                         |
| 角色与导航        | 登录响应或 `GET /v1/me` 的 `permissions`（`platform:admin` / `platform:auditor`）     |
| 当前页            | `location.hash`（唯一恢复载体）；用户态在 `state` 内存，无 store                      |

## 5. 已知缺陷（台账）

- 🟢 **U106**：R1-R6 已落地（hash 路由、登录回跳、详情深链、工作区覆盖层、筛选入 URL、未知路由 404 与窄视口）。剩余 T8-T13 属 W1-W3（Orca Web `?api&project` 恢复与嵌入页登录兜底），不在 R 域；U67 `#/members` 回落表述已同步为 404。
- 🟢 U72：审计员导航与直达路由门禁（已修；现状 admin 或 auditor 可见审计）。
- 🟢 U74-P3：管理员隐藏「查看无权限页」，避免管理员跳过 403 预览。
- 🟢 U53③：归档项目曾混入在营视图；现状 `GET /v1/projects` 默认排除归档。
- 🟢 U46：项目行三操作语义（打开=同页覆盖层、详情=弹框、Orca Web=新标签）。
- 🟢 U40 / AA5：管理员无授权时的「授权并打开」自授入口。
- 🟢 U65/U67b：主机/项目授权卡片语义仍在收敛（联动 M3/M4/M11）。
- 🟢 U278：移动端主机详情无功能缺口——平台 Web 控制台 ≤700px 已有响应式全屏 sheet（信息/权限）；`ui/prototype-mobile.html` 的原型 sheet 归二期素材（2026-11-18 裁定，不新增开发）。

## 6. 测试覆盖

- `cloud-platform/test/console-routes.test.ts`：解析/生成往返、查询保序、编码、未知路由 404、空 hash 默认路由、尾斜杠、构造异常。
- `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`：C1/C4 深链刷新（projects/hosts/audit）、C6 未知路由 404 + 5 形态矩阵（`#/members`/`#/diagnostics`/旧 `#/project/<key>`/畸形编码/多余段）、403 与 404 分离、C5/C8 登录回跳与非管理员 403、`#/login` 兼容与空 hash 规范化。
- `cloud-platform/test/e2e/u106-detail-deeplink.e2e.test.ts`：R3 详情深链/页签/关闭/未知 id 404（R3）。
- `cloud-platform/test/e2e/u106-workspace-route.e2e.test.ts`：R4 覆盖层直链/刷新重新 mint/关闭回列表/不可见项目 404。
- `cloud-platform/test/e2e/u106-filter-url.e2e.test.ts`：R5 projects/users/audit 筛选往返与 U120 登出清 hash。
- `cloud-platform/test/e2e/u106-console-mobile.e2e.test.ts`：R6 390×844 视口下 404/403 同 schema、无横向溢出（真实 Chrome）。
- `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者管理导航隐藏/直达 403/接口 403+审计；管理员全可见；中继页渲染。
- `cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts`：U72-1/2/3 侧栏按角色显隐与直达门禁。
- `cloud-platform/test/e2e/web-project-entry.e2e.test.ts`：打开/Orca Web/详情三入口、离线与维护置灰、无 open 权限不渲染 Orca Web。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-005/007/010/011（状态推导、三入口禁用原因、未授权管理员、加载失败重试）、R5-②（归档排除与徽标）。
- `cloud-platform/test/e2e/web-workbench-latency.e2e.test.ts`、`workbench-project-list-latency.e2e.test.ts`：工作台首屏与项目列表时延。
- `cloud-platform/test/e2e/web-project-registration.e2e.test.ts`：登记入口仅管理员（联动 M3）。

## 7. 未覆盖 / 存疑

- 工作台统计卡数值（四项）无 e2e 断言；卡片心跳提示「60 秒无心跳转离线」由 `web-exploratory-fixes` 的 U116 用例从 `HOST_OFFLINE_DEFAULT_MS` 推导后断言，但文案写死默认值，部署以 `ORCA_CLOUD_HOST_OFFLINE_MS` 覆盖时不跟随。
- T13 多标签页（各自 URL + 重新 mint）无专门实现与 e2e。
- T14 仅 404/403 做了窄视口验证；管理台列表/表格等页面仍是桌面布局。
- 浏览器前进/后退的细节由 `u106-detail-deeplink`/`u106-workspace-route` 覆盖打开/关闭，但完整历史栈矩阵（跨路由连续后退）未单列。
- 面包屑标题仅按路由名映射；参数路由（如 `projects/:id`）无法区分列表/详情。
