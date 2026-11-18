# Orca 云开发平台 · 业务地图（2026-11-18）

- 生成日期：2026-11-18
- 用途：按业务域组织功能清单，给出唯一编号、状态、进度与可复核的测试计数
- 数据来源：`requirements.md`（FR 编号）、`defect-ledger.md`（U 编号与状态）、`test-plan.md`（§6/§7 实测计数）、当日回归日志
- 配套复盘：[`reviews/business-map-review-20261118.md`](reviews/business-map-review-20261118.md)（未完成清单、阻塞说明、人工复核动作；后续复盘在该文件追加）
- 维护约定：新增功能必须分配三级编号；状态变更与计数变化须在台账或本文件同步（改本文件时以 `PROGRESS`/台账现有记录为准，不另造数字）

## 1. 编号与状态规则

- 编号：`<域>-<子域>-<功能项>`，每级英文缩写（2–12 字符），横线连接，如 `AUTH-LOGIN-LDAP`
- 状态：🟢 已交付（有回归与证据）/ 🟡 进行中或部分交付 / ⚪ 待决策或待开工
- 进度：已交付验收项 ÷ 应有验收项（决策项按 0%，部分项按实际功能面估算）
- 优先级：P0 必须（阻塞一期验收）/ P1 应做 / P2 二期或增强 / 「—」不参与产品优先级；带「（门禁）」「（过程交付）」「（形态扩展）」「（分期）」「（二期）」为限定说明
- 测试数：优先使用**可复核的实测计数**（指定套件 / 基线）；无法逐项计数时标注所属基线，不估算

## 2. 一级域总览

| 域 | 名称 | 优先级 | 状态 | 进度 | 测试证据 |
|---|---|---|---|---|
| AUTH | 身份认证与会话 | P0 | 🟢 | 100%（D15/D18/D20/D5–D10 全部落地） | 24 文件认证基线 **267/267**；锁定 **14/14**；ldap 14/14；u243 4/4 |
| AZ | 授权与准入 | P0 | 🟢 | 100%（D15-1 已实施、LGA-6 收口） | 组合矩阵 **113/113**；api 授权 116/116；ldap 14/14 |
| PRJ | 项目 | P0 | 🟢 | 100%（D22 已交付） | 归档/自助/详情/连接套件；web-project-entry **12/12** |
| HOST | 开发机与中继 | P0 | 🟢 | 100% | mtls 12/12、relay 5/5、host-offline 1/1 等 |
| CONN | 连接与选路 | P0 | 🟢 | 100% | 直连地址 12/12、畸形地址快照 5/5 |
| FILE | 文件浏览与下载管控 | P0 | 🟡 | 87.5%（⚪专用下载 RPC，D21 缓登记） | 文件契约 e2e；宿主硬拦 guard 7/7；复制捕获 8/8 |
| AUD | 审计 | P0 | 🟢 | 100%（D18/D20 事件词汇已实施） | 审计链/writer/export/query 套件；u243 4/4 |
| ADMIN | 管理台 | P0 | 🟢 | 100% | web-admin-gating 3/3、directory 套件、矩阵 113/113 |
| CLIENT | 客户端与企业定制 | P0 | 🟢 | 100% | install-wizard **90/90**、one-liner 运行期 **14/14** |
| WEB | 平台 Web 控制台 | P0 | 🟢 | 100%（路由 P1 已修） | web-exploratory **45/45**、移动端用户页 5/5 |
| MOB | 移动端形态 | P1 | 🟢 | 100%（响应式全屏 sheet 已覆盖，原型稿归二期） | u80-mobile-shell 390×844 sheet、m9fix 触控 44px |
| DSGN | 设计原型与文档 | P1 | 🟢 | 100% | proto-tab-check **39/39** |
| QA | 测试与门禁基建 | P0 | 🟢 | 100%（U317 已实施） | 全仓 e2e **1149/1149**；门禁 **89（88 pass/1 skip）**，基线 **0** |

## 3. 功能项明细

### AUTH 身份与会话

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| AUTH-LOGIN-LDAP | LDAP/LDAPS 登录 bind | FR-1.1 | P0 | 🟢 | 100% | 认证基线（267） |
| AUTH-TOKEN-ISSUE | 访问/刷新令牌签发与 30s 轮换宽限 | FR-1.2 | P0 | 🟢 | 100% | refresh-cookie 套件 |
| AUTH-TOKEN-STORE | 令牌哈希入库与快照持久化 | FR-1.2（服务端） | P0 | 🟢 | 100% | store-persistence **21/21** |
| AUTH-TOKEN-GC | 令牌回收与快照明文剥离 | FR-1.2（服务端） | P0 | 🟢 | 100%（D18 A1 已实施 `b521fb87988`；A2 按裁定不做） | session-sweep + snapshot-credential-strip **11/11**（主会话复跑） |
| AUTH-LOGIN-LOCKOUT | 5 次失败锁 15 分钟 | FR-1.4 | P0 | 🟢 | 100% | 契约 9/9、body 5/5、entry-module 9/9 |
| AUTH-LDAP-ADMIT | LDAP 组门槛准入 | FR-1.5 | P1 | 🟢 | 100%（D15-1 已实施 `73bc4ce6647`：登录时组全量替换） | `ldap-admission` **14/14**（含移出组/去重 2 例，主会话复跑） |
| AUTH-REVOKE-SELF | 自助登出与设备吊销 | FR-1.6 | P0 | 🟢 | 100% | u229/u241 套件 |
| AUTH-REVOKE-FORCE | 管理员强制下线（含 3+ follower 并发） | FR-1.6 | P0 | 🟢 | 100% | **12/12** |
| AUTH-PERM-PROPAGATE | 权限变更即时生效与 60s 断连 | FR-1.7 | P1 | 🟢 | 100% | policy/u244 相关 |
| AUTH-COOKIE-MODE | Cookie 模式（auto/never/always） | FR-1.2 | P0 | 🟢 | 100%（D5–D10：同源默认关闭，检查单 `19c908da06f`；生产启用待运维） | u197 浏览器套件 9/9、认证基线 267/267 |
| AUTH-PAGE-CSP | 认证页 CSP（Report-Only） | NFR 5.3（安全） | P0 | 🟢 | 100%（D10 维持 Report-Only，不启用 enforcement） | csp-zero 6/6 |
| AUTH-COMPAT-LEGACY | 旧客户端兼容与启动恢复 | FR-9.8 | P2 | 🟢 | 100% | u198 2/2、u229 系列 |
| AUTH-SESSION-EXPIRE | 过期自动登出与 `session.expired` 事件 | FR-1.6 | P0 | 🟢 | 100%（D20 已实施：`session.expired`/`session.revoked` 两事件） | `u243-session-events` 4/4（主会话复跑） |

### AZ 授权与准入

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| AZ-HOST-GRANT | 主机授权全权/只读两级 | FR-9.10 | P0 | 🟢 | 100% | host-authorization |
| AZ-PROJECT-GRANT | 项目权限位与三原则合成 | FR-9.11 | P0 | 🟢 | 100% | u67 套件 |
| AZ-REVIEW-MATRIX | 角色×端点组合矩阵 | FR-9.3 | P0 | 🟢 | 100% | **113/113** |
| AZ-GRANT-VALIDATE | 非法 subject/permission 拒绝、重复位去重 | FR-9.3 | P0 | 🟢 | 100% | dedupe **4/4**、u62 4/4 |
| AZ-DENIAL-AUDIT | 越权拒绝审计 | FR-9.5 | P0 | 🟢 | 100% | admin-denial-audit |
| AZ-ENUM-GUARD | 无权限项目防探测（404/不泄露） | FR-2.2 | P0 | 🟢 | 100%（D24 保留操作级 404 静默，不新增审计通道） | web-project-entry 10/10 |
| AZ-LDAP-GROUP | LDAP 组授权（LGA-1~6） | FR-1.5 | P1 | 🟢 | 100%（裁定不新增功能；LGA-6 收口完成：m11 裁定节 + U211 文案 + 回归） | `ldap-admission` 6/6（主会话复跑 2026-11-18） |

### PRJ 项目

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| PRJ-CREATE-ADMIN | 管理员登记项目与创建校验 | FR-3.1/3.2 | P0 | 🟢 | 100% | registration/self-service |
| PRJ-CREATE-SELF | 开发者自助建项目（仓库可选） | FR-3.7 | P0 | 🟢 | 100% | self-service-project-dir 6/6 |
| PRJ-LIFECYCLE-ARCHIVE | 归档/恢复与只读 30 天 | FR-3.4 | P1 | 🟢 | 100% | actions 7/7、detail 5/5、data 8/8 |
| PRJ-ACCESS-CONNECT | 打开项目、会话复用与凭证签发 | FR-3.3/3.6 | P0 | 🟢 | 100% | project-connect 套件 |
| PRJ-ACCESS-DETAIL | 详情页（信息/权限/会话页） | FR-3.5/3.8/3.9 | P1 | 🟢 | 100% | u106-detail 9/9 |
| PRJ-PROVISION-ERR | 克隆失败原因呈现 | FR-3.2 | P0 | 🟢 | 100%（D22 已实施：内联于列表/详情/工作台；注入转义已测） | `web-project-entry` **12/12**（含注入载荷与无 img 断言） |

### HOST 开发机与中继

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| HOST-ONBOARD-WIZARD | 向导式添加与一行安装命令 | FR-4.11 | P0 | 🟢 | 100% | install-wizard **90/90** |
| HOST-ONBOARD-REGISTER | 注册、协议版本校验、令牌不误烧 | FR-4.1/4.2 | P0 | 🟢 | 100% | protocol-version 3/3 |
| HOST-RUNTIME-HEARTBEAT | 心跳与 auditGap 上报 | FR-4.3 | P0 | 🟢 | 100% | u71 4/4、host-offline 1/1 |
| HOST-RELAY-PAGE | 中继独立管理页 | FR-4.10 | P1 | 🟢 | 100% | relay-endpoint 4/4 |
| HOST-BROWSER-RELAY | 经中继访问宿主 Web 界面 | FR-4.12 | P1 | 🟢 | 100% | browser-entry 6/6、browser-mode 6/6 |
| HOST-RUNTIME-REVOKE | 吊销主机与路由清理 | FR-4.6 | P0 | 🟢 | 100% | host-revocation |

### CONN 连接与选路

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| CONN-SELECT-ROUTE | 直连/中继选路与故障诊断 | FR-5.1–5.9 | P0 | 🟢 | 100% | route-key-follow 4/4、failover |
| CONN-DIRECT-ADDR | 直连地址校验与历史快照清洗 | FR-5.1–5.9 | P0 | 🟢 | 100% | 12/12 + 畸形快照 5/5 |
| CONN-RELAY-BOUND | 中继只转发、不做授权判定 | FR-5.10 | P0 | 🟢 | 100% | relay-hardening、edge-hygiene 5/5 |

### FILE 文件浏览与下载管控

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| FILE-BROWSER-BROWSE | 文件浏览器（展开/搜索/只读） | FR-6.1/6.2 | P0 | 🟢 | 100% | file-contract |
| FILE-BROWSER-PREVIEW | 512KB 预览上限与二进制不可预览 | FR-6.3/6.4 | P1 | 🟢 | 100% | file-contract |
| FILE-PATH-GUARD | 相对路径与 `..` 穿越拒绝 | FR-6.5 | P0 | 🟢 | 100% | file-contract |
| FILE-DL-POLICY | 全局/项目下载策略与即时生效 | FR-7.1/7.2/7.6 | P0 | 🟢 | 100% | download-policy 套件 |
| FILE-DL-HARDEN | 宿主侧硬拦（现有 RPC） | FR-7.3 | P0 | 🟢 | 100% | guard 7/7、enforcement 4/4 |
| FILE-DL-RPC | 专用 `files.download` 流式 RPC | FR-9.12 | P0（分期） | ⚪ | 0%（D21：缓；C9 前置调研亦建议维持缓，A 仅关闭 5 个点名方法中的 1 个） | 缓登记 U66/D21；guard 7/7、enforcement 4/4、download-policy 3/3；调研 `test-reports/d21-c9-prep-20261118.md` |
| FILE-DL-AUDIT | 拦截/超阈值读取审计 | FR-7.4 | P0 | 🟢 | 100% | audit-file-events 套件 |
| FILE-COPY-CAPTURE | DOM 选区复制捕获 | FR-9.14（FR-9.13–16 未入库） | P1（二期） | 🟢 | 100%（C6 已落地于云端简易工作区） | cloud-file-copy-audit **8/8** |

### AUD 审计

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| AUD-CHAIN-VERIFY | 只追加哈希链与持久化顺序 | FR-8.1/8.2 | P0 | 🟢 | 100% | audit-anchor、audit-verify（AUD 组 3/3） |
| AUD-APPEND-ATOMIC | 落盘失败不留内存残条 | FR-8.2 | P0 | 🟢 | 100% | u246 组 3/3（U244 为 11/11） |
| AUD-BODY-GUARD | 事件体积全局护栏与截断标记 | FR-8.1 | P0 | 🟢 | 100% | audit-event-size **17/17** |
| AUD-QUERY-FILTER | 时间/用户/类型筛选、游标、31 天窗 | FR-8.3 | P0 | 🟢 | 100% | u66-2 8/8、query 28/28 |
| AUD-EXPORT-DOWNLOAD | 审计员导出与二次确认 | FR-8.5 | P1 | 🟢 | 100% | audit-export 系列 |
| AUD-TRACE-CORRELATE | traceId 关联 | FR-8.4 | P0 | 🟢 | 100% | audit-trace-window 1/1 |
| AUD-CURSOR-GATE | 游标/路径参数校验 | FR-8.3 | P0 | 🟢 | 100% | cursor 3/3 + writer 4/4 |

### ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA

| 编号 | 功能 | FR | 优先级 | 状态 | 进度 | 测试 |
|---|---|---|---|---|---|
| ADMIN-CONSOLE-WORKBENCH | 工作台四卡与项目表 | FR-2.1–2.6 | P0 | 🟢 | 100%（四卡标签已按 D11 对齐；搜索/筛选/通知为 FR 外增强，另挂 U316） | `u70-workbench-cards` 3/3（在线项目）、AC-01 |
| ADMIN-USERS-ROLES | 用户/角色管理 | FR-9.2 | P1 | 🟢 | 100% | u67-3-users 6/6 |
| ADMIN-PERM-TAB | 位置即权限三卡片 | FR-9.3 | P0 | 🟢 | 100% | u67-3a/3b、drawer 11/11 |
| ADMIN-CONSOLE-GATING | 管控面入口门控 | FR-9.7 | P0 | 🟢 | 100% | web-admin-gating 3/3（admin-gating 13 例另计） |
| ADMIN-CONSOLE-SETTINGS | 平台设置与策略页 | FR-9.4 | P0 | 🟢 | 100% | web-settings 6/6 |
| CLIENT-INSTALL-ONELINER | 安装命令可照抄执行（退出码/信号/清理） | FR-4.11 | P0 | 🟢 | 100% | `install-one-liner-runtime` **14/14**、`test-timeout-selfcheck.e2e` **2/2** |
| CLIENT-ZERO-ENV | 安装即可用、平台地址可填 | FR-2.7 | P0 | 🟢 | 100% | u106 路由套件 |
| CLIENT-BRANDING-UI | 品牌/登录页/关于页定制 | FR-10.1 | P0 | 🟢 | 100% | m70 验收 |
| CLIENT-RESILIENCE-OFFLINE | 平台不可用提示 | FR-10.5 | P1 | 🟢 | 100% | m70、m9fix |
| CLIENT-DIAGNOSTICS-REPORT | 客户端诊断上报 | FR-10.6 | P1 | 🟢 | 100% | m70 |
| WEB-NAV-ROUTING | 控制台路由渲染与代次守卫 | FR-9.1 | P0 | 🟢 | 100%（P1 已修） | web-exploratory **45/45**（U310） |
| WEB-SESSION-REFRESH | 刷新/多标签协调 | FR-1.2 | P0 | 🟢 | 100% | u197 套件、u80-users 5/5 |
| MOB-HOST-DETAIL | 移动端主机详情 sheet | FR-9.1 | P1（形态扩展） | 🟢 | 100%（响应式全屏 sheet；原型稿归二期素材） | u80-mobile-shell 390×844 sheet、m9fix 触控 ≥44px |
| DSGN-PROTO-U67 | U67 原型、验收截图与回归脚本 | — | P1（过程交付） | 🟢 | 100% | proto-tab-check **39/39** |
| QA-AUTH-BASE | 认证 24 文件基线 | — | P0（门禁） | 🟢 | 100% | **267/267** |
| QA-BASE-MATRIX | 授权组合矩阵基线 | — | P0（门禁） | 🟢 | 100% | **113/113** |
| QA-E2E-SWEEP | 全仓 e2e 全景 | — | P0（门禁） | 🟢 | 100% | **1149/1149，0 skip**（第七轮，148 文件；U319 后定向复跑） |
| QA-TIMEOUT-GATE | 超时形态门禁与存量迁移 | — | P1（门禁） | 🟢 | 100%（U317/U321 已实施；范围漂移提示非失败） | 门禁测试 **89（88 pass/1 skip）**；296 文件、0 new |
| QA-TYPE-GATE | apps 类型门禁 | — | P1（门禁） | 🟢 | 100% | `tc:apps` 16→0 |
| QA-EVIDENCE-CHECKERS | 台账表格/sha/编码校验 | — | P0（门禁） | 🟢 | 100% | 三脚本 + 自测 |


## 4. 汇总与口径

- 综合完成度：**69 / 70 = 98.6%**（定义：🟢计 1、🟡计 0.5、⚪计 0；域进度按同法计算）
- 叶子外挂账（不计入 70 行）：U233 F4 认证拒绝审计（已设计、缓办）、U323/U324 工具项、FR 外增强 U316/U54 等，见台账
- 叶子功能项 **70**：🟢 **69**、🟡 **0**、⚪ **1**（FILE-DL-RPC，D21 缓登记）
- 计数口径：叶子行数按本文件表行实测（70），下次更新须重算并同步本节
- 阻塞源（剩余）：cookieMode 生产启用待运维按检查单执行、D21-C9 缓（登记缺口）；其余决策项均已实施或收口
- 所有计数为**指定范围基线**；「全仓无红」仅由 QA-E2E-SWEEP 的全景扫描支撑（协议 §2-142），不得以子集基线替代
- 当日台账增量：U272–U324；唯一重开：WEB-ROUTING（U307→U310→U312），修复后回绿
## 5. 按地图推进的规则与顺序

### 5.1 规则（防止迷失方向）

1. **每个任务必须挂一个地图编号**：任务书、提交标题、台账行都写 `<域>-<子域>-<功能项>`（如 `fix(WEB-NAV-ROUTING): …`）。挂不上编号的工作不启动——确需做则先在本文件补叶子。
2. **测试按叶子登记**：新增/修改用例必须写清它验证哪条叶子（套件名 + 计数），并在本文件「测试」列或 §5.2 追溯表可查。
3. **完成即回写**：叶子状态变化（🟢/🟡/⚪）与计数变化当轮更新本文件，并在复盘文档 `reviews/business-map-review-*.md` 追加一条。
4. **决策项不施工**：⚪ 叶子在用户裁定前只允许做「不改变语义」的准备（设计、探针、证据），不得改运行时行为。
5. **简单优先（用户指令，最高优先级）**：实现任何叶子都选「最简单且基本满足需求」的方案；不预留抽象/配置层/事件/子系统，复杂度代价（新增文件数/配置项/事件数）必须写进任务书与决策记录。

### 5.2 活跃与未完成项 → 台账/证据追溯

| 地图编号 | 状态 | 台账/决策 | 套件或证据 |
|---|---|---|---|
| ADMIN-CONSOLE-WORKBENCH | 🟢 | U316（QA-030 搜索/筛选/通知，FR 外增强，⚪ 挂账） | workbench 套件（AC-01） |
| HOST-ONBOARD-WIZARD | 🟢 | U181（H11–H13 打包验收产物待出） | install-wizard 90/90；D25 手动构建 job |
| AUTH-REVOKE-FORCE | 🟢 | U245③（D23 自撤/同级测试待补） | u244 12/12 |
| ADMIN-CONSOLE-WORKBENCH / QA-EVIDENCE-CHECKERS | 🟢 | U323（探索重放脚本标签漂移，非门禁） | U322 复审发现 |
| QA-TIMEOUT-GATE | 🟢 | U324（import 正则边界，P2，0 文件命中） | U321 复审 |
| —（无叶子：早期探索/FR 外增强） | ⚪ | U11/U12/U27/U32/U54/U56/U58/U74/U76/U116/U316 | 台账 §3.2 |
| QA-TIMEOUT-GATE | 🟢 | U291/U313/U315/U317/U321 已关 | 门禁套件 **89（88 pass/1 skip）**、扫描 296 文件 0 new；`evidence/m110-load-300` |
| WEB-NAV-ROUTING | 🟢 | U307/U310/U312/U314（已关） | `web-exploratory-fixes` 45、U310 定向 1/1（主会话复跑） |
| MOB-HOST-DETAIL | 🟢 | U278（已裁定不开发） | `u80-mobile-shell` 390×844 sheet、`u80-mobile-m9fix` 触控 44px |
| AUTH-LOGIN-LOCKOUT | 🟢 | U289/U292/U293/U294/U296（已关） | 契约 9/9、entry-module 9/9、lockout 14/14 |
| AUTH-COOKIE-MODE | 🟢 | D5–D10（检查单 `19c908da06f`）、U214 已关、U216 已接受 | u197 浏览器套件 9/9、认证基线 267/267 |
| AUTH-PAGE-CSP | 🟢 | D10（维持 Report-Only） | csp-zero 6/6 |
| AUTH-TOKEN-GC | 🟢 | D18（已实施 `b521fb87988`）、U233 F6 已关；U233 F4 另挂并缓办 | `session-sweep` + `snapshot-credential-strip` 11/11 |
| AUTH-SESSION-EXPIRE | 🟢 | D20（已实施）、U243/U230 | `u243-session-events` 4/4 |
| AUTH-LDAP-ADMIT / AZ-LDAP-GROUP | 🟢/🟢 | D15-1（已实施 `73bc4ce6647`）、U212 已关；LGA-6 收口 | `ldap-admission` 14/14（主会话复跑）、准入设计 v3 |
| AZ-ENUM-GUARD | 🟢 | D24（保留 404 静默）、U247 观察 | web-project-entry 10/10 |
| PRJ-PROVISION-ERR | 🟢 | D22（已实施 `4a85e45bdce`）、U54 | `web-project-entry` 12/12 |
| FILE-DL-RPC / FILE-COPY-CAPTURE | ⚪/🟢 | D21（C9 缓登记；C6 已落地）、U66 第二口径结案 | `cloud-file-copy-audit` 8/8 |
| FILE-DL-HARDEN | 🟢 | U66 二期（已关） | guard 7/7、enforcement 4/4 |
| CLIENT-INSTALL-ONELINER | 🟢 | U275/U276/U281/U283/U285/U288（已关） | 运行期 14/14、自检 2/2 |
| HOST-ONBOARD-REGISTER | 🟢 | U272（已关） | protocol-version 3/3 |
| CONN-DIRECT-ADDR | 🟢 | U263/U265/U268/U274/U277/U280（已关） | 12/12 + 畸形快照 5/5 |
| DSGN-PROTO-U67 | 🟢 | U67/U279（已关） | proto-tab-check 39/39 |
| QA-TYPE-GATE | 🟢 | U282/U286（已关） | `tc:apps` 16→0 |
| QA-EVIDENCE-CHECKERS | 🟢 | 三个检查脚本 + 自测 | `check-ledger-*`、`check-doc-encoding` |

### 5.3 推荐推进顺序（P0 → P1，先施工后决策）

1. **QA-TIMEOUT-GATE 收尾**（已完成）：`load-300` 提交（基线 0）→ U315 范围 → U317 七形（`a1e0a5c893b`）→ 回写本表；仅余 `FILE-DL-RPC`（D21 缓）
2. **QA-E2E-SWEEP 复跑**（P0 门禁）：D15/D18/D20/D22 后已跑第七轮（1149/1149，`8cc353fce7e`）；后续任何 `apps/**`/`test/**` 改动仍需重跑，0 红才更新
3. **WEB-NAV-ROUTING 收口**：U314 全量绿后转 100%
4. **跨叶子维护批**（格式化债务，20+ e2e 文件 oxfmt-red）：单独提交，不改变语义
5. **决策项（已全部裁定，按减法顺序施工）**：D20+D18 → D22 → D15-1 → D21 C6 复核 + D11 需求文本 → D25 + D5–D10 检查单 → 文档收口批；详见 [`work-orders/decisions-log-20261118.md`](work-orders/decisions-log-20261118.md) §5
