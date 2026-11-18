# LDAP 分组准入设计（memberOf group filter · 单组登录门槛 · 角色与组解耦）

> 状态：**已交付**（两轮评审 APPROVED 预授权 → LGAA 六令 6/6 落地 → 独立验收审计通过 2026-11-16；全过程见台账 U69a 行）
> 日期：2026-11-16 · 缺陷账：U69a（defect-ledger.md:81，LDAP 方案方向错误撤回）
> 需求唯一源：用户澄清（台账 U69a 行 + 本会话指令）——**多系统共用一个 LDAP，每个系统的登录权限对应一个分组，用户加入分组才能登录对应系统**。本系统是其中一个子系统，对应一个分组（组名 env 可配，如 orca-cloud），**只认这个分组的用户**；LDAP 分组=**登录准入门槛**；登录后角色（普通/审计/管理员）仍由平台内管理（U67-3 用户管理页 roleOverride+首登种子）——**与组无关**
> 用户本会话两次追加指令（裁决记录）：①「memberOf」②「**使用 memberOf group filter 方案**」——准入过滤采用调研**形态 A 正宗**：组条件以 **memberOf** 内嵌用户查找 filter（LDAP 查询侧执行，Gitea User Filter / GitLab user_filter / FAB AUTH_LDAP_SEARCH_FILTER 同款）；**不是** posixGroup member 反查（Gitea 双向形态），**不是** Keycloak 形态 C 的纯应用侧自查
> 语义基线：作废标记 `work-orders/ldap-group-authz-design.md`（组→角色映射方向全文作废）+ `work-orders/u67-authz-refactor-design.md` §7.2/§7.3（roleOverride 优先于种子）+ `requirements.md` FR-1.1/FR-1.4/FR-1.6（认证/锁定/吊销既有语义不动）
> 业界对照：`work-orders/ldap-open-source-survey.md`（Gitea/GitLab/Jenkins/Keycloak/Grafana/FAB 六项调研，提交 `5c82d39294f`，用户指令要求对齐）
> 现状基线：HEAD 工作树实读——`cloud-platform/apps/api/ldap.ts`（LdapAdapter/LdapProfile.groups/Mock）、`server.ts`（登录链 :1682-1767、authenticate :1702、种子 :1723-1737、roleOverride :1739-1741、内联组→角色规则 :1731-1733、env 装配先例 :736/:4270、handoff :1827-1875）、`ldap-role-groups.ts`（LGA-1，未被引用）、`store.ts` User（:4-14）、`apps/web/app.js`（登录错误透传 :2383-2388）
> 范围：平台 API 登录链准入过滤 × LGA-1 去留裁定 × Mock/生产适配形态 × 测试 × 切分；**非目标**：不做组→角色映射（已作废）、不做定时全量同步（U67 已裁定）、不做移出组后存量会话 ≤60s 撤销（一期只做登录时判定，§3.7）、不实现生产 LDAPS 适配器本体（只定接口、filter 形态与边界，独立工单）、requirements.md FR-1.5 措辞修订并入 LGAA-5（§9-3 裁定，覆盖本条原非目标表述）

---

## 0. 结论摘要

**一句话**：按用户钦定的 **memberOf group filter 方案**（调研形态 A 正宗），准入条件=filter `(&(uid=<用户>)(memberOf=CN=<准入组>,<组搜索基>))`——**生产 LDAPS adapter 在用户查找 filter 内嵌 memberOf 准入条件**，filter 未命中即目录里无此准入用户；`ORCA_CLOUD_LDAP_REQUIRED_GROUP`（单个 CN 名单值，env 存在才启用、缺省全放行=Gitea/GitLab/FAB 同款 fail-open-on-unset）同时驱动查询侧 filter 与平台侧统一闸门（`profile.groups ∋ 准入组`，Mock 的唯一执行点+生产的防御第二道）；拒绝统一映射 `401 LDAP_GROUP_NOT_ADMITTED` + 明确提示 + `login` 失败审计（reason=`ldap_group_denied`）+ **不计锁定、不建用户行**；角色派生与组彻底脱钩。

**LGA-1 裁定：删除**（前向删除 `git rm` 两个文件；不 revert 提交、不抹历史；处置步骤 §4.1）。`ldap-role-groups.ts` 是被用户裁定作废的「形态 B 组→角色映射」，且现状就是死代码（`rolesFromGroups` 仅被自身测试引用，server.ts 从未 import）；留着会让后来者误以为映射方向仍可启用。若未来真需要组分层权限，按届时语义重新设计，不复活这份提交。

**形态选择的如实说明**：任务原稿拟「过滤在平台侧做而非 LDAP 查询侧」；用户在本会话两次追加指令（memberOf → memberOf group filter 方案）后定为**查询侧 filter（形态 A 正宗）**。平台侧闸门仍保留，但角色降级为「统一语义点+防御第二道」：Mock 无 LDAP 查询层，闸门是它的唯一执行点；生产中 filter 是主执行点，闸门兜 adapter 漂移。两层由同一 env 驱动、同一判据（memberOf 含准入组），不存在分歧。

**裁定项清单索引**（主会话收货核对用）：形态 A 单组准入+定死 memberOf 不做双栈=§3.3/§3.5/§8-Q2；拒绝行为+明确提示+ldap_denied 类审计=§3.2（文案钦定值 vs survey 建议值列终审项 T1）；移出组善后一期登录时判定+`ldap_blocked` 式二期挂账=§3.7/§8-Q3；:1731 内联规则冲突裁定建议（废除）=§4.2（终审项 T2）；LGA-1 去留+处置步骤=§4.1；AC→用例映射表=§7.0；兼容性声明=§3.6。

**置信度：高（约 85%）**。登录链、env 装配、错误透传、LGA-1 死代码均实读核实；生产 filter 流程与二分 miss 诊断依赖真实目录形态（memberOf 可用性、search 权限），已如实列为部署前置与开放问题（§8）。

---

## 1. 需求与现状对照

### 1.1 需求逐条（唯一需求源=U69a + 用户本会话指令）

| #  | 需求                                                                                     | 本设计落点                                        |
| -- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| R1 | 登录链 authenticate 成功后检查 `profile.groups ∋ 平台分组`                               | §3.1 平台统一闸门（统一语义点+防御第二道）        |
| R2 | 组名 env 配置（`ORCA_CLOUD_LDAP_REQUIRED_GROUP`），env 存在才启用、缺省不过滤保持兼容    | §3.4 配置装配（沿 loginLockoutUrl 先例）          |
| R3 | 不包含 → 401 + 明确提示「该账号未授权访问本系统」                                        | §3.2 错误码/文案/审计（含查询侧 miss 的统一映射） |
| R4 | 种子/会话/既有登录路径全走过滤                                                           | §3.4 路径覆盖表                                   |
| R5 | LGA-1 映射表去留裁定（如实）                                                             | §4.1：删除+处置步骤                               |
| R6 | Mock 测试形态适配；生产 LDAPS 同接口；simple-bind 边界如实说明                           | §5（Mock 需真实适配镜像生产路径，§5.1）           |
| R7 | **使用 memberOf group filter 方案**（用户两次追加指令）                                  | §3.3/§3.5：形态 A 正宗查询侧 filter；不做双栈     |
| R8 | 测试计划（在组成功/不在组拒绝+提示/无 env 零回归/种子兼容/多组边界）                     | §6 + §7.0 映射表                                  |
| R9 | 切分 ≤20 分钟令                                                                          | §7                                                |

### 1.2 现状链路（HEAD 实读）

```
POST /v1/auth/login（server.ts:1682）
  loginLockState → 503/423（:1686-1700，锁定语义 FR-1.4 不动）
  ldap.authenticate(username, password)        ← 全平台唯一调用点（:1702）
  ├─ !ok → recordLoginFailure + 审计(login/failure) → 401 INVALID_CREDENTIALS / 423 ACCOUNT_LOCKED（:1703-1720；
  │        现状不分 reason，unavailable 也走此路——§6.1-A11 如实记录该疣与 LG-8 改进挂账）
  └─ ok  → clearLoginFailures（:1722）
            usersByName.get → 无则 seedUser（:1723-1735）
            │   种子角色内联规则：profile.groups.includes('platform-admins')
            │     ? ['platform:admin','developer'] : ['developer']   ← :1731-1733（组→角色残留，§4.2 裁定建议废除）
            │   既有用户：角色冻结，仅 roleOverride 非空时重算（:1739-1741，U67-3）
            groups 并集合并（:1737，供 Grant/HostGrant 组主体匹配——保留不动）
            issueDeviceSession → 审计(login/success) → 签发 token（:1742-1766）
POST /v1/auth/refresh（:1769）——不触碰 LDAP（无密码可绑，作废方案 git 历史 170f4e28f84 §4.2 已核实）
web-handoff 兑换（:1827-1875）——consumeWebHandoff 消费已存在用户，不认证 LDAP
```

| 现状件                                         | 位置                                                            | 与本设计的关系                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LdapAdapter` / `LdapResult.reason`            | ldap.ts:9-15                                                    | reason 联合**加性**扩展 `'not_admitted'`（§3.2）；`authenticate` 签名零改动                                                   |
| `LdapProfile.groups: string[]`                 | ldap.ts:1-7                                                     | 语义钉死=**memberOf 归一 CN 数组**（§3.5）；平台闸门与组并集合并的输入                                                        |
| `MockLdapAdapter`（Map 账户表）                | ldap.ts:21-35                                                   | 需真实适配：可选 `requiredGroup`，不在组返回 `not_admitted`（§5.1，镜像生产 adapter 路径保 e2e 保真）                         |
| `ApiConfig.ldap?: LdapAdapter` 注入点          | server.ts:93 / :1118                                            | 测试注入自定义 adapter 走这里；默认 Mock 装配改为透传 requiredGroup（§3.4）                                                   |
| 内联组→角色种子规则                            | server.ts:1731-1733                                             | 组→角色残留，裁定建议废除（§4.2）；默认 mock 下对 zhangsan/lisi 派生 developer 不变，对 admin 不生效（admin 启动已种子 :1121-1129） |
| `rolesFromGroups` + 测试                       | ldap-role-groups.ts / test/ldap-role-groups.test.ts             | 死代码（grep 全仓：仅自身测试引用）→ 删除（§4.1）                                                                             |
| env 双读先例                                   | server.ts:736（`loginLockoutUrl`）+ :4270-4272（入口条件装配）   | 新 env 沿用同款形态（§3.4）                                                                                                   |
| 登录错误透传                                   | app.js:2383-2388（`body.error.message`/`code` → `#loginError`）  | 服务端新错误码+文案原样到达登录表单，**web 零改动**                                                                           |
| 启动种子 admin                                 | server.ts:1121-1129                                             | 生产管理员引导故事=启动种子 admin（platform:admin）+ admin 加入准入组（§4.2）                                                 |

---

## 2. 业界对齐（吸收 ldap-open-source-survey.md）

| survey 结论                                                                                                                                     | 本设计采纳                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| §2 形态 A「准入过滤」=把组条件并入用户查找 filter（memberOf 最常见），filter 未命中=无此用户=认证失败——唯一原生拒绝登录的形态（Gitea/GitLab/FAB） | **用户钦定此形态**：查询侧 memberOf filter（§3.3）；配置收窄为单组名单值（不做自由 filter，易误配）      |
| 形态 A/B 普遍并存且正交；形态 B（组→角色）从不拒登录                                                                                             | 形态 B 已被 U69a 作废（LGA-1 删除 §4.1）；准入（本设计）与角色（U67 用户管理页）分层正交                 |
| Grafana `skip_org_role_sync=true` =「映射关闭、角色平台内管」先例                                                                                 | 「角色与组无关」语义的业界锚点                                                                          |
| §2-① 组名匹配两派：CN（Gitea 组过滤/GitLab admin_group/Jenkins）与完整 DN（Grafana/FAB）                                                         | env 收 **CN** 名单值；DN 展开归生产 adapter 配置（组搜索基+CN 合成，§5.2）；闸门匹配归一后的 CN          |
| §3-2 匹配语义优先 memberOf、posixGroup 反查不做双栈                                                                                              | **用户已确认 memberOf**（两次指令）；posixGroup 登记 §8-Q2 不设计                                       |
| §3-3 开关语义：未设置=全放行，设置后 fail-closed                                                                                                  | 与 R2 缺省兼容一致                                                                                      |
| §3-4 拒绝行为：拒绝+可诊断审计+登录页明示原因                                                                                                     | `401 LDAP_GROUP_NOT_ADMITTED`+提示文案+`login`/failure reason=`ldap_group_denied`（不新增事件类型）     |
| §3-5 移出组善后：下次登录即拒（各家一致）；GitLab `ldap_blocked` 更严                                                                              | §3.7 一期登录时判定；`ldap_blocked` 式登记二期挂账并写明差异                                            |
| §3-6 `server.ts:1731` 内联规则与新语义冲突须裁定                                                                                                  | §4.2 建议废除（终审项 T2），admin 引导改走启动种子+用户管理页                                           |
| §3-7 不引定时全量同步                                                                                                                              | 准入判定点=登录（唯一知情点），与 U67 非目标一致                                                        |

---

## 3. 准入过滤设计（memberOf group filter 方案）

### 3.1 双层执行点（同一 env、同一判据、如实分工）

| 层                  | 执行点                                   | 形态                                                                     | 角色                                                                                             |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **查询侧（主）**    | 生产 LDAPS adapter 的用户查找 filter      | `(&(uid=<u>)(memberOf=CN=<准入组>,<组搜索基>))`——形态 A 正宗，用户钦定   | filter 未命中=目录无此准入用户，bind 不发生；非组成员的密码**不经验证**                          |
| **平台侧（统一语义点）** | 登录链 `clearLoginFailures` 之后、`seedUser` 之前 | `result.profile.groups.includes(requiredGroup)`              | ①Mock/dev 的唯一执行点（Mock 无查询层）；②生产防御第二道（兜 adapter 漂移/回填缺陷）；③钦定 401/审计语义的统一映射点 |

两层由同一 `ORCA_CLOUD_LDAP_REQUIRED_GROUP` 驱动、判据同源（memberOf 含准入组 CN）——不存在「filter 说有、闸门说无」的分歧；闸门对已通过 filter 的用户是重言式复核（防御性），对注入 adapter（测试）是独立执行点。大小写偏差为钦定的 fail-closed 边界（§3.5/A7），非分歧面。

**登录链变更**（:1702 起）：

```
result = ldap.authenticate(username, password)
if (!result.ok) {
  if (result.reason === 'not_admitted')          ← 新增分支（查询侧 filter miss 映射）
    → 审计 login/failure { reason:'ldap_group_denied' }
    → 401 LDAP_GROUP_NOT_ADMITTED + 明确提示（§3.2）
    → 不 recordLoginFailure、不清锁定（密码未经 bind 验证——§3.2 锁定语义）
  ...既有 invalid_credentials / unavailable 分支不动（:1703-1720；A11 如实记录现状疣）
}
ok → clearLoginFailures（:1722 原位——密码已证即清计数）
   → 【平台统一闸门】requiredGroup 存在 且 profile.groups 不含准入组
       → 同款审计 + 401 + 文案（此处密码已验：清零已发生、仍不增量）
   → usersByName / seedUser（:1731-1733 内联规则删除 → 一律 roles:['developer']）
   → groups 并集合并（:1737 原样——准入组 CN 进入 user.groups，
       Grant 以该组为主体即可一次授权全部准入用户，语义自洽）
   → roleOverride 优先（:1739-1741 原样）→ issueDeviceSession → 签发
```

关键取舍（三条）：

1. **闸门在 `clearLoginFailures` 之后、`seedUser` 之前**：准入拒绝不是凭据失败——不调 `recordLoginFailure`（否则不在组用户攒 5 次「正确密码」会把自己锁进 FR-1.4 计数器，入组后反被锁）；也不得先 seed 再拒（不在组用户不得在 store 物化 User 行）。
2. **两条拒绝路径、同一 UX**：查询侧 miss（生产主路径）与闸门 miss（Mock/注入形态）映射同一错误码、同一文案、同一审计 reason——用户与前端无感知差异。
3. **平台不构造任何 LDAP 查询**：组成员事实源=adapter（生产=memberOf filter+回填，§3.3/§5.2）；目录形态变化只改 adapter，闸门代码不动。

### 3.2 拒绝响应、审计与锁定语义

| 面                    | 取值                                                                                                                  | 依据                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 状态             | `401`                                                                                                                  | R3（语义=「身份已知但未获本系统准入」；不冒用 403——本平台 403=已登录后的权限拒绝）                                                                          |
| 错误码                | `LDAP_GROUP_NOT_ADMITTED`                                                                                              | SCREAMING_SNAKE 惯例（INVALID_CREDENTIALS/ACCOUNT_LOCKED）；技术码可 grep、可对审计；两条拒绝路径统一                                                       |
| 文案（终审项 T1）     | 定稿 `账号未加入平台准入组。`（§9-1 裁定，survey §3-4/调度建议，更明示原因）；备选 `该账号未授权访问本系统。`（原默认，单常量可切回）          | 单常量可一键切换；内网管理台场景两者枚举风险均可接受（survey §3-4），主会话已终审（§9-1）                                                                        |
| 前端                  | 零改动                                                                                                                  | app.js:2385 直接展示 `error.message`，新码新文案原样进 `#loginError`                                                                                        |
| 审计                  | `eventType:'login'`、`result:'failure'`、`actor:username`、`targetId:null`、`metadata:{ reason:'ldap_group_denied' }`   | 沿既有 login/failure+reason 模式（:1691-1699，'locked' 同款）；不新增事件类型（审计页下拉不动）；best-effort 同款（审计盘满不阻断拒绝响应）；落链断言见 A12 |
| 锁定（filter miss）   | **既不增量也不清零**                                                                                                    | 密码未经 bind 验证：按 FR-1.4「密码错误计数」语义不可计；与 Gitea/GitLab「通算登录失败」的如实差异——通算会让不在组用户以正确密码自攒锁定、入组后反被 423 挡；可诊断性由独立审计 reason 承担（survey §3-4） |
| 锁定（闸门 miss）     | 清零已发生（:1722 前置）、不增量                                                                                        | 密码已验（Mock/注入 adapter 已核对），沿「密码正确即清计数」既有语义                                                                                         |
| `LdapResult` 扩展     | reason 联合加 `'not_admitted'`（ldap.ts:11）                                                                            | 同 union 加性：进程内类型，无 wire 涉；分支 exhaustive 防漏                                                                                                 |

### 3.3 生产 adapter 的 filter 流程与二分 miss 诊断（形态 A 正宗 + 保住明确提示）

Gitea/GitLab 的 filter miss 一律通算「登录失败」、文案含混（GitLab 甚至置 `ldap_blocked`）；本平台明确提示要求**区分**「用户不存在」与「在目录但未入组」。生产 adapter（`createLdapsAdapter`，独立工单实现）流程：

> **filter/DN 转义契约（P1-6）**：用户名按 RFC 4515 转义、准入组 CN 单值校验（拒绝 `,` `=` `\` 等 DN 特殊字符）、禁止自由 filter——以 **G04 §4-3** 为准；平台不构造 filter，转义责任在 adapter。**G04-1（依赖评审）是生产 adapter 的开工门**（§5.2）。

```
准入开启（requiredGroup 存在）：
1. 服务账号 bind（或匿名 search 目录）——search 权限前置（§5.3）
2. 准入查找：(&(uid=<u>)(memberOf=CN=<准入组>,<组搜索基>)) → 命中 DN
3. 未命中 → uid 复查 (&(uid=<u>)) 二分：
     命中 → { ok:false, reason:'not_admitted' }（在目录、未入组；密码不验）
     未命中 → { ok:false, reason:'invalid_credentials' }（既有语义）
4. 命中 → 用【用户密码】simple bind 该 DN（认证本体，平台不存密码——ldap.ts:18 契约）
        → 绑定自读 memberOf → DN→CN 归一 → 回填 profile.groups
        （filter 已保证含准入组；回填仍全量读——Grant 组主体与平台闸门需要）
准入关闭：filter 不内嵌，即作废方案 git 历史 170f4e28f84 §6 原流程（uid 搜索→bind→读组）
```

- 二分复查**只发生在拒绝路径**；正常登录=1 search + bind + 1 读，零额外开销。
- 若运维接受含混文案可裁掉步骤 3（实现令可选项，§8-Q7）；本设计按明确提示要求为准。

### 3.4 配置装配与路径覆盖

```
ORCA_CLOUD_LDAP_REQUIRED_GROUP    # 准入组 CN 名单值；未设置/空白=准入关闭（fail-open-on-unset）
```

- `ApiConfig` 加性字段 `ldapRequiredGroup?: string`（同 `loginLockoutUrl` 形态）；createApp 读点：`(config.ldapRequiredGroup ?? process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP ?? '').trim()` 归一为空则 null——trim 防「空白 env 意外开启」；进程内测试传 config 不碰 env。
- 入口装配（:4270 条件 spread 同款）：`...(process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP ? { ldapRequiredGroup: process.env.ORCA_CLOUD_LDAP_REQUIRED_GROUP } : {})`。
- 默认 Mock 装配（:1118）改为 `config.ldap ?? new MockLdapAdapter(accounts, requiredGroup ? { requiredGroup } : undefined)`——env 一到，Mock 即镜像生产 adapter 的 filter 行为（§5.1），e2e 走对外行为同形的路径（判定顺序不同，见 §5.1 末）。
- 组 DN 展开（生产）：CN 名单值 + 组搜索基（生产 adapter 配置键，§5.2）合成 memberOf 值；最终键名归生产工单钉（§8-Q5）。

**路径覆盖（R4：种子/会话/既有登录路径全走过滤）**：

| 登录/会话路径                                                                          | 是否过准入         | 说明                                                                  |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `POST /v1/auth/login`（新用户，触发 seedUser）                                          | **过**（双层）     | 查询侧 filter 先挡；Mock/注入形态走闸门；不在组永不建户               |
| `POST /v1/auth/login`（store 既有用户，含启动种子 admin/zhangsan、roleOverride 用户）  | **过**（双层）     | 种子用户被移出组后同样下次登录即拒                                    |
| web-handoff 兑换（:1864 issueDeviceSession）                                            | **传递覆盖**       | 只消费既有用户（:1839），无独立 LDAP 路径；存量用户过闸口径按 §3.7 登录时判定边界（env 开启前已 seed 的用户经 handoff 兑换不触发登录闸）         |
| refresh / me / install 脚本 token                                                       | 不过（一期边界）   | §3.7：无密码不可重验，存量会话不追溯                                  |
| 宿主/中继/内部 token 链                                                                 | 不涉及             | 非 LDAP 身份（mTLS/internal token），准入语义只管「人」               |

### 3.5 匹配语义（memberOf 形态，定死无双栈）

- 事实源链：目录用户条目 **memberOf** 属性（查询侧 filter 条件与回填属性同源）→ adapter DN→CN 归一 → `profile.groups` → 闸门 `includes` 判断。
- 形态**定死 memberOf，不做双栈**（survey §3-2；用户两次指令确认）：posixGroup（无 memberOf 属性的目录）不在本设计范围——该形态下 memberOf filter/回填皆空 → 准入开启时 fail-closed 拒绝（方向安全）；登记 §8-Q2，需求出现再设计。
- env/闸门匹配：**精确、大小写敏感**的 CN 相等（`Array.prototype.includes`）。CN 派先例（GitLab admin_group/Gitea 组过滤/Jenkins，survey §2-①）；Grafana `org_role` 大小写敏感同类。大小写偏差=fail-closed 拒绝（放行方向=提权风险面，不做折叠）；运维修正组名即可，边界进 §6 用例。
- **运维规则（P2-5，fail-closed）**：准入组名与目录组 CN 必须逐字符精确、大小写一致；任何偏差一律 fail-closed 拒绝，平台不做大小写折叠（半套折叠会让准入与授权出现两套匹配规则）。组改名（含仅大小写变化）后须同步 env 与组授权主体并重启；旧 `user.groups` 并集不会自动迁移（撤销边界待 D15-1）。

### 3.6 兼容性声明（调度裁定项 7）

- **缺省行为与现网完全一致**：env 未设置时准入链路零生效（闸门条件短路、Mock 不带 requiredGroup、:1731 废除对默认 mock 三账户行为无变化——zhangsan/lisi 仍 developer、admin 仍启动种子 admin）；既有测试全量绿（E3）。
- **wire 零变更**：新增仅服务端行为+`LdapResult.reason` 进程内加性枚举；登录/refresh/审计协议形状不变，错误响应走既有 `error()` 形状，仅新增一种 401 错误码。
- **env 变更不要求旧客户端/宿主升级**：web（app.js:2385 直接展示 message）/宿主/中继/relay 无感知，mobile 按既有错误处理形态预期无感知（裸断言无证据指针，实现验收补验）——登录 200 响应结构不变、新 401 码走既有错误处理形态；准入开关纯属平台侧运维配置，随时可设可撤。

### 3.7 会话与移出组善后（一期边界，如实声明）

- 判定点=**登录时**。移出组后：下次登录即拒（查询侧 filter 即刻不命中）；存量会话/refresh 链一期**不追溯撤销**（survey §3-5 各家主流形态）。
- **二期挂账（写明差异）**：GitLab `ldap_blocked` 形态=移出组即全端点禁登+存量会话处置，配合 FR-1.7 的 ≤60s 撤销语义——登记 §8-Q3，本设计不做；一期应急收敛依赖 FR-1.6 管理员强制下线——**已实现 API**（U244 `d0b4f064797`/最终 `a62d3944156`，`POST /v1/users/{id}/sessions/revoke`），Web 按钮待 D15 批次；`revokeUserCredentials` 仍只撤宿主票据，设备吊销仅本人可用。
- 刷新链滚动续期意味着「移出组」的实际生效上界=该用户下次主动登录（作废方案 git 历史 170f4e28f84 §4.2 已核实 refresh 无密码不可重绑）。
- 「准入开启→关闭 env」的已拒用户：无 User 行、无会话，无善后；已在组用户不受影响。

---

## 4. LGA-1 去留裁定（调度裁定项 5）

### 4.1 裁定：删除（如实的判定依据 + 处置步骤）

| 判据     | 事实                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语义     | `ldap-role-groups.ts` 实现的正是被 U69a 用户裁定作废的「形态 B 组→角色映射」（survey §2 形态 B「从不拒登录」，与本需求方向相反）                                        |
| 代码现状 | **死代码**：`rolesFromGroups` 全仓 grep 仅 `ldap-role-groups.ts` 自身与 `test/ldap-role-groups.test.ts` 引用；server.ts 从未 import（登录链里 :1731 是另一份内联规则）  |
| 保留成本 | 文件头注释、`PlatformRole` 类型、14 用例 139 行映射白名单测试会持续误导后来者以为映射方向待启用；两套「组→角色」实现（文件版+内联版）并存本身就是混乱源                 |
| 删除成本 | 零运行时影响（无引用）；提交 `c45aba6f23` 保留在 git 历史，方向可考古                                                                                                   |
| 恢复路径 | 若未来需要组分层权限（如准入升级为多组分层），届时按 U69a 语义重新评审设计，**不得复活本提交代码**——其 fail-safe 表设计虽精良，服务的已是另一个需求                    |

**处置步骤**（实现令 LGAA-4）：①`git rm cloud-platform/apps/api/src/ldap-role-groups.ts cloud-platform/test/ldap-role-groups.test.ts`（14 用例随模块同删，方向作废不保留断言）；②全量 `node --test` 回归 + grep 全仓 `rolesFromGroups|LDAP_ROLE_GROUP_MAP` 零命中（§6.3）；③台账 U69a 备注列登记裁定（LGAA-5）。不 revert 提交本身、不抹历史，前向删除。

### 4.2 连带裁定（已终审 §9-2：废除） server.ts:1731-1733 内联组→角色种子规则

survey §3-6 点名的冲突点（「platform-admins 组首登 seed 平台管理员」vs「LDAP 不供角色」）。**建议裁定：废除**——新用户种子一律 `roles:['developer']`，「分组=准入、角色=平台内」语义不留例外口子（为什么 `platform-admins` 特殊？没有理由——这正是作废方向的残余）。**保留选项如实给出**：保留为首登引导亦可行（U67 `roleOverride` 已保证覆盖优先、重登不回灌，:1739-1741），代价是语义残留一个「组→角色」特例。主会话终审二选一；以下影响面按「废除」核实：

- 默认 mock 下该规则对 zhangsan/lisi 派生 `['developer']`（废除后不变）；对 admin **不生效**（admin 启动已种子 :1121-1129，usersByName 命中走不到 seed）；全测试目录 grep `platform-admins` 断言仅存在于待删除的 ldap-role-groups.test.ts → **废除零测试破坏**。
- 生产管理员引导故事（废除后的引导路径）：启动种子 admin（platform:admin，既有）保持登录即管理员——运维把 admin 账号加入准入组即可（filter/闸门只看准入组，不看平台角色组）；其余新用户一律 developer，升权走 U67-3 用户管理页 roleOverride（覆盖优先 :1739-1741 不动，一经设置永不被种子回灌）。
- **文档级连带（评审 M3 登记）**：U67 设计 §7.1 页脚「LDAP platform-admins 组成员首次登录映射为管理员」与 §7.2 admin 行「组首登映射（既有，保留）」须随本裁定（废除）同步修订——归属 U67 修订令（本轮已下达），避免 U67 落地把已废除语义写进 UI。

---

## 5. Mock / 生产适配

### 5.1 Mock：真实适配（对外行为同形、判定顺序不同，保 e2e 保真）

用户钦定查询侧 filter 后，Mock 若只靠平台闸门，e2e 验到的就不是对外行为同形的路径。适配（最小改动）：

```
// ldap.ts：构造参数加可选配置
new MockLdapAdapter(accounts, { requiredGroup?: string })
// authenticate 行为：凭据命中且 requiredGroup 存在且 profile.groups 不含准入组
//   → { ok:false, reason:'not_admitted' }
//（先核密码、再判组——顺序与生产二分诊断相反，但对外结果一致：不在组一律 not_admitted）
```

- 装配：:1118 处 requiredGroup 存在即透传给 Mock（§3.4）——**e2e 经 env 驱动即走 adapter 侧 not_admitted 路径**（对外行为同形、判定顺序不同）。
- `ldapProfile({ groups })` 按账户可配（ldap.ts:37-50）不变；默认三账户 profile 恰好构成双向门矩阵：

| mock 账户  | profile.groups                   | env=`platform-admins` 时 | env=`developers` 时 |
| ---------- | -------------------------------- | ------------------------ | -------------------- |
| admin      | `['platform-admins']`（:1106）   | 200                      | 401                  |
| zhangsan   | `['developers']`（缺省 :48）     | 401                      | 200                  |
| lisi       | `['developers']`（缺省 :48）     | 401                      | 200                  |

- 自定义组名（orca-cloud）、多组 profile 的用例走**进程内注入**：`createApp({ ldap: stubAdapter, ldapRequiredGroup })`（ApiConfig.ldap :93 + 新 config 字段）。
- 如实说明差异（**对外行为同形、判定顺序不同**）：Mock 先验密码后判组、生产先 filter 后验密码——「错误密码+不在组」在 Mock 得 `invalid_credentials`（+计数）、生产得 `not_admitted`（不计数，密码不泄漏目录外信息恰是生产语义的优点）；在组/不在组主路径两形态行为完全一致。

### 5.2 生产 LDAPS：同接口、filter 内嵌、引用可复用部分

- **接口零改动**（reason 加性除外，§3.2）：`createLdapsAdapter(config)` 承接作废方案 git 历史 `170f4e28f84` §6 的已核实骨架——TLS 连接、用户 DN 搜索、用户密码 simple bind（认证本体）、自读组属性、DN→CN 归一、`ORCA_CLOUD_LDAP_URL` 存在即选生产 adapter 的入口装配、`ApiConfig.ldap` 注入点不动。**两处语义修正**：①用户查找 filter 内嵌 memberOf 准入条件（§3.3，本设计核心增量）；②组的用途从「角色重算」改为「准入+组并集合并（Grant 组主体）」。
- **配置键**（生产工单钉最终名，§8-Q5）：`ORCA_CLOUD_LDAP_URL` / `ORCA_CLOUD_LDAP_GROUP_ATTR`（缺省 memberOf）/ 组搜索基（合成 `CN=<准入组>,<基>`）/ 服务账号 bindDN+bindPassword（search 权限，§5.3）。
- **过滤位置声明（如实）**：主执行在 LDAP 查询侧（用户钦定形态 A）；平台闸门保留为统一语义点+防御第二道（§3.1）。与 Gitea/GitLab 的差别在二分 miss 诊断与独立审计（§3.3）——形态一致、诊断更强。
- **filter/DN 转义契约（引用 G04 §4-3）**：用户名 RFC 4515 转义、准入组 CN 单值校验（拒绝 DN 特殊字符）、禁止自由 filter 由生产 adapter 承接，本设计平台侧不重复实现。**G04-1 依赖评审是生产 adapter 的开工门**——未通过前不开工 adapter（G04 仍为草案），也不得宣称生产 adapter 可用。
- **依赖前置**：Node 内置无 LDAP 客户端，候选 `ldapts`（作废方案 git 历史 170f4e28f84 §6 评审结论照抄）；本仓库零运行时依赖纪律（cloud-platform/PLAN.md §0）→ 引依赖须独立评审，生产 adapter 连同评审走独立工单；本设计的准入链（Mock/注入）零新依赖即可全量验证。

### 5.3 simple-bind 能力边界（如实声明）

simple bind 只回答「凭据对不对」，**不具备任何查询能力**——memberOf filter 是 search 语义，必须先有可执行 search 的绑定：

1. 目录允许匿名 search，或配置服务账号 bindDN（作废方案 git 历史 170f4e28f84 §6 已有该设计，照抄）；
2. 目录在用户条目上维护 memberOf（AD 原生；OpenLDAP 需 memberof overlay）；
3. 服务账号可读用户条目 memberOf（受限 schema 除外）；
4. 登录名属性映射：filter 模板钉死 `uid`——AD 登录名常为 sAMAccountName、`uid` 可能缺省，部署前核实用户条目含 `uid`（属性可配归生产 adapter 工单键，并入 §8-Q5）。

前提不满足时：准入开启 → 所有登录在 filter 阶段失败（uid 复查命中则 `not_admitted`）——**全员 fail-closed，无提权风险，方向安全**；准入关闭 → 回到现状登录（组回填空仅影响组并集展示）。四条是**部署前置条件**，进运维 checklist；真实目录核实挂 `ORCA_REAL_LDAP_TEST=1` 门（作废方案 git 历史 170f4e28f84 §6 先例），归生产 adapter 工单。

### 5.4 生产启用/回滚运维 runbook（P2-3、P2-5，零语义）

> 本 runbook 只固定操作顺序与 fail-closed 规则，不裁定 D15-1..8 的任何语义项（撤销边界、绝对寿命、503、嵌套组、未认证枚举等仍在 D 表待裁定）。生产 adapter 本体仍归 G04（G04-1 为开工门）；在 adapter 落地前，本 runbook 只适用于 Mock/注入形态的准入链，不得据此宣称生产 adapter 已实现。

**启用顺序（必须按序）**：

1. **入组**：把启动种子 admin 及全部应准入用户加入目录准入组 CN；核实 §5.3 四条目录前置（可 search、条目含 memberOf、服务账号权限、登录属性）。
2. **先授权（如用组主体）**：若主机/项目授权以准入组为主体，先完成 `HostGrant`/`Grant` 写入（主体名=组 CN），再进入下一步；冷启动先授权后设 env，避免「用户已能登录但组授权尚未建立」的空窗。
3. **升级全副本**：所有 API 副本升级到含准入链的版本并重启；**旧副本未升级前不得设 env**（混合版本旧副本 fail-open；是否要求共享配置见 D15-8）。
4. **设 env**：所有副本设置 `ORCA_CLOUD_LDAP_REQUIRED_GROUP=<CN>`；组名与目录 CN 必须精确、大小写一致（P2-5）。
5. **重启**：逐副本重启使 env 生效（env 只在启动读点生效，无热加载）。
6. **验证**：管理员登录 200；非准入组账号 401 `LDAP_GROUP_NOT_ADMITTED` +「账号未加入平台准入组。」；审计可见 `login/failure reason=ldap_group_denied`；拒绝不增加锁定计数；启动日志打印准入组名（不含凭据）。

**回滚（撤 env 重启）**：移除（或清空）全部副本的 `ORCA_CLOUD_LDAP_REQUIRED_GROUP` 并重启 → 回到现状全放行；已拒用户无 User 行、无会话，无需善后；已在组用户不受影响。

**运维规则（P2-5，fail-closed）**：

- 准入组名与目录组 CN 必须逐字符精确、大小写一致；任何偏差=fail-closed 拒绝，平台不折叠大小写、不做前缀/同名模糊匹配（与 §3.5 一致）。
- 组改名（即使仅大小写变化）后必须同步 env、组授权主体并重启；旧 `user.groups` 并集不会自动迁移（撤销边界待 D15-1）。
- 目录不可达/搜索失败且准入开启时全员 fail-closed 拒绝（方向安全）；不得以降级 Mock 或跳过准入作应急，故障期按上述回滚步骤撤 env。

---

## 6. 测试计划

### 6.1 进程内单测（`test/ldap-admission.test.ts`；adapter 侧路径用默认 Mock+config、闸门路径用注入 adapter）

| #   | 用例                                       | 断言                                                                                                                                                                                                        |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 在组登录成功（两层各验）                   | 200；roles 按种子/override 规则（与组无关）；`user.groups` 含准入组                                                                                                                                          |
| A2  | 不在组拒绝（adapter 侧，对外行为同形）     | 401 + `LDAP_GROUP_NOT_ADMITTED` + 明确提示文案；store 无该用户行（未 seed）；锁定计数**不增不清**（`recordLoginFailure`/`clearLoginFailures` 均未触）                                                        |
| A3  | 不在组拒绝（闸门侧：注入无 requiredGroup 概念的 adapter） | 同码同文案同审计；清零已发生、不增量                                                                                                                                                            |
| A4  | 拒绝后再入组                               | A2 后 adapter 改判在组 → 同账密立即 200（无锁定残留）                                                                                                                                                         |
| A5  | 未配置 env 零回归                          | `ldapRequiredGroup` 缺省 → 三 mock 账户全 200；无 `not_admitted`、无 `ldap_group_denied` 审计；:1731 废除后 lisi 首登 roles=`['developer']` 不变                                                              |
| A6  | 种子用户兼容                               | 启动种子 admin：env 开启+在组 → 200 且 roles=`['platform:admin','developer']`（不因种子规则废除而丢）；roleOverride 用户在组通过 → roles 按 override（准入与角色正交实证）；种子用户移出组 → 下次登录 401     |
| A7  | 匹配边界（闸门+Mock 双验）                 | `['team-x','orca-cloud']` → 200；`['orca-cloud-2']`（前缀相似）→ 401 精确匹配不误命中；`['Orca-Cloud']`（大小写偏差）→ 401 fail-closed                                                                        |
| A8  | 凭据失败优先级                             | 错误密码+在组 → 既有 401 INVALID_CREDENTIALS + 计数；错误密码+不在组（Mock 形态）→ 同左（Mock 先验密码如实差异，§5.1）——filter/闸门不掩盖凭据路径                                                             |
| A9  | 移出组不追溯（一期边界钉死）               | 登录成功后摘组 → refresh/me 仍 200；再登录 401                                                                                                                                                                |
| A10 | 空白 env 值                                | `ldapRequiredGroup` 传空白 → 归一 null → 等价 A5 全放行                                                                                                                                                       |
| A11 | env 设置 + LDAP 不可达（fail-closed 边界） | 注入恒 unavailable adapter + env 开启 → `!ok` 路径无会话、无 seed、无准入绕过；**现状如实记录**：:1703-1720 不分 reason，unavailable 得 401+计数（既有疣）——`not_admitted` 分支不改变该现状，503 不计数改进沿作废方案 LG-8 挂生产工单 |
| A12 | 审计事件落链                               | A2/A3 拒绝事件经 `/v1/audit/verify` 验链通过；事件可经审计查询按 `reason=ldap_group_denied` 检索；metadata 参与哈希（改写即断链，沿 U66 语义）                                                                |

### 6.2 e2e（`test/e2e/ldap-admission.e2e.test.ts`；spawnService + env，真实 HTTP，走对外行为同形的 adapter 路径；判定顺序不同）

| #   | 用例                                             | 断言                                                                                 |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| E1  | `ORCA_CLOUD_LDAP_REQUIRED_GROUP=platform-admins` | admin/Adm1n! 200；zhangsan/lisi 401 + 文案（web 透传形态同 app.js:2385）             |
| E2  | `ORCA_CLOUD_LDAP_REQUIRED_GROUP=developers`      | zhangsan/lisi 200；admin 401（门不偏袒管理员）                                       |
| E3  | 不设 env（现网兼容）                             | 三账户全 200；与既有 login-lockout e2e（login-lockout-shared.e2e.test.ts）并跑不回归 |
| E4  | 拒绝不污染锁定                                   | E1 下 zhangsan 正确密码连击 5 次 → 全 401 无 423；env 撤后同账密立即 200（env 在 createApp 启动读点生效：撤 env=重启 spawnService）             |
| E5  | handoff 传递覆盖                                 | env 开启下先登录取 handoff 码 → 兑换 200（闸门单点性验证）                           |
| E6  | 审计可诊断                                       | E1 的拒绝事件在审计查询可见（reason=`ldap_group_denied`），与密码错误事件可区分      |

### 6.3 删除回归

LGAA-4 删除 LGA-1 两文件后：全量 `node --test` 绿；grep 全仓 `rolesFromGroups|LDAP_ROLE_GROUP_MAP` 零命中。

---

## 7. 实现切分（≤20 分钟令）

### 7.0 AC → 用例映射（调度裁定项 6；每条裁定项有直接断言）

| 裁定项 / AC                  | 用例（本文 §6.x）   | 断言要点                                                                                                                                     |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 未设置 env 全放行（现网兼容） | §6.1-A5 + §6.2-E3   | 缺省三账户全 200；无拒绝审计；既有 lockout e2e 并跑不回归；:1731 废除后首登角色不变                                                            |
| 设置后命中（在组）            | §6.1-A1 + §6.2-E1/E2 | 200 + 会话签发 + user.groups 含准入组 + 角色与组无关（A6 正交实证）                                                                            |
| 设置后未命中（不在组）        | §6.1-A2/A3 + §6.2-E1/E4 | 401 + `LDAP_GROUP_NOT_ADMITTED` + 提示文案；不 seed；锁定不增量不误锁；两条路径（adapter/闸门）同 UX                                       |
| posixGroup 形态（定死 memberOf，无双栈） | 声明性覆盖 §3.5/§8-Q2 | 不写 mock 自动化用例（mock 无法模拟目录 schema）：memberOf 缺失目录 → filter miss → fail-closed 拒绝（方向安全）；真实目录验证挂 `ORCA_REAL_LDAP_TEST=1` 门 + 部署 checklist（§5.3） |
| env 设置但 LDAP 不可达（fail-closed 边界） | §6.1-A11 | 恒 unavailable adapter + env 开启 → 无会话无 seed 无准入绕过；现状 401+计数如实记录，503 改进挂生产工单（LG-8 先例）                            |
| 审计事件落链                  | §6.1-A12 + §6.2-E6   | 拒绝事件入哈希链、verify 通过、可按 reason 检索、与密码错误可区分；best-effort 边界沿既有                                                      |
| 种子/会话/既有路径全覆盖      | §6.1-A6/A9 + §6.2-E5 | 种子 admin/roleOverride 用户过闸且角色不受影响；移出组下次登录即拒、存量会话一期不动；handoff 传递覆盖                                          |
| 匹配语义（精确 CN）           | §6.1-A7              | 多组含目标组命中；前缀相似/大小写偏差 fail-closed                                                                                              |
| 兼容性（wire/env）            | §3.6 声明 + E3       | wire 零变更、错误走既有形状；env 可设可撤，无客户端/宿主升级要求                                                                               |
| LGA-1 删除回归 | §6.3 | 全量 node --test 绿 + grep `rolesFromGroups|LDAP_ROLE_GROUP_MAP` 零命中 |
| env 中途切换 | §3.7（声明性覆盖） | 撤 env=重启生效；已拒用户无善后；已在组用户不受影响 |
| 并发登录 | 豁免声明 | 登录链无共享可变状态（判定为请求内逻辑+store 既有原子操作），不设并发用例 |

### 7.1 令切分

| 令      | 层                                      | 内容                                                                                                                                              | 预估 |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| LGAA-1a | ① `ldap.ts`                             | reason 加 `'not_admitted'` + `MockLdapAdapter` 可选 `requiredGroup`（§5.1）+ Mock 行为单测                                                          | 20   |
| LGAA-1b | ① `server.ts`                           | 登录链 `not_admitted` 分支（401/审计/不计数）+ 平台统一闸门 + 删除 :1731-1733 内联规则（种子一律 developer；按 §9-2 终审执行）+ `ApiConfig`/createApp env 读点 + Mock 装配透传 + 入口 env 装配 | 20   |
| LGAA-2  | ③ `test/ldap-admission.test.ts`         | §6.1 A1-A12                                                                                                                                         | 20   |
| LGAA-3  | ③ `test/e2e/ldap-admission.e2e.test.ts` | §6.2 E1-E6（spawnService env 门）                                                                                                                   | 20   |
| LGAA-4  | ② 删除                                  | `ldap-role-groups.ts` + `test/ldap-role-groups.test.ts`（§4.1 处置步骤）+ §6.3 回归                                                                 | 10   |
| LGAA-5  | ④ 文档                                  | defect-ledger U69a 备注列登记裁定（LGA-1 删除 + :1731 终审结果 + filter 形态落地）；**按 §9-3 执行** requirements.md FR-1.5 措辞修订（保留「组信息同步」「管理员可覆盖」子句）+ 登记 U67 §7.1/§7.2 文案连带修订归属                        | 10   |

依赖：1a→1b→2→3 顺序；4、5 独立可并行。生产 LDAPS adapter（filter 内嵌+二分诊断+服务账号+ldapts 评审+ORCA_REAL_LDAP_TEST 验收）= **独立后续工单**。

---

## 8. 开放问题与终审项

| #   | 问题                                                                                  | 现处置                                                                                                   |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| T1  | 拒绝文案定稿：U69a 钦定「该账号未授权访问本系统。」vs survey/调度建议「账号未加入平台准入组。」 | 已终审（§9-1）：定稿 survey 文案，见 §3.2                                                   |
| T2  | :1731 内联组→角色种子规则：废除（建议）vs 保留为首登引导                                | 已终审（§9-2）：废除；影响面核实完毕见 §4.2                                                          |
| Q1  | 真实目录 memberOf 可用性（AD 原生 / OpenLDAP overlay）与 search 权限（匿名 or 服务账号） | 生产 adapter 工单前置核实 + 部署 checklist（§5.3）；准入开启前必须确认                                   |
| Q2  | posixGroup 目录（无 memberOf）反查形态（Gitea 双向 member 查找）                        | 本设计不做双栈（用户钦定 memberOf group filter）；adapter 层未来扩展登记，需求出现再设计                  |
| Q3  | 移出组存量会话处置（GitLab `ldap_blocked` 全端点禁登 + FR-1.7 ≤60s 撤销）——**二期挂账** | 一期不做（§3.7，差异已写明）；FR-1.6 强制下线兜底**已实现 API（U244 `d0b4f064797`/`a62d3944156`），Web 按钮待 D15 批次**；内网审计要求升级再开独立工单                          |
| Q4  | requirements.md FR-1.5/§50/§105「角色由安全组映射」措辞与 U69a 语义冲突                  | 本设计不改正文（非目标）；已终审（§9-3）：修订并入 LGAA-5 执行，见 §7.1                                        |
| Q5  | 生产配置键终名（组搜索基/组 DN 模板、服务账号键）与 `ldapts` 依赖评审                    | 归生产 adapter 工单；本设计只钉 `ORCA_CLOUD_LDAP_REQUIRED_GROUP` 与合成规则                              |
| Q6  | 审计拒绝事件是否独立 `eventType`（survey §3-4 提「ldap_denied 类事件」）                 | 采用既有 `login`/failure+reason 模式（§3.2，审计页下拉零改动）；审计运营要求独立类型属加性小改不阻塞     |
| Q7  | filter miss 二分诊断（§3.3 步骤 3）的取舍                                                | 按明确提示要求做二分；运维接受含混文案可在实现令裁掉（只省一次拒绝路径 search），不影响其他设计          |

---

## 9. 主会话审定（2026-11-16）

1. **T1 文案：定「账号未加入平台准入组。」**（采纳 survey/调度建议案）——「明确提示」的需求本体是让用户知道原因与去向（找管理员入组），诊断性文案严格更优；「该账号未授权访问本系统。」降为备选，单常量可一键切回（如运营偏好弱提示）。
2. **T2：废除 server.ts:1731-1733 内联组→角色种子规则**（采纳设计建议）——「分组=准入、角色=平台内」不留特例口子；影响面已核实零测试破坏；生产管理员引导=启动种子 admin（既有）+ admin 加入准入组 + 升权走 U67-3 用户管理页 roleOverride。
3. **Q4 归属裁定**：requirements.md FR-1.5「角色由安全组映射」措辞修订**并入 LGAA-5** 执行（语义已由 U69a 终局澄清，非重设计）——替换为「登录准入由 LDAP 分组门槛控制（ORCA_CLOUD_LDAP_REQUIRED_GROUP）；角色（普通/审计/管理员）由平台内用户管理页管理，与 LDAP 组无关」。
4. **切分照准**（§7.1 六令+依赖链）；执行窗口约束：LGAA-1b/2/3 涉 server.ts——U66 二期已落地（`f01bc88272e`）窗口已开，与 U62 修令（apps/api 域）串行；LGAA-1a/4/5 零碰撞，复评 APPROVED 即可行。Q1-Q3/Q5-Q7 处置照准。
5. **评审门**：独立 doc-review 通过后才派任何实现令；LGA-1 删除（LGAA-4）随实现批一并执行，不提前。
