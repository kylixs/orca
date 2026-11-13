# W2 审计报告（M116 QA 修复，三笔提交）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象：`21651eea9ce`（F1 用户授权按 username 解析）、`807c3b9ff2e`（F2 QA-002~012 批量修复）、`2bd257e4934`（archive e2e 补 dir）
- 对照基准：work-orders-2026-11-14.md §W2/§W8、requirements.md FR-2.4/3.7/4.5/8.3/8.4、AGENTS.md、evidence/m116-exploratory-web/findings.json（QA-001~012）
- 方法：只读 diff 审查 + 现行源码交叉验证（server.ts / store.ts / audit.ts / app.js / 三个测试文件 / harness）+ 既有证据文件（evidence/w116-fixes/*.json）核对。按只读纪律未复跑测试套件（测试代理职责）；「回归是否变红」为推理判定。

## 结论

**不通过（有 major）**：blocker 0、major 1、minor 4、note 7。

三笔提交的修复方向、覆盖面与防回归力整体扎实：F1 的服务端解析+撤销范围收窄正确且有强断言；F2 十一项均有真实产品代码修复（非改断言）且各带一条可变红的回归断言；2bd257e4934 是正确的测试侧对齐，未掩盖平台问题（详见 §5，W8 前提本身不成立）。

唯一的 major（M-1）：`21651eea9ce` 在服务端新增 400 USER_NOT_FOUND 后，console 的授予/移除入口没有配套错误处理，输错用户名在页面上表现为完全静默——与本次 W2 自己修的 QA-009 同形态。需回派实现代理补一处 try/catch + toast。

---

## 1. QA-001~012 逐条核对

判定口径：「真实覆盖」= 存在产品代码修复而非仅测试调整；「防回归」= 把修复还原后对应断言会失败。

| QA | 修复位置 | 真实覆盖 | 防回归（还原坏代码是否变红） |
|---|---|---|---|
| 001 用户授权不生效+误撤全项目 | server.ts:1485-1497（解析+拒绝）、1515-1525（退役死行）、1532-1537（仅撤该用户）、app.js:565（矩阵显示用户名） | 是 | 是。测试 1 断言 `subjectId` 匹配 `/^user_/` 且未知名返回 400 USER_NOT_FOUND（旧代码存原文 → 双红）；测试 2 断言 `revoked.projects` 不含 proj_payment（旧代码 `store.users.get('lisi')` 为 undefined 走 revokeProjectCredentials → 红） |
| 002 审计 50 条无提示 | app.js:622-724（cursor 分页 + 「已显示 N 条」+ 「仅显示最近 50 条」+ 加载更早） | 是 | 是。断言 `已显示 50 条`、`#auditMore` 存在、加载后与 `limit=200` 总数一致、耗尽后控件消失（旧代码固定 50 无控件 → 红） |
| 003 筛选条件被重置 | app.js:630-633（从 state 回填）、667-673（value 赋值恢复）、684-694（apply 全量携带）、696-702（重置） | 是 | 是。断言查询后控件值保留、二次查询 URL 同时含 eventType 与 result（旧代码丢条件 → 红）、重置后无 eventType= |
| 004 traceId 截断不可复制 | app.js:681-683（全量渲染 + title + 复制按钮） | 是 | 是。断言完整 traceId 出现在单元格、`dataset.trace` 等于全量、title 等于全量（旧 `slice(0,12)` → 红） |
| 005 主机状态用持久 status | app.js:399-415（按 `h.online` 推导，revoked 优先） | 是 | 是。断言 dev-001（status=online、online=false）行显示 离线 且不出现 在线（旧 `h.status==='online'` → 红）。前置断言先验证 API 两字段，防测试自身失效 |
| 006 已吊销无标识可再维护 | app.js:402-415/464/467-468（标识+按钮禁用）、server.ts:2008-2012（409 HOST_REVOKED） | 是 | 是。服务端：对已吊销主机维护断言 409+code（旧代码返回 200 → 红）；页面：行与抽屉显示 已吊销（、两个按钮 disabled（旧代码可点 → 红） |
| 007 离线打开仅一处禁用 | app.js:233-247（openDisabledReason/Attr 统一驱动）、249-266/286-299/337-360（卡片/工作台行/我的项目行共用） | 是 | 是。断言三个入口全部 disabled 且 title=主机离线（旧代码卡片与我的项目行可点 → 红）。用「结束维护后心跳静默」构造离线态，同时覆盖 QA-005 的次生症状 |
| 008 维护原因不可见 | server.ts:608-609（payload 增 hostMaintenanceReason）、app.js:216-221（维护中 · 原因） | 是 | 是。断言工作台行含 `维护中 · 数据库主从切换` 且打开禁用（旧代码渲染 离线/主机离线 → 红） |
| 009 策略保存失败无提示 | app.js:747-762（try/catch + toast + renderSettings() 回滚） | 是 | 是。断言 toast 含 保存失败、单选回落 deny、策略 version 不变（旧代码无 catch → 无 toast 且 `:checked` 仍为 allow → 红） |
| 010 admin 权限列全空 | app.js:223-231（管理员可见（未授权））、233-241（未授权禁打开） | 是 | 是。断言列文案、打开禁用+title；再授予 platform-admins 后断言列出真实权限且可打开（旧代码列空、可点 → 红） |
| 011 加载失败永久加载中 | app.js:117-133（loadContent try/catch + 错误态 + 重试） | 是 | 是。断言 加载失败 + 具体原因 + 重试按钮，clearFails 后重试渲染出中继页（旧代码永久 加载中… → 红） |
| 012 空提交烧锁定次数 | app.js:879-887（空值客户端拒绝并标红账号框） | 是 | 是。断言错误文案、账号框 invalid、`calls()` 不含 `POST /v1/auth/login`（旧代码发出请求 → 红） |

全部 11 项（002~012）均有产品代码修复且各有一条能防回归的断言；F1 有两条（授权生效 + 撤销范围）。断言普遍先固化前置条件（如 `seeded.status==='online' && seeded.online===false`），失效时会显式报错而非静默通过，质量好。

### F1 测试的两点削弱（不改变结论）

- 测试 2 的 `revoked.users.some(u => u.id === 'lisi')` 会因测试 1 已产生的同键撤销记录而通过（revocations 累积不清理）；但同断言组的两条负向断言（不含 zhangsan、不含 proj_payment）在旧代码下必然变红，防回归力成立。
- 提交信息称「audit event records the resolved subject」，实现存在（server.ts:1508）但 e2e 未断言 audit metadata（→ note n-1）。

---

## 2. F1 安全语义

**username→user id 解析（server.ts:1481-1497）**：合规。

- 空白：`String(body.subjectId ?? '').trim()`，`''`/纯空白 解析失败 → 400，不会再存出死行（顺带修掉了旧行为里空主体可入库的问题）。
- 大小写：`usersByName` 精确匹配，与登录路径（server.ts:842 同一 Map）口径一致——大小写不符的用户名本来也登不进来，拒绝是对的。
- 注入面：subjectId 只进内存 Map、JSON 响应与审计 metadata；console 侧经 `esc()` 转义（app.js:565）。无 shell/SQL/HTML 注入路径。
- 解析顺序 `store.users.get(submitted) ?? store.usersByName.get(submitted)`：user id 形如 `user_<uuid>`，与用户名空间实际不相交，先 id 后名的优先级无歧义。

**撤销范围（server.ts:1526-1537）**：严格限该用户。修复后 user 分支的 `subjectId` 必为已解析的合法 id，`store.users.get(subjectId)` 必命中 → `revokeUserCredentials`（按 username 记撤销，与凭证 `sub=user:<username>` 对齐，server.ts:2444-2450 注释明确）；`else` 的 revokeProjectCredentials 只剩 group 一条路（主机无法解析组成员，AC-12 语义保留）。测试 2 对 `revoked.projects` 的负向断言钉死了「不得全项目撤销」。

**遗留死行清理 `g.subjectId === submitted`（server.ts:1515-1525）**：无误伤。

- 可能被退役的行 = 同项目 + 同 subjectType=user + subjectId ∈ {已解析 id, 提交串}。合法行的 subjectId 只会是某用户 id；若 `submitted` 恰为另一用户的 id，解析结果相同，属同一主体。用户名不形如 `user_<uuid>`，不存在跨用户误配。
- 清理不完整（→ minor m-2）：仅当管理员按同名再次授予/移除时才退役；若该用户已被删除（PUT 直接 USER_NOT_FOUND）或从未再触碰，username 键的旧行永久滞留且 UI 无法移除。

---

## 3. 线兼容与契约

- `GET /grants` 新增可选 `username`（server.ts:1460-1470）：**安全**。旧客户端忽略未知字段；旧服务端 + 新 console 走 `g.username ?? g.subjectId` 回退（app.js:565）。/grants 的消费方只有 console 与测试 fixture，桌面端只 PUT 不严格解析 GET。
- `projectView` 新增可选 `hostMaintenanceReason`（server.ts:608-609）：**安全**，可选新增。
- 新错误码 `HOST_REVOKED`（409）、`USER_NOT_FOUND`（400）：error 载荷形状不变（code/message），旧客户端按文案显示，无解析分支依赖 code。**但 console 对这两个新响应都没有展示路径**（→ major M-1）。
- 审计事件形状：字段集不变；`grant_update` 的 metadata 新增可选 `username`，且 `metadata.subjectId` 的取值语义从「提交串」变为「已解析 user id」。符合「新增可选字段安全」，但按 subjectId 反查用户名的旧日志消费方会拿到 id——建议在交付说明注明（→ note n-6）。审计链本身（hash chain）不受影响。

---

## 4. 规范符合（AGENTS.md）

- **max-lines**：三笔提交均无任何 eslint/oxlint disable、无 per-file bump。✓
- **命名**：`web-console-page.ts` 以「装的是什么」命名（console DOM harness 及其类型），合规；`web-exploratory-fixes.e2e.test.ts` 以覆盖内容命名，可接受。✓
- **注释密度**：新增注释 1-3 行、why 导向、锚定 QA 编号（如 server.ts:2008-2009、app.js:224-226、623-624），无过程性复述。✓
- **checked types**：新测试 `adminApi` 返回 `body: any`（web-exploratory-fixes.e2e.test.ts:36），同文件其余处均为窄化断言——违反 AGENTS「prefer checked types」精神；cloud-platform 是独立 workspace 不进根 lint 门禁（config/scripts/check-changed-code-quality.mjs:11 明确忽略），故降为 minor（→ m-3）。同文件另有 4 处 oxlint 报错（curly / prefer-array-find ×2 / no-useless-fallback-in-spread），仅记录。
- **跨平台**：改动面为 web console + Node API，无路径/shell/快捷键假设；`dir` 为单段相对名，`joinProjectPath` 保留宿主分隔符风格。✓
- **裸色值/计算 className**：app.js 仅复用既有 class（badge/dot/muted/forbidden 等），无新增颜色值；`dot ${offline ? 'offline' : 'online'}` 为文件内既有模式。design-system 门禁 scope 为 src/renderer，不适用。✓
- **工作令纪律**：未触碰平台无关改动；偏差在 PROGRESS.md 交付说明中申报（符合「冲突先指出，不改文档」）。✓

---

## 5. `2bd257e4934` 处置建议

**事实核验**：
1. 该提交只动测试：1 文件 +4 行，四处 `createSelf` 载荷补 `dir`。✓
2. 平台行为在 HEAD 未修也**无需修**：管理员登记路由 `POST /v1/projects`（server.ts:1126-1213）只走 `validateProjectPath`，从不要求 `dir`；`INVALID_DIR` 仅由自助路由 `/v1/projects/self`（server.ts:1248-1251）产生。
3. 回溯 QA 快照 `98cb583bbc9`：当时管理员 path 路由同样无 dir 校验。archive 套件四处失败全部来自 `createSelf`（`POST /v1/projects/self`，devToken=开发者自助），是 W1（FR-3.7）**按设计**把 dir 设为必填后，套件载荷未跟上契约。
4. 管理员 path 登记语义仍被持续覆盖：project-archive.e2e.test.ts:202-209（admin 按 path 建 path-blocker，无 dir，201）+ web-exploratory-fixes.e2e.test.ts before 钩子（admin 建 order-service 用 path，无 dir）。「自助缺 dir → INVALID_DIR」的负向断言在 self-service-project-dir.e2e.test.ts:161/226，覆盖未丢失。

**结论**：该提交**没有**掩盖「管理员 path 登记」问题——因为该问题不存在；它修的是 W1 契约变更后测试载荷滞后，属正确的测试侧止血（提交信息与 PROGRESS.md 均如实申报，未越权改文档）。

**W8 需重定**：W8 工作令的前提「管理员按 path 登记项目的旧调用收到 400 INVALID_DIR（project-archive.e2e 4 断言级联）」与事实不符——失败调用是自助路由的，不是管理员 path 登记。建议：
- 撤销 W8 的服务端改动项（「dir 缺省按 key/path 派生」对管理员路由无意义，该路由本就无 dir 字段）；
- 将 W8 缩为：补一条显式回归断言「管理员 POST /v1/projects 按 path、无 dir → 201」（现虽被两套件隐式覆盖，但无具名断言，将来再有人给管理员路由加 dir 校验时不会被任何具名用例拦住），并在工作令/记录中更正「真回归」定性，避免该错误结论随文档下传。

---

## 6. 三个偏差决策评审

1. **QA-010 改为「管理员可见（未授权）」+ 禁用打开**：合理。findings 的 expected 本就给了两个可选方向（禁用+提示 或 展示真实授权主体），实现两者都做了。禁用的 gating（`permissions.length===0 && isAdmin()`）与可达场景精确对齐——开发者列表按 `effectivePermissions(p).includes('open')` 过滤（server.ts:1116-1121），不可能出现零权限行，故该条件不会误伤开发者。测试还演示了「授予后即恢复可开」的完整闭环。无异议。
2. **audit cursor 分页**：合理。`nextCursor` 基于 `seq`（audit.ts:168）而非 offset，加载更早期间新事件到达不会错位/重复；筛选条件与 cursor 同携，组合筛选下翻页正确；离开页面即弃累积（app.js:623-627），不会复活陈旧列表。边界：总数恰为 50 的整数倍时需多点一次「加载更早」拿到空页控件才消失（audit.ts:168 的 `page.length === limit` 判据），可接受的 UX 瑕疵（→ note n-3）。findings 的 expected 是「总数+分页 或 明确提示」，实现取后者+加载更早，满足条文。
3. **行号漂移按语义定位**：合理且是唯一可行做法——findings.json 的 file:line 基于 QA 快照 `98cb583bbc9`，与 HEAD 之间隔了 W1 等多笔提交。实现质量：代码内注释均锚定 QA 编号，测试以行为断言而非行号，漂移风险已被测试面兜住。

---

## 7. 分级发现清单

### Blocker（0）

无。

### Major（1）

- **M-1** `cloud-platform/apps/web/app.js:593-606`（授予）、`607-617`（移除）：PUT /grants 两个 console 入口无 try/catch。`21651eea9ce` 在服务端新增 400 USER_NOT_FOUND 后，管理员输错（或已离职）用户名时：无 toast、矩阵不刷新、控制台 unhandled rejection——**新引入的静默失败**，与本次 W2 自己修的 QA-009（保存失败无提示，定 P1）同形态，且恰是 F1 修复的目标流程；F1 的「未知用户被拒」对用户实际不可见。同 handler 的空主体静默 return（app.js:595，QA-028/P2）属既有范围外问题，一并提及。修法：仿 QA-009——try/catch 后 `toast(\`授予失败：${err.message}\`)`（移除同理），可另补一条 console 侧断言。服务端行为本身正确，无需回退。

### Minor（4）

- **m-1** `cloud-platform/apps/api/src/server.ts:1490-1494`：未知用户的 PUT /grants 在 `recordAudit` 之前被拒，不产生 denied 审计事件；同端点 403 走 `denyPrivileged` 记审计、自助创建路径所有 deny 也记审计（server.ts:1220-1236）。对用户名枚举/越权尝试无审计痕迹（FR-8 系列）。建议拒绝也记 `grant_update` denied。
- **m-2** `cloud-platform/apps/api/src/server.ts:1515-1525`：遗留死行清理只在「按同名再授予/移除」时发生；用户被删除后其 username 键旧行永久滞留且 UI 无法移除（移除也要先过 USER_NOT_FOUND），矩阵继续显示一个永不生效的授权。建议：GET /grants 或删除用户时清理，或允许对不存在主体做 `permissions:[]` 清除。
- **m-3** `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts:36`：`body: any` 违反 AGENTS「prefer checked types」；子工作区无 lint 门禁故不挡 CI，但同文件其余处均窄化断言，建议统一 `unknown` + 断言。另同文件 4 处 oxlint 报错（:42 no-useless-fallback-in-spread、:94 curly、:366/:376 prefer-array-find）仅记录。
- **m-4** `cloud-platform/apps/web/app.js:718-723`：新增 traceId 复制按钮沿用 QA-021（P2）的「clipboard 未等待/失败仍提示 已复制」反模式，非安全上下文假成功。P2 不在 W2 范围，但新代码不应复制已知缺陷形态（`copyCommandAction` app.js:427-437 同型，既有）。

### Note（7）

- **n-1**：提交信息称 audit 记录已解析主体，实现存在（server.ts:1508）但 e2e 未断言 `metadata.username/subjectId`——断言缺口，防回归力弱于提交声明。
- **n-2** `cloud-platform/apps/web/app.js:707/714/716-717/756/760`：renderAudit 的 apply/reset/more 与 renderSettings 回滚重渲染绕过 `loadContent` 的 try/catch，失败无错误态；QA-011 只覆盖导航进入路径。缺口比修复前小，同类残留。
- **n-3** `cloud-platform/apps/api/src/audit.ts:168`：总数恰为 50 整数倍时需多点的「加载更早」返回空页后控件才消失，可接受。
- **n-4** `cloud-platform/apps/web/app.js:209-214`：已吊销主机上的项目在项目列表显示「主机离线」徽标（hostStatusView 把 revoked 归 offline），语义可接受，但「已吊销」信息在项目维度不可见，仅主机页/抽屉可见。
- **n-5**：用户名解析大小写敏感与登录一致、空白已 trim、无注入面——判定合规（§2 详述），留档备查。
- **n-6**：审计 `metadata.subjectId` 取值语义变化（提交串 → 已解析 id）+ 新增可选 `username`，符合线兼容规则，建议在交付说明向旧日志消费方注明。
- **n-7**：F1 测试 2 的 `revoked.users` 断言受撤销列表累积影响略有削弱，但靠负向断言（无 zhangsan、无 proj_payment）保住防回归力（§1 详述）。

---

## 8. 复核建议（回派实现代理的最小集）

1. M-1：授予/移除 handler 补 try/catch + 错误 toast（一处提交，`fix(web): report refused grants`）。
2. m-1 / m-2：可与 M-1 同批或随 W8 重定一并处理（低风险小改）。
3. W8 重定（§5）：具名「管理员无 dir 按 path 登记 → 201」断言 + 更正工作令记录，取消不存在的服务端修复项。
