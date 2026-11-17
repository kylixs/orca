import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatServeRuntimeSelection } from '../../shared/orcad-local-serve-selection'
import type { runProcess } from '@orca/process-host'
import {
  orcadServeArgs,
  preflightOrcadHostRuntime,
  resolveLocalServeRuntime,
  serveOptionArgs,
  serveWithOrcad
} from './serve-orcad-launch'

type RunProcess = typeof runProcess

function answering(stdout: string, code = 0): RunProcess {
  return vi.fn<RunProcess>(async () => ({
    code,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false
  }))
}

const options = {
  executable: '/Applications/Orca.app/Contents/MacOS/Orca',
  appRoot: '/Applications/Orca.app/Contents/Resources/app.asar',
  userDataPath: '/Users/u/Library/Application Support/orca',
  usesMacUpdateHandoff: false
}

describe('orca serve asking the app which host to run', () => {
  it("runs the app's own selection entry as plain Node and reads its answer", async () => {
    const selection = {
      kind: 'orcad' as const,
      runtime: '/rt/node',
      entry: '/slot/orcad.js',
      version: '1'
    }
    const run = answering(`noise\n${formatServeRuntimeSelection(selection)}\n`)
    expect(await resolveLocalServeRuntime(options, run)).toEqual(selection)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: options.executable,
        args: [
          `${options.appRoot}/out/main/orcad/orcad-local-serve-selection-entry.js`,
          '--user-data',
          options.userDataPath,
          '--app-root',
          options.appRoot
        ],
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
  })

  it('keeps packaged macOS on Electron without starting the app to ask', async () => {
    const run = answering('')
    expect(await resolveLocalServeRuntime({ ...options, usesMacUpdateHandoff: true }, run)).toEqual(
      {
        kind: 'electron',
        reason: expect.stringContaining('packaged macOS')
      }
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('serves on Electron, and says why, when the app gives no answer', async () => {
    expect(await resolveLocalServeRuntime(options, answering('', 1))).toEqual({
      kind: 'electron',
      reason: expect.stringContaining('did not answer')
    })
    const failing = vi.fn<RunProcess>(async () => {
      throw new Error('spawn ENOENT')
    })
    expect(await resolveLocalServeRuntime(options, failing)).toEqual({
      kind: 'electron',
      reason: expect.stringContaining('spawn ENOENT')
    })
  })

  it('passes preflight only for a materialized orcad slot with its pinned runtime', async () => {
    const resolve = vi.fn<typeof resolveLocalServeRuntime>(async () => ({
      kind: 'orcad',
      runtime: '/slot/runtimes/node-sha/bin/node',
      entry: '/slot/orcad-server.js',
      version: '0.1.0'
    }))

    await expect(preflightOrcadHostRuntime(options, resolve)).resolves.toEqual({
      id: 'runtime',
      ok: true,
      detail: expect.stringContaining('orcad 0.1.0')
    })
    expect(resolve).toHaveBeenCalledWith(options)
  })

  it('fails preflight when the selector fell back to Electron', async () => {
    const resolve = vi.fn<typeof resolveLocalServeRuntime>(async () => ({
      kind: 'electron',
      reason: 'this Orca install carries no orcad template'
    }))

    await expect(preflightOrcadHostRuntime(options, resolve)).resolves.toEqual({
      id: 'runtime',
      ok: false,
      detail: 'this Orca install carries no orcad template'
    })
  })

  it('fails preflight instead of throwing when the selector crashed', async () => {
    const resolve = vi.fn<typeof resolveLocalServeRuntime>(async () => {
      throw new Error('spawn ENOENT')
    })

    await expect(preflightOrcadHostRuntime(options, resolve)).resolves.toEqual({
      id: 'runtime',
      ok: false,
      detail: 'spawn ENOENT'
    })
  })

  it('forwards every desktop serve flag, binding wide as Electron serve does', () => {
    expect(
      orcadServeArgs({
        json: true,
        port: '6768',
        pairingAddress: '10.0.0.5',
        noPairing: true,
        mobilePairing: true,
        recipeJson: true,
        projectRoot: '/work/app'
      })
    ).toEqual([
      '--bind',
      '0.0.0.0',
      '--json',
      '--port',
      '6768',
      '--pairing-address',
      '10.0.0.5',
      '--no-pairing',
      '--mobile-pairing',
      '--recipe-json',
      '--project-root',
      '/work/app'
    ])
    expect(orcadServeArgs({})).toEqual(['--bind', '0.0.0.0'])
  })

  it('forwards --reenroll to orcad and leaves the credential for the locked host', () => {
    expect(orcadServeArgs({ hostMode: true, reenroll: true })).toEqual([
      '--bind',
      '0.0.0.0',
      '--host-mode',
      '--reenroll'
    ])

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-reenroll-'))
    const credentialPath = join(userDataPath, 'orca-cloud-host.json')
    writeFileSync(credentialPath, '{"credential":"old"}', { mode: 0o600 })

    // A failed spawn is still after every pre-spawn step; the credential must be untouched.
    expect(() =>
      serveWithOrcad(
        { kind: 'orcad', runtime: '/rt/node', entry: '/slot/orcad.js', version: '1' },
        { hostMode: true, reenroll: true },
        userDataPath,
        {},
        () => {
          throw new Error('spawn failed')
        }
      )
    ).toThrow('spawn failed')

    expect(readFileSync(credentialPath, 'utf8')).toBe('{"credential":"old"}')
    expect(readdirSync(userDataPath)).toEqual(['orca-cloud-host.json'])
    expect(existsSync(credentialPath)).toBe(true)
  })

  it('spells the same flags with the --serve- prefix for the Electron host', () => {
    expect(
      serveOptionArgs(
        {
          json: true,
          port: '6768',
          pairingAddress: '10.0.0.5',
          noPairing: true,
          mobilePairing: true,
          grantDesktopControl: true,
          recipeJson: true,
          projectRoot: '/work/app'
        },
        '--serve-'
      )
    ).toEqual([
      '--serve-json',
      '--serve-port',
      '6768',
      '--serve-pairing-address',
      '10.0.0.5',
      '--serve-no-pairing',
      '--serve-mobile-pairing',
      '--serve-grant-desktop-control',
      '--serve-recipe-json',
      '--serve-project-root',
      '/work/app'
    ])
    expect(serveOptionArgs({ recipeJson: true }, '--serve-')).toEqual([])
  })
})
