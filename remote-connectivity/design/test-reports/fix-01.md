# Fix report 01 — Android HTML scheme escape, filter-chip layout, meta-refresh feedback

- Date: 2026-11-10
- Branch: `feat/remote-terminal-load-diagnostics` (no commit made)
- Input: `test-review-01.md` findings R-01/R-02/R-03/R-04 and test gaps R-10/R-11.
- Verification environment: AVD `Pixel_8a` (Android 16 / API 36, arm64), Orca Mobile 0.0.52
  debug dev-client, Chrome/WebView 133, isolated headless host on 6770, Metro on 8081.
  JS-only changes were served by Metro; no APK rebuild was needed.

## Verdict

| Finding | Severity | Status |
|---|---|---|
| R-01 Android executes `javascript:` links | BLOCKER | **Fixed and verified on emulator** |
| R-02 filter chips render full-height | MAJOR | **Fixed and verified on emulator** |
| R-03 meta-refresh blocked without toast | MINOR | **Fixed and verified on emulator** |
| R-04 duplicate save feedback | MINOR (UX) | **Deferred — see below** |
| R-10 no Android-level scheme test | Test gap | **Closed** (script + WebView contract tests + real tap) |
| R-11 no chip layout test | Test gap | **Closed** (layout contract test + on-device bounds) |

## R-01 — Android HTML preview executed `javascript:` links

### Root cause

`MobileHtmlPreviewFrame` relied solely on `onShouldStartLoadWithRequest`. Android's WebView
consumes a tapped `javascript:` URL itself and never hands it to `shouldOverrideUrlLoading`, so
the block branch never ran. The existing unit test called that callback directly and therefore
could not observe the escape (exactly the R-10 gap).

### Change

`mobile/src/components/html-preview-interception.ts` (new) holds a fixed, self-contained
interception script injected with `injectedJavaScriptBeforeContentLoaded` (and a second,
idempotent pass after load):

- A capture-phase `click` listener cancels links/areas whose resolved scheme is not
  `http:`/`https:`/`mailto:` and is not an inline `about:blank`/`data:` document.
- A capture-phase `submit` listener does the same for form actions.
- Event delegation covers anchors added after load; `composedPath` covers taps on child nodes.
- `meta refresh` targets use DOM parsing (not a string rewrite): a blocked refresh element is
  removed before its navigation task can run, and the original delay is kept for the toast.
- The whitelist is interpolated from `HTML_PREVIEW_EXTERNAL_SCHEMES` in
  `html-preview-scheme.ts`, so the DOM fence and the native callback cannot drift.

`MobileHtmlPreview.tsx` now wires the script and accepts **one** message:
`HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE = 'orca:html-preview:blocked-scheme'`. `onMessage`
ignores every payload that is not byte-for-byte that sentinel and only raises the existing
toast. No URL is read or reflected, and no host action is reachable. On Android the repo's
existing `react-native-webview` patch additionally drops messages from subframes. The native
`onShouldStartLoadWithRequest` policy is unchanged and still the backstop for script-initiated
navigation (`file:`/`intent:`/custom schemes), so the whitelist is not weakened.

Security boundary written down in code: a page script can post the sentinel and produce a
spurious toast; it cannot open a link, read a message, or reach the host through this channel.
Page-script navigation to `http(s)` remains the residual risk already accepted in design §8.1.

### Tests

- `mobile/src/components/html-preview-interception.test.ts` (new, happy-dom): evaluates the
  shipped script and dispatches real click/submit events — `javascript:`, `file:`, `intent:`,
  `tel:`, custom schemes and relative targets are cancelled and reported; `http`,
  `https`, `mailto`, `about:blank#fragment`, `data:`, `#fragment` and empty `href` pass through;
  child-element taps, post-load anchors, form actions, idempotent double injection, and
  meta-refresh removal/delay/case/spacing/attribute-order all covered.
- `mobile/src/components/mobile-html-preview-frame.test.tsx`: now asserts the WebView receives
  the interception script both before and after content load, receives an `onMessage` handler,
  does not receive an injected object bridge, shows the toast for the exact sentinel, and ignores
  arbitrary payloads (URLs, JSON, whitespace/case variants, non-strings).

### On-device verification (Android)

- `page.html` → tap `javascript link`: no native "JavaScript / 1" dialog; toast
  “This link type isn't supported in preview”; preview stays mounted.
  Evidence: `device-evidence/fix-01/screenshots/android-js-link-blocked-toast.png`.
- `dangerous-schemes.html` → tap `file:`, `intent:`, `my-app:` and `javascript:` links: toast
  each time, `mCurrentFocus` stays `com.stably.orca.mobile/.MainActivity` (no external app).
  Evidence: `android-dangerous-*.png`.
- Sandboxed iframe with `intent:`/`file:` links: preview stays mounted; no external app.
  Evidence: `android-iframe-intent-no-external-app.png`,
  `android-iframe-file-no-external-app.png`.
- `https` link still leaves for Chrome and the preview does not navigate.
  Evidence: `android-http-link-external-open.png`.
- CDP probe of the live WebView confirmed the fence installed and the dangerous
  `meta refresh` element was removed from the DOM (log in
  `device-evidence/fix-01/logs/device-verification.txt`).

## R-02 — filter chips rendered as full-height columns

### Root cause

A horizontal `ScrollView` carries a default `flexGrow: 1`; inside the Files flex column it grew
to all remaining vertical space. There was no layout test to notice it.

### Change

`mobile/src/files/MobileFileFilterChips.tsx`: the scroll view now has
`flexGrow: 0, flexShrink: 0`; content padding was reduced from 8dp to 4dp vertically. The chips
keep `minHeight: 32`, horizontal scrolling, selected state, roles, labels and `hitSlop`.

### Tests

`mobile/src/files/MobileFileFilterChips.test.tsx` (new): asserts `horizontal`, the
`flexGrow: 0`/`flexShrink: 0` constraint, no `flex: 1`, 32dp minimum chip height, one selected
chip, button roles, labels and hitSlop for every category.

### On-device verification

`uiautomator` bounds before the fix were `[0,427][1080,1408]` (~981px). After the fix:

```
File type filters  HorizontalScrollView  [0,406][1080,511]   (105px = 40dp)
Show All files     Button                [32,417][134,501]   (84px = 32dp)
```

Identical bounds with the IME open, and the file list is visible below the row.
Evidence: `android-filter-chips-single-row.png`, `android-filter-chips-keyboard.png`,
`logs/filter-chips-bounds.xml`, `logs/filter-chips-keyboard-bounds.xml`.

## R-03 — meta-refresh to `file:` blocked silently

### Root cause

`meta refresh` navigations never went through a user gesture and, when blocked by the native
policy, produced no feedback.

### Change

The injected script (same module as R-01) mirrors the scheme policy for `meta refresh`:
blocked targets are removed from the DOM at document start (plus a `MutationObserver` for
late insertions), and the sentinel is posted after the original delay, which raises the same
toast. Allowed `http(s)` refreshes are left to the native callback; a same-document refresh is
left alone. Parsing uses DOM attributes, so the page markup is never reserialised.

### Tests

Covered in `html-preview-interception.test.ts`: blocked `file:`/`intent:` refresh removed and
reported after its delay; delay-0 case; case/spacing/attribute-order/quoted-URL variants;
`http(s)` refresh preserved; same-document refresh untouched. The frame test covers sentinel →
toast.

### On-device verification

`meta-refresh.html` (`0;url=file:///etc/passwd`) stays on the “refresh” document and shows
“This link type isn't supported in preview”.
Evidence: `android-meta-refresh-blocked-toast.png`, `android-meta-refresh-no-navigation.png`.

Residual: if injection were ever missed, the native policy still blocks the navigation (safe,
silent). No such case was observed on the emulator.

## R-04 — save result sheet plus persistent “Saved to phone” banner

**Deferred.** Design §8.1 explicitly specifies the success toast followed by the result sheet,
and the existing save flow/tests depend on the notice for other outcomes. Removing one surface
is a product/UX decision, not required to unblock the release, and doing it here would change
the tested Save contract. No code was changed for R-04.

## Verification commands (executed)

```text
pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts
  → Test Files 102 passed (102); Tests 717 passed (717)

pnpm --dir mobile test (focused, final)
  → 39 passed (5 files)

pnpm --dir mobile typecheck
  → exit 0

pnpm --dir mobile exec oxlint <7 changed files>
  → exit 0

pnpm --dir mobile typecheck:tests
  → still reports the repo's pre-existing test-type errors; no error mentions any changed file

pnpm run check:code-quality:changed
  → code quality: 0 new findings across 160 changed files
  → Changed-code quality gate passed since 7bd3928159f5
```

No cross-package changes were made, so `pnpm tc` was not required.

## Files changed

- `mobile/src/components/MobileHtmlPreview.tsx` (wire interception script + restricted channel)
- `mobile/src/components/html-preview-scheme.ts` (export the whitelist used by the script)
- `mobile/src/components/html-preview-interception.ts` (new)
- `mobile/src/components/html-preview-interception.test.ts` (new)
- `mobile/src/components/mobile-html-preview-frame.test.tsx` (R-10 contract tests)
- `mobile/src/files/MobileFileFilterChips.tsx` (layout constraint)
- `mobile/src/files/MobileFileFilterChips.test.tsx` (new)
- `remote-connectivity/design/test-reports/fix-01.md` (this report)
- `remote-connectivity/design/test-reports/device-evidence/fix-01/**` (evidence)
- `remote-connectivity/design/test-reports/device-evidence/fix-01/fixtures/dangerous-schemes.html`
  (new device fixture)

Unrelated dirty files (`mobile/src/session/*`, `src/renderer/src/runtime/*`, etc.) were not
modified. No commit was created and no permission settings were changed.

## Still uncovered

- iOS remains blocked by the Xcode 26 / iOS 26 SDK environment; the web sandbox path is
  unchanged.
- Physical-device run and the rest of the save/size matrix from the device report remain open.
- The on-device matrix used the file-browser preview. The session-file reader uses the same
  frame and therefore the same fence, but was not re-run on-device this round.
- A page that pre-empts the injected script with its own capture listener can interfere with
  same-context event handling; the native callback still refuses non-whitelisted navigations.
  Page-script `http(s)` navigation remains the design §8.1 accepted risk.

## Corrections (fix-02, 2026-11-10)

Independent review `fix-code-review-01.md` checked this report; the following statements were
inaccurate and are superseded by `fix-02.md`:

- **“Native callback is the backstop for pre-empted taps.”** False on Android WebView 133:
  tapped `javascript:`/`file:`/`intent:`/`tel:` never reach `onShouldStartLoadWithRequest`
  (no toast; `https` does reach it). `fix-02` replaces the pre-emptable document listener with a
  document-start window-capture fence (native patch) and records the callback probe.
- **“Native callback is the backstop for script `file:`.”** False for feedback: the engine blocks
  script `file:` silently. Script `intent:` does reach the callback and does toast. C12 was
  corrected in `test-plan.md`.
- **Files changed** omitted `mobile/src/components/MobileHtmlPreview.web.tsx` (already dirty in
  the worktree) and `mobile/src/components/html-preview-scheme.test.ts`.
- **“39 passed (5 files)”** is not reproducible from the four named fix test files (32 tests).
  Adding `html-preview-link-affordance` gives 36; the fifth file was not named. The broader
  `102 files / 717 tests` figure was reproduced exactly by the reviewer.
- **Dangerous-scheme screenshots** were byte-identical (same SHA-256), so they did not show which
  link was tapped. `device-evidence/fix-02/screenshots/android-fix02-preempt-*.png` recaptures
  each scheme with a distinct visible probe marker and distinct hashes.
