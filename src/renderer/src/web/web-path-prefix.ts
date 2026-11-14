const WEB_ROUTE_SEGMENT = 'h'
const WEB_ROUTE_KEY = /^[A-Za-z0-9_-]+$/

export type WebPageLocation = {
  protocol: string
  host: string
  /** Absent on the admin entry and bare harnesses, which are never prefixed. */
  pathname?: string | undefined
}

/**
 * The `/h/<routeKey>` mount the relay's browser mode serves this page under, or
 * an empty string for a direct (unprefixed) page. The key shape matches the
 * relay's own rule so a prefix it would 404 is never fabricated.
 */
export function deriveWebRoutePathPrefix(pathname: string | undefined): string {
  // The admin entry and bare harnesses expose a location without a pathname.
  if (typeof pathname !== 'string') {
    return ''
  }
  const segments = pathname.split('/')
  if (segments.length < 3 || segments[1] !== WEB_ROUTE_SEGMENT) {
    return ''
  }
  let routeKey: string
  try {
    routeKey = decodeURIComponent(segments[2] ?? '')
  } catch {
    return ''
  }
  if (!WEB_ROUTE_KEY.test(routeKey)) {
    return ''
  }
  return `/${WEB_ROUTE_SEGMENT}/${routeKey}`
}

/**
 * Direct pages keep the offer's endpoint byte for byte. A prefixed page can only
 * reach its host through the relay that served it, so the socket targets the page
 * origin and re-adds the prefix the relay strips.
 */
export function webSocketUrlForPage(endpoint: string, page: WebPageLocation): string {
  const prefix = deriveWebRoutePathPrefix(page.pathname)
  if (!prefix || (page.protocol !== 'http:' && page.protocol !== 'https:')) {
    return endpoint
  }
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return endpoint
  }
  if (parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`)) {
    return endpoint
  }
  const protocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${page.host}${prefix}${parsed.pathname}${parsed.search}`
}
