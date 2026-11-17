import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { ROOT } from './harness.ts'

const WEB_SOURCE = join(ROOT, 'apps/web')

export type WebConsolePage = {
  window: Window
  settle: () => Promise<void>
  clickNav: (route: string) => Promise<void>
  submitLogin: (username: string, password: string) => Promise<void>
  text: (selector: string) => string
  hidden: (selector: string) => boolean
  /**
   * Makes the next requests to `METHOD path` fail inside the page's own fetch,
   * or return a stubbed payload when `respond` is given.
   */
  fail: (method: string, path: string, respond?: { status: number; body: unknown }) => void
  /** Makes the next request to `METHOD path` reject at the fetch boundary (network down). */
  abort: (method: string, path: string) => void
  clearFails: () => void
  /**
   * Makes the NEXT request to `METHOD path` hang at the page boundary until
   * `release()` — the only way to observe a mid-batch window such as the matrix
   * save freeze (M120b-8). The held request is paused, never answered here.
   */
  hold: (method: string, path: string) => void
  /** Sends every held request on to the platform and lets the page settle. */
  release: () => Promise<void>
  /** Every request the page made, as `METHOD path`. */
  calls: () => string[]
  /** Response status per call, aligned with `calls()`; undefined for a rejected/hung fetch. */
  statuses: () => (number | undefined)[]
  /** Authorization header sent with each call, aligned with `calls()`. */
  authHeaders: () => (string | undefined)[]
  /** A request header sent with each call, aligned with `calls()`. */
  headerValues: (name: string) => (string | undefined)[]
  /** JSON bodies of requests that carried one, in call order. */
  bodies: () => { call: string; body: unknown }[]
}

/**
 * Loads the real index.html and app.js into a DOM whose `fetch` goes to the real
 * platform. Scripts are stripped from the markup and injected by hand so the
 * fetch shim exists before the bootstrap IIFE runs.
 */
export function loadWebConsolePage(
  platformUrl: string,
  options: {
    timerScale?: number
    hash?: string
    /** localStorage seeded before the page's bootstrap runs (cached-session cases). */
    storage?: Record<string, string>
    /**
     * U197: when set, every request carries this Origin and a shared cookie jar
     * is maintained, so the page can exercise the real Cookie transport.
     */
    platformOrigin?: string
    cookieJar?: Map<string, string>
    /** Requests that reject at the fetch boundary before the bootstrap runs. */
    abortOnLoad?: string[]
    /** Requests held at the page boundary before the bootstrap runs. */
    holdOnLoad?: string[]
    /** Requests answered by a stub/failure before the bootstrap runs. */
    failOnLoad?: { call: string; status?: number; respond?: { status: number; body: unknown } }[]
  } = {}
): WebConsolePage {
  // Why scale: the ready timeout is 20s; a test needs to observe it (and two
  // retries) without waiting a minute. Default 1 keeps every other suite real.
  const timerScale = options.timerScale ?? 1
  const window = new Window({ url: 'https://web.console.local/' })
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    window.localStorage.setItem(key, value)
  }
  // Seed the deep link before the page runs so its bootstrap parses that URL.
  if (options.hash !== undefined) window.location.hash = options.hash
  const html = readFileSync(join(WEB_SOURCE, 'index.html'), 'utf8')
    // Why strip: the markup's script tags point at the server, not at our shim.
    .replace(/<script[\s\S]*?<\/script>/g, '')
  window.document.documentElement.innerHTML = html

  const realFetch = globalThis.fetch
  const failing = new Map<string, number>()
  const stubbed = new Map<string, { status: number; body: unknown }>()
  const aborted = new Set<string>()
  const requests: string[] = []
  const sentAuth: (string | undefined)[] = []
  const sentStatuses: (number | undefined)[] = []
  const sentHeaders: Headers[] = []
  const cookieJar = options.cookieJar
  const absorbSetCookies = (response: Response): Response => {
    if (!cookieJar) return response
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';')
      const equals = (pair ?? '').indexOf('=')
      if (equals === -1) continue
      const name = (pair ?? '').slice(0, equals).trim()
      const value = (pair ?? '').slice(equals + 1).trim()
      if (name === '') continue
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))
      if (value === '' || expired) cookieJar.delete(name)
      else cookieJar.set(name, value)
    }
    return response
  }
  const outboundInit = (init?: RequestInit): RequestInit | undefined => {
    if (!options.platformOrigin && !cookieJar) return init
    const headers = new Headers(init?.headers)
    if (options.platformOrigin) headers.set('origin', options.platformOrigin)
    if (cookieJar && cookieJar.size > 0) {
      headers.set('cookie', [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    return { ...init, headers }
  }
  const sentBodies: { call: string; body: unknown }[] = []
  const heldPaths = new Set<string>()
  // Pre-seed failures so the bootstrap's own first requests can be faulted.
  for (const call of options.abortOnLoad ?? []) aborted.add(call)
  for (const call of options.holdOnLoad ?? []) heldPaths.add(call)
  for (const entry of options.failOnLoad ?? []) {
    if (entry.respond) stubbed.set(entry.call, entry.respond)
    else failing.set(entry.call, entry.status ?? 503)
  }
  const held = new Map<
    string,
    { input: string; init: RequestInit | undefined; resolve: (response: Response) => void }[]
  >()
  // A `*` suffix matches a path prefix, for endpoints whose query string is
  // computed at click time and cannot be named up front.
  const lookup = <T>(map: Map<string, T>, key: string): T | undefined => {
    if (map.has(key)) return map.get(key)
    for (const [pattern, value] of map) {
      if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) return value
    }
    return undefined
  }
  const fetchToPlatform: typeof fetch = (input, init) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${path}`)
    const callIndex = sentStatuses.push(undefined) - 1
    sentAuth.push(new Headers(init?.headers).get('authorization') ?? undefined)
    sentHeaders.push(new Headers(init?.headers))
    const key = `${method} ${path}`
    if (typeof init?.body === 'string') {
      try {
        sentBodies.push({ call: key, body: JSON.parse(init.body) })
      } catch {
        sentBodies.push({ call: key, body: init.body })
      }
    }
    if (heldPaths.delete(key)) {
      return new Promise((resolve) => {
        const waiters = held.get(key) ?? []
        waiters.push({
          input: `${platformUrl}${path}`,
          init: outboundInit(init),
          resolve: (response) => {
            sentStatuses[callIndex] = response.status
            resolve(response)
          }
        })
        held.set(key, waiters)
      })
    }
    if (aborted.delete(key)) {
      // A rejected fetch, not an HTTP error: the page must handle the transport failure.
      return Promise.reject(new TypeError('fetch failed'))
    }
    const failure = lookup(failing, key)
    const stub = lookup(stubbed, key)
    if (failure !== undefined || stub !== undefined) {
      // An in-page failure exercises the console's own error paths (M116-QA-009/011);
      // a stub replays a payload the live platform cannot produce any more, such as
      // a legacy pre-fix grant row.
      const respond = stub ?? {
        status: failure ?? 503,
        body: { error: { code: 'SIMULATED_FAILURE', message: '模拟平台故障' } }
      }
      const response = new Response(JSON.stringify(respond.body), {
        status: respond.status,
        headers: { 'content-type': 'application/json' }
      })
      sentStatuses[callIndex] = response.status
      return Promise.resolve(response)
    }
    return realFetch(`${platformUrl}${path}`, outboundInit(init)).then((response) => {
      sentStatuses[callIndex] = response.status
      return absorbSetCookies(response)
    })
  }

  // The router is an ES module the browser imports; `new Function` has no module
  // loader, so inline it (export keywords dropped) ahead of the classic app.js.
  const routesSource = readFileSync(join(WEB_SOURCE, 'router/routes.js'), 'utf8').replace(
    /^export /gm,
    ''
  )
  const source = `${routesSource}\n${readFileSync(join(WEB_SOURCE, 'app.js'), 'utf8').replace(
    /^import[^\n]*from '\.\/router\/routes\.js'\n/m,
    ''
  )}`
  // Why Function and not eval: this keeps the page's declarations out of the
  // test module and lets the DOM globals be injected.
  const run = new Function(
    'document',
    'localStorage',
    'fetch',
    'window',
    'navigator',
    'location',
    'confirm',
    'console',
    'setTimeout',
    'clearTimeout',
    'Date',
    'URL',
    'JSON',
    'Promise',
    source
  )
  run(
    window.document,
    window.localStorage,
    fetchToPlatform,
    window,
    window.navigator,
    window.location,
    () => true,
    console,
    (callback: () => void, delay?: number, ...args: unknown[]) =>
      window.setTimeout(callback, Math.round((delay ?? 0) * timerScale), ...args),
    window.clearTimeout.bind(window),
    Date,
    URL,
    JSON,
    Promise
  )

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 40; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  const element = (selector: string): HTMLElement => {
    const found = window.document.querySelector<HTMLElement>(selector)
    if (!found) {
      throw new Error(`missing ${selector}`)
    }
    return found
  }

  return {
    window,
    settle,
    clickNav: async (route) => {
      // The button exists even inside the hidden group, which is exactly the
      // "user forces the route" case the guard has to catch.
      const button = window.document.querySelector<HTMLElement>(`.nav-item[data-route="${route}"]`)
      if (!button) {
        throw new Error(`no nav item for ${route}`)
      }
      button.click()
      await settle()
    },
    submitLogin: async (username, password) => {
      window.document.querySelector<HTMLInputElement>('#username')!.value = username
      window.document.querySelector<HTMLInputElement>('#password')!.value = password
      const form = window.document.querySelector<HTMLFormElement>('#loginForm')!
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      for (let round = 0; round < 40; round += 1) {
        if (!element('#view-app').hidden) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await settle()
    },
    text: (selector) => element(selector).textContent ?? '',
    hidden: (selector) => element(selector).hidden === true,
    fail: (method, path, respond) => {
      const key = `${method.toUpperCase()} ${path}`
      if (respond) {
        stubbed.set(key, respond)
      } else {
        failing.set(key, 503)
      }
    },
    abort: (method, path) => {
      aborted.add(`${method.toUpperCase()} ${path}`)
    },
    clearFails: () => {
      failing.clear()
      stubbed.clear()
      aborted.clear()
    },
    hold: (method, path) => {
      heldPaths.add(`${method.toUpperCase()} ${path}`)
    },
    release: async () => {
      const pending: Promise<void>[] = []
      for (const waiters of held.values()) {
        for (const waiter of waiters.splice(0)) {
          pending.push(
            realFetch(waiter.input, waiter.init)
              .catch(() => new Response(null, { status: 503 }))
              .then((response) => waiter.resolve(absorbSetCookies(response)))
          )
        }
      }
      held.clear()
      await Promise.all(pending)
      await new Promise((resolve) => setTimeout(resolve, 25))
    },
    calls: () => [...requests],
    statuses: () => [...sentStatuses],
    authHeaders: () => [...sentAuth],
    headerValues: (name) => sentHeaders.map((headers) => headers.get(name) ?? undefined),
    bodies: () => [...sentBodies]
  }
}
