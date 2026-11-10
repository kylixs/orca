# Fix report 02 — HTML preview DOM fence hardening, subframes, form action, evidence

- Date: 2026-11-10
- Branch: `feat/remote-terminal-load-diagnostics` (no commit made)
- Input: `fix-code-review-01.md` (F-01 MAJOR, F-02..F-09 MINOR), design §8.1/§9, test-plan C10/C11b/C12/C18/C19.
- Environment: AVD `Pixel_8a` (Android 16 / API 36, arm64, `emulator-5554`), WebView
  `133.0.6943.137`, Orca Mobile 0.0.52 debug dev-client paired to the isolated host on 6770,
  Metro on 8081. Native changes required a rebuilt APK; JS-only changes were hot-loaded.
- Evidence: `device-evidence/fix-02/` (fixtures, logs, screenshots). All screenshots below have
  distinct SHA-256 values.

## Verdict

| Finding | Severity | Status |
|---|---|---|
| F-01 DOM fence pre-emptable; native backstop claim false | MAJOR | **Fixed in the DOM fence; native hard block proven not to run on the tap path (device evidence), claim corrected** |
| F-02 subframe `javascript:` executes | MINOR | **Fixed** (fence now injected into all frames; subframe sentinel still dropped) |
| F-03 `formaction` / `form.submit()` | MINOR | **Fixed for `formaction`; `form.submit()` documented as residual** |
| F-04 script `file:` blocked silently | MINOR | **Report/test-plan wording corrected; no toast is claimed** |
| F-05 stale/incorrect security comments | MINOR | **Fixed** |
| F-06 layout test pins implementation | MINOR | **Limitation documented; fresh device bounds kept** |
| F-07 sentinel/meta flood | MINOR | **Fixed** (host ignore-while-visible + script throttle + debounced sweep) |
| F-08 policy drift / quoted URL | MINOR | **Fixed** (resolved-URL about rule, spec-compliant quoted URL, parity tests; bare `#fragment` regression found and fixed) |
| F-09 evidence/report accuracy | MINOR | **Fixed** (per-scheme distinct screenshots; fix-01 corrections appended) |

No remaining MAJOR/BLOCKER finding within the DOM fence's achievable scope. The native
`WebViewClient` cannot be made the boundary for tap-initiated dangerous schemes on this WebView;
that is demonstrated, not assumed, below.

## F-01 — fence ordering, idempotency, form action, native boundary

### Root cause

The old fence registered `click`/`submit` on `document` capture. A page script could register a
`window` capture listener first (or win the before-content-loaded race) and stop propagation before
the fence saw the event. The idempotency flag was a page-writable boolean, so a page that ran first
could pre-set it and disable both injection passes. The review's independent probe also showed that
the claimed native `onShouldStartLoadWithRequest` backstop does not run for tapped dangerous schemes.

### Changes

1. **Document-start injection (native patch).**
   `mobile/patches/react-native-webview@13.16.2.patch` now registers
   `injectedJavaScriptBeforeContentLoaded` with
   `WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton("*"))` when
   `DOCUMENT_START_SCRIPT` is supported (WebView 89+). It honors
   `injectedJavaScriptBeforeContentLoadedForMainFrameOnly` (main-frame guard; all frames when
   false), removes/re-registers the `ScriptHandler` when the prop changes, and keeps the
   `onPageStarted` evaluation as a fallback (the script guard makes a duplicate run a no-op).
   iOS already injects at document start via `WKUserScript`; the frame now passes `false` for both
   `...ForMainFrameOnly` props so subframes are covered on both platforms.
2. **Earliest window capture + document fallback.**
   The script registers `click`/`submit` on `window` capture and again on `document` capture. For a
   blocked event it calls `preventDefault()` then `stopImmediatePropagation()`; events blocked at
   window never reach document or later page listeners. A closure `WeakSet` prevents an event from
   being handled twice.
3. **Non-writable, non-configurable guard.**
   `Object.defineProperty(window, '__orcaHtmlPreviewInterception', { value: 'v2', writable: false,
   enumerable: false, configurable: false })`. A page that pre-seeds a writable value is overwritten;
   a page that pre-defines a non-configurable value cannot disable the fence — the script installs
   anyway (best effort; the worst case is a duplicate listener, not a missing one).
4. **Submitter form action.**
   The submit handler checks `event.submitter` first: an explicit `formaction` wins over the form
   `action`, including an explicitly empty `formaction`. See F-03.
5. **Residual documented in code.** `form.submit()` dispatches no submit event; page script can
   still replace `Event.prototype.preventDefault` or call `location.href` — those paths are owned by
   the native policy or the engine.
6. **Notification throttling.** See F-07.

### Native hard rejection — investigated, not implementable on the tap path

The review suggested a native `shouldOverrideUrlLoading`/WebViewClient block. We probed it on the
unchanged native policy (evidence: `device-evidence/fix-02/logs/native-callback-probe.txt`):

| Pre-empted trusted tap | App block branch ran (toast)? | Focus after tap |
|---|---|---|
| `intent://...#Intent;scheme=https;package=com.android.chrome;end` | no | Orca (Chrome not launched) |
| `file:///etc/passwd` | no | Orca |
| `tel:+15551234` | no | Orca |
| `https://example.com/` | n/a (allowed) | Chrome launched |
| `intent://...` with `target="_blank"` | no | Orca |

The `https` tap proves the callback is installed; the dangerous taps prove WebView 133 does not
deliver them to `shouldOverrideUrlLoading` at all. A native block placed there would therefore add
no protection for `javascript:`/`file:`/`intent:`/`tel:` on the tap path. The engine itself refused
those external schemes on this build. We did **not** add a native block that would give false
assurance; the reliable boundary is the document-start fence, and the engine remains the last line
for external schemes. If a future WebView starts delivering these taps, the right follow-up is a
per-view native allowlist prop checked before delegating to JS (not a global change: the app has
five other WebView consumers).

### Device evidence

Fixture `fixtures/preempting-schemes.html` registers window-capture
`stopPropagation`+`stopImmediatePropagation` in its first inline script, pre-seeds the guard
(writable assignment plus a non-configurable redefinition), and has `javascript:`/`file:`/`intent:`
(Chrome target)/`tel:`/custom links, a `formaction` submit button, and fragment/data/https controls.

`logs/preempting-markers.txt` (CDP `Runtime.evaluate`):

```json
{ "headRan": true, "flagSaw": "v2", "flagAfterWrite": "v2",
  "hardFlagError": "TypeError", "guard": "v2",
  "descriptor": { "value": "v2", "writable": false, "enumerable": false, "configurable": false } }
```

`flagSaw === "v2"` proves the fence was installed before the page's first inline script (the page
saw the guard). The page's write left `v2`; its non-configurable redefinition threw `TypeError`.
`logs/preempting-matrix.json` and `screenshots/android-fix02-preempt-*.png`:

| Tap | Page handler observed | Status | Focus |
|---|---|---|---|
| `javascript:` | no | idle (not executed) | Orca |
| `file:` | no | idle | Orca |
| `intent:` (Chrome target) | no | idle | Orca |
| `tel:` | no | idle | Orca |
| custom scheme | no | idle | Orca |
| `formaction="javascript:"` | submit listener not called | idle | Orca |

Each blocked-scheme screenshot carries a distinct red `probe: <scheme>` marker and the toast
“This link type isn't supported in preview”; the fragment/data controls use the same marker and show
the allowed outcome. SHA-256 values are all distinct. `https` still opens Chrome
(`screenshots/android-fix02-https-external.png`, `logs/https-external.txt`).

### Residual

Same-context JavaScript can still sabotage its own event object (for example by replacing
`Event.prototype.preventDefault`); this is capability-equivalent to the artifact's own script for
`javascript:` and cannot be prevented by any page-context fence. External schemes are refused by the
engine on this build; that is an engine property, not an app guarantee. No host bridge or host data
is reachable.

## F-02 — subframe `javascript:`

- The frame passes `injectedJavaScriptForMainFrameOnly={false}` and
  `injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}`. On Android the patched
  document-start handler injects into every origin (`"*"`), including `srcdoc` frames.
- Device proof: the subframe's `window.__orcaHtmlPreviewInterception` is `"v2"` with the same
  non-writable descriptor before the tap (`logs/subframe-iframe.txt`). A trusted tap on the
  iframe's `javascript:` link leaves the parent status `idle`, produces no toast, and keeps focus in
  Orca (`screenshots/android-fix02-iframe-javascript.png`). The old Android injection ran only for
  the main frame, so this guard is direct evidence of the new path.
- The subframe sentinel is still dropped by the existing native message patch (no host toast) by
  design; no external app is launched. iOS uses `WKUserScript` with the same all-frames props, but
  was not run (Xcode 26 blocker).

## F-03 — `formaction` and `form.submit()`

- `event.submitter` is inspected: an explicit `formaction` (including an empty one) takes
  precedence over `form.action`; otherwise `formaction`/`action` reflection is used. Tests cover a
  blocked `formaction` overriding an allowed action and an allowed `formaction` overriding a blocked
  action; the pre-empting device page's `formaction="javascript:"` did not execute.
- `form.submit()` dispatches no `submit` event and is a documented residual; its navigation is
  handled by the native policy/engine.

## F-04 — script-initiated `file:`

- The engine blocks `location.href = 'file://...'` before the JS navigation callback, so no toast is
  shown. We now state this explicitly in design §9.2 and test-plan C12; the fix report no longer
  claims a native callback backstop for this path. The outcome is still safe (no navigation).
- Script `intent:`/custom schemes do reach the native callback and toast; meta refresh is handled by
  the DOM fence and toasts after its delay.

## F-05 — security comments

`MobileHtmlPreview.tsx` now says: no object bridge; one fixed-sentinel message channel that can only
raise the existing toast; page script may forge the toast. `html-preview-interception.ts` documents
the same-context limits and the document-start requirement.

## F-06 — layout test limitation

`MobileFileFilterChips.test.tsx` now states that it is a contract test (react-test-renderer has no
layout engine) and that the on-device bounds are the layout evidence. Fresh device evidence:
`logs/filter-chips-bounds.xml` (row `[0,406][1080,511]` = 105 px = 40 dp, chip
`[32,417][134,501]` = 84 px = 32 dp) and `screenshots/android-fix02-filter-chips.png`.

## F-07 — notification and sweep flooding

- Host: `showBlockedToast` ignores sentinels while the toast is visible (2.5 s), so a page posting in
  a loop causes at most one React update/timer per window. Unit test covers the timer not restarting.
- Script: `notify()` is throttled to one message per 400 ms per document.
- Meta sweep: `MutationObserver` callbacks are coalesced into one 50 ms-debounced sweep instead of a
  full-document `querySelectorAll` per mutation. Unit tests cover the throttle and the debounce.

## F-08 — policy duplication and edge drift

- about rule: the DOM now resolves the URL first and checks `bareDocumentUrl(resolved.href) ===
  'about:blank'`, matching the native `isInlineDocument` decision for `about:blank`,
  `about:blankfoo`, `about:blank?x`, `about:srcdoc` (top frame), and `data:`. Parity tests compare
  the DOM's `defaultPrevented` verdict with `htmlPreviewNavigationDecision` for every absolute form.
- Quoted meta refresh: parsing now stops at the closing quote, as the HTML spec's refresh parser does,
  so `0;url="https://safe" extra` is allowed (the old parser false-positive-blocked it). A blocked
  quoted URL is still removed.
- **Regression found and fixed during this round:** the about check used the raw `href`, so a bare
  `#fragment` resolved to `about:blank#section` but was still cancelled. It now uses the resolved
  URL. Device-verified (`hash` goes from empty to `#section`); the unit test creates a fresh window
  per href so a happy-dom navigation cannot mask the listener state.
- Known engine behavior (not drift): a top-frame `data:` link is allowed by both policies but
  Chromium refuses it with “Not allowed to navigate top frame to data URL”
  (`logs/about-data.txt`). The initial inline preview document is unaffected.

## F-09 — evidence and accounting

- Re-captured per-scheme screenshots with a distinct visible probe marker; all SHA-256 values differ
  (`screenshots/android-fix02-preempt-*.png`, `android-fix02-iframe-javascript.png`,
  `android-fix02-meta-refresh-toast.png`, `android-fix02-https-external.png`,
  `android-fix02-filter-chips.png`).
- `fix-01.md` now has a “Corrections (fix-02)” section: the native-backstop claims, the omitted
  `MobileHtmlPreview.web.tsx`/`html-preview-scheme.test.ts` files, the unreproducible “39 passed (5
  files)” count, and the byte-identical dangerous-scheme screenshots.

## Verification (executed)

```text
# focused fix tests
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx \
  src/files/MobileFileFilterChips.test.tsx
→ Test Files 3 passed (3); Tests 34 passed (34)

# broader focused suite (same set as fix-01 plus all components)
pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts
→ Test Files 102 passed (102); Tests 728 passed (728)

pnpm --dir mobile typecheck
→ exit 0

pnpm --dir mobile exec oxlint <5 changed JS/TS files>
→ no findings

pnpm --dir mobile exec oxfmt --check <5 changed JS/TS files>
→ all matched files use the correct format

pnpm run check:code-quality:changed
→ code quality: 0 new finding(s) across 160 changed file(s)
→ casting code quality: 0 new finding(s)
→ Changed-code quality gate passed since 7bd3928159f5
```

Native rebuild (full log: `device-evidence/fix-02/logs/build-fix02.txt`):

```text
JAVA_HOME=<openjdk-17> gradle-8.13 :app:assembleDebug --offline --no-daemon \
  -PreactNativeArchitectures=arm64-v8a
→ BUILD SUCCESSFUL in 38s
unzip -p app-debug.apk 'classes*.dex' | strings | grep "Document-start injection unavailable"
→ 9Document-start injection unavailable; using onPageStarted
adb install -r app-debug.apk → Success
```

`pnpm install`/`pnpm patch-commit` re-applied the patch and refreshed the lockfile hash.
`mobile/package.json` already had uncommitted `expo-intent-launcher`/`expo-sharing` changes before
this round; the fix-02 lockfile delta is the `react-native-webview` patch hash plus that pre-existing
resolution state.

## Android device checklist (post-fix)

| Case | Result | Evidence |
|---|---|---|
| Pre-empting page + `javascript:` tap | not executed; page listener not called; toast | `preempt-js.png` |
| Pre-empting page + `file:`/`intent:`/`tel:`/custom | no external app; toast; focus Orca | `preempt-file/intent/tel/custom.png` |
| Pre-empting page + `formaction="javascript:"` | not executed; submit listener not called; toast | `preempt-formaction.png` |
| Pre-set writable/non-configurable guard | fence still installed; `TypeError` on hard redefinition | `logs/preempting-markers.txt` |
| Subframe `javascript:` | not executed; no toast (sentinel dropped); no external | `android-fix02-iframe-javascript.png` |
| `#fragment` / `about:blank#frag` | navigates in place | `logs/about-data.txt` |
| `data:` link | fence allows; engine refuses top-frame data navigation | `logs/about-data.txt` |
| `https` link | Chrome opens; preview does not navigate | `android-fix02-https-external.png` |
| meta refresh to `file:` | meta removed; no navigation; toast | `android-fix02-meta-refresh-toast.png` |
| filter chip row | 40 dp row / 32 dp chip, list visible | `logs/filter-chips-bounds.xml` |

## Files changed

- `mobile/src/components/html-preview-interception.ts` — window capture, immediate propagation,
  non-writable guard, submitter form action, resolved-URL about rule, spec quoted URL, throttle,
  debounced sweep, residual comments.
- `mobile/src/components/MobileHtmlPreview.tsx` — all-frames injection props, host toast throttle,
  corrected security comments.
- `mobile/src/components/html-preview-interception.test.ts` — pre-emption, guard race, registration
  order, window capture, `formaction`, throttle, quoted URL, debounce, parity, fragment regression.
- `mobile/src/components/mobile-html-preview-frame.test.tsx` — all-frames prop contract and
  ignore-while-visible throttle.
- `mobile/src/files/MobileFileFilterChips.test.tsx` — contract-vs-layout limitation.
- `mobile/patches/react-native-webview@13.16.2.patch` — Android document-start injection (and the
  existing message-drop hunks).
- `mobile/pnpm-lock.yaml` — patch hash refresh (already dirty before this round).
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/design.md` §9.1/§9.2.
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/test-plan.md` C11b/C12/C18/C19.
- `remote-connectivity/design/test-reports/fix-01.md` — correction section.
- `remote-connectivity/design/test-reports/fix-02.md` and
  `remote-connectivity/design/test-reports/device-evidence/fix-02/**` (fixtures, logs, screenshots).

Unrelated dirty files in the worktree (session/terminal/runtime work) were not modified.

## Residual risks / not fixed

1. Same-context JS can still override event methods; `javascript:` execution is capability-equivalent
   to the artifact's own script. The native layer does not see tapped dangerous schemes on WebView
   133, so the engine's refusal is the last boundary rather than an app policy. This is recorded in
   design §9.1; a future native allowlist prop is the correct follow-up if the engine behavior
   changes.
2. `form.submit()` and script-initiated `http(s)` navigation remain outside the DOM fence (the
   latter is the accepted design §8.1 risk; the former is native/engine territory).
3. A top-frame `data:` link is refused by Chromium even though the policy allows it; this is engine
   behavior, not a fence decision.
4. Subframe sentinels are intentionally dropped, so a subframe's blocked link produces no toast.
5. iOS was not re-run (Xcode 26 / iOS 26 SDK blocker); the iOS path continues to use
   `WKUserScript` at document start with the same all-frames props. The web sandbox path was not
   changed.
6. Physical-device (non-emulator) and resolvable custom-scheme handlers beyond Chrome were not
   tested; the engine refused the resolvable Chrome `intent:` on the emulator.
