# Fix-03 independent code review — M-01..M-07 closure and regressions

- Date: 2026-11-10
- Reviewer role: independent, read-only. No product or test code was modified; the only file written is this report.
- Inputs: `fix-code-review-02.md` (M-01..M-07), `fix-03.md`, design.md §9.1/§9.2, test-plan C8/C11b/C12/C18/C19, the current code/tests/patch/applied `node_modules`, and `device-evidence/fix-03/**`.
- Method: code, test and patch reading; focused and broad test runs; `typecheck`/`oxlint`/`oxfmt`/changed-quality; independent probes in happy-dom (the actual injected script, one and two installs), a Hermes 0.14.1 compile check, and Chromium probes of the browser's meta-refresh behavior. Device evidence was reviewed and the screenshot hashes were recomputed; the captured environment was not re-driven (its Metro/host were stopped when this review ran, and a rebuild was neither needed nor available).

## Verdict

**CHANGES_REQUIRED.**

| BLOCKER | MAJOR | MINOR |
|---:|---:|---:|
| 0 | 1 | 4 |

M-01, M-04, M-05 and M-07 are genuinely closed. M-06 is closed for the `about:` forms it targeted, with a small subframe `mailto:` parity/test gap. M-02 is substantially fixed for same-origin frames but has an undocumented pre-adoption ordering residual and a comment overstatement. M-03 is **not** fully closed: the synchronous removal only works when the meta's attributes are already present at insertion, and the new `blockedMetas` WeakSet makes a re-appended blocked meta permanently invisible to both the observer and the 50 ms backstop — a regression over the pre-fix debounce. The native/engine boundary still prevents the out-of-preview outcomes observed in earlier rounds, so this is not a BLOCKER, but the fix's stated guarantee and tests are wrong for those paths.

## Per-item conclusions

### M-01 — guard exact-value pre-seed: closed

- The early return and descriptor read are gone; `install()` always registers listeners. Exact-value and poisoned non-configurable pre-seeds both install (real click, `defaultPrevented`, sentinel), and the idempotent second pass does not double-handle a click because the first cancellation calls `stopImmediatePropagation`.
- The duplicate-install argument is correct for same-target/phase listeners: the first listener stops the later ones on the same target; the `handled` WeakSet is per install, but that is harmless (the later install only matters if the first did not cancel, in which case the duplicate check just re-confirms).
- The fallback remains page-first-preemptible (a page listener registered before the install can stop it) and main-frame-only; design §9.1 and C11b now state this. The device `m01-exact-preseed.txt` is a bare CDP result, but the unit test is the stronger check and is credible.
- No new issue from removing the early return.

### M-02 — dynamic `about:blank` frames: closed for same-origin, with two residual/documentation gaps

- The parent adopts same-origin child windows in its MutationObserver and evaluates the named `install` (WeakSet-deduplicated). Window listeners survive a later `document.open()`/`write()`, as the unit test and device probe show; the device log's `childGuard:"v2"`, `childIsSubframe:true` and the blocked trusted `javascript:` tap are consistent.
- Not a new injection surface: the artifact already controls the child; eval is subject to the child document's CSP, and cross-origin/sandbox-opaque frames cannot be adopted. The residual list (cross-origin, CSP, pre-adoption eval/`Function.prototype.toString` tampering) is accurate but incomplete (see R-03).
- Performance is acceptable: the per-mutation `querySelectorAll` is scoped to the added subtree, and a full document scan is still debounced.
- The residual/documentation gaps are MINORs, not a boundary breach.

### M-03 — 0-delay blocked meta: not fully closed (see R-01)

- The new synchronous branch does remove a blocked meta whose `http-equiv` and `content` are already present when it is inserted; the device's 0.1 ms measurement and the unit test are credible. Allowed `http(s)` metas are left alone and the debounce still coalesces mutations into one full scan.
- Two paths defeat the removal:
  1. An artifact can append a meta with `http-equiv` (or no content) and set `content` **after** insertion. The observer watches only `childList`, so no callback runs; the browser does process a later attribute change and refreshes (independently confirmed in Chromium). If no further childList mutation occurs, the 50 ms backstop never runs either.
  2. The artifact can retain the removed node and re-append it. `blockedMetas.has(meta)` then returns false forever, in both the document-start and post-load installs, so neither the observer nor the debounced sweep removes it. Chromium executes the refresh after re-appending. This is a regression: the pre-fix 50 ms sweep would have removed the re-appended node.
- The native/engine layer still handles the resulting top-frame navigation (`intent:` blocked with toast by the callback; `file:` refused by the engine), so no new external launch was demonstrated. But the fix's test-plan/design claim that a newly added blocked meta is synchronously removed before the navigation task is only true for the attributes-present-at-insertion case, and the tests do not cover either failing path.

### M-04 — `ScriptHandler` lifecycle: closed

- The patch and applied `node_modules` both remove and null the handler in `destroy()` before `super.destroy()`; `cleanupCallbacksAndDestroy()` routes through `destroy()`. Prop-change re-registration is unchanged and correctly re-registers with the current main-frame flag. The handler is an instance field, so WebViews are isolated.
- The API branch is correct: `WebViewFeature.DOCUMENT_START_SCRIPT` is checked and the `onPageStarted` fallback remains. The build log shows `:react-native-webview:compileDebugJavaWithJavac` and `:app:assembleDebug` succeeded, and the dex bytecode in `apk-destroy-bytecode.txt` shows `ScriptHandler.remove()`, the field null, and only then `WebView.destroy()`. The dex/recompile claim is credible.

### M-05 — lockfile: closed as documented, residual review noise

- The patch SHA-256 is `2df04ce2a45fbcb4ed97b2218594d185b09738a65806bcb5602b17649be653a0`, matching both `pnpm-lock.yaml` `patchedDependencies.react-native-webview@13.16.2` and the patch file itself.
- The classification matches the diff: `mobile/package.json` adds `expo-intent-launcher` and `expo-sharing`; the lockfile adds their importer/snapshot entries, `@expo/config-plugins@55.0.12` and `xcode@4.0.0`, plus the `(supports-color@8.1.1)` peer-suffix re-keying. The 2,642-line diff is not a pure patch-hash refresh, but the report says so rather than hiding it.
- The "HEAD + pinned pnpm reproduces the same diff" claim was not independently reproduced (that needs a lockfile swap/install). Nothing in the diff indicates a runtime problem; this remains reviewability debt.

### M-06 — subframe `about:srcdoc` parity: closed for the targeted forms; one MINOR parity/test gap remains

- `isBlocked` now allows `about:srcdoc` only when `window.top !== window` and still allows `about:blank` (with fragments) everywhere; top-frame `about:srcdoc` and `about:blankfoo` remain blocked. The unit test covers the `about:` forms, `data:`, `http(s)`, `file:` and `javascript:`; the device log covers the `about:` forms, `https` and `file:` (and omits `data:`/`javascript:`/`mailto:`).
- The full subframe policy is still not mirrored: `mailto:` is in `ALLOWED` and is therefore not cancelled in a subframe, while the native subframe policy (`SUBFRAME_SCHEMES` = http(s)) blocks it. The subframe parity test and the device log omit `mailto:` (and the device log omits `data:`), so the "everything else is blocked" statement is false. See R-02.

### M-07 — false relative-asset warning: closed

- `SRCDOC_ATTR` strips double-quoted, single-quoted and unquoted `srcdoc` values (case-insensitive, not `data-srcdoc`), before the top-level `src`/`href`/`url()` scan. Real top-level refs after the iframe survive; the regression test covers the escaped `&quot;javascript:...` pattern and a single-quoted `srcdoc` with an inner `./inner.png`.
- The regex's lookbehind compiles with the repo's Hermes compiler (0.14.1), so the mobile bundle is not at risk. The device screenshot/log show the warning gone and the iframe link still fenced.
- Edge cases (unquoted `srcdoc` cannot legally contain markup; `srcdoc=` in inert prose can only under-report) do not warrant a change.

## Findings

### R-01 — MAJOR — M-03: blocked meta can survive the fence via late attributes or re-insertion

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:57,206-217,261-289` (the `blockedMetas` WeakSet, `removeBlockedMeta`, and the observer that watches only `{childList:true,subtree:true}`); tests `mobile/src/components/html-preview-interception.test.ts:441-454` (only attributes-before-insertion).
- **Problem:** the removal guarantee is enforced only for a meta whose attributes are complete at insertion. `MutationObserver` does not watch `attributes`, and `removeBlockedMeta` returns early when the node is already in `blockedMetas`, so:
  - appending a meta and setting `content` later is never seen (the one debounced sweep from the insertion may already have run and no later childList mutation need occur); the browser processes the later content and refreshes;
  - re-appending the same removed node is skipped by the WeakSet in both the document-start and post-load installs, so it is never removed again (the pre-fix debounce would have caught it).
- **Failure scenario:** an artifact creates `<meta http-equiv="refresh">`, appends it, waits, then sets `content="0;url=file:///etc/passwd"` (or appends a blocked meta, lets the fence remove it, and re-appends the same node). The fence leaves it in the DOM and the browser schedules the refresh. On WebView 133 the native callback/engine still blocks the top-frame navigation (no out-of-preview launch observed), but the DOM removal and its intended early feedback are bypassed, and the design/test-plan claim is false for these paths.
- **Suggestion:** observe attribute changes for `meta` elements (`attributes:true, attributeFilter:['http-equiv','content']`) and run the blocked-meta check on those records; do not let the WeakSet suppress removal (track "already notified" separately, or always remove while `meta.isConnected`, using the WeakSet only to avoid re-notifying). Add tests for (a) content set after insertion and (b) re-appending the removed node after the observer microtask, with an assertion that the node is gone after the 50 ms backstop as well.

### R-02 — MINOR — subframe `mailto:` is not in the DOM/native parity, and Android never supplies `isTopFrame`

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:94-114` (allowed-scheme check precedes the subframe rule); `mobile/src/components/html-preview-scheme.ts:11-14,29-33,45-49`; `mobile/src/components/html-preview-interception.test.ts:509-535` (URL list omits `mailto:`); `mobile/src/components/html-preview-scheme.test.ts:87-96` (native subframe policy explicitly blocks `mailto:`); applied `node_modules/react-native-webview/android/.../RNCWebViewClient.java:94-146,314-325` (`createWebViewEvent` has no `isTopFrame`).
- **Problem:** a subframe click on `mailto:` is **not** cancelled by the DOM fence (`mailto:` is in `ALLOWED`) while `htmlPreviewNavigationDecision({isTopFrame:false})` blocks it. The subframe parity test/log omit exactly this URL. On Android the callback event from `createWebViewEvent` has no `isTopFrame`, so `htmlPreviewNavigationDecision` treats every callback as the top frame (the scheme test codifies this at lines 71-76); Android's own docs say `shouldOverrideUrlLoading` may be called for subframes. If it is, a subframe `https` link is handed to `onExternalLink` (Chrome opens instead of rendering in the frame) and a subframe `mailto:` link is handed to `onExternalLink` (the mail app opens), contrary to C18's "iframe renders and does not launch an external browser" and the "subframes never hand anything to the system" comment.
- **Failure scenario:** an artifact embeds an iframe with a `mailto:` (or `https`) link; the DOM fence allows `mailto:` and, on Android, the navigation callback applies the top-frame policy. The parity test and device log cannot detect this because they compare against the `isTopFrame:false` branch that Android never supplies.
- **Suggestion:** in `isBlocked`, mirror `SUBFRAME_SCHEMES` for subframes (`if (isSubframe && protocol !== 'http:' && protocol !== 'https:' && ...) return true` — at minimum block `mailto:`), add `mailto:`/`tel:`/`blob:` to the subframe parity test, and either pass `request.isForMainFrame()` through the Android patch (add `isTopFrame` to the event) or correct the `html-preview-scheme.ts:21-22` comment and state that the subframe rule is iOS-only. Add a trusted subframe `https`/`mailto` tap to the device matrix.

### R-03 — MINOR — adopted-frame ordering: scripts in synchronously written content run before adoption

- **Files/lines:** `mobile/src/components/html-preview-interception.ts:231-259` (adoption in the parent's MutationObserver microtask); design §9.1 residual list; test `html-preview-interception.test.ts:169-205` (writes only markup, no inline script).
- **Problem:** a frame created, appended, and filled synchronously with `document.write` executes any inline script in that content **before** the parent's observer microtask installs the fence. That script can register a window-capture listener that calls `stopImmediatePropagation()` (the fence's listener is later on the same target/phase and never runs), or replace the child's `eval` before adoption. The fix report correctly says listeners are installed before the first user tap, but the residual list only mentions cross-origin/CSP/pre-adoption eval tampering, not this ordering. Sandboxed `allow-scripts` frames (opaque origin) are also unadoptable and only mentioned indirectly as "cross-origin".
- **Failure scenario:** an artifact writes `<script>window.addEventListener('click', e => e.stopImmediatePropagation(), true)</script>` into the dynamic frame, then lures a tap; the adopted fence is pre-empted. This is capability-equivalent to the artifact's own script (it could already run code in the parent), so it is a documentation/test gap, not a new privilege.
- **Suggestion:** add a fixture/test proving the limitation (or, if it is acceptable, explicitly document it as a residual alongside the CSP/eval cases); include sandboxed `allow-scripts` frames in the same sentence.

### R-04 — MINOR — preview comment overstates post-load subframe coverage on Android

- **Files/lines:** `mobile/src/components/MobileHtmlPreview.tsx:109-111`; applied `RNCWebView.java:311-318` (`callInjectedJavaScript` uses `evaluateJavascript`, which targets the main frame) and `RNCWebViewClient.onPageFinished`.
- **Problem:** the comment says "Both passes cover navigated and srcdoc frames". On Android only the before-content (document-start) pass covers subframes; the post-load `injectedJavaScript` pass is main-frame only. The design §9.1 wording is correct; the component comment is not.
- **Suggestion:** say "the before-content pass covers subframes on Android; the post-load pass is the main-frame fallback and the dynamic-frame adoption path".

### R-05 — MINOR — evidence traceability

- **Files/lines:** `device-evidence/fix-03/logs/m01-exact-preseed.txt` (a bare `Runtime.evaluate` result with no evaluated source, URL or page context); `logs/meta-zero.txt`, `logs/subframe-parity.txt`, `logs/regression-matrix.txt` (curated narratives, not raw commands/results); no SHA-256 manifest for the 11 screenshots.
- **Problem:** the screenshots are distinct (independently recomputed; all 11 hashes differ) and the bounds XML does support the row/chip claim (`[0,406][1080,511]` and `[32,417][134,501]`), so the visual evidence is fine. But the timing-sensitive probes cannot be reproduced from the artifact alone, and the subframe log's "everything else is blocked" is contradicted by the `mailto:` gap in R-02. This is a reviewability gap, not a runtime finding.
- **Suggestion:** record the exact CDP command/evaluated source for `m01-exact-preseed.txt`, include a SHA-256 list, and re-run the subframe parity log with `mailto:`/`data:` included.

## Verification commands and results

```text
pnpm --dir mobile test src/components/html-preview-interception.test.ts \
  src/components/mobile-html-preview-frame.test.tsx src/files/html-relative-assets.test.ts
→ Test Files 3 passed (3); Tests 58 passed (58)          (matches fix-03.md)

pnpm --dir mobile test src/components src/files/MobileFileFilterChips.test.tsx \
  src/files/MobileFilePreviewBody.test.tsx src/files/MobileFilePreviewScreen.test.ts \
  src/files/MobileFilePreviewScreen.actions.test.tsx src/files/MobileFileExplorerPanel.test.ts \
  src/files/html-relative-assets.test.ts
→ Test Files 103 passed (103); Tests 754 passed (754)    (matches fix-03.md)

The interception test file was re-run five times: 26/26 each time (no observed flake).

pnpm --dir mobile typecheck → exit 0
oxlint <5 changed TS/TSX files> → exit 0
oxfmt --check <5 changed TS/TSX files> → all matched files use the correct format
pnpm run check:code-quality:changed → 0 new findings across 160 changed files; gate passed
```

Patch/install checks:

```text
sha256(mobile/patches/react-native-webview@13.16.2.patch)
  = 2df04ce2a45fbcb4ed97b2218594d185b09738a65806bcb5602b17649be653a0
  = pnpm-lock.yaml patchedDependencies[...] (line 175)
applied node_modules has the document-start handler, per-instance field,
prop setters and destroy() cleanup; dex bytecode matches logs/apk-destroy-bytecode.txt.
```

Independent probes (no product/test files changed; scripts live in `/tmp`):

```text
Hermes 0.14.1 hermesc compiles the html-relative-assets lookbehind regex → OK
happy-dom, actual fence, one and two installs:
  content set after insertion            → node remains in the DOM
  http-equiv/content set after insertion → node remains in the DOM
  blocked meta removed, then re-appended → node remains after the 50 ms backstop
Chromium (MCP browser):
  meta content set after insertion       → refresh fires (about:blank#attr-after)
  re-appended meta (removed by observer) → refresh fires (hash #reinsert)
DOM/native subframe parity probe:
  mailto: → DOM not blocked, native subframe policy block
  about:srcdoc/blank# → both allow; about:blankfoo/file: → both block; https: → both allow
```

Device evidence reviewed (not re-driven; Metro/host were stopped): all 11 fix-03 screenshots have distinct SHA-256 values and show the claimed outcomes (`exact-guard` toast/status idle, dynamic frame no execution, meta-zero toast/status idle, iframe-srcdoc warning absent, formaction/custom markers plus toast, https in Chrome); `filter-chips-bounds.xml` contains row `[0,406][1080,511]` and chip `[32,417][134,501]`; the build and dex logs are consistent with the patch.

## Residual risks

1. Same-context page script can still tamper with `Event.prototype.preventDefault`, call `form.submit()` or set `location.href`; external schemes still rely on the engine/native callback where the tap is not delivered. Unchanged and documented.
2. The `onPageStarted` fallback (< WebView 89) remains page-first-preemptible and main-frame-only; the preview is not gated on the engine version. Unchanged and documented.
3. The M-03 DOM removal can be bypassed by late attribute writes or node re-insertion (R-01); the native/engine boundary still blocks the top-frame navigation, but the application-level guarantee and its evidence are incomplete.
4. Adopted frames are fenced only after the parent's observer microtask; content written synchronously can pre-empt the fence with its own listeners, and sandboxed/CSP/cross-origin frames remain unfenced (R-03).
5. Subframe `mailto:` is not in the DOM/native parity, and the Android callback cannot distinguish subframes; the effective outcome for a subframe `https`/`mailto` tap is unverified on device (R-02).
6. The lockfile re-resolution remains review noise (M-05); no runtime issue observed.
7. iOS was not re-run (Xcode 26 blocker); the JS fence is shared and the iOS props are unchanged, but the iOS subframe callback path was not exercised in this round.
