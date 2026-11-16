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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EVIDENCE_DIR = path.join(REPO_ROOT, 'cloud-platform/evidence/exploratory-r8')
const OUTPUT_FILE = path.join(EVIDENCE_DIR, 'u138-timeline.json')
const RUN_ID = (process.env.U138_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-')).replace(
  /[^\w-]/g,
  '-'
)
const RUN_DIR = path.join(EVIDENCE_DIR, `run-${RUN_ID}`)

const PLATFORM_URL = (process.env.U138_PLATFORM_URL ?? 'https://127.0.0.1:18787').replace(/\/$/, '')
const USERNAME = process.env.U138_USERNAME ?? 'zhangsan'
const PASSWORD = process.env.U138_PASSWORD ?? 'Passw0rd!'
const PROJECT_KEY = process.env.U138_PROJECT_KEY ?? 'zhangsan-demo'
const CYCLES = Math.max(1, Number(process.env.U138_CYCLES ?? 3))
const REOPEN_CYCLES = Math.max(0, Number(process.env.U138_REOPEN_CYCLES ?? 3))
const QUICK_CYCLES = Math.max(0, Number(process.env.U138_QUICK_CYCLES ?? 5))
const SETTLE_MS = Math.max(2000, Number(process.env.U138_SETTLE_MS ?? 2100))
const HEADLESS = process.env.U138_HEADLESS !== '0'
const PAGE_FRAME_LIMIT = Number(process.env.U138_PAGE_FRAME_LIMIT ?? 300)
const HOST_STATE_ROOTS = (
  process.env.U138_HOST_STATE_ROOTS ??
  [path.join(homedir(), 'orca-local-env/host'), path.join(homedir(), 'orca-local-env/host2')].join(
    path.delimiter
  )
)
  .split(path.delimiter)
  .filter(Boolean)

mkdirSync(EVIDENCE_DIR, { recursive: true })
mkdirSync(RUN_DIR, { recursive: true })

/* -------------------------------------------------------------------------- */
/* Host state (script side): the persisted value is the ONLY host-side source. */
/* Host memory is not observable without a host debug RPC, so it stays        */
/* UNKNOWN and never takes part in consistency.                                */
/* -------------------------------------------------------------------------- */

let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  // Node < 22.5; host state reads degrade to hostPersistedOk=false.
}

function candidateProfileStateDbs() {
  const files = []
  for (const root of HOST_STATE_ROOTS) {
    const profiles = path.join(root, 'ud', 'profiles')
    if (!existsSync(profiles)) {
      continue
    }
    for (const profileId of readdirSync(profiles)) {
      const file = path.join(profiles, profileId, 'profile-state.db')
      if (existsSync(file)) {
        files.push({ root, profileId, file })
      }
    }
  }
  return files
}

function readHostState(worktreeId) {
  const at = Date.now()
  if (!DatabaseSync) {
    return { ok: false, at, error: 'node:sqlite unavailable', hostPersistedOk: false }
  }
  const errors = []
  for (const candidate of candidateProfileStateDbs()) {
    let db = null
    try {
      db = new DatabaseSync(candidate.file, { readOnly: true })
      const row = db
        .prepare("select payload from profile_state_documents where domain = 'workspaceSession'")
        .get()
      if (!row?.payload) {
        continue
      }
      const session = JSON.parse(row.payload)
      const byWorktree = session?.activeTabIdByWorktree ?? {}
      if (!Object.hasOwn(byWorktree, worktreeId)) {
        continue
      }
      return {
        ok: true,
        at,
        hostPersistedOk: true,
        file: candidate.file,
        hostRoot: candidate.root,
        // Host memory has no RPC and is NOT read here; never present it as observed.
        hostMemoryActive: 'UNKNOWN',
        hostMemorySource: 'unavailable',
        persistentSource: 'profile-state.db:workspaceSession.activeTabIdByWorktree',
        hostPersistentActive: byWorktree[worktreeId] ?? null,
        hostPersistentType: session?.activeTabTypeByWorktree?.[worktreeId] ?? null,
        hostPersistentGroupId: session?.activeGroupIdByWorktree?.[worktreeId] ?? null
      }
    } catch (error) {
      errors.push(`${candidate.file}: ${String(error?.message ?? error)}`)
    } finally {
      try {
        db?.close?.()
      } catch {}
    }
  }
  return {
    ok: false,
    at,
    hostPersistedOk: false,
    error:
      errors.length > 0 ? errors.join('; ') : `worktree ${worktreeId} not found in profile-state.db`
  }
}

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
  let probeCall = null
  let rawSubscribe = null

  const isRelevantMethod = (method) =>
    typeof method === 'string' && method.startsWith('session.tabs.')

  const push = (frame) => {
    frames.push(frame)
    if (frames.length > MAX_FRAMES) {
      const dropped = frames.length - MAX_FRAMES
      frames.splice(0, dropped)
      transport.droppedFrames = (transport.droppedFrames ?? 0) + dropped
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
      'persistSelection',
      'clientNavigationId',
      'clientMutationId',
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
            : (group.tabOrder ?? null)
        }))
      : undefined
  })

  const summarizeResult = (method, result) => {
    if (result === null || typeof result !== 'object') {
      return result === undefined ? null : truncate(result, 400)
    }
    if (method === 'session.tabs.listAll') {
      return {
        worktrees: Array.isArray(result.worktrees)
          ? result.worktrees.slice(0, 20)
          : result.worktrees,
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

  const recordCall = async (req, source, call) => {
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
      const response = await call(req)
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
      return null
    }
    const original = namespace.call
    const bound = original.bind(namespace)
    if (!probeCall) {
      // session.tabs.* travels over runtimeEnvironments; probe reads reuse its binding.
      probeCall = bound
    }
    namespace.call = function wrappedCall(req) {
      if (!isRelevantMethod(req?.method)) {
        return original.call(namespace, req)
      }
      return recordCall(req, 'renderer', bound)
    }
    return bound
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
          synthetic: true,
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
      const argument = isCallbackShape ? (response) => wrapped.onResponse(response) : wrapped
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
        protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols)
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
        if (typeof probeCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          {
            selector: 'active',
            method: 'session.tabs.list',
            params: { worktree },
            timeoutMs: 15_000
          },
          'probe',
          probeCall
        )
      },
      hostActivate: async (args) => {
        if (typeof probeCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          {
            selector: 'active',
            method: 'session.tabs.activate',
            params: args,
            timeoutMs: 15_000
          },
          'probe-restore',
          probeCall
        )
      },
      hostClose: async (args) => {
        if (typeof probeCall !== 'function') {
          throw new Error('u138 probe: raw RPC call not captured yet')
        }
        return recordCall(
          {
            selector: 'active',
            method: 'session.tabs.close',
            params: args,
            timeoutMs: 15_000
          },
          'probe-close',
          probeCall
        )
      },
      traceDump: () => {
        try {
          return window.__orcaSessionTabsTrace?.dump?.() ?? null
        } catch {
          return null
        }
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

function readDomAndStore() {
  const state = window.__store?.getState?.()
  const worktreeId = state?.activeWorktreeId ?? null
  const groups = worktreeId ? (state?.groupsByWorktree?.[worktreeId] ?? []) : []
  const activeGroupId = worktreeId ? (state?.activeGroupIdByWorktree?.[worktreeId] ?? null) : null
  // Authoritative field only: no groups[0] fallback (P2-2).
  const activeGroup =
    (activeGroupId ? groups.find((group) => group.id === activeGroupId) : null) ?? null
  const unified = worktreeId ? (state?.unifiedTabsByWorktree?.[worktreeId] ?? []) : []
  const groupByTabId = new Map(unified.map((tab) => [tab.id, tab.groupId ?? null]))
  const activeUnified =
    activeGroup?.activeTabId != null
      ? (unified.find((tab) => tab.id === activeGroup.activeTabId) ?? null)
      : null

  // Scope DOM to the visible workspace container; ignore hidden panes and
  // floating tab strips outside .app-layout (P2-1).
  const root = document.querySelector('.app-layout')
  const domNodes = root ? [...root.querySelectorAll('[data-tab-id]')] : []
  const domTabs = domNodes.map((element) => {
    const id = element.getAttribute('data-tab-id')
    return {
      id,
      title: element.getAttribute('data-tab-title') ?? (element.innerText ?? '').trim(),
      active: element.getAttribute('data-active') === 'true',
      visible: element.getClientRects().length > 0,
      groupId: groupByTabId.get(id) ?? null
    }
  })
  const domActive = domTabs.filter((tab) => tab.active && tab.visible).map((tab) => tab.id)

  return {
    worktreeId,
    domActive,
    domTabs,
    domVisibleTabCount: domTabs.filter((tab) => tab.visible).length,
    storeActive: activeGroup?.activeTabId ?? null,
    storeActiveSource: activeGroupId ? 'active-group' : 'missing-active-group',
    storeActiveType:
      activeUnified?.contentType ?? state?.activeTabTypeByWorktree?.[worktreeId] ?? null,
    storeActiveLabel: activeUnified?.label ?? null,
    storeActiveGroupId: activeGroup?.id ?? null,
    storeActiveGroup: activeGroup?.activeTabId ?? null,
    focusedGroupId: activeGroupId,
    activeTerminalId: worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null,
    activeBrowserId: worktreeId
      ? (state?.activeBrowserTabIdByWorktree?.[worktreeId] ?? null)
      : null,
    activeFileId: worktreeId ? (state?.activeFileIdByWorktree?.[worktreeId] ?? null) : null,
    groups: groups.map((group) => ({ id: group.id, activeTabId: group.activeTabId ?? null })),
    unified: unified.map((tab) => ({
      id: tab.id,
      contentType: tab.contentType,
      label: tab.label,
      groupId: tab.groupId ?? null
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
  await page
    .getByRole('menuitem', { name: /New Terminal/ })
    .first()
    .click({ timeout: 15_000 })
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
          result:
            response?.ok === true
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
      last = {
        ok: false,
        error: { code: 'probe_thrown', message: String(error?.message ?? error) }
      }
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

/** Writes that can move the selection; the H-A timing anchor only uses these. */
function isSelectionWriteMethod(method) {
  return [
    'session.tabs.activate',
    'session.tabs.close',
    'session.tabs.closeLifecycle',
    'session.tabs.createTerminal'
  ].includes(method)
}

function lastClientWriteBefore(frames, gid, doc, methodFilter = isWriteMethod) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (frame.gid > gid) {
      continue
    }
    if (doc !== undefined && frame.doc !== doc) {
      continue
    }
    if (
      frame.layer === 'rpc' &&
      frame.dir === 'send' &&
      frame.source === 'renderer' &&
      !frame.synthetic &&
      methodFilter(frame.method)
    ) {
      const response = [...frames]
        .toReversed()
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
        wall: frame.wall ?? null,
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
      !frame.synthetic &&
      (frame.method === 'session.tabs.subscribe' || frame.method === 'session.tabs.subscribeAll') &&
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

/* -------------------------------------------------------------------------- */
/* T1 apply telemetry + validity helpers                                      */
/* -------------------------------------------------------------------------- */

function parseTrace(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, frames: [], error: 'trace handle unavailable' }
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      ok: true,
      capacity: parsed.capacity ?? null,
      size: parsed.size ?? null,
      frames: Array.isArray(parsed.frames) ? parsed.frames : []
    }
  } catch (error) {
    return { ok: false, frames: [], error: String(error?.message ?? error) }
  }
}

function summarizeTraceFrame(frame, worktreeId) {
  if (!frame) {
    return null
  }
  const summary = matchedWorktreeSnapshot(frame, worktreeId)
  const isListFrame = Array.isArray(frame.result?.snapshots)
  return {
    seq: frame.seq,
    ts: frame.ts,
    dir: frame.dir,
    method: frame.method,
    requestId: frame.requestId,
    ok: frame.ok ?? null,
    worktree: summary?.worktree ?? frame.worktree ?? frame.result?.worktree ?? null,
    activeTabId: frame.result?.activeTabId ?? summary?.activeTabId ?? null,
    activeGroupId: frame.result?.activeGroupId ?? summary?.activeGroupId ?? null,
    snapshotVersion: frame.result?.snapshotVersion ?? summary?.snapshotVersion ?? null,
    publicationEpoch: frame.result?.publicationEpoch ?? summary?.publicationEpoch ?? null,
    // A listAll frame's own `applied` is an aggregate over every worktree, so only the
    // matched per-worktree snapshot may answer the decision for this worktree.
    applied: isListFrame ? (summary?.applied ?? null) : (frame.applied ?? null),
    applyOptions: isListFrame ? (summary?.applyOptions ?? null) : (frame.applyOptions ?? null),
    frameAppliedAggregate: frame.applied ?? null,
    matchedSnapshot: summary !== null
  }
}

/** A listAll frame carries one snapshot per worktree; keep only the sampled worktree's. */
function matchedWorktreeSnapshot(frame, worktreeId) {
  const snapshots = frame?.result?.snapshots
  if (!Array.isArray(snapshots)) {
    return null
  }
  const scoped = worktreeId
    ? snapshots.filter((entry) => !entry.worktree || sameWorktree(entry.worktree, worktreeId))
    : snapshots
  return (
    scoped.find((entry) => entry.applied !== undefined) ??
    scoped.find((entry) => entry.activeTabId !== undefined) ??
    null
  )
}

function frameBelongsToWorktree(frame, worktreeId) {
  // Single-snapshot stream frames carry the worktree on result; listAll carries it per snapshot.
  const frameWorktree = frame?.worktree ?? frame?.result?.worktree ?? null
  if (!worktreeId || !frameWorktree) {
    return true
  }
  return sameWorktree(frameWorktree, worktreeId)
}

/** H-A candidate: applied, after the last selection write, and not what the client shows. */
function isHACandidate(entry, afterTs, clientDomActive, clientStoreActive) {
  if (!entry || entry.applied !== true || !entry.activeTabId) {
    return false
  }
  if (afterTs !== null && !(typeof entry.ts === 'number' && entry.ts > afterTs)) {
    return false
  }
  const domActive =
    Array.isArray(clientDomActive) && clientDomActive.length === 1 ? clientDomActive[0] : null
  if (domActive === null || clientStoreActive === null) {
    return false
  }
  return (
    !sameComparable(entry.activeTabId, domActive) &&
    !sameComparable(entry.activeTabId, clientStoreActive)
  )
}

/**
 * Frames up to the wall clock. `lastQualifyingAppliedFrame` is the only frame allowed to
 * answer H-A: `applied` alone means the apply pipeline ran, not that it won a race.
 */
function traceAtWall(traceFrames, wall, options = {}) {
  const {
    worktreeId = null,
    afterTs = null,
    clientDomActive = [],
    clientStoreActive = null
  } = options
  if (!Array.isArray(traceFrames) || typeof wall !== 'number') {
    return {
      lastFrame: null,
      lastAppliedFrame: null,
      lastAppliedTrueFrame: null,
      lastQualifyingAppliedFrame: null
    }
  }
  const before = traceFrames.filter(
    (frame) =>
      typeof frame.ts === 'number' && frame.ts <= wall && frameBelongsToWorktree(frame, worktreeId)
  )
  const lastFrame = before.length > 0 ? summarizeTraceFrame(before.at(-1), worktreeId) : null
  let lastAppliedFrame = null
  let lastAppliedTrueFrame = null
  let lastQualifyingAppliedFrame = null
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const entry = summarizeTraceFrame(before[index], worktreeId)
    if (lastAppliedFrame === null && entry.applied !== null && entry.applied !== undefined) {
      lastAppliedFrame = entry
    }
    if (lastAppliedTrueFrame === null && entry.applied === true) {
      lastAppliedTrueFrame = entry
    }
    if (
      lastQualifyingAppliedFrame === null &&
      isHACandidate(entry, afterTs, clientDomActive, clientStoreActive)
    ) {
      lastQualifyingAppliedFrame = entry
    }
    if (
      lastAppliedFrame !== null &&
      lastAppliedTrueFrame !== null &&
      lastQualifyingAppliedFrame !== null
    ) {
      break
    }
  }
  return { lastFrame, lastAppliedFrame, lastAppliedTrueFrame, lastQualifyingAppliedFrame }
}

function evaluateTopology(domStore, tabA, tabB) {
  const groupOf = (id) => (domStore.unified ?? []).find((tab) => tab.id === id)?.groupId ?? null
  const tabAGroupId = groupOf(tabA)
  const tabBGroupId = groupOf(tabB)
  const tabCount = (domStore.unified ?? []).length
  const groupCount = (domStore.groups ?? []).length
  const crossGroup = Boolean(tabAGroupId && tabBGroupId && tabAGroupId !== tabBGroupId)
  return {
    tabCount,
    groupCount,
    tabA,
    tabB,
    tabAGroupId,
    tabBGroupId,
    crossGroup,
    ok: tabCount >= 2 && groupCount >= 2 && crossGroup
  }
}

function comparable(id) {
  return tabPart(toHostTabId(id))
}

function sameComparable(a, b) {
  return comparable(a) !== null && comparable(a) === comparable(b)
}

function normalizeWorktreeSelector(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    return null
  }
  return trimmed.startsWith('id:') ? trimmed.slice(3) : trimmed
}

function sameWorktree(a, b) {
  const left = normalizeWorktreeSelector(a)
  const right = normalizeWorktreeSelector(b)
  return left !== null && right !== null && left === right
}

/**
 * H-A: only a frame that is applied, came after the last selection write, and carries an
 * active different from the sampled DOM/store may answer. Anything else is `unknown`.
 */
function hAAssessment(sample) {
  const frame = sample?.trace?.lastQualifyingAppliedFrame
  const decision = sample?.trace?.lastAppliedFrame
  if (!frame) {
    return {
      verdict: 'unknown',
      reason: decision
        ? `no applied frame after the last selection write carrying a different active (last decision ${decision.method} applied=${decision.applied})`
        : 'no applied frame after the last selection write carrying a different active'
    }
  }
  const authoritative = frame.applyOptions?.hostActiveAuthoritative
  // Missing applyOptions means that apply did not adopt the host active.
  if (authoritative !== true) {
    return {
      verdict: 'affirmative',
      reason: `${frame.method} applied after the last client write with active=${JSON.stringify(frame.activeTabId)} and hostActiveAuthoritative=${String(authoritative)}`
    }
  }
  return {
    verdict: 'negative',
    reason: `${frame.method} applied with hostActiveAuthoritative=true`
  }
}

/** Factual direction of the divergence; no causal claim beyond the recorded frames. */
function diagnose(matches, lastWrite, hostPersistentActive, projectionActive, domActive) {
  if (matches.domStore && matches.domHostPersisted && matches.projectionPersistent) {
    return 'consistent'
  }
  if (!matches.domStore) {
    return 'client-divergence: DOM and store disagree'
  }
  const writeActive = lastWrite?.response?.result?.activeTabId ?? null
  const clientActive = domActive.length === 1 ? domActive[0] : null
  if (!matches.domHostPersisted) {
    if (writeActive !== null && sameComparable(writeActive, hostPersistentActive)) {
      return 'client-ahead-host: last client write response carries the host persisted active, but DOM/store show another tab'
    }
    if (
      writeActive !== null &&
      clientActive !== null &&
      sameComparable(writeActive, clientActive)
    ) {
      return 'host-did-not-follow-write: last client write response carries the client active, host persisted stayed different'
    }
    return 'client-host-divergence-without-matching-write'
  }
  if (!matches.projectionPersistent) {
    return 'projection-lag: device projection differs from host persisted active'
  }
  if (!matches.domProjection) {
    return 'projection-differs-from-client: device projection differs from DOM/store while host persisted matched'
  }
  return 'unclassified-divergence: host persisted, projection, and client views disagree'
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const out = {
  probe: 'u138-frame-timeline',
  generatedAt: new Date().toISOString(),
  runId: RUN_ID,
  runDir: RUN_DIR,
  platformUrl: PLATFORM_URL,
  user: USERNAME,
  projectKey: PROJECT_KEY,
  requestedCycles: CYCLES,
  config: {
    cycles: CYCLES,
    reopenCycles: REOPEN_CYCLES,
    quickCycles: QUICK_CYCLES,
    settleMs: SETTLE_MS
  },
  worktreeId: null,
  project: null,
  runs: [],
  samples: [],
  frames: [],
  baseline: null,
  transportByDoc: [],
  firstInconsistency: null,
  isolation: {
    baselinePersistentActive: null,
    baselineOk: false,
    finalPersistentActive: null,
    restored: false,
    restoredVerified: false,
    restoreCall: null,
    createdTabIds: [],
    closedCreatedTabIds: []
  },
  verdict: null,
  notes: [
    'WebSocket frames are E2EE ciphertext after e2ee_hello; plaintext RPC frames are recorded at the window.api boundary.',
    'Host memory is NOT observed: this probe compares host persisted (profile-state.db activeTabIdByWorktree) + device projection + client DOM/store.',
    'Device projection is session.tabs.list; it is asserted separately from host persisted.',
    'DOM active is scoped to .app-layout and visible only.',
    'Store active is the active group only; no groups[0] fallback.'
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
  await context.addInitScript(() => {
    try {
      localStorage.setItem('orca.debug.sessionTabs', '1')
    } catch {
      // Trace opt-in is best-effort; its absence marks the run INVALID.
    }
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

  const row = consolePage.locator('#projectBody tr').filter({ hasText: PROJECT_KEY }).first()
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
  const baselineHostState = readHostState(worktreeId)
  const baselineProjection = await probeHostList(workspacePage, worktreeId)
  await drainInto(workspacePage, documentEpoch)
  out.baseline = {
    hostState: baselineHostState,
    projectionOk: baselineProjection?.ok === true,
    projectionActive: baselineProjection?.ok
      ? (baselineProjection.result?.activeTabId ?? null)
      : null
  }
  out.isolation.baselineOk = baselineHostState.ok === true
  out.isolation.baselinePersistentActive = baselineHostState.hostPersistentActive ?? null
  if (!baselineHostState.ok) {
    out.notes.push(`baseline host state read failed: ${baselineHostState.error}`)
  }

  const ensured = await ensureTwoTabs(workspacePage)
  out.isolation.createdTabIds = ensured.createdTabIds
  if (ensured.tabIds.length < 2) {
    throw new Error(`workspace exposes ${ensured.tabIds.length} tab(s); need at least two`)
  }
  const tabA = ensured.tabIds[0]
  const tabB = ensured.tabIds[1]
  out.notes.push(`driven tabs: A=${tabA} B=${tabB}`)

  function outOfOrderActivate(frames, gid) {
    const pairs = []
    for (const frame of frames) {
      if (frame.gid > gid || frame.layer !== 'rpc' || frame.method !== 'session.tabs.activate') {
        continue
      }
      if (frame.dir === 'send' && frame.source === 'renderer') {
        const recv = frames.find(
          (candidate) =>
            candidate.layer === 'rpc' &&
            candidate.dir === 'recv' &&
            candidate.callId === frame.callId &&
            candidate.gid <= gid
        )
        if (recv) {
          pairs.push({ send: frame.gid, recv: recv.gid })
        }
      }
    }
    const recent = pairs.slice(-6)
    for (let index = 1; index < recent.length; index += 1) {
      if (recent[index].recv < recent[index - 1].recv) {
        return true
      }
    }
    return false
  }

  /** One atomic read: DOM/store, device projection, host persisted fallback, T1 trace. */
  async function readOnce(cycle, phase, tag) {
    const readAt = { start: Date.now() }
    const preFrames = await drainInto(workspacePage, documentEpoch)
    const domStore = await workspacePage.evaluate(readDomAndStore)
    readAt.domStore = Date.now()
    const host = await probeHostList(workspacePage, worktreeId)
    readAt.projection = Date.now()
    const hostState = readHostState(worktreeId)
    readAt.hostState = Date.now()
    const traceRaw = await workspacePage.evaluate(() => window.__u138Probe?.traceDump?.() ?? null)
    readAt.trace = Date.now()
    const probeFrames = await drainInto(workspacePage, documentEpoch)
    const frameGidAtSample = globalFrameSeq
    const transport = await readTransport(workspacePage)
    if (transport) {
      out.transportByDoc.push({ doc: documentEpoch, phase, cycle, tag, ...transport })
    }

    const trace = parseTrace(traceRaw)
    const projectionActive = host?.ok ? (host.result?.activeTabId ?? null) : null
    const domActive = domStore.domActive
    const storeActive = domStore.storeActive
    // Host memory is not observable from this probe; it is never compared.
    const hostMemoryActive = 'UNKNOWN'
    const hostPersistentActive = hostState.ok ? (hostState.hostPersistentActive ?? null) : null
    const lastWrite = lastClientWriteBefore(out.frames, frameGidAtSample, documentEpoch)
    const lastSelectionWrite = lastClientWriteBefore(
      out.frames,
      frameGidAtSample,
      documentEpoch,
      isSelectionWriteMethod
    )
    const traceSlice = traceAtWall(trace.frames, readAt.domStore, {
      worktreeId,
      afterTs: lastSelectionWrite?.wall ?? null,
      clientDomActive: domActive,
      clientStoreActive: storeActive
    })

    const topology = evaluateTopology(domStore, tabA, tabB)
    const matches = {
      domStore: domActive.length === 1 && domActive[0] === storeActive,
      domProjection: domActive.length === 1 && sameComparable(domActive[0], projectionActive),
      storeProjection: storeActive !== null && sameComparable(storeActive, projectionActive),
      domHostPersisted:
        domActive.length === 1 && sameComparable(domActive[0], hostPersistentActive),
      storeHostPersisted:
        storeActive !== null && sameComparable(storeActive, hostPersistentActive),
      projectionPersistent:
        projectionActive !== null &&
        hostState.ok &&
        sameComparable(projectionActive, hostPersistentActive)
    }
    const consistent =
      matches.domStore &&
      matches.domProjection &&
      matches.storeProjection &&
      matches.domHostPersisted &&
      matches.storeHostPersisted

    const invalidReasons = []
    if (!hostState.ok) {
      invalidReasons.push(`hostPersistedOk=false: ${hostState.error}`)
    }
    if (!domStore.hasStore) {
      invalidReasons.push('hasStore=false')
    }
    if (domStore.storeActiveSource !== 'active-group') {
      invalidReasons.push('storeActiveSource=missing-active-group')
    }
    if (!topology.ok) {
      invalidReasons.push(
        `topology: tabs=${topology.tabCount} groups=${topology.groupCount} crossGroup=${topology.crossGroup}`
      )
    }
    if (!trace.ok) {
      invalidReasons.push(`trace unavailable: ${trace.error ?? 'no dump'}`)
    }
    if (!out.isolation.baselineOk) {
      invalidReasons.push('baseline-read-failure')
    }

    const valid = invalidReasons.length === 0
    const lastPublish = lastHostPublishBefore(out.frames, frameGidAtSample)
    const run = {
      cycle,
      phase,
      tag,
      at: new Date().toISOString(),
      readAt,
      doc: documentEpoch,
      frameGidAtSample,
      frames: [...preFrames, ...probeFrames],
      domActive,
      domTabs: domStore.domTabs,
      domVisibleTabCount: domStore.domVisibleTabCount,
      storeActive,
      storeActiveSource: domStore.storeActiveSource,
      storeActiveType: domStore.storeActiveType,
      storeActiveLabel: domStore.storeActiveLabel,
      storeActiveGroupId: domStore.storeActiveGroupId,
      storeActiveGroup: domStore.storeActiveGroup,
      focusedGroupId: domStore.focusedGroupId,
      activeTerminalId: domStore.activeTerminalId,
      activeBrowserId: domStore.activeBrowserId,
      activeFileId: domStore.activeFileId,
      groups: domStore.groups,
      unified: domStore.unified,
      projectionActive,
      projectionActiveType: host?.ok ? (host.result?.activeTabType ?? null) : null,
      projectionActiveGroupId: host?.ok ? (host.result?.activeGroupId ?? null) : null,
      projectionPublicationEpoch: host?.ok ? (host.result?.publicationEpoch ?? null) : null,
      projectionOk: host?.ok === true,
      projectionError: host?.ok === true ? null : (host?.error ?? null),
      hostMemoryActive,
      hostMemoryKnown: false,
      hostMemorySource: 'unavailable',
      hostStateFile: hostState.file ?? null,
      hostStateError: hostState.ok ? null : (hostState.error ?? null),
      hostPersistedOk: hostState.ok === true,
      hostPersistentActive,
      hostPersistentType: hostState.hostPersistentType ?? null,
      hostPersistentGroupId: hostState.hostPersistentGroupId ?? null,
      hostPersistentSource: hostState.persistentSource ?? null,
      matches,
      topology,
      valid,
      invalidReasons,
      consistent,
      diagnosis: diagnose(matches, lastWrite, hostPersistentActive, projectionActive, domActive),
      outOfOrderWrites: outOfOrderActivate(out.frames, frameGidAtSample),
      trace: {
        ok: trace.ok,
        size: trace.size ?? null,
        lastFrame: traceSlice.lastFrame,
        lastAppliedFrame: traceSlice.lastAppliedFrame,
        lastAppliedTrueFrame: traceSlice.lastAppliedTrueFrame,
        lastQualifyingAppliedFrame: traceSlice.lastQualifyingAppliedFrame
      },
      lastClientWrite: lastWrite,
      lastSelectionWrite,
      lastHostPublish: lastPublish,
      tabCount: domStore.unified.length,
      hasStore: domStore.hasStore,
      hasProbe: domStore.hasProbe
    }
    out.runs.push(run)
    return run
  }

  function normalizedReading(run) {
    return {
      domActive: run.domActive,
      storeActive: comparable(run.storeActive),
      projectionActive: comparable(run.projectionActive),
      hostMemoryActive: comparable(run.hostMemoryActive),
      hostPersistentActive: comparable(run.hostPersistentActive)
    }
  }

  function sameReading(a, b) {
    return JSON.stringify(normalizedReading(a)) === JSON.stringify(normalizedReading(b))
  }

  function summarizeRun(run) {
    return {
      tag: run.tag,
      at: run.at,
      doc: run.doc,
      frameGidAtSample: run.frameGidAtSample,
      domActive: run.domActive,
      domVisibleTabCount: run.domVisibleTabCount,
      storeActive: run.storeActive,
      storeActiveSource: run.storeActiveSource,
      storeActiveGroupId: run.storeActiveGroupId,
      projectionActive: run.projectionActive,
      projectionOk: run.projectionOk,
      hostMemoryActive: run.hostMemoryActive,
      hostMemoryKnown: run.hostMemoryKnown,
      hostMemorySource: run.hostMemorySource,
      hostPersistedOk: run.hostPersistedOk,
      hostPersistentActive: run.hostPersistentActive,
      hostStateFile: run.hostStateFile,
      hostStateError: run.hostStateError,
      matches: run.matches,
      topology: run.topology,
      valid: run.valid,
      invalidReasons: run.invalidReasons,
      consistent: run.consistent,
      diagnosis: run.diagnosis,
      trace: run.trace,
      lastClientWrite: run.lastClientWrite,
      lastSelectionWrite: run.lastSelectionWrite,
      lastHostPublish: run.lastHostPublish
    }
  }

  function attributePoint(point) {
    if (!point.valid) {
      return { token: 'INVALID', reason: point.invalidReasons.join(' | ') }
    }
    if (point.unstable) {
      return { token: 'unstable', reason: 'the two reads disagree; no causal attribution' }
    }
    const sample = point.second
    const clientActive = sample.domActive.length === 1 ? sample.domActive[0] : null
    const hostPersisted = sample.hostPersistentActive
    const writeActive = sample.lastClientWrite?.response?.result?.activeTabId ?? null
    const written = sample.trace?.lastQualifyingAppliedFrame ?? null

    // Client DOM/store moved off the host persisted value while its own write reply
    // still carried the host value: the client is ahead of the host.
    if (
      sample.matches.domStore &&
      clientActive !== null &&
      !sameComparable(clientActive, hostPersisted) &&
      writeActive !== null &&
      sameComparable(writeActive, hostPersisted)
    ) {
      const params = sample.lastClientWrite?.params ?? {}
      return {
        token: 'client-ahead-host',
        reason: `client shows ${clientActive} while host persisted stays ${hostPersisted}; last client write ${sample.lastClientWrite?.method} replied ${writeActive} (materializeOnly=${String(params.materializeOnly)}, notifyClients=${String(params.notifyClients)})`
      }
    }
    // A host frame carried the host persisted active after the last write and the
    // client did not adopt it.
    if (
      written &&
      written.activeTabId !== null &&
      sameComparable(written.activeTabId, hostPersisted) &&
      clientActive !== null &&
      !sameComparable(written.activeTabId, clientActive)
    ) {
      return {
        token: 'host-frame-not-won',
        reason: `applied ${written.method} #${written.seq} carried host persisted active ${written.activeTabId}; client kept ${clientActive}`
      }
    }
    if (sample.matches.projectionPersistent === false) {
      return {
        token: 'H-C',
        reason: 'device projection differs from host persisted activeTabIdByWorktree'
      }
    }
    const ha = point.hA
    if (ha.verdict === 'affirmative') {
      return { token: 'H-A', reason: ha.reason }
    }
    const applied = sample.trace?.lastQualifyingAppliedFrame
    if (
      applied &&
      writeActive &&
      (applied.method === 'session.tabs.subscribe' ||
        applied.method === 'session.tabs.subscribeAll') &&
      applied.activeTabId &&
      !sameComparable(applied.activeTabId, writeActive)
    ) {
      return {
        token: 'H-B',
        reason: `host stream ${applied.method} applied over client write (write=${writeActive} applied=${applied.activeTabId})`
      }
    }
    if (sample.outOfOrderWrites) {
      return { token: 'H-D', reason: 'activate responses landed out of send order' }
    }
    return {
      token: 'unknown',
      reason: 'no qualifying frame after the last client write; direction not attributable'
    }
  }

  async function samplePoint(cycle, phase) {
    const first = await readOnce(cycle, phase, 'initial')
    await sleep(SETTLE_MS)
    const second = await readOnce(cycle, phase, 'resample')
    const valid = first.valid && second.valid
    const stable = valid && sameReading(first, second)
    const consistent = valid && stable && first.consistent && second.consistent
    const invalidReasons = [...new Set([...first.invalidReasons, ...second.invalidReasons])]
    const point = {
      cycle,
      phase,
      kind: typeof cycle === 'number' ? 'reload' : String(cycle).replace(/-\d+$/, ''),
      at: new Date().toISOString(),
      valid,
      stable,
      consistent,
      unstable: valid && !stable,
      invalidReasons,
      first: summarizeRun(first),
      second: summarizeRun(second),
      hA: hAAssessment(second)
    }
    point.attribution = consistent
      ? { token: 'none', reason: 'all three perspectives agree in both reads' }
      : attributePoint(point)
    out.samples.push(point)
    const view = !valid ? 'INVALID' : consistent ? 'GREEN' : 'RED'
    console.log(
      `[u138] ${String(cycle).padEnd(12)} ${phase.padEnd(12)} ${view}` +
        ` dom=${JSON.stringify(point.second.domActive)} store=${JSON.stringify(point.second.storeActive)}` +
        ` projection=${JSON.stringify(point.second.projectionActive)}` +
        ` hostMem=${String(point.second.hostMemoryActive)}` +
        ` hostPersist=${JSON.stringify(point.second.hostPersistentActive)}` +
        ` hA=${point.hA.verdict} attr=${point.attribution.token}`
    )
    if (!valid) {
      console.log(`[u138]   INVALID: ${invalidReasons.join(' | ')}`)
    }
    return point
  }

  async function openWorkspaceFromConsole(timeoutMs = 120_000) {
    const popupPromise = consolePage.waitForEvent('popup', { timeout: 30_000 })
    await row.locator('button[data-orca-web]').first().click()
    const page = await popupPromise
    page.on('pageerror', (error) => workspaceErrors.push(String(error?.message ?? error)))
    await page.waitForSelector('.app-layout', { timeout: timeoutMs })
    await sleep(500)
    await dismissOnboarding(page)
    await waitWorkspaceShell(page, timeoutMs)
    return page
  }

  async function reopenWorkspace() {
    await drainInto(workspacePage, documentEpoch)
    documentEpoch += 1
    try {
      await workspacePage.close()
    } catch {}
    workspacePage = await openWorkspaceFromConsole()
  }

  async function createTempTab() {
    const before = await workspacePage.evaluate(() =>
      [...document.querySelectorAll('.app-layout [data-tab-id]')].map((element) =>
        element.getAttribute('data-tab-id')
      )
    )
    // Split layouts render one New-tab trigger per group; use the first visible one.
    await workspacePage.getByRole('button', { name: 'New tab' }).first().click({ timeout: 15_000 })
    await workspacePage
      .getByRole('menuitem', { name: /New Terminal/ })
      .first()
      .click({ timeout: 15_000 })
    const deadline = Date.now() + 30_000
    let after = before
    while (Date.now() < deadline) {
      after = await workspacePage.evaluate(() =>
        [...document.querySelectorAll('.app-layout [data-tab-id]')].map((element) =>
          element.getAttribute('data-tab-id')
        )
      )
      if (after.length > before.length) {
        break
      }
      await sleep(300)
    }
    return after.find((id) => !before.includes(id)) ?? null
  }

  async function closeTabViaProbe(tabId) {
    try {
      await workspacePage.evaluate(
        async (args) => {
          const response = await window.__u138Probe.hostClose(args)
          return response?.ok === true
        },
        { worktree: worktreeId, tabId: toHostTabId(tabId), reason: 'user' }
      )
    } catch {
      // Best-effort; the reopen/close scenario records host state regardless.
    }
    await sleep(400)
  }

  // Scenario C1/baseline: activate A -> activate B -> reload, dual-sampled.
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    if (cycle > 1) {
      await waitWorkspaceShell(workspacePage)
    }
    await samplePoint(cycle, 'start')
    await activateTab(workspacePage, tabA)
    await samplePoint(cycle, 'activate-a')
    await activateTab(workspacePage, tabB)
    await samplePoint(cycle, 'activate-b')

    await drainInto(workspacePage, documentEpoch)
    documentEpoch += 1
    await workspacePage.reload({ waitUntil: 'domcontentloaded' })
    await workspacePage.waitForSelector('.app-layout', { timeout: 120_000 })
    await dismissOnboarding(workspacePage)
    await waitWorkspaceShell(workspacePage)
    await samplePoint(cycle, 'after-reload')
  }

  // Scenario C3: close the page, reopen through the console entry, dual-sample.
  const reopenActives = []
  for (let index = 1; index <= REOPEN_CYCLES; index += 1) {
    await reopenWorkspace()
    const point = await samplePoint(`reopen-${index}`, 'after-reopen')
    reopenActives.push({
      index,
      pointValid: point.valid,
      domActive: point.second.domActive,
      storeActive: point.second.storeActive,
      projectionActive: point.second.projectionActive,
      hostPersistentActive: point.second.hostPersistentActive
    })
  }
  out.reopenActives = reopenActives
  out.crossReopenSameActive =
    reopenActives.length > 0 &&
    reopenActives.every(
      (entry) =>
        comparable(entry.domActive[0] ?? null) === comparable(reopenActives[0].domActive[0] ?? null)
    )

  // Scenario C2: quick tab open -> sample -> close -> sample, five rounds.
  for (let index = 1; index <= QUICK_CYCLES; index += 1) {
    const createdTabId = await createTempTab()
    await samplePoint(`quick-${index}`, 'opened')
    if (createdTabId) {
      out.isolation.quickCreatedTabIds = [...(out.isolation.quickCreatedTabIds ?? []), createdTabId]
      await closeTabViaProbe(createdTabId)
    }
    await samplePoint(`quick-${index}`, 'closed')
  }

  // First red sample in order (valid but inconsistent).
  const firstBad = out.samples.find((point) => point.valid && !point.consistent)
  if (firstBad) {
    out.firstInconsistency = {
      cycle: firstBad.cycle,
      phase: firstBad.phase,
      attribution: firstBad.attribution,
      hA: firstBad.hA,
      first: firstBad.first,
      second: firstBad.second
    }
  }

  // Restore by host persisted value (not projection), then re-read to verify.
  const finalHostState = readHostState(worktreeId)
  await drainInto(workspacePage, documentEpoch)
  out.isolation.finalPersistentActive = finalHostState.ok
    ? finalHostState.hostPersistentActive
    : null
  const baselineSurface = out.isolation.baselinePersistentActive
  if (
    out.isolation.baselineOk &&
    baselineSurface &&
    tabPart(baselineSurface) !== tabPart(out.isolation.finalPersistentActive)
  ) {
    const [baseTabId, baseLeafId] = String(baselineSurface).split(HOST_SURFACE_SEPARATOR)
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
    out.isolation.restored = out.isolation.baselineOk
    out.isolation.restoreCall = out.isolation.baselineOk
      ? { ok: true, skipped: 'host persisted active did not change' }
      : { ok: false, skipped: 'baseline host state unreadable' }
  }
  const verifyState = readHostState(worktreeId)
  out.isolation.restoredVerified =
    out.isolation.baselineOk &&
    verifyState.ok &&
    comparable(baselineSurface) === comparable(verifyState.hostPersistentActive)
  out.isolation.verifyState = verifyState

  // Close any tabs the initial ensureTwoTabs created.
  const cleanupIds = [
    ...new Set([
      ...(out.isolation.createdTabIds ?? []),
      ...(out.isolation.quickCreatedTabIds ?? [])
    ])
  ]
  for (const createdTabId of cleanupIds) {
    try {
      const closed = await workspacePage.evaluate(
        async (args) => {
          const response = await window.__u138Probe.hostClose(args)
          return {
            ok: response?.ok === true,
            error: response?.ok === true ? null : (response?.error ?? null)
          }
        },
        { worktree: worktreeId, tabId: toHostTabId(createdTabId), reason: 'user' }
      )
      if (closed.ok) {
        out.isolation.closedCreatedTabIds.push(createdTabId)
      }
    } catch {
      // Best-effort cleanup; the run evidence records what was created.
    }
  }
  await drainInto(workspacePage, documentEpoch)

  const validPoints = out.samples.filter((point) => point.valid)
  const invalidPoints = out.samples.filter((point) => !point.valid)
  const greenPoints = validPoints.filter((point) => point.consistent)
  const redPoints = validPoints.filter((point) => !point.consistent)
  const scenarioName = (point) => point.kind
  const scenarioSummary = (kind) => {
    const points = out.samples.filter((point) => scenarioName(point) === kind)
    return {
      samplePoints: points.length,
      green: points.filter((point) => point.valid && point.consistent).length,
      red: points.filter((point) => point.valid && !point.consistent).length,
      invalid: points.filter((point) => !point.valid).length
    }
  }
  out.verdict = {
    cycleCount: CYCLES,
    reopenCycles: REOPEN_CYCLES,
    quickCycles: QUICK_CYCLES,
    sampleCount: out.runs.length,
    samplePointCount: out.samples.length,
    green: greenPoints.length,
    red: redPoints.length,
    invalid: invalidPoints.length,
    // Backwards-compatible names: only valid points participate.
    consistentSamples: greenPoints.length,
    inconsistentSamples: redPoints.length,
    reproduced: redPoints.length > 0,
    // Fix B (INVALID hardening / conclusive gate) is out of scope for this pass.
    conclusive: false,
    conclusiveReason:
      'fix B not implemented: projection-unavailable and failed quick create/close still count as red; see test-reports/u138-probe-hardened-audit.md P1-1/P1-4',
    perspective: 'host-persisted + device-projection + client DOM/store (host memory UNKNOWN)',
    hostMemory: 'UNKNOWN',
    hostMemorySource: 'unavailable',
    byScenario: {
      reload: scenarioSummary('reload'),
      reopen: scenarioSummary('reopen'),
      quick: scenarioSummary('quick')
    },
    redSamples: redPoints.map((point) => ({
      cycle: point.cycle,
      phase: point.phase,
      attribution: point.attribution,
      hA: point.hA,
      unstable: point.unstable,
      first: point.first,
      second: point.second
    })),
    invalidSamples: invalidPoints.map((point) => ({
      cycle: point.cycle,
      phase: point.phase,
      invalidReasons: point.invalidReasons
    })),
    crossReopenSameActive: out.crossReopenSameActive,
    reopenActives,
    baseline: out.baseline
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
    samplePointCount: out.samples.length,
    green: out.samples.filter((point) => point.valid && point.consistent).length,
    red: out.samples.filter((point) => point.valid && !point.consistent).length,
    invalid: out.samples.filter((point) => !point.valid).length,
    consistentSamples: out.samples.filter((point) => point.valid && point.consistent).length,
    inconsistentSamples: out.samples.filter((point) => point.valid && !point.consistent).length,
    reproduced: out.samples.some((point) => point.valid && !point.consistent),
    conclusive: false,
    conclusiveReason: 'fix B not implemented; forced false before the run finished',
    hostMemory: 'UNKNOWN',
    hostMemorySource: 'unavailable',
    perspective: 'host-persisted + device-projection + client DOM/store (host memory UNKNOWN)',
    blocked: true
  }
} finally {
  try {
    await browser?.close()
  } catch {}
  const firstBad = out.firstInconsistency
  const summary = {
    fatalError: out.fatalError ?? null,
    runId: RUN_ID,
    cycles: out.verdict?.cycleCount ?? 0,
    reopenCycles: REOPEN_CYCLES,
    quickCycles: QUICK_CYCLES,
    samples: out.verdict?.sampleCount ?? 0,
    samplePoints: out.verdict?.samplePointCount ?? 0,
    green: out.verdict?.green ?? 0,
    red: out.verdict?.red ?? 0,
    invalid: out.verdict?.invalid ?? 0,
    reproduced: out.verdict?.reproduced ?? false,
    conclusive: out.verdict?.conclusive ?? false,
    conclusiveReason: out.verdict?.conclusiveReason ?? null,
    perspective: out.verdict?.perspective ?? null,
    byScenario: out.verdict?.byScenario ?? null,
    baselineOk: out.isolation?.baselineOk ?? false,
    hostMemory: 'UNKNOWN',
    hostMemorySource: 'unavailable',
    firstInconsistency: firstBad
      ? {
          cycle: firstBad.cycle,
          phase: firstBad.phase,
          attribution: firstBad.attribution,
          hA: firstBad.hA,
          first: firstBad.first,
          second: firstBad.second
        }
      : null,
    redSamples: out.verdict?.redSamples ?? [],
    invalidSamples: out.verdict?.invalidSamples ?? [],
    isolation: out.isolation,
    output: OUTPUT_FILE
  }
  out.summary = summary
  // Write the authoritative copy into this run's directory first; the shared file is only a pointer.
  writeFileSync(path.join(RUN_DIR, 'u138-timeline.json'), JSON.stringify(out, null, 2))
  writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2))

  console.log('')
  console.log('[u138] U138 frame timeline probe (hardened)')
  console.log(`[u138] project=${PROJECT_KEY} worktree=${out.worktreeId ?? 'n/a'}`)
  console.log(
    `[u138] baselineOk=${out.isolation?.baselineOk} hostMemory=UNKNOWN perspective=host-persisted+projection+client`
  )
  console.log(
    `[u138] counts: green=${summary.green} red=${summary.red} invalid=${summary.invalid} of ${summary.samplePoints} sample point(s) conclusive=${summary.conclusive}`
  )
  for (const point of out.samples) {
    const view = !point.valid ? 'INVALID' : point.consistent ? 'GREEN' : 'RED'
    console.log(
      `[u138] ${String(point.cycle).padEnd(12)} ${point.phase.padEnd(12)} ${view}` +
        ` first={dom:${JSON.stringify(point.first.domActive)},store:${JSON.stringify(point.first.storeActive)},proj:${JSON.stringify(point.first.projectionActive)},hostPersist:${JSON.stringify(point.first.hostPersistentActive)}}` +
        ` second={dom:${JSON.stringify(point.second.domActive)},store:${JSON.stringify(point.second.storeActive)},proj:${JSON.stringify(point.second.projectionActive)},hostPersist:${JSON.stringify(point.second.hostPersistentActive)}}` +
        ` attr=${point.attribution.token} hA=${point.hA.verdict}`
    )
    if (!point.valid) {
      console.log(`[u138]   INVALID: ${point.invalidReasons.join(' | ')}`)
    } else if (!point.consistent) {
      const decision = point.second.trace?.lastAppliedFrame
      const qualifying = point.second.trace?.lastQualifyingAppliedFrame
      console.log(`[u138]   attribution: ${point.attribution.token} — ${point.attribution.reason}`)
      console.log(
        `[u138]   last decision frame: ${decision ? `#${decision.seq} ${decision.method} applied=${decision.applied} hostActiveAuthoritative=${String(decision.applyOptions?.hostActiveAuthoritative)} active=${JSON.stringify(decision.activeTabId)}` : 'none'}`
      )
      console.log(
        `[u138]   last H-A-candidate frame: ${qualifying ? `#${qualifying.seq} ${qualifying.method} applied=${qualifying.applied} hostActiveAuthoritative=${String(qualifying.applyOptions?.hostActiveAuthoritative)} active=${JSON.stringify(qualifying.activeTabId)}` : 'none (after last selection write, different from client)'}`
      )
    }
  }
  if (firstBad) {
    console.log(
      `[u138] first red: ${firstBad.phase} attr=${firstBad.attribution.token} hA=${firstBad.hA.verdict}`
    )
  } else {
    console.log('[u138] first red: none')
  }
  console.log('')
  console.log(
    `[u138] perspective: host-persisted + device-projection + client DOM/store; host memory UNKNOWN (H-B not judged)`
  )
  console.log(`[u138] evidence: ${OUTPUT_FILE}`)
  console.log(`[u138] evidence copy (authoritative): ${path.join(RUN_DIR, 'u138-timeline.json')}`)
  if (fatalError) {
    console.log(`[u138] blocked: ${out.fatalError.message}`)
  }
}

process.exitCode = fatalError ? 1 : 0
