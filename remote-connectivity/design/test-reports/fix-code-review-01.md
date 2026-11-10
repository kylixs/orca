# Fix-01 independent code review — Android `javascript:` escape, filter chips, meta refresh

- Date: 2026-11-10
- Reviewer role: independent, read-only. No product or test code was modified; the only file written is this report.
- Inputs: `test-review-01.md` (R-01/R-02/R-03/R-10/R-11), `fix-01.md`, design.md §9, test-plan C10/C11b/C12/C19, and the fix code/tests/callers.
- Method: code reading, focused and broad test runs, typecheck, oxlint, changed-quality gate, review of the committed device evidence, and independent live probes on the still-running emulator (`emulator-5554`, Android 16/API 36, WebView 133, app pid 16072) via `adb`, `uiautomator`, and the WebView DevTools socket (`tcp:9222`).
- Working-tree note: the checkout mixes fix-01 with the broader (uncommitted) feature work. This review evaluates the current worktree state of the named files; findings outside those files are marked as such.

## Verdict

**CHANGES_REQUIRED.**

| BLOCKER | MAJOR | MINOR |
|---:|---:|---:|
| 0 | 1 | 8 |

The original R-01 exploit is fixed: a plain tap on `<a href="javascript:...">` no longer executes script; Android shows the in-frame toast and keeps the preview mounted. R-02 and R-03 are also fixed and were independently verified. The blocking issue is a security-control gap in the new DOM fence: because the fence runs in the same JS context as the untrusted page, page script can pre-empt it, and the claimed native `onShouldStartLoadWithRequest` backstop does **not** run for tap-initiated non-http(s) navigations on this build. The app's scheme policy is therefore not applied on that path. On the emulator the WebView engine still refused `intent:`/`file:`/`tel:` (no external app), but a resolvable `intent:` on a real device was not verified, so the report's "native callback still refuses" claim is not established.

## Per-item conclusions

### 1. R-01 — Android `javascript:` escape

- **Core case: fixed and independently reproduced.** In the live WebView, tapping the `javascript link` in `dangerous-schemes.html` produced “This link type isn't supported in preview”, no native JavaScript dialog, no navigation, and `mCurrentFocus` stayed `com.stably.orca.mobile/.MainActivity`. A real CDP tap on a fresh `javascript:` anchor was blocked (a control `#fragment` tap and a `javascript:` tap both proved the tap reaches the page and default actions run).
- **Delegation / late nodes / child nodes: sound for ordinary pages.** The capture-phase listener on `document` runs before page bubble handlers and finds links via `composedPath` or `closest`; anchors added after load are covered. Tests exercise child-element taps and post-load anchors.
- **Bypasses exist and were reproduced on the real WebView:**
  - A page-installed `window.addEventListener('click', e => e.stopPropagation(), true)` runs before the `document` capture listener and prevents it. A trusted tap then executes `javascript:` (verified: the injected handler set a dataset value). This is a one-line, same-context bypass.
  - The idempotency flag `window.__orcaHtmlPreviewInterception` is page-writable (`html-preview-interception.ts:33-34`); if Android's before-content-loaded injection lands after an inline page script, the page can pre-set the flag and the fence (including the post-load pass) never installs.
  - The injection is main-frame-only. An unsandboxed `srcdoc` iframe containing a `javascript:` link executes it on a real tap (verified); subframes have no fence.
  - Form submission checks only the form's `action`; a submitter's `formaction="javascript:..."` executes when the form action is allowed (verified). A window-capture `submit` listener likewise pre-empts the fence (verified with `action="javascript:..."`).
- **Native callback backstop: not present on the tap path.** For pre-empted taps on `intent:`, `file:` and `tel:`, no toast appeared, i.e. the app's `block` branch did not run; the WebView engine refused the navigation on this emulator (no external app, focus unchanged). For script-initiated navigation, `intent:` produced a toast (callback ran) while `file:` was blocked silently (engine, callback not run). The fix report's statement that the native callback is the backstop for pre-empted taps and for script `file:` navigation is therefore inaccurate. The native policy code itself is unchanged and was not weakened.
- **Scheme policy behavior:** `http(s)` top-frame → external; `mailto:` top-frame → external; `data:`/`about:blank`/`#fragment` → in place; relative/root-relative and `file:`/`intent:`/`tel:`/custom → blocked with toast. This matches design §8.1. Minor DOM/native drift on `about:blank*` forms is noted in F-08.

### 2. Fixed-sentinel `onMessage` channel

- **Boundary holds.** `isHtmlPreviewBlockedMessage` is strict equality; the handler reads no URL and performs only the existing toast action. The frame test asserts arbitrary strings, JSON, case/whitespace variants and non-strings are ignored, and that `injectedJavaScriptObject` is not passed. No host data is reachable and no other host action exists.
- **Subframe drop is real and was verified live.** The repo patch (`mobile/patches/react-native-webview@13.16.2.patch`, registered in `mobile/pnpm-workspace.yaml`) drops non-main-frame and non-string messages; the installed package contains it. On the device, an iframe `postMessage(sentinel)` produced no toast; a main-frame `postMessage(sentinel)` produced one. C19's subframe property is satisfied on Android.
- **Page can forge a toast.** This is explicitly accepted by design §9; a page can also flood the sentinel (see F-07).
- **Documentation is stale/incorrect.** The frame still says “no host bridge” and “the injected interceptor is the only writer of this channel … cannot … reach any host behaviour”. The page can write the channel and can raise the toast (a host UI action). See F-05.

### 3. Meta-refresh fence

- **Reliable in unit tests and on the real WebView.** The live probe added `<meta content="1 ; URL = &quot;file:///etc/passwd&quot;" http-equiv="Refresh">`; it was removed within 300 ms (MutationObserver), the document did not navigate, and the toast appeared at the original 1 s delay. Case, whitespace, attribute order and quoted URLs are covered by `html-preview-interception.test.ts:159-198`; `http(s)` is preserved and same-document refresh is untouched.
- **No silent bypass observed.** DOM-attribute parsing avoids reserialization; if injection were missed, the engine/native layer still blocks `file:` (silently), which is safe though not toasted.
- **Minor risks:** full-document `querySelectorAll` on every childList mutation is O(n) per mutation (F-07); a malformed quoted URL can false-positive a refresh the browser would allow (fails safe; F-08); a removed/replaced meta can still fire a delayed toast.

### 4. R-02 — filter chips layout

- **Fix is correct.** The horizontal `ScrollView` now sets `flexGrow: 0, flexShrink: 0`, overriding RN's `baseHorizontal` (`flexGrow: 1, flexShrink: 1`) that caused the full-height column. Device evidence supports the claim: row `[0,406][1080,511]` (105 px = 40 dp), chip `[32,417][134,501]` (32 dp), identical with the IME open; the keyboard screenshot shows the row and list visible. Screenshot and XML are consistent.
- **No hit-area / accessibility regression found.** Roles, labels, selected state and `hitSlop` are preserved; 40 dp row + 6 dp vertical hitSlop stays inside the row.
- **Test caveat:** `MobileFileFilterChips.test.tsx:48-64` asserts style props, not rendered height. It reliably fails if the fix is removed, but cannot catch a parent-layout regression or a non-RN layout change. The on-device bounds are the real layout evidence; R-11 is only partially closed in automation (F-06).

### 5. Test quality

- **Substantial improvement.** `html-preview-interception.test.ts` evaluates the shipped script verbatim and dispatches real click/submit events; this closes the R-10 tautology (calling `onShouldStartLoadWithRequest` directly). The frame test checks both injection points, the restricted handler, ignored payloads and the iOS/Android selection branch.
- **Stable.** Repeated runs were deterministic; fake timers and MutationObserver microtasks are handled correctly; Platform is mocked and reset.
- **Still missing:** pre-emption/flag race, subframe `javascript:`, `formaction`/`form.submit()`, and a measured layout assertion. C19's subframe behavior is device-only (the frame test cannot exercise the native patch). The frame unit test still mocks `react-native-webview`, which is appropriate for prop wiring but is not an Android integration test; the new device taps are the integration evidence.

### 6. Regression risk in callers

- **Session file page:** `MobileSessionFileReader` uses the wrapper (`MobileHtmlPreview`), which keeps its own mode state, toolbar and `openExternalLink`; Preview/Source behavior, toast placement and text selection are unchanged. No regression observed in code; it was not re-run on device this round (report also says so).
- **File-browser preview:** `MobileFilePreviewBody` mounts `MobileHtmlPreviewFrame` only for `htmlMode === 'preview'`, with `showToolbar={false}` and `mode="preview"`; the screen's own HTML controls still own the mode. External links use the same `openExternalLink`; blocked schemes now get the in-frame toast instead of being handed to the host (intended). The 102-file/717-test focused suite passes.
- **Toast:** absolutely positioned with `pointerEvents="none"`, so it cannot swallow touches.

### 7. Code quality / AGENTS.md

- Typecheck, oxlint and the changed-quality gate pass. No new type assertions in product code (the test's `as` has a `SAFETY:` comment), no `max-lines` disables, no hardcoded platform keyboard behavior, no new bridge object.
- Naming and structure are good; the whitelist is shared to prevent drift, and the script is documented.
- Issues: stale security comments (F-05); the pure policy and the DOM policy are two implementations with only the whitelist shared (F-08); the notification path has no throttle (F-07).

### 8. Independent verification of the fix report

| Claim | Result |
|---|---|
| Target tests pass | **Verified** — the four named fix test files: 32/32 passed. |
| Broader focused suite `102 files / 717 tests` | **Verified** — identical result. |
| `pnpm --dir mobile typecheck` | **Verified** — exit 0. |
| `oxlint <changed files>` | **Verified** — no findings. |
| `pnpm run check:code-quality:changed` | **Verified** — 0 new findings across 160 files; gate passed since `7bd3928159f5`. |
| On-device `javascript:` tap → toast, no dialog | **Verified independently.** |
| Subframe message drop | **Verified independently** (iframe sentinel → no toast; main-frame → toast). |
| Meta refresh removed, no navigation, toast | **Verified independently** in the live WebView. |
| `https` still opens externally | Evidence reviewed (screenshot); not re-run to avoid focus changes. |
| Filter-chip bounds / keyboard | Evidence reviewed (XML + screenshots); consistent. |
| “Native callback is the backstop” for pre-empted taps | **Not verified; contradicted by probe** (no toast/callback on pre-empted tap). |
| “Focused 39 passed / 5 files” | The named four fix files total 32; the fifth file is unstated. The 102/717 figure is reproduced; treat 39/5 as unverified, not contradicted. |
| Four dangerous-scheme screenshots | All four are byte-identical (same SHA-256), so they do not independently prove which link was tapped; the log narrative and the independent probe cover the behavior. |

## Findings

### F-01 — MAJOR — the DOM fence is same-context pre-emptable, and the claimed native backstop does not run for pre-empted taps

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:33-34` (page-writable idempotency flag), `:88-91` (`document` capture click listener), `:93-98` (submit listener); `mobile/src/components/MobileHtmlPreview.tsx:58-70` (native policy); `remote-connectivity/design/test-reports/fix-01.md:45-58, 201-210` (claim).
- **Problem:** The security fence lives in the same JS context as the untrusted artifact. Page script can pre-empt it before it runs, so the stated policy is not enforced on a user tap. The mitigation claim (“the native callback still refuses non-whitelisted navigations”) is false for the tap path and for `javascript:`, which Android never delivers to the callback.
- **Failure scenario (reproduced on the real WebView):**
  1. Malicious artifact runs `window.addEventListener('click', e => e.stopPropagation(), true)` in an early inline script (or wins the before-content-loaded race and sets `window.__orcaHtmlPreviewInterception = true`).
  2. It renders a link or submit button using `javascript:`, `intent:`, `file:` or a custom scheme.
  3. The user taps it. The `document` capture listener never sees the click; a real tap executes `javascript:` (verified), or the WebView takes the external navigation.
  4. For pre-empted `intent:`/`file:`/`tel:` taps, no toast appeared, so the app's `block` branch did not run. The emulator's WebView refused the navigations (no external app, focus stayed in Orca), but a resolvable `intent:` targeting an installed app was not tested and remains unverified.
- **Impact:** The original plain-tap blocker is fixed, but the fence is not a reliable security control against an adversarial artifact; the app's scheme policy is absent exactly on the bypass path. The page gains no host data or bridge capability; the risk is external-app launch / policy violation, not host compromise.
- **Suggested fix:**
  - Add a native hard block for non-http(s) navigations at the WebView client level (a native `shouldOverrideUrlLoading`/patch that returns override for `file:`, `intent:`, `tel:`, custom schemes before delegating to JS), so the policy does not depend on page-context JS.
  - Harden the fence: register the click/submit listeners on `window` capture as well as `document`, and replace the page-writable flag with a non-enumerable/non-configurable guard (best-effort; native remains the boundary).
  - Add a device test with a resolvable `intent:` (a small test app handling a custom scheme, or a target with a known handler) and with a pre-empting page.
  - Correct the fix report/design claim about the native callback backstop.
- **Residual note:** Even after this, same-context JS can always interfere with same-context listeners; the honest statement is that `javascript:` execution is capability-equivalent to the artifact's own script, and the native layer must own external-scheme refusal.

### F-02 — MINOR — subframe `javascript:` is not fenced

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:31-145` is injected only into the main frame (default `injectedJavaScriptForMainFrameOnly`); design.md §9.1 (“子帧危险 scheme 仍由 WebView 默认策略阻止”); test-plan C11b.
- **Problem:** The injection does not cover subframes. An unsandboxed `<iframe srcdoc>` with a `javascript:` link executed it on a real tap (verified). `file:`/`intent:` in iframes did not open an external app (engine refused), so the external boundary held, but the blanket claim is wrong for `javascript:`.
- **Suggested fix:** Document the residual and adjust C11b wording, or inject into all frames where supported / sandbox preview iframes. This is capability-neutral (the page already runs script).

### F-03 — MINOR — form submission checks only `action`, not the submitter's `formaction`; `form.submit()` bypasses the listener

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:93-98`; test coverage `mobile/src/components/html-preview-interception.test.ts:133-146`.
- **Problem:** A submitter's `formaction="javascript:..."` is not inspected. Verified on the real WebView: with `action="data:..."` (allowed by the fence) and `formaction="javascript:void(...)"`, the submit fired and the `javascript:` ran. A window-capture `submit` stopPropagation also pre-empts the fence, and `form.submit()` does not dispatch a submit event.
- **Impact:** Capability-neutral (page script already runs), but the fence's “form actions are covered” statement is incomplete.
- **Suggested fix:** Use `event.submitter?.formAction` when present in addition to the form action, and document `form.submit()` as a residual. Add a test.

### F-04 — MINOR — script-initiated `file:` navigation is blocked silently (C12 toast not met)

- **Files/lines:** `mobile/src/components/MobileHtmlPreview.tsx:58-70`; test-plan C12 (`test-plan.md:82`); `fix-01.md:143-148`.
- **Problem:** On Android, `location.href = 'file:///etc/passwd'` stayed on the document but produced no toast; the WebView engine blocked it before the JS navigation callback. `intent:` did produce a toast (callback ran). The fix report's “native callback backstop for script file:” is inaccurate for the feedback path; the outcome is safe.
- **Suggested fix:** Either accept/update C12 to say the engine may block silently, or add a best-effort feedback mechanism. Do not claim the callback handles `file:`.

### F-05 — MINOR — stale/incorrect security comments

- **Files/lines:** `mobile/src/components/MobileHtmlPreview.tsx:33-36` (“no host bridge”), `:72-76` (“the injected interceptor is the only writer … cannot reach any host behaviour”).
- **Problem:** The WebView now has a restricted host message channel, and any page script can write to it (toast only). The comments contradict design §9 and overstate isolation.
- **Suggested fix:** Say “no object bridge; one fixed-sentinel message channel that can only raise the existing toast; page script may forge the toast.”

### F-06 — MINOR — R-11 test pins implementation, not layout

- **Files/lines:** `mobile/src/files/MobileFileFilterChips.test.tsx:48-64`.
- **Problem:** The test asserts `flexGrow`/`flexShrink` style values and `minHeight`. It catches removal of the exact fix but cannot catch a parent-layout regression, a different source of vertical stretch, or the actual rendered height. R-11's “layout test” is only a contract test; the device bounds are the real evidence.
- **Suggested fix:** Add a measured layout/e2e assertion (or keep the device-bounds artifact as the verification record and state the limitation). The current test is still useful and stable.

### F-07 — MINOR — sentinel/meta notification flood has no throttle

- **Files/lines:** `mobile/src/components/MobileHtmlPreview.tsx:41-47` (each sentinel resets state and timers), `mobile/src/components/html-preview-interception.ts:120-133` (every blocked meta schedules a notify; the observer sweeps on every childList mutation).
- **Problem:** A page can post the sentinel in a tight loop or insert many blocked metas, causing repeated React updates/timers on the RN JS thread and repeated full-document `querySelectorAll` sweeps. Malicious HTML can degrade the host UI (DoS), not access data.
- **Suggested fix:** Ignore sentinels while the toast is visible (or throttle), cap notifications per document, and debounce the meta sweep.

### F-08 — MINOR — policy duplication and edge drift

- **Files/lines:** `mobile/src/components/html-preview-scheme.ts:41-53` and `mobile/src/components/html-preview-interception.ts:48-63, 100-118`.
- **Problem:** Only the whitelist is shared; the rest of the policy is implemented twice. Divergences: the DOM allows any `about:blank*` prefix (e.g. `about:blankfoo`) while the native `bareDocumentUrl` requires a bare/fragment `about:blank`; the meta-refresh quote stripping can false-positive-block a refresh the browser would allow (`"https://safe" extra`); `file:` script navigation is engine-blocked without toast while `intent:` is callback-blocked with toast.
- **Impact:** No security gap found; false-positive toast / inconsistent feedback and future drift risk.
- **Suggested fix:** Keep the whitelist shared (already done), add parity tests for `about:`/quote edge cases, and document the known divergences.

### F-09 — MINOR — evidence/report accuracy

- **Files/lines:** `remote-connectivity/design/test-reports/device-evidence/fix-01/screenshots/android-dangerous-*.png`; `fix-01.md:184-199` (files changed); `fix-01.md:165-166` (focused count).
- **Problem:** The four dangerous-scheme screenshots are byte-identical (same SHA-256), so they do not independently show which scheme was tapped; the log narrative is the only differentiator. The “Files changed” list omits `mobile/src/components/MobileHtmlPreview.web.tsx` (dirty in the worktree and carrying the frame split) and does not mention `html-preview-scheme.test.ts`. The “39 passed (5 files)” focused run is not reproducible from the named fix tests (32 in four files; 36 with `html-preview-link-affordance`), though the broader 102/717 claim is exact.
- **Impact:** Evidence/accounting quality, not product behavior. Our independent device probes cover the core cases.
- **Suggested fix:** Capture per-scheme evidence (or a hierarchy dump/video), list all touched files, and name the five focused files.

## Verification commands and results

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/html-preview-scheme.test.ts \
  src/components/mobile-html-preview-frame.test.tsx \
  src/files/MobileFileFilterChips.test.tsx
→ Test Files 4 passed (4); Tests 32 passed (32)

pnpm --dir mobile test src/components \
  src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx \
  src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx \
  src/files/MobileFileExplorerPanel.test.ts
→ Test Files 102 passed (102); Tests 717 passed (717)   (matches fix-01.md)

pnpm --dir mobile typecheck
→ exit 0

pnpm --dir mobile exec oxlint <7 changed files>
→ no findings

pnpm run check:code-quality:changed
→ code quality: 0 new finding(s) across 160 changed file(s)
→ gate passed since 7bd3928159f5
```

Independent Android probes (emulator-5554, Android 16/API 36, WebView 133, app pid 16072, Metro 8081, CDP `localhost:9222`):

- Plain tap on the `javascript link` in the `dangerous-schemes.html` preview → toast, no dialog, focus stays Orca. **PASS**.
- Real tap on a fresh `javascript:` anchor (with `void()` to avoid document replacement) → no dataset change; a control `#fragment` tap navigated and a pre-empted `javascript:` tap set the dataset. **Baseline PASS, pre-emption bypass confirmed.**
- Pre-empted `intent:`/`file:`/`tel:` taps → no toast, no external app, focus stays Orca (the app's block callback did not run; the engine refused). **Engine boundary held on this emulator; app-policy path absent.**
- Unsandboxed iframe `javascript:` link tap → executed; iframe `intent:`/`file:` taps → no external app, no toast. **Subframe `javascript:` bypass confirmed.**
- Iframe `postMessage(sentinel)` → no toast; main-frame `postMessage(sentinel)` → toast. **Subframe drop PASS.**
- Live meta refresh (`1 ; URL = "file:///etc/passwd"`, uppercase/attribute order) → removed within 300 ms, no navigation, toast at ~1 s. **PASS.**
- Filter-chip evidence: bounds XML `[0,406][1080,511]` / chip `[32,417][134,501]`, keyboard screenshot; consistent with the fix report. **Evidence reviewed; the UI flow was not re-run because the app was left on the HTML preview.**
- Device evidence review: four dangerous screenshots byte-identical; meta-refresh screenshots distinct; `logs/device-verification.txt` and the CDP probe line are consistent with the independent observations.

Not run: iOS (Xcode 26 blocker unchanged), physical device, a resolvable `intent:` handler, and the full file-browser R-02/R-03 UI path (mechanism verified directly in the live WebView instead).

## Residual risks

1. The DOM fence is same-context and can always be pre-empted by page script; a native external-scheme block is the robust boundary (F-01).
2. Subframe `javascript:` and `formaction`/`form.submit()` paths are not fenced (capability-neutral; the artifact already runs JS).
3. Script-initiated `file:` navigation is blocked by the engine without toast; `http(s)` script navigation can still open externally (accepted in design §8.1).
4. The sentinel/meta path lacks throttling and can be used for host-UI churn (F-07).
5. iOS and the session-file reader were not re-run on device this round; the web sandbox path is unchanged.
6. The fix report's “native callback backstop” statement should not be relied on until a resolvable-intent device test is added.
