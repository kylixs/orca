# U46 批审计报告 · 项目行三操作语义（详情弹框 / 同页简易工作区 / Orca Web 不动）

> 审计性质：只读。未改代码、未提交 git、未运行长套件。
> 审计基线：`HEAD=1302be087e7`（U46 批实现止于 `d2dbff30598`；`1302be087e7` 仅新增 PROGRESS 记录）。审计以已提交内容为准；工作树中 `cloud-platform/apps/web/styles.css` 的重排与 `acceptance-index.md` 的再生成不属于本批，见 F-12。
> 唯一需求源：`remote-connectivity/design/2026-11-13-cloud-dev-platform/work-orders/u46-three-actions-design.md`（含 §10 审定、§11 增量、§12 复用、§13 md 双模式）。

---

## 0. 总体结论

**总体判定：PASS（有条件）。**

- 0 个 blocker；2 个 major（均可登记后派修，不阻断三操作主流程）；7 个 minor；4 个 info。
- 三操作语义全部落地且与用户裁定一致：详情=平台弹框、打开=同页覆盖层 iframe、Orca Web=新标签不变。
- 两处 major 是规格中明确要求、但实现缺失的交互：
  1. **文件标签 dirty 关闭无确认**（§4.4 要求「保存/放弃/取消」），直接丢弃缓冲区；
  2. **iframe ready 20s 超时只移除覆盖层+toast**，没有 §4.2/§5.3 要求的失败态与「重试」入口（旧宿主 bundle 的兼容退路）。
- 安全面未发现漏洞级问题；postMessage 双向校验、HTML 预览空 sandbox、drawio 不加载三方脚本、文件 RPC worktree 边界、createdBy 角色下发均成立。
- U48/U49 的闭环证据与声明一致（含 U49 后第二轮真栈+构建图复验）；U50 的修复声明与证据一致，但 `git.commitDiff` 仍只有组件级断言、缺真栈调用（F-05）。

---

## 1. 审计对象

| 令 | 提交 | 内容 | 审计结论 |
| --- | --- | --- | --- |
| U46-1 | `ede079c7e86` | `surface:'admin'` + `createdBy`（admin/auditor） | PASS |
| U46-2 | `c42248f942c` | 详情弹框 + dialog 无障碍 | PASS |
| U46-3 | `e7a12bc0ac1` | 打开 → 同页覆盖层 iframe | PASS（F-02 major） |
| U46-4 | `07cf401c36d` | cloud-admin embed 入口/桥/消息协议 | PASS |
| U46-5a | `837615a7c83`+`7f81aa1bf78` | 两栏外壳 + 标签 reducer + 状态栏 | PASS（F-01 major） |
| U46-5b | `9cd0dcf9c60` | 终端标签 + `active` fit 守卫 | PASS |
| U46-6 | `fd410cbff78` | 懒加载文件树 + 名称过滤 | PASS |
| U46-6b | `c341997cc02` | Git 变更/提交面板 + git RPC 前置核验 | PASS |
| U46-7a | `dbb54750bc4` | Monaco 编辑器 + md 双模式 | PASS |
| U46-7b | `179c38dee15` | 图片/HTML/drawio/PDF 预览 + diff 左右/合并 | PASS |
| U46-8 | `5b9b0915052` | 装配 + E1–E7 + 旅程/回归 | PASS（F-04/F-06 覆盖与文档） |
| U48+U50 | `0bbe49e5e81` | 保存宿主绑定、commit diff 身份 | PASS（F-05 U50 真栈缺证） |
| U49 | `1173b6b3901` | 入口 chunk 解耦 + 构建图门禁 | PASS |

---

## 2. 逐令结论

### U46-1 平台契约（PASS）

- `surface:'admin'`：URL 页面换页为 `cloud-admin.html`、追加 `embed=1&project=<id>`、hash 仍为一次性 code；响应仅在调用方显式传 `surface` 时回显。旧控制台「无 body」时 `readJson` 返回 `{}`，响应字段顺序与 URL 形态逐字节保持（测试用正则锁定 `{"url":...,"expiresIn":60}`）。
- `createdBy` 仅 `platform:admin` / `platform:auditor` 下发，其余角色 payload 无该键；`null` 允许。单项目、列表、新建项目三条路径均有断言。
- admin surface 独享 `PROJECT_PROVISIONING`/`PROJECT_NOT_PREPARED` 409；web surface 行为不变。审计 `web_handoff` 成功/拒绝事件均带 `surface`。
- 证据：`cloud-platform/evidence/u46-1-contract/contract-matrix.json`、`cloud-platform/test/e2e/u46-1-platform-contract.e2e.test.ts`。

### U46-2 详情弹框（PASS）

- 「详情」从 `<a target=_blank>` 改为按钮，仅管理员；离线/维护不再置灰，弹框内「打开项目」沿用同一 `openDisabledReason` 置灰并给 title（`app.js:detailEntry` / `openProjectDetail`）。
- 字段覆盖规格 §3.2 全表：创建六字段 + createdBy/创建时间/状态/失败原因/宿主状态/我的权限/直接授权/下载策略/独立页链接；零新增端点；先渲染缓存行再一次 `GET /projects/:id`，失败保留缓存并提示「未能刷新」。
- `dialog()` 增加 Escape、焦点回收、aria-labelledby、首个可聚焦元素聚焦；D1–D6 全部为真实行为断言（按钮类型、1 次 GET、零写、零 window.open、createdBy 角色、焦点回收）。
- 证据：`cloud-platform/test/e2e/web-project-detail.e2e.test.ts`（6/6，第二轮复验）、`cloud-platform/evidence/u46-2-dialog/detail-matrix.json`。

### U46-3 同页覆盖层（PASS，F-02 major）

- 「打开」恰 1×`POST /web-handoff`（`surface:'admin'`）、iframe src 即响应 URL、零新标签、零 `/connect`；旧平台返回 `web-index.html` 时回落新标签 + toast；签发失败给原因 + 重试 + 「在新标签打开 Orca Web」。
- postMessage：父侧校验 `event.source === iframe.contentWindow`、`event.origin === 响应 URL origin`、固定标识 `source:'orca-cloud-admin'`；`close` 握手 300ms 兜底；`logout` 先移除覆盖层再登出。O1–O5 均打在真实平台进程上。
- **F-02**：`ready` 20s 超时仅 `removeWorkspaceOverlay()` + toast（`app.js:596-601`），没有失败态页与「重试」。规格 §4.2 第 189 行与 §5.3 R9 明确要求「失败态 + 重试 / 在新标签打开 Orca Web」；当前实现只覆盖了「签发失败」的失败态。
- 证据：`cloud-platform/test/e2e/u46-3-overlay.e2e.test.ts`、`cloud-platform/test/e2e/web-project-entry.e2e.test.ts`、`cloud-platform/evidence/u46-3-overlay/overlay-matrix.json`。

### U46-4 embed 入口与消息桥（PASS）

- `takeCloudAdminEmbedEntry` 在兑换前清 hash；C1–C5 覆盖清 hash、兑换→持久化→自动打开→ready/dirty、兑换失败回落登录表单+notice、刷新不重复兑换/不双开、非 embed 逐字节不变。
- 父→iframe `close` 调 `closeProject` 后回 `closed`；`logout` 调 `signOut`；ready 超时后 iframe 自身也退出 embed 态。
- 证据：`src/renderer/src/cloud/cloud-admin-embed.test.tsx`、`cloud-browser-bridge.test.ts`（U46-4 describe）、`cloud-platform/evidence/u46-4-embed/summary.json`。

### U46-5a 两栏外壳与标签 reducer（PASS，F-01 major）

- 确实没有左栏：`main`（标签条+内容区）+ 右侧 `w-[300px]` 双 tab（文件 / Git 变更）+ 底部状态栏。
- reducer：同路径去重、关闭激活标签右邻优先、最后关闭空态、新终端取未用最小序号、上限 6、dirty 位按标签记录/关闭清除。
- **F-01**：标签条关闭按钮直接 `dispatch({type:'close'})`（`src/renderer/src/cloud/cloud-simple-workspace.tsx:217-225`），未检查 `state.dirty`，违反 §4.4「文件标签 dirty → 自定义确认（保存/放弃/取消）」；关闭后 reducer 清 dirty，父覆盖层的未保存确认也随之失效，存在静默丢稿风险。
- 证据：`src/renderer/src/cloud/cloud-simple-workspace.test.tsx`、`cloud-simple-workspace-tabs.test.ts`、`cloud-platform/evidence/u46-5a-shell/summary.json`。

### U46-5b 终端标签（PASS）

- 每标签一个 `CloudTerminalPanel`，`title`/`active` 两个可选 prop 向后兼容；hidden 时 `pushViewport` 与 `fit` 被 `activeRef` 抑制，激活时补一次 fit + viewport；卸载调 `terminal.close`。
- T2 断言：只建一次 PTY、切走不卸载重建、隐藏不推 0 尺寸 viewport、关闭释放。
- 证据：`src/renderer/src/cloud/cloud-workspace-terminal-tab.test.tsx`、`cloud-terminal-panel.tsx`、`cloud-platform/evidence/u46-5b-terminal-tab/summary.txt`。

### U46-6 文件树（PASS）

- 逐目录懒加载、按相对路径缓存、`刷新` 重拉根与已展开层、`.git` 由共享 `parseEntry` 隐藏、目录优先排序复用 `sortCloudEntries`；「每次展开恰 1×`files.readDir`」、错误行不伪装空目录。
- 文件名过滤复用 `FileExplorerNameFilter`；对未加载目录显示「未展开的目录中可能还有匹配」，不做事无界的全仓 crawl。
- 证据：`src/renderer/src/cloud/cloud-workspace-file-tree.test.tsx`、`cloud-platform/evidence/u46-6-filetree/summary.json`。

### U46-6b Git 变更面板（PASS）

- 首步核验已留档：`git.status/history/commitCompare/commitDiff/diff` 均在 `CLOUD_HOST_METHODS` 宽集合内，`cloudMethodAccess` 将 `git.*` 映射到 `terminal`，`cloudGitAccessOf` 将 `commitDiff` 归为只读，路径参数 `filePath/oldPath` 受守卫。
- 上下布局：工作区变更按状态分组（同一文件 staged/unstaged 用 `getDominantStatus` 折叠）在上，提交记录在下；点击提交经 `git.commitCompare` 懒加载文件列表；点击文件回调 diff。
- 证据：`src/renderer/src/cloud/cloud-workspace-git-panel.test.tsx`、`cloud-platform/evidence/u46-6b-git-panel/summary.json`。

### U46-7a 编辑器（PASS）

- `files.read/files.write` 走 `cloudWorktreeSelector(workspacePath)`；truncated 强制只读且无保存入口；`file:write` 缺失只读；保存前重读比对 `baseContent`，冲突给「重新加载/覆盖保存/取消」；保存失败行内错误码。
- md 双模式：预览（复用 `MarkdownPreviewBody`，GFM/表格/代码块/净化/`javascript:` 过滤）+ Monaco 源码编辑，无 WYSIWYG；Cmd/Ctrl+S 通过 `monaco.KeyMod.CtrlCmd`。
- 证据：`src/renderer/src/cloud/cloud-workspace-file-tab.test.tsx`、`cloud-workspace-file-io.test.ts`、`cloud-platform/evidence/u46-7a-editor/summary.json`。

### U46-7b 预览与 diff（PASS）

- 预览：图片 data URL（含 svg/drawio.svg）、HTML `sandbox=""` + `referrerPolicy="no-referrer"` + srcDoc（无 allow-scripts/allow-same-origin）、drawio 降级为源码且明说不加载第三方查看器、PDF/其他二进制占位、large diff 概要卡。
- diff：工作区行 `git.diff(staged:false, compareAgainstHead:true)`；提交行从 `commitCompare.summary.parentOid` 解析父提交后调 `git.commitDiff`（完整 oid）；左右/合并切换驱动 Monaco `renderSideBySide`；二进制图片双侧 data URL。
- 证据：`cloud-workspace-preview-tab.test.tsx`、`cloud-workspace-diff-tab.test.tsx`、`cloud-platform/evidence/u46-7b-preview-diff/summary.json`。

### U46-8 装配与真栈（PASS，F-04/F-06）

- 装配链：`CloudApp embed → EmbeddedWorkspace → CloudSimpleWorkspaceSession → workspace.info(branch) → 四类型工厂 + 文件树/Git 面板 + dirty 上报`。四类型与右栏均在生产链路接线。
- E1–E7 全部打在真实平台 + TLS 宿主 + 真 PTY + 真仓库上，无产品 stub（第二轮 `final-journey-verification-2` 复验 7/7）。
- **F-04**：实现版 E 编号与设计 §6.2 的清单不一致：设计 E3（真实图片/HTML fixture）、E4（工作区外写入 `path_denied` + 审计）、E6（重放/过期 410、无 `open` 403）、E7（关闭覆盖层后 PTY/套接字回收）没有以设计编号落地；其中写边界/重放由更早套件覆盖，但图片/HTML 真宿主读取与「覆盖层关闭→PTY 回收」只有组件级/直接 RPC 级证据。
- 证据：`src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`、`cloud-platform/evidence/u46-8-assembly/*`、`cloud-platform/evidence/final-journey-verification-2/summary.json`。

---

## 3. 发现清单（分级）

| ID | 级别 | 令 | 发现 | 位置/证据 |
| --- | --- | --- | --- | --- |
| F-01 | **Major** | U46-5a/7a | 文件标签 dirty 关闭无确认，缓冲区被直接丢弃；父覆盖层的未保存确认同时失效 | `src/renderer/src/cloud/cloud-simple-workspace.tsx:217-225`；无对应测试 |
| F-02 | **Major** | U46-3 | ready 20s 超时只移除覆盖层 + toast，缺 §4.2/§5.3 要求的失败态与「重试」入口（旧宿主 bundle 兼容路径） | `cloud-platform/apps/web/app.js:596-601` |
| F-03 | Minor | U46-8/4 | `CloudSimpleWorkspaceDegraded`（§4.9 的「未授予终端权限，无法创建工作区」页）未在生产 embed 链路接线；ensure 失败实际显示通用 `CloudEmbedProgress`（含错误码） | `src/renderer/src/cloud/cloud-app.tsx:351-380`、`cloud-simple-workspace.tsx:170-176` |
| F-04 | Minor | U46-8 | E1–E7 编号/覆盖面与设计 §6.2 有偏移：真实图片/HTML 预览、写边界 `path_denied`、重放/过期、覆盖层关闭后的 PTY 回收未按设计项真栈覆盖 | `src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts` |
| F-05 | Minor | U50 | `git.commitDiff` 仅组件断言参数，真栈 E6 只调了 `git.status/history/commitCompare/git.diff`；第二轮 summary 亦注明 commit-row wiring 在套件范围外 | `cloud-platform/evidence/u48u50-fix/summary.json`、`final-journey-verification-2/summary.json` observations |
| F-06 | Minor | U46-8 | `u46-8-assembly/summary.json` 未随修复刷新：仍写 E4「pass with red」、R1/R2/R3 红项；实际 `e4-edit-save.json` 已 ok:true 且第二轮 `redItems: []`。11 步浏览器旅程产物早于 U49（含 stub 说明），U49 后未重跑整段旅程（有页面冒烟+构建图+web-project 套件补偿） | `cloud-platform/evidence/u46-8-assembly/summary.json`、`browser-journey.json` |
| F-07 | Minor | U46-4 | iframe 侧父消息校验在 `document.referrer` 为空时接受任意 origin（`expected === null \|\| ...`），且现有测试未覆盖「错误 origin/source 被忽略」的负例 | `src/renderer/src/cloud/cloud-app.tsx:39-45`；`cloud-admin-embed.test.tsx` |
| F-08 | Minor | U46-3 | 失败态 shell 未登记到 `workspaceOverlay`；若在失败态下退出登录，`closeWorkspaceForLogout()` 不会移除它（顶栏关闭可移除） | `cloud-platform/apps/web/app.js:534-541,637-642` |
| F-09 | Minor | U46-5a | 标签条缺 §4.4 的「文件图标/终端图标」；终端关闭无「关闭将结束该终端会话」tooltip；无 `file:read` 时空态仍提示「从右侧文件树打开文件」 | `src/renderer/src/cloud/cloud-simple-workspace.tsx:191-249`、`cloud-simple-workspace-empty-state.tsx` |
| F-10 | Info | U46-4 | `ready.latencyMs` 是「挂载→ready」本地耗时，不是线路 RTT；状态栏以 `ms` 呈现可能被读成网络延迟 | `src/renderer/src/cloud/cloud-app.tsx` ready effect；`app.js` route badge |
| F-11 | Info | U46-7b | HTML 预览用 `files.readPreview`（而非 §4.8 字面写的 `files.read`）；单次只读、功能等价，不算缺陷 | `cloud-workspace-preview-tab.tsx:205-224` |
| F-12 | Info | 工作树 | `cloud-platform/apps/web/styles.css` 存在与本批无关的整文件重排，`acceptance-index.md` 亦为未提交再生成；建议不要混入本批提交 | `git status` |
| F-13 | Info | U46-3/U49 | 平台控制台 11 步真浏览器旅程未在 U49 后重跑；U49 用「真实产物页面冒烟 + 构建图 + web-project 双套件 16/16」覆盖其修复面 | `cloud-platform/evidence/u49-build-graph/*`、`final-journey-verification-2/summary.json` |

---

## 4. 安全面核对

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 父→iframe postMessage | PASS（F-07 硬化项） | source=window.parent；origin=referrer origin；无 referrer 时通配 |
| iframe→父 postMessage | PASS | 固定标识 `orca-cloud-admin` + source + 响应 URL origin；消息只含 route/latency/dirty |
| URL 不落日志 | PASS | 控制台/桥/embed 无 console 输出 URL；无 `location.href` 写入 |
| HTML 预览脚本 | PASS（无脚本） | `sandbox=""`、`srcDoc`、no-referrer |
| drawio 三方脚本 | PASS（拒绝） | 仅渲染源码 + 明确降级文案，无外部查看器 |
| 文件 RPC worktree 边界 | PASS | 全部 `worktree: path:<workspacePath>`；相对路径由 `cloudChildPath` 拼接（拒绝 `/ \ . ..`）；host `cloud-path-guard` 仍为权威 |
| createdBy 角色下发 | PASS | 仅 admin/auditor；其余角色无键 |
| iframe 嵌入面 | PASS（Q4 维持开放） | 宿主静态页仍无 `X-Frame-Options`；设计记为开放问题，本批未改 |
| 关闭/登出回收 | PASS（F-08 边缘） | close→closeProject→closed + 300ms 兜底；logout 先 postMessage 再移除；平台吊销为权威 |

---

## 5. 复用纪律（§12）

| 组件 | 先例来源 | 结论 |
| --- | --- | --- |
| 文件树 | orca web explorer（`useFileExplorerTree`/`FileExplorer`）+ 复用 `FileExplorerNameFilter` | 已注记不能 import 的原因，最小适配，未重造树逻辑 |
| 终端 | W5a `CloudTerminalPanel` + W5c 子票 | 直接复用，仅加 `title/active` |
| Git 分组/配色 | Source Control `status-display.ts` | 直接复用 `getDominantStatus`/`STATUS_LABELS`/`STATUS_COLORS` |
| md 预览 | `components/editor/MarkdownPreviewBody` + 插件管线 | 直接复用 |
| Monaco | `@/lib/monaco-setup` + `installMonacoE2EProbe` | 复用加载与 E2E 探针 |
| 外壳/空态/状态栏 | `AppWorkspaceShell`、`SidebarCloudSessionEmptyState`、`CloudLoginStatusSegment` | 形态参考/适配并注明来源 |
| 平台弹框 | `dialog()` + `.kv` + 既有 grants/policy 端点 | 零新增端点，仅补无障碍 |

未发现与既有能力重复建设的第二套传输/第二套浏览器客户端。

---

## 6. 兼容性核对

| 场景 | 结论 | 依据 |
| --- | --- | --- |
| 旧控制台不发 `surface` | PASS：回复字段/顺序、URL 形态逐字节不变 | U46-1 正则断言 |
| 旧平台 + 新控制台 | PASS：识别 `web-index.html` → 回落新标签 + toast | O3 |
| 新平台 + 旧控制台 | PASS：不发送 surface，行为不变 | 服务端默认 `web` |
| 旧宿主 bundle + 新控制台 | **部分 PASS**：20s 后确实释放控制台，但缺失败态/重试（F-02） | `app.js:596-601` |
| 详情弹框只读平台数据 | PASS：新旧宿主 bundle 均可用；createdBy 缺省显示「未记录」 | D2/D3、`projectDetailHtml` |
| 非 embed 管理台页 | PASS：仍走 `CloudProjectWorkspace`，C5 无自动打开/无消息 | C5 |
| `createdBy` 旧前端 | PASS：wire-additive，旧前端忽略 | U46-1 |

---

## 7. 测试质量

- 断言均驱动真实行为：平台侧用真实 API 进程 + happy-dom 加载真实 `app.js/styles.css`；工作区组件用 scripted RPC + 真实 reducer/懒加载；真栈用真实平台、TLS 宿主、真 PTY、真 git。
- 覆盖良好的代表：O4 外部 origin 消息被忽略、C4 重渲染不双开、T2 隐藏不推 0 尺寸 viewport、T3 展开仅一次 readDir、T4 冲突三分支、T5 sandbox 属性、U50 提交行携带完整 oid。
- 覆盖缺口：F-04（设计 E 项偏移）、F-05（commitDiff 无真栈）、F-07（iframe 侧负例）、F-01（dirty 关闭确认无测试）。

**变异抽查（静态，未修改仓库）**

1. reducer `close` 中把 `tabs[index + 1] ?? tabs[index - 1]` 改成左邻优先 → `cloud-simple-workspace-tabs.test.ts`「关闭 active 标签优先激活右邻，无则左邻」会失败（期望 `terminal-3`，左邻给 `terminal-1`）。
2. 删除 `HtmlPreview` 的 `sandbox=""` → `cloud-workspace-preview-tab.test.tsx`「HTML 在空 sandbox iframe 中渲染」会在 `getAttribute('sandbox') === ''` 处失败。
3. 移除 `writeCloudWorkspaceFile` 的 `expectedExecutionHostId` → `cloud-workspace-file-io.test.ts` 的精确 payload 断言失败，真栈 E4 也会复现 U48 的宿主拒绝。

结论：关键路径的测试具备真实鉴别力；缺口集中在未写的用例，而非空断言。

---

## 8. 红项闭环（U48/U49/U50）

| 项 | 声明 | 证据 | 结论 |
| --- | --- | --- | --- |
| U48 | `files.write` 补 `expectedExecutionHostId:'local'`，真宿主接受 | `e4-edit-save.json`（10:54 重新生成，`adapterWrite.ok=true`）；`final-journey-verification-2` 真栈 7/7 无 stub | **一致** |
| U49 | 入口渲染树拆入无副作用模块 + 构建图门禁 | `u49-build-graph` entryImporters 为空、入口 chunk 2770B/2139B；真实产物页面冒烟 cloud-admin/web-index 双 PASS；第二轮 HEAD=d2dbff 复验 `verifyWebBuildExit=0`、guard 4/4 | **一致** |
| U50 | commit 行携带 commitOid/parentOid，diff 标签调 `git.commitDiff` | 组件测试断言完整参数与 tab id `diff:<oid>:<path>`；真栈 E6 未调用 commitDiff（第二轮 summary 自述范围外） | **声明一致，真栈覆盖不足（F-05）** |

---

## 9. 风格 / AGENTS

- 新文件命名具体（`cloud-simple-workspace-tabs.ts`、`cloud-workspace-file-io.ts`、`cloud-workspace-git-panel-model.ts` 等），无 helpers/utils 类空泛命名。
- 未发现 `max-lines` 抑制；未发现无理由的 `eslint-disable/oxlint-disable`。`cloud-terminal-panel.tsx` 的 `react-doctor/effect-needs-cleanup` 为带理由的既有抑制。
- 新渲染层文件只使用 token/shadcn 原语；对全部新增 `.tsx` 运行 `oxlint --config config/oxlint-design-system.json` 与常规 `oxlint` 均为 exit 0。
- 渲染层新代码无 `as` 断言（仅 `as const`）。平台 e2e 新测试的 `as any` 带 `oxlint-disable -- 说明`，沿用既有 `web-project-*.e2e` 先例；`cloud-platform/` 不在根 changed-lines 门禁范围内。
- 跨平台：保存快捷键用 `KeyMod.CtrlCmd`；平台 Web 判定 Mac 仅用于展示设备名；无硬编码 `metaKey` 新增。

---

## 10. 证据索引

- 契约/平台：`cloud-platform/evidence/u46-1-contract/contract-matrix.json`、`u46-2-dialog/detail-matrix.json`、`u46-3-overlay/overlay-matrix.json`
- 渲染层：`u46-4-embed/summary.json`、`u46-5a-shell/summary.json`、`u46-5b-terminal-tab/summary.txt`、`u46-6-filetree/summary.json`、`u46-6b-git-panel/summary.json`、`u46-7a-editor/summary.json`、`u46-7b-preview-diff/summary.json`
- 真栈/旅程：`u46-8-assembly/{summary.json,e1..e7,browser-journey.json,screenshots/}`
- 修复闭环：`u48u50-fix/summary.json`、`u49-build-graph/*`、`final-journey-verification-2/summary.json`
- 测试：`cloud-platform/test/e2e/u46-1-platform-contract.e2e.test.ts`、`web-project-detail.e2e.test.ts`、`u46-3-overlay.e2e.test.ts`、`web-project-entry.e2e.test.ts`、`src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`、`src/renderer/src/cloud/cloud-admin-embed.test.tsx` 及各组件测试。

---

## 11. 建议（先登记后派修，本次不改代码）

1. **F-01（Major）**：关闭 dirty 文件标签前弹出「保存/放弃/取消」；取消保持标签，保存走现有 save 流程，放弃才 `close`。同时保证 reducer 的 dirty 位只在确认后清除。
2. **F-02（Major）**：把 ready 超时也走 `mountWorkspaceFailure`（或同级失败态），提供「重试」与「在新标签打开 Orca Web」，与签发失败一致。
3. **F-03**：把 ensure 失败映射到 `CloudSimpleWorkspaceDegraded`（或让其文案复用 W5b），确保 §4.9 的权限降级页在生产链路可见。
4. **F-04/F-05**：补真栈断言：图片/HTML `readPreview` fixture、工作区外写入 `path_denied` 审计、覆盖层关闭后 PTY/套接字回收、`git.commitDiff` 真仓库调用。
5. **F-06**：修复提交后重新生成 `u46-8-assembly/summary.json`（或显式标注为历史快照），避免读者把已清红的 R1–R3 当现状。
6. **F-07**：为 iframe 侧补「错误 origin/source 忽略」负例；若可获得平台 origin 配置，优先用配置值而非 referrer 推导。
7. **F-09**：补标签类型图标与终端关闭 tooltip；空态文案按 `file:read` 权限分支。
