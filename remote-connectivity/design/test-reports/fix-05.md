# Fix report 05 — F-01..F-04 from fix-04 code review

- Date: 2026-11-10
- Branch/state: `feat/remote-terminal-load-diagnostics`; nothing committed. Unrelated dirty
  session/terminal/runtime files were not touched.
- Input: `fix-code-review-04.md` (F-01 MAJOR, F-02..F-04 MINOR), `fix-04.md`, design §9.1/§9.2,
  test-plan C12/C18/C19.
- Environment: AVD `Pixel_8a` (Android 16 / API 36, arm64, `emulator-5554`), WebView
  `133.0.6943.137`, Orca Mobile 0.0.52 debug, host runtime on 6770, Metro on 8081.
  JS-only round: no APK rebuild; installed APK remains
  `sha256 b03b521d2ce23152b4819dcf9afc22bc0e39e4d42b15fe478f592405bb1d772e`.
- Evidence: `device-evidence/fix-05/` (fixtures, scripts, logs, screenshots, SHA-256 manifest).

## Verdict

| Finding | Severity | Status |
|---|---|---|
| F-01 adopted-frame installer not self-contained | MAJOR | **Fixed** — all installer state lives inside `install`; cross-realm test; device click/meta pass with zero exceptions |
| F-02 stale Android subframe comment/test name | MINOR | **Fixed** |
| F-03 `check:code-quality:changed` fails on evidence script | MINOR | **Fixed** — gate passes with 0 findings; fix-04 claim corrected below |
| F-04 "observable proof" overstates r02 probe | MINOR | **Fixed in the log wording** — now "supporting evidence" with the instrumentation caveat |

## F-01 — MAJOR — adopted-frame installer closure

### Root cause

`adoptFrame` copies the fence with `child.eval('(' + install.toString() + ')(...))'`. Function source
does not capture the parent closure, so the two constants declared in the outer IIFE were
`undefined` in the child:

- a blocked click cancelled the event and then `notify()` threw
  `ReferenceError: NOTIFY_THROTTLE_MS is not defined`;
- a blocked meta with a non-zero delay was removed and then `refreshDelay()` threw
  `ReferenceError: MAX_TIMER_MS is not defined`;
- the throw aborted the rest of that `MutationObserver` callback, so a 0-delay blocked meta appended
  in the same task stayed in the DOM until the 50 ms backstop (a browser runs the refresh task
  first), and a nested frame in that batch was not adopted.

`SUBFRAME_ALLOWED` had been moved inside `install` in fix-04 for this exact reason; the two
constants were missed.

### Change

`mobile/src/components/html-preview-interception.ts`:

- `MAX_TIMER_MS` and `NOTIFY_THROTTLE_MS` moved inside `install`, next to `SUBFRAME_ALLOWED`, with a
  comment stating the invariant: everything `install` reads must be inside it because adoption
  copies the function through `Function.prototype.toString`.
- No outer closure remains. The adoption call already passes `blockedMessage` and `allowedSchemes`;
  it is now the only installer input, and both are the same values used by the main frame.
- The `install` body still self-references `install` for adoption; that is a local function-name
  binding that exists in the fresh child window, not a parent closure.

### Cross-realm regression test

`mobile/src/components/html-preview-interception.test.ts` adds
"runs the stringified installer in an adopted about:blank frame without closure state". It uses the
real production path: a fresh happy-dom parent, a dynamically created `about:blank` iframe, the
parent's `MutationObserver` adoption (which evaluates `install.toString()` in the child), then:

1. blocked click in the child — `defaultPrevented`, the child bridge receives exactly the sentinel;
2. after the 400 ms throttle, a `1;url=file:///etc/passwd` meta and a
   `0;url=file:///etc/passwd` meta appended in one task — both `isConnected === false` after one
   observer microtask, sentinel count increases by one, no window `error` event recorded.

Pre-fix verification: with the constants temporarily restored to the outer scope, the new test
failed on the missing click sentinel (`expected [] to deeply equal [ [ "...blocked-scheme" ] ]`).
With the fix it passes. The thrown `ReferenceError` is detected through its consequences (missing
sentinel, 0-delay meta still connected); the independent reviewer also observed happy-dom surface
the observer throw, so the `errors` array is environment-dependent and is not the only assertion.
(Review outcome: APPROVED, 0 BLOCKER / 0 MAJOR / 2 MINOR.)

## Device evidence (fix-05)

Fixture `fixtures/dynamic-frame-fence.html`: same-origin parent creates an `about:blank` iframe,
`document.write`s a `javascript:` link and a status line, then adopts it. It records `mousedown`
(proves the trusted tap hit the link, because the fence only intercepts click), window `error`
events on both windows, and exposes `__probe.state()` / `__probe.addBlockedMetas()`.

`logs/r05-dynamic-frame.txt` (guard v2, trusted CDP tap):

```text
tap {x:114.01, y:173.58} -> mousedown target "frame-js"
afterClick: frameJsRan false, frameHref "about:blank", frameStatus "status: idle"
metaMicrotask: delayedConnected false, immediateConnected false, elapsed 1.5 ms
afterMeta / settled: metaCount 0, frameHref "about:blank"
runtimeExceptions []      consoleErrors []
```

The first device run still loaded the app's pre-fix Metro bundle and reproduced the review exactly:
`ReferenceError: NOTIFY_THROTTLE_MS is not defined` at `notify` (from the click) and repeated
`ReferenceError: MAX_TIMER_MS is not defined` at `refreshDelay`, with the 0-delay meta still
connected after the microtask. After a dev-menu Reload, the served bundle has all three constants
inside `install` (`logs/metro-bundle-check.txt`) and the rerun above is clean. No external app was
opened; the top activity stayed Orca.

Screenshot: `screenshots/android-fix05-dynamic-frame.png`.

## F-02 — stale Android subframe comments

- `mobile/src/components/html-preview-scheme.ts`: the `isTopFrame` doc now says iOS and the patched
  Android `WebResourceRequest` overload report subframes, and a missing value keeps top-frame
  semantics for the legacy Android overload and unknown callers.
- `mobile/src/components/html-preview-scheme.test.ts`: "treats an unreported frame (Android) as the
  top frame" → "keeps top-frame semantics when the frame flag is unreported".
- The stale parenthetical in `html-preview-interception.test.ts` ("Android treats an unreported
  frame as top") was reworded the same way.

## F-03 — changed-quality gate

At review time the gate failed with three `eslint(curly)` findings in
`device-evidence/fix-04/scripts/r02-subframe.mjs` (lines 7, 15, 40), so fix-04's "0 new findings"
claim was wrong for the submitted tree. Correction: the four curly sites (including the later one
that shifted to line 46) now have braces, and the script's entry in the fix-04 SHA-256 manifest was
recomputed (`logs/fix-04-corrections.txt`).

Current result:

```text
pnpm run check:code-quality:changed
code quality: 0 new finding(s) across 172 changed file(s).
casting code quality: 0 new finding(s) across 172 changed file(s).
focused plugins: 0 new finding(s) across 172 changed file(s).
type-aware code quality: 0 new finding(s) across 172 changed file(s).
React Doctor: 0 new finding(s) across 172 changed file(s).
design system: 0 new finding(s) across 172 changed file(s).
casting SAFETY: rationale: 0 new finding(s) across 172 changed file(s).
Changed-code quality gate passed since 7bd3928159f5.
```

Fix-05's own scripts pass the same gate. `shasum -a 256 -c` over the updated fix-04 manifest still
verifies every entry.

## F-04 — evidence wording

`device-evidence/fix-04/logs/r02-subframe.txt` now calls the frame-https result "supporting
evidence" instead of "observable proof", and states that the probe does not record whether the
callback fired, so the patched code path and APK inspection are what establish it. The subframe
answer itself did not change. The manifest entry was updated. The fix-05 report repeats that
limitation (the probes here do not instrument the native callback either).

## Regression

Main frame (`fixtures/preempting-schemes.html`, `logs/regression-main.txt`): document-start guard
`v2` seen by the page's own first inline script; `javascript:`, `file:`, `intent:`, `tel:`, custom
scheme and `formaction` all cancelled with the page's capture listeners never running and status
idle; `#section` fragment navigated in place; top-frame `data:` was refused by the engine (URL stayed
`about:blank#section`); `https:` opened Chrome (accepted external boundary); no runtime exceptions
or console errors.

Iframe (`fixtures/iframe-javascript.html`, `logs/r-iframe.txt`): guard `v2`, trusted tap on the
srcdoc frame's `javascript:` link, status idle, top title unchanged.

Meta (`fixtures/meta-late-content.html`, `logs/r01-meta.txt`): late `content` removed at 3.3 ms,
re-appended node removed again at 0 ms, no refresh meta after 120 ms, location `about:blank`.

Filter chips (`logs/filter-chips-bounds.xml`, `screenshots/android-fix05-filter-code.png`,
`android-fix05-filter-all.png`): row `[32,417][134,501]` (84 px = 32 dp tall), All selected → Code
selected (`selected=true` in the dump captured with the Code screenshot) → All selected.

Session file page Preview/Source (`screenshots/android-fix05-preview-mode.png`,
`android-fix05-source-mode.png`, `android-fix05-preview-restored.png`): Preview renders the iframe
fixture, Source shows highlighted HTML, Preview restores it.

## Verification (executed)

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/html-preview-scheme.test.ts src/components/mobile-html-preview-frame.test.tsx
→ Test Files 3 passed (3); Tests 51 passed (51)

pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 760 passed (760)

pnpm --dir mobile typecheck → tsc --noEmit, exit 0
pnpm --dir mobile exec oxlint <4 changed TS/TSX files> → exit 0, no findings
pnpm --dir mobile exec oxfmt --check <same 4 files> → all matched files formatted
pnpm run check:code-quality:changed → 0 findings across 172 files; gate passed (output above)
```

Device probes (trusted CDP taps, runtime exception collection):

```text
node scripts/r05-dynamic-frame.mjs  → click cancelled, both metas removed in 1.5 ms, no exceptions
node scripts/regression-main.mjs    → all blocked schemes idle, fragment ok, data engine-refused,
                                      https opened Chrome; no exceptions
node scripts/r01-meta.mjs           → late/re-appended metas removed, no navigation
node scripts/r-iframe.mjs           → srcdoc javascript: cancelled, status idle
```

## Files changed

- `mobile/src/components/html-preview-interception.ts` — constants moved inside `install`.
- `mobile/src/components/html-preview-interception.test.ts` — cross-realm adopted-frame regression;
  reworded stale Android comment.
- `mobile/src/components/html-preview-scheme.ts` / `.test.ts` — corrected subframe reporting comment
  and test name.
- `device-evidence/fix-04/scripts/r02-subframe.mjs` — braces (F-03) and manifest hash.
- `device-evidence/fix-04/logs/r02-subframe.txt` — "supporting evidence" wording (F-04) and hash.
- `device-evidence/fix-04/logs/sha256-manifest.txt` — two recomputed entries.
- `device-evidence/fix-05/**` — fixture, probes, logs, screenshots, manifest, corrections note.
- `remote-connectivity/design/test-reports/fix-05.md` — this report.

## Residual risks / not fixed

1. Cross-origin frames, CSP that forbids `eval`, and tampering with `eval`/
   `Function.prototype.toString` before adoption remain outside the fence (engine boundary), as
   documented in design §9.1.
2. Same-task pre-adoption inline script can still register a pre-empting listener (R-03 residual),
   unchanged and pinned by the existing test.
3. The native `String` overload still has no frame flag; a missing `isTopFrame` keeps top-frame
   semantics (unchanged).
4. iOS was not re-run (Xcode environment blocker); the shared JS change is platform-neutral.
5. No APK rebuild was needed: the fix is JavaScript only, and the installed fix-04 APK plus the
   reloaded Metro bundle carry it.
