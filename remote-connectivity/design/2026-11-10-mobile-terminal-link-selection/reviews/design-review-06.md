# 设计评审 06

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`terminal-link.html`、`terminal-selection.html`（静态核对），以及设计引用的 mobile terminal/session 与 host publication 源码
日期：2026-11-10
Reviewed snapshot（sha256 前 8 位）：design `3bd0c467`、test-plan `00178ba7`、tasks `17c53c14`、ui/README `33ddde54`、terminal-link `7091d464`、terminal-selection `bab8545f`。
结论：**APPROVED_WITH_MINORS**

New findings: **0 BLOCKER / 0 MAJOR / 5 MINOR.**
Prior findings: **N-F FIXED；N-C-r1 FIXED（minor 残留）；N-C-r2 FIXED（minor 残留）；N-E-r1 FIXED（原型/README 有残留）；N-E-r2 FIXED；m5-r FIXED；m6-r FIXED（state 21 有一处文字错误）；任务账本 PARTIAL。Earlier BLOCKER/MAJOR: 0 re-opened.**
Unresolved total: **0 BLOCKER / 0 MAJOR / 5 MINOR。**

---

## Prior findings

| ID       | Severity | Status                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-F      | MAJOR    | **FIXED**                                     | `design.md:287` 已将“相等清空”限定到释放：拖拽中保留被拖锚点并渲染单 glyph，只有释放且两锚点相等才清空。`test-plan.md:224` B17b 覆盖 1→2→5、3→1→0、2→4→6 的 through-equal 路径并断言“拖拽经过相等点时选区存活”；`:226` B17d 覆盖释放于相等点清空；`terminal-selection.html:753,790,827,864` 状态 17–20 均带 `data-equal-span`/`data-equal-select`/`data-equal-copy` 与 through-equal trace。三条向量的算术复核一致：`bc` 1/2→[2,6)/`cdef`；`bcd` 1/3→[0,2)/`ab`；`文a` 2/4→[4,7)/`abc`，固定上锚点 2 的 `[0,4)`/`中文` 也正确。 |
| N-C-r1   | MINOR    | **FIXED（minor 残留，见 Finding 1）**         | `design.md:286,290-294` 已固定 `{anchor,focus}` 两个 glyph 起始锚点、`SelectionSpan` 为派生值、seed end 锚点取最后一个被包含 glyph 的起始 cell、`selectAll` focus=`snapToGlyphStart(cols-1,lastRow)`，并写明 `document-scope.ts` 的归属（该文件 `:212-214` 目前已是 anchor/focus，设计措辞可改为“保持”）。残留是 test-plan 没有“seed 后先断言 anchor/focus 再拖动”的用例，且 `:285` 仍写 seed 映射为 start/endExclusive。                                                                                                       |
| N-C-r2   | MINOR    | **FIXED（minor 残留，见 Finding 2）**         | `test-plan.md:225` B17b2 给出固定上锚点为宽字符的 `[0,4)`/`中文`；`terminal-selection.html:855-890` 状态 20 与 `ui/README.md:71` 已补；状态 19 标题改为“wide glyph on the crossed side”。残留是没有 `snapToGlyphEnd` 的单测矩阵、`design.md:289` 标签仍写“宽字符固定端”，以及 B17b2/state 20 的目标 cell 文案错误。                                                                                                                                                                                                             |
| N-E-r1   | MINOR    | **FIXED（原型/README 有残留，见 Finding 3）** | `design.md:236` 已改为“仅当 v2 不存在时写 `ask`；v2 已存在则保持用户值，只删除旧键”；`test-plan.md:199` A20b 覆盖“先写 v2 再第一次打开 sheet”。`terminal-link.html` 本轮未变更（hash 与 review-05 相同），其 state 12 仍写无条件迁移。                                                                                                                                                                                                                                                                                          |
| N-E-r2   | MINOR    | **FIXED**                                     | `design.md:232` 已改为“本次不写偏好；已有非 ask 值保持不变（host 恢复后仍直开）”，`:239` 明确“不自动降级存储值”。`test-plan.md:212` A30b 断言不可用时存储值仍为 `orca-browser`、恢复后直接远程打开且不再弹 sheet；A30/A31/A32 覆盖不可用、folder/floating、phone-browser 直开。                                                                                                                                                                                                                                                 |
| m5-r     | MINOR    | **FIXED**                                     | `test-plan.md:112` AC2 已为 `G1..G30（含 G22a–G22e 与 Segmenter 两态）`；`:113` AC3 已为 `G9..G11、G25..G30`。G29/G30 均进入 AC 映射。                                                                                                                                                                                                                                                                                                                                                                                          |
| m6-r     | MINOR    | **FIXED（state 21 文字错误，见 Finding 4）**  | `test-plan.md:184` G30、`:230-231` B20/B20a；`terminal-selection.html:682-698` state 15 与 `:892-923` state 21；`ui/README.md:66,72` 均把“无选区”限定为 blank/end-of-line，并说明非空白无 token glyph fallback。                                                                                                                                                                                                                                                                                                                |
| 任务账本 | MINOR    | **PARTIAL（见 Finding 5）**                   | 完成定义 `tasks.md:39` 不再引用 TL-S4；T12–T15 映射在 `:123`；T4 依赖为 `—（能力判断独立）`、T4A 依赖 TL-T4（`:59-60`），与 `:70` 合并顺序一致；N-E 直开门禁已落到 TL-T3（`:57`）。残留为状态行、TL-S6 的 G 范围、旧 §2 的 S4 行和 T12 映射。                                                                                                                                                                                                                                                                                   |

Earlier rounds: review-01/02/03 的 BLOCKER B1–B3（宽字符右半格、end-exclusive 模型、可证伪测试）与 review-02/03 的 MAJOR N-A/N-B/N-D（后缀吸附、5 字窗口、背景创建隔离）仍保持已修复状态；本轮修改未重新打开任何 BLOCKER/MAJOR。

---

## Findings

- **[MINOR] N-C-r1 residual — seed 后的存储锚点仍未被测试钉死，且 `design.md:285` 仍用 endExclusive 描述 seed。** `design.md:285` 写“seed：token 映射为 start/endExclusive”，而 `:290-291` 又规定存储模型是 `{anchor,focus}` 两个 glyph 起始锚点、seed 的 end 锚点取“最后一个被包含 glyph 的起始 cell，不是 token 的 endExclusive”。两处并读会让人以为 seed 可以直接把 endExclusive 存进 focus。更关键的是，`test-plan.md` 没有任何“先 seed 再断言 anchor/focus、然后拖动”的用例：B17b/B17b2（`:224-225`）直接从手工构造的 1/2、1/3、2/4 锚点开始，G1–G18 只断言派生出的 `start`/`endExclusive`，因此一个把 seed focus 存成 exclusive 边界、再在别处补偿的实现仍可能通过现有向量，直到第一次拖动才暴露——正是 review-05 N-C-r1 描述的风险。**影响：** seed/model/drag 的存储契约没有被独立证明，交叉向量只证明了“给定正确锚点时的排序”。**修复：** 把 `design.md:285` 改为“seed 先计算 token coverage `[start,endExclusive)`，再存 anchor=首 glyph 起始、focus=最后一个被包含 glyph 起始”；新增 B17e（或等价集成用例）：长按/seed `bc`、`bcd`、`文a` 后先断言 `scope.sel.anchor/focus` 为 glyph 起始，再执行 B17b/B17b2 的拖动；同时在 G1/G4/G15 的补充断言中加 anchor/focus，而不只断言派生 model。 |

- **[MINOR] N-C-r2 residual — `snapToGlyphEnd` 没有契约和单测矩阵，固定上锚点向量的目标 cell 也写错。** `test-plan.md:161` 的补充断言仍只列 `snapToGlyphStart`（右半格、continuation、空 cell），没有 review-05 要求的 `snapToGlyphEnd` 用例（宽字符起点、右半格、空白、行尾）。`design.md:289` 仍把 `中文abc` 选 `文a` 拖 start 到 c 的 `[4,7)`/`abc` 称为“宽字符固定端”，但该例的固定端是 cell 4 的 `a`（宽 1），`文` 在被越过的一侧；真正的固定上锚点宽字符向量只存在于 `test-plan.md:225` 和原型 state 20。另，B17b2/state 20 的目标 cell 文案指向了错误的 glyph：`test-plan.md:225` 写“end 拖到 a(0)”，`terminal-selection.html:861` 写“to a at cell 0”，`:872` 写“to a (cell 0)”，`ui/README.md:71` 写“to `a` at cell 0”；但 `中文abc` 的 cell 0 是 `中`，`a` 在 cell 4。期望结果 `[0,4)`/`中文`、`term.select(0,row,4)` 与原型视觉（`tap-target` 落在 `中`）都正确，所以这是标签/矢量描述错误，不是算术错误。**影响：** B17b2 能抓住“upper+1”的固定端宽字符错误，但 `snapToGlyphEnd` 对右半格/空白/行尾的行为仍未被证伪，设计仍把两种情形混称；测试作者若按“拖到 a(0)”字面执行，会把 end 手柄拖到 cell 4（原地/相等点），与期望的 `[0,4)` 冲突。**修复：** 在 `design.md` 定义 `snapToGlyphEnd(cell)`：glyph 起点→起点+width；continuation→先 `snapToGlyphStart` 再加 width；空白→+1；行尾 clamp 到 cols；把 `:289` 改名为“宽字符位于被越过的一侧”并补一条固定上锚点的 `[0,4)`/`中文` 示例；在 `test-plan.md:161` 增加上述四类 `snapToGlyphEnd` 单测；把 B17b2/state 20 的“a(0)”统一改为“cell 0（中）”/“to 中 at cell 0”。 |

- **[MINOR] N-E-r1 residual — link 原型和 ui/README 仍把旧键迁移写成无条件的 `v2 = ask`。** `terminal-link.html:786,801,820` 与 `ui/README.md:38` 仍写“old key is read once, then migrated to `orca:terminalLinkOpenMode:v2 = ask` and deleted”，没有说明 v2 已存在时只删旧键、不覆盖用户值。设计 `design.md:236` 和 A20b（`test-plan.md:199`）已经正确；本轮 `terminal-link.html` 的 hash 与 review-05 相同，说明该文案未随 N-E-r1 更新。**影响：** 按原型实现会在用户已从设置页写入 v2 后，第一次打开 sheet 时把用户选择静默改回 Ask。**修复：** 将 state 12/README 改为“仅在 v2 不存在时用旧键预选并写 `ask`；v2 已存在则保留并只删旧键”，或在原型中加一句 A20b 分支说明。 |

- **[MINOR] m6-r residual — state 21 的空白间距描述左右颠倒。** `terminal-selection.html:909` 写“`&` is at cell 14 with 10 blank cells before the left token and 10 before the right token”；实际布局是 `left`（0–3）后有 10 个空格到 `&`（14），`&` 后又有 10 个空格到 `right`。`ui/README.md:72` 的“10 blank cells before each neighbouring token”是正确的。**影响：** 仅注释文字错误；`[14,15)`/`term.select(14,row,1)`/copy `&` 均正确。**修复：** 改为“10 blank cells between `&` and the left token, and 10 between `&` and the right token”。 |

- **[MINOR] 任务账本仍有残留。** `tasks.md:3` 仍写“review-04 REJECTED ... 待复审”，未更新到 review-05/06 的状态。`tasks.md:81,117` 的 TL-S6 仍写 `G1..G29`，而 test-plan 已新增 G30（非空白孤立 glyph fallback），TL-S6 应覆盖 `G1..G30`。`tasks.md:24` 的旧 §2 表仍保留 TL-S4（附近词/短语），而权威 §5.2 已将该职责改为 TL-S5，完成定义 `:39` 和 §5.2 都不再定义 S4；旧表虽被 `:48` 的“以本节为准”覆盖，但悬空行仍会误导。`tasks.md:123` 把 T12（失败态/离线/未知能力/创建中）映射到 T8/T9，其中 T9 是“默认切 ask”，而 T12 的离线/未知/创建中能力态实际由 T4/T11 覆盖；建议改为 T8/T11 或补一句说明。T4/T4A 依赖（`:59-60`）与 N-E 门禁归属（TL-T3，`:57`）已验证正确。**修复：** 更新状态行；TL-S6 改 `G1..G30`；删除或标注旧 §2 表为 superseded（至少 S4/S5 两行）；修正 T12 映射。 |

---

## Requirement coverage

- **点击链接弹框（本机/远程/复制/取消）**: **覆盖**. 独立背景创建、能力命名、A12、URL 展示、门禁、失败态和原型均齐；N-E 的直开门禁与恢复路径已写清并有用例。残留仅为原型 legacy 文案（Finding 3）。
- **中文/英文/emoji/混排/折行长按不错位**: **覆盖**. G1–G18、G26–G29、B17/B17b/B17b2 精确；N-B 的 5 字窗口在 Segmenter 两态一致。N-C-r1/r2 的 seed 锚点与 `snapToGlyphEnd` 单测仍可再钉死（Finding 1/2）。
- **空白/标点选附近词，不选空/整行**: **覆盖**. B20/B20a、G7/G9/G11/G25–G30 对齐；state 15/21 已补。state 21 仅有一处间距文字错误（Finding 4）。
- **高亮与复制一致、手柄按 cell**: **覆盖**. 两个 glyph 起始锚点、排序、交叉、释放清空、固定上锚点宽字符的算术全部复核一致；N-F 已解决。剩余是 seed-before-drag 与 `snapToGlyphEnd` 的测试覆盖（Finding 1/2）。
- **不影响输入/滚动/OSC/路径/复制/全选**: **覆盖** in intent；A33 覆盖既有 New Browser/HTML/file 回归，S3 文件列表完整；任务账本仅剩 bookkeeping（Finding 5）。
- **记住选择/设置恢复每次询问**: **覆盖**. v2/旧键、Remember 开关表、写失败、A18–A21、A20b、A30b 明确；N-E-r1/r2 的设计与测试已闭环，仅 link 原型文案残留（Finding 3）。
- **Chrome 74 / Segmenter fallback**: **覆盖**. 固定 zh、缓存/reset、构造抛错、回退、G19–G22e；G22a–e 精确。
- **测试可证伪性**: **基本覆盖**. G1–G18、G22a–e、G26–G30、B17b/B17b2 强；seed 后的 anchor/focus 与 `snapToGlyphEnd` 的四类边界仍缺直接单测（Finding 1/2）。
- **任务拆分/顺序**: **覆盖**. 合并顺序 `T4B → T4/T4A → T1A → T2/T2A → T3/T3A → ...` 与依赖列一致；TL-S3 原子改造、TL-T3 直开门禁归属正确。剩余为状态/G30/旧 S4/T12 映射（Finding 5）。
- **原型**: **覆盖**. 状态 17–20 的 through-equal trace 与算术一致，state 20 固定上锚点宽字符已补，state 21 孤立 glyph 已补；state 20 目标 glyph 文案和 state 21 间距文案需修（Finding 2/4）。
- **无障碍/失败态/文件夹/OTA**: **覆盖** in design and cases；本轮无新增阻断。

---

## 建议修改（按优先级）

1. 补 N-C-r1 的 seed-before-drag 用例，并把 `design.md:285` 改成“先算 coverage、再存两个 glyph 起始锚点”，消除 endExclusive/focus 的歧义。
2. 补 `snapToGlyphEnd` 的契约与四类单测；修正 `design.md:289` 的“宽字符固定端”标签，并把 B17b2/state 20 的目标 glyph 由 `a(0)` 改为 `中(0)`。
3. 修正 link 原型/README 的旧键迁移文案：仅 v2 不存在时写 `ask`，v2 已存在时保留并只删旧键。
4. 更新任务账本：review-05/06 状态、TL-S6 `G1..G30`、旧 §2 S4 行、T12→T8/T11 映射。
5. 修正 state 21 的间距描述；这是纯文字问题，不影响向量。

以上均为 MINOR，G3 出口条件（无 BLOCKER/MAJOR）已满足；建议在 `tasks.md` §5.5 增加一节记录本轮处理决定后进入 G4。
