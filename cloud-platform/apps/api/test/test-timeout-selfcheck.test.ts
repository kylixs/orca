import { test } from 'node:test'
import {
  assertLegacyTimeoutIgnored,
  assertTimeoutEnforced,
  ENFORCED_TIMEOUT_FIXTURE,
  LEGACY_TIMEOUT_FIXTURE,
  runNodeTestFixture
} from '../../../test/helpers/timeout-selfcheck.ts'

test('timeout option is enforced: sleep(50) with timeout: 10 fails', () => {
  assertTimeoutEnforced(runNodeTestFixture('enforced.test.mjs', ENFORCED_TIMEOUT_FIXTURE))
})

test('legacy third-argument options are ignored: sleep(50) with { timeout: 10 } as third arg passes', () => {
  assertLegacyTimeoutIgnored(runNodeTestFixture('ignored.test.mjs', LEGACY_TIMEOUT_FIXTURE))
})
