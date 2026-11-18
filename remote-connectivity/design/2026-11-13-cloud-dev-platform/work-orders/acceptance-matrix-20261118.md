# 业务地图验收矩阵（2026-11-18）

- 上游：`../business-map.md`（70 叶子，🟢69/🟡0/⚪1，98.6%）
- 今日门禁：第八轮全景 148 文件/37 批全 exit 0、1150（1147 pass/3 env skip）；认证 267/267；矩阵 113/113；门禁 92（91+1）；U326 拆分后 149 文件/1152 待第九轮

| 域 | 编号 | 功能 | 状态 | 地图证据 | 今日验收 |
|---|---|---|---|---|---|
| AUTH 身份与会话 | AUTH-LOGIN-LDAP | LDAP/LDAPS 登录 bind | 🟢 | 认证基线（267） | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-TOKEN-ISSUE | 访问/刷新令牌签发与 30s 轮换宽限 | 🟢 | refresh-cookie 套件 | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-TOKEN-STORE | 令牌哈希入库与快照持久化 | 🟢 | store-persistence **21/21** | 今日实跑 21/21 |
| AUTH 身份与会话 | AUTH-TOKEN-GC | 令牌回收与快照明文剥离 | 🟢 | session-sweep + snapshot-credential-strip **11/11**（主会话复跑） | 今日实跑 11/11（session-sweep 10 + strip 1；单测非 e2e） |
| AUTH 身份与会话 | AUTH-LOGIN-LOCKOUT | 5 次失败锁 15 分钟 | 🟢 | 契约 9/9、body 5/5、entry-module 9/9 | 今日实跑 23/23（9+5+9） |
| AUTH 身份与会话 | AUTH-LDAP-ADMIT | LDAP 组门槛准入 | 🟢 | `ldap-admission` **14/14**（含移出组/去重 2 例，主会话复跑） | 今日实跑 14/14 |
| AUTH 身份与会话 | AUTH-REVOKE-SELF | 自助登出与设备吊销 | 🟢 | u229/u241 套件 | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-REVOKE-FORCE | 管理员强制下线（含 3+ follower 并发、自撤/同级） | 🟢 | **14/14**（含 D23 两例） | 今日实跑 14/14（12+2） |
| AUTH 身份与会话 | AUTH-PERM-PROPAGATE | 权限变更即时生效与 60s 断连 | 🟢 | control-plane-isolation **3/3**（AC-12，第八轮）；u244 14/14 | 第八轮 control-plane-isolation 3/3（AC-12）；u244 14/14 |
| AUTH 身份与会话 | AUTH-COOKIE-MODE | Cookie 模式（auto/never/always） | 🟢 | u197 浏览器套件 9/9、认证基线 267/267 | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-PAGE-CSP | 认证页 CSP（Report-Only） | 🟢 | csp-zero 6/6 | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-COMPAT-LEGACY | 旧客户端兼容与启动恢复 | 🟢 | u198 2/2、u229 系列 | 第八轮全景覆盖 |
| AUTH 身份与会话 | AUTH-SESSION-EXPIRE | 过期自动登出与 `session.expired` 事件 | 🟢 | `u243-session-events` 4/4（主会话复跑） | 第八轮全景覆盖 |
| AZ 授权与准入 | AZ-HOST-GRANT | 主机授权全权/只读两级 | 🟢 | host-authorization **11/11** | 今日实跑 11/11 |
| AZ 授权与准入 | AZ-PROJECT-GRANT | 项目权限位与三原则合成 | 🟢 | u67 套件 | 第八轮全景覆盖 |
| AZ 授权与准入 | AZ-REVIEW-MATRIX | 角色×端点组合矩阵 | 🟢 | **113/113** | 第八轮全景覆盖 |
| AZ 授权与准入 | AZ-GRANT-VALIDATE | 非法 subject/permission 拒绝、重复位去重 | 🟢 | dedupe **4/4**、u62 4/4 | 第八轮 u62 4/4；dedupe 4/4 为单测 |
| AZ 授权与准入 | AZ-DENIAL-AUDIT | 越权拒绝审计 | 🟢 | admin-denial-audit **1/1** | 今日实跑 1/1 |
| AZ 授权与准入 | AZ-ENUM-GUARD | 无权限项目防探测（404/不泄露） | 🟢 | web-project-entry 10/10 | 第八轮全景覆盖 |
| AZ 授权与准入 | AZ-LDAP-GROUP | LDAP 组授权（LGA-1~6） | 🟢 | `ldap-admission` 6/6（主会话复跑 2026-11-18） | 第八轮全景覆盖 |
| PRJ 项目 | PRJ-CREATE-ADMIN | 管理员登记项目与创建校验 | 🟢 | registration **7/7**、self-service **10/10**（另有 web 9/9、project-dir 6/6） | 今日实跑 7/7 + 10/10（另有 web 9/9、dir 6/6） |
| PRJ 项目 | PRJ-CREATE-SELF | 开发者自助建项目（仓库可选） | 🟢 | self-service-project-dir 6/6 | 第八轮全景覆盖 |
| PRJ 项目 | PRJ-LIFECYCLE-ARCHIVE | 归档/恢复与只读 30 天 | 🟢 | actions 7/7、detail 5/5、data 8/8 | 第八轮全景覆盖 |
| PRJ 项目 | PRJ-ACCESS-CONNECT | 打开项目、会话复用与凭证签发 | 🟢 | project-connect 套件 | 第八轮全景覆盖 |
| PRJ 项目 | PRJ-ACCESS-DETAIL | 详情页（信息/权限/会话页） | 🟢 | u106-detail 9/9 | 第八轮全景覆盖 |
| PRJ 项目 | PRJ-PROVISION-ERR | 克隆失败原因呈现 | 🟢 | `web-project-entry` **12/12**（含注入载荷与无 img 断言） | 今日实跑 12/12（含注入用例） |
| HOST 开发机与中继 | HOST-ONBOARD-WIZARD | 向导式添加与一行安装命令 | 🟢 | install-wizard **90/90** | 第八轮全景覆盖 |
| HOST 开发机与中继 | HOST-ONBOARD-REGISTER | 注册、协议版本校验、令牌不误烧 | 🟢 | protocol-version 3/3 | 今日实跑 3/3（单测）；第八轮 u147 4/4 旁证 |
| HOST 开发机与中继 | HOST-RUNTIME-HEARTBEAT | 心跳与 auditGap 上报 | 🟢 | u71 4/4、host-offline 1/1 | 第八轮全景覆盖 |
| HOST 开发机与中继 | HOST-RELAY-PAGE | 中继独立管理页 | 🟢 | relay-endpoint 4/4 | 第八轮全景覆盖 |
| HOST 开发机与中继 | HOST-BROWSER-RELAY | 经中继访问宿主 Web 界面 | 🟢 | browser-entry 6/6、browser-mode 6/6 | 第八轮全景覆盖 |
| HOST 开发机与中继 | HOST-RUNTIME-REVOKE | 吊销主机与路由清理 | 🟢 | host-revocation **1/1** | 今日实跑 1/1 |
| CONN 连接与选路 | CONN-SELECT-ROUTE | 直连/中继选路与故障诊断 | 🟢 | route-key-follow 4/4、failover | 第八轮全景覆盖 |
| CONN 连接与选路 | CONN-DIRECT-ADDR | 直连地址校验与历史快照清洗 | 🟢 | 12/12 + 畸形快照 5/5 | 今日实跑 17/17（12+5；单测非 e2e） |
| CONN 连接与选路 | CONN-RELAY-BOUND | 中继只转发、不做授权判定 | 🟢 | relay-hardening、edge-hygiene 5/5 | 第八轮全景覆盖 |
| FILE 文件浏览与下载管控 | FILE-BROWSER-BROWSE | 文件浏览器（展开/搜索/只读） | 🟢 | file-contract **6/6**（M29-1 浏览/只读 1/1） | 今日实跑 6/6（M29-1） |
| FILE 文件浏览与下载管控 | FILE-BROWSER-PREVIEW | 512KB 预览上限与二进制不可预览 | 🟢 | `cloud-file-preview-guards` **2/2**（真实 runtime/TLS） | 今日实跑 2/2（真实 runtime vitest，U325） |
| FILE 文件浏览与下载管控 | FILE-PATH-GUARD | 相对路径与 `..` 穿越拒绝 | 🟢 | file-contract **6/6**（M29-2/3 2/2） | 今日实跑 6/6（M29-2/3 2/2） |
| FILE 文件浏览与下载管控 | FILE-DL-POLICY | 全局/项目下载策略与即时生效 | 🟢 | download-policy 套件 | 第八轮全景覆盖 |
| FILE 文件浏览与下载管控 | FILE-DL-HARDEN | 宿主侧硬拦（现有 RPC） | 🟢 | guard 7/7、enforcement 4/4 | 今日实跑 11/11（guard 7 + enforcement 4；vitest） |
| FILE 文件浏览与下载管控 | FILE-DL-RPC | 专用 `files.download` 流式 RPC | ⚪ | 缓登记 U66/D21；guard 7/7、enforcement 4/4、download-policy 3/3；调研 `test-reports/d21-c9-prep-20261118.md` | 未实施（D21-C9 缓） |
| FILE 文件浏览与下载管控 | FILE-DL-AUDIT | 拦截/超阈值读取审计 | 🟢 | audit-file-events 套件 | 第八轮全景覆盖 |
| FILE 文件浏览与下载管控 | FILE-COPY-CAPTURE | DOM 选区复制捕获 | 🟢 | cloud-file-copy-audit **8/8** | 今日实跑 8/8（renderer vitest） |
| AUD 审计 | AUD-CHAIN-VERIFY | 只追加哈希链与持久化顺序 | 🟢 | audit-anchor、audit-verify（AUD 组 3/3） | 第八轮全景覆盖 |
| AUD 审计 | AUD-APPEND-ATOMIC | 落盘失败不留内存残条 | 🟢 | u246 组 **3/3**（单测）；U244 **14/14** | u246 3/3（单测）；U244 14/14 |
| AUD 审计 | AUD-BODY-GUARD | 事件体积全局护栏与截断标记 | 🟢 | audit-event-size **17/17** | 今日实跑 17/17 |
| AUD 审计 | AUD-QUERY-FILTER | 时间/用户/类型筛选、游标、31 天窗 | 🟢 | u66-2 8/8、query 28/28 | 第八轮 u66-2 8/8；query 28/28 单测 |
| AUD 审计 | AUD-EXPORT-DOWNLOAD | 审计员导出与二次确认 | 🟢 | audit-export **14/14**、audit-export-download **11/11** | 今日实跑 14/14 + 11/11 |
| AUD 审计 | AUD-TRACE-CORRELATE | traceId 关联 | 🟢 | audit-trace-window 1/1 | 第八轮全景覆盖 |
| AUD 审计 | AUD-CURSOR-GATE | 游标/路径参数校验 | 🟢 | cursor 3/3 + writer 4/4 | 今日实跑 7/7（3+4 单测） |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | ADMIN-CONSOLE-WORKBENCH | 工作台四卡与项目表 | 🟢 | `u70-workbench-cards` 3/3（在线项目）、AC-01 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | ADMIN-USERS-ROLES | 用户/角色管理 | 🟢 | u67-3-users 6/6 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | ADMIN-PERM-TAB | 位置即权限三卡片 | 🟢 | u67-3a/3b、drawer 11/11 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | ADMIN-CONSOLE-GATING | 管控面入口门控 | 🟢 | web-admin-gating 3/3（admin-gating 13 例另计） | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | ADMIN-CONSOLE-SETTINGS | 平台设置与策略页 | 🟢 | web-settings 6/6 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | CLIENT-INSTALL-ONELINER | 安装命令可照抄执行（退出码/信号/清理） | 🟢 | `install-one-liner-runtime` **14/14**、`test-timeout-selfcheck.e2e` **2/2** | 今日实跑 16/16（14+2） |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | CLIENT-ZERO-ENV | 安装即可用、平台地址可填 | 🟢 | u106 路由套件 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | CLIENT-BRANDING-UI | 品牌/登录页/关于页定制 | 🟢 | m70 验收 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | CLIENT-RESILIENCE-OFFLINE | 平台不可用提示 | 🟢 | m70、m9fix | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | CLIENT-DIAGNOSTICS-REPORT | 客户端诊断上报 | 🟢 | m70 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | WEB-NAV-ROUTING | 控制台路由渲染与代次守卫 | 🟢 | web-exploratory **45/45**（U310） | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | WEB-SESSION-REFRESH | 刷新/多标签协调 | 🟢 | u197 套件、u80-users 5/5 | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | MOB-HOST-DETAIL | 移动端主机详情 sheet | 🟢 | u80-mobile-shell 390×844 sheet、m9fix 触控 ≥44px | 第八轮全景覆盖 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | DSGN-PROTO-U67 | U67 原型、验收截图与回归脚本 | 🟢 | proto-tab-check **39/39** | 今日实跑 39/39（脚本） |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-AUTH-BASE | 认证 24 文件基线 | 🟢 | **267/267** | 今日实跑 267/267 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-BASE-MATRIX | 授权组合矩阵基线 | 🟢 | **113/113** | 今日实跑 113/113 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-E2E-SWEEP | 全仓 e2e 全景 | 🟢 | **第八轮：148 文件 / 37 批 / 1150 tests（1147 pass / 0 fail / 3 env skip）**，hashes_same=yes；U326 拆分后 149 文件/1152，**待第九轮** | 第八轮 148 文件/1150（1147 pass / 3 env skip）；拆分后 149/1152 待第九轮 |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-TIMEOUT-GATE | 超时形态门禁与存量迁移 | 🟢 | 门禁测试 **92（91 pass/1 skip）**；296 文件、0 new | 今日实跑 92（91+1）、296 文件 0 new |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-TYPE-GATE | apps 类型门禁 | 🟢 | `tc:apps` 16→0 | 历史 `tc:apps` 16→0（本轮未重跑） |
| ADMIN 管理台 / CLIENT 客户端 / WEB 控制台 / MOB / DSGN / QA | QA-EVIDENCE-CHECKERS | 台账表格/sha/编码校验 | 🟢 | 三脚本 + 自测 | 今日三脚本 RC 0 + 自测 15/15 |

## 说明

- 「今日验收」区分 e2e 与单测/脚本：只有 `cloud-platform/test/e2e/*.e2e.test.ts` 属第八轮全景；其余为今日直接实跑的 apps/api 单测、vitest 或脚本。
- `relay-container-harness` 3 例因缺 Docker/镜像走既有降级 skip，需在容器环境补跑。
- 未实施：`FILE-DL-RPC`（D21-C9 缓）；叶子外挂账：U181（H11–H13 产物）、U233 F4（缓办）、U323（工具项）。
