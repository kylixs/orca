#!/usr/bin/env node
// System resource monitor for long test runs (node/electron process count, RSS, load).
// Usage: node monitor-system-resources.mjs [--interval=5] [--out=dir] [--max-node=24] [--max-rss-gb=12]
//        node monitor-system-resources.mjs -- <command...>
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const GIB = 1024 * 1024

export function parseProcessTable(output) {
  const rows = []
  for (const line of output.split('\n').slice(1)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), rssKb: Number(match[2]), command: match[3] })
  }
  return rows
}

export function summarize(rows, loadAvg, cpuCount) {
  const nodeRows = rows.filter((row) => /(^|\/)(node|Electron|electron)( |$)/.test(row.command))
  const rssGb = rows.reduce((sum, row) => sum + row.rssKb, 0) / GIB
  return {
    processCount: rows.length,
    nodeProcessCount: nodeRows.length,
    rssGb: Math.round(rssGb * 100) / 100,
    loadAvg,
    cpuCount,
    topRss: rows
      .slice()
      .sort((a, b) => b.rssKb - a.rssKb)
      .slice(0, 5)
      .map((row) => ({
        pid: row.pid,
        rssMb: Math.round(row.rssKb / 1024),
        command: row.command.slice(0, 80)
      }))
  }
}

export function sampleSystem() {
  const ps = spawnSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
  const rows = parseProcessTable(`pid rss command\n${ps.stdout ?? ''}`)
  // Why: process.loadavg does not exist; os.loadavg is the supported API.
  const loadAvg = os.loadavg()
  return summarize(rows, loadAvg, os.cpus().length)
}

export function violations(sampleValue, limits) {
  const found = []
  if (limits.maxNode && sampleValue.nodeProcessCount > limits.maxNode) {
    found.push(`node/electron processes ${sampleValue.nodeProcessCount} > ${limits.maxNode}`)
  }
  if (limits.maxRssGb && sampleValue.rssGb > limits.maxRssGb) {
    found.push(`total rss ${sampleValue.rssGb}GB > ${limits.maxRssGb}GB`)
  }
  const load1 = sampleValue.loadAvg?.[0] ?? 0
  if (limits.maxLoad && load1 > limits.maxLoad) found.push(`load1 ${load1} > ${limits.maxLoad}`)
  return found
}

export function sanitizeLimits(limits, warn = console.warn) {
  const value = (candidate, fallback, label) => {
    if (candidate === undefined) return fallback
    if (Number.isFinite(candidate)) return candidate
    warn(`[resource-watch] ignored invalid ${label}=${candidate}; using ${fallback}`)
    return fallback
  }
  return {
    maxNode: value(limits?.maxNode, 24, 'maxNode'),
    maxRssGb: value(limits?.maxRssGb, 12, 'maxRssGb'),
    maxLoad: value(limits?.maxLoad, 0, 'maxLoad')
  }
}

export function startMonitor({ intervalSec, outDir, limits }) {
  mkdirSync(outDir, { recursive: true })
  const safeInterval = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 5
  const safeLimits = sanitizeLimits(limits)
  const jsonl = join(outDir, 'system-resources.jsonl')
  const samples = []
  const timer = setInterval(() => {
    const value = { at: new Date().toISOString(), ...sampleSystem() }
    samples.push(value)
    appendFileSync(jsonl, `${JSON.stringify(value)}\n`)
    const bad = violations(value, safeLimits)
    for (const message of bad) console.warn(`[resource-watch] ${message}`)
  }, safeInterval * 1000)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      const peak = samples.reduce(
        (acc, cur) => ({
          nodeProcessCount: Math.max(acc.nodeProcessCount, cur.nodeProcessCount),
          rssGb: Math.max(acc.rssGb, cur.rssGb)
        }),
        { nodeProcessCount: 0, rssGb: 0 }
      )
      const summary = { samples: samples.length, peak, jsonl }
      writeFileSync(
        join(outDir, 'system-resources-summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`
      )
      console.log(`[resource-watch] samples=${summary.samples} peak=${JSON.stringify(peak)}`)
      return summary
    }
  }
}

export function parseArgs(argv, warn = console.warn) {
  const options = {
    intervalSec: 5,
    outDir: 'cloud-platform/evidence/resource-monitor',
    maxNode: undefined,
    maxRssGb: undefined,
    maxLoad: undefined,
    command: []
  }
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options.command = argv.slice(index + 1)
      break
    }
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
  const limits = sanitizeLimits(options, warn)
  return { ...options, ...limits }
}

export async function runWithMonitor(options) {
  const outDir = resolve(options.outDir)
  const monitor = startMonitor({
    intervalSec: options.intervalSec,
    outDir,
    limits: { maxNode: options.maxNode, maxRssGb: options.maxRssGb, maxLoad: options.maxLoad }
  })
  const [cmd, ...args] = options.command
  let code = 1
  try {
    code = await new Promise((done) => {
      const child = spawn(cmd, args, { stdio: 'inherit' })
      child.on('error', (error) => {
        console.error(`[resource-watch] failed to spawn ${cmd}: ${error.message}`)
        done(1)
      })
      child.on('exit', (exitCode) => done(exitCode ?? 1))
    })
  } finally {
    monitor.stop()
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2))
  if (options.command.length === 0) {
    console.error(
      'usage: monitor-system-resources.mjs [--interval=5] [--out=dir] [--max-node=24] [--max-rss-gb=12] -- <command...>'
    )
    process.exit(2)
  }
  runWithMonitor(options).then((code) => process.exit(code))
}
