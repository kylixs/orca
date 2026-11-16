# U154 — user-initiated create gestures for the remaining terminal entries

## Entries wired

| Entry | File | Mark call |
| --- | --- | --- |
| File-tree "New Terminal" | `src/renderer/src/components/terminal/terminal-tab-create.ts` | after `state.createTab(...)` |
| Split group | `src/renderer/src/components/tab-group/useTabGroupCreationCommands.ts` (`createSplitGroup`) | after `createTab(worktreeId, newGroupId)` |
| "+" shell row (local branch) | `src/renderer/src/components/tab-group/useTabGroupCreationCommands.ts` (`newTerminalWithShell`) | after `createTab(worktreeId, groupId, shellOverride)` |

All use `markUserInitiatedTerminalCreate(<local tabId>)`, the same ledger and transport path as the
titlebar "+". Passive mounts and mirror attaches never call an entry, so they cannot mark.

## Ledger sweep

`web-session-user-initiated-create.ts`:
- `markUserInitiatedTerminalCreate` sweeps every entry older than the 2-minute TTL before writing.
- `peek` expires the queried entry (existing behavior).
- `discardUserInitiatedTerminalCreate` removes a mark on create failure/abort.

## Focus intent guard

`remote-runtime-pty-transport.ts` samples `resolveWebSessionVisibleTabId` once at `connect()`
entry (before the `terminal.create` round-trip) when `userInitiated` is true and passes it as
`recordWebSessionFocusIntent`'s `expectedCurrentLocalTabId`. If the user switches away while the
create is in flight, the snapshot reconcile sees a mismatch and does not pull focus back.

Failure points that drop the mark: `!created`, destroyed/epoch-changed after create, and the
connect catch.

## Pins

- `src/renderer/src/runtime/web-session-user-initiated-create.test.ts` — mark/peek/consume, TTL
  sweep on next mark, failure discard.
- `src/renderer/src/components/terminal/user-initiated-terminal-create-entries.test.ts` — one pin
  per entry (file tree, split, "+" shell) plus passive-mount negative control
  (`buildPaneTransportOptions` omits `userInitiated` for an unmarked tab).
- `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-u154-user-create-wiring.test.ts`
  — click → mark → `buildPaneTransportOptions` (reads the ledger, no injected flag) → transport →
  non-`materializeOnly` `session.tabs.activate` with `intent: 'user'` → intent records
  `expectedCurrentLocalTabId` → mark consumed.
- Existing U153 host-selection pin still passes.

## Results

- 4 files / 10 tests passed: `tests.log`.
- `pnpm tc` exit 0: `typecheck.log`.
- Discrimination (temporary removal, restored after each run):
  - file-tree mark removed → "marks a terminal created from the file tree" failed.
  - split mark removed → "marks the terminal seeded by a split-group command" failed.
  - shell mark removed → "marks a local-shell terminal from the '+' menu" failed.
  - store-action mark removed → wiring pin failed.
