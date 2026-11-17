#!/usr/bin/env node
// Standalone resource sampler: a child process keeps sampling while the tier runner blocks in spawnSync.
// Usage: node resource-sampler.mjs --interval=5 --out=dir [--max-node=24] [--max-rss-gb=12] [--max-load=0]
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sampleSystem, sanitizeLimits, violations } from './monitor-system-resources.mjs'

export function startSampler({
  intervalSec,
  outDir,
  limits = {},
  sampleFn = sampleSystem,
  timers = { setInterval, clearInterval },
  signals = process,
  append = appendFileSync,
  write = writeFileSync,
  log = console.log,
  exit = process.exit
} = {}) {
  if (!outDir) throw new Error('outDir is required')
  mkdirSync(outDir, { recursive: true })
  const safeInterval = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 5
  const safeLimits = sanitizeLimits(limits, log)
  const jsonl = join(outDir, 'system-resources.jsonl')
  const samples = []
  let stopped = false
  let summary = null

  const tick = () => {
    const value = { at: new Date().toISOString(), ...sampleFn() }
    samples.push(value)
    append(jsonl, `${JSON.stringify(value)}\n`)
    for (const message of violations(value, safeLimits)) log(`[resource-watch] ${message}`)
  }

  const timer = timers.setInterval(tick, safeInterval * 1000)

  const onSignal = () => {
    stop()
    exit(0)
  }

  const stop = () => {
    if (stopped) return summary
    stopped = true
    timers.clearInterval(timer)
    signals?.off?.('SIGTERM', onSignal)
    signals?.off?.('SIGINT', onSignal)
    const peak = samples.reduce(
      (acc, cur) => ({
        nodeProcessCount: Math.max(acc.nodeProcessCount, cur.nodeProcessCount),
        rssGb: Math.max(acc.rssGb, cur.rssGb)
      }),
      { nodeProcessCount: 0, rssGb: 0 }
    )
    summary = { samples: samples.length, peak, jsonl }
    write(join(outDir, 'system-resources-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    log(`[resource-watch] samples=${summary.samples} peak=${JSON.stringify(peak)}`)
    return summary
  }

  signals?.on?.('SIGTERM', onSignal)
  signals?.on?.('SIGINT', onSignal)

  return { tick, stop }
}

// Runner side: async child so the sampler keeps ticking while the runner's spawnSync blocks.
export function startSamplerProcess({
  intervalSec,
  outDir,
  limits = {},
  nodePath = process.execPath,
  scriptPath = join(import.meta.dirname, 'resource-sampler.mjs'),
  spawnFn = spawn,
  log = console.log,
  timeoutMs = 10000
} = {}) {
  const args = [scriptPath, `--interval=${intervalSec ?? 5}`, `--out=${outDir}`]
  if (limits.maxNode !== undefined) args.push(`--max-node=${limits.maxNode}`)
  if (limits.maxRssGb !== undefined) args.push(`--max-rss-gb=${limits.maxRssGb}`)
  if (limits.maxLoad !== undefined) args.push(`--max-load=${limits.maxLoad}`)

  const child = spawnFn(nodePath, args, { stdio: 'ignore' })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.on('error', (error) => log(`[resource-watch] sampler failed: ${error.message}`))

  const stop = () =>
    new Promise((done) => {
      if (exited) return done()
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        done()
      }
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, timeoutMs)
      killTimer.unref?.()
      child.once('exit', finish)
      child.once('close', finish)
      child.kill('SIGTERM')
    })

  return { child, stop }
}

export function parseSamplerArgs(argv, warn = console.warn) {
  const options = {
    intervalSec: 5,
    outDir: null,
    maxNode: undefined,
    maxRssGb: undefined,
    maxLoad: undefined
  }
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/)
    if (!match) continue
    const [, key, value] = match
    if (key === 'interval') options.intervalSec = Number(value)
    else if (key === 'out') options.outDir = value
    else if (key === 'max-node') options.maxNode = Number(value)
    else if (key === 'max-rss-gb') options.maxRssGb = Number(value)
    else if (key === 'max-load') options.maxLoad = Number(value)
  }
  options.intervalSec =
    Number.isFinite(options.intervalSec) && options.intervalSec > 0 ? options.intervalSec : 5
  return { ...options, ...sanitizeLimits(options, warn) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseSamplerArgs(process.argv.slice(2))
  if (!options.outDir) {
    console.error(
      'usage: resource-sampler.mjs --out=dir [--interval=5] [--max-node=24] [--max-rss-gb=12] [--max-load=0]'
    )
    process.exit(2)
  }
  startSampler(options)
}
