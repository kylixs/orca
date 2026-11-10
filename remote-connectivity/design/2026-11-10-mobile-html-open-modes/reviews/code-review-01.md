# Code Review 01 — Mobile HTML open modes

Scope: `design.md` (section 8 normative), `test-plan.md`, `tasks.md`, `reviews/design-review-04.md`, and the HTML-related working-tree implementation (`mobile/src/files/mobile-html-open-mode*`, `mobile-file-open-mode-actions`, `html-relative-assets`, `MobileFileOpenModeSheet`, `MobileFileHtmlModeToolbar`, `MobileFilePreviewHtmlControls`, `MobileFilePreviewBody/Screen`, `mobile-file-actions`, `use-mobile-file-*-html*`, `html-preview-scheme`, `MobileHtmlPreview*`, route/normalize, preferences, Browser settings). File-browser download/search work and terminal-link/selection work were treated as out of scope except where the HTML feature reuses them.

Verdict: **CHANGES_REQUESTED**
Counts: **0 BLOCKER / 2 MAJOR / 12 MINOR**

Evidence (read-only):

- `npx vitest run <9 HTML test files>` — 93 passed.
- `npx vitest run src/files/MobileFileExplorerPanel.test.ts src/components/mobile-webview-editor-web-fallbacks.test.tsx src/components/html-preview-link-affordance.test.tsx src/components/html-preview-inert-links.test.ts && …` — 44 passed; `MobileFilePreviewScreen.test.ts`, `MobileFileMarkdownPreview.test.ts`, `mobile-file-preview-retry.test.tsx` — 9 passed.
- `npx tsc --noEmit` (mobile) — exit 0.
- `npx oxlint <all touched HTML/prod files>` — no findings.
- `pnpm run check:code-quality:changed` — fails, but all 8 findings are in out-of-scope files (`use-mobile-file-search.test.ts`, `mobile-terminal-diagnostics.test.ts`, `mobile-file-download-cache.ts`, `mobile-file-save.ts`); no HTML file appears.
- `node mobile/scripts/check-tests-typecheck-ratchet.mjs` — fails on `src/files/use-mobile-file-search.test.ts` (file-browser, out of scope).
- Direct evaluation of the navigation policy: `htmlPreviewNavigationDecision({url:'about:blank#section'})` returns `block` for `isTopFrame` true/false/undefined; `about:srcdoc` as a subframe returns `block`.

## BLOCKER

None. The security design holds: no bridge/`onMessage`/injected script, `allowFileAccess` stays false, top-frame schemes are limited to http/https/mailto, subframes never call `openExternalLink`, and the web frame keeps `sandbox` without scripts/same-origin.

## MAJOR

### M1. iOS in-page anchors (and `srcdoc` subframes) are blocked by the navigation policy

`mobile/src/components/html-preview-scheme.ts:33-35` (`isInlineDocument`) accepts only the exact string `about:blank` or a `data:` prefix.

Scenario: the rendered HTML is loaded with `source={{html}}` and an `about:blank` base. A self-contained document with `<a href="#section">` (or `location.hash = 'section'`) produces a same-document request for `about:blank#section`. The policy sees protocol `about:` and returns `block`, so the WebView cancels the scroll and shows the false toast "This link type isn't supported in preview". This is a normal case for documentation-style HTML and contradicts AC5 ("rendered view displays self-contained HTML") and the C8 rule that `#anchor` is not a missing asset.

Related: `about:srcdoc` (the URL WebKit/Chromium report for an inline `<iframe srcdoc>`) is blocked for subframes, so an HTML document that embeds an inline iframe can render a blank iframe and a spurious toast on iOS. Note that the native library computes `isTopFrame` as `request.URL == mainDocumentURL` (`react-native-webview/apple/RNCWebViewImpl.m:1357`), so a fragment navigation may also arrive with `isTopFrame=false`; the URL check, not the frame flag, has to admit it.

Fix: normalize the URL before matching (`const bare = url.split('#')[0]`) and treat `about:blank` (any fragment) as inline; additionally allow `about:srcdoc` (and `about:blank`) in the `isTopFrame === false` branch. Add tests for `about:blank#anchor` (top and subframe) and `about:srcdoc`.

### M2. The acceptance-critical 512 KB boundary and Copy-content read path have no tests

The design makes truncation the highest-priority mode rule (8.4/8.6) and requires exact 511/512/513 KB behaviour (7.6, test-plan C9/B10, tasks HT-U9/HT-U16), but:

- No test exercises `truncateMobileFilePreview` at the boundary (`src/main/runtime/runtime-file-commands-terminal-artifact-access.ts:131-145`). The `<=` boundary is correct today, but an `<=` → `<` regression would make a 512 KB file "truncated" and pass the whole current suite.
- No test exercises `readFileContentForCopy` (`mobile/src/files/mobile-file-copy-content.ts`) at all — neither the `files.read` truncated path nor the local 512 KB re-truncation (`:57-65`) nor the "Copied first 512 KB" notice.
- The mobile truncation test (`MobileFilePreviewScreen.actions.test.tsx:346-371`) injects `truncated: true` directly, so it proves the UI reaction but not the 511/512/513 contract or the ordering with a real read.

Failure scenario: a host/mobile change silently flips the boundary or breaks partial copy; CI stays green while C9/B10 and AC5 regress.

Fix: add host tests for 511/512/513 KB/1 MB through `truncateMobileFilePreview`; add mobile tests for the resolver at those boundaries, the disabled Preview/action array, and `readFileContentForCopy` including a multi-byte character straddling the cut.

## MINOR

### m1. Preference resolution can override the forced source mode or a manual toggle

`mobile/src/files/use-mobile-file-preview-html-mode.ts:28-52` loads the stored preference asynchronously and calls `resolveMobileHtmlPreviewMode` with hard-coded `hasLineTarget: false, truncated: false`, then assigns `setMode(resolved)`.

Failure scenario (bare preview route — deep link/shared URL, no `mode`, no line): while the AsyncStorage read is in flight the user taps Source; the late preference result sets mode back to Preview. For a truncated file with preference `preview`, the late result can also set mode back to `preview` after the truncation effect (`:54-59`) forced `source`, leaving the toolbar showing a disabled Preview selected while source text is displayed. This violates the normative "truncated outranks stored preference" rule in 8.4.

Fix: pass the real `truncated`/`hasLineTarget` into the resolver and skip the preference effect when `truncated`; keep a `userChoseModeRef` so an async result never overwrites a manual choice. Better still, resolve once with all inputs (terminal/truncated/route/line/preference) instead of splitting the precedence between `initialHtmlMode` and two effects.

### m2. The normative precedence function is duplicated and effectively bypassed

`resolveMobileHtmlPreviewMode` (`mobile-html-open-mode.ts:25-48`) is described as the one place precedence is decided, but the screen re-implements the same order in `initialHtmlMode` (`use-mobile-file-preview-html-mode.ts:79-93`) plus the truncation/preference effects, and only ever calls the resolver with `truncated:false`/`hasLineTarget:false`. This is the main drift risk for the 8.4 table (see m1). Fix: one resolver call for the initial mode, with the effects only handling a user change.

### m3. `availableHtmlOpenActions` does not use `hasLineTarget` and returns no actions for terminal artifacts

`mobile/src/files/mobile-file-open-mode-actions.ts:13-41` documents `hasLineTarget` as part of the input but never reads it, and returns `[]` for `source: 'terminalArtifact'`. Design 8.3 lists `{source,hasLineTarget,previewDisabled,readFailed}` as the only input and says "one available → open directly (terminal artifact only)", which implies the terminal artifact still has its Source mode; 8.5 says menus show every available action. The present result is that an HTML terminal artifact's overflow menu has no Source entry at all.

The behaviour may be intended (the artifact is already in Source), but it is not pinned by a test and contradicts the documented input. Fix: decide explicitly — either include `{id:'source'}` for terminal artifacts (a no-op switch, still one visible mode action) or document that terminal artifacts contribute zero mode actions and delete/rename `hasLineTarget` plus add a unit test for this branch.

### m4. `htmlOpenMode` is threaded through the action model but never used

`FileActionOptions.htmlOpenMode` (`mobile/src/files/mobile-file-actions.ts:80-86`) is accepted by `buildFileActions`, passed by `MobileFileActionSheet`/`MobileFilePreviewOverlays`, yet never read in the builder (`:129-153`). Either use it (e.g. mark the current mode) or delete it; the design's unique builder signature is satisfied without dead plumbing.

### m5. The automatic chooser bypasses `ActionSheetModal`'s close-before-navigate sequencing

`MobileFileOpenModeSheet.tsx:36-56` renders `ActionSheetContent` directly inside a `BottomDrawer`; pressing Preview/Source calls `onSelect` immediately. The shared `ActionSheetModal` (used by the file action sheet) deliberately defers the action until the native modal has unmounted (`ActionSheetModal.tsx:120-140`: "iOS cannot present a second native modal until the action sheet's native window has fully unmounted"). The chooser pushes a route while the drawer is still presented/closing, which can animate over the new screen or race a subsequent presentation on iOS.

Fix: use `ActionSheetModal` with `closeBeforePress` (or wire `onAfterClose`) so navigation happens after the drawer is gone. Keep the remember switch outside the sequenced action.

### m6. The no-app copy and availability do not match the feature's normative copy (C14)

`mobile/src/platform/open-file.ts:44,47,64` reports "No app can open this file. Save it to your phone instead.", while `test-plan.md:84` and `ui/README.md:29` specify "No app available for this file type. Use Save to phone instead.". Additionally, `fileActionCapabilities` only probes native-module availability, not per-MIME handlers, so "Open with" is never hidden for a file no installed app handles — the prototype's "No app available" state cannot occur. This is shared file-browser code, but C14 is in this feature's test plan; as written it cannot pass.

Fix: adopt the normative string in `open-file.ts` and decide whether capability probing is expected to detect missing handlers (or relax C14 and remove the prototype state).

### m7. The Android half of the `textInteractionEnabled` test asserts an iOS-only prop

`mobile/src/components/MobileHtmlPreview.tsx:71` passes `textInteractionEnabled={Platform.OS === 'ios'}`, and `mobile-html-preview-frame.test.tsx:139-146` asserts `false` on Android. `textInteractionEnabled` is documented `@platform ios` (`react-native-webview/src/WebViewTypes.ts:708-711`), so the Android assertion proves nothing about selection.

Fix: pass `undefined` on non-iOS and let the Android default stand; assert iOS behaviour only (or a behavioural Android test), keeping C13's platform split honest.

### m8. The relative-asset detector produces false warnings for attribute-shaped text

`mobile/src/files/html-relative-assets.ts:8,17-22` scans the raw document. Attribute-like text inside `<script>`, comments, or a `<pre><code>` example (`src="./x.png"` shown as prose) is reported as a missing asset, so a page that documents HTML always shows "Relative assets may not load". Also, because `src`/`href` are swept before `url(...)`, the returned list is not strictly in document order across the two kinds (the test's "document order" claim holds only within one sweep).

Fix: strip comments/`<script>`/`<style>`/`<pre>` (or at least document the heuristic) and collect matches in one ordered pass; add an inline-code/comment case to C8.

### m9. A11y details from design 7.13 are incomplete

- `MobileFilePreviewHeader.tsx:46-54`: the overflow button has no `accessibilityState={{ expanded: actionSheetVisible }}` (design asks for selected/expanded on the overflow control).
- The blocked-scheme toast (`MobileHtmlPreview.tsx:74-79`) uses `accessibilityLiveRegion`, which React Native only acts on for Android; iOS users get no announcement of the rejection. This is the documented platform difference, but the toast's iOS silence is not recorded.

Fix: add the expanded state; note the iOS toast limitation or add an iOS announcement path.

### m10. Long-press timing diverges from the feature spec

`mobile/src/files/mobile-file-explorer-row.tsx:150` uses `delayLongPress={350}`, while design 7.13 specifies 500 ms. The extra `LONG_PRESS_TAP_GUARD_MS` timer (`:18,109-119`) is redundant: React Native's `Pressability` already suppresses `onPress` when the release comes from the long-press state (`Pressability.js:743-761`), and the guard can swallow the first tap if the sheet is dismissed inside 600 ms. This row is shared FB-U1 code (already noted in the file-browser review), but HTML B11 depends on it.

Fix: set 500 ms and delete the redundant guard/timer (or keep only a press-in reset).

### m11. Settings load-failure handling is unreachable; no end-to-end Ask round trip

`loadMobileHtmlOpenMode` never rejects — it catches and returns `ask` (`mobile/src/storage/preferences.ts:334-341`) — so the rejection branch in `browser-settings-screen.tsx:93-101` is dead; a storage failure silently displays Ask. Design only requires write-failure reporting, so this is acceptable, but the dead branch is misleading.

Also, A5 ("change back to Ask, next tap re-opens the chooser") is only covered by unit mocks: `useMobileFileHtmlOpenMode` reloads on focus, and `MobileFileExplorerPanel.test.ts:696-707` mocks the stored value; nothing wires settings → explorer. Add one integration test or document the unit split.

### m12. Test-hygiene and coverage gaps beyond M2

- `MobileFilePreviewScreen.actions.test.tsx:405` calls `deps.modeSheetProps?.onSelect?.('source', true)` outside `act`; this can log an act warning/flake under React 19.
- The "renders only one mode toolbar" test (`:323-344`) mocks `MobileFilePreviewBody`, so it cannot detect a second toolbar inside the frame; add a body-level test asserting `showToolbar=false` on the frame and the warning rendered above it.
- Missing explicit C9/C14/C15/C16/C18 cases: 0-byte HTML, CJK/emoji content/file names, return/rotation, Android `isTopFrame`-undefined navigation branch, web sealed-sandbox variant, `about:blank#anchor`/`about:srcdoc` (would have caught M1), long-press-release mutual exclusion (B11), and any direct test of `availableHtmlOpenActions` (m3) or `readFileContentForCopy` (M2).
- `isAllowedHtmlPreviewScheme` (`html-preview-scheme.ts:13-15`) is production-unused (test-only); either use it in the policy or drop the export.

## Design conformance summary

| Area | Result |
|---|---|
| Preference key `orca:mobileHtmlOpenMode`, enum validation, ask fallback, write-failure notice | Pass (`preferences.ts:328-345`, list/preview hooks, settings) |
| Browser settings row + PickerModal, only reset-to-Ask path | Pass (`browser-settings-screen.tsx:169-207`) |
| Mode precedence terminal/truncated > route > line > pref > ask | Pass in normal flows; bare-route race in m1 |
| Page-local mode, return writes no preference, no `setParams` | Pass (`use-mobile-file-preview-html-mode.ts`, screen local state) |
| Route `mode` through type/normalize/nav/app routes/terminal branch | Pass (`mobile-file-preview-route.ts:21,60-64,99,117`; navigation test) |
| Single action builder, exact array, one Preview in both contexts | Pass (`mobile-file-actions.test.ts:116-177`; explorer/preview component tests) |
| Auto chooser two modes + remember; long-press/overflow never write preference | Pass (`MobileFileOpenModeSheet`, `use-mobile-file-html-open-mode`, explorer tests) |
| Frame controlled, no double toolbar, session wrapper preserved | Pass (`MobileHtmlPreview.tsx:31-101`; body passes `showToolbar=false`) |
| textInteraction integration | Pass; Android test issue m7 |
| Relative-asset detector + ≤3 refs + exact copy | Pass; heuristic false positives m8 |
| 512 KB: 511/512 render, 513 disabled, banner/source note exact copy | Implementation correct; tests missing (M2) |
| Copy content on demand, partial-copy hint/notice | Implementation present; tests missing (M2) |
| Terminal artifact HTML source-only, Save preserved | Pass (`MobileFilePreviewBody.tsx:114-131`; screen `sourceOnly`) |
| OTA forces native, mode not lost | Pass (`preview/[worktreeId].tsx`; web-shell route tests) |
| Scheme allowlist, top-frame vs subframe, no external for subframes, no bridge, no file access | Pass, except fragment/`srcdoc` handling (M1) |
| Web sandbox iframe, no toast | Pass (existing web tests) |
| `openExternalLink` contract unchanged | Pass (optional `onFailure` is additive) |
| data/about handling | `data:` and exact `about:blank` pass; fragment/`about:srcdoc` fail (M1) |

## Gate status

- Mobile production typecheck, focused tests and focused lint pass.
- The repo-wide changed-code gate and the mobile tests-typecheck ratchet currently fail only on out-of-scope file-browser/terminal files; they must be green before merge, but no HTML file is implicated.
