# 验收用例集（G7c 从链路 + 模块现状派生）

> 派生日期：2026-11-16｜派生基线：`business-flows.md` + `m01..m12` @ `664a91e0322`（快照头：种子基线 `664a91e0322`；当前刷新至 R4 基线 `27135c06cbc`）。
> **刷新记录（R2）**：2026-11-16｜刷新基线 HEAD `5569f174501`｜依据=defect-ledger 闭合项（U67 全批/审计 PASS、U96-A、U99、U103/U104、U106 R1–R6+W3、U112 D1–D8、U114-D4、U115、U118/U120–U128）与新增自动化 T64–T69/R22；本轮 ✅ +32、🖐 −2、⛔ −30，缺口 27→21（6 closed，G18 部分闭合）。
> **刷新记录（R4，审计修正）**：2026-11-16｜基线 HEAD `27135c06cbc`｜同步 U134（G28 closed）/U135（AC-M6-15 ✅）/U136①/U137；**R3 行记录（基于 `63a47043057`）保留为历史**：逐条核对 §13 并对可自动化项补测：G01 浏览器重放（T05 新增）、G11 中继刷新态（T06 QA-013）、G14 auditor 下拉（T32 U72-4）；复核确认 T06 QA-002/QA-004/QA-009、U70 guard 7 单测已闭合相应缺口；新发现 G28（并行 refresh 竞态）与 G29（策略并发覆盖）。
> 派生规则（G7c）：链路每步骤 ≥1 正常用例；每失败分支 ≥1 异常用例；每已知缺陷 ≥1 回归钉；探索有效路径转正。未实现行为一律标 ⛔ + U 号，不按设计稿断言「应通过」。
> 模块与链路映射：M1→F1；M2→F1/F3；M3→F2/F5；M4→F5/F7；M5→F8；M6→F9；M7→F6；M8→F2/F5（下载策略）；M9→F3/F4；M10→F4；M11→F5；M12→F7/F8。F10（移动端，U80 原型）不派生运行用例。

## 0. 现状标记与自动化文件索引

现状三类：

- **✅ 已有自动化**：给索引号（T=cloud-platform 测试，R=renderer/两端测试），完整路径见下表。
- **🖐 仅手测可行**：步骤列即手测操作序列；有探索路径的按括号内路径重放。
- **⛔ 未覆盖**：未实现或无可执行断言；全部进入 §13 缺口清单，并带 U 号（无 U 号的标「无 U/登记建议」）。

### 0.1 自动化文件索引（cloud-platform）

| 索引 | 文件（仓库相对路径）                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| T01  | `cloud-platform/test/ldap-admission.test.ts`                                                                                   |
| T02  | `cloud-platform/test/ldap-mock-required-group.test.ts`                                                                         |
| T03  | `cloud-platform/test/e2e/ldap-admission.e2e.test.ts`                                                                           |
| T04  | `cloud-platform/test/e2e/login-lockout-shared.e2e.test.ts`                                                                     |
| T05  | `cloud-platform/test/e2e/session-renewal.e2e.test.ts`                                                                          |
| T06  | `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`                                                                    |
| T07  | `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`                                                                         |
| T08  | `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`                                                                     |
| T09  | `cloud-platform/test/e2e/web-project-registration.e2e.test.ts`                                                                 |
| T10  | `cloud-platform/test/e2e/project-registration-validation.e2e.test.ts`                                                          |
| T11  | `cloud-platform/test/e2e/project-branch-validation.e2e.test.ts`                                                                |
| T12  | `cloud-platform/test/e2e/web-project-detail.e2e.test.ts`                                                                       |
| T13  | `cloud-platform/test/e2e/web-project-entry.e2e.test.ts`                                                                        |
| T14  | `cloud-platform/test/e2e/web-admin-self-grant.e2e.test.ts`                                                                     |
| T15  | `cloud-platform/test/e2e/u46-1-platform-contract.e2e.test.ts`                                                                  |
| T16  | `cloud-platform/test/e2e/u46-3-overlay.e2e.test.ts`                                                                            |
| T17  | `cloud-platform/test/e2e/web-handoff.e2e.test.ts`                                                                              |
| T18  | `cloud-platform/test/e2e/project-connect-readiness.e2e.test.ts`                                                                |
| T19  | `cloud-platform/test/e2e/provision-assignment-downlink.e2e.test.ts`                                                            |
| T20  | `cloud-platform/test/e2e/project-archive.e2e.test.ts`                                                                          |
| T21  | `cloud-platform/test/e2e/project-update.e2e.test.ts`                                                                           |
| T22  | `cloud-platform/test/e2e/host-authorization.e2e.test.ts`                                                                       |
| T23  | `cloud-platform/test/e2e/web-host-permission-drawer.e2e.test.ts`                                                               |
| T24  | `cloud-platform/test/e2e/web-grant-subject-picker.e2e.test.ts`                                                                 |
| T25  | `cloud-platform/test/e2e/u67-role-authz.e2e.test.ts`                                                                           |
| T26  | `cloud-platform/test/e2e/u62-authz-polish.e2e.test.ts`                                                                         |
| T27  | `cloud-platform/test/e2e/user-grant-resolution.e2e.test.ts`                                                                    |
| T28  | `cloud-platform/test/e2e/u66-5-audit-ui.e2e.test.ts`                                                                           |
| T29  | `cloud-platform/test/e2e/u66-2-audit-query.e2e.test.ts`                                                                        |
| T30  | `cloud-platform/test/e2e/u66-audit-file-events.e2e.test.ts`                                                                    |
| T31  | `cloud-platform/test/e2e/u71-audit-gap-heartbeat.e2e.test.ts`                                                                  |
| T32  | `cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts`                                                                  |
| T33  | `cloud-platform/test/e2e/audit-verify.e2e.test.ts`                                                                             |
| T34  | `cloud-platform/test/e2e/audit-fail-closed.e2e.test.ts`                                                                        |
| T35  | `cloud-platform/test/e2e/audit-writer.e2e.test.ts` / `audit-writer-standby.e2e.test.ts`                                        |
| T36  | `cloud-platform/test/e2e/audit-anchor.e2e.test.ts`                                                                             |
| T37  | `cloud-platform/test/e2e/u67-3-users-page.e2e.test.ts`                                                                         |
| T38  | `cloud-platform/test/e2e/install-wizard.e2e.test.ts`                                                                           |
| T39  | `cloud-platform/test/e2e/host-offline.e2e.test.ts`                                                                             |
| T40  | `cloud-platform/test/e2e/host-revocation.e2e.test.ts`                                                                          |
| T41  | `cloud-platform/test/e2e/host-route-key-follow.e2e.test.ts`                                                                    |
| T42  | `cloud-platform/test/e2e/u64-host-port-drift.e2e.test.ts`                                                                      |
| T43  | `cloud-platform/test/e2e/projects-root-change-guard.e2e.test.ts`                                                               |
| T44  | `cloud-platform/test/e2e/host-key-change-audit.e2e.test.ts`                                                                    |
| T45  | `cloud-platform/test/e2e/mtls-control-channel.e2e.test.ts`                                                                     |
| T46  | `cloud-platform/test/e2e/control-plane-isolation.e2e.test.ts`                                                                  |
| T47  | `cloud-platform/test/e2e/web-download-policy.e2e.test.ts`                                                                      |
| T48  | `cloud-platform/test/e2e/project-download-policy.e2e.test.ts`                                                                  |
| T49  | `cloud-platform/test/e2e/relay-endpoint-address.e2e.test.ts`                                                                   |
| T50  | `cloud-platform/test/e2e/u79-host-relay-binding.e2e.test.ts`                                                                   |
| T51  | `cloud-platform/test/e2e/relay-hardening.e2e.test.ts`                                                                          |
| T52  | `cloud-platform/test/e2e/relay-failover.e2e.test.ts`                                                                           |
| T53  | `cloud-platform/test/e2e/relay-browser-entry.e2e.test.ts`                                                                      |
| T54  | `cloud-platform/test/e2e/relay-browser-mode.e2e.test.ts`                                                                       |
| T55  | `cloud-platform/test/e2e/relay-browser-edge-hygiene.e2e.test.ts`                                                               |
| T56  | `cloud-platform/test/relay-nodes.test.ts`                                                                                      |
| T57  | `cloud-platform/test/console-routes.test.ts`                                                                                   |
| T58  | `cloud-platform/test/e2e/web-workbench-latency.e2e.test.ts` / `workbench-project-list-latency.e2e.test.ts`                     |
| T59  | `cloud-platform/test/e2e/self-service-projects.e2e.test.ts` / `self-service-project-dir.e2e.test.ts`                           |
| T60  | `cloud-platform/test/e2e/admin-denial-audit.e2e.test.ts` / `admin-authorization-directory.e2e.test.ts`                         |
| T61  | `cloud-platform/test/host-audit-file-ingest.test.ts`                                                                           |
| T62  | `cloud-platform/test/e2e/audit-query-latency.e2e.test.ts`                                                                      |
| T63  | `cloud-platform/test/e2e/audit-trace-window.e2e.test.ts`                                                                       |
| T64  | `cloud-platform/test/e2e/u106-detail-deeplink.e2e.test.ts`                                                                     |
| T65  | `cloud-platform/test/e2e/u106-workspace-route.e2e.test.ts` / `u106-filter-url.e2e.test.ts` / `u106-console-mobile.e2e.test.ts` |
| T66  | `cloud-platform/test/e2e/u114-u81b-users-filter-lock.e2e.test.ts`                                                              |
| T67  | `cloud-platform/test/e2e/u114-u86-audit-grid-contract.e2e.test.ts`                                                             |
| T68  | `cloud-platform/test/e2e/u58-input-hardening.e2e.test.ts`                                                                      |
| T69  | `cloud-platform/test/e2e/review07-gaps.e2e.test.ts`                                                                            |
| T70  | `cloud-platform/test/e2e/u70-workbench-cards.e2e.test.ts`                                                                      |
| T71  | `cloud-platform/test/e2e/web-project-detail.e2e.test.ts`                                                                       |
| T72  | `cloud-platform/test/e2e/web-host-lifecycle-feedback.e2e.test.ts`                                                              |

### 0.2 自动化文件索引（renderer / 两端）

| 索引 | 文件（仓库相对路径）                                                          |
| ---- | ----------------------------------------------------------------------------- |
| R01  | `tests/e2e/cloud-golden-journey-orca-web.spec.ts`                             |
| R02  | `tests/e2e/cloud-golden-journey-git-and-restart.spec.ts`                      |
| R03  | `src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts`                    |
| R04  | `src/renderer/src/web/web-cloud-session-renewal.e2e.test.ts`                  |
| R05  | `src/renderer/src/web/web-cloud-session-resume.test.ts`                       |
| R06  | `src/renderer/src/web/web-cloud-workspace-location.test.ts`                   |
| R07  | `src/renderer/src/runtime/web-session-tabs-reentry-host-adoption.test.ts`     |
| R08  | `src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`             |
| R09  | `src/renderer/src/cloud-admin/cloud-admin-session.e2e.test.ts`                |
| R10  | `src/renderer/src/cloud/cloud-simple-workspace-tabs.test.ts`                  |
| R11  | `src/renderer/src/cloud/cloud-simple-workspace-session-tabs.test.ts`          |
| R12  | `src/renderer/src/cloud/cloud-simple-workspace-orphan-recovery.test.ts`       |
| R13  | `src/renderer/src/cloud/cloud-terminal-panel.test.tsx`                        |
| R14  | `src/renderer/src/cloud/cloud-terminal-replay-boundary.test.tsx`              |
| R15  | `src/renderer/src/cloud/cloud-admin-embed.test.tsx`                           |
| R16  | `src/renderer/src/cloud-admin/cloud-simple-workspace-dual-client.e2e.test.ts` |
| R17  | `src/renderer/src/runtime/web-session-tabs-sync/*.test.ts`                    |
| R18  | `src/main/cloud-platform/cloud-session-tabs-scope.test.ts`                    |
| R19  | `src/main/cloud-platform/cloud-terminal-scope.test.ts`                        |
| R20  | `src/renderer/src/web/web-cloud-workspace-bootstrap.test.ts`                  |
| R21  | `src/renderer/src/web/web-cloud-session-capabilities.test.ts`                 |
| R22  | `src/renderer/src/web/WebCloudWorkspaceError.test.tsx`                        |

---

## M1 登录与认证（F1）

来源：`business-flows.md#F1`、`m01-auth.md`（A1–A9）、探索 `web-console-paths.md` L1–L8、`api-paths.md` A1–A16。

| 用例号   | 来源         | 前置数据                                | 步骤                                            | 期望                                                                            | 类型   | 现状                                      | 关联 U 号 |
| -------- | ------------ | --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------ | ----------------------------------------- | --------- |
| AC-M1-01 | F1 S1 / A2   | 有效域账号                              | 登录页输入账号密码，点「登录」                  | 200；按钮「登录中…」后进主框架；写 access/refresh/user/device                   | 正常   | ✅ T03/T06/T07/T08                        | —         |
| AC-M1-02 | F1 S2 / A2   | 已登录                                  | 登录成功后读侧栏与 localStorage                 | 侧栏显示名/部门/角色 chip；四个 `orca.*` 键存在                                 | 正常   | ✅ T06/T37                                | —         |
| AC-M1-03 | F1 S3 / B4   | 已登录；hash=`#/login`、空、`#/hosts`   | 分别登录后观察落地路由                          | 空/`#/login`→`#/workbench`；其他 hash 原样恢复；非管理员管理路由 403 且保留 URL | 正常   | ✅ T07/T08                                | U72       |
| AC-M1-04 | F1 S4 / A7   | access 已过期、refresh 有效             | 触发任一业务请求                                | 401→refresh→旋转 token→原请求重放一次；用户无感                                 | 正常   | ✅ T05（单请求重放；并行 401 竞态见 G28） | —         |
| AC-M1-05 | F1 S5 / A8   | 本地有 access                           | 刷新/重开页面                                   | `GET /v1/me` 成功并直接进主框架/原 hash                                         | 正常   | ✅ T08                                    | —         |
| AC-M1-06 | F1 S6 / A6   | 登录页                                  | 点密码框眼睛两次                                | `password`↔`text` 切换，无网络请求                                              | 正常   | 🖐                                        | —         |
| AC-M1-07 | F1 S7 / A9   | 已登录                                  | 点侧栏「退出」                                  | 工作区 iframe 收 logout；尽力调 logout；本地四键清空、登录框清空、回登录页      | 正常   | ✅ T06                                    | U53②      |
| AC-M1-08 | F1 E1 / A1   | 未登录                                  | 空账号/空密码/空白用户名提交                    | 前端拦截零请求；行内「请输入域账号和密码。」；账号框标红聚焦                    | 异常   | ✅ T06                                    | —         |
| AC-M1-09 | F1 E2 / A3   | 不存在账号+任意密码                     | 提交一次                                        | 401 `INVALID_CREDENTIALS`；行内「账号或密码错误，请重试。」；密码框标红聚焦     | 异常   | ✅ T03/T06                                | —         |
| AC-M1-10 | F1 E3 / A4   | 不存在账号                              | 连续失败 5 次，再第 6 次                        | 第 5/6 次 423；文案「连续 5 次失败，账号已锁定 15 分钟。」；审计 `locked`       | 异常   | ✅ T04                                    | —         |
| AC-M1-11 | F1 E4 / A5   | LDAP 用户不在准入组                     | 提交                                            | 401 `LDAP_GROUP_NOT_ADMITTED`；零锁定计数；审计 `ldap_group_denied`             | 异常   | ✅ T02/T03/T06                            | U69a      |
| AC-M1-12 | F1 E5        | 配置共享锁定服务且不可达                | 提交登录                                        | 503 `PLATFORM_UNAVAILABLE`（fail-closed）；界面无专门中文映射                   | 异常   | ✅ T04                                    | —         |
| AC-M1-13 | F1 E6 / A7   | refresh 已过期                          | 触发 401 续会话                                 | refresh 失败→本地登出回登录页，不保留半登录态                                   | 异常   | ✅ T05（refresh 401→登录页/三键清空/单次刷新） | —         |
| AC-M1-14 | F1 E7 / A8   | 仅缓存 user、无 access；或 `/v1/me` 401 | 刷新页面                                        | 清 access、移除缓存 user、显示登录页；仅缓存 user 不得进                        | 异常   | ✅ T05（仅缓存 user 不进且移除）          | —         |
| AC-M1-15 | F1 E8 / A9   | 已登录、logout 端点失败                 | 点退出                                          | 错误被吞，本地仍清空并回登录页                                                  | 异常   | ✅ T05（logout 500 静默回登录页/三键清空） | —         |
| AC-M1-16 | U8           | 跨源页面登录                            | 从宿主/边缘跨源调登录                           | 不再出现 `network_error`（CORS 已修）                                           | 回归钉 | ✅ T06                                    | U8        |
| AC-M1-17 | U13          | 开发模式带 `ORCA_CLOUD_API_URL` 启动    | 打开平台根                                      | 正常显示登录页（准入只认显式宿主信号）                                          | 回归钉 | ✅ T07                                    | U13       |
| AC-M1-18 | U53②         | 登录后退出                              | 退出后直接点登录                                | 凭据不残留，不得一键恢复上一账号；显示空提交错误                                | 回归钉 | ✅ T06                                    | U53②      |
| AC-M1-19 | U69a         | LDAP 组 `platform-admins` 用户          | 首登后查角色                                    | 组只做准入，不映射角色；首登一律 developer；覆盖优先                            | 回归钉 | ✅ T01/T03                                | U69a      |
| AC-M1-20 | U72          | 审计员账号                              | 登录后看导航/直达管理路由                       | 仅审计入口可见；其余管理直达 403                                                | 回归钉 | ✅ T07/T32                                | U72       |
| AC-M1-21 | U106         | 未登录访问 `#/hosts`；已登录 `#/login`  | 登录回跳与刷新                                  | 登录后回原 hash；`#/login` 兼容；深链刷新不丢                                   | 回归钉 | ✅ T08                                    | U106      |
| AC-M1-22 | 探索 L2 / L5 | 登录页                                  | 用户名输入 3 空格；再输入 396 字符与 XSS/注入串 | trim 后拦截零请求；超长不破版、无脚本执行、统一 401 文案                        | 异常   | 🖐                                        | —         |
| AC-M1-23 | 探索 L4      | 登录页                                  | 点眼睛并读 `aria-label`                         | 类型切换正确；已知观察：`aria-label` 恒为「显示密码」                           | 正常   | 🖐（WEB-R2-011，未登记 U）                | —         |
| AC-M1-24 | F1 E9        | 登录页；网络不可达 / LDAP 拒绝 / 请求在途 | 提交登录；在途期间再次提交                      | fetch 拒绝→行内「网络异常，请稍后重试」；LDAP 401 文案逐字展示；在途按钮禁用「登录中…」、重复提交零新增请求、失败恢复可点 | 异常   | ✅ T06                                    | —         |

**覆盖核对表（M1）**

| 操作条目             | 用例号                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| A1 空提交            | AC-M1-08                                                                  |
| A2 登录成功/会话落地 | AC-M1-01、AC-M1-02                                                        |
| A3 密码错误          | AC-M1-09                                                                  |
| A4 连续失败锁定      | AC-M1-10                                                                  |
| A5 LDAP 准入拒绝     | AC-M1-11                                                                  |
| A6 密码显示切换      | AC-M1-06、AC-M1-23                                                        |
| A7 静默续会话        | AC-M1-04、AC-M1-13                                                        |
| A8 刷新恢复          | AC-M1-05、AC-M1-14                                                        |
| A9 退出              | AC-M1-07、AC-M1-15                                                        |
| 登录失败 UI 三态     | AC-M1-24（网络异常/LDAP 文案/登录中禁用）                                 |
| 缺口裁定             | AC-M1-04 浏览器重放、AC-M1-13/14/15 失败 UI 建议补测；WEB-R2-011 建议登记 |

---

## M2 工作台与导航（F1/F3）

来源：`business-flows.md#F1/#F3`、`m02-workbench-nav.md`（B1–B17）、`console-routes.test.ts`、`u106-console-routing.e2e.test.ts`、`u70-workbench-cards.e2e.test.ts`。

| 用例号   | 来源             | 前置数据                                  | 步骤                                                                   | 期望                                                                                         | 类型    | 现状                               | 关联 U 号                                |
| -------- | ---------------- | ----------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- | ---------------------------------- | ---------------------------------------- |
| AC-M2-01 | B1               | 已登录                                    | 点击侧栏各菜单                                                         | `navigate` 写 hash；面包屑/高亮切换；内容渲染                                                | 正常    | ✅ T07/T57                         | —                                        |
| AC-M2-02 | B2               | 任一页                                    | 重复点击当前菜单                                                       | 强制重绘（重新取数），不产生重复路由项                                                       | 正常    | 🖐                                 | —                                        |
| AC-M2-03 | B3               | 已登录                                    | 浏览器前进/后退、手改 hash                                             | 相同签名不重复请求；未知→404；无权→403                                                       | 正常    | ✅ T08/T57/T70（前进/后退+query 不生效） | —                                        |
| AC-M2-04 | B4               | 登录前 hash 为空/`#/login`/其他           | 登录                                                                   | 分别落 `#/workbench` / `#/workbench` / 原 hash                                               | 正常    | ✅ T08                             | —                                        |
| AC-M2-05 | B5               | 已登录                                    | 访问未知 hash                                                          | 保留地址渲染 404，面包屑「页面不存在」                                                       | 异常    | ✅ T08/T57                         | —                                        |
| AC-M2-06 | B6               | 开发者                                    | 直达 `#/hosts                                                          | #/relays                                                                                     | #/users | #/settings`                        | 403 页保留 URL，导航不高亮，不发数据请求 | 异常 | ✅ T07/T32 | U72 |
| AC-M2-07 | B7               | 审计员                                    | 直达 `#/audit`                                                         | 正常渲染审计页                                                                               | 正常    | ✅ T32                             | U72                                      |
| AC-M2-08 | B8/B9            | 非管理员/管理员                           | 点「查看无权限页」，再点「返回工作台」                                 | 非管理员见 403；管理员按钮隐藏；返回工作台                                                   | 正常    | ✅ T07（管理员隐藏为观察）         | U74-P3                                   |
| AC-M2-09 | B10              | 已登录有项目                              | 工作台点「查看全部」                                                   | 跳 `#/projects`                                                                              | 正常    | 🖐                                 | —                                        |
| AC-M2-10 | B11/B12          | 项目 open、主机在线；另备离线/维护/归档行 | 点最近卡/行内「打开」                                                  | 同页覆盖层；不可打开时 disabled 且 title 给原因                                              | 正常    | ✅ T13/T16                         | U46                                      |
| AC-M2-11 | B13              | 管理员、项目未授权、主机在线              | 点「授权并打开」并确认                                                 | 确认框列 5 位+断会话警告；PUT 自授后打开                                                     | 正常    | ✅ T14                             | U40/AA5                                  |
| AC-M2-12 | B14              | 管理员                                    | 行内「详情」                                                           | 打开项目详情弹框                                                                             | 正常    | ✅ T12                             | U46                                      |
| AC-M2-13 | B15              | 项目 open、主机在线                       | 行内「Orca Web」                                                       | 新标签 `web-index.html` handoff；失败 toast/置灰                                             | 正常    | ✅ T13/T17                         | —                                        |
| AC-M2-14 | B16              | 我的项目有数据                            | 搜索框输入名称/仓库/主机/XSS 串                                        | 大小写不敏感包含过滤；无匹配空态；无 XSS                                                     | 正常    | 🖐                                 | —                                        |
| AC-M2-15 | B17              | 任一页                                    | 点「刷新」                                                             | `location.reload()` 后数据重取                                                               | 正常    | 🖐                                 | —                                        |
| AC-M2-16 | 探索 M116-QA-011 | 注入渲染异常                              | 打开菜单                                                               | 内容区「加载失败」+「重试」可恢复                                                            | 异常    | ✅ T06                             | —                                        |
| AC-M2-17 | U106             | 已登录                                    | 访问 `#/projects/:id`、`#/hosts/:id`、`#/users/:id`、`#/workspace/:id` | R3 深链已实现：项目/主机/用户详情与权限页签直达、刷新保持、关闭回列表；非管理员 403 保留 URL | 回归钉  | ✅ T64（R3 深链）                  | U106                                     |
| AC-M2-18 | U72              | 审计员/开发者                             | 复跑导航显隐与直达门禁                                                 | 审计员仅审计入口；开发者管理入口全隐藏                                                       | 回归钉  | ✅ T32/T07                         | U72                                      |
| AC-M2-19 | U74-P3           | 管理员                                    | 看顶栏「查看无权限页」                                                 | 按钮隐藏，管理员不能跳过 403 预览                                                            | 回归钉  | 🖐                                 | U74-P3                                   |
| AC-M2-20 | U53③             | 有归档项目的数据集                        | 打开工作台/我的项目                                                    | 归档项目不出现在在营列表（管理员仅 `includeArchived=1` 取回）                                | 回归钉  | ✅ T06                             | U53③                                     |
| AC-M2-21 | U46              | 管理员                                    | 行内三操作                                                             | 打开=同页覆盖层；详情=弹框；Orca Web=新标签                                                  | 回归钉  | ✅ T13/T16                         | U46                                      |
| AC-M2-22 | U40/AA5          | 管理员无 open 项目                        | 行内操作矩阵                                                           | 只出现「授权并打开」，不出现 Orca Web；确认框取消零请求                                      | 回归钉  | ✅ T14                             | U40/AA5                                  |
| AC-M2-23 | U65/U67b         | 管理员                                    | 看项目/主机授权卡片                                                    | U67 审定二已实现：层级单卡（查看/控制/管理），位置即权限，同主体不再多卡                     | 回归钉  | ✅ T23/T12（U67 审定二+审计 PASS） | U65/U67b                                 |

**覆盖核对表（M2）**

| 操作条目 | 用例号                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B1       | AC-M2-01                                                                                                                       |
| B2       | AC-M2-02                                                                                                                       |
| B3       | AC-M2-03                                                                                                                       |
| B4       | AC-M2-04                                                                                                                       |
| B5       | AC-M2-05                                                                                                                       |
| B6       | AC-M2-06                                                                                                                       |
| B7       | AC-M2-07                                                                                                                       |
| B8/B9    | AC-M2-08                                                                                                                       |
| B10      | AC-M2-09                                                                                                                       |
| B11/B12  | AC-M2-10                                                                                                                       |
| B13      | AC-M2-11、AC-M2-22                                                                                                             |
| B14      | AC-M2-12                                                                                                                       |
| B15      | AC-M2-13                                                                                                                       |
| B16      | AC-M2-14                                                                                                                       |
| B17      | AC-M2-15                                                                                                                       |
| 缺口裁定 | 统计卡四项数值无断言（登记建议）；前进/后退无专门 e2e（补测 AC-M2-03 历史栈分支）；查询参数「保留但不生效」无 characterization |

---

## M3 项目（F2/F5）

来源：`business-flows.md#F2`、`m03-projects.md`（C1–C21）、`web-console-paths.md` P1–P4、`authz-combo-paths.md` D3/D4。

| 用例号   | 来源                 | 前置数据                               | 步骤                                               | 期望                                                                                                                                                | 类型   | 现状                                                                        | 关联 U 号                     |
| -------- | -------------------- | -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- | ----------------------------- |
| AC-M3-01 | F2 S1 / C1           | 已登录，ACL 内有项目                   | 进入「我的项目」                                   | 并发取 projects+download 策略；表格/空态正确                                                                                                        | 正常   | ✅ T09/T12                                                                  | —                             |
| AC-M3-02 | C2/C3                | 列表有数据                             | 搜索名称/仓库/主机；点「刷新」                     | 客户端过滤即时生效；无匹配「没有匹配的项目」；刷新重载                                                                                              | 正常   | 🖐                                                                          | —                             |
| AC-M3-03 | F2 S2 / C4           | 管理员                                 | 点「登记项目」                                     | 取 hosts（排除已吊销）后打开弹框；失败 toast                                                                                                        | 正常   | ✅ T09                                                                      | —                             |
| AC-M3-04 | F2 S3 / C5           | 登记弹框                               | Key 失焦输入 `PaymentService`/尾点/65 字符         | 与提交同规则即时标红/清错                                                                                                                           | 正常   | ✅ T09                                                                      | U18                           |
| AC-M3-05 | F2 S3 / C6           | 登记弹框                               | 选 host1 填路径，再切 host2                        | 清空已填路径；刷新「主机项目根」提示（r2 `WEB-AUTHZ-001` 为修复前观察）                                                                             | 正常   | ✅ T09                                                                      | —                             |
| AC-M3-06 | F2 S4 / C8           | 合法名称/Key/主机/绝对路径，无 repoUrl | 提交                                               | 201；弹框关、toast、列表重绘；status=ready                                                                                                          | 正常   | ✅ T09                                                                      | —                             |
| AC-M3-07 | F2 S5 / C9           | 合法字段+repoUrl                       | 提交                                               | provisioning；toast「克隆中」；宿主回报后 ready                                                                                                     | 正常   | ✅ T71（G07）                                                               | U37                           |
| AC-M3-08 | F2 S6 / C13/C14      | 管理员；列表有缓存行                   | 点「详情」，切信息/权限页签                        | 先缓存后并发刷新；信息三组/权限卡完整；黄条仅项目 GET 失败                                                                                          | 正常   | ✅ T12                                                                      | U46                           |
| AC-M3-09 | C15                  | 详情弹框                               | 点 ID/路径/仓库复制                                | 剪贴板写入 + toast「已复制」                                                                                                                        | 正常   | ✅ T12/T71（G07）                                                           | —                             |
| AC-M3-10 | F2 S7 / C16          | 详情权限页                             | 添加用户/组到「查看/控制」                         | 位并集整行 PUT；成功 toast+重绘；已有行先确认                                                                                                       | 正常   | ✅ T24/T06                                                                  | U62                           |
| AC-M3-11 | C17                  | 已有授权芯片                           | 移除芯片；剩余为空再确认                           | 减位 PUT；非空 toast；空则「移除全部授权」确认                                                                                                      | 正常   | ✅ T06                                                                      | U62                           |
| AC-M3-12 | F2 S8 / C11/C18      | 项目 open、主机在线                    | 行内/详情「打开」，脏文件时关闭                    | 同页覆盖层准备→就绪；失败态重试/新标签；关闭回原路由                                                                                                | 正常   | ✅ T16/T13                                                                  | U46                           |
| AC-M3-13 | C19                  | 详情弹框打开                           | Escape / 背景 / 关闭                               | 关闭且焦点回「详情」按钮                                                                                                                            | 正常   | ✅ T12                                                                      | —                             |
| AC-M3-14 | C20                  | 项目 open、主机在线                    | 行内「Orca Web」                                   | 新标签 web handoff；离线/维护 disabled                                                                                                              | 正常   | ✅ T13                                                                      | —                             |
| AC-M3-15 | C12 / F5 S9          | 管理员、无 open、主机在线              | 「授权并打开」确认/取消                            | 确认自授 5 位并打开；取消零请求；失败 toast                                                                                                         | 正常   | ✅ T14                                                                      | U40/AA5                       |
| AC-M3-16 | F2 S11 / C21         | 管理员/创建者                          | API `POST archive`/`restore`；列表与详情 GET       | 归档后列表消失、详情 404；恢复回 ready；凭证撤销                                                                                                    | 正常   | ✅ T20（仅 API；控制台无入口）                                              | U53③                          |
| AC-M3-17 | F2 E1 / C7           | 登记弹框                               | 空名称/非法 Key/未选主机/相对路径/`..`/尾分隔符    | 零请求；所有错误标红；焦点首个错误                                                                                                                  | 异常   | ✅ T09/T10                                                                  | U18                           |
| AC-M3-18 | F2 E2 / C10          | 登记弹框                               | 触发服务端字段错误（重复 Key/路径/非法 repo/分支） | 按错误码落字段；弹框不关、输入保留、按钮恢复                                                                                                        | 异常   | ✅ T09/T10/T11                                                              | U18/U25                       |
| AC-M3-19 | F2 E3                | 主机离线/维护/项目归档                 | 看行内按钮                                         | 「打开」「Orca Web」disabled 且 title 给原因；详情仍可开                                                                                            | 异常   | ✅ T13/T06                                                                  | U19                           |
| AC-M3-20 | F2 E4                | handoff 签发失败/20s 未就绪            | 打开后观察失败态并重试                             | 失败态重试/新标签；超时文案；最多重试 2 次                                                                                                          | 异常   | ✅ T16                                                                      | —                             |
| AC-M3-21 | F2 E5                | repoUrl 克隆失败                       | 宿主心跳回报 `provisioningError`                   | 详情状态「准备失败」+原因                                                                                                                           | 异常   | ✅ T71（G07）                                                               | U37/U44                       |
| AC-M3-22 | F2 E6                | 权限页写请求失败                       | 添加/移除主体                                      | toast「授予/移除失败：…」；输入保留；控件解冻                                                                                                       | 异常   | ✅ T06                                                                      | —                             |
| AC-M3-23 | F2 E7                | 开发者                                 | 调 `POST /v1/projects`                             | 403 + denied 审计；入口不渲染                                                                                                                       | 异常   | ✅ T07/T60                                                                  | —                             |
| AC-M3-24 | F2 E8                | 归档项目                               | 非管理员列表；详情 GET；API 归档                   | 列表排除；详情 404 不泄露存在性；非创建者/非 admin 归档 404                                                                                         | 异常   | ✅ T20/T06                                                                  | U53③                          |
| AC-M3-25 | U18                  | 管理员登记                             | 提交大写 Key、Unicode Key、201 字符名称            | 400 `PROJECT_KEY_INVALID`/`PROJECT_NAME_INVALID`，不落库                                                                                            | 回归钉 | ✅ T10                                                                      | U18                           |
| AC-M3-26 | U19                  | 离线主机                               | 登记/打开                                          | 409 `HOST_OFFLINE`；入口置灰                                                                                                                        | 回归钉 | ✅ T10/T13                                                                  | U19                           |
| AC-M3-27 | U25                  | 非法默认分支                           | 登记/更新                                          | 400 `BRANCH_INVALID`；与宿主 git-ref 规则一致                                                                                                       | 回归钉 | ✅ T11                                                                      | U25                           |
| AC-M3-28 | U20/U37/U44          | repo-ful 项目                          | 创建后等心跳                                       | 创建即 provisioning，指派克隆，回报 ready/`provisioningError`；无死锁                                                                               | 回归钉 | ✅ T19/T18                                                                  | U20/U37/U44                   |
| AC-M3-29 | U53③                 | 归档项目                               | 列表/统计/详情                                     | 默认排除归档，不混入在营视图                                                                                                                        | 回归钉 | ✅ T06/T20                                                                  | U53③                          |
| AC-M3-30 | U62                  | 授权写入                               | 非法 subjectType/权限位/拒绝                       | 400 或明确拒绝；拒绝落 denied 审计（字段完整）                                                                                                      | 回归钉 | ✅ T26/T27                                                                  | U62                           |
| AC-M3-31 | U65/U67/U67b         | 项目详情权限页                         | 查看三卡片                                         | U67-4 已实现：项目权限页查看/控制可写卡、管理卡主机推导只读并跳转主机权限                                                                           | 回归钉 | ✅ T12（U67-4 层级单卡）                                                    | U65/U67/U67b                  |
| AC-M3-32 | U23/U24              | 自助建项目路径                         | 已存在 git 目录/并发 open                          | 返回明确错误/幂等，不产生半成品                                                                                                                     | 回归钉 | ✅ T59                                                                      | U23/U24                       |
| AC-M3-33 | 探索 P2/`WEB-R2-008` | 登记弹框                               | 仓库填 `not-a-valid-url`                           | 400 `REPO_URL_INVALID`；受支持形态=http(s)/ssh/git/file/本地绝对路径/user@ 形式 SCP-like（U141/U142 两端对齐）；拒绝裸串、UNC、ftp、ext::、控制字符 | 回归钉 | ✅ T10（project-registration-validation 树；U141 起本地路径/`file://` 201） | U136①+U141 `6cb53417057`+U142 |

**覆盖核对表（M3）**

| 操作条目 | 用例号                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| C1       | AC-M3-01                                                                                                           |
| C2/C3    | AC-M3-02                                                                                                           |
| C4       | AC-M3-03                                                                                                           |
| C5       | AC-M3-04                                                                                                           |
| C6       | AC-M3-05                                                                                                           |
| C7       | AC-M3-17                                                                                                           |
| C8       | AC-M3-06                                                                                                           |
| C9       | AC-M3-07、AC-M3-21                                                                                                 |
| C10      | AC-M3-18                                                                                                           |
| C11      | AC-M3-12、AC-M3-20                                                                                                 |
| C12      | AC-M3-15                                                                                                           |
| C13/C14  | AC-M3-08                                                                                                           |
| C15      | AC-M3-09                                                                                                           |
| C16      | AC-M3-10                                                                                                           |
| C17      | AC-M3-11                                                                                                           |
| C18      | AC-M3-12                                                                                                           |
| C19      | AC-M3-13                                                                                                           |
| C20      | AC-M3-14                                                                                                           |
| C21      | AC-M3-16、AC-M3-24                                                                                                 |
| 缺口裁定 | 归档/恢复控制台入口未实现（无 U，登记建议，仅 API 验收）；provisioning→ready UI 补测；复制按钮/黄条/独立页链接补测 |

---

## M4 主机（F5/F7）

来源：`business-flows.md#F7`、`m04-hosts.md`（D1–D16）、`web-console-paths.md` H1–H6、`authz-combo-paths.md` D2。

| 用例号   | 来源                | 前置数据                         | 步骤                              | 期望                                                                                   | 类型   | 现状                    | 关联 U 号           |
| -------- | ------------------- | -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | ------ | ----------------------- | ------------------- |
| AC-M4-01 | F7 S1 / D1          | 管理员                           | 进入「主机」                      | 并发取 hosts+download；列表列/状态/心跳/空态正确                                       | 正常   | ✅ T07/T13              | —                   |
| AC-M4-02 | F7 S2 / D2          | 管理员                           | 点「注册主机」                    | `POST tokens` 签发 24h 一次性令牌（只存 hash，审计 `host_token_create`）；弹框展示命令 | 正常   | 🖐（API T38）           | —                   |
| AC-M4-03 | F7 S3 / D3          | 注册弹框                         | 点「复制命令」                    | 剪贴板写入完整 bash 命令；toast「已复制」；弹框保持                                    | 正常   | 🖐                      | —                   |
| AC-M4-04 | F7 S4 / D4          | 管理员会话+有效 token            | `GET /install/host.sh?token=`     | 200 脚本内嵌平台地址/令牌/根/TLS/systemd；审计不含令牌明文                             | 正常   | ✅ T38                  | U115                |
| AC-M4-05 | F7 S5 / D5          | 有效一次性令牌                   | 宿主 `POST /hosts/register`       | 201；令牌置已用；upsert 主机；写路由；审计 `host_register`                             | 正常   | ✅ T38/T22              | —                   |
| AC-M4-06 | D6/D7               | 管理员                           | 点行内「详情」，切信息/权限       | 先缓存后拉 grants；信息 dl.kv 完整；权限三卡片                                         | 正常   | ✅ T23                  | —                   |
| AC-M4-07 | F7 S9 / D8          | 在线主机                         | 点「进入维护模式」                | 状态维护中；关闭抽屉重绘；项目打开入口置灰                                             | 正常   | ✅ T06/T22/T72          | M116-QA-008         |
| AC-M4-08 | D9                  | 维护中主机                       | 点「结束维护」                    | 回 online；列表重绘；项目恢复可打开                                                    | 正常   | ✅ T22/T39              | —                   |
| AC-M4-09 | F7 S10 / D10        | 管理员                           | 点「下线主机」并确认/取消         | 原生 confirm「确认下线该主机？」；取消无动作；确认后 revoked、删路由、撤凭证、审计     | 正常   | ✅ T40/T72              | —                   |
| AC-M4-10 | F7 S11 / D11        | 主机抽屉权限页                   | 添加组/用户到卡片                 | 位并集整行 PUT；成功 toast+重绘；已有行先确认                                          | 正常   | ✅ T23                  | U65/U67b            |
| AC-M4-11 | D12                 | 已有主机授权芯片                 | 移除芯片；空时确认                | 减位 PUT；级别变化 toast；空则「移除全部授权」                                         | 正常   | ✅ T23                  | U65/U67b            |
| AC-M4-12 | F7 S6 / D13         | 宿主凭证                         | 周期 `POST heartbeat`             | 更新地址/目录/根/E2EE/TLS/状态；返回策略/撤销/维护/指派                                | 正常   | ✅ T22/T43/T44          | —                   |
| AC-M4-13 | F7 S7 / D14         | 心跳过期/恢复                    | 观察列表状态                      | 60s 超窗→离线；恢复心跳→在线；不沿用存储 online                                        | 正常   | ✅ T39                  | M116-QA-005         |
| AC-M4-14 | F7 S8 / D15         | 显式/未命名 relayRoute           | 注册/重注册/心跳换地址            | 显式键优先；否则 `ip-<IP>`；漂移同步；旧键删除                                         | 正常   | ✅ T41/T42              | M114a/U64           |
| AC-M4-15 | F7 S8 / D16         | 中继离线、宿主有直连             | 看主机列表/抽屉                   | 「中继离线」+「直连不受阻」；项目仍可打开                                              | 正常   | ✅ T50                  | U79                 |
| AC-M4-16 | F7 E1 / D4          | 缺/无效/已用/过期 token；开发者  | 调安装脚本端点                    | 400 `INSTALL_TOKEN_REQUIRED`；401 `HOST_TOKEN_INVALID`；非 admin 403                   | 异常   | ✅ T38                  | —                   |
| AC-M4-17 | F7 E2 / D5          | 无效/已用/过期注册令牌           | `POST register`                   | 401 `HOST_TOKEN_INVALID`；令牌一次性                                                   | 异常   | ✅ T38                  | —                   |
| AC-M4-18 | F7 E3               | 开发者                           | 直达 `#/hosts`/调 hosts 授权端点  | 403 页保留 URL；接口 403 + denied 审计                                                 | 异常   | ✅ T07/T22              | —                   |
| AC-M4-19 | F7 E4 / D13         | 宿主上报坏 `directAddrs`         | 心跳                              | 400 `HOST_DIRECTADDRS_INVALID`；整拍拒绝、不落库                                       | 异常   | ✅ T22/T57?             | U57                 |
| AC-M4-20 | F7 E5 / D13         | 有活跃项目                       | 心跳换 projectsRoot               | 200 + `projectsRootRejected:'PROJECTS_ROOT_CONFLICT'`；旧根保留；归档项目不阻塞        | 异常   | ✅ T43                  | U21                 |
| AC-M4-21 | F7 E6 / D14         | 主机离线                         | 看项目入口                        | 「主机离线」disabled；恢复心跳后可打开                                                 | 异常   | ✅ T39/T13              | M116-QA-005         |
| AC-M4-22 | F7 E7 / D8          | 已吊销主机                       | 心跳/维护/新连接                  | 心跳 200+`hostRevoked` 不更新；维护 409；新连接 409 `HOST_REVOKED`                     | 异常   | ✅ T40                  | —                   |
| AC-M4-23 | F7 E8 / U115        | 干净 shell                       | 照抄向导命令执行 host.sh/relay.sh | U115 已修复：向导命令照抄可直接执行（一次性下载令牌），不再 401                        | 异常   | ✅ T38（U115 修复）     | U115                |
| AC-M4-24 | U21                 | 活跃项目在册                     | 换 projectsRoot                   | 拒绝换根并回 `PROJECTS_ROOT_CONFLICT`；已建项目 path 不迁移                            | 回归钉 | ✅ T43                  | U21                 |
| AC-M4-25 | U38                 | 安装脚本/中继进程                | 检查环境变量名                    | 双写/双读 `ORCA_CLOUD_*` 与旧裸名，无静默失败                                          | 回归钉 | ✅ T38                  | U38                 |
| AC-M4-26 | U39                 | 注册拍缺 relayTarget/directAddrs | 看路由表                          | 心跳 `ensureHostRoute` 补写表项，不留空                                                | 回归钉 | ✅ T41                  | U39                 |
| AC-M4-27 | U57                 | 坏心跳字段                       | 上报非字符串/非法地址             | 整拍拒绝且不落库，项目列表不受污染                                                     | 回归钉 | ✅ T22                  | U57                 |
| AC-M4-28 | U64                 | 宿主重启端口漂移                 | 心跳新端口                        | 路由 target 更新，传播窗口受控                                                         | 回归钉 | ✅ T42                  | U64                 |
| AC-M4-29 | U62                 | 主机授权                         | 非法位/未知主体/非 admin 读       | 400/403 + denied 审计；读写事件类型正确                                                | 回归钉 | ✅ T26/T22              | U62                 |
| AC-M4-30 | U65/U67b            | 主机抽屉权限页                   | 三卡片添加/移除/只读语义          | 现状三卡；全权=view+provision（不含 maintain）；不得按旧矩阵判                         | 回归钉 | ✅ T23（U67 审计 PASS） | U65/U67b            |
| AC-M4-31 | U79                 | 中继静默                         | 看主机列/抽屉                     | `relayTarget`/`relayOnline` 可见；「中继离线」「直连不受阻」                           | 回归钉 | ✅ T50                  | U79                 |
| AC-M4-32 | M114a               | 未命名路由宿主                   | IP 变化                           | 派生 `ip-<IP>` 随地址迁移；显式键不随 IP 抖动                                          | 回归钉 | ✅ T41                  | M114a               |
| AC-M4-33 | M116-QA-005/006/008 | 静默/吊销/维护主机               | 观察三入口与维护                  | 静默不显示在线；已吊销不可维护；维护原因在项目列表可见                                 | 回归钉 | ✅ T06/T22              | M116-QA-005/006/008 |
| AC-M4-34 | U115                | 向导命令                         | 复跑 host.sh 粘贴执行             | U115 已修复：向导命令照抄可直接执行（一次性下载令牌），不再 401                        | 回归钉 | ✅ T38（U115 修复）     | U115                |

**覆盖核对表（M4）**

| 操作条目 | 用例号                                                                          |
| -------- | ------------------------------------------------------------------------------- |
| D1       | AC-M4-01                                                                        |
| D2       | AC-M4-02                                                                        |
| D3       | AC-M4-03                                                                        |
| D4       | AC-M4-04、AC-M4-16、AC-M4-34                                                    |
| D5       | AC-M4-05、AC-M4-17                                                              |
| D6/D7    | AC-M4-06                                                                        |
| D8/D9    | AC-M4-07、AC-M4-08、AC-M4-22                                                    |
| D10      | AC-M4-09                                                                        |
| D11/D12  | AC-M4-10、AC-M4-11、AC-M4-29、AC-M4-30                                          |
| D13      | AC-M4-12、AC-M4-19、AC-M4-20、AC-M4-27                                          |
| D14      | AC-M4-13、AC-M4-21                                                              |
| D15      | AC-M4-14、AC-M4-26、AC-M4-28、AC-M4-32                                          |
| D16      | AC-M4-15、AC-M4-31                                                              |
| 缺口裁定 | 维护/下线控制台 UI 无 e2e（补测）；注册弹框成功/失败 UI 补测；U115 修复后再验收 |

---

## M5 中继（F8）

来源：`business-flows.md#F8`、`m05-relays.md`（3.1–3.7）、`web-console-paths.md` §6、`api-paths.md` R1–R15。

| 用例号   | 来源            | 前置数据                  | 步骤                                       | 期望                                                                   | 类型   | 现状                                                                 | 关联 U 号        |
| -------- | --------------- | ------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- | ---------------- |
| AC-M5-01 | F8 S1 / 3.1     | 管理员，有中继            | 打开 `#/relays`                            | 4 列表格/在线状态/最近注册时间；空态「尚未注册中继」                   | 正常   | ✅ T07/T49                                                           | —                |
| AC-M5-02 | 3.2             | 中继列表                  | 点「刷新」                                 | 重新 `GET /v1/relays` 并重绘                                           | 正常   | 🖐                                                                   | —                |
| AC-M5-03 | F8 S2 / 3.3     | 管理员                    | 点「添加中继」/复制命令                    | 弹框命令 `bash <(curl …/install/relay.sh)`；toast 已复制；Esc/遮罩关闭 | 正常   | ✅ T38（命令文本）                                                   | —                |
| AC-M5-04 | F8 S3 / 3.4     | 管理员                    | `GET /install/relay.sh`                    | 200 脚本内嵌 API URL/内部令牌；审计 `install_script` 不含明文          | 正常   | ✅ T38                                                               | U115             |
| AC-M5-05 | F8 S4           | 内部令牌+合法端口         | `POST /internal/relay-endpoint`            | 记录 host/port/browserHost/lastSeenAt；返回 relayPort/id/healthyRelays | 正常   | ✅ T49/T56                                                           | —                |
| AC-M5-06 | F8 S5           | 平台路由表有项            | `GET /internal/relay-routes`               | `{version,routes[]}`；中继同步；陈旧 5 分钟拒绝新连接                  | 正常   | ✅ T52/T56                                                           | —                |
| AC-M5-07 | F8 S6 / 3.6     | 中继离线、宿主有直连      | 看主机表/抽屉                              | 「中继离线」+「直连不受阻」                                            | 正常   | ✅ T50                                                               | U79              |
| AC-M5-08 | F8 S7 / 3.7     | 双中继                    | `/connect` 看端点；杀一台                  | 只下发存活端点（wss/SNI）；5 次内切换                                  | 正常   | ✅ T52/T49                                                           | —                |
| AC-M5-09 | F8 E1 / 3.2     | 中继 API 失败             | 点「刷新」                                 | 失败提示（`.note.warn` 横幅含原因）+「重试」；旧表保留；成功后提示清除 | 异常   | ✅ T06 QA-013（U136② 实现）                                           | U136②            |
| AC-M5-10 | F8 E2 / 3.4     | 干净 shell                | 粘贴向导命令执行 relay.sh                  | U115 已修复：向导命令照抄可直接执行（一次性下载令牌），不再 401        | 异常   | ✅ T38（U115 修复）                                                  | U115             |
| AC-M5-11 | F8 E3 / 3.5     | 中继静默超窗              | 不刷新页面观察                             | 状态可能长期停留「在线」；无自动轮询（既定语义；刷新失败已有可见提示） | 异常   | ✅ T06 QA-013（1.2s 无轮询，U136② 保持）                               | U136②            |
| AC-M5-12 | F8 E4           | 非法端口 0/70000/abc/缺省 | 注册中继                                   | 400 `RELAY_PORT_INVALID`，节点不注册                                   | 异常   | ✅ T56                                                               | —                |
| AC-M5-13 | F8 E5 / 3.7     | 无存活中继                | `/connect`                                 | 不下发端点；客户端呈现连接错误                                         | 异常   | ✅ T52                                                               | —                |
| AC-M5-14 | F8 E6           | 未知 SNI/非 TLS/超并发    | 连中继                                     | 黑洞/拒绝；不泄露路由                                                  | 异常   | ✅ T51                                                               | —                |
| AC-M5-15 | F8 E7           | 中继离线、宿主直连可达    | 打开项目                                   | 仍可打开；宿主侧标注直连不受阻                                         | 异常   | ✅ T50                                                               | U79              |
| AC-M5-16 | U43             | 中继 announce 带请求体    | `POST relay-endpoint`                      | mtlsFetch https 分支保留请求体，不再 400                               | 回归钉 | ✅ T49                                                               | U43              |
| AC-M5-17 | U38/U39/U64/U79 | 安装/路由/漂移/绑定       | 复跑对应回归                               | 均已在 AC-M4-25/26/28/31 钉住，不重复派生                              | 回归钉 | ✅ 见 M4                                                             | U38/U39/U64/U79  |
| AC-M5-18 | 探索 §6         | 中继页                    | 读表/复制/刷新/Esc                         | 行状态只 在线/离线；地址 host:port；无详情/删除/分页                   | 正常   | 🖐                                                                   | —                |
| AC-M5-19 | F8 S8           | 无存活中继/未知 SNI       | 看 `/connect` 端点、连未知 SNI、观察中继页 | 不下发端点；未知 SNI 黑洞；中继页不自动轮询，离线需刷新/重进           | 正常   | 🖐（T52/T51 覆盖端点与黑洞）                                         | —                |

**覆盖核对表（M5）**

| 操作条目         | 用例号                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| 3.1              | AC-M5-01                                                                                            |
| 3.2              | AC-M5-02、AC-M5-09                                                                                  |
| 3.3              | AC-M5-03                                                                                            |
| 3.4              | AC-M5-04、AC-M5-10                                                                                  |
| 3.5              | AC-M5-11                                                                                            |
| 3.6              | AC-M5-07、AC-M5-15                                                                                  |
| 3.7              | AC-M5-08、AC-M5-13、AC-M5-14                                                                        |
| F8 S8 不可达表现 | AC-M5-19                                                                                            |
| 缺口裁定         | 刷新失败态已实现可见提示+重试并保留旧表（T06 QA-013，U136②）；无自动轮询为既定语义；见 §13 G11（closed） |

---

## M6 用户管理（F9）

来源：`business-flows.md#F9`、`m06-users.md`（3.1–3.12）、`exploratory-r5-paths.md` P1'。

| 用例号   | 来源             | 前置数据                   | 步骤                                | 期望                                                                       | 类型   | 现状                                                      | 关联 U 号 |
| -------- | ---------------- | -------------------------- | ----------------------------------- | -------------------------------------------------------------------------- | ------ | --------------------------------------------------------- | --------- |
| AC-M6-01 | F9 S1 / 3.1      | 管理员                     | 打开 `#/users`                      | 7 列只读表、页头徽标、页脚统计；空态正确                                   | 正常   | ✅ T37                                                    | U81b/U82  |
| AC-M6-02 | F9 S2 / 3.2/3.4  | 用户表有数据               | 关键字输入显示名/账号；点「查询」   | 即输即筛、大小写不敏感；查询兜底一致；无网络请求                           | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-03 | F9 S3 / 3.3      | 用户表                     | 切角色/状态下拉                     | 精确匹配、三条件 AND、即时重绘                                             | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-04 | 3.5/3.6          | 有筛选条件                 | 点「重置」；再筛到无结果            | 恢复全量/控件复位；空态文案 + 页脚筛选 0                                   | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-05 | F9 S4 / 3.7      | 列表有用户                 | 点「详情」                          | 弹框 7 字段；来源当前 users；关闭回焦触发按钮                              | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-06 | F9 S5 / 3.8      | 活跃用户                   | 改角色下拉                          | 下拉立即回退；弹「角色变更」确认；同值不弹                                 | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-07 | F9 S6 / 3.9      | 确认升权                   | 确认并 PUT                          | toast；整页重绘保留筛选；详情来源「管理员覆盖」                            | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-08 | F9 S7 / 3.10     | admin→非 admin             | 确认降级                            | danger 确认；`revoked=true`；旧 token 下一请求失去管控面（≤60s）           | 正常   | ✅ T37                                                    | —         |
| AC-M6-09 | F9 S8            | 有 roleOverride 的用户     | 重新登录                            | 角色按覆盖值，LDAP 组不推导；来源 `admin-override`                         | 正常   | ✅ T37/T32                                                | U69a      |
| AC-M6-10 | F9 S9 / 3.11     | 停用账号                   | 看列表/详情/改角色                  | 显示「已停用」；下拉 disabled 且二次拦截                                   | 正常   | 🖐（无停用入口）                                          | U114-D4   |
| AC-M6-11 | F9 E1 / 3.1      | users API 失败             | 打开页面                            | 「加载失败」+错误文本+「重试」                                             | 异常   | 🖐                                                        | —         |
| AC-M6-12 | F9 E2 / 3.6      | 无匹配条件                 | 查询                                | 单行空态；页脚仍显示总数/筛选 0                                            | 异常   | ✅ T37                                                    | —         |
| AC-M6-13 | F9 E3 / 3.9      | PUT 失败                   | 确认改角色                          | toast「保存失败：…」；重绘回服务端真值（回滚）                             | 异常   | ✅ T37                                                    | —         |
| AC-M6-14 | F9 E4            | 开发者                     | 直达 `#/users`/调 users             | 403 保留 URL；零 `GET /v1/users`；denied 审计                              | 异常   | ✅ T07/T37                                                | —         |
| AC-M6-15 | F9 E5            | 停用账号                   | 直接 PUT roles                      | 409 `USER_DISABLED`「账号已停用，不能修改角色。」+ denied 审计；角色不落库 | 异常   | ✅ U135 `cbbcb130086`（disabled-account-role-update e2e） | U135      |
| AC-M6-16 | F9 E6            | 角色变更后                 | 观察筛选态                          | 整页重绘保留筛选（T66 断言）                                               | 异常   | ✅ T66（筛选态保持）                                      | U114-D4   |
| AC-M6-17 | F9 E7            | roleOverride + LDAP 再登录 | 并发登录                            | 覆盖值优先，无竞态覆盖                                                     | 异常   | ✅ T32                                                    | —         |
| AC-M6-18 | U81/U81b         | 用户管理页                 | 复跑查询四态/只读/详情/角色确认     | 6/6 新 e2e + 回归通过                                                      | 回归钉 | ✅ T37                                                    | U81/U81b  |
| AC-M6-19 | U82              | 用户列表                   | 检查写控件                          | 列表无任何写控件；角色仅详情修改                                           | 回归钉 | ✅ T37                                                    | U82       |
| AC-M6-20 | U74              | 用户搜索/筛选              | 复跑主项                            | 已并入 U81/U82；无分页为设计未承诺                                         | 回归钉 | 🖐                                                        | U74       |
| AC-M6-21 | U114-D4          | 筛选态/停用锁              | 角色变更后观察筛选与停用            | 筛选态保持、停用账号角色控件锁定（T66）                                    | 回归钉 | ✅ T66（筛选态/停用锁）                                   | U114-D4   |
| AC-M6-22 | 探索 P1'-1/2/3/4 | admin                      | 读行数/输入关键字/切筛选/组合重置   | DOM 与 API 同刻一致；空态复用                                              | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-23 | 探索 P1'-5/6/7   | admin 行                   | 打开详情；改角色后取消；读来源列    | 7 字段与 API 一致；取消零 PUT、下拉回滚；来源徽标正确                      | 正常   | ✅ T37                                                    | U81b      |
| AC-M6-24 | F9 S10           | 已登录管理员               | 访问 `#/users/:id`；HEAD 下打开详情 | R3 深链已实现：用户详情直达、刷新保持、关闭回列表                          | 正常   | ✅ T64（R3 用户深链）                                     | U106      |

**覆盖核对表（M6）**

| 操作条目                | 用例号                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------- |
| 3.1                     | AC-M6-01、AC-M6-11                                                                  |
| 3.2                     | AC-M6-02、AC-M6-22                                                                  |
| 3.3/3.4                 | AC-M6-03、AC-M6-22                                                                  |
| 3.5                     | AC-M6-04                                                                            |
| 3.6                     | AC-M6-04、AC-M6-12                                                                  |
| 3.7                     | AC-M6-05、AC-M6-23                                                                  |
| 3.8                     | AC-M6-06、AC-M6-23                                                                  |
| 3.9                     | AC-M6-07、AC-M6-13                                                                  |
| 3.10                    | AC-M6-08                                                                            |
| 3.11                    | AC-M6-10、AC-M6-21                                                                  |
| 3.12                    | AC-M6-05                                                                            |
| F9 S10 深链（设计目标） | AC-M6-24                                                                            |
| 缺口裁定                | U114-D4 补测；停用账号服务端校验缺口建议登记；页头 LDAP 徽标已由 U145 改为事实性展示（准入组/未配置，不声明同步状态） |

---

## M7 审计（F6）

来源：`business-flows.md#F6`、`m07-audit.md`（3.1–3.12）、`exploratory-r5-paths.md` P2'。

| 用例号   | 来源               | 前置数据                  | 步骤                                                  | 期望                                                                     | 类型   | 现状                                                                          | 关联 U 号        |
| -------- | ------------------ | ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------- | ---------------- |
| AC-M7-01 | F6 S1 / 3.1        | 管理员/审计员             | 打开 `#/audit`                                        | 并行四请求；events 成功即可；表/缺口横幅/覆盖块/操作目录                 | 正常   | ✅ T28                                                                        | —                |
| AC-M7-02 | F6 S2、F6 S3 / 3.2 | 已打开                    | 设置关键字/时间/操作/用户/项目/主机/文件名/结果并查询 | 客户端校验→写 filter→清 cursor→请求；结果表更新                          | 正常   | ✅ T28/T29                                                                    | U86              |
| AC-M7-03 | 3.3                | 有筛选                    | 点「清除」                                            | filter 清空、累积清空、回默认 7 天                                       | 正常   | ✅ T28                                                                        | —                |
| AC-M7-04 | F6 S5 / 3.4        | 首屏有 nextCursor         | 点「加载更早」                                        | cursor 追加 50 条，不与新查询混表                                        | 正常   | ✅ T06 QA-002（50→全量，耗尽后按钮移除）                                      | —                |
| AC-M7-05 | F6 S7 / 3.5/3.6    | 结果含文件名/traceId      | 点文件名；点 traceId「复制」                          | 复制 path/缺省 fileName 与 traceId；toast「已复制」                      | 正常   | ✅ 文件名复制 U66-5-7（path+toast）；traceId T06 QA-004                       | —                |
| AC-M7-06 | F6 S6 / 3.7        | 有 `file_copy` 行         | 点「展开/收起」                                       | 摘录/`sha256`/字符与字节数；无摘录「仅保留指纹」；不重查                 | 正常   | ✅ T28                                                                        | U74              |
| AC-M7-07 | F6 S4 / 3.8        | 关键字/文件名命中         | 查询                                                  | 命中文案 `<mark>` 高亮，大小写不敏感                                     | 正常   | ✅ T29                                                                        | U78              |
| AC-M7-08 | 3.9/3.10           | 选「最近 31 天」/手动起止 | 查询                                                  | 钳 31 天−5 分钟并钉 until；显式边界优先；越界前端拦截                    | 正常   | ✅ T28/T29                                                                    | U97              |
| AC-M7-09 | 3.11               | 快速连续查询              | 连续改条件查询                                        | generation latest-wins，旧请求不落 state/不渲染                          | 正常   | ✅ T32                                                                        | U73              |
| AC-M7-10 | F6 E1 / 3.2        | 非法条件                  | 提交                                                  | `#auditError` 显示原因且零请求                                           | 异常   | ✅ T28                                                                        | —                |
| AC-M7-11 | F6 E2 / 3.2        | 服务端拒绝（如窗口/权限） | 查询                                                  | 横幅「查询失败：…（下方为上次结果）」；旧行保留                          | 异常   | ✅ T28                                                                        | —                |
| AC-M7-12 | F6 E3 / 3.1        | events 首屏失败           | 打开页面                                              | 「加载失败」+错误文本+「重试」                                           | 异常   | ✅ U66-5-8（首屏失败文案+重试恢复）                                           | —                |
| AC-M7-13 | F6 E4 / 3.11       | 快速查询被取代            | 观察                                                  | 被取代请求不渲染，失败静默                                               | 异常   | ✅ T32                                                                        | U73              |
| AC-M7-14 | F6 E5              | 审计员身份                | 看项目/主机下拉                                       | 空列表显示「无可见项目（需 open 授权）」/「无可见主机（需主机权限）」，事件照常渲染；不得按「有数据」判通过     | 异常   | ✅ T32 U72-4（解释文案 + 事件照常）                                           | U136③            |
| AC-M7-15 | F6 E6              | 无匹配条件                | 查询                                                  | 单行「没有符合筛选条件的审计事件」                                       | 异常   | ✅ T28                                                                        | —                |
| AC-M7-16 | F6 E7 / 3.12       | 开发者                    | 直达 `#/audit`；调 events/status/verify               | 403 保留 URL；零查询；API 403 + `audit_query` denied                     | 异常   | ✅ T32/T29                                                                    | U72              |
| AC-M7-17 | U66                | 文件事件族                | 复跑三类事件/查询/UI                                  | file_download/file_copy/download_blocked 语义与筛选正确                  | 回归钉 | ✅ T28/T29/T30                                                                | U66              |
| AC-M7-18 | U71                | 宿主 auditGap             | 心跳 delta 上报                                       | 同值不刷屏、变化落增量、重启只记一次                                     | 回归钉 | ✅ T31                                                                        | U71              |
| AC-M7-19 | U72                | 审计员 Web                | 导航/直达/接口                                        | 仅审计入口；目录 API 仍 admin-only                                       | 回归钉 | ✅ T32                                                                        | U72              |
| AC-M7-20 | U73                | 并发查询                  | 双击查询/清除后查询                                   | latest-wins，不混表                                                      | 回归钉 | ✅ T32                                                                        | U73              |
| AC-M7-21 | U78                | 接入类事件                | 操作类型下拉/查询                                     | `status.eventTypes` 派生目录；旧平台 fallback                            | 回归钉 | ✅ T29                                                                        | U78              |
| AC-M7-22 | U86                | 1440 视口                 | 读 10 控件坐标并聚类                                  | 恰好 3 行、不重叠/不越界；无底部提示                                     | 回归钉 | 🖐（几何无自动化）                                                            | U86/U114-D4      |
| AC-M7-23 | U97                | 选「最近 31 天」          | 查询                                                  | 钳边界、错误横幅可见并标注「下方为上次结果」                             | 回归钉 | ✅ T28                                                                        | U97              |
| AC-M7-24 | U74                | `file_copy` 摘录          | 真实入口查看                                          | 摘录分支经真实入口不可达（二期开关）；`download_blocked` 恒 advisory     | 回归钉 | 🖐                                                                            | U74              |
| AC-M7-25 | U114-D4            | 审计页断点                | 1100/700 视口                                         | 断点契约已钉：12 列→1100px 6 列→700px 2 列（T67）                        | 回归钉 | ✅ T67（网格断点契约）                                                        | U114-D4          |
| AC-M7-26 | 探索 P2'-1/2/3     | 1440 视口                 | 读网格/底部提示/页头                                  | 三行网格；旧提示不存在；页头含「最大 31 天/已显示 N 条」                 | 正常   | 🖐（P2'-1/2 可手测）                                                          | U86              |
| AC-M7-27 | 探索 P2'-4         | 有 login 事件             | 操作=login、用户=admin、结果=success、7 天查询        | DOM 行数=API；页头一致；31 天预设当前不可用（R5-OBS-01）                 | 正常   | ✅ T29（31 天边界 T28）                                                       | U97              |
| AC-M7-28 | F6 S8              | 宿主有审计缺口            | 打开审计页，展开覆盖范围折叠块                        | 缺口横幅（宿主数/计数，best-effort）；覆盖块四段                                                                     | 正常   | 🖐（横幅 UI 无断言）                                                          | U71              |
| AC-M7-29 | F6 S9              | 管理员/审计员             | 调 `GET /v1/audit/verify`                             | 200 `{ok:true}`/409 断链；写 `audit_verify`；控制台「校验审计链」按钮展示结果                                       | 正常   | ✅ T33（API）+ T32 U72-5（控制台成功/409）                                    | U136③            |
| AC-M7-30 | F6 S9 / 3.12       | 管理员/审计员身份         | 展开「链健康与容量（只读）」                          | 展示 `chain.ok/lastSeq`、容量今日/累计与 envelope、persisted；不再隐藏链健康/容量                                   | 正常   | ✅ T32 U72-5                                                                  | U136③            |

**覆盖核对表（M7）**

| 操作条目 | 用例号                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| 3.1      | AC-M7-01、AC-M7-12                                                                                                  |
| 3.2      | AC-M7-02、AC-M7-10、AC-M7-11                                                                                        |
| 3.3      | AC-M7-03                                                                                                            |
| 3.4      | AC-M7-04                                                                                                            |
| 3.5/3.6  | AC-M7-05                                                                                                            |
| 3.7      | AC-M7-06                                                                                                            |
| 3.8      | AC-M7-07                                                                                                            |
| 3.9/3.10 | AC-M7-08                                                                                                            |
| 3.11     | AC-M7-09、AC-M7-13                                                                                                  |
| 3.12     | AC-M7-14、AC-M7-25、AC-M7-30（链健康/容量 UI）                                                                     |
| F6 S8/S9 | AC-M7-28（缺口/覆盖块）、AC-M7-29（链校验 API+UI）、AC-M7-30（链健康/容量）                                        |
| 缺口裁定 | 审计链健康/容量水位与 verify 入口已由 U136③ 实现（T32 U72-5）；文件名复制/审计首屏失败/缺口横幅仍补测；审计员下拉已解释（T32 U72-4） |

---

## M8 平台设置（下载策略）

来源：`m08-settings.md`（3.1–3.7）、F2/F5 的下载策略分支。

| 用例号   | 来源         | 前置数据               | 步骤                       | 期望                                                                             | 类型   | 现状                                       | 关联 U 号    |
| -------- | ------------ | ---------------------- | -------------------------- | -------------------------------------------------------------------------------- | ------ | ------------------------------------------ | ------------ |
| AC-M8-01 | 3.1          | 管理员                 | 打开 `#/settings`          | 全局卡/范围统计/覆盖表或空态；并发取策略+projects                                | 正常   | ✅ T47                                     | —            |
| AC-M8-02 | 3.2          | 管理员                 | 切全局 radio 后保存        | PUT 成功 toast；整页重绘；跟随项目生效                                           | 正常   | ✅ T47                                     | M120c        |
| AC-M8-03 | 3.3          | 有 explicit 项目       | 改覆盖行下拉               | change 即 PUT；toast；重绘并恢复滚动/焦点                                        | 正常   | ✅ T47                                     | U30          |
| AC-M8-04 | 3.4          | 有 explicit 项目       | 选「跟随全局」             | PUT `{inherit:true}`；行移出覆盖表；统计减一                                     | 正常   | ✅ T47/T48                                 | —            |
| AC-M8-05 | 3.5          | 全局翻转               | 从 deny→allow              | 钉住项目不变；跟随项目生效值同步到工作台/项目列                                  | 正常   | ✅ T47                                     | —            |
| AC-M8-06 | 3.6          | 有归档项目             | 打开设置页                 | 归档项目从统计与覆盖表剔除                                                       | 正常   | ✅ T48                                     | —            |
| AC-M8-07 | 3.7          | 设置页                 | 关闭/刷新页面              | 无草稿保护；保存均为即时请求                                                     | 正常   | 🖐                                         | —            |
| AC-M8-08 | 3.1 失败     | 策略/projects API 失败 | 打开页面                   | 「加载失败」+错误文本+「重试」                                                   | 异常   | 🖐                                         | —            |
| AC-M8-09 | 3.2 失败     | 全局 PUT 失败          | 保存                       | toast「保存失败：…」并按服务端值重绘（不保留未落库值）                           | 异常   | ✅ T06 QA-009                              | —            |
| AC-M8-10 | 3.3 失败     | 行级 PUT 失败          | 改覆盖行                   | toast + 回服务端值；行不重复、不回弹页顶                                         | 异常   | ✅ T47                                     | M120c2       |
| AC-M8-11 | 非管理员     | 开发者                 | 直达 `#/settings`/直调 PUT | 403 页保留 URL；零写请求；API 403                                                | 异常   | ✅ T07/T47                                 | —            |
| AC-M8-12 | U30          | 行级保存               | 复跑滚动/焦点              | 保存成功后保留滚动位置与 select 焦点                                             | 回归钉 | ✅ T47                                     | U30          |
| AC-M8-13 | M120c/M120c2 | 设置页                 | 复跑覆盖/继承/失败回滚     | inherit 清除覆盖与审计 metadata 正确；失败不静默                                 | 回归钉 | ✅ T47/T48                                 | M120c/M120c2 |
| AC-M8-14 | U70          | 全局策略翻转           | 等宿主拉取                 | U70 C+② 已实现：readChunk 单窗 >64KB 前置拒绝；首窗 ≤64KB/乱序不累计仍为声明残余 | 回归钉 | 🖐（guard 7 单测；多窗口端到端真机待复跑） | U70          |
| AC-M8-15 | AC-M8-09 后继 | 两位管理员、策略 vN        | A 读 vN 后 B 先保存，A 再保存 | PUT 带 `expectedVersion=N`；409 `POLICY_VERSION_CONFLICT` 时卡内黄条报「策略已被他人修改」+ 服务端版本/当前值，radio 保留 A 的选择；「刷新后重试」重新 GET 后以新版本重放成功；正常保存版本加一 | 异常   | ✅ T47 U136④b                             | U136④b      |

**覆盖核对表（M8）**

| 操作条目 | 用例号                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 3.1      | AC-M8-01、AC-M8-08                                                                                   |
| 3.2      | AC-M8-02、AC-M8-09、AC-M8-15                                                                         |
| 3.3      | AC-M8-03、AC-M8-10                                                                                   |
| 3.4      | AC-M8-04                                                                                             |
| 3.5      | AC-M8-05                                                                                             |
| 3.6      | AC-M8-06                                                                                             |
| 3.7      | AC-M8-07                                                                                             |
| 缺口裁定 | 全局保存失败 UI 已闭合（T06 QA-009）；并发版本冲突已实现（U136④：409 保留输入+刷新重试，G29 closed）；移动端布局仍未覆盖 |

---

## M9 Orca Web 工作区（F3/F4）

来源：`business-flows.md#F3/#F4`、`m09-orca-web.md`（§3.1–§3.4）、`workspace-paths.md` P1/P18–P23、`desktop-paths.md` Path B/F。

| 用例号   | 来源          | 前置数据                                 | 步骤                                                                  | 期望                                                                                                     | 类型   | 现状                                    | 关联 U 号 |
| -------- | ------------- | ---------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- | --------- |
| AC-M9-01 | F3 S1         | 项目 open、主机在线                      | 管理台点「打开」                                                      | mint 一次性 handoff（admin surface）；全屏覆盖层；顶栏项目/分支                                          | 正常   | ✅ R01/R03                              | —         |
| AC-M9-02 | F2 S9/F3 S2   | handoff URL                              | 嵌入页读 hash→抹 code→兑换→workspace.info→repo.add→provision→activate | ready/fallback；code 立即消失；按 file:read 挂 Explorer                                                  | 正常   | ✅ R03/R20                              | —         |
| AC-M9-03 | F3 S3         | 宿主支持 `cloud.session-tabs-restore.v1` | 进入工作区                                                            | 拉宿主镜像、应用快照；每次进入 `adoptHostLayout` 一次；之后 client-owned                                 | 正常   | ✅ R07/R17                              | U104/U96  |
| AC-M9-04 | F3 S4 / F4 S2 | 宿主有终端历史上限内                     | 订阅回放                                                              | 512 KiB/1000 行；超限 `truncated`；PTY 死显示「会话已结束」+重开                                         | 正常   | ✅ R14/R13                              | —         |
| AC-M9-05 | F2 S10/F3 S5  | 工作区有脏文件                           | 关闭覆盖层                                                            | 三选确认；握手后移除覆盖层；回原路由；PTY 按 suspend 保留                                                | 正常   | ✅ R08/R15                              | —         |
| AC-M9-06 | F3 S6         | 持久 `orca.webCloudSession`              | 刷新嵌入页/Orca Web；管理台覆盖层刷新                                 | 嵌入页与管理台覆盖层刷新均静默续会话回同一 project                                                       | 正常   | ✅ R04/R05/T65（R4 覆盖层刷新）         | U103/U106 |
| AC-M9-07 | F3 S7         | 同一项目已打开过一次                     | 第 2/N 次打开                                                         | 每次进入收养宿主镜像组/active/layout；客户端已有本地组后宿主 layout 不覆盖                               | 正常   | ✅ R07                                  | U104      |
| AC-M9-08 | F3 S8         | 设计目标                                 | 标签级 URL/`#/workspace/:id`/筛选入 URL                               | R4/R5 已实现：#/workspace/:id 与筛选入 URL；标签级 URL 未承诺                                            | 正常   | ✅ T65（R4/R5 URL 路由+筛选）           | U106      |
| AC-M9-09 | F3 E1         | handoff 已用/过期/无权限                 | 兑换                                                                  | `HANDOFF_GONE`/`PROJECT_FORBIDDEN`/`network_error` 文案；保留登录入口                                    | 异常   | ✅ R03                                  | —         |
| AC-M9-10 | F3 E2         | 20 秒未就绪                              | 观察覆盖层                                                            | 超时态；可重试（≤2 次）/新标签逃生                                                                       | 异常   | ✅ R01/R03                              | —         |
| AC-M9-11 | F3 E3         | 旧宿主无 capabilities                    | 进入工作区                                                            | 视为不支持恢复；零 `session.tabs.*` 探测；降级无恢复                                                     | 异常   | ✅ R21/R17                              | —         |
| AC-M9-12 | F3 E4         | project 不可见/无 open                   | 打开项目                                                              | W3 已实现：不可见/无 open 返回 403/404 终态页，不静默换项目                                              | 异常   | ✅ R22/R03（W3 403/404 终态页）         | U106      |
| AC-M9-13 | F3 E5         | 管理台刷新覆盖层                         | 刷新页面                                                              | R4 已实现：覆盖层刷新按同一 hash 重建并重新 mint                                                         | 异常   | ✅ T65（R4 覆盖层刷新保持）             | U106      |
| AC-M9-14 | F3 E6         | 二次打开历史缺陷                         | 关闭后再次打开                                                        | 不再出现 `NOT_SIGNED_IN`；回归套件钉住                                                                   | 异常   | ✅ R07                                  | U104      |
| AC-M9-15 | F3 E7         | 订阅断流                                 | 断网/宿主重启                                                         | D5 已实现：断流 500/1000/2000ms 退避重连                                                                 | 异常   | ✅ R17/R08（U112 D5 退避）              | U112 D5   |
| AC-M9-16 | F3 E8         | 文件/编辑器标签                          | 关闭重开                                                              | 仅终端标签+分组+内容恢复；文件标签不恢复为用户裁定（U100）                                               | 异常   | ✅ R08/R14（按裁定验收）                | U100      |
| AC-M9-17 | U96           | A 链整体                                 | 复跑标签组/终端恢复                                                   | U96 A 链 8 站与 U99 已闭：标签组/终端恢复、二开与刷新稳定                                                | 回归钉 | ✅ R02/R07（U96 A 链 8 站；U99 已闭）   | U96/U99   |
| AC-M9-18 | U103          | 刷新停在旧登录页                         | 复跑嵌入页 reload                                                     | B1 静默续会话+B2 预填：自动回工作区，不显示登录页                                                        | 回归钉 | ✅ R04/R05                              | U103      |
| AC-M9-19 | U104          | 第 2 次打开                              | 复跑 reentry                                                          | 每次进入收养宿主布局，不丢标签组                                                                         | 回归钉 | ✅ R07                                  | U104      |
| AC-M9-20 | U106          | 全站 URL                                 | 复跑 W1 项目上下文/深链                                               | W1+R4/R5：?api&project 保留，工作区/筛选深链已实现                                                       | 回归钉 | ✅ R06/T65（W1+R4/R5）                  | U106      |
| AC-M9-21 | U113          | A 批审计                                 | 复跑二次打开采纳触发/时序/capability                                  | A-fix1 自动化已落（D2/D3/D4）；真机 2 组×3 标签复跑待发布                                                | 回归钉 | ✅ 真机矩阵 9/9（evidence/u113-retest/summary.json）（A-fix1 自动化已落；真机复跑待发布） | U113      |
| AC-M9-22 | U100          | 文件标签                                 | 关闭重开                                                              | 文件/编辑器标签不恢复；验收不得按设计字面判失败                                                          | 回归钉 | ✅ 裁定项（R08）                        | U100      |
| AC-M9-23 | U109          | 编译产物                                 | 检查 web 域构建                                                       | 无编译产物遮蔽源文件                                                                                     | 回归钉 | ✅ 构建                                 | U109      |
| AC-M9-24 | 探索 P1       | admin、demo-app                          | 工作台「打开」→等 ready                                               | 1 次 admin handoff；iframe 为 `cloud-admin.html?...embed=1`；hash 无 handoff；路线 badge；零 window.open | 正常   | ✅ R01                                  | —         |
| AC-M9-25 | 探索 P19/P20  | 同一浏览器 profile                       | 首开→关闭→二开；制造失败后重试/新标签                                 | 二开应 ready；失败态有重试/新标签逃生                                                                    | 异常   | ✅ R07（修复后）；🖐 失败态             | U104      |
| AC-M9-26 | 探索 P21      | dev-local-03、infra-tools                | 跨主机首开、开文件、终端 touch                                        | 状态栏项目/主机/分支正确；marker 落 host2                                                                | 正常   | ✅ R02                                  | —         |
| AC-M9-27 | 探索 P22      | lisi 只读                                | 打开 demo-app                                                         | W3 降级终态页：forbidden/失效显示明确错误，不长时间准备                                                  | 异常   | ✅ R22（W3 降级终态页）                 | U106 W3   |

**覆盖核对表（M9）**

| 操作条目                             | 用例号                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| §2 handoff 免登/直链/续会话/登录表单 | AC-M9-01、AC-M9-02、AC-M9-06、AC-M9-09                                                                              |
| §3.1 bootstrap 1–6                   | AC-M9-02、AC-M9-11                                                                                                  |
| §3.2 标签组恢复/新建/关闭/多组       | AC-M9-03、AC-M9-07、AC-M9-14、AC-M9-17                                                                              |
| §3.3 回放/ended/断流                 | AC-M9-04、AC-M9-15                                                                                                  |
| §3.4 刷新/二次打开/真栈复跑          | AC-M9-06、AC-M9-07、AC-M9-25                                                                                        |
| 缺口裁定                             | 管理台覆盖层刷新/`#/workspace/:id`/project 403 视图（U106 R4/W3）登记；U113 真机复跑；多组 U99 复验；旧宿主真机矩阵 |

---

## M10 简易工作区（F4）

来源：`business-flows.md#F4`、`m10-simple-workspace.md`（§3.1–§3.4）、`workspace-paths.md` P2–P18、`exploratory-r5-paths.md` P3'。

| 用例号    | 来源         | 前置数据                         | 步骤                                              | 期望                                                                               | 类型   | 现状                                | 关联 U 号 |
| --------- | ------------ | -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ | ----------------------------------- | --------- |
| AC-M10-01 | F4 S1        | 工作区就绪，宿主支持 create      | 点「+ 终端」                                      | 本地先加终端标签→`terminal.create`→`session.tabs.activate`；失败保留本地并降级一次 | 正常   | ✅ R08/R10                          | U107      |
| AC-M10-02 | F4 S2        | 终端已存在                       | attach/订阅                                       | `desktopViewportClaims:1` 被动观察；快照 512 KiB/1000 行；超限 truncated           | 正常   | ✅ R13/R14                          | U98       |
| AC-M10-03 | F4 S3        | 同一宿主 PTY                     | 多视图订阅/输入                                   | 输入经宿主 PTY 回显到同一 handle；多端为同一 PTY 视图                              | 正常   | ✅ R16/R13                          | —         |
| AC-M10-04 | F4 S4        | 多标签                           | 激活标签                                          | 本地 activate；宿主型额外 `session.tabs.activate`；应用宿主帧不回写                | 正常   | ✅ R10/R08                          | U112 D3   |
| AC-M10-05 | F4 S5        | 终端/文件/Diff 标签              | 关闭标签                                          | 宿主型先 `session.tabs.close` 成功才移除；文件本地 reducer；dirty 进确认           | 正常   | ✅ R10/R08                          | U108      |
| AC-M10-06 | F4 S6        | 覆盖层收起/legacy close/logout   | suspend                                           | 销毁 xterm/流/socket 但保留宿主 PTY；回复 suspended/closed                         | 正常   | ✅ R08/R15                          | —         |
| AC-M10-07 | F2 S10/F4 S7 | 宿主声明支持 end                 | 点「结束工作区」                                  | D1 已实现：ending→runEndCleanup→关 socket→ended，关闭宿主 PTY 并退役行             | 正常   | ✅ R08/R16（U112 D1）               | U112 D1   |
| AC-M10-08 | F4 S8        | 投影后有 pending-handle 带 ptyId | 重进工作区                                        | `terminal.list(requireFreshPtyLiveness)` 匹配→`adoptOrphans`；每 bootstrap 一次    | 正常   | ✅ R12                              | —         |
| AC-M10-09 | F4 S9        | PTY 已死/宿主重启                | 看终端面板                                        | 「会话已结束（宿主已重启或终端已退出）」+同标签一键重开；不显示空白假活            | 正常   | ✅ R14                              | U112 D2   |
| AC-M10-10 | F4 E1        | 宿主拒绝关闭                     | 关闭标签                                          | `refused` 保留标签并显示提示（live-host-pty/retirement-owner/stale/unknown）       | 异常   | ✅ R10/R08                          | —         |
| AC-M10-11 | F4 E2        | 连接不可用                       | 关闭标签                                          | `local` 走本地关闭并提示「连接不可用」                                             | 异常   | ✅ R10                              | —         |
| AC-M10-12 | F4 E3        | pending-handle 行                | 等它变结束                                        | D2 已实现：pending 10s 超时转 ended，可显式重开                                    | 异常   | ✅ R16/R08（U112 D2）               | U112 D2   |
| AC-M10-13 | F4 E4        | 另一端控制尺寸                   | 本端观察                                          | 渲染 `CloudTerminalFitOverlay`（保持/接管/恢复）；自动恢复文案                     | 异常   | ✅ R13/R16                          | U98       |
| AC-M10-14 | F4 E5        | 订阅断流                         | 断网/重连                                         | D5 已实现：断流退避重连                                                            | 异常   | ✅ R17/R08（U112 D5）               | U112 D5   |
| AC-M10-15 | F4 E6        | 已有 6 个终端                    | 再点「+ 终端」                                    | 第 7 个禁用，title「最多 6 个终端」；关一个后恢复                                  | 异常   | ✅ R08/R10                          | —         |
| AC-M10-16 | F4 E7        | 文件标签 dirty                   | 关闭标签                                          | 三选「保存/放弃/取消」；取消保留 buffer；放弃不落盘；保存后关                      | 异常   | ✅ R08                              | —         |
| AC-M10-17 | F4 E8        | 宿主不支持新建终端               | 新建终端                                          | 本地标签保留；降级一次不重试                                                       | 异常   | ✅ R10                              | —         |
| AC-M10-18 | F4 E9        | 多标签组                         | 恢复 2 组                                         | U99 已闭：2 组恢复可用（R18 单测）                                                 | 异常   | ✅ R18（U99 已闭 1cace8bc18f）      | U99       |
| AC-M10-19 | U98          | 订阅 attach                      | 复跑被动观察/overlay                              | 不再一开终端就 claim fit floor；四态 overlay 正确                                  | 回归钉 | ✅ R13/R16                          | U98       |
| AC-M10-20 | U112 D1      | 显式 end                         | 复跑「结束工作区」                                | D1 已实现：结束工作区退役 attached/reopened PTY 与 inventory 行                    | 回归钉 | ✅ R08/R16（U112 D1）               | U112 D1   |
| AC-M10-21 | U112 D2      | pending-handle                   | 复跑过渡                                          | D2 已实现：pending 可达 ended 并显式重开                                           | 回归钉 | ✅ R16/R08（U112 D2）               | U112 D2   |
| AC-M10-22 | U112 D3      | 激活回环                         | 复跑宿主帧/用户手势                               | 用户手势才回写；应用宿主帧不回写，无陈旧 ref                                       | 回归钉 | ✅ R10                              | U112 D3   |
| AC-M10-23 | U112 D4      | 失败/并发关闭                    | 复跑瞬时失败与双端关闭                            | D4 已实现：按动作类型降级、重复 close 幂等，不误触发并发关闭                       | 回归钉 | ✅ R16/R08（U112 D4）               | U112 D4   |
| AC-M10-24 | U112 D5      | 断流                             | 复跑退避重连                                      | D5 已实现：500/1000/2000ms 退避重连                                                | 回归钉 | ✅ R17/R08（U112 D5）               | U112 D5   |
| AC-M10-25 | U112 D6      | 无 owner 首开                    | 观察尺寸接管                                      | D6 characterization 已钉现状（无 owner 首开尺寸接管）                              | 回归钉 | ✅ R16（U112 D6 characterization）  | U112 D6   |
| AC-M10-26 | U112 D7      | 证据                             | 复核证据链                                        | 修复证据不得失真                                                                   | 回归钉 | 🖐                                  | U112 D7   |
| AC-M10-27 | U112 D8      | 旧非法 id                        | 打开/恢复旧标签                                   | D8 已实现：旧非法 id 不再崩溃/假活（合法 id 迁移）                                 | 回归钉 | ✅ R16/R17（U112 D8）               | U112 D8   |
| AC-M10-28 | U107         | 新建终端                         | 检查 tabId/leafId                                 | 客户端生成 `terminal-<uuid>`+裸 UUID；无双份风险                                   | 回归钉 | ✅ R10/R11                          | U107      |
| AC-M10-29 | U108         | 新建/关闭标签                    | 检查镜像持久化/退役                               | 图代数围栏生效；镜像退役；close 语义正确                                           | 回归钉 | ✅ R11/R08                          | U108      |
| AC-M10-30 | U96          | B 链整体                         | 复跑端到端                                        | B-令多数落地；端到端验收未闭合                                                     | 回归钉 | 🖐                                  | U96       |
| AC-M10-31 | 探索 P2/P3   | 工作区就绪                       | 读外壳/文件树/过滤/刷新                           | 无左栏；文件/Git 双 tab；状态栏字段；空目录/过滤/刷新保层级                        | 正常   | ✅ R08                              | —         |
| AC-M10-32 | 探索 P4–P13  | 文件样本齐全                     | 打开文本/图片/PDF/drawio/二进制/Markdown/HTML/Git | 去重/着色；预览沙箱；PDF/drawio 降级；二进制占位；Git 分组一致                     | 正常   | ✅ R08（FS 套件）                   | —         |
| AC-M10-33 | 探索 P14/P15 | 多标签+终端                      | 混合标签关闭邻接；终端 echo/上限                  | 邻接激活；同文件共槽；6 上限；marker 落宿主                                        | 正常   | ✅ R08/R10                          | —         |
| AC-M10-34 | 探索 P16/P18 | dirty 文件                       | 标签关闭三选；覆盖层关闭 dirty confirm            | 三选行为正确；覆盖层移除且路由不变                                                 | 正常   | ✅ R08                              | —         |
| AC-M10-35 | 探索 P17     | 覆盖层开着                       | 程序化点退出                                      | 覆盖层移除；iframe signOut；平台登录页                                             | 正常   | ✅ R09                              | —         |
| AC-M10-36 | 探索 r5 P3'  | demo-app、终端实时               | 测填满/resize/回显徽标/长输出                     | panel 填满 pane；resize 跟随；`echo Nms p95` 徽标随输入更新；长输出不改布局        | 正常   | ✅ R08（U83/U84a 断言；几何需手测） | U83/U84a  |

**覆盖核对表（M10）**

| 操作条目                             | 用例号                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| §3.1 标签（新建/激活/关闭/宿主推送） | AC-M10-01、AC-M10-04、AC-M10-05、AC-M10-10、AC-M10-11、AC-M10-15、AC-M10-17           |
| §3.2 attach/尺寸                     | AC-M10-02、AC-M10-03、AC-M10-13、AC-M10-19、AC-M10-36                                 |
| §3.3 suspend/end                     | AC-M10-06、AC-M10-07、AC-M10-20、AC-M10-22、AC-M10-23                                 |
| §3.4 孤儿恢复                        | AC-M10-08、AC-M10-12、AC-M10-18、AC-M10-21                                            |
| 缺口裁定                             | U112 D1/D2/D4/D5/D6、U99、U96 端到端列入缺口；U112 D7/D8 需手测复核；双端并发关闭补测 |

---

## M11 授权与角色体系（F5）

来源：`business-flows.md#F5`、`m11-authz-model.md`（§3/§4）、`authz-combo-paths.md` D1–D5/M1–M4、`authz-api-combo-paths.md`。

| 用例号    | 来源           | 前置数据                          | 步骤                                      | 期望                                                                         | 类型   | 现状                                           | 关联 U 号     |
| --------- | -------------- | --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- | ------ | ---------------------------------------------- | ------------- |
| AC-M11-01 | F5 S1          | 管理员，项目/主机有授权           | 打开权限页                                | 先缓存后 GET grants；三卡/主体数/断会话脚注                                  | 正常   | ✅ T23/T12                                     | —             |
| AC-M11-02 | F5 S2          | 有目录数据                        | 切换用户/组 datalist                      | 建议项来自 `GET /v1/directory`；未知主体提交被拒                             | 正常   | ✅ T24                                         | —             |
| AC-M11-03 | F5 S3          | 项目/主机权限页                   | 添加到卡片                                | 位并集整行 PUT；成功 toast 合成级别+重绘                                     | 正常   | ✅ T23/T24                                     | U65           |
| AC-M11-04 | F5 S4          | 同主体已有行                      | 再次添加                                  | 「覆盖现有授权」确认（级别变化+断会话）；取消零请求                          | 正常   | ✅ T06                                         | U65           |
| AC-M11-05 | F5 S5          | 已有芯片                          | 移除芯片                                  | 减位 PUT；非空 toast；空则「移除全部授权」确认                               | 正常   | ✅ T23/T06                                     | U65           |
| AC-M11-06 | F5 S6          | 主机 view / view+provision / 无位 | connect 后读票据 perms 并调宿主方法       | 全权=六操作位；仅 view=上限 `open+file:read`；无位=项目行；宿主按方法拒绝    | 正常   | ✅ T22/T27                                     | U65           |
| AC-M11-07 | F5 S7          | admin→非 admin 或授权收缩         | 观察被降级用户                            | 服务端撤凭证（≤60s 心跳）；下一请求失权/被踢                                 | 正常   | ✅ T37（角色降级）；✅ U136⑤（主机授权收缩）    | U136⑤         |
| AC-M11-08 | F5 S8          | 管理员操作授权                    | 查审计                                    | `grant_update`/`host_grant_update`/`role_update`；拒绝同名 denied            | 正常   | ✅ T22/T60                                     | U62           |
| AC-M11-09 | F5 S9 / C12    | 管理员无 open                     | 「授权并打开」                            | 确认 5 位+断会话警告→PUT 自授→打开                                           | 正常   | ✅ T14                                         | U40/AA5       |
| AC-M11-10 | F5 E1          | 未知组/用户/非法位                | 添加授权                                  | 平台文案 toast；输入保留；控件冻结后恢复                                     | 异常   | ✅ T24/T23                                     | U62           |
| AC-M11-11 | F5 E2          | 写请求失败                        | 添加/移除                                 | toast「授予/移除失败：…」；重拉 GET 重绘；输入保留                           | 异常   | ✅ T06                                         | —             |
| AC-M11-12 | F5 E3          | 非管理员                          | 调项目/主机 grants                        | 主机端点 admin-only、项目 admin/owner；403+denied；入口不渲染                | 异常   | ✅ T22/T07                                     | —             |
| AC-M11-13 | F5 E4          | 管理员无 open                     | 看打开按钮                                | disabled+title；提供「授权并打开」；取消零请求                               | 异常   | ✅ T14/T13                                     | U40/AA5       |
| AC-M11-14 | F5 E5          | 主机只读授权                      | 项目内看有效位                            | 强制裁剪为 `open+file:read`，即使项目行授 terminal/write 也不进票据          | 异常   | ✅ T22/T27                                     | U65           |
| AC-M11-15 | F5 E6          | 仅项目级授权                      | 查主机可见性/创建/维护                    | 项目授权不扩大到主机级；仅 provision/maintain 混合位不推导可见性             | 异常   | ✅ T22/T27                                     | U65           |
| AC-M11-16 | F5 E7          | 主机授权收缩                      | 端到端观察凭证撤销                        | 有效位收缩撤销受影响用户（user=本人、group=组员，扩容/同值不撤销）；审计带 removedPermissions/revokedUsers/accessLevel；其余用户不受影响 | 异常   | ✅ U136⑤（host-authorization e2e 2 例）        | U136⑤         |
| AC-M11-17 | F5 E8          | 审定二                            | 看三卡片语义                              | U67 审定二已实现：三卡片层级单卡（查看/控制/管理），位置即权限               | 异常   | ✅ T23/T12（U67 审定二+审计 PASS）             | U67/U67b      |
| AC-M11-18 | U65            | 主机授权                          | 复跑 view/view+provision/read-only/不扩大 | 全权=view+provision（缺 maintain 不降级）；只读上限生效                      | 回归钉 | ✅ T22/T27                                     | U65           |
| AC-M11-19 | U67/U67b       | 授权 UI                           | 复跑卡片形态与入口                        | U67 审定二已实现：三卡片层级单卡（查看/控制/管理），位置即权限               | 回归钉 | ✅ T23/T12（U67 审定二+审计 PASS）             | U67/U67b      |
| AC-M11-20 | U45            | 授权矩阵                          | 复跑 12 格                                | 可见/打开/connect perms 一致                                                 | 回归钉 | ✅ T27                                         | U45           |
| AC-M11-21 | U61            | authz 组合                        | 复跑 open 口径/路径占用键                 | open 统一；路径占用键含 hostId（r2 F2 为修复前）                             | 回归钉 | ✅ T26/T27                                     | U61           |
| AC-M11-22 | U62            | denied 审计                       | 复跑字段/策略                             | denied 事件字段完整、subjectType/位校验                                      | 回归钉 | ✅ T26                                         | U62           |
| AC-M11-23 | U69a           | LDAP 组                           | 复跑角色方向                              | 组只准入；新用户 developer；角色平台内覆盖                                   | 回归钉 | ✅ T01/T37                                     | U69a          |
| AC-M11-24 | U106           | 详情深链                          | 复跑 `?tab=perms`                         | R3 已实现：?tab=perms 深链直达并保持                                         | 回归钉 | ✅ T64（R3 深链 ?tab=perms）                   | U106          |
| AC-M11-25 | 探索 D1/D2     | lisi/zhangsan、双项目             | 逐位授予→connect→UI 行                    | 票据=视图=行并集；撤销后消失                                                 | 正常   | ✅ T27                                         | U45           |
| AC-M11-26 | 探索 D3/D5     | admin 无 open、目录               | 自授取消；directory/audit                 | 取消零变更；admin 200/开发者 403+denied                                      | 正常   | ✅ T14/T60                                     | —             |
| AC-M11-27 | 探索 M1–M4     | 组+用户、跨项目/跨主机            | 同组不同用户/同用户不同位并集             | 无 deny 覆盖；组+用户并集；UI 权限列一致                                     | 正常   | ✅ T27                                         | U61           |
| AC-M11-28 | 探索 authz-api | 双主机/三身份                     | 复跑 B/C/D/F 组合与还原                   | 60 例中 6 findings（D8/F2/B11/B12/C10/G4）为已知观察，按修复状态复验         | 异常   | 🖐                                             | 无 U/登记建议 |

**覆盖核对表（M11）**

| 操作条目                        | 用例号                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- |
| §3 全局角色/roleOverride/降级   | AC-M11-07、AC-M11-18、AC-M11-22、AC-M11-23                                    |
| §4.2 主机三卡                   | AC-M11-01–05、AC-M11-14、AC-M11-18                                            |
| §4.2 项目三卡（含主机推导只读） | AC-M11-01–05、AC-M11-17、AC-M11-19                                            |
| §4.3 有效权限计算               | AC-M11-06、AC-M11-14、AC-M11-15、AC-M11-25                                    |
| 缺口裁定                        | U65 C10 撤销链路补测；U67/U67b 未实现；authz-api 6 findings 建议逐项登记/复验 |

---

## M12 宿主与中继接入后端面（F7/F8）

来源：`business-flows.md#F7/#F8`、`m12-host-onboarding.md`（§2–§8）、`api-paths.md` H/R/U、`desktop-paths.md`。

| 用例号    | 来源                | 前置数据             | 步骤                                                             | 期望                                                                                 | 类型   | 现状                                 | 关联 U 号           |
| --------- | ------------------- | -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ------------------------------------ | ------------------- |
| AC-M12-01 | F7 S2               | 管理员               | `POST /v1/hosts/tokens`                                          | 201 token+24h；库中仅 hash；审计 `host_token_create`                                 | 正常   | ✅ T38                               | —                   |
| AC-M12-02 | F7 S4               | 管理员+token         | `GET /install/host.sh?token=`                                    | 200 脚本；内嵌平台地址/令牌/根/TLS/systemd；审计无明文                               | 正常   | ✅ T38                               | U115                |
| AC-M12-03 | F8 S3               | 管理员               | `GET /install/relay.sh`                                          | 200 relay 脚本；内嵌 API URL/内部令牌                                                | 正常   | ✅ T38                               | —                   |
| AC-M12-04 | F7 S5               | 有效令牌+全字段      | `POST /v1/hosts/register`                                        | 201；usedAt；upsert Host；写路由；返回 hostId/credential/policyVersion               | 正常   | ✅ T38/T22                           | —                   |
| AC-M12-05 | F7 S6               | 宿主凭证             | `POST heartbeat`                                                 | 更新地址/目录/E2EE/TLS/状态/项目根/克隆回报；响应含策略/撤销/维护/指派/serverTime    | 正常   | ✅ T22/T43/T44                       | —                   |
| AC-M12-06 | F7 S8               | 新直连地址           | 心跳                                                             | `syncHostRoute`+`ensureHostRoute` 补/迁移路由                                        | 正常   | ✅ T41/T42                           | —                   |
| AC-M12-07 | §5                  | 无活跃项目           | 心跳换 projectsRoot                                              | 接受新根；`projectDirs` 规范化；`/hosts/available` 加性字段同步                      | 正常   | ✅ T43                               | U21                 |
| AC-M12-08 | §4                  | E2EE/TLS 指纹变化    | 心跳                                                             | 各写一条 `host_e2ee_key_changed`/`host_tls_fingerprint_changed`（不存旧键）          | 正常   | ✅ T44                               | —                   |
| AC-M12-09 | §4                  | repo-ful 项目        | 心跳下行 `provisionAssignments`                                  | 宿主执行克隆并回报 `provisioned[]`；推进 ready/错误                                  | 正常   | ✅ T19                               | U37                 |
| AC-M12-10 | §6                  | 宿主文件事件         | `POST /v1/internal/audit/file-events` + 心跳 `auditCapabilities` | 白名单/字段上限；落 file_download/file_copy/download_blocked；缺口 delta 落链        | 正常   | ✅ T30/T31/T61                       | U66/U68             |
| AC-M12-11 | §6                  | 能力协商             | 注册 `runtimeCapabilities`；workspace.info capabilities          | 落 `Host.capabilities`；旧宿主无 capabilities 零探测                                 | 正常   | ✅ T22/R21                           | —                   |
| AC-M12-12 | F8 S4               | 内部令牌+合法端口    | `POST /v1/internal/relay-endpoint`                               | 注册节点；30s 存活窗；返回 relayPort/id/healthyRelays                                | 正常   | ✅ T49/T56                           | —                   |
| AC-M12-13 | F8 S5               | 路由表有项           | `GET /v1/internal/relay-routes`                                  | `{version,routes[]}`；中继同步；陈旧 5 分钟拒绝新连接                                | 正常   | ✅ T52/T56                           | —                   |
| AC-M12-14 | §8                  | 写操作发生           | 查审计链                                                         | 单写者哈希链；变更端点在链不可用时 fail-closed；`verify` 通过                        | 正常   | ✅ T33/T34/T35/T36                   | —                   |
| AC-M12-15 | F7 E1/E2            | 无效/已用/过期 token | 安装脚本/注册                                                    | 400/401 对应码；令牌一次性                                                           | 异常   | ✅ T38                               | —                   |
| AC-M12-16 | F7 E4               | 坏 `directAddrs`     | 心跳                                                             | 400 `HOST_DIRECTADDRS_INVALID`；整拍拒绝不落库                                       | 异常   | ✅ T22                               | U57                 |
| AC-M12-17 | F7 E5               | 有活跃项目           | 心跳换根                                                         | `projectsRootRejected`；旧根保留；归档不阻塞                                         | 异常   | ✅ T43                               | U21                 |
| AC-M12-18 | F7 E7               | 已吊销主机           | 心跳/维护/新连接                                                 | 心跳 200+hostRevoked 不更新；维护 409；新连接 409                                    | 异常   | ✅ T40                               | —                   |
| AC-M12-19 | F8 E4               | 非法端口             | 中继注册                                                         | 400 `RELAY_PORT_INVALID`，不注册                                                     | 异常   | ✅ T56                               | —                   |
| AC-M12-20 | §8                  | 审计链不可用         | 调变更端点                                                       | fail-closed 拒绝写并返回错误                                                         | 异常   | ✅ T34                               | —                   |
| AC-M12-21 | F7 E3               | 开发者               | 调 hosts/tokens/安装/授权                                        | 403 + denied 审计                                                                    | 异常   | ✅ T22/T38/T60                       | —                   |
| AC-M12-22 | F8 E3               | 中继静默             | 平台/中继路由                                                    | 平台侧无「陈旧路由」显式状态；中继进程拒绝新连接                                     | 异常   | ✅ T22（能力路径）；🖐 陈旧路由可观测性仍无 | —                   |
| AC-M12-23 | U37                 | repo-ful 项目        | 复跑下行指派+宿主执行                                            | 不死锁；provisioned 回报推进状态                                                     | 回归钉 | ✅ T19                               | U37                 |
| AC-M12-24 | U18/U19             | 项目创建             | 复跑 key/name/主机在线校验                                       | 400/409 对应码；不落半成品                                                           | 回归钉 | ✅ T10                               | U18/U19             |
| AC-M12-25 | U66/U68             | 文件事件             | 复跑 ingest/能力协商/捕获点                                      | 事件落链、字段上限、旧宿主不投递                                                     | 回归钉 | ✅ T30/T61                           | U66/U68             |
| AC-M12-26 | U43/U38/U39/U64/U79 | 中继/宿主路由        | 复跑对应回归                                                     | 均已分别在 AC-M5-16、AC-M4-25/26/28/31 钉住，不重复派生                              | 回归钉 | ✅ 见 M4/M5                          | U43/U38/U39/U64/U79 |
| AC-M12-27 | U21/U57/U65         | 根/心跳/下载硬拦     | 复跑护栏与二期边界                                               | 换根拒绝、坏拍拒绝（T43/T22）；宿主硬拦已实现（U70 C+②）；U65 C10 撤销另见 AC-M11-16 | 回归钉 | ✅ T43/T22；U65 C10 ⛔ 见 M11        | U21/U57/U65         |
| AC-M12-28 | 探索 API H/R/U      | 本地平台+探针宿主    | 复跑 H1–H49、R1–R15、U1–U14                                      | 令牌/注册/心跳/授权/吊销/中继/审计边界按检查点                                       | 异常   | 🖐（脚本 `run-api-exploratory.mjs`） | —                   |

**覆盖核对表（M12）**

| 操作条目                             | 用例号                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| §2 令牌/安装/列表/维护/授权/下线端点 | AC-M12-01–04、AC-M12-15、AC-M12-18、AC-M12-21                                                                                 |
| §3 注册/routeKey/路由表              | AC-M12-04、AC-M12-06、AC-M12-12                                                                                               |
| §4 心跳全字段/响应                   | AC-M12-05–09、AC-M12-16、AC-M12-17                                                                                            |
| §5 projectsRoot/projectDirs          | AC-M12-07、AC-M12-17                                                                                                          |
| §6 能力协商/文件事件                 | AC-M12-10、AC-M12-11、AC-M12-25                                                                                               |
| §7 中继接入/路由/edge                | AC-M12-03、AC-M12-12、AC-M12-13、AC-M12-19                                                                                    |
| §8 审计落链                          | AC-M12-14、AC-M12-20                                                                                                          |
| 缺口裁定                             | 真实宿主脚本→注册→首心跳端到端未覆盖（补测）；Windows/CentOS7 安装脚本补测；runtimeCapabilities 升级路径/陈旧路由可观测性登记 |

---

## F10 移动端（不派生验收用例）

`business-flows.md#F10` 明确：U80 原型阶段，0 正常步骤、0 失败分支、0 已覆盖。本文件**不生成**移动端运行用例，也不得按原型截图推断「应通过」。缺口：U80（实现未开工）；U106 C15 移动视口冒烟尚未落地；R5 明确移动视口并入 r6。

---

## 13. 缺口清单（⛔ 项 + 未映射操作）

| #   | 缺口                                                                       | 来源用例/操作         | 类型      | 裁定建议                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------- | --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | ~~浏览器 401→refresh→重放无 e2e~~ **closed（单请求）**                     | AC-M1-04              | closed    | T05 新增浏览器用例「浏览器 401 → refresh → 原请求重放一次」（`session-renewal.e2e.test.ts`，relays 单请求路由：2×GET + 1×refresh + token 旋转）。并行请求竞态另见 G28                                                                                                                  |
| G02 | ~~refresh 失败 UI/仅缓存 user/登出失败静默~~ **closed**                   | AC-M1-13/14/15        | closed    | T05 三例：refresh 401→回登录页（单次刷新、三键清空）、logout 500 静默回登录页（无 toast）、仅缓存 user 无 token 不进且移除缓存                                                                                                                                                                                                                                                        |
| G03 | ~~登录页网络错误、LDAP 拒绝 UI 文案、登录中禁用态~~ **closed**              | M1 §7                 | closed    | T06 新增三例：fetch 拒绝显示「网络异常，请稍后重试」、LDAP 401 文案逐字展示、请求在途按钮禁用且重复提交零新增请求（失败恢复可点）；AC-M1-24 |
| G04 | 生产 LDAPS adapter 不在仓库                                                | M1 §7                 | 登记      | 真机/部署层验证，不据 Mock 判通过                                                                                                                                                                                                                                                      |
| G05 | ~~工作台统计卡四项数值、前进/后退历史栈、查询参数不生效~~ **closed**      | M2 §7                 | closed    | T70 `u70-workbench-cards.e2e.test.ts`：四卡逐字对齐 API（项目数/在线数/禁用下载数/默认策略+v版本，含 2 在线+1 离线宿主与 1 显式 deny）、`#/workbench?foo=bar` 请求集合与无 query 一致、列表→详情 back→forward 复开详情（补 T64 缺的 forward） |
| G06 | 归档/恢复无控制台入口（仅 API）                                            | AC-M3-16 / C21        | 登记      | 无 U 号；按「设计未承诺 UI」验收或补 UI                                                                                                                                                                                                                                                |
| G07 | ~~provisioning→ready UI、详情黄条/复制/独立页链接~~ **closed**             | AC-M3-07/21、C15      | closed    | T71 `web-project-detail.e2e.test.ts`：repoUrl 登记 toast「克隆中」→ 详情「准备中」→ 宿主回报 ok →「就绪」；回报 ok:false+error →「准备失败」+原因；详情 GET 失败 → 黄条「未能刷新项目信息」且缓存保留；路径/仓库复制 toast「已复制」、在线宿主详情含独立页链接 |
| G08 | ~~仓库地址 `not-a-valid-url` 历史接受缺陷~~ **closed**                     | AC-M3-33              | closed    | U136① `9854ef58d60` 收紧→U141 `6cb53417057` 跨层对齐（本地绝对路径与 `file://` 两端接受）→U142 统一 SCP-like(user@) 并两端拒 UNC；矩阵与 T10 回归；历史数据读取不重校验                                                                                                                |
| G09 | ~~维护/下线控制台 UI、注册弹框成功/失败 UI~~ **closed**                   | AC-M4-07/09、D2       | closed    | T72 `web-host-lifecycle-feedback.e2e.test.ts`：抽屉「进入维护模式」→ POST `{enabled:true,reason}`、抽屉关闭、行维护中、项目打开禁用；下线 confirm 取消 0 DELETE/抽屉不关/平台未吊销，确认 1 DELETE/行已吊销；注册弹框复制命令（剪贴板完整命令+toast「已复制」+弹框保持）；令牌/维护/下线 500 → `注册主机失败/进入维护模式失败/下线主机失败：模拟平台故障` toast、抽屉与平台状态不变 |
| G10 | ~~U115 安装命令照抄执行 401~~ **closed**                                   | AC-M4-23/34、AC-M5-10 | closed    | U115 修复 `9d90575ccf3`；T38 五场景矩阵（照抄 200/二次 401/过期 401/兼容 200/越权 401）                                                                                                                                                                                                |
| G11 | ~~中继刷新失败态、自动刷新/离线 UI~~ **closed**                           | AC-M5-09/11           | closed     | U136② 实现刷新失败内联 `.note.warn` 提示 +「重试」、旧表保留、成功清除提示；无自动轮询为既定语义（AC-M5-11 仍成立），离线/不可达行 UI 由 AC-M5-07/19 覆盖。T06 QA-013 改为行为断言（失败提示/旧行保留/1.2s 无轮询/重试清除） |
| G12 | ~~停用账号校验、LDAP 静态徽标~~ **closed**（U135 409+denied；U145 事实性徽标）；分页按「设计未承诺」关闭 | AC-M6-15、M6 §5       | closed    | U135 `cbbcb130086`：409 `USER_DISABLED`+denied 审计（e2e disabled-account-role-update）；U145：用户页徽标改读 `GET /v1/users` 加性字段 `ldap.requiredGroup`，显示「LDAP 准入组：<组名>」/「LDAP 准入：未配置」，旧服务端回退「LDAP 分组准入」，不再声明同步状态（T37 断言同步更新）；分页按「设计未承诺」关闭 |
| G13 | ~~U114-D4 用户筛选态/停用锁、审计断点几何~~ **closed**                     | AC-M6-16/21、AC-M7-25 | closed    | `e0692622c39`；T66（筛选态保持+停用锁）、T67（12 列/1100/700 断点契约）                                                                                                                                                                                                                |
| G14 | ~~审计链健康/容量水位无 UI、verify 无入口；auditor 下拉为空~~ **closed** | AC-M7-14/29/30、3.12 | closed | U136③：审计页新增「链健康与容量（只读）」区块（chain.ok/lastSeq、容量今日/累计与 envelope、persisted）与「校验审计链」按钮（200 通过 / 409 展示 brokenAtSeq）；auditor 空下拉显示「无可见项目（需 open 授权）」「无可见主机（需主机权限）」。T32 U72-4/U72-5 行为断言 |
| G15 | ~~加载更早/复制/空态/首屏失败/缺口横幅 UI~~ **closed**                    | AC-M7-04/05/12        | closed    | 「加载更早」T06 QA-002；traceId 复制 T06 QA-004；空态 U66-5-2；文件名复制 U66-5-7（path+toast「已复制」）；首屏失败「加载失败」+错误文本+「重试」恢复 U66-5-8；缺口 >0 渲染 `.note.warn#auditGapWarning`（无缺口不渲染）U66-5-9 |
| G16 | ~~全局保存失败 UI、并发版本冲突~~ **closed**                              | AC-M8-09/15、M8 §5    | closed    | 全局 PUT 失败 toast+回滚由 T06 QA-009 覆盖；并发版本冲突由 U136④ 落地（④a `afca14d02c8` 协议 409、④b UI 保留输入+刷新重试，T47 M120c2-8/9）→ G29 closed                                                                                                                                |
| G17 | ~~管理台覆盖层刷新丢失 / `#/workspace/:id` / project 403 视图~~ **closed** | AC-M9-08/12/13        | closed    | U106 R4 `402517832b7`+W3 `7bdf6f6a974`；T65（6 场景）、R22                                                                                                                                                                                                                             |
| G18 | ~~U99 多组恢复 / U113 A-fix1~~ **closed**（旧宿主矩阵单列手测） | AC-M9-17/21           | closed    | U99 `1cace8bc18f` 已闭；U113 `530807b7a18` 自动化+**真机矩阵 9/9**（evidence/u113-retest）；旧宿主矩阵仍手测                                                                                                                                                                                         |
| G19 | ~~U112 D1/D2/D4/D5/D6/D7/D8~~ **closed**                                   | AC-M10-07/12/14/20–27 | closed    | `fee2402fb3a`（D1/D2）+`737a3962428`（D3–D8）；R08/R16/R17 自动化                                                                                                                                                                                                                      |
| G20 | ~~双端并发关闭 / 尺寸 owner 首开 characterization~~ **closed**             | AC-M10-23/25          | closed    | `737a3962428`：按动作降级+重复 close 幂等（D4）、D6 characterization 钉现状                                                                                                                                                                                                            |
| G21 | ~~U65 C10 主机授权收缩撤凭证端到端~~ **closed**                            | AC-M11-07/16          | closed    | U136⑤：`PUT /v1/hosts/{id}/grants` 写前快照、落库后重算有效 `hostBits`，收缩者逐个 `revokeUserCredentials(username,'host_grant_changed')`（扩位不撤销）；审计 `accessLevel`/`removedPermissions`/`revokedUsers`；host-authorization e2e 新增 2 例 |
| G22 | ~~U67/U67b 层级单卡/位置即权限~~ **closed**                                | AC-M11-17/19          | closed    | U67-3a/3b/4/5/6 落地 `518769959d0`；独立审计 PASS（AC 9/9、缺陷 0）；T23/T12                                                                                                                                                                                                           |
| G23 | ~~authz-api 6 findings~~ **closed**（6/6 已在 HEAD 修复并有回归） | AC-M11-28             | closed | 逐项确认是否转 U                                                                                                                                                                                                                                                                       |
| G24 | 真实宿主脚本→注册→首心跳端到端；Windows/CentOS7 脚本                       | M12 §10               | 补测      | 真机矩阵，勿以脚本文本断言替代                                                                                                                                                                                                                                                         |
| G25 | runtimeCapabilities 升级路径、陈旧路由平台侧可观测性（能力路径已钉） | AC-M12-22             | 部分闭合  | T22 新增：注册落库 caps；心跳上报更多能力或缺失字段均不改写（注册是唯一更新通道，陈旧值 fail-closed）；陈旧路由平台侧仍无显式状态，可观测性未闭 |
| G26 | 移动端实现（U80）；U106 R6 移动视口冒烟已闭                                | F10                   | 未实现    | T65 `u106-console-mobile`（404/403 同 schema）；U80 原型阶段，不生成运行用例                                                                                                                                                                                                           |
| G27 | 无 U 号观察：设置页策略生效文案（原「30 秒生效」）无同步状态、未覆盖项目无法直接钉住 | M8 §5 | 部分闭合  | 文案已修正（「已保存，将随宿主心跳生效」）；未覆盖项目钉住功能待排期                                                                                                                                                                                                                   |
| G28 | ~~浏览器并行 401 双 refresh 竞态→登出~~ **closed**                         | AC-M1-04 / 本轮探针   | closed    | U134 `cbbcb130086`：`refreshInFlight` single-flight（并行 401 仅 1 次 refresh、登录态保留）；`session-renewal` e2e 扩测                                                                                                                                                                |
| G29 | ~~下载策略并发保存无版本号/冲突检测（last-write-wins）~~ **closed**        | AC-M8-15              | closed    | U136④a `afca14d02c8`：`PUT /v1/policies/download` 与 `PUT /v1/projects/:id/policy` 接受可选 `expectedVersion`，陈旧写入 409 `POLICY_VERSION_CONFLICT`（details 含服务端 version/策略、failure 审计）；U136④b UI：保存带 `expectedVersion`，409 保留输入+服务端值+刷新后重试，T47 M120c2-8/9；缺省字段保持旧客户端行为 |

---

## 14. 统计与自检

### 14.1 分模块统计

| 模块     | 链路  | 用例数  | 正常    | 异常   | 回归钉 | ✅ 已有自动化 | 🖐 仅手测 | ⛔ 未覆盖 |
| -------- | ----- | ------- | ------- | ------ | ------ | ------------- | --------- | --------- |
| M1       | F1    | 24      | 8       | 10     | 6      | 21            | 3         | 0         |
| M2       | F1/F3 | 23      | 13      | 3      | 7      | 18            | 5         | 0         |
| M3       | F2/F5 | 33      | 16      | 8      | 9      | 29            | 4         | 0         |
| M4       | F5/F7 | 34      | 15      | 8      | 11     | 31            | 3         | 0         |
| M5       | F8    | 19      | 10      | 7      | 2      | 16            | 3         | 0         |
| M6       | F9    | 24      | 13      | 7      | 4      | 21            | 3         | 0         |
| M7       | F6    | 30      | 14      | 7      | 9      | 24            | 6         | 0         |
| M8       | F2/F5 | 15      | 7       | 5      | 3      | 12            | 3         | 0         |
| M9       | F3/F4 | 27      | 10      | 10     | 7      | 25            | 2         | 0         |
| M10      | F4    | 36      | 15      | 9      | 12     | 34            | 2         | 0         |
| M11      | F5    | 28      | 12      | 9      | 7      | 26            | 2         | 0         |
| M12      | F7/F8 | 28      | 14      | 9      | 5      | 27            | 1         | 0         |
| **合计** | F1–F9 | **321** | **147** | **92** | **82** | **284**       | **37**    | **0**     |

### 14.2 自检结论

- **步骤覆盖**：F1–F9 的 82 个正常步骤均至少映射 1 条正常用例（机检源标签 S1–S11 全覆盖）。
- **失败分支覆盖**：F1–F9 的 71 个失败分支均至少映射 1 条异常用例（源标签 E1–E9 全覆盖）。
- **缺陷回归钉**：台账中与 F1–F9 相关的已知缺陷均至少出现 1 条「回归钉」；未实现项保持 ⛔ + U 号，未按设计稿判通过。
- **探索转正**：`web-console-paths` L1–L8/P1–P4/H1–H6/§6–§9、`workspace-paths` P1–P23、`exploratory-r5-paths` P1'–P3'、`authz-combo` D0–D5/M1–M4、`api-paths` A/P/G/H/D/C/U/R 段的有效路径已转为用例或纳入异常/回归钉。
- **缺口**：§13 共 29 条（27 原有 + 2 本轮新发现 G28/G29）。已 closed 23 条（G01/G02/G03/G05/G07/G08/G09/G10/G11/G12/G13/G14/G15/G16/G17/G18/G19/G20/G21/G22/G23/G28/G29）；部分闭合 2 条（G25 能力路径已自动化，陈旧路由平台侧可观测性仍无。G27 设置页文案已修正，未覆盖项目钉住待排期）；待裁定/待实现 4 条。⛔ 未覆盖用例剩 0 条；AC-M5-09/11 已由 U136② 实现并保留自动化（刷新失败提示+重试；无自动轮询为既定语义），AC-M7-14 已由 U136③ 实现（空下拉解释）、链健康/容量与 verify 入口由 AC-M7-29/30 覆盖。本轮新增自动化 5 例（T05 浏览器重放、T06 QA-013 中继刷新态、T32 U72-4 auditor 下拉解释、T32 U72-5 链健康/容量+校验、T10 U136① 仓库地址矩阵），另复核确认 T06 QA-002/QA-004/QA-009 与 U70 guard 7 单测已覆盖原缺口；U136④b 新增 T47 M120c2-8/9（保存携带 `expectedVersion`、409 保留输入+刷新后重试）；G09 由 T72 四例闭合（维护/下线控制台 UI、注册弹框复制与失败反馈）。
