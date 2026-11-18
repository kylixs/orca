# 待决策事项简报（2026-11-17）

> 范围：数据采集 A+、P1 启动、审计存储二期、U163 车道去留。U116②/④ 已由用户暂缓，不在本简报展开。
> 口径：只列可核验事实；「已落地」附提交或代码/证据路径，「未落地」附检索结论。
> **证据缺口**：全仓不存在「数据采集 A+」「P1 启动」的方案/需求文档（`git grep` + 全仓检索仅命中 `cloud-platform/PROGRESS.md` 三处决策项与 `cloud-platform/test-reports/backlog-inventory-20261117.md` #15–#17）。因此 D1/D2 的现状事实来自现有架构文档、代码与需求约束，而非未入库的方案文本；选项成本为粗估，细化前需补方案文档。

> 补充（2026-11-17 14:5x）：D1/D2 的正式方案草案已补：`work-orders/collection-and-agent-invocation-draft.md`（`4001213a8d9`，22 字段表/采集路径/隐私治理/容量估算/Q1–Q6 默认建议；**未获批准，不得据此开工**）。

## 决策总览

| 编号 | 一句话决策问题 | 建议 | 待决策前默认执行 | 不决策的后果 |
| --- | --- | --- | --- | --- |
| D1 | 采集 A+ 采用「宿主为中心 + Orca Web 主入口」，且是否采集 prompt 正文？ | 架构选 A（宿主为中心）；隐私选 A（仅元数据，正文默认不采集） | 按 A/A 冻结设计与事件字段，不扩采集面 | 采集面随实现漂移；正文边界被默认打开后难以收回 |
| D2 | 是否现在启动 P1（自助建项目 + `agent_invocation` 元数据）？ | 启动，限元数据、prompt 正文不采集 | 按元数据 schema 开工，正文相关字段不进入契约 | P1 继续挂起；自助建项目已落地但采集价值未兑现 |
| D3 | 审计存储二期是否作为 P1 的前置？ | 不作为前置；并行、设容量触发阈值 | P1 不等二期；二期按环境窗口推进 | P1 被环境依赖长期阻塞，或二期被无限期拖延 |
| D4 | U163 补齐车道：移除 / 仅非本地启用 / 保留默认关闭开关？（**U176 已按建议关闭**：默认关闭 + 主进程路由/V7 E1 为验证终点，2026-11-18） | 保留默认关闭开关（现状 (c)），并设退出条件 | 维持现状 (c)，无额外运行时成本 | 车道长期僵尸化，或过早删除丢失已验证件 |

---

## D1 采集 A+：宿主为中心 + Orca Web 主入口；隐私边界

### D1.1 决策问题

采集链路以**执行宿主**为采集与事实源头、以 **Orca Web** 为主分析入口（A），还是以平台/中继为中心（B），或双轨（C）；同时裁定是否采集 prompt 正文。

### D1.2 现状事实

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 平台定位 | 已落地：平台=注册中心+认证授权，业务数据面不经平台 | `remote-connectivity/design/2026-11-13-cloud-dev-platform/requirements.md` §2.3；`design.md` §2 |
| 宿主拥有执行与状态 | 已落地：终端/文件/agent 状态由执行宿主拥有，平台只订阅 | `AGENTS.md`「Agent Status」「SSH Use Case」；`current-state/m09-orca-web.md` §3 |
| Orca Web 复用完整 App 壳 | 已落地：`web-root.tsx` 懒加载原生 `App`，经 relay 伺服 `out/web` | `current-state/m09-orca-web.md` §1；`src/renderer/src/web/` |
| 宿主侧采集管道 | 部分已落地：宿主审计队列/心跳上报已存在（文件事件一期） | `cloud-platform/apps/api/src/host-audit-ingest.ts`；`u66-audit-tech-design.md` §6.1；提交 `2c99689d684` |
| `agent_invocation` 采集 | **未落地**：全仓无该事件类型、字段、表列或文档定义 | 全仓检索 `agent_invocation` 0 命中（`claude-subagent` 的 invocation 为无关标识） |
| prompt 正文采集 | **未落地且与现行需求冲突**：需求明确不记录 AI 对话内容，客户端诊断默认不含代码/终端内容 | `requirements.md` §5.4、FR-10.6；`u66-audit-tech-design.md` §9 O-5（摘录默认关闭，开启需合规确认 OQ-16） |
| A+ 方案文档 | **未入库** | 见文首「证据缺口」 |

### D1.3 选项

| 选项 | 内容 | 成本（粗估） | 风险 | 影响面 |
| --- | --- | --- | --- | --- |
| **A（建议）** | 宿主采集 `agent_invocation` 元数据并上报；平台聚合；Orca Web 为主入口 | M：宿主三平台埋点 + 上报/缓冲；平台聚合查询 | 宿主版本碎片、离线丢事件；需能力协商与缺口可见性 | `src/main`、`src/renderer/src/cloud`、`cloud-platform/apps/api`、`apps/web` |
| B | 平台/中继侧采集（控制面或 relay 解析） | L：需改数据面或降低 E2EE 语义 | 与 §2.3「平台不代理数据面」冲突；relay 仅见元数据，拿不到 agent 调用；隐私面最大 | relay、平台 API、协议与审计口径 |
| C | 双轨：宿主上报 + Web 控制台另行埋点 | L：两套管道、去重与口径对齐 | 同一事件两套真相；隐私边界翻倍；查询结果不一致 | A 的全部 + `apps/web` 前端埋点 |

**隐私子决策**

| 选项 | 内容 | 成本 | 风险 | 影响面 |
| --- | --- | --- | --- | --- |
| **A（建议）** | 仅元数据：时间、用户、项目、主机、agent/模型、耗时、token 数、结果/错误码；不含 prompt、回复、代码、文件、终端内容 | S：schema + 序列化负控 | 分析能力受限，但可逆 | 事件契约、审计/查询、UI 文案 |
| B | 元数据 + 默认关闭的正文摘录（≤1KB、显式开启、180 天） | M：沿用 U66 摘录开关模型，需合规确认 | 开关一开即正文入链；需求 §5.4 需修订 | `requirements.md`、policy pack、宿主裁剪、查询 |
| C | 默认采集 prompt 正文 | M | 直接违反 §5.4/FR-10.6；合规与信任风险最高 | 需求、法务、全链路存储 |

### D1.4 建议与理由

**选 A + A。** 宿主本来就是执行与状态的唯一权威，采集放在宿主不需要改数据面/E2EE，也不引入第二套真相；Orca Web 已是完整原生壳入口，作为主入口无需另建分析前端。隐私仅采元数据：现行需求已明文禁止记录 AI 对话内容，A 不需要改需求、可立即实施；B 只能作为后续显式合规决策，C 不建议。

### D1.5 不决策的后果与默认方案

不决策则采集范围会由实现者自行解释，正文边界一旦默认打开难以回收。**默认按 A/A 执行**：冻结「宿主采集 + Orca Web 入口 + 仅元数据」设计；正文相关字段不进入事件契约，不新增摘录开关。

---

## D2 P1 启动：自助建项目 + `agent_invocation` 元数据

### D2.1 决策问题

是否现在启动 P1：交付自助建项目，并以元数据形式采集 `agent_invocation`（prompt 正文默认不采集）。

### D2.2 现状事实

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 自助建项目（后端） | **已落地**：`POST /v1/projects/self`，主机选择/目录推导/配额/自动授权，审计 `selfService:true` | `cloud-platform/apps/api/src/project-self-service.ts`；提交 `7eba67c76cd`；`cloud-platform/test/e2e/self-service-projects.e2e.test.ts` |
| 自助建项目（目录选择/新建） | **已落地**：宿主心跳清单 `projectDirs` + 单级目录校验；UI 支持「选择已有/新建」 | `server.ts` `parseProjectDirs`；`src/renderer/src/cloud/cloud-new-project-dialog.tsx`；`self-service-project-dir.e2e.test.ts` |
| `agent_invocation` 元数据 | **未落地**：无事件类型/字段/表列/上报路径 | 全仓检索 0 命中 |
| prompt 正文 | **不采集**：与 §5.4 一致；U66 摘录默认关闭 | `requirements.md` §5.4；`u66-audit-tech-design.md` §9 O-5 |
| P1 方案文档 | **未入库** | 见文首「证据缺口」 |

### D2.3 选项

| 选项 | 内容 | 成本 | 风险 | 影响面 |
| --- | --- | --- | --- | --- |
| **A（建议）** | 启动 P1：自助建项目维持现状；新增 `agent_invocation` 元数据事件（宿主产生、平台聚合），正文不采集 | M：事件契约 + 宿主三平台埋点 + 平台 ingest/查询 | 宿主版本差异、离线补投缺口；schema 冻结过早 | 宿主 runtime、平台 API、审计/查询、Orca Web |
| B | 等 A+ 架构裁定后启动 | S（等待） | P1 无限期挂起；自助建项目已交付但采集价值未兑现 | 无代码影响，仅排期 |
| C | 只保留自助建项目，不做 `agent_invocation` | S | P1 名存实亡；后续重启需重新立项 | 不影响现有代码 |

### D2.4 建议与理由

**选 A。** 自助建项目已交付，P1 的实际增量只有 `agent_invocation` 元数据；该事件契约与 A+/B 的汇聚入口解耦（宿主产生、平台接收），不必等架构裁定。先按仅元数据启动，可验证采集价值且不触碰 §5.4 的正文红线；若后续要正文，再走 D1 的 B 选项与合规流程。

### D2.5 不决策的后果与默认方案

不决策则 P1 继续作为挂起项占据主线，且实现者可能顺手扩字段。**默认按 A 执行**：只开工元数据契约与宿主上报，prompt/回复/代码/终端内容字段一律不进入 schema；自助建项目不再重复建设。

---

## D3 审计存储二期：是否作为 P1 前置

### D3.1 决策问题

是否先把审计存储二期（G-04 的 Redis Stream 队列 + PostgreSQL/对象存储 WORM 归档）做完，再启动 P1。

### D3.2 现状事实

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 审计存储一期 | **已落地**：单写入者串行定序、哈希链、JSONL 追加与重启回放、fail-closed | `cloud-platform/apps/audit-writer/src/writer.ts`；提交 `c7eaa4cb86c`；`evidence/m31-audit-verify/`、`evidence/m32-audit-fail-closed/` |
| 签名锚点 / standby | **已落地**：5 分钟签名锚点、备用写入者接管 | `apps/audit-writer/src/anchor.ts`、`writer-lease.ts`；提交 `6ffecca9d15`、`b00fce05748` |
| 审计存储二期 | **未落地**：Redis Stream 队列、PostgreSQL/对象存储 WORM 归档未实现，依赖部署形态 | `design.md` §13.2；`PROGRESS.md` L1941/L2255/L3961；G-04（L1472） |
| U66 审计二期（`files.download` 等） | **未落地**，且与「存储二期」不是同一项 | `u66-audit-tech-design.md` §6.2；代码无 `files.download` handler（仅权限白名单） |
| 容量触发线 | 设计已给阈值：日均文件事件 >5k 或总量 >100 万条触发存储立项 | `u66-audit-tech-design.md` §6.2 / §9 O-2（M-12） |

### D3.3 选项

| 选项 | 内容 | 成本 | 风险 | 影响面 |
| --- | --- | --- | --- | --- |
| A | 作为 P1 前置：先完成 Redis/PG/WORM 再开 P1 | L：2–3 周 + 环境/部署，且依赖外部资源 | P1 被环境窗口长期阻塞；存储超前于数据量 | `apps/audit-writer`、部署、DBA/对象存储 |
| **B（建议）** | 非前置：P1 并行；按容量阈值或合规要求触发二期 | M（P1 期内） | 若事件量突增，文件链可能先到容量上限；需监控 | 审计写入、容量告警、部署排期 |
| C | 取消二期，长期用单文件链 | S | 无多副本队列、无 WORM 归档，G-04 不闭环 | 审计可用性/合规 |

### D3.4 建议与理由

**选 B。** P1 的 `agent_invocation` 是低频元数据（每次调用一条），一期单写入序列 + JSONL 链足以承接；存储二期的真实驱动是**部署形态与容量**（Redis/PG/对象存储），不是 P1 的数据量。将其设为前置会把 P1 绑死在一个需要外部环境的项目上。条件触发即可：达到 `>5k 事件/日` 或 `>100 万条`、或多副本/合规归档成为硬要求时启动二期。

### D3.5 不决策的后果与默认方案

不决策则 P1 可能被默认排到二期之后，或二期被无限期拖延。**默认按 B 执行**：P1 先走一期链，同时保留容量监控与触发阈值；二期不进入 P1 的关键路径。

---

## D4 U163 补齐车道去留

### D4.1 决策问题

宿主布局补齐车道按 (a) 彻底移除、(b) 仅非本地宿主启用、(c) 保留默认关闭开关，选哪一个。

### D4.2 现状事实

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 前提未验证（复诊） | **更正（2026-11-18）**：V8a-1/V8a-2 两轮真栈无效——未开 opt-in、无 headless 前置、`waitForTimeout(1500)` 非实测时延、未统计入站转发；分歧实际由宿主转发、桌面 renderer 应用 split。前提既未被证伪也未被证实 | `test-reports/u176-catchup-premise-recheck.md`；`defect-ledger.md` U176 |
| C1 闸门矛盾 | **部分更正**：非本地宿主有 `session.tabs.subscribe` 活动流应用完整快照，本地普通 worktree 反而没有；C1 只跑本地与缺口位置一致，原「矛盾」表述不准确 | 附录 D.3；复诊报告 |
| 当前处置 | **(c) 已落地**：钩子默认关闭，`localStorage['orca.debug.hostLayoutCatchup']==='1'` 才启用；关闭态无订阅/无 list 调用 | 提交 `c11e8b8b79e`；`src/renderer/src/app-shell/use-local-host-layout-catchup.ts` |
| 代码/测试保留 | V1–V7 全部保留（预 seed、组去重、焦点 pin 等已验证语义） | 附录 D.4；提交 `b4b34687de3`…`d5429c64eb3` |
| 设计记录 | 附录 D 已入库 | 提交 `c04be66113c` |

### D4.3 选项

| 选项 | 内容 | 成本 | 风险 | 影响面 |
| --- | --- | --- | --- | --- |
| A | 彻底移除车道 | S：删 V1–V7 模块/测试/文档 | 丢失已验证件；非本地缺口出现时需重建 | `local-structured-session-tabs-sync/`、`app-shell` 钩子、测试 |
| B | 仅非本地宿主启用 | M：先取得非本地缺口真实证据，再改 C1 与执行器 | 无证据即启用=把未验证路径放上生产；可能引入重复组/焦点回退 | 决策函数、执行器、wire/同步路径 |
| **C（建议）** | 保留默认关闭开关，设退出条件 | S：现状；仅维护成本 | 长期僵尸化；他人误以为功能生效 | 同上，关闭态零运行时成本 |

### D4.4 建议与理由

**选 C，并加退出条件。** 关闭态没有任何订阅或 `session.tabs.list` 成本，代码/测试是未来「非本地宿主」车道的现成件；A 会丢失已通过变异验证的语义，B 缺关键前提（非本地缺口存在性未证）。建议保留到下一个发布窗口，并以「出现 SSH/远端宿主下桌面布局不跟随的真实证据」为启用条件；若到期无证据，再按 A 清理，避免无限期僵尸化。

### D4.5 不决策的后果与默认方案

不决策则代码长期处于「已落地但无收益」状态，后续维护者可能误判为生效功能或重复实现。**默认按 C 执行**：维持默认关闭开关，不新增 wire 字段、不改 C1、不恢复 V8b；在台账保留 U176 直至退出条件触发。

---

## 附：不在本简报范围

| 项 | 处置 |
| --- | --- |
| U116② 创建向导目录选择器 | 用户已暂缓（manual-acceptance B2）；当前代码已具备心跳目录清单与选择/新建 UI，按现状不动 |
| U116④ `project:owner` 可达性 | 用户已暂缓（manual-acceptance B3）；不排期 |

---

## 22:00 增补：新产生的待裁定项（2026-11-17）

> 以下项均有设计/评审依据；未裁定前按「默认执行」保持现状，不影响已关闭的 U201/U205/U206/U209/U211。

| 编号 | 决策问题 | 建议 | 待决策前默认 | 依据 |
| --- | --- | --- | --- | --- |
| D5 | U197 令牌存储是否按 **方案 B**（refresh HttpOnly Cookie + access 内存）推进？ | 按 B；若本周期不能改服务端，A 仅作不关闭 QA-032 的临时缓解 | 不实施，QA-032 保持开启 | `u197-token-storage-design.md` v3 §5 |
| D6 | 响应形态判别（v3 已定死规则）与 body refresh 移除时点 | 采纳 v3：Cookie 源不返新 refresh；body 仅 current/previous 回显；移除按遥测+90 天期限 | v3 规则即默认，不再开放口径 | v3 §2B-2、迁移判据 |
| D7 | Cookie 属性/生命周期/降级（名称/Path/SameSite、会话 vs Max-Age、`auto` 边界） | `orca_refresh`、`Path=/v1/auth`、`SameSite=Lax`、Max-Age=refresh TTL；`auto` 仅 https/loopback 下发并告警 | 采用建议默认 | v3 Cookie 默认值表 |
| D8 | grace 默认值与审计 | 30s（上限 60s，`ORCA_CLOUD_REFRESH_GRACE_MS` 可配 0）；记录 `refresh.grace_reuse`/`refresh.reuse_detected` | 采用建议默认 | v3 grace 六条 |
| D9 | 迁移/回退/body 移除判据 | 按 v3 状态机四分支；新 Web+旧服务端回退 localStorage；body 字段移除按遥测+期限 | 按 v3 状态机实现 | v3 迁移判据 |
| D10 | 部署前置 + CSP + 关闭范围（CSP 草稿已备：`u197-csp-draft.md`，`script-src 'self'` 可行、style 需 inline、frame-src/img-src 已修正） | 单副本或粘性/共享 store；代理保证 Host/XFP；CSP 同批 Report-Only 起步；PII（`orca.user`）不在 QA-032 关闭条件 | 未满足前置不开启 Cookie 模式 | v3 §5-6/§2C |
| D11 | 工作台统计卡与 FR-2.5 不一致（U202）。**简报已备**：`test-reports/u202-stats-brief-20261118.md`（推荐修订 FR 对齐四卡；今日会话/待审批下载标二期；主机卡改去重或更名；QA-030 含搜索/通知部分需拆分） | 修订 FR 对齐现状（下载策略卡为补充；今日会话数需另立数据源） | 不改 UI | `requirements.md:158`；`u202-stats-brief-20261118.md` |
| D12 | 「最近使用」数据源（U196）。**简报已备**：`test-reports/u196-recent-use-brief-20261118.md`（推荐项目 `lastUsedAt`，仅成功打开/连接写；前端 `lastUsedAt ?? updatedAt ?? createdAt`；待拍板 D12-1..6） | 定义「打开/连接」为最近使用事件，后端加 `lastUsedAt`（不沿用 `updatedAt`） | 保持按创建时间排序 | U196；`u196-recent-use-brief-20261118.md` |
| D13 | 克隆失败 UX（U54-008） | 项目列表内联显示 `provisioningError`（不预校验，失败原因来自宿主） | 保持现状（仅详情可见） | WEB-R2-008 |
| D14 | host.* 拒绝逐请求 traceId（U210） | 需要逐请求关联时，主机为每条拒绝携带独立 traceId | 保持心跳批次 traceId | U210 |
| D15 | LGA 待裁定批（U212）：撤销边界、嵌套组、混合版本副本、目录不可达、filter/DN 契约、bootstrap、枚举、大小写。**简报已备** `u212-d15-brief-20261118.md`（D15-1..8 拍板点；U244 强制下线 API 已实现并复审通过，Web 按钮待本决策） | 先定撤销边界与嵌套组（阻断级）；其余按评审建议逐项 | 不改语义 | `test-reports/lga-design-review.md`、`u212-d15-brief-20261118.md` |

| D16 | Cookie 源「同值重发」需在内存保留 current refresh 明文（`Session.currentRefreshToken`），与「仅存哈希」原则冲突 | 先接受（仅内存、不落盘；进程内存泄漏即等同会话失守），或改为「Cookie 源也轮换」（需改 v5 不变式并重新评审） | 按 v5 同值重发；实现注明明文仅内存 | U215/v5 §2B-2 |
| D17 | U197 迁移分支「能力未知（无标记）」是否在加载发一次无 body 探测？覆盖 AC9b（有旧键）与 AC9c（无旧键、清 localStorage 后 Cookie 仍有效）；探测失败是否写 signed-out/legacy 标记避免每次加载重试 | 采纳设计字面（1 次无 body → 1 次 body 回退）；若确认旧服务端部署期成本不可接受，则修订 AC9b 为「标记缺失时按渐进路径，由下一次 401/登录响应迁移」 | 维持 S4 现状（无探测，渐进迁移），AC9b/AC9c 修订；或加 signed-out 标记后按设计探测 | 每次加载多 1 个失败请求（旧服务端/已登出用户），而渐进迁移最多延迟到 access 过期；清 localStorage 用户即使 Cookie 有效也停在登录页（U221 F1） | `u197-token-storage-design.md` AC9b；U219 |
| D18 | U233 F6：`refreshTokens`（明文 key）与 `sessions` 无界增长；`ORCA_PLATFORM_STORE_FILE` 开发快照会含明文 refresh | 增加 sweep：撤销/过期 session 及其 token 在宽限结束后删除；保持明文内存 map（U216 已接受），快照仍剥离 `currentRefreshToken` | 不处理，仅文档登记（长期运行内存增长） | 长跑进程内存与快照敏感面；修复不改变线上协议 | 台账 U233 F6 |
| D19 | U237：状态变更端点（maintenance/policy PUT、项目 PATCH）是否要求显式必填字段，拒绝空 body/`null` 的「默认语义」？ | 加必填校验（400），避免意外请求静默变更状态 | 维持现状（空 body 走默认值） | 变更会拒绝既有 `{}` 调用语义，需确认无客户端依赖 | U236 复审观察 |
| D20 | U243①「刷新过期→自动登出」是否新增 `session.expired` 审计事件（方案 A）；事件名/result/actor/是否带 expiredAt | A：新增 `session.expired`（`result=success`、`actor=username`、`targetType=session`、metadata{reason:EXPIRED,source,expiredAt}、best-effort、由 `revokeSessionOnce` 首个撤销者写 1 条） | 不新增（链上该序列无撤销事件） | 新事件进下拉/筛选；旧客户端加性兼容（勿加 eventFamily） | `test-reports/u243-session-expiry-event-brief.md` |

## 附：D17/D10 一页决策简报（2026-11-18，U197 实施收口）

**当前状态**：U197 S1/S2/S4/S5 全部落地并双轨验收；AC 🟢16 / 🟡1（AC7 双标签登出）/ 🔴3（AC9b、AC9c、AC15(g)）/ ⚪1（AC10）。cookieMode 默认关闭，未启用。

### D17（阻断 AC9b/AC9c/AC15(g)）
- 问题：无 `orca.authMode` 标记时，客户端无法判断服务端是否支持 Cookie，当前按旧模式渐进迁移（access 过期后一次 body 刷新才置标记）。
- 选项 A（设计字面）：加载时先发一次无 body Cookie 探测，失败再发一次 body 回退；建议失败后写 `legacy`/signed-out 标记，避免旧服务端期每次加载重试。
  - 代价：旧服务端/已登出用户每次加载多 1 个失败请求（可被标记收敛）；收益：AC9b/AC9c/AC15(g) 全部达标，清 localStorage 用户凭有效 Cookie 单次恢复。
- 选项 B（修订设计）：维持渐进迁移，只修 AC9b/AC9c/AC15(g) 文本为「下一次 401/登录响应迁移」。
  - 代价：设计修订 + 复审；收益：无额外请求，旧部署零影响。
- 建议：A（带 legacy 标记）。若选 B，需同步修订 AC9b/AC9c/AC15(g) 并重新评审。

### D10（AC10 与部署）
- 草稿已 APPROVED（`u197-csp-draft.md`）：Report-Only 仅 HTML 文档、console 观测；`script-src 'self'`（先重构 `app.js:1942` 3 行）、`style-src-attr 'unsafe-inline'`、`frame-src 'self' https:`、`img-src 'self' data:`、不引入 UIR；阶段 1 无需上报端点。
- 待裁：CSP 是否先于 cookieMode 启用（草稿建议「先 CSP RO，观察 7 天/2 发布后升强制」；D10 原文为「同批」）；O4 是否新增上报端点；O5/O7 宿主面是否同批（须独立策略评估，禁止照抄）。
- 建议：接受草稿排序与指令集；O4 暂不做，O5/O7 单独立项。

## 附二：统一裁定清单（2026-11-18 04:3x）

| 编号 | 事项 | 建议 | 影响 |
|---|---|---|---|
| **D17** | 未知能力（无 `orca.authMode`）加载是否先发无 body 探测 | **A**：探测一次 + 失败写 legacy 标记（不再重试） | AC9b/AC9c/AC15(g) 转绿；旧服务端每次加载多 1 个失败请求（仅首次，标记后收敛） |
| **D10** | CSP 是否按草稿先行 Report-Only | 接受草稿（仅 HTML、console、`frame-src 'self' https:`、`img-src data:`、先重构 onclick、无 UIR）；O4 暂不做、O5/O7 单独立项 | AC10；与 cookieMode 启用顺序解耦 |
| **D15** | LGA 撤销边界/嵌套组等 8 项 | Phase 0 文档/可观测收口；**Phase 1 撤销边界最小组合**（组替换 + 绝对会话寿命 + 管理员强制下线，后者 U244 已实现 API）；嵌套组/refresh 复查挂 G04 | 见 `u212-d15-brief-20261118.md` D15-1..8 |
| **D18** | token GC / 开发快照明文 | 增加 sweep：撤销/过期 session 及 token 在宽限后删除；快照仍剥离当前明文 | 长跑内存；无协议变化 |
| **D19** | 状态变更端点必填字段 | 对 8 个「空 body 即变更」端点要求显式字段（400） | 拒绝既有 `{}` 调用语义；fuzz 清单见 U237 |
| **U176** | U163 布局补齐车道 | 保留默认关闭；接受主进程路由+V7 E1 为验证终点（不必再投入真栈复验） | 关闭 U176；D4 去留留待需求出现 |
| **U244** | 管理员强制下线 | API 已实现并复审 APPROVED（`d0b4f064797`→`a62d3944156`，9/9）；Web 按钮是否同批 | FR-1.6 P0 能力；UI 影响 D15 |

关闭执行清单：`test-reports/u197-closure-checklist-20261118.md`（D17/D10/D18/D19/D20 → 实施 → 双轨验收映射）。

复核/关闭顺序建议：先 D17+D10（解锁 QA-032 关闭），再 D15 Phase 0/1，D18/D19 随批；U176 可直接按建议关闭。

---

## 附三：D21 U66 二期第二口径（方案 §6.2 全量）一页决策包（2026-11-18）

**分歧一句话**：焦点口径（宿主硬拦 + 三件平台项）已在 `f01bc88272e` 100% 交付、终复验 10/10 PASS；`u66-audit-tech-design.md` §6.2（P1 全量）另有五项未落地，两口径不可互相代表。

### D21.1 未落地项（原始编号 → 代价 → 影响）

| 项 | 方案编号（原始） | 现在做代价（切片） | 不做的影响 |
| --- | --- | --- | --- |
| 专用 `files.download` RPC（流式 + 边算 sha256 + host-attested） | C9：`u66-audit-tech-design.md:328`；§6.2 `:525`；§9 P1 `:624` | 4 段 | 审计完整性：专用下载无独立 host-attested 事件，`readChunk` 重建缺口仍按声明存在；合规：FR-9.12 字面未达成；UX 无损（仍走 `readChunk`） |
| 读字节推断（read-inference，`inferred`） | C10：`:329`；§6.2 `:526`；§9 P2 `:625` | 2–3 段 | 审计完整性：低于重建阈值的静默批量读不被记；与 U70 硬拦语义冲突，须先设计裁定 |
| DOM 选区复制捕获 | C6：`:325`；§6.2 `:527`；§9 P3 `:626` | 3–4 段 | 审计完整性：Monaco/预览选区 Ctrl+C 不可见（仅显式复制按钮覆盖）；UX 无损 |
| 摘录开关 + 检索 | P4：`:627`；§6.2 `:528`；AC-54/55 `:550` | 4 段 | 合规：仅有元数据、无 1KB 摘录，外泄内容不可证；须 O-12 合规书面确认才可开 |
| 存储二期（SQLite/FTS5） | P5：`:628`；§6.2 `:529`；§4.4 `:456` | 评估 + 条件实施（L） | 审计可用性/合规归档：仅当 >5k 事件/日或 >100 万条触发；当前未触线（同 D3-B） |

### D21.2 三选项与推荐

- **A 全做**（C9+C10+C6+P4+P5）：能力最全；代价 ~17–19 段 + 存储立项，且 C10 与 U70 冲突、P4 需合规签字。**不推荐**。
- **B 只做审计完整性项（推荐）**：**C9 + C6**（共 ~7–8 段）。补齐专用下载 host-attested 与选区复制两条最高价值覆盖缺口；C10 因与 U70 硬拦语义冲突、P4 需合规签字、P5 未触线，均移出。
- **C 维持现状、文档标注二期外**：零成本；在方案 §6.2 五项标「二期外/条件触发」，缺口保持如实声明；C9 的 FR-9.12 字面缺口长期保留。

**逐项推荐**：C9 做（归 B）；C6 做（归 B）；C10 缓（先与 U70 对齐）；P4 缓（待 O-12 合规确认）；P5 缓（容量触发，同 D3-B）。

**状态：待用户裁定，未开工。**
