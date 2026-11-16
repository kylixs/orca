/**
 * U161/D2: the intent-guard deferral must not outlive the focus intent it was armed for.
 * A deferral left behind would turn the next fresh intent's first rejection into a second
 * rejection, cancelling that intent before the host frame could be honoured.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  clearWebSessionFocusIntent,
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent
} from '../web-session-focus-intent'
import { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

const HOST_TAB_ID = 'host-tab-1'

function hostTerminalSnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot([
    {
      type: 'terminal',
      id: `${HOST_TAB_ID}::${LEAF_ID}`,
      title: HOST_TAB_ID,
      parentTabId: HOST_TAB_ID,
      leafId: LEAF_ID,
      isActive: true,
      status: 'ready',
      terminal: 'host-pty'
    }
  ])
}

const scopes = { environmentId: ENV }

function prepare(): void {
  prepareWebSessionTabsSnapshotBase(
    makeState(),
    hostTerminalSnapshot(),
    ENV,
    WT,
    NOW,
    undefined,
    undefined
  )
}

/** The intent expects a different visible tab, so every prepare below rejects it. */
function recordRejectedIntent(): void {
  recordWebSessionFocusIntent(scopes, WT, HOST_TAB_ID, LEAF_ID, 'some-other-local-tab')
}

describe('U161/D2 intent guard deferral cleanup', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('drops a deferral once its intent is cleared, so the next intent gets a first rejection', () => {
    recordRejectedIntent()
    prepare()
    expect(peekWebSessionFocusIntent(scopes, WT), 'first rejection keeps the intent').not.toBeNull()

    // A different path (browser focus guard, tab close, owner switch) clears the intent.
    clearWebSessionFocusIntent(scopes, WT)
    prepare()

    // Same intent identity re-recorded. A leaked deferral would satisfy the second-rejection
    // branch and cancel it; a pruned deferral must leave it armed.
    recordRejectedIntent()
    prepare()
    expect(
      peekWebSessionFocusIntent(scopes, WT),
      'a stale deferral must not cancel a fresh intent'
    ).not.toBeNull()
  })
})
