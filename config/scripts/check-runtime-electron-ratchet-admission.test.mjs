import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectElectronImporters } from './check-runtime-electron-ratchet.mjs'

const ROOT = path.join(import.meta.dirname, '..', '..')

// U181 H1: orcad imports the cloud admission on plain Node. Its graph must not reach
// Electron, so the renderer IPC install belongs to the Electron launch path only.
describe('cloud admission Electron independence', () => {
  it('bundles the admission and attach modules without an electron edge', async () => {
    const importers = await collectElectronImporters([
      path.join(ROOT, 'src', 'main', 'startup', 'cloud-runtime-admission.ts'),
      path.join(ROOT, 'src', 'main', 'startup', 'cloud-runtime-attach.ts')
    ])
    expect(importers).toEqual([])
  }, 60_000)
})
