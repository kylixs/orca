import { describe, expect, it } from 'vitest'
import {
  readRememberedCloudProjectId,
  rememberCloudProjectId,
  type WebCloudProjectMemoryStorage
} from './web-cloud-project-memory'

class MemoryStorage implements WebCloudProjectMemoryStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

describe('web cloud project memory', () => {
  it('remembers one project id per platform address', () => {
    const storage = new MemoryStorage()
    rememberCloudProjectId(storage, 'https://cloud.example/', 'proj_demo')
    rememberCloudProjectId(storage, 'https://other.example', 'proj_other')

    expect(readRememberedCloudProjectId(storage, 'https://cloud.example')).toBe('proj_demo')
    expect(readRememberedCloudProjectId(storage, 'https://cloud.example/')).toBe('proj_demo')
    expect(readRememberedCloudProjectId(storage, 'https://other.example')).toBe('proj_other')
    expect(readRememberedCloudProjectId(storage, 'https://unknown.example')).toBeNull()
  })

  it('keeps the previous platform when a new one is remembered', () => {
    const storage = new MemoryStorage()
    rememberCloudProjectId(storage, 'https://cloud.example', 'proj_demo')
    rememberCloudProjectId(storage, 'https://other.example', 'proj_other')

    expect(readRememberedCloudProjectId(storage, 'https://cloud.example')).toBe('proj_demo')
  })

  it('treats a corrupted record as no memory instead of failing', () => {
    const storage = new MemoryStorage()
    storage.value = '{"version":1,"byApiUrl":{"https://cloud.example":42}}'

    expect(readRememberedCloudProjectId(storage, 'https://cloud.example')).toBeNull()
    rememberCloudProjectId(storage, 'https://cloud.example', 'proj_demo')
    expect(readRememberedCloudProjectId(storage, 'https://cloud.example')).toBe('proj_demo')
  })
})
