import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DEFAULT_AUDIT_EXPORT_ROOT } from '../../apps/api/src/audit-export-jobs.ts'
import { spawnService, type Service } from './harness.ts'

/**
 * U201 E9b: spawned services must never share the developer's real
 * `~/.orca-cloud/audit-exports`, or an e2e sweep could delete real export jobs.
 */

const READY = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const TOKEN = 'audit-export-isolation-token'

async function startApi(env: Record<string, string>): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: TOKEN, ...env },
    READY,
    'api-audit-export-isolation'
  )
}

test('spawnService 默认注入独立的临时审计导出目录', async () => {
  const api = await startApi({})
  const dir = api.env.ORCA_AUDIT_EXPORT_DIR
  try {
    assert.ok(dir, 'spawned service must receive ORCA_AUDIT_EXPORT_DIR')
    assert.equal(existsSync(dir), true, 'injected dir must exist')
    assert.notEqual(resolve(dir), resolve(DEFAULT_AUDIT_EXPORT_ROOT))
    assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + sep), true)
  } finally {
    await api.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test('调用方显式提供的 ORCA_AUDIT_EXPORT_DIR 优先', async () => {
  const explicit = mkdtempSync(join(tmpdir(), 'orca-audit-export-explicit-'))
  const api = await startApi({ ORCA_AUDIT_EXPORT_DIR: explicit })
  try {
    assert.equal(api.env.ORCA_AUDIT_EXPORT_DIR, explicit)
  } finally {
    await api.stop()
    rmSync(explicit, { recursive: true, force: true })
  }
})
