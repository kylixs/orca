# M120 批量审计报告（a 登记弹层 / b 权限矩阵 / c1 策略契约 / c2 策略 UI）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象（提交本体，`git show <hash>` 逐 hunk）：
  - `4c3d7a87a81`（a，feat(cloud): admin project registration dialog；app.js +187、新 e2e 566 行 8 例）
  - `5a9df0154ce`（c1，feat(cloud): project download policy inherit control；server.ts +18/−3、新 e2e 285 行 9 例）
  - `bf34abed505`（b，feat(cloud): project permission matrix editor；app.js +172/−23、新 e2e 521 行 6 例）
  - `00f479d1d9a`（c2，feat(cloud): per-project download policy ui；app.js +103/−9、新 e2e 413 行 6 例）
  - 实际提交顺序为 **a → c1 → b →（U26/U23/U25 三个修复令）→ c2**，与设计 §7 的 a→b→c1→c2 不同；唯一硬约束（c2 消费 c1 字段，必须在其后）成立，见 §5.1。
- 对照基准：`work-orders/m120-admin-console-design.md` 全文（§3 a / §4 b / §5 c / §6 测试设计 / §7 切分）；`requirements.md` FR-3.1 / FR-9.3 / FR-9.4；`test-reports/exploratory-qa-web.md` §M116-QA-009 / 013 / 014 / 015；`defect-ledger.md` U18 / U19 / U23 / U25 / U29
- 方法：只读 diff 逐 hunk 审阅 + server.ts / contract（project-key.ts、project-path.ts、credential.ts、store.ts）交叉验证 + 四套件与其要求保持全绿的两套 W2/QA-009 回归套件实跑 + **两条关键断言的变异抽查**（红证）。主工作树源码零改动（变异即改即还原，sha256 前后一致 `a732950c…`，`git status` 复核 app.js 干净）。
- 实跑记录（真实平台进程，`PORT=0` 自起）：
  - `web-project-registration.e2e.test.ts` 8/8 绿（47.0s）
  - `web-permission-matrix.e2e.test.ts` 6/6 绿（35.3s）
  - `project-download-policy.e2e.test.ts` 9/9 绿（2.2s）
  - `web-download-policy.e2e.test.ts` 6/6 绿（26.9s）
  - `web-exploratory-fixes.e2e.test.ts` + `web-admin-gating.e2e.test.ts` 16/16 绿（含 M116-QA-009、W2-M-1、W2-m-2）（60.0s）
  - 变异①：把 c2 `effectiveDownloadPolicy` 改回「恒取原始存储值」（即设计 §5.1-1 的误报回归）→ 恰 `M120c2-4` 红（钉住者/跟随者徽标正反例），其余 5 例绿——证明三处替换断言非恒真。
  - 变异②：把 b `isDirty` 改为「无草稿也视为脏」→ 恰 `M120b-2`、`M120b-4` 红（「仅脏行一次 PUT / 其余行零请求」与首败中止计数），其余 4 例绿——证明 diff 保存语义断言非恒真。

## 结论

**PASS**：blocker 0、major 0、minor 7、note 6。

四令全部按设计落地且互相无回退；M120 的三条 P0 缺口（QA-013 / 014 / 015）在提交本体内均已闭合，线兼容论证成立，负向路径（QA-009 回滚、W2-M-1/m-2、admin 门控、fail-closed 审计门）全部保持。29 条新增 e2e + 16 条既有回归实跑全绿，两条变异抽查均被恰现有例打红，测试断言真打行为。minor 全部是文案/样式级或已被后续修复令/台账覆盖的项，不阻塞关闭。

---

## 分级发现

### blocker（0）

无。

### major（0）

无。

### minor（7）

- **m-1（a）`.invalid` 高亮对 `<select>` 无效。** `setRegistrationError` 给 `#regHost`（`<select class="select">`）加 `invalid` 类，但 styles.css 仅有 `.field input.invalid { border-color: var(--danger) }`（styles.css:126，本批量未改任何 CSS），无 `.select.invalid` 规则——主机字段的错误只有下方红字行，控件本身不变红。提示仍可达（e2e M120a-8 断言的就是文字行），纯视觉缺口。
- **m-2（a）设计 §3.2 的「失焦即校」未做。** `PROJECT_KEY_PATTERN` 校验只挂在「登记」提交时（`registrationFieldErrors`），`regKey` 无 blur/onchange 处理器（弹层内唯一事件绑定是 `#regHost.onchange`）。提交时拦截已达成「0 请求」这一硬目标（M120a-2 断言），失去的只是打字过程中的即时反馈。
- **m-3（a）`BRANCH_INVALID` 映射在 a 的提交本体上是死映射。** `REGISTRATION_FIELD_BY_CODE.BRANCH_INVALID = 'regBranch'`，但 a 的基线里管理员路由对 `defaultBranch` 完全不校验（`server.ts:1436` 直接 `String(body.defaultBranch ?? 'main')` 入库，全文件无 `BRANCH_INVALID`）——非法分支会登记成功、克隆期才在宿主侧失败，正是台账 U25 描述的缺口，随后由 `f94af5a4523` 补齐（validateProjectDefaultBranch，管理员路径 + self-service/PUT 同收紧）。对 a 本体而言该映射属超前布线、无害；但其 e2e（M120a-8）未覆盖 REPO_URL_INVALID / BRANCH_INVALID 的字段落点（见 n-4）。
- **m-4（b）`.dirty` 行高亮类是死类。** `tr.classList.toggle('dirty', …)` 在 styles.css 中无对应规则（全文件无 `.dirty`，本批量也未改 CSS）；设计 §4.4 明确预算了「新增 ≤1 个 `.dirty` 高亮类」，未落地。脏行可见性实际由行内 `未保存` 徽标（`[data-unsaved]`，e2e M120b-2 断言）承担，功能不缺，但预算中的视觉标记名存实亡。
- **m-5（b）批量保存期间控件未全部冻结，存在窄窗口草稿丢失面。** `applyChanges` 只禁用「保存变更/放弃修改」两个按钮；复选框、「添加授权」、「移除」在 PUT 序列进行中仍可点。对**已入队**行的中途编辑会被该行 PUT 时的 `draftOf(g)` 取到（行为尚可），对**未入队**行的中途编辑会在批后 `showGrants` 重绘时被静默丢弃（重绘后 draft 清空）。窗口为一次 PUT 往返，实际可达性低；未测试。
- **m-6（b）确认框「取消」的语义与设计 §4.4 文本相反（实现更优，但应对齐文档或改文档）。** 设计错误矩阵写「确认框取消 → 丢弃草稿保留服务端值」，实现是取消即关框、**草稿保留**（勾选仍在、保存按钮仍可用），只有「放弃修改」才回服务端值；e2e M120b-3 明确断言取消后 `checkbox.checked === true` 且可再保存（"the draft survives"）。零落盘这一安全面两读法一致；差异只在草稿去留。建议把设计 §4.4 该行改写为「取消 → 不落盘，草稿保留待修订；『放弃修改』才回服务端值」。
- **m-7（c2）行级保存触发整页 `renderSettings()` 重绘，连续改多行时滚动位置/焦点被重置，且两次快速改行存在「后一次重绘读到前一次 PUT 之前的平台状态」的瞬时错显窗口。** 每次重绘都从服务端拉最新值，最终态必收敛（且失败路径必须整页重绘来回滚，QA-009 模式），但覆盖行多时体验粗糙、并发双击可短暂显示陈旧值。与全局卡既有形态一致的最小实现，符合 §5.3「行内选择即保存」的粒度裁定，故仅记 minor。

### note（6）

- **n-1（流程）实际提交顺序 a → c1 → b → 修复令 → c2 与设计 §7 的 a → b → c1 → c2 不同。** 唯一排序约束「c2 消费 c1，必须在其后」成立；app.js 严格线性接力无交叠（blob 链 `11d11adf545`（a 前）→ `dc07b2f0b84`（a）→ `f715b4da69b`（b）→ `2665fa1f96f`（c2）），c1 只动 server.ts，中途三个修复令（`41b01a56516` 主进程日志、`108bf8bb832` 宿主侧、`f94af5a4523` server.ts/contract）均未触碰 a/b 的 app.js 面。无互相回退。
- **n-2（a/b/c2）提交前缀与设计 §7 提案不符（`feat(cloud)` vs 提案 `feat(web)`），c1 提交标题措辞也与提案不同；证据目录名 `w120{a,b,c1,c2}-*` 与设计 §7 的 `m120{a,b,c1,c2}-*` 前缀不同。** 均为名义差异，信息无损。
- **n-3（a）FR-3.1 的「负责人组/可见组」不在登记弹层内，属设计 §3.4/R3 的显式裁定而非遗漏。** 弹层覆盖 FR-3.1 八字段中的六个（名称/Key/仓库地址/目标主机/目标路径/默认分支），授权走 M120b 矩阵后置完成，成功 toast 明示「授权请在『成员与权限』中配置」，AC-04 两步走通（M120a-3 断言新行呈现「管理员可见（未授权）」，M120b-5 断言矩阵补授）。主会话若要求表单内授权需另立追加令（设计已声明两请求非原子）。
- **n-4（a）测试面比设计 §6 清单多一条（M120a-8 兜底映射），但 REPO_URL_INVALID / BRANCH_INVALID 两个映射项无专测。** 机制本身由 M120a-8 的 HOST_NOT_FOUND（字段）+ 503（顶部行）两例覆盖，BRANCH_INVALID 服务端行为后由 `f94af5a4523` 的 `project-branch-validation.e2e.test.ts` 接管（非本令文件）。可接受，登记为覆盖空隙。
- **n-5（a 提交信息措辞）"The entry and the dialog both gate on isAdmin()" 中弹层函数本身没有 isAdmin() 检查**——门控经由唯一入口按钮（非 admin 不渲染）达成，绕过 UI 直调由服务端 403 + denied 审计兜底（M120a-1 实证）。措辞略夸，行为符合 §3.1。
- **n-6（环境，非提交缺陷）主工作树内 cloud-platform 约 50 个文件存在**先于本审计**的未提交 prettier 重排（styles.css/index.html/server.ts/PLAN.md 等，纯格式、无语义变化）。本审计未触碰这些文件；审计期间两条变异只动过 app.js 并已按 sha256 还原（`a732950c…` 前后一致）。另：本次实跑按 U29 记载的 harness 进程泄漏留下了 3 个 PPID=1 的 `server.ts`/bun 孤儿（PID 99904/37300/37837），审计结束时已点杀清理；更早时段（16:56/17:00）的存量孤儿属其他会话残留，未动，仍挂 U29 派修。

---

## 审计清单逐项核验

### 1. M120a（`4c3d7a87a81`）— 通过（m-1/m-2/m-3/n-4/n-5）

- **W8 语义（path 直供不发 dir）落实**：请求体只含 `name/key/hostId/path/repoUrl?/defaultBranch?`（app.js，注释「管理员路由是 path 直供语义（W8）：不发 dir」），无 `dir` 键。与 server.ts 管理员路由一致——该路由只读 `body.path` 跑 `validateProjectPath`，从不读 `body.dir`；W8 审计（w8-audit.md）钉死的 dir-free 守卫套件仍在其位。
- **错误码映射与 server.ts 实际一致**：管理路由实际可回 `HOST_NOT_FOUND(400)`/`PROJECT_EXISTS(409)`（server.ts:1394/1397，**非**自助路由的 `PROJECT_KEY_TAKEN`，:1525）/`PROJECT_PATH_INVALID(400)`/`PROJECT_PATH_TAKEN(409)`（:1413）/`REPO_URL_INVALID(400)`/`PERMISSION_DENIED(403)`（:1378-1389，含 denied 审计）/审计门 503（fail-closed，写前 `recordAudit`）。映射表七项逐一对上；`PERMISSION_DENIED`、审计门、网络失败正确地**不**进字段映射而落弹层顶部 `#regError`，弹层不关、输入保留。`PROJECT_EXISTS` 与 `PROJECT_KEY_TAKEN` 的区分有专测（M120a-5 断言 key 字段文案「项目 Key 已存在。」且 path/key 双清白）。
- **admin-only 门控**：入口 `${isAdmin() ? '<button id="registerProjectBtn">…' : ''}`（renderProjects page-head，「刷新」旁，单一入口）；开发者直调 `POST /v1/projects` → 403 `PERMISSION_DENIED` + `project_create/denied` 审计，M120a-1 双向断言（UI 不可见 + 绕过被拒 + 审计落库）。
- **客户端预校验与服务端规则同源**：key 三段（长度 1–64 / `^[a-z0-9][a-z0-9._-]*$` / 不以 `.` 结尾）与 `project-key.ts` 的正则、阈值、消息、判序**逐字同源**（`.`/`..` 整串在两侧都先被首字符规则拦截）；path 客户端做设计 §3.2 要求的软校验子集（绝对路径含 Windows 盘符、无 `..` 段、非根不去尾分隔符），消息与服务端 `project-path.ts` 同文案；空段/控制字符/POSIX 混反斜杠留服务端裁决，且其原样文案落 path 字段有专测（M120a-6 的 `/srv//x` → 「项目路径包含空段（重复分隔符）。」）。服务端仍是权威（R1 口径：key/name/在线校验服务端不设防，挂 U18/U19，本批量后由 `1a1f8ac72af` 修复）。辅助呈现（revoked 主机过滤、`（离线）/（维护中）` 后缀、`主机项目根：…` projectsRoot 提示）齐全，M120a-3 断言提示真实出现。

### 2. M120b（`bf34abed505`）— 通过（m-4/m-5/m-6）

- **7 权限位与 credential 契约一致**：`GRANT_PERMISSIONS = ['open','terminal','agent','file:read','file:write','browser','download']` 与 `packages/contract/src/credential.ts` 的 `Permission` 联合**逐位逐序相等**；列头由同一数组生成（不重复手写），`browser` 列补上、`download` 锁徽标移除（M120b-1 双断言：`heads.slice(2,9)` deepEqual 七位 + `doesNotMatch /锁/`）。客户端白名单天然成立（复选框只能发这七位；行内未呈现的杂串权限在勾选时经 `new Set(draft)` 原样保留、不被静默清洗）。
- **diff 保存语义（仅脏行 PUT 行内全量）**：草稿存 `Map<rowKey, sorted permissions>`，`isDirty` 与服务端快照做排序后逐位比较；保存时只对脏行按序 PUT，body 为该行**全量数组**（服务端先删该主体旧行再按数组重建，server.ts:1770-1785，未勾位不丢）。首败即停、toast 带失败主体与已存计数、随后 `GET` 重绘（已应用的行保持）。变异②红证此语义非恒真；M120b-2 断言「1 行 2 位变更 → 恰 1 次 PUT、其余行 0 请求、服务端回读 deepEqual、重绘后脏标记清除、GET 次数恰 +1」。防双击由保存期间按钮禁用承担。
- **撤销确认文案与无在线会话端点的如实呈现**：平台确无在线会话列表端点，实现以规则性提示表达——用户行「保存将断开 <username> 当前全部云会话（含其他项目）。」（对应 `revokeUserCredentials`，server.ts:1787-1791）、组行「宿主无法解析组成员，保存将断开该项目当前全部在线会话。」（对应 `revokeProjectCredentials`，AC-12），确认框逐行列 ± 差量摘要；M120b-3 对两种文案与差量逐字断言。文案不点名任何"当前在线者"，如实。
- **W2-M-1 / W2-m-2 语义未回退**：`grantAdd` 失败分支保持「toast + return 不重绘、输入保留」（新增注释点名 W2-M-1；M120b-5 断言 `grantLoads` 不变 + `subject.value` 幸存 + 服务端未存）；死用户行复选框与移除按钮均 disabled（W2-m-2）；「移除」保持既有立即 `PUT permissions: []` + 失败 toast（未并入暂存模型，符合 §4.2 裁定），并顺带修了 `data-remove` 的冒号切分（`indexOf(':')` 取首个分隔符）。既有回归套件 `web-exploratory-fixes`（W2-M-1、W2-m-2、QA-009）在 HEAD 实跑 16/16 绿。「授予基础权限」五权限写死按钮确被「添加授权（默认 `['open']`）」取代（§4.2 减供面裁定）。

### 3. M120c1（`5a9df0154ce`）— 通过

- **契约加性、线兼容论证成立**：读字段 `downloadPolicyExplicit: p.downloadPolicyExplicit === true` 挂在 `projectView`（server.ts:737），所有投影该视图的端点（列表/创建响应/更新/归档）一致带出；布尔恒在、旧对端忽略未知字段（AGENTS「新可选字段安全」），无解码破坏面；生效值可由客户端以 `/v1/policies/download` 推导，未另发冗余字段（「可推导的不上 wire」守住）。写参 `inherit === true` 才走新分支，旧客户端从不发送。
- **旧形态 PUT 逐字节不变**：else 分支两条赋值语句 `found.downloadPolicy = nextPolicy; found.downloadPolicyExplicit = true` 与改前逐字相同；审计 metadata 旧形态仍恰为 `{ downloadPolicy, …rate }`。测试以**键集 deepEqual**（响应恰 `['downloadPolicy','readRatePerHour','version']`）与**审计 metadata deepEqual（`{downloadPolicy:'allow'}`）** 双重钉死零回归（9 例中的例 2/3）。
- **审计 metadata 不误记**：`...(inherit ? { inherited: true } : { downloadPolicy: nextPolicy })`——被忽略的 `downloadPolicy` 不再以"已生效"的面目入审计；测试用 `Object.hasOwn` 正反双向断言（inherited 事件必无 `downloadPolicy`、pinned 事件必无 `inherited`）。
- **internal policy 收敛正确**：两处 `projectOverrides` 发布点（`/v1/internal/policy` 与宿主 beat 回包，server.ts:2236-2237 / 2526-2527）既有实现本就按 `downloadPolicyExplicit === true` 过滤，`delete found.downloadPolicyExplicit` 后项目自然离场；`rateOverrides` 与下载位解耦，`inherit` 请求仍可设/清 `readRatePerHour`（例 6/7 断言，语义不动）；全局翻转后 inherit 项目随即跟随（例 5）。响应体形状（GET/PUT `/policy`）未变。admin 门（`denyPrivileged` + denied 审计）未触碰，403 双形态（旧/inherit）+ denied 审计有专测（例 8）。

### 4. M120c2（`00f479d1d9a`）— 通过

- **三处替换完整、无第四处漏网**：全文件扫描 `downloadPolicy` 裸用仅剩三处且全部正确——①覆盖行 select 的初始选中值（该表只列 explicit 项目，原值=生效值）；②写参数 `{downloadPolicy: value}`；③`effectiveDownloadPolicy` 内部。展示面四个（工作台「禁用下载项目」统计、项目卡徽标 `downloadBadge`、我的项目「下载策略」列、设置页「当前生效」列）全部走 `effectiveDownloadPolicy(p, globalDefault)`；工作台「全部项目」表无下载列、中继页/成员页只述全局默认，无漏网。变异①红证正反两例断言有区分度。
- **inherit 行移出清单**：`policyOverrides` 以 `downloadPolicyExplicit === true` 圈定、归档行排除（防御性，与 admin 默认列表行为叠加）；选「跟随全局」→ `PUT {inherit:true}` → `renderSettings()` 重绘 → 行消失、`跟随全局 N / 独立覆盖 M` 同步回落。M120c2-3 断言：恰 1 次 PUT、服务端 `downloadPolicyExplicit === false`、`effective === globalDefault`、行数 0、统计 2/0——「普通 PUT 不会清钉住」的对照含义在断言注释里写明。
- **QA-009 回滚一致**：`saveProjectPolicy` 失败 → toast「保存失败：<服务端原因>」+ 整页按服务端值重绘；M120c2-5 注入 503 后断言行回退到 deny、无重复行（`[data-policy-row]` 计数 1）、服务端钉住未变——与全局卡既有模式（同套件内 M116-QA-009 用例）同构。
- **admin 门控**：平台设置属 `ADMIN_ROUTES`，开发者强制进入落「无权访问」、零策略写请求；直调 `PUT /v1/projects/:id/policy` → 403 `PERMISSION_DENIED` 且服务端状态不变（M120c2-6 三层断言）。全局保存 toast 按.FR-9.4 报出生效半径「已保存，30 秒内生效；跟随全局 N 个项目，独立覆盖 M 个不受影响」（M120c2-4 逐字断言），副标题改为「下载策略：全局默认与项目覆盖。」并断言不再出现「客户端最低版本」（QA-015 的副标题虚言修正）。

### 5. 跨令一致性 — 通过

- **a/b/c2 共改 app.js 无互相回退**：见 n-1 的 blob 线性链；HEAD app.js 同时含 `registerProjectBtn`（:398）/`registerProjectDialog`（:505）、`GRANT_PERMISSIONS`/`showGrants` 矩阵（:807/:820）、`effectiveDownloadPolicy`/`policyOverrides`（:169/:1119），三者函数域互不交叠（a：renderProjects+弹层；b：showGrants/grantAdd/移除；c2：workbench/projects/settings）。
- **UX 从简贯彻**：三令均零新增导航项、零向导分步、零在线会话实时列表、零新依赖、零新 CSS 声明（四提交 diff 均不含 styles.css/index.html）；b 还净减了一个写死五权限的按钮供面。全部复用 `dialog()/toast()/esc()/.field/.table-wrap/.badge/.note` 既有资产，新增内联 style 与文件既有风格一致。
- **M120c1+c2 合并后语义闭环**：生效值单一真值 = `explicit ? 项目值 : 全局默认`，在服务端（GET `/policy` 的 `effective`、internal `projectOverrides`、导出门）与控制台（统计/徽标/列/覆盖表）两侧同源；钉住→全局翻转不受影响、跟随者随之翻转（M120c2-4 正反两例）、解除钉住→立即跟随（M120c2-3）三方互证。可推导字段不上 wire、撤销钉住有唯一入口（inherit）、审计不误记，闭环无死角。

### 6. AGENTS / 风格 — 通过

- **零新 CSS 声明**：四个提交均未改 `styles.css`/`index.html`；引用的 `.inline-error`/`.field input.invalid`/`.badge`/`.table-wrap`/`.mono` 均为既有规则（唯 `.dirty` 无规则，见 m-4）。cloud-platform 独立管理台不适用 docs/STYLEGUIDE.md（设计 §风格口径），无 `components/ui/` 原语约束面。
- **无 max-lines 抑制**：四个提交的 diff 内零 `max-lines` disable（唯三处 `oxlint-disable-next-line typescript/no-explicit-any`，均在 e2e 测试 helper，行级+理由，沿用套件既有惯例，合规）。
- **命名惯例**：新符号全部以具体域概念命名（`registerProjectDialog`/`registrationFieldErrors`/`REGISTRATION_FIELD_BY_CODE`/`GRANT_PERMISSIONS`/`applyChanges`/`effectiveDownloadPolicy`/`policyOverrides`/`saveProjectPolicy`/`downloadBadge`），新测试文件名即域（web-project-registration / web-permission-matrix / project-download-policy / web-download-policy），无 helpers/utils 类泛名。SSH/远程与 wire 兼容约束：c1 是全批量唯一线变更且按「新可选字段安全」处理（§3 已证）。

### 7. 测试质量 — 通过

- **真打行为、无恒真**：四套件 29 例全部断言可观察事实——请求计数（`calls()` 过滤精确到方法+路径）、请求体形状（服务端权限数组 deepEqual、响应键集 deepEqual、审计 metadata deepEqual）、服务端状态回读（`GET /grants` / `GET /projects` / internal policy `Object.hasOwn`）、UI 状态（字段错误文本、弹层开合、activeElement、toast 文案、行数/徽标文本）。负向用例全部注入真实平台可复现的失败（`page.fail('PUT', …)` 503/409、直调越权 403），且断言"未发生副作用"（0 请求、服务端不变、无重复行）。
- **变异抽查（2/2 红证）**：变异①（c2 生效值推导回退为原始存储值）→ 恰 M120c2-4 红；变异②（b 脏行判定恒真）→ 恰 M120b-2/M120b-4 红。两条红证均与被测语义一一对应，无空转通过路径。
- **设计 §6 断言清单覆盖度**：a 6/6（超配 1 条兜底例）、b 6/6、c1 3 项展开为 9 例（含设计未要求的响应键集/审计 metadata 逐键断言）、c2 5/6 项全过 + 第 6 条门控专例（超配）。要求保持全绿的 `web-exploratory-fixes`（QA-009/W2-M-1/W2-m-2）与 `web-admin-gating` 实跑 16/16 绿。
- 证据目录四套齐备：`cloud-platform/evidence/w120a-registration-dialog/`、`w120b-permission-matrix/`、`w120c1-policy-inherit/`、`w120c2-policy-ui/`（另有后续修复令的 `w120-fix-u18u19/u20/u25/u28`）。

---

## 台账衔接建议（先登记后派修）

按流程整改第 1 条，以下 minor 建议登记后派修（均可作下一通道①任务的顺带项）：

| 建议 # | 来源 | 内容 | 量级 |
| --- | --- | --- | --- |
| 新 U（建议） | m-4 | styles.css 补 `.dirty` 行高亮（或删除死类，明示以 `未保存` 徽标为准） | 一行 CSS |
| 新 U（建议） | m-1 | styles.css 补 `.select.invalid`（或错误时给 `.field` 加错误态） | 一行 CSS |
| 新 U（建议） | m-2 | regKey 失焦即校（onblur → `registrationFieldErrors` 单字段） | 数行 |
| 新 U（建议） | m-6 | 设计 §4.4 文本与实现对齐（取消保留草稿） | 文档一行 |
| 新 U（建议） | m-5/m-7 | 批量保存期间冻结矩阵交互；覆盖行保存防连点去抖/按行局部重绘（可选） | 小令 |
| 挂账核对 | n-4 | REPO_URL_INVALID 字段落点无专测（BRANCH_INVALID 已由 `f94af5a4523` 套件接管） | 可选加严 |
