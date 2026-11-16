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
}

/**
 * Loads the real index.html and app.js into a DOM whose `fetch` goes to the real
 * platform. Scripts are stripped from the markup and injected by hand so the
 * fetch shim exists before the bootstrap IIFE runs.
 */
export function loadWebConsolePage(
  platformUrl: string,
  options: { timerScale?: number } = {}
): WebConsolePage {
  // Why scale: the ready timeout is 20s; a test needs to observe it (and two
  // retries) without waiting a minute. Default 1 keeps every other suite real.
  const timerScale = options.timerScale ?? 1
  const window = new Window({ url: 'https://web.console.local/' })
  const html = readFileSync(join(WEB_SOURCE, 'index.html'), 'utf8')
    // Why strip: the markup's script tags point at the server, not at our shim.
    .replace(/<script[\s\S]*?<\/script>/g, '')
  window.document.documentElement.innerHTML = html

  const realFetch = globalThis.fetch
  const failing = new Map<string, number>()
  const stubbed = new Map<string, { status: number; body: unknown }>()
  const requests: string[] = []
  const heldPaths = new Set<string>()
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
    const key = `${method} ${path}`
    if (heldPaths.delete(key)) {
      return new Promise((resolve) => {
        const waiters = held.get(key) ?? []
        waiters.push({ input: `${platformUrl}${path}`, init, resolve })
        held.set(key, waiters)
      })
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
      return Promise.resolve(
        new Response(JSON.stringify(respond.body), {
          status: respond.status,
          headers: { 'content-type': 'application/json' }
        })
      )
    }
    return realFetch(`${platformUrl}${path}`, init)
  }

  const source = readFileSync(join(WEB_SOURCE, 'app.js'), 'utf8')
  // Why Function and not eval: app.js is a classic script; this keeps its
  // declarations out of the test module and lets the DOM globals be injected.
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
    clearFails: () => {
      failing.clear()
      stubbed.clear()
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
              .then((response) => waiter.resolve(response))
          )
        }
      }
      held.clear()
      await Promise.all(pending)
      await new Promise((resolve) => setTimeout(resolve, 25))
    },
    calls: () => [...requests]
  }
}
