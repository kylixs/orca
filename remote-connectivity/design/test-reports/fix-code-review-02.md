# Fix-02 independent code review — DOM fence hardening, subframes, form action, evidence

- Date: 2026-11-10
- Reviewer role: independent, read-only. No product or test code was modified; the only file written is this report.
- Inputs: `fix-02.md`, design.md §9.1/§9.2, test-plan C11b/C12/C18/C19, `fix-01.md` Corrections, the current code/tests/patch, node_modules applied implementation, and `device-evidence/fix-02/**`.
- Method: code and patch reading; focused and broad test runs; typecheck; oxlint/oxfmt; changed-quality gate; review of the committed evidence; independent live probes on `emulator-5554` (Android 16/API 36, WebView 133, app pid 17582) through `adb`, `uiautomator` and the WebView DevTools socket. The preview was reopened and confirmed `document.visibilityState === 'visible'` before the timing-sensitive probes (hidden WebViews freeze timers and are not valid evidence).

## Verdict

**APPROVED_WITH_MINORS.**

| BLOCKER | MAJOR | MINOR |
|---:|---:|---:|
| 0 | 0 | 7 |

The main F-01/F-02/F-03/F-07/F-08 mechanisms now work on the target WebView 133: the document-start fence runs before the page's first inline script, the page's later window-capture `stopPropagation` cannot take precedence, the guard survives writable/poisoned pre-seeds, `formaction` is checked, subframe `srcdoc` frames are fenced, and the late meta sweep/toast/throttles behave. The independent device probes confirm the committed evidence and the native-callback conclusion. The remaining findings are edge-scope and test/evidence completeness issues, not a demonstrated breach of the host/external-scheme boundary.

## Per-item conclusions

### F-01 — pre-emption, guard, native boundary: closed on the document-start path; two edge gaps

- **Ordering is real and independently verified.** On the visible preempting page, the page's first inline script read `window.__orcaHtmlPreviewInterception === 'v2'`; the page's writable assignment left `v2`, and its non-configurable redefinition threw `TypeError`. Trusted taps on the `javascript:` link and the `formaction="javascript:"` button left the page status `idle`; the page's window-capture click/submit listeners did not run (the js case's `__pageClickObserved` stayed unset; the form case's `clickObserved` was true only because the fence does not cancel non-link clicks, while `submitObserved` stayed unset). The fragment control navigated (`#section`). This matches the committed matrix.
- **Native-callback conclusion is supported.** The `native-callback-probe.txt` probe, run against the unchanged native policy, shows `intent:`/`file:`/`tel:`/`javascript:` taps producing no toast and no external app, while `https` opened Chrome. This is consistent with the pre-fix independent finding and with the live probes; a `WebViewClient`-level block cannot cover a tap the WebView never delivers. Correcting the fix-01 claim was the right resolution.
- **Still reproducible edge gaps:**
  - **Guard race (fallback/page-first only).** The early return at `html-preview-interception.ts:49-51` matches a page-controlled descriptor. A page that runs before the fence (the `onPageStarted` fallback on WebView < 89, or if document-start is unavailable) can pre-define `{ value: 'v2', writable: false, configurable: false }` and the script returns before installing any listener. I confirmed this in a fresh happy-dom window: `defaultPrevented: false`, no sentinel. The existing test only pre-defines `'poisoned'`, so it passes while the exact-value case fails. This is not reachable on the document-start path (the fence wins first), but it is the fallback path and the report's “the page cannot … disable the guard” is too strong there.
  - **Dynamic `about:blank` iframe written with `document.write` has no fence.** See F-02 below.
  - The documented same-context residuals are real: after replacing `Event.prototype.preventDefault` with a no-op, a trusted tap on a `javascript:` link executed; `form.submit()` on a `javascript:` action executed (no submit event). These are capability-equivalent to the page's own script and are correctly documented as residual.
  - `target="_blank"` on an `intent:` link was cancelled by the fence: no new page target, no external app, toast shown.
- **Non-configurable guard:** effective against writable/poisoned pre-seeds and against page redefinition after install; not effective against the exact-value pre-seed before install (above).

### F-02 — all-frame injection: static and srcdoc frames covered; dynamically written `about:blank` frames are not

- The frame passes both `...ForMainFrameOnly={false}` props. On the visible device, a dynamically created `srcdoc` iframe got `window.__orcaHtmlPreviewInterception === 'v2'` and a trusted tap on its `javascript:` link did not execute; the committed static `srcdoc` fixture shows the same. Subframe sentinels remain dropped (the iframe evidence shows no toast; the round-1 independent probe verified the native message drop). Android document-start injection via `Collections.singleton("*")` reaches srcdoc frames; iOS uses `WKUserScript` with the same all-frames props (not run; Xcode blocker).
- **Gap:** an iframe created as `about:blank` and then populated with `document.write` (or `contentDocument` DOM APIs) never starts a page navigation, so no document-start script runs and no guard is present. I confirmed on the visible device: the frame had no guard and a trusted tap on its `javascript:` link **executed** (`dataset.js === 'yes'`; the iframe click listener ran). Dangerous `intent:`/`file:` links in such a frame did not launch an external app and produced no toast (the engine refused them), so the host/external boundary held; the `javascript:` execution is capability-equivalent to the parent page's script. The fix report's “the fence is injected into all frames” and C18's “both frames inject the fence” are true for navigated/srcdoc frames but not for a dynamically written about:blank document. Add a fixture/test for this path and document the limitation, or treat the engine as the last line for external schemes there.
- The `onPageStarted` fallback is main-frame only; on WebView < 89, static subframes are also unfenced. The report does not state a WebView floor or the fallback's all-frame limitation.

### F-03 — `formaction` and `form.submit()`

- The submitter check is correct: `hasAttribute('formaction')` wins (including an explicit empty one), otherwise the `formAction` reflection, otherwise `form.action`. The unit tests cover a blocked formaction overriding an allowed action and an allowed formaction overriding a blocked action; the preempting-page formaction tap left status idle and the page's submit listener unset.
- `form.submit()` remains a documented residual. I confirmed that a form whose `action` is `javascript:void(...)` executes the script when `form.submit()` is called (no submit event). This is the same capability as page script; the test-plan C12 and design §9.1 state the residual. No new finding.

### F-04 — script `file:`

- Wording is corrected in design §9.2 and test-plan C12: script `file:` can be refused by the engine with no toast; script `intent:`/custom reach the native callback and toast. The correction matches the earlier independent probe. No finding.

### F-05 — comments

- `MobileHtmlPreview.tsx:33-36,80-89` now describe the no-object-bridge, fixed-sentinel toast-only channel and the page-forged-toast boundary; `html-preview-interception.ts:9-16,24-39` documents the document-start requirement and same-context limits. Correct; no finding.

### F-06 — layout test limitation

- `MobileFileFilterChips.test.tsx:53-55` explicitly states it is a contract test and points to the on-device bounds. The fresh fix-02 bounds are consistent: row `[0,406][1080,511]` (105 px = 40 dp), chip `[32,417][134,501]` (32 dp); the screenshot shows the row and list. R-11 is closed as far as react-test-renderer can, with the device evidence as the layout proof. No finding.

### F-07 — notification and sweep flooding

- Host: the `toastVisible` ref ignores repeats while the 2.5 s toast is visible; the frame test verifies the timer is not restarted. Script: the 400 ms notify throttle works (unit test; live one-toast outcome). The MutationObserver is 50 ms-debounced and the unit test counts one sweep for 20 mutations.
- **Timing caveat (MINOR):** for a late `<meta http-equiv=refresh content="0;url=...">`, the browser's refresh task is due immediately, while the debounced removal runs after ~50 ms. On the visible WebView 133 the meta was removed at ~60 ms, no navigation occurred, and the toast appeared; the engine refused the `file:`/Chrome-target `intent:` targets, so no breach was observed. The claim “removing the element before its navigation task runs” is therefore not an app-level guarantee for delay 0; the committed fixture uses a 1 s delay and the unit 0-delay test checks removal after 120 ms, not before a navigation task. See M-03.

### F-08 — policy drift, quoted URL, fragment

- The resolved-URL `about:blank` rule matches the native absolute-form decisions; the quoted-refresh parser stops at the closing quote and the parity test covers the listed absolute forms; the bare `#fragment` regression was found and fixed (live hash `#section`). The `data:` top-frame link is allowed by both policies and refused by Chromium (documented; not a fence decision).
- **Residual parity gap (MINOR):** the parity test is top-frame only. In a subframe, the native policy allows `about:srcdoc` (`isInlineSubframeDocument`), while the DOM fence's `isBlocked` blocks it (it only allows `about:blank`). The subframe sentinel is dropped, so the user sees no feedback. This is rare and not a security boundary, but it is drift between the two policies.

### F-09 — evidence and accounting

- The fix-02 screenshots have distinct SHA-256 values (verified: all 12 differ) and the pre-empt screenshots carry distinct visible `probe: <scheme>` markers; `preempting-markers.txt` matches the live guard descriptors; `preempting-matrix.json`/logs are consistent with the independent taps; `native-callback-probe.txt` is credible. The focused count (34/3) and broad count (102/728) match; typecheck/lint/format/gate pass. The fix-01 Corrections section is accurate.
- **Minor evidence/UX issue:** `android-fix02-iframe-javascript.png` visibly shows a **false relative-asset warning**: “Relative assets may not load: &quot;javascript:void(parent.document.getElementById(...”. This is the file preview's relative-asset detector scanning the escaped `srcdoc` attribute; the detector returns `&quot;javascript:void(parent.document.getElementById(` for the fixture. It is not caused by the fence, but it is a new visible regression/noise in the file-browser HTML preview and is not mentioned in the fix report. See M-07.
- The fix-02 report still does not list `MobileHtmlPreview.web.tsx`/`html-preview-scheme.test.ts` in “Files changed” (the fix-01 corrections mention them); they may be pre-existing dirty files, but the accounting is incomplete.

## Findings

### M-01 — MINOR — guard exact-value pre-seed disables the fence on the page-first/fallback path

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:46-63`; test gap `mobile/src/components/html-preview-interception.test.ts:207-224`.
- **Problem:** the early return trusts a page-controlled descriptor. If a page can run before the fence (the `onPageStarted` fallback on WebView < 89, or a failed document-start registration), it can define `window.__orcaHtmlPreviewInterception = 'v2'` with `writable:false, configurable:false`; the script returns without installing listeners. The report/test only cover `'poisoned'`, so the guard is claimed stronger than it is. The comment “the cost is a duplicate listener” is false for the exact-value case; the cost is no listener.
- **Failure scenario:** on a WebView without `DOCUMENT_START_SCRIPT`, an artifact's first inline script pre-seeds the exact guard; a later `javascript:`/`file:`/`intent:` tap is not seen by the fence. External schemes still depend on the engine; the app's scheme policy is absent.
- **Suggested fix:** remove the early return and always install listeners (the `WeakSet` makes duplicate handling safe), or use a non-forgeable per-document marker. Add a test with the exact `'v2'` non-configurable pre-seed; state the supported WebView floor and the fallback's limitations.

### M-02 — MINOR — dynamically written `about:blank` subframes are not fenced

- **Files/lines:** `mobile/src/components/MobileHtmlPreview.tsx:111-114` (all-frames props); `html-preview-interception.ts` document-start design; test/fixture gap (`iframe-javascript.html` is a static `srcdoc`).
- **Problem:** a frame created as `about:blank` and populated with `document.write`/`contentDocument` never starts a navigation, so no document-start script runs. The independent visible-page probe found no guard and a trusted tap on its `javascript:` link executed. External `intent:`/`file:` taps in that frame were engine-refused with no toast, so the host/external boundary held.
- **Failure scenario:** a malicious artifact creates a `about:blank` iframe, writes a link, and lures a tap; `javascript:` executes and the F-02/C18 claim “iframe javascript: not executed” fails for this path. Capability-equivalent to the artifact's own script; no external app observed.
- **Suggested fix:** add a fixture/test with a dynamically created about:blank frame; document that document-start cannot cover non-navigated documents and the engine is the last line; consider injecting on frame attachment where the platform allows it. Also state the `onPageStarted` fallback is main-frame only.

### M-03 — MINOR — the 50 ms meta debounce loses the “remove before the 0-delay refresh task” guarantee

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:210-221`; tests `html-preview-interception.test.ts:328-337,369-384`; fixture `meta-refresh-blocked.html` uses `content="1;url=..."`.
- **Problem:** a late 0-delay blocked meta is removed by the debounced sweep at ~50-60 ms. The browser's refresh task is due at 0 ms; the app-level removal is not before it. On WebView 133 the engine refused `file:` and the Chrome-target `intent:`, so no breach was observed, and the toast appeared; but the design claim “removed before its navigation task runs” is not guaranteed for delay 0, and the tests/evidence do not exercise that race (the unit test checks removal after 120 ms).
- **Suggested fix:** remove a newly added blocked meta synchronously in the MutationObserver callback (or run a targeted sweep when a meta is added) and keep the debounce for the broader scan; add evidence/assertion for a 0-delay blocked refresh, or document that the engine/native layer is the boundary in that window.

### M-04 — MINOR — `ScriptHandler` is not removed on WebView destroy

- **Files/lines:** `mobile/patches/react-native-webview@13.16.2.patch:42-90,91-113`; applied `node_modules/.../RNCWebView.java:320-356,462-473`.
- **Problem:** the patch removes/re-registers the document-start handler when the props change, but `destroy()`/`cleanupCallbacksAndDestroy()` do not call `injectedJSBeforeContentLoadedHandler.remove()`. The handler holds a native script registration and a WebView reference; on normal WebView teardown it is likely collectable with the WebView, but the lifecycle is incomplete and can leak/keep a registration until native teardown.
- **Suggested fix:** remove the handler in `destroy()`/cleanup before `super.destroy()`, and add a small lifecycle test or comment.

### M-05 — MINOR — lockfile diff is much larger than the claimed patch-hash refresh

- **Files/lines:** `mobile/pnpm-lock.yaml` (2,642 changed lines); `fix-02.md:253-256`.
- **Problem:** the patch hash change is correct (`react-native-webview@13.16.2` hash refreshed), but the lockfile also re-resolves many transitive peer suffixes (`supports-color@8.1.1` additions across packages). The report says “the only fix-02 lockfile change is the patch hash plus that pre-existing resolution state”; the diff is not reviewable as a patch-only change and its relation to the pre-existing state is not demonstrated.
- **Failure scenario:** a reviewer cannot separate the intentional patch registration from unrelated resolution churn; a different pnpm version may reproduce a different graph. Not a runtime bug observed.
- **Suggested fix:** regenerate with the repo's pinned pnpm/`--frozen-lockfile` where possible, or split/justify the unrelated resolution changes; keep the patch hash and `patchedDependencies` entry.

### M-06 — MINOR — subframe `about:srcdoc` policy drift and top-frame-only parity test

- **Files/lines:** `mobile/src/components/html-preview-scheme.ts:29-33,45-49`; `html-preview-interception.ts:100-103`; parity test `html-preview-interception.test.ts:387-421` (top frame only).
- **Problem:** the native subframe policy allows `about:srcdoc`; the DOM fence in a subframe blocks it (the `isBlocked` about rule only allows `about:blank`), and the subframe sentinel is dropped so there is no feedback. The parity test compares only top-frame decisions.
- **Failure scenario:** a subframe link to `about:srcdoc` is silently cancelled while the native policy would allow it. Rare; no security impact.
- **Suggested fix:** add a subframe-aware parity test or a documented exception for `about:srcdoc` in the DOM fence; keep the `#fragment`/`about:blank` behavior (verified).

### M-07 — MINOR — false relative-asset warning for a JavaScript link inside `srcdoc`

- **Files/lines:** `mobile/src/files/html-relative-assets.ts:18-28`; evidence `device-evidence/fix-02/screenshots/android-fix02-iframe-javascript.png`; fixture `fix-02/fixtures/iframe-javascript.html`.
- **Problem:** the detector scans the whole HTML, including the escaped `srcdoc` attribute. For the iframe fixture it returns `&quot;javascript:void(parent.document.getElementById(` and the preview shows “Relative assets may not load: &quot;javascript:void(...”. `javascript:` is explicitly excluded by design §8.6; the detector only sees the escaped `&quot;` and treats it as a relative path. This is unrelated to the fence but is visible in the new fix-02 evidence and will affect user HTML with an iframe `srcdoc`.
- **Failure scenario:** a valid iframe `srcdoc` containing a link triggers a false warning (and garbled text) in the file-browser HTML preview; users may think the preview is broken.
- **Suggested fix:** skip `srcdoc` attribute contents when scanning top-level assets (the frame document is not a top-level asset), or decode HTML entities before the scheme check; add a fixture test.

## Verification commands and results

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx \
  src/files/MobileFileFilterChips.test.tsx
→ Test Files 3 passed (3); Tests 34 passed (34)   (matches fix-02.md)

pnpm --dir mobile test src/components \
  src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx \
  src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx \
  src/files/MobileFileExplorerPanel.test.ts
→ Test Files 102 passed (102); Tests 728 passed (728)   (matches fix-02.md)

pnpm --dir mobile typecheck → exit 0
pnpm --dir mobile exec oxlint <5 files> → exit 0
pnpm --dir mobile exec oxfmt --check <5 files> → all matched files use the correct format
pnpm run check:code-quality:changed
→ 0 new findings across 160 changed files; gate passed since 7bd3928159f5
```

Patch/install checks:

```text
mobile/pnpm-workspace.yaml registers react-native-webview@13.16.2 → patches/react-native-webview@13.16.2.patch
node_modules/react-native-webview/android/.../RNCWebView.java contains
  WebViewCompat.addDocumentStartJavaScript(... Collections.singleton("*"))
node_modules/.../RNCWebViewManagerImpl.kt routes the two prop setters to the new methods
Only MobileHtmlPreview uses injectedJavaScriptBeforeContentLoaded in mobile/src.
```

Independent Android probes (visible preview, `document.visibilityState === 'visible'`):

- Preempting fixture: page's first inline script saw guard `v2`; writable write left `v2`; hard redefinition threw `TypeError`; descriptor `{value:'v2', writable:false, enumerable:false, configurable:false}`.
- Trusted tap on `javascript:` → status idle, page click listener not called, toast; `formaction="javascript:"` → status idle, submit listener not called, toast; `#fragment` → `#section`.
- Visible-page late meta: 0-delay `file:` removed at ~60 ms, no navigation; 0-delay `intent:` (Chrome target) removed at ~60 ms, no Chrome, toast; 1 s static fixture evidence reviewed.
- Dynamic `srcdoc` iframe: guard `v2`; iframe `javascript:` tap did not execute. Static iframe evidence reviewed; subframe sentinel drop verified in the previous round and unchanged.
- Dynamic `about:blank` iframe written with `document.write`: **no guard**; iframe `javascript:` tap executed (`dataset.js='yes'`); `intent:`/`file:` taps produced no external app/no toast (engine refused). This is M-02.
- `form.submit()` with a `javascript:` action executed (documented residual); `Event.prototype.preventDefault` tamper let a `javascript:` tap execute (documented residual); `target="_blank"` dangerous link cancelled with toast, no new target.
- Guard exact-value pre-seed: happy-dom probe returned `defaultPrevented:false`, no sentinel (M-01).
- Evidence: all 12 fix-02 PNG SHA-256 values distinct; markers visible; preempting-matrix/logs consistent; filter-chip bounds `[0,406][1080,511]`/`[32,417][134,501]`; https evidence reviewed (not re-run to avoid changing focus). The iframe screenshot exposes the M-07 warning.
- Native callback probe reviewed; `https` reaches the callback, tapped `javascript:`/`file:`/`intent:`/`tel:` do not (no toast, focus stays Orca), supporting the report's corrected claim.

Not run: iOS (Xcode 26 blocker), physical device, resolvable custom-scheme handlers beyond Chrome, and a clean-install rebuild (the installed APK and live document-start behavior were verified; the build log was reviewed).

## Residual risks

1. Same-context JavaScript can still tamper with event methods, `form.submit()`, `location.href`, closed shadow DOM, and dynamically written documents; `javascript:` execution remains capability-equivalent to the artifact's own script. External schemes are refused by the engine on WebView 133, not by an app guarantee; a future WebView that delegates these taps needs a per-view native allowlist.
2. WebView < 89 has only the `onPageStarted` fallback: it is page-first-preemptible, the exact-value guard can disable it, and subframes are not covered. State the supported WebView floor or gate the preview on `DOCUMENT_START_SCRIPT`.
3. The 50 ms debounce leaves a short window for 0-delay meta refreshes; the engine/native layer is the boundary there.
4. Subframe sentinels are intentionally dropped, so subframe blocks have no toast; the `about:srcdoc` parity gap is silent.
5. The false relative-asset warning for `srcdoc` links is user-visible in the file preview.
6. Lockfile churn beyond the patch hash and the missing `ScriptHandler` cleanup are reviewability/lifecycle debt, not observed runtime failures.
