# 设计评审 03 — HTML 打开方式（第三轮复审）

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/html-open-modes.html`；对照 `mobile/src/files`、`mobile/src/components`、`mobile/src/session`、`mobile/src/storage`、`mobile/src/settings`、`react-native-webview@13.16.2` 与文件浏览需求。
复审基线：`reviews/design-review-02.md`（REJECTED：1 BLOCKER / 7 MAJOR / 8 MINOR）。
原型验证：本地 HTTP 提供页面后用 Playwright 实测（不修改文件）；同时做静态核对。

结论：REJECTED
统计：BLOCKER 0 / MAJOR 5 / MINOR 9

---

## Prior findings（review-02 逐条核对）

| 编号 | 级别 | 状态 | 核对结果 |
|---|---|---|---|
| 02-B1 | BLOCKER | 部分解决 | `tasks.md:21` 的 HT-U1 已只导出模式动作，`tasks.md:24` 的 HT-U4 已扩展 FB 唯一构造器，HT-U3 已把切换放到第二行工具栏；但共享构造器的动作顺序与 Preview 语义仍未统一 → 03-M1、03-M2。 |
| 02-M1 | MAJOR | 已解决 | 不可成立的 Orca 浏览器、无限循环超时、非 UTF-8 报错断言已从 `test-plan.md` 删除；C4/C6 改为可判定。残留“记录/固定文案”表述 → 03-m2。 |
| 02-M2 | MAJOR | 部分解决 | `design.md:333-341` 已改为 scheme-only、明确不区分手势，C11 断言可落地；但 iframe 的顶层/子帧策略仍有平台缺口 → 03-M4。 |
| 02-M3 | MAJOR | 已解决 | `design.md:349-354` 固定 worktree 两个模式、line/terminal 直开；A8 与原型状态 01 一致。残留正文旧计数描述 → 03-m1。 |
| 02-M4 | MAJOR | 部分解决 | HT-V1/U13/T2/U11 依赖已修正；但 HT-U17/FB-U11 仍重复且依赖方向相反，HT-U12 与 HT-V1 仍可并行改同一 body → 03-M5、03-m9。 |
| 02-M5 | MAJOR | 部分解决 | 优先级已写入 `design.md:356-369`，但顺序把 `route.mode` 放在 terminal artifact 之上，与 source-only 冲突 → 03-M3。 |
| 02-M6 | MAJOR | 已解决 | `design.md:343-347` 与 8.5 只保留设置页恢复；B2 无 Ask、原型状态 10 是唯一恢复入口、菜单无 Reset。 |
| 02-M7 | MAJOR | 已解决 | `design.md:380-388` 已补齐忽略/提示规则；C8 覆盖 `mailto/tel/javascript/about/blob///#/空 href` 与 `./`、`../`、裸名、根绝对路径。残留 http(s)/data 与空文档用例 → 03-m3。 |
| 02-m1 | MINOR | 已解决 | 实测：文件列表状态 01/09 无 header More，无文件大小标签，无 prefbar，无 missing-asset 占位、无 Link blocked 弹层；状态 02-08 的 7 个溢出按钮全部打开同一个 `data-overflow-sheet`。 |
| 02-m2 | MINOR | 已解决（设计/原型） | 512 KB 禁用态、固定英文文案、`aria-disabled`、`Showing first 512 KB` 在状态 05 齐全；测试的精确文案仍缺 → 03-m2/03-m4。 |
| 02-m3 | MINOR | 已解决 | 白名单落在新模块 `html-preview-scheme.ts`，`openExternalLink` 契约不变；R8 保留回归。 |
| 02-m4 | MINOR | 已解决 | `design.md:368` 明确 page-local、返回不写偏好；原型状态 04 无 restore。正文旧表述未清 → 03-m1。 |
| 02-m5 | MINOR | 已解决 | 长按/溢出不显示 remember，状态 09 动作齐全；动作顺序与共享 builder 的冲突 → 03-M1。 |
| 02-m6 | MINOR | 已解决 | Copy content 已进入 8.5、B10、原型状态 02-05/07/08/09；截断副文案 `Copies the first 512 KB` 存在。 |
| 02-m7 | MINOR | **未解决** | 设计正文仍保留旧偏好键、旧计数、旧 header 切换、旧返回规则、设置/菜单恢复与旧动作顺序 → 03-m1。 |
| 02-m8 | MINOR | 已解决（有平台保留） | 8.7 与 HT-U17/FB-U11 已纳入文字选择；`textInteractionEnabled` 仅 iOS，C13 未分平台 → 03-m8。 |

---

## Findings

### BLOCKER

无。

### MAJOR

- **[MAJOR] 单一动作构造器的顺序在 HTML 与文件浏览两份规范之间互相冲突，B9 的“数组完全等于 B2”必然让一侧测试失败。**
  HTML 侧固定为 `Preview、Source、Open with、Save to phone、Copy content、Copy path、Cancel`（`design.md:374`、`test-plan.md:53`、`ui/README.md:7/28`、原型状态 02-09）；文件浏览侧固定为 `Preview、Save to phone、Open with、Copy content、Copy path、Cancel`（`2026-11-10-mobile-file-browser/design.md:85-91`、同目录 `test-plan.md:37`）。`tasks.md:24` 的 HT-U4 明确复用文件浏览的 `buildFileActions`，HT-U15/HT-Q7 又要求“单一 builder、动作数组完全一致”（`tasks.md:28/54`），所以两份期望数组不可能同时成立。HTML 自己的 7.3（`design.md:231`）也仍是“下载/保存、用其它 App”的旧顺序。
  **建议**：选定唯一顺序并同步所有产物。推荐沿用文件浏览已定顺序（`Preview、Source、Save to phone、Open with、Copy content、Copy path、Cancel`），更新 HTML `design.md:231/374`、`test-plan.md:53`、`ui/README.md:7/28` 与原型状态 02-09；或反向更新 FB 的 design/test。两份测试计划里各放一份相同的期望数组，由 HT-Q7 直接断言。

- **[MAJOR] “HTML 只追加 Preview/Source” 与文件浏览已有的 Preview 动作重复，设计没有定义抑制/合并规则；这与 B9 “无重复”和原型只显示一个 Preview 冲突。**
  `design.md:373` 要求 HTML “只追加 Preview/Source 两个模式项”，而共享构造器的第一个动作已经是“预览”（`2026-11-10-mobile-file-browser/design.md:86`、其 `test-plan.md:37`）。按“追加”实现会得到两个同名 Preview：一个打开文件预览，一个切换渲染模式；在预览页里前者还是冗余动作。原型状态 09 和测试 B2/B9 都只允许一个 Preview（`test-plan.md:53/58`、原型 739-744）。任务表也没有说明构造器如何区分“行长按上下文”和“预览页上下文”（`tasks.md:24`）。
  **建议**：在 8.5 写明：对 HTML，共享构造器用模式项 `Preview` 取代通用文件 `Preview`（目标带 `mode=preview`），`Source` 紧随其后；预览页上下文不再生成单独的通用 Preview。若保留两个动作，必须给其中一个改名（与原型/README 的英文文案不符），不可接受。补 builder 单测：行长按、预览页溢出两个上下文各断言唯一数组。

- **[MAJOR] 8.4 的“唯一顺序”把 `route.mode` 放在 terminal artifact 与不可渲染状态之上，与 terminal artifact source-only、truncated 禁用 Preview 自相矛盾。**
  `design.md:361-365` 规定 `route.mode > source=terminalArtifact (force source) > line/column ...`，但 `design.md:353` 说 terminal artifact 直接 Source、不提供渲染，`design.md:369` 说 terminal artifact（可编辑/只读）都 `sourceOnly`，`design.md:289` 还要求 normalize 对 terminalArtifact 分支校验/透传 `mode`。因此 `?source=terminalArtifact&mode=preview` 按顺序会进入 Preview，直接违反 R7（`test-plan.md:95`）和 sourceOnly。worktree 的 `mode=preview` + 读取后 `truncated` 也没有回退规则：8.3 只说页面内禁用 Preview，`C5/C9` 只断言禁用态，没有说最终显示 Source；原型状态 05 却显示 Source。`tasks.md:12` 的 HT-T3 重复了同一错误顺序。
  **建议**：把不变量写死为“terminal artifact 与 `truncated` 永远 Source，忽略显式 route.mode”，或调整顺序为 `sourceOnly/truncated > route.mode > line/column > preference > ask`。补 A14（`source=terminalArtifact&mode=preview` → Source，无渲染 tab）与 C19（`mode=preview` + 513 KB → Source + 截断横幅），并同步 HT-T3/HT-U12。

- **[MAJOR] iframe 导航策略与现有实现及设计中的“iframe 可发起网络请求”不一致；iOS 上 iframe 会被交给 `openExternalLink`，C18 没有可判定断言。**
  `design.md:244` 声称 iframe 与 fetch/图片仍可发起网络请求，`design.md:240-243` 只写“顶层 about:blank/data”，却没有规定按 `isTopFrame` 区分。现有 `mobile/src/components/MobileHtmlPreview.tsx:61-67` 对任何非 `about:blank`/`data:` 的请求都调用 `openExternalLink`；而 iOS 的 `onShouldStartLoadWithRequest` 对子帧也会触发（`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1374-1411`，`isTopFrame` 在 1356 行计算），Android 则固定 `isTopFrame: true` 且不为内层 frame 触发（`.../android/.../TopShouldStartLoadWithRequestEvent.kt:11-16`）。结果是：含 `<iframe src="https://...">` 的 HTML 在 iOS 上会拉起外部浏览器而不是渲染 iframe，在 Android 上却能渲染；C18 只写“native 记录边界”（`test-plan.md:83`），无法发现该差异。
  **建议**：在 8.1/HT-U7 明确“外部打开/拒绝只作用于顶层 frame”，子帧请求按白名单放行（或在不拉起外部 App 的前提下拒绝）；为 `isTopFrame` 增加组件/单测。C18 改成可判定断言：iOS/Android 的 iframe 均渲染、不拉起外部浏览器；web sandbox 不执行脚本。平台差异写进测试环境说明。

- **[MAJOR] HT-U17 与 FB-U11 重复实现同一件事，且依赖方向互相矛盾，可能形成循环或并行修改同一 Frame。**
  `tasks.md:42` 的 HT-U17 写“FB-U11 依赖本任务”，但依赖列又列了 `HT-U6、FB-U11`；`2026-11-10-mobile-file-browser/tasks.md:38` 与 `design.md:396` 则说 FB-U11 依赖 HT-U6/HT-V1，并不依赖 HT-U17。若按字面实现，FB-U11 → HT-U17 → FB-U11 构成环。另外 `tasks.md:35` 的 HT-U6 签名已经包含 `textInteractionEnabled`，与 HT-U17 的职责重复，也违背 7.2 的 Frame API（`design.md:221` 尚无该 prop）。
  **建议**：只保留一个 owner。推荐删除 HT-U17，由 FB-U11 按 8.7 在 HT-U6/HT-V1 之后追加；或保留 HT-U17（仅依赖 HT-U6）并删除 FB-U11、同步 FB 任务表。从 HT-U6 签名中移除 `textInteractionEnabled`，避免两边都改 Frame。

### MINOR

- **[MINOR] 设计正文仍保留被第 7/8 节推翻的旧值和旧行为，容易误导实现。**
  `design.md:86` 与 `:168` 仍写偏好键 `orca:mobileFileOpenMode:html`，而 7.7/8.5、测试 A9 与原型状态 10 都是 `orca:mobileHtmlOpenMode`；`:93-95` 仍是“≥2 个模式才弹、1 个直开”，与 8.3 固定两个模式冲突；`:101-102` 与组件树 `:153` 仍把 Preview/Source 放在 header，与 7.1/8.5 的第二行工具栏冲突；`:114` 仍写 `setParams`/“返回时保留”，与 8.4 的 page-local 冲突；`:50` 仍写“设置/菜单中恢复”，与 8.2 的仅设置页冲突；`:231` 的动作顺序与 8.5 不同（见 03-M1）。
  **建议**：逐条删除或就地标注“已被 8.x 取代”，偏好键、动作顺序、header 位置只保留一个事实源。这是 review-02 m7 的残留。

- **[MINOR] 测试计划仍有“记录”“文案固定”这类不可判定断言。**
  `test-plan.md:74` 的 C9 只写“文案固定”，没有给出要断言的英文串；C5（`:70`）给了源码文案但没给 512 KB 横幅；`:77` 的 C12 对 http(s) 写“按 design 8.1 记录”；`:83` 的 C18 写“native 记录边界”；`:76` 的 C11 仍是单行，而 `design.md:394` 要求拆成 iOS/Android 两条；`:79` 的 C14 “无 App 给出提示”没有文案。它们都不算 pass/fail 断言。
  **建议**：在期望列直接写精确英文（512 KB 横幅、源码截断、无 App toast、blocked scheme toast）；C11 拆成 C11a/C11b 或两行平台期望；C12/C18 改成“观察到 http(s) 脚本会外开（已知风险）”或把风险说明移出用例表。

- **[MINOR] 相对资源检测矩阵仍缺设计 8.6 的两类，提示文案也未统一。**
  `design.md:385` 明确 `http:`、`https:`、`data:` 不提示，`design.md:251` 还要求空 HTML 用例；`test-plan.md:73` 的 C8 没有这三类。文案方面，7.5（`design.md:250`）写“Some relative assets may not load”，原型（`html-open-modes.html:314`）与 README 写“Relative assets may not load: … . Detected from src / href / url() in this file.”，且 README 的 Normative English copy 列表没有收录这句。
  **建议**：C8 补 `http:`/`https:`/`data:` 与空文档；把准确文案写进 design 7.5、README 的规范文案和 C2 期望，或删掉原型额外那句。

- **[MINOR] 512 KB 截断文案与现有共享组件不一致，直接改会波及 Markdown（R2）。**
  设计/测试要求 HTML 源码显示“Showing first 512 KB”（`design.md:257`、`test-plan.md:70/74`、README），但现有 `MobileFilePreviewSourceText.tsx:61-67` 输出的是“Preview truncated. File size: …”，且该组件被 Markdown 预览共用（`MobileFileMarkdownPreview.tsx:72`）。R2（`test-plan.md:90`）又要求 Markdown 不变。
  **建议**：给 HTML 源码增加专用截断 note（或 `truncatedNote` prop），保留 Markdown 现有文案，并在 R2 中断言 Markdown 的现有文案未被改变；任务 HT-U9 写清这一点。

- **[MINOR] 被阻止 scheme 的 in-frame toast 只存在于原型/README/8.7，Frame API、任务和测试都没有承接。**
  `design.md:395` 说“改为设计内 toast”，`ui/README.md:7/27` 把它当作规范文案，但 7.2 的 Frame API（`design.md:221`）没有 `onBlockedScheme` 之类的回调，HT-V4（`tasks.md:41`）只要求拒绝，C10/C11（`test-plan.md:75-76`）只断言“不拉起外部 App”。在 web 上该 toast 是否可观测也未说明。
  **建议**：给 Frame 增加 `onBlockedScheme?` 并落到 HT-V4；native 断言 toast 文案；明确 web 要么没有 toast、要么由 shell 上报，并补相应测试。

- **[MINOR] 原型状态 05/06 隐藏了 Preview（以及 Preview/Source/Copy content），但 8.3 的 `availableHtmlOpenActions({source,hasLineTarget})` 没有 truncated/read-failure 输入，无法推出这些隐藏项。**
  `design.md:354`；原型状态 05 的 sheet 只有 Source/Open/Save/Copy content/Copy path，状态 06 只有 Open/Save/Copy path；8.5（`design.md:374`）说“不可用项按能力隐藏”。测试 B2 只覆盖正常文件，没有断言这两个数组。
  **建议**：给模式/动作能力输入补 `previewDisabled`（truncated）与 `readFailed`，由预览页传入；在测试计划中补状态 05/06 的期望动作数组。

- **[MINOR] 原型设置页用内联 radiogroup，与现有 Browser 设置页的“行 + PickerModal”交互不一致。**
  原型状态 10（`html-open-modes.html:771-785`）是三行 radio；现有 `mobile/src/settings/browser-settings-screen.tsx:96-120` 是“Open terminal links”行 + `PickerModal`。7.8（`design.md:271`）只说“选择器/与 terminalLinkOpenMode 同页”，未指定用哪种；HT-T5 也没有。
  **建议**：选定一种并同步 design/README/HT-T5/原型。推荐复用现有行 + PickerModal（少一套交互与焦点逻辑）；若保留内联 radiogroup，需在设计中写明并补 a11y 用例。

- **[MINOR] `textInteractionEnabled` 只作用于 iOS，C13 没有平台区分。**
  `design.md:396`、`tasks.md:35/42` 把它当成跨平台能力；RN WebView 的类型标注为 `@platform ios`（`mobile/node_modules/react-native-webview/lib/WebViewTypes.d.ts:561-565`，native 实现只在 Apple 侧）。C13（`test-plan.md:78`）要求长按选择与链接不冲突，但没有说明 Android 依赖 WebView 默认行为。
  **建议**：在设计/任务中写明 Android 靠 WebView 默认选择；C13 分平台写期望（iOS 由 prop 控制，Android 默认行为），或至少加一条平台说明。

- **[MINOR] 任务图仍有两处未列出的文件重叠/依赖。**
  HT-U12（`tasks.md:15`）修改预览路由/body 的 `htmlRenderable`/`sourceOnly`，但只依赖 HT-T3；HT-V1（`tasks.md:39`）也修改 `MobileFilePreviewBody.tsx`，两者可并行，违背“禁止并行改同一文件”的精神。HT-U3（`tasks.md:23`）消费 HT-T3 建立的 page-local mode，却未依赖 HT-T3（也未依赖 HT-V1 的 body）。
  **建议**：HT-U12 依赖 HT-V1（或把 flags 并入 HT-V1）；HT-U3 依赖 HT-T3（和 HT-V1）；把文件重叠写进合并顺序。

---

## Prototype checklist

| 检查项 | 结果 |
|---|---|
| 文件列表 header More | 通过。状态 01/09 用 44px spacer（`html-open-modes.html:253/721`），无未绑定 More。 |
| 文件大小标签 | 通过。目录行无 size 文案。 |
| prefbar / Reset to Ask | 通过。无 prefbar；状态 10 是唯一恢复入口；所有菜单无 Reset/Ask。 |
| missing-asset 占位 / Link blocked 弹层 | 通过。状态 02 的警告是设计内检测提示；状态 08 用 in-frame toast，不是弹层。 |
| 所有溢出按钮打开同一 sheet | 通过（Playwright 实测）：状态 02-08 共 7 个 `data-toggle-menu` 全部打开各自的 `data-overflow-sheet`，动作顺序一致、不可用项按状态隐藏。 |
| 动作顺序 | 与 8.5/B2/README 一致（Preview、Source、Open with、Save to phone、Copy content、Copy path、Cancel）；与 FB design/test 冲突 → 03-M1。 |
| 自动弹层两个模式 | 通过。状态 01 只有 Preview/Source + remember + Cancel。 |
| 长按菜单 | 通过。状态 09 与溢出同序，无 remember、无 Ask，有一个 Preview（与 03-M2 的实现规则需对齐）。 |
| 相对资源提示 | 通过。状态 02 列出 `./styles/app.css`、`./assets/hero.png`、`url(../images/bg.png)`，来自演示源码实际引用。 |
| 512 KB | 通过。状态 05 Preview `disabled`/`aria-disabled`、固定横幅、源码 `Showing first 512 KB`；caption 明确 511/512 可渲染、513 起截断。 |
| 读取失败 | 通过。状态 06 只提供 Retry，sheet 隐藏 Preview/Source/Copy content。 |
| 无可用 App | 通过。状态 07 隐藏 Open with，保留 Save to phone 提示。 |
| 被阻止 scheme | 通过（视觉）。状态 08 toast 文案与 README 一致；实现回调/测试缺口见 03-m5。 |
| 设置恢复 | 通过（入口）。状态 10 Ask/Preview/Source；控件形态与现有设置页不同 → 03-m7。 |
| 无障碍/触控 | 44×44、hitSlop、tablist/switch/dialog 角色基本到位；sheet 焦点/返回键由 HT-U13 实现。 |

## Platform check（folder workspace / SSH / remote / iOS / Android）

- Android：8.1 的 scheme-only 策略可落地，`navigationType` 固定 `other` 的约束已正确接受，不再声称手势。残留：iframe 只对子帧不触发 `onShouldStartLoadWithRequest`（与 iOS 不同），C18 需分平台。
- iOS：`onShouldStartLoadWithRequest` 会为 iframe 触发且带 `isTopFrame`；当前实现未过滤 → 03-M4。`textInteractionEnabled` 仅 iOS → 03-m8。
- SSH / folder workspace：预览仍走 `files.read`（`mobile/src/files/mobile-file-preview-request.ts`），相对资源检测与 512 KB 截断与本地一致；测试数据已要求各一条。未发现新的远程阻断。
- OTA：文件预览强制 native、`mode` 经 route/shell params 透传的路径可行；HT-T2 已列四个真实文件，HT-U11 不再依赖 FB-U7 条件。

## AC → 用例覆盖

| AC | 对应用例 | 结论 |
|---|---|---|
| AC1 首次点击弹层 | A1/A2/A3/A8 | A1/A8 具体；原型的两个模式与设计一致。 |
| AC2 渲染/源码切换 | A2/A3/B1/B8 | 可验证；路由优先级见 03-M3。 |
| AC3 溢出/长按菜单 | B2/B3/B9/B11 | B2/B9 受 03-M1/03-M2 阻塞。 |
| AC4 记住/恢复 | A4/A5/A9/A10/A11 | 三处已统一为设置页恢复。 |
| AC5 相对资源/大文件 | C2/C5/C8/C9 | 检测矩阵/文案见 03-m3/03-m4。 |
| AC6 外链/安全 | C3/C10/C11/C12 | scheme 策略可行；iframe 见 03-M4；C12/C18 记录式断言见 03-m2。 |
| AC7 回归 | R1-R8 | R2 受 03-m4 影响；R7 受 03-M3 影响；其余可覆盖。 |

## 需主会话确认

1. 共享动作数组采用哪一顺序（03-M1）；建议沿用 FB 的 `Preview、Source、Save to phone、Open with…` 并同步 HTML 三份产物。
2. HTML 的模式 Preview 与通用文件 Preview 如何合并（03-M2）；必须明确唯一数组。
3. terminal artifact 与 truncated 是否绝对压过显式 `route.mode`（03-M3）；建议“是”。
4. iframe 外部打开的顶层判定与 C18 的平台期望（03-M4）。
5. HT-U17 与 FB-U11 保留哪一个 owner（03-M5）。
