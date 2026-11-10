# 设计评审 04

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`terminal-link.html`、`terminal-selection.html`，以及设计引用的 mobile terminal/session 与 host publication 源码
日期：2026-11-10
Reviewed snapshot（sha256 前 8 位）：design `d341cab3`、test-plan `fc4cb6b1`、tasks `21790a98`、ui/README `4e4a359a`、terminal-link `f4f032cb`、terminal-selection `37e5a47a`。
结论：**REJECTED**

New findings: **0 BLOCKER / 1 MAJOR / 3 MINOR.**
Prior findings: **N-A / N-B / N-D FIXED (N-A、N-D 仍有 minor 残留); N-C STILL OPEN (MAJOR); m1/m4/m7/m8/m9/m10 FIXED; m2/m5 STILL OPEN (MINOR); m3/m6 FIXED (minor 残留).**
Unresolved total: **0 BLOCKER / 2 MAJOR / 9 MINOR.**

---

## Prior findings

| ID | Severity | Status | Evidence |
|---|---|---|---|
| N-A | MAJOR | **FIXED (minor residual)** | `design.md:298-302` adds the suffix-attachment rule for `+`/`#`/`%` and scopes trimming to sentence punctuation, so `C++`/`100%`/`a#b` are constructible and G22 now names both Segmenter states (`test-plan.md:171`). G22 still has no exact cell/`term.select`/copy vectors, and repeated suffix attachment (`C++`) is not stated as iterative: N-A-minor. |
| N-B | MAJOR | **FIXED** | `design.md:247-252` replaces the six-character/token-dependent rule with the tokenizer-independent 5-character window (`start = clamp(tapCharIndex, runStart, runEnd - 5)`); `test-plan.md:175-177` G26/G27/G28 now exactly match the design; G19/G20 require identical G1..G28 under both tokenizer states. |
| N-C | MAJOR | **STILL OPEN (narrowed)** | `design.md:285-286` still mixes two representations: the end handle is described as `snapToGlyphEnd` (an exclusive boundary), then both handles are described as glyph-cell anchors normalized with `snapToGlyphStart(lower)` / `snapToGlyphEnd(upper)`. `terminal-selection.html:742,753` state 17 uses exclusive anchors (1 and 3) and expects `[3,6)`/`def`; under the line-286 cell-anchor policy the fixed end anchor is 2 and the result is `[2,6)`/`cdef`. B17b (`test-plan.md:212`) has no exact span/copy, so either reading passes. |
| N-D | MAJOR | **FIXED (minor residual)** | `design.md:208`; `tasks.md:60` TL-T4A require a separate `handleCreateBackgroundBrowser` with `activate:false`, no pending ref, existing New Browser/HTML/file callers kept `activate:true`; `tasks.md:70` places T4B → T4/T4A before T1A/T2/T3. Test-plan has no explicit New Browser/HTML/file regression case: N-D-minor. |
| m1 | MINOR | **FIXED** | `test-plan.md:36` TL-A10 and `test-plan.md:128` TL-L5 now say `mailto` is a non-goal and keeps existing tap behavior; `design.md:221`. |
| m2 | MINOR | **STILL OPEN** | `design.md:209`, `test-plan.md:187` A15, `terminal-link.html:877`, `ui/README.md:39` all say old host = disabled + update prompt, while `tasks.md:61` TL-T4B still says “旧 host 无能力时手机隐藏远程项”. Folder/floating hiding is correctly separate. |
| m3 | MINOR | **FIXED (minor residual)** | `design.md:236` makes migration mandatory (write v2 `ask`, delete old key); `test-plan.md:192` A20 now asserts the second open has no preselection. The first-read timing still conflicts with the existing focus hook: `use-mobile-session-preference-focus.ts:44-54` loads the mode on focus, before the first sheet; if migration lives in that loader, A20's first-open preselection cannot appear. |
| m4 | MINOR | **FIXED** | `tasks.md:54` TL-T1A now names `settings/browser-settings-screen.tsx` and tests; A9 remains in `test-plan.md:35`; `browser-settings-screen.tsx:14-24` is the file to extend. |
| m5 | MINOR | **STILL OPEN** | `test-plan.md:225-226` still uses `R9` for both the clipboard-seam check and the test-command check. The rest of the AC map (`test-plan.md:111-114`) now covers A1–A29, B1–B20, G1–G28, and G25–G28. |
| m6 | MINOR | **FIXED (minor residual)** | `design.md:251`, `test-plan.md:216` B20, `test-plan.md:178` G29, and `terminal-selection.html:675-690` state 15 now say a blank/end-of-line cell with no token creates no selection and glyph fallback only applies to a non-blank cell. B20's wording still overreaches: see m6-minor. |
| m7 | MINOR | **FIXED** | `test-plan.md:213` B17c now gives the two exact eviction outcomes: rows shift/text unchanged/endExclusive preserved; oldest row evicted → model cleared/overlay hidden/`selection-evicted`. |
| m8 | MINOR | **FIXED** | `design.md:240`; `test-plan.md:194` A22; `terminal-link.html:235,1047` and state 16 show summary without userinfo and expanded full URL with `deploy@` after bidi/control filtering. |
| m9 | MINOR | **FIXED** | `tasks.md:59` TL-T4 now names `use-mobile-session-foundation.ts` and `HostProtocolGate`; `design.md:209` names `statusReadable`; A15 covers unknown/offline/old host. `use-mobile-session-foundation.ts:41` currently destructures only `hostCapabilities`, which is what the task must extend. |
| m10 | MINOR | **FIXED** | `design.md:230` now reads “不写偏好、不改变 ask 模式；sheet 复制后关闭”; `terminal-link.html:239` and state 11 match. |

---

## Findings

- **[MAJOR] N-C — Handle-crossing normalization is still two coordinate models, and the only exact prototype vector contradicts the chosen one.** `design.md:285` says dragging the end handle stores `snapToGlyphEnd(tapCell)` (an exclusive boundary). `design.md:286` then says both handles are stored as “包含该 glyph 的 cell 锚点”, sorted, and normalized to `start=snapToGlyphStart(lower)` and `endExclusive=snapToGlyphEnd(upper)`. Those cannot both be the stored model for the end handle. `terminal-selection.html:742,753` (state 17) says selection `bc` has anchors at 1 and 3 and, after dragging the start to cell 5, yields `[3,6)` / `def`; under the cell-anchor policy the end anchor of `bc` is 2, so the ordered span is `[2,6)` / `cdef` and `term.select(2,row,4)`. State 18 (`terminal-selection.html:774,785`) happens to yield `bcd` under either reading because the dragged end replaces the old one, but its stated end anchor 5 is also the exclusive boundary, so the same ambiguity is present. `test-plan.md:212` B17b only says “correct” with no expected span/copy, so a one-character error passes. Current source still sorts raw coordinates (`selection-range.ts:44-64`) and writes tapped cells directly (`selection-overlay.ts:70-87`); the visible-menu and mouse-drag producers are also not named in TL-S3 (`selection-menu-buttons.ts:29-35`, `host-message-router.ts:134-138`, `mouse-click-drag.ts:116-127`). **Impact:** crossing handles still copies a different character than the design intends, and the prototype/design/test plan cannot agree on the expected text. **Fix:** choose one representation. Recommended: keep both raw anchors as glyph cells (`drag end` stores the glyph cell, `endExclusive` is derived), then state 17 must become `[2,6)` / `cdef`; alternatively, keep exclusive end anchors and recompute both crossing examples (including the review-03 `[2,6)` example) with an explicit conversion rule. Add exact B17b vectors for both crossing directions, including a wide glyph on the fixed side, asserting model + `term.select` + copy; add `selection-menu-buttons.ts`, `mouse-click-drag.ts`, and `document-scope.ts` to TL-S3.

- **[MAJOR] N-E — A remembered `orca-browser` preference bypasses the capability/workspace gates that protect the remote action.** `design.md:89` and `design.md:228-229` say a remembered choice is used to directly open on subsequent taps; `design.md:73` still says `handleTerminalOpenUrl` only sets a pending choice; `design.md:209-211` and A4/A15/A27 require old host / offline / unknown / creating / folder / floating to disable or hide the remote action and show a hint, never silently. `design.md:235` makes the preference global per device, not per host. None of A8/A15/A18/A20/A21 or the prototype states 04/06/07/13/14 cover “stored mode = `orca-browser` and remote is now unavailable” (the prototypes all start with Remember off). **Impact:** a user who remembered remote on a capable host, then opens a link on an old host, while offline/creating, or in a folder/floating workspace, can take the direct-open branch instead of the sheet. That may call the activating `handleCreateBrowser` (phone leaves the terminal), or the new background function without the capability check, and no disabled/hint state is shown. **Fix:** in `handleTerminalOpenUrl`, direct-open only when `mode !== 'ask'` and the preferred action passes the same client/`statusReadable`/capability/creating/workspace checks as the sheet; otherwise show the sheet with remote disabled/hidden and the hint (or downgrade the stored mode to `ask`). Add cases for stored `orca-browser` + old host/offline/unknown/creating/folder/floating, asserting no `browser.tabCreate` call/projected active tab stays terminal, and decide whether the stored preference is downgraded.

- **[MINOR] m2-minor — `tasks.md:61` still hides the remote action on an old host.** Change TL-T4B to “旧 host 无能力时远程项禁用 + update prompt；folder/floating 隐藏” and make the task assert the prompt, matching `design.md:209`, `test-plan.md:187`, `terminal-link.html:877`, and `ui/README.md:39`.

- **[MINOR] m3-minor — Legacy preselection timing is not defined against the existing focus load.** `use-mobile-session-preference-focus.ts:44-54` loads `terminalLinkOpenMode` on every focus, and `use-mobile-session-screen-state.ts:46` starts at `orca-browser`. If the mandatory migration is implemented in `loadTerminalLinkOpenMode`, the legacy key is consumed before the first sheet, so A20’s “first open preselected” never happens. State the first-read point (first sheet open) and keep the legacy value in screen state until then; add a component test that mounts the session, completes the load, opens the first sheet with preselection, and opens the second sheet without it. Add `use-mobile-session-preference-focus.ts` to TL-T1A or explicitly exclude it.

- **[MINOR] m5-minor — Duplicate `R9` remains.** `test-plan.md:225` (clipboard seam) and `test-plan.md:226` (test commands) both use R9. Renumber the test-command row (for example R10) and update AC5.

- **[MINOR] m6-minor — B20 says any mid-line space creates no selection, which contradicts G7.** `test-plan.md:216` groups “空行/全空白行/行中孤立空格” under “空白 cell 不建立选区…（唯一预期）”, but `test-plan.md:144` G7 taps the space in `中文 abc` and expects `中文`, and `design.md:245` requires the nearest-token rule for whitespace. Split B20 into (a) empty/all-whitespace line or mid-line space with no token within ±8 → no selection, and (b) mid-line space between tokens → nearest token (G7).

- **[MINOR] N-A-minor — G22 lacks exact vectors and repeated suffix attachment is not stated.** `test-plan.md:171` says each of `foo-bar`/`key=value`/`a@b.com`/`C++`/`100%`/`a#b` is one token under both tokenizer states and copies whole, but gives no `start`/`endExclusive`/`term.select` values; `Intl.Segmenter('zh')` yields `C` + `+` + `+`, so `design.md:299` must say the `+`/`#`/`%` suffix attachment is applied iteratively (or otherwise make `C++` reachable). Add the exact rows and a note that trimming never removes the join set.

- **[MINOR] N-D-minor — The existing New Browser/HTML/file callers have no test-plan case.** `design.md:208` and `tasks.md:60` require them to stay `activate:true` with the pending ref, but A12 only covers the new background path. Add component cases asserting `handleCreateBrowser` still sends `activate:true`, sets `pendingBrowserFocusPageIdRef`, and the existing flows still activate, so the isolated background function cannot be achieved by flipping the shared caller.

- **[MINOR] Task bookkeeping is stale.** `tasks.md:81` TL-S6 still says “G1..G25” although the test plan now has G1..G29 (G26–G28 CJK windows, G29 blank); `tasks.md:79` TL-S3’s file list omits `document-scope.ts` (named in the description) and the visible-menu/mouse-drag producers; `tasks.md:39` completion definition still lists only the old TL-T1..T7/TL-S1..S7/TL-R1..R3 IDs and omits TL-T1A/T2A/T3A/T4A/T4B/T9–T11, TL-S8, and TL-R6–R8. Update the ranges and file lists so the tasks match the authoritative sections.

- **[MINOR] The host-side capability publication predicate is unspecified.** `design.md:209` / `tasks.md:61` add `browser.tab-create-background.v1` to host status, but do not say when it is advertised. `src/main/runtime/orca-runtime-get-status.ts:69-92` conditionally filters `browser.screencast.v1` and `browser.tab-create-known-id.v1` on `canBrowse`/headless/client-host support; a statically advertised new capability would make the mobile enable remote on a host that cannot create a browser tab. Add the same predicate to TL-T4B and a host-status test.

- **[MINOR] Prototype touch targets are below the design’s 44 px and the prototype’s own annotation.** `design.md:173` and `terminal-selection.html:580` say the selection menu keeps 44 px touch targets, but `terminal-selection.html:99-106` sets `.editmenu button{height:40px}`. `terminal-link.html:125-128` makes the Remember switch 46×28, `:94` the URL toggle 38 px high, and `:118` the Retry button 32 px high. Raise the effective hit areas to at least 44×44 (wrapper/hitSlop) and update the annotation. `terminal-selection.html` states 17/18 should be re-rendered after N-C is resolved.

---

## Requirement coverage

- **点击链接弹框（本机/远程/复制/取消）**: **基本覆盖**. Isolated background create, capability naming, A12, URL presentation, guards, and prototypes are in place. N-E is the remaining behavior gap; m2-minor is a task-text contradiction.
- **中文/英文/emoji/混排/折行长按不错位**: **覆盖** for seeding and geometry. G1–G18 are exact; N-B is fixed; G26–G28 match the 5-character rule.
- **空白/标点选附近词，不选空/整行**: **覆盖** for the defined vectors; B20’s “any mid-line space” wording still conflicts with G7.
- **高亮与复制一致、手柄按 cell**: **部分覆盖**. Seed/selectAll/eviction/end-of-line are specified; N-C leaves the crossing copy text and exact vectors contradictory.
- **不影响输入/滚动/OSC/路径/复制/全选**: **覆盖** in intent; N-D-minor should add the existing New Browser/HTML/file regression cases, and the producer file list should be complete.
- **记住选择/设置恢复每次询问**: **部分覆盖**. Legacy migration and write semantics are fixed; N-E is the read-path gap when the remembered action is unavailable.
- **Chrome 74 / Segmenter fallback**: **覆盖**. Locale, cache, reset, fallback, CJK window, and G19–G22 are defined; G22 needs exact vectors for full falsifiability.
- **测试可证伪性**: **部分覆盖**. G1–G18 and G26–G29 are strong; B17b, B20, and G22 remain weak.
- **任务拆分/顺序**: **覆盖 in order**. T4B → T4/T4A → T1A → T2/T2A → T3/T3A removes the earlier regression window. Remaining issue is task bookkeeping, not ordering.
- **原型**: **基本覆盖**. 5-character window, migration, copy, old host, full URL, folder/floating, and keyboard states match. State 17’s crossing vector is wrong under the design’s cell-anchor rule; touch targets need adjustment.
- **无障碍/失败态/文件夹/OTA**: **覆盖** in design and cases; touch-target sizes are the remaining UI verification item.

---

## 建议修改（按优先级）

1. Resolve N-C first: choose one handle representation, rewrite the normalization paragraph, fix prototype state 17 (and the state 18 anchors), and add exact B17b vectors including a wide-glyph fixed side.
2. Resolve N-E: gate remembered direct-open by the same capability/workspace checks as the sheet; add stored-remote + unavailable cases.
3. Apply the m2/m3/m5/m6/N-A/N-D residuals; they are cheap and remove stale or unfalsifiable expectations.
4. Complete task bookkeeping (G1..G29, producer file list, DoD IDs), specify the host capability predicate, and fix the prototype touch targets.
