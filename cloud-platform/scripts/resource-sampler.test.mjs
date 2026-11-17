import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSamplerArgs, startSampler, startSamplerProcess } from './resource-sampler.mjs'

function fakeTimers() {
  let callback = null
  return {
    setInterval(fn) {
      callback = fn
      return 1
    },
    clearInterval() {
      callback = null
    },
    tick() {
      assert.ok(callback, 'timer must be armed')
      callback()
    },
    get armed() {
      return callback !== null
    }
  }
}

function fakeSignals() {
  const handlers = new Map()
  return {
    on(event, handler) {
      handlers.set(event, handler)
    },
    off(event) {
      handlers.delete(event)
    },
    emit(event) {
      handlers.get(event)?.()
    },
    has(event) {
      return handlers.has(event)
    }
  }
}

const samples = [
  { nodeProcessCount: 3, rssGb: 1.5, loadAvg: [0.4], cpuCount: 8, processCount: 10, topRss: [] },
  { nodeProcessCount: 7, rssGb: 2.5, loadAvg: [0.9], cpuCount: 8, processCount: 12, topRss: [] },
  { nodeProcessCount: 5, rssGb: 2.0, loadAvg: [0.2], cpuCount: 8, processCount: 11, topRss: [] }
]

test('sampler writes one JSONL row per tick and a peak summary', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'resource-sampler-'))
  const timers = fakeTimers()
  let index = 0
  const sampler = startSampler({
    intervalSec: 5,
    outDir,
    limits: { maxNode: 24, maxRssGb: 12, maxLoad: 0 },
    sampleFn: () => samples[index++],
    timers,
    signals: null,
    log: () => {}
  })
  timers.tick()
  timers.tick()
  timers.tick()
  const summary = sampler.stop()

  const lines = readFileSync(join(outDir, 'system-resources.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].nodeProcessCount, 3)
  assert.deepEqual(summary.peak, { nodeProcessCount: 7, rssGb: 2.5 })
  assert.equal(summary.samples, 3)

  const written = JSON.parse(readFileSync(join(outDir, 'system-resources-summary.json'), 'utf8'))
  assert.deepEqual(written.peak, { nodeProcessCount: 7, rssGb: 2.5 })
  assert.equal(written.samples, 3)
  assert.equal(timers.armed, false, 'stop must clear the interval')
})

test('sampler writes the summary and exits on SIGTERM', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'resource-sampler-signal-'))
  const timers = fakeTimers()
  const signals = fakeSignals()
  let exitCode = null
  startSampler({
    intervalSec: 5,
    outDir,
    limits: {},
    sampleFn: () => samples[0],
    timers,
    signals,
    exit: (code) => (exitCode = code),
    log: () => {}
  })
  timers.tick()
  signals.emit('SIGTERM')

  assert.equal(exitCode, 0)
  assert.equal(signals.has('SIGTERM'), false, 'signal handler must be detached')
  const summary = JSON.parse(readFileSync(join(outDir, 'system-resources-summary.json'), 'utf8'))
  assert.equal(summary.samples, 1)
  assert.deepEqual(summary.peak, { nodeProcessCount: 3, rssGb: 1.5 })
  assert.equal(timers.armed, false)
})

test('sampler stop is idempotent and safe after a signal', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'resource-sampler-idempotent-'))
  const timers = fakeTimers()
  const signals = fakeSignals()
  const sampler = startSampler({
    intervalSec: 5,
    outDir,
    limits: {},
    sampleFn: () => samples[0],
    timers,
    signals,
    exit: () => {},
    log: () => {}
  })
  signals.emit('SIGTERM')
  const summary = sampler.stop()
  assert.equal(summary.samples, 0)
  assert.equal(existsSync(join(outDir, 'system-resources-summary.json')), true)
})

test('parseSamplerArgs requires an output dir and sanitizes limits', () => {
  const warnings = []
  const options = parseSamplerArgs(
    ['--interval=2', '--out=/tmp/x', '--max-node=abc', '--max-rss-gb=8'],
    (message) => warnings.push(message)
  )
  assert.equal(options.intervalSec, 2)
  assert.equal(options.outDir, '/tmp/x')
  assert.equal(options.maxNode, 24)
  assert.equal(options.maxRssGb, 8)
  assert.equal(warnings.length, 1)
})

test('startSamplerProcess spawns the sampler script and stops it with SIGTERM', async () => {
  const events = []
  class FakeChild extends EventEmitter {
    kill(signal) {
      events.push(`kill:${signal}`)
      this.emit('exit', 0)
      return true
    }
  }
  const child = new FakeChild()
  const spawned = []
  const sampler = startSamplerProcess({
    intervalSec: 5,
    outDir: '/tmp/out',
    limits: { maxNode: 24, maxRssGb: 12, maxLoad: 0 },
    nodePath: '/usr/bin/node',
    spawnFn: (cmd, args, options) => {
      spawned.push({ cmd, args, options })
      return child
    },
    log: () => {}
  })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cmd, '/usr/bin/node')
  assert.ok(spawned[0].args[0].endsWith('resource-sampler.mjs'))
  assert.ok(spawned[0].args.includes('--out=/tmp/out'))
  await sampler.stop()
  assert.deepEqual(events, ['kill:SIGTERM'])
})
