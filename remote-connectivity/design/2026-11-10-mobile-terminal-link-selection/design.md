# 移动端终端：链接打开选择与中文选区校准

> 日期：2026-11-10
> 范围：Orca Mobile（Expo/React Native + xterm.js WebView）
> 目标：终端链接点击后由用户选择“本机打开/远程打开”；修复中文及宽字符长按选中错位，并智能选中附近词/短语。

---

## 1. 现状

### 1.1 终端渲染

- 终端是 **xterm.js WebView**：`mobile/src/terminal/TerminalWebView.tsx` 加载生成的 HTML（`terminal-webview-html.ts`），不是原生控件。
- 文档脚本：`mobile/src/terminal/document/create-terminal-document.ts`、`terminal-init.ts`。
- 已启用 `@xterm/addon-unicode11`，xterm 能正确计算 CJK/emoji 占 2 列。
- 滚动缓冲 5000 行，选区在缓冲被挤出时会清除。

### 1.2 链接识别与当前行为

- 没有使用 xterm 的 link addon；点击时由 `document/surface-tap.ts` 手动识别，优先级：
  1. OSC link
  2. `file://`
  3. OSC 8 / HTTP(S) URL
  4. 文件路径
  5. 鼠标点击
- URL 识别：`document/url-tap.ts`、`terminal-webview-url-tap.ts`；最长 2048 字符。
- 通知到 App：`terminal-webview-notification-dispatch.ts` → `onOpenUrl` / `onFileTap`。
- 当前没有弹框：`use-mobile-session-file-actions.ts:87-101` 按全局偏好直接路由：
  - `phone-browser` 或浮动工作区 → `openExternalLink(url)`（`Linking.openURL`）
  - 其它 → `browser.tabCreate` 在桌面 Orca 打开
- 偏好：`storage/preferences.ts:256-270`，`orca:terminalLinkOpenMode`，默认 `orca-browser`。
- 设置入口：`settings/browser-settings-screen.tsx`。

### 1.3 长按选区

- 长按 500ms 进入选区：`document/tap-dispatch.ts:64,167`。
- 选区状态与词种子：`document/selection-range.ts`
  - `seedWordSelection`：用 `getLineText()` 得到字符串，再用 `WORD_RE` 按 **字符串下标** 扩大选区。
  - `applyXtermSelection`：用 **cell 列** 调 `term.select(start.col, start.row, length)`。
- 中文/emoji 问题根因：
  - `getLineText()` 中一个 CJK 字符占 1 个字符串下标，但在 xterm 中占 2 个 cell 列。
  - 直接用 cell 列去索引字符串，长按点前面有中文时就会错位。
  - 链接/路径点击已经有 `document/cell-geometry.ts:29-43` 的 `cellColToStringIndex` 做校准；**选区路径没有使用它**。
- 选区覆盖层/手柄：`document/selection-overlay.ts`，端点用 `viewportToCell`；拖动本身是 cell 语义，问题集中在“长按种子”和“释放后的词吸附”。

---

## 2. 目标

1. 点击终端链接，弹出选择：
   - 在本机打开（手机浏览器）
   - 在远程打开（桌面 Orca 浏览器标签）
   - 复制链接
   - 取消
2. 长按中文/英文/emoji 混排文本时，选中位置与视觉一致，不错位。
3. 长按空白/标点时，智能选中附近的一个词或短语，而不是选空或选整行。
4. 选区手柄拖动仍然按 cell 边界工作，复制文本与高亮一致。
5. 不影响现有终端输入、滚动、OSC 链接、文件路径点击、选区复制/全选。

---

## 3. 方案

### 3.1 链接打开选择弹框

#### 入口与状态

- 在 `MobileSessionSheets.tsx` 增加 `TerminalLinkActionSheet`，状态放在 `use-mobile-session-screen-state.ts`：
  ```ts
  type TerminalLinkChoice = { handle: string; url: string }
  const [terminalLinkChoice, setTerminalLinkChoice] = useState<TerminalLinkChoice | null>(null)
  ```
- `handleTerminalOpenUrl` 不再直接打开，而是 `setTerminalLinkChoice({handle,url})`。
- 仅当当前 handle 仍是 active handle 时弹框（保持现有竞态保护）。

#### 弹框内容

- 复用 `components/ActionSheetModal.tsx`（已有 title/message/actions/destructive/hint/loading）。
- 动作：
  1. **在本机打开**
     - 调 `openExternalLink(url)`（`platform/external-link.ts`）。
  2. **在远程打开**（已被 7.1.2/8.x 取代）
     - 使用独立的背景创建路径（`activate:false`），不调用会抢焦点的 `handleCreateBrowser`；能力见 7.1.2。
  3. **复制链接**
     - `expo-clipboard` 的 `setStringAsync(url)`；成功后关闭。
  4. **取消**。
- 记住选择：
  - 弹框底部增加“记住我的选择”开关。
  - 开启后写入 `terminalLinkOpenMode`（复用现有 `saveTerminalLinkOpenMode`），后续直接按偏好打开。
  - 新键 `orca:terminalLinkOpenMode:v2` 默认 `ask`；旧键只作一次预选并迁移（见 7.1.4）。设置页增加“每次询问”。
- 只有一个可用动作时（例如远程不支持且用户未记住），仍然弹框但只显示可用动作；避免静默改变行为。

#### 远程打开的实现

- 复用 `browser.tabCreate`（已加入移动端方法 allowlist）。
- 不建议新增 `browser.openUrl`：`browser.openUrl` 目前不在 `runtime-rpc-mobile-method-allowlist.ts`，且 `browser.tabCreate` 已满足“在新标签打开”的需求。
- 若 URL 是 `file://` 或 OSC 文件链接，仍走现有 `onFileTap` / 文件预览路径，不进入本弹框。

#### 文案

- 标题：`打开链接`
- 描述：显示 URL 主机名（不是完整长 URL），降低钓鱼风险；点击可展开完整 URL。
- 动作：`在本机浏览器打开` / `在 Orca 远程浏览器打开` / `复制链接` / `取消`。

### 3.2 中文/宽字符选区校准

#### 核心：cell ↔ string 双向映射

在 `document/cell-geometry.ts` 增加：

```ts
export function stringIndexToCellCol(
  scope: TerminalDocumentScope,
  absRow: number,
  stringIndex: number
): number
```

实现要点：

- 遍历 buffer line 的 cell（`getCell(col,row)`），累计 `getChars().length`（或 `getWidth()` 对应的显示宽度），直到字符串下标覆盖目标。
- 宽字符 `getWidth() === 2`；组合字符/emoji 可能由多个 code point 组成，以 `getChars()` 的实际长度为准。
- 行尾空白/`translateToString(true)` 的处理要与 `getLineText` 保持一致。
- 对超出范围的下标做 clamp。

#### 长按种子流程（替换 `seedWordSelection`）

```text
touch → viewportToCell → (absRow, cellCol)
      → cellColToStringIndex(cellCol) → stringIndex
      → tokenizer(lineText, stringIndex, locale)
      → token 的 [startString, endString)
      → stringIndexToCellCol(start/end) → [startCol, endCol)
      → term.select(startCol, absRow, lengthCells)
```

#### 分词与“附近短语”

- 优先使用 `Intl.Segmenter({granularity:'word'})`：
  - WebView 较新（Chrome ≥ 87）可用；不可用时回退。
- 回退分词：
  - 拉丁/数字：`[A-Za-z0-9_]+`
  - CJK 连续段：`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`
  - 英文单词 + 中文混排按边界切分
  - 标点/空白为边界
- 选中规则：
  1. 命中的 token 长度 ≥ 1 且非纯标点 → 选 token。
  2. 命中空白/标点 → 在 ±8 cell 内找最近的 token；找不到则选最近的 1 个非空 cell。
  3. 命中单个 CJK 字符 → 尝试扩展到同一连续 CJK 段的 2-6 个字符，但不超过标点/空白边界；若段本身只有一个字符，则保持单字。
  4. 英文短词（1-2 字母）不额外扩展。
- 拖动端点：
  - 继续用 cell 边界；释放时对端点做一次词边界吸附（可配置），但不要改变已选中的中间文本。
- 多行/换行：
  - 选区长度按 cell 列计算；跨行时保持现有 `applyXtermSelection` 的行列算法，新增宽字符测试。
- 兼容：
  - 保持 `cancelSelect`、`selectAll`、copy、eviction、haptic、overlay 行为不变。

### 3.3 交互细节

- 长按 500ms、移动 10px 取消长按：保持现有手感。
- 长按后菜单仍为 Copy / Select All；可增加第三项“复制链接”仅当选区包含唯一 URL 时（可选，二期）。
- 选区手柄 44×44，保持在文本上方/下方，不遮挡行。
- 链接弹框出现时暂停终端输入焦点，关闭后恢复。

---

## 4. 平台与兼容

- iOS/Android 均使用 WebView；`Intl.Segmenter` 可用性按 WebView 版本判断，必须有回退。
- Android WebView 的字体缩放已由 `textZoom={100}` 固定；选区坐标仍以 xterm cell 为准。
- 超长行/折行：映射函数只处理当前 buffer line，折行由 xterm 的 row/col 语义处理。
- 性能：长按只处理一行，O(cols)；拖动时不做全量分词，只在释放时吸附。
- 无障碍：ActionSheet 使用现有组件，自动获得焦点/读屏行为；选区菜单保持现有 44px 触控尺寸。

---

## 5. 风险与备选

| 风险 | 处理 |
|---|---|
| `Intl.Segmenter` 不可用 | 使用正则/Unicode 范围回退；测试覆盖 |
| emoji/组合字符边界 | 以 xterm cell 的 `getChars()`/`getWidth()` 为准，不用 code unit 下标 |
| 选区跨行 + 宽字符 | 增加跨行测试；只在种子/端点吸附时映射，长度仍用 cell |
| 远程打开能力不可用 | 禁用远程动作 + hint；folder/floating 隐藏 |
| 用户已有全局偏好 | v2 键默认 `ask`；旧键只作一次预选并迁移 |
| 协议兼容 | 复用 `browser.tabCreate`，不新增移动端 RPC |

---

## 6. 验收标准

- 中文、英文、emoji、混排、折行文本长按，选中高亮与复制文本一致。
- 长按空白/标点时选中附近词/短语，不选空、不选整行。
- 链接弹框可选择本机/远程/复制/取消；远程不可用/离线/能力未知时禁用或隐藏并提示，不静默。
- “记住我的选择”生效，设置页可恢复“每次询问”。
- 现有终端测试、typecheck、lint 全绿；设备回归无异常。

---

## 7. 评审 01 修订与决策（2026-11-10）

> 本节吸收 `reviews/design-review-01.md`；与上文冲突时以本节为准。

### 7.1 产品决策

1. **默认行为**：所有用户首次点击链接都弹框（包括已有 `orca-browser`/`phone-browser` 偏好的老用户）。旧偏好作为弹框中的预选/高亮项，不再直接跳过弹框；弹框内“记住我的选择”后写入新语义。
2. **远程打开语义**：只在桌面 Orca 新建 browser tab，**手机停留终端**，不切换手机 tab；桌面 tab 在后台创建（不抢占桌面焦点）。
   - **新增独立** `handleCreateBackgroundBrowser`（或 `handleCreateBrowser({activate:false, focus:false})` 的专用分支）：显式传 `activate: false`，不设置 `pendingBrowserFocusPageIdRef`；不得修改现有 `handleCreateBrowser`（New Browser/HTML/file 仍 `activate:true`），并补这些调用方回归。
   - 新增 host 能力 `browser.tab-create-background.v1`（宿主广播）；仅在宿主 `canBrowse`/browser host 可用时与 `browser.screencast.v1` 一样条件性广播（不能静态广播）。手机仅在 client 在线、host status readable、该能力存在时启用远程动作。旧 host 无该能力：远程项**禁用** + “Update Orca on the host to open links here.”；folder/floating 才隐藏。
   - 能力未知/离线/创建中：禁用并提示；不要静默返回。
   - Folder/floating workspace：远程项隐藏；sheet 仍提供本机/复制/取消。OTA web shell 不在本期终端 sheet 范围。
3. **链接类型矩阵**：

   | 类型 | 行为 |
   |---|---|
   | 文本 HTTP/HTTPS | 弹框（本机/远程/复制/取消） |
   | OSC 8 HTTP/HTTPS | 弹框 |
   | OSC 8 file | 文件 tap（原有行为） |
   | `file://` | 文件 tap |
   | 裸文件路径/带行号路径 | 文件 tap |
   | `mailto:` | **非本期**；现有检测器不识别，保持 tap 行为，不新增 matcher |
   | 自定义 scheme | 非本期；保持现有/忽略，不弹框 |

4. **记住选择语义**：

   | 动作 | 写偏好 | 说明 |
   |---|---|---|
   | 在本机打开 | ✅ | 记住后后续直接本机打开 |
   | 在桌面 Orca 打开 | ✅ | 记住后后续直接远程打开 |
   | 复制链接 | ❌ | 不写偏好、不改变 ask 模式；sheet 复制后关闭 |
   | 取消 | ❌ | 不写偏好 |
   | 远程项隐藏/不可用 | ❌ | 本次不写偏好；已有非 ask 值保持不变（host 恢复后仍直开） |

   - 偏好写失败：toast 提示，本次动作仍执行，下次仍弹框。
   - 偏好全局（按设备），不按 host/workspace 分；本期不做 per-host。
   - **版本化键**：新键 `orca:terminalLinkOpenMode:v2`（`ask|phone-browser|orca-browser`），初始 state 为 `ask`。旧键 `orca:terminalLinkOpenMode` **在第一次 sheet 打开时**读取（不要在 focus loader 提前消费）：把值作为第一次 sheet 的预选高亮，不自动执行、不预开 Remember。迁移规则：**仅当 v2 不存在**时写 `ask` 到 v2；v2 已存在则保持用户值，只删除旧键。第二次打开不再预选。`use-mobile-session-preference-focus.ts` 只加载 v2；旧键迁移由第一次 sheet 入口执行。新 Remember 只写 v2。
   - **开关表**：Remember off → 任何动作都不写；on + 本机/远程 → 写 v2；on + Copy/Cancel → 不写；写失败 → toast，动作仍执行。
   - 预选高亮：仅给对应动作加 selected 样式/无障碍 state，不改变默认焦点；Remember 默认 off。
   - **记住值直开前必须重新过能力/工作区门禁**：`mode !== ask` 时，只有当首选动作在**当前** client/statusReadable/capability/creating/workspace 条件下仍可用，才直接执行；否则不调用 create/open，显示 sheet（远程禁用/隐藏 + hint）。不自动降级存储值（host 恢复后仍可用）。本机首选也需 URL scheme 可打开；否则回落 sheet。
   - 用例：stored `orca-browser` + 旧 host/离线/未知/creating/folder/floating；断言无 `browser.tabCreate`、active tab 仍终端、sheet/hint 正确。
5. **URL 展示**：
   - 摘要显示 scheme + host + port（**隐藏 userinfo**）；展开完整 URL 时保留 userinfo，但先过滤 bidi/控制字符。摘要与展开分别测试。
   - `http://` 显示明文警告。
   - `localhost`/`127.0.0.1`/私网地址：提示“在本机浏览器打开通常不可达；远程打开指向桌面”。
   - 过滤 bidi/控制字符后再展示；完整 URL 展开也做同样处理。
6. **附近词/短语规则**（钉死）：
   - 命中标点/空白时，先 `snapToGlyphStart`，再在 ±8 cell 内选择**边缘距离**最近的 token；距离 = tap cell 与 token span 之间相隔的空 cell 数（命中 token 内为 0）；相同优先左侧。
   - 例：`修复，登录流程` 点 `，` → 左侧“修复”（隔着 0 个空 cell，右侧“登录流程”隔 1）；`验证 权限边界 & token` 点 `&` → 左侧“权限边界”（两侧各隔 1，平局左）。
   - 相邻、无空隙的 CJK 字符先合并为连续 CJK run；**不依赖 Segmenter token 边界**，保证 Chrome 74 回退与现代表现一致。
   - run ≤5 字：选整段。run >5 字：取 5 字窗口，`start = clamp(tapCharIndex, runStart, runEnd-5)`，`[start, start+5)`。
     - 点击在左侧标点/空白：取 run 末尾 5 字；点击在右侧：取 run 开头 5 字。
   - 例：`中华人民共和国万岁` 点“人”（index2）→ `人民共和国`；点“国”（index6）→ `共和国万岁`。7 字 run `春夏秋冬风花雪` 点“风”（index4）→ `秋冬风花雪`。
   - 无任何 token 时：仅当命中 cell 是非空白 glyph，选中该完整 glyph（宽字符 2 cells）；空白/行尾空白**不建立选区**。
   - 原型中“，”选右侧示例按此规则改为左侧；原型以本规则为准。
7. **折行/缩放**：
   - v1 只处理当前 buffer line；跨 wrap 的整词合并为非目标；手动拖动可以跨行。
   - Pinch 会 `cancelSelect`（现有行为），不要求缩放后保留选区；旋转/refit 后状态一致即可。
   - 横向 pan 仅在内容宽于 viewport 时发生；测试按实际可达状态写。
8. **手柄释放吸附**：本期不做释放时词边界吸附，避免改变复制文本；拖动仍按 cell。
9. **语言**：实现使用英文 UI（与现有移动端一致）；原型中文仅作沟通，不作为实现依据。
10. **WebView 支持**：终端文档 target 为 Chrome 74；`Intl.Segmenter` 不存在是必走路径，必须有回退并测试。`\p{Script=...}` Chrome 64+ 可用。
    - 固定 `new Intl.Segmenter('zh', { granularity: 'word' })`，模块内缓存实例；测试提供 `resetTokenizerForTests()`/注入点，确保删除 Segmenter 后真的走回退。
    - 回退与 Segmenter 都经过同一 post-merge（见 7.2.3），不依赖设备 locale。

### 7.2 几何与选区模型（BLOCKER 修复）

1. **宽字符右半格归一化**：
   - 流程增加 `snapToGlyphStart(absRow, cellCol)`：仅当 `getWidth() === 0` 且 `col > 0 && getCell(col-1).getWidth() === 2` 时，向左找到同一 glyph 的起始 cell；**不要**用 `getChars() === ''` 判空白（xterm 空白 cell 可能 chars 为空但 width=1）。
   - `snapToGlyphEnd(absRow, cellCol)`：glyph 起点 → 起点+width；continuation → 先 `snapToGlyphStart` 再加 width；空白 → +1；行尾 clamp 到 cols。单测覆盖四类。
   - 例：`中文abc`，中 0-1、文 2-3、a 4；点 cell 3 → snap 到 2 → string index 1（“文”），选中“文/中文”，不再落到 `abc`。
   - 单测覆盖“宽字符两个半格”“emoji 两个半格”。
2. **选区坐标统一为 end-exclusive**：
   ```ts
   type SelectionSpan = {
     start: { row: number; col: number }       // first cell
     endExclusive: { row: number; col: number } // one past last cell
   }
   ```
   - `applyXtermSelection` 用 `endExclusive - start` 计算 cell 长度，不再使用 `end.col - start.col + 1`：
     ```ts
     const length = end.row === start.row
       ? end.col - start.col
       : (cols - start.col) + (end.row - start.row - 1) * cols + end.col
     ```
   - **所有 producer 必须同时改**（TL-S3 合并 seed/model/drag/selectAll/eviction）：
     - seed：先算 token coverage `[start,endExclusive)`，再存 anchor=首 glyph 起始 cell、focus=最后一个被包含 glyph 起始 cell；
     - **两个手柄都只存 glyph 起始 cell 锚点**（end 手柄也存 `snapToGlyphStart(tapCell)`，不存 exclusive 边界）；
     - 计算 span 时排序两个锚点：`start=snapToGlyphStart(lower)`，`endExclusive=snapToGlyphEnd(upper)`；交叉时交换锚点并反转手柄角色；**拖拽中相等时保留被拖锚点并渲染单 glyph，不得 cancel/清空**；只有释放且两锚点相等时才清空。不得把 exclusive 边界与 cell 锚点混用或传给 `term.select` 造成负长度。
     - 例：`abcdef` 选中 `bc`（锚点 1/2），拖 start 到 f（cell5）→ 排序 2/5 → `[2,6)`、`term.select(2,row,4)`、复制 `cdef`；选中 `bcd`（1/3）拖 end 到 a（0）→ 排序 0/1 → `[0,2)`、`term.select(0,row,2)`、复制 `ab`。
     - 宽字符位于被越过的一侧：`中文abc` 选中 `文a`（锚点2/4），拖 start 到 c（6）→ 排序4/6 → `[4,7)`、`term.select(4,row,3)`、复制 `abc`。
     - 固定上锚点为宽字符：同选区拖 end 到 cell0（中）→ 排序0/2 → `[0,4)`、`term.select(0,row,4)`、复制 `中文`。
     - **存储模型固定为 `{anchor, focus}` 两个 glyph 起始 cell 锚点**；`SelectionSpan` 只是派生值，不存 exclusive 边界。
     - seed：end 锚点取“最后一个被包含 glyph 的起始 cell”，不是 token 的 endExclusive。
     - `selectAll`：anchor=(0,0)，focus=`snapToGlyphStart(cols-1,lastRow)`；派生 endExclusive 自然到 cols（行尾宽字符取起始 cell）。
     - eviction：anchor/focus 行同时调整；选区被挤出时清除；`document-scope.ts` 类型改成 anchor/focus。
     - 测试先断言 seed 后 anchor/focus，再拖动；不能只从 1/2 等锚点直接开始。
   - `repositionOverlay` 末端手柄放在 `endExclusive`；若 `endExclusive.col === cols`，视觉 x clamp 到 viewport 右边缘（不要用 continuation cell 的 `getWidth()===0` 算宽），selection model 仍保留 end-exclusive。
   - 测试必须断言 `term.select` 参数、selection model、拖拽/selectAll/eviction/多行/行尾，不只断言 seed 或 `getSelection()`。
3. **UTF-16 下标统一**：`getChars().length`、`lineText.length`、`Intl.Segmenter` index 都用 code unit；cell 与 string 两个游标分别按 `+= getChars().length` / `+= max(1, getWidth())` 前进。
   - token span 是 `[startString, endString)`；`stringIndexToCellCol(startString)` 取 glyph 起始 cell，`stringIndexToCellCol(endString)` 取下一 glyph 起始 cell（或行尾/裁剪后的 endExclusive cell），保证 end > start。
   - 行文本与 `translateToString(true)` 的裁剪保持一致；尾部空格 token 不入选区。
4. **Token 原子性与 post-merge**：
   - 先标记原子 span：现有 URL/路径正则；emoji/ZWJ/组合字符按 grapheme；全角字母数字 `[Ａ-Ｚａ-ｚ０-９]` 与 ASCII 同类组成一个 token。
   - Segmenter 与回退分词都产出 base token，然后统一 post-merge：
     1. 两个 token 之间只隔 `WORD_RE` 的 `._/:@~+=?&#%-`，且两侧 token 均含字母/数字 → 合并；
     2. 紧随字母/数字 token、无空白的 `+`/`#`/`%` 后缀 token **迭代**吸附到前一个 token（支持 `C++`、`100%`、`C#`）；
     3. 只裁剪句末标点（`。，、；：！？` 等），**不要**裁剪 join 集合 `._/:@~+=?&#%-`；
     4. URL/路径原子 span 不再拆/不再合并。
   - 这样保留 `foo-bar`、`key=value`、`a@b.com`、`C++`、`100%`、`a#b`，且 Chrome 74 回退能产出 `ＡＢＣ１２３` 单 token。
   - 加 Segmenter 存在/删除两套相同向量。

### 7.3 链接弹框承载

- 新建 `TerminalLinkActionSheet`（基于 `BottomDrawer` 或给 `ActionSheetModal` 增加受控 footer/children），包含：
  - scheme+host+port 摘要；展开/收起完整 URL；
  - 本机/远程/复制/取消；
  - “记住我的选择”开关；
  - 远程不可用 hint；
  - 无障碍标签/状态。
- 打开前先 `Keyboard.dismiss`/blur 终端输入，复用 `openSessionTabActionSheetAfterKeyboardDismiss` 模式；记录打开前键盘状态，关闭后**恢复**：打开前有键盘则重新聚焦并打开，没有则保持收起（取消/复制/远程动作一致）。补两种前置状态测试。
- 复制使用现有 `useClipboardWriter`/`platform/clipboard.ts` seam，不新增第二套 clipboard 实现。
- `handleTerminalOpenUrl` 只负责设置 pending choice；动作执行时再次校验 `handle === activeHandleRef.current`；增加 `choiceConsumed`/in-flight guard 防重复。
- 远程选项判断 client 在线/可调用 `browser.tabCreate`；创建中/未知/离线禁用并提示。
- 失败态：本机打开失败 toast/haptic；复制失败 toast；远程创建失败 toast；client 为空/创建中不静默。

### 7.4 测试修订

- 增加 AC→用例映射；几何/分词/选区单元测试写清：
  - 输入行、tap cell、期望 start/endExclusive、期望 `term.select` 参数、期望复制文本。
- 使用 width-aware fake buffer（每 cell 有 `getChars()`/`getWidth()`，`translateToString` 按 width 跳过宽字符第二格）或真实 `BufferLine`。
- 覆盖：
  - 宽字符左右半格、emoji 左右半格、组合字符（NFC/NFD）、全角字符、行尾宽字符、折行。
  - `Intl.Segmenter` 存在/缺失/构造抛错三态；Chrome 74 回退。
  - URL/路径长按复制回归；OSC 8 HTTP/file、file://、裸路径矩阵。
  - 弹框后切 tab、快速双击、active handle 变化。
  - 本机打开失败、复制失败、远程 client 空/创建中/离线/未知能力。
  - Folder workspace/OTA；键盘打开/关闭；读屏/开关状态。
  - Pinch 取消选区、旋转/refit 后状态、横向 pan 可达性。
- 删除/修正与现有实现冲突的断言（例如“缩放后选区保留”）。

### 7.5 任务调整

| ID | 任务 | 依赖 |
|---|---|---|
| TL-T1A | 先加 `ask` 分支，再改默认；旧偏好迁移为预选 | — |
| TL-T3A | 动作执行时复核 active handle + in-flight/consumed guard | TL-T3 |
| TL-T6A | 偏好写失败 toast；copy/cancel 不写偏好 | TL-T6 |
| TL-T7A | 键盘 dismiss/reopen 流程 | TL-T3 |
| TL-T8 | `snapToGlyphStart` + width-aware 几何测试 | TL-S1 |
| TL-T9 | end-exclusive SelectionSpan 全链路改造 | TL-S3 |
| TL-T10 | 远程打开不切换手机 tab；能力判断改为 client/可调用 | TL-T4 |
| TL-T11 | URL 摘要/展开/HTTP/loopback/bidi 处理 | TL-T2 |
| TL-T12 | 失败态/离线/未知能力/创建中 | TL-T3 |
| TL-T13 | URL/路径长按复制回归 | TL-S2 |
| TL-T14 | 选择模型/overlay/手柄测试 | TL-S5 |
| TL-T15 | Folder workspace/OTA/键盘/读屏用例 | 全部 |

### 7.6 原型修订

- 英文实现文案；删除设计未覆盖的 prefbar/撤销/链接样式，或标注非本期。
- 修正“松开前不显示选区”：500ms 即显示 overlay。
- 补 emoji/组合字符/折行/手柄拖动/复制一致性状态。
- 原型可按共享 `design/ui-prototypes/` 组织，但需在 feature 的 `ui/` 说明/链接；G2 产物可追溯。
- 远程打开状态改为“桌面打开、手机留守”；能力受限/离线/创建中状态。
