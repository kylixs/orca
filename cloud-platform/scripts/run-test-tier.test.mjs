import assert from 'node:assert/strict'
import test from 'node:test'
import { CRITICAL_CLOUD_E2E, CRITICAL_VITEST, changedTargets } from './run-test-tier.mjs'

test('maps renderer runtime changes to their suite', () => {
  const targets = changedTargets(['src/renderer/src/runtime/web-session-tabs-sync/layout-groups.ts'])
  assert.deepEqual(targets.vitest, ['src/renderer/src/runtime'])
  assert.deepEqual(targets.cloudE2E, [])
})

test('maps platform api changes to the cloud e2e tree', () => {
  const targets = changedTargets(['cloud-platform/apps/api/src/server.ts'])
  assert.deepEqual(targets.vitest, [])
  assert.deepEqual(targets.cloudE2E, ['cloud-platform/test/e2e'])
})

test('ignores unrelated files', () => {
  const targets = changedTargets(['README.md', 'cloud-platform/PROGRESS.md'])
  assert.deepEqual(targets, { vitest: [], cloudE2E: [] })
})

test('critical tier stays small and user-facing', () => {
  assert.ok(CRITICAL_VITEST.length <= 6)
  assert.ok(CRITICAL_CLOUD_E2E.length <= 10)
  assert.ok(CRITICAL_VITEST.some((path) => path.includes('web-session-tabs-sync')))
})
