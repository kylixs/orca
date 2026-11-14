# W9b 审计报告（Orca Web 浏览器线黄金旅程 spec）

- 审计人：独立审计代理（只读；未修改任何被审文件，本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`c68dbaae334`（test(e2e): golden journey orca web line，1 文件 +699——`tests/e2e/cloud-golden-journey-orca-web.spec.ts` 为纯新增，diff 即全文）；证据目录 `cloud-platform/evidence/journey-golden-b/`（gitignored，未入提交，与 work-order「证据入 gitignored 目录」纪律一致）
- 对照基准：work-orders-2026-11-14.md §W9a/W9b（L177-180）+ PROGRESS.md L2658 派发记录（B1–B6：免登自动进入+流式终端+文件树+重放回落）+ defect-ledger U16/W13、business-chain-tests.md §2（链路 B）、`evidence/journey-golden-b/findings.json` + journey-timeline.json + 5 截图 + 3 份回归 log + 2 份 run log、`evidence/w7c-startup-scope/w7c-change-manifest.json`、AGENTS.md
- 基准勘误：**「W9A-5 追加令」不存在**。W9A-5 是 A 线（桌面）旅程派生的缺陷令（openWorkspace 重复 `registerCloudRuntimeEnvironment` 轮换 pairing 身份，`7bb66c0da89` 修复），与 W9b 无指令关系；work-orders 的「追加令」节实际是 W3c/W12。本审计以档内真实存在的三处 W9b 指令（work-orders §W9a/W9b、PROGRESS 派发、ledger U16）为准。
- 方法：只读 diff + 现行源码逐行核对（cloud-rpc-permission / cloud-runtime-admission / rpc 方法索引 / web main+WebConnect+CloudSessionEmptyState / web-runtime-client 订阅重签 / monaco-e2e-probe / vite.web.config + global-setup 构建配方 / apps/web app.js 入口与对话框）、e2e typecheck 实跑（见 §3）、oxlint 实跑、证据交叉印证（timeline 步级 detail 与 findings 声明逐条对、截图 md5、run log 时间戳）

## 结论

**有条件通过（旅程本身真实、绿、红线如实记录：真实平台进程 + 真实 Electron 云宿主（production 方法表）+ 真 Chrome，B1/B2/B3/B5 的正负断言大体扎实，B4 红线三项根因全部核实为真；1 条 major 在「W13 翻转机制」——待启用用例的编辑器 oracle 在文档化构建配方下结构性不可满足，「翻转即启用、无需新代码」的声明不成立）**：blocker 0、major 1、minor 5、note 13。

---

## 1. 旅程 spec 质量（B1–B5 断言强度）

### 确认的强断言

| 步 | 断言 | 强度评价 |
| --- | --- | --- |
| B1 | `button[data-orca-web=<projectId>]` 可见且 enabled（app.js:315-325 确认该属性仅在「有 open 权限且宿主在线」时渲染，disabled 形态无此属性） | 真 DOM、绑项目 id；缺负向对照（无 open 权限不渲染），但由回归集里的 platform-web-e2e `W3-orca-web 无 open 权限不渲染 Orca Web 入口`（24/24 之一）补位 |
| B2 | 流量层捕获真实 `POST /v1/projects/{id}/web-handoff` 请求 + popup URL 五点断言（origin=宿主 TLS 直连地址、pathname=/web-index.html、`?api=`=平台地址、hash 正则 `#handoff=<code>&project=<id>`） | 强；hash 携带 code 隐含了 mint 201 成功（code 只在签发响应里）。弱点：未断言响应状态码；重试循环（≤3 次点击）每次都真实铸造一枚一次性 code，多枚未消费 code 留存 + web_handoff 审计噪音（note 12） |
| B3 | hash === ''（全等）、`.app-layout` 已挂载、`#web-cloud-api-url` 不存在、8s settle 后 body 文本无 'Session restore failed'、`orca.webCloudSession` 已持久化、环境名含项目名、console error/warning 无 "not available to cloud sessions" | hash 清空是全等断言（最强）；8s settle 对抗 sticky toast 的设计正确（W7c toast 永不自动消失，过了窗口仍未出现=未发生）。弱点见 MIN-1（denial 日志观测窗口）与 MIN-2（toast 文案 locale 敏感） |
| B4 | 侧栏云空态（`[data-worktree-sidebar-container] svg.lucide-cloud`，与 CloudSessionEmptyState.tsx 实渲染结构一致）、repoCount===0、activeWorktreeId===null、`repo.list` 拒绝文案含 `Method 'repo.list' is not available to cloud sessions`（与 cloud-agent-scope.ts:133 逐字同源） | 红线用正断言钉死（不是「没测」而是「测到了边界」），符合 W9a 确立的「红线记录不隐藏」处理。`worktrees.listAll` 结果只记录不断言（fail 点是缺 repo，文案断言无信息量），取舍合理 |
| B5 | `POST /v1/web/handoff` 响应 410、登录表单在、`.app-layout` 不在、预填值===平台地址（全等）、无会话落存储 | 强。弱点：410 无法区分「重放」与「未知/过期码」（平台两者皆 410）；实际 mint→重放约 9s（<60s TTL），走的是已消费分支，W7a e2e 已在 API 层把三分支分开——可接受（note 6） |
| B6 | 5 张截图落盘校验 + timeline 计数 | 轻；真正的步级证据在 journey-timeline.json 的 per-step detail，质量好（含失败即落盘的 `journeyStep` catch 分支，spec:109-130） |

### 发现

**MAJ-1（major）「翻转 W13_CLOUD_WORKSPACE_VIEW_LANDED 即启用、无需新代码」不成立：待启用用例的编辑器 oracle 在文档化构建配方下结构性不可满足，且翻转会先打红主旅程**

- 死 oracle：`window_snapshotEditorValueTail`（spec:697-699）读 `window.__monacoEditorE2E?.snapshot().valueTail`，而探针只在 `import.meta.env.MODE === 'e2e'` 安装（monaco-e2e-probe.ts:34-36 `if (import.meta.env.MODE !== 'e2e') return () => {}`）。web bundle 的唯一构建路径是 `pnpm run build:web` → `vite build --config vite.web.config.ts`（run-vite-web-build.mjs:14-16），不传 `--mode` → MODE='production'；e2e 的 `ORCA_E2E_WEB_CLIENT` 构建路径也只注入 `VITE_EXPOSE_STORE: 'true'`，同样不传 `--mode e2e`（global-setup.ts:87-95）。`--mode e2e` 只用于 **Electron** 构建（global-setup.ts:60），从不用于 web 构建。即宿主伺服的 out/web 里 `window.__monacoEditorE2E` 恒为 undefined → 可选链短路 → `valueTail ?? ''` 恒 '' → `toBe(FILE_MARKER)` 30s 必超时。W13 落地后启用该用例，文件内容断言永远红，且症状会误导排查方向（指向尚不存在的 W13 工作区视图，而非构建 mode）。这是全仓第一处对 **web bundle** 使用该探针的用例（桌面线用的是 --mode e2e 的 Electron 渲染层，故从未暴露）。
- 翻转的第二处失真：flag 置 true 后，主旅程 B4 步直接 `throw`（spec:493-496 tripwire）→ journeyStep 记失败并抛 → B5/B6 不再执行——即「enable without new code」还需同步把 B4 步改写为「要求工作区表面存在」。代码注释（spec:494）自认了这一点，属有意设计；失真在 findings.json `specTreatment` 与 commit message 的「flipping the flag enables it ... without new code / oracles already written」表述。
- 收口建议（三选一，均为小改）：① flip 说明中要求 web 构建追加 `--mode e2e`（run-vite-web-build.mjs 已支持 argv 透传）；② valueTail oracle 改为 DOM 断言（`.editor-header-path` 已断言文件名，可加可见文本含 FILE_MARKER）；③ 探针缺失时显式失败（snapshot 前检查 `window.__monacoEditorE2E` 存在并报「web build 缺 e2e mode」），并在 findings/commit 措辞中把「翻转即启用」改为「翻转 + 重写 B4 步 + web 构建加 mode」。

**MIN-1（minor）B3 的「零 cloud-denial」console 观测有窗口缺口，且否定断言本身非穷尽**

- 监听在 B3 才挂（spec:436-440），而 popup 在 B2 已 `waitForLoadState('domcontentloaded')`；web-index 的 app bundle 是 module script，在 DCL 事件**前**执行——bundle 求值期同步打出的拒绝日志会漏采。实际风险有限（首笔 RPC 需 React 挂载+传输连接，大概率晚于挂接），但「8s 全程零拒绝」的读数并不覆盖全程。
- 该断言是「console error/warning 文本扫描」（spec:474-475），调用点若静默吞错则不产生日志，断言空转。结构性保证其实在 W7c 的启动跳过清单（use-app-startup-hydration 云会话跳过 native-only 目录加载），console 扫描只是回归哨兵。
- 顺带：`denialLogs===[]` 的断言结果未写入 timeline B3 detail（只有绿跑佐证，findings 声称的 "zero cloud-denial console logs" 无 artifact 字段）。建议 B2 拿到 popup 即挂接监听，并把 denialLogs 计数写进 detail。

**MIN-2（minor）「降级 toast=false」断言 locale 敏感：非英文宿主上会假绿**

- 断言是 `document.body.innerText.includes('Session restore failed')`（spec:453），而该 toast 有 zh/ja/fr/es 译文（locales/zh.json:282「会话恢复失败」等）；`newContext` 未钉 `locale`（spec:321-323），在 OS/Chrome locale 非 en 的机器上，toast 真弹出也会因文案不匹配而读出 false。本跑环境（macOS/Chrome 默认 en-US）侥幸成立。建议 `newContext({ locale: 'en-US', ... })` 或改断言 toast 的 DOM 锚点。

**MIN-3（minor）B4 skip 理由引用的两个证据路径在干净检出即悬空**

- skip 理由（spec:602-607）指向 `cloud-platform/evidence/journey-golden-b/journey-timeline.json` 与 `cloud-platform/evidence/w7c-startup-scope/w7c-change-manifest.json`，两者都在 gitignored 的 `cloud-platform/evidence/` 下（.gitignore:174，`git ls-files` 确认零跟踪）——其他开发者/CI 检出后引用悬空。已入库的等价记录是 defect-ledger U16（commit `68ecc0a2893`，含同一边界与 W13 处置）。建议 skip 理由补一句「入库记录见 defect-ledger U16」。

**MIN-4（minor）旅程 B 编号与 §2 链路 B 编号冲突，覆盖面偏移未声明**

- 旅程的 B6=证据落盘，§2 的 B6=经中继访问（跨网段）；§2-B4（终端/文件树）以红线记录，§2-B6（中继）完全不在旅程内且 findings/commit 未声明其归属（中继浏览器链属 W6 域，chain-coverage-audit 的红名单仍有 B6）。§2-B3 的「线路徽标正常」同样未覆盖（云会话无工作区视图时无从渲染，属 B4 红线的下游）。§2-B7/B8 由 W7b e2e（web-handoff/entry + web-cloud-session-restore 套件）覆盖，work-order 文本有记载。建议在 spec 头注或 findings 里给一张「旅程 B× ↔ §2 步骤」映射，免得后续读数把两者混同。

**MIN-5（minor）零回归证据缺命令行，且改动文件的静态门禁未报告**

- 三份回归 log 均无执行的命令/过滤参数头：`regression-web-cloud-cloudadmin-units.log` 只有 vitest 尾部统计（76 文件/493 例，与 findings 一致），「rendererWeb + cloud + cloudAdmin 单元」的真实范围无法从证据复现；`regression-platform-web-e2e.log`（24/24）与 `regression-cloud-admin-session-e2e.log`（4/4）同。
- 更实质的缺口：`tests/**` 不在任何**强制** typecheck 工程内——`config/tsconfig.e2e.json` 自述 "NOT ENFORCED YET" 且未挂进 `pnpm tc` 链（run-typecheck-projects-in-parallel.mjs 仅 node/tc.web/tc.cli/cloud-e2e/process-host 五工程）。本审计代跑 `pnpm typecheck:e2e`：exit 1，656 个既有错误全在**其他**文件，**新 spec 0 错**（helpers 的既有错误亦与本 spec 无关）。即当前 spec 类型健康，但没有任何门禁守护这一点——W5b MAJ-1（spec 不被任何 typecheck 工程覆盖）的目录级版本。建议把 `pnpm typecheck:e2e` 纳入交付核验并在 log 头记命令；根治则是把 tsconfig.e2e 修到零错误后挂链（大工程，另立任务）。

## 2. 隔离与真实性

### 真实栈构成复核（成立）

| 构件 | 声明 | 核实 |
| --- | --- | --- |
| 平台 | 真实 API 进程，PORT=0（startCloudPlatform） | 成立：spawn `cloud-platform/apps/api/src/server.ts`（cloud-platform-stack.ts:44-49），监听行解析端口，独立实例每跑一个 |
| 宿主 | 真实 Orca Electron 宿主，云宿主模式 + TLS（makeHostTls 自签证书），**production RPC 方法表**，伺服 out/web | 成立且是本旅程最硬的真实性来源：launch 的是 `out/main/index.js`（真实应用入口），方法表来自生产装配点 `cloud-runtime-admission.ts:349` = `ALL_RPC_METHODS + MANAGED_WORKTREE_METHODS + PROJECT_PROVISION_METHODS`，**无任何 env/mode 门**（grep 证实 admission/dispatch 无 `import.meta.env.MODE` 分支）——链路覆盖审计指出的「测试宿主方法表≠生产」风险在此构造性消除（生产表含 project.provision，旧测试 harness 刻意排除的方法在场）。伺服 out/web 由 B2/B3 实证（宿主 origin 下 /web-index.html 挂载出完整 App） |
| 浏览器 | Playwright Chromium `channel: 'chrome'` headless（真 Chrome） | 成立：channel 指定本机 Chrome，未装即报错；B1–B5 全部真键入/真点击/真 popup |
| 前置 | C4/C5 走平台 API（建项目+组授权），种子项目 `proj_payment`（server.ts:540）授权清空以保证旅程项目行唯一 | 与派发口径一致（W9a 先例即「C4(API)/C5(组) 前置串联」）；种子清理只影响本次专用平台实例，无跨跑泄漏 |

### 「唯一捷径=忽略自签宿主证书」的合理性

忽略自签证书（`--ignore-certificate-errors` + context `ignoreHTTPSErrors`，spec:312-323）本身**合理**：生产路径的宿主身份信任由桌面客户端/平台的证书指纹钉扎承担（M108/M109），浏览器 leg 不承担该职责，且替代方案（向 Chrome profile 装 CA）收益不成比例。但「唯一」的说法失真，除它之外还有四处真实性缩减，均应视为已披露或可接受的取舍而非「无捷径」：

1. **平台为纯 HTTP**（timeline B2/B5：`?api=http%3A%2F%2F127.0.0.1%3A54847`）——生产平台走 TLS；宿主→平台的 TLS 校验因此完全未行使（`ORCA_CLOUD_TLS_INSECURE=1` 在 http 下惰性，cloud-platform.ts:272 只作用于出站 https）。
2. **被测 web bundle 是 e2e 仪表化构建**（`VITE_EXPOSE_STORE=true` 烤入，global-setup.ts:61/94）——B3/B4 的 `window.__store` 断言依赖它。好在是「响亮依赖」：store 缺失会让 B4 的 `repoCount` 断言（toBe(0) vs null）直接红，不会假绿。findings.isolation.builds 有披露，但 stack.host 行的「production」措辞未限定到「方法表」。
3. **前置走 API**（非真实向导/表单）——派发口径内。
4. **宿主 headless + `ORCA_BYPASS_SINGLE_INSTANCE_LOCK`**——后台运行纪律要求，不算捷径。

建议把 spec:312 的注释改为「ignoring the self-signed host TLS (and running the platform over plain http) are the journey's shortcuts」一类，与 findings 的披露对齐。

## 3. 零回归声明复核

- **数字全部对得上**：493 passed/3 skipped（log 尾部统计与 findings 一致）、cloud-admin-session e2e 4/4、platform-web-e2e 24/24（node test runner 输出逐条可数）、run log 两次（16:12 首绿 7.0s、16:16 终态 11.8s）与 findings.runs 及截图 mtime（16:15-16:16）吻合；timeline generatedAt=16:16:04+08:00 与第二次跑对应。oxlint + type-aware 实跑 exit 0（0 finding），声明成立。
- **选取相关性**：commit 只新增一个 spec 文件，真实回归面 = ① 该 spec 自身（跑了两遍，绿）；② 它的静态门禁（typecheck——**未报告**，且如 MIN-5 所述无强制工程；本审计代跑为 0 错）；③ lint（已报，0）；④ 共享 helper（未动）。493 例的 renderer web/cloud/cloud-admin 单元跑是**防御性广度**而非针对面（未触任何产品代码），无害但也不构成针对性证据；24/24 的 platform-web-e2e 是**精准选取**（W7a/W7b/W3 正是旅程驱动的入口/端点面，含 CORS、入口 URL、按钮、410/403 负向）；cloud-admin-session e2e 4/4 为相邻域（同 helper、同栈）。总体：选取可辩护，扣分在缺 typecheck 报告与 log 无命令头（MIN-5）。
- 未跑但低风险：W9a 桌面线 spec（同目录独立文件，未动）、全量 playwright 收集（新增文件不影响既有 spec 的隔离运行）。

## 4. B4 红线根因定位质量

三项根因**全部核实为真**，且与 w7c-change-manifest.json 逐点吻合——这是一次高质量的边界定位，不是猜测：

1. **「宿主无 workspace.info 实现：cloud-rpc-permission.ts 把它列为 session 方法，但 runtime 方法表没有该方法」**——核实：`cloud-rpc-permission.ts:13` `SESSION_METHODS = new Set(['status.get', 'workspace.info'])`（注释还写着 "the workspace view calls this"）；全仓 `workspace.info` 仅此一处（grep src+packages，排除测试），`src/main/runtime/rpc/methods/` 注册的 workspace 相关方法只有 `workspacePorts.scan/kill`；生产装配点 `cloud-runtime-admission.ts:349` 的三元组亦不含它。即云会话按表应被放行、宿主却无实现可调——「声明了但没实现」的表述精确。
2. **「web 云会话未挂工作区视图：App 仅有侧栏云空态（CloudSessionEmptyState），无文件树/终端入口」**——核实：`web/main.tsx:134-138` 挂共享 `App`；`WorktreeList.tsx:268` 云会话渲染 `SidebarCloudSessionEmptyState`（Cloud 图标+说明，无列表）；文件树/终端需要 repo/worktree，而票据范围 repo.list 被拒、store 目录为空（B4 正断言钉死 repoCount=0）。W13 ledger U16 的定义（宿主 workspace.info 实现 + web 云会话工作区视图挂文件树/终端，复用 W5c 重签订阅与 W9A-7 multiplex 准入）与本根因严丝合缝。
3. **「已知边界来源：w7c-change-manifest.json（cloudMethodTable.extended=false 的裁定）」**——核实：该文件 `cloudMethodTable.extended=false` 及其四条 reasoning（扩表=跨项目目录泄露，是越界不是缺口）与 `knownBoundaries[0]`（workspace.info 声明未实现，需后续工单补宿主方法+工作区视图）逐句对应。引用准确、非断章。

**pendingWorkOrder=W13 的引用准确性**：spec/commit/ledger 三处对 W13 的定义一致；但 W13 只登记在 defect-ledger U16（`68ecc0a2893`），**未进 work-orders-2026-11-14.md 的执行队列**（该文件最后状态止于 M120，追加令节只有 W3c/W12）——工单主文件与台账脱节（note 3）。ledger 的回归口径「B 线旅程 B4–B6 全绿」与 MAJ-1 揭示的翻转机制缺口（B4 步需重写、编辑器 oracle 需修）应当一并写进 W13 派令，否则 W13 落地时会撞上这两个坑。

**待启用用例（W9b-B4 终端流式+文件树）的 oracle 前瞻核验**：`/v1/projects/{id}/connect` 端点在（server.ts:1706）；`host.connection_rejected`（host-audit-ingest.ts:88 `host.${eventType}`）与 `metadata.reason='replayed'`（cloud-agent-client.ts:301）字段名全对；「订阅重签=第二次 connect mint」与 `web-runtime-client.ts:153-165`（cloud pairing 下每订阅 `offerForNextConnection` 开子 socket）一致；`.xterm-rows`/`[data-orca-explorer-shell]`（FileExplorer.tsx:247）/`.editor-header-path`（EditorPanelHeaderPath.tsx:127）选择器真实存在。唯编辑器 valueTail oracle 死于构建 mode（MAJ-1）。这些断言今天无法验证（用例 skip），W13 启用时预期还要按真实 UI 再校一轮——属「预写 oracle」的固有风险，spec 注释也已自认（"the W5c re-signed-ticket and live-stream oracles already written" 是声明过头的部分）。

## 发现汇总

**Blocker：0**

**Major：1**
- MAJ-1 「翻转即启用」不成立：待启用用例的编辑器 oracle 在 web 构建（production mode）下结构性不可满足；翻转运会先打红主旅程 B4 步。修复与措辞更正见 §1。

**Minor：5**
- MIN-1 B3 零 cloud-denial 观测窗口缺口（listener 晚挂 + 文本扫描非穷尽）+ denialLogs 结果未入 timeline detail
- MIN-2 降级 toast 断言 locale 敏感（zh/ja/fr/es 译文在，context 未钉 locale）
- MIN-3 skip 理由引用的两个证据路径 gitignored，干净检出悬空；应补指已入库的 defect-ledger U16
- MIN-4 旅程 B6（证据）与 §2 B6（中继）编号冲突；§2-B6/线路徽标不在旅程且未声明归属；建议补旅程↔§2 映射
- MIN-5 回归 log 无命令头（493 例范围不可复现）+ 改动文件无强制 typecheck 工程（实测 0 错但无门禁，W5b MAJ-1 目录级版本）

**Note：13**
1. 「W9A-5 追加令」不存在——W9A-5 是 A 线缺陷令（`7bb66c0da89` 修复）；W9b 有效指令集 = work-orders §W9a/W9b + PROGRESS L2658 派发 + ledger U16。
2. B4 根因三项全部核实为真（见 §4），与 w7c manifest 裁定吻合——红线定位质量高。
3. W13 只在 defect-ledger U16 排队，未进 work-orders 主文件执行队列——工单主文件与台账脱节。
4. 截图 03 与 04 字节相同（md5 `d577c632…`）——同 tab 相邻两步；B4 的判别证据在 timeline 的 evaluate 结果（repoCount=0、拒绝文案）而非截图。
5. B5 捕获了 `state.hash` 但未断言——回落后 hash 是否清空未钉（§2-B5 预期未提，轻）。
6. B5 的 410 不区分重放/未知/过期（平台三者同码）；实际 ~9s < 60s TTL 走已消费分支，三分支区分由 W7a e2e 承担。
7. B2 重试循环（≤3）每次真实铸造一枚一次性 code：多枚未消费 code + web_handoff 审计噪音；且流量断言只看请求不看 201（hash 含 code 已隐含成功）。
8. B1 无「无 open 权限不渲染」负向对照——由 platform-web-e2e `W3-orca-web` 用例覆盖（24/24 之一），旅程内不补亦可。
9. 真实栈三构件（平台真进程 PORT=0 / 宿主真 Electron + production 方法表 admission:349 无 mode 门 / 真 Chrome channel=chrome）全部成立；ignore-certificate-errors 捷径合理（生产信任由 M108/M109 指纹钉扎承担）。
10. spec:312「唯一捷径」注释失真（另含 http 平台、仪表化 web bundle、API 前置、headless/bypass 四项）——均合理，措辞应对齐 findings 披露。
11. `mkdtempSync('/tmp/...')` + openssl 依赖为 mac/Linux 假设，与 W9a 桌面线同型（云 e2e 家族既有平台口径），非本提交新引入。
12. 平台 seed 项目授权清空（`proj_payment` grants=[]）只作用于本跑专用实例（PORT=0 独立 store），无跨跑/跨测试泄漏。
13. 待启用用例的 /connect、`host.connection_rejected`+`reason='replayed'`、W5c 每订阅重签语义、DOM 选择器全部核实为真（唯 valueTail oracle 除外，见 MAJ-1）；这些预写 oracle 在 W13 启用时仍需按真实 UI 复核一次。

## 放行建议

- MAJ-1 回派修复（web 构建 mode 或换 oracle + findings/commit 措辞更正）后即可关单；MIN-1/2/3 是小改，建议随同顺手收口；MIN-4/5 记入后续（映射表与回归 log 规范化）。
- 红线处置本身合格：B4 以正断言记录边界、缺陷入 U16、W13 排队——「记录不隐藏」的纪律执行到位；W13 派令时应把本报告 MAJ-1 的两个翻转前提（B4 步重写 + web bundle e2e mode）写进验收口径。
