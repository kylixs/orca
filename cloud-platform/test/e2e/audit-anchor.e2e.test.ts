import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorMatchesChain,
  verifyAuditAnchor,
  type AuditAnchor
} from '../../apps/audit-writer/src/anchor.ts'
import { canonicalJson } from '../../packages/contract/src/credential.ts'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M100 (design §13.2, G-04 remainder): the hash chain alone cannot prove the log
 * was not rewritten wholesale — a re-forged chain is self-consistent. The writer
 * now signs the tip every interval with an Ed25519 key kept in its own file; an
 * anchor copy proves the log existed in that shape at that time.
 *
 * Real writer processes, a real API replica producing real audit events, real
 * signatures verified with the public key alone.
 */

const EVIDENCE = 'm100-audit-anchor'
const INTERNAL_TOKEN = 'm100-internal-token'
const ANCHOR_INTERVAL_MS = 600

type AnchorBody = { publicKeyPem: string | null; anchors: AuditAnchor[] }
type AuditLine = { seq: number; hash: string; eventType: string; metadata?: Record<string, unknown> }

let dir = ''
let logPath = ''
let anchorPath = ''
let keyPath = ''
let writer: Service
let api: Service
/** Monotonic across calls: the platform refuses two projects on one host path. */
let produced = 0

function writerEnv(): Record<string, string> {
  return {
    PORT: '0',
    INTERNAL_TOKEN,
    AUDIT_LOG_PATH: logPath,
    AUDIT_ANCHOR_PATH: anchorPath,
    AUDIT_ANCHOR_KEY_PATH: keyPath,
    AUDIT_ANCHOR_INTERVAL_MS: String(ANCHOR_INTERVAL_MS)
  }
}

async function startWriter(): Promise<Service> {
  return spawnService(
    'apps/audit-writer/src/writer.ts',
    writerEnv(),
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer-anchor'
  )
}

/** A replica configured with the writer URL; it must be restarted if that URL moves. */
async function startApi(): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_AUDIT_WRITER_URL: writer.url },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-anchor'
  )
}

async function fetchAnchors(): Promise<AnchorBody> {
  const res = await fetch(`${writer.url}/v1/anchors`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as AnchorBody
}

/** Asks the writer to anchor the current tip now (tests do not wait 5 minutes). */
async function anchorNow(): Promise<AuditAnchor | null> {
  const res = await fetch(`${writer.url}/v1/anchors`, {
    method: 'POST',
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200, await res.clone().text())
  return ((await res.json()) as { anchor: AuditAnchor | null }).anchor
}

function logLines(path = logPath): AuditLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditLine)
}

/** Produces real audit events through a real API replica. */
async function produceEvents(count: number): Promise<void> {
  const admin = await login(api.url, 'admin', 'Adm1n!')
  for (let index = 0; index < count; index += 1) {
    produced += 1
    const res = await fetch(`${api.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({
        key: `m100-${produced}`,
        name: `m100-${produced}`,
        hostId: 'host_dev001',
        path: `/srv/work/m100-${produced}`
      })
    })
    if (res.status !== 201) {
      throw new Error(
        `${res.status}: ${await res.clone().text()}\nwriter: ${writer.logs.join('')}\napi: ${api.logs.join('')}`
      )
    }
  }
}

async function waitForAnchors(min: number, timeoutMs = 15_000): Promise<AnchorBody> {
  const started = Date.now()
  let body = await fetchAnchors()
  while (body.anchors.length < min && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    body = await fetchAnchors()
  }
  assert.ok(body.anchors.length >= min, `expected ${min} anchors, got ${body.anchors.length}`)
  return body
}

type AuditLine = { seq: number; ts?: number; hash: string; prevHash?: string; eventType: string; metadata?: Record<string, unknown>; [key: string]: unknown }

/**
 * Re-forges the whole chain after changing one event, the way an attacker with
 * file access would: every `prevHash`/`hash` recomputed so a plain chain check
 * still passes. The original anchors are the only surviving witness.
 */
function reforge(lines: AuditLine[], tamperSeq: number): AuditLine[] {
  let prev = 'GENESIS'
  return lines.map((line) => {
    const tampered =
      line.seq === tamperSeq
        ? { ...line, metadata: { ...(line.metadata ?? {}), forged: true } }
        : line
    const body = {
      seq: tampered.seq,
      ts: tampered.ts,
      eventType: tampered.eventType,
      actor: tampered.actor,
      targetType: tampered.targetType,
      targetId: tampered.targetId,
      result: tampered.result,
      traceId: tampered.traceId,
      metadata: tampered.metadata ?? {}
    }
    const hash = createHash('sha256').update(`${prev}|${canonicalJson(body)}`).digest('hex')
    const reforged = { ...tampered, prevHash: prev, hash }
    prev = hash
    return reforged
  })
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-m100-'))
  logPath = join(dir, 'audit.log')
  anchorPath = join(dir, 'anchors.jsonl')
  keyPath = join(dir, 'anchor-key.json')
  writer = await startWriter()
  api = await startApi()
}, 120_000)

after(async () => {
  await api?.stop()
  await writer?.stop()
})

test('审计签名锚点：签名可独立验证、与链尾一致、重启后保留、能识破重写', async () => {
  // ---- real events, then automatic anchors on the interval ----
  await produceEvents(3)
  const first = await waitForAnchors(1)
  const publicKeyPem = first.publicKeyPem
  assert.ok(publicKeyPem, 'writer must publish its anchor public key')
  assert.match(publicKeyPem, /BEGIN PUBLIC KEY/)

  await produceEvents(2)
  const grown = await waitForAnchors(2)

  // ---- the interval, not just the manual call, produced them ----
  const automatic = grown.anchors.length
  assert.ok(automatic >= 2)

  // ---- every anchor verifies with the public key alone ----
  for (const anchor of grown.anchors) {
    assert.equal(
      verifyAuditAnchor(publicKeyPem, anchor),
      true,
      `anchor ${anchor.seq} signature must verify`
    )
  }
  // ---- and points at an event that is really in the log ----
  let events = logLines()
  for (const anchor of grown.anchors) {
    assert.equal(anchorMatchesChain(events, anchor), true, `anchor ${anchor.seq} must match the log`)
  }
  const seqs = grown.anchors.map((anchor) => anchor.seq)
  assert.deepEqual(
    [...seqs].sort((a, b) => a - b),
    seqs,
    'anchors must be appended in chain order'
  )
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate anchors for one tip')

  // ---- manual anchor covers everything written so far ----
  const final = await anchorNow()
  assert.ok(final)
  events = logLines()
  assert.equal(final.seq, events.at(-1)?.seq, 'anchor must cover the current tip')
  assert.equal(anchorMatchesChain(events, final), true)
  assert.equal(verifyAuditAnchor(publicKeyPem, final), true)

  // ---- restart: anchors survive and the same key keeps verifying ----
  await api.stop()
  await writer.stop()
  writer = await startWriter()
  // The replica was configured with the old writer URL; bring it back pointed here.
  api = await startApi()
  const afterRestart = await fetchAnchors()
  assert.ok(
    afterRestart.anchors.length >= grown.anchors.length,
    `anchors must survive a restart, had ${grown.anchors.length}, now ${afterRestart.anchors.length}`
  )
  assert.equal(afterRestart.publicKeyPem, publicKeyPem, 'the anchor key must be stable across restarts')
  await produceEvents(1)
  const next = await anchorNow()
  assert.ok(next)
  assert.ok(next.seq > (final.seq ?? 0), 'a later anchor must cover later events')
  assert.equal(verifyAuditAnchor(publicKeyPem, next), true)

  // ---- a rewritten log is caught: the signature is still valid, the chain is not ----
  // Why re-forge instead of editing: an attacker who controls the file would
  // recompute every hash so `verify()` still passes. The anchor is what survives.
  const lines = logLines()
  // Between two real anchors, so both sides of the rewrite are provable.
  const tamperSeq = (grown.anchors[0]?.seq ?? 1) + 1
  assert.ok(lines.some((line) => line.seq === tamperSeq), 'tampered event must exist')
  const reforged = reforge(lines, tamperSeq)
  const beforeTamper = grown.anchors.filter((anchor) => anchor.seq < tamperSeq)
  const afterTamper = grown.anchors.filter((anchor) => anchor.seq > tamperSeq)
  assert.ok(beforeTamper.length > 0 && afterTamper.length > 0, 'need anchors on both sides')
  for (const anchor of beforeTamper) {
    assert.equal(verifyAuditAnchor(publicKeyPem, anchor), true)
    assert.equal(
      anchorMatchesChain(reforged, anchor),
      true,
      'an anchor before the rewrite still matches untouched events'
    )
  }
  const forgedVerdicts = afterTamper.map((anchor) => ({
    seq: anchor.seq,
    signatureValid: verifyAuditAnchor(publicKeyPem, anchor),
    matchesRewrittenChain: anchorMatchesChain(reforged, anchor)
  }))
  for (const verdict of forgedVerdicts) {
    assert.equal(verdict.signatureValid, true, 'the anchor itself is genuine')
    assert.equal(
      verdict.matchesRewrittenChain,
      false,
      `anchor ${verdict.seq} must expose the rewrite`
    )
  }
  writeFileSync(join(dir, 'reforged.log'), `${reforged.map((e) => JSON.stringify(e)).join('\n')}\n`)

  saveEvidence(EVIDENCE, 'audit-anchor.json', {
    anchorIntervalMs: ANCHOR_INTERVAL_MS,
    automaticAnchors: automatic,
    anchorSeqs: seqs,
    publicKeyStable: afterRestart.publicKeyPem === publicKeyPem,
    allSignaturesVerified: true,
    allAnchorsMatchLog: true,
    finalAnchor: { seq: final.seq, at: final.at },
    afterRestartAnchorCount: afterRestart.anchors.length,
    anchorAfterNewEvents: { seq: next.seq },
    rewrittenLog: {
      tamperedSeq: tamperSeq,
      reforgedEveryHash: true,
      anchorsBeforeTamperStillMatch: beforeTamper.map((anchor) => anchor.seq),
      anchorsAfterTamper: forgedVerdicts
    }
  })
}, 120_000)
