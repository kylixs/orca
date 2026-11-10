# Mobile terminal link selection — UI prototypes

> Feature: `2026-11-10-mobile-terminal-link-selection`
> Gate: G2 UI prototype (`DEVELOPMENT_PROCESS.md` §3)
> Revised against `design.md` §7, `test-plan.md` §5, and `tasks.md` §5 (TL-U1..U3).

## Prototype location

The HTML prototypes live in the shared prototype directory:

| Prototype | Path | Purpose |
|---|---|---|
| Terminal link sheet | [`../../ui-prototypes/terminal-link.html`](../../ui-prototypes/terminal-link.html) | Link tap → Open on this phone / Open in Orca on desktop / Copy link / Cancel, background desktop open, URL review, capability states, legacy preselection, floating workspace, keyboard and tab-switch behavior |
| Terminal selection | [`../../ui-prototypes/terminal-selection.html`](../../ui-prototypes/terminal-selection.html) | 500 ms long-press overlay and menu, wide-character geometry, nearby phrase selection, long CJK runs, blank/end-of-line, handles, and the Copy / Select All menu |
| Prototype index | [`../../ui-prototypes/index.html`](../../ui-prototypes/index.html) | Entry point linking both prototypes and the other mobile flows |

Open either file directly in a browser. Both are single self-contained HTML files with no external dependencies, fixed 390 × 844 dark phone frames, practical ARIA labels/roles, and clickable interactions. No build step or server is required.

## English copy is normative

The implementation uses English UI copy, consistent with the existing mobile app. The English strings in these prototypes are the normative copy for implementation. The Chinese design, test, and task documents are explanatory context only; Chinese text inside the prototypes is terminal test data (CJK, emoji, NFD, fullwidth vectors), not product copy.

This supersedes the earlier Chinese-only prototype copy.

## terminal-link.html — states

1. **Terminal — tap a URL** (`#link-terminal`): URLs are not underlined or recolored; tapping one opens the sheet. File links and OSC file links keep the existing file-tap path.
2. **Open link — remote available** (`#link-choice`): URL summary shows scheme + host + port only and omits userinfo. Show / Hide full URL expands the complete URL, which retains userinfo after bidi/control-character filtering. Actions: Open on this phone, Open in Orca on desktop, Copy link, Cancel. Remote hint: “Opens in a desktop Orca tab in the background; your phone stays on this terminal.” Remember defaults off.
3. **Plain HTTP + loopback hint (SSH session)** (`#link-http-loopback`): plain-HTTP warning plus the localhost / 127.0.0.1 / private-range hint: “Usually not reachable from this phone; desktop open uses the desktop Orca browser.” The SSH session names the remote host (`dev-box-01`).
4. **Remote disabled — desktop offline** (`#link-offline`): disabled remote action with reason and Retry.
5. **Creating browser — double tap ignored** (`#link-creating`): disabled/loading remote action while a background desktop tab is created; double taps are ignored and there is no retry while creating (prevents duplicate tabs).
6. **Remote disabled — capability unknown** (`#link-unknown`): disabled remote action with reason and Retry.
7. **Folder workspace — remote hidden** (`#link-folder`): remote action is hidden, not disabled; phone / copy / cancel remain, with a reason.
8. **Keyboard open before — restored on close** (`#link-keyboard`): starts with the keyboard open; tapping the URL dismisses it first and then presents the sheet. Closing the sheet restores the pre-open state, so the keyboard reopens.
9. **Remote opened — phone stays here** (`#link-remote-opened`): post-action state. A desktop Orca tab is created in the background; the desktop is not focused, this phone remains on the terminal, and no phone browser tab switch is shown.
10. **Terminal tab switched — sheet dismissed** (`#link-tab-switch`): switching terminal tabs dismisses the sheet and discards the pending choice.
11. **Remember on — Copy and Cancel never save** (`#link-remember-on`): Remember defaults off. When on, only the two Open actions write the preference. Copy link does not change Ask mode and the sheet closes after copying; Cancel also leaves the preference unchanged. There is no “remembered” prefbar and no undo snackbar.
12. **Legacy preference — one-time preselection** (`#link-legacy`): a stored `orca-browser` / `phone-browser` value highlights the matching action once (“Last used”). Nothing opens automatically and Remember stays off. Migration is conditional: only when v2 does not exist, the old key is read once, used for this preselection, then `orca:terminalLinkOpenMode:v2 = ask` is written and the old key is deleted. If v2 already exists, its value is preserved and only the old key is deleted. A second open has no “Last used” preselection.
13. **Old host — background create unavailable** (`#link-old-host`): the host lacks `browser.tab-create-background.v1`; remote stays visible but disabled with “Update Orca on the host to open links here.” It never silently falls back to an activating desktop tab. This is distinct from folder/floating workspaces, which hide the action.
14. **Floating workspace — remote hidden** (`#link-floating`): remote is hidden; the sheet still offers Open on this phone, Copy link, and Cancel, with a reason.
15. **Keyboard closed before — stays closed** (`#link-keyboard-closed`): the keyboard is closed when the URL is tapped; closing the sheet restores the pre-open state and the keyboard stays closed.
16. **Full URL expanded — userinfo retained after filtering** (`#link-full-url`): the summary still hides userinfo; the expanded full URL shows `deploy@` after bidi/control characters are filtered. The action list and Remember state are unchanged.

Touch targets: every interactive control in the sheet exposes an effective hit area of at least 44 × 44 — the URL toggle and Retry are 44 px tall, the Remember switch is 46 × 44, sheet actions and Cancel are 52 px tall, and the inline terminal URL uses a 44 px hit area without changing line height.

Traceability: design §7.1–7.3, §7.6; test-plan A12–A29; tasks TL-U1.

## terminal-selection.html — states

Cell numbers in the annotations are 0-based and refer to the bare test-vector row in each phone. Prompt, command, and history rows are context only and carry no vector coordinates.

1. **500 ms — overlay and menu while holding** (`#select-hold`): the overlay, handles, **and** Copy / Select All menu appear at 500 ms while the finger is still down; release is not required. Tapping cell 4 (`，`) in `修复，登录流程` selects the left `修复` (gap 0 left vs gap 1 right, span `[0,4)`).
2. **中文abc — right half of 文** (`#select-cjk`): tap cell 3 snaps to the glyph start and selects `中文`, not `abc`.
3. **中文😀English — emoji right half** (`#select-emoji`): tap cell 5 snaps to cell 4 and selects only `😀`.
4. **中文😀English — tap E** (`#select-english`): tap E selects `English` with the correct start cell.
5. **验证 权限边界 & token — tap &** (`#select-and`): both neighbours are one empty cell away; the tie goes left and selects `权限边界` (span `[5,13)`).
6. **CJK merge — 登录流程** (`#select-merge`): Segmenter splitting `登录` + `流程` merges back to the 4-character run `登录流程` (under the 5-character window, span `[6,14)`). The window is tokenizer-independent.
7. **中文 abc — tap space** (`#select-space`): both gaps are zero; the tie goes left and selects `中文`.
8. **Fullwidth ＡＢＣ１２３** (`#select-fullwidth`): a tap on the right half of `Ｂ` selects the whole 12-cell fullwidth token.
9. **NFD é** (`#select-nfd`): `e` + U+0301 is one cell but two UTF-16 code units; the whole grapheme is selected.
10. **Wrapped line — KLMNOP** (`#select-wrap`): with cols = 10, tapping K on the second row selects only that row; the v1 word seed does not merge across the wrap.
11. **Handle drag across a wide glyph** (`#select-drag`): the end handle dragged into the right half of `😀` stores the glyph-start anchor (cell 4); the derived endExclusive is 6, so copied text equals the highlight.
12. **Selection menu — Copy / Select All** (`#select-menu`): the active-selection menu copies exactly the highlighted text; Select All selects the buffer.
13. **Long CJK run — tap 人** (`#select-long-run-start`): in the 9-character run `中华人民共和国万岁`, tapping 人 (character index 2) selects the 5-character window `人民共和国` (characters `[2,7)`), span `[4,14)`, `term.select(4,row,10)`. The window is fixed at 5 characters and does not depend on tokenizer output.
14. **Long CJK run — tap 国** (`#select-long-run-end`): tapping 国 (character index 6) clamps the window start to `runEnd − 5 = 4`, so the selection is `共和国万岁` (characters `[4,9)`), span `[8,18)`, `term.select(8,row,10)`. No token boundaries are consulted.
15. **Blank / end of line — only case with no selection** (`#select-blank`): only a blank/end-of-line cell produces no selection and no handles; Copy is disabled and Select All remains available. Blank/end-of-line is the only no-selection case; a non-blank glyph with no token uses glyph fallback (state 21). A blank cell between two tokens still selects the nearest token (B20a).
16. **7-char CJK run — tap 风** (`#select-long-run-window`): in `春夏秋冬风花雪`, tapping 风 (character index 4) clamps the start to `runEnd − 5 = 2`, selecting `秋冬风花雪` (characters `[2,7)`), span `[4,14)`, `term.select(4,row,10)`. Segmenter present or absent produces the same span.
17. **Handle crossing — start past end** (`#select-cross-start`): selection `bc` has glyph-start anchors at cells 1 and 2; dragging the start handle past the end to cell 5 passes through the equal point at anchor 2, where the span is `[2,3)` and Copy is `c` — during drag keeps a single-glyph span; release at equal clears. Continuing past the anchor and releasing there orders the anchors, giving start = `snapToGlyphStart(2)` = 2 and endExclusive = `snapToGlyphEnd(5)` = 6. The final span is `[2,6)`, Copy is `cdef`, `term.select(2,row,4)`, and the handle roles reverse. No negative length reaches `term.select`.
18. **Handle crossing — end before start** (`#select-cross-end`): selection `bcd` has glyph-start anchors at cells 1 and 3 (the end handle stores the glyph start of `d`); dragging the end handle before the start to cell 0 passes through the equal point at anchor 1, where the span is `[1,2)` and Copy is `b` — during drag keeps a single-glyph span; release at equal clears. Continuing before the anchor and releasing there orders the anchors, giving start = `snapToGlyphStart(0)` = 0 and endExclusive = `snapToGlyphEnd(1)` = 2. The final span is `[0,2)`, Copy is `ab`, `term.select(0,row,2)`, and the handle roles reverse. No negative length reaches `term.select`.
19. **Handle crossing — wide glyph on the crossed side** (`#select-cross-wide`): in `中文abc`, selection `文a` has glyph-start anchors at cells 2 and 4; dragging the start handle past the end to `c` at cell 6 passes through the equal point at anchor 4, where the span is `[4,5)` and Copy is `a` — during drag keeps a single-glyph span; release at equal clears. Continuing past the anchor and releasing there orders the anchors, giving start 4 and endExclusive 7. The final span is `[4,7)`, Copy is `abc`, and `term.select(4,row,3)`; the wide glyph `文` is on the crossed side and stays outside the span. No negative length reaches `term.select`.
20. **Handle crossing — wide fixed upper anchor** (`#select-cross-wide-fixed`): in `中文abc`, selection `文a` has glyph-start anchors at cells 2 (`文`, wide) and 4 (`a`); dragging the end handle before the start to `中` at cell 0 passes through the equal point at anchor 2, where the single-glyph span is `[2,4)` and Copy is `文` — during drag keeps a single-glyph span; release at equal clears. Releasing before the anchor orders the anchors, giving start 0 and endExclusive = `snapToGlyphEnd(2)` = 4, not upper + 1. The span is `[0,4)`, Copy is `中文`, and `term.select(0,row,4)`, proving the fixed upper anchor keeps its full two-cell width.
21. **Isolated non-blank glyph — select `&`** (`#select-isolated-glyph`): a blank or end-of-line cell is the only case that creates no selection. In this row, `&` is at cell 14 with 10 blank cells between `&` and the left token, and 10 between `&` and the right token, so no token is within ±8. The pressed cell is non-blank, so glyph fallback selects the full glyph: span `[14,15)`, `term.select(14,row,1)`, Copy `&`.

All interactive controls keep an effective hit area of at least 44 × 44: the app-bar icon buttons are 44 × 44, and the selection menu buttons (`.editmenu button`) are 44 px tall with at least 44 px width. The through-equal traces and glyph-fallback annotations are non-interactive and do not reduce any touch target.

The Non-goals section (`#selection-notes`) records, as explicit non-goals:

- Pinch zoom cancels selection (existing `cancelSelect`); no preserved selection is promised.
- Rotation / refit may clear the selection; only a consistent, non-crashing state is required.
- No release-time word-boundary snapping in v1; drag endpoints stay on cell boundaries, so copy equals the highlight.
- Horizontal pan is only reachable when content is wider than the viewport; selection coordinates follow the pan.
- The v1 word seed handles the current buffer line only; manual drag can cross lines.
- Only a blank/end-of-line cell creates no selection; a non-blank isolated glyph falls back to selecting that glyph.
- Handle crossing is not a non-goal: the selection survives the equal-anchor moment during drag, and clears only when released with equal anchors.

Traceability: design §7.1.6–7.1.8, §7.2 (including §7.2.2 handle crossing and §7.1.6 blank vs non-blank glyph fallback); test-plan §5.3 (G1–G18, G26–G30), §5.6 (B13/B14/B16/B17/B17a/B17b/B17b2/B17d/B20/B20a); tasks TL-U2.

## Out of scope

`file-actions.html` and `html-open-modes.html` are owned by another prototype workstream and are intentionally not modified here. The shared `index.html` was updated only to link the revised terminal states.
