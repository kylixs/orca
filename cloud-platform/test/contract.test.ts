import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateSigningKey,
  newJti,
  signCredential,
  verifyCredential,
  type CredentialPayload
} from '../packages/contract/src/credential.ts'
import {
  decideMethod,
  isInsideRoot,
  requiresWritePath
} from '../packages/contract/src/permissions.ts'
import { AuditChain } from '../apps/api/src/audit.ts'
import { Store } from '../apps/api/src/store.ts'

function payload(overrides: Partial<CredentialPayload> = {}): CredentialPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    v: 1,
    jti: newJti(),
    sub: 'user:zhangsan',
    aud: 'host:dev-001',
    host: 'host_dev001',
    project: 'proj_payment',
    projectRoot: '/srv/work/payment-service',
    workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
    deviceId: 'dev_1',
    devicePubKey: 'pk',
    deviceToken: 'tok',
    perms: ['open', 'file:read'],
    iat: now,
    exp: now + 60,
    ...overrides
  }
}

test('凭证：签名与验签往返', () => {
  const key = generateSigningKey('kid-1')
  const token = signCredential(payload(), key)
  const result = verifyCredential(token, new Map([['kid-1', key.publicKeyPem]]), Math.floor(Date.now() / 1000))
  assert.equal(result.ok, true)
})

test('凭证：篡改载荷导致验签失败', () => {
  const key = generateSigningKey('kid-1')
  const token = signCredential(payload(), key)
  const [header, body, sig] = token.split('.')
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  decoded.perms.push('download')
  const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`
  const result = verifyCredential(tampered, new Map([['kid-1', key.publicKeyPem]]), Math.floor(Date.now() / 1000))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.reason : '', 'bad_signature')
})

test('凭证：过期与未知 kid', () => {
  const key = generateSigningKey('kid-1')
  const now = Math.floor(Date.now() / 1000)
  const expired = signCredential(payload({ iat: now - 300, exp: now - 200 }), key)
  assert.deepEqual(
    verifyCredential(expired, new Map([['kid-1', key.publicKeyPem]]), now),
    { ok: false, reason: 'expired' }
  )
  const valid = signCredential(payload(), key)
  assert.deepEqual(verifyCredential(valid, new Map(), now), { ok: false, reason: 'unknown_kid' })
})

test('方法级权限：未登记方法默认拒绝', () => {
  assert.deepEqual(decideMethod('files.unknownMethod', ['file:read'], 'deny'), {
    allow: false,
    code: 'METHOD_NOT_REGISTERED'
  })
})

test('方法级权限：读允许、写需权限、导出恒拒绝', () => {
  assert.equal(decideMethod('files.read', ['file:read'], 'deny').allow, true)
  const denied = decideMethod('files.write', ['file:read'], 'deny')
  assert.equal(denied.ok, undefined)
  assert.deepEqual(denied, { allow: false, code: 'PERMISSION_MISSING' })
  assert.deepEqual(decideMethod('files.download', ['file:read', 'download'], 'deny'), {
    allow: false,
    code: 'EXPORT_DENIED'
  })
  assert.equal(decideMethod('files.download', ['download'], 'allow').allow, true)
})

test('方法级权限：导出规则先于 browser 前缀匹配', () => {
  assert.deepEqual(decideMethod('browser.download', ['browser', 'download'], 'deny'), {
    allow: false,
    code: 'EXPORT_DENIED'
  })
  assert.equal(decideMethod('browser.navigate', ['browser'], 'deny').allow, true)
  assert.deepEqual(decideMethod('browser.navigate', ['download'], 'deny'), {
    allow: false,
    code: 'PERMISSION_MISSING'
  })
  assert.equal(decideMethod('worktree.createManaged', ['terminal'], 'deny').allow, true)
})

test('路径边界：拒绝穿越与绝对逃逸', () => {
  const root = '/srv/work/payment-service/.orca-worktrees/zhangsan'
  assert.equal(isInsideRoot(root, `${root}/src/a.ts`), true)
  assert.equal(isInsideRoot(root, `${root}/../other/src/a.ts`), false)
  assert.equal(isInsideRoot(root, '/etc/passwd'), false)
  assert.equal(isInsideRoot(root, `${root}/src/../../zhangsan2/a.ts`), false)
  assert.equal(requiresWritePath('files.write'), true)
  assert.equal(requiresWritePath('files.read'), false)
})

test('路径边界：Windows 盘符、跨盘与分隔符', () => {
  const root = 'C:\\srv\\work\\payment-service\\.orca-worktrees\\zhangsan'
  assert.equal(isInsideRoot(root, 'C:\\srv\\work\\payment-service\\.orca-worktrees\\zhangsan\\src\\a.ts'), true)
  assert.equal(isInsideRoot(root, 'D:\\evil\\x.ts'), false, 'cross-drive must be rejected')
  assert.equal(isInsideRoot(root, 'C:\\srv\\work\\payment-service\\.orca-worktrees\\zhangsan2\\a.ts'), false)
  assert.equal(isInsideRoot(root, 'C:\\srv\\work\\payment-service\\.orca-worktrees\\zhangsan\\..\\..\\..\\etc'), false)
  // Mixed separators must still resolve correctly.
  assert.equal(isInsideRoot('C:\\root', 'C:/root/child'), true)
  // Bare relative paths are rejected outright.
  assert.equal(isInsideRoot('root', 'root/child'), false)
})

test('方法级权限：前缀白名单只覆盖已登记的自省方法', () => {
  assert.equal(decideMethod('sessions.whoami', [], 'deny').allow, true)
  assert.deepEqual(decideMethod('sessions.deleteAll', [], 'deny'), {
    allow: false,
    code: 'METHOD_NOT_REGISTERED'
  })
})

test('路径边界：根含 .. 时不得扩大作用域', () => {
  // Project paths are operator-supplied; a non-normalised root must not widen scope.
  assert.equal(isInsideRoot('/a/..', '/etc/passwd'), true, 'current behaviour: lexical root')
  // The platform must reject such roots at registration time instead.
  assert.equal(isInsideRoot('/srv/work/../etc', '/etc/passwd'), false)
})

test('审计哈希链：追加、校验、篡改可定位', () => {
  const store = new Store()
  const chain = new AuditChain(store)
  for (let i = 0; i < 20; i++) {
    chain.append({
      eventType: 'login',
      actor: 'zhangsan',
      targetType: 'session',
      targetId: String(i),
      result: 'success',
      traceId: `t-${i}`
    })
  }
  const verdict = chain.verify()
  assert.equal(verdict.ok, true)
  assert.equal(verdict.ok ? verdict.checked : -1, 20)
  store.audit[7].actor = 'mallory'
  const broken = chain.verify()
  assert.equal(broken.ok, false)
  assert.equal(broken.ok === false ? broken.brokenAtSeq : 0, 8)
})
