# 设计评审 01 — 终端

结论：REJECTED

## Findings

- [BLOCKER] 宽字符右半格映射仍会错位：设计把长按流程定为 `viewportToCell → cellColToStringIndex → tokenizer`，但 xterm 的 `line.translateToString(false, 0, col)` 在 `col` 指向宽字符第二格时会把整个宽字符包含进来，返回的是“该字符之后”的 string index（`mobile/src/terminal/document/cell-geometry.ts:34-43`）。例：`中文abc`（中 0-1、文 2-3、a 4），点 cell 3（“文”的右半格）得到 index 2，分词结果变成 `abc`；点 emoji 的右半格也会落到后面的英文。 — 影响：用户仍会看到“前面有中文/emoji 时长按错位”，核心需求未修复；这不是边界情况，手指落在宽字符右半格非常常见。 — 建议：在 cell→string 之前把落点归一到显示字符的起始 cell（若当前 cell 为空且前一 cell `getWidth() === 2`，或从 0 按 width 扫描定位），并把 `snapToCellStart` 写成设计 pipeline 的显式一步；同时明确两个游标不能互换：`stringIndex += getChars().length`，`cellCol += max(1, getWidth())`。补“宽字符两个半格”“emoji 两个半格”的单元测试。

- [BLOCKER] 选区坐标语义自相矛盾，宽字符高亮与复制仍会不一致：设计把 token 映射成 `[startCol, endCol)`，但现有 `applyXtermSelection` 仍按 inclusive 计算 `end.col - start.col + 1`（`mobile/src/terminal/document/selection-range.ts:64-89`），`repositionOverlay` 的末端手柄也用 `r.end.col + 1`（`mobile/src/terminal/document/selection-overlay.ts:19-31`）。例：选中“中文”时 start=0、end-exclusive=4；若保持现有 inclusive 焦点 2，则长度为 3，只高亮“文”的左半格，而 `term.getSelection()` 会复制完整的“中文”；若把焦点改成 4，则长度算成 5，多选一格。跨行和手柄拖动同样受影响。 — 影响：直接违反验收标准“选中高亮与复制文本一致”，并且设计又要求“保持现有 applyXtermSelection 的行列算法”，两者不可同时成立。 — 建议：二选一并全链路修改。推荐保留 cell-start 的 inclusive anchor/focus，但选区长度按末字符的 `getWidth()` 扩展，overlay 末端用 `focus.col + width(focusCell)`；或统一改为 end-exclusive，并同步改 `applyXtermSelection`、`repositionOverlay`、`syncSelectionHandleToViewportPoint`、`selRange`/`isStartFirst`、`selectAll`。测试必须断言 `term.select` 参数和 selection model 末端，不能只断言 `getSelection()`。

- [BLOCKER] 测试方案无法证明 offset bug 被修复：现有 WebView 测试的 fake line 用 `text.slice(start, end)` 把 cell 列当字符串下标（`mobile/src/terminal/terminal-webview-tap-routing.test.ts:36-40`），这正是待修复的错误假设；`test-plan.md` 的向量只要求“记录：长按 cell、期望字符串、实际字符串、截图”，没有给出具体 cell 范围、`term.select` 参数，也没有覆盖宽字符右半格、`Intl.Segmenter` 缺失、组合字符、行尾/折行。 — 影响：错误实现可以全绿通过，G3/G6 无法验收，也无法防止回归。 — 建议：提供 width-aware fake buffer（每 cell 实现 `getChars()`/`getWidth()`，`translateToString` 按 width 跳过宽字符第二格）或直接使用真实 xterm `BufferLine`；把向量写成表：行文本、tap cell、期望 startCell/endCell、期望 `term.select` 参数、期望复制文本；加入“中文/emoji 右半格”“行尾宽字符”“组合字符”“折行”“Segmenter 存在/不存在”两类用例。

- [MAJOR] 新 tokenizer 会破坏现有 URL/路径/emoji/组合字符/全角词的整词选择：现有 `WORD_RE` 含 `._/:@~+=?&#%-`（`mobile/src/terminal/document/selection-range.ts:7`），所以 URL 和路径会被当作一个词；设计的回退拉丁词是 `[A-Za-z0-9_]+`，并明确“标点/空白为边界”，`Intl.Segmenter` 的 word 粒度也会把 URL/路径拆开。`emoji`、`é`（U+0065 U+0301）、全角 `ＡＢＣ１２３` 在回退路径下也可能被当作边界或拆开。 — 影响：长按 URL/路径复制（终端里非常常见）会从“整段复制”退化为“复制一个片段”，属于现有行为回归；emoji/组合字符的 AC 也无法达成。 — 建议：分词前先用现有 URL/path 正则标记原子 span（复用 `url-tap.ts`/`path-tap.ts` 的匹配），再分词；为 grapheme/emoji/combining mark/全角字符定义原子 token；补“URL/路径长按复制不变”的回归用例。另需统一使用 UTF-16 code unit 下标（`getChars().length`、`lineText.length`、`Segmenter` index 都是 code unit），不要改成 code point 计数。

- [MAJOR] “附近词/短语”的选取规则未定义完整，且与原型冲突：设计只写“±8 cell 内找最近的 token”，没有定义距离是 token 起点、终点还是中心，也没有左右平局规则。按“最近边缘”，在 `修复，登录流程` 上长按“，”会选到左边距离 0 的“修复”，而原型期望“登录流程”（`terminal-selection.html` 状态 02）；在 `验证 权限边界 & token` 上长按“&”按“最近起点”会选到右边的“token”，原型却期望左边的“权限边界”（状态 03）。另外 `Intl.Segmenter` 可能把“登录流程”切成“登录”+“流程”，而设计的 2-6 字扩展只对“单个 CJK 字符”生效，无法从“登录”扩展到“登录流程”。 — 影响：实现者无法从设计得出唯一结果，原型不能作为验收依据；用户看到的“智能短语”会随机偏向一侧。 — 建议：明确距离度量、左右优先级、CJK 连续段合并上限（例如最多 6 字）、长 token 与窗口重叠的规则，以及无 token 时选中“整个字符”（宽字符 2 cells）而不是 1 个 cell；用 `修复，登录流程`、`权限边界 & token` 两组用例把规则钉死，并同步修改原型或规则。

- [MAJOR] “远程打开”的实际行为与 TL-A3“手机停留终端”矛盾：`handleCreateBrowser` 会设置 `pendingBrowserFocusPageIdRef`（`mobile/src/session/use-mobile-session-content-create-actions.ts:124-129`），tab 同步命中后会调用 `switchSessionTab` 切到新 browser tab（`mobile/src/session/use-mobile-session-tab-reconciliation.ts:55-58`、`mobile/src/session/mobile-session-tabs-accepted-effects.ts:30-36`）。因此当前实现选择“远程打开”后，手机很可能离开终端进入新 browser tab，而不是停留在终端。另一个问题是 `browserScreencastSupported` 表示“手机能否看浏览器流”，不是“桌面能否新建 browser tab”；用它决定是否隐藏远程动作，把“在桌面打开”和“在手机看流”混为一谈。 — 影响：测试预期（TL-A3）与实际行为不符；能力受限主机可能被无谓地隐藏“远程打开”；用户选择远程后可能被切走。 — 建议：先确认产品语义。若“远程打开”=仅桌面新标签、手机留守，则不要设置 `pendingBrowserFocusPageIdRef`，或增加不激活手机 tab 的 create 变体；若“远程打开”=手机展示流，则更新 TL-A3/文案，并保留 capability gate。补 `client` 为空、`creatingBrowser`、能力未知（null）、离线四种状态的用例。

- [MAJOR] 链接类型路由矩阵不完整，TL-A10 自相矛盾：`surface-tap.ts` 的顺序是 OSC file → `file://` → OSC HTTP/HTTP(S) → 文件路径（`mobile/src/terminal/document/surface-tap.ts:18-55`）。OSC 8 的 HTTP(S) 链接会发出 `open-url`，因此应进入新弹框；但 `test-plan.md` 的 TL-A10 把“OSC 8 / file:// / 文件路径”整体写成“保持原有路由，不被新弹框误处理”，会错误地要求 OSC 8 HTTP 不弹框。 — 影响：测试可能固化错误行为；OSC 8 HTTP 是真实链接类型，漏测后线上行为不确定。 — 建议：在 design/test-plan 加矩阵并逐条建用例：文本 HTTP/HTTPS → 弹框；OSC 8 http(s) → 弹框；OSC 8 file → file tap；`file://` → file tap；裸路径/带行号路径 → file tap；`mailto:`/自定义 scheme → 明确写为非目标。

- [MAJOR] active handle 竞态只在弹框时检查，动作执行时没有复核：设计说“仅当当前 handle 仍是 active handle 时弹框”，但弹框打开后切换 terminal tab/会话，用户再点动作仍会执行；TL-A11 又要求“handle 不匹配时忽略”。设计也没有防重复点击/动作消费标记。 — 影响：长按链接后切走仍会在错误上下文打开；快速连点可能重复调用 `browser.tabCreate`/`Linking.openURL`。 — 建议：在选择动作时再次校验 `handle === activeHandleRef.current`，或监听 active handle 变化关闭/清空 sheet；加 `choiceConsumed`/in-flight guard；T7 增加“弹框后切 tab”“快速双击动作”组件测试。

- [MAJOR] “复用 ActionSheetModal”不成立，记住开关和完整 URL 展开没有实现载体：`ActionSheetModal` 的 props 只有 `title/message/actions/onClose`（`mobile/src/components/ActionSheetModal.tsx:20-26,110-144`），`message` 只是普通 `Text`，没有 children/footer/switch，无法放“记住我的选择”开关，也无法做“点击展开完整 URL”。T2 也没有列出主机名摘要、完整 URL 展开、开关行。 — 影响：按设计会临时改公共组件或拼装，容易破坏其它 sheet；URL 钓鱼防护的关键交互（只看 host、可展开）落不了地。 — 建议：明确新建 `TerminalLinkActionSheet`（基于 `BottomDrawer`，或给 `ActionSheetModal` 增加受控 footer/children 扩展），在 T2 列出主机名摘要、显示/隐藏完整 URL、记住开关、取消、无障碍标签；补组件测试。

- [MAJOR] 键盘/焦点处理没有任务：设计说“弹框出现时暂停终端输入焦点，关闭后恢复”，但 Android/iOS 的 BottomDrawer 不会自动收起终端 `TextInput`。现有会话 tab sheet 已有成熟模式 `openSessionTabActionSheetAfterKeyboardDismiss`（`mobile/src/session/use-mobile-session-terminal-send-actions.ts:229-263`）：先 blur/Keyboard.dismiss，等键盘消失再开 sheet，并有 fallback。 — 影响：键盘可能盖住 sheet、抢焦点；取消后是否恢复键盘也不确定。 — 建议：T3 复用 dismiss-then-open 流程，记录打开前键盘状态，明确取消/复制/远程后是否恢复；补组件和设备用例。

- [MAJOR] “记住我的选择”语义未定义完整：开关打开后选“复制链接”或“取消”写什么？远程动作被隐藏/能力未知时记住哪个？偏好写失败如何反馈？`terminalLinkOpenMode` 初始 state 仍是 `'orca-browser'`（`mobile/src/session/use-mobile-session-screen-state.ts:46-47`），异步 `loadTerminalLinkOpenMode` 完成前点击会绕过 `ask`；现有偏好测试仍断言默认 `orca-browser`（`mobile/src/storage/preferences.test.ts:479-505`）。 — 影响：用户可能“记住”未预期的行为；首击有竞态；T1 落地后现有测试会红。 — 建议：给出 action×remember 状态表（只有本机/远程打开写偏好；copy/cancel 不写；写失败 toast），T1 更新默认值/初始 state/现有测试，T6 明确写回后同步 `setTerminalLinkOpenMode`；确认旧显式偏好是否迁移或保留。

- [MAJOR] `Intl.Segmenter` 回退只有声明，没有可执行验证；文档构建 target 是 `chrome74`（`mobile/scripts/build-terminal-document-script.mjs:20`），Chrome 74 没有 `Intl.Segmenter`（Chrome 87+），旧 WebView 必然走回退。现代 Android 模拟器不会覆盖这条路径，test-plan 也没有 mock Segmenter 缺失/构造抛错。 — 影响：旧设备上中文分词可能退化为错误边界，而测试全绿。 — 建议：tokenizer 测试删除/替换 `Intl.Segmenter` 后跑同一组向量，并对“构造抛错”做兜底；指定 locale（`Intl.Segmenter(undefined, {granularity:'word'})` 或显式 zh）并缓存实例；在旧 WebView/CI 环境跑回退路径；说明 `\p{Script=...}` 在 Chrome 64+ 可用，不需要为属性转义再做回退。

- [MAJOR] test-plan 缺少 AC→用例映射和几何/tokenizer 单元测试：没有“验收标准 1-5 → TL-*”的映射表；没有 `cell-geometry.test.ts`、`text-tokenizer.test.ts`、`selection-range.test.ts`、`selection-overlay.test.ts` 的具体断言；TL-B8/B13/B14 只有场景没有期望；没有手柄拖动到宽字符边界、复制文本与高亮同时断言、失败/离线/未知能力、folder workspace/OTA 用例；TL-B10 的组合字符没有写明 NFC/NFD code point。 — 影响：不满足 G1“每条验收标准对应的用例编号”，G7 会判“假通过”。 — 建议：补映射表和分层用例；每个几何/分词用例写清输入、tap cell、期望 cell 区间、期望 `term.select` 参数、期望文本；补失败/离线/未知能力/folder workspace/OTA 和旧 WebView 环境；设备用例写清 WebView 版本、命令和证据路径。

- [MAJOR] 折行/缩放测试预期与现有行为冲突：设计说“映射函数只处理当前 buffer line”，但 TL-B8 只写“跨行文本复制正确”没有期望，`isWrapped` 也未被使用；TL-B14 要求“缩放/旋转后选区仍对齐”，但 pinch 会 `cancelSelect`（`mobile/src/terminal/document/tap-dispatch.ts:126-131`），rotation/refit 也可能重建或清除选区；TL-B13 的横向 pan 在 fitScale ≤ 1 时通常不可达（`surface-touch-gestures` 只在内容宽于 viewport 时 pan）。 — 影响：测试会写死错误预期或无法执行；跨 wrap 的单词到底选一半还是整词也没有产品结论。 — 建议：明确 v1 是否支持跨 wrap 整词（若支持，用 `isWrapped` 合并逻辑行；若不支持，写进非目标并加“当前行”用例）；把 TL-B13/B14 改成“pinch 取消选区/旋转后状态一致”并实测；补宽字符在折行边界的用例。

- [MAJOR] 任务依赖顺序有回归窗口，且缺少若干关键任务：T1 先把默认/类型改成 `'ask'`，但 `handleTerminalOpenUrl` 在 T3 前只认 `phone-browser`，否则落到 remote open（`mobile/src/session/use-mobile-session-file-actions.ts:94-99`）；分 PR 合并时 `ask` 会表现为“直接远程打开”。tasks 也缺少：落点归一化、selection model/overlay 的 inclusive/end-exclusive 改造、键盘处理、active handle 复核、URL 展示/展开、失败态、URL/path 长按回归。 — 影响：中间态行为错误、难以 bisect；开发子代理会按不完整任务做出不可集成的实现。 — 建议：T1 与 T3 同 PR，或 T3 先加 `ask` 分支再改默认；把上述缺失项拆成可执行任务并标注具体文件/测试；TL-R1..R3 从“相关测试”改为具体文件与命令。

- [MINOR] 原型包含设计与任务未覆盖的 UI/行为：`terminal-link.html` 的 prefbar“已记住…修改”、snackbar“撤销”、链接虚线/蓝色样式都不在 design/tasks 中；`terminal-selection.html` 说“松开前不显示选区”，但 `armLongPress` 在 500ms 就调用 `enterSelect` 并显示 overlay（`mobile/src/terminal/document/tap-dispatch.ts:64-77`、`selection-range.ts:111-118`）。 — 影响：实现者会误以为这些是本期需求；测试预期不一致。 — 建议：删除/标注为“非本期”，或补任务（尤其是链接可视化的实现成本）；修正“松开前不显示选区”的描述。

- [MINOR] URL 展示的安全/可用性细节未定义：只显示 hostname 会隐藏 scheme 和 port；`http://` 没有警告；`localhost`/`127.0.0.1` 在手机上“本机打开”必然失败（原型第一例就是 `localhost:5173`）；SSH 会话里的 `localhost` 选择“远程打开”指向的是桌面而不是 SSH 主机；bidi/控制字符可能伪装 host。 — 影响：安全提示和用户预期都可能落空。 — 建议：显示 scheme + host(+port)，对 HTTP 给警告，对 loopback 给出“仅在远程主机可用”的提示，过滤 bidi/控制字符；补对应组件测试。

- [MINOR] 文案语言不一致：移动端现有 UI（Browser settings、Copy/Select All）是英文，design 和原型是全中文；直接实现会出现中英混排。 — 影响：UI 一致性差，评审/测试无法确认最终文案。 — 建议：明确本地化策略；若应用仍为英文，原型和任务使用英文，或接入 i18n。

- [MINOR] 无障碍未被验证：`ActionSheetModal` 是否自动聚焦/读屏未证实；记住开关、完整 URL 展开的 `accessibilityState`、终端链接没有可聚焦元素都缺少测试。 — 影响：读屏用户无法发现或操作链接；开关状态可能不被读出。 — 建议：给 Switch/展开按钮加 `accessibilityLabel`/`accessibilityState`，补 RNTL 断言；在设计里说明终端链接的读屏限制及替代入口（如长按菜单中的复制链接）。

- [MINOR] 失败态反馈不完整：`openExternalLink` 只 `console.warn`（`mobile/src/platform/external-link.ts`），本机打开失败用户无感；copy 失败需要 toast；remote 失败已有 toast，但 `client` 为空或 `creatingBrowser` 时 `handleCreateBrowser` 静默返回 false。 — 影响：用户点了动作却没有任何反馈。 — 建议：本机打开/copy 增加 toast/haptic；remote 在 client 为空或正在创建时禁用/提示；补测试。

- [MINOR] folder workspace / OTA web shell 未覆盖：design 只写 floating workspace；AGENTS.md 要求考虑 folder workspace；`orca:terminalLinkOpenMode` 在 page storage allowlist 中（`mobile/src/mobile-web-shell/page-storage-keys.ts:39`），`'ask'` 值需要确认 OTA 页面兼容。 — 影响：可能在某些路由上出现空动作或旧行为。 — 建议：补 folder workspace 和 OTA/web shell 用例，或明确写为非目标。

- [MINOR] 原型位置与状态覆盖不完整：原型放在共享 `design/ui-prototypes/` 而非 feature 的 `ui/`（DEVELOPMENT_PROCESS G2 要求每个需求一个 `ui/`）；selection 原型缺少 emoji、组合字符、折行、手柄拖动/复制一致性的状态。 — 影响：门禁产物不齐；关键状态无法评审。 — 建议：归位或说明共享布局；补 selection 的关键状态。

## Requirement coverage

- 原始需求 1（点击链接弹框，本机/远程选择）：**部分覆盖**。design §3.1、T1-T7、TL-A1..A11 有基本骨架；但远程动作的实际手机 tab 行为与 TL-A3 矛盾（M3），OSC 8 HTTP 与 TL-A10 矛盾（M4），remember 语义不完整（M8），失败/未知能力/离线态缺失（M3/M8/失败态 MINOR），ActionSheetModal 承载不了开关和 URL 展开（M6）。
- 原始需求 2（长按中文/宽字符选区校准 + 附近短语）：**未充分覆盖，存在 BLOCKER**。cell→string 的右半格归一化缺失（B1），选区 inclusive/end-exclusive 语义冲突导致高亮/复制不一致（B2），测试无法检出 offset（B3）；CJK 短语/最近 token 规则与原型不一致（M2）；emoji/组合字符/全角/URL/path 的 token 原子性缺失（M1）；折行/缩放预期冲突（M11）。
- HTTP/HTTPS：**覆盖**（`url-tap.ts` + 新弹框），但需要补 URL 展示/失败态/长 URL 用例。
- OSC 8：**部分覆盖**。HTTP(S) 应弹框、file 应走 file tap，但 TL-A10 把两者混在一起（M4）；自定义 scheme 未写非目标。
- `file://` / 文件路径：**路由逻辑覆盖**（`surface-tap.ts` 优先走 file tap），但需求层面“它们是否算用户所说的链接”未确认；test-plan 只写了“保持原有路由”，没有针对 file tap 的回归断言（M4）。
- 远程能力回退：**部分覆盖**。隐藏远程动作 + hint 有设计，但 `browserScreencastSupported` 的语义（桌面建 tab vs 手机看流）未分清（M3），能力未知/离线未覆盖（M3/MINOR）。
- 浮动工作区：**设计覆盖，测试定义不清**。TL-A5 说“保持只支持本机打开的既有行为”，但新 `ask` 模式会弹 sheet，和“保持既有行为”不一致（M8/待确认）；需要明确 sheet 是否仍出现。
- 记住选择：**部分覆盖**。开关存在，但 Copy/Cancel、远程隐藏/未知能力、写失败、旧偏好、初始 state、状态同步均未定义（M8）；现有偏好测试需要更新。
- 平台可行性：**部分覆盖**。Chrome 74 target 下 `Intl.Segmenter` 不存在，回退是必走路径，但没有可执行验证（M9）；`\p{Script=...}` 在 Chrome 64+ 可用，这点设计无需担心；iOS 14.5+ 可用。
- 测试可证伪性：**不满足**。没有 AC→用例映射、没有具体 cell/string 期望、没有 `term.select` 断言、没有 width-aware fake、没有 Segmenter 缺失/旧 WebView 用例（B3/M10）。
- 回归：**设计有意愿，用例不足**。TL-R1..R5 太泛；URL/路径长按复制、输入/滚动、OSC/file tap、selection copy/eviction、pinch 取消选区都没有具体断言（M1/M4/M11）。
- 任务完整性/依赖：**不充分**。T1/T3 合并顺序有中间态回归（M12）；缺少落点归一化、selection model/overlay 改造、键盘、active handle、URL 展示、失败态等任务（M12/M6/M7/M8）。
- UX/无障碍/一致性：**部分覆盖**。原型结构清晰、可点击；但存在原型专属的 prefbar/撤销/链接样式、长按时机错误、中文文案与英文应用不一致、无障碍未验证（MINOR 1/2/3/4）。

## 待确认问题

1. 已显式保存 `orca-browser`/`phone-browser` 的老用户，是否仍然直接按偏好打开、不再弹框？design 说“老用户已存的值保持不变”，但原始需求是“点击链接弹框”，需要确认产品取舍；未保存过的用户会得到新默认 `ask`。
2. “远程打开”的准确语义是什么：只在桌面 Orca 新建标签、手机留在终端，还是手机也切到新 browser tab 并展示流？当前 `handleCreateBrowser` 会切手机 tab，与 TL-A3 冲突。
3. 如果手机留在终端，`browserScreencastSupported === false` 时是否仍应允许“远程打开”（桌面能建 tab 即可）？如果手机要展示流，能力未知（null）时动作是隐藏、禁用还是等待？
4. “附近短语”的规则请拍板：按 token 起点/终点/中心算距离？左右平局优先哪边？CJK 连续段如何合并、上限几字？为什么原型中“，”选右侧“登录流程”、“&”选左侧“权限边界”？
5. 折行：v1 是否要把跨 wrap 的同一个词作为整体选中（使用 `isWrapped` 合并逻辑行），还是明确只处理当前 buffer line？
6. `file://`、OSC 8 file、裸文件路径、`mailto:`/自定义 scheme，是否都按 design 绕过弹框？需求里的“链接”是否包含文件路径？
7. 记住开关与 Copy/Cancel 的关系：开关打开后点 Copy/Cancel 是否不写偏好？偏好是全局还是按 host/workspace？写失败如何提示？
8. `localhost`/`127.0.0.1`/LAN 地址的“本机打开”在手机上通常不可达；SSH 会话中的“远程打开”指向桌面而不是 SSH 主机。是否需要提示、禁用或改写？
9. 旧 Android WebView（Chrome 74）是否仍在支持矩阵？如果在，必须验收 Segmenter 回退；如果不在，请写明最低 WebView 版本。
10. Folder workspace 是否支持 `browser.tabCreate`、是否显示远程动作？OTA/web shell 下这个 sheet 的行为是否与 native 一致？
11. 文案语言：本期移动端是英文 UI，design/原型是中文；最终用哪套文案？是否接入 i18n？
12. 手柄释放时的“词边界吸附”是否本期做？如果做，吸附改变端点会改变复制文本，与“不要改变已选中的中间文本”冲突，需要明确规则。
