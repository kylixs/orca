# W8 审计报告（管理员 path 登记回归断言）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象：`c50ffe41ccd`（test(cloud): admin path-based project registration stays dir-free，1 文件 +31 行）
- 对照基准：work-orders-2026-11-14.md §W8（降级版）、evidence/w2-verify/w8-fact.json 裁定、AGENTS.md、W2 审计 §5 重定建议（w2-audit.md）
- 方法：只读 diff 审查 + 现行源码交叉验证（server.ts 管理员/自助路由、project-self-service.ts、contract/project-path.ts、harness.ts、种子数据）+ 证据文件核对。按只读纪律未复跑套件（测试代理职责）；「变异是否变红」为静态推理 + 复核实现代理的变异记录（PROGRESS.md，`8af175d47a6`）。报告中行号基于当前 HEAD（`8af175d47a6` 后）。

## 结论

**通过**：blocker 0、major 0、minor 2、note 5。

该提交精确落实了 W8 降级版与 W2 审计 §5 的建议——把「管理员 POST /v1/projects 按 hostId+path、无 dir」从两处隐式覆盖升级为具名断言，且断言面比最低要求更宽（path 原样、无 dir 键、ready 即时）。断言钉死目标回归、无时序/种子脆弱性、提交信息与工作令指定逐字一致。

## 1. 断言是否钉死目标回归（审计点①）

**是，三个变异方向都会红。**

1. **目标变异（dir 必填扩散到管理员路由）**：即实现代理的变异——把 `validateProjectDir` 注入 `POST /v1/projects`。静态复核成立：用例载荷无 `dir` → `validateProjectDir(undefined)` 走 `dir === ''` 分支返回 `{ ok:false, code:'INVALID_DIR' }`（project-self-service.ts:22-26）→ 400 → `assert.equal(created.status, 201, JSON.stringify(body))` 红，且诊断信息带完整错误体。无空转通过路径（status 为精确等值断言，非范围断言）。
2. **path 被改写（join/规范化）**：`validateProjectPath` 本就原样返回（contract/project-path.ts:66 `return { ok: true, path: value }`，无归一化），管理员路由 server.ts:1185 直接存 `pathVerdict.path`；若有人改成 `joinProjectPath(root, …)` 对齐自助语义，`assert.equal(body.path, targetPath, 'admin path must not be joined onto projectsRoot')` 红。
3. **载荷扩散 dir 字段**：`assert.equal('dir' in body, false)` 红（projectView 现无 dir 键，server.ts:600-617）。

变异记录（PROGRESS.md：临时注入 validateProjectDir → 如期变红 → 还原，6/6 过）与上述推理一致，论证可信。证据 `evidence/w8-regression/admin-path-registration-dir-free.json` 与断言逐项对应（201、path 原样、responseHasDir false、status ready）。

## 2. 断言位置（审计点②）

**合理，维持现址。**

工作令明示两个许可归属：「既有项目登记 e2e 或 archive 套件」，现选其一。M115 dir 语义套件是「dir 门不该扩散」这条守卫的最邻近居所——未来误加 dir 校验的人最可能正在改 server.ts 自助/契约代码路径，跑的就是这个文件；负向断言（缺 dir → INVALID_DIR）同文件在 :161/:226，正向守卫与负向契约一页对照。备选 archive 套件虽是历史级联现场（:202-209 已隐式走 admin path 登记且无 dir），但其主题是归档生命周期，登记语义守卫放那里反而更难被发现。不构成偏差。

## 3. 用例脆弱性（审计点③）

**低。逐项核验无时序/种子/环境污染依赖：**

- **实例隔离**：`spawnService('apps/api/src/server.ts', { PORT: '0' })` 每次运行起独立进程，projects 存内存（server.ts 无 projects 持久化，仅 audit log 可选落盘）→ key `admin-no-dir-demo` / path `/srv/work/admin-no-dir-demo` 跨运行不冲突。
- **种子数据**：`admin`/`zhangsan` 账号硬编码于 server.ts:434-443，与本套件其余 5 例及全 e2e 工程共用，非本用例新引入的假设。
- **无时序依赖**：管理员路由不要求主机在线（仅 `store.hosts.get`，server.ts:1143-1145，无需心跳）；`status: 'ready'` 是无 repoUrl 时的同步赋值（server.ts:1189），非轮询/等待。`registerHost` 后不心跳在本用例下完全合法（自助路由的在线要求不适用）。
- **无文件系统接触**：`/srv/work/admin-no-dir-demo` 只过 `validateProjectPath` 校验（绝对 POSIX、无 `..`/空段/尾分隔符），平台不 mkdir 不 stat；`projectPathTaken` 查内存表。
- **跨用例干扰**：独立注册专属主机（`m115-host-admin`），不改共享状态；同文件其余用例的 projectsRoot 为临时目录，与本用例的绝对 path 不相交。
- **跨平台**：Windows 下该 POSIX 绝对路径走 `isPosix` 分支同样通过，与 archive 套件 `/srv/...` 常量同一惯例。

## 4. 命名与注释合规（审计点④）

- 提交信息与工作令指定**逐字一致**（`test(cloud): admin path-based project registration stays dir-free`）。✓
- 用例名「管理员按 hostId+path 登记无需 dir：path 原样、payload 不含 dir、状态 ready」与套件既有中文命名风格一致，把三条断言意图都写进了名字。✓
- Why 注释 3 行、why 导向（FR-3.7 作用域 + 管理员路由自持语义），无过程复述；AGENTS 建议 1 行，W2 审计已把 1-3 行密度判定为合规，且断言内联消息 `admin path must not be joined onto projectsRoot` 自解释。✓
- 无任何 max-lines disable；`as Record<string, unknown>` 为 JSON 响应窄化，与同套件全部既有写法一致（cloud-platform 为独立 workspace，不入根 lint/design-system 门禁，check-changed-code-quality.mjs:11）。✓
- 纯测试新增，未触碰实现；未触碰工作令禁止的平台无关改动；交付说明入 PROGRESS.md（`8af175d47a6`），符合「冲突先指出」纪律。✓

## 5. 分级发现清单

### Blocker（0）/ Major（0）

无。

### Minor（2）

- **m-1** `self-service-project-dir.e2e.test.ts:8-13`：文件头 docstring 与 describe 标题均把套件限定为「自助建项目」，未提该文件同时守护管理员路由的 dir-free 语义。守卫的正确性不受影响（用例名自明），但只扫文件标题的读者不会知道这里藏着 W8 守卫。建议头注释补一行（如「也守护 FR-3.7 不扩散：管理员 path 登记保持 dir-free」）。
- **m-2** `self-service-project-dir.e2e.test.ts:279`：`saveEvidence('w8-regression', …)` 用内联字面量绕过了文件级 `EVIDENCE` 常量模式（:15，其余 5 例均走常量）。按工作令「证据入 evidence/<work-order>/」这是对的归属，但一个文件产出两个证据根、且其中一个不可搜（无常量引用）。建议提为第二具名常量（如 `const W8_EVIDENCE = 'w8-regression'`）并注释归属 W8。

### Note（5）

- **n-1** `:274` `assert.equal(errorCode(body), '')`：201 响应本无 error 载荷，该断言恒真，属冗余（但可作诊断锚点，与套件风格一致性优先，无害）。
- **n-2** `:277` `'dir' in body === false` 的 tripwire 比「登记语义」更宽：将来 projectView 若合法新增可选 `dir` 字段（符合线兼容规则的可选新增）也会变红。这是有意的契约钉死（用例名与提交信息均声明「payload 不含 dir」），仅提示需有意识地同步更新，非缺陷。
- **n-3** 归属备选案留档：project-archive 套件同为工作令许可归属且是历史级联现场（其 :202-209 仍隐式覆盖 admin path 登记 201）；现址邻近性论证更优（§2），不要求迁移。
- **n-4** 用例未覆盖「管理员带 dir 仍 201 且 dir 被忽略」的对照面——w8-fact.json 已探测过该行为（201，dir 非本路由字段），且不属降级后 W8 范围，留作后续可选。
- **n-5** work-orders-2026-11-14.md:39 状态表仍标 W8「待派发」，实现侧已在 PROGRESS.md 申报完成；状态表更新属主会话收口动作，非本提交义务。

## 6. 处置建议

无需回派。m-1/m-2 为两行级注释/常量整理，可由实现代理随下一个通道①任务顺手带上，或留待 W7a 一并处理；不阻塞 W8 关闭。
