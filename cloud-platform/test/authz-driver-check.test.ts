import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCheckShape,
  summarizeChecks
} from '../scripts/exploratory-r2/authz-driver-check.mjs'

test('U195: accepts a flat list of {name, ok} checks', () => {
  assert.doesNotThrow(() =>
    assertCheckShape('H2', [
      { name: 'a', ok: true },
      { name: 'b', ok: false }
    ])
  )
})

test('U195: a nested array is rejected instead of being counted as a failure', () => {
  assert.throws(
    () => assertCheckShape('H2', [[{ name: 'a', ok: true }]]),
    /nested array/
  )
})

test('U195: malformed entries are rejected', () => {
  assert.throws(() => assertCheckShape('H2', [{ ok: true }]), /string name/)
  assert.throws(() => assertCheckShape('H2', [{ name: 'a', ok: 'yes' }]), /boolean ok/)
  assert.throws(() => assertCheckShape('H2', null), /must be an array/)
})

test('U195: failure count comes from leaf checks only', () => {
  const { failed, ok } = summarizeChecks('H2', [
    { name: 'a', ok: true },
    { name: 'b', ok: false }
  ])
  assert.equal(ok, false)
  assert.deepEqual(
    failed.map((check) => check.name),
    ['b']
  )
})
