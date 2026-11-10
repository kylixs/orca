import { HTML_PREVIEW_EXTERNAL_SCHEMES } from './html-preview-scheme'

/**
 * Why this exists: Android's WebView executes a tapped `javascript:` link itself instead of
 * delivering it to `onShouldStartLoadWithRequest`, so the native policy alone cannot stop it. The
 * injected script mirrors that policy at the DOM: it cancels a tap on a link (or form submit) whose
 * scheme is outside the preview whitelist, and neutralises a `meta refresh` to the same schemes.
 *
 * The fence must be installed before any page script runs: it registers its listeners on `window`
 * capture, and only the first registration of a target/phase wins. On Android the native patch
 * installs this source as a document-start script (see `react-native-webview` patch); iOS uses
 * `WKUserScript` at document start.
 *
 * The only page-originated message the host accepts is this fixed sentinel. It carries no URL and
 * runs no host action -- at most it raises the existing "not supported" toast. A page script can
 * post it; that is a spurious toast, not a capability.
 */
export const HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE = 'orca:html-preview:blocked-scheme'

export function isHtmlPreviewBlockedMessage(payload: unknown): boolean {
  return payload === HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE
}

/**
 * Source for `injectedJavaScriptBeforeContentLoaded` (and a second, idempotent pass after load).
 *
 * The whitelist is interpolated from `HTML_PREVIEW_EXTERNAL_SCHEMES` so the DOM fence and the
 * navigation callback cannot drift. Everything else -- `file:`, `intent:`, `javascript:`, `tel:`,
 * custom app schemes, and relative targets -- is cancelled and reported. `http(s)`/`mailto` still
 * fall through to the native callback, which hands them to the host exactly as before.
 *
 * Same-context limits are explicit: `form.submit()` fires no `submit` event, and page script can
 * still call `location.href` (the native callback or the engine owns those). The guard marker is
 * diagnostics/tests only and is never trusted to skip installation; a page can still replace
 * `Event.prototype.preventDefault`, so the native scheme policy remains the external boundary.
 *
 * `meta refresh` is parsed with DOM APIs rather than a string rewrite, so page markup is never
 * reserialised. A newly added blocked meta, or one whose `http-equiv`/`content` changes after
 * insertion, is removed synchronously in the MutationObserver callback, before a 0-delay refresh
 * task; the 50 ms debounced full scan is only a backstop. A removed node that the page re-appends is
 * removed again (the WeakSet only suppresses a duplicate notification).
 *
 * Dynamic `about:blank` frames never navigate, so document-start never runs in them. Same-origin
 * parent documents adopt such frames (and their future document.write documents) by evaluating
 * this installer in the child window. Content written synchronously before that adoption microtask
 * runs first: an inline script there can register a pre-empting listener or tamper with the child's
 * eval. That ordering limit is documented and covered by a test; it is not claimed away.
 */
export const HTML_PREVIEW_INTERCEPTION_SCRIPT = `(function () {
  'use strict';
  var BLOCKED = '${HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE}';
  var ALLOWED = ${JSON.stringify(HTML_PREVIEW_EXTERNAL_SCHEMES)};

  function install(blockedMessage, allowedSchemes) {
  var GUARD = '__orcaHtmlPreviewInterception';
  var GUARD_VERSION = 'v2';
  // Everything install reads must live inside it: adoptFrame copies this function through
  // Function.prototype.toString into a child window, where the parent's closure does not exist.
  var SUBFRAME_ALLOWED = ['http:', 'https:'];
  var MAX_TIMER_MS = 2147483647;
  var NOTIFY_THROTTLE_MS = 400;
  var lastNotifyAt = 0;
  var handled = typeof WeakSet === 'function' ? new WeakSet() : null;
  var blockedMetas = typeof WeakSet === 'function' ? new WeakSet() : null;
  try {
    // Why: writable+configurable would let page script hide the marker.
    Object.defineProperty(window, GUARD, {
      value: GUARD_VERSION,
      writable: false,
      enumerable: false,
      configurable: false
    });
  } catch (error) {}
  // Why: never return on an existing marker. On the onPageStarted fallback the page runs first and
  // can forge the exact descriptor; skipping installation would disable the fence. Duplicate
  // installs are harmless: the first cancellation stops immediate propagation to later listeners.

  function notify() {
    var now = Date.now();
    if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) return;
    lastNotifyAt = now;
    try {
      var bridge = window.ReactNativeWebView;
      if (bridge && typeof bridge.postMessage === 'function') {
        bridge.postMessage(blockedMessage);
      }
    } catch (error) {}
  }

  function bareDocumentUrl(value) {
    return value.split('#')[0].toLowerCase();
  }

  var isSubframe = false;
  try {
    isSubframe = window.top !== window;
  } catch (error) {
    isSubframe = true;
  }

  function isBlocked(value) {
    var href = String(value == null ? '' : value).trim();
    if (!href) return false;
    var resolved;
    try {
      // Resolve first: a bare '#section' is an about:blank#section navigation, not an about: URL.
      resolved = new URL(href, document.baseURI);
    } catch (error) {
      return true;
    }
    var protocol = resolved.protocol.toLowerCase();
    if (isSubframe) {
      // Mirror the native subframe rule (SUBFRAME_SCHEMES + isInlineDocument): a frame may render
      // http(s), data: and inline about: documents; every other scheme is blocked here. The
      // Android patch now passes isTopFrame, so the native callback applies the same rule if a
      // navigation still reaches it.
      if (protocol === 'data:') return false;
      if (protocol === 'about:') {
        var subBare = bareDocumentUrl(resolved.href);
        return !(subBare === 'about:blank' || subBare === 'about:srcdoc');
      }
      return SUBFRAME_ALLOWED.indexOf(protocol) === -1;
    }
    if (allowedSchemes.indexOf(protocol) !== -1) return false;
    if (protocol === 'data:') return false;
    if (protocol === 'about:') {
      var bare = bareDocumentUrl(resolved.href);
      // Match the native policy: about:blank (with any fragment) is always inline; about:srcdoc is
      // inline only in a subframe (isInlineSubframeDocument).
      return !(bare === 'about:blank');
    }
    return true;
  }

  function linkFor(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (var i = 0; i < path.length; i += 1) {
      var node = path[i];
      if (node && node.tagName && /^(a|area)$/i.test(node.tagName)) return node;
    }
    var target = event.target;
    return target && typeof target.closest === 'function'
      ? target.closest('a[href], area[href]')
      : null;
  }

  function hrefOf(link) {
    return link.getAttribute('href') ||
      link.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  }

  function cancel(event) {
    event.preventDefault();
    // Why immediate: page handlers registered on window capture after ours must not observe or
    // re-enable the event; this is what makes the fence independent of same-context pre-emption.
    event.stopImmediatePropagation();
    notify();
  }

  function firstVisit(event) {
    if (!handled) return true;
    if (handled.has(event)) return false;
    handled.add(event);
    return true;
  }

  function onClick(event) {
    if (!firstVisit(event)) return;
    var link = linkFor(event);
    if (link && isBlocked(hrefOf(link))) cancel(event);
  }

  function onSubmit(event) {
    if (!firstVisit(event)) return;
    var form = event.target;
    if (!form || typeof form.getAttribute !== 'function') return;
    var submitter = event.submitter;
    var action;
    if (submitter && typeof submitter.hasAttribute === 'function' && submitter.hasAttribute('formaction')) {
      action = submitter.getAttribute('formaction');
    } else if (submitter && typeof submitter.formAction === 'string' && submitter.formAction) {
      action = submitter.formAction;
    } else {
      action = form.getAttribute('action');
    }
    // Why: form.submit() dispatches no submit event; that navigation is left to the native policy.
    if (isBlocked(action)) cancel(event);
  }

  // window capture is the earliest point a document can observe; document capture is the fallback
  // when an event is dispatched on a target that never reaches window.
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);

  function refreshTarget(content) {
    var separator = content.indexOf(';');
    if (separator < 0) return '';
    var match = /^\\s*url\\s*=\\s*([\\s\\S]*)$/i.exec(content.slice(separator + 1));
    if (!match) return '';
    var url = match[1].trim();
    var quote = url.charAt(0);
    if (quote === '"' || quote === "'") {
      // Match the HTML spec: a quoted URL ends at the next quote; trailing text is not part of it.
      var end = url.indexOf(quote, 1);
      url = (end < 0 ? url.slice(1) : url.slice(1, end)).trim();
    }
    return url;
  }

  function refreshDelay(content) {
    var separator = content.indexOf(';');
    var seconds = parseInt((separator < 0 ? content : content.slice(0, separator)).trim(), 10);
    if (!isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds * 1000, MAX_TIMER_MS);
  }

  function isRefreshMeta(node) {
    return !!node && node.nodeType === 1 &&
      String(node.tagName || '').toLowerCase() === 'meta' &&
      String(node.getAttribute('http-equiv') || '').trim().toLowerCase() === 'refresh';
  }

  function removeBlockedMeta(meta) {
    if (!isRefreshMeta(meta)) return false;
    var content = meta.getAttribute('content') || '';
    var target = refreshTarget(content);
    if (!isBlocked(target)) return false;
    // Why not skip on the WeakSet: the page can remove the node and re-append it. The set only
    // prevents a second notification for the same node, never a second removal.
    var first = !(blockedMetas && blockedMetas.has(meta));
    if (first && blockedMetas) blockedMetas.add(meta);
    if (meta.parentNode) meta.parentNode.removeChild(meta);
    if (first) setTimeout(notify, refreshDelay(content));
    return true;
  }

  function sweepMetaRefresh(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var metas = root.querySelectorAll('meta[http-equiv]');
    for (var i = 0; i < metas.length; i += 1) {
      removeBlockedMeta(metas[i]);
    }
  }

  function sweep() {
    sweepMetaRefresh(document);
  }

  // Why: a frame created as about:blank and filled with document.write never navigates, so no
  // document-start script runs in it. A same-origin parent evaluates this installer in the child;
  // cross-origin frames and a CSP that forbids eval stay unfenced (engine remains the boundary).
  var adoptedFrames = typeof WeakSet === 'function' ? new WeakSet() : null;
  function adoptFrame(frame) {
    var child = null;
    try {
      child = frame.contentWindow;
    } catch (error) {
      return;
    }
    if (!child || child === window) return;
    if (adoptedFrames && adoptedFrames.has(child)) return;
    try {
      child.eval('(' + install.toString() + ')(' +
        JSON.stringify(blockedMessage) + ',' + JSON.stringify(allowedSchemes) + ')');
      if (adoptedFrames) adoptedFrames.add(child);
    } catch (error) {}
  }

  function adoptFrames(root) {
    if (!root) return;
    if (root.tagName && String(root.tagName).toLowerCase() === 'iframe') adoptFrame(root);
    if (typeof root.querySelectorAll !== 'function') return;
    var frames = root.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      adoptFrame(frames[i]);
    }
  }

  if (typeof MutationObserver === 'function') {
    var sweepTimer = null;
    var observer = new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r += 1) {
        var record = records[r];
        // Why attributes: the page can append the element first and set http-equiv/content later.
        // Watching only childList would never see the refresh target.
        if (record.type === 'attributes') {
          removeBlockedMeta(record.target);
          continue;
        }
        var added = record.addedNodes;
        for (var a = 0; a < added.length; a += 1) {
          var node = added[a];
          // Why synchronous: a 0-delay refresh is due in a later task; waiting for the debounced
          // full scan would lose that race.
          if (isRefreshMeta(node)) {
            removeBlockedMeta(node);
          } else if (node && typeof node.querySelectorAll === 'function') {
            var metas = node.querySelectorAll('meta[http-equiv]');
            for (var m = 0; m < metas.length; m += 1) {
              removeBlockedMeta(metas[m]);
            }
          }
          adoptFrames(node);
        }
      }
      // Debounce the full scan: a page can insert thousands of nodes in one task.
      if (sweepTimer !== null) return;
      sweepTimer = setTimeout(function () {
        sweepTimer = null;
        sweep();
      }, 50);
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['http-equiv', 'content']
    });
  }
  document.addEventListener('DOMContentLoaded', sweep, true);
  sweep();
  adoptFrames(document);
  }

  install(BLOCKED, ALLOWED);
})();`
