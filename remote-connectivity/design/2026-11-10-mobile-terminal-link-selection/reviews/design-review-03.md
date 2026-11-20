# 设计评审 03

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`terminal-link.html`、`terminal-selection.html`，以及设计引用的 mobile terminal/session 与 host publication 源码
日期：2026-11-10
Reviewed snapshot（sha256 前 8 位）：design `81a76165`、test-plan `12bc6849`、tasks `66550996`、ui/README `5a2ef580`、terminal-link `1f841911`、terminal-selection `eef25e8a`。
结论：**REJECTED**

New findings: **0 BLOCKER / 4 MAJOR / 10 MINOR.**
Prior findings: **3/3 blockers FIXED; 11/12 majors FIXED, 1 STILL OPEN (M1); 7/7 minors FIXED.**

---

## Prior findings

| ID    | Severity | Status                    | Evidence                                                                                                                                                              |
| ----- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | BLOCKER  | **FIXED**                 | `design.md:269-272` snaps only on `getWidth()===0` plus left-neighbour width 2; G29 and prototype states 02/03 cover both half-cells.                                 |
| B2    | BLOCKER  | **FIXED**                 | `design.md:273-294` defines `start/endExclusive`, the length formula, and names every producer; TL-S3 is one atomic change. Producer crossing is a new gap: N-C.      |
| B3    | BLOCKER  | **FIXED**                 | `test-plan.md:132-162` uses a width-aware buffer and exact cell/model/select/copy rows G1–G18.                                                                        |
| M1    | MAJOR    | **STILL OPEN (narrowed)** | Fullwidth, URL/path, emoji, and combining atomicity are now specified (`design.md:298-305`), but `C++`/`100%` still cannot be produced by the stated merge rule: N-A. |
| M2    | MAJOR    | **FIXED**                 | `design.md:246-256`; G9–G11, G26–G28; prototypes 01/05/07/13/14. The new CJK rule introduces a tokenizer inconsistency: N-B.                                          |
| M3    | MAJOR    | **FIXED**                 | `design.md:209-212`; A12 now asserts `activate:false`, no pending ref, caller-projected active tab, and reconnect. Isolation/order gap remains: N-D.                  |
| M4    | MAJOR    | **FIXED**                 | `design.md:214-224`; `test-plan.md:119-130`. One stale mailto row remains: m1.                                                                                        |
| M5    | MAJOR    | **FIXED**                 | `design.md:317`; A16/A17.                                                                                                                                             |
| M6    | MAJOR    | **FIXED**                 | `design.md:307-314`; TL-T2; prototype carries full-URL/footer/switch.                                                                                                 |
| M7    | MAJOR    | **FIXED**                 | `design.md:315`; A25; prototypes 08/15 and `closeAll` restore the pre-open keyboard and focus.                                                                        |
| M8    | MAJOR    | **FIXED**                 | `design.md:226-240`; A18–A21; legacy preselection, switch table, write failure, and async `ask` are explicit. One-time cleanup remains vague: m3.                     |
| M9    | MAJOR    | **FIXED**                 | `design.md:263-265` pins `zh`, caching, reset, and the mandatory Chrome-74 path; G19–G22.                                                                             |
| M10   | MAJOR    | **FIXED**                 | `test-plan.md:107-117`; mapping exists. Omissions remain: m5.                                                                                                         |
| M11   | MAJOR    | **FIXED**                 | `design.md:257-260`; B13/B14/B16; prototypes declare the non-goals.                                                                                                   |
| M12   | MAJOR    | **FIXED (selection)**     | `tasks.md:79-84`; TL-S3 owns seed/model/drag/selectAll/eviction/document-scope. Link merge order is a new gap: N-D.                                                   |
| m1–m7 | MINOR    | **FIXED**                 | English copy, URL presentation, no prefbar/undo, a11y, failure states, folder/floating, prototype placement/link styling, 500 ms overlay + menu are all present.      |

---

## Findings

- **[MAJOR] N-A — `C++` and `100%` are still impossible under the post-merge rule.** `design.md:301` merges two tokens only when both sides contain a letter/number and only punctuation separates them. `Intl.Segmenter('zh')` yields `C` + `+` + `+` and `100` + `%` (verified 2026-11-10); there is no right-hand alphanumeric token, so neither can be reconstructed. If the fallback base token already contains the trailing punctuation, the next bullet (`design.md:302`) trims leading/trailing punctuation and can strip the `+`/`%` again. `test-plan.md:171` (G22) nevertheless requires each of `foo-bar`, `key=value`, `a@b.com`, `C++`, `100%`, `a#b` to be one token under both Segmenter states. **Impact:** long-press copy regresses on common shell/log tokens on every WebView, and G22 cannot pass. **Fix:** add an attached-trailing-punctuation rule for the pinned join set (absorb adjacent punctuation tokens into the neighbouring alphanumeric token, or make the base tokenizer run the legacy `WORD_RE` class), and scope trimming to sentence punctuation (`。，、；：！？` etc.), never the join set. Add exact G22 model/select/copy vectors under Segmenter present and deleted.

- **[MAJOR] N-B — Long-CJK results depend on which tokenizer ran, so G19/G20 and G26–G28 cannot all pass.** `design.md:250-251` selects whole adjacent CJK tokens up to six characters, while `design.md:252` gives a fallback token longer than six a six-character window starting at `tapChar`. `test-plan.md:168-169` (G19/G20) requires G1–G27 to be identical with Segmenter present and deleted. But for `春夏秋冬风花雪`, Segmenter yields `春夏秋冬` / `风` / `花` / `雪`, so the whole-token rule from `风` yields `风花雪` (3 characters), not G28's `夏秋冬风花雪` (`test-plan.md:177`). Conversely, under the fallback the 9-character `中华人民共和国万岁` is one long token, so `design.md:252` yields `人民共和国万` / `民共和国万岁` (6 characters), not G26/G27's 5-character token-boundary results (`test-plan.md:175-176`). **Impact:** the mandatory Chrome-74 path and the modern path produce different cells and copied text; the exact-cell tests cannot be satisfied by both. **Fix:** choose one semantics. Either make the rule tokenizer-independent (for example the old six-character window around the tapped character, and update G26/G27 to six-character results), or accept per-tokenizer outputs and split G26–G28 into separate Segmenter/fallback rows, removing long-run vectors from G19/G20's “identical” set. Add G28 to the tokenizer-state matrix.

- **[MAJOR] N-C — End-exclusive handle coordinates are undefined when the handles cross.** `design.md:286-293` assigns the start handle a start cell and the end handle an `endExclusive` boundary, but does not define how `selRange` orders two values from different coordinate spaces. The current `selection-range.ts:44-64` orders raw coordinates and swaps, and `selection-overlay.ts:70-87` writes the tapped cell directly into `anchor`/`focus`. Example: start handle at cell 5; drag the end handle to glyph start 2, so `endExclusive=3`. Ordering yields `[3,5)`, excluding both the dragged cell 2 and the fixed cell 5; the intended flipped span is `[2,6)`. Dragging the start handle past `endExclusive` makes `start > end` and feeds a zero/negative length to `term.select`. **Impact:** handle crossing copies the wrong text; B17 only drags each handle into a wide glyph, so no case covers it. **Fix:** choose one policy — clamp each handle at the other, or keep both handles as cell anchors and derive `start = snapToGlyphStart(lowerCell)` and `endExclusive = snapToGlyphEnd(upperCell)` after ordering. Update `selRange`/`isStartFirst` in TL-S3 and add start-crosses-end and end-crosses-start cases asserting model, `term.select`, and copy.

- **[MAJOR] N-D — Background remote open is not isolated from the activating create path, and the merge order exposes the old behavior.** `design.md:210` and `tasks.md:60` add `activate:false`, but the only implementation is `handleCreateBrowser` (`mobile/src/session/use-mobile-session-content-create-actions.ts:90-142`), which sends `activate:true` and sets `pendingBrowserFocusPageIdRef` (lines 115-130). That function is also used by the New Browser flow (`mobile/src/session/MobileSessionSheets.tsx:345`) and by HTML/file open (`mobile/src/session/use-mobile-session-file-actions.ts:38`). Changing it in place would silently make those flows background; no task or test covers them. In addition, `tasks.md:70` places T4/T4A after T3/T3A and T5–T8, so until T4A the new sheet's remote action can still call the activating create — the phone-switch bug is locally green until the last tests. **Impact:** the core “phone stays on the terminal” promise can regress for the sheet's intermediate commits, and the existing New Browser/HTML flows can regress at the end. **Fix:** add a separate background-create function or an explicit `{activate:false, focus:false}` parameter used only by the terminal-link path; keep the existing callers `activate:true` with the pending ref; add regression tests for the New Browser and HTML/file callers. Move T4/T4A immediately after T3/T3A (or fold them into T3) so the first sheet wiring is already capability-gated and non-activating.

- **[MINOR] m1 — TL-A10 still says `mailto → 本机`.** `test-plan.md:36` contradicts `test-plan.md:128` (TL-L5) and `design.md:223` (non-goal, no matcher). Change TL-A10 to “mailto: non-goal; existing tap behavior” so no local-open implementation is implied.

- **[MINOR] m2 — Old-host presentation is hidden in the design and disabled in the prototype, and A15 allows either.** `design.md:211` says the old host hides remote; `terminal-link.html:861-883` and `ui/README.md:39` show a disabled action with an update prompt; `test-plan.md:187` says “禁用/隐藏”. Choose one and make A15 assert it. Keep folder/floating hidden as a separate rule.

- **[MINOR] m3 — The one-time legacy migration is optional and untested.** `design.md:238` says the old key is read once and “可写 ask 或删除旧键”; the “可” leaves the old key in place, so every later sheet can preselect again. A20 (`test-plan.md:192`) only checks the first open. Make the migration mandatory (write `ask` or delete the old key on first read), and add a second-open assertion that no preselection appears and core storage reads v2 only.

- **[MINOR] m4 — The settings-screen “ask” option has no owner in the superseding task table.** `design.md:197` and test A9 require restoring “每次询问”, but `tasks.md §5.1` TL-T1A only names `preferences.ts`, `use-mobile-session-screen-state.ts`, and `preferences.test.ts`; `browser-settings-screen.tsx:14-24` still enumerates only two modes. The old TL-T1 row mentions the settings page, but §5.1 declares itself authoritative. Add the settings-screen file and a component test for A9 to TL-T1A/TL-T9.

- **[MINOR] m5 — AC mapping still has omissions and a duplicate regression ID.** `test-plan.md:111` omits A4/A5/A10/A11 from AC1; line 112 omits B8/B9/B13/B14/B18/B19/B20 and G19–G22 from AC2; line 113 omits G28 from AC3; lines 223-224 both use `R9` for different checks. Map AC1 to A1–A29, AC2 to B1–B20 plus G1–G28 (with tokenizer qualifiers), AC3 to G9–G11/G25–G28, and renumber the test-command check.

- **[MINOR] m6 — The blank-cell rule still has a glyph-fallback sentence that can be read as selecting an empty cell.** `design.md:255` says “无任何 token 时选中命中 cell 对应的完整 glyph”; B20 (`test-plan.md:214`) and prototype state 15 require no selection for a blank/end-of-line cell. State explicitly that a blank/whitespace-only snapped cell creates no selection and that the glyph fallback applies only to a non-blank cell with no token. Add a mid-line isolated-space case with no token in range.

- **[MINOR] m7 — Eviction remains unfalsifiable.** `test-plan.md:211` accepts “model 正确或清空”, which a “clear on any buffer-full feed” implementation passes. Define two exact cases: selection still inside the buffer after eviction (rows shift by one, model and copied text unchanged, `endExclusive` preserved) and selection's oldest row evicted (model cleared, overlay hidden, `selection-evicted` notified). Assert model plus `getSelection`/copy, not only “no crash”.

- **[MINOR] m8 — A22's “隐藏 userinfo” is not scoped to the summary.** `test-plan.md:194` says hide userinfo; the prototype hides it in the summary but shows `deploy@` in the expanded full URL (`terminal-link.html:234`). State whether userinfo is hidden only in the summary (current prototype) or everywhere, and add a vector for each display mode.

- **[MINOR] m9 — The capability source named in the design is not plumbed by the task's file list.** `design.md:211` requires “host status readable” in addition to the capability, but TL-T4 (`tasks.md:59`) only names the create-actions file; `mobile/src/session/use-mobile-session-foundation.ts:41` destructures only `hostCapabilities`, while `useHostStatusGates` (via `HostProtocolGate.tsx:15-21`) carries `statusReadable`/`statusPending`. Add the foundation/gates file to TL-T4 and a component case for the unknown/unreadable state.

- **[MINOR] m10 — The copy action row says “不关闭 ask” while the sheet closes on Copy.** `design.md:232` reads as “does not close the ask [sheet]”, but `design.md:87` and prototype state 01 close the sheet after copying. Reword to “does not change the ask mode; the sheet closes” (or align the implementation if the sheet is meant to stay open).

---

## Requirement coverage

- **点击链接弹框（本机/远程/复制/取消）**: **基本覆盖**. `activate:false`, the new capability, A12, preselection, switch table, URL presentation, guards, and prototypes are in place. N-D is the remaining implementation-order/regression gap; m1/m2/m4/m9 are polish.
- **中文/英文/emoji/混排/折行长按不错位**: **部分覆盖**. Seed geometry and G1–G18 are exact. N-A and N-B still make punctuation and long-CJK results wrong or tokenizer-dependent.
- **空白/标点选附近词，不选空/整行**: **覆盖** for the defined cases; m6 is a wording clarification.
- **高亮与复制一致、手柄按 cell**: **部分覆盖**. Seed/selectAll/end-of-line are specified; N-C leaves crossing handles undefined and untested.
- **不影响输入/滚动/OSC/路径/复制/全选**: **覆盖** in intent. R6–R9 are corrected; m5 is a mapping/ID hygiene issue.
- **记住选择/设置恢复每次询问**: **覆盖**. v2 key, preselection-only, switch-off, write failure, async `ask`, and A18–A21 are explicit; m3/m4 are residuals.
- **Chrome 74 / Segmenter fallback**: **部分覆盖**. Locale, cache, reset, fullwidth, and constructor/segment failure are pinned; N-A/N-B show the fallback and Segmenter cannot produce the same claimed results for punctuation words and long CJK runs.
- **测试可证伪性**: **部分覆盖**. G1–G18 are strong; N-B, m7, and m5 keep some producer expectations weak.
- **任务拆分/顺序**: **部分覆盖**. Selection is atomic; N-D leaves the link merge order and shared create path unsafe.
- **原型**: **覆盖**. State 13/14 annotations now match the rendered cells; the 500 ms overlay plus menu, keyboard restore, floating/folder, old-host, remember, and legacy states are present. m2 is the only cross-artifact mismatch.
- **无障碍/失败态/文件夹/OTA**: **覆盖** in design and cases; remaining work is verification, not a design blocker.

---

## 建议修改（按优先级）

1. Fix N-B first: decide whether long-CJK selection is token-boundary or character-window semantics, then update the design examples, G19/G20, and G26–G28 together.
2. Fix N-A: add attached trailing punctuation to the join rule or use a tokenizer path that preserves it; scope trimming to sentence punctuation.
3. Fix N-C: define handle-crossing/clamping and add both crossing tests.
4. Fix N-D: isolate the background create from the shared `handleCreateBrowser`, and move T4/T4A before the sheet entry in the merge order.
5. Apply m1–m10; they are cheap and mostly remove stale/ambiguous expectations.
