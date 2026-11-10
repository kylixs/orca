/**
 * The scheme policy for the HTML preview's WebView, kept apart from `openExternalLink` so that
 * opening a link from anywhere else keeps its existing pass-through contract.
 *
 * Top-frame navigation may leave the preview only for http(s)/mailto. Subframes are allowed to
 * reach http(s) so an embedded frame renders, but never hand anything to the system.
 */
export type HtmlPreviewNavigationDecision = 'allow' | 'external' | 'block'

/** The schemes a preview may hand to the host. The injected interceptor mirrors this list. */
export const HTML_PREVIEW_EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'] as const

const EXTERNAL_SCHEMES = new Set<string>(HTML_PREVIEW_EXTERNAL_SCHEMES)
const SUBFRAME_SCHEMES = new Set(['http:', 'https:'])

export function isAllowedHtmlPreviewScheme(url: string): boolean {
  return EXTERNAL_SCHEMES.has(protocolOf(url))
}

export function htmlPreviewNavigationDecision(args: {
  url: string
  /**
   * iOS, and Android through the patched `WebResourceRequest` overload, report subframes. A missing
   * value keeps the top-frame policy for the legacy Android overload and unknown callers.
   */
  isTopFrame?: boolean
}): HtmlPreviewNavigationDecision {
  const url = args.url.trim()
  if (isInlineDocument(url)) {
    return 'allow'
  }
  if (args.isTopFrame === false) {
    return isInlineSubframeDocument(url) || SUBFRAME_SCHEMES.has(protocolOf(url))
      ? 'allow'
      : 'block'
  }
  return isAllowedHtmlPreviewScheme(url) ? 'external' : 'block'
}

/**
 * `about:blank` is the base of a `source={{html}}` render, so a fragment navigation to an in-page
 * anchor arrives as `about:blank#section` rather than a bare `about:blank`.
 */
function isInlineDocument(url: string): boolean {
  return url.toLowerCase().startsWith('data:') || bareDocumentUrl(url) === 'about:blank'
}

/** WebKit/Chromium report an inline `<iframe srcdoc>` as `about:srcdoc`. */
function isInlineSubframeDocument(url: string): boolean {
  const bare = bareDocumentUrl(url)
  return bare === 'about:blank' || bare === 'about:srcdoc'
}

function bareDocumentUrl(url: string): string {
  return url.split('#')[0].toLowerCase()
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol.toLowerCase()
  } catch {
    return ''
  }
}
