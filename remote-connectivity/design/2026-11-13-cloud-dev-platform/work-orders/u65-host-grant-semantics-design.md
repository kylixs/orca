# U65 设计 · 主机授权语义深化（全权/只读两级 · 继承/上限/不扩大 · 下载两期拦截）

> 状态：设计稿，只设计不修码，待主会话审定后拆实现令
> 日期：2026-11-15 · 缺陷账：U65（defect-ledger.md:71）
> 需求唯一源：`requirements.md` FR-9.10 / FR-9.11 / FR-9.12 与 AC-33 ~ AC-40（已按 U65 增量修订，含主机授权语义矩阵）
> 现状基线：HEAD `972461c5ffc` 工作树实读——`cloud-platform/apps/api/src/server.ts`、`store.ts`、`project-self-service.ts`、`cloud-platform/apps/web/app.js`、`cloud-platform/packages/contract/src/permissions.ts`、`src/main/cloud-platform/*`、`src/main/runtime/rpc/*`、`src/renderer/src/{cloud,web}/*`
> 范围：平台 API × 管理台 Web × 宿主（orca server）权限执行 × 桌面/orca web 前端入口 × 测试
> 非目标：不改宿主票据签名/校验协议；不改 E2EE/中继；不新增主机 wire 字段；不引入内容级 DLP（仍按 design.md §9.3 的既有边界）
> 风格口径：cloud-platform 独立管理台，STYLEGUIDE.md 不适用；契约变更全部加性可选

---

## 0. 结论摘要

**一句话**：不新增权限位、不改宿主 wire，用 AA 批已有的三位（`provision` / `maintain` / `view`）做**级别推导**，把「主机授权」从平台内的建项开关升级为分层权限——全权推导「全部项目可见 + 全部项目操作位（`download` 除外）+ 创建 + 维护」，只读推导「全部项目可见 + `open + file:read` 上限」，项目级授权永不向上扩大；宿主侧的修改类拦截不写新代码，由平台下调后的**票据 `perms`** 天然完成（宿主 `cloudMethodAccess` + `rpc-caller-scope` 已按位拒绝）。

**核心机制（三处判定，一个事实源）**

1. **平台签发前**：新增纯函数 `effectiveProjectPermissions(store, project, user)`，把「项目授权位 P」与「主机授权推导的上限/来源 H」合成为有效位 E。所有可见性、打开、签票消费点统一改走 E。
2. **宿主执行**：票据 `perms` 就是 E；宿主既有 `cloudMethodAccess` 映射 + `decideMethod`/`cloudMethodDenial` 拒绝缺失位的方法。U65 不需要给宿主加「主机只读」概念。
3. **下载**：`download` 永远不由主机级授权推导；只读上限强制剔除；全权只继承项目级显式 `download` 位，且始终受 FR-7 项目/全局策略与宿主导出拦截约束。

**与 AA 的三个反转（必须写进实现，否则语义不成立）**

| AA 现状 | U65 后 |
| --- | --- |
| `view` 位仅占位，不接端点（app.js:1331） | `view` 推导项目可见性与 `open + file:read` 上限 |
| 主机位「不进凭证」，主机授权变更无需撤销（server.ts:2778） | 主机位经 E 进入票据 `perms`；导致有效位收缩的授权变更必须撤销受影响用户凭证（FR-1.7 / AC-38） |
| 自助建项目默认 `open`，所有人可建（provisionPolicy 缺省=open） | 创建能力只来自 `provision` 位（或 admin）；仅项目授权者不可创建（AC-35/AC-36） |

**下载分期**：一期是**体验层**（orca web / 客户端 web / 管理台详情页隐藏或禁用入口 + 尽力审计），明确不是安全边界；二期是宿主硬拦（现有五个导出方法已拦，U65 补 `browser.clientHost.fileChannel.read`、host-hosted 浏览器下载策略、AC-40 审计字段）。一期期间「绕过前端直读 RPC 仍可下载」必须登记为已知缺口，不得宣称 G4/FR-7.3 已 100%。

**置信度：高（约 90%）**。语义与消费点有代码实证；不确定点集中在：只读会话在 orca web 的工作区激活需要 remap `worktree.list`（§4.5）、一期 `download_blocked` 审计是否新增端点（§8）、AC-40 的 `size` 字段可得性。

---

## 1. 需求与现状对照

### 1.1 需求（唯一需求源，逐条对齐 FR-9.10 ~ 9.12）

| 需求 | 结论 |
| --- | --- |
| 主机全权 = 可见该主机全部非归档项目 + 可创建/登记 + 全部项目操作位 | 全权 = `provision + maintain + view` 三位；项目操作位为六个（`open`/`terminal`/`agent`/`file:read`/`file:write`/`browser`），**不含 `download`** |
| 主机只读 = 仅打开查看；不能创建/编辑/终端/Agent/浏览器/下载 | 只读 = 仅 `view`；项目内有效位强制为 `open + file:read`；无 `provision`/`maintain` |
| 项目级授权不扩大到主机级 | 项目位只在「无 view 推导」时生效；不产生其他项目可见性、不产生创建、不产生维护 |
| 混合位按最小权限降级 | 缺 `view` 不推导可见性；缺 `provision` 不可建；缺 `maintain` 不可维护；`provision`/`maintain` 不授予项目内读写 |
| 平台管理员旁路 | admin 不受自身主机只读约束；但**项目内操作仍按其项目授权位**（U40 自授语义不变） |
| 下载两期 | 一期前端（体验层）→ 二期宿主（安全边界）；一期须登记绕过缺口 |

### 1.2 AA 批已实现的形态（只读核实）

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| 主机授权模型 | `store.ts:90-100` | `HostPermission = 'provision' \| 'maintain' \| 'view'`；`HostGrant` 平台内部行 |
| 位匹配 | `project-self-service.ts:135-150` | `hasHostPermission` 逐位匹配用户 id / 组名 |
| 授权端点 | `server.ts:2675-2790` | `GET/PUT /v1/hosts/{id}/grants`、`PUT /v1/hosts/{id}/provision-policy`；全 admin-only |
| 建项门禁 | `server.ts:1775-1786` | 仅当 `provisionPolicy === 'restricted'` 且非 admin 且无 `provision` 才拒 |
| 可建主机 | `server.ts:2320-2332` | `provisionAllowed = projectsRoot && (policy !== 'restricted' \|\| admin \|\| provision)` |
| 维护 | `server.ts:2627-2631` | `admin \|\| hasHostPermission('maintain')` |
| 凭证 | `server.ts:3330-3345` | `perms = store.effectivePermissions(project.id, user)`（**仅项目授权行**） |
| 项目可见性 | `server.ts:1548-1562` | `admin \|\| effectivePermissions.includes('open')`（**仅项目授权行**） |
| 打开/交接 | `server.ts:1320`、`server.ts:3116-3125`、`server.ts:3232` | 均只查项目授权行的 `open` |
| `view` 位 | `app.js:1331` | 文案明示「仅占位（v1 不接端点）」 |
| 宿主导出拦截 | `cloud-rpc-permission.ts:64-70,102-134` + `rpc-caller-scope.ts:38-58` | 五个导出方法按 `download` 位 + 下载策略拒绝 |

### 1.3 与 AA 实现的差异清单（哪些格现在不符）

记号：`H` = 主机授权推导，`P` = 项目授权位，`E` = 有效位。

| # | 语义格 | 现状 | U65 目标 | 根因 |
| --- | --- | --- | --- | --- |
| D1 | 全权 → 可见该主机全部项目 | 不符：只看显式项目授权 | 相符：`view` 推导所有非归档项目的 `open` | 可见性只查 `store.effectivePermissions` |
| D2 | 全权 → 项目内全部操作位 | 不符：票据只带 P | 相符：E = 六个操作位 | 凭证只由 P 生成 |
| D3 | 全权 → 新登记项目自动继承 | 不符：新项目无授权行即不可见 | 相符：可见性按 `hostId` 动态推导 | 同上 |
| D4 | 全权 → 可创建 | 部分符：默认 open 时人人可建，restricted 时看 `provision` | 相符：只由 `provision` 决定 | 门禁被 `provisionPolicy` 包着 |
| D5 | 只读 → 可见并打开全部项目 | 不符：`view` 未接任何端点 | 相符：`view` 推导 `open` | `view` 占位 |
| D6 | 只读 → `open + file:read` 上限 | 不符：P 有 `terminal`/`file:write` 即进票据 | 相符：E 强制裁剪 | 无上限合成 |
| D7 | 只读 → 不可创建 | 不符：默认 open 主机上可建 | 相符：无 `provision` 即拒 | 门禁默认 open |
| D8 | 只读 → 不可下载 | 不符：P 有 `download` 且策略 allow 即可 | 相符：E 剔除 `download` | 无上限合成 |
| D9 | 仅项目授权 → 只见被授权项目 | 相符：现状即显式授权 | 保持 | — |
| D10 | 仅项目授权 → 不可创建 | 不符：默认 open 主机上可建 | 相符：无 `provision` 即拒 | 门禁默认 open |
| D11 | 全权 → 可维护 | 相符（`maintain` 已接维护端点） | 保持 | — |
| D12 | 授权降级 → 60 秒内生效 | 不符：主机位不进票据，无需撤销；在线会话保持旧权限 | 相符：票据 E 收缩 + 撤销受影响用户 | AA 明确「不触发撤销」 |
| D13 | 全权 → `download` | 现状同普通用户（P + 策略） | 保持：全权不推导 `download` | 需求明确 |
| D14 | 管理台只暴露两级 | 不符：三位矩阵 + `provisionPolicy` 开关 | 相符：全权/只读/无 三选一 | AA UI 暴露内部位 |

---

## 2. 语义模型

### 2.1 位与级别

| 级别（对外） | 存储位（底层） | 判据 |
| --- | --- | --- |
| 主机全权 | `provision` + `maintain` + `view` | 三位同时存在（用户行 ∪ 组行的并集） |
| 主机只读 | `view` | 有 `view` 且不是全权 |
| 无主机授权 | — | 无任何匹配的 `view`/`provision`/`maintain` |
| 混合位（历史/直写，管理台不产生） | 其余组合 | 逐位最小降级（§2.2） |

**并集规则**：同一用户经「用户直授行 + 组成员行」拿到的位取并集。全权要求并集包含三位；只读要求并集包含 `view`。这避免「用户行 view + 组行 provision」被误读为两个独立级别。

### 2.2 推导公式

```ts
// 纯函数，建议放 cloud-platform/apps/api/src/host-authority.ts
type HostAccessLevel = 'full' | 'read-only' | null

const FULL_OPS: Permission[] = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser']
const VIEW_OPS: Permission[] = ['open', 'file:read']

function hostBits(store, hostId, user): Set<HostPermission>   // 用户行 ∪ 组行
function hostAccessLevel(store, hostId, user): HostAccessLevel {
  const b = hostBits(store, hostId, user)
  if (b.has('provision') && b.has('maintain') && b.has('view')) return 'full'
  if (b.has('view')) return 'read-only'
  return null
}

function effectiveProjectPermissions(store, project, user, isPlatformAdmin): Permission[] {
  const projectBits = store.effectivePermissions(project.id, user) // 既有：项目授权并集
  if (isPlatformAdmin) return projectBits                         // 旁路：不受主机只读约束
  const level = hostAccessLevel(store, project.hostId, user)
  if (level === 'full') {
    // download 不推导；只继承项目级显式 download 位（仍受 FR-7 策略约束）
    return dedupe([...FULL_OPS, ...projectBits.filter((p) => p === 'download')])
  }
  if (level === 'read-only') return [...VIEW_OPS]                 // 上限 + 保底
  return projectBits                                              // 无主机授权：项目位仅项目内生效
}

function canCreateProjectOnHost(store, hostId, user, isPlatformAdmin): boolean {
  return isPlatformAdmin || hostBits(store, hostId, user).has('provision')
}
```

**三个必须固化的细节**

1. **只读是「保底 + 上限」**：`view` 即使没有任何项目授权也给出 `open + file:read`（否则「只读授权」等于无授权）；同时项目授权不能突破它。
2. **全权是「来源」**：可见性/操作位由主机位供给，不要求逐项目授权；但对 `download` 只做继承、不做推导。
3. **无 `view` 时无上限**：只有 `provision`/`maintain` 的混合位不裁剪项目位（它们本就不授予项目读写，见下表的逐位降级）。

### 2.3 完整语义矩阵（主机授权位 × 行为）

图例：`允许` / `拒绝` / `按项目位` = 由 P 决定 / `按策略` = 项目位 + FR-7 下载策略共同决定。判定源：`H`=主机推导，`P`=项目授权，`min`=主机上限 ∩ 项目位，`policy`=下载策略，`admin`=管理员旁路，`host`=宿主 RPC 执行。

| 主体在该主机上的状态 | 可见项目列表 | 打开/查看 | 编辑文件 `file:write` | 终端/Agent `terminal`/`agent` | 浏览器 `browser` | 创建/登记项目 | 主机维护 | 下载 | 判定源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 平台管理员 | 全部（含归档，`includeArchived=1` 时） | 需显式 `open`（U40 自授，现状不变） | 按项目位 | 按项目位 | 按项目位 | 允许 | 允许 | 按项目位 + 策略 | `admin` 管控面旁路；项目内仍 `P` |
| 主机全权（三位） | 该主机全部非归档 | 允许 | 允许 | 允许 | 允许 | 允许 | 允许 | 按项目位（仅显式 `download`）+ 策略 | `H` 供给六位；下载 `P` + `policy`；宿主 `host` |
| 主机只读（仅 `view`） | 该主机全部非归档 | 允许 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | `H` 上限（`open + file:read`）；宿主 `host` |
| 混合：`view + provision`（缺 maintain） | 该主机全部非归档 | 允许 | 拒绝 | 拒绝 | 拒绝 | 允许 | 拒绝 | 拒绝 | 缺 maintain 不成立全权；`provision` 只给创建 |
| 混合：`view + maintain`（缺 provision） | 该主机全部非归档 | 允许 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 允许 | 拒绝 | 同上，`maintain` 只给维护 |
| 混合：`provision + maintain`（无 view） | 仅显式项目授权 | 按项目位 | 按项目位 | 按项目位 | 按项目位 | 允许 | 允许 | 按项目位 + 策略 | 缺 view 不推导可见性/上限 |
| 仅 `provision` | 仅显式项目授权 | 按项目位 | 按项目位 | 按项目位 | 按项目位 | 允许 | 拒绝 | 按项目位 + 策略 | 同上 |
| 仅 `maintain` | 仅显式项目授权 | 按项目位 | 按项目位 | 按项目位 | 按项目位 | 拒绝 | 允许 | 按项目位 + 策略 | 同上 |
| 无主机授权（仅项目授权） | 仅显式项目授权 | 按项目位 | 按项目位 | 按项目位 | 按项目位 | 拒绝 | 拒绝 | 按项目位 + 策略 | `P` |

**可见性判据**：上表「可见项目列表」等价于 `effectiveProjectPermissions(...).includes('open')`。全权/只读因推导出 `open` 而可见全部；无 view 的混合位/无授权只见显式授权。

**「按项目位」的宿主执行**：平台把 E 签进票据；宿主按 `cloud-rpc-permission.ts` 的映射逐方法拒绝。因此「编辑文件/终端/Agent/浏览器」在宿主侧不存在第二套主机级判断。

### 2.4 项目授权位 × 主机上限（合成表）

| 项目授权位 P | 无主机授权 | 主机只读上限 | 主机全权来源 |
| --- | --- | --- | --- |
| `open` 缺失 | 不可见（除非 P 含 open） | 可见（view 保底） | 可见（全权供给） |
| `open` 存在 | 可见 | 可见 | 可见 |
| `file:read` | 按 P | 允许（view 供给） | 允许 |
| `file:write` | 按 P | 拒绝（上限） | 允许 |
| `terminal` | 按 P | 拒绝（上限） | 允许 |
| `agent` | 按 P | 拒绝（上限） | 允许 |
| `browser` | 按 P | 拒绝（上限） | 允许 |
| `download` | 按 P + 策略 | 拒绝（上限，即使 P 有） | 仅当 P 显式有 + 策略允许 |

**关键裁定（与主会话建议一致）**：主机只读对项目内修改类操作是 `min(主机上限, 项目位)` 的**上限约束**；主机全权对项目可见性是**来源**（主机授权 → 该项目自动可见，无需逐项目授权），对项目操作位是**来源**，对 `download` 只继承、不推导。

### 2.5 判定顺序（默认拒绝）

```
1. admin 旁路：项目内 E = P（U40 自授仍需要 open）；管控面允许
2. 计算 H（并集）：
   a. H 含三位 → E = 六个操作位 ∪ (P ∩ {download})
   b. H 含 view（非全权）→ E = {open, file:read}
   c. H 无 view → E = P
3. 可见性/打开/签票统一用 E.includes('open')
4. 宿主执行 E：方法映射缺失位 → forbidden + method_denied 审计
5. 下载：E 有 download 且策略 allow 才放行（前端隐藏只是体验层）
```

---

## 3. 数据模型与契约变更

### 3.1 不新增位 / 不新增存储字段

- `HostPermission` / `HostGrant` 保持原样（`store.ts:90-100`）。全权是三位组合，只读是 `view`，对外两级由**推导**产生，不落库。
- 不新增 `Store` 字段，不需要数据迁移；既有行按新规则重新解释（见 §6.3）。
- 新增一个纯函数模块 `cloud-platform/apps/api/src/host-authority.ts`（命名按职责，不用 helpers/utils）：`hostBits`、`hostAccessLevel`、`effectiveProjectPermissions`、`canCreateProjectOnHost`、`hostOperationsCeiling`。
- 复用收口：`hasHostPermission`（`project-self-service.ts:137`）改为 `hostBits(...).has(permission)`，全仓只保留一套主体匹配逻辑（用户 id + 组名并集）。
- `store.effectivePermissions`（`store.ts:182`）**保留**为「项目授权并集」基线；新函数在其上合成主机上限，避免把两层语义揉进 store。

### 3.2 wire-additive 字段（全部可选，旧端忽略）

| 位置 | 新增字段 | 用途 | 兼容性 |
| --- | --- | --- | --- |
| `projectView`（server.ts:812） | `hostAccess?: 'full' \| 'read-only'` | 管理台/工作台解释「为什么我的权限被裁剪」；无主机授权或 admin 时省略 | 加性；旧客户端忽略 |
| `GET /v1/hosts/available`（server.ts:2313） | `accessLevel: 'full' \| 'read-only' \| null` | 主机下拉标注；`provisionAllowed` 语义收紧但字段保留 | 加性；旧客户端只读 `provisionAllowed` |
| `GET /v1/hosts/{id}/grants`（server.ts:2675） | 每行 `level: 'full' \| 'read-only' \| 'mixed'` | 管理台抽屉显示级别 | 加性 |
| `workspace.info`（`src/main/runtime/rpc/methods/workspace-info.ts`） | `downloadAllowed?: boolean` | 一期前端判断项目/全局策略；缺失按 `false`（fail closed） | 加性；旧 host 不发送 → 前端隐藏入口（安全方向） |
| `CloudProjectLinkSchema`（`src/shared/runtime-environments.ts:30`） | `permissions?: CloudPermission[]` | 桌面原生工作区按票据位门禁下载入口；每次打开刷新 | 本地 sidecar 加性，旧 sidecar 忽略 |
| `POST /v1/projects/{id}/download-blocked`（可选，见 §5.2） | 新端点 | 一期前端拦截的尽力审计 | 纯新增；不影响旧端 |

**平台 ↔ 宿主 wire 零变更**：主机位仍只在平台侧消费；宿主只看到票据 `perms` 和既有策略包。`workspace.info` 的新字段是宿主→客户端回复的加性字段，不涉及平台↔宿主。

### 3.3 审计与撤销

- `host_grant_update` 审计 metadata 增 `accessLevel`（由新位推导）、`revokedUsers`（数量）。
- 撤销规则（替换 AA 的「无需撤销」）：
  1. 计算受影响用户集合：用户主体=该用户；组主体=当前 `store.users` 中属于该组的所有用户（宿主无法解析组，必须落到用户）。
  2. 在写前快照这些用户的 `hostBits`，落库后重算；**有效位收缩**的用户才 `revokeUserCredentials(username, 'host_grant_changed')`。
  3. 纯增加（none→view、view→full）不撤销：在线会话位更少是安全方向，重连即得新权限。
  4. 不用「按项目撤销」：会把同项目无关用户一起踢下线；不新增 `host` 撤销类型：旧宿主会静默忽略未知类型（Remote Wire Compatibility）。
  5. 已知代价：`revokeUserCredentials` 关闭该用户在所有主机上的云会话（与既有项目授权 user 行变更一致）；host 级更窄的撤销目标需要宿主 wire（§8 开放问题）。
- 项目级授权变更的撤销路径不变（server.ts:2069-2071）。
- 降级传播 ≤60 秒依赖既有心跳撤销同步（FR-1.7 / AC-38 前提已写明）。

---

## 4. 消费点改动清单

### 4.1 平台 API（逐处）

| # | 位置 | 现状 | 改动 |
| --- | --- | --- | --- |
| C1 | `server.ts:812` `projectView` | `permissions = store.effectivePermissions` | `permissions = effectiveProjectPermissions(..., isAdmin(user))`；加 `hostAccess`（admin 省略） |
| C2 | `server.ts:906` `visibleProject` | 只查 P 的 `open` | 改 E（保持 404 不泄露） |
| C3 | `server.ts:1548-1562` `GET /v1/projects` | `admin \|\| P.open` | `admin \|\| E.open`；归档过滤、`includeArchived` admin-only 不变 |
| C4 | `server.ts:1863-1876` 项目路由守卫 | `adminAccess \|\| P.open` | `adminAccess \|\| E.open`；`GET /grants` 的可读面随 E 扩大（与 AA §1.6-④ 裁定一致，文档化） |
| C5 | `server.ts:1320` handoff 兑换 | `P.open` | `E.open`（授权在发放与兑换之间收缩仍拒绝） |
| C6 | `server.ts:3116-3125` `handleWebHandoff` 签发 | `P.open` | `E.open` |
| C7 | `server.ts:3232-3345` `handleConnect` | `perms = P` | `perms = E`；**这是宿主修改类拦截的唯一开关** |
| C8 | `server.ts:1775-1786` 自助建项目 | 仅 restricted 且无 provision 拒 | 一律 `admin \|\| provision`，否则 `403 HOST_PROVISION_FORBIDDEN` + denied 审计（保留 `hostId` metadata） |
| C9 | `server.ts:2320-2332` `available` | `policy !== 'restricted' \|\| admin \|\| provision` | `projectsRoot && (admin \|\| provision)`；加 `accessLevel` |
| C10 | `server.ts:2699-2790` `PUT /hosts/{id}/grants` | 明确不撤销（2778 注释） | 按 §3.3 撤销有效位收缩的用户；审计加 `accessLevel`/`revokedUsers` |
| C11 | `server.ts:2627-2631` 维护 | `admin \|\| maintain` | 不变（全权含 maintain；只读无） |
| C12 | `project-self-service.ts:135` 注释 | 「host bits never enter a credential」 | 改写：主机位经有效位合成进入票据，见 §3.3 |
| C13 | `app.js:1331/1401/1461` 文案 | 「view 仅占位」「无需断开会话」 | 级别选择器；改为「降级会断开受影响用户的会话」 |
| C14 | `app.js` 主机抽屉（1330-1520 区） | 三位矩阵 + `provisionPolicy` 开关 | 全权/只读/无 三选一；保存写三位或 `['view']` 或 `[]`；策略开关移除（保留端点） |

**不动的判定**：`POST /v1/projects`（admin-only）、`DELETE /v1/hosts/{id}`、`POST /v1/hosts/tokens`、项目归档/恢复（创建者或 admin；主机全权不授予项目管理权）、U40 自授入口。

### 4.2 可见性推导（`/v1/projects` + `available`）

- `/v1/projects`：不新增「主机项目枚举」逻辑；E 对全权/只读在每台主机上自动含 `open`，现有 `filter(E.includes('open'))` 自然覆盖。**新增项目无需授权行即可见**（AC-37）——因为 E 是按 `project.hostId` 动态计算的，没有缓存。
- `/v1/hosts/available`：`provisionAllowed` 改为只反映「能否创建」；新增 `accessLevel` 供前端标注「只读」。旧客户端忽略 `accessLevel`，仍按 `provisionAllowed` 禁用下拉。
- 搜索：桌面/工作台的搜索数据源若来自 `/v1/projects`，自动继承；若本地缓存列表，登录/打开时刷新即可（不新增端点）。

### 4.3 创建/登记门禁与 `provisionPolicy` 处置

- 门禁：`canCreateProjectOnHost = isAdmin || hostBits.has('provision')`；`HOST_PROVISION_FORBIDDEN` 错误码与 denied 审计形状保持 AA 现状（AC-35/AC-36 可直接断言）。
- `provisionPolicy`：**保留字段与端点，语义弃用**——不再参与门禁；`GET /v1/hosts` 继续返回（旧管理台可读）；管理台移除开关。这样既满足「仅项目授权不可创建」的无条件规则，又不做破坏性 wire/存储变更。
- 存量 `provisionPolicy='open'` 的主机：部署后立即收紧为「需 `provision` 位」。这是产品语义变更，不做宽限（§8 开放问题记录）。
- 自助创建成功后仍写入创建者的项目授权行（createor 已有五位）；对全权用户是冗余但无害，保留以免改动创建事务。

### 4.4 宿主 RPC 面的修改类拦截（只读用户）

**结论：零宿主代码改动即可拦住修改类方法**，因为拦截点是票据 `perms`：

| 用户行为 | 票据 E（只读） | 宿主拒绝点 | 结果 |
| --- | --- | --- | --- |
| 终端 `pty.*`/`terminal.*` | 无 `terminal` | `cloudMethodAccess` → `terminal`；`cloudMethodDenial` | forbidden + `method_denied` 审计（PERMISSION_MISSING） |
| 文件写 `files.write`/`createFile`/`delete`… | 无 `file:write` | 同上 | 同上 |
| Agent `agent.*` | 无 `agent` | 同上 | 同上 |
| 浏览器 `browser.*` | 无 `browser` | 同上 | 同上 |
| 下载五个导出方法 | 无 `download` | 同上 + 策略 `downloadAllowed` | forbidden / `DOWNLOAD_DISABLED` |
| 文件浏览 `files.read*` | 有 `file:read` | 放行（路径护栏不变） | 正常 |

**只读用户仍可触达的两个 `open` 级方法**（需文档化，不是漏洞）：

- `project.provision`（`cloud-rpc-permission.ts:76` 归 `open`）：首次打开时宿主按票据 projectRoot 克隆/登记项目；这是「打开查看」的必要准备动作，不写用户内容。
- `repo.add`（同上）：把票据 projectRoot 登记进宿主 repo 目录；宿主 `checkProjectRootTarget` 把路径钉死在票据根。

### 4.5 只读会话的 web 工作区可达性缺口（必须补，否则 AC-34 的「浏览/预览正常」在 orca web 不成立）

现状链路：

- `cloudMethodAccess`（`src/main/cloud-platform/cloud-rpc-permission.ts:89-98`）把 `worktree.create/createManaged/rm/forceDeleteBranch/show/list/detectedList` **全部**归 `terminal`。
- `web-cloud-workspace-bootstrap.ts:168-215` 只有在 `terminalGranted` 时才 `ensure`、`fetchWorktrees`、`activateWorkspace`；只读会话（open+file:read）在 `repo.add` 后直接返回，**文件树永远不挂载**。
- 结果：主机只读用户在 orca web 看不到文件；与 FR-9.10「可见并可打开、浏览与预览正常」冲突。

改动（最小、只读方向）：

1. 拆分 `WORKTREE_METHODS`：
   - 读目录类 `worktree.list`、`worktree.detectedList`、`worktree.show` → `file:read`（仍受票据 projectRoot 路径护栏）。
   - 变更类 `worktree.create`、`worktree.createManaged`、`worktree.rm`、`worktree.forceDeleteBranch` → `terminal`。
2. `web-cloud-workspace-bootstrap`：`terminalGranted=false && fileReadGranted=true` 时，跳过 `ensure`（需要 terminal），用 `workspace.info.workspace.path` 选择既有检出；`fetchWorktrees` 后 `activateWorkspace({ mountExplorer: true })` 并保持终端 pane 不挂载。无既有检出时进入只读空态（提示「只读授权，无可用检出」），不报 forbidden。
3. 桌面云会话同理：web 侧的 explorer 挂载条件已按 `file:read`（W13b/U33 语义）；桌面侧需核对同一条件，并补「无 terminal 也可激活」的分支。
4. 测试：只读 web 会话可见文件树、可读预览；`worktree.createManaged` 仍被拒；`worktree.list` 审计无 method_denied。

> 这是 U65 里唯一需要动宿主权限映射的核心项；不改协议、不新增方法。

### 4.6 管理台 UI（`cloud-platform/apps/web/app.js`）

- 主机 drawer「权限分配」区：三行级别单选（全权 / 只读 / 无），保存写 `['provision','maintain','view']` / `['view']` / `[]`；不再渲染 `provision`/`maintain`/`view` 三个独立勾选。
- 移除 `provisionPolicy` 开关（端点保留、GET 仍返回）；抽屉内说明改为：
  - 全权：可见全部项目、可创建、可维护、项目内全部操作（下载除外）。
  - 只读：可见全部项目、只可浏览/预览；终端、写入、Agent、浏览器、下载均不可用。
  - 降级保存会断开受影响用户当前云会话（≤60 秒）。
- 项目行权限列（`permissionSummary`/`openDisabledReason`，app.js:249-267）：E 已被裁剪，显示即为有效位；可用 `hostAccess` 追加「（主机只读上限）」。
- 删除「主机权限位不进凭证」三处文案（app.js:1331/1401/1461）。
- AA6 探针迁移：矩阵 header 断言改为级别单选；`provisionPolicy` 断言改为「仍可 GET、UI 不再写」。

---

## 5. 下载两期拦截

### 5.1 现状盘点（入口 × 面 × 现状 × 缺口）

| # | 入口/方法 | 所在面 | 现状 | U65 处置 | 期 |
| --- | --- | --- | --- | --- | --- |
| D1 | `files.download` / `files.downloadFolder` / `terminal.exportArtifact` / `browser.download` / `browser.savePage` | 宿主 RPC | `cloudMethodAccess` 归 `download`；`rpc-caller-scope.ts:49-56` 按位 + `downloadAllowed` 拒 | 已硬拦；补「方法未注册也先拒绝」的契约测试 | 二期（已验证） |
| D2 | `browser.clientHost.fileChannel.read` | 宿主 RPC（浏览器下载分块回传） | `cloudMethodAccess` 走 `browser.` 前缀 → **`browser` 位即可读**，不是 `download` | 改归 `download`；`fileChannel.write/abort` 不属导出（write 是上传方向），保持 `browser` 并注释 | 二期 |
| D3 | host-hosted 浏览器 `will-download` | 宿主浏览器进程 | `browser-session-partition-policies.ts:188-192` 有 `downloads:'deny'` 开关，但无云会话/策略接线 | 云会话的浏览器分区在策略禁止时走 `handleDeniedWillDownload`；或依赖 D2 收口 | 二期 |
| D4 | `downloadRuntimeFile`（`runtime-file-read-client.ts:136-195`） | 桌面客户端 | 走 `files.readChunk`（`file:read`）+ 本地保存；无云会话权限门禁 | 一期 UI 隐藏入口；内容级读取不拦（既有边界） | 一期（UI）/已知缺口 |
| D5 | 文件树右键「下载」（`file-explorer-row-context-menu.tsx:142`） | 桌面客户端 | `shouldShowRemoteDownloadAction`（`file-explorer-row-action-visibility.ts:20-37`）在 web 客户端隐藏；桌面云会话仍显示 | 云会话且 E 无 `download` 或 `downloadAllowed=false` 时隐藏 | 一期 |
| D6 | 浏览器面板下载/另存 | 桌面客户端 | 显示下载进度与「打开/显示文件」 | 云会话无 `download` 时不提供入口/禁用 | 一期 |
| D7 | 终端产物导出 UI | 桌面客户端 | 由 `terminalArtifact.*` / `terminal.exportArtifact` 支撑 | 云会话无 `download` 时隐藏 | 一期 |
| D8 | 拖拽到本地 | 桌面客户端 | 文件树/预览拖拽 | 一期审计所有拖拽源；无法可靠拦截的登记已知缺口 | 一期 |
| D9 | orca web 文件下载 | 配对 web 客户端 | 下载菜单按 `__ORCA_WEB_CLIENT__` 隐藏；`web-filesystem-api.ts:62-82` 全部 throw；无浏览器下载 | 增加按票据位的显式门禁与测试（防御纵深，不改行为） | 一期 |
| D10 | 管理台简易工作区 / cloud-admin 详情页 | `src/renderer/src/cloud` | 无下载/导出入口（M92 `cloud-managed-no-export.test.tsx`）；`downloadRestricted` 按 `permissions.includes('download')` | 主密钥位裁剪后 `downloadRestricted` 自动正确；保留徽标文案 | 一期 |
| D11 | 剪贴板 | 客户端 | 服务端不可读 | 不处理（design.md §9.3 既有边界） | 不适用 |
| D12 | `files.readChunk`/`read`/`readPreview` 重建文件 | 任意客户端 | 放行（限速 + 审计） | 不拦；二期也承认内容级 DLP 未覆盖 | 不适用（已知缺口） |

### 5.2 一期（前端拦截，体验层，不是安全边界）

**目标**：在项目/全局下载策略「禁止」或票据无 `download` 位时，三个面都不出现可点的下载/导出/拖拽入口；用户触发给出原因；尽量写 `download_blocked` 审计。

1. **平台**：无需新业务端点。`projectView.permissions` 已是裁剪后的 E，`downloadRestricted`（`cloud-project-summary.ts:16`、`web-cloud-session.ts:230`）自动反映「主机只读」与「项目无 download」。
2. **宿主（小改，体验层）**：`workspace.info` 加 `downloadAllowed`（读 `cloudAccessGuard.downloadAllowed(projectId)`，`runtime-rpc-websocket-dispatch.ts:95` 已有同源值）；缺失时前端按 `false`。
3. **orca web（`src/renderer/src/web`）**：bootstrap 已拿 `info.perms`；增加 `downloadGranted = perms.includes('download') && info.downloadAllowed !== false`，挂到会话状态；文件树/浏览器/终端产物入口按此隐藏。现状本就隐藏，补测试钉住。
4. **桌面云会话（`src/renderer/src`）**：把票据位（`readTicketClaims(prepared.link.cloudUpgrade.credential).permissions`，`src/main/ipc/cloud-platform.ts:144` 已在用）经 `registerCloudRuntimeEnvironment` 落 sidecar 的 `cloudProject.permissions?`；文件树右键下载、浏览器下载、终端产物导出按 `download` 位 + `downloadAllowed` 隐藏。`downloadRuntimeFile` 本身不改（仍走 `readChunk`，属已知内容级缺口）。
5. **管理台**：`src/renderer/src/cloud` 已无入口；补一条「有 download 位 + 策略 allow 也不显示下载」的负向断言（M92 已覆盖，确认无需新增）。
6. **审计**：FR-9.12 要求一期写 `download_blocked`。建议新增加性端点 `POST /v1/projects/{id}/download-blocked`（auth + 可见性校验 + 按用户/项目限速；eventType `download_blocked`，metadata `{surface, method?, path?, advisory:true}`）。它是**尽力而为**：恶意客户端可以不调用，不能作为安全证据。若主会话不接受新端点，则一期审计降级为「前端日志 + 已知缺口」，并在验收中明确 AC-39 的审计项为 Partially。
7. **已知缺口登记**：一期期间「绕过前端直连 RPC（`readChunk` 重建或桌面 `downloadRuntimeFile`）仍可下载」必须写入缺陷台账/验收报告；U65 在二期前保持未闭合，禁止宣称 G4/FR-7.3 已 100%。

**工作量**：平台 0（可选 1 个小端点）；宿主 1 处加性字段；orca web 1 处会话状态 + 入口门禁；桌面 1 处 sidecar 字段 + 3 处入口门禁；测试/证据 1 令。约 2 个 20 分钟令。

### 5.3 二期（宿主硬拦，安全边界）

1. **方法映射收口**（`cloud-rpc-permission.ts`）：
   - `browser.clientHost.fileChannel.read` 移入 `DOWNLOAD_METHODS`（或新增显式集合），要求 `download` 位 + 策略；`write`/`abort` 保持 `browser` 并注释方向。
   - 增加契约测试：遍历 `DOWNLOAD_METHODS`，对云会话无 `download` 位或策略 deny 时，`denyRpcMethodForCaller` 必返拒绝；对已注册/未注册方法同真同证。
2. **host-hosted 浏览器下载**：云会话的浏览器分区在 `downloadAllowed=false` 时使用 `downloads:'deny'`（复用 `browser-session-partition-policies.ts:188-192` 既有开关）；若浏览器页实际由客户端承载，则依赖第 1 项与前端门禁。
3. **审计字段**（AC-40 要求 user/project/path/size/method/result/traceId）：
   - `CloudHostAuditEvent` / `HostAuditReport`（`src/main/cloud-platform/cloud-host-audit.ts:12`、`cloud-platform/apps/api/src/host-audit-ingest.ts:15-24`）加可选 `path?: string`、`bytes?: number`。
   - `runtime-rpc-websocket-dispatch.ts:232-242` 的 `onCloudDenial` 传入从请求参数白名单提取的 `relativePath`/`path`（截断 512）；`bytes` 仅当参数显式携带 `length`/`size` 时记录，否则 `null` 并文档化（不在拒绝路径上额外 stat）。
   - 平台 ingest 把两字段写入审计 metadata（加性），旧 host 不发送不影响。
4. **不做**：内容级 DLP/剪贴板/`readChunk` 阻断——design.md §9.3 的既定边界，AC-40 也只承诺「下载/导出 RPC」。
5. **工作量**：映射 + 测试 1 令；浏览器分区接线 1 令（若可达）；审计字段 host+platform 1 令。共 2–3 个 20 分钟令。

### 5.4 分期边界与验收口径

| 项 | 一期 | 二期 |
| --- | --- | --- |
| 安全边界 | 否（体验层） | 是（宿主 RPC） |
| 覆盖 | orca web / 客户端 web / 管理台详情 | 任意客户端 + 裸 WebSocket |
| 证据 | UI 无入口 + 可点性断言 + 尽力审计 | 逐方法 forbidden + audit 字段 |
| AC | AC-39（允许 Partially 审计） | AC-40 |
| 台账 | U65 保持未闭合 + 已知缺口 | 可闭合 |

---

## 6. 兼容性与迁移

### 6.1 wire 兼容

| 通道 | 变更 | 旧端行为 |
| --- | --- | --- |
| 平台 → 桌面/web 客户端（REST） | 可见项目集合扩大/缩小；`projectView.permissions` 变为有效位；新增 `hostAccess`/`accessLevel` | 旧客户端忽略新字段；按 `permissions` 门禁的 UI 自动正确（裁剪后） |
| 平台 → 宿主 | 无变更 | 宿主只验证票据 `perms`，无需知道主机级概念 |
| 宿主 → web 客户端（RPC） | `workspace.info` 新增 `downloadAllowed`；`worktree.list/detectedList/show` 改由 `file:read` 放行 | 旧客户端忽略字段；旧 host 不发送 → 前端 fail closed 隐藏下载；旧 host 的 worktree 映射仍是 terminal（只读会话在旧 host 上不可浏览，登记为版本落差） |
| 宿主 → 平台（心跳 audit） | `path`/`bytes` 可选 | 平台 ingest 按可选字段解析，旧 host 不发送不受影响 |

**顺序建议**：先平台（U65-2/3/4）→ 再宿主可浏览（U65-6）→ 再前端下载（U65-7/8/9）。平台先上线时，旧客户端会立即看到新语义（可见性/权限裁剪），这是产品期望，不构成 wire 破坏。

### 6.2 AA2/AA3 断言保留与迁移

| 套件/用例 | 断言 | 处置 |
| --- | --- | --- |
| `host-authorization.e2e.test.ts` AA2-1/2/3（端点门禁、位校验、组解析） | admin 可用、developer 403、位白名单、组名校验、全量替换 | **保留**（原始位模型不变） |
| AA2 restricted 门禁（lisi 403、granted 201、admin 201） | 依赖 `provision` 位 | **保留**；门禁收紧后仍成立（restricted 只是历史配置） |
| AA2 `available` 加性字段（restricted 下 provisionAllowed） | 依赖 `provision` | **保留**；缺省 open 的断言需迁移（见下） |
| AA2 维护委派 / AA3 维护与吊销 | `maintain`、`via:'host_grant'`、吊销仍 admin-only | **保留** |
| AA3 自助门禁分支（用户直授、按位、组大小写、吊销即时、策略回切） | 其中「`open` 策略恢复旧行为」 | **迁移**：策略不再影响门禁；改为「无 `provision` 恒拒，有 `provision` 恒放」；删除 open/restricted 回切断言或改为「策略字段仍返回但不影响判定」 |
| AA3 `available` 判定（缺省 open 恒 true） | `provisionAllowed` 公式 | **迁移**：无 `provision` 的缺省主机变为 false |
| `self-service-projects.e2e.test.ts`（全员可自助） | 默认主机无授权可建 | **迁移**：fixture 补主机授权（`['provision']` 或全权）或改为断言 403；`available` 字段断言同步 |
| `self-service-project-dir.e2e.test.ts` | 依赖自助 | **迁移**：同上补授权 |
| `web-host-permission-drawer.e2e.test.ts` AA6-1/2/3/5 | 三位矩阵 header、策略开关、`['provision']` 行 | **迁移**：级别单选 + 无策略开关；存储断言改为三位或 `['view']`；失败回滚断言保留 |
| `user-grant-resolution` / `web-permission-matrix` / `admin-authorization-directory` | 项目授权语义 | **保留**（项目位不变；仅当 fixture 里用到主机授权时补位） |
| `U40/web-admin-self-grant` | admin 自授 | **保留**（admin 旁路不受主机上限影响） |
| `r3-api-hardening`（host grants 输入） | 位校验 | **保留** |

**原则**：项目级授权的所有既有断言保留；只迁移「主机授权默认 open / 三位独立 UI / view 占位」三类被 U65 取代的断言。迁移必须在同一提交内红绿对照，禁止删除断言了事。

### 6.3 数据与配置迁移

- `Store` 无 schema 变化；无需迁移脚本。
- 既有主机授权行的重新解释：
  - `['provision']`（AA 常见）= 仅创建，无项目可见性推导 → 不产生越权扩大（安全方向）。
  - `['view']` = 从「无效果」变为「可见 + 只读全部项目」——这是 U65 的预期语义，但部署时会让被授予者突然看到全部项目，需在发布说明中标注。
  - `['provision','view']` = 可建 + 只读上限（混合位最小降级）。
  - 三位 = 全权。
- `provisionPolicy`：保留值、不再参与判定；管理台不再写。旧值 `open` 不会恢复全员可建。
- U40 种子授权、admin 自授、演示数据不变。
- 回滚：平台回滚后 `view` 重新变为占位；已签发的票据 TTL 60 秒，撤销记录保留但无消费者，回滚窗口内不产生新语义。

---

## 7. e2e 与实现切分

### 7.1 测试计划（AC 映射）

**纯函数单测（新 `cloud-platform/test/host-authority.test.ts`）**

- 位并集：用户行 + 组行、直接 + 间接组、大小写敏感。
- 级别判定：全权/只读/无/五种混合。
- E 合成：只读强制 `open+file:read`（P 含 terminal/write/download 也被裁）；全权六位 + 仅继承 `download`；无 view 返回 P；admin 旁路返回 P。
- 创建/维护判据。

**平台 e2e（沿用 `spawnService` PORT=0 真实进程）**

| AC | 用例 |
| --- | --- |
| AC-33 | 全权用户无项目授权：`GET /v1/projects` 含 P、Q；`GET /v1/projects/{P}` 200；`POST /connect` 凭证 claims `perms` = 六位且不含 `download`；`GET /available` `provisionAllowed=true`、`accessLevel='full'` |
| AC-34 | 只读用户 + 项目授权含 `terminal`/`file:write`/`download`：`GET /projects` 含全部；connect 凭证 `perms` = `['open','file:read']`；宿主侧（`cloud-session-e2e-harness`）`pty`/`files.write`/`browser.*` 被拒且 `method_denied` 审计；`files.read` 成功 |
| AC-35 | 只读用户：`available.provisionAllowed=false`；`POST /projects/self` 403 `HOST_PROVISION_FORBIDDEN` + denied 审计（reason/hostId） |
| AC-36 | 仅项目授权：`GET /projects` 仅 P；`GET /projects/{Q}` 404；`available` 不含可建；`POST /self` 403 |
| AC-37 | 全权后新增 Q（未授权）：`GET /projects` 含 Q；`GET /projects/{Q}` 200；connect 成功 |
| AC-38 | 全权降只读：`host_grant_update` 审计含 `accessLevel`/`revokedUsers`；新 connect 凭证降为 `open+file:read`；宿主心跳同步后在线会话关闭（harness 撤销断言） |
| AC-39 | 前端负向：orca web/桌面云会话无下载入口；`workspace.info.downloadAllowed=false`；若采纳审计端点则 `download_blocked` 落链；证据 JSON 含已知缺口 |
| AC-40 | 裸 RPC 逐方法：五个导出方法 + `browser.clientHost.fileChannel.read` 对无 `download`/策略 deny 的会话全拒；审计含 `projectId`/`method`/`denial`（+ `path`/`bytes` 可得时） |

**回归门**：AA2/AA3 迁移后全绿；`self-service-projects`、`self-service-project-dir`、`web-host-permission-drawer`、`user-grant-resolution`、`web-permission-matrix`、`cloud-download-policy`、`cloud-managed-no-export`、`r3-api-hardening`、`admin-gating`/`admin-denial-audit`。证据入 `cloud-platform/evidence/u65-host-grant-semantics/`（含观察输出原文，U27 纪律）。

### 7.2 实现令（每令 ≤20 分钟，域不相交）

| 令 | 通道 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- | --- |
| U65-1 | ① API 纯函数 | `host-authority.ts` 推导 + 矩阵单测；`hasHostPermission` 收口到 `hostBits` | 15–20 | — |
| U65-2 | ① API 消费点 | C1–C7 切 E；`projectView.hostAccess`；平台面 AC-33/34/36/37 | 20 | 1 |
| U65-3 | ① API 门禁 | C8/C9 + `provisionPolicy` 弃用 + `accessLevel`；AC-35/36 | 15 | 1 |
| U65-4 | ① API 撤销/审计 | C10 撤销（用户/组员、有效位收缩才撤）+ `host_grant_update` 字段；AC-38 平台面 | 15 | 2 |
| U65-5 | ② 管理台 | 级别单选 + 移除策略开关 + 文案 + AA6 探针迁移 | 20 | 2/3 |
| U65-6 | ③ 宿主可浏览 | worktree 读方法归 `file:read` + web bootstrap 只读激活 + 测试 | 20 | 2 |
| U65-7 | ③ 宿主契约 | `workspace.info.downloadAllowed` + `CloudWorkspaceInfo` + ticket perms 落 sidecar | 15 | — |
| U65-8 | ④ 前端一期 | 桌面云会话 3 处下载入口门禁 + orca web 门禁/断言 +（可选）`download-blocked` 端点调用 | 20 | 7 |
| U65-9 | ③ 宿主二期 | `fileChannel.read` 归 download + host-hosted 浏览器下载策略 + `path/bytes` 审计 | 20 | 7 |
| U65-10 | ⑤ 测试/证据 | AC-33~40 全量 + AA 迁移收口 + 证据 JSON | 20 | 全部 |

**通道不交叠**：① 只碰 `cloud-platform/apps/api/src`；② 只碰 `cloud-platform/apps/web/app.js`；③ 只碰 `src/main/**` + `src/shared/cloud-workspace-info.ts`；④ 只碰 `src/renderer/**`；⑤ 只碰 `cloud-platform/test/**` + evidence。③ 与 ④ 同属 `src/` 但子树不相交；U65-7 的共享类型只由 ③ 改。

**超时切分**：U65-2 若超时拆 `U65-2a 可见性+projectView` / `U65-2b handoff/connect`；U65-9 拆「映射+测试」/「浏览器分区」。

---

## 8. 开放问题（请主会话裁定）

1. **全权包含 `maintain` 的产品风险**：按 FR-9.10，全权=三位，意味着任何全权开发者都能把主机置为维护（拒新连接）。是否接受？备选是把维护权从全权里拆开（但会偏离 requirements 的级别定义）。本设计按 requirements 执行并显式标注风险。
2. **全权 + 显式项目 `download` 位**：FR-9.10 说 `download` 不在全权推导范围。本设计理解为「不推导、但继承项目级显式位」。若产品意图是「全权也不能下载」，则 E 恒剔除 `download`，AC-33 的「下载按策略」需改写。
3. **混合位输入**：`PUT /v1/hosts/{id}/grants` 是否继续接受任意三位组合并静默降级？建议接受（AA2 兼容、且管理台只写两级）；若要强约束，需同步迁移 AA2 的 `['provision','view']` 断言。
4. **组授权撤销的爆炸半径**：按组员逐个撤销会把该用户在所有主机的会话一起关闭（现有项目授权 user 行变更同语义）。是否值得新增 host 级撤销目标？那需要宿主理解新 `targetType`，旧宿主会静默忽略——不建议在一期做。
5. **一期 `download_blocked` 审计**：新增 `POST /v1/projects/{id}/download-blocked`（advisory）还是承认一期只有前端日志？FR-9.12/AC-39 要求审计，但前端可跳过；建议新增并按限速保护审计链。
6. **AC-40 的 `size` 字段**：拒绝点通常拿不到文件大小（`files.download` 参数不含 size）。建议 `bytes` 仅在有显式参数时记录，否则 `null`；若必须非空，需在拒绝路径 stat 目标文件（成本与副作用需评估）。
7. **`provisionPolicy` 的最终处置**：本设计保留字段但弃用。是否在下一版移除端点/字段？移除前需一个弃用周期。
8. **`worktree.list`/`show` 降为 `file:read`**：会让只读会话看到项目内的 worktree 元数据（路径/分支）。这是「浏览项目」所需的最小面；需安全评审确认不泄露宿主其它项目（路径护栏按票据 projectRoot 限定）。
9. **主机全权是否可归档/删除他人项目**：requirements 只写创建/登记；本设计保持归档/恢复为创建者或 admin。确认无遗漏。
10. **存量 `provisionPolicy='open'` 主机的切换**：U65 部署即收紧为「需 provision 位」，不做宽限；若需过渡期，需单独的公告/开关设计。

---

## 9. 验收对照（AC → 判定点）

| AC | 判定点（本设计中的位置） |
| --- | --- |
| AC-33 | §2.3 全权行；§4.1 C1/C3/C7；§7.1 |
| AC-34 | §2.3 只读行 + §2.4；§4.4；§7.1 |
| AC-35 | §4.3；§4.1 C8/C9 |
| AC-36 | §2.3 无主机授权行；§4.1 C3/C4/C8 |
| AC-37 | §2.3 全权行；§4.2（动态按 hostId 推导） |
| AC-38 | §3.3；§4.1 C10；§7.1 |
| AC-39 | §5.2；§5.4 |
| AC-40 | §5.3；§7.1 |

**置信度：约 90%**。高置信来自 requirements 的两级语义与现有代码路径逐点对应；主要不确定项是 §8 的开放问题 2/5/6/8，以及 AA 测试迁移的实际工作量（预计 3–5 个套件需要补主机授权 fixture）。


## 主会话审定（2026-11-15）

语义矩阵全盘采纳（含 effective perms 进票据+授权收缩撤凭证 FR-1.7 闭环+可见性推导+自助门禁收紧+管理台三选一）。§开放问题裁定：**全权不含 maintain**（最小权限）；**download 不推导**（确认）；**只读 remap 三读方法归 file:read+只读激活分支采纳**（AC-34 前提，安全评审点=只读分支不得触碰写路径）；一期 advisory 端点采纳；AC-40 size 可得性按现状。实现切分按 §切分表（10 令 ≤20 分钟），与需求 v1.4/原型对齐；**U65 文档族（需求 v1.4+原型）已落**，技术方案即本文档——三族齐后独立评审→修改/复审→开发+测试（用户流程纪律）。
