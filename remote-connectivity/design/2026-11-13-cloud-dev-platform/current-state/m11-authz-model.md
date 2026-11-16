# M11 · 授权与角色体系（全局角色 × 资源角色）

> **基线提交**：`664a91e0322`（2026-11-16）。
> 代码：平台后端 `cloud-platform/apps/api/src/host-authority.ts`、`store.ts`、`server.ts`（grants/roles 端点）；管理台 `cloud-platform/apps/web/app.js`（详情弹框权限 tab、用户管理页）。
> 设计：`work-orders/u67-authz-refactor-design.md`（含 2026-11-15 审定一/审定二）、`u65-host-grant-semantics-design.md`、`ldap-group-admission-design.md`。

---

## 1. 两层模型（现状共识）

```
平台角色（用户管理页）      = 身份层：管控面/审计面可见性（platform:admin / platform:auditor / developer）
资源角色（详情弹框权限 tab）= 资源层：谁能用哪些项目/主机、有哪些操作（HostGrant / Grant）
有效权限 = 角色判据（管控面） ⊕ 资源授权（项目内/主机内）
管理员角色 ≠ 项目内全权：打开项目仍需显式 open（U40 自授语义保留）
```

## 2. 页面/界面位置

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 主机授权 | 主机详情抽屉，顶部 `.detail-tabs`「信息 \| 权限」 | 权限 tab = 三卡片（查看/控制/管理），唯一主机授权入口 |
| 项目授权 | 项目详情弹框（`openProjectDetail`），同款「信息 \| 权限」tab | 权限 tab = 查看/控制 + 管理（主机推导只读卡） |
| 全局角色 | 导航「用户管理」页（admin-only） | 列表只读；角色只在用户详情弹框下拉修改；变更确认 → `PUT /v1/users/{id}/roles` |
| 旧「成员与权限」页 | — | 已整体删除（页面+导航+旧路由渲染 404，U106 T6 修订），符合 U67 审定二 |
| 深链 | `projects|hosts|users/<id>` + `?tab=perms` | U106 R3 深链（已派/在途，见 U106 行） |

## 3. 全局角色（用户管理页）

| 页面角色 | 存储 `roles` | `ROLE_PERMISSIONS` | 管控面 | 审计面 | 项目/主机使用面 |
| --- | --- | --- | --- | --- | --- |
| 普通 | `['developer']` | `[]` | 全部隐藏；直访 403 + denied 审计 | 无 | 按资源授权；持 `provision` 可自助建项目 |
| 审计 | `['developer','platform:auditor']` | `['platform:auditor']` | 不可管控 | 审计查询/状态/校验；目录仍 admin-only | 同普通（不授予项目操作位） |
| 管理员 | `['developer','platform:admin']` | `['platform:admin']` | 全管控面；三卡片读写、用户管理、策略、主机生命周期 | 同审计 | 项目内仍按资源授权（admin 旁路仅管控面；U65 主机只读上限对 admin 豁免） |

**实现要点**：

- `User.roleOverride?: 'developer'|'auditor'|'admin'`（`store.ts:14`）：非 null 时登录 seed/重算以覆盖为准；页面写覆盖即设该字段。
- 端点 `PUT /v1/users/{id}/roles`（admin-only）：400 `ROLE_INVALID`、404 `USER_NOT_FOUND`、403 + denied 审计；写 `role_update` 审计（`from/to/username/revoked`）；管理员降级调用 `revokeUserCredentials(username,'role_changed')`（≤60 s 心跳闭环），升级不撤销。
- 服务端每请求按 store 活用户实时判定角色（token 为 opaque 键，非 roles 快照）；前端导航在登录响应快照上渲染，角色变更后旧页面导航可能陈旧，直到 `/v1/me` 或 403 刷新。
- LDAP 只做登录准入门槛（`ORCA_CLOUD_LDAP_REQUIRED_GROUP`），**组→角色映射已废除**；新用户首登一律普通，升权走用户管理页覆盖。

## 4. 资源角色（三卡片）与位映射

### 4.1 存储形状（未变）

- 主机：`HostGrant { hostId, subjectType, subjectId, permissions: ('provision'|'maintain'|'view')[] }`，平台内部，**不进票据**。
- 项目：`Grant { projectId, subjectType, subjectId, permissions: Permission[] }`，位集合 `open/terminal/agent/file:read/file:write/browser/download`。
- 同一主体同一资源只有一行；卡片是位分组视图，加入卡片 = 位并集写回整行（PUT 整行替换）。

### 4.2 当前实现（HEAD）

| 资源 | 卡片 | 写入位 | 效果 |
| --- | --- | --- | --- |
| 主机 | 查看 | `view` | 只读：可见该主机全部非归档项目；项目内上限 `open+file:read`；不可建/维护/终端/Agent/编辑/浏览器/下载 |
| 主机 | 控制 | `view + provision` | 全权（U65 审定：**不含 maintain**）：六操作位供给 + 可创建/登记 |
| 主机 | 管理 | `provision + maintain` | 可创建/登记 + 维护；不推导可见性，不授予项目内操作位 |
| 项目 | 查看 | `open + file:read` | 项目可见/可打开、文件浏览与预览 |
| 项目 | 控制 | `terminal + agent + file:write + browser + download` | 项目内操作位；`download` 仍受项目/全局下载策略约束 |
| 项目 | 管理 | 无项目级位 | 只读派生：列出按 U65 在本项目获得权限的主机级主体（来源视图，写入口在主机弹框；不扩大） |

- 卡片匹配规则：`row.permissions` 与卡片 `bits` **任一相交**即入卡；行尾徽标显示合成级别（主机：全权/全权+维护/只读/管理/其他；项目：查看/控制拼接）。
- 无卡片认领的历史/直写位组合进「其他位组合」卡（可移除、不可再加卡）。
- 即时保存：每次添加/移除 = 一次 PUT；同主体已在其它卡时先弹覆盖确认；失败 toast + 重拉 GET 重绘；降级文案声明断会话 ≤60 s。
- 主机授权端点：`GET/PUT /v1/hosts/{id}/grants`、`PUT /v1/hosts/{id}/provision-policy`，全部 admin-only；拒绝落 `host_grant_read`/`host_grant_update` 审计（含被拒主体）。
- 项目授权端点：`GET/PUT /v1/projects/{id}/grants`，admin 或项目创建者（self-service）可写；拒绝落 denied 审计。

### 4.3 有效权限计算（U65，`host-authority.ts`）

```ts
hostBits = 用户行 ∪ 组行
hostAccessLevel: view+provision → 'full'；仅 view → 'read-only'；否则 null
（full 判定不含 maintain；maintain 只影响维护端点）
effectiveProjectPermissions(project,user,isAdmin):
  isAdmin → 项目位 P（旁路，不裁剪）
  full → 六操作位 ∪ (P ∩ {download})
  read-only → ['open','file:read']（保底 + 上限）
  null → P
canCreateProjectOnHost = isAdmin || hostBits.has('provision')
```

语义结论：

1. **min 上限**：只读主机的项目内有效位被强制裁剪为 `open+file:read`，即使项目行授予 terminal/file:write 也不进入票据。
2. **不扩大**：项目级授权永不产生主机级可见性/创建/维护；仅 `provision`/`maintain` 的混合位不推导项目可见性。
3. **全权是来源**：`view+provision` 给该主机全部非归档项目可见性与六操作位；`download` 只继承项目显式位 + 策略，不由主机推导。
4. **判定默认拒绝**：可见性/打开/签票统一 `effectiveProjectPermissions(...).includes('open')`；宿主按票据 `perms` 的方法映射逐方法拒绝（`cloud-rpc-permission.ts`），宿主无第二套主机级判断。
5. **审计**：授权写 `grant_update` / `host_grant_update`；拒绝写 denied；角色写 `role_update`。

## 5. 现状 vs 设计（尚未实现/有偏差）

| 设计项 | 现状 | 结论 |
| --- | --- | --- |
| U67 审定二「位置即权限 · 层级单卡」 | 当前仍是**位并集 + 合成徽标 + 同主体可出现在多张卡** | **未实现**（U67 🔴 / U67b 🔴）；验收按现状不得宣称层级单卡 |
| 主体行只留名字+类型徽标，删除权限词尾注 | 当前 chip 仍显示合成级别 badge | **未实现** |
| 项目「管理」卡 = 主机推导只读 | 已实现（`projectDerivedCardHtml`） | 已实现 |
| 主机卡「控制」含创建能力 | 已实现且文案注明 | 已实现 |
| 60 s 撤凭证常驻提示 | 已实现（文案+断会话声明） | 已实现；真实撤销链路归属 U65 C10（主机授权收缩）需核对是否落地 |
| 用 `level` 加性字段消费主机级别 | 当前前端按位过滤（`view`/`provision`），未用 level | 两态等价，无缺口 |
| 主机授权 UI 仅两级 | 当前三卡片（含管理卡），符合 U67 卡片模型 | 与 U65 文档旧「两级」表述以 U67 为准 |
| 用户管理查询/详情弹框 | 已实现（U81/U82）：关键字/角色/状态筛选、列表只读、详情改角色 | 已实现 |

## 6. 数据来源

| 面 | API |
| --- | --- |
| 身份 | `POST /v1/auth/login`、`GET /v1/me`、`PUT /v1/users/{id}/roles`、`GET /v1/users`、`GET /v1/directory` |
| 主机授权 | `GET/PUT /v1/hosts/{id}/grants`、`PUT /v1/hosts/{id}/provision-policy`、`GET /v1/hosts/available`（`provisionAllowed`/`accessLevel` 加性字段） |
| 项目授权 | `GET/PUT /v1/projects/{id}/grants`、`GET /v1/projects`（`permissions`/`hostAccess` 加性字段） |
| 生效 | 票据 `perms`（connect 时计算）→ 宿主 `cloud-rpc-permission` 方法映射 |
| 审计 | `grant_update`、`host_grant_update`、`host_grant_read`、`role_update`、`method_denied`、各类 denied |

## 7. 已知缺陷（台账链接）

| U | 状态 | 说明 |
| --- | --- | --- |
| [U65](../defect-ledger.md#L71) | 🔴 | 主机授权语义深化总项；后端 `effectiveProjectPermissions`/`hostAccessLevel` 已实现，但下载二期宿主硬拦、C10 撤销链路、UI 终验未闭合 |
| [U67](../defect-ledger.md#L77) | 🔴 | 授权方案重构；三卡片/用户页已实现，审定二「位置即权限·层级单卡」未实现 |
| [U67b](../defect-ledger.md#L79) | 🔴 | 用户复核 UI 不达标（详情页授权入口/卡片形态）；当前实现需按审定二重做 |
| [U45](../defect-ledger.md#L52) | 🟢 | 授权矩阵 12 格补齐断言 |
| [U61](../defect-ledger.md#L67) | 🟢 | authz 组合批：open 口径统一、路径占用键含 hostId 等 |
| [U62](../defect-ledger.md#L68) | 🟢 | denied 审计字段/policy 等打磨 |
| [U69a](../defect-ledger.md#L80) | 🟢 | LDAP 方向撤回：分组=登录门槛，角色平台内管理 |
| [U106](../defect-ledger.md#L107) | 🟡 | 详情深链 `?tab=perms` R3 在途 |

**验收注意**：U65 原文矩阵（全权=provision+maintain+view）已被 2026-11-15 审定修订为「全权=`view+provision`，缺 maintain 不降级」；当前代码与卡片均按修订后语义，验收不得按旧表判定。

## 8. 测试覆盖

| 类型 | 文件 |
| --- | --- |
| 后端单测/集成 | `cloud-platform/test/e2e/host-authorization.e2e.test.ts`、`u67-role-authz.e2e.test.ts`、`u67-3-users-page.e2e.test.ts`、`u72-u73-audit-role-race.e2e.test.ts`、`user-grant-resolution.e2e.test.ts`、`u62-authz-polish.e2e.test.ts`、`admin-authorization-directory.e2e.test.ts`、`admin-denial-audit.e2e.test.ts`、`web-admin-gating.e2e.test.ts`、`web-admin-self-grant.e2e.test.ts`、`web-host-permission-drawer.e2e.test.ts`、`web-grant-subject-picker.e2e.test.ts` |
| 旅程 | `tests/e2e/cloud-golden-journey-desktop.spec.ts`、`cloud-golden-journey-orca-web.spec.ts`、`cloud-golden-journey-git-and-restart.spec.ts` |
| 报告 | `test-reports/u67-doc-review.md`、`evidence/aa7-coverage/matrix-coverage.json` |

**未覆盖/薄弱**：审定二层级单卡的 e2e（当前无实现）、主机授权收缩触发凭证撤销的端到端、下载二期宿主硬拦、roleOverride 与 LDAP 再登录竞态已有 `u72-u73` 覆盖。
