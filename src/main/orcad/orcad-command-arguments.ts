import type { OrcadOptions } from './orcad-entry'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'
import { DEFAULT_WS_PORT } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import { ORCAD_LOOPBACK_BIND_HOST } from './orcad-bind-address'

/** A host-mode flag conflict: a configuration fault, so a supervisor must not restart on it. */
export class OrcadHostModeFlagConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadHostModeFlagConflictError'
  }
}

export const ORCAD_USAGE = `orcad — the Orca runtime served without Electron.

Usage: orcad [options]

Options:
  --port <n>               WebSocket port, 0-65535; 0 picks a free port.
                           Defaults to ${DEFAULT_WS_PORT}, with a fallback if unavailable.
  --bind <ip>              Literal IP to bind (default ${ORCAD_LOOPBACK_BIND_HOST}, local only).
                           Use an SSH port-forward or a network IP for remote access.
  --pairing-address <addr> Address advertised in pairing offers when different
                           from the bind address (for example, a public hostname).
  --json                   Print the one-line server readiness JSON to stdout.
  --no-pairing             Do not create a client pairing offer at startup.
  --mobile-pairing         Create a mobile-scoped pairing offer with a QR code.
  --grant-desktop-control  Allow desktop control in the default runtime offer;
                           cannot combine with --no-pairing or --mobile-pairing.
  --recipe-json            Print only the VM recipe line; requires --project-root.
  --project-root <dir>     Existing absolute project directory for --recipe-json.
  --host-mode              Serve as the platform-enrolled headless host.
  --reenroll               With --host-mode, re-register: back up the stored credential and enrol again.
  --preflight              With --host-mode, validate config and the slot, then exit.
  --help, -h               Print this text and exit without starting the server.

Environment:
  ORCA_USER_DATA           Data directory for this instance's profile and state.
`

type OrcadCommandArguments = OrcadOptions & { help?: boolean }

/**
 * orcad's flags. A value-taking flag consumes the next token whatever it looks
 * like, so `--bind --json` binds to the literal `--json`; only a missing token
 * is an error. Pinned by orcad-launch-contract.test.ts.
 */
export function parseArgs(argv: string[]): OrcadCommandArguments {
  const options: OrcadCommandArguments = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--port') {
      const raw = argv[i + 1]
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${raw ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (arg === '--mobile-pairing') {
      options.mobilePairing = true
    } else if (arg === '--grant-desktop-control') {
      options.grantDesktopControl = true
    } else if (arg === '--recipe-json') {
      options.recipeJson = true
    } else if (arg === '--host-mode') {
      options.hostMode = true
    } else if (arg === '--reenroll') {
      options.reenroll = true
    } else if (arg === '--preflight') {
      options.preflight = true
    } else if (arg === '--project-root') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--project-root expects a value')
      }
      options.projectRoot = value
      i += 1
    } else if (arg === '--bind') {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (arg === '--pairing-address') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--pairing-address expects a value')
      }
      options.pairingAddress = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  // Why shared: orcad can be launched directly, bypassing the CLI's conflict checks.
  if (options.hostMode) {
    const conflict = getServeOptionValidationError({
      noPairing: options.noPairing === true,
      mobilePairing: options.mobilePairing === true,
      grantDesktopControl: options.grantDesktopControl === true,
      recipeJson: options.recipeJson === true,
      projectRoot: options.projectRoot,
      hostMode: true,
      reenroll: options.reenroll === true,
      preflight: options.preflight === true,
      pairingAddress: options.pairingAddress
    })
    if (conflict) {
      throw new OrcadHostModeFlagConflictError(conflict)
    }
  }
  if (options.grantDesktopControl && (options.noPairing || options.mobilePairing)) {
    throw new Error('--grant-desktop-control applies only to the default runtime pairing offer')
  }
  if (options.recipeJson && !options.projectRoot) {
    throw new Error('--recipe-json requires --project-root')
  }
  if (options.preflight && !options.hostMode) {
    throw new Error('--preflight requires --host-mode')
  }
  if (options.reenroll && !options.hostMode) {
    throw new Error('--reenroll requires --host-mode')
  }
  return options
}
