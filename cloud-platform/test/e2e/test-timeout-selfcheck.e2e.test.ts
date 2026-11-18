import { test } from 'node:test'
import {
  assertLegacyTimeoutIgnored,
  assertTimeoutEnforced,
  ENFORCED_TIMEOUT_FIXTURE,
  LEGACY_TIMEOUT_FIXTURE,
  runNodeTestFixture
} from '../helpers/timeout-selfcheck.ts'

/**
 * U290: gate e2e suites must use `test(name, { timeout }, fn)`. The legacy
 * third-argument form is silently ignored, so a hung test waits forever.
 */
test('U290: { timeout: 10 } turns a hung test red', () => {
  assertTimeoutEnforced(
    runNodeTestFixture('enforced.test.mjs', ENFORCED_TIMEOUT_FIXTURE, { tapReporter: true })
  )
})

test('U290: legacy third-argument options are ignored', () => {
  assertLegacyTimeoutIgnored(
    runNodeTestFixture('ignored.test.mjs', LEGACY_TIMEOUT_FIXTURE, { tapReporter: true })
  )
})
