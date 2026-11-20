# 设计评审 05

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`terminal-link.html`、`terminal-selection.html`（静态核对），以及设计引用的 mobile terminal/session 与 host publication 源码
日期：2026-11-10
Reviewed snapshot（sha256 前 8 位）：design `5ce69c4f`、test-plan `556053d9`、tasks `466c9783`、ui/README `5347174c`、terminal-link `7091d464`、terminal-selection `30bf71d2`。
结论：**REJECTED**

New findings: **0 BLOCKER / 1 MAJOR / 7 MINOR.**
Prior findings: **N-C / N-E FIXED（原 MAJOR 均已解决，各有 minor 残留）；m2/m3/m5/m6/N-A-minor/N-D-minor/能力广播/44px FIXED（m3/m5/m6 有 minor 残留）；任务账本 PARTIAL。**
Unresolved total: **0 BLOCKER / 1 MAJOR / 7 MINOR.**

---

## Prior findings

| ID            | Severity | Status                  | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-C           | MAJOR    | **FIXED（minor 残留）** | `design.md:285-294` 已统一为“两个手柄只存 glyph 起始锚点，排序后 start=`snapToGlyphStart(lower)`、endExclusive=`snapToGlyphEnd(upper)`”。B17b（`test-plan.md:221`）三条向量与 `terminal-selection.html:742,753,774,785,806,817` 状态 17/18/19 的 `[2,6)`/`cdef`、`[0,2)`/`ab`、`[4,7)`/`abc` 完全一致；`term.select` 长度均为正。残留为 N-C-r1/r2，另有新 MAJOR N-F。 |
| N-E           | MAJOR    | **FIXED（minor 残留）** | `design.md:239` 要求 `mode !== ask` 直开前重新过 client/statusReadable/capability/creating/workspace 门禁，不可用则显示 sheet+hint、不调用 create/open，且不自动降级存储值；A30/A31/A32（`test-plan.md:207-209`）覆盖 stored `orca-browser` 的不可用、folder/floating 与 stored `phone-browser` 直开。残留为 N-E-r1/r2。                                              |
| m2            | MINOR    | **FIXED**               | `tasks.md:61` TL-T4B 已改为“旧 host 无能力时禁用 + update prompt；folder/floating 隐藏”，与 `design.md:209`、`test-plan.md:192` A15、`terminal-link.html:876-883`、`ui/README.md:39` 一致。                                                                                                                                                                           |
| m3            | MINOR    | **FIXED（minor 残留）** | `design.md:236` 明确旧键只在第一次 sheet 打开时读取/迁移，`use-mobile-session-preference-focus.ts` 只读 v2；A20 断言第二次打开无预选。残留见 N-E-r1。                                                                                                                                                                                                                 |
| m5            | MINOR    | **FIXED（minor 残留）** | `test-plan.md:235-236` 已拆为 R9（clipboard seam）与 R10（测试命令）。AC 映射仍漏 G29/G22a–e：m5-r。                                                                                                                                                                                                                                                                  |
| m6            | MINOR    | **FIXED（minor 残留）** | `test-plan.md:225-226` 已拆为 B20（无邻近 token 的空白不选）与 B20a（两侧有 token 走 G7）；`design.md:253`、状态 15 的 glyph fallback 仅限非空白 cell。原型说明仍过度概括：m6-r。                                                                                                                                                                                     |
| N-A-minor     | MINOR    | **FIXED**               | `design.md:302-304` 已写明 `+`/`#`/`%` 后缀**迭代**吸附、裁剪不移除 join 集合；G22a–G22e（`test-plan.md:172-176`）给出 `key=value`/`a@b.com`/`C++`/`100%`/`a#b` 的精确 start/endExclusive/`term.select`/copy。                                                                                                                                                        |
| N-D-minor     | MINOR    | **FIXED**               | A33（`test-plan.md:210`）覆盖 New Browser/HTML/file 仍 `activate:true` 且设置 `pendingBrowserFocusPageIdRef`；`tasks.md:60` TL-T4A 同步。                                                                                                                                                                                                                             |
| 任务账本      | MINOR    | **PARTIAL**             | `tasks.md:39` 完成定义、`tasks.md:79` TL-S3 文件列表、`tasks.md:81` G1..G29 已更新。仍存在 ID/依赖残留，见“任务账本”一条。                                                                                                                                                                                                                                            |
| 能力广播谓词  | MINOR    | **FIXED**               | `design.md:209`、`tasks.md:61` 要求仅在 `canBrowse`/browser host 可用时条件性广播并补 host-status 测试；`orca-runtime-get-status.ts:82,93` 的 `canBrowse` 过滤与 `browser.tab-create-known-id.v1` 先例一致。                                                                                                                                                          |
| 44px 触摸目标 | MINOR    | **FIXED**               | `terminal-selection.html:100` `.editmenu button` 已为 44px；`terminal-link.html:94` URL toggle `min-height:44px`、`:118` Retry `44×44`、`:125` Remember switch `46×44`、`:102` 动作行 52px；`ui/README.md:44` 与注解一致。                                                                                                                                            |

---

## Findings

- **[MAJOR] N-F — “相等则清空选区”会在拖拽中途取消活动手柄，使 B17b 的三条交叉向量无法在真实手势路径到达。** `design.md:287` 把“相等则清空选区”写在每次计算 span 的规则里；`test-plan.md:221` 与 `terminal-selection.html:753,785,817` 又要求手柄从另一锚点的一侧拖到另一侧。三条向量都必须经过相等点：`bc` 的 start 从 1 拖到 5 经过固定锚点 2；`bcd` 的 end 从 3 拖到 0 经过 1；`文a` 的 start 从 2 拖到 6 经过 4。当前拖拽在每次 `touchmove` 都调用 `handleDragMove` → `syncSelectionHandleToViewportPoint`（`tap-dispatch.ts:182`、`selection-overlay.ts:70-87`）。若相等时执行 `cancelSelect`、把 `scope.sel` 置空，下一次移动会在 `selection-overlay.ts:77` 的 `!scope.sel` 处直接返回，手势停在相等点，永远到不了 5/0/6。单元测试若直接构造锚点 1/2、1/3、2/4 则能通过，因此 B17b 目前不能证明真实拖拽可交叉。**影响：** 手柄交叉时选区可能中途消失，状态 17/18/19 的复制结果不可达；这是 N-C 核心交互的阻断性矛盾。**修复：** 把“相等清空”限定为释放时（`activeHandle` 为空/`touchend`），或在 `activeHandle !== null` 时保留被拖锚点并渲染单 glyph span、只在释放且相等时清空；补“经过相等点”的拖拽测试（`handleDragMove` 1→2→5、3→1→0、2→4→6，断言 `scope.sel`、`term.select`、copy 均存活）以及“释放于相等点清空”的独立用例；同步修改 `design.md:287`、`test-plan.md:221`、`ui/README.md:68-70`、`terminal-selection.html:877,882`。

- **[MINOR] N-C-r1 — 存储模型、seed 转换与 selectAll 的锚点仍未钉死。** `design.md:286` 说两个手柄只存 glyph 起始锚点；`:290` 说 `selectAll` 的 `start=(0,0)`、`endExclusive=(cols,lastRow)`；`:292` 说 `document-scope.ts` 类型改为 endExclusive，但同一句又用 anchor/focus 描述 eviction。`:285` 只说 seed 把 token 映射为 start/endExclusive，没有说明 end 手柄要回填为“最后一个被包含 glyph 的起始 cell”。B17b 直接从锚点 1/2、1/3、2/4 开始，因此一个把 seed 的 focus 存成 endExclusive（`bc` 存 3）的实现可以通过 G1–G18 与 B17b，却在第一次拖动时错位。**影响：** 实现者仍可能在 seed/selectAll 处混用边界与锚点，交叉修复只覆盖“已存在的正确模型”。**修复：** 明确存储模型为 `{anchor, focus}` 两个 glyph 起始锚点、`SelectionSpan` 为派生值；写明 seed 的 end 锚点取最后一个被包含 glyph 的起始 cell、selectAll 的 end 锚点如何取到 `cols`（含行尾宽字符/空白）；修正 `document-scope.ts` 的类型表述；增加“seed `bc`/`bcd`/`文a` 后先断言手柄锚点，再拖动”的集成用例。

- **[MINOR] N-C-r2 — “宽字符固定端”向量并未把宽字符放在固定端，`snapToGlyphEnd` 的宽度处理没有被证伪。** `design.md:289`、`test-plan.md:221`、`terminal-selection.html:806-817`、`ui/README.md:70` 的 `中文abc` 选 `文a`（锚点 2/4）拖 start 到 c(6) 中，固定端是 cell 4 的 `a`（宽 1），`文` 属于被拖走的一侧。一个把 `endExclusive` 算成 `upper + 1` 的实现可以通过全部三条交叉向量。`test-plan.md:161` 也只有 `snapToGlyphStart` 单测，没有 `snapToGlyphEnd`。**影响：** 当固定上锚点本身是宽字符时，结束边界可能少 1 格，复制与高亮不一致且测试不报错。**修复：** 增加 end 从 4 拖到 0 的向量：排序 0/2 → `[0,4)`、`term.select(0,row,4)`、copy `中文`；补 `snapToGlyphEnd` 单测（宽字符起点、右半格、空白、行尾）；把状态 19 标题改为“宽字符位于被越过的一侧”或新增真正的固定端状态。

- **[MINOR] N-E-r1 — 旧键迁移可能覆盖用户已显式写入的 v2。** `design.md:236` 规定第一次 sheet 打开时读取旧键并“必须写 `ask` 到 v2”，但没有先判断 v2 是否已存在。若用户升级后先去设置页选择 `Phone browser`/`Orca browser`（A9 要求设置页可改回 Ask，也必须能写 v2），v2 已写入；随后第一次打开链接 sheet 仍会无条件写 `ask`，把用户刚选的模式静默改回每次询问，然后删旧键。**影响：** 设置页选择被迁移逻辑覆盖，属于偏好数据丢失。**修复：** 仅当 v2 不存在时用旧键做一次预选并迁移；v2 已存在时只删除旧键、不写 v2；A20 增加“先设置 v2，再第一次打开 sheet”的用例，断言 v2 保持用户选择且旧键被删除。

- **[MINOR] N-E-r2 — “不自动降级”与偏好表冲突，且没有恢复/存储值断言。** `design.md:232` 写“远程项被隐藏/不可用 → 记忆值保持‘每次询问’”，而 `design.md:239` 明确“不自动降级存储值（host 恢复后仍可用）”。若存储值本来是 `orca-browser`，不可用时它不会变成 ask。A30/A31（`test-plan.md:207-208`）只断言当前不直开/无 `browser.tabCreate`，没有断言 fallback 后存储值仍为 `orca-browser`，也没有断言能力恢复后下一次点击重新直开。**影响：** 实现者可能按 :232 把存储值降级，破坏“host 恢复后仍可用”；测试不能发现。**修复：** 改写 :232 为“不可用时本次不写偏好，已有非 ask 值保持不变”；增加 A30b：不可用时走 sheet 且存储值不变，能力恢复后下一次点击直接远程打开、不再弹 sheet。

- **[MINOR] m6-r — 原型说明把“无 token”泛化为“永不建立选区”。** `terminal-selection.html:882` 写“If the long-pressed cell has no token, no selection or handles are created”，但 `design.md:253` 规定命中 cell 是非空白 glyph 且 ±8 cell 内无 token 时选中该完整 glyph（宽字符 2 cells）；B20/B20a（`test-plan.md:225-226`）只把“不选”限定为空白/行尾。原型也没有非空白无 token 的 glyph fallback 状态，测试计划没有对应精确向量。**影响：** 按原型实现会丢掉设计要求的标点/孤立 glyph 选中。**修复：** 将说明限定为 blank/end-of-line；增加非空白无 token 的向量（如行内孤立 `&` 且 ±8 内无 token → 选中 `&`，copy 一致）；原型可补一张状态或明确标注未覆盖。

- **[MINOR] m5-r — AC 映射仍落后于新增的 G 行。** `test-plan.md:112` 的 AC2 仍写 “G1..G28”，未包含 G29 与 G22a–G22e；`:113` 的 AC3 写 “G9..G11、G25..G28”，未包含 G29；`:115` 的 AC5 只列 R9（R10 是验证命令，可不列）。R9/R10 的重复本身已修复（`:235-236`）。**影响：** 验收标准到用例的追溯不完整，G29/G22a–e 不在任何 AC 行中。**修复：** AC2 改为 “G1..G29（含 G22a–G22e）”；AC3 增加 G29；如需要，在 AC5 注明 R10 为全绿验证命令。

- **[MINOR] 任务账本/依赖仍有残留。** `tasks.md:39` 的完成定义写 “TL-S1..S8”，但 `tasks.md:74-84` 的权威 §5.2 没有 TL-S4（旧 §2 的 S4 已被 §5.2 的 S5 取代），S4 是悬空 ID。`design.md:345-352` 的 TL-T12–T15 在 `tasks.md` 中没有对应行（实际由 T8/T10/T11/S6 吸收），需要映射或删除。`tasks.md:59-61` 的依赖列写 T4→T3、T4A→T4，与 `tasks.md:70` 的强制合并顺序 “T4B → T4/T4A → T1A → T2/T2A → T3/T3A” 冲突；照依赖列实施会重新打开 review-03 N-D 的中间提交窗口。§5.5 的 N-E 决策（记住值直开门禁，A30–A32）没有落到 TL-T3/T6 的任一行。**修复：** 删/改 S4，映射或删除 T12–T15，把 T4/T4A 的依赖改为 T1A/T2（或注明能力/背景创建部分不依赖 T3），并在 TL-T3/T6 增加“记住值直开重新过门禁（A30–A32）”及测试。

---

## Requirement coverage

- **点击链接弹框（本机/远程/复制/取消）**: **覆盖**. 独立背景创建、能力命名、A12、URL 展示、门禁、失败态和原型均齐；N-E 的直开门禁已写清并有用例。残留为迁移优先级与不降级断言（N-E-r1/r2）。
- **中文/英文/emoji/混排/折行长按不错位**: **覆盖**. G1–G18、G26–G29 精确；N-B 的 5 字窗口在 Segmenter 两态一致。
- **空白/标点选附近词，不选空/整行**: **覆盖**. B20/B20a 已拆分，G7/G9/G11/G25–G29 对齐；原型说明仍把“无 token”泛化（m6-r）。
- **高亮与复制一致、手柄按 cell**: **阻断**. 模型、精确向量和状态 17/18/19 的算术已对齐，但“相等清空”会在拖拽中途取消选区（N-F），交叉结果在真实手势中不可达；N-C-r1/r2 是模型/宽度覆盖残留。
- **不影响输入/滚动/OSC/路径/复制/全选**: **覆盖** in intent；A33 补了既有 New Browser/HTML/file 回归，S3 文件列表已全；任务依赖列与合并顺序不一致（任务账本）。
- **记住选择/设置恢复每次询问**: **覆盖**. v2/旧键、Remember 开关表、写失败、A18–A21 明确；迁移覆盖 v2 与不降级的测试仍缺（N-E-r1/r2）。
- **Chrome 74 / Segmenter fallback**: **覆盖**. 固定 zh、缓存/reset、构造抛错、回退、G19–G22e；G22a–e 精确。
- **测试可证伪性**: **部分覆盖**. G1–G18、G22a–e、G26–G29 强；B17b 仍不能覆盖“拖拽经过相等点”和“固定上锚点为宽字符”两条路径（N-F/N-C-r2）。
- **任务拆分/顺序**: **基本覆盖**. 合并顺序本身正确，但依赖列、悬空 S4、T12–T15 映射和 N-E 任务归属需收口。
- **原型**: **基本覆盖**. 状态 17/18/19 与设计算术一致，旧 host/legacy/keyboard/folder/floating/44px 均已对齐；状态 19 标题与说明的“固定端”不准确（N-C-r2），空白说明过度概括（m6-r）。
- **无障碍/失败态/文件夹/OTA**: **覆盖** in design and cases；本轮无新增阻断。

---

## 建议修改（按优先级）

1. 先修 N-F：把“相等清空”限定到释放，保证活动拖拽可越过另一手柄；补经过相等点的拖拽测试和释放于相等点的独立测试，并同步设计/测试/原型/README 文案。
2. 钉死 N-C 的存储模型与边界：明确 seed 的 end 锚点回填、selectAll 的 end 锚点来源、`document-scope.ts` 的类型归属；补真正“固定端是宽字符”的交叉向量和 `snapToGlyphEnd` 单测。
3. 收口 N-E 残留：旧键迁移只在 v2 不存在时执行；改写“记忆值保持每次询问”；补不降级/恢复直开与“先设置 v2”用例。
4. 修 m5-r/m6-r 与任务账本：AC2/AC3 补 G29、G22a–e；原型说明限定 blank；删除悬空 S4、映射 T12–T15、修正 T4/T4A 依赖并在 TL-T3/T6 落下直开门禁。
