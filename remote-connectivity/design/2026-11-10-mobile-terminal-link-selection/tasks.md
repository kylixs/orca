# 移动端终端：任务拆分

> 状态：设计 review-06 APPROVED_WITH_MINORS（0/0/5，MINOR 已处理，2026-11-10）

## 1. 链接选择

> 旧 §1–§4 表已被 §5 取代；TL-S4 行作废（职责并入 TL-S5），仅保留历史参考。

| ID | 任务 | 文件/模块 | 依赖 | 优先级 |
|---|---|---|---|---|
| TL-T1 | 偏好新增 `ask` 模式；设置页增加“每次询问” | `mobile/src/storage/preferences.ts`、`settings/browser-settings-screen.tsx` | — | P1 |
| TL-T2 | 新增 `TerminalLinkActionSheet`（本机/远程/复制/取消 + 记住选择） | `mobile/src/session/MobileSessionSheets.tsx`（或新组件） | TL-T1 | P1 |
| TL-T3 | 状态与入口：`handleTerminalOpenUrl` 改为弹框，保留 active handle 竞态保护 | `use-mobile-session-file-actions.ts`、`use-mobile-session-screen-state.ts` | TL-T2 | P1 |
| TL-T4 | 远程不可用检测（screencast 能力/浮动工作区） | `use-mobile-session-content-create-actions.ts` | TL-T3 | P1 |
| TL-T5 | 复制链接（expo-clipboard） | `platform/clipboard.ts`、动作面板 | TL-T2 | P1 |
| TL-T6 | 记住选择写回偏好；取消/关闭行为 | TL-T2/T1 | TL-T1 | P1 |
| TL-T7 | 组件测试：动作可用性、偏好迁移、竞态、复制 | `mobile/src/session/*.test.tsx` | TL-T2/T3 | P1 |

## 2. 选区校准

| ID | 任务 | 文件/模块 | 依赖 | 优先级 |
|---|---|---|---|---|
| TL-S1 | 新增 `stringIndexToCellCol`；补齐 `cell-geometry` 测试 | `mobile/src/terminal/document/cell-geometry.ts` | — | P1 |
| TL-S2 | 新增 CJK/宽字符 tokenizer（`Intl.Segmenter` + 正则回退） | `mobile/src/terminal/document/text-tokenizer.ts`（新） | — | P1 |
| TL-S3 | 重写 `seedWordSelection`：cell→string→token→cell | `mobile/src/terminal/document/selection-range.ts` | TL-S1, TL-S2 | P1 |
| TL-S4 | 附近词/短语吸附 + 单字扩展规则 | `selection-range.ts` | TL-S3 | P1 |
| TL-S5 | 端点释放吸附（可选）；保持拖动按 cell | `selection-overlay.ts` | TL-S3 | P1 |
| TL-S6 | 跨行/折行/横向滚动/缩放测试 | `mobile/src/terminal/document/*.test.ts` | TL-S1..S5 | P1 |
| TL-S7 | 真机测试：CJK/emoji/组合字符/复制一致性 | `test-reports/` | TL-S3..S6 | P1 |

## 3. 回归

| ID | 任务 | 文件/模块 | 依赖 | 优先级 |
|---|---|---|---|---|
| TL-R1 | 终端输入/滚动/OSC/文件路径回归测试 | `mobile/src/terminal/**/*.test.ts` | 全部 | P1 |
| TL-R2 | 会话切换/重连/WebView 重载回归 | 相关测试 | 全部 | P1 |
| TL-R3 | 选区复制/全选/eviction 回归 | 相关测试 | 全部 | P1 |

## 4. 完成定义

- TL-T1A/T2/T2A/T3/T3A/T4/T4A/T4B/T5..T11、TL-S1..S3/S5..S8、TL-R1..R3/R6..R8、TL-U1..U3 完成。
- 单元/组件/真机测试通过，报告与证据归档。
- 设计/代码/测试三次独立评审通过。
- 不改变现有链接检测优先级、终端输入和选区复制行为。

---

## 5. 评审 01 修订任务（2026-11-10）

> 以本节为准；旧 TL-S5“释放吸附”取消（v1 非目标）。

### 5.1 链接选择

| ID | 任务 | 文件/模块 | 依赖 |
|---|---|---|---|
| TL-T1A | 先加 `ask` 分支/枚举校验/v2 键；旧键在**第一次 sheet 打开**时读取/预选/强制迁移（focus loader 只读 v2）；初始 state 同步；设置页增加 Ask | preferences、screen state、`use-mobile-session-preference-focus.ts`、settings、测试 | — |
| TL-T2 | 新建 `TerminalLinkActionSheet`（BottomDrawer 或受控 ActionSheet 扩展）：本机/远程/复制/取消、URL 展开、记住开关、a11y | `session/TerminalLinkActionSheet.tsx`（新） | TL-T1A |
| TL-T2A | URL 展示：scheme+host+port、隐藏 userinfo、bidi/控制字符过滤、http 警告、loopback/私网提示 | `session/terminal-link-presentation.ts`（新） | TL-T2 |
| TL-T3 | 入口/状态：`handleTerminalOpenUrl` 设置 pending；**记住值直开前重新过门禁**（A30–A32），不可用回 sheet+hint | `use-mobile-session-file-actions.ts`、`use-mobile-session-screen-state.ts` | TL-T2、TL-T4 |
| TL-T3A | 动作时复核 active handle；active 变化关闭 sheet；`choiceConsumed`/in-flight guard | 同上 | TL-T3 |
| TL-T4 | 远程能力：client 在线 + `useHostStatusGates` statusReadable + 新能力 `browser.tab-create-background.v1`；离线/未知/creating 禁用+hint；folder/floating 隐藏 | create actions、`use-mobile-session-foundation.ts`、`HostProtocolGate` | —（能力判断独立） |
| TL-T4A | **独立** `handleCreateBackgroundBrowser`（或专用分支）传 `activate:false`，不设 pending ref；断言 caller 投影后 active tab 仍是终端、重连不切；New Browser/HTML/file 调用方仍 activate:true | create actions/tab reconciliation | TL-T4 |
| TL-T4B | host 在 `canBrowse`/browser host 可用时条件性广播 `browser.tab-create-background.v1`；旧 host 无能力时手机远程项禁用 + update prompt（folder/floating 隐藏） | `protocol-version.ts`、`orca-runtime-get-status.ts`、host status 测试 | — |
| TL-T5 | 复制链接 + 失败 toast，复用 `useClipboardWriter`/`platform/clipboard.ts` | 现有 seam、sheet | TL-T2 |
| TL-T6 | 记住语义：新键 `...:v2`；旧键只作一次预选高亮；Remember off 不写；on+本机/远程写；copy/cancel 不写；失败 toast | sheet + preferences | TL-T1A、TL-T5 |
| TL-T7 | 键盘：dismiss 前记录状态；关闭后恢复（有键盘则重新打开，无则保持收起） | sheet + 现有 dismiss-open 模式 | TL-T3 |
| TL-T8 | 失败态：本机/复制/远程失败 toast/haptic；client 空/creating 不静默 | sheet/actions | TL-T3 |
| TL-T9 | 默认切 `ask` 并更新现有偏好/组件测试；确认中间态无“直接远程打开” | preferences、tests | TL-T1A、TL-T3、TL-T6 |
| TL-T10 | 路由矩阵测试：OSC8 http/file、file://、路径、自定义 scheme；mailto 非目标；floating sheet | `terminal-webview-tap-routing.test.ts` 等 | TL-T3 |
| TL-T11 | 组件测试：切 tab、双击、remember 开关组合、预选、能力四态、folder/floating、键盘两态、a11y、activate=false 参数 | `session/*.test.tsx` | T2..T9 |

**合并顺序**：T4B → T4/T4A（背景创建隔离 + 能力门禁）→ T1A → T2/T2A → T3/T3A → T5/T6/T7/T8 → T9 → T10/T11。T9 之前 `ask` 不得成为默认；T4A 之前不接线远程动作。

### 5.2 选区校准

| ID | 任务 | 文件/模块 | 依赖 |
|---|---|---|---|
| TL-S7 | width-aware fake buffer / 测试辅助（`getChars`/`getWidth`/`translateToString`）+ Segmenter reset | 终端测试目录 | — |
| TL-S1 | `snapToGlyphStart`（仅 width=0 且左邻 width=2）+ `snapToGlyphEnd` + `stringIndexToCellCol`；cell/string 游标分开 | `cell-geometry.ts` | TL-S7 |
| TL-S2 | tokenizer：固定 `zh` Segmenter + 缓存/reset；回退；URL/路径/emoji/组合/全角原子；post-merge；UTF-16 下标 | `text-tokenizer.ts`（新） | TL-S7 |
| TL-S3 | **原子改造**：end-exclusive model + seed + start/end drag + 交叉 + selectAll + eviction + 菜单/鼠标 producer；两个手柄存 glyph 起始锚点 | `selection-range.ts`、`selection-overlay.ts`、`tap-dispatch.ts`、`selection-state-and-eviction.ts`、`document-scope.ts`、`host-message-router.ts`、`selection-menu-buttons.ts`、`mouse-click-drag.ts` | TL-S1、TL-S2 |
| TL-S5 | 附近短语：±8 cell、边缘 gap、平局左、CJK run >5 的 5 字窗口、空白不选/glyph 仅非空白 | `text-tokenizer.ts`、`selection-range.ts` | TL-S3 |
| TL-S6 | 几何/选区测试：G1..G30、手柄两端/交叉、宽字符半格、多行、selectAll、eviction、行尾 clamp、复制一致性；同时断言 `term.select`/model | 测试目录 | TL-S1..S5 |
| TL-S8 | 真机测试：宽字符左右半格、长 CJK run、标点邻近、Segmenter 回退、pinch/旋转 | `test-reports/` | TL-S6 |

**合并顺序**：TL-S7 → TL-S1 → TL-S2 → TL-S3 → TL-S5 → TL-S6/S8。TL-S3 是原子 PR，禁止先改 model 后改 seed。

### 5.3 回归

| ID | 任务 | 断言 |
|---|---|---|
| TL-R1 | 输入/滚动/软键盘 | 不变 |
| TL-R2 | 会话切换/重连/WebView 重载 | 不变 |
| TL-R3 | OSC/文件 tap 路由 | 矩阵逐条 |
| TL-R6 | URL/路径长按复制 | 新增 width-aware selection 测试，整段不变 |
| TL-R7 | Copy/Select All/eviction | 新增 selection-range/selection-overlay 测试；行为不变 |
| TL-R8 | `pnpm --dir mobile test`/typecheck/lint、`pnpm tc` | 全绿 |

### 5.4 原型

| ID | 任务 | 内容 |
|---|---|---|
| TL-U1 | 更新 `terminal-link.html` | 英文文案；删除 prefbar/撤销/链接样式；URL 摘要/展开（摘要隐藏 userinfo）、http/loopback 警告、能力四态（旧 host 禁用）、键盘两态、预选/强制迁移、Copy 不改变 Ask |
| TL-U2 | 更新 `terminal-selection.html` | 500ms 显示 overlay **和 Copy/Select All 菜单**；向量相对坐标；补 emoji/5 字 CJK 窗口/折行/手柄两端/交叉/复制一致 |
| TL-U3 | 原型归位/说明 | 共享布局需在 feature `ui/` 说明或链接；G2 可追溯 |

### 5.5 Review-04 处理决定

| 条目 | 决定 |
|---|---|
| N-C | 两个手柄只存 glyph 起始锚点；排序后 start=snapToGlyphStart(lower)、endExclusive=snapToGlyphEnd(upper)；B17b 精确向量 |
| N-E | 记住值直开前重新过 client/status/capability/creating/workspace 门禁；不可用则显示 sheet+hint，不调用 create；A30/A31 |
| m2 | 旧 host 禁用+prompt；folder/floating 隐藏；T4B 同步 |
| m3 | 旧键只在第一次 sheet 打开时读取/迁移；focus loader 只读 v2 |
| m5 | 测试命令行改为 R10，避免 R9 重复 |
| m6 | B20 拆为“无 token 空白不选”与“两侧有 token 走 G7” |
| N-A minor | G22a–G22e 精确向量；后缀吸附迭代；裁剪不移除 join 集合 |
| N-D minor | A33 覆盖 New Browser/HTML/file 仍 activate:true + pending ref |
| 任务账本 | TL-S3 文件列表补全；TL-S6 G1..G30；完成定义更新 |
| 能力广播 | 仅在 canBrowse/browser host 可用时条件性广播；host-status 测试 |
| 触摸目标 | 原型按钮/开关/Retry 提升到 44×44 有效命中区 |
| N-F | 拖拽中相等保留单 glyph，只在释放时清空；补经过相等点用例 |
| N-C-r1/r2 | 存储 `{anchor,focus}` glyph 起始锚点；seed/selectAll 回填规则；固定端宽字符向量 |
| N-E-r1/r2 | 迁移仅当 v2 不存在；不可用不写偏好且不降级；A20b/A30b |
| 旧 T12–T15 | 映射：T12→T8/T11，T13→S2/S3，T14→S6，T15→T10/T11；不再单列 |
| m6-r | 原型说明限定空白；新增 G30 非空白 glyph fallback |

## 最终验收（2026-11-10）

- 设计评审、代码评审、测试评审、修复后复审均通过；测试评审确认“高亮/复制不一致”为误报。
- `regression-01.md`：Android 终端 11 项完整 PASS + 2 项 BLOCKED（adb 合成拖拽被系统返回手势拦截，单元向量覆盖）；链接 sheet、remember、CJK/emoji/5 字窗口、Select All、键盘打开时 60 ms 链接点击均复验通过。
- 未覆盖项（不计 PASS）：iOS（Xcode 26 阻塞）、物理设备、多行拖拽/handle crossing 真机手势、旧 host 远程打开、SSH/folder workspace。
- 结论：Android/模拟器范围 FINAL_ACCEPT。
