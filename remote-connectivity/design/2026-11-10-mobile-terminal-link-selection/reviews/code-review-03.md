# Code review 03 — mobile terminal link sheet + CJK/wide selection

Scope: third-round review of the link-sheet and selection work on `feat/remote-terminal-load-diagnostics`, verifying the two MINOR fixes from `reviews/code-review-02.md` against `design.md` §7, `test-plan.md`, `tasks.md`, and the current working-tree diff. Concurrent file-browser/HTML and remote-terminal-load-diagnostics changes were read only where they share the gate output; they are not reviewed here.

Date: 2026-11-10
Verdict: **APPROVED — 0 BLOCKER / 0 MAJOR / 0 MINOR**

Both round-02 MINORs are correctly fixed. No earlier BLOCKER or MAJOR is re-opened, and no new race, deadlock, or test-isolation leak was found in the fix.

---

## Round-02 disposition

| ID                                     | Status    | Evidence                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MINOR 1 — legacy migration lost update | **Fixed** | One module-level barrier (`mobile/src/storage/preferences.ts:275-291`) now orders `saveTerminalLinkOpenMode` (`:303-306`) and the migration's read/compare/write (`:316-344`). `loadTerminalLinkOpenMode` waits the barrier (`:294`). See verification below.                |
| MINOR 2 — A21 / A30b coverage          | **Fixed** | A21 at `mobile/src/session/use-mobile-session-file-actions.test.ts:341-378` runs the real screen-state and preference-focus hooks; A30b at `:380-412` drives unavailable → sheet → recovered → direct with no preference rewrite. Both are discriminating, not tautological. |

---

## Requested-item verification

### 1. Module-level write queue

`queueTerminalLinkOpenModeWrite` (`preferences.ts:278-291`) chains each write onto the previous barrier; the barrier is a rejection-swallowed view (`:280-283`) so one failed write cannot stall later writes, while the promise returned to the caller is the unswallowed `queued` (`:290`), preserving rejection semantics (`saveTerminalLinkOpenMode` still rejects to its caller; `runTerminalLinkAction`'s `.catch` at `use-mobile-session-file-actions.ts:255-259` still fires — exercised by `use-mobile-session-file-actions.test.ts:466-483`).

- **No deadlock:** the queued write never calls `saveTerminalLinkOpenMode` or `loadTerminalLinkOpenMode`; the migration uses `persistMirrored` directly inside its own queued slot (`:323-343`). Nothing re-enters the queue, and no queued write awaits the barrier itself. The identity-guarded cleanup (`:285-289`) only clears the barrier it installed, so a write queued after resolution is not stranded.
- **Load waits:** `loadTerminalLinkOpenMode` awaits `terminalLinkOpenModeWriteBarrier` before reading (`:293-297`). In the lost-update test the load is issued before the deferred migration read is released and still resolves to `phone-browser`, so this assertion is load-bearing.
- **Ordering covers both directions:** migration-then-save ends at the user's save (verified below); save-then-migration reads the v2 value first and only deletes the legacy key (A20b test, `preferences.test.ts:537-545`).
- **Test reset:** the latch and barrier are reset in `beforeEach` (`preferences.test.ts:484-489`) through `resetLegacyTerminalLinkOpenModeForTests` (`preferences.ts:347-350`). No test in the file leaves a queued write pending; later describes in the file do not touch the link queue, and every other suite mocks the preferences module, so there is no cross-file isolation leak.

### 2. Deterministic lost-update test actually fails old behavior

The test (`preferences.test.ts:555-587`) defers the migration's v2 read at its callback, issues the Remember save and a reload, then releases it. I reproduced the exact storage double and both implementations outside the repo:

```text
old { preselect: 'orca-browser', loaded: 'ask',            stored: 'ask',            finalAssertionPasses: false }
new { preselect: 'orca-browser', loaded: 'phone-browser',  stored: 'phone-browser',  finalAssertionPasses: true  }
```

Under the old unqueued code the migration's already-issued null read writes `ask` after the save has landed, so the test's final `storage.get(v2) === 'phone-browser'` and `reloaded === 'phone-browser'` both fail. Under the barrier the save is ordered after the migration and wins. The test is deterministic: every await is driven by the deferred, not by timers or scheduling luck.

### 3. A21 is a real initial-ask-before-load race test

`renderScreenHarness` (`use-mobile-session-file-actions.test.ts:177-203`) mounts the real `useMobileSessionScreenState` and `useMobileSessionPreferenceFocus`, so the pending `loadTerminalLinkOpenMode` promise is the production focus loader, not a hand-set prop. Before the deferred resolves the test asserts mode `ask`, opens the sheet, and asserts neither `openExternalLink` nor `handleCreateBackgroundBrowser` ran (`:341-362`). Resolving `orca-browser` then asserts the state updated and a second tap goes direct with no sheet (`:364-376`). This fails if the initial state regresses to `orca-browser`, if the focus loader is unwired, or if an unresolved load were treated as a stored mode.

### 4. A30b recovery assertion is real

`use-mobile-session-file-actions.test.ts:380-412` uses the actual hook with `statusReadable: false`: the sheet opens, `create` is not called, `saveTerminalLinkOpenMode` is not called, and `setTerminalLinkOpenMode` is not called (no downgrade). After closing the sheet, mutating `statusReadable` and rerendering, the same stored `orca-browser` takes the direct path (`create` called, no sheet) and still writes no preference. Mutating the scope and rerendering feeds the production `resolveTerminalLinkRemoteAvailability`/`resolveDirectTerminalLinkAction` pair, so the recovery half is genuinely exercised.

### 5. Earlier findings / no re-open

- **B1 Chrome-74:** `text-tokenizer.ts` and `selection-range.ts` contain no `.at(`, `findLast`, `toSorted`, `replaceAll`, or other post-74 built-in; the generated document bundle has none of the review-01 list either. The runtime-floor tests (`text-tokenizer.test.ts:163`, `selection-range.test.ts:239`) delete `Array.prototype.at` and `Intl.Segmenter`.
- **M1 trailing-slash atomics:** only the `SLASH_PATH_RE` spans are filtered, and only when the whole span matches `^[.\\/]+$` (`text-tokenizer.ts:108-116`); HTTP/file spans are pushed unfiltered. G12/G13 vectors pass in both arms.
- **m1 unparseable summary:** `terminal-link-presentation.ts:98-105` emits only `scheme:…`/`Unparseable URL`; zero-width format characters are included in the sanitizer (`:9-26`); component test at `TerminalLinkActionSheet.test.tsx:183-197`.
- **m2 silent refusals:** every `handleCreateBackgroundBrowser` guard toasts (`use-mobile-session-content-create-actions.ts:161-184`), the RPC catch toasts (`:202-205`), and the direct path falls back to the sheet on `false`/rejection (`use-mobile-session-file-actions.ts:184-203`).
- **m4 single sheet-close owner:** the only active-handle effect is `use-mobile-session-file-actions.ts:136-140`; `use-mobile-session-screen-state.ts` owns state only.
- **m6 sheet reset:** the body is keyed per open URL (`TerminalLinkActionSheet.tsx:28-31`), with the regression test at `TerminalLinkActionSheet.test.tsx:199-219`.
- **A20/A20b:** migration only writes `ask` when v2 is absent and always removes the legacy key (`preferences.ts:326-337`), covered by `preferences.test.ts:524-545`.

---

## Verification performed

- `pnpm --dir mobile vitest run src/storage/preferences.test.ts src/session/use-mobile-session-file-actions.test.ts src/session/use-mobile-session-content-create-actions.test.ts src/session/terminal-link-open-policy.test.ts src/session/terminal-link-presentation.test.ts src/session/TerminalLinkActionSheet.test.tsx` — 6 files / 97 tests pass.
- `pnpm --dir mobile vitest run src/terminal/document/text-tokenizer.test.ts src/terminal/document/selection-range.test.ts src/terminal/document/native-document-bundle.test.ts src/terminal/terminal-webview-tap-routing.test.ts` — 4 files / 107 tests pass.
- `pnpm --dir mobile vitest run src/settings/browser-settings-screen.test.tsx` — 3 tests pass.
- `pnpm --dir mobile typecheck` — passes.
- `pnpm --dir mobile typecheck:tests` — fails only on pre-existing repo-wide errors (transport/worktree/settings-state suites); none is in a link/selection or storage file.
- `pnpm run check:code-quality:changed` — 0 findings in the link/selection files reviewed here. The gate still exits 1 with 6 findings, all in the concurrent features: `mobile/src/session/mobile-terminal-diagnostics.test.ts:67,80,92` (type assertions without SAFETY annotations, load-diagnostics) and `mobile/src/files/use-mobile-file-preview-html-mode.ts:74,78,84` (`no-adjust-state-on-prop-change`, file-browser/HTML). Neither is a regression of this feature.
- Reproduced the round-02 lost update and the round-03 fix with an independent storage-double simulation (results above).
- Read-only: no source or test file was modified.

## Observations (not counted as findings)

- The link queue has no unit-level "continues after a failed write" case of its own (the analogous `saveDefaultSessionView` test exists at `preferences.test.ts:167-183`); failure propagation is covered at the consumer level (`use-mobile-session-file-actions.test.ts:466-483`). Optional future coverage only.
- `resetLegacyTerminalLinkOpenModeForTests` nulls the barrier unconditionally, which is safe for the current tests (all queued writes are awaited) but would not protect a future test that deliberately abandons an in-flight write.
