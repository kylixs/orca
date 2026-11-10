# 设计评审 02 — HTML 打开方式（复审）

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/html-open-modes.html`；对照 `mobile/src/files`、`mobile/src/components/MobileHtmlPreview*`、`mobile/src/session`、`mobile/src/storage`、`mobile/src/settings`、`mobile/src/mobile-web-shell`、`mobile/src/platform` 与文件浏览需求。
复审基线：`reviews/design-review-01.md`（REJECTED：1 BLOCKER / 11 MAJOR / 8 MINOR）。

结论：REJECTED
统计：BLOCKER 1 / MAJOR 7 / MINOR 8

---

## Prior findings（design-review-01 逐条核对）

| 编号 | 级别 | 状态 | 核对结果 |
|---|---|---|---|
| 01-B1 | BLOCKER | **未解决（残留）** | 设计 7.1/7.3 已统一动作模型并移除 Orca 浏览器，但 `tasks.md:17` 的 HT-U1 仍新建完整动作构造器（含 Orca 浏览器/其它 App/复制路径），`tasks.md:19-20` 仍把切换放 header、HT-U4 只依赖 HT-U1，`tasks.md:68` 又要求“只追加模式项”。开发计划仍会造出第二套模型 → 见 B1。 |
| 01-M1 | MAJOR | 部分解决 | 设计 7.2（`design.md:215-224`）抽出受控 `MobileHtmlPreviewFrame`，HT-U6 已建任务；但 `tasks.md:27` 的 HT-V1 只依赖 HT-T3，未依赖 HT-U6，按任务顺序仍会把有内部 state 的 `MobileHtmlPreview` 当 body 复用 → 见 M4。 |
| 01-M2 | MAJOR | 部分解决 | 设计 7.3（`design.md:226-231`）与原型已移除 Orca 浏览器；但 `test-plan.md:40/42/43/55` 和 `tasks.md:17` 仍保留该动作/用例 → 见 B1、M1。 |
| 01-M3 | MAJOR | 部分解决 | 设计 7.4（`design.md:235-243`）新增 scheme 白名单并写明 iframe/网络外带边界；但原生端“脚本/meta refresh 不得自动拉起外部 App”缺少可落地的用户激活判定 → 见 M2。 |
| 01-M4 | MAJOR | 部分解决 | 设计 7.5（`design.md:245-250`）新增 `findRelativeHtmlAssetRefs` 并让原型按检测结果提示；但忽略规则会误报 `mailto:`/`tel:`/协议相对 URL，且遗漏根绝对路径 → 见 M7。 |
| 01-M5 | MAJOR | 部分解决 | 设计 7.6（`design.md:252-258`）改为“truncated → 源码 + 渲染禁用”，测试 C9/原型状态 05 已补；但自动弹层无法在读取前知道截断，且 3.4 仍保留 `files.readDocPreview` 旧说法 → 见 M3、m2、m7。 |
| 01-M6 | MAJOR | 已解决 | 7.7（`design.md:260-265`）限定只有 preview/source 可记住，外部动作不写偏好；A9/A10 覆盖。长按文案仍含糊 → 见 m5。 |
| 01-M7 | MAJOR | 部分解决 | 7.8（`design.md:267-271`）与 HT-T5 把设置落到 Browser 设置页；但 HT-T1（`tasks.md:9`）仍写 `settings/*`，HT-T4（`:57`）与 HT-T5 重叠，存在再建页面的风险 → 见 M4。 |
| 01-M8 | MAJOR | 部分解决 | 7.9（`design.md:273-281`）决定强制 native 并列出参数链；但 HT-T2（`tasks.md:10`）未列 app 路由文件，HT-U11（`:64`）仍依赖“FB-U7 决策”而 FB 已决定，R5 仍写“或提示” → 见 M4、M1。 |
| 01-M9 | MAJOR | 部分解决 | 7.10（`design.md:283-288`）规定 line/column 默认 source、terminalArtifact 只读源码；但未定义 route mode、line/column、偏好三者的优先级，且 `MobileFilePreviewBody` 没有 source 标志可区分只读终端产物 → 见 M5。 |
| 01-M10 | MAJOR | **未解决** | `test-plan.md:54/56` 仍保留“无限循环有超时/限制”“非 UTF-8 报错”，5.3（`:129`）却说已删除；B2/B4/B5/C5 仍断言 Orca 浏览器。M1 仍未解决 → 见 M1。 |
| 01-M11 | MAJOR | 部分解决 | 7.11（`design.md:290-295`）定义 `availableHtmlOpenActions` 只计 preview/source；但“本期均可用 → 2”与 >512 KB 禁用预览冲突，A8 的“1 个 → 直开”没有可产生 1 的实际输入 → 见 M3。 |
| 01-m1 | MINOR | 已解决 | 原型手机框内文案已全部为英文；中文仅页面注解（`ui/README.md:5`、原型 779）。 |
| 01-m2 | MINOR | 已解决 | 分段控件 44px（原型 73）、菜单项 52px（133）、开关 28px 但有 `inset:-8px` 命中区（154）；设计 7.13 也写入 hitSlop。 |
| 01-m3 | MINOR | 已解决 | 设计 7.13（`design.md:308`）改用 `ActionSheetModal`/`BottomDrawer`；原型为底部 sheet，带 scrim/外部点击关闭。焦点管理落到 HT-U13。 |
| 01-m4 | MINOR | 已解决 | 键统一为 `orca:mobileHtmlOpenMode`（7.7/原型 769），非法值回退 ask，A10 覆盖。 |
| 01-m5 | MINOR | 部分解决 | 7.13（`design.md:312`）决定用局部 state、不用 `setParams`；但“返回重置规则”仍未写出，3.3 仍写“保留当前模式（可选）” → 见 m4。 |
| 01-m6 | MINOR | 已解决 | 原型新增状态 05（512 KB）、06（读取失败）、07（无 App）、08（被阻止 scheme）；但引入若干设计未覆盖的元素 → 见 m1。 |
| 01-m7 | MINOR | 已解决 | 长按复用同一 ActionSheet，HTML 只追加 Preview/Source，无 remember 开关（原型 09）；动作顺序仍未固定 → 见 m5。 |
| 01-m8 | MINOR | 已解决（设计） | 7.13/HT-U14 补 500ms、触觉、滚动取消、与 onPress 互斥、`accessibilityState`；但测试计划无对应交互用例 → 见 m5。 |

---

## Findings

### BLOCKER

- **[BLOCKER] 任务表仍在指令第二套文件动作模型和双菜单入口，文件浏览与 HTML 仍会并行改同一批文件。**
  `tasks.md:17` 的 HT-U1 仍在 `mobile-file-open-mode-actions.ts` 新建“动作构造器（预览/源码/Orca 浏览器/其它 App/复制路径/每次询问）”；这不是模式项，而是文件浏览需求 FB-T2 在 `mobile-file-actions.ts` 的职责（`2026-11-10-mobile-file-browser/tasks.md:11`），且包含设计 7.3 已延期的 Orca 浏览器。`tasks.md:19` 的 HT-U3 仍写“预览页头部：预览/源码切换 + 右侧溢出菜单”，与设计 7.1（`design.md:211`）“切换放第二行工具栏、只保留一个右侧溢出”冲突；`tasks.md:20` 的 HT-U4 仍只依赖 HT-U1，未依赖 FB-T2/FB-U1/FB-U10/FB-U3；`tasks.md:68` 的 HT-U15 又要求“只追加模式项”，却仍把文件指向新模块。两个子代理按此表开发，会再次出现双 `…`、重复文案或动作丢失。
  **建议**：删除 HT-U1 的“动作构造器”职责；让 `mobile-file-open-mode-actions.ts` 只导出 `availableHtmlOpenActions` 和模式动作描述（不碰下载/分享/复制）。扩展 FB 的 `buildFileActions(target, { htmlOpenMode?, capabilities })`：HTML 只追加 Preview/Source，按能力隐藏 Orca 浏览器；HT-U3 依赖 FB-U3/HT-U6，明确“header 溢出属于 FB-U3，HTML 只加第二行工具栏”；HT-U4 依赖 FB-T2/FB-U1/FB-U3/FB-U10；HT-Q7 断言最终动作列表与顺序完全一致。

### MAJOR

- **[MAJOR] 测试计划仍包含不可成立或已移除的断言，且关键用例没有可判定的期望值。**
  `test-plan.md:54` 仍要求“无限循环…有超时/限制”，但现有 WebView 没有超时（`mobile/src/components/MobileHtmlPreview.tsx:52-68`），5.3（`:129`）已说删除；`test-plan.md:56` 仍要求“非 UTF-8 报错”，而 `readLocalMobileFile` 直接 `toString('utf8')`，只会产生替换字符（`src/main/runtime/runtime-file-commands-terminal-file-paths.ts:34-43`），5.3 也已说删除。`test-plan.md:40/42/43/55` 仍要求 Orca 浏览器动作/远程打开/引导，与设计 7.3 和 `tasks.md:74` 的移除决定冲突。`test-plan.md:122/123` 的 C11/C12 分别是“遵循用户激活/策略”“记录网络外带边界”，不是断言；`:27` A1 的“预览/源码/更多”与自动弹层只有两个模式不符；`:114` A8 的“1 个 → 直开”没有可产生的输入；`:118` B9 的“顺序稳定”没有给定期望顺序；`:131` 要求覆盖 0 字节/CJK/emoji/返回/旋转/断线，但没有用例 ID 与期望。
  **建议**：把 C4 改为“脚本无限循环时仍可返回/退出，App 不崩溃，不要求超时”；C6 改为“非 UTF-8 字节显示替换字符，不崩溃，不出现 `binary_file`”；删除 B2/B4/B5/C5 的 Orca 浏览器断言及测试环境中的“配对的桌面 Orca”；C11/C12 改成平台化、可观察的断言（见 M2）；A1 改为“Preview/Source 选择”；A8 明确输入与“1 模式”的唯一来源（建议只用于 terminal artifact）；B9 给出完整期望数组；为 0 字节、CJK/emoji、返回/旋转、断线、读取失败、无可用 App 各补一条带期望值的用例。同步更新 AC→用例映射（`test-plan.md:100-108`）。

- **[MAJOR] 原生端“脚本/meta refresh 不自动拉起外部 App”没有可行的用户激活判定，Android 上按现设计无法同时满足“链接可点”和“脚本不自动打开”。**
  设计 7.4（`design.md:239-241`）要求脚本/meta refresh 与用户点击走同一策略且“不允许自动拉起外部 App”，但 `MobileHtmlPreview.tsx:61-67` 的 `onShouldStartLoadWithRequest` 只拿到 URL，没有手势信息。react-native-webview 13.16.2 在 iOS 上把 `WKNavigationType` 映射为 `navigationType: 'click' | 'other'`，Android 的 `TopShouldStartLoadWithRequestEvent.kt:16` 则固定写 `"other"`，并注明不覆盖 iframe。Android 上无法区分 `<a>` 点击与 `location.href`/meta refresh；若按设计全部拒绝，链接不可用（AC6 失败）；若全部放行，脚本可自动拉起外部 App（安全要求失败）。HT-C11 因此不可判定。
  **建议**：在设计中按平台写死策略并给测试双：(a) iOS 用 `navigationType === 'click'` 才放行 http(s)/mailto，`other` 拒绝；(b) Android 若 RN WebView 不能提供手势，就选择“拒绝所有顶层 http(s) 导航，改为在预览内提供可点击链接列表/确认层”，或“注入点击拦截并明确接受脚本可伪造”的折中，并删除“未注入宿主桥”的表述（注入 `onMessage` 会暴露 `window.ReactNativeWebView`）；(c) 若只保证 iOS，则在设计/AC/测试中显式缩小范围。HT-C11 拆成 iOS/Android 两条，各自断言“点击成功/脚本失败”。

- **[MAJOR] 自动弹层计数无法处理 >512 KB 的禁用预览，也无法处理 line/column 强制 source；“1 个可用 → 直开”没有真实输入。**
  设计 7.11（`design.md:292-295`）定义 `availableHtmlOpenActions(target)` 只计 preview/source，并写“本期均可用 → 2”；但 7.6（`design.md:254-257`）要求 truncated 时禁用渲染。自动弹层发生在 `MobileFileExplorerPanel.previewFile`（`mobile/src/files/MobileFileExplorerPanel.tsx:264-279`），此时还没有 `files.read` 结果；目录项（`mobile/src/files/file-tree.ts:9-18`）也没有 size，因此无法在弹层前判断是否只剩 source。同样，7.10 规定 line/column 默认 source，但计数仍会给出 2，用户选择 Preview 会丢失目标行。A8 的“1 个可用 → 直开”没有可构造的 worktree HTML 输入。
  **建议**：把 `availableHtmlOpenActions` 的输入写成可判定的 `{ kind, size?, knownTruncated?, hasLineTarget?, source }`，或在设计上明确“worktree HTML 永远弹两个模式，Preview 进入后再禁用”，删除“1 → 直开”或只保留给 terminal artifact；line/column 直接绕过弹层并强制 source；补 >512 KB 与 line/column 下的自动弹层用例。

- **[MAJOR] 任务依赖与执行顺序仍有多处错误，按 `tasks.md` 开发仍会撞上文件浏览和受控预览的时间窗。**
  除 B1 外：`tasks.md:27` 的 HT-V1 只依赖 HT-T3，未依赖 HT-U6；按序推进会复用 `MobileHtmlPreview` 的内部 `useState`（`mobile/src/components/MobileHtmlPreview.tsx:19`），重新制造两个 mode 源。`tasks.md:66` 的 HT-U13 只依赖 HT-U2，未依赖 FB-U3/HT-U3，溢出宿主会落在错误组件。`tasks.md:10` 的 HT-T2 只列 route/navigation，而设计 7.9（`design.md:276-280`）要求 `mobile/app/h/[hostId]/files/preview/[worktreeId].tsx`、`.web.tsx`、`normalize` 与 `mobileFilePreviewShellParams` 全链路；后两者在 `mobile-file-preview-route.ts:56-123`，前两者的手工参数类型在 `.tsx:26-42`、`.web.tsx:14-30`。`tasks.md:9` 的 HT-T1 仍写 `settings/*`，与 HT-T4（`:57`）/HT-T5（`:58`）重叠。`tasks.md:64` 的 HT-U11 仍依赖“FB-U7 决策”，但 FB 已在 `2026-11-10-mobile-file-browser/tasks.md:78` 决定强制 native。
  **建议**：HT-V1 依赖 HT-U6 + HT-U9；HT-U13 依赖 FB-U3 + HT-U3；HT-T2 列出四个真实文件；HT-T1 只做偏好读写，设置 UI 归 HT-T5，删除 HT-T4 或并入 HT-T1；HT-U11 去掉条件依赖并写明 `shellSwitchDecision` 的调用点和 `.web.tsx` 的处理。

- **[MAJOR] mode 优先级与终端产物分支未定义，read-only terminal artifact HTML 可能被错误渲染。**
  设计 7.10（`design.md:285-288`）说 line/column 默认 source；7.3 让偏好 preview/source 直接进入；3.3（`design.md:105-112`）又说 route `mode` 驱动。三者冲突：偏好为 preview 的用户从带 `line` 的深链进入时会打开渲染页并丢失目标行。终端产物方面，7.10 只说“可编辑 HTML 只读源码”，而 R7（`test-plan.md:125`）说所有 terminal artifact HTML 都无渲染 tab；`MobileFilePreviewBody.tsx:102-114` 只有 `editable` 一个标志，无法区分 read-only 终端产物与 worktree HTML，加渲染分支后会误渲染。`mobile-file-tap-open.ts:154-165` 会推入带 line/column、无 mode 的预览路由，也需要确定的默认。
  **建议**：写出唯一优先级：显式 route `mode` > line/column（强制 source）> `source=terminalArtifact`（强制 source，忽略偏好）> 存储偏好 > ask；把 `source`/`htmlRenderable` 传到 `MobileFilePreviewBody`；明确“可编辑”终端产物是“source-only 但仍可保存”，read-only 同样 source-only；补 preference=preview + line、route mode=preview + line、terminalArtifact（可编辑/只读）三类组件测试。

- **[MAJOR] “恢复每次询问”的入口在 design/test/prototype 三处不一致。**
  `design.md:97`（3.2.3）说预览页溢出菜单包含“每次询问”；7.3 的菜单清单（`design.md:229`）不含它；7.8（`:269`）把恢复放在 settings。`test-plan.md:40` B2 仍断言溢出菜单包含它；原型却在源码页加了一条设计未定义的 prefbar“Reset to Ask every time”（`ui-prototypes/html-open-modes.html:475-479`），其溢出菜单（`:367-378`、`:433-442`）没有 Ask 动作。AC4 只要求“设置可恢复”，但需求目标 5 写“设置/菜单中恢复”，三份产物无法指导实现或验收。
  **建议**：二选一并同步三处：(A) 仅设置页恢复：删除 3.2.3 的“每次询问”、更新 B2，删除原型 prefbar；(B) 溢出菜单增加“Ask every time”动作：更新 7.3/7.7、B2、原型溢出菜单，并补一条“从溢出恢复后下次点击再次弹层”的用例。若保留 prefbar，则把它写进设计/任务/测试，而不是原型私有行为。

- **[MAJOR] `findRelativeHtmlAssetRefs` 的忽略规则会误报/漏报常见引用。**
  设计 7.5（`design.md:247`）只忽略 `data:`、`http(s):`、`#`、`/` 绝对路径。这会把 `mailto:`、`tel:`、`javascript:`、`blob:`、`about:` 和协议相对 `//cdn.example/x.css` 当成相对资源并显示“可能无法加载”的警告；同时根绝对路径 `/assets/x.css` 在 `about:blank`/`srcdoc` 下同样不能解析到工作区，却被忽略。`test-plan.md:137-138` 的测试数据也没有这些形态。
  **建议**：把“非资源 scheme”定义为 `http:, https:, data:, mailto:, tel:, javascript:, about:, blob:` 及协议相对 `//`；明确根绝对路径是否提示（建议提示或写成明确的已知限制）；若只支持 `src`/`href`/`url()`，在设计里写明不覆盖 `srcset`/`poster`。补单测：自包含不提示、`mailto:` 不提示、协议相对提示/不提示符合定义、根绝对路径按定义、空 `href=""` 忽略。

### MINOR

- **[MINOR] 原型包含设计/任务/测试没有覆盖的入口、数据和面板。**
  文件列表 header 的 More 按钮在状态 01/09（`ui-prototypes/html-open-modes.html:264`、`:702`）没有绑定动作，设计只定义了点行、长按、预览页溢出；文件大小标签 `4.2 KB`（`:269`、`:282`、`:716`）需要目录项没有的 size 数据（`file-tree.ts:9-18`）；`:342-343` 的 missing-asset 占位、`:672-682` 的 Link blocked 弹层、`:586` 读取失败的 Copy path、`:323` 的 mode-note 都没有进入 design/tasks/test。另外状态 04-08 的预览页 More 按钮只触发 `data-toast="File actions"`（`:466`、`:522`、`:570`、`:610` 等），没有打开 ActionSheet，原型无法证明源码/大文件/错误状态下菜单入口仍可用。实现者无法判断哪些是本期行为。
  **建议**：删除未设计的 header More、大小标签、prefbar、占位与 blocked 弹层；或把它们写进 design/tasks 并补测试。若保留读取失败的 Copy path，需要把它加到 `MobileFilePreviewBody` 的 error 分支（当前只有 Retry，`MobileFilePreviewBody.tsx:38-49`）。

- **[MINOR] >512 KB 的文案、禁用态和边界断言没有固定。**
  设计 7.6 写“仅显示前 512 KB”；现有组件文案是“Preview truncated. File size: …”（`MobileFilePreviewSourceText.tsx:61-67`）；原型是“Source truncated at 512 KB (1.2 MB total)…”（`:544`）。C9 只写“提示”，没有断言具体状态和英文文案，也没有覆盖 512 KB 精确边界下 `truncated` 的判定来源。
  **建议**：指定一句英文文案；断言 Preview tab `disabled`、`accessibilityState.disabled`、源码截断提示存在、`formatPreviewByteLength(byteLength)` 的值；明确 512 KB 整（`truncateMobileFilePreview` 的 `<=`）与 512 KB+1 的差异。

- **[MINOR] `isAllowedHtmlPreviewScheme` 的落点可能改变 `openExternalLink` 的既有契约。**
  HT-U7（`tasks.md:60`）把 `platform/external-link.ts` 列入改动；但该函数当前刻意不做 scheme 过滤（`mobile/src/platform/external-link.ts:14-24`，测试 `external-link.test.ts:49-53` 明确断言 `orca://x` 直通），终端/PR/Markdown 等调用方依赖这一行为。若把白名单塞进 `openExternalLink`，会回归这些入口。
  **建议**：把纯函数放在新模块（如 `html-preview-scheme.ts`）或 `MobileHtmlPreviewFrame` 内部，只约束 HTML 预览的导航策略；保留 `openExternalLink` 原契约并加回归测试。

- **[MINOR] 返回时模式重置规则仍未定义。**
  3.3（`design.md:111`）写“返回时保留当前模式（可选）”，7.13（`:312`）要求“定义返回重置规则”但没有规则；`MobileFilePreviewScreen` 用局部 state，返回后再次点击会重新读偏好/弹层。测试没有覆盖“切换后返回再进入”。
  **建议**：明确：返回不写偏好；再次点击按当前偏好/ask 重新决定；若希望保留本次手动 mode，则写明仅在本次页面生命周期内保留，并加一条组件测试。

- **[MINOR] 长按/溢出菜单的 remember 语义、动作顺序和测试仍不可判定。**
  7.7（`design.md:264`）“长按菜单不出现‘记住此选择’，除非用户选择的是 preview/source”在交互上不可执行（菜单在选择前无法知道）；原型长按没有 remember（`:729`）也没有 Ask；B9（`test-plan.md:118`）只要求“顺序稳定”，没有给期望顺序；没有用例断言“从长按选 Preview 不写 `orca:mobileHtmlOpenMode`”。
  **建议**：改成“长按/溢出不显示 remember 开关；选择 Preview/Source 也不写偏好”；固定一份动作顺序数组（模式项 → 文件动作 → Cancel），B9 与组件测试逐项断言；补 A9 的长按入口变体。

- **[MINOR] HTML 的“复制内容”动作在共享模型中缺失。**
  文件浏览设计 7.2 矩阵把 HTML 的“复制内容”标为 ✅（`2026-11-10-mobile-file-browser/design.md:327`），但 HTML 设计 7.3 的动作清单（`design.md:229`）和原型（`:372-375`、`:439-442`、`:724-727`）都没有它。按“共享动作模型”实现时它会突然出现，或按原型实现时会被丢掉，两种结果都违反“动作无重复/禁用规则一致”。
  **建议**：在 7.3 明确 HTML 是否包含“Copy content”（含 512 KB 截断提示）；若包含，原型补该动作并让 B9 期望数组包含它；若排除，在共享 builder 的能力输入中显式关闭并加测试。

- **[MINOR] 设计正文仍保留被第 7 节推翻的旧表述，容易误导实现。**
  `design.md:78`（Orca 浏览器动作）、`:95`/`:97`（长按/溢出 Orca）、`:120`（相对资源引导 Orca 浏览器）、`:124`（`files.readDocPreview` 解决大文件）、`:178-179`（远程 URL 构造、旧主机 `browser.tabCreate`）都与 7.3/7.6 的最终决定冲突。虽然第 7 节声明“冲突时以本节为准”，但正文仍是实现者的第一阅读面。
  **建议**：在第 3/5/6 节就地标注“已被 7.3/7.6 取代”，或直接删除旧动作/旧路径，保留单一事实源。

- **[MINOR] 文件浏览需求已把 HTML 渲染视图的文字选择纳入本期，但本设计没有承接。**
  文件浏览设计 7.1 决策 6 要求 `MobileHtmlPreview` 开启文本选择并处理与链接点击的冲突（`2026-11-10-mobile-file-browser/design.md` 7.1 第 6 条；FB-U11），而本设计的 `MobileHtmlPreviewFrame` API（`design.md:219`）与 HT-U6（`tasks.md:59`）没有 `textInteractionEnabled`/选择与链接冲突的处理，也没有测试。
  **建议**：在 HT-U6 中显式纳入该属性与链接冲突策略（或写明由 FB-U11 负责并登记依赖），补一条“渲染视图长按选择 + 点击链接不冲突”的组件/真机用例，避免两次改同一个 Frame。

---

## Prototype checklist

| 检查项 | 结果 |
|---|---|
| 源码/渲染切换 | 通过。状态 02 中 tab 切换会隐藏/显示 `[data-pane]`，`aria-selected` 同步（浏览器实测）。 |
| 溢出菜单 | 状态 02/03 存在并可打开；状态 04-08 的 More 只 toast，不打开同一 sheet（m1）。 |
| 长按菜单与溢出平价 | 状态 09 与状态 03 的动作/分组一致，无 remember 开关；动作顺序未固定（m5）。 |
| 自动弹层 | 状态 01 存在，写明只计两个模式；但计数无法处理 >512 KB/line（M3）。 |
| 相对资源提示 | 状态 02 存在，列出 3 个实际引用，符合 7.5；检测边界见 M7。 |
| >512 KB 禁用态 | 状态 05 的 Preview 为 disabled，源码有截断提示；文案/无障碍断言见 m2。 |
| 导航拒绝 | 状态 08 展示 `file:` 被阻止；该 “Link blocked” 弹层未进入设计/测试（m1）。 |
| 无 “Open in Orca browser” | 通过。状态 02/03/09 的菜单均无该动作。 |
| 无障碍 | 44×44/命中区、tab/switch/dialog 角色基本到位；sheet 的焦点陷阱与返回键需按 HT-U13 实现。 |

## Platform check（folder workspace / SSH / remote）

- 设计 7.3 取消 Orca 浏览器后，不再需要为远程 worktree 构造绝对路径或 URL；预览/源码继续走 `files.read`（SSH 由 `readRemoteMobileFile` 处理，`runtime-file-commands-read-mobile-file.ts:30-35`），folder workspace 也不依赖 git。未发现新的远程阻断。
- 但 `test-plan.md:17/42/43` 仍保留“配对的桌面 Orca”和远程打开用例，会要求已移除的能力（M1）。相对资源/512 KB 在 SSH 下与本地同一行为，需在真机用例中明确主机类型（SSH/folder workspace）。

## AC → 用例覆盖

| AC | 对应用例 | 结论 |
|---|---|---|
| AC1 首次点击弹层 | A1/A2/A3/A8 | A1 文案陈旧，A8 输入不可构造；见 M3 |
| AC2 渲染/源码切换 | A2/A3/B1/B8 | B8 可验证受控 Frame；路由优先级见 M5 |
| AC3 溢出/长按菜单 | B2/B3/B9 | B2 仍含 Orca 浏览器；B9 无期望顺序；见 B1/M1/m5 |
| AC4 记住/恢复 | A4/A5/A9/A10 | 记忆语义已覆盖；“恢复 Ask”入口三处不一致，见 M6 |
| AC5 相对资源/大文件 | C2/C5/C8/C9 | 检测边界见 M7；512 KB 文案/禁用态见 m2 |
| AC6 外链/安全 | C1/C3/C10/C11/C12 | C11/C12 不可判定；Android 策略缺失，见 M2 |
| AC7 回归 | R1-R7 | R5 仍是“可用或提示”，与强制 native 冲突；见 M1/M4 |

---

## 需主会话确认

1. Android 原生链接的用户激活策略：拒绝全部 http(s) 并改为预览内链接列表，还是接受注入点击拦截的折中？这会改变 AC6 的表述和测试。
2. “恢复 Ask”只放设置页，还是溢出菜单也保留？三份产物必须选同一个。
3. 自动弹层是否需要读取文件大小来判断“只剩 Source”？若不加 size/stat，请接受“永远弹两个模式，进入后再禁用 Preview”。
4. read-only terminal artifact HTML（native chat）本期是否允许渲染，还是与可编辑终端产物一样只显示 source？
