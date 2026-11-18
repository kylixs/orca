# 业务地图复盘 · 未完成功能与阻塞清单（2026-11-18）

- 文档性质：**周期性复盘文档**（后续每次复盘在本文件追加「复盘记录」，不新建同名文件）
- 配套地图：[`../business-map.md`](../business-map.md)（编号、状态、测试计数以该文件为准）
- 数据来源：`defect-ledger.md`、`test-plan.md`、`work-orders/pending-decisions-2026-11-17.md`、`work-orders/decision-index-20261118.md`、`work-orders/decisions-log-20261118.md`、当日 test-reports
- 推进顺序与开发/测试规则见 [`../business-map.md`](../business-map.md) §5（任务必须挂地图编号；测试按叶子登记；决策项不施工）
- 使用方式：人工复核时按 §2「未完成功能清单」逐项确认 → 在 §4「复核动作」勾选 → 决策后回到台账更新 U 行 → 下次复盘填写 §5

---

## 1. 当前总览

| 指标 | 数值 | 口径 |
|---|---|---|
| 业务地图叶子项 | 70 | `business-map.md` 表行实测 |
| 🟢 已交付 | 62 | 有回归 + 台账 🟢 |
| 🟡 进行中 / 部分 | 3 | LDAP 准入组替换、Cookie 模式启用、超时门禁收尾（决策均已定，剩实施/文档） |
| ⚪ 待决策 / 待开工 | 5 | 决策均已定，剩实施（AUTH-TOKEN-GC / AUTH-SESSION-EXPIRE / AZ-LDAP-GROUP / PRJ-PROVISION-ERR / FILE-DL-RPC） |
| 综合完成度 | **90.7%** | (62 + 0.5×3) / 70，与 `business-map.md` §4 一致 |
| 台账未关闭行 | **17** | 其中 🟡 6、⚪ 11（2026-11-18 实施波后重算：U317 关闭；U316 新增，U212/U315/U318/U319 关闭） |
| 当前门禁 | 全仓 e2e **1143/1143**；认证 **267/267**；矩阵 **113/113**；超时门禁 2→0（`load-300` 收尾中） | `test-plan.md` §7 |

---

## 2. 未完成功能清单（按业务地图状态）

### 2.1 🟡 进行中 / 部分交付（3 项）

| 编号 | 功能 | 优先级 | 进度 | 阻塞类型 | 阻塞编号 | 需要谁做什么 | 相关文档 |
|---|---|---|---|---|---|---|
| AUTH-LDAP-ADMIT | LDAP 组门槛准入 | P1 | 80% | 实施 | **D15-1** | 落地登录时 `user.groups` 按本次 profile 全量替换（1 行 + `ldap-admission` 断言） | `work-orders/ldap-group-admission-design.md` §10、`test-reports/u212-d15-brief-20261118.md` |
| AUTH-COOKIE-MODE | Cookie 模式启用范围 | P0 | 95% | 实施/文档 | **D5–D10** | 写部署检查单（TLS、`ORCA_CLOUD_PUBLIC_ORIGIN`、粘性 store、宿主跨源不依赖 Cookie）；默认关闭可继续 | `test-reports/u197-ac-coverage.md`、`u197-closure-verdict-20261118.md`、`work-orders/u197-token-storage-design.md` §6 |
| QA-TIMEOUT-GATE | 超时形态门禁与存量迁移 | P1（门禁） | 99% | 施工收尾 | **U315**（U291 已关） | `load-300` 完整规模实跑（300×1800s）完成后提交代码/基线/台账，基线归零 | `test-reports/timeouts-burndown-plan-20261118.md`、`test-plan.md` §7.3 |

### 2.2 ⚪ 待决策 / 待开工（5 项，决策已定，剩余实施/文档）

| 编号 | 功能 | 优先级 | 决策状态 | 决策结论 | 剩余工作 | 相关文档 |
|---|---|---|---|---|---|
| AUTH-TOKEN-GC | 令牌回收与快照明文剥离 | P0 | 已定 D18 | 惰性 + 60s sweep（`ORCA_CLOUD_SESSION_SWEEP_MS` 可关）+ 快照剥离 `accessTokens`/`webHandoffs`；不做 FIFO/新端点/持久化 | 实施 | `test-reports/u233-d18-token-gc-brief-20261118.md` |
| AUTH-SESSION-EXPIRE | 过期自动登出与 `session.expired` 审计事件 | P0 | 已定 D20 | 只新增 `session.expired` 与 `session.revoked`；不改 401/清 Cookie | 实施 | `u243-session-expiry-event-brief.md` |
| AZ-LDAP-GROUP | LDAP 组授权（LGA-1~6） | P1 | 已定 LGA-6 | 不新增功能；组=系统准入 + 组作为授权主体均已闭环，无角色映射/嵌套组 | 文档/地图/台账收口 | `work-orders/ldap-group-admission-design.md` §10、`u212-*` |
| PRJ-PROVISION-ERR | 克隆失败原因呈现 | P0 | 已定 D22 | 前端内联 `provisioningError`，零 API、零新探测 | 前端 3 处实施 | `work-orders/decisions-log-20261118.md` §3 |
| FILE-DL-RPC | 专用 `files.download` 流式 RPC | P0（分期） | 已定 D21（C9 缓） | 现有 readChunk 审计 + 宿主硬拦已覆盖，字面缺口如实登记；不新增 RPC | 登记（不施工） | `work-orders/decisions-log-20261118.md` §3 |

> 说明：以上 5 项决策均已定（D18 / D20 / D15-LGA-6 / D22 / D21-C9），不再等待人工裁定；剩余仅为实施与文档收口。

---

## 3. 台账未关闭行（13 行 = 🟡8 + ⚪5，按处理方式分组）

> 口径：以 2026-11-18 决策收口后的 `defect-ledger.md` 实际状态重算（原 28 行已过时）。所有待决策项均已自动决策并经主会话减法评审；剩余行为实施在途或残余观望。

### 3.1 实施 / 测试在途（8 行 🟡）

| 行 | 内容摘要 | 决策 / 剩余工作 |
|---|---|---|
| U181 | FR-4.11 打包容器验收（H11–H13） | D25 已定；工作流 job 待实施 |
| U212 | LGA 评审待裁定批 | D15 已定；D15-1 组替换待实施 |
| U214 | U197 令牌存储实施（QA-032） | D5–D10 已定；部署检查单待写 |
| U230 | 禁用撤销事件语义（`session.revoked`） | D20 已定，待实施 |
| U233 | 认证端点冷读审计（F4/F6） | D18 已定，待实施 |
| U243 | `session.expired` 事件 | D20 已定，待实施 |
| U245 | 管理员自撤 / 撤同级 admin 策略 | D23 已定，待测试固化 |
| U247 | 授权矩阵复验剩余观察 | D24 已裁定，观察登记 |

### 3.2 残余 / 观望（5 行 ⚪）

| 行 | 摘要 | 处置 |
|---|---|---|
| U54 | 探索 A 批余项 | 余项已对账，无排期 P3 |
| U58 | 探索 D 批余项 | 同上 |
| U116 | M3 缺口（目录选择器、`project:owner`） | ②④ 已裁定不立项（U116 裁定） |
| U315 | 门禁词法残余（注释漏报、过匹配、行数上限） | 待扫描器释放后派修 |
| U316 | QA-030 搜索/筛选/通知残留 | D11 另立，待排期 |

> 说明：U54/U58 的「余」列表已按 §2-138 对账（H24c/G11/P45 已修、U12 转口径、W5/U13 已修、H44/G8b 已修于 U272/U273），当前仅剩少量 P3 无排期项；U203 已随 D11 收口，其 QA-030 搜索/筛选/通知残留转入 U316。

---

## 4. 人工复核动作清单（已自动决策，复核仅确认结论）

> 全部待决策项已于 2026-11-18 由独立子代理决策并经主会话减法评审定稿（`work-orders/decisions-log-20261118.md`）。以下清单不再需要人工选择方案，只需确认结论无误；勾选表示「结论已复核」。

- [ ] **D5–D10**：Cookie 模式仅同源启用、默认关闭、CSP 维持 Report-Only；四项前置待写部署检查单
- [ ] **D11**：FR-2.5 已修订为四卡，「今日会话」「待审批下载」属二期
- [ ] **D12**：不新增 `lastUsedAt`，一期不做（U196 关闭）
- [ ] **D15-1..8**：登录组全量替换待实施；D15-2/4/5/7/8 不做；D15-3 条件项
- [ ] **D16**：接受内存明文 refresh 权衡（U216 关闭）
- [ ] **D18**：惰性 + 60s sweep + 快照剥离，待实施
- [ ] **D20**：仅 `session.expired` / `session.revoked`，待实施
- [ ] **D21**：C6 已落地；C9 缓登记；C10 不做
- [ ] **D22**：克隆失败前端内联，待实施
- [ ] **D23**：允许自撤/撤同级 admin，无层级，审计留痕即可
- [ ] **D24**：保留操作级 404 静默，不新增审计通道
- [ ] **D25**：`workflow_dispatch` 构建 job 待实施
- [ ] **U100 / U116 / U208 / U210 / U278**：文档收口已落，确认结论

---

## 5. 复盘记录（后续在此追加）

| 日期 | 触发 | 变化摘要 | 新增决策 | 遗留 |
|---|---|---|---|---|
| 2026-11-18 | 首次生成 | 业务地图建立（70 叶子 / 🟢58 / 🟡5 / ⚪7）；当日关闭 U272–U313 中 40 项；U310 P1（双击导航重放循环）修复 | — | 12 项功能未完成；28 行台账未关闭 |
| 2026-11-18 | U317 关闭 | 地图 **69/1/0（98.6%）**：`QA-TIMEOUT-GATE` 🟡→🟢（7 形检出、三套件 84=83+1、两模式 0 new）；QA 域 100%；台账未关闭 18→17 | — | FILE-DL-RPC（D21 缓）、FR 外增强 U316/U54/U56/U58/U74 |
| 2026-11-18 | 决策实施与门禁 | 地图 **68/1/1（97.9%）**：AUTH 域 13 叶子全 🟢（D15-1/D18/D20/D5–D10）、COOKIE/LDAP 准入收口；第七轮全景 **1149/1149** 通过；期间登记并关闭 U318（D15-1 夹具）、U319（D22 后 pin）；U315 范围关、U317 待修 | — | QA-TIMEOUT-GATE 待 U317；FILE-DL-RPC 缓登记 |
| 2026-11-18 | 全量自动决策（用户指令） | 地图 70 叶子 / 🟢62 / 🟡3 / ⚪5（90.7%）；台账未关闭 28→13（🟡8、⚪5）；U196/U202/U208/U210/U216/U278/U100 关闭，U203 收口并另立 U316 | 三组：AUTH（D5–D10/D12/D16/D18/D20/D23）、AZ（D15-1..8/D24/LGA-6）、PRODUCT（D11/D21/D22/D25/U278/U100/U116/U196/U208/U210） | D15-1、D18、D20、D22 待实施；D5–D10 部署检查单待写；D25 工作流待实施；LGA-6 文档收口；U315/U316 残余 |

---

## 6. 相关文档索引

| 类别 | 路径 |
|---|---|
| 需求与设计 | `../requirements.md`、`../design.md`、`../design-adjustment-native-ui.md` |
| 业务地图（本复盘的上游） | `../business-map.md` |
| 缺陷台账 | `../defect-ledger.md` |
| 测试计划（§6 计数、§7.1 认证清单、§7.2 全景、§7.3 超时门禁） | `../test-plan.md` |
| 决策索引与决策包 | `../work-orders/decision-index-20261118.md`、`../work-orders/decisions-log-20261118.md`、`../work-orders/pending-decisions-2026-11-17.md`（附三 D21、附四 D22、附五 D25） |
| 子会话协议（报告/证据/复盘纪律） | `../parent-child-session-protocol.md`、`../../DEVELOPMENT_PROCESS.md` |
| 现状文档 | `../current-state/m01-auth.md`、`m02-workbench-nav.md`、`m03-projects.md`、`m04-hosts.md`、`m06-users.md`、`m07-audit.md`、`m11-authz-model.md` |
| 关键测试报告（gitignored，随工作树） | `cloud-platform/test-reports/full-e2e-sweep-final3-20261118.md`、`auth-baseline-6-20261118.md`、`u197-closure-verdict-20261118.md`、`timeouts-burndown-plan-20261118.md`、`open-rows-triage-20261118.md`、`review-728c5d5-20261118.md`（U310 复现对照） |
| 证据目录 | `cloud-platform/evidence/`（gitignored）、`/tmp/e2e-sweep-final3/`（当次扫描日志） |
