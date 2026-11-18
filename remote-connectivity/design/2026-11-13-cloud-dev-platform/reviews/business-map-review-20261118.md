# 业务地图复盘 · 未完成功能与阻塞清单（2026-11-18）

- 文档性质：**周期性复盘文档**（后续每次复盘在本文件追加「复盘记录」，不新建同名文件）
- 配套地图：[`../business-map.md`](../business-map.md)（编号、状态、测试计数以该文件为准）
- 数据来源：`defect-ledger.md`、`test-plan.md`、`work-orders/pending-decisions-2026-11-17.md`、`work-orders/decision-index-20261118.md`、当日 test-reports
- 使用方式：人工复核时按 §2「未完成功能清单」逐项确认 → 在 §4「复核动作」勾选 → 决策后回到台账更新 U 行 → 下次复盘填写 §5

---

## 1. 当前总览

| 指标 | 数值 | 口径 |
|---|---|---|
| 业务地图叶子项 | 70 | `business-map.md` 表行实测 |
| 🟢 已交付 | 58 | 有回归 + 台账 🟢 |
| 🟡 进行中 / 部分 | 5 | 1 项施工收尾 + 2 项等启用裁定 + 1 项等语义裁定 + 1 项等评审 |
| ⚪ 待决策 / 待开工 | 7 | 全部挂决策编号 |
| 台账未关闭行 | 27 | 其中 🟡 10、⚪ 17（多数为早期探索批次或证据类） |
| 当前门禁 | 全仓 e2e **1143/1143**；认证 **267/267**；矩阵 **113/113**；超时门禁 2→0（`load-300` 收尾中） | `test-plan.md` §7 |

---

## 2. 未完成功能清单（按业务地图状态）

### 2.1 🟡 进行中 / 部分交付（5 项）

| 编号 | 功能 | 进度 | 阻塞类型 | 阻塞编号 | 需要谁做什么 | 相关文档 |
|---|---|---|---|---|---|---|
| AUTH-LDAP-ADMIT | LDAP 组门槛准入 | 80% | 语义裁定 | **D15**（D15-1..8） | 裁定撤销边界/嵌套组/503 语义；Phase 0 文档已交付 | `work-orders/ldap-group-admission-design.md`、`test-reports/u212-d15-brief-20261118.md` |
| AUTH-COOKIE-MODE | Cookie 模式启用范围 | 95% | 启用决策 | **D5–D10** | 确认生产启用范围与部署前置（CSP 顺序、粘性 store、Host/XFP）；默认关闭可继续 | `test-reports/u197-ac-coverage.md`、`u197-closure-verdict-20261118.md`、`work-orders/pending-decisions-2026-11-17.md` |
| AUTH-CSP | 认证页 CSP enforcement | 70% | 启用决策 | **D10**（stage 2） | 决定 report-uri 上报地址、enforcement 时间与宿主侧 CSP | `test-reports/u224-*`、`current-state/m01-auth.md` |
| AZ-ENUM-GUARD | 无权限项目防探测 | 90% | 政策裁定 | **D24** | 确认「防枚举 404 不留痕」是否保留；若不保留需补 denial 审计 | `current-state/m07-audit.md`、`test-reports/open-rows-triage-20261118.md` |
| QA-TIMEOUT-GATE | 超时形态门禁与存量迁移 | 99% | 施工收尾 | **U291** | `load-300` 完整规模实跑（300×1800s）完成后提交代码/基线/台账，基线归零 | `test-reports/timeouts-burndown-plan-20261118.md`、`test-plan.md` §7.3 |

### 2.2 ⚪ 待决策 / 待开工（7 项）

| 编号 | 功能 | 阻塞类型 | 阻塞编号 | 决策要点（推荐见括号） | 相关文档 |
|---|---|---|---|---|---|
| AUTH-TOKEN-GC | 令牌回收与快照明文剥离 | 决策 | **D18** | 惰性 + 60s sweep + retention；快照剥离 `accessTokens`/`webHandoffs` 明文（推荐方案 A） | `test-reports/u233-d18-token-gc-brief-20261118.md` |
| AUTH-SESSION-EXPIRE | 过期自动登出与 `session.expired` 审计事件 | 决策 | **D20** | 首个撤销者写 1 条 best-effort 事件（推荐 A）；与 U230 事件词汇批同批 | `u243-session-expiry-event-brief.md` |
| AZ-LDAP-GROUP | LDAP 组授权（LGA-1~6） | 评审 | 用户评审 | 组→系统准入与组授权设计已产出，待评审后派工 | `work-orders/ldap-open-source-survey.md`、`u212-*` |
| PRJ-PROVISION-ERR | 克隆失败原因呈现 | 决策 | **D22** | 内联 `provisioningError` + 覆盖层 + 管理员重试（推荐 B，零 wire 变更） | `work-orders/pending-decisions-2026-11-17.md` 附四 |
| FILE-DL-RPC | 专用 `files.download` 流式 RPC | 决策 | **D21（C9）** | 只做 C9+C6（推荐 B），补齐 host-attested 下载审计 | 同附三 |
| FILE-COPY-CAPTURE | DOM 选区复制捕获 | 决策 | **D21（C6）** | 同 D21-B | 同附三 |
| MOB-DETAIL | 移动端主机详情 sheet | 决策 | **U278** | 补 sheet（信息/权限双段三卡）或裁定「移动端二期」 | `current-state/m03-projects.md`、`ui/prototype-mobile-notes.md` |

---

## 3. 台账未关闭行（27 行，按处理方式分组）

### 3.1 需用户决策（10 行）

| 行 | 内容摘要 | 决策编号 |
|---|---|---|
| U181 | FR-4.11 打包容器验收（H11–H13） | **D25**（产物来源：推荐 `workflow_dispatch` + `build_template:true`） |
| U203 | M116 探索批登记缺口 | QA-030 与 U202 编号碰撞，随 U202/D11 |
| U212 | LGA 评审待裁定批 | D15 |
| U214 | U197 令牌存储实施（QA-032） | D5–D10 |
| U230 | 禁用撤销事件语义（`session.revoked`） | D20 事件词汇批 |
| U233 | 认证端点冷读审计（F4/F6） | D18 + 事件词汇批 |
| U243 | `session.expired` 事件 | D20 |
| U245 | 管理员自撤 / 撤同级 admin 策略 | D23 |
| U247 | 授权矩阵复验剩余观察 | D24 |
| U202 | 工作台统计卡 vs FR-2.5 | D11 |

### 3.2 施工 / 评审在途（3 行）

| 行 | 内容 | 状态 |
|---|---|---|
| U291 | 超时迁移 `load-300` 收尾 | 🟡 完整规模跑中 |
| U313 | 门禁词法残余（注释漏报、过匹配、行数上限） | ⚪ 待扫描器释放后派修 |
| U278 | 移动端主机详情 | ⚪ 见 §2.2 |

### 3.3 早期探索批次 / 证据类（14 行，未阻塞当前交付）

| 行 | 摘要 | 建议 |
|---|---|---|
| U11 / U12 | 模型额度中断、授权码外发风险 | 历史观察，建议逐条确认是否仍适用，不适用即关闭 |
| U27 / U32 | 变异证据不可复现、nativeChat transcriptPath | 证据/隐私类，按需单独立项 |
| U54 / U56 / U58 | 探索 A/C/D 打磨批余项 | 余项清单已对账（见 §3.3 说明），建议关账或转新编号 |
| U74 / U76 / U100 | r3 打磨、构建保真、editor tab 恢复面 | U100 需裁定范围（editor tab 是否一期） |
| U116 | M3 缺口（目录选择器、`project:owner`） | ②④ 已按用户决策暂缓 |
| U196 | 「最近使用」缺数据源 | 产品增强，可并入 FR 修订批 |
| U208 / U210 | 导出链接轮换、traceId 粒度 | 已知约束/可观测性，建议标注为设计约束后关闭 |
| U216 | Cookie 同值重发需内存明文 | 安全权衡，随 D5–D10 一并裁定 |

> 说明：U54/U56/U58 的「余」列表已按 §2-138 对账（H24c/G11/P45 已修、U12 转口径、W5/U13 已修、H44/G8b 已修于 U272/U273），当前仅剩少量 P3 无排期项。

---

## 4. 人工复核动作清单（可直接勾选）

- [ ] **D5–D10**：确认 `cookieMode` 生产启用范围与部署前置（默认关闭是否满足一期验收）
- [ ] **D15**：确认 LDAP 组准入门槛的撤销边界与 503/不可达语义
- [ ] **D18**：确认令牌 GC 与快照明文剥离方案（推荐惰性 + sweep）
- [ ] **D20**：确认 `session.expired` / `session.revoked` 事件词汇批
- [ ] **D21**：确认 U66 第二口径范围（推荐只做 C9 专用下载 RPC + C6 选区复制）
- [ ] **D22**：确认克隆失败内联呈现（推荐 B）
- [ ] **D23**：确认管理员自撤 / 同级保护策略
- [ ] **D24**：确认「防枚举 404 不留痕」政策
- [ ] **D25**：确认 U181 验收产物来源（推荐新增 `workflow_dispatch` 构建 job）
- [ ] **D11**：确认工作台统计卡与 FR-2.5 的对齐方式
- [ ] **U278**：确认移动端主机详情是否本期补齐
- [ ] **U100**：确认 editor/文件 tab 的云端恢复是否一期范围
- [ ] 关账 §3.3 中已不适用或已解决的早期观察（U11/U12/U208/U210 等）

---

## 5. 复盘记录（后续在此追加）

| 日期 | 触发 | 变化摘要 | 新增决策 | 遗留 |
|---|---|---|---|---|
| 2026-11-18 | 首次生成 | 业务地图建立（70 叶子 / 🟢58 / 🟡5 / ⚪7）；当日关闭 U272–U313 中 40 项；U310 P1（双击导航重放循环）修复 | — | 12 项功能未完成；27 行台账未关闭 |

---

## 6. 相关文档索引

| 类别 | 路径 |
|---|---|
| 需求与设计 | `../requirements.md`、`../design.md`、`../design-adjustment-native-ui.md` |
| 业务地图（本复盘的上游） | `../business-map.md` |
| 缺陷台账 | `../defect-ledger.md` |
| 测试计划（§6 计数、§7.1 认证清单、§7.2 全景、§7.3 超时门禁） | `../test-plan.md` |
| 决策索引与决策包 | `../work-orders/decision-index-20261118.md`、`../work-orders/pending-decisions-2026-11-17.md`（附三 D21、附四 D22、附五 D25） |
| 子会话协议（报告/证据/复盘纪律） | `../parent-child-session-protocol.md`、`../../DEVELOPMENT_PROCESS.md` |
| 现状文档 | `../current-state/m01-auth.md`、`m02-workbench-nav.md`、`m03-projects.md`、`m04-hosts.md`、`m06-users.md`、`m07-audit.md`、`m11-authz-model.md` |
| 关键测试报告（gitignored，随工作树） | `cloud-platform/test-reports/full-e2e-sweep-final3-20261118.md`、`auth-baseline-6-20261118.md`、`u197-closure-verdict-20261118.md`、`timeouts-burndown-plan-20261118.md`、`open-rows-triage-20261118.md`、`review-728c5d5-20261118.md`（U310 复现对照） |
| 证据目录 | `cloud-platform/evidence/`（gitignored）、`/tmp/e2e-sweep-final3/`（当次扫描日志） |
