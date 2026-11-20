# 设计评审 01 — HTML 打开方式

结论：REJECTED

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui-prototypes/html-open-modes.html`；对照 `mobile/src/files`、`mobile/src/components/MobileHtmlPreview*`、`mobile/src/mobile-web-shell`、`src/main/runtime` 与文件浏览需求的 `tasks.md`。

## Findings

- [BLOCKER] 预览页“右侧溢出菜单”和长按菜单与文件浏览需求重复建设 — 文件浏览需求 `2026-11-10-mobile-file-browser/tasks.md` 的 FB-U3 已经在同一个 `MobileFilePreviewScreen` 头部增加溢出菜单，FB-U2 新建 `MobileFileActionSheet`；本设计又新增一套 `…` 并“复用”该 Sheet，但 `tasks.md` 的 HT-U3/U4 只依赖 HT-U1/U2，没有声明对 FB-U2/FB-U3/FB-T4 的依赖，也没有定义两个功能合并后的菜单结构。两个并行开发子代理会各自修改同一 header，出现两个 `…`、动作丢失或合并冲突；HTML 模式动作与文件下载/复制动作还可能形成两套文案和可用性规则。— 建议：把文件浏览的 action builder 作为唯一动作模型（如 `buildFileActions(target, { htmlOpenMode })`），HTML 只追加模式项；预览页只保留一个溢出菜单；`tasks.md` 增加 FB-U2/FB-U3/FB-T4 依赖、文件所有权和合并顺序；补“两个功能同时存在”的组件测试。

- [MAJOR] `MobileHtmlPreview` 自带 Preview/Source 工具栏和内部 mode state — `mobile/src/components/MobileHtmlPreview.tsx:18-74` 已在组件内部渲染 tab 并自己 `useState<'preview'|'source'>()`；本设计却在 `MobileFilePreviewScreen` 头部再加“预览/源码”分段控件，并让 `MobileFilePreviewBody` 把整个组件当 body 复用。结果是两个切换控件、两个 mode 状态源，路由 `mode=source` 无法驱动组件内部状态。— 建议：抽出受控的 `MobileHtmlPreviewFrame`（只负责 WebView/iframe 与安全策略），接收 `mode`、`onModeChange`、`showToolbar`；会话页保留薄包装以维持现行为；统一 header 与第二行工具栏的选型（原型是第二行，设计组件树写的是 header）；HT-V1 补该 API 与会话预览回归测试。

- [MAJOR] “在 Orca 浏览器打开”缺少可落地的 URL/能力方案 — 设计只写“主机支持 `browser.tabCreate` 且能构造 URL”，但移动端预览路由只有 `hostId/worktreeId/relativePath`，没有绝对路径；`browser.tabCreate` 只接受 URL（`src/shared/rpc-contract/browser-tab-create-params.ts`）。桌面端对远程 worktree 明确不走 `file://`，而是 `doc-preview` grant（`src/renderer/src/lib/file-preview.ts:23-24,145-160`），该 grant 由桌面 IPC 铸造，移动端没有对应 RPC；预览页不在 session 内，也拿不到 `browserScreencastSupported` 探针。SSH/paired worktree 下 `file://` 会指向桌面本机，打开错误文件。— 建议：新增桌面侧操作（如 `files.openInBrowser` / `files.openDocPreview`），在桌面复用 `getWorkspaceFilePreviewPlan`/`openFileInBrowserTab` 并返回 unsupported 原因；移动端按能力隐藏/禁用；或明确本期只在可判定的本地 worktree 显示。HT-B4/B5 覆盖本地、SSH、paired host、旧主机。

- [MAJOR] 安全模型描述与现有代码不符，且缺少 scheme 白名单 — 设计 3.5 称“外部链接 scheme 仍受 `openExternalLink` 限制（https/http/mailto 等）”；实际 `mobile/src/platform/external-link.ts:14-24` 只是 `Linking.openURL`，没有 scheme 过滤。原生 `MobileHtmlPreview.tsx:61-67` 对任何非 `about:blank`/`data:` 的顶层导航都调用它，脚本或 `<meta http-equiv="refresh">` 触发的跳转也会打开外部应用；`file:`、`intent:`、`tel:`、自定义 deep link 都可能被自动拉起。Android 的 `shouldOverrideUrlLoading` 主要覆盖主 frame，iframe 与网络请求（图片/fetch）不受导航锁约束。— 建议：打开前做 scheme 白名单（仅 http/https/mailto），对脚本发起的导航要求用户激活或直接拒绝；显式拒绝 `file:`/`intent:`/`javascript:`；在设计里写明 JS 产物可发起网络请求（`MobileHtmlPreview.web.tsx` 注释已承认图片外带），并决定是否加 CSP；HT-C3 增加恶意脚本自动跳转/iframe/deep link 用例。

- [MAJOR] 相对资源提示不可实现，设计与原型不一致 — 设计 3.4 只要求“顶部显示轻提示”；原型却列出具体文件 `styles/app.css、assets/hero.png`，这意味着要解析 HTML 提取相对引用。tasks HT-V2 没有定义检测逻辑，HT-C2 也没说明什么情况必须出现提示。若对所有 HTML 一律提示会误报自包含页面；若解析，需定义 `src/href/url()` 的提取与忽略规则（`data:`/`http(s):`/`#`/`/`）。— 建议：明确采用“检测到相对引用才提示”或“所有 HTML 都提示”之一；若检测，抽纯函数并单测；同步修正原型文案与测试预期；提示中列出的资源名必须来自实际解析结果或去掉。

- [MAJOR] >512 KB 行为未定义，且“后续接入 `files.readDocPreview`”不是可行路径 — `files.read` 在 `MOBILE_FILE_READ_MAX_BYTES = 512 * 1024` 处截断并返回 `truncated`（`src/main/runtime/runtime-file-commands-mobile-file-list-limit.ts:25`、`runtime-file-commands-read-mobile-file.ts:32-42`），但设计没有说渲染视图是否加载截断后的 HTML、是否允许切到预览、截断横幅放在哪里。`readDocPreviewFile` 的 `maxTextBytes` 同样是 `MOBILE_FILE_READ_MAX_BYTES`（`runtime-file-commands-read-file-explorer-preview.ts:139`），而且它是单文件读取，不是 WebView 的相对资源 URL 处理器，解决不了大文件/相对资源。— 建议：明确“truncated → 源码可用 + 渲染禁用/仅提示 + 外开引导”或“渲染截断内容并显著提示”之一；去掉 doc-preview 的误导性表述；若要做完整渲染需另立“宿主端 asset scheme + grant”设计；HT-C5 覆盖 512 KB±1、1 MB 并断言具体 UI。

- [MAJOR] “记住我的选择”对非模式动作没有定义 — 偏好模型只有 `ask/preview/source`，但自动弹层和长按弹层把“记住”开关放在所有动作旁边（原型 01/04），包括“在 Orca 浏览器打开/用其它 App 打开/下载”。用户打开记住后点外部动作，下一次点击记录什么、是否再次弹层都没定义；长按弹层有“记住此选择”，设计 3.2 却完全没提。— 建议：二选一：只在 preview/source 动作上显示记住；或扩展偏好为可记住的动作并定义外部动作的复现（不推荐，容易静默打开外部 App）。长按弹层与自动弹层共用同一规则，并补 HT-A4/长按记忆用例。

- [MAJOR] 设置页“恢复每次询问”没有落点 — 设计说“设置页可在‘文件预览’下增加”，但 `mobile/src/settings/mobile-settings-menu-items.ts` 没有文件预览页，`browser-settings-screen.tsx` 才是终端链接打开方式的落点；HT-T1 只写 `settings/*`，不可独立执行。— 建议：明确放进 Browser 设置（与 `terminalLinkOpenMode` 同页）或新增 `/file-settings` 并注册菜单/路由；tasks 写明具体文件、控件、读写与失败处理；HT-A5 增加从设置页恢复的步骤。

- [MAJOR] OTA/web-shell 行为未决策，`mode` 也未进入 shell 参数链 — `mobile/src/mobile-web-shell/shell-switch-decision.ts` 在 OTA 构建下对任意可构造路由返回 `shell`，文件预览会渲染桌面 web bundle；本设计只说“与文件浏览需求一致：原生路由或明确提示”，没有决策，而文件浏览需求 FB-U7 仍在“评审决策”。同时 `mobile/app/h/[hostId]/files/preview/[worktreeId].tsx` 和 `.web.tsx` 都手工列了参数类型，`mobile-file-preview-route.ts` 的 `normalize` 也是白名单；只改 route/navigation 不够，`mode` 必须在这三处和 shell params 中传递。— 建议：与 FB-U7 一起决定文件路由强制 native（推荐）或接受 OTA 缺失并给提示；补齐参数链；HT-R5 改成可判定断言（OTA 下强制 native 或页面明确提示，且 `mode` 不丢失）。

- [MAJOR] 现有 `line`/`column` 深链和可编辑终端产物 HTML 被忽略 — `MobileFilePreviewScreen` 把 `lineColumn` 传给源码视图（`MobileFilePreviewScreen.tsx:174-277`），当前 HTML 默认打开源码并滚动到指定行；改成“默认预览/首次询问”后，带 `line`/`column` 的 HTML 会打开渲染页而看不到目标行。路由同时支持 `source=terminalArtifact`，HTML 终端产物可能是可编辑源码（`MobileFilePreviewBody.tsx:102-114`），本设计没有定义 mode 与 editable 的优先级。— 建议：`line`/`column` 存在时默认 source（与 Markdown 的 `initialLine` 规则一致），并作为独立默认规则测试；可编辑终端产物 HTML 明确“只读预览 + 编辑源码”或“本期不提供预览”，在 body 层做分支；route normalize 对 `terminalArtifact` 分支也要透传/校验 mode。

- [MAJOR] 测试方案断言了现有实现没有的行为，且缺关键用例 — HT-C4 要求“无限循环不崩溃、有超时/限制”，但现有 WebView 没有超时/JS 限制；HT-C6 要求非 UTF-8 报错，但 `readLocalMobileFile` 直接 `toString('utf8')`，只会出现替换字符，不会触发 `binary_file`（`runtime-file-commands-terminal-file-paths.ts:32-42`）；HT-C1“脚本按现有策略执行”在 native 是执行、在 web sandbox 是不执行，必须分开写。还缺：scheme 白名单/脚本自动跳转、iframe、web 端链接行为、mode 路由归一化/OTA、设置恢复、偏好损坏、外部动作记忆、0 字节、CJK/emoji 内容与文件名、返回/旋转、渲染中断线。— 建议：按实际实现修正断言；若产品要求“无限循环可恢复”，在设计中加入超时/重载策略，否则把 HT-C4 降级为“不崩溃、可退出预览”并说明代价；补上上述用例编号并映射到 AC。

- [MAJOR] 自动弹层的触发条件与“几种打开方式”没有精确定义 — HTML 的 preview/source 永远可用，所以“可用模式 ≥2 且偏好 ask”实际上等于“每次点击都弹”，除非用户记住；原型写“检测到 3 种打开方式”却列了 5 个动作；外部动作是否计入、不可用动作是否隐藏/禁用、只有 1 个可用动作时是否还弹，都没有定义，导致 HT-A1/HT-B5 无法判定。— 建议：定义 `availableHtmlOpenActions(target)` 纯函数及计数口径（只数 preview/source，或数所有可执行动作）；明确“只有 1 个动作时不弹、直接执行”；在原型中展示远程不支持时的状态和实际动作数。

- [MINOR] 原型中文文案与移动端实际 UI 不一致 — mobile 代码“renders plain strings throughout”，`MobileHtmlPreview` 用 "Preview"/"Source"，现有设置也是英文；原型用“预览页面/查看源码/在 Orca 浏览器打开”。另外“渲染 · 安全沙箱”对原生 WebView 不准确（JS 开启、无桥，但不是 iframe sandbox）；“3 种打开方式”与 5 个动作自相矛盾。— 建议：统一英文文案（或明确本地化不在本期），把“安全沙箱”改为可证实描述（如“外部链接外部打开”），修正计数。

- [MINOR] 触控目标低于原型的 44×44 声明 — `.segmented button` 高 30px、`.warnbar button` 约 24px、`.switch` 高 28px；`index.html` 声称 44×44 最小触控目标。— 增加 hitSlop/最小高度，或修改原型声明。

- [MINOR] 溢出菜单宿主未定，原型交互不完整 — 移动端没有 popover/menu 原语（只有 `ActionSheetModal`/`BottomDrawer`）；原型用锚定 popover，且没有 scrim/点击外部/Android back 关闭。`ActionSheetModal`/`PickerModal` 也没有“记住”开关或页脚插槽，`MobileFileOpenModeSheet` 需要明确用 `BottomDrawer` 组合。— 建议：指定新建可访问的 `PopoverMenu` 或改用 ActionSheet；补 outside-tap/back/焦点管理；明确 sheet 组合方式与测试。

- [MINOR] 偏好键名与容错未定义 — `orca:mobileFileOpenMode:html` 与现有 `orca:terminalLinkOpenMode` 风格不一致；损坏/未知值（非 ask/preview/source）的回退没有测试。— 统一命名（如 `orca:mobileHtmlOpenMode`），读取时校验枚举并回退 `ask`，补单测。

- [MINOR] 返回时模式保留“可选”未定义，且 `setParams` 在 OTA 会重挂载 shell — `[worktreeId].tsx` 用 `key={shellScreenRouteKey(decision.route)}`，改路由参数会重挂载页面。— 明确用局部 state（返回重置为偏好或保持当前），避免 `setParams`；或接受重载并测试状态与滚动。

- [MINOR] 原型缺少 G2 要求的禁用/能力受限状态 — 没有远程/旧主机不支持“Orca 浏览器”、用其它 App 不可用、>512KB、读取失败/无权限等状态；还额外画了 4.2 KB 大小标签和 HTML 图标，设计未提及。— 补关键状态并去掉未纳入设计的视觉元素。

- [MINOR] 长按菜单动作与设计不一致 — 原型 04 有“下载到手机”和“记住此选择”，设计 3.2/3.3 没有；自动弹层与长按弹层的动作顺序/分组也不同。— 用同一个 action builder 输出，明确顺序、分隔和记住项的适用范围。

- [MINOR] 长按交互与无障碍细节缺失 — 没有 500ms 长按、触觉反馈、滚动中取消长按、与行 `onPress` 互斥的说明；分段控件/溢出按钮没有 `accessibilityState`（selected/expanded）和当前模式播报。— 补交互规范与组件测试，沿用现有 `triggerSelection` 和 `accessibilityRole="tab"` 模式。

## Requirement coverage

| 需求                        | 结论     | 依据 / 缺口                                                                                |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| 代码/渲染切换               | 部分覆盖 | AC1/2、3.2/3.3 有；组件复用冲突、header 与第二行工具栏不一致（见 MAJOR）                   |
| 右侧折叠菜单                | 部分覆盖 | 3.2/原型 02 有；与 FB-U3 冲突，宿主未定                                                    |
| 长按文件弹出菜单            | 部分覆盖 | 3.2/原型 04 有；依赖未建的 FB-U2，动作与设计不一致                                         |
| 多种打开方式时自动弹层      | 部分覆盖 | AC1/3.2 有；触发计数口径不清，远程/旧主机隐藏后的行为未定                                  |
| 记住选择                    | 部分覆盖 | AC4 有；外部动作语义缺失，长按入口未写入设计                                               |
| 恢复“每次询问”              | 部分覆盖 | overflow 与 prefbar 有；设置页落点缺失                                                     |
| 相对资源缺失提示            | 部分覆盖 | 明确为限制；检测逻辑、文案与测试不一致                                                     |
| >512 KB HTML                | 部分覆盖 | 风险表有；具体渲染/禁用行为未定义，doc-preview 说法不成立                                  |
| 远程 worktree               | 未覆盖   | Orca 浏览器 URL 构造与能力探测未定义；远程 `file://` 会指向桌面本机                        |
| OTA/web-shell               | 未覆盖   | 未决策；`mode` 未进入 shell 参数链；HT-R5 不可判定                                         |
| 安全（沙箱/导航锁/XSS）     | 部分覆盖 | 复用导航锁、web sandbox、无宿主桥成立；scheme 限制描述错误，缺用户激活/白名单/网络外带说明 |
| 桌面一致性                  | 覆盖     | 明确不强制同形态；但移动端没有相对资源/doc-preview，需在 UI 讲清限制                       |
| 与文件浏览/终端链接功能一致 | 部分覆盖 | ask/记住模式与终端链接类似；但菜单、设置、能力探针未与文件浏览需求对齐                     |

## 待确认问题

1. OTA 构建下 `/files` / `/files/preview` 强制 native，还是接受桌面 web bundle？需要和 FB-U7 给出同一个结论。
2. “在 Orca 浏览器打开”是否要支持 SSH/paired 远程 worktree？若支持，用哪个 host RPC / doc-preview 方案？
3. “记住我的选择”是否只对 preview/source 生效？选择外部动作后是否写偏好、是否再次弹层？
4. 模式切换放 header 还是第二行工具栏？是否允许 `MobileHtmlPreview` 去掉内部 Preview/Source tab？
5. > 512 KB 时是渲染截断内容还是禁止渲染？截断横幅放在正文顶部还是模式栏？
6. 相对资源是解析后提示，还是所有 HTML 一律提示？是否需要在提示中列出具体文件？
7. `line`/`column` 深链是否强制 source？可编辑终端产物 HTML 是否允许渲染预览？
8. 自动弹层的“多种打开方式”具体计数口径是什么？隐藏不可用动作后是否仍弹？
9. 设置入口放在 Browser 设置还是新建 Files 设置页？OTA/web-shell 是否需要同步？
10. 原型中的中文文案是最终 UI 还是仅文档示意？实现应使用英文还是引入本地化？
