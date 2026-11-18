# 待裁定决策索引（一页版，2026-11-18）

> 汇总 `work-orders/pending-decisions-2026-11-17.md`（含附三 D21、附四、附五 D25）、`cloud-platform/test-reports/open-rows-triage-20261118.md` 的 D 表及台账「待裁定」行。路径简写：`wo/` = 本目录 `work-orders/`，`tr/` = `cloud-platform/test-reports/`，`ledger` = 本目录 `defect-ledger.md`。
> 口径：未裁定前均按各文档「默认执行」保持现状；下表「阻塞」列为不裁定即无法关闭/无法开工的行。

| 决策编号 | 一句话问题 | 影响的台账行 | 阻塞了什么 | 推荐选项 | 详情文档路径 |
| --- | --- | --- | --- | --- | --- |
| **D5–D10** | `cookieMode`（refresh HttpOnly Cookie + access 内存）是否启用、启用范围与部署前置（CSP 顺序、副本/粘性 store、Host/XFP） | U214（主）、U199、U203（QA-032 引用） | QA-032/U214 收口与 cookieMode 上线；实现与双轨验收已 100% 完成，默认关闭 | 按方案 B：先 CSP Report-Only（草稿已 APPROVED），满足部署前置后再开 Cookie；未满足即维持关闭 | `wo/u197-token-storage-design.md` v3、`wo/u197-csp-draft.md`、`tr/u197-closure-verdict-20261118.md` |
| **D11** | 工作台统计卡与 FR-2.5 不一致：改需求还是改 UI | U202（⚪ 状态漂移）、U203（QA-030b） | U202/U203 定案与状态回写；需求修订 | 修订 FR 对齐现有四卡；今日会话数另立数据源、与待审批下载同标二期；主机卡去重或更名 | `tr/u202-stats-brief-20261118.md`、`requirements.md:158` |
| **D15** | LGA 撤销边界、嵌套组、目录不可达 503、bootstrap/枚举/大小写等 8 项 | U212（主）、U244（Web 按钮）、U245（部分） | U212 语义改动；U244 管理员强制下线 Web 按钮 | Phase 1 最小组合：登录时组替换 + 会话绝对寿命 + 管理端强制下线（API 已实现）；嵌套组/refresh 复查挂 G04。**Phase 0 文档/可观测已完成**（`721a4c2caca`，零语义） | `tr/u212-d15-brief-20261118.md`、`tr/lga-design-review.md`、`ledger` U212 |
| **D18** | token/会话无删除路径、开发快照含明文；是否加 GC sweep | U233（F6） | U233 关闭；长跑进程内存与快照敏感面 | 惰性 + 60s unref sweep：撤销/过期 session 及其 token 在宽限后删除；快照仍剥离 `currentRefreshToken` | `tr/u233-d18-token-gc-brief-20261118.md` |
| **D20** | 「刷新过期→自动登出」是否新增 `session.expired` 审计事件 | U243①、U230①（事件词汇批） | U243、U230 关闭；过期路径目前零审计 | A：由 `revokeSessionOnce` 首个撤销者写 1 条，`result=success`，metadata `{reason:EXPIRED,source,expiredAt}`，best-effort | `tr/u243-session-expiry-event-brief.md`、`tr/u197-closure-checklist-20261118.md` |
| **D21** | U66 二期「方案 §6.2 全量」这一第二口径是否做（焦点口径已交付） | U66（两行）、U70 | U66 结案口径与 FR-9.12 字面缺口声明 | B：只做 C9（专用 `files.download`，host-attested）+ C6（选区复制），约 7–8 段；C10 缓（与 U70 硬拦冲突）、P4 待合规签字、P5 触线再做 | `wo/pending-decisions-2026-11-17.md` 附三、`wo/u66-audit-tech-design.md` §6.2 |
| **D22**（附四原文记作 D13） | 克隆失败（U54-008）如何呈现给用户 | U54（WEB-R2-008） | U54 关闭；非管理员当前只看到通用「项目准备失败」 | B：列表行/卡内联 `provisioningError` + 失败覆盖层读取 + 管理员重试；不做前置探测（会被瞬断误判并拖慢创建） | `wo/pending-decisions-2026-11-17.md` 附四、`ledger` U54 |
| **D23** | 管理员能否自撤、能否撤同级 admin；同级保护 | U245③ | U245 关闭；当前无自撤/同级保护 | 显式裁定：自撤允许或 403；撤同级至少留痕（审计） | `tr/open-rows-triage-20261118.md` §2.1、`tr/u244-u246-review-report-20261118.md`、`current-state/m06-users.md` |
| **D24** | 「防枚举 404 不留痕」政策是否保留 | U247①③ | U247 关闭（矩阵本体已 113/113 通过） | 保留 404 不留痕，并将观察①③作为已接受边界写入现状文档；若改为留痕，须为 archive/restore 拒绝补 denial 审计 | `tr/open-rows-triage-20261118.md` §2.1、`current-state/m07-audit.md:127` |
| **D25** | U181 H11–H13 验收产物从哪来 | U181（🟡） | U181 打包容器验收（S4）；PR 产物缺 `resources/orcad-template` | B：新增 `workflow_dispatch` job，复用 `build_template:true` 并设 `ORCA_REQUIRE_ORCAD_TEMPLATE=1`，产物绑定验收 SHA | `wo/u181-h11-ci-artifact-plan.md`、`tr/u181-h11-h13-runbook-20261118.md` |
| **U116②** | 创建向导是否加目录选择器 | U116 | 无（用户已暂缓） | 维持现状：心跳目录清单 + 选择/新建 UI 已具备，自由文本保留不删 | `wo/manual-acceptance-matrix.md` B2、`wo/pending-decisions-2026-11-17.md` 附 |
| **U116④** | `project:owner` 角色是否落地 | U116 | 无（用户已暂缓） | 维持暂缓，待产品语义确认；不排期 | `wo/manual-acceptance-matrix.md` B3 |

> **编号冲突说明**：①`U245③` 即 **D23** 同项（triage 建议新立 D23），已合并，不另列。②附四原文把克隆失败记为 **D13**，而 triage 把 **D22** 预留给 U230（`session.revoked`）；本索引按任务口径取 D22=克隆失败，U230 事件归入 D20 事件词汇批。③`U116②/④` 非阻塞，仅为一次性确认。
> 未列入本页、已有默认且可维持现状的项：D12（最近使用，`tr/u196-recent-use-brief-20261118.md`）、D14（逐请求 traceId）、D16（内存明文 refresh）、D19（必填字段 400）、D4/U176（已按默认关闭收口）。

## 建议裁决顺序（按解锁行数）

1. **D5–D10** — 解锁 3 行（U214/U199/U203）并决定 cookieMode 是否上线；若想拆小，先裁 D10+D5 两项即可放行 CSP 与启用范围。
2. **D15** — 解锁 U212/U244 共 2–3 行；Phase 0 已完成，剩余只是 Phase 1 语义拍板，单次裁决收益最高。
3. **D20 + D18 同批** — 一次裁决解锁 U243/U230/U233 共 3 行，且 sweep 必须复用 D20 的撤销事件，分开裁会返工。
4. **D11** — 纯文档/需求修订，解锁 U202/U203 的定案，无代码风险。
5. **D24 + D23** — 各一句话政策，解锁 U247/U245 两行。
6. **D22** — 用户可见的克隆失败提示，解锁 U54。
7. **D25** — 选 B 即可派 S4 打包验收，解锁 U181 最后一步。
8. **D21** — 不阻塞任何代码；即使暂不裁，也可先选 C（文档标注「二期外/条件触发」），零成本且缺口如实声明。
9. **U116②④** — 维持暂缓，不算风险（现有能力已覆盖，仅缺产品确认）。

**可维持现状不算风险**：U116②④、D21-C、D12/D14/D16/D19 默认值、D4/U176（已关闭）。其余各项维持现状会留下状态漂移或安全/审计缺口，建议按上述顺序裁决。
