// Process, port, and HTTP helpers shared by the local environment reseed scripts.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const exists = (file) => fs.existsSync(file)

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim()
}

export const tryRun = (command, args) => {
  try {
    return run(command, args)
  } catch {
    return null
  }
}

export async function writeFile(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode })
  fs.chmodSync(file, mode)
}

export async function ensureSource(file, source) {
  if (!exists(file) || fs.readFileSync(file, 'utf8') !== source) {
    await writeFile(file, source)
  }
}

export const readPid = (file) => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export const isAlive = (pid) => {
  if (!pid) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function killTree(pid) {
  if (!isAlive(pid)) {
    return
  }
  const signal = (sig) => {
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, sig)
      } else {
        process.kill(pid, sig)
      }
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 20 && isAlive(pid); i += 1) {
    await sleep(100)
  }
  if (isAlive(pid)) {
    signal('SIGKILL')
  }
}

/** Every listener on `port` with its bind address, so loopback and wildcard stay distinct. */
export function listeners(port) {
  const text = tryRun('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'])
  const found = []
  let current = null
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('p')) {
      current = { pid: Number(line.slice(1)), address: '' }
      found.push(current)
    } else if (line.startsWith('n') && current) {
      current.address = line.slice(1)
    }
  }
  return found.filter((listener) => Number.isInteger(listener.pid) && listener.pid > 0)
}

export const isLoopback = (address) =>
  address.startsWith('127.0.0.1:') || address.startsWith('[::1]:')

export async function waitPortsFree(port, loopbackOnly) {
  for (let i = 0; i < 50; i += 1) {
    const busy = listeners(port).some((listener) => !loopbackOnly || isLoopback(listener.address))
    if (!busy) {
      return
    }
    await sleep(200)
  }
}

export function spawnDetached({ command, args, env, logFile, pidFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  child.unref()
  fs.writeFileSync(pidFile, String(child.pid))
  return child.pid
}

export function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export async function waitFor(label, probe, timeoutMs, intervalMs = 500) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe()
      if (value) {
        return value
      }
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${last ? `: ${last.message}` : ''}`)
}

export function httpsJson(
  url,
  { method = 'GET', headers = {}, body, ca, rejectUnauthorized = true } = {}
) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers
        },
        ...(ca ? { ca: fs.readFileSync(ca) } : {}),
        rejectUnauthorized,
        timeout: 15000
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode ?? 0, json, text: text.slice(0, 400) })
        })
      }
    )
    request.on('timeout', () => request.destroy(new Error(`timeout ${url}`)))
    request.on('error', reject)
    if (body !== undefined) {
      request.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    request.end()
  })
}
