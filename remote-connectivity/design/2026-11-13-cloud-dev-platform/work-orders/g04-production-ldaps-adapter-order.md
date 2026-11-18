# G04 工作令：生产 LDAPS 适配器（草案）

> 状态：**草案，待评审**（本文件只定范围/依赖/配置/安全/测试/切分，不含实现）
> 日期：2026-11-17
> 上游依据：`work-orders/ldap-group-admission-design.md`（准入链已交付，Mock/注入形态；§5.2「生产 LDAPS：同接口」、§5.3「simple-bind 边界」、§8-Q1/Q5 明确把生产 adapter 留给独立工单）
> 现状基线：`cloud-platform/apps/api/ldap.ts`（`LdapAdapter`/`LdapProfile`/`MockLdapAdapter`）；`server.ts:1344` 默认装配 Mock；入口 env 装配（`server.ts:4931` 附近）当前只传 `ldapRequiredGroup`，**没有** `ORCA_CLOUD_LDAP_URL` 读点；`createLdapsAdapter` 尚不存在
> 纪律约束：`cloud-platform/PLAN.md` §0「零运行时依赖，仅复用仓库已有的 `ws`」——引入任何 LDAP 客户端须独立评审（本令 G04-1）；`ORCA_REAL_LDAP_TEST=1` 是真实目录验收门（沿 `ORCA_REAL_CLAUDE_CLI_TEST` 先例）
> 非目标（硬边界）：**不改**登录准入判定、`not_admitted` 语义、平台闸门、角色派生/`roleOverride`、会话与 refresh 语义、审计事件类型、Web UI

---

## 1. 目标与范围

### 1.1 目标

用真实 LDAPS 目录实现 `LdapAdapter`，使 `ORCA_CLOUD_LDAP_URL` 存在时平台以生产 adapter 认证，行为与已交付的准入链完全同形：

1. **LDAPS 连接**：`ldaps://` + 系统/私有 CA 校验；连接、搜索、bind 均有超时。
2. **用户查找**：按可配置 filter 模板搜索用户 DN；准入开启时 filter **内嵌** `memberOf=CN=<准入组>,<组搜索基>`（设计 §3.3，形态 A 正宗）。
3. **认证 bind**：用**用户密码**对命中 DN 做 simple bind（平台不存密码）。
4. **组回填**：bind 后读用户条目组属性（或经服务账号读），DN→CN 归一，回填 `LdapProfile.groups`——供平台闸门与 Grant 组主体使用。
5. **拒绝诊断**：准入 filter 未命中时做一次 uid 复查，命中 → `not_admitted`；未命中 → `invalid_credentials`（保留现有明确提示能力，设计 §3.3 步骤 3）。
6. **fail-closed**：TLS/连接/搜索/超时错误 → `unavailable`；绝不降级到 Mock、绝不放行；准入开启且搜索不可执行 = 拒绝。
7. **装配**：`ORCA_CLOUD_LDAP_URL` 存在即选生产 adapter；配置缺失 fail-fast（拒绝启动），不静默回落 Mock。

### 1.2 范围边界

| 在范围                                             | 不在范围                                                       |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `cloud-platform/apps/api/src/ldaps-adapter.ts`（新） | `LdapAdapter` 类型/`LdapResult` 联合（已定稿，加性也已完成）   |
| `createLdapsAdapter(config): LdapAdapter`           | 登录链 `authenticate` 调用点、平台闸门、401/审计映射（已交付） |
| 入口 env 装配 + `ApiConfig` 加性字段                | 角色语义、`roleOverride`、种子用户规则                         |
| 生产 adapter 单测 + `ORCA_REAL_LDAP_TEST` 验收脚本  | posixGroup/多组/组→角色（设计 §8-Q2 明确不做双栈）             |
| 运维部署前置 checklist（真实目录核实）              | 定时全量同步、移出组存量会话撤销（设计 §3.7 二期）            |

### 1.3 接口契约（零改动）

复用 `ldap.ts` 现有类型；`LdapResult.reason` 三值已定，不新增。生产 adapter 只负责「目录事实 → `LdapProfile`」；准入判定与错误映射仍归登录链。

---

## 2. 依赖评审（G04-1：生产 adapter 开工门）

> **G04-1 是生产 adapter 的开工门**：评审结论未存档或未通过前，G04-2..G04-5 一律不开工，本令保持草案状态。

Node 内置无 LDAP 客户端。候选与风险对照：

| 维度        | A. `ldapts`                                                                        | B. 自实现最小客户端（`node:tls` + BER/ASN.1）                    | C. 系统 `ldapsearch` 子进程                                                  |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 依赖面      | 1 个直接依赖 + 少量传递依赖（`asn1js`/`debug`/`tslib` 量级），需锁版本与许可证审计 | 零 npm 依赖，但代码面=LDAP 协议子集                              | 零 npm 依赖，但要求每台主机预装 OpenLDAP client                              |
| TLS 验证    | `node:tls` 底层；可传 `ca`；也可被误配 `rejectUnauthorized:false`（须在配置层封死） | 自行校验证书链/hostname，错一行即静默失效                        | `LDAPTLS_CACERT` 可传 CA；`LDAPTLS_REQCERT never` 可关校验（须在调用层封死） |
| 协议正确性  | 成熟实现：分页搜索、referral、filter 编码、LDAP 消息分帧已处理                    | 需自行实现 BER 编解码、RFC 4515 转义、结果分页、连接生命周期     | 依赖外部二进制与版本差异；LDIF 解析脆弱                                       |
| Windows/WSL | 纯 JS，全平台一致                                                                  | 全平台一致                                                       | macOS 无预装、Windows 无预装、WSL/容器需额外安装——**不满足跨平台前提**       |
| 凭据安全    | bind 密码在进程内传入                                                              | 同 A                                                             | `-w` 进 argv 可被 `ps` 看到；`-y` 需落临时文件                               |
| 连接复用    | 可保持/显式 unbind                                                                 | 自管                                                             | 每请求一个进程，无法复用                                                     |
| 维护成本    | 上游维护 + 本仓锁版本                                                              | 本仓长期自维护协议实现                                           | 运维加装软件 + 版本矩阵                                                      |
| 适配现有构建 | Node 直接跑 TS，`import` npm 包无构建步骤（同 `ws` 软链形态）                       | 无额外依赖                                                       | 需 `spawnProcess`（AGENTS.md 子进程规则），cloud-platform 侧无现成封装        |

**建议：A（`ldapts`），有条件通过。** 理由：

- LDAP 协议面远大于本需求，自实现（B）的缺陷风险与安全评审成本不成比例；`ldapsearch`（C）的跨平台预装前提在 macOS/Windows 上直接不成立，且凭据经 argv 泄漏面不可接受。
- `ldapts` 是纯 TS、ESM/CJS 双形态、活跃维护，`ca`/`timeout`/paged search 均原生支持；与 `cloud-platform` 的 Node type-stripping 运行方式兼容（需在 G04-2 首令实测 `import`）。
- **准入条件（独立评审必须逐项给出结论）**：
  1. 许可证（MIT 及传递依赖）与本仓政策一致；
  2. 锁定**精确版本**（非 `^`），记录传递依赖清单与 CVE 扫描结果；
  3. **声明位置**：`cloud-platform/` 无独立 workspace，`node_modules` 软链到根。建议加入根 `dependencies`（与 `ws` 同形、语义正确），但须确认 electron-builder 打包范围不把该包带进桌面产物（见 Q1）；若评审选择 `devDependencies`，部署文档必须注明「生产部署用完整 `pnpm install`」；
  4. 配置层禁止透传 `rejectUnauthorized:false`（除显式 dev 开关，见 §4）；
  5. 评审未通过则回到 C（并接受主机预装前提），**不采用 B**。

评审产物：一页结论（选型、版本、传递依赖、声明位置、打包影响、否决理由），作为 G04-2 的开工门，即**生产 adapter 开工门**（§6）；未通过则按本表末条回退方案 C 并重新评审，不进入实现。

---

## 3. 配置键（env，统一 `ORCA_CLOUD_LDAP_*`）

命名沿用现有 `ORCA_CLOUD_LDAP_REQUIRED_GROUP` 与历史骨架（git `170f4e28f84` §6.2）已出现过的键；新增键同前缀、全大写、下划线。

| env 键                                | 作用                                              | 缺省 / 必填                                 | 备注                                                          |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `ORCA_CLOUD_LDAP_URL`                 | LDAPS 端点，存在即选生产 adapter                  | 未设=Mock；设置则必填                       | 仅接受 `ldaps://`；含 userinfo 的 URL 拒绝启动（见 Q5）       |
| `ORCA_CLOUD_LDAP_USER_BASE`           | 用户搜索基                                        | 生产 adapter 必填                           | 与 URL 同时校验，缺失 fail-fast                               |
| `ORCA_CLOUD_LDAP_USER_FILTER`         | 用户查找 filter 模板，`{{username}}` 占位         | `(uid={{username}})`                        | 用户名按 RFC 4515 转义后替换；准入条件由代码内嵌，不由该键注入 |
| `ORCA_CLOUD_LDAP_GROUP_BASE`          | 组搜索基，用于合成准入组 DN                       | 准入开启时必填                              | 合成 `CN=<REQUIRED_GROUP>,<GROUP_BASE>`；缺失 fail-fast       |
| `ORCA_CLOUD_LDAP_GROUP_ATTR`          | 用户条目上的组属性                                | `memberOf`                                  | 设计 §3.5 定死 memberOf，不设双栈                             |
| `ORCA_CLOUD_LDAP_GROUP_DN_TO_CN`      | 组 DN→CN 归一                                     | `1`                                         | 回填 `profile.groups` 用                                     |
| `ORCA_CLOUD_LDAP_BIND_DN`             | 服务账号 DN（search 权限）                        | 未设=以登录用户自身读组                     | 准入 filter 搜索需要可执行 search 的绑定                      |
| `ORCA_CLOUD_LDAP_BIND_PASSWORD`       | 服务账号密码                                      | 与 `BIND_DN` 成对                           | **绝不入日志/审计**；与 DN 单边配置 = 启动失败                |
| `ORCA_CLOUD_LDAP_TLS_CA`              | 私有/自签 CA 文件路径                             | 未设=系统 trust store                       | 只读加载；不存在/不可读 fail-fast                             |
| `ORCA_CLOUD_LDAP_TIMEOUT_MS`          | 连接/搜索/bind 单步超时                           | `5000`                                      | 正整数；非法值忽略并告警（沿 ttlFromEnv 先例）                |
| `ORCA_CLOUD_LDAP_RETRY`               | 仅连接/超时阶段重试次数                           | `1`                                         | 上限 2；bind 拒绝与 filter miss **不重试**                    |
| `ORCA_CLOUD_LDAP_TLS_INSECURE`        | 显式关闭证书校验（仅本地开发）                    | 未设=校验开                                 | 置 1 时启动打印高危告警；生产禁用（§4）                       |
| `ORCA_CLOUD_LDAP_REQUIRED_GROUP`      | 准入组 CN（**已存在**，本令不改语义）             | 未设=准入关闭                               | 生产 adapter 读取它来内嵌 memberOf 条件                       |
| `ORCA_CLOUD_LDAP_ATTR_DISPLAY_NAME`   | `LdapProfile.displayName` 来源属性                | `displayName`                               | 缺失回退 `cn`，再回退用户名                                   |
| `ORCA_CLOUD_LDAP_ATTR_DEPT`           | `LdapProfile.dept` 来源属性                       | `department`                                | 缺失回退 `ou`，再回填空串                                     |
| `ORCA_CLOUD_LDAP_ATTR_EMAIL`          | `LdapProfile.email` 来源属性                      | `mail`                                      | 缺失回填空串                                                  |

装配形态：

- `ApiConfig` 只加 `ldap?: LdapAdapter` 的**已有**注入点使用方式不变；env → config 的读取集中在 `createApp` 或入口（沿 `ldapRequiredGroup` 先例），生产 adapter 实例由入口构造后注入，测试继续注入 Mock/桩。
- **fail-fast 清单**（任一条成立则拒绝启动，错误信息只含键名不含值）：URL 非法/非 ldaps；`USER_BASE` 缺失；准入开启但 `GROUP_BASE` 缺失；`BIND_DN`/`BIND_PASSWORD` 单边；CA 文件不可读；`TLS_INSECURE=1` 且明确生产环境（见 Q5）。
- 启动日志一行摘要（URL 主机、搜索基、组属性、准入组、超时；**不含 DN 密码**）。

---

## 4. 安全要求

> 编号约定：本节条目以 **§4-1…§4-8** 引用；其中 **§4-3** 为 filter/DN 注入防护（RFC 4515 用户名转义、准入组 CN 单值校验、禁止自由 filter），是准入设计 §3.3/§5.2 的契约引用点。

1. **证书校验不可关闭**：默认走 `node:tls` 完整校验（链 + hostname）；CA 仅通过 `ORCA_CLOUD_LDAP_TLS_CA` 文件注入。唯一例外是显式 `ORCA_CLOUD_LDAP_TLS_INSECURE=1`：启动打印高危告警，且建议仅在 URL 指向 loopback/内网测试目录时允许（Q5 定稿）。禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0` 作为实现手段。
2. **凭据不入日志**：用户密码与服务账号密码不进入任何日志、审计 metadata、错误消息、URL；捕获客户端异常时重新归类为固定文案，禁止把含凭据的原始异常对象直接透传。`LdapProfile` 不含密码（既有契约）。
3. **注入防护（§4-3）**：用户名按 RFC 4515 转义后代入 filter 模板；准入组 CN 校验为单个 CN（拒绝 `,` `=` `\` 等 DN 特殊字符，启动时校验）；不做字符串拼接 DN 以外的自由 filter。
4. **连接生命周期**：每请求 `connect → (服务账号 search) → 用户 bind → 读组 → unbind/destroy`，所有阶段受 `TIMEOUT_MS` 约束；异常路径必须 `destroy`，防止 fd 泄漏。v1 不共享长连接（避免陈旧会话与被复用身份），连接池留作后续性能议题。
5. **重试边界**：只对连接失败/超时重试且次数受限；认证 bind 被拒、filter miss、证书错误**不重试**，避免把拒绝放大成目录压力或掩盖故障。
6. **fail-closed 语义**：任一阶段失败返回 `unavailable`（或按 §1.1 的二分结果返回 `not_admitted`/`invalid_credentials`）；登录链既有分支保持不变。**不得**在目录不可达时回退 Mock/匿名放行/跳过准入。
7. **审计**：adapter 不写审计；拒绝事件仍由登录链落 `login`/failure + `reason`（既有 vocabulary），不新增事件类型。启动配置错误属于进程启动失败，不进审计链。
8. **跨平台**：依赖方案必须 macOS/Linux/Windows/WSL 一致可运行；若最终选 `ldapsearch` 子进程方案，必须走 `@orca/process-host` 的 `spawnProcess` 并编码参数（AGENTS.md 子进程规则），且如实记录主机预装前提。

---

## 5. 测试计划

### 5.1 契约单测（进程内，无真实目录）

`createLdapsAdapter(config, { clientFactory })` 留测试注入点，用桩客户端覆盖：

| #   | 用例                                 | 断言                                                                     |
| --- | ------------------------------------ | ------------------------------------------------------------------------ |
| U1  | 在组 + 正确密码                      | `ok:true`；`profile.groups` 为归一 CN；displayName/dept/email 映射正确   |
| U2  | 准入 filter miss + uid 复查命中      | `{ok:false, reason:'not_admitted'}`；用户密码未做 bind                   |
| U3  | 准入 filter miss + uid 复查未命中    | `{ok:false, reason:'invalid_credentials'}`                               |
| U4  | 用户 bind 被拒                       | `invalid_credentials`；不读组                                            |
| U5  | 连接拒绝 / 超时 / 证书错误           | `unavailable`；不重试 bind、不重试 filter miss                           |
| U6  | 用户名 filter 转义                   | `*` `)` `\` `\0` 被转义，filter 结构不被破坏                             |
| U7  | 组 DN→CN 归一                        | `CN=platform-admins,OU=…` → `platform-admins`；大小写保持原样            |
| U8  | 配置校验                             | 缺 `USER_BASE`、缺 `GROUP_BASE`（准入开启）、CA 不可读 → 构造期抛错      |
| U9  | 重试边界                             | 连接失败按 `RETRY` 次数重试；bind 拒绝只一次                             |
| U10 | 异常不含凭据                         | 抛错/日志文本不含密码与 bind 密码（字符串断言）                          |

### 5.2 Mock 回归（零回归门）

`test/ldap-admission.test.ts`、`test/ldap-mock-required-group.test.ts`、`test/e2e/ldap-admission.e2e.test.ts` 全绿；未设 `ORCA_CLOUD_LDAP_URL` 时行为与现网完全一致（Mock + `ldapRequiredGroup` 闸门）。

### 5.3 真实目录验收（`ORCA_REAL_LDAP_TEST=1` 门控）

沿 `ORCA_REAL_CLAUDE_CLI_TEST` 形态：未置门时跳过并打印 skip 原因；置门时读取运维提供的环境（端点、CA、基、服务账号、测试账号）。

| #   | 场景                         | 断言                                                                                                              |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | 组内用户 + 正确密码          | HTTP 200；会话签发；`user.groups` 含准入组                                                                        |
| R2  | 组外用户 + 正确密码          | 401 `LDAP_GROUP_NOT_ADMITTED` + 明确文案；store 无用户行；锁定计数不增不清                                        |
| R3  | 组内用户 + 错误密码          | 401 `INVALID_CREDENTIALS`；锁定计数按既有 FR-1.4 增加（证明 filter 未掩盖凭据路径）                                |
| R4  | 目录不可达（错误端口/断网）  | 401/既有 unavailable 映射；**无会话、无 seed、无准入绕过**；不重试成风暴                                          |
| R5  | 私有 CA / 错误 CA            | 正确 CA → 200；错误 CA → `unavailable`（证明确实校验证书，未使用 insecure）                                        |
| R6  | 服务账号读取受限目录         | 配置服务账号可完成 search；未配且目录禁匿名 → fail-closed                                                          |
| R7  | 真实目录形态核实（部署前置） | 用户条目存在 `memberOf`、`uid`（或配置的登录属性）、服务账号有 search 权限；结果写入运维 checklist（设计 §5.3 四条） |

真实目录用例默认不进 CI（无目录环境）；由 G04-5 在本机/内网一次性执行并留证据。

---

## 6. 实现切分（每令 ≤20 分钟）

依赖链：G04-1 → G04-2 → G04-3 → G04-4 → G04-5。**G04-1 是生产 adapter 开工门**，未通过则整链暂停（见 §2）。

| 令     | 内容                                                                                                                                                                                             | 出口判据                                                             | 预估 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---- |
| G04-1  | 依赖评审：`ldapts` 版本锁定、许可证/传递依赖/CVE、声明位置、打包影响；否决则裁定 `ldapsearch`（含主机预装前提）                                                                                   | **生产 adapter 开工门**：一页评审结论，明确「通过/否决」与后续方案；未通过则整链暂停 | 20   |
| G04-2  | 适配器骨架：`ldaps-adapter.ts` 配置解析与校验、LDAPS 连接、simple bind、超时、错误→`unavailable` 映射；入口 `ORCA_CLOUD_LDAP_URL` 装配 + fail-fast；不实现组搜索                                     | 构造期配置测试 U8 绿；真实端点可完成「连上 + 用户 bind」；Mock 回归绿 | 20   |
| G04-3  | 组搜索与准入：用户查找 filter 内嵌 `memberOf`（准入开启）、服务账号 search、二分 miss 诊断、读组属性、DN→CN、`LdapProfile` 映射、重试边界                                                         | U1–U7/U9/U10 绿；在组/不在组两路径结果与设计 §3.3 一致               | 20   |
| G04-4  | 测试补齐：桩客户端契约用例、Mock 回归全量、`ORCA_REAL_LDAP_TEST=1` 用例骨架与 skip 门                                                                                                             | `node --test` 全绿；真实用例未置门时正确 skip                        | 20   |
| G04-5  | 真机验收：内网真实目录跑 R1–R7，记录证据；更新运维部署 checklist（目录前置四条、env 清单、回滚=撤 `ORCA_CLOUD_LDAP_URL` 重启）                                                                      | R1–R7 通过或如实登记环境阻塞项；checklist 入设计目录                 | 20   |

若任一方在 20 分钟内未收敛：拆半（例如 G04-3 拆「搜索+诊断」与「组回填+映射」），不在令内扩时。

---

## 7. 开放问题（Q1–Q5，附建议默认值）

| #   | 问题                                                                                              | 建议默认值                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | `ldapts` 的声明位置：根 `dependencies`（语义正确、可能进 Electron 打包）vs 根 `devDependencies`（不进桌面包，但部署须完整安装） | 根 `dependencies` + 评审确认 electron-builder 仅打包 `out/**`；如打包范围含全部依赖，则改 `devDependencies` 并在部署文档写明 |
| Q2  | 准入组 DN 的合成：只接受 CN + `GROUP_BASE` 合成，还是允许直接传完整组 DN？                        | 只接受 CN（与设计 §3.5 精确 CN 匹配一致），`GROUP_BASE` 必填；完整 DN 留作后续加性配置                                          |
| Q3  | 登录名属性：设计钉死 `uid`，但 AD 常为 `sAMAccountName`                                           | 缺省 filter `(uid={{username}})`，通过 `ORCA_CLOUD_LDAP_USER_FILTER` 覆盖；R7 部署核实实际属性并写 checklist                    |
| Q4  | 重试策略：默认重试几次？哪些阶段允许？                                                            | 缺省 `RETRY=1`，仅连接/超时；上限 2；bind 拒绝、filter miss、证书错误不重试                                                     |
| Q5  | `ldap://` + StartTLS 是否一期支持？`TLS_INSECURE=1` 的允许范围？                                  | 一期只支持 `ldaps://`（拒绝 `ldap://`）；`TLS_INSECURE=1` 仅在 URL 为 loopback/内网测试地址且非生产环境时接受，否则启动失败    |

---

## 8. 待审表

| 评审人 | 角色 | 结论（通过/有条件通过/否决） | 意见 | 日期 |
| ------ | ---- | ---------------------------- | ---- | ---- |
|        |      |                              |      |      |
|        |      |                              |      |      |
|        |      |                              |      |      |
