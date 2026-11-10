# Fix report 03 — minor review findings M-01..M-07

- Date: 2026-11-10
- Branch: `feat/remote-terminal-load-diagnostics` (no commit made)
- Input: `fix-code-review-02.md` (APPROVED_WITH_MINORS, M-01..M-07), `fix-02.md`, design §9,
  test-plan C8/C11b/C12/C18/C19.
- Environment: AVD `Pixel_8a` (Android 16 / API 36, arm64, `emulator-5554`), WebView
  `133.0.6943.137`, Orca Mobile 0.0.52 debug dev-client paired to the isolated host on 6770,
  Metro on 8081. Native changes required a rebuilt APK; JS changes were hot-loaded.
- Evidence: `device-evidence/fix-03/` (fixtures, logs, screenshots).
- Scope: only the seven listed minors. Unrelated dirty session/terminal/runtime files were not
  touched.

## Verdict

| Finding | Severity | Status |
|---|---|---|
| M-01 guard exact-value pre-seed disables fallback fence | MINOR | **Fixed** — the guard is never trusted; listeners always install. WebView floor/fallback limits documented |
| M-02 dynamically written `about:blank` frames unfenced | MINOR | **Fixed for same-origin frames** via parent adoption; cross-origin/CSP/tamper cases documented as residual; C18/design wording corrected |
| M-03 0-delay meta refresh loses the 50 ms debounce race | MINOR | **Fixed** — new blocked metas are removed synchronously in the MutationObserver callback; 0.1 ms measured on device |
| M-04 `ScriptHandler` not removed on destroy | MINOR | **Fixed** — patch removes it in `destroy()` before `super.destroy()`; rebuilt APK bytecode verified |
| M-05 lockfile churn | MINOR | **Not splittable safely; classified and documented** (below). Patch hash and required pre-existing package entries retained |
| M-06 subframe `about:srcdoc` parity drift | MINOR | **Fixed** — DOM subframe policy matches native `isInlineSubframeDocument`; unit + device parity |
| M-07 false relative-asset warning from `srcdoc` | MINOR | **Fixed** — `srcdoc` attribute contents skipped; device warning gone |

## M-01 — guard exact-value pre-seed

**Problem.** The old script returned early when the page-controlled guard was exactly
`{value:'v2', writable:false, configurable:false}`. On the `onPageStarted` fallback (WebView < 89, or
document-start unavailable) the page runs first, so this disabled the fence.

**Change.** `mobile/src/components/html-preview-interception.ts`: removed the early return and the
descriptor read entirely. The non-writable/non-configurable guard is now only a diagnostics/test
marker and is never a skip condition. Duplicate installs are safe: the first window-capture listener
cancels and calls `stopImmediatePropagation`, so later registrations on the same target/phase do not
run. Comments now state the guarantee boundary: document-start requires Android System WebView 89+
(`DOCUMENT_START_SCRIPT`); the `onPageStarted` fallback is main-frame only and page-first-preemptible.

**Tests.** Added "installs even when the page pre-defines the exact non-configurable guard"
(`html-preview-interception.test.ts`), which dispatches a real click and asserts
`defaultPrevented` and the sentinel. The existing poisoned-flag and idempotency cases still pass.

**Device.** `logs/m01-exact-preseed.txt`: a fresh same-origin window pre-defines the exact
descriptor, then runs the current script; a `javascript:` click yields `defaultPrevented: true` and
the sentinel. `logs/exact-guard-page.txt` + `screenshots/android-fix03-exact-guard.png`: the fixture's
first inline script saw `v2` (document-start won), its exact-value redefine was a no-op, and a
trusted tap was blocked with the toast.

## M-02 — dynamic `about:blank` + `document.write` frames

**Problem.** A frame created as `about:blank` and filled with `document.write` never navigates, so no
document-start script runs in it.

**Change.** The installer is now a named `install(blockedMessage, allowedSchemes)`. Each installed
parent observes child-list mutations and, for every added `iframe` (and existing frames at install
time), evaluates the same installer in a same-origin child window (WeakSet-deduplicated). Window
listeners are registered before the page can be tapped, including content written synchronously
before the observer microtask. Subframe messages remain dropped by the native patch, so no host toast
is expected.

**Tests.** Added "fences a dynamically written about:blank frame that never navigates": the parent
creates the frame, writes a `javascript:` link synchronously, waits one microtask, asserts the child
guard and a cancelled click, then rewrites the document with `document.open()`/`write()` and asserts
a second click is still cancelled.

**Device.** `logs/dynamic-about-blank.txt` + `screenshots/android-fix03-dynamic-about-blank.png`:
child guard `v2`, `childIsSubframe: true`; trusted taps on the frame's `javascript:` link left the
parent status idle, and `file:`/`intent:` taps kept focus in Orca. A follow-up probe rewrote the
adopted frame with `document.open()`/`document.write()` and a `javascript:` click was still
cancelled (window listeners survive the rewrite; guard `v2` afterwards). External schemes in this
frame are still the engine's boundary.

**Residual (must not be over-claimed).** Cross-origin frames cannot be adopted. A CSP that forbids
`eval`, or a parent that tampers with the child's `eval`/`Function.prototype.toString` before
adoption, prevents the injection; that is capability-equivalent to the parent's own script, and the
engine still refuses external schemes. Design §9.1 and C18 now state this explicitly and no longer
claim document-start covers every iframe.

## M-03 — 0-delay meta refresh

**Problem.** A late blocked `<meta http-equiv=refresh content="0;url=...">` was only removed by the
50 ms debounced sweep. The browser's refresh task could be scheduled first.

**Change.** The MutationObserver callback now removes a newly added blocked refresh meta (or a meta
inside an added subtree) synchronously, using a per-install WeakSet to avoid double notification;
the debounced full-document sweep remains a backstop only. Code comments and design §9.2 now say the
synchronous microtask precedes the navigation task, with the engine/native policy as the boundary if
it does not. Removed the old "removing the element before its navigation task runs is platform
independent" wording.

**Tests.** Added "removes a newly added 0-delay blocked refresh before the debounced sweep" — one
`await Promise.resolve()` flushes the observer, the meta is already gone and the sentinel arrives
without waiting for 50 ms. The debounce-count test still observes exactly one full sweep.

**Device.** `logs/meta-zero.txt`, `screenshots/android-fix03-meta-zero-dynamic.png` and
`-meta-zero-static.png`: dynamic 0-delay meta removed **0.1 ms** after insertion (below the 50 ms
debounce), location stayed `about:blank`, toast shown; the parser-inserted static 0-delay fixture
also had `metaCount 0`, no navigation and the toast.

## M-04 — `ScriptHandler` lifecycle

**Problem.** The Android patch removed/re-registered the document-start handler when props changed,
but never released it on WebView teardown.

**Change.** `mobile/patches/react-native-webview@13.16.2.patch` (regenerated with
`pnpm patch-commit`) now removes the handler in `RNCWebView.destroy()` before `super.destroy()`;
`cleanupCallbacksAndDestroy()` already routes through `destroy()`. Prop-change
remove/re-register is unchanged.

**Verification.** Rebuilt `:app:assembleDebug` (`logs/build-fix03.txt`, BUILD SUCCESSFUL in 29 s),
installed with `adb install -r` (Success). `Document-start injection unavailable` is present in the
APK, and the dex bytecode for `RNCWebView.destroy` calls `ScriptHandler.remove()` before
`WebView.destroy()` (`logs/apk-destroy-bytecode.txt`). Live document-start behavior after install:
the exact-guard fixture's first inline script saw `v2`.

## M-05 — lockfile churn

**Problem.** `mobile/pnpm-lock.yaml` has a 2,642-line working-tree diff, much larger than a patch-hash
refresh.

**Investigation.** The diff contains three distinct parts:

1. `patchedDependencies.react-native-webview@13.16.2` hash and the `patch_hash=` references — the
   only change caused by this round's patch edit (`2df04ce…`).
2. Four new package/snapshot entries: `expo-intent-launcher@55.0.16`, `expo-sharing@55.0.25`,
   `xcode@4.0.0`, `@expo/config-plugins@55.0.12`, plus their importer entries. These follow from the
   pre-existing uncommitted `mobile/package.json` additions (`expo-intent-launcher`, `expo-sharing`),
   not from this round.
3. 309 removed / 314 added snapshot keys that are the same packages re-keyed with
   `(supports-color@8.1.1)` peer suffixes, and the corresponding `expo@55.0.31(...)` peer hash.

**Why it was not split.** Restoring `HEAD:mobile/pnpm-lock.yaml` and re-running the repo's pinned
pnpm (`12.8.1`, `packageManager`) reproduces the same 2,642-line re-resolution, so the churn is the
pinned tool's canonical output from the pre-existing package.json state, not a hand edit. pnpm
10.24.0 produces a smaller diff only by deleting pnpm 12's `configDependencies`/
`packageManagerDependencies` block, which would make the lockfile incompatible with the repo's
pinned pnpm; pnpm 12.0.0 still re-resolves 2,398 lines. Per the review guidance, no package or
lockfile entries were force-reverted. The current lockfile is internally consistent
(`pnpm install` reports "Lockfile is up to date, resolution step is skipped") and was used for the
rebuilt APK.

## M-06 — subframe `about:srcdoc` parity

**Problem.** The native subframe policy allows `about:srcdoc`
(`isInlineSubframeDocument`), while the DOM fence blocked it; the subframe sentinel is dropped, so
the drift was silent.

**Change.** `isBlocked` computes `isSubframe = window.top !== window` (guarded for cross-origin
access) and allows `about:srcdoc` only in a subframe. `about:blank` (with any fragment) remains
allowed everywhere; top-frame `about:srcdoc` remains blocked, matching
`htmlPreviewNavigationDecision`.

**Tests.** Added a subframe parity test over `about:srcdoc`, `about:blank#…`, `about:blankfoo`,
`data:`, `http(s)`, `file:` and `javascript:` using a real child window.

**Device.** `logs/subframe-parity.txt`: in adopted subframes, `about:srcdoc` and `about:blank#x`
were not cancelled, `about:blankfoo` and `file:` were cancelled, `https` was not — matching the
native subframe rule.

## M-07 — false relative-asset warning from `srcdoc`

**Problem.** `findRelativeHtmlAssetRefs` scanned the escaped contents of an iframe `srcdoc`
attribute, so `href=&quot;javascript:...` was treated as a relative path and shown with garbled
`&quot;` text.

**Change.** `mobile/src/files/html-relative-assets.ts` strips the `srcdoc` attribute value
(`(?<![\w-])srcdoc=...`, all quote forms) before collecting top-level `src`/`href`/`url()` refs. The
frame document is not a top-level asset; `data-srcdoc` is not matched.

**Tests.** Added a regression test with the exact escape pattern plus a single-quoted `srcdoc`
containing `./inner.png`; only the real top-level `./outer.png` is reported.

**Device.** Opened the same `iframe-javascript.html` fixture that showed the warning in fix-02:
`logs/iframe-srcdoc.txt` + `screenshots/android-fix03-iframe-srcdoc.png` show zero occurrences of
"Relative assets may not load". The srcdoc iframe fence still blocks its `javascript:` link.

## Verification (executed)

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx \
  src/files/html-relative-assets.test.ts
→ Test Files 3 passed (3); Tests 58 passed (58)

pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 754 passed (754)

pnpm --dir mobile typecheck → exit 0

pnpm --dir mobile exec oxlint <5 changed TS/TSX files> → no findings
pnpm --dir mobile exec oxfmt --check <5 changed TS/TSX files> → all formatted

pnpm run check:code-quality:changed
→ code quality: 0 new finding(s) across 160 changed file(s)
→ casting / focused plugins / type-aware / React Doctor / design system / SAFETY: 0 new findings
→ gate passed since 7bd3928159f5
```

Native rebuild/install:

```text
JAVA_HOME=<openjdk-17> gradle-8.13 :app:assembleDebug --offline --no-daemon \
  -PreactNativeArchitectures=arm64-v8a
→ BUILD SUCCESSFUL in 29s
adb install -r app-debug.apk → Success
```

Android checks after install (all on the visible preview, `document.visibilityState === 'visible'`):

| Case | Result | Evidence |
|---|---|---|
| M-01 exact non-configurable pre-seed before script | click `defaultPrevented`, sentinel sent | `logs/m01-exact-preseed.txt` |
| M-01 document-start + exact pre-seed page | page saw `v2`; trusted tap blocked + toast | `logs/exact-guard-page.txt` |
| M-03 dynamic 0-delay blocked meta | removed in 0.1 ms; no nav; toast | `logs/meta-zero.txt` |
| M-03 static 0-delay blocked meta | meta count 0; no nav; toast | `logs/meta-zero.txt` |
| M-02 dynamic `about:blank` frame | child guard `v2`; `javascript:` not executed; file/intent no external | `logs/dynamic-about-blank.txt` |
| M-06 subframe `about:srcdoc` parity | matches native for srcdoc/blank/blankfoo/http/file | `logs/subframe-parity.txt` |
| M-07 srcdoc warning | warning absent; iframe `javascript:` still blocked | `logs/iframe-srcdoc.txt` |
| Regression matrix | js/file/intent/tel/custom blocked + toast; formaction blocked; fragment navigates; data engine-refused; https opens Chrome | `logs/regression-matrix.txt` |
| Filter chips | row 40 dp / chip 32 dp, list visible | `logs/filter-chips-bounds.xml`, `screenshots/android-fix03-filter-chips.png` |
| Document-start after rebuild | page's first inline script saw guard `v2` | `logs/exact-guard-page.txt` |
| M-04 destroy cleanup in APK | dex calls `ScriptHandler.remove()` before `super.destroy()` | `logs/apk-destroy-bytecode.txt` |

During the final round the environment was collected by another background task (Metro 8081 and the
isolated host 6770 stopped). Both were restarted with the same isolated `ORCA_USER_DATA_PATH`
(`/tmp/orca-mobile-pair/userData`) before the last static-meta check; the already captured evidence
was unaffected.

## Files changed

- `mobile/src/components/html-preview-interception.ts` — no guard early return; named installer;
  synchronous blocked-meta removal; parent adoption of same-origin frames; subframe
  `about:srcdoc`; comments/limits.
- `mobile/src/components/html-preview-interception.test.ts` — exact-value pre-seed, dynamic
  `about:blank` adoption, 0-delay synchronous removal, subframe parity.
- `mobile/src/components/MobileHtmlPreview.tsx` — all-frame comment corrected (navigated/srcdoc
  frames + adoption; not "all frames").
- `mobile/src/files/html-relative-assets.ts` — skip `srcdoc` attribute contents.
- `mobile/src/files/html-relative-assets.test.ts` — srcdoc regression.
- `mobile/patches/react-native-webview@13.16.2.patch` — `ScriptHandler.remove()` in `destroy()`.
- `mobile/pnpm-lock.yaml` — patch hash refresh plus the pre-existing pnpm 12.8.1 re-resolution
  described under M-05.
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/design.md` §9.1/§9.2 —
  WebView 89+ floor, fallback limits, guard semantics, dynamic-frame coverage, 0-delay sync removal,
  subframe parity.
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/test-plan.md` — C8, C11b, C12, C18.
- `remote-connectivity/design/test-reports/fix-03.md` and
  `device-evidence/fix-03/**`.

## Residual risks / not fixed

1. `onPageStarted` fallback (< WebView 89) remains page-first-preemptible and main-frame-only; the
   preview is not gated on the WebView version. Only document-start gives the ordering guarantee.
2. Dynamic `about:blank` frames are covered only when the parent is same-origin and eval is allowed;
   CSP, cross-origin parents, or pre-adoption tampering leave engine behavior as the boundary.
3. Same-context JavaScript can still replace `Event.prototype.preventDefault`, call `form.submit()`
   or `location.href`; external schemes still rely on the engine when it does not deliver the tap to
   `shouldOverrideUrlLoading` (unchanged, documented in §9.1).
4. The lockfile re-resolution remains review noise; it is reproducible with the pinned pnpm and was
   not hand-reverted.
5. iOS was not re-run (Xcode 26 blocker). The JS fence is shared; the iOS all-frames props are
   unchanged. Physical-device testing was not run.
