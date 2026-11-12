import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalJson,
  generateSigningKey,
  signCredential,
  verifyCredential,
  type CredentialPayload
} from '../packages/contract/src/credential.ts'
// The Orca main-process twin (dependency-free by design so it can be imported here).
import {
  canonicalCloudJson,
  verifyCloudCredential
} from '../../src/main/cloud-platform/cloud-credential.ts'

/**
 * The platform signs, the host verifies. Those are two implementations that must
 * agree byte for byte — this test is the contract between them.
 */

const key = generateSigningKey('kid-parity')
const keys = new Map([[key.kid, key.publicKeyPem]])

function payload(overrides: Partial<CredentialPayload> = {}): CredentialPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    v: 1,
    jti: 'jti-parity',
    sub: 'user:zhangsan',
    aud: 'host:dev-001',
    host: 'host_dev001',
    project: 'proj_payment',
    projectRoot: '/srv/work/payment-service',
    workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
    deviceId: 'dev_client',
    devicePubKey: 'device-public-key',
    deviceToken: 'device-token',
    perms: ['open', 'terminal', 'file:read'],
    iat: now,
    exp: now + 60,
    ...overrides
  }
}

function verdictOf(token: string, nowSeconds: number): string {
  const platform = verifyCredential(token, keys, nowSeconds)
  const host = verifyCloudCredential(token, keys, nowSeconds)
  assert.equal(platform.ok, host.ok, 'both verifiers must agree on acceptance')
  if (platform.ok && host.ok) {
    assert.deepEqual(host.payload, platform.payload)
    return `ok:${platform.kid}`
  }
  assert.equal(!platform.ok ? platform.reason : null, !host.ok ? host.reason : null)
  return `reject:${!platform.ok ? platform.reason : 'none'}`
}

describe('平台与主机凭证实现一致性', () => {
  test('规范化 JSON 输出完全一致', () => {
    const sample = { z: 1, a: [3, { y: 2, b: 1 }], m: null, s: 'x' }
    assert.equal(canonicalCloudJson(sample), canonicalJson(sample))
  })

  test('合法凭证双方都接受', () => {
    const token = signCredential(payload(), key)
    assert.equal(verdictOf(token, Math.floor(Date.now() / 1000)), 'ok:kid-parity')
  })

  test('过期凭证双方都以 expired 拒绝', () => {
    const token = signCredential(payload(), key)
    assert.equal(verdictOf(token, Math.floor(Date.now() / 1000) + 3600), 'reject:expired')
  })

  test('签名被篡改双方都以 bad_signature 拒绝', () => {
    const [header, body, signature] = signCredential(payload(), key).split('.')
    const tampered = `${header}.${Buffer.from(
      canonicalJson(payload({ perms: ['open', 'download'] }))
    ).toString('base64url')}.${signature}`
    assert.equal(verdictOf(tampered, Math.floor(Date.now() / 1000)), 'reject:bad_signature')
  })

  test('未知 kid 双方都以 unknown_kid 拒绝', () => {
    const other = generateSigningKey('kid-other')
    const token = signCredential(payload(), other)
    assert.equal(verdictOf(token, Math.floor(Date.now() / 1000)), 'reject:unknown_kid')
  })

  test('结构损坏双方都以 malformed 拒绝', () => {
    assert.equal(verdictOf('not-a-token', Math.floor(Date.now() / 1000)), 'reject:malformed')
    assert.equal(verdictOf('a.b', Math.floor(Date.now() / 1000)), 'reject:malformed')
  })

  test('未来签发（时钟偏差外）双方都以 not_yet_valid 拒绝', () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    const token = signCredential(payload({ iat: future, exp: future + 60 }), key)
    assert.equal(verdictOf(token, Math.floor(Date.now() / 1000)), 'reject:not_yet_valid')
  })
})
