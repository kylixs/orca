# W3c 审计报告（「打开」= 进入项目，FR-3.11 修订）

- 审计人：独立审计代理（只读；除本报告外未创建/修改任何文件，未提交 git）
- 日期：2026-11-14
- 审计对象：`085599b77c9`（feat(cloud): open enters the project workspace，恰 2 文件 +62/−48：apps/web/app.js +57/−33、test/e2e/web-project-entry.e2e.test.ts +53/−17；`git show --stat` 复核无第三文件混入）
- 对照基准：work-orders-2026-11-14.md §W3c（追加令）、requirements.md FR-3.11 修订行（:191）、AGENTS.md、既有 W3/W7b/W7a 交付
- 方法：只读 diff 审查（含 `git show -w` 空白不敏感对照，用于核验 oxfmt 波）+ 现行源码交叉验证（server.ts 签发/换发/可见性链、store.ts 单次消费、web-release.ts 发布契约、渲染端 cloud-project-workspace 连接诊断）+ 证据复核（w3c-open-enters-workspace/ 四份日志与 summary）。行号基于本提交的文件内容（工作树对 cloud-platform 无未提交改动，已核对）。

## 结论

**通过（PASS）**：blocker 0、major 0、minor 2、note 5。

规格三条全部落地且只落在授权域内：「打开」（工作台卡片 app.js:264、工作台/我的项目行 app.js:289）与「Orca Web」（app.js:314）统一进 `openProjectWorkspace`（app.js:358）走 W7b 既有语义——`POST /v1/projects/{id}/web-handoff` + `window.open(url, '_blank', 'noopener')`（app.js:360-361），未新增任何线契约；「连接信息已就绪」对话框连同 `openProject` 整函数、控制台侧 `/connect` 调用与 `clientVersion` 一起删净，无死代码残留；管理员「详情」与离线/维护/未授权置灰语义零改动（`-w` diff 逐 hunk 核验）。安全面成立：交接码 32 字节随机、只出现在 URL fragment（不回传服务端）、消费即删的单次语义（store.ts:187-195）、60s TTL（server.ts:63）、审计只记指纹（server.ts:2631-2638），URL 不含任何令牌。证据齐备可解析，套件 40/6/2 全绿与本套件新断言逐条对上。

## 发现

### blocker

无。

### major

无。

### minor

- **m-1 活文档陈旧**：`test-plan.md:137`（M117/FR-3.8 行）仍写「打开对话框含桌面客户端引导」——该对话框已被本提交删除，e2e 中对应用例（原 W3-guide）已替换为 W3c-open。权威定义（requirements.md FR-3.11 修订）已更新，此行未随动。属文档漂移，不涉代码；建议随收口批次改写为「打开 = handoff 新标签进工作区」。
- **m-2 新标签 URL 断言可更钉**：W3c-open（web-project-entry.e2e.test.ts:476-479）断言了「恰一次 window.open + api 参数 + `#handoff=<code>&project=` 形状」，但未断言 `project=` 的值等于所点项目、也未断言入口 origin（中继边缘 `/h/dev-tls/`）。入口 URL 组合本身由 W7b-url 套件钉住（web-handoff-entry.e2e.test.ts:290-300），证据 `console-open-click.json` 留存了全形 URL，故覆盖是够的；列为可加严项而非缺口。

### note（不计为缺陷）

- **n-1**：测试文件两处 `oxlint-disable-next-line typescript/no-explicit-any`（:40 既有、:458 新增）均带行内原因说明，与 W7b 同款先例逐字一致；内容满足 AGENTS「类型断言须行内解释」的意图，仅未用 `SAFETY:` 字面前缀。
- **n-2**：app.js:356 注释保留「连接信息已就绪」字样属有意文档化（说明删除缘由），非残留文案引用；代码与测试中无其它引用（全仓 grep 核验）。
- **n-3 线兼容核对**：控制台经 `web-release.ts` 内容哈希发布、契约版本 1（WEB_CONTRACT_VERSION/MIN 均为 1）——本提交不改任何端点形状：旧归档构建的「打开→/connect」路径服务端仍在（桌面客户端共用，platform.e2e 等套件不经过控制台、不受影响），新构建只消费 W7a/W7b 既有端点；AC-19/web-release 6/0 在证据中。无持久化状态依赖被破坏（对话框不落 localStorage；`currentDeviceId` 仍被登录路径使用，非孤儿）。
- **n-4 无「可点必 403」用户路径**：项目列表可见性即 `admin || open`（server.ts:1358-1370），故非管理员可见的每一行都持 open；唯一无 open 的渲染面是未授权管理员行，`openDisabledReason`（app.js:235-242）置灰并给「项目未授权给你…」title——与 W7a 签发侧 403（server.ts:2575-2590）自洽，且新 e2e 正钉住这一态。
- **n-5 lint 复核**：`npx oxlint apps/web/app.js test/e2e/web-project-entry.e2e.test.ts` = 26 条既有 curly（无一落在 W3c 改动行，最近的是未触碰的 app.js:369）+ 测试文件 0 条，与 evidence summary notes 自述一致；无任何 max-lines 抑制。

已知注记（按派单，不作为发现）：① app.js 携带 4 个 oxfmt 波 hunk（esc/showHost/renderMembers），经 `git show -w` 核验纯机械重排零语义变化，提交信息已披露；② 「Orca Web」按钮保留为保守读法，合并裁定需另立工单——本提交将其并入同一 handler（app.js:340-346）未改变其渲染条件（`permissions.includes('open')`，app.js:314-317）。

## 逐项清单

### ① 规格符合（W3c 三条 + 提交域）

| 规格点 | 实现 | 判定 |
| --- | --- | --- |
| 「打开」对所有有 open 权限者 = 调 web-handoff 新标签自动进工作区 | 工作台卡片（app.js:264）、工作台行与我的项目行共用 builder（app.js:289→projectRowActions），`data-open` 与 `data-orca-web` 同一绑定（app.js:343-346）→ `openProjectWorkspace`：`POST /v1/projects/{id}/web-handoff` + `window.open(url,'_blank','noopener')`（app.js:358-365）。错误路径 toast（与 W7b 一致），不再弹对话框 | ✅ |
| 移除「连接信息已就绪」对话框；信息保留在详情/诊断 | `openProject` 整函数删除（-w diff 核验）；控制台内 `/connect` 与 `clientVersion` 零残留（grep）；`dialog()` 仍被「注册主机/添加中继」两处使用，CSS 未成死码；`currentDeviceId` 仍被登录使用。原始地址信息的保留面：详情入口（宿主 cloud-admin.html 会话页，app.js:293-301）与 orca web 工作区「连接诊断」（src/renderer/src/cloud/cloud-project-workspace.tsx:157）均实际存在 | ✅ |
| 管理员「详情」不变 | `detailEntry`/`detailDisabledReason` 零改动（-w diff）；e2e W3-admin / W3-admin 无会话页地址 / W3-maintenance 三例不改而过 | ✅ |
| 提交域 = apps/web/app.js + e2e | `git show --stat` 恰 2 文件；e2e 改动仅三处（文件头注释、W3-orca-web 加固、W3-guide→W3c-open 替换），无域外文件 | ✅ |

### ② 对话框删除彻底性

- 死代码/未用函数：无。被删函数的两个依赖（`currentDeviceId`、`dialog()`）各有其它在用调用点。
- 文案引用：代码中仅 app.js:356 一处解释性注释（n-2）；测试与文档无活引用（`test-plan.md:137` 陈旧行除外 → m-1；w3-audit.md/exploratory-qa-web.md/defect-ledger.md 中的提及均为历史记录，不属活规格）。
- 证据残留：w3-fixes/ 现存 `open-handoff-entry.json`，旧 `open-dialog-guidance.json` 不在目录中。

### ③ handoff 复用是否走 W7b 既有端点语义

- 端点与语义零改动：签发 `handleWebHandoff`（server.ts:2565）——open 权限必需（2575）、维护/吊销/离线 409、入口优先中继边缘回落 TLS 直连（2604-2613）；code 32 字节 base64url（2621）、TTL 60s（server.ts:63）、审计记 `codeFingerprint` 不记明文（2631-2638）；换发 `POST /v1/web/handoff`（1076）——消费即删的单次语义（store.ts:187-195，先 delete 再验期，重放/未知一律 410）。URL 形状 `?api=<平台>#handoff=<code>&project=<id>`（server.ts:2646）。
- 客户端侧：`window.open(body.url, '_blank', 'noopener')`（app.js:361）与 W7b 原 `openOrcaWeb` 逐字相同，仅改名收敛为单 handler。

### ④ 不回归（离线/维护/无 open 置灰 + W3/W7b 套件语义）

- `openDisabledReason`/`openDisabledAttr`（app.js:234-248）、`detailDisabledReason`（270-281）、`orcaWebDisabledReason`（304-312）全部零改动（-w diff）。
- 既有断言未被放松：W3-orca-web（:381-401）原「详情在、Orca Web 不渲染」保留，新增「打开 disabled + title/未授权/」属加固；W3-developer、W3-admin、W3-maintenance、W3-admin-open、M116-QA-007/010 均不改而过。
- W7b 套件语义未破坏：「Orca Web」按钮仍在（orcaWebEntry 未动），W7b-button 两例（mint-per-click + 签发失败 toast）不改而过（证据日志逐条列出）；W7a 九例不改而过。
- 离线三控件同态（W3-admin-open :579-599）与维护置灰/恢复（W3-maintenance :521-577）全绿。

### ⑤ 测试质量

- 断言打在行为上：点「打开」后（a）`.dialog` 不存在（:466-470，dialog() 仅在调用时注入 DOM，index.html 无静态 .dialog——断言真实可红）；（b）请求序列过滤后 deepEqual 恰为 `POST /v1/projects/{id}/web-handoff`（:471-475）——/connect 出现即红，二次签发也红；（c）恰一次 window.open（:476）+ api 参数 + hash 形状（:477-479）。突变对照：还原为对话框实现时 (a)(b) 双双转红，handler 摘除时 (c) 转红。无恒真断言。
- `page.window.open` stub 打在真实执行路径上：app.js 经 `new Function(..., 'window', ...)` 注入同一 happy-dom Window（web-console-page.ts:33-60），点击时才解析 `window.open`，stub 生效。
- 孤儿引用：原 W3-guide 用例删除后，测试文件头注释同步改写为 W3c 描述；`matrix['open-dialog']` 键替换为 `open-entry`，entry-matrix.json 已是新版；无未用变量（oxlint 0 条）。
- 残余加严项见 m-2。

### ⑥ 线兼容 / 安全

见 note n-3 与 ③。补充：本提交为纯控制台客户端行为变更，不改平台发布的任何 payload/流帧/RPC 参数；`/connect` 端点保留供桌面客户端，二者互不依赖对方变更。交接码经 fragment 携带（不产生服务端日志/审计明文），证据文件对 code 做了 `#handoff=<redacted>` 脱敏（e2e:483）。

### ⑦ 风格 / AGENTS

cloud-platform 域命名与注释惯例保持（`openProjectWorkspace` 具体命名；注释为「why」密度，1-3 行）；无 max-lines 抑制；类型断言见 n-1。

### ⑧ 证据

`cloud-platform/evidence/w3c-open-enters-workspace/`：`summary.json`（5 案例 × 3 批次运行映射）、`console-open-click.json`（请求 + 脱敏 URL + dialogShown:false）、`run-web-console-suites.log`（40 pass/0 fail，含 W3c-open/W3-orca-web/W7a/W7b 逐例）、`run-web-release-install-screenshots.log`（6/0，含 AC-19）、`run-workbench-latency.log`（2/0，真实 Chrome）。全部 JSON 可解析、日志含逐例耗时；旁证 `w3-fixes/open-handoff-entry.json`、`w3-fixes/entry-matrix.json`（open-entry 键为新文案）。提交信息中的通过数与日志一致。

## 审计覆盖度声明

本审计为只读 diff + 源码交叉验证 + 既有证据复核，未独立复跑 e2e 套件（派单约束）；套件通过性以证据日志为准，其逐例输出、端口与真实平台进程特征（`[api] listening`、127.0.0.1 随机端口、毫秒级真实平台往返耗时）自洽，未发现伪造迹象。
