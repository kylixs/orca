/**
 * Shared systemd user-unit rendering. The host install script and the relay
 * installer (U183 R8) both write a unit, so the template lives here rather
 * than inline in either script.
 */

export type SystemdUnitInput = {
  description: string
  /** Absolute command line. May contain shell variables when the consuming script expands it. */
  execStart: string
  environmentFile: string
  /** Host-only: 78 is a non-retryable config/identity failure. Never add 3. */
  restartPreventExitStatus?: number
  startLimitIntervalSec?: number
  startLimitBurst: number
  extraUnitLines?: string[]
  extraServiceLines?: string[]
  restart?: string
  restartSec?: number
}

function requireText(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`systemd unit: ${name} is required`)
  }
  return value
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`systemd unit: ${name} must be a positive integer`)
  }
  return value
}

export function renderSystemdUnit(input: SystemdUnitInput): string {
  const description = requireText('description', input.description)
  const execStart = requireText('execStart', input.execStart)
  const environmentFile = requireText('environmentFile', input.environmentFile)
  const startLimitBurst = requirePositiveInteger('startLimitBurst', input.startLimitBurst)
  const startLimitIntervalSec =
    input.startLimitIntervalSec === undefined
      ? undefined
      : requirePositiveInteger('startLimitIntervalSec', input.startLimitIntervalSec)
  const restartPreventExitStatus =
    input.restartPreventExitStatus === undefined
      ? undefined
      : requirePositiveInteger('restartPreventExitStatus', input.restartPreventExitStatus)

  const restart = input.restart === undefined ? 'on-failure' : requireText('restart', input.restart)
  const restartSec =
    input.restartSec === undefined ? 5 : requirePositiveInteger('restartSec', input.restartSec)

  const lines = ['[Unit]', `Description=${description}`]
  for (const line of input.extraUnitLines ?? []) lines.push(requireText('extraUnitLines', line))
  if (startLimitIntervalSec !== undefined) {
    lines.push(`StartLimitIntervalSec=${startLimitIntervalSec}`)
  }
  lines.push(
    `StartLimitBurst=${startLimitBurst}`,
    '',
    '[Service]',
    `EnvironmentFile=${environmentFile}`,
    `ExecStart=${execStart}`,
    `Restart=${restart}`,
    `RestartSec=${restartSec}`
  )
  if (restartPreventExitStatus !== undefined) {
    lines.push(`RestartPreventExitStatus=${restartPreventExitStatus}`)
  }
  for (const line of input.extraServiceLines ?? [])
    lines.push(requireText('extraServiceLines', line))
  lines.push('', '[Install]', 'WantedBy=default.target')
  return `${lines.join('\n')}\n`
}

export function renderHostUnit(input: { binPath: string }): string {
  const binPath = requireText('binPath', input.binPath)
  return renderSystemdUnit({
    description: 'Orca Cloud 宿主代理',
    execStart: `${binPath} --host-mode`,
    environmentFile: '%h/.orca-cloud/host.env',
    restartPreventExitStatus: 78,
    startLimitIntervalSec: 60,
    startLimitBurst: 5
  })
}

export function renderRelayUnit(input: {
  nodePath: string
  root: string
  /** U186: defaults to the bundle release entry; repo mode passes its own. */
  entry?: string
  /** U187: defaults to <root>/current; repo mode has no current dir. */
  workingDirectory?: string
}): string {
  const nodePath = requireText('nodePath', input.nodePath)
  // POSIX unit path: do not use path.join (it would emit backslashes on Windows).
  const root = requireText('root', input.root).replace(/\/+$/, '')
  const entry = requireText('entry', input.entry ?? `${root}/current/apps/relay/src/relay.ts`)
  const workingDirectory = requireText(
    'workingDirectory',
    input.workingDirectory ?? `${root}/current`
  )
  return renderSystemdUnit({
    description: 'Orca Cloud 中继',
    execStart: `${nodePath} ${entry}`,
    environmentFile: `${root}/relay.env`,
    extraUnitLines: ['After=network-online.target', 'Wants=network-online.target'],
    extraServiceLines: ['Type=simple', `WorkingDirectory=${workingDirectory}`],
    restartSec: 2,
    startLimitIntervalSec: 60,
    startLimitBurst: 5
  })
}
