# LGA 设计 · LDAP 分组授权平台权限（组→角色映射 · 登录时重算 · 生产 LDAPS 接口）

> 状态：设计稿，**只设计不修码**；按 §10 切分在用户确认后启动实现令
> 日期：2026-11-16
> 需求唯一源：用户指令（本令）——LDAP 账号认证之外，**用户在 LDAP 的组决定其在平台的权限/角色**；需求文档逐字依据 `requirements.md` FR-1.5「用户与组信息按 LDAP 同步（登录时增量 + 定时全量），**角色由安全组映射，管理员可覆盖单个用户角色**」+ FR-9.2「角色绑定可编辑（按用户覆盖，覆盖记录留审计）」+ FR-1.7「权限变更下一操作生效；收回时 ≤60 秒断开」
> 语义基线：`work-orders/u67-authz-refactor-design.md` §7.3（roleOverride 优先先例 + 管理员降级撤凭证）+ `work-orders/u65-host-grant-semantics-design.md`（资源授权组主体语义、有效位收缩才撤——U65 C10 判例）
> 现状基线：HEAD 工作树实读——`cloud-platform/apps/api/src/ldap.ts`（接口 :13-15 / Mock :21-35）、`server.ts`（登录 :1682-1766 / knownGroups :380-390 / 用户管理 :2802-2880 / 撤凭证 :4100-4122 / env 入口 :4252-4301）、`store.ts`（User :4-15 / effectivePermissions :184-194 / revocations :119-125）、`host-authority.ts`（hostBits :20-32）、`apps/web/app.js`（用户页文案 :1435-1436 / :1476、审计下拉 :1818-1831）
> 范围：平台 API 登录链路 × 组→角色映射模块 × 生产 LDAPS 适配器 × 审计 × e2e；**非目标**：不做定时全量同步（FR-1.5 后半，U67 已裁定出范围，Q2 留独立工单）、不改 Grant/HostGrant 组主体的匹配语义、不动票据签发链路与 wire 字段、零新增端点

---

## 0. 结论摘要

**一句话**：把「角色在首登种子时一次定格」改为「**每次登录以 LDAP 组为唯一角色事实源重算**」——优先级阶梯 `roleOverride（管理员覆盖）> rolesFromGroups（组派生）> ['developer']（兜底）`；同时把登录时的组合并从**并集**改为**替换**（否则组移除永不传播，资源授权与角色都会滞留旧组）；映射表以**代码常量**落位（映射=安全白名单：不在表内的组安全兜底 developer，永不提权）；生产用**同接口** `LdapAdapter` 的 LDAPS simple-bind 适配器替换 Mock；登录重算写的是 store 活用户对象，叠加既有 revocations 用户级撤凭证链路，组变动（升与降）对该用户所有会话**下一请求即时生效**。零新增端点、零 wire 字段变更。

**核心取舍表**：

| 取舍点 | 选定 | 落选 | 一句理由 |
| --- | --- | --- | --- |
| 映射配置形态 | 代码常量表 | env 字符串 / 可配置端点 | 映射=安全白名单，随码走 PR 评审即天然审计链；可配置端点需要平台尚不存在的持久存储（store 进程内，重启即失）；env 覆盖留 Q1 |
| 角色授予语义 | 每次登录按组重算 | 首登种子冻结（现状） | FR-1.5 逐字要求「角色由安全组映射」；冻结使 LDAP 侧组撤销永不生效；需要固定角色者走 override 显式表达（U67-3 既有） |
| 组集合同步 | 登录时**替换** `user.groups` | 现状并集合并 | `user.groups` 是资源授权 join key（store.ts:189 / host-authority.ts:26），只增不删使 LDAP 侧移除对角色与组授权都永不传播 |
| 组降级传播时机 | 知情点（登录）即时生效 + 精确撤凭证 | 本令顺带做定时全量 | U67 已裁定定时全量出范围；FR-1.7 约束的是平台**已知情**变更（§4.2 语义对齐） |
| LDAP 不可达 | 503 不计锁定 | 现状（计入锁定 + 误报 401） | 不可达 ≠ 密码错误；现状故障 5 次即锁号且提示「密码错误」误导运维与用户 |

**置信度：高（约 85%）**。机制全部落在已核实的既有链路上（resolveToken 活用户对象每请求实时判定、revocations 用户级撤、`ApiConfig.ldap` 注入点 server.ts:93/:1118 现成）；不确定项集中在 §11 开放问题（真实目录 schema、定时全量需求、ldapts 依赖评审）。

---

## 1. 现状盘点（只读核实）

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| LDAP 适配接口 | `ldap.ts:13-15` | 单方法 `authenticate(username,password) → LdapResult`；失败分 `invalid_credentials / unavailable`；`LdapProfile.groups: string[]` **已含组信息**（本设计的主要既有前提，无需改接口） |
| Mock 适配器 | `ldap.ts:21-35` | Map 账户表；`ldapProfile` 缺省 `groups=['developers']`（ldap.ts:48）；注释已声明生产走同接口 LDAPS simple-bind |
| 登录链路 | `server.ts:1682-1766` | 锁定检查 → `ldap.authenticate`（:1702）→ 失败一律记锁定（**不区分 unavailable**，:1703-1721）→ 首登 `seedUser` 定角色（:1724-1736，`platform-admins` 组→`['platform:admin','developer']` **硬编码单条映射**）→ 组**并集**合并（:1737，只增不减）→ `roleOverride` 重写 roles（:1739-1741）→ 签发会话 + 审计；响应体 `roles/permissions` 是一次性快照（:1753-1764） |
| 角色模型 | `server.ts:338-358` | `ROLE_PERMISSIONS`（管控面位）、`USER_PAGE_ROLES`（页面三键→roles 数组）、`userPageRole` 逆映射（admin > auditor > developer） |
| roleOverride（U67-3） | `store.ts:13-14` + `server.ts:2874-2875` | 管理员从用户管理页写入即设 override；之后**每次登录**按 `USER_PAGE_ROLES[roleOverride]` 重写 roles——「覆盖后每次登录重算」已是现状（§7.3 注释 server.ts:1738） |
| 角色写入审计与撤凭证 | `server.ts:2853-2878` | `role_update` 审计 `{from,to,username,revoked}`；仅 admin→非 admin 降级撤 `revokeUserCredentials(username,'role_changed')` |
| 组→资源授权 | `store.ts:184-194` + `host-authority.ts:20-32` | `Grant`/`HostGrant` 组主体按 `user.groups.includes(subjectId)` 匹配，每请求实时（活对象） |
| knownGroups | `server.ts:380-390` | 登录组 ∪ grant 组主体的并集；`resolveGrantSubject` 用它拒「死行」（:405-420）；`GET /v1/directory` 输出它（:2797） |
| 撤凭证链（FR-1.7） | `server.ts:4100-4122` + `store.ts:119-125` | `revocations` 按 (targetType,targetId) upsert；用户级按 username（票据 `sub=user:<username>`）；grant 变更用户级撤（:2599-2604）；≤60s 心跳闭环 |
| 角色消费 | `server.ts:1189-1204` | `resolveToken` 返回 store **活用户对象**→`isAdmin()`/roles 门禁**每请求实时**（U67 §7.3 已裁定：票内只有资源位、与平台角色无关） |
| 多副本形态 | `login-lockout-client.ts` 头注 | API 多副本真实部署；store 进程内，角色/组/撤销各副本独立持有（**既有约束**，非本令引入，Q8） |
| Mock 账户 | `server.ts:1090-1118` | 三账户（zhangsan/admin/lisi）+ 种子行（:1121-1138）+ 组 grant（team-payment，:1176-1181）；`config.ldap ?? new MockLdapAdapter(accounts)`（:1118） |

**现状的两个结构性缺陷（本设计的直接动机）**：

1. **角色冻结**：非 override 用户角色只在首登种子，此后 LDAP 组升/降都不跟随——组撤销永不生效，与 FR-1.5「角色由安全组映射」直接冲突。
2. **组只增不删**（server.ts:1737 并集）：`user.groups` 是资源授权 join key，LDAP 侧移出组后项目/主机组授权照旧命中（store.ts:189），撤权永不可能。

---

## 2. LDAP 组→平台角色映射

### 2.1 缺省映射表

```ts
// cloud-platform/apps/api/src/ldap-role-groups.ts（新模块：纯常量+纯函数，无 I/O，可单测）
export const LDAP_ROLE_GROUP_MAP: Record<string, PlatformRole[]> = {
  'platform-admins': ['platform:admin'],
  'platform-auditors': ['platform:auditor']
}

export function rolesFromGroups(groups: string[]): string[]
// = ['developer', …各组映射值并集排序去重]；未知组/空组 → ['developer']
```

语义细则：

- **developer 是认证基座而非映射目标**：任何通过 LDAP 认证的用户都有 `['developer']` 底座——映射表里不出现 `developer` 键，避免「移出所有组=无角色」的歧义（无角色用户连 `userPageRole` 逆映射都无法归约）。
- **未知组安全兜底**：不在表内的组不派生任何位——写错组名/删除映射只会**降权**不会提权（fail-safe 方向）。这与既有硬编码（`includes('platform-admins')`，server.ts:1731）等价，只是显式化为表。
- **复合派生**：同时持有 `platform-admins` 与 `platform-auditors` → `['developer','platform:admin','platform:auditor']`；`userPageRole`（server.ts:354-358）归约显示管理员（admin 优先）。此后管理员写入 override 会**塌缩为单键**——这是显式动作且留审计，可接受（Q6）。
- **映射值保留数组形态**：一组多角色（如 `platform-ops → [admin, auditor]`）无需改函数签名。
- 替换既有硬编码：登录种子与派生统一走 `rolesFromGroups`；`createApp` 种子行（admin/zhangsan，server.ts:1121-1138）的显式 roles **保留不动**（启动引导数据，任何登录前不存在派生时机）。

### 2.2 配置形态三选一取舍（选定：代码常量表）

| 形态 | 优点 | 缺点 | 判定 |
| --- | --- | --- | --- |
| **代码常量表**（选定） | 类型安全、可单测；变更走 PR 评审=天然审计链；与本仓「映射是安全语义」的定位一致 | 改映射需发版 | **选定**。映射是安全白名单，把变更节奏压到代码评审是收益不是成本；现状单部署（docker 单镜像）无跨部署差异诉求 |
| env（如 `ORCA_CLOUD_LDAP_ROLE_MAP`） | 部署期可变，子进程 e2e 可注入 | 字符串解析易错且**静默失效**（typo→组不映射→静默降权）；无类型；改动不留审计痕迹 | 落选为缺省机制；留 Q1 作第二部署出现时的加性扩展位 |
| 可配置端点（管理台编辑） | 运营最灵活 | 需要持久存储（store 进程内，重启即失，须先做落盘）；管理台误操作=提权面；还要新增端点+UI+审计 | 落选。为「极少变更的映射」引入一整套存储与攻击面，不成比例 |

---

## 3. 登录时角色授予机制（核心取舍）

### 3.1 两种语义取舍

| 语义 | 行为 | 优点 | 缺点 | 判定 |
| --- | --- | --- | --- | --- |
| **登录刷新**（选定） | 每次登录按 `rolesFromGroups(profile.groups)` 重算（override 除外） | 组变动自动跟随（升与降）；FR-1.5 逐字满足；无需同步设施 | LDAP 侧降级只在下次登录可见（§4.2） | **选定**。「撤销生效」是安全需求的下限 |
| 种子一次（现状） | 首登定格，此后冻结 | 行为可预期；LDAP 抖动不影响在册角色 | 组撤销**永不生效**（升级也要等管理员手改）；与 FR-1.5 冲突 | 落选。需要固定角色的用户改用 override 表达——「固定」从默认隐式行为变为显式管理动作 |

与 U67 文案的关系：U67 §7.1 页脚语义行「…首次登录映射为管理员，此后按用户覆盖优先，再次登录不会被同步覆盖」描述的正是种子一次语义；本令将其修正为「角色按登录时 LDAP 组实时派生；管理员覆盖后覆盖优先，再次登录不会被同步覆盖」——后半个分句（override 用户）语义不变，前半个分句是**本令的显著行为变更**，须在 §8 迁移表与发布说明显式声明。

### 3.2 优先级阶梯（override > 组派生 > developer 兜底）

登录处理器（server.ts:1723-1741）改为：

```ts
const prevRoles = user.roles
const prevGroups = user.groups
user.groups = [...new Set(result.profile.groups)]          // 并集 → 替换
if (user.roleOverride) {
  user.roles = USER_PAGE_ROLES[user.roleOverride]          // 第一优先：管理员覆盖（U67-3 既有，不动）
} else {
  user.roles = rolesFromGroups(user.groups)                // 第二优先：组派生（首登/再登同一路径）
}                                                          // 第三优先：rolesFromGroups 空映射兜底 ['developer']
```

- 首登 `seedUser`（:1724-1736）的 roles 参数改为 `rolesFromGroups(result.profile.groups)`——种子与再登走同一派生函数，硬编码 `platform-admins` 分支删除。
- **代码路径上 override 与派生是二选一**，「优先级」体现在：override 存在时派生结果被完全遮蔽（含降级——组移除不会削弱 override 用户，管理员明示的意图优先于组事实）。

### 3.3 免费搭既有实时链路：为什么无需新设施

`resolveToken`（server.ts:1189-1204）返回 store 活用户对象，角色/组门禁**每请求实时读**。因此登录重算写入 user 对象的瞬间：

- 该用户**所有在途会话**（多设备、web handoff 会话共享同一 user 对象）的下一请求即按新角色判定；
- 组替换同理——`effectivePermissions`/`hostBits` 实时读 `user.groups`，组授权位下一请求即收缩。

真正需要额外动作的只有一件：**已签票据**的位是签发时快照（票据 `perms`），位高于现有效位时必须撤——§4.3 的精确规则。

### 3.4 降级撤凭证的精确规则（避免误伤）

登录重算后：

```
revoke ⟺ (prevRoles 含 platform:admin 且新 roles 不含)
       OR (被移除的组中存在任一 grant/hostGrant 的组主体引用)
revokeUserCredentials(username, admin丢失 ? 'role_changed' : 'group_membership_changed')
```

- admin 丢失复用既有 `role_changed`（与 `PUT /v1/users/{id}/roles` 降级同词汇、同粒度——旧票据按 admin 旁路上限签发，U67 §7.3 同款理由）。
- 组收缩触发撤销仅当被移除的组**实际被资源授权引用**（store.grants/hostGrants 主体匹配）——位收缩才撤（U65 C10 判例）；无人引用的组变动只改 `user.groups`，不撤不审计（噪声守门，用户无感）。
- 粒度是**用户级**（票据 `sub` 只有用户维度，主机不解析组——server.ts:2596-2598 既有注释），与 `grant_changed` 撤销同粒度，不新增粒度语义。

### 3.5 LDAP `unavailable` 不计锁定（顺带缺陷修复）

现状 `if (!result.ok)` 一律进 `recordLoginFailure`（server.ts:1703-1721）：LDAP 故障期间用户连试 5 次「平台错误」即被锁 15 分钟，且响应 401「账号或密码错误」误导。改为分支：

- `reason === 'invalid_credentials'` → 既有锁定+401 路径不动；
- `reason === 'unavailable'` → 503 `PLATFORM_UNAVAILABLE`、**不进锁定计数**、审计仍记 `login/failure{reason:'unavailable'}`（可观测）。

对齐共享锁定客户端的既有哲学——服务不可达不得被读作「未锁定」的镜像面：不可达也不得被读作「密码错误」（login-lockout-client.ts:5-8、lockoutUnavailable :65-68）。

---

## 4. 组成员变更传播（FR-1.7 对齐）

### 4.1 两条传播路径

| 变更源 | 传播机制 | 延迟界 | 撤凭证 |
| --- | --- | --- | --- |
| **平台侧**（grants/roles PUT、管理员覆盖） | 既有链路原样：活对象实时 + `revokeUserCredentials` | 下一请求；票据 ≤60s 心跳断开（FR-1.7） | 既有规则，本令不动 |
| **LDAP 侧**（组升降） | 下次登录：`authenticate` 返回新组 → 替换 `user.groups` + 重算 roles → 活对象即时生效 + §3.4 精确撤凭证 | **该用户下次登录**（§4.2 诚实界） | §3.4 精确规则 |

### 4.2 「下次登录」延迟界的诚实声明

LDAP simple-bind 用**用户密码**验证，refresh 流程没有密码、不能 re-bind，因此组同步点只能是登录。access token 30 分钟、refresh 12 小时且每次刷新续期（server.ts:1786）——理论上会话可无限滚动，LDAP 侧降级延迟上界 = 用户下次主动登录（实际界受 12h refresh 窗口约束的印象**不成立**，须按无上界对待）。

**语义对齐 FR-1.7 不违背**：FR-1.7 约束「会话期间**权限变更**」——即平台已知情并落库的变更（grants/roles），这条由既有 ≤60s 链路承载；LDAP 侧组变动是「平台尚未知情的变更」，知情点=登录，知情后**立即**生效+撤凭证。把延迟压到登录以下需要定时全量同步（服务账号 bindDN 拉组）——FR-1.5 P1 后半，U67 已裁定出范围，留 Q2 独立工单（须连同副本扇出一起设计，Q8）。

### 4.3 降级后的状态收敛（举 admin 例）

1. 用户被移出 `platform-admins`（LDAP 侧操作）；
2. 该用户下次登录：派生 roles 降为 `['developer']`，`role_refresh` 审计 `{from:…admin,to:developer}`；
3. `revocations` 落 `user/'role_changed'` 记录 → 该用户已签票据在 ≤60s 心跳后失效（与 `PUT /v1/users/{id}/roles` 降级完全同链路）；
4. 旧 access token 下一请求即 403 管控面端点（活对象已降）——双保险，与 U67-3 UG-3 断言形态一致。

---

## 5. 资源授权联动（组作为项目/主机 grants 的组主体）

- **匹配语义零改动**：`store.effectivePermissions`（store.ts:184-194）与 `hostBits`（host-authority.ts:20-32）按 `user.groups.includes(subjectId)` 匹配，原样保留。变得更真实的只是 `user.groups` 的内容（替换语义）。
- **组在资源授权中的既有语义保持**（本令需求④）：任何 LDAP 组（含角色映射组 `platform-admins`/`platform-auditors`）都可作 Grant/HostGrant 主体——**单一命名空间**（组名即组名，不因它映射了角色而分区），显式声明为不变量。
- **knownGroups 收缩行为**（server.ts:380-390）：替换语义后，一个既无登录成员又无 grant 引用的组会从 `/v1/directory` 消失——这正是 A1「平台见过的组」的定义（登录组∪grant 组），无需改函数；grant 已引用的组永不消失（union 的 grant 侧不变），`resolveGrantSubject` 对死行的拒绝语义（GROUP_NOT_FOUND，:414）不变。
- **登录组收缩 → 组授权失效的完整链**：移出 `team-payment` → 下次登录 `user.groups` 不再含它 → 该用户在组授权项目上的有效位实时归零（下一请求 403/无可见）→ 已签票据因该组被 grant 引用而撤销（§3.4）≤60s 断开。升级方向（新加入组）无需撤销，只增不减是安全方向。

---

## 6. 生产 LDAPS 接口（同 interface 不变）

### 6.1 接口形态

`LdapAdapter` 接口（ldap.ts:13-15）**一字不改**；新增生产适配器模块 `cloud-platform/apps/api/src/ldaps-adapter.ts`：

```ts
export type LdapsAdapterConfig = {
  url: string                 // ldaps://host:636；ldap:// 仅在显式允许 StartTLS 时放行
  userBase: string            // 用户子树，如 'DC=example,DC=com'
  userFilter: string          // 如 '(sAMAccountName={{username}})'，{{username}} 转义后替换
  groupAttr: string           // 缺省 'memberOf'
  bindDn?: string             // 可选服务账号：嵌套组/受限目录的搜索用；缺省以绑定用户自身读组
  bindPassword?: string
  caPath?: string             // 自签/私有 CA（企业 AD 常态）
  groupDnToCn: boolean        // 'CN=platform-admins,OU=…' → 'platform-admins'（AD 缺省开）
  timeoutMs: number
}
export function createLdapsAdapter(config: LdapsAdapterConfig): LdapAdapter
```

bind 流程：TLS 连接 →（配置了服务账号则先服务 bind）→ 按 userFilter 搜出用户 DN → 用**用户密码** simple bind（认证本体，平台不经手存储密码——ldap.ts:19 既有契约）→ 读 user 条目 groupAttr（或服务账号搜嵌套组）→ 映射 `LdapProfile`。

错误映射（消费端 server.ts 已按 reason 分流，§3.5）：

| LDAP 事件 | LdapResult | 平台行为 |
| --- | --- | --- |
| bind 被拒（invalidCredentials） | `invalid_credentials` | 锁定计数 + 401（既有） |
| 连接/超时/搜索失败/证书错误 | `unavailable` | 503、不锁（本令修复） |

### 6.2 装配与配置（env，沿用 `ORCA_CLOUD_*` 命名与入口展开模式 server.ts:4252-4301）

| env | 作用 | 缺省 |
| --- | --- | --- |
| `ORCA_CLOUD_LDAP_URL` | **存在即选 LdapsAdapter**（入口 `...(env ? { ldap: createLdapsAdapter(...) } : {})`）；未设 → Mock（dev/测试缺省）+ 启动警告日志 | 未设 |
| `ORCA_CLOUD_LDAP_USER_BASE` | 用户子树 | 必填（随 URL 一起校验，缺则启动失败 fail-fast） |
| `ORCA_CLOUD_LDAP_USER_FILTER` | 用户查找过滤器 | `(sAMAccountName={{username}})` |
| `ORCA_CLOUD_LDAP_GROUP_ATTR` | 组属性名 | `memberOf` |
| `ORCA_CLOUD_LDAP_BIND_DN` / `ORCA_CLOUD_LDAP_BIND_PASSWORD` | 服务账号（嵌套组搜索） | 未设（以绑定用户读组） |
| `ORCA_CLOUD_LDAP_TLS_CA` | CA 证书路径 | 系统 trust |
| `ORCA_CLOUD_LDAP_GROUP_DN_TO_CN` | DN→CN 归一 | `1` |
| `ORCA_CLOUD_LDAP_TIMEOUT_MS` | 连接/搜索超时 | `5000`（复用 `AbortSignal.timeout` 模式，同 login-lockout-client） |

`ApiConfig.ldap?: LdapAdapter`（server.ts:93）注入点不动——测试注入与生产装配走同一入口。

### 6.3 依赖选型（待评审，Q5）

Node 内置无 LDAP 客户端，候选：**`ldapts`**（纯 TS、ESM、活跃维护——倾向此项）/ `ldapjs`（维护停滞）/ 自写 BER bind+search（不推荐，面大）。依赖引入走独立评审后才启动 LGA-4；接口不变保证该决策完全局部化。契约测试以注入 `clientFactory` 的桩覆盖（§9 LG-10），真实目录验收挂 `ORCA_REAL_LDAP_TEST=1` 门（同 `ORCA_REAL_CLAUDE_CLI_TEST` 先例）。

---

## 7. 审计与安全

| 事件/机制 | 内容 |
| --- | --- |
| `role_sync`（新增事件） | 登录时派生角色变化**或**触发撤凭证时记录（组无变化不记——login success 已覆盖签到事实，噪声守门）；metadata `{from, to, groupsAdded, groupsRemoved, revoked, source:'ldap'}`；`AUDIT_EVENT_OPTIONS` 加「LDAP 角色同步 · role_sync」一项（app.js:1818-1831 处追加） |
| 提权审计 | `to` 含 `platform:admin` 的 `role_sync` 即提权留痕（操作者=本人登录，非管理员动作——审计页按角色同步筛选即可核查全部组→admin 的授予面）；管理员显式覆盖仍走既有 `role_update` |
| 降级撤凭证 | 复用既有 reason 词汇：admin 丢失=`'role_changed'`、组收缩=`'group_membership_changed'`（新增一条，不造同义词）；撤销记录与 ≤60s 断开链路全部既有 |
| 映射表变更审计 | 常量表随码——PR diff 即审计记录（§2.2 选型的直接收益）；若 Q1 引入 env 覆盖，须同时加「启动时审计一行映射内容」义务，避免部署期静默改映射 |
| 安全不变量 | 派生只授予映射表内角色（表=白名单）；未知组兜底 developer（永不提权）；override 写入仍 admin-only+`role_update` 审计（既有）；密码不经手存储（接口契约既有）；审计 metadata 只含组名与角色串（组名已在用户页展示，非新增敏感面） |
| 最后管理员 | 组模式下兜底更强：任何 `platform-admins` 成员登录即恢复 admin（比 U67 时代「首登映射」兜底覆盖面更广）；控制台「至少一名管理员」硬约束是否仍需要→Q7 |
| LDAP 故障安全 | `unavailable` 不锁不误报（§3.5）；认证必须经 LDAP，无旁路（与现状一致） |

---

## 8. 兼容与迁移

### 8.1 用户类行为对照

| 用户类 | 现状 | 本令后 | 迁移动作 |
| --- | --- | --- | --- |
| override 用户（U67-3 设置过） | override 每次登录重写 roles | **不变** | 无 |
| 非 override、组从未变 | 首登种子（恰与组一致） | 每登录重算，结果恒等 | 无感 |
| 非 override、组升级 | 冻结在旧角色 | 跟随升级（预期行为变更） | 无 |
| 非 override、组降级（含 admin） | **冻结保权**（缺陷） | 降级+精确撤凭证（预期行为变更，安全方向） | **显著行为变更，PR/发布说明显式声明** |
| 种子行（admin/zhangsan） | 显式 roles | 保留至下次登录按组重算；admin 组在→恒等 | 无 |

### 8.2 wire 与接口

- 零新增端点、零字段变更；`GET /v1/users` 的 `roleSource`（server.ts:2822）标签不变，语义从「首登映射」变为「登录时组派生」——对前端无感。
- 登录/refresh 响应体形状不变（roles 快照语义沿用 U67 §7.3 裁定：前端导航陈旧面不为此做推送）。

### 8.3 UI 文案修订点（app.js 三处，随 LGA-5）

| 位置 | 现文案 | 修订 |
| --- | --- | --- |
| :1436 页脚语义行 | 「LDAP platform-admins 组成员**首次登录**映射为管理员，此后按用户覆盖优先，再次登录不会被同步覆盖」 | 「角色按**登录时** LDAP 组实时派生；管理员覆盖后覆盖优先，再次登录不会被同步覆盖」 |
| :1476 确认弹框 | 「变更写入 role_update 审计；按用户覆盖优先于 LDAP 同步，再次登录不会被同步覆盖。」 | 保留（override 语义仍真），句尾补「未覆盖用户按 LDAP 组派生」 |
| :1435 usersFoot | 仅有 role_update 筛选提示 | 补「组派生变更按 role_sync 筛选」句 |

### 8.4 测试与部署兼容

- 静态三账户与全部既有 e2e 不受影响（缺省 Mock 不动）；LGA-4 生产适配器仅在被 env 选中时装配。
- in-memory store 重启即重置（既有条件）：重启后角色/override 清空、下次登录按组重派——派生是确定性的，重启不引入漂移。

---

## 9. 测试计划

**前提机制**：进程内 `createApp({ ldap: <测试自有可变 Mock> })`（注入点 server.ts:93/:1118 现成；进程内先例 u66-audit-file-events / session-renewal 等）——组「登录间变化」场景必须可在两次登录之间改适配器账户表，子进程套件做不到；子进程 UI 套件（u67-3）沿用静态三账户不动。

新建 `cloud-platform/test/e2e/ldap-group-authz.e2e.test.ts`：

| # | 场景 | 断言 |
| --- | --- | --- |
| LG-1 | 首登映射 | `platform-admins` 用户首登 roles=`['developer','platform:admin']`；`developers` 用户=`['developer']`；`platform-auditors` 用户=`['developer','platform:auditor']` |
| LG-2 | 登录刷新（升） | auditor 组用户两次登录均含 `platform:auditor`（非首登特惠）；两次登录间 adapter 加组 → 再登录 roles 升 + `role_sync{from,to}` |
| LG-3 | override 优先级 | 先 `PUT /v1/users/{id}/roles` 设 auditor（override），再把组改为 platform-admins → 再登录 roles 仍 `['developer','platform:auditor']`、roleSource=`'admin-override'`、无 role_sync |
| LG-4 | 组移除降级（非 admin） | 移出 auditor 组 → 再登录 roles 降 `['developer']` + `role_sync{from:auditor,to:developer}` |
| LG-5 | admin 组移除 | roles 降 + `revocations` 含 `user/'role_changed'` + 旧 access token 下一请求 403 + 已签票据心跳后失效（复用 U67-3 UG-3 断言形态） |
| LG-6 | 组移除→资源授权失效 | `team-payment` 成员移组 → 再登录 `user.groups` 不含它 → 项目 open 403；`revocations` 含 `'group_membership_changed'`（该组有 grant 引用） |
| LG-7 | 无引用组移除（噪声守门） | 移出无 grant 引用的组 → 登录成功、groups 更新、不撤凭证、不记 role_sync |
| LG-8 | unavailable 不计锁定 | 注入恒 unavailable adapter → 503 `PLATFORM_UNAVAILABLE` + 锁定计数不变 + 恢复后正常密码登录不被误锁 |
| LG-9 | 派生函数单测 | `rolesFromGroups`：映射全覆盖/未知组兜底/复合组/空组/确定性排序；`userPageRole` 对派生 roles 的三键归约 |
| LG-10 | LdapsAdapter 契约（LGA-4） | 桩 client 注入：bind 拒→`invalid_credentials`；连接/超时→`unavailable`；groupAttr 读取；DN→CN 归一；filter 转义；真实目录验收挂 `ORCA_REAL_LDAP_TEST=1` |

**回归门**：`u67-3-users-page`（UG-1~UG-6 全绿——override 链路未动）、`platform.e2e`（登录流）、`admin-authorization-directory`（knownGroups 收缩面）、`host-authorization`（组主体匹配未动）、`login-lockout-shared`（invalid 路径未动）。红绿对照同一提交，禁止删断了事。

---

## 10. 实现切分（每令 ≤20 分钟，通道不交叠）

| 令 | 通道 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- | --- |
| LGA-1 | ① `apps/api/src` | `ldap-role-groups.ts`：映射表 + `rolesFromGroups` + LG-9 单测 | 10 | — |
| LGA-2 | ① 登录链路 | 组替换 + override/派生阶梯（种子走同一函数）+ `role_sync` 审计 + §3.4 精确撤凭证 + `unavailable` 503 分支 | 20 | 1 |
| LGA-3 | ③ `test/**` | `ldap-group-authz.e2e.test.ts` LG-1~LG-8（进程内可变 adapter） | 20 | 2 |
| LGA-4 | ① `ldaps-adapter.ts` | `createLdapsAdapter` + env 装配 + LG-10 契约单测；**依赖评审（Q5）未放行则本令挂起** | 20 | 1 + Q5 |
| LGA-5 | ② `apps/web` | 文案三处（§8.3）+ 审计下拉 role_sync 项 | 10 | 2 |
| LGA-6 | ③ 回归+证据 | §9 回归门全量 + 证据 JSON（`cloud-platform/evidence/ldap-group-authz/`） | 15 | 2,3,5 |

**超时切分**：LGA-2 拆 `2a 替换+阶梯` / `2b 审计+撤凭证+503`；LGA-4 拆 `4a bind+搜索` / `4b profile+组归一`。
**通道不交叠**：① `cloud-platform/apps/api/src`；② `cloud-platform/apps/web`；③ `cloud-platform/test/**` + evidence。

---

## 11. 开放问题

| # | 问题 | 现倾向 |
| --- | --- | --- |
| Q1 | 映射表 env 覆盖（`ORCA_CLOUD_LDAP_ROLE_MAP`）：第二部署出现真实差异时再加 | 暂不做；届时须带「启动审计映射内容」义务 |
| Q2 | 定时全量同步（FR-1.5 P1 后半）：服务账号 bindDN 周期拉组，把 LDAP 侧降级延迟从「下次登录」压到「≤周期」；须连同副本扇出一起设计 | 独立工单，本令不做（U67 裁定沿用） |
| Q3 | refresh 不 re-bind 导致的延迟界（§4.2，理论上无上界）：接受「下次登录」界，还是缩 refresh TTL 换窗口 | 接受现状界；运维如有 SLA 再议 |
| Q4 | 真实目录 schema（`memberOf` vs OpenLDAP `member`、DN/CN 形态、嵌套组是否在范围内） | LGA-4 硬化前须对真实 AD/LDAP 核实；验收挂 `ORCA_REAL_LDAP_TEST=1` |
| Q5 | LDAP 客户端依赖引入评审：ldapts / ldapjs / 自写 | 倾向 ldapts；评审放行前 LGA-4 挂起 |
| Q6 | 复合派生角色（admin+auditor）被 override 塌缩为单键 | 可接受：覆盖是显式动作+审计 |
| Q7 | 「至少保留一名管理员」硬约束（U67 遗留）：组模式下兜底=任意 platform-admins 成员登录即恢复，控制台硬锁是否还需要 | 待 ops 确认，本令不加 |
| Q8 | 多副本 in-memory store 的角色/组/撤销收敛（登录落在哪个副本、哪个副本的状态生效）——**既有约束，非本令引入**，但组同步放大其可见性 | 与 Q2 合并设计；单副本部署不受影响 |


## 主会话审定（2026-11-16）

全盘采纳：①**登录刷新语义**（LDAP 组=角色唯一事实源，每次登录重算；需固定角色者走 U67-3 roleOverride 显式表达）——否决种子一次（组撤销永不生效违背 FR-1.5）；②映射=**代码常量表**（安全白名单 PR 评审即审计链；可配置端点需不存在的持久存储，env 留开放问题）；③**精确撤凭证**（丢失 admin 或被移除组被 grants 引用才撤，噪声守门）+LDAP unavailable 改 503（修既有 401 误报缺陷，顺带项）；④传播时机诚实声明（下次登录生效；定时全量同步 Q2 独立工单）；⑤资源授权联动零语义改动；⑥生产 LDAPS 同接口适配（ldapts 依赖评审开放）。实现切分 LGA-1~6 待独立评审后派发（U67-3 roleOverride 页面已上线，兼容面已核）。
