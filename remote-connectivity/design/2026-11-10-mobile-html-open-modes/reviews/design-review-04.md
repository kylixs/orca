# 设计评审 04 — HTML 打开方式（第四轮复审）

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/html-open-modes.html`；对照 `mobile/src/files`、`mobile/src/components/MobileHtmlPreview*`、`mobile/src/settings/browser-settings-screen.tsx`、`react-native-webview@13.16.2`（iOS/Android 导航实现）与文件浏览需求。
复审基线：`reviews/design-review-03.md`（REJECTED：0 BLOCKER / 5 MAJOR / 9 MINOR）。
原型验证：本地 HTTP 提供页面后用 Playwright 实测（未修改文件）：7 个预览态溢出按钮、状态 05/06/07 数组、唯一 Preview、header 入口、第二行工具栏、设置页 PickerModal 均已核对；同时做静态核对。

结论：**APPROVED_WITH_MINORS**
统计：**0 BLOCKER / 0 MAJOR / 6 MINOR**

门禁判定：review-03 的 5 个 MAJOR 均已解决，无新的 blocker/major；剩余 6 个 MINOR 不改变实现可行性，但按 `DEVELOPMENT_PROCESS.md` 的 G3 规则需在 `tasks.md` 记录处理决定后再进入开发。

---

## Prior findings（review-03 逐条核对）

| 编号  | 级别  | 状态         | 核对结果                                                                                                                                                                                                                                                                         |
| ----- | ----- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 03-M1 | MAJOR | **已解决**   | 8.5（`design.md:382`）与 B2/B9（`test-plan.md:55/60`）、README:29、原型状态 02-09 统一为 `Preview、Source、Save to phone、Open with、Copy content、Copy path、Cancel`；HT-U4 已写同一顺序。文件浏览的共有动作相对顺序不变，HTML 仅在 Preview 后插入 Source，交叉数组可同时成立。 |
| 03-M2 | MAJOR | **已解决**   | 8.5（`design.md:383`）明确 HTML 的模式 `Preview` 取代通用文件 `Preview`，`list`/`preview` 两个 context 都只生成一个 Preview；HT-U4 与 B2/B3/B9 承接。Playwright 实测状态 02/04/08 均只有一个 Preview。                                                                           |
| 03-M3 | MAJOR | **已解决**   | 8.4（`design.md:363-372`）已把 `sourceOnly/terminalArtifact` 与 `truncated` 放到 `route.mode` 之前；A14/A15（`test-plan.md:47-48`）与 HT-T3（`tasks.md:12`）、HT-U12（`:15`）一致；A13 仍正确表达“无 terminal/truncated 时 route.mode 优先”。                                    |
| 03-M4 | MAJOR | **已解决**   | 8.1（`design.md:340-345`）限定顶层 frame 外开/拒绝，子帧按白名单放行；HT-U7/HT-V4、C10/C11a/C11b/C18 均承接。iOS 的 `isTopFrame` 与 Android 固定 true/不报子帧的事实已写入设计；C18 已改为可判定断言。残留 Android 子帧危险 scheme 的表述见 04-m6。                              |
| 03-M5 | MAJOR | **已解决**   | HT-U17 已删除；HT-U6（`tasks.md:35`）明确不加 `textInteractionEnabled`，由 FB-U11 在 HT-U6/HT-V1 之后追加；合并顺序（`tasks.md:60`）写明 FB-U11 唯一 owner；FB 任务表依赖方向一致。                                                                                              |
| 03-m1 | MINOR | **部分解决** | `setParams`（114）与恢复入口（50/84）已清；偏好键、自动弹层计数、header 切换、动作顺序等正文旧值仍残留 → 04-m1。                                                                                                                                                                 |
| 03-m2 | MINOR | **部分解决** | 512 KB 源码/横幅、blocked toast、C11 分平台、C8 矩阵均已精确化；no-app 精确文案与原型不一致、B12 边界标签错误 → 04-m2、04-m3。                                                                                                                                                   |
| 03-m3 | MINOR | **已解决**   | C8（`test-plan.md:77`）已含 `http(s):`、`data:`、空 HTML，且 `mailto/tel/javascript/about/blob///#/空 href` 与 `./`、`../`、裸名、根绝对路径齐全；与 8.6 一致。                                                                                                                  |
| 03-m4 | MINOR | **已解决**   | 8.7（`design.md:406`）与 HT-U9（`tasks.md:38`）要求 HTML 专用 `truncatedNote`，R2（`test-plan.md:95`）保留 Markdown 既有 “Preview truncated. File size: …”。                                                                                                                     |
| 03-m5 | MINOR | **已解决**   | `onBlockedScheme` 已进入 Frame API 思路、HT-U6/HT-V4、C10/C12；web 无 toast/由 shell 上报的平台差异已写明。                                                                                                                                                                      |
| 03-m6 | MINOR | **部分解决** | B12/B13 与 README 状态 05/06 已给完整数组；但 8.3 的函数输入仍与 8.5/HT-U1 不一致 → 04-m4。                                                                                                                                                                                      |
| 03-m7 | MINOR | **已解决**   | 3.1/7.8、HT-T5、README 与原型状态 10 均为“行 + PickerModal”；与 `browser-settings-screen.tsx` 现有交互一致，Playwright 实测通过。                                                                                                                                                |
| 03-m8 | MINOR | **已解决**   | 8.7/HT-U6/HT-U11 已区分 iOS 与 Android；C13（`test-plan.md:83`）分平台写明期望。                                                                                                                                                                                                 |
| 03-m9 | MINOR | **已解决**   | HT-U12 依赖 HT-V1（`tasks.md:15`），HT-U3 依赖 HT-T3/HT-V1（`:23`）；文件重叠已串行化。合并顺序遗漏 HT-U3 见 04-m5。                                                                                                                                                             |

---

## Findings

### BLOCKER

无。

### MAJOR

无。

### MINOR

- **[MINOR] 设计正文与任务摘要仍保留被第 8 节推翻的旧值，且这是 02-m7/03-m1 的第三次残留。**
  `design.md:101-102` 仍写“预览页头部切换”，与 `:153`、`:214`、`:386` 的第二行工具栏冲突；`:169` 仍是 `mobileFileOpenMode:html`，与 `:86/:267` 的 `orca:mobileHtmlOpenMode` 冲突；`:184` 仍是“≥2 模式才弹”，与 8.3 固定两个模式冲突；`:232` 的动作列表仍是“预览页面、查看源码、下载/保存、用其它 App 打开、复制路径”，缺 Copy content/Cancel；`:100`、`:213` 与 `tasks.md:4` 仍写“HTML 只追加 Preview/Source”，与 8.5 的模式 Preview 取代通用 Preview 冲突；`:80` 的 Copy content 条件“≤512 KB”与截断仍可复制前 512 KB（B12）冲突；`:133` 仍是只允许 `about:blank`/`data:` 的旧导航锁，与 8.1 白名单冲突；`tasks.md:3` 状态仍是“设计修订 02（待复审）”。
  **建议**：删除或就地标注“已被 8.x 取代”；偏好键、动作顺序、header 位置、追加/取代语义、512 KB Copy content 只保留一个事实源；`tasks.md` 状态更新为第 04 轮复审结果。

- **[MINOR] no-app 的精确文案在测试计划与原型之间不一致，README 的规范文案未收录。**
  `test-plan.md:84` 断言 “No app can open this file”，但原型状态 07（`html-open-modes.html:656`）显示 “No app available for this file type. Use Save to phone instead.”，且 `ui/README.md:22-33` 的 Normative English copy 没有该句。README 声明手机框内英文文案为规范来源，因此 C14 的期望无法直接落地。
  **建议**：选定一条（推荐原型的带 Save to phone 引导文案），写入 README 规范文案，并同步 C14；若保留短文案，则同步原型。

- **[MINOR] B12 的场景名写成“512 KB 菜单”，与 512 KB 边界定义冲突。**
  `test-plan.md:63` 的 B12 期望无 Preview、Copy content 带 “Copies the first 512 KB”，但 `test-plan.md:78` 的 C9 与原型状态 05 明确“511/512 KB 不截断、513 KB 起截断”。按 B12 的场景名执行 512 KB 文件会得到与 C9 相反的结果。
  **建议**：改名为“513 KB（truncated）菜单”或“>512 KB 菜单”，与 A15/C9 使用同一输入。

- **[MINOR] `availableHtmlOpenActions` 的输入签名与 truncated/read-failure 隐藏规则仍未收口。**
  `design.md:359` 仍写输入只有 `{ source, hasLineTarget }`；`:388` 又要求 `previewDisabled`/`readFailed` 并“分别隐藏 Preview/Source/Copy content，或只保留 Retry/可用项”；HT-U1（`tasks.md:21`）已包含四项输入，B12/B13 已给不同数组。design 内部没有唯一签名，且“分别隐藏 Preview/Source/Copy content”容易被读成 truncated 也隐藏 Source。
  **建议**：在 8.3/8.5 只保留一个签名 `{ source, hasLineTarget, previewDisabled, readFailed }`，并写死：truncated 只隐藏 Preview，保留 Source/Copy content；read failure 保留 Retry/Save/Open/Copy path，隐藏 Preview/Source/Copy content。

- **[MINOR] 合并顺序漏掉 HT-U3/HT-U15，而 HT-U13 依赖 HT-U3。**
  `tasks.md:59-60` 的第 2 步只列 `HT-U1/U2/U4/U5`，第 5 步才列 `U11/U12/U13/U14/U16`；但 HT-U13（`:26`）依赖 HT-U3，HT-U3（第二行 Preview/Source 工具栏）未出现在任何合并阶段，HT-U15（交叉验收）也只在任务表中。按字面执行合并顺序会出现“依赖已排期、被依赖任务未排期”。
  **建议**：在 HT-V1 之后、HT-U13/HT-U14 之前加入 HT-U3；把 HT-U15 放到测试阶段（与 Q2/Q7 同批），并更新 `tasks.md:3` 状态。

- **[MINOR] C18 的“危险 scheme 被拒绝”对 Android 子帧没有设计依据。**
  `design.md:340-342` 只定义了 iOS 子帧（`isTopFrame=false`）的 `file/intent/javascript` 拒绝；Android 的 `onShouldStartLoadWithRequest` 固定 `isTopFrame: true` 且不为内层 frame 触发，无法用同一回调拒绝子帧。`test-plan.md:88` 的 C18 以“iframe（iOS/Android）”要求“危险 scheme 被拒绝”，Android 侧可能只能依赖 WebView 默认行为，没有可实现的断言路径。
  **建议**：把 C18 的危险 scheme 断言限定为顶帧 + iOS 子帧；Android 子帧改为可观察的“不拉起外部浏览器、不离开预览”，或在 8.1 明确 Android 依赖 WebView 默认拒绝并补平台说明。

---

## Prototype checklist

| 检查项                  | 结果                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一 Preview / 动作顺序 | 通过（Playwright）：状态 02-09 的动作数组一致，均只有一个 Preview；顺序为 Preview、Source、Save to phone、Open with、Copy content、Copy path、Cancel（不可用项隐藏）。                                                           |
| 预览页溢出入口          | 通过：每个预览态恰好一个 header `…`（`data-toggle-menu`），打开同一形态的 ActionSheet；状态 03 默认展开也同序。                                                                                                                  |
| 文件列表 header More    | 通过：状态 01/09 用 44px spacer，无未绑定 More；状态 09 行尾按钮属于文件浏览行操作。                                                                                                                                             |
| 第二行工具栏            | 通过：每个预览态恰好一个 `role="tablist"`、两个 tab；无重复切换控件。                                                                                                                                                            |
| 自动弹层                | 通过：状态 01 只有 Preview/Source/Cancel + Remember，无外部动作、无 More。                                                                                                                                                       |
| 512 KB                  | 通过：状态 05 Preview `disabled`/`aria-disabled`，横幅与 “Showing first 512 KB” 精确；ActionSheet 为 Source、Save、Open、Copy content（Copies the first 512 KB）、Copy path、Cancel。文案与 C9 一致，但 B12 场景名需修 → 04-m3。 |
| 读取失败                | 通过：状态 06 数组 Retry、Save、Open、Copy path、Cancel；Preview/Source/Copy content 隐藏，与 B13/README 一致。                                                                                                                  |
| 无可用 App              | 通过（结构/数组）；toast 文案与 C14 不一致 → 04-m2。                                                                                                                                                                             |
| 被阻止 scheme           | 通过：状态 08 in-frame toast 文案与 README/C10 一致；仅顶层 frame 的说明已在状态文案中。                                                                                                                                         |
| 长按菜单                | 通过：状态 09 与溢出同序、无 remember、无 Reset/Ask，选择模式不写偏好。                                                                                                                                                          |
| 设置恢复                | 通过：状态 10 为“HTML open mode”行 + PickerModal（Ask/Preview/Source），唯一 Reset-to-Ask 路径；与现有 Browser 设置页结构一致。                                                                                                  |
| 无旧元素                | 通过：无 prefbar、无 “Reset to Ask”、无文件大小标签、无 “Link blocked” 弹层、无 “Open in Orca browser”。                                                                                                                         |

## Platform check（iOS / Android / SSH / folder / OTA）

- iOS：顶层/子帧策略已按 `isTopFrame` 写清；`textInteractionEnabled` 仅 iOS，由 FB-U11 追加；C13 已分平台。未发现新阻断。
- Android：`navigationType` 固定 `other` 已被接受；顶层 scheme 白名单可落地；子帧危险 scheme 的测试表述见 04-m6。
- SSH / folder workspace：预览仍走 `files.read`（`mobile-file-preview-request.ts`），截断、相对资源检测与本地一致；测试数据要求 SSH/folder 各一条。
- OTA：文件预览强制 native，mode 经 route/normalize/shell params 透传；HT-T2/HT-U11 与 R5 覆盖。

## AC → 用例覆盖

| AC                  | 对应用例                 | 结论                                                              |
| ------------------- | ------------------------ | ----------------------------------------------------------------- |
| AC1 首次点击弹层    | A1/A2/A3/A8              | 可验证；自动弹层固定两个模式。                                    |
| AC2 渲染/源码切换   | A2/A3/B1/B8/A14/A15      | 可验证；优先级由 8.4 唯一化。                                     |
| AC3 溢出/长按菜单   | B2/B3/B9/B11/B12/B13     | 可验证；数组与唯一 Preview 已固定；B12 标签需修。                 |
| AC4 记住/恢复       | A4/A5/A9/A10/A11         | 可验证；设置页为唯一恢复入口。                                    |
| AC5 相对资源/大文件 | C2/C5/C8/C9              | 可验证；边界与文案已精确。                                        |
| AC6 外链/安全       | C3/C10/C11a/C11b/C12/C18 | 可验证；C18 的 Android 子帧说明见 04-m6。                         |
| AC7 回归            | R1-R8                    | 可覆盖；R2 保留 Markdown 文案，R7 terminal artifact source-only。 |

## 处理建议

1. 先清理 04-m1 的正文/任务旧值，再进入 G4；这些旧值与第 8 节直接冲突，第三次残留会持续误导实现。
2. 在 `tasks.md` 记录 04-m1..04-m6 的处理决定（G3 对仅 MINOR 的通过要求）。
3. 04-m2/04-m3 只需改文案/场景名；04-m5 只需补合并顺序；04-m4/04-m6 建议在 8.1/8.3/8.5 内收口后再实现。
