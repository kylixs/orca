// @vitest-environment happy-dom
/**
 * The Android-effective half of the scheme policy.
 *
 * These cases dispatch real click/submit events through the injected script, rather than calling
 * `onShouldStartLoadWithRequest` directly. That distinction is the finding: Android never delivers
 * a tapped `javascript:` link to the callback, so a test that only calls the callback cannot catch
 * the escape.
 *
 * Each case gets a fresh happy-dom `Window` so the fence's per-document state (guard, notification
 * throttle, MutationObserver) cannot leak between cases.
 */
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE,
  HTML_PREVIEW_INTERCEPTION_SCRIPT
} from './html-preview-interception'
import { htmlPreviewNavigationDecision } from './html-preview-scheme'

declare global {
  interface Window {
    __orcaHtmlPreviewInterception?: string
    __orcaPageListenerRan?: boolean
    ReactNativeWebView?: { postMessage: (message: string) => void }
  }
}

let postMessage: ReturnType<typeof vi.fn<(message: string) => void>>

function makeWindow(prepare?: (window: Window) => void): Window {
  const win = new Window({ url: 'about:blank' })
  postMessage = vi.fn()
  win.ReactNativeWebView = { postMessage: (message) => postMessage(message) }
  prepare?.(win)
  win.eval(HTML_PREVIEW_INTERCEPTION_SCRIPT)
  return win
}

/** A frame window whose parent never runs the fence: the document-start equivalent is absent. */
function makeSubframeWindow(prepare?: (window: Window) => void): Window {
  const parent = new Window({ url: 'about:blank' })
  const frame = parent.document.createElement('iframe')
  parent.document.body.append(frame)
  const win = frame.contentWindow
  if (!win) {
    throw new Error('happy-dom did not create a frame window')
  }
  postMessage = vi.fn()
  win.ReactNativeWebView = { postMessage: (message) => postMessage(message) }
  prepare?.(win)
  win.eval(HTML_PREVIEW_INTERCEPTION_SCRIPT)
  return win
}

// The fence runs inside its own happy-dom Window, whose timers/Date are not the Node globals that
// Vitest's fake timers replace. Wait on real time; the debounce is 50 ms and the notification
// throttle is 400 ms.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Let the MutationObserver deliver the mutation and run the debounced sweep. */
async function flushMetaSweep(): Promise<void> {
  await wait(120)
}

function click(element: Element): MouseEvent {
  const win = element.ownerDocument.defaultView
  if (!win) {
    throw new Error('fixture element has no window')
  }
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  return event
}

function link(win: Window, html: string): HTMLAnchorElement {
  win.document.body.innerHTML = html
  const anchor = win.document.querySelector('a')
  if (!anchor) {
    throw new Error('fixture has no anchor')
  }
  return anchor
}

beforeEach(() => {
  postMessage = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the injected HTML preview scheme fence', () => {
  it('cancels a tapped javascript: link instead of letting the WebView execute it', () => {
    const win = makeWindow()
    const alert = vi.fn()
    win.alert = alert
    const anchor = link(win, '<a id="bad" href="javascript:alert(1)">run</a>')

    const event = click(anchor)

    expect(event.defaultPrevented).toBe(true)
    expect(alert).not.toHaveBeenCalled()
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('cancels file:, intent:, tel: and custom app schemes', async () => {
    const win = makeWindow()
    for (const href of [
      'file:///etc/passwd',
      'intent://scan#Intent;scheme=zxing;end',
      'tel:+15551234',
      'orca://deep/link',
      'my-app://open'
    ]) {
      const anchor = link(win, `<a href="${href}">x</a>`)
      const event = click(anchor)
      expect(event.defaultPrevented, href).toBe(true)
      await wait(450)
    }
    expect(postMessage).toHaveBeenCalledTimes(5)
    for (const [message] of postMessage.mock.calls) {
      expect(message).toBe(HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE)
    }
  })

  it('lets http, https and mailto through to the native callback unchanged', () => {
    for (const href of ['https://example.com/a', 'http://example.com/b', 'mailto:a@example.com']) {
      const win = makeWindow()
      const anchor = link(win, `<a href="${href}">x</a>`)
      expect(click(anchor).defaultPrevented, href).toBe(false)
      expect(postMessage, href).not.toHaveBeenCalled()
    }
  })

  it('does not treat inline documents, fragments or empty hrefs as blocked', () => {
    // A fresh window per href: an allowed click in happy-dom performs the navigation, which would
    // drop the listeners and make the next case pass for the wrong reason.
    for (const href of ['about:blank#section', 'data:text/html,hi', '#section', '']) {
      const win = makeWindow()
      const anchor = link(win, `<a href="${href}">x</a>`)
      expect(click(anchor).defaultPrevented, href).toBe(false)
      expect(postMessage, href).not.toHaveBeenCalled()
    }
  })

  it('finds the link when the tap lands on a child element', () => {
    const win = makeWindow()
    link(win, '<a href="javascript:alert(1)"><span id="label">tap</span></a>')
    const label = win.document.getElementById('label')
    if (!label) {
      throw new Error('fixture has no child')
    }

    expect(click(label).defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('covers anchors added after the page loaded', () => {
    const win = makeWindow()
    const anchor = win.document.createElement('a')
    anchor.setAttribute('href', 'javascript:alert(1)')
    win.document.body.append(anchor)

    expect(click(anchor).defaultPrevented).toBe(true)
  })

  it('fences a dynamically written about:blank frame that never navigates', async () => {
    // document-start never runs in a frame that is created as about:blank and filled with
    // document.write, so the parent's fence adopts the same-origin child from its mutation.
    const win = makeWindow()
    const frame = win.document.createElement('iframe')
    win.document.body.append(frame)
    const child = frame.contentWindow
    if (!child) {
      throw new Error('happy-dom did not create a frame window')
    }
    child.document.write('<a id="frame-js" href="javascript:void(0)">run</a>')
    child.document.close()

    // Wait for the parent's MutationObserver microtask, not the 50 ms debounced sweep.
    await wait(0)

    expect(child.__orcaHtmlPreviewInterception).toBe('v2')
    const anchor = child.document.querySelector('a')
    if (!anchor) {
      throw new Error('the frame document lost its link')
    }
    const event = new child.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    // document.open() removes document listeners but not the window capture listener.
    child.document.open()
    child.document.write('<a id="rewritten" href="javascript:void(0)">run</a>')
    child.document.close()
    const rewritten = child.document.querySelector('a')
    if (!rewritten) {
      throw new Error('the rewritten frame document lost its link')
    }
    const rewrittenEvent = new child.MouseEvent('click', { bubbles: true, cancelable: true })
    rewritten.dispatchEvent(rewrittenEvent)
    expect(rewrittenEvent.defaultPrevented).toBe(true)
  })

  it('runs the stringified installer in an adopted about:blank frame without closure state', async () => {
    // Cross-realm regression: adoptFrame copies `install` through Function.prototype.toString into
    // the child window, so any parent-closure constant becomes a ReferenceError there. This covers
    // a blocked click and a positive-delay blocked meta followed by a 0-delay one in the same task.
    const win = makeWindow()
    const errors: string[] = []
    const frame = win.document.createElement('iframe')
    win.document.body.append(frame)
    const child = frame.contentWindow
    if (!child) {
      throw new Error('happy-dom did not create a frame window')
    }
    const childPost = vi.fn<(message: string) => void>()
    child.ReactNativeWebView = { postMessage: (message) => childPost(message) }
    const recordError = (event: Event): void => {
      errors.push('message' in event ? String(event.message) : String(event.type))
    }
    child.addEventListener('error', recordError)
    win.addEventListener('error', recordError)

    child.document.write('<a id="frame-js" href="javascript:void(0)">run</a>')
    child.document.close()
    // Wait for the parent's adoption microtask, not the 50 ms debounced sweep.
    await wait(0)
    expect(child.__orcaHtmlPreviewInterception).toBe('v2')

    const anchor = child.document.querySelector('a')
    if (!anchor) {
      throw new Error('the frame document lost its link')
    }
    const event = new child.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await wait(20)
    expect(childPost.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
    expect(errors).toEqual([])

    // Let the 400 ms notification throttle expire, then insert both metas in one task. The first
    // notification schedules a 1 s toast; that must not abort the observer before the 0 s node.
    await wait(450)
    const delayed = child.document.createElement('meta')
    delayed.setAttribute('http-equiv', 'refresh')
    delayed.setAttribute('content', '1;url=file:///etc/passwd')
    const immediate = child.document.createElement('meta')
    immediate.setAttribute('http-equiv', 'refresh')
    immediate.setAttribute('content', '0;url=file:///etc/passwd')
    child.document.head.append(delayed)
    child.document.head.append(immediate)

    // Both are removed in the observer microtask, well before the 50 ms debounced sweep.
    await Promise.resolve()
    expect(delayed.isConnected).toBe(false)
    expect(immediate.isConnected).toBe(false)
    await wait(20)
    expect(childPost.mock.calls).toHaveLength(2)
    expect(childPost.mock.calls[1]).toEqual([HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE])
    expect(errors).toEqual([])
  })

  it('documents the pre-adoption ordering limit for synchronously written frame script', async () => {
    // Residual, not a guarantee: document.write runs before the parent's observer microtask, so an
    // inline script written into the frame can register its window-capture listener first and
    // pre-empt the adopted fence (or tamper with eval). This fixture pins that known limit.
    const win = makeWindow()
    const frame = win.document.createElement('iframe')
    win.document.body.append(frame)
    const child = frame.contentWindow
    if (!child) {
      throw new Error('happy-dom did not create a frame window')
    }
    child.document.write('<a id="late" href="javascript:alert(1)">run</a>')
    child.document.close()
    // happy-dom does not execute document.write inline scripts. Run the equivalent script
    // synchronously instead, i.e. in the same task before the parent's adoption microtask.
    child.eval(
      'window.addEventListener("click", function (event) {' +
        'window.__orcaPageListenerRan = true; event.stopImmediatePropagation()' +
        '}, true)'
    )

    await wait(0)
    expect(child.__orcaHtmlPreviewInterception).toBe('v2')
    const anchor = child.document.querySelector('a')
    if (!anchor) {
      throw new Error('the frame document lost its link')
    }
    const event = new child.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)

    // The page listener ran first, so the fence never saw the click. The native/engine boundary is
    // what still refuses the javascript: navigation in production.
    expect(child.__orcaPageListenerRan).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('still wins when the page adds a window-capture stopPropagation listener', () => {
    // Ordering is the contract: the fence is a document-start script, so its window capture
    // listener is registered before any page script. A page listener added later never runs.
    const win = makeWindow()
    const pageListener = vi.fn((event: Event) => {
      event.stopPropagation()
      event.stopImmediatePropagation()
    })
    win.addEventListener('click', pageListener, true)
    const anchor = link(win, '<a href="javascript:alert(1)">run</a>')

    const event = click(anchor)

    expect(event.defaultPrevented).toBe(true)
    expect(pageListener).not.toHaveBeenCalled()
  })

  it('registers click and submit on window capture before document fallbacks', () => {
    const win = new Window({ url: 'about:blank' })
    const windowAdd = vi.spyOn(win, 'addEventListener')
    const documentAdd = vi.spyOn(win.document, 'addEventListener')
    const captures = (
      target: 'window' | 'document',
      spy: typeof windowAdd
    ): Array<{ target: string; type: string; capture: unknown }> =>
      spy.mock.calls
        .filter(([type]) => type === 'click' || type === 'submit')
        .map(([type, , options]) => ({ target, type, capture: options }))

    win.eval(HTML_PREVIEW_INTERCEPTION_SCRIPT)

    expect([...captures('window', windowAdd), ...captures('document', documentAdd)]).toEqual([
      { target: 'window', type: 'click', capture: true },
      { target: 'window', type: 'submit', capture: true },
      { target: 'document', type: 'click', capture: true },
      { target: 'document', type: 'submit', capture: true }
    ])
  })

  it('is not disabled by a page-writable pre-seeded flag', () => {
    const win = makeWindow((window) => {
      window.__orcaHtmlPreviewInterception = 'true'
    })

    const descriptor = Object.getOwnPropertyDescriptor(win, '__orcaHtmlPreviewInterception')
    expect(descriptor).toMatchObject({ value: 'v2', writable: false, configurable: false })
    const anchor = win.document.createElement('a')
    anchor.setAttribute('href', 'javascript:alert(1)')
    win.document.body.append(anchor)
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('installs even when the page pre-defines the exact non-configurable guard', () => {
    // The fallback pass (onPageStarted on WebView < 89) runs after page script, so an exact-value
    // pre-seed must never be treated as "already installed". Duplicate listeners are harmless.
    const win = makeWindow((window) => {
      Object.defineProperty(window, '__orcaHtmlPreviewInterception', {
        value: 'v2',
        writable: false,
        configurable: false
      })
    })

    const anchor = link(win, '<a href="javascript:alert(1)">run</a>')
    const event = click(anchor)

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('installs anyway when a page pre-defines a non-configurable flag', () => {
    // Best effort: the page cannot disable the fence; the cost is a duplicate listener if the
    // post-load pass runs again, which still cancels the event.
    const win = makeWindow((window) => {
      Object.defineProperty(window, '__orcaHtmlPreviewInterception', {
        value: 'poisoned',
        writable: false,
        configurable: false
      })
    })

    const anchor = win.document.createElement('a')
    anchor.setAttribute('href', 'javascript:alert(1)')
    win.document.body.append(anchor)
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('cancels a form submission to a blocked scheme', () => {
    const win = makeWindow()
    win.document.body.innerHTML =
      '<form action="file:///etc/passwd"><button type="submit">go</button></form>'
    const form = win.document.querySelector('form')
    if (!form) {
      throw new Error('fixture has no form')
    }

    const event = new win.Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('checks the submitter formaction in preference to the form action', () => {
    const win = makeWindow()
    win.document.body.innerHTML =
      '<form action="data:text/html,ok"><button type="submit" formaction="javascript:alert(1)">go</button></form>'
    const form = win.document.querySelector('form')
    const button = win.document.querySelector('button')
    if (!form || !button) {
      throw new Error('fixture is incomplete')
    }

    const event = new win.SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      submitter: button
    })
    form.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('allows a submitter formaction that overrides a blocked form action', () => {
    const win = makeWindow()
    win.document.body.innerHTML =
      '<form action="file:///etc/passwd"><button type="submit" formaction="https://example.com/x">go</button></form>'
    const form = win.document.querySelector('form')
    const button = win.document.querySelector('button')
    if (!form || !button) {
      throw new Error('fixture is incomplete')
    }

    const event = new win.SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      submitter: button
    })
    form.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('throttles repeated blocked notifications from one document', async () => {
    const win = makeWindow()
    const first = link(win, '<a href="file:///etc/passwd">a</a>')
    click(first)
    const second = win.document.createElement('a')
    second.setAttribute('href', 'tel:+15551234')
    win.document.body.append(second)
    click(second)

    expect(postMessage).toHaveBeenCalledTimes(1)

    await wait(450)
    const third = win.document.createElement('a')
    third.setAttribute('href', 'intent://scan#Intent;end')
    win.document.body.append(third)
    click(third)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('is idempotent when injected before and after load', () => {
    const win = makeWindow()
    win.eval(HTML_PREVIEW_INTERCEPTION_SCRIPT)
    const anchor = link(win, '<a href="javascript:alert(1)">x</a>')

    click(anchor)

    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('the injected meta-refresh fence', () => {
  it('removes a refresh to a blocked scheme and reports it after its delay', async () => {
    const win = makeWindow()
    win.document.head.innerHTML =
      '<meta http-equiv="refresh" content="2;url=file:///etc/passwd"><meta charset="utf-8">'
    await flushMetaSweep()

    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
    expect(win.document.querySelector('meta[charset]')).not.toBeNull()
    expect(postMessage).not.toHaveBeenCalled()

    await wait(2100)
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('parses case, spacing, attribute order and quoted URLs', async () => {
    const win = makeWindow()
    win.document.head.innerHTML =
      '<META CONTENT="0 ; URL = \'intent://scan#Intent;end\'" HTTP-EQUIV="Refresh">'
    await flushMetaSweep()

    expect(win.document.querySelector('meta')).toBeNull()
    await wait(50)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('accepts a quoted URL with trailing text, as the browser parser does', async () => {
    // Parity: the HTML spec stops a quoted refresh URL at the closing quote, so trailing text is
    // not part of the URL and must not turn an allowed target into a blocked one.
    const win = makeWindow()
    win.document.head.innerHTML =
      '<meta http-equiv="refresh" content=\'0;url="https://example.com/next" extra\'>'
    await flushMetaSweep()

    expect(win.document.querySelector('meta[http-equiv]')).not.toBeNull()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('leaves an http(s) refresh to the native navigation callback', async () => {
    const win = makeWindow()
    win.document.head.innerHTML =
      '<meta http-equiv="refresh" content="1;url=https://example.com/next">'
    await flushMetaSweep()

    expect(win.document.querySelector('meta[http-equiv]')).not.toBeNull()
  })

  it('does not report a same-document refresh', async () => {
    const win = makeWindow()
    win.document.head.innerHTML = '<meta http-equiv="refresh" content="5">'
    await flushMetaSweep()

    expect(win.document.querySelector('meta[http-equiv]')).not.toBeNull()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('removes a newly added 0-delay blocked refresh before the debounced sweep', async () => {
    const win = makeWindow()
    const meta = win.document.createElement('meta')
    meta.setAttribute('http-equiv', 'refresh')
    meta.setAttribute('content', '0;url=file:///etc/passwd')
    win.document.head.append(meta)

    // One microtask flushes the MutationObserver; the debounced full scan is still 50 ms away.
    await Promise.resolve()

    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
    await wait(20)
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('removes a meta whose content is set after insertion', async () => {
    // A page may append the element first and set content afterwards; the browser accepts the
    // attribute change, so childList alone cannot see the refresh.
    const win = makeWindow()
    const meta = win.document.createElement('meta')
    meta.setAttribute('http-equiv', 'refresh')
    win.document.head.append(meta)
    await Promise.resolve()

    meta.setAttribute('content', '0;url=file:///etc/passwd')
    await Promise.resolve()

    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
    await wait(20)
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])

    // The debounced backstop still finds nothing to remove.
    await flushMetaSweep()
    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
  })

  it('removes a meta whose http-equiv is set after insertion', async () => {
    const win = makeWindow()
    const meta = win.document.createElement('meta')
    meta.setAttribute('content', '0;url=file:///etc/passwd')
    win.document.head.append(meta)
    await Promise.resolve()
    expect(meta.isConnected).toBe(true)

    meta.setAttribute('http-equiv', 'refresh')
    await Promise.resolve()

    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
    await wait(20)
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('removes a blocked meta again when the page re-appends the removed node', async () => {
    const win = makeWindow()
    const meta = win.document.createElement('meta')
    meta.setAttribute('http-equiv', 'refresh')
    meta.setAttribute('content', '0;url=file:///etc/passwd')
    win.document.head.append(meta)
    await Promise.resolve()
    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()

    // The observer already removed this exact node; the WeakSet must not exempt it from removal.
    win.document.head.append(meta)
    await Promise.resolve()
    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()

    // The 50 ms debounced scan finds nothing left either.
    await flushMetaSweep()
    expect(win.document.querySelector('meta[http-equiv]')).toBeNull()
    // One notification for the node, not one per insertion.
    expect(postMessage.mock.calls).toEqual([[HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE]])
  })

  it('debounces a burst of mutations into one sweep', async () => {
    const win = makeWindow()
    const sweepSpy = vi.spyOn(win.document, 'querySelectorAll')
    for (let i = 0; i < 20; i += 1) {
      const meta = win.document.createElement('meta')
      meta.setAttribute('http-equiv', 'refresh')
      meta.setAttribute('content', '0;url=https://example.com/x')
      win.document.head.append(meta)
    }

    await flushMetaSweep()

    expect(
      sweepSpy.mock.calls.filter(([selector]) => selector === 'meta[http-equiv]')
    ).toHaveLength(1)
  })
})

describe('DOM/native scheme parity', () => {
  // The two implementations remain separate (the DOM runs in the page, the native policy in RN),
  // but their block/allow verdict must agree for every absolute form the browser can resolve.
  it('agrees with htmlPreviewNavigationDecision on blockable URLs', () => {
    const urls = [
      'about:blank',
      'about:blank#section',
      'about:blankfoo',
      'about:blank?x',
      'about:srcdoc',
      'data:text/html,hi',
      'https://example.com/',
      'mailto:a@example.com',
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'tel:+15551234',
      'blob:https://example.com/id',
      'my-app://open',
      'javascript:alert(1)'
    ]

    for (const url of urls) {
      // Fresh window per URL: an allowed navigation replaces the document in happy-dom.
      const win = makeWindow()
      const anchor = win.document.createElement('a')
      anchor.setAttribute('href', url)
      win.document.body.append(anchor)
      const event = new win.MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      const domBlocked = event.defaultPrevented
      const nativeBlocked = htmlPreviewNavigationDecision({ url, isTopFrame: true }) === 'block'
      expect(domBlocked, url).toBe(nativeBlocked)
    }
  })

  it('agrees with the native policy for subframes, including about:srcdoc and external-app schemes', () => {
    // The native subframe rule allows only http(s), data: and inline about: documents; the DOM
    // fence must both allow the same targets and block mailto:/tel:/blob:/app schemes (the subframe
    // sentinel is dropped, so drift is silent, and an unreported frame keeps the top-frame rule).
    const urls = [
      'about:blank',
      'about:blank#section',
      'about:srcdoc',
      'about:blankfoo',
      'data:text/html,hi',
      'https://example.com/',
      'http://example.com/',
      'mailto:a@example.com',
      'tel:+15551234',
      'blob:https://example.com/id',
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'orca://deep/link',
      'javascript:alert(1)'
    ]

    for (const url of urls) {
      const win = makeSubframeWindow()
      const anchor = win.document.createElement('a')
      anchor.setAttribute('href', url)
      win.document.body.append(anchor)
      const event = new win.MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      const domBlocked = event.defaultPrevented
      const nativeBlocked = htmlPreviewNavigationDecision({ url, isTopFrame: false }) === 'block'
      expect(domBlocked, url).toBe(nativeBlocked)
    }
  })

  it('blocks mailto, tel, blob and app schemes in a subframe but lets mailto leave from the top', () => {
    for (const url of [
      'mailto:a@example.com',
      'tel:+15551234',
      'blob:https://example.com/id',
      'orca://deep/link'
    ]) {
      const top = makeWindow()
      const topAnchor = top.document.createElement('a')
      topAnchor.setAttribute('href', url)
      top.document.body.append(topAnchor)
      const topEvent = new top.MouseEvent('click', { bubbles: true, cancelable: true })
      topAnchor.dispatchEvent(topEvent)

      const sub = makeSubframeWindow()
      const subAnchor = sub.document.createElement('a')
      subAnchor.setAttribute('href', url)
      sub.document.body.append(subAnchor)
      const subEvent = new sub.MouseEvent('click', { bubbles: true, cancelable: true })
      subAnchor.dispatchEvent(subEvent)

      // Top-frame mailto is handed to the host; every one of these is blocked inside a frame.
      expect(topEvent.defaultPrevented, `top ${url}`).toBe(url !== 'mailto:a@example.com')
      expect(subEvent.defaultPrevented, `sub ${url}`).toBe(true)
    }
  })
})
