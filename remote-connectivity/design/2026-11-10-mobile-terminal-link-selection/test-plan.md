# 移动端终端：测试方案

> 对应设计：`design.md`
> 目标：证明链接选择弹框、本机/远程打开、CJK/宽字符选区校准、附近词/短语吸附在真实设备上可用，且不回归终端输入/滚动/复制。

---

## 1. 测试环境

| 环境                                  | 用途                                         |
| ------------------------------------- | -------------------------------------------- |
| Vitest（mobile）                      | 选区几何、分词、选项状态机、组件测试         |
| TypeScript / oxlint                   | 类型与静态检查                               |
| Android 模拟器/真机（adb）            | 长按选区、手柄拖动、链接弹框、系统浏览器     |
| iOS 模拟器（如可用）                  | 同上                                         |
| 配对的桌面 Orca                       | `browser.tabCreate` 远程打开（手机留守终端） |
| client 离线/creating/能力未知/旧 host | 远程项禁用 + hint；folder/floating 隐藏      |

---

## 2. 用例

### A. 链接打开选择

| ID     | 场景                              | 预期                                                                                                            |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| TL-A1  | 点击 HTTP/HTTPS 链接              | 弹出操作面板：本机/远程/复制/取消                                                                               |
| TL-A2  | 选择“本机打开”                    | 手机系统浏览器打开，URL 完整                                                                                    |
| TL-A3  | 选择“远程打开”                    | 桌面 Orca 新标签打开；手机停留终端                                                                              |
| TL-A4  | 远程能力不可用/未知/离线/creating | 禁用远程项并显示 hint；不静默                                                                                   |
| TL-A5  | Folder workspace                  | 远程项隐藏；本机/复制/取消仍可用                                                                                |
| TL-A6  | 复制链接                          | 剪贴板内容与链接一致                                                                                            |
| TL-A7  | 取消                              | 不打开任何页面，焦点回到终端                                                                                    |
| TL-A8  | “记住我的选择”开启                | 后续点击直接按所选方式打开                                                                                      |
| TL-A9  | 设置页改回“每次询问”              | 再次弹框                                                                                                        |
| TL-A10 | 链接类型矩阵                      | OSC8 http → sheet；OSC8 file/file:// /裸路径 → file tap；mailto 非目标/保持 tap；自定义 scheme 非目标（见 5.2） |
| TL-A11 | 快速连点/弹框打开时切换标签       | 动作时复核 handle；不重复打开；切 tab 关闭 sheet                                                                |

### B. 中文/宽字符选区

| ID     | 场景                               | 预期                                                          |
| ------ | ---------------------------------- | ------------------------------------------------------------- |
| TL-B1  | `中文abc`，长按“中”                | 选中“中”或“中文”短语，不是错位字符                            |
| TL-B2  | `中文abc`，长按“a”                 | 选中 `abc`，不包含中文                                        |
| TL-B3  | `中文😀English`，长按 emoji 后英文 | 英文选区起点正确                                              |
| TL-B4  | 行首多个中文后再长按               | 无列偏移                                                      |
| TL-B5  | 中英混排 + 标点                    | 词边界正确，不跨标点                                          |
| TL-B6  | 长按空白/标点                      | 选中附近词；不选空/整行                                       |
| TL-B7  | 单个 CJK 字符                      | 扩展到最多 5 字短语（有边界；>5 时 5 字窗口）                 |
| TL-B8  | 折行/多行选择                      | 跨行文本复制正确                                              |
| TL-B9  | 全角标点/制表符                    | 选区与视觉一致                                                |
| TL-B10 | 组合字符/ZWJ emoji                 | 不拆断 code point                                             |
| TL-B11 | 手柄拖动                           | 端点按 cell 边界；复制文本与高亮一致                          |
| TL-B12 | 缓冲挤出                           | 仍显示“Selection cleared”，不崩溃                             |
| TL-B13 | 长文本横向滚动                     | 仅在内容宽于 viewport 时可 pan；选区坐标随 pan 正确           |
| TL-B14 | Pinch/旋转                         | pinch 取消选区（现有行为）；旋转/refit 后状态一致，不要求保留 |
| TL-B15 | 复制后粘贴                         | 文本完整、无多余空白                                          |

### C. 回归

| ID    | 场景                       | 预期                 |
| ----- | -------------------------- | -------------------- |
| TL-R1 | 终端输入/快捷键/软键盘     | 不变                 |
| TL-R2 | 滚动/回滚/边缘滚动         | 不变                 |
| TL-R3 | OSC link / 文件路径点击    | 不变                 |
| TL-R4 | 选区复制/全选/Copy 菜单    | 不变                 |
| TL-R5 | 会话切换/重连/WebView 重载 | 不崩溃；选区状态合理 |

---

## 3. 选区测试向量

```text
中文abc
中文 😀 English
前缀中文: https://example.com/path?q=中文
abc中文def
你好，世界！Hello.
全角：ＡＢＣ１２３
emoji: 👨‍👩‍👧‍👦 family
组合: é café
折行: 0123456789...（超过 cols）
制表: \t中文\tABC
```

每个向量记录：长按 cell、期望选中的字符串、实际复制字符串、截图。

---

## 4. 执行与报告

```bash
pnpm --dir mobile test
pnpm --dir mobile typecheck
pnpm --dir mobile lint
pnpm tc
adb exec-out screencap -p > evidence/terminal-selection.png
adb shell input swipe ...   # 长按/拖动
```

报告模板见 `../../DEVELOPMENT_PROCESS.md` 第 6 节；每条用例记录步骤、预期、实际、证据路径。

---

## 5. 评审 01 修订（2026-11-10）

### 5.1 AC → 用例映射

| 验收标准                                        | 用例                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| AC1 点击 HTTP/HTTPS 弹框（本机/远程/复制/取消） | TL-A1..A33；TL-L1..L7                                                                  |
| AC2 中文/英文/emoji/混排/折行长按不错位         | TL-B1..B20；G1..G30（含 G22a–G22e 与 Segmenter 两态）                                  |
| AC3 长按空白/标点选附近短语                     | TL-B6/B7；G9..G11、G25..G30                                                            |
| AC4 高亮与复制一致、手柄按 cell                 | TL-B11/B15/B17/B17a/B17b/B17c；selection-range/overlay 拖拽、交叉、selectAll、eviction |
| AC5 不影响输入/滚动/OSC/路径/复制/全选          | TL-R1..R8、R9（clipboard seam）                                                        |
| 非目标：远程打开手机留守                        | A3、A12、A15                                                                           |
| 非目标：旧 WebView 回退                         | G19..G22（Segmenter 三态/回退）                                                        |

### 5.2 链接路由矩阵

| ID    | 输入                                  | 期望                                                                              |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------- |
| TL-A1 | 文本 `https://example.com`            | `open-url` → sheet                                                                |
| TL-L1 | OSC 8 HTTP(S)                         | `open-url` → sheet                                                                |
| TL-L2 | OSC 8 `file://`                       | `file-tap`，无 sheet                                                              |
| TL-L3 | 文本 `file:///tmp/a.txt`              | `file-tap`                                                                        |
| TL-L4 | 裸路径/带行号路径                     | `file-tap`                                                                        |
| TL-L5 | `mailto:a@b.com`                      | 非目标；现有检测器不识别，保持 tap 行为                                           |
| TL-L6 | 自定义 scheme                         | 非目标；保持现有/忽略，不弹 sheet                                                 |
| TL-L7 | 浮动 workspace / fenced code 中的 URL | 浮动 workspace：sheet 显示本机/复制/取消，远程隐藏；fenced code URL 仍 `open-url` |

### 5.3 几何与选区单元测试（BLOCKER 1/2）

测试 buffer 必须 width-aware：每 cell 有 `getChars()`/`getWidth()`，`translateToString` 按 width 跳过宽字符第二格；或直接使用 xterm `BufferLine`。行宽 ≥ 向量长度。

| ID  | 行文本（列布局）                                            | tap cell             | 期望 start | 期望 endExclusive | `term.select` | 期望复制                          |
| --- | ----------------------------------------------------------- | -------------------- | ---------- | ----------------- | ------------- | --------------------------------- |
| G1  | `中文abc`（中0-1 文2-3 a4 b5 c6）                           | 0                    | 0          | 4                 | `(0,row,4)`   | `中文`                            |
| G2  | 同上                                                        | 1（中右半）          | 0          | 4                 | `(0,row,4)`   | `中文`                            |
| G3  | 同上                                                        | 3（文右半）          | 0          | 4                 | `(0,row,4)`   | `中文`                            |
| G4  | 同上                                                        | 4（a）               | 4          | 7                 | `(4,row,3)`   | `abc`                             |
| G5  | `中文😀English`（😀4-5，E6..h12）                           | 5（emoji右半）       | 4          | 6                 | `(4,row,2)`   | `😀`                              |
| G6  | 同上                                                        | 6（E）               | 6          | 13                | `(6,row,7)`   | `English`                         |
| G7  | `中文 abc`（sp4 a5..c7）                                    | 4（空格）            | 0          | 4                 | `(0,row,4)`   | `中文`（平局左）                  |
| G8  | `中文 abc`                                                  | 5（a）               | 5          | 8                 | `(5,row,3)`   | `abc`                             |
| G9  | `修复，登录流程`（，4-5 登6..程13）                         | 4/5                  | 0          | 4                 | `(0,row,4)`   | `修复`（左 gap 0，右 gap 1）      |
| G10 | 同上                                                        | 6（登）              | 6          | 14                | `(6,row,8)`   | `登录流程`（合并 Segmenter 切分） |
| G11 | `验证 权限边界 & token`（权5..界12 sp13 &14 sp15 t16..n20） | 14（`&`）            | 5          | 13                | `(5,row,8)`   | `权限边界`（两侧 gap 1，平局左）  |
| G12 | `https://example.com/path?q=中文`                           | 任意 URL cell        | 0          | 31                | `(0,row,31)`  | 完整 URL                          |
| G13 | `src/main.ts:42`                                            | 行内任意             | 0          | 14                | `(0,row,14)`  | 完整路径                          |
| G14 | `éx`（NFD）                                                 | 0                    | 0          | 1                 | `(0,row,1)`   | `é`                               |
| G15 | `ＡＢＣ１２３`（每字 2 cells）                              | 3（Ｂ右半）          | 0          | 12                | `(0,row,12)`  | 全角串                            |
| G16 | 折行：cols=10，`abcdefghijKLMNOP`                           | 第二行 K             | 第二行 0   | 第二行 6          | `(0,row2,6)`  | `KLMNOP`（v1 只当前行）           |
| G17 | `abcd中`（cols=6，中4-5）                                   | 5（中右半）          | 4          | 6                 | `(4,row,2)`   | `中`                              |
| G18 | `abcd中`（cols=5，中放不下折到下一行）                      | row2 cell1（中右半） | row2 0     | row2 2            | `(0,row2,2)`  | `中`                              |

> G18 断言按 xterm 实际换行布局：宽字符整字折到下一行；若实现观察不同，先记录 buffer 再调整预期。

补充断言：

- 每次同时断言 `term.select` 参数、selection model（`start`/`endExclusive`）和 `term.getSelection()`；不能只断言复制文本。
- `snapToGlyphStart` 单测：右半格 → 左半格；孤立 continuation/空 cell 不越界。
- `stringIndexToCellCol` 单测：UTF-16 code unit、宽字符、组合字符、clamp。

### 5.4 分词与 Segmenter

| ID   | 场景                                               | 期望                                                                                                   |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| G19  | Segmenter 存在（固定 `zh`、缓存）                  | `登录流程` 合并为一个候选；G1..G29（含 G22a–G22e）结果与回退一致（CJK 用 5 字窗口，不依赖 token 边界） |
| G20  | 删除 `Intl.Segmenter` + `resetTokenizerForTests()` | 回退分词；G1..G29 全向量结果不变，尤其 G15/G22..G22e/G26..G28                                          |
| G21  | 构造抛错/`segment` 抛错 + reset                    | 捕获并回退，不崩溃；结果与 G20 相同                                                                    |
| G22  | `foo-bar`                                          | start 0,endExclusive 7,select(0,row,7),copy `foo-bar`（两态）                                          |
| G22a | `key=value`                                        | start 0,endExclusive 9,select(0,row,9),copy `key=value`                                                |
| G22b | `a@b.com`                                          | start 0,endExclusive 7,select(0,row,7),copy `a@b.com`                                                  |
| G22c | `C++`                                              | start 0,endExclusive 3,select(0,row,3),copy `C++`（后缀迭代吸附）                                      |
| G22d | `100%`                                             | start 0,endExclusive 4,select(0,row,4),copy `100%`                                                     |
| G22e | `a#b`                                              | start 0,endExclusive 3,select(0,row,3),copy `a#b`                                                      |
| G23  | `👨‍👩‍👧‍👦 family`                                        | ZWJ family 为一个 grapheme token；复制完整                                                             |
| G24  | 全角标点/制表符                                    | 作为边界；附近词规则正确                                                                               |
| G25  | 长 token 与 ±8 窗口重叠                            | 窗口按 token span 边缘计算，长 token 仍可命中                                                          |
| G26  | `中华人民共和国万岁`，tap cell 4（人）             | start 4,endExclusive 14,select(4,row,10),copy `人民共和国`                                             |
| G27  | 同上 tap cell 12（国）                             | start 8,endExclusive 18,select(8,row,10),copy `共和国万岁`                                             |
| G28  | 7 字 run `春夏秋冬风花雪`，tap cell 8（风）        | start 4,endExclusive 14,select(4,row,10),copy `秋冬风花雪`                                             |
| G29  | 空白 cell（行尾/中间空格）                         | `snapToGlyphStart` 不左移；空格仍是边界；B20 不选空                                                    |
| G30  | 行内孤立非空白 glyph（如四周 >±8 无 token 的 `&`） | 选中该 glyph：start 原位、endExclusive + width、copy `&`                                               |

### 5.5 链接弹框组件/状态

| ID   | 场景                                                        | 期望                                                                                                                |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A12  | 远程打开                                                    | `browser.tabCreate` 参数含 `activate:false`；无 pending ref；**应用 caller 投影后 active tab 仍是终端**；重连仍不切 |
| A13  | client 为空                                                 | 远程项禁用 + hint；不静默返回                                                                                       |
| A14  | `creatingBrowser`                                           | 远程项禁用/loading；不重复创建                                                                                      |
| A15  | 能力未知/离线/旧 host 无 `browser.tab-create-background.v1` | 远程项**禁用** + “Update Orca on the host to open links here.”；folder/floating 才隐藏                              |
| A16  | 弹框后切 terminal tab                                       | 关闭/清空 sheet；动作不执行                                                                                         |
| A17  | 快速双击动作                                                | 只执行一次（consumed/in-flight）                                                                                    |
| A18  | Remember off + 本机/远程；on + Copy/Cancel                  | 均不写 v2；下次按原状态                                                                                             |
| A19  | 偏好写失败                                                  | toast；本次动作仍执行；下次仍弹框                                                                                   |
| A20  | 旧偏好 `orca-browser`/`phone-browser`                       | 第一次只作预选高亮；不自动执行；Remember 默认 off；v2 不存在时首次后迁移 v2=ask 并删旧键，第二次无预选              |
| A20b | 已先写 v2（设置页选 Preview/Orca）再第一次打开 sheet        | 迁移只删旧键，不覆盖 v2；用户值保持                                                                                 |
| A21  | 初始 state 加载竞态                                         | 加载完成前按 `ask`，不误直开                                                                                        |
| A22  | URL 摘要/展开                                               | 摘要 scheme+host+port 且隐藏 userinfo；展开完整 URL 保留 userinfo，但过滤 bidi/控制字符                             |
| A23  | `http://`                                                   | 明文警告                                                                                                            |
| A24  | `localhost`/`127.0.0.1`/私网                                | “usually not reachable from this phone; desktop open uses desktop Orca browser”；SSH 会话注明远程主机               |
| A25  | 键盘打开/关闭时点链接                                       | 先 dismiss 再开 sheet；关闭后恢复打开前状态（有键盘则重开，无则保持收起）                                           |
| A26  | 读屏                                                        | actions/开关/展开有 label/state；可操作                                                                             |
| A27  | Folder workspace                                            | 远程项隐藏/提示；sheet 仍可本机/复制/取消                                                                           |
| A28  | OTA web shell                                               | 明确非目标/提示，不崩溃                                                                                             |
| A29  | 本机打开/复制/远程创建失败                                  | toast/haptic；按钮可重试                                                                                            |
| A30  | stored `orca-browser` + 旧 host/离线/未知/creating          | 不直开、不调用 `browser.tabCreate`；显示 sheet + 远程禁用/hint；active tab 仍终端                                   |
| A31  | stored `orca-browser` + folder/floating                     | 不直开；sheet 远程隐藏；本机/复制/取消可用                                                                          |
| A32  | stored `phone-browser` + 本地可打开                         | 直接本机打开，不弹 sheet                                                                                            |
| A30b | stored `orca-browser` 不可用后恢复                          | 不可用时走 sheet 且存储值仍为 `orca-browser`；能力恢复后下一次点击直接远程打开、不再弹 sheet                        |
| A33  | New Browser / HTML/file 既有调用方回归                      | 仍 `activate:true` 且设置 `pendingBrowserFocusPageIdRef`，行为不变                                                  |

### 5.6 选区/交互设备用例修正

| ID    | 场景                                   | 期望                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B13   | 横向 pan                               | 仅在内容宽于 viewport 时可 pan；选区坐标随 pan 正确                                                                                                                                                                                                      |
| B14   | pinch 缩放                             | 选区取消（现有行为）；不要求保留                                                                                                                                                                                                                         |
| B16   | 旋转/refit                             | 状态一致，不崩溃；选区可被清除                                                                                                                                                                                                                           |
| B17   | 手柄拖到宽字符右半格（start/end 两端） | start→glyph 起点；end→glyph 起点+width；复制/高亮/model 一致                                                                                                                                                                                             |
| B17a  | Select All / 多行 end=cols             | `selectAll` endExclusive=(cols,lastRow)；无 off-by-one                                                                                                                                                                                                   |
| B17b  | 手柄交叉（经过相等点）                 | `abcdef` 选 `bc`（锚点1/2），start 1→2→5 → `[2,6)`、select(2,row,4)、copy `cdef`；`bcd`（1/3），end 3→1→0 → `[0,2)`、select(0,row,2)、copy `ab`；`中文abc` 选 `文a`（2/4），start 2→4→6 → `[4,7)`、select(4,row,3)、copy `abc`；拖拽经过相等点时选区存活 |
| B17b2 | 固定上锚点为宽字符                     | `中文abc` 选 `文a`（2/4），end 拖到 cell0（中）→ 排序0/2、`[0,4)`、select(0,row,4)、copy `中文`                                                                                                                                                          |
| B17d  | 释放于相等点                           | start/end 同 cell 释放 → 清空选区/隐藏 overlay；拖拽中同点不只清空                                                                                                                                                                                       |
| B17e  | seed 后存储锚点                        | 长按 seed `bc`/`bcd`/`文a` 后先断言 `scope.sel.anchor/focus` 为 glyph 起始 cell（1/2、1/3、2/4），再执行 B17b/B17b2 拖动                                                                                                                                 |
| B17f  | `snapToGlyphEnd` 矩阵                  | 宽字符起点→+2；右半格→起点+2；空白→+1；行尾→clamp cols                                                                                                                                                                                                   |
| B17c  | eviction                               | 选区仍在 buffer：行号平移、文本不变、endExclusive 保持；最旧行被挤出：model 清空、overlay 隐藏、selection-evicted                                                                                                                                        |
| B18   | 快速长按/滚动                          | 500ms 显示 overlay 和 Copy/Select All 菜单；滚动取消长按                                                                                                                                                                                                 |
| B19   | 放大字体/Android textZoom              | 坐标仍按 cell；触点准确                                                                                                                                                                                                                                  |
| B20   | 空行/全空白行/行中空格（无邻近 token） | 不建立选区，Copy 禁用；glyph fallback 只用于非空白 cell                                                                                                                                                                                                  |
| B20a  | 行中空格且两侧有 token                 | 按 G7 选最近 token（平局左），仍建立选区                                                                                                                                                                                                                 |

### 5.7 回归具体化

| ID  | 命令/文件                                                 | 断言                                |
| --- | --------------------------------------------------------- | ----------------------------------- |
| R6  | 新增 width-aware `text-tokenizer`/`selection-range` 测试  | URL/路径长按复制整段不变            |
| R7  | 新增 `selection-range`/`selection-overlay` 测试           | Copy/Select All/eviction/model 一致 |
| R8  | `url-tap`/`path-tap`/`surface-tap` 测试（若不存在则新增） | 路由矩阵与优先级不变                |
| R9  | `useClipboardWriter`/`platform/clipboard` 回归            | 复制链接走现有 seam，无第二套实现   |
| R10 | `pnpm --dir mobile test`、`typecheck`、`lint`、`pnpm tc`  | 全绿                                |

### 5.8 设备证据

- 记录 Android/iOS 版本、WebView/Chrome 版本（`chrome://version` 或 UA）。
- 旧 WebView（Chrome 74 或可模拟环境）至少跑 G1/G3/G5/G9/G11/G20。
- 截图/录屏：长按宽字符右半格、点标点选附近词、链接 sheet、复制后粘贴、手柄拖动、远程打开后手机仍停留终端。
- 证据路径写入 `test-reports/`，逐条对应用例 ID。
