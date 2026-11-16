import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_SOCKETS_PER_DEVICE_SESSION } from '../cloud-platform/cloud-session-limits'
import { adoptCloudDeviceInList } from './device-registry-cloud-adoption'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

function cloudRow(token: string, projectId = 'proj-alpha'): DeviceEntry {
  return {
    deviceId: 'cloud-device',
    name: 'cloud-device',
    token,
    scope: 'runtime',
    publicKeyB64: 'device-public-key',
    pairedAt: 1,
    lastSeenAt: 2,
    cloudSession: {
      projectId,
      permissions: ['open', 'terminal'],
      projectRoot: '/srv/project',
      workspaceRoot: '/srv/workspace'
    }
  }
}

function registryFile(dir: string): string {
  return join(dir, DEVICE_REGISTRY_FILENAME)
}

function parseRows(text: string): DeviceEntry[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error('device registry is not an array')
  }
  return parsed.filter(
    (row): row is DeviceEntry => row !== null && typeof row === 'object' && !Array.isArray(row)
  )
}

function readRows(dir: string): DeviceEntry[] {
  return parseRows(readFileSync(registryFile(dir), 'utf-8'))
}

describe('DeviceRegistry 云端 token 释放', () => {
  it('只删除匹配的 cloudSession 行，移动行保留并持久化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-m63-release-'))
    const registry = new DeviceRegistry(dir)
    const mobile = registry.addDevice('paired-phone')
    registry.adoptCloudDevice({
      deviceId: 'cloud-device',
      token: 'cloud-token',
      name: 'cloud-device',
      publicKeyB64: 'device-public-key',
      project: 'proj-alpha',
      permissions: ['open', 'terminal'],
      projectRoot: '/srv/project',
      workspaceRoot: '/srv/workspace'
    })
    expect(registry.countCloudTokens()).toBe(1)

    expect(registry.releaseCloudDeviceToken(mobile.token)).toBe(false)
    expect(registry.releaseCloudDeviceToken('missing-token')).toBe(false)
    expect(registry.validateToken(mobile.token)).not.toBeNull()

    expect(registry.releaseCloudDeviceToken('cloud-token')).toBe(true)
    expect(registry.countCloudTokens()).toBe(0)
    expect(registry.validateToken('cloud-token')).toBeNull()
    expect(registry.listDevices()).toHaveLength(1)

    // A fresh registry proves the release reached disk, not just memory.
    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.countCloudTokens()).toBe(0)
    expect(reloaded.validateToken('cloud-token')).toBeNull()
    expect(reloaded.validateToken(mobile.token)?.deviceId).toBe(mobile.deviceId)
    expect(readRows(dir).map((row) => row.token)).toEqual([mobile.token])
  })

  it('load() 丢弃磁盘上的 cloudSession 行并立即写回，移动行不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-m63-load-'))
    const mobile = new DeviceRegistry(dir).addDevice('paired-phone')
    writeFileSync(
      registryFile(dir),
      JSON.stringify([cloudRow('dead-token'), mobile], null, 2),
      'utf-8'
    )

    const registry = new DeviceRegistry(dir)

    expect(registry.countCloudTokens()).toBe(0)
    expect(registry.validateToken('dead-token')).toBeNull()
    expect(registry.validateToken(mobile.token)?.deviceId).toBe(mobile.deviceId)

    const onDisk = readRows(dir)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]?.token).toBe(mobile.token)
    expect(onDisk[0]).not.toHaveProperty('cloudSession')
    expect(readFileSync(registryFile(dir), 'utf-8')).not.toContain('cloudSession')
  })

  it('注册表无法解析时不写回，保留原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-m63-corrupt-'))
    const corrupt = '[{"cloudSession": {"projectId": "proj-alpha"'
    writeFileSync(registryFile(dir), corrupt, 'utf-8')

    new DeviceRegistry(dir)

    expect(readFileSync(registryFile(dir), 'utf-8')).toBe(corrupt)
  })
})

describe('DeviceRegistry 云端 token 预算', () => {
  function adopt(devices: readonly DeviceEntry[], token: string): readonly DeviceEntry[] {
    return adoptCloudDeviceInList(devices, {
      deviceId: 'cloud-device',
      token,
      name: 'cloud-device',
      publicKeyB64: 'device-public-key',
      project: 'proj-alpha',
      permissions: ['open', 'terminal'],
      projectRoot: '/srv/project',
      workspaceRoot: '/srv/workspace'
    }).devices
  }

  it('a full device-session fan-out plus its replacement keeps the oldest live token (U118)', () => {
    let devices: readonly DeviceEntry[] = []
    for (let index = 0; index <= MAX_SOCKETS_PER_DEVICE_SESSION; index += 1) {
      devices = adopt(devices, `token-${index}`)
    }

    expect(devices).toHaveLength(MAX_SOCKETS_PER_DEVICE_SESSION + 1)
    expect(devices.map((row) => row.token)).toContain('token-0')
  })

  it('still evicts the oldest token beyond that budget', () => {
    let devices: readonly DeviceEntry[] = []
    for (let index = 0; index <= MAX_SOCKETS_PER_DEVICE_SESSION + 1; index += 1) {
      devices = adopt(devices, `token-${index}`)
    }

    expect(devices).toHaveLength(MAX_SOCKETS_PER_DEVICE_SESSION + 1)
    expect(devices.map((row) => row.token)).not.toContain('token-0')
    expect(devices.map((row) => row.token)).toContain('token-1')
  })
})
