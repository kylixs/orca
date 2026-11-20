# 管理授权补全设计 · 项目权限分配 / 主机权限分配 / admin 打开项目语义

> 状态：设计稿，待主会话审定后派实现代理（本令只设计不实现，不改任何代码）
> 日期：2026-11-14 · 依据：用户裁定「管理员有任何资源的分配权限，目前缺少项目、主机权限分配相关功能」· defect-ledger U40 · requirements.md §2.1 角色 / FR-1.5 / FR-3.1 / FR-3.7 / FR-4.x / FR-9.3 / FR-9.7
> 现状基线：`cloud-platform/apps/api/src/server.ts`（HEAD `00f8354c48f`；行号按 2026-11-14 盘点时的工作树实读，并行通道在改 server.ts 时引用需复核）· `cloud-platform/apps/api/src/store.ts` · `cloud-platform/apps/web/app.js`（M120b 矩阵已提交形态）· `packages/contract/src/credential.ts` / `permissions.ts`
> 风格口径：docs/STYLEGUIDE.md **不适用**——cloud-platform 独立管理台，遵循 `apps/web` 既有惯例；契约变更全部**加性可选**，wire 兼容（Remote Wire Compatibility 纪律）

---

## 0. 结论摘要

| 域                      | 缺口                                                                                                                           | 接口结论                                                                                                                                        | 改动域                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A 项目权限分配          | 授权端点只有一个（项目×单主体×7 位），**无主体目录、组名不校验（拼错即死行）、permissions 数组服务端不校验、PUT 拒绝不落审计** | 新增 `GET /v1/directory`（admin）+ 三个服务端校验/审计补齐；零字段变更既有端点                                                                  | `server.ts`（共享主体解析器）+ `app.js`（datalist）       |
| B 主机权限分配          | **完全没有主机级授权概念**：`/v1/hosts/available` 全员可见、自助建项目对所有登录者开放、维护/吊销仅 admin                      | 新增 `HostGrant`（provision/maintain/view 三位）+ `PUT /v1/hosts/{id}/grants` + `provisionPolicy` 开关；**宿主心跳/契约零变更**（纯平台侧消费） | `server.ts` + `store.ts` + `app.js`（主机 drawer 分配区） |
| C admin 打开项目（U40） | admin 可见全部项目但 `perms:[]` 发票→宿主 `permission_lost`                                                                    | **裁定：自授流程**（非隐式 open）——服务端**零改动**，仅 web 端「授权并打开」入口复用既有 `PUT /grants`                                          | 仅 `app.js`                                               |

三域共享一个前提（用户裁定）：**admin 对任何资源持有分配权**。该权已在项目域成立（`PUT /grants` 仅查 `isAdmin`，任意项目可用），本设计把它补到主机域，并让「使用权」继续走显式授权（默认拒绝不变，FR-9.7/AC-03）。

---

## 1. 现状盘点（只读核实，行号为基线版）

### 1.1 `platform:admin` 能力全集（已有 / 缺失）

| 能力                 | 端点                                                                                                                                                                                               | 门禁                                                    | 状态                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 角色                 | `ROLE_PERMISSIONS`（server.ts:315）只映射 `platform:admin→['platform:admin']`；`isAdmin()`（:321）是全部管控面判定的唯一开关；角色来自 LDAP 组 `platform-admins`（**仅首次登录播种**，:1089-1091） | —                                                       | ⚠️ 角色生命周期缺口（§1.6-⑥）                                                                                                            |
| 项目 CRUD            | `POST /v1/projects`（:1455 admin-only，拒绝落 denied 审计）、`PUT /v1/projects/{id}`（:1761）、archive/restore（:1933 admin 或创建者）                                                             | admin                                                   | ✅ 已有                                                                                                                                  |
| **项目授权 PUT**     | `PUT /v1/projects/{id}/grants`（:1866）                                                                                                                                                            | `isAdmin() \|\| roles.includes('project:owner')`        | ✅ **admin 对任意项目可用**（只查全局角色，不查项目归属）；⚠️ `project:owner` 是幻影角色——全仓库无任何赋值点，实际= admin-only（§1.6-⑤） |
| 项目授权 GET         | `GET /v1/projects/{id}/grants`（:1851）                                                                                                                                                            | 项目 `open` 持有者或 admin（:1734 的 `adminAccess` 块） | ✅ 已有；⚠️ open 持有者可读全项目 ACL（§1.6-④）                                                                                          |
| 项目策略             | `PUT /v1/projects/{id}/policy`（:2038）+ 全局 `PUT /v1/policies/download`（:2562），均 `denyPrivileged`                                                                                            | admin                                                   | ✅ 已有                                                                                                                                  |
| 宿主注册令牌         | `POST /v1/hosts/tokens`（:2161）                                                                                                                                                                   | admin                                                   | ✅ 已有                                                                                                                                  |
| 宿主维护             | `POST /v1/hosts/{id}/maintenance`（:2404）                                                                                                                                                         | admin                                                   | ✅ 已有；**无委派**                                                                                                                      |
| 宿主吊销             | `DELETE /v1/hosts/{id}`（:2447）                                                                                                                                                                   | admin                                                   | ✅ 已有；无委派（**建议保持**）                                                                                                          |
| 宿主/中继列表        | `GET /v1/hosts`（:2126）、`GET /v1/relays`（:2104）                                                                                                                                                | admin                                                   | ✅ 已有                                                                                                                                  |
| 审计查询/校验        | `/v1/audit/events · status · verify`（:2480-2548）                                                                                                                                                 | admin 或 `platform:auditor`                             | ✅ 已有                                                                                                                                  |
| 签名密钥轮换         | `POST /v1/admin/signing-keys/rotate`（:1395）                                                                                                                                                      | admin                                                   | ✅ 已有                                                                                                                                  |
| **主机授权（分配）** | —                                                                                                                                                                                                  | —                                                       | ❌ **缺失：无任何主机级授权端点与数据模型**                                                                                              |
| 用户/组目录          | —                                                                                                                                                                                                  | —                                                       | ❌ **缺失：无 `/v1/users`、无组枚举**；授权矩阵靠自由文本输入                                                                            |
| 角色分配             | —                                                                                                                                                                                                  | —                                                       | ❌ **缺失**：FR-1.5（P1）「管理员可覆盖单个用户角色」无端点无 UI                                                                         |

### 1.2 grants PUT 的主体可用性（用户问题直答）

**已对任意项目可用（admin）**：`PUT /v1/projects/{id}/grants` 的判定只有 `isAdmin(authed.user) || roles.includes('project:owner')`（server.ts:1868），与该 admin 是否创建/被授权该项目无关；且外层路由守卫（:1735-1737）对 admin 放行所有项目。所以「admin 分配任意项目权限」**今天就能走通**——缺口不在端点门禁，而在分配的**质量与可发现性**（目录、组校验、位校验、拒绝审计，§1.6）与主机域的空白（§1.4）。

非 admin 路径：`project:owner` 无赋值点 → 实际无人可走；且该分支**不校验被授权项目归属**（若将来赋值该角色，任何持有者可改任意项目 ACL）——补全时必须一并处理（§3.1-A6）。

### 1.3 项目侧：M120b 矩阵已覆盖什么、组从哪来

| 项                 | 现状                                                                                                                                                                                                                                                                                       | 引用                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 矩阵 UI            | 「成员与权限」页（admin 路由，app.js:83 `ADMIN_ROUTES`）左侧项目列表（admin 经 `loadProjects()` 含归档拿全量）+ 右侧 7 位可编辑矩阵，行级草稿→确认→逐行 `PUT`（全量数组替换）                                                                                                              | app.js:789-816、818-827、925-962    |
| 添加授权           | 自由文本输入 + 类型下拉（默认 group）；新行 born with `['open']`；未知**用户** 400 `USER_NOT_FOUND` toast 不清矩阵                                                                                                                                                                         | app.js:880-884、986-1008            |
| **组的来源**       | LDAP profile `groups`（登录时合并进 `user.groups`，server.ts:1095）；`Grant.subjectType='group'` 匹配 `user.groups.includes(subjectId)`（store.ts:169-179）                                                                                                                                | —                                   |
| **组管理 UI**      | ❌ **不存在**（M120 设计 §3.4 已如实声明「FR-3.1 负责人组/可见组无创建字段」）：无组列表、无组创建（组是 LDAP 事实，平台不该创建）、**无组名校验**——`PUT /grants` 对 group 主体只 trim 不验证（server.ts:1872-1873），拼错组名静默落一行**永不匹配的死授权**，矩阵显示已授予而无人获得权限 | server.ts:1872、app.js:881          |
| 用户 vs 组入口差异 | 用户：输入用户名→服务端解析为 user id（M116-QA-001 修复）→可命名（GET 回带 `username`）→变更只断该用户会话；组：输入组 ID 原样入库→不可命名→变更断开**该项目全部**在线会话（宿主无法解析组成员，AC-12）                                                                                    | server.ts:1880-1929、app.js:907-923 |

### 1.4 主机侧：现有权限概念与语义空白

现模型中「主机」只有**运维状态**概念，没有**授权**概念：

| 「主机权限分配」的自然语义 | 现有字段/端点                                                                                                                                                                                                                                           | 现状判定                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 谁可**看**主机             | `GET /v1/hosts` admin-only（全量含指纹/E2EE 公钥/地址）；`GET /v1/hosts/available` **所有登录者**（server.ts:2146-2159，刻意 credential-free：id/name/online/provisionable/projectDirs）                                                                | ⚠️ 二值且无每人差异：开发者看得见「有哪些主机」但看不到详情；无 per-user 可见性控制                 |
| 谁可**自助建项目**         | `POST /v1/projects/self`（server.ts:1601）：门禁=登录 + 主机在线 + `projectsRoot` 非空（`selectSelfServiceHost`，project-self-service.ts:65-115）+ 每人 20 个上限。`/v1/hosts/available` 的 `provisionable: Boolean(h.projectsRoot)` 是唯一「可建」信号 | ❌ **所有登录用户可在所有 provisionable 主机上建**，无按主机/按主体的收口                           |
| 谁可**维护**主机           | `POST /v1/hosts/{id}/maintenance`（:2404）admin-only；心跳的 `maintenance` 下行（:2398）宿主据此拒新连接                                                                                                                                                | ❌ 无委派：平台运维员若非 `platform-admins` 组成员连维护都做不了（只能给全量 admin 角色，过度授权） |
| 谁可**注册/吊销**主机      | 令牌 `POST /v1/hosts/tokens`、吊销 `DELETE /v1/hosts/{id}` 均 admin-only                                                                                                                                                                                | ✅ 建议**保持** admin-only（注册与吊销是平台级信任操作，FR-4.1/4.6）                                |

### 1.5 U40 现状（admin 打不开项目的根因链）

1. `GET /v1/projects` 对 admin 返回全部项目（:1446 admin 绕过 ACL）→ admin 看得到；
2. `POST /v1/projects/{id}/web-handoff` → `handleConnect` 的凭证 `perms = store.effectivePermissions(...)`（server.ts:2883）——admin 无授权行时 `[]`；
3. 票据携带 `perms:[]` 到宿主，`decideMethod` 全拒（permissions.ts:70-71）→ web 端 `permission_lost`/`PROJECT_FORBIDDEN`（defect-ledger U40 实测 403）；
4. web 端已知此缺口并只做了**呈现缓解**：权限列显示「管理员可见（未授权）」、「打开」禁用并提示「请先在成员与权限中授权」（app.js:239-257，M116-QA-010）——即当前产品语义已经是「admin 需先被授权才能打开」，只是没有一键路径。

U40 的环境侧处置（种子补 admin 授权）已落地；本设计 §3.3 给产品语义裁定。

### 1.6 顺带核实的授权卫生缺口（本设计一并补）

| #   | 缺口                                                                                                         | 位置                | 影响                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------- |
| ①   | `PUT /grants` 拒绝**不落审计**（裸 `error(403)`，未走 `denyPrivileged`）                                     | server.ts:1869      | 违反 AC-18「被拒的管理操作写入审计」口径；与 POST /v1/projects 的拒绝路径（:1456-1465）不一致        |
| ②   | `permissions` 数组**服务端不校验**，原样入库                                                                 | server.ts:1874-1876 | 杂串落成哑权限位（U33 已在客户端白名单，权威校验缺位）；无法靠枚举审计                               |
| ③   | group 主体不校验存在性 → 死授权行                                                                            | server.ts:1872-1873 | 矩阵显示已授予、实际无人命中（比 USER_NOT_FOUND 修复前的用户死行更隐蔽，因为组无「已删除」标识逻辑） |
| ④   | `GET /grants` 对项目 `open` 持有者开放全量 ACL（全部主体+位）                                                | server.ts:1734/1851 | 信息面=项目内成员名单；**裁定保持**（矩阵需要；风险低），文档化即可                                  |
| ⑤   | `project:owner` 幻影角色：无赋值点，且该分支不查项目归属                                                     | server.ts:1868      | 死代码误导 + 将来启用即越权口子（§3.1-A6 裁定）                                                      |
| ⑥   | 角色生命周期：角色仅首次登录播种（:1089-1091），此后 LDAP 组变动**不回灌**——`platform-admins` 移除成员不降级 | server.ts:1081-1095 | FR-1.5 P1 的覆盖缺口；本设计**不修**（域外），登记开放问题 §9                                        |

---

## 2. 目标授权矩阵（角色 × 资源 × 动作）

图例：✅ 现状已有 · 🔨 本设计补齐 · ➖ 保持拒绝 · (P2) 本设计给最小契约、建议缓议

| 资源 | 动作                                                  | platform:admin                                     | developer（未授权）                                                                        | developer（被授权）                           |
| ---- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 项目 | **分配**（改 ACL）                                    | ✅ 任意项目 `PUT /grants`                          | ➖（现状即拒，补 denied 审计 🔨A3）                                                        | (P2) 持 `manage` 位可管本项目                 |
| 项目 | **使用**（open/terminal/agent/file/browser/download） | 🔨 C：自授后持有（默认拒绝不破）                   | ➖ 404 不泄露                                                                              | ✅ 按授权位                                   |
| 项目 | **管理**（CRUD/策略/归档）                            | ✅                                                 | ✅ 自助建/归档本人项目（现状保持）                                                         | ➖                                            |
| 主机 | **分配**（主机授权 + 自助开关）                       | 🔨 B：`PUT /v1/hosts/{id}/grants`、provisionPolicy | ➖ 403 + denied 审计                                                                       | (P2) `view/maintain` 被授予者只读看自己的授权 |
| 主机 | **查看**                                              | ✅ `GET /v1/hosts` 全量                            | ✅ `/v1/hosts/available` 精简（现状保持，不收紧）                                          | (P2) `view` 委派可看详情                      |
| 主机 | **自助建项目**                                        | ✅ 不受限                                          | 🔨 B：`provisionPolicy=open`（默认，现状零回归）时可用；`restricted` 时需 `provision` 授权 | 🔨 B：restricted 主机上持 `provision` 者可用  |
| 主机 | **维护**                                              | ✅                                                 | ➖                                                                                         | (P2) 持 `maintain` 者可进/出维护              |
| 主机 | **注册 / 吊销 / 令牌**                                | ✅                                                 | ➖                                                                                         | ➖（平台级信任操作，不委派）                  |
| 平台 | 策略 / 审计 / 中继 / 密钥 / 角色                      | ✅                                                 | ➖                                                                                         | ➖（角色分配属 FR-1.5，§9 开放）              |

分配类动作全部 admin-only（用户裁定）；被授权者只获得**使用/维护**类动作。所有新增写端点：`requireAuth` → admin 判定（复用 `denyPrivileged`，拒绝落 denied 审计）→ `auditAllowsMutations`（写前审计 fail-closed）→ `recordAudit`。

---

## 3. 方案设计

### 3.1 A · 项目权限分配补全

**A1 主体目录 `GET /v1/directory`（新增，admin-only）**

```
GET /v1/directory → 200 {
  users:  [{ id, username, displayName, dept }],   // store.users 全量（登录过的人）
  groups: [string]                                  // ∪ user.groups ∪ 现有 grant 组 subjectId，排序去重
}
```

- 为什么不接 LDAP 枚举：`LdapAdapter` 仅有 `authenticate`（ldap.ts:13-15），Mock/生产适配器都无 search 能力；目录从平台已知事实（登录过的用户与组）派生，零新依赖、Mock/生产同一实现。生产接 LDAPS search 属 §9 开放问题。
- 403 `PERMISSION_DENIED` + denied 审计（`denyPrivileged`，eventType `directory_read`）。
- UI：授权矩阵「添加授权」输入框挂 `<datalist>`（`grantType=user` 列用户名+显示名，`=group` 列组），自由输入仍允许（服务端仍裁决）——**单一控件，不新增弹层**。

**A2 组主体校验（消灭死行）**：`PUT /grants` 在 `subjectType==='group'` 时，用与 A1 同源的已知组集合校验，未命中 → `400 GROUP_NOT_FOUND`（message 对齐 `USER_NOT_FOUND`：'组不存在或平台未见过该组。'），**拒绝且不落行**。解析函数提取为共享 `resolveGrantSubject(store, subjectType, subjectId)`（A1/A2/§3.2-B2 三处复用）。

**A3 permissions 白名单 + 拒绝审计**：

- `PUT /grants`：数组每个元素必须 ∈ 契约 7 位（credential.ts:11-18），否则 `400 GRANT_PERMISSION_INVALID`（数组整体拒绝，不部分落盘——PUT 是行级全量替换语义，天然可整体拒）。
- admin 判定失败改走 `denyPrivileged(res, traceId, user, { eventType: 'grant_update', targetType: 'project', targetId, permission: 'platform:admin' })`——替换 server.ts:1869 的裸 error，一行改动补齐 AC-18。

**A4 UI 侧（`app.js`）**：datalist（A1）；`GROUP_NOT_FOUND` 复用既有 toast 不清矩阵路径（W2-M-1 回归语义）；组死行不可能再新增（服务端拒绝），既有死行仍显示「已删除用户」式徽标逻辑不动。

**A6（P2，建议缓议）项目 owner 委派**：契约 `Permission` 增 `'manage'`（**wire 安全**：`decideMethod` 无规则引用它，老宿主收到多余位是惰性位，permissions.ts:56-73 首个匹配规则决定放行）；`PUT /grants` 分支改为「admin 或对该项目持 `manage` 者」，且被授予者只能授出**自身持有位去掉 `manage`**（防权限升级）。启用前提：宿主侧回归（`terminal-only 票据` 族）+ FR-1.5 角色模型先收敛。**本设计不排实现令。**

### 3.2 B · 主机权限分配（推荐最小语义）

**B1 数据模型（`store.ts`，平台内部结构，不上行到宿主）**

```ts
export type HostPermission = 'provision' | 'maintain' | 'view'
export type HostGrant = {
  hostId: string
  subjectType: 'user' | 'group'
  subjectId: string // user id（解析同项目授权）/ 组名
  permissions: HostPermission[]
}
// Store 增：hostGrants: HostGrant[]；Host 增可选字段 selfServiceProvision?: 'open' | 'restricted'
```

- `Host.selfServiceProvision` 缺省=`'open'`=**现状语义**（所有登录者可在该机自助建项目）→ 存量行为零回归、旧数据零迁移。
- **宿主心跳/注册 wire 零变更**：该字段与 HostGrant 只被平台消费（自助端点、available、维护端点都在平台），宿主无需知道。
- `view` 位 v1 不接端点（`GET /v1/hosts` 保持 admin-only），仅占模型位，避免将来加位再动契约。

**B2 端点（`server.ts`，全部加性新路由）**

| 端点                                  | 门禁  | 语义                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/hosts/{id}/grants`           | admin | 列主机授权（user 行带 username，复用项目 GET 的解析呈现）                                                                                                                                                                                                                                                                                           |
| `PUT /v1/hosts/{id}/grants`           | admin | body `{subjectType, subjectId, permissions}`；user 经 `resolveGrantSubject`（`USER_NOT_FOUND`）；group 经已知组集（`GROUP_NOT_FOUND`）；permissions ⊆ 三位（`400 HOST_GRANT_PERMISSION_INVALID`）；空数组=删行；写前审计 `host_grant_update`；变更后对 user 主体 `revokeUserCredentials` 不需要（主机位不进凭证）——**不触发凭证撤销**，语义注释写明 |
| `PUT /v1/hosts/{id}/provision-policy` | admin | body `{mode: 'open' \| 'restricted'}`（`400 HOST_PROVISION_POLICY_INVALID`）；审计 `host_provision_policy_update`（含 mode）                                                                                                                                                                                                                        |

**B3 消费点（三处，全部加性判定）**

1. `POST /v1/projects/self`（:1652 `selectSelfServiceHost` 之后）：目标主机 `selfServiceProvision==='restricted'` 且非 admin 且无该主机 `provision` 授权（user 直授或经组）→ `403 HOST_PROVISION_FORBIDDEN`（'该主机已限制自助建项目，请联系管理员。'），审计 `project_create/denied` 带 `reason:'HOST_PROVISION_FORBIDDEN'`。判定函数 `hasHostPermission(store, hostId, user, 'provision')` 放 `project-self-service.ts`（与 `selectSelfServiceHost` 同域，测试同套件）。
2. `GET /v1/hosts/available`（:2146）：每台**加性可选字段** `provisionAllowed: boolean` = `provisionable && (mode==='open' || admin || granted)`。旧客户端不读该字段，行为不变；web 前端用它在自助建项目下拉禁用+注明原因（替换现在「选了才报 409」的体验）。
3. `POST /v1/hosts/{id}/maintenance`（:2404）：`isAdmin || hasHostPermission(...,'maintain')`；委派路径审计 metadata 加 `via:'host_grant'`。**吊销（DELETE）不委派**，保持 admin-only。

**B4 UI（`app.js`）**：主机页 `showHost` drawer（:705-743）追加「权限分配」section——`provisionPolicy` 开关（open/restricted 单选，保存调 B2）+ 三位矩阵（主体×provision/maintain/view），完全复用项目矩阵的草稿-确认-逐行 PUT 模式与样式；断开提示对主机位改为「无需断开会话」（不撤凭证）。

### 3.3 C · U40 裁定：admin 打开项目 = 自授流程（推荐），隐式 open 备选否决

|                          | **自授流程（推荐）**                                                             | 隐式 open（admin connect 时兜底位）                                                                |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 默认拒绝（AC-03/FR-9.7） | 保持：使用权仍来自显式授权行                                                     | 破：`GET /grants` 矩阵显示「未授权」而凭证携带权限，M116-QA-010 的缓解列（app.js:239-247）变成说谎 |
| 宿主/契约                | **零改动**（票据语义、`decideMethod`、wire 全不动）                              | 票据语义变化需宿主侧回归；审计无法区分「授权的」与「admin 兜底的」位                               |
| 可回退性                 | 授权行可见、可移除、可审计（`grant_update` 既有事件，actor=admin，subject=本人） | 隐式权无法「移除」，追责与排查都落在代码语义里                                                     |
| 实现面                   | **服务端 0 行**；web 端一个入口                                                  | server.ts handleConnect + 项目列表呈现 + 审计语义三处                                              |
| 用户体验                 | 多一次确认点击（可接受：打开的是**别人的项目**，本就该留痕）                     | 少一次点击                                                                                         |

**推荐实现（仅 `app.js`）**：

- `openDisabledReason(p)` 的 admin 分支（:253-255）从「禁用」改为渲染次级按钮 `授权并打开`（`data-self-grant="${p.id}"`）：确认框列出将授予本人的五位 `['open','terminal','agent','file:read','file:write']`（与自助项目默认集一致，server.ts:1719 同源）+「保存将断开你当前全部云会话」（user 行变更既有文案）→ `PUT /grants {subjectType:'user', subjectId:<自己用户名>, permissions:[五位]}`（服务端既有 username→id 解析，:1883-1888）→ 成功后直接 `openProjectWorkspace(p.id)`（:373）。
- `orcaWebEntry`（:329-339）同样补 admin 自授入口（现条件 `p.permissions.includes('open')` 对未授权 admin 隐藏 Orca Web 按钮）。
- 审计不新增事件：复用 `grant_update`（可选加性 metadata `selfGrant:true`）；矩阵/审计/凭证三者保持单一事实源。
- 与 U40 环境侧种子授权的关系：种子是演示便利；产品语义以本节为准（未授权 admin 走自授），种子可留可清。

### 3.4 明确不做（非目标）

- 组的创建/改名/删成员 UI——组是 LDAP 事实（FR-1.5），平台只做**引用与校验**；M120 §3.4 缺口以「目录+校验」方式闭合，不引入平台侧组存储。
- 用户角色分配端点（FR-1.5 P1 的「管理员可覆盖单个用户角色」）——域外，§9 开放问题。
- 主机「谁可看」的 per-user 隔离（`/v1/hosts/available` 保持全员）——收紧会破坏 FR-3.7 既有自助体验，与「加性优先」冲突。
- 项目创建表单内联授权字段（M120 §3.4/R3 已裁定不进表单，维持）。

---

## 4. 契约与 UI 改动清单（文件级 / 端点级）

| 文件                                   | 改动                                                                                                                                                                                                                                                                                | 性质                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/api/src/store.ts`                | `HostPermission`/`HostGrant` 类型；`Store.hostGrants`；`Host.selfServiceProvision?`                                                                                                                                                                                                 | 加性；平台内部                                               |
| `apps/api/src/server.ts`               | `GET /v1/directory`；`GET/PUT /v1/hosts/{id}/grants`；`PUT /v1/hosts/{id}/provision-policy`；`PUT /v1/projects/{id}/grants` 补组/位校验与 `denyPrivileged`；`/v1/hosts/available` 加 `provisionAllowed`；`/v1/projects/self` 补 provision 门禁；`/v1/hosts/{id}/maintenance` 补委派 | 新路由加性；既有端点只加**拒绝分支**与**可选读字段**，线兼容 |
| `apps/api/src/project-self-service.ts` | `hasHostPermission(store, hostId, user, perm)`                                                                                                                                                                                                                                      | 新增纯函数                                                   |
| `apps/web/app.js`                      | 授权矩阵 datalist；`GROUP_NOT_FOUND`/`GRANT_PERMISSION_INVALID` toast；主机 drawer「权限分配」区；admin「授权并打开」入口（工作台卡片/我的项目行/Orca Web）                                                                                                                         | 既有页面内增量                                               |

端点门禁基线不变量（测试钉住）：`GET /v1/hosts`、`DELETE /v1/hosts/{id}`、`POST /v1/hosts/tokens`、`/v1/admin/signing-keys/rotate`、`PUT /v1/policies/*` 保持 admin-only。

---

## 5. 错误处理

| 错误码                              | HTTP | 触发                                         | 呈现                                                                            |
| ----------------------------------- | ---- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `GROUP_NOT_FOUND`                   | 400  | PUT grants（项目/主机）组主体不在已知组集    | toast：'组不存在或平台未见过该组。'，矩阵不变（复用 W2-M-1 路径）               |
| `GRANT_PERMISSION_INVALID`          | 400  | 项目 grants 位越界                           | toast + 矩阵不变                                                                |
| `HOST_GRANT_PERMISSION_INVALID`     | 400  | 主机 grants 位 ∉ {provision, maintain, view} | drawer 字段级行                                                                 |
| `HOST_PROVISION_POLICY_INVALID`     | 400  | mode 非 open/restricted                      | drawer 字段级行                                                                 |
| `HOST_PROVISION_FORBIDDEN`          | 403  | restricted 主机上无 provision 授权自助建项目 | 自助弹层主机选项预禁用（提示'该主机已限制自助建项目'）；直调 API 得中文 message |
| `PERMISSION_DENIED`（+denied 审计） | 403  | 全部新端点/既有端点的非 admin 访问           | 既有 forbidden 页/toast                                                         |

写前审计 fail-closed 沿用 `auditAllowsMutations`/`recordAudit`（server.ts:373-449）：审计不可写时新增端点同样拒绝落盘。

---

## 6. 审计事件

| 事件                           | 结果           | metadata                                                          | 新增/修正                           |
| ------------------------------ | -------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `grant_update`                 | denied         | `reason:'PERMISSION_DENIED', requiredPermission:'platform:admin'` | **修正**（现状 403 无审计，§1.6-①） |
| `grant_update`                 | success        | 既有 + 可选 `selfGrant:true`                                      | 加性                                |
| `directory_read`               | denied         | requiredPermission                                                | 新增                                |
| `host_grant_update`            | success/denied | `hostId, subjectType, subjectId, username?, permissions`          | 新增                                |
| `host_provision_policy_update` | success/denied | `hostId, mode`                                                    | 新增                                |
| `project_create`               | denied         | 既有 + `reason:'HOST_PROVISION_FORBIDDEN', hostId`                | 加性 reason                         |
| `host_maintenance`             | success        | 既有 + `via:'host_grant'`（仅委派路径）                           | 加性                                |

审计筛选下拉（app.js:1053-1064）补 `host_grant_update`、`host_provision_policy_update` 两项。

---

## 7. 测试方案（每功能双向断言，真实平台进程 `spawnService` PORT=0）

**A · 项目授权分配（新 `test/e2e/platform-grant-validation.e2e.test.ts`）**

1. **admin 对任意资源可分配**：admin 对自己未创建、未授权的第二个项目 `PUT /grants`（user 主体 zhangsan）→ 200；zhangsan `GET /v1/projects` 可见且 `permissions` 含位；`GET /grants` 行带 username。
2. **非 admin 不可分配**：developer `PUT /grants` → 403 且服务端 grants 不变（既有 M120b-6 保持绿）**且 `/v1/audit/events` 出现 `grant_update/denied`**（新断言）。
3. 位校验：`permissions:['open','bogus']` → 400 `GRANT_PERMISSION_INVALID`，该主体存量授权行不变。
4. 组校验：`subjectType:'group', subjectId:'team-typo'` → 400 `GROUP_NOT_FOUND`，`GET /grants` 无死行；已知组 `team-payment` → 200。
5. 目录：admin `GET /v1/directory` 200 含 zhangsan 与 `team-payment`；developer → 403 + `directory_read/denied` 审计。

**B · 主机授权分配（新 `test/e2e/host-authorization.e2e.test.ts`）**

1. admin `PUT /v1/hosts/{id}/provision-policy {mode:'restricted'}` → 200；`PUT /v1/hosts/{id}/grants` 授组 `team-payment` `['provision']` → 200。
2. **被授予者可用**：组内用户 `POST /v1/projects/self {hostId}` → 201；**未授予者**（lisi，无组）→ 403 `HOST_PROVISION_FORBIDDEN` + `project_create/denied` 审计；admin 恒 201。
3. 零回归：`provision-policy` 缺省（'open'）时既有 `self-service-projects.e2e.test.ts` 全绿（不动其断言）。
4. `GET /v1/hosts/available` 加性字段：restricted+无授权 → `provisionAllowed:false`；granted → true；open 主机 → true；**响应其余字段逐字不变**（wire 兼容断言）。
5. 维护委派：授 `['maintain']` 的 developer `POST maintenance` → 200 且审计带 `via:'host_grant'`；未授予 developer → 403 + denied 审计；`DELETE /v1/hosts/{id}` 对 developer 恒 403（含被授予者）。
6. 非 admin 访问三个新端点全部 403 + denied 审计（对齐 `admin-gating` 套件模式）。

**C · U40 自授（新 `test/e2e/web-admin-self-grant.e2e.test.ts`，`web-console-page.ts` happy-dom 探针）**

1. admin 打开未授权项目：按钮呈「授权并打开」→ 点击 → 确认框含五位与断开提示 → 断言发出恰好一次 `PUT /grants`（subjectId=admin 用户名）→ 随后 `POST /web-handoff` 被调用。
2. **双向**：developer 对未授权项目（404 不可见）/对已授权项目（直接「打开」，无自授按钮）均不出现该入口；被授权 admin（已有 open）直接打开零额外请求。
3. Orca Web 入口：未授权 admin 显示自授入口、授权后显示正常入口。

**回归门**：`web-permission-matrix` / `user-grant-resolution` / `admin-gating` / `admin-denial-audit` / `web-admin-gating` / `self-service-projects` / `self-service-project-dir` / `web-exploratory-fixes` 全绿；证据入 `cloud-platform/evidence/admin-authorization/`。

---

## 8. 实现切分（每令 ≤20 分钟，域不相交；通道①=server.ts/store 独占，通道③=app.js 独占）

| 令  | 通道     | 内容                                                                                                                                  | 预估       | 提交                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| AA1 | ①        | `resolveGrantSubject` 共享解析 + A2 组校验 + A3 位白名单 + `denyPrivileged` 补 grant 拒绝审计 + `GET /v1/directory`（A1）；测试 A1–A5 | 15–20 分钟 | `feat(cloud): grant subject directory and validation`     |
| AA2 | ①        | B1 模型 + B2 三端点 + 审计事件（依赖 AA1 的解析器，**必须串行在 AA1 后**）；测试 B1/B6                                                | ≈20 分钟   | `feat(cloud): host grants and provision policy endpoints` |
| AA3 | ①        | B3 三个消费点（self 门禁 / available 加性字段 / maintenance 委派）；测试 B2–B5                                                        | 15 分钟    | `feat(cloud): enforce host provision and maintain grants` |
| AA4 | ③        | A1/A2 UI：矩阵 datalist + 新错误码 toast；web 探针 2 条（AA1 后）                                                                     | 10–15 分钟 | `feat(web): grant subject picker with directory`          |
| AA5 | ③        | C 自授入口（工作台/我的项目/Orca Web 三处同源）；web 探针 3 条（**服务端零依赖，可与①并行**）                                         | ≈15 分钟   | `feat(web): admin self-grant open entry`                  |
| AA6 | ③        | B4 主机 drawer「权限分配」区（矩阵+开关）；web 探针 2 条（AA2 后）                                                                    | ≈20 分钟   | `feat(web): host permission drawer`                       |
| AA7 | 测试工程 | §7 回归门全量复跑 + 双向断言核对 + 证据 JSON（含观察输出原文，U27 纪律）                                                              | ≈20 分钟   | `test(cloud): admin authorization coverage`               |

粒度校验：最大令 AA2（store+server+2 测试）；超时切分 `AA2a 模型+GET` / `AA2b PUT+审计`。AA1→AA2→AA3 严格串行（同文件同域）；AA5 独立可先行交付 U40 语义；AA4/AA6 依赖对应服务端码位。

---

## 9. 开放问题（请主会话裁定）

1. **组全集来源**：平台已知组=登录用户组并集，冷启动时可能不含运维想授的 LDAP 组（该组尚无人登录）。可选缓解：env `ORCA_CLOUD_KNOWN_GROUPS` 追加白名单（加性、一行），或接 LDAPS search（FR-1.5 范围）。默认建议：先用并集 + env 白名单。
2. **restricted 模式的存量冲击**：对已将 `selfServiceProvision` 置 restricted 的主机，现有自助用户立即失去建项能力（仅新请求被拒，已建项目不受影响）。是否需要过渡期宽限（如仅对新建目录生效）？默认建议：不做宽限，开关语义保持简单，切换前由管理员沟通。
3. **A6 `manage` 位委派**与 FR-1.5 角色分配：建议合并为「授权模型 v2」独立设计令，本设计不排。
4. U40 种子授权清理：环境侧已补的 admin 授权行保留（演示数据），产品语义按 §3.3 执行即可，无需回收。

## 主会话审定（2026-11-14）

全盘采纳：① U40=自授流程（web「授权并打开」：确认五位→PUT /grants subject=本人→handoff），否决隐式 open（默认拒绝/凭证单一事实源/可移除可审计三理由成立）；② HostGrant 三位（provision/maintain/view）+provisionPolicy 开关，纯平台侧消费、缺省 open=存量零回归；③ 目录端点从 store 派生零 LDAP 依赖；④ AA1-AA4/A6/A7 排 server.ts 通道串行（等在途 U41 落地）；AA5（自授入口，零服务端依赖）先行。
