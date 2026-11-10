# Code Review 03 — Mobile HTML open modes

Scope: the review-02 fixes for the HTML open-mode feature (`design.md` sections 7-8, `test-plan.md`, `tasks.md`) in the current working tree. File-browser download/search, terminal-link/selection, and terminal-load diagnostics work were treated as out of scope except where shared code is load-bearing.

Verdict: **APPROVED_WITH_MINORS**
Counts: **0 BLOCKER / 0 MAJOR / 3 MINOR**

Review-02 B1, m1 and m2 are resolved. m3 is resolved for rotation and C5 but the B11 test still does not exercise Pressability's long-press cancellation. One new navigation-hygiene issue and one narrow pre-preference render issue remain.

Evidence (read-only):

- `npx vitest run` (mobile) on 18 focused HTML/action/read-failure files — 211 passed.
- `npx tsc --noEmit` (mobile) — exit 0.
- `node scripts/check-tests-typecheck-ratchet.mjs` — OK (993 files, 122 grandfathered).
- `npx oxlint` on every touched HTML/prod file — no findings.
- `pnpm run check:code-quality:changed` — 3 findings, all in the out-of-scope `mobile/src/session/mobile-terminal-diagnostics.test.ts`; no HTML file appears. Same residue as review-02.

## BLOCKER

None.

## MAJOR

None.

## MINOR

### n1. The B11 long-press-release test is still vacuous

`mobile/src/files/MobileFileExplorerPanel.test.ts:712-731` now calls `row.props.onLongPress()` and then `row.props.onPressOut?.()`. The row's `Pressable` has no `onPressOut` handler (`mobile/src/files/mobile-file-explorer-row.tsx:117-136`), so the optional call at test line 727 does nothing. `Pressable` is mocked as a host string at test line 93, so neither RN Pressability nor any cancellation runs.

Scenario: a regression where a long-press release also dispatches `onPress` still passes this test — the test never calls `onPress` after the long press, and the only cancellation it claims to cover is a comment. The product behavior is correct today because it relies on RN Pressability (source comment `mobile-file-explorer-row.tsx:124`), but review-02 m3's request ("Pressability's cancellation ... exercised") is not met. Use a real Pressability test (`@testing-library/react-native` / a Pressability harness), or extract the row's press/long-press decision into a pure handler and assert the release path there.

### n2. A stored Source preference can flash the rendered page before storage resolves

`use-mobile-file-preview-html-mode.ts:32` starts `preference` as `null`, and `:54-64` resolves `ask` to the page-local mode `preview` while the preference is still unread. `MobileFilePreviewScreen.tsx:374` marks the file renderable as soon as the RPC read is ready, and `MobileFilePreviewBody.tsx:118-120` mounts the JS-enabled frame for `htmlMode === 'preview'`.

Scenario: bare HTML route (deep link / terminal file tap) with stored `source`; the host read returns before `loadMobileHtmlOpenMode()` does. The frame mounts and scripts execute for a frame or two before the mode flips to Source, even though the settings row promises Source opens the text view directly. Hold the body in a non-rendering state (or source) until the preference read settles when the route is bare and `ask`/unread.

### n3. The generic Preview action now writes an HTML `mode` into non-HTML routes

`MobileFileExplorerPanel.tsx:183-189` passes the action id as the route mode for every worktree `preview`, and `mobile-file-actions.ts:136-138` emits the generic `preview` action for every previewable non-HTML row. `openPreviewFile` then adds `mode: 'preview'` whenever the third argument is present (`MobileFileExplorerPanel.tsx:125-135`).

Scenario: long-press `README.md` (or a text/image row) → Preview. The pushed preview route now carries `mode=preview`, although `MobileFilePreviewRouteParams.mode` is the HTML open mode (`mobile-file-preview-route.ts:21`). It is inert today because only the HTML hook reads it, but it changes non-HTML route params and becomes a latent bug for any future `mode` consumer, share/reload, or route-diff. Pass `mode` only when `actionTarget.kind === 'html'` (the `source` id is already HTML-only; only the shared `preview` id needs the guard).

## Review-02 item verification

| Item | Result |
|---|---|
| B1 chooser target survives close/afterClose | **Resolved.** `MobileFileOpenModeSheet.tsx:27,40-46,69-75` defers dispatch to `onAfterClose`; `use-mobile-file-html-open-mode.ts:18,54-63` keeps the target in `pendingTargetRef`, which `closeChooser` (`:81`) does not clear. List wiring passes both callbacks (`MobileFileExplorerPanel.tsx:370-376`). |
| B1 integration test genuinely fails old behavior | **Yes.** `MobileFileOpenModeSheet.integration.test.tsx:158-178` drives the real sheet and hook: tapping Source closes the real action sheet (invoking `onClose` → `closeChooser`), then calls the post-close `onAfterClose`. An old `selectMode` capturing cleared `pending` state would be the re-rendered callback and would no-op; the test asserts the push and the preference write. |
| B1 dismiss clears target | **Yes in code** (`use-mobile-file-html-open-mode.ts:82-85`); the test at `MobileFileOpenModeSheet.integration.test.tsx:180-190` proves dismissal does not navigate (the target-ref clearing itself is not observable there, because no dispatch follows a dismiss). |
| B1 remember writes correctly | **Yes.** `selectMode` writes only when `remember` (`:64-70`); the integration test asserts no write before `onAfterClose` and a `source` write after. |
| m1 readFailed suppresses chooser / forces source / passes resolver→hook→screen | **Resolved.** `MobileFilePreviewScreen.tsx:91,100-106` computes and forwards `readFailed`; `use-mobile-file-preview-html-mode.ts:18-24,39-52,65-71` skips storage, forces source and hides the sheet; `mobile-html-open-mode.ts:36-38` makes read failure beat route mode; `MobileFilePreviewHtmlControls.tsx:23` hides the toolbar; `mobile-file-open-mode-actions.ts:31-33` removes mode actions. Tests: `use-mobile-file-preview-html-mode.test.tsx:107-115`, `MobileFilePreviewScreen.actions.test.tsx:479-494`. |
| m2 list manualChoice guard / discriminating test | **Resolved.** `use-mobile-file-html-open-mode.ts:20,28-30,62`; `MobileFileExplorerPanel.test.ts:733-761` resolves the stale `ask` after the remembered choice and then taps again. Without the guard the late `setMode('ask')` would reopen the chooser, so the test fails old behavior. |
| m3 rotation | **Real.** `MobileFilePreviewScreen.actions.test.tsx:496-519` changes the mocked dimensions and updates the real screen, then asserts the page-local mode and recomputed image box. |
| m3 C5 `accessibilityState.disabled` | **Real.** `MobileFilePreviewScreen.actions.test.tsx:363-376` inspects the real `MobileFileHtmlModeToolbar` tab nodes (not a mocked body/sheet); the truncated Preview tab reports `{selected:false, disabled:true}`. |
| m3 B11 behavior | **Not resolved** — see n1. |
| Action arrays / read-failure / preference regressions | No HTML regression found. `mobile-file-actions.test.ts:117-190`, `MobileFilePreviewScreen.actions.test.tsx:321-436`, list actions at `MobileFileExplorerPanel.test.ts:618-710`, and `preferences.test.ts:600-641` all pass. Read-failure arrays remain Retry/Save/Open/Copy path/Cancel. |
| Navigation / dead refs | One impurity (n3). No dead HTML refs found: `onDismiss`, `availableHtmlOpenActions`, `isMobileHtmlPreviewMode`, and the route `mode` are all used; the old shell-params helper is gone. |

## Gate status

- Focused tests, mobile production typecheck, focused lint, and the tests-typecheck ratchet pass.
- `check:code-quality:changed` still fails only on the concurrent `mobile-terminal-diagnostics.test.ts` work; no HTML file is implicated. Merge still requires that gate to be green.
