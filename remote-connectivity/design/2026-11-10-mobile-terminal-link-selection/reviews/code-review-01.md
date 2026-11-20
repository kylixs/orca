# Code review 01 — mobile terminal link sheet + CJK/wide selection

Scope: working-tree diff on `feat/remote-terminal-load-diagnostics` for the link-sheet and selection work, plus `design.md` §7, `test-plan.md`, `tasks.md`, `reviews/design-review-06.md`. Unrelated concurrent HTML/file-browser and remote-terminal-load-diagnostics changes were read only where they share reviewed files (`protocol-version.ts`, `orca-runtime-get-status.ts`).

Date: 2026-11-10
Verdict: **REQUEST CHANGES — 1 BLOCKER / 1 MAJOR / 6 MINOR**

The design decisions themselves are implemented faithfully (v2 migration, ask default, remember gating, direct-open re-gating, background create, capability gating, active-handle/in-flight guards, glyph anchors, end-exclusive derivation). The blocking issue is a runtime floor violation in the new tokenizer; the major issue is a copy-fidelity regression for paths/URLs that end with `/`.

---

## BLOCKER

### B1. `Array.prototype.at` makes the tokenizer throw on the declared WebView floor (Chrome 74 / iOS 15.1–15.3), silently disabling all word/phrase selection

**Where:** `mobile/src/terminal/document/text-tokenizer.ts:92`, `:227`, `:267` (`merged.at(-1)`).

**Failure scenario:** The terminal document is bundled with `target: 'chrome74'` (`mobile/scripts/build-terminal-document-script.mjs:20`) and the engine build explicitly shims post-Chrome-74 runtime APIs for the #7030 floor (`mobile/scripts/build-terminal-webview-engine.mjs:40-70`). esbuild lowers syntax, not built-ins, so the shipped document bundle still contains `merged.at(-1)` (verified in `terminal-webview-document-script.generated.ts`). `Array.prototype.at` only exists in Chrome 92+ / Safari 15.4+. On the minimum supported WebView (and iOS 15.1–15.3, which React Native 0.83 still supports) `mergeOverlappingSpans`/`mergeJoinable`/`mergeAdjacentCjk` throw `TypeError: merged.at is not a function`; the broad `catch` at `text-tokenizer.ts:302-305` swallows it and returns `[]`.

Result on those devices: every long press has no tokens, so `chooseSelection` falls through to the single-glyph fallback. Tapping an English word selects one character, tapping punctuation or whitespace selects nothing, and the pre-existing “long-press selects the word” behaviour is regressed as well. Verified directly:

```text
tokens after deleting .at: []
tokens normally: [{"start":0,"end":2,...},{"start":2,"end":5,...}]
```

**Why the tests miss it:** `selection-range.test.ts:224-240` (“Chrome 74 tokenizer fallback”) only deletes `Intl.Segmenter`, and `text-tokenizer.test.ts:85-93` does the same; both run on Node 24 where `.at` exists. The test therefore proves the Segmenter fallback, not the runtime floor it is named for.

**Fix:** replace the three `.at(-1)` calls with `merged[merged.length - 1]`, and add a test that removes `Array.prototype.at` (like the existing `toSorted` deletion in `use-retired-worktree-names.test.tsx`) or evaluates the built document bundle with a Chrome-74-like global. Optionally narrow the tokenizer `catch` to a dev-visible warning so a future unsupported API is not silently converted into “no tokens”.

---

## MAJOR

### M1. The “bare separator” filter removes every atomic URL/path that ends in `/`, changing what long-press copies

**Where:** `mobile/src/terminal/document/text-tokenizer.ts:111-118`.

```ts
pushMatches(line, new RegExp(TERMINAL_FILE_URL_REGEX_SOURCE, 'gi'), spans)
pushMatches(line, SLASH_PATH_RE, spans, 3)
// Why: a bare separator is prose, not a path.
for (...) {
  const text = line.slice(spans[i]!.start, spans[i]!.end)
  if (/^[\\/]$/.test(text) || /[\\/]$/.test(text)) { spans.splice(i, 1) }
}
```

The loop runs over the HTTP, file and slash-path spans that were just pushed, so it also deletes real URLs and directory paths whose final character is `/`. The surviving text is then rebuilt by the fallback/merge pass, which cannot re-attach a leading or trailing separator (the join pass only fills gaps _between_ tokens).

Verified against the real tokenizer:

```text
https://example.com/                 -> "https://example.com"      (slash lost)
open https://example.com/a/ now      -> "https://example.com/a"
/var/log/                            -> "var/log"                 (leading + trailing slash lost)
/tmp/                                -> "tmp"
```

`https://example.com/` is a very common form, and `/var/log/` losing a leading slash makes the copied value a _relative_ path. This is a regression of the pre-change `WORD_RE` selection, which included `/` and copied such paths/URLs whole, and contradicts R6/TL-T13 (“URL/路径长按复制整段不变”) and the design’s “URL/路径原子 span 不再拆”. The existing vectors G12/G13 only use URLs/paths without a trailing slash, so tests do not see it.

**Fix:** apply the separator check only to the `SLASH_PATH_RE` matches (keep the HTTP/file matches intact), and only drop a slash-path span when its text is _entirely_ separators (e.g. `/`, `//`, `./`), not when it merely ends with one. Add `https://example.com/`, `/var/log/`, `C:\` and `./src/` vectors asserting the full copied text in both Segmenter arms.

---

## MINOR

### m1. Unparseable URLs bypass the “host only / hide userinfo” summary and leak the full URL (including credentials)

**Where:** `mobile/src/session/terminal-link-presentation.ts:97-103`.

When `new URL(filtered)` throws, the function returns `summary: filtered` — the entire URL. The tap detector matches `https?://…` broadly, so a malformed but matched value can reach the sheet, e.g. `https://user:pass@` or `https://user:pass@[bad/path` (both parse-throw; both contain userinfo). The sheet then renders `user:pass@…` as the _summary_, defeating A22’s “summary hides userinfo” anti-phishing contract. Also, `isBidiOrControl` (`:9-21`) filters bidi/control but not zero-width format characters (U+200B–U+200D, U+2060, U+FEFF), which can hide characters in the expanded full URL.
**Fix:** on parse failure show a defanged/truncated prefix (no userinfo, no path) or a neutral “Unparseable URL” line while keeping the full URL only in the explicitly expanded view; add the Cf range to the sanitizer. Add a component/presentation test with `https://user:pass@[bad/path`.

### m2. The desktop action can fail silently despite the “never silent” requirement

**Where:** `mobile/src/session/use-mobile-session-content-create-actions.ts:156-161`, `:167-168`; caller `mobile/src/session/use-mobile-session-file-actions.ts:159-161`, `:251`.

`handleCreateBackgroundBrowser` returns `false` with no toast (and no sheet fallback) when `client`/`connState`/`creatingBrowser` changed after the sheet was rendered, or when the route became folder/floating. `runTerminalLinkAction`/the stored-preferred direct path ignore the returned promise. A tap on a sheet that was available one render ago therefore does nothing visible. Design 7.1.2/TL-T8 require “disabled + hint; do not silently return”.
**Fix:** on these guards, show a toast (“Connect to the desktop…” / “A browser tab is already opening.”) and/or fall back to the sheet; have the direct-open path check the boolean and open the sheet when false.

### m3. Legacy migration can overwrite a preference the user just saved

**Where:** `mobile/src/storage/preferences.ts:284-286` (save), `:309-315` (migration).

Migration reads v2 (`:309`) and, if still `null`, writes `ask` (`:311`). A remember-write that lands between that read and the write is silently overwritten by `ask`; the user’s “Remember my choice” then reverts on the next focus load. The `requestSeq` guard only suppresses the asynchronously delivered preselect, not the storage write. Low likelihood (human tap vs. two AsyncStorage calls) but it is a real lost update and the repro is a first-run sheet with slow storage.
**Fix:** serialize the migration before enabling sheet actions, or make the migration write conditional on a compare-and-set style check (re-read/token) so it cannot clobber a v2 write that happened after the first read.

### m4. Two hooks implement the same “close sheet on active-handle change” rule; only one restores keyboard/in-flight state

**Where:** `mobile/src/session/use-mobile-session-screen-state.ts:59-64` and `mobile/src/session/use-mobile-session-file-actions.ts:134-140`.

The screen-state effect clears `terminalLinkChoice` without touching `linkKeyboardWasOpenRef`, `linkSheetSeqRef` or `linkActionInFlightRef`; the file-actions effect calls `closeTerminalLinkSheet`, which does all three. Today both effects run in the same commit so the behaviour is correct, but the invariant is split across two hooks and one copy is a trap for future edits (e.g. if file-actions stops being mounted first, the keyboard is never restored and the in-flight guard stays latched).
**Fix:** keep one effect (in file-actions, which owns the lifecycle) and delete the screen-state duplicate.

### m5. Test-plan coverage gaps (mostly cases the design explicitly calls out)

- **A12:** the content-create test (`use-mobile-session-content-create-actions.test.ts:76-92`) asserts `activate:false` and no pending ref but not “after caller projection the active tab is still the terminal” / reconnect; that is the actual regression the design wanted pinned.
- **A16:** no test that an `activeHandle` change closes the sheet and suppresses the action (the recheck in `runTerminalLinkAction` is tested, the effect is not).
- **A29:** no failure-path test for the background create (catch → toast), and none for the silent-return guards in m2.
- **A21 / A30b:** initial “ask before load completes” and “unavailable then recovered host, stored value survives” are only partially covered by the policy unit tests.
- **Both-arm parity:** the design requires the same G vectors under Segmenter present/absent. `text-tokenizer.test.ts:85-93` compares one mixed line; `selection-range.test.ts:224-240` re-runs one CJK vector without Segmenter. A quick manual comparison of all test-plan vectors showed no drift today, but the suite would not catch a drift in, say, G22a–G22e under the fallback.
- **B1:** the Chrome-74 fallback test does not exercise the actual runtime floor (see B1).

### m6. Changed-lines quality gate fails on new lines in this feature

`pnpm run check:code-quality:changed` reports new findings in feature files (the concurrent file-browser work also fails the same gate, but these are ours):

- `mobile/src/terminal/document/text-tokenizer.ts:51` — `Intl as unknown as …`. The `SAFETY:` disable at `:58` is attached to a line with no assertion, so the gate flags the cast twice.
- `mobile/src/session/TerminalLinkActionSheet.test.tsx:81`, `mobile/src/session/use-mobile-session-file-actions.test.ts:11,79`, `mobile/src/session/use-mobile-session-content-create-actions.test.ts:22-24` — assertions without line-specific `SAFETY:` comments.
- `mobile/src/session/TerminalLinkActionSheet.tsx:42-48` — `react-doctor(no-adjust-state-on-prop-change)`: the `expanded`/`remember` reset runs after paint, so reopening the sheet with a new URL can show the previous sheet’s expanded/Remember state for one frame. Prefer a keyed remount (`key={url}` on the content) or derive the reset from the presentation key.

**Fix:** move the SAFETY disable directly above the `Intl` cast, annotate the test casts (or remove them), and key the sheet body by URL/visible epoch.

---

## Verified as correct (spot checks)

- **Geometry:** `snapToGlyphStart`/`snapToGlyphEnd` follow the design (width 0 + left width 2 only; blank only via width; clamp at cols), and the G1–G18 vectors, including wide/emoji right halves and folded wide glyphs, pass against the width-aware buffer. `stringIndexToCellCol` uses separate UTF-16 and cell cursors (`cell-geometry.ts:106-136`). `glyphStartBeforeCell` correctly backs up continuation cells.
- **Selection model:** both producers store glyph-start anchors (`selection-range.ts:186-197`, `selectAllTerminal:281-288`, `mouse-click-drag.ts:127-131`, `moveSelectionHandleToCell`); the exclusive end is derived once (`selectionSpan`), never stored; `applyXtermSelection` uses the design’s multi-row length formula; crossing/equal-release behaviour and the B17b/B17b2/B17d/B17e/B17f vectors are correct and tested; drag-in-progress survives the equal point.
- **Nearby phrase:** edge-distance, ±8 cells, tie-left, CJK run merge independent of Segmenter, >5 window, blank-no-selection and non-blank glyph fallback all match design §7.1.6/G7–G30. A manual Segmenter-present vs absent comparison over the full test-plan vector list showed zero token drift.
- **Link policy:** ask default, `resolveDirectTerminalLinkAction` re-gating (phone scheme check, remote availability, no downgrade), folder/floating hidden, offline/unknown/creating/unsupported disabled with the exact host-update hint; `browser.tab-create-background.v1` only advertised when `canBrowse` (`orca-runtime-get-status.ts:90-108`) and tested; `activate:false` + no `pendingBrowserFocusPageIdRef` in the background path while the foreground path keeps `activate:true` + pending ref.
- **Sheet/keyboard:** keyboard state captured before open, blur+dismiss before the drawer, restore on cancel/copy/phone/remote; in-flight and active-handle guards verified; copy does not write the preference; remember failure still performs the action; v2 migration only deletes the legacy key when v2 exists (A20/A20b tests pass).
- **Migration wiring:** `use-mobile-session-preference-focus.ts` reads only v2; the legacy key is consumed on the first sheet; `page-storage-keys.ts` allowlists v2.
- **URL presentation (happy path):** summary is scheme+host+port with userinfo/path hidden, full expansion keeps userinfo after bidi/control filtering; HTTP and loopback/private warnings render.
- **Routing:** OSC 8 HTTP → `open-url`; OSC 8 file/file:// / bare path → `terminal-file-tap`; mailto/custom schemes post nothing (new test).

## Verification performed

- `pnpm --dir mobile vitest run` on the feature suites: 8 files / 114 tests pass, plus `src/terminal/document` + tap-routing: 12 files / 116 tests pass.
- `pnpm --dir mobile typecheck`: passes. `pnpm tc:node`: passes.
- `pnpm vitest run src/main/runtime/runtime-extraction-regressions.test.ts`: 6/6 pass (capability advertisement).
- `pnpm run check:code-quality:changed`: fails (see m6; the concurrent file-browser work contributes most findings).
- `pnpm --dir mobile test`: 42 failures in 10 files, all in concurrent/unrelated areas (file browser/HTML preview, rpc-recording goldens, task launch, a mock-server key flake); no selection/link suite fails.
- `pnpm --dir mobile check:tests-typecheck`: fails only on two concurrent file-browser tests (`MobileFilePreviewScreen.actions.test.tsx`, `MobileFileSearchResults.test.ts`); the new feature tests typecheck.
- Reproduced B1 by deleting `Array.prototype.at` at runtime and calling `tokenizeTerminalLine('中文abc')` → `[]`.
- Reproduced M1 by tokenizing `https://example.com/`, `/var/log/`, `/tmp/`, `./src/`.
