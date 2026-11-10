# Fix-05 independent code review — F-01..F-04 closure and regressions

- Date: 2026-11-10
- Reviewer role: independent, read-only. No product or test code was modified and nothing was committed; the only file written is this report.
- Inputs: `fix-code-review-04.md` (F-01 MAJOR, F-02..F-04 MINOR), `fix-05.md`, design §9.1/§9.2, test-plan C12/C18/C19, the current `html-preview-interception.ts` / `.test.ts`, `html-preview-scheme.ts` / `.test.ts`, `MobileHtmlPreview.tsx`, `device-evidence/fix-05/**`, the corrected `device-evidence/fix-04/scripts/r02-subframe.mjs` and its manifest/log.
- Method: independent AST free-variable scan of `install`; cross-realm execution of the real exported script in happy-dom (fresh parent, adopted child, nested child) and a mutation check of the regression test in a `/tmp` copy; repeated test runs; targeted and full test sets; `typecheck` (mobile and root); `oxlint`/`oxfmt`; `check:code-quality:changed`; SHA-256 recomputation; fixture/log/screenshot review. The emulator, Metro and CDP endpoint were reachable, but no preview target was open (only `about:blank`), so device probes were reviewed, not re-driven.

## Verdict

**APPROVED.**

| BLOCKER | MAJOR | MINOR |
|---:|---:|---:|
| 0 | 0 | 2 |

The fix-04 F-01 MAJOR is genuinely closed. `install` now reads no parent-closure state; the stringified copy runs in a fresh child realm, including nested adopted frames, with no `ReferenceError`; blocked click, sentinel, and the 1 s + 0 s blocked-meta batch all behave as claimed. The new cross-realm test does catch the regression (confirmed by an independent mutation run) and is stable. F-02/F-03/F-04 are closed except for one leftover stale product comment and two inaccuracies in the fix report's narrative. Neither affects runtime behavior or test strength.

## Per-item conclusions

### F-01 — MAJOR — adopted-frame installer closure: closed (independent verification)

- **Static self-containment.** An AST scope scan of the actual `install` function (the value `Function.prototype.toString()` copies) finds no unresolved identifier that could be a parent-closure binding. Everything it reads is a parameter (`blockedMessage`, `allowedSchemes`), a local (`SUBFRAME_ALLOWED`, `MAX_TIMER_MS`, `NOTIFY_THROTTLE_MS`, local helpers), its own function-name binding (`install`), or a standard browser global (`window`, `document`, `WeakSet`, `URL`, `MutationObserver`, ...). `MAX_TIMER_MS` and `NOTIFY_THROTTLE_MS` are inside the function at `html-preview-interception.ts:60-61`; `SUBFRAME_ALLOWED` at `:59`.
- **Cross-realm execution.** Independent happy-dom probe driven by the real exported `HTML_PREVIEW_INTERCEPTION_SCRIPT`:
  - adopted `about:blank` child: guard `v2`, blocked click `defaultPrevented=true`, child bridge receives exactly `orca:html-preview:blocked-scheme`, page script did not run, no error events;
  - 1 s blocked meta + 0 s blocked meta appended in one task: both `isConnected=false` after one observer microtask, sentinel count increased; no `ReferenceError`;
  - nested (depth-2) dynamically written frame: the child copy adopts it (`guard v2`), its blocked click is cancelled, and its blocked meta is removed. This exercises the self-reference `install.toString()` inside the copied function.
- **Mutated-regression check.** In a `/tmp` copy (repo untouched), restoring the pre-fix shape (constants in the outer IIFE) makes the new test fail exactly as the report says: `AssertionError: expected [] to deeply equal [[ "orca:html-preview:blocked-scheme" ]]` at `html-preview-interception.test.ts:242`. A second mutation moving only `MAX_TIMER_MS` outside (click path works) fails the meta assertions (`META_CONNECTED=[false,true]`) and records `MAX_TIMER_MS is not defined`. The test is load-bearing, and stronger than the report's caveat below.
- **Device evidence.** `logs/r05-dynamic-frame.txt` shows guard `v2`, a trusted tap that reached `frame-js` (mousedown), `frameJsRan=false`, both metas disconnected after 1.5 ms, no `runtimeExceptions`/`consoleErrors`. `logs/metro-bundle-check.txt` shows all three constants inside `function install` in the served bundle. The first-run pre-fix reproduction described in `fix-05.md` is consistent with the observed stale bundle; the clean rerun is the evidence used for closure.

### F-02 — MINOR — stale Android `isTopFrame` comment/test name: closed, one leftover comment (F-05-01)

- `html-preview-scheme.ts:22-25` now states that iOS and the patched Android `WebResourceRequest` overload report subframes, and that a missing value keeps top-frame semantics for the legacy overload/unknown callers. `html-preview-scheme.test.ts:71` is renamed accordingly; the interception-test parenthetical at `:666` is reworded too.
- One stale product comment remains at `html-preview-interception.ts:114-115` ("which would treat it as the top frame on Android"). It no longer describes the patched callback. See F-05-01; documentation only.

### F-03 — MINOR — changed-quality gate: closed

- `pnpm run check:code-quality:changed` passes: `0 new finding(s) across 172 changed file(s)` for all seven gates, `Changed-code quality gate passed since 7bd3928159f5`.
- Coverage of the evidence scripts is confirmed: the gate enumerates untracked files (`git ls-files --others`) and accepts `.mjs`; `172 = prior 167 + 5 new fix-05 scripts`. The corrected `fix-04/scripts/r02-subframe.mjs` and the five `fix-05/scripts/*.mjs` pass explicit `oxlint` and `oxfmt --check`.
- `fix-04/logs/sha256-manifest.txt` (23 entries) and `fix-05/logs/sha256-manifest.txt` (23 entries) both verify with `shasum -a 256 -c`.

### F-04 — MINOR — evidence wording: closed

- `fix-04/logs/r02-subframe.txt` now says "supporting evidence", states that the probe does not record whether the callback fired, and credits the patched code + APK inspection. `fix-05.md` repeats the limitation for its own probes. No overclaim found.

### Regressions — none introduced

- Product change for this round is the two constants moving inside `install` (plus comments/tests); main-frame behavior is unchanged.
- Tests: 103 files / 760 tests pass (matches the report; the +1 over fix-04 is the new cross-realm test); targeted 3 files / 51 tests pass.
- Device logs cover main-frame `javascript:`/`file:`/`intent:`/`tel:`/custom/`formaction` (all idle, page capture listeners never ran), `#section` fragment, `data:` engine refusal, `https:` external boundary, iframe `javascript:`, late-content/re-appended meta, filter chips, and Preview/Source. Screenshots are 1080×2400 and consistent; the filter-chip bounds show the 32 dp row; Source shows highlighted HTML and Preview restores.
- No new security or correctness issue was found from this round's change.

## Findings

### F-05-01 — MINOR — one stale "native treats Android subframes as top frame" comment remains

- **File/line:** `mobile/src/components/html-preview-interception.ts:114-115`.
- **Problem:** the subframe branch says the scheme is blocked at the DOM "rather than being handed to the native callback (which would treat it as the top frame on Android)". After the patch, the `WebResourceRequest` overload forwards `request.isForMainFrame()` and the native policy takes the subframe branch; this is exactly the statement the round corrected in `html-preview-scheme.ts` and the test names. The DOM block is still correct (Android does not deliver tapped dangerous schemes to the callback at all, and the legacy overload has no flag), so only the parenthetical rationale is stale.
- **Failure scenario:** none at runtime; it misleads the next reader about which layer is responsible for Android subframe policy.
- **Suggestion:** reword to the still-valid reason (Android may not invoke the callback for a tapped dangerous scheme; the legacy `String` overload cannot report the frame), without claiming the patched callback ignores `isForMainFrame`.

### F-05-02 — MINOR — the fix report misdescribes its own regression evidence

- **File/lines:** `remote-connectivity/design/test-reports/fix-05.md:68-70` and `:92`.
- **Problem:** the report says the pre-fix failure is detected by "positive-delay meta still connected", but the 1 s meta is the one removed first; the node that survives the aborted observer callback is the **0 s** meta (the report's own line 92 says this, and the fix-04 review documents it). It also says happy-dom did not surface the observer throw as a `window.error` event; an independent run of the same happy-dom version with only `MAX_TIMER_MS` moved outside the function records `OBSERVER_ERRORS_AFTER_MICROTASK=["MAX_TIMER_MS is not defined"]`, so that caveat is inaccurate (in that mutation an earlier assertion fails first, but the `errors` assertion would also fail). The test itself is correct and stronger than advertised.
- **Failure scenario:** none at runtime; a future reviewer could underrate the test or repeat the wrong survivor description.
- **Suggestion:** correct the narrative to "0-delay meta stays connected" and state that the child-window `error` listener observes the observer `ReferenceError` (as well as the click one).

## Verification results

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/html-preview-scheme.test.ts src/components/mobile-html-preview-frame.test.tsx
→ Test Files 3 passed (3); Tests 51 passed (51)                    (matches fix-05.md)

pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 760 passed (760)              (matches fix-05.md)

html-preview-interception.test.ts 8× full file  → 32/32 each time
new cross-realm test 20×                        → 1 passed (31 skipped) each time; no flake

mobile typecheck (tsc --noEmit)                 → exit 0
root `pnpm tc` (build:packages + parallel)      → exit 0

oxlint <4 changed product TS files>             → exit 0
oxfmt --check <same 4 files>                    → all formatted
oxlint <5 fix-05 scripts + fix-04 r02-subframe.mjs> → exit 0
oxfmt --check <same 6 scripts>                  → all formatted

pnpm run check:code-quality:changed → 0 findings / 172 changed files; gate passed
```

Independent checks:

```text
AST free-variable scan of install:
  unresolved = browser globals + local function declarations + own name `install`
  no parent-closure identifier (parameters are the only call inputs)

happy-dom cross-realm probe (real exported script):
  child guard "v2"; blocked click cancelled + exact sentinel; no error
  [1 s blocked meta, 0 s blocked meta] → both disconnected after one microtask
  nested depth-2 frame adopted by the child copy → guard v2, click cancelled, meta removed
  errors: []

/tmp mutation (repo untouched):
  constants outside install → test fails at line 242 (missing sentinel)
  only MAX_TIMER_MS outside → line 260 fails, 0 s meta connected, error event observed

SHA-256:
  fix-05 manifest: 23/23 OK
  fix-04 manifest: 23/23 OK (including corrected r02-subframe.mjs)
```

Device evidence reviewed (not re-driven): emulator-5554, Metro and CDP were up, but `/json` exposed only an `about:blank` target, so the fixture was not open. Logs, fixtures, scripts, screenshots and hashes are mutually consistent; `r05-dynamic-frame.txt` shows the required click/meta/no-exception result, `regression-main.txt` covers the main-frame schemes, `r-iframe.txt` the srcdoc iframe, `r01-meta.txt` the late/re-appended metas, and the filter/Preview/Source screenshots match their dumps.

## Residual risks (accepted, unchanged)

1. Same-context page script can tamper with the context (`Event.prototype.preventDefault`, `eval`, `Function.prototype.toString`), call `form.submit()`, or set `location.href`; external schemes still rely on the native/engine boundary where no tap is delivered.
2. Android WebView < 89 / document-start unavailable uses the `onPageStarted` fallback (main frame only, page script can pre-empt). Accepted.
3. Cross-origin frames, CSP that forbids `eval`, and sandboxed `allow-scripts` opaque-origin frames are not adopted; same-task inline script written before adoption can register a pre-empting listener. Documented in design §9.1 and pinned by a test.
4. The legacy Android `String` overload has no frame flag; a missing `isTopFrame` keeps top-frame semantics.
5. iOS was not exercised (environment blocker); the JS change is platform-neutral.
6. Lockfile re-resolution noise from earlier rounds remains out of scope.
7. F-05-01 is a documentation-only leftover; the runtime behavior and tests are correct.
