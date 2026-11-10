# Code Review 02 — Mobile HTML open modes

Scope: `design.md` (sections 7-8 normative), `test-plan.md`, `tasks.md`, and the current working-tree HTML implementation/tests, re-checked after `reviews/code-review-01.md`. File-browser download/search and terminal-link/selection work were treated as out of scope except where shared code is load-bearing.

Verdict: **CHANGES_REQUESTED**
Counts: **1 BLOCKER / 0 MAJOR / 3 MINOR**

Review-01 findings M1, M2, m1-m4, m6-m12 are resolved. The m5 fix for close-before-navigate is correct in isolation but introduced a regression in the file-list chooser (B1); the preview-screen chooser path still works because its `onSelect` does not depend on the cleared state.

Evidence (read-only):

- `npx vitest run` (mobile) on the 15 focused HTML files — 178 passed; on the 7 regression files (`MobileFileExplorerPanel`, `MobileFilePreviewScreen`, Markdown, web fallbacks, link affordance/inert links, retry) — 55 passed; on the 3 shell-route files — 31 passed; `MobileSessionFileReader`/artifact-kind — 5 passed.
- `npx vitest run src/main/runtime/runtime-file-commands-mobile-file-truncation.test.ts` — 5 passed.
- `npx tsc --noEmit` (mobile) — exit 0.
- `npx oxlint` on every touched HTML/prod file — no findings.
- `pnpm run check:code-quality:changed` — fails only on 3 out-of-scope `mobile/src/session/mobile-terminal-diagnostics.test.ts` assertions (concurrent work); no HTML file appears.
- `node mobile/scripts/check-tests-typecheck-ratchet.mjs` — OK (992 files, 122 grandfathered, no new HTML errors).

## BLOCKER

### B1. Selecting Preview/Source in the file-list auto chooser now does nothing

The m5 sequencing change defers `onSelect` until the drawer has closed, but the file-list hook clears the pending file before that callback runs.

- `mobile/src/files/MobileFileOpenModeSheet.tsx:59-65` invokes `props.onSelect` from `onAfterClose`.
- The action tap first runs `action.onPress()` (which only stores the choice in `pendingChoiceRef`) and then calls `props.onClose` (`mobile/src/components/ActionSheetModal.tsx:73-77`).
- In the list, `props.onClose` is `closeChooser` (`mobile/src/files/MobileFileExplorerPanel.tsx:369-374`), which runs `setPending(null)` (`use-mobile-file-html-open-mode.ts:73`) before the drawer's close animation completes.
- The parent re-renders the still-closing sheet with a new `onSelect` closure whose captured `pending` is now `null`; `selectMode` then returns at `mobile/src/files/use-mobile-file-html-open-mode.ts:50-54`.

Scenario (AC1/AC4, design 8.3/8.4): fresh install or preference `Ask` → tap `index.html` → chooser opens → tap Preview or Source (with or without Remember) → drawer closes, the list stays, no preview opens and no preference is written.

Why CI is green: `MobileFileOpenModeSheet.test.tsx` uses a stable `onSelect` and never simulates the parent close, and `MobileFileExplorerPanel.test.ts:663-700` mocks the sheet away and calls `mockOpenModeSheet.props?.onSelect(...)` directly. No test composes the real sheet's close sequence with `useMobileFileHtmlOpenMode`.

Fix: keep the selected target alive until the deferred dispatch (pass the target through the deferred `onSelect`, or store it in a ref that the close-following-a-selection does not clear), and add an integration test that drives select → `onClose` → `onAfterClose` through the real sheet/hook. Note that simply removing `setPending(null)` from `closeChooser` would leave a stale target when the sheet is dismissed by Cancel/drag, so the dismissal and selection paths should be distinguishable.

## MAJOR

None.

## MINOR

### m1. The mode chooser appears over a read-failed HTML preview

`use-mobile-file-preview-html-mode.ts:63-68` derives `sheetVisible` from the preference/mode resolution only; it never receives the read-failure state. `MobileFilePreviewScreen.tsx:91-104` passes `truncated` but no `readFailed`.

Scenario: bare HTML route, stored preference `Ask`, `files.read` returns EACCES → the Retry error screen is covered by "Open HTML file" with Preview/Source. Choosing a mode changes nothing and leaves the error. Design 8.3 says `readFailed` hides Preview/Source. Include `readFailed` in the hook input and suppress the chooser.

### m2. A late preference read can still clobber a list-level choice

The preview hook now has `manualMode` to protect a late storage read, but the list hook does not. `use-mobile-file-html-open-mode.ts:19-31` starts a focus load; `:48-65` records a choice in state.

Scenario: on focus, AsyncStorage is slow; the user opens the chooser, picks Source and Remember before the read resolves; the stale read returns `ask` and `setMode('ask')` at `:22-25`, so the next tap asks again despite the remembered choice. Conversely, a loaded stored mode can override a non-remembered choice for the next tap. Use a read generation/ref that a choice invalidates, as the preview hook does.

### m3. Residual coverage gaps

- No integration test for the auto-chooser close sequence (this is what would have caught B1).
- B11 (long-press release does not also trigger preview; sheet appears once) is still only covered by an assertion on `delayLongPress={500}` (`MobileFileExplorerPanel.test.ts:608-613`); Pressability's cancellation is assumed, not exercised.
- No rotation case (C16); return is covered by "does not carry a manual toggle back to the next visit".
- C5's "Preview disabled + `accessibilityState.disabled`" is implemented (`MobileFileHtmlModeToolbar.tsx:26-31`) but no test asserts the disabled state; the screen tests only inspect the mocked sheet/body.
- C8 has no inline-code case outside `<pre>` (the new stripping tests cover comments/scripts/styles/pre).

## Review-01 item verification

| Item | Result |
|---|---|
| M1 fragment stripping (`about:blank#anchor` top/subframe), `about:srcdoc` subframe, undefined `isTopFrame`, no false toast | **Resolved.** `html-preview-scheme.ts:38-57`; tests at `html-preview-scheme.test.ts:29-48` and `mobile-html-preview-frame.test.tsx:95-109`. `undefined` takes the top-frame branch (Android). No bridge/injected script/file access added. |
| M2 511/512/513 KB/1 MB host boundary, resolver, disabled Preview/array, partial/multibyte copy | **Resolved.** `runtime-file-commands-mobile-file-truncation.test.ts:10-60`; screen boundary test at `MobileFilePreviewScreen.actions.test.tsx:381-429`; resolver and action arrays in `mobile-html-open-mode.test.ts` / `mobile-file-open-mode-actions.test.ts` / `mobile-file-actions.test.ts`; `mobile-file-copy-content.test.ts:46-133`. |
| m1/m2 single resolver, no late preference override, truncation wins | **Resolved in the preview hook** (`use-mobile-file-preview-html-mode.ts:38-68`; tests `:75-147`). List-level late-read race remains (m2 above). |
| m3 terminal Source action; `hasLineTarget` removal | **Resolved.** `mobile-file-open-mode-actions.ts:30-43`; `hasLineTarget` now lives only in the resolver. |
| m4 dead `htmlOpenMode` removal | **Resolved.** Replaced by `htmlActionState` (`mobile-file-actions.ts:78-83`), used by both callers. |
| m5 close-after-close sequencing | **Sequencing implemented** (`MobileFileOpenModeSheet.tsx:53-66`) but the list integration regressed (B1). Preview-screen flow is correct. |
| m6 normative no-app copy and documented capability limits | **Resolved.** `open-file.ts:44-73`; test-plan C14 and `ui/README.md` document the native-module-only probing and the fallback condition. |
| m7 iOS-only `textInteractionEnabled` | **Resolved.** `MobileHtmlPreview.tsx:71-73`; Android asserts `undefined` (`mobile-html-preview-frame.test.tsx:156-163`). |
| m8 detector stripping/order | **Resolved.** `html-relative-assets.ts:9-16,39-45`; tests cover comments/scripts/styles/pre, live script src, order, dedupe, out-of-scope attrs. |
| m9 a11y expanded/toast limitation | **Resolved.** `MobileFilePreviewHeader.tsx:48-56`; iOS toast limitation recorded at `MobileHtmlPreview.tsx:77-79`. |
| m10 500 ms long press, guard removed | **Resolved.** `mobile-file-explorer-row.tsx:132-136`; test `:608-613`. |
| m11 dead settings branch / A5 | **Resolved as accepted.** Dead rejection branch removed (`browser-settings-screen.tsx:93-98`); A5 is exercised by a focus-reload simulation (`MobileFileExplorerPanel.test.ts:722-738`), not a real settings→list composition. |
| m12 test hygiene / coverage | **Mostly resolved.** The out-of-`act` selection call is gone; body-level toolbar test added (`MobileFilePreviewBody.test.tsx:129-153`); 0-byte, CJK/emoji, undefined-`isTopFrame`, anchors/srcdoc cases added. Residual gaps in m3 above. |

## Gate status

- Mobile production typecheck, focused tests, focused lint, and the tests-typecheck ratchet pass.
- `check:code-quality:changed` fails only on out-of-scope `mobile-terminal-diagnostics.test.ts` findings; no HTML file is implicated. Merge still requires that gate to be green.
