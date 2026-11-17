# M6 用户管理（列表 / 查询 / 详情弹框 / 角色覆盖 / 停用账号）

> 基线提交：`664a91e0322`（2026-11-16 工作区快照）。当前工作树另有未提交的 U106-R3 详情深链改动（`cloud-platform/apps/web/app.js`）：会把用户详情接入 `#/users/:id` 与浏览器后退；本文件按 HEAD 记录（HEAD 上详情只能从列表点开）。
> 前端：`cloud-platform/apps/web/app.js`（`renderUsersPage` / `filterUsers` / `userDetailMarkup` / `confirmUserRoleChange` / `applyUserRoleChange`，约 L1554-1765）。后端：`cloud-platform/apps/api/src/server.ts`（`GET /v1/users`、`PUT /v1/users/{id}/roles`，约 L2933-3010）。

## 1. 页面/界面布局

路由 `#/users`，面包屑「用户管理」。

- **页头**：标题「用户管理」；副标题「平台账号与角色设置。用户与组来自 LDAP；角色以平台默认为基线，按用户覆盖，覆盖记录留审计。」；右侧 toolbar 两枚徽标：LDAP 准入徽标（U145：`GET /v1/users` 加性字段 `ldap.requiredGroup` 有值显示「LDAP 准入组：<组名>」，未配置显示「LDAP 准入：未配置」，旧服务端无该字段回退中性「LDAP 分组准入」；不声明同步状态）、「N 个账号」。
- **模型说明条**（`.note`）：「角色 ≠ 资源授权（两层模型）」整段：本页角色决定管控面/审计面可见性；资源授权在项目/主机详情弹框权限页签；管理员角色不等于项目内全权，打开项目仍需显式授权。
- **查询栏**（`.toolbar[role=search]`，5 个控件）：
  - `#userSearch` 搜索框（占宽），占位「用户名关键字：显示名或账号，如 张伟 / zhangwei」；
  - `#userRoleFilter` 下拉：全部角色 / 普通 / 审计 / 管理员；
  - `#userStatusFilter` 下拉：全部状态 / 活跃 / 已停用；
  - `#userFilterApply`「查询」（primary）；
  - `#userFilterReset`「重置」（ghost）。
- **列表区标题**：「账号与角色」，右侧灰字「列表只读 · 角色在详情中修改 · 变更写入 role_update 审计」。
- **表格**（7 列，与原型逐字对照）：`用户` / `部门` / `LDAP 组` / `角色` / `角色来源` / `状态` / `操作`。
  - 用户列：显示名加粗 + 账号（等宽灰字）；
  - 角色列：纯文本（普通/审计/管理员），**无行内控件**；
  - 角色来源：`admin-override` 显示绿徽标「管理员覆盖」，否则灰字「平台默认」；
  - 状态：绿点「活跃」/ 灰点「已停用」；
  - 操作：唯一按钮「详情」（ghost）。
- **页脚**（`#usersFoot`）：「共 N 个账号[ · 当前筛选 M 个] · 服务端按请求实时判定角色；角色降级会断开当前云会话（≤60 秒），升级即时生效、不断会话。变更可在审计日志按「角色变更 · role_update」筛选。」
- **空态**：单行 `colspan="7"` 文案「没有符合筛选条件的账号——请调整关键字或重置条件」。
- **详情弹框**（`dialog(..., {wide:true})`，标题「用户详情 · <显示名>」）：7 个字段的 `dl.kv`：
  1. 显示名；2. 账号（等宽）；3. 部门；4. LDAP 组（逗号分隔，空为 —）；5. 平台角色（`select[data-detail-role]`，活跃账号可改，停用账号 disabled 并显示「已停用账号不可修改角色」）；6. 角色来源（同列表）；7. 状态（同列表）。
     弹框底部说明：角色变更写 role_update 审计、覆盖优先于平台默认角色、降级断开云会话、列表只读仅此处修改。
     不展示创建时间/最近登录（users API 无该字段，不虚构）。
- **分页**：无。`GET /v1/users` 一次返回全部账号，查询三条件均为**客户端过滤**（零 wire 变更），页脚只显示总数/筛选数。
- **无**：新建用户、删除用户、启用/停用操作、管理员强制下线按钮（U244 仅 API，UI 待 D15 批次）、批量操作、排序、导出、服务端分页。

## 2. 菜单与入口

- 侧栏 `#adminNav` 的「用户管理」按钮（`index.html` L61）。仅 `platform:admin` 可见；auditor/developer 隐藏。
- 直达 `#/users`：非管理员 → `routeAllowed` 拒绝 → 「无权访问」页（保留 URL），不发 `GET /v1/users`。
- 列表行「详情」→ 打开弹框（HEAD 不改变 URL；R3 工作树将改为 `#/users/:id` push）。
- 详情弹框内角色下拉是角色修改的**唯一入口**；列表没有任何写控件。

## 3. 操作清单

| #    | 触发                                     | 结果                                                                                                                                                                         | 弹窗/确认                                                                                 | 失败态                                                                              |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 3.1  | 打开 `#/users`                           | `GET /v1/users` → 渲染页头/徽标/查询栏/表格/页脚                                                                                                                             | 无                                                                                        | 「加载失败」+ 错误文本 + 「重试」                                                   |
| 3.2  | 在关键字框输入                           | 即输即筛：显示名或账号的大小写不敏感子串匹配；`input` 事件立即重绘行                                                                                                         | 无                                                                                        | 无网络请求                                                                          |
| 3.3  | 切换角色/状态下拉                        | `change` 立即重绘；角色/状态为精确匹配；三条件 AND                                                                                                                           | 无                                                                                        | 无                                                                                  |
| 3.4  | 点「查询」                               | 兜底重放当前三个控件值（用于未触发 input 的场景）                                                                                                                            | 无                                                                                        | 无                                                                                  |
| 3.5  | 点「重置」                               | 三条件恢复 `query='' / role='all' / status='all'`，重绘全部行；页脚去掉「当前筛选」                                                                                          | 无                                                                                        | 无                                                                                  |
| 3.6  | 筛选无结果                               | tbody 单行空态文案（见 §1）；页脚仍显示「共 N 个账号 · 当前筛选 0 个」                                                                                                       | 无                                                                                        | 无                                                                                  |
| 3.7  | 点行「详情」                             | 打开用户详情弹框；字段来自当前 `users` 数组                                                                                                                                  | 弹框；关闭=「关闭」/Esc/点遮罩；关闭后焦点回到触发按钮                                    | 无                                                                                  |
| 3.8  | 详情内改角色下拉                         | 下拉值**立刻回退**为当前角色；弹出「角色变更」确认框。同值不弹；停用账号直接 return                                                                                          | 确认框文案含「X（username）：普通 → 审计」、role_update 审计、覆盖优先、升级即时/降级断开 | 无                                                                                  |
| 3.9  | 确认升权（非 admin→非 admin 或升 admin） | `PUT /v1/users/{id}/roles {role}` → 成功 toast「已将 <显示名> 的角色更新为<角色>」→ 整页重绘（筛选态由模块级 `userFilter` 保留）→ 详情弹框重绘为新角色，来源翻「管理员覆盖」 | 「确认变更」primary                                                                       | toast「保存失败：<原因>」；随后仍整页重绘并回调刷新弹框，界面回到服务端真值（回滚） |
| 3.10 | 确认降级（admin→非 admin）               | 同上 PUT；后端记 `role_update` metadata `revoked=true` 并 `revokeUserCredentials`，旧 token 下一请求失去管控面（≤60 秒心跳撤销）                                             | 确认按钮 `danger`，文案「管理员 → 审计」「降级将断开该用户当前云会话（≤60 秒）」          | 同 3.9                                                                              |
| 3.11 | 停用账号                                 | 列表/详情正常显示「已停用」；详情角色下拉 disabled，change 处理器也二次拦截                                                                                                  | 无                                                                                        | 无                                                                                  |
| 3.12 | 关闭详情                                 | 同 3.7                                                                                                                                                                       | 无                                                                                        | 无                                                                                  |
| 3.13 | 管理员强制下线（**仅 API，Web 暂无按钮**） | `POST /v1/users/{id}/sessions/revoke` body `{reason?}` → `{ok:true, revokedSessions:N}`。撤销该用户全部 session（epoch+1，旧 access 立即 401；refresh 401 并清 Cookie），并写 `user:<username>` 宿主撤销集合；**不吊销 device**；重复/并发幂等 | 无（API-only；Web 按钮待 D15 批次）                                                        | 403 `PERMISSION_DENIED`（denied 审计）/ 404 `USER_NOT_FOUND` / 503 `AUDIT_CHAIN_BROKEN`（审计不可写则不撤销，fail-closed） |

角色语义（服务端）：

- 页面角色映射：`developer`→`['developer']`；`auditor`→`['developer','platform:auditor']`；`admin`→`['developer','platform:admin']`。
- `roleOverride` 一旦写入即每次登录重算角色：登录时若存在 `roleOverride`，`roles = USER_PAGE_ROLES[roleOverride]`（LDAP 组不推导角色）；`roleSource` 即 `roleOverride ? 'admin-override' : 'default'`（`default` = 首登 `['developer']` 的默认角色；历史服务端曾发 `'ldap'`）。
- 实时生效：access token 为 opaque 键，角色每请求重算；升级不撤销凭证，降级（仅 admin 降出）撤销用户凭证。
- 审计：成功写 `role_update`（from/to/username/revoked）；拒绝写 `role_update` denied（requiredPermission=platform:admin）；被拒的列表读写 `user_list` denied。
- 停用：`requireAuth` 对 `user.status !== 'active'` 返回 null（已签发 token 全部失效）；当前**无任何页面/接口把账号置为 disabled**（停用态仅由数据层产生）。登录对非 active 用户返回 403 `USER_DISABLED`、不签发令牌/Cookie（U228 `39ad743d793`）；角色 PUT 服务端校验 `target.status`，停用账号 409 `USER_DISABLED` + denied 审计（U135 `cbbcb130086`）。

管理员强制下线（U244 / FR-1.6，API-only）：

- 端点 `POST /v1/users/{id}/sessions/revoke`（`cloud-platform/apps/api/src/server.ts:5210-5281`）；body 仅可选 `reason`（≤200 字，请求体上限 4KB，`:320`）。
- 计数语义（U245②）：审计 metadata `revokedSessions` 为目标 session 数（写审计前快照），响应 `revokedSessions` 为本次实际撤销数；远程审计写期间的并发撤销可致 metadata 略高估（安全结果不受影响）。
- 权限与审计：`platform:admin`；非管理员 403 + `session_revoke` denied 审计（`requiredPermission=platform:admin`）。写前经 `auditAllowsMutations` 门禁，审计链不可写时 503 且**不撤销任何 session / 不写宿主撤销集合**（fail-closed）。
- 撤销范围：逐活跃 session `revokeSessionOnce`（epoch+1 → 旧 access 立即 401，refresh 401 并清 Cookie）；`appendRevocation('user', username, 'admin_force_offline')` 让已建 WSS 宿主票据一并失效；**不写 device 撤销**。并发/重复由 `withUserSessionRevokeLock`（`:2996-3022`）串行化：并发只撤一次且只写一条审计；重复请求返回 `revokedSessions:0`，但 leader 每次仍写一条 `session_revoke` 审计（管理员动作必留痕，U244 复审后语义）。
- **Web 暂无按钮**：用户管理页只有「详情」与角色修改，强制下线为 API-only；UI 待 D15 批次（`work-orders/pending-decisions-2026-11-17.md` U244）。
- 测试：`cloud-platform/test/e2e/u244-admin-force-offline.e2e.test.ts`。

## 4. 数据来源

- `GET /v1/users`（admin-only）→ `{ users: [{ id, username, displayName, dept, groups, roles, status, role, roleSource }] }`。
- `PUT /v1/users/{id}/roles` body `{ role }` → `{ ok:true, roles, source:'admin-override' }`；400 `ROLE_INVALID`；404 `USER_NOT_FOUND`。
- `POST /v1/users/{id}/sessions/revoke`（admin-only）body `{ reason? }` → `{ ok:true, revokedSessions }`；403 `PERMISSION_DENIED`；404 `USER_NOT_FOUND`；503 `AUDIT_CHAIN_BROKEN`。
- `GET /v1/me`（刷新会话时读取当前用户角色）。
- 审计：`role_update`、`user_list`、`session_revoke`（管理员强制下线成功/拒绝）。
- 存储：`store.users`（`status: active|disabled`、`roles`、`roleOverride`）；LDAP 登录准入在认证路径，不在此页。

## 5. 已知缺陷与观察

已登记：

- **U81**（🟢）用户管理常用查询条件：设计交付并审定（查询三项 + 只读化 + 详情弹框）。
- **U81b**（🟢）实现令：查询栏四态、只读列表、详情 7 字段、角色确认链复用、来源取服务端真值；6/6 新 e2e + 19/19 回归。
- **U82**（🟢）列表只读、角色仅详情修改、弹框内角色编辑。
- **U74**（⚪）探索归并：搜索/筛选主项已并入 U81 并落地；「用户管理无分页」设计未承诺，仍无分页。
- **U114-D4**（⚪，覆盖缺口）「U81b 筛选态保持 + 停用锁」缺自动化回归（当前 e2e 覆盖筛选四态，但未覆盖角色变更整页重绘后筛选态保持、以及停用账号锁定的自动化断言）。

未登记观察（建议登记）：

1. ~~页头「LDAP 同步正常」是静态徽标，不来自任何同步状态接口；LDAP 故障时仍显示正常。~~ **已修（U145）**：徽标改为读 `GET /v1/users` 加性字段 `ldap.requiredGroup` 的事实性文案（准入组 / 未配置），仅陈述准入配置，不主张同步状态；T37 断言同步改为「LDAP 准入：未配置」并显式禁止「LDAP 同步正常」文案。
2. 角色 PUT 仅前端阻止停用账号，服务端不校验 `target.status`，存在 defense-in-depth 缺口（当前无停用入口，实际不可达）。
3. 无分页：账号量大时一次性传输与渲染；当前规模可接受，登记为容量风险而非功能缺陷。
4. 列表/详情「状态」来源真值存在，但产品没有停用/启用账号的入口，停用态目前只能由数据层产生。

## 6. 测试覆盖

已覆盖（绝对路径）：

- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u67-3-users-page.e2e.test.ts`：原型锚点逐字对照、7 列、查询四态（关键字账号/显示名、角色、状态空态、组合 AND、查询兜底、重置）、只读列表无写控件、详情 7 字段、升权确认链（非 danger）→ PUT → 弹框/列表/来源同步、admin 降级（danger + 断会话文案）、role_update 审计、roleOverride 重登优先、非 admin 403 + denied 审计、降级撤凭证。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts`：审计员侧栏只见审计入口（其余管理入口隐藏）、开发者强制直达 403。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u67-role-authz.e2e.test.ts`：角色授权面。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者管理导航隐藏与强制路由无权访问。
- 证据：`/Users/gongdewei/work/projects/orca/cloud-platform/evidence/u67-3-users-page/`（users-page-structure.json、role-change-audit.json、denied-writes.json、demotion-revocation.json）、`/Users/gongdewei/work/projects/orca/evidence/u81b-fix/`（runs.json：6/6 + 回归 19/19）、`.../evidence/exploratory-r3-users-audit/`。

未覆盖：

- 角色变更后筛选态保持（整页重绘）——U114-D4 点名缺口。
- 停用账号的角色下拉锁定与 change 二次拦截——无自动化。
- 弹框关闭焦点回归、Esc/遮罩关闭路径——u46-3 覆盖通用 dialog，未专门断言本页。
- 深链 `#/users/:id`（R3 工作树新增）尚无基线测试。

## 7. 基线提交

`664a91e0322d90e4d32ce9d092526159c3052854`。工作树 U106-R3 未提交改动会把详情打开改为 URL push；验收若在 R3 合入后执行，请按新提交更新 §1/§2/§3.7。
