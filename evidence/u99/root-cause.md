# U99: session.tabs.move RPC_TIMEOUT (headless cloud)

## Root cause

`checkCloudSessionTabsScope` (src/main/cloud-platform/cloud-session-tabs-scope.ts)
verified tab-scope methods (`session.tabs.activate/close/move`) by extracting the
runtime method and calling it detached:

    const list = args.runtime.listMobileSessionTabs
    await list(selector)          // `this` === undefined

`listMobileSessionTabs` is a prototype method on OrcaRuntimeService
(orca-runtime-collect-mobile-visible-graph-changed-worktrees.ts:49) and reads
`this`, so the call threw `TypeError: Cannot read properties of undefined
(reading 'getValidatedExplicitWorktreeIdSelector')` before the RPC handler ran.
The websocket path starts the dispatch with `void trackClientRequest(...)` and no
catch, so the rejection never produced a reply and the client saw RPC_TIMEOUT.
`session.tabs.list` was unaffected (worktree scope returns before the list).

The unit test used an arrow-function fake runtime, so it did not lose `this`.

## Fix

Call through the runtime object (`args.runtime.listMobileSessionTabs(selector)`),
and add a class/prototype-shaped regression test.

## Evidence

- repro-before-fix-a5.json: pre-fix A-5 harness, `session.tabs.move.second` = RPC_TIMEOUT.
- probe-result.json: post-fix headless cloud probe. split -> two groups,
  move-to-group index 0 -> lands, reorder -> requested order, reconnect ->
  group membership/order identical; all moves `{moved:true}`, no RPC_TIMEOUT.
  (Worktree path and random ids differ per run.)
- probe test: u99-move-probe.test.ts (run from src/main/cloud-platform as a copy).
