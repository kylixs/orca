import { describe, expect, it } from 'vitest'
import { parseJsonText, readString } from '../../../shared/json-fields'
import {
  loadOrCreateWebCloudDeviceKey,
  webCloudPairingBinding,
  type WebCloudDeviceKeyStorage,
  type WebCloudDeviceIdentity
} from './web-cloud-device-key'

class MemoryStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

function readStored(storage: MemoryStorage): WebCloudDeviceIdentity {
  const parsed = parseJsonText(storage.value ?? '')
  const publicKeyB64 = readString(parsed, 'publicKeyB64')
  const secretKeyB64 = readString(parsed, 'secretKeyB64')
  if (publicKeyB64 === null || secretKeyB64 === null) {
    throw new Error('stored identity malformed')
  }
  return { publicKeyB64, secretKeyB64 }
}

describe('web cloud device key', () => {
  it('generates and persists an identity on first use', () => {
    const storage = new MemoryStorage()
    const identity = loadOrCreateWebCloudDeviceKey(storage)

    expect(readStored(storage)).toEqual(identity)
    expect(Buffer.from(identity.publicKeyB64, 'base64')).toHaveLength(32)
    expect(Buffer.from(identity.secretKeyB64, 'base64')).toHaveLength(32)
  })

  it('returns the same identity on later calls', () => {
    const storage = new MemoryStorage()
    const first = loadOrCreateWebCloudDeviceKey(storage)
    const stored = storage.value
    const second = loadOrCreateWebCloudDeviceKey(storage)

    expect(second).toEqual(first)
    expect(storage.value).toBe(stored)
  })

  it('regenerates instead of throwing when the stored JSON is malformed', () => {
    const storage = new MemoryStorage()
    storage.value = '{not json'
    const identity = loadOrCreateWebCloudDeviceKey(storage)

    expect(readStored(storage)).toEqual(identity)
    expect(Buffer.from(identity.publicKeyB64, 'base64')).toHaveLength(32)
  })

  it('regenerates when the stored pair is inconsistent', () => {
    const storage = new MemoryStorage()
    const first = loadOrCreateWebCloudDeviceKey(storage)
    const other = loadOrCreateWebCloudDeviceKey(new MemoryStorage())
    storage.value = JSON.stringify({
      publicKeyB64: first.publicKeyB64,
      secretKeyB64: other.secretKeyB64
    })

    const identity = loadOrCreateWebCloudDeviceKey(storage)
    expect(identity.publicKeyB64).not.toBe(first.publicKeyB64)
    expect(readStored(storage)).toEqual(identity)
  })

  it('exposes only the public key in an offer-shaped binding', () => {
    const storage = new MemoryStorage()
    const identity = loadOrCreateWebCloudDeviceKey(storage)
    const binding = webCloudPairingBinding(identity, 'ticket')

    expect(binding).toEqual({ credential: 'ticket', devicePublicKeyB64: identity.publicKeyB64 })
    expect(Object.keys(binding).sort()).toEqual(['credential', 'devicePublicKeyB64'])
    expect(JSON.stringify(binding)).not.toContain(identity.secretKeyB64)
  })
})
