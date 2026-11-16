/**
 * U138 reusable RPC-frame timeline probe.
 *
 * Defect: after a refresh the Orca Web host's active tab can disagree with what
 * the DOM renders and what the client store holds. This probe drives
 * activate A -> activate B -> refresh x N and samples the three views, keeping a
 * frame-level timeline of every `session.tabs.*` request/response so a later
 * investigation can name the writer that moved the host selection.
 *
 * Wire note: the web client talks E2EE over its WebSocket, so page-level
 * WebSocket frames are ciphertext after `e2ee_hello`. The probe therefore
 * installs BOTH recorders before any page script:
 *   - a WebSocket wrapper for transport/handshake evidence (counts + control
 *     frames only), and
 *   - a `window.api` wrapper that records the same RPCs as plaintext at the
 *     renderer boundary (method, params, response id/result).
 * The plaintext RPC timeline is the authoritative frame list.
 *
 * Isolation: uses a fresh browser context (a new paired device), a dedicated
 * developer project, and restores the host's pre-run active tab at the end with
 * the same device when the run moved it. No process is killed except the
 * browser this script launched.
 *
 * Usage:
 *   node cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs
 *   U138_PROJECT_KEY=zhangsan-demo U138_CYCLES=3 node .../u138-frame-timeline.mjs
 *
 * Output: cloud-platform/evidence/exploratory-r8/u138-timeline.json (gitignored)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EVIDENCE_DIR = path.join(REPO_ROOT, 'cloud-platform/evidence/exploratory-r8')
const OUTPUT_FILE = path.join(EVIDENCE_DIR, 'u138-timeline.json')

const PLATFORM_URL = (process.env.U138_PLATFORM_URL ?? 'https://127.0.0.1:18787').replace(/\/$/, '')
const USERNAME = process.env.U138_USERNAME ?? 'zhangsan'
const PASSWORD = process.env.U138_PASSWORD ?? 'Passw0rd!'
const PROJECT_KEY = process.env.U138_PROJECT_KEY ?? 'zhangsan-demo'
const CYCLES = Math.max(1, Number(process.env.U138_CYCLES ?? 3))
const HEADLESS = process.env.U138_HEADLESS !== '0'
const PAGE_FRAME_LIMIT = Number(process.env.U138_PAGE_FRAME_LIMIT ?? 300)

mkdirSync(EVIDENCE_DIR, { recursive: true })

/* -------------------------------------------------------------------------- */
/* Page-side recorder (runs before any page script)                            */
/* -------------------------------------------------------------------------- */

function installU138Probe(config) {
  if (window.__u138Probe) {
    return
  }

  const MAX_FRAMES = config.frameLimit
  const frames = []
  const transport = {
    openedAt: null,
    closedAt: null,
    plaintextControlFrames: 0,
    encryptedSendFrames: 0,
    encryptedRecvFrames: 0,
    encryptedSendBytes: 0,
    encryptedRecvBytes: 0,
    lastControl: null
  }
  let seq = 0
  let rawCall = null
  let rawSubscribe = null

  const isRelevantMethod = (method) =>
    typeof method === 'string' && method.startsWith('session.tabs.')

  const push = (frame) => {
    frames.push(frame)
    if (frames.length > MAX_FRAMES) {
      frames.splice(0, frames.length - MAX_FRAMES)
    }
  }

  const truncate = (value, limit) => {
    if (typeof value === 'string') {
      return value.length > limit ? `${value.slice(0, limit)}…<${value.length}>` : value
    }
    return value
  }

  const summarizeParams = (params) => {
    if (params === null || typeof params !== 'object') {
      return params === undefined ? null : truncate(params, 400)
    }
    const picked = {}
    for (const key of [
      'worktree',
      'tabId',
      'leafId',
      'reason',
      'publicationEpoch',
      'terminal',
      'notifyClients',
      'navigation',
      'intent',
      'materializeOnly',
      'targetGroupId',
      'afterTabId'
    ]) {
      if (params[key] !== undefined) {
        picked[key] = truncate(params[key], 400)
      }
    }
    const keys = Object.keys(params)
    if (keys.length > 0) {
      picked.__keys = keys
    }
    return picked
  }

  const summarizeTabList = (tabs) =>
    Array.isArray(tabs)
      ? tabs.slice(0, 80).map((tab) => ({
          id: tab.id,
          type: tab.type,
          title: tab.title ?? tab.label ?? null,
          groupId: tab.groupId ?? null,
          active: tab.active ?? null
        }))
      : undefined

  const summarizeSnapshot = (snapshot) => ({
    worktree: snapshot.worktree ?? null,
    activeGroupId: snapshot.activeGroupId ?? null,
    activeTabId: snapshot.activeTabId ?? null,
    activeTabType: snapshot.activeTabType ?? null,
    publicationEpoch: snapshot.publicationEpoch ?? null,
    snapshotVersion: snapshot.snapshotVersion ?? null,
    removed: snapshot.removed === true ? true : undefined,
    navigationIntent: snapshot.navigationIntent ?? undefined,
    tabs: summarizeTabList(snapshot.tabs),
    tabGroups: Array.isArray(snapshot.tabGroups)
      ? snapshot.tabGroups.map((group) => ({
          id: group.id,
          activeTabId: group.activeTabId ?? null,
          tabOrder: Array.isArray(group.tabOrder)
            ? group.tabOrder.slice(0, 40)
            : group.tabOrder ?? null
        }))
      : undefined
  })

  const summarizeResult = (method, result) => {
    if (result === null || typeof result !== 'object') {
      return result === undefined ? null : truncate(result, 400)
    }
    if (method === 'session.tabs.listAll') {
      return {
        worktrees: Array.isArray(result.worktrees) ? result.worktrees.slice(0, 20) : result.worktrees,
        snapshots: Array.isArray(result.snapshots)
          ? result.snapshots.slice(0, 20).map(summarizeSnapshot)
          : undefined
      }
    }
    if (method === 'session.tabs.list') {
      return summarizeSnapshot(result)
    }
    if (method === 'session.tabs.subscribe' || method === 'session.tabs.subscribeAll') {
      if (result.type === 'snapshots' && Array.isArray(result.snapshots)) {
        return {
          type: result.type,
          snapshots: result.snapshots.slice(0, 20).map(summarizeSnapshot)
        }
      }
      if (result.type === 'updated') {
        return { type: result.type, ...summarizeSnapshot(result) }
      }
      return {
        type: result.type ?? null,
        worktree: result.worktree ?? null,
        removed: result.removed === true ? true : undefined
      }
    }
    if (method === 'session.tabs.activate') {
      return summarizeSnapshot(result)
    }
    const picked = {}
    for (const key of [
      'closed',
      'refused',
      'refusalReason',
      'snapshotRepublished',
      'publicationEpoch',
      'snapshotVersion',
      'tab',
      'removed',
      'activeTabId',
      'activeTabType'
    ]) {
      if (result[key] !== undefined) {
        picked[key] = result[key]
      }
    }
    if (result.tab && typeof result.tab === 'object') {
      picked.tab = { id: result.tab.id, type: result.tab.type, title: result.tab.title ?? null }
    }
    return Object.keys(picked).length > 0 ? picked : { __keys: Object.keys(result).slice(0, 20) }
  }

  const recordCall = async (req, source) => {
    const method = req?.method
    const callId = `u138-${source}-${++seq}`
    const sendAt = performance.now()
    const sendFrame = {
      layer: 'rpc',
      dir: 'send',
      id: callId,
      callId,
      method,
      params: summarizeParams(req?.params),
      subscription: false,
      source,
      t: sendAt,
      wall: Date.now()
    }
    push(sendFrame)
    try {
      const response = await rawCall(req)
      push({
        layer: 'rpc',
        dir: 'recv',
        id: response?.id ?? callId,
        callId,
        method,
        ok: response?.ok === true,
        result: response?.ok === true ? summarizeResult(method, response.result) : null,
        error: response?.ok === true ? null : (response?.error ?? null),
        subscription: false,
        source,
        t: performance.now(),
        wall: Date.now()
      })
      return response
    } catch (error) {
      push({
        layer: 'rpc',
        dir: 'recv',
        id: callId,
        callId,
        method,
        ok: false,
        result: null,
        error: { code: 'probe_thrown', message: String(error?.message ?? error) },
        subscription: false,
        source,
        t: performance.now(),
        wall: Date.now()
      })
      throw error
    }
  }

  const wrapCallNamespace = (namespace) => {
    if (!namespace || typeof namespace.call !== 'function') {
      return
    }
    const original = namespace.call
    if (!rawCall) {
      rawCall = original.bind(namespace)
    }
    namespace.call = function wrappedCall(req) {
      if (!isRelevantMethod(req?.method)) {
        return original.call(namespace, req)
      }
      return recordCall(req, 'renderer')
    }
  }

  const wrapSubscribeNamespace = (namespace) => {
    if (!namespace || typeof namespace.subscribe !== 'function') {
      return
    }
    const original = namespace.subscribe
    if (!rawSubscribe) {
      rawSubscribe = original.bind(namespace)
    }
    namespace.subscribe = function wrappedSubscribe(req, callbacksOrCallback) {
      const method = req?.method
      if (!isRelevantMethod(method)) {
        return original.call(namespace, req, callbacksOrCallback)
      }
      const callId = `u138-sub-${++seq}`
      push({
        layer: 'rpc',
        dir: 'send',
        id: callId,
        callId,
        method,
        params: summarizeParams(req?.params),
        subscription: true,
        source: 'renderer',
        t: performance.now(),
        wall: Date.now()
      })
      const recordResponse = (response) => {
        push({
          layer: 'rpc',
          dir: 'recv',
          id: response?.id ?? callId,
          callId,
          method,
          ok: response?.ok === true,
          result: response?.ok === true ? summarizeResult(method, response.result) : null,
          error: response?.ok === true ? null : (response?.error ?? null),
          subscription: true,
          source: 'renderer',
          t: performance.now(),
          wall: Date.now()
        })
      }
      const recordError = (error) => {
        push({
          layer: 'rpc',
          dir: 'recv',
          id: callId,
          callId,
          method,
          ok: false,
          result: null,
          error: { code: 'probe_subscription_error', message: String(error?.message ?? error) },
          subscription: true,
          source: 'renderer',
          t: performance.now(),
          wall: Date.now()
        })
      }
      const recordClose = () => {
        push({
          layer: 'rpc',
          dir: 'recv',
          id: callId,
          callId,
          method,
          ok: true,
          result: { type: 'end' },
          error: null,
          subscription: true,
          source: 'renderer',
          t: performance.now(),
          wall: Date.now()
        })
      }

      const isCallbackShape = typeof callbacksOrCallback === 'function'
      const callbacks = isCallbackShape
        ? { onResponse: callbacksOrCallback, onError: undefined, onClose: undefined }
        : (callbacksOrCallback ?? {})
      const wrapped = {
        onResponse: (response) => {
          recordResponse(response)
          return callbacks.onResponse?.(response)
        },
        onError: (error) => {
          recordError(error)
          return callbacks.onError?.(error)
        },
        onClose: () => {
          recordClose()
          return callbacks.onClose?.()
        },
        ...(callbacks.onBinary
          ? {
              onBinary: (bytes) => callbacks.onBinary(bytes)
            }
          : {})
      }
      const argument = isCallbackShape
        ? (response) => wrapped.onResponse(response)
        : wrapped
      return original.call(namespace, req, argument)
    }
  }

  const wrapApi = (api) => {
    if (!api || api.__u138Wrapped === true) {
      return api
    }
    try {
      wrapCallNamespace(api.runtimeEnvironments)
      wrapCallNamespace(api.runtime)
      wrapSubscribeNamespace(api.runtimeEnvironments)
      wrapSubscribeNamespace(api.runtime)
    } catch {
      // Wrapping is best-effort; a shape change must not break the app.
    }
    try {
      Object.defineProperty(api, '__u138Wrapped', { value: true, enumerable: false })
    } catch {}
    return api
  }

  // `window.api` is assigned by installWebPreloadApi(); take the assignment so
  // the wrapper is in place before React mounts.
  let apiValue
  try {
    Object.defineProperty(window, 'api', {
      configurable: true,
      enumerable: true,
      get() {
        return apiValue
      },
      set(value) {
        apiValue = wrapApi(value)
      }
    })
  } catch {
    // If the property cannot be redefined, fall through to the polling net.
  }
  if (window.api) {
    apiValue = wrapApi(window.api)
  } else {
    const poll = window.setInterval(() => {
      if (window.api) {
        window.clearInterval(poll)
        apiValue = wrapApi(window.api)
      }
    }, 25)
    window.setTimeout(() => window.clearInterval(poll), 15_000)
  }

  // WebSocket transport recorder: plaintext only for the E2EE control frames.
  try {
    const OriginalWebSocket = window.WebSocket
    const recordSocketData = (dir, data) => {
      let text = null
      if (typeof data === 'string') {
        text = data
      } else if (data instanceof ArrayBuffer) {
        transport[dir === 'send' ? 'encryptedSendBytes' : 'encryptedRecvBytes'] += data.byteLength
        transport[dir === 'send' ? 'encryptedSendFrames' : 'encryptedRecvFrames'] += 1
        return
      } else if (ArrayBuffer.isView(data)) {
        transport[dir === 'send' ? 'encryptedSendBytes' : 'encryptedRecvBytes'] += data.byteLength
        transport[dir === 'send' ? 'encryptedSendFrames' : 'encryptedRecvFrames'] += 1
        return
      }
      if (text === null) {
        return
      }
      let control = null
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          control = parsed.type
        }
      } catch {
        // Encrypted frames are base64, not JSON.
      }
      if (control) {
        transport.plaintextControlFrames += 1
        transport.lastControl = { dir, type: control, t: performance.now(), wall: Date.now() }
        push({
          layer: 'ws',
          dir,
          method: control,
          id: null,
          params: null,
          payload: truncate(text, 600),
          source: 'transport',
          t: performance.now(),
          wall: Date.now()
        })
        return
      }
      if (dir === 'send') {
        transport.encryptedSendFrames += 1
        transport.encryptedSendBytes += text.length
      } else {
        transport.encryptedRecvFrames += 1
        transport.encryptedRecvBytes += text.length
      }
    }

    function WrappedWebSocket(url, protocols) {
      const socket =
        protocols === undefined
          ? new OriginalWebSocket(url)
          : new OriginalWebSocket(url, protocols)
      transport.openedAt = transport.openedAt ?? Date.now()
      const originalSend = socket.send.bind(socket)
      socket.send = (data) => {
        recordSocketData('send', data)
        return originalSend(data)
      }
      socket.addEventListener('message', (event) => recordSocketData('recv', event.data))
      socket.addEventListener('close', () => {
        transport.closedAt = Date.now()
      })
      return socket
    }
    WrappedWebSocket.prototype = OriginalWebSocket.prototype
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      Object.defineProperty(WrappedWebSocket, key, { value: OriginalWebSocket[key] })
    }
    window.WebSocket = WrappedWebSocket
  } catch {
    // Transport evidence is optional; RPC recording still works.
  }

  Object.defineProperty(window, '__u138Probe', {
    configurable: true,
    enumerable: false,
    value: {
      frames: () => JSON.parse(JSON.stringify(frames)),
      drain: () => {
        const drained = JSON.parse(JSON.stringify(frames))
        frames.length = 0
        return drained
      },
      transport: () => ({ ...transport }),
      hostList: async (worktree) => {
        if (typeof rawCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          { selector: 'active', method: 'session.tabs.list', params: { worktree }, timeoutMs: 15_000 },
          'probe'
        )
      },
      hostActivate: async (args) => {
        if (typeof rawCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          {
            selector: 'active',
            method: 'session.tabs.activate',
            params: args,
            timeoutMs: 15_000
          },
          'probe-restore'
        )
      },
      hostClose: async (args) => {
        if (typeof rawCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          {
            selector: 'active',
            method: 'session.tabs.close',
            params: args,
            timeoutMs: 15_000
          },
          'probe-restore'
        )
      }
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Script-side helpers                                                         */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const WEB_TERMINAL_PREFIX = 'web-terminal-'
const HOST_SURFACE_SEPARATOR = '::'

function toHostTabId(localId) {
  if (!localId) {
    return null
  }
  if (!localId.startsWith(WEB_TERMINAL_PREFIX)) {
    return localId
  }
  try {
    return decodeURIComponent(localId.slice(WEB_TERMINAL_PREFIX.length))
  } catch {
    return localId
  }
}

function tabPart(hostSurfaceId) {
  if (!hostSurfaceId) {
    return null
  }
  const index = hostSurfaceId.indexOf(HOST_SURFACE_SEPARATOR)
  return index === -1 ? hostSurfaceId : hostSurfaceId.slice(0, index)
}

function comparableHostId(localId) {
  return tabPart(toHostTabId(localId))
}

function readDomAndStore() {
  const state = window.__store?.getState?.()
  const worktreeId = state?.activeWorktreeId ?? null
  const groups = worktreeId ? (state?.groupsByWorktree?.[worktreeId] ?? []) : []
  const activeGroupId = worktreeId
    ? (state?.activeGroupIdByWorktree?.[worktreeId] ?? null)
    : null
  const activeGroup =
    (activeGroupId ? groups.find((group) => group.id === activeGroupId) : null) ??
    groups[0] ??
    null
  const unified = worktreeId ? (state?.unifiedTabsByWorktree?.[worktreeId] ?? []) : []
  const activeUnified =
    activeGroup?.activeTabId != null
      ? (unified.find((tab) => tab.id === activeGroup.activeTabId) ?? null)
      : null

  const domNodes = [...document.querySelectorAll('[data-tab-id]')]
  const domTabs = domNodes.map((element) => ({
    id: element.getAttribute('data-tab-id'),
    title: element.getAttribute('data-tab-title') ?? (element.innerText ?? '').trim(),
    active: element.getAttribute('data-active') === 'true',
    group: element.getAttribute('data-tab-group') ?? null
  }))
  const domActive = domTabs.filter((tab) => tab.active).map((tab) => tab.id)

  return {
    worktreeId,
    domActive,
    domTabs,
    storeActive: activeGroup?.activeTabId ?? null,
    storeActiveType: activeUnified?.contentType ?? state?.activeTabTypeByWorktree?.[worktreeId] ?? null,
    storeActiveLabel: activeUnified?.label ?? null,
    storeActiveGroupId: activeGroup?.id ?? null,
    storeActiveGroup: activeGroup?.activeTabId ?? null,
    activeTerminalId: worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null,
    activeBrowserId: worktreeId ? (state?.activeBrowserTabIdByWorktree?.[worktreeId] ?? null) : null,
    activeFileId: worktreeId ? (state?.activeFileIdByWorktree?.[worktreeId] ?? null) : null,
    groups: groups.map((group) => ({ id: group.id, activeTabId: group.activeTabId ?? null })),
    unified: unified.map((tab) => ({
      id: tab.id,
      contentType: tab.contentType,
      label: tab.label,
      groupId: tab.groupId
    })),
    hasStore: Boolean(window.__store),
    hasProbe: Boolean(window.__u138Probe),
    onboardingOpen: Boolean(document.querySelector('[data-slot="dialog-content"]'))
  }
}

async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const open = await page.evaluate(
      () => document.querySelector('[data-slot="dialog-content"]') !== null
    )
    if (!open) {
      return true
    }
    await page.keyboard.press('Escape')
    await sleep(500)
    const stillOpen = await page.evaluate(
      () => document.querySelector('[data-slot="dialog-content"]') !== null
    )
    if (!stillOpen) {
      return true
    }
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]')
      if (!dialog) {
        return
      }
      const buttons = [...dialog.querySelectorAll('button')]
      const target =
        buttons.find((button) =>
          /^(got it|知道了|跳过|close|完成)$/i.test((button.textContent ?? '').trim())
        ) ?? dialog.querySelector('[data-slot="dialog-close"]')
      target?.click()
    })
    await sleep(700)
  }
  return !(await page.evaluate(
    () => document.querySelector('[data-slot="dialog-content"]') !== null
  ))
}

async function waitWorkspaceShell(page, timeoutMs = 120_000) {
  await page.waitForSelector('.app-layout', { timeout: timeoutMs })
  await dismissOnboarding(page)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const state = window.__store?.getState?.()
      return {
        worktreeId: state?.activeWorktreeId ?? null,
        tabCount: document.querySelectorAll('[data-tab-id]').length,
        activeEnvironmentId: state?.settings?.activeRuntimeEnvironmentId ?? null
      }
    })
    if (last.worktreeId && last.tabCount > 0) {
      return last
    }
    await sleep(750)
  }
  throw new Error(`workspace did not become ready: ${JSON.stringify(last)}`)
}

async function ensureTwoTabs(page) {
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tab-id]')].map((element) =>
      element.getAttribute('data-tab-id')
    )
  )
  if (before.length >= 2) {
    return { tabIds: before, createdTabIds: [] }
  }
  await page.getByRole('button', { name: 'New tab' }).click({ timeout: 15_000 })
  await page.getByText('New Terminal', { exact: true }).click({ timeout: 15_000 })
  const deadline = Date.now() + 30_000
  let after = before
  while (Date.now() < deadline) {
    after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab-id]')].map((element) =>
        element.getAttribute('data-tab-id')
      )
    )
    if (after.length >= 2) {
      break
    }
    await sleep(500)
  }
  const createdTabIds = after.filter((id) => !before.includes(id))
  return { tabIds: after, createdTabIds }
}

async function activateTab(page, tabId) {
  const selector = `[data-tab-id="${tabId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
  const locator = page.locator(selector).first()
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
  await locator.click({ timeout: 20_000 })
  const deadline = Date.now() + 15_000
  let active = []
  while (Date.now() < deadline) {
    active = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab-id][data-active="true"]')].map((element) =>
        element.getAttribute('data-tab-id')
      )
    )
    if (active.length === 1 && active[0] === tabId) {
      break
    }
    await sleep(200)
  }
  // Give the activate response and the host's subscription update time to land.
  await sleep(1200)
  return active
}

async function drainFrames(page, documentEpoch) {
  const raw = await page.evaluate(() => {
    try {
      return window.__u138Probe?.drain?.() ?? []
    } catch {
      return []
    }
  })
  return raw.map((frame) => ({ ...frame, doc: documentEpoch }))
}

async function readTransport(page) {
  return page.evaluate(() => {
    try {
      return window.__u138Probe?.transport?.() ?? null
    } catch {
      return null
    }
  })
}

async function probeHostList(page, worktreeId) {
  const deadline = Date.now() + 20_000
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(async (worktree) => {
        const response = await window.__u138Probe.hostList(worktree)
        return {
          ok: response?.ok === true,
          id: response?.id ?? null,
          error: response?.ok === true ? null : (response?.error ?? null),
          result: response?.ok === true
            ? {
                activeTabId: response.result?.activeTabId ?? null,
                activeTabType: response.result?.activeTabType ?? null,
                activeGroupId: response.result?.activeGroupId ?? null,
                publicationEpoch: response.result?.publicationEpoch ?? null,
                snapshotVersion: response.result?.snapshotVersion ?? null,
                worktree: response.result?.worktree ?? null,
                tabs: Array.isArray(response.result?.tabs)
                  ? response.result.tabs.map((tab) => ({
                      id: tab.id,
                      type: tab.type,
                      title: tab.title ?? null,
                      groupId: tab.groupId ?? null
                    }))
                  : []
              }
            : null
        }
      }, worktreeId)
      if (last?.ok) {
        return last
      }
    } catch (error) {
      last = { ok: false, error: { code: 'probe_thrown', message: String(error?.message ?? error) } }
    }
    await sleep(500)
  }
  return last ?? { ok: false, error: { code: 'probe_unavailable', message: 'no response' } }
}

function isWriteMethod(method) {
  return [
    'session.tabs.activate',
    'session.tabs.close',
    'session.tabs.closeLifecycle',
    'session.tabs.createTerminal',
    'session.tabs.move',
    'session.tabs.setTabProps',
    'session.tabs.updatePaneLayout'
  ].includes(method)
}

function lastClientWriteBefore(frames, gid) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (frame.gid > gid) {
      continue
    }
    if (frame.layer === 'rpc' && frame.dir === 'send' && isWriteMethod(frame.method)) {
      const response = [...frames]
        .reverse()
        .find(
          (candidate) =>
            candidate.layer === 'rpc' &&
            candidate.dir === 'recv' &&
            candidate.callId === frame.callId &&
            candidate.gid <= gid
        )
      return {
        gid: frame.gid,
        t: frame.t,
        method: frame.method,
        params: frame.params,
        source: frame.source,
        doc: frame.doc,
        response: response
          ? {
              gid: response.gid,
              id: response.id,
              ok: response.ok,
              result: response.result,
              error: response.error
            }
          : null
      }
    }
  }
  return null
}

function lastHostPublishBefore(frames, gid) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (frame.gid > gid) {
      continue
    }
    if (
      frame.layer === 'rpc' &&
      frame.dir === 'recv' &&
      (frame.method === 'session.tabs.subscribe' ||
        frame.method === 'session.tabs.subscribeAll') &&
      frame.result &&
      (frame.result.activeTabId !== undefined ||
        frame.result.type === 'updated' ||
        frame.result.type === 'snapshots')
    ) {
      return {
        gid: frame.gid,
        t: frame.t,
        method: frame.method,
        result: frame.result,
        doc: frame.doc
      }
    }
  }
  return null
}

function frameActive(frame) {
  if (!frame?.result) {
    return null
  }
  if (frame.result.activeTabId !== undefined) {
    return frame.result.activeTabId
  }
  if (Array.isArray(frame.result.snapshots) && frame.result.snapshots.length === 1) {
    return frame.result.snapshots[0]?.activeTabId ?? null
  }
  return null
}

function diagnose(domStoreMatch, domHostMatch, lastWrite, lastPublish, sampleHostActive) {
  if (domStoreMatch && domHostMatch) {
    return 'consistent'
  }
  const writeActive = lastWrite?.response?.result?.activeTabId ?? null
  const publishActive = lastPublish ? frameActive(lastPublish) : null
  const writeMatchesHost = writeActive !== null && tabPart(writeActive) === tabPart(sampleHostActive)
  const publishMatchesHost =
    publishActive !== null && tabPart(publishActive) === tabPart(sampleHostActive)
  if (!domStoreMatch) {
    return writeMatchesHost
      ? 'client-apply-lag: request reached the host with the sampled active tab, but DOM/store did not follow'
      : 'client-divergence: DOM and store disagree with each other (and the host)'
  }
  if (writeMatchesHost) {
    return 'host-moved-after-write: the host changed away from the last client write after it was accepted'
  }
  if (publishMatchesHost && !writeMatchesHost) {
    return 'host-publish-overrode-write: a later host subscription snapshot carries a different active tab'
  }
  return 'write-response-disagrees-with-host: the accepted request and the sampled host active differ'
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const out = {
  probe: 'u138-frame-timeline',
  generatedAt: new Date().toISOString(),
  platformUrl: PLATFORM_URL,
  user: USERNAME,
  projectKey: PROJECT_KEY,
  requestedCycles: CYCLES,
  worktreeId: null,
  project: null,
  runs: [],
  frames: [],
  transportByDoc: [],
  firstInconsistency: null,
  isolation: {
    baselineHostActive: null,
    finalHostActive: null,
    restored: false,
    restoreCall: null,
    createdTabIds: [],
    closedCreatedTabIds: []
  },
  verdict: null,
  notes: [
    'WebSocket frames are E2EE ciphertext after e2ee_hello; plaintext RPC frames are recorded at the window.api boundary.',
    'Host active is sampled with a read-only session.tabs.list probe and cross-checked against session.tabs.subscribe snapshots.',
    'DOM active selector: [data-tab-id][data-active="true"] (SortableTab/TerminalTab/BrowserTab/EditorFileTab roots).',
    'Store active: active group of activeWorktreeId -> group.activeTabId (plus activeTabIdByWorktree evidence).'
  ]
}

let browser = null
let context = null
let consolePage = null
let workspacePage = null
let documentEpoch = 0
let globalFrameSeq = 0
let fatalError = null

function mergeFrames(frames, epoch) {
  return frames.map((frame) => ({ ...frame, doc: epoch, gid: ++globalFrameSeq }))
}

async function drainInto(page, epoch) {
  const drained = mergeFrames(await drainFrames(page, epoch), epoch)
  out.frames.push(...drained)
  return drained
}

try {
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--ignore-certificate-errors']
  })
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  await context.addInitScript(installU138Probe, { frameLimit: PAGE_FRAME_LIMIT })

  consolePage = await context.newPage()
  const consoleErrors = []
  consolePage.on('pageerror', (error) => consoleErrors.push(String(error?.message ?? error)))
  await consolePage.goto(`${PLATFORM_URL}/#/projects`, { waitUntil: 'domcontentloaded' })

  const loginVisible = await consolePage
    .waitForSelector('#loginForm', { state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (loginVisible) {
    await consolePage.fill('#username', USERNAME)
    await consolePage.fill('#password', PASSWORD)
    await consolePage.click('#loginBtn')
  }

  await consolePage.waitForFunction(
    () => document.querySelectorAll('#projectBody tr').length > 0,
    undefined,
    { timeout: 30_000 }
  )
  // The console may land on the workbench after login; force the projects route.
  if (!(await consolePage.locator('#projectBody').count())) {
    await consolePage.evaluate(() => {
      window.location.hash = '#/projects'
    })
    await consolePage.waitForFunction(
      () => document.querySelectorAll('#projectBody tr').length > 0,
      undefined,
      { timeout: 20_000 }
    )
  }

  const row = consolePage
    .locator('#projectBody tr')
    .filter({ hasText: PROJECT_KEY })
    .first()
  if (!(await row.count())) {
    throw new Error(`project row not found for ${PROJECT_KEY}`)
  }
  const projectIdFromButton = await row
    .locator('button[data-orca-web]')
    .first()
    .getAttribute('data-orca-web')
  if (!projectIdFromButton) {
    throw new Error(`project ${PROJECT_KEY} has no usable Orca Web entry (disabled?)`)
  }

  const popupPromise = consolePage.waitForEvent('popup', { timeout: 25_000 })
  await row.locator('button[data-orca-web]').first().click()
  workspacePage = await popupPromise
  const workspaceErrors = []
  workspacePage.on('pageerror', (error) => workspaceErrors.push(String(error?.message ?? error)))
  const issuedUrl = workspacePage.url()
  await workspacePage.waitForSelector('.app-layout', { timeout: 120_000 })
  await sleep(1000)
  await dismissOnboarding(workspacePage)
  const ready = await waitWorkspaceShell(workspacePage)
  const worktreeId = ready.worktreeId
  out.worktreeId = worktreeId
  out.project = {
    key: PROJECT_KEY,
    id: projectIdFromButton,
    issuedUrl: issuedUrl.replace(/#handoff=[^&]+/, '#handoff=<redacted>')
  }

  await drainInto(workspacePage, documentEpoch)
  const baselineHost = await probeHostList(workspacePage, worktreeId)
  await drainInto(workspacePage, documentEpoch)
  out.isolation.baselineHostActive = baselineHost?.result?.activeTabId ?? null

  const ensured = await ensureTwoTabs(workspacePage)
  out.isolation.createdTabIds = ensured.createdTabIds
  if (ensured.tabIds.length < 2) {
    throw new Error(`workspace exposes ${ensured.tabIds.length} tab(s); need at least two`)
  }
  const tabA = ensured.tabIds[0]
  const tabB = ensured.tabIds[1]
  out.notes.push(`driven tabs: A=${tabA} B=${tabB}`)

  async function sample(cycle, phase) {
    const preFrames = await drainInto(workspacePage, documentEpoch)
    const domStore = await workspacePage.evaluate(readDomAndStore)
    const host = await probeHostList(workspacePage, worktreeId)
    const probeFrames = await drainInto(workspacePage, documentEpoch)
    const frameGidAtSample = globalFrameSeq
    const transport = await readTransport(workspacePage)
    if (transport) {
      out.transportByDoc.push({ doc: documentEpoch, phase, cycle, ...transport })
    }

    const domActive = domStore.domActive
    const storeActive = domStore.storeActive
    const hostActive = host?.ok ? (host.result?.activeTabId ?? null) : null
    const domStoreMatch = domActive.length === 1 && domActive[0] === storeActive
    const domHostMatch =
      domActive.length === 1 &&
      comparableHostId(domActive[0]) === tabPart(hostActive)
    const storeHostMatch =
      storeActive !== null && comparableHostId(storeActive) === tabPart(hostActive)
    const consistent = domStoreMatch && domHostMatch && storeHostMatch

    const lastWrite = lastClientWriteBefore(out.frames, frameGidAtSample)
    const lastPublish = lastHostPublishBefore(out.frames, frameGidAtSample)
    const run = {
      cycle,
      phase,
      at: new Date().toISOString(),
      doc: documentEpoch,
      frameGidAtSample,
      frames: [...preFrames, ...probeFrames],
      domActive,
      domTabs: domStore.domTabs,
      storeActive,
      storeActiveType: domStore.storeActiveType,
      storeActiveLabel: domStore.storeActiveLabel,
      storeActiveGroupId: domStore.storeActiveGroupId,
      storeActiveGroup: domStore.storeActiveGroup,
      activeTerminalId: domStore.activeTerminalId,
      activeBrowserId: domStore.activeBrowserId,
      activeFileId: domStore.activeFileId,
      groups: domStore.groups,
      unified: domStore.unified,
      hostActive,
      hostActiveType: host?.ok ? (host.result?.activeTabType ?? null) : null,
      hostActiveGroupId: host?.ok ? (host.result?.activeGroupId ?? null) : null,
      hostPublicationEpoch: host?.ok ? (host.result?.publicationEpoch ?? null) : null,
      hostOk: host?.ok === true,
      hostError: host?.ok === true ? null : (host?.error ?? null),
      domStoreMatch,
      domHostMatch,
      storeHostMatch,
      consistent,
      diagnosis: diagnose(domStoreMatch, domHostMatch, lastWrite, lastPublish, hostActive),
      lastClientWrite: lastWrite,
      lastHostPublish: lastPublish,
      tabCount: domStore.domTabs.length,
      hasStore: domStore.hasStore,
      hasProbe: domStore.hasProbe
    }
    out.runs.push(run)
    return run
  }

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    if (cycle > 1) {
      // Refresh start of cycle: the previous cycle ended with a reload, so this
      // is the post-refresh sample for the previous cycle. Cycles still begin
      // with a stable sample to keep the timeline self-contained.
      await waitWorkspaceShell(workspacePage)
    }
    await sample(cycle, 'start')
    await activateTab(workspacePage, tabA)
    await sample(cycle, 'activate-a')
    await activateTab(workspacePage, tabB)
    await sample(cycle, 'activate-b')

    await drainInto(workspacePage, documentEpoch)
    documentEpoch += 1
    await workspacePage.reload({ waitUntil: 'domcontentloaded' })
    await workspacePage.waitForSelector('.app-layout', { timeout: 120_000 })
    await dismissOnboarding(workspacePage)
    await waitWorkspaceShell(workspacePage)
    const afterReload = await sample(cycle, 'after-reload')
    if (cycle === CYCLES) {
      // Keep the final transport snapshot before closing.
      await drainInto(workspacePage, documentEpoch)
    }
    if (!afterReload.consistent) {
      // Do not abort: collect the following cycles to see whether it is durable.
      out.notes.push(`cycle ${cycle} after-reload inconsistent: ${afterReload.diagnosis}`)
    }
  }

  // First inconsistency in sample order.
  const firstBad = out.runs.find((run) => !run.consistent)
  if (firstBad) {
    out.firstInconsistency = {
      cycle: firstBad.cycle,
      phase: firstBad.phase,
      frameGidAtSample: firstBad.frameGidAtSample,
      domActive: firstBad.domActive,
      storeActive: firstBad.storeActive,
      hostActive: firstBad.hostActive,
      diagnosis: firstBad.diagnosis,
      lastClientWrite: firstBad.lastClientWrite,
      lastHostPublish: firstBad.lastHostPublish
    }
  }

  // Restore the pre-run host active tab (same device), then close any tab we created.
  const finalHost = await probeHostList(workspacePage, worktreeId)
  await drainInto(workspacePage, documentEpoch)
  out.isolation.finalHostActive = finalHost?.ok ? (finalHost.result?.activeTabId ?? null) : null
  const baselineSurface = out.isolation.baselineHostActive
  if (
    baselineSurface &&
    tabPart(baselineSurface) !== tabPart(out.isolation.finalHostActive)
  ) {
    const [baseTabId, baseLeafId] = baselineSurface.split(HOST_SURFACE_SEPARATOR)
    try {
      const restored = await workspacePage.evaluate(
        async (args) => {
          const response = await window.__u138Probe.hostActivate(args)
          return {
            ok: response?.ok === true,
            id: response?.id ?? null,
            error: response?.ok === true ? null : (response?.error ?? null),
            activeTabId: response?.ok === true ? (response.result?.activeTabId ?? null) : null
          }
        },
        {
          worktree: worktreeId,
          tabId: baseTabId,
          ...(baseLeafId ? { leafId: baseLeafId } : {}),
          notifyClients: false,
          navigation: 'caller',
          intent: 'user'
        }
      )
      out.isolation.restoreCall = restored
      out.isolation.restored = restored.ok === true
      await drainInto(workspacePage, documentEpoch)
    } catch (error) {
      out.isolation.restoreCall = {
        ok: false,
        error: { code: 'restore_thrown', message: String(error?.message ?? error) }
      }
    }
  } else {
    out.isolation.restored = true
    out.isolation.restoreCall = { ok: true, skipped: 'active tab did not change' }
  }

  if (out.isolation.createdTabIds.length > 0) {
    for (const createdTabId of out.isolation.createdTabIds) {
      try {
        const closed = await workspacePage.evaluate(
          async (args) => {
            const response = await window.__u138Probe.hostClose(args)
            return {
              ok: response?.ok === true,
              error: response?.ok === true ? null : (response?.error ?? null)
            }
          },
          {
            worktree: worktreeId,
            tabId: toHostTabId(createdTabId),
            reason: 'user'
          }
        )
        if (closed.ok) {
          out.isolation.closedCreatedTabIds.push(createdTabId)
        }
      } catch {
        // Best-effort cleanup; the run evidence records what was created.
      }
    }
    await drainInto(workspacePage, documentEpoch)
  }

  const consistentSamples = out.runs.filter((run) => run.consistent).length
  const inconsistentSamples = out.runs.length - consistentSamples
  const perCycle = []
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const cycleRuns = out.runs.filter((run) => run.cycle === cycle)
    perCycle.push({
      cycle,
      samples: cycleRuns.map((run) => ({
        phase: run.phase,
        consistent: run.consistent,
        domActive: run.domActive,
        storeActive: run.storeActive,
        hostActive: run.hostActive,
        frameGidAtSample: run.frameGidAtSample,
        diagnosis: run.diagnosis
      })),
      consistent: cycleRuns.every((run) => run.consistent)
    })
  }
  out.verdict = {
    cycleCount: CYCLES,
    sampleCount: out.runs.length,
    consistentSamples,
    inconsistentSamples,
    perCycle,
    reproduced: inconsistentSamples > 0
  }
  out.consoleErrors = consoleErrors.slice(0, 50)
  out.workspaceErrors = workspaceErrors.slice(0, 50)
} catch (error) {
  fatalError = error
  out.fatalError = {
    message: String(error?.message ?? error),
    stack: typeof error?.stack === 'string' ? error.stack : null
  }
  out.verdict = out.verdict ?? {
    cycleCount: out.runs.length > 0 ? Math.max(...out.runs.map((run) => run.cycle)) : 0,
    sampleCount: out.runs.length,
    consistentSamples: out.runs.filter((run) => run.consistent).length,
    inconsistentSamples: out.runs.filter((run) => !run.consistent).length,
    perCycle: [],
    reproduced: out.runs.some((run) => !run.consistent),
    blocked: true
  }
} finally {
  try {
    await browser?.close()
  } catch {}
  const firstBad = out.firstInconsistency
  const summary = {
    fatalError: out.fatalError ?? null,
    cycles: out.verdict?.cycleCount ?? 0,
    samples: out.verdict?.sampleCount ?? 0,
    consistent: out.verdict?.consistentSamples ?? 0,
    inconsistent: out.verdict?.inconsistentSamples ?? 0,
    reproduced: out.verdict?.reproduced ?? false,
    firstInconsistency: firstBad
      ? {
          cycle: firstBad.cycle,
          phase: firstBad.phase,
          frameGid: firstBad.frameGidAtSample,
          domActive: firstBad.domActive,
          storeActive: firstBad.storeActive,
          hostActive: firstBad.hostActive,
          diagnosis: firstBad.diagnosis,
          lastClientWrite: firstBad.lastClientWrite
            ? {
                gid: firstBad.lastClientWrite.gid,
                method: firstBad.lastClientWrite.method,
                params: firstBad.lastClientWrite.params,
                response: firstBad.lastClientWrite.response
              }
            : null,
          lastHostPublish: firstBad.lastHostPublish
            ? {
                gid: firstBad.lastHostPublish.gid,
                activeTabId: frameActive(firstBad.lastHostPublish)
              }
            : null
        }
      : null,
    isolation: out.isolation,
    output: OUTPUT_FILE
  }
  out.summary = summary
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2))

  console.log('')
  console.log('[u138] U138 frame timeline probe')
  console.log(`[u138] project=${PROJECT_KEY} worktree=${out.worktreeId ?? 'n/a'}`)
  for (const run of out.runs) {
    const view = run.consistent ? 'CONSISTENT' : 'INCONSISTENT'
    console.log(
      `[u138] cycle ${run.cycle} ${run.phase.padEnd(12)} dom=${JSON.stringify(run.domActive)} store=${JSON.stringify(run.storeActive)} host=${JSON.stringify(run.hostActive)} => ${view}`
    )
    if (!run.consistent) {
      console.log(`[u138]   diagnosis: ${run.diagnosis}`)
      if (run.lastClientWrite) {
        console.log(
          `[u138]   last client write: frame #${run.lastClientWrite.gid} ${run.lastClientWrite.method} params=${JSON.stringify(run.lastClientWrite.params)}`
        )
        console.log(
          `[u138]   response: ${JSON.stringify(run.lastClientWrite.response)}`
        )
      } else {
        console.log('[u138]   last client write: none observed before this sample')
      }
      if (run.lastHostPublish) {
        console.log(
          `[u138]   last host publish: frame #${run.lastHostPublish.gid} activeTabId=${JSON.stringify(frameActive(run.lastHostPublish))}`
        )
      }
    }
  }
  if (firstBad) {
    console.log(
      `[u138] first inconsistency: cycle ${firstBad.cycle} ${firstBad.phase} at frame #${firstBad.frameGidAtSample} (${firstBad.diagnosis})`
    )
  } else {
    console.log('[u138] first inconsistency: none (all samples agree)')
  }
  console.log(
    `[u138] conclusion: ${out.verdict.consistentSamples}/${out.verdict.sampleCount} samples consistent across ${out.verdict.cycleCount} cycle(s); reproduced=${out.verdict.reproduced}`
  )
  console.log(`[u138] evidence: ${OUTPUT_FILE}`)
  if (fatalError) {
    console.log(`[u138] blocked: ${out.fatalError.message}`)
  }
}

process.exitCode = fatalError ? 1 : 0
