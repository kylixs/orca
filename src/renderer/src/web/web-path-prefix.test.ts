import { describe, expect, it } from 'vitest'
import { deriveWebRoutePathPrefix, webSocketUrlForPage } from './web-path-prefix'

describe('deriveWebRoutePathPrefix', () => {
  it('reads a prefixed page under /h/<routeKey>', () => {
    expect(deriveWebRoutePathPrefix('/h/route-key/web-index.html')).toBe('/h/route-key')
  })

  it('accepts a trailing slash and an exact mount path', () => {
    expect(deriveWebRoutePathPrefix('/h/route_key/')).toBe('/h/route_key')
    expect(deriveWebRoutePathPrefix('/h/route_key')).toBe('/h/route_key')
  })

  it('returns empty for a direct page', () => {
    expect(deriveWebRoutePathPrefix('/web-index.html')).toBe('')
    expect(deriveWebRoutePathPrefix('/')).toBe('')
  })

  it('decodes an encoded route key the relay would accept', () => {
    expect(deriveWebRoutePathPrefix('/h/route%5Fkey/web-index.html')).toBe('/h/route_key')
  })

  it('rejects encoded characters the relay route table cannot match', () => {
    expect(deriveWebRoutePathPrefix('/h/route%20key/web-index.html')).toBe('')
    expect(deriveWebRoutePathPrefix('/h/%E4%B8%AD/web-index.html')).toBe('')
    expect(deriveWebRoutePathPrefix('/h/route%2Fkey/web-index.html')).toBe('')
  })
})

describe('webSocketUrlForPage', () => {
  const direct = { protocol: 'https:', host: 'host.example:6768', pathname: '/web-index.html' }

  it('leaves a direct page endpoint byte for byte', () => {
    const endpoint = 'wss://host.example:6768/'
    expect(webSocketUrlForPage(endpoint, direct)).toBe(endpoint)
  })

  it('targets the relay origin and re-adds the prefix on a prefixed page', () => {
    expect(
      webSocketUrlForPage('wss://host.example:6768/', {
        protocol: 'https:',
        host: 'relay.example',
        pathname: '/h/route-key/web-index.html'
      })
    ).toBe('wss://relay.example/h/route-key/')
  })

  it('uses ws on an http page and keeps the endpoint path behind the prefix', () => {
    expect(
      webSocketUrlForPage('ws://host.example:6768/ws', {
        protocol: 'http:',
        host: 'relay.example:8080',
        pathname: '/h/route-key/'
      })
    ).toBe('ws://relay.example:8080/h/route-key/ws')
  })

  it('does not double an already-prefixed endpoint', () => {
    const endpoint = 'wss://relay.example/h/route-key/'
    expect(
      webSocketUrlForPage(endpoint, {
        protocol: 'https:',
        host: 'relay.example',
        pathname: '/h/route-key/web-index.html'
      })
    ).toBe(endpoint)
  })
})
