import { describe, expect, it } from 'vitest'
import {
  decideWebPairingStartup,
  parseWebPairingInput,
  WebPairingCloudKeyError,
  webRuntimeSubprotocols,
  type WebPairingOffer
} from './web-pairing'

describe('web pairing input', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({ ...offer, ...overrides }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('parses query-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('still parses legacy hash-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair#${encodeOffer()}`)).toEqual(offer)
  })

  it('preserves optional device scope metadata', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'mobile' })}`)).toEqual({
      ...offer,
      scope: 'mobile'
    })
  })

  it('preserves optional paired device identity', () => {
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ pairedDeviceId: 'paired-device-a' })}`)
    ).toEqual({
      ...offer,
      pairedDeviceId: 'paired-device-a'
    })
  })

  it.each([
    ['wss://proxy.example:443/orca/runtime', 'wss://proxy.example:443/orca/runtime'],
    ['https://proxy.example/orca/runtime', 'wss://proxy.example/orca/runtime'],
    ['http://proxy.example:8080/orca/runtime', 'ws://proxy.example:8080/orca/runtime']
  ])('preserves reverse-proxy endpoint routing for %s', (endpoint, expected) => {
    expect(parseWebPairingInput(encodeOffer({ endpoint }))).toMatchObject({ endpoint: expected })
  })

  it('treats invalid device scope metadata as unknown', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'admin' })}`)).toEqual(
      offer
    )
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`orca://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`orca://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })

  it('auto-saves scoped runtime offers during web startup', () => {
    const input = `orca://pair?code=${encodeOffer({ scope: 'runtime' })}`
    expect(
      decideWebPairingStartup({ initialPairingInput: input, hasStoredEnvironment: false })
    ).toEqual({
      kind: 'auto-save-runtime-offer',
      offer: { ...offer, scope: 'runtime' }
    })
  })

  it('shows the connect screen for mobile-scope and legacy unknown-scope offers', () => {
    const mobileInput = `orca://pair?code=${encodeOffer({ scope: 'mobile' })}`
    const legacyInput = `orca://pair?code=${encodeOffer()}`

    expect(
      decideWebPairingStartup({ initialPairingInput: mobileInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: mobileInput })
    expect(
      decideWebPairingStartup({ initialPairingInput: legacyInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: legacyInput })
  })

  it('uses a stored environment when no fresh valid pairing offer is present', () => {
    expect(
      decideWebPairingStartup({ initialPairingInput: null, hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
    expect(
      decideWebPairingStartup({ initialPairingInput: 'not a code', hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
  })
})

describe('cloud pairing offers', () => {
  const deviceKeyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const devicePublicKeyB64 = Buffer.from(deviceKeyBytes).toString('base64')
  const credential = 'header.payload.signature'

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(
      JSON.stringify({
        v: 2,
        endpoint: 'wss://cloud.example/orca/runtime',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        ...overrides
      }),
      'utf-8'
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  function cloudOffer(devicePublicKeyB64Override = devicePublicKeyB64): WebPairingOffer {
    return {
      v: 2,
      endpoint: 'wss://cloud.example/orca/runtime',
      deviceToken: 'token',
      publicKeyB64: 'public-key',
      cloud: { credential, devicePublicKeyB64: devicePublicKeyB64Override }
    }
  }

  it('parses and normalises a cloud offer', () => {
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ cloud: cloudOffer().cloud })}`)
    ).toEqual(cloudOffer())
  })

  it('accepts the device key in base64url and stores standard base64', () => {
    const base64url = Buffer.from(deviceKeyBytes).toString('base64url')
    expect(base64url).not.toContain('=')
    expect(
      parseWebPairingInput(
        `orca://pair?code=${encodeOffer({
          cloud: { credential, devicePublicKeyB64: base64url }
        })}`
      )
    ).toEqual(cloudOffer())
  })

  it.each([
    ['missing credential', { devicePublicKeyB64 }],
    ['empty credential', { credential: '', devicePublicKeyB64 }],
    ['missing device key', { credential }],
    ['non-base64 device key', { credential, devicePublicKeyB64: 'not a key' }],
    ['short device key', { credential, devicePublicKeyB64: Buffer.alloc(16).toString('base64') }],
    ['long device key', { credential, devicePublicKeyB64: Buffer.alloc(33).toString('base64') }]
  ])('rejects a cloud field with %s', (_label, cloud) => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ cloud })}`)).toBeNull()
  })

  it('keeps legacy offers protocol-less', () => {
    const legacy: WebPairingOffer = {
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: 'public-key'
    }
    expect(webRuntimeSubprotocols(legacy)).toBeNull()
  })

  it('builds the runtime, credential, and device protocols for a cloud offer', () => {
    const protocols = webRuntimeSubprotocols(cloudOffer())
    expect(protocols).toEqual([
      'orca-runtime',
      `orca-cred.${credential}`,
      `orca-device.${Buffer.from(deviceKeyBytes).toString('base64url')}`
    ])
    const deviceToken = protocols?.[2]?.slice('orca-device.'.length) ?? ''
    expect(deviceToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(deviceToken).not.toContain('=')
    expect(deviceToken).not.toContain('+')
    expect(deviceToken).not.toContain('/')
  })

  it('fails loudly when a constructed offer carries a malformed device key', () => {
    expect(() => webRuntimeSubprotocols(cloudOffer('short-key'))).toThrow(WebPairingCloudKeyError)
  })
})
