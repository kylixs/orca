# Fix-04 independent code review — R-01..R-05 closure and regressions

- Date: 2026-11-10
- Reviewer role: independent, read-only. No product or test code was modified and nothing was committed; the only file written is this report.
- Inputs: `fix-code-review-03.md` (R-01 MAJOR, R-02..R-05 MINOR), `fix-04.md`, design §9.1/§9.2, test-plan C12/C18/C19, the current fence/tests/component/patch, the applied `node_modules` (`RNCWebView.java`, `RNCWebViewClient.java`, `RNCWebViewManagerImpl.kt`, `WebViewTypes.d.ts`), the fixed APK, and `device-evidence/fix-04/**`.
- Method: code, test and patch reading; broad and focused test runs; `typecheck`/`oxlint`/`oxfmt`/changed-quality; an independent happy-dom probe driven by the real exported script (bundled with the repo's esbuild) covering the adopted-frame path; SHA-256 recomputation; APK inspection; independent reading of the Android 36 `WebViewClient` javadoc. The device environment was not re-driven (reviewed only).

## Verdict

**CHANGES_REQUIRED.**

| BLOCKER | MAJOR | MINOR |
|---:|---:|---:|
| 0 | 1 | 3 |

R-02, R-03, R-04 and R-05 are closed for this round (with a stale comment/test name and an evidence-precision nit). R-01 is genuinely fixed for ordinary documents: late `content`/`http-equiv`, re-append, the 50 ms backstop, the single-notification behaviour and the "do not remove allowed metas" rule all hold, and the device evidence is credible. However, the same installer is copied into adopted same-origin frames with `install.toString()`, and two constants it still closes over (`MAX_TIMER_MS`, `NOTIFY_THROTTLE_MS`) do not exist in the child window. Every blocked click in an adopted frame throws a `ReferenceError` after cancelling, and a blocked meta with a non-zero delay throws while scheduling its toast. The throw aborts the rest of the child observer callback, so a 0-delay blocked meta appended in the same task can remain in the DOM until the 50 ms backstop — in a browser the 0-delay navigation task runs first. This is the same class of defect as fix-03's R-01 (the stated synchronous-removal guarantee is false on a supported path) and is not covered by any test or device fixture. The native/engine boundary still refuses the resulting external schemes, so no out-of-preview launch was demonstrated; hence MAJOR, not BLOCKER.

## Per-item conclusions

### R-01 — blocked meta removal: fixed for ordinary documents, not fully closed for adopted frames (F-01)

Verified in the real injected script:

- The observer now watches `attributes` with `attributeFilter: ['http-equiv', 'content']` (`html-preview-interception.ts:313-318`). A meta appended first and given `content` or `http-equiv` later is removed in the observer microtask; device `r01-meta.txt` shows 6.5 ms for the late attribute and the unit tests cover both attribute orders.
- `removeBlockedMeta` no longer skips on `blockedMetas` (`:223-235`): a connected blocked meta is always removed, and the WeakSet only suppresses a second notification. Re-appending the removed node is removed again, as the unit test and the device's 0.1 ms re-removal show.
- The 50 ms debounced full scan remains (`:306-311`) and is a genuine backstop; the per-added-node scan is still scoped.
- No legitimate meta is removed: only `http-equiv=refresh` with a blocked target is touched; `http(s)`/`mailto` at top, `about:blank` (with fragment), same-document refresh and `http(s)`/`data`/inline-`about:` subframe targets stay. The removal itself produces one extra childList record and at most one extra sweep; no notification loop. Attribute observation fires for unrelated `content` attributes, but `isRefreshMeta` rejects them immediately.
- The 0-delay device evidence is credible for what it claims: the probe removes the node, checks both nodes are absent after 120 ms, and `refreshMetaCount` is 0. The 6.5 ms figure is observer-delivery time rather than an independent before-navigation timestamp, but the unit test and the browser's microtask/task ordering carry the "removed before the refresh task" claim; `location` staying `about:blank` is weaker on its own because the engine also refuses top-frame `file:`.

The gap: the installer is stringified and evaluated in adopted child windows, and it still references `MAX_TIMER_MS` (line 53) and `NOTIFY_THROTTLE_MS` (line 54), which are declared outside `install()` (unlike `SUBFRAME_ALLOWED`, which fix-04 correctly moved inside). Independent probe

```text
adopted frame (guard v2):
  typeof MAX_TIMER_MS            -> undefined
  blocked click                  -> defaultPrevented true, error event "NOTIFY_THROTTLE_MS is not defined"
  blocked meta content=1;url=file: -> error event "MAX_TIMER_MS is not defined"
  same batch [1 s blocked meta, 0 s blocked meta]
    main frame                   -> both removed in the observer microtask
    adopted frame                -> first removed; second still connected at 20 ms,
                                    only removed by the 50 ms sweep (~140 ms)
```

In a browser the 0-delay refresh navigation is queued as a task and runs before the 50 ms timer, so the synchronous-removal guarantee that R-01 exists to enforce is not met in an adopted frame in this batch shape. The same throw aborts the remainder of the observer callback, so other added nodes in that batch (including a nested frame that needed adoption) are skipped; adoption has no sweep backstop, so that frame is never adopted by this install. The resulting external schemes are still stopped by the native callback (subframe policy) or the engine (`file:`), which is why this is not a BLOCKER. No unit test or device fixture exercises a meta inside a dynamically written frame.

### R-02 — subframe scheme parity and Android `isTopFrame`: closed, one stale documentation item (F-02)

- The DOM subframe rule now mirrors the native policy: `data:` and inline `about:blank`/`about:srcdoc` are allowed; only `http(s)` are in `SUBFRAME_ALLOWED`; `mailto:`, `tel:`, `blob:`, `file:`, `intent:`, custom schemes and `about:blankfoo` are blocked (`html-preview-interception.ts:100-131`). Top-frame semantics are unchanged. The parity tests include the full URL list, including `mailto:`/`tel:`/`blob:`/app schemes, and the split test asserts top `mailto:` is allowed while the subframe form is blocked.
- The patch forwards `request.isForMainFrame()` for both the blocking and fallback branches (`react-native-webview@13.16.2.patch:116-153`; applied `RNCWebViewClient.java:93-163`). The deprecated `String` overload keeps its old event shape and delegates with no field. `@Nullable` is imported; the overload is API 24+ and the app's minSdk is 24, so the flag is available on every supported device. The flag is delivered under `nativeEvent` by `dispatchDirectShouldStartLoadWithRequest` (`RNCWebView.java:419-425`). Per-instance state only; multiple WebViews are independent. iOS is untouched by this round.
- Device `r02-subframe.txt`: `mailto:`/`tel:`/`blob:` leave the frame URL at `about:srcdoc` with Orca foreground; `data:` renders in the frame; `https:` renders in the frame and Chrome does not open. The no-toast result for blocked taps is consistent with the native main-frame message guard. `javascript:` and `file:` remain covered by the regression matrix and unit tests.
- Residual documentation issue: `html-preview-scheme.ts:21-23` still says "Android only calls this for the top frame, where it is true", and the test name at `html-preview-scheme.test.ts:71` says "treats an unreported frame (Android) as the top frame". After the patch, Android's `WebResourceRequest` path does report subframes. The runtime behaviour is correct; only the comment/test name are stale. See F-02.

### R-03 — pre-adoption ordering residual: accurately documented and pinned

- Design §9.1 (`design.md:427`) now states the same-task `document.write` ordering limit, the `stopImmediatePropagation`/`eval` pre-emption and the sandboxed `allow-scripts` opaque-origin case; test-plan C18 carries the same residual. The fix report does not claim it fixed.
- The unit test (`html-preview-interception.test.ts:208-242`) installs the child listener synchronously before awaiting the parent adoption microtask, asserts the adopted guard is `v2`, and asserts the page listener wins (not cancelled); the comment correctly notes happy-dom does not execute `document.write` scripts and uses an equivalent synchronous `child.eval`. Device `r03-pre-adoption.txt` reproduces it with a trusted tap and `status: FRAME JS EXECUTED`. Accurate, not overclaimed.

### R-04 — preview comment: closed

- `MobileHtmlPreview.tsx:109-115` now says the Android before-content (document-start) pass covers subframes, the post-load pass is main-frame only, and the script adopts same-origin `document.write` frames. That matches the applied code: `addDocumentStartJavaScript` with the `ForMainFrameOnly` wrapper vs `evaluateJavascript` on `onPageFinished` (`RNCWebView.java:311-368`). iOS is not misdescribed by the sentence as written.

### R-05 — evidence traceability: closed for this round

- `scripts/` contains `cdp-common.mjs` plus one script per probe; `r05-raw-commands.txt` records the adb forward/curl/node invocations and the Runtime.evaluate parameters, and the scripts contain the exact evaluated expressions (`cdp-common.mjs:31-58` uses `returnByValue`, `awaitPromise`, `userGesture` and trusted `Input.dispatchMouseEvent` taps).
- `logs/sha256-manifest.txt` lists every fixture, log, script and screenshot; all 23 entries verify with `shasum -a 256 -c`. The manifest itself is the only unhashed file (expected).
- The subframe parity log now includes `mailto:`, `tel:`, `blob:`, `data:` and `https:` (fix-03's gap). `r-data.mjs`'s programmatic-click fallback is disclosed in `r05-raw-commands.txt`.
- One precision caveat (F-04): the log's "observable proof that isForMainFrame=false reached JS" is not instrumented; see below.

## Findings

### F-01 — MAJOR — the adopted-frame installer is not self-contained: blocked-click/meta throws and can defer a 0-delay blocked meta past the synchronous guarantee

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:53-54` (outer `MAX_TIMER_MS`, `NOTIFY_THROTTLE_MS`), `:79` (notify), `:214` (refreshDelay), `:252-267` (`adoptFrame` evaluates `install.toString()`); tests `mobile/src/components/html-preview-interception.test.ts:170-206` (dynamic frame test only covers clicks) and `:493-549` (meta tests use a single main-frame install); fixtures under `device-evidence/fix-04/fixtures/` contain no meta inside a dynamic frame.
- **Problem:** `install()` is copied into an adopted child via `child.eval('(' + install.toString() + ')(...))'`. `SUBFRAME_ALLOWED` was moved inside `install()` for exactly this reason, but the two constants above were not. In the child they resolve to nothing:
  - every blocked click reaches `cancel()` (which succeeds: `preventDefault` + `stopImmediatePropagation` are called first) and then `notify()` throws `ReferenceError: NOTIFY_THROTTLE_MS is not defined`; no sentinel is posted;
  - a blocked refresh meta with a non-zero delay is removed, but `refreshDelay()` throws `ReferenceError: MAX_TIMER_MS is not defined` while evaluating `setTimeout(notify, ...)`;
  - the throw propagates out of the MutationObserver callback, aborting the remaining `addedNodes`/records in that batch. A blocked 0-delay meta appended in the same task after a positive-delay blocked meta is therefore not removed synchronously; it stays until the 50 ms sweep, and a browser runs the 0-delay refresh task before that timer. A nested dynamically written frame in the same batch is likewise skipped and is never adopted (there is no adoption backstop).
- **Failure scenario:** artifact HTML creates an iframe and lets the parent adopt the fence (`guard v2`), then writes two metas in one task: `<meta http-equiv=refresh content="1;url=file:///etc/passwd">` followed by `<meta http-equiv=refresh content="0;url=file:///etc/passwd">` (or a `mailto:`/`tel:` target in the frame). The first removal throws, the second survives the observer microtask, and its refresh task runs before the 50 ms backstop; a nested frame added in the same batch is also skipped by that callback. The native subframe callback and the engine still refuse the resulting external schemes, so no external launch was demonstrated — the application-level removal guarantee and its tests are what fail.
- **Suggestion:** make the copied installer self-contained: move `MAX_TIMER_MS` and `NOTIFY_THROTTLE_MS` inside `install()` (or pass them as parameters alongside `blockedMessage`/`allowedSchemes`), and consider not letting one bad node abort the rest of the observer loop. Add two regressions using the adopted-frame fixture: (a) a blocked click in a dynamically written frame asserts `defaultPrevented` and no `error` event; (b) a positive-delay blocked meta plus a 0-delay blocked meta inserted in one task are both gone in the observer microtask, before the 50 ms backstop. A device fixture with a meta inside a `document.write` frame would close the evidence gap.

### F-02 — MINOR — the Android subframe comment/test name still describe the pre-patch callback

- **Files/lines:** `mobile/src/components/html-preview-scheme.ts:21-23`; `mobile/src/components/html-preview-scheme.test.ts:71`.
- **Problem:** "Android only calls this for the top frame, where it is true" and "treats an unreported frame (Android) as the top frame" are no longer true for the `WebResourceRequest` path the patch just instrumented. The code behaviour (missing value → top-frame policy) is correct and still needed for the legacy/unspecified case, but the comments now contradict `MobileHtmlPreview.tsx:67-69` and the patch.
- **Suggestion:** say that iOS and (with the patch) Android report subframes, and that a missing `isTopFrame` keeps the top-frame semantics for the legacy overload/unknown callers.

### F-03 — MINOR — `check:code-quality:changed` fails; the fix-04 verification claim is not reproducible

- **Files/lines:** `remote-connectivity/design/test-reports/device-evidence/fix-04/scripts/r02-subframe.mjs:7,15,40`; claim at `remote-connectivity/design/test-reports/fix-04.md:194-196`.
- **Problem:** the gate reports 3 new findings across 167 changed files (all `eslint(curly)`: missing braces after `if`/`for-of`) and exits 1, while fix-04 reports "0 new findings across 160 changed files; gate passed". The product TS files are clean; the failure is in a newly added evidence script, so it does not affect runtime behaviour, but the report's verification section is inaccurate for the submitted tree.
- **Suggestion:** add the braces (or exclude evidence scripts from the gate deliberately), re-run the gate, and correct the report to the actual command output.

### F-04 — MINOR — the `isTopFrame` device inference is stronger than the probe records

- **Files/lines:** `remote-connectivity/design/test-reports/device-evidence/fix-04/logs/r02-subframe.txt` (Interpretation, "observable proof"); `scripts/r02-subframe.mjs` (no callback invocation log).
- **Problem:** the `frame-https` result (frame navigates, Chrome does not open) is also exactly what happens if Android does not invoke `shouldOverrideUrlLoading` for that subframe navigation at all; the probe does not record whether the callback fired. The javadoc says the callback "may be called" for subframes. The patch code, the dex bytecode (`classes2.dex` contains both `isTopFrame` and `isForMainFrame`) and the unit test do establish the code path, so the conclusion still holds — the log's "observable proof" wording is the only gap.
- **Suggestion:** log a host-side counter (or a temporary debug prop) when `onShouldStartLoadWithRequest` fires with `isTopFrame=false`, or reword the evidence as corroboration rather than proof.

## Verification results

```text
pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 759 passed (759)        (matches fix-04.md)

pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx src/components/html-preview-scheme.test.ts
→ Test Files 3 passed (3); Tests 50 passed (50)               (matches fix-04.md)

html-preview-interception.test.ts re-run 5× → 31/31 each time (no observed flake)

pnpm --dir mobile typecheck → tsc --noEmit, exit 0
oxlint <html-preview-interception.ts, .test.ts, MobileHtmlPreview.tsx> → exit 0
oxfmt --check <same 3 files> → all matched files formatted
pnpm run check:code-quality:changed → FAILED: 3 findings across 167 changed files (r02-subframe.mjs:7,15,40)
```

Patch/install/evidence checks:

```text
sha256(mobile/patches/react-native-webview@13.16.2.patch)
  = 2f33bd3807c63a63089737fbb1c3f5b0b272cd7630846f8233ae294c9940c8f2
  = mobile/pnpm-lock.yaml patchedDependencies (line 175)
applied node_modules: WebResourceRequest path passes request.isForMainFrame()
  into both callback branches; String overload keeps the old event shape;
  ScriptHandler document-start and destroy() cleanup are present.
sha256(mobile/android/app/build/outputs/apk/debug/app-debug.apk)
  = b03b521d2ce23152b4819dcf9afc22bc0e39e4d42b15fe478f592405bb1d772e
  (matches fix-04.md)
independent `unzip` + `strings classes*.dex`: classes2.dex contains both
  "isTopFrame" and "isForMainFrame", consistent with logs/apk-isTopFrame.txt.
sha256 manifest: all 23 entries verify.
Android 36 SDK WebViewClient javadoc: both overloads say the callback may be
  called for subframes (fixed content is otherwise as described).
happy-dom probe of the real script: main-frame batch removes both blocked
  metas synchronously; adopted-frame batch leaves the 0-delay meta until the
  50 ms sweep and produces NOTIFY_THROTTLE_MS/MAX_TIMER_MS ReferenceErrors.
```

Device evidence reviewed (not re-driven): `r01-meta.txt` and its screenshot show the toast and both removals; `r02-subframe.txt` shows the five subframe links with the claimed URLs/activities; `r03-pre-adoption.txt` shows `FRAME JS EXECUTED` after adoption; `regression-matrix.txt` covers javascript/file/intent/tel/custom/formaction/fragment/https/iframe/meta plus Preview/Source and filter chips; `filter-chips-bounds.xml` contains row `[0,406][1080,511]` and chip `[32,417][134,501]`; the screenshots are 1080×2400 and match their described states. All hashes verify.

## Residual risks

1. Adopted-frame installer closure bug (F-01): synchronous meta removal and notification are not reliable after `adoptFrame`; external schemes still rely on the native/engine boundary.
2. R-03 pre-adoption ordering and unfenced cross-origin/CSP/sandbox frames remain documented residuals (capability-equivalent to page script).
3. Same-context page script can still replace `Event.prototype.preventDefault`, call `form.submit()` or set `location.href`; external schemes rely on the native callback where no tap is delivered.
4. Android `String` overload has no frame flag (unreachable at minSdk 24, but still the fallback contract); missing `isTopFrame` keeps top-frame semantics.
5. iOS was not re-run (Xcode 26 blocker); the shared JS fence and iOS props are unchanged, but the iOS subframe callback path was not exercised.
6. Lockfile re-resolution noise from the earlier rounds remains (not re-reviewed here).
