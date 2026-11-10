# Fix report 04 — R-01..R-05 from fix-03 code review

- Date: 2026-11-10
- Branch: `feat/remote-terminal-load-diagnostics` (no commit made)
- Input: `fix-code-review-03.md` (R-01 MAJOR, R-02..R-05 MINOR), `fix-03.md`, design §9,
  test-plan C8/C11b/C12/C18/C19.
- Environment: AVD `Pixel_8a` (Android 16 / API 36, arm64, `emulator-5554`), WebView
  `133.0.6943.137`, Orca Mobile 0.0.52 debug, isolated host on 6770, Metro on 8081.
  The native patch required a rebuilt APK
  (`sha256 b03b521d2ce23152b4819dcf9afc22bc0e39e4d42b15fe478f592405bb1d772e`), installed with
  `adb install -r`. JS changes were hot-loaded by Metro.
- Evidence: `device-evidence/fix-04/` (fixtures, scripts, logs, screenshots, SHA-256 manifest).
- Scope: only R-01..R-05. Unrelated dirty session/terminal/runtime files were not touched.

## Verdict

| Finding | Severity | Status |
|---|---|---|
| R-01 blocked meta survives late attributes / re-append | MAJOR | **Fixed** — observer watches `http-equiv`/`content`; WeakSet no longer suppresses removal; tests + device |
| R-02 subframe `mailto:` parity and Android `isTopFrame` | MINOR | **Fixed** — DOM subframe policy mirrors native; Android patch forwards `isForMainFrame()`; device proves frame https stays in preview |
| R-03 pre-adoption ordering limit | MINOR | **Documented + pinned by test/fixture** (not claimed fixed) |
| R-04 preview comment overstates Android post-load subframe coverage | MINOR | **Fixed** — comment corrected |
| R-05 evidence traceability | MINOR | **Fixed for fix-04** — scripts with sent source, raw commands, SHA-256 manifest, parity re-run with `mailto:`/`data:` |

All 103 component/file test files pass (759 tests), typecheck/lint/format/changed-quality pass, and
the rebuilt APK was verified by dex bytecode and device probes.

## R-01 — MAJOR — blocked meta removal

**Root cause.** (1) The observer watched only `childList`/`subtree`; a meta appended with
`http-equiv` and given `content` later never produced a child-list record, and the single debounced
sweep could already have run. (2) `removeBlockedMeta` returned early when the node was in
`blockedMetas`, so a page could remove the node, re-append it, and make it permanently invisible to
both the observer and the 50 ms backstop (a regression against the pre-fix sweep).

**Change** (`mobile/src/components/html-preview-interception.ts`):

- `observer.observe(document, { childList: true, subtree: true, attributes: true,
  attributeFilter: ['http-equiv', 'content'] })`; attribute records call `removeBlockedMeta` on the
  target. Setting `content` or `http-equiv` after insertion is therefore removed in the observer
  microtask, before a 0-delay refresh task.
- `removeBlockedMeta` no longer skips on the WeakSet. It always removes a blocked connected meta;
  the WeakSet only suppresses a duplicate notification (one toast per node).
- The 50 ms debounced full scan remains a backstop.

**Tests** (`html-preview-interception.test.ts`):

- "removes a meta whose content is set after insertion" — append with `http-equiv`, set `content`
  later; node gone after one microtask, sentinel after its delay, still gone after the debounce.
- "removes a meta whose http-equiv is set after insertion".
- "removes a blocked meta again when the page re-appends the removed node" — first removal,
  re-append, second removal in the observer microtask, still gone after the 50 ms backstop, exactly
  one notification.

**Device** (`logs/r01-meta.txt`, `screenshots/android-fix04-meta-late-reappend.png`): guard `v2`;
late `content` removed 6.5 ms after the attribute write; re-appended node removed 0.1 ms after the
second insertion; both absent 120 ms later; `refreshMetaCount 0`, location `about:blank`, toast
"This link type isn't supported in preview" visible, top activity Orca.

## R-02 — MINOR — subframe scheme parity and Android `isTopFrame`

**Root cause.** The DOM `isBlocked` checked the top-frame whitelist (`http(s)`/`mailto`) before any
subframe rule, so a subframe `mailto:` was allowed while the native subframe policy blocked it. On
Android `createWebViewEvent` never carried `isTopFrame`, and the JS policy treats a missing value as
the top frame, so an Android subframe callback would have applied the top-frame policy (open Chrome
or the mail app).

**Change**

- `html-preview-interception.ts`: inside `install`, `SUBFRAME_ALLOWED = ['http:', 'https:']` and a
  subframe branch in `isBlocked` mirrors the native rule: only http(s), `data:` and inline
  `about:blank`/`about:srcdoc` pass; `mailto:`, `tel:`, `blob:`, `file:`, `intent:`, custom schemes
  and `about:blankfoo` are blocked. (`SUBFRAME_ALLOWED` lives inside `install` because
  `adoptFrame` copies the function through `toString()` into the child window; a closure-scoped
  constant would be a ReferenceError there.)
- `mobile/patches/react-native-webview@13.16.2.patch` + applied `node_modules`:
  `RNCWebViewClient.shouldOverrideUrlLoading(WebView, String)` keeps its old event shape (no field)
  and delegates to a helper; `shouldOverrideUrlLoading(WebView, WebResourceRequest)` passes
  `request.isForMainFrame()` as `isTopFrame` into the event in both the blocking and fallback
  branches. The `String` overload is main-frame-only on the API levels where it is used.
  New patch SHA-256: `2f33bd3807c63a63089737fbb1c3f5b0b272cd7630846f8233ae294c9940c8f2`
  (lockfile `patchedDependencies` updated by `pnpm patch-commit`).
- Type declaration: `react-native-webview`'s `lib/WebViewTypes.d.ts` already declares
  `ShouldStartLoadRequest.isTopFrame: boolean` (re-exported through `index.d.ts`), so no type change
  was needed; the patch makes Android actually populate it. `MobileHtmlPreview.tsx` already passes
  `request.isTopFrame`; a comment now records the Android source and the legacy-overload behavior.
  iOS has always supplied the field (`RNCWebViewImpl.m`).

**Tests** (`html-preview-interception.test.ts`):

- The subframe parity URL list now includes `mailto:`, `tel:`, `blob:`, `intent:` and a custom
  scheme in addition to `about:`/`data:`/http(s)/file/javascript.
- "blocks mailto, tel, blob and app schemes in a subframe but lets mailto leave from the top"
  asserts the top/subframe split explicitly.

**Device** (`logs/r02-subframe.txt`, fixture `fixtures/subframe-parity.html`): trusted CDP taps in a
srcdoc iframe with guard `v2`.

| link | frame URL after tap | top activity |
|---|---|---|
| `mailto:` | `about:srcdoc` (unchanged) | Orca — no mail app, no toast |
| `tel:` | `about:srcdoc` | Orca |
| `blob:` | `about:srcdoc` | Orca |
| `data:` | `data:text/html,ok` (renders in frame) | Orca |
| `https:` | `https://example.com/` (renders in frame) | Orca — **Chrome did not open** |

The https result is the observable proof that `isForMainFrame=false` reached JS: without the field
the top-frame policy would have called `onExternalLink` and opened Chrome.

Platform note: when no value is available (only the deprecated Android `String` overload), the JS
policy keeps the existing top-frame semantics. That overload is main-frame-only on the API levels
that use it, and the DOM fence blocks dangerous schemes regardless. iOS and current Android supply
the flag.

## R-03 — MINOR — pre-adoption ordering residual

Not a fix; the review explicitly allowed documenting it. Same-task `document.write` inline script in
a new frame runs before the parent's adoption microtask, so it can register a window-capture
listener that `stopImmediatePropagation()`s the later-adopted fence, or replace the child's `eval`.
Sandboxed `allow-scripts` frames (opaque origin) cannot be adopted at all.

- Design §9.1 now states this ordering residual and keeps the "do not claim document-start covers
  all iframes" rule.
- Test-plan C18 records it.
- Unit test: "documents the pre-adoption ordering limit for synchronously written frame script" —
  the child listener is installed synchronously before the adoption microtask, the adopted guard is
  `v2`, and the tap is not cancelled (the page listener wins). happy-dom does not execute scripts
  written through `document.write`, so the test runs the equivalent synchronous child `eval`; the
  comment says so.
- Device fixture `fixtures/pre-adoption-order.html` writes the script inline; a trusted tap produces
  `status: FRAME JS EXECUTED` after the page listener pre-empts the fence (adopted guard `v2`),
  recorded in `logs/r03-pre-adoption.txt`.

This is capability-equivalent to the page's own script (it could already run code in the parent).
The fence remains the boundary for content written after adoption; no coverage is claimed for this
ordering.

## R-04 — MINOR — MobileHtmlPreview comment

`mobile/src/components/MobileHtmlPreview.tsx`: the injected-script comment now says that on Android
the before-content pass (document-start) covers subframes, the post-load pass is the main-frame
fallback, and the script adopts same-origin `document.write` frames. It no longer claims both passes
cover frames.

## R-05 — MINOR — evidence traceability

- `device-evidence/fix-04/scripts/` holds the complete evaluated source for every probe
  (`cdp-common.mjs` plus per-probe scripts); `logs/r05-raw-commands.txt` records the raw `adb
  forward` / `curl` / `node` commands and notes the protocol parameters.
- `logs/sha256-manifest.txt` lists SHA-256 for every fixture, log, script and screenshot in
  `fix-04/`.
- The subframe parity run was repeated with `mailto:`, `tel:`, `blob:` and `data:` added
  (`logs/r02-subframe.txt`), closing the fix-03 gap.
- fix-03 artifacts are unchanged. For the record: `fix-03/logs/m01-exact-preseed.txt` was a bare
  `Runtime.evaluate` result, and `fix-03` included no SHA-256 manifest; this round closes the
  equivalent gaps for its own probes but does not rewrite history. The fix-03 screenshots remain
  valid evidence for their claims and are not re-hashed here.

## Regression

`logs/regression-matrix.txt`:

- Document-start after rebuild: the page's first inline script saw `v2`.
- `javascript:`, `file:`, `intent:`, `tel:`, custom scheme: cancelled, page status idle, page's own
  capture listeners never ran, toast shown; top activity Orca.
- `formaction` javascript: cancelled.
- Fragment navigated in place (`#section`).
- `https:` opened Chrome (accepted external boundary).
- `data:` top-frame navigation was refused by the WebView engine (URL unchanged, Orca foreground),
  matching the fix-03 "engine-refused" note.
- Iframe `javascript:` link cancelled with no host toast.
- Meta refresh: see R-01.
- Filter chips: row 105 px = 40 dp, chips 84 px = 32 dp; selection All → Code → All; screenshot
  `screenshots/android-fix04-filter-code.png`, bounds `logs/filter-chips-bounds.xml`.
- Session file page Preview/Source: `screenshots/android-fix04-preview-mode.png` and
  `android-fix04-source-mode.png`.

## Verification (executed)

```text
pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 759 passed (759)

pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx src/components/html-preview-scheme.test.ts
→ Test Files 3 passed (3); Tests 50 passed (50)

pnpm --dir mobile typecheck → exit 0
pnpm --dir mobile exec oxlint <3 changed TS/TSX files> → no findings
pnpm --dir mobile exec oxfmt --check <3 changed TS/TSX files> → all formatted
pnpm run check:code-quality:changed
→ 0 new findings across 160 changed files; gate passed since 7bd3928159f5
```

Native rebuild/install:

```text
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ... gradle-8.13 :app:assembleDebug --offline --no-daemon \
  -PreactNativeArchitectures=arm64-v8a
→ BUILD SUCCESSFUL in 29s; :react-native-webview:compileDebugJavaWithJavac executed
adb install -r app-debug.apk → Success
APK sha256 b03b521d2ce23152b4819dcf9afc22bc0e39e4d42b15fe478f592405bb1d772e
dexdump classes2.dex → const-string "isTopFrame"; WebResourceRequest.isForMainFrame() invocations
```

## Files changed

- `mobile/src/components/html-preview-interception.ts` — attribute observation, no WeakSet removal
  suppression, subframe policy inside `install`, residual comments.
- `mobile/src/components/html-preview-interception.test.ts` — late content/http-equiv, re-append,
  subframe mailto/tel/blob parity, pre-adoption ordering fixture.
- `mobile/src/components/MobileHtmlPreview.tsx` — corrected coverage comment, isTopFrame note.
- `mobile/patches/react-native-webview@13.16.2.patch` — `WebResourceRequest.isForMainFrame()` →
  `event.isTopFrame` for both callback branches (patch regenerated with `pnpm patch-commit`).
- `mobile/pnpm-lock.yaml` — patch hash `2f33bd38…` and the pre-existing pnpm 12.8.1 re-resolution
  (unchanged in kind from fix-03; not split).
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/design.md` §9.1/§9.2 — attribute
  observation, re-append behavior, subframe scheme set, Android `isTopFrame`, pre-adoption residual.
- `remote-connectivity/design/2026-11-10-mobile-html-open-modes/test-plan.md` — C12 and C18.
- `remote-connectivity/design/test-reports/fix-04.md` and `device-evidence/fix-04/**`.

## Residual risks / not fixed

1. R-03 ordering: same-task `document.write` script runs before adoption and can pre-empt the fence
   or tamper with `eval`; sandboxed `allow-scripts` frames cannot be adopted. Documented and pinned,
   not fixed.
2. Cross-origin frames, CSP that forbids `eval`, and pre-adoption `Function.prototype.toString`
   tampering remain outside the fence (engine boundary). Unchanged.
3. Same-context page script can still replace `Event.prototype.preventDefault`, call `form.submit()`
   or set `location.href`; external schemes still rely on the engine when no tap is delivered to the
   DOM. Unchanged and documented.
4. Android before API 24 uses the deprecated `String` overload, which has no frame flag; it is
   main-frame-only there, and the DOM fence still blocks dangerous schemes.
5. The lockfile re-resolution remains review noise (reproducible with the pinned pnpm; not
   hand-reverted).
6. iOS was not re-run (Xcode 26 blocker). The shared JS fence and the iOS `isTopFrame` source are
   unchanged; the iOS subframe callback path was not exercised in this round.
