import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { CLOUD_AUDIT_METHODS, validateFileEventMetadata } from './cloud-audit'
import type { RpcContext } from '../core'
import type { CloudFileEventReport } from '../../../cloud-platform/cloud-file-event-audit'

/** §2.10.2: the host RPC mirrors the platform's field whitelist so bad data is
 * refused before it travels, and non-cloud sessions get the typed refusal. */

const method = CLOUD_AUDIT_METHODS[0]

function parse(params: unknown): ReturnType<typeof method.params.parse> {
  return method.params.parse(params)
}

function ctxWith(
  submit?: (report: CloudFileEventReport) => unknown
): RpcContext & { cloudFileEvent?: (report: CloudFileEventReport) => unknown } {
  return {
    runtime: {} as RpcContext['runtime'],
    ...(submit
      ? {
          cloud: {
            projectId: 'proj-1',
            projectRoot: '/r',
            workspaceRoot: '/w',
            repoUrl: '',
            defaultBranch: 'main',
            perms: ['open'] as const
          },
          cloudFileEvent: submit as RpcContext['cloudFileEvent']
        }
      : {})
  }
}

describe('audit.recordFileEvent 宿主 RPC（U66 §2.10）', () => {
  it('schema 拒绝未知顶层字段与非法枚举；download_blocked 必须 denied', () => {
    expect(() => parse({ eventType: 'file_copy', result: 'success', extra: 1 })).toThrow(ZodError)
    expect(() => parse({ eventType: 'files.list', result: 'success' })).toThrow(ZodError)
    // The cross-field rule lives in the handler, ahead of the session check.
    expect(() =>
      method.handler(parse({ eventType: 'download_blocked', result: 'success' }), ctxWith())
    ).toThrow(/download_blocked requires result denied/)
  })

  it('metadata 白名单：未知字段抛 InvalidArgumentError，路径拒绝绝对与 ..', () => {
    expect(validateFileEventMetadata({ body: 'leak' })).toMatchObject({
      ok: false,
      field: 'body',
      reason: 'unknown'
    })
    expect(validateFileEventMetadata({ path: '/etc/passwd' })).toMatchObject({
      ok: false,
      field: 'path',
      reason: 'absolute-or-parent-traversal'
    })
    expect(validateFileEventMetadata({ path: 'src/../secret' })).toMatchObject({
      ok: false,
      field: 'path',
      reason: 'absolute-or-parent-traversal'
    })
    expect(validateFileEventMetadata({ deviceId: 'dev', actorSource: 'device' })).toMatchObject({
      ok: false,
      field: 'deviceId',
      reason: 'platform-written'
    })
    expect(validateFileEventMetadata({ sizeBytes: -1 })).toMatchObject({
      ok: false,
      field: 'sizeBytes',
      reason: 'not-a-non-negative-integer'
    })
    const ok = validateFileEventMetadata({
      path: 'src\\a.ts',
      fileName: 'a.ts',
      sizeBytes: 10,
      sha256: 'nothex'
    })
    expect(ok).toEqual({
      ok: true,
      metadata: { path: 'src/a.ts', fileName: 'a.ts', sizeBytes: 10 }
    })
  })

  it('U69 生产形态：sha256+sha256Source:client 白名单通过并保留（字段序无关）', () => {
    // The renderer's copyMetadata output when a fingerprint was computed.
    const production = {
      fileName: 'rules.ts',
      path: 'src/engine/rules.ts',
      copyKind: 'content-whole',
      copiedChars: 1240,
      copiedBytes: 3720,
      surface: 'web',
      capturePoint: 'web-clipboard-api',
      captureConfidence: 'client-declared',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sha256Source: 'client',
      occurredAt: 1_700_000_000_000
    }
    expect(validateFileEventMetadata(production)).toEqual({ ok: true, metadata: production })
    // Source declared before the fingerprint applies too.
    expect(
      validateFileEventMetadata({
        sha256Source: 'host',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
    ).toEqual({
      ok: true,
      metadata: {
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        sha256Source: 'host'
      }
    })
  })

  it('U69 枚举外 sha256Source 拒绝为 invalid_argument；孤源与坏指纹一起丢弃', () => {
    expect(validateFileEventMetadata({ sha256Source: 'forged' })).toMatchObject({
      ok: false,
      field: 'sha256Source',
      reason: 'not-allowed'
    })
    expect(validateFileEventMetadata({ sha256Source: 7 })).toMatchObject({
      ok: false,
      field: 'sha256Source',
      reason: 'not-allowed'
    })
    // An orphan source (no valid fingerprint) is noise, not an error.
    const orphan = validateFileEventMetadata({ sha256Source: 'client' })
    expect(orphan).toEqual({ ok: true, metadata: {} })
    const badFingerprint = validateFileEventMetadata({
      sha256: 'nothex',
      sha256Source: 'client'
    })
    expect(badFingerprint).toEqual({ ok: true, metadata: {} })
  })

  it('非云会话返回 queued:false non-cloud-session，不入队', () => {
    const reply = method.handler(parse({ eventType: 'file_copy', result: 'success' }), ctxWith())
    expect(reply).toEqual({ queued: false, reason: 'non-cloud-session' })
  })

  it('云会话经宿主承接入队；excerpt 剥离后返回 excerptDropped', () => {
    const seen: CloudFileEventReport[] = []
    const reply = method.handler(
      parse({
        eventType: 'file_copy',
        result: 'success',
        traceId: 'tr_1',
        metadata: { path: 'src/a.ts', excerpt: 'secret' }
      }),
      ctxWith((report) => {
        seen.push(report)
        return { queued: true }
      })
    )
    expect(reply).toEqual({ queued: true, excerptDropped: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ eventType: 'file_copy', traceId: 'tr_1' })
    expect(JSON.stringify(seen[0])).not.toContain('secret')
  })

  it('坏 metadata 抛出带字段名的 InvalidArgumentError，不触碰队列', () => {
    const seen: CloudFileEventReport[] = []
    expect(() =>
      method.handler(
        parse({ eventType: 'file_copy', result: 'success', metadata: { nope: 1 } }),
        ctxWith((report) => {
          seen.push(report)
          return { queued: true }
        })
      )
    ).toThrow(/nope/)
    expect(seen).toHaveLength(0)
  })
})
