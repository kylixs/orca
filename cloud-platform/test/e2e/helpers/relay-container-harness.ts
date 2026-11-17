import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { startTcpDelayHop, type TcpDelayHop } from '../harness.ts'

/**
 * U183 R13a: a clean Debian container plus a host-side TCP forwarder, so a
 * relay installer can be exercised against a platform running on this machine.
 * Nothing here is product code; it only owns container/forwarder lifetime.
 */

export const DEFAULT_CONTAINER_IMAGE = 'jlc-deb12:rust'
export const CONTAINER_HOME = '/tmp/orca-relay-e2e-home'

export type ContainerCapabilities = {
  bash: boolean
  curl: boolean
  openssl: boolean
  /** Node is absent from the cached image; node-dependent suites must skip. */
  node: boolean
  nodeVersion: string | null
}

export type ContainerExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ContainerHarness = {
  available: boolean
  /** Present when Docker or the image is unusable; suites skip, never fail. */
  skipReason?: string
  image: string
  containerName: string | null
  dockerVersion: string | null
  homeDir: string
  capabilities: ContainerCapabilities
  /** `http://host.docker.internal:<forwarderPort>`, or null when unavailable. */
  platformUrl: string | null
  execInContainer: (command: string) => Promise<ContainerExecResult>
  getContainerPlatformUrl: () => string
  /** Runs curl from inside the container against the host URL (default /health). */
  checkPlatformReachable: (path?: string) => Promise<boolean>
  stop: () => Promise<void>
}

export type ContainerHarnessOptions = {
  /** Host port where the platform listens on 127.0.0.1. */
  platformPort: number
  image?: string
  /** How long tool probing may take after `docker run`. */
  probeTimeoutMs?: number
}

type RunResult = ContainerExecResult & { notFound: boolean }

/** Containers this process created; the exit hook reaps anything stop() missed. */
const activeHarnesses = new Set<ContainerHarness>()

function emptyCapabilities(): ContainerCapabilities {
  return { bash: false, curl: false, openssl: false, node: false, nodeVersion: null }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  onTimeout?: () => void
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      onTimeout?.()
      proc.kill('SIGKILL')
      finish({ exitCode: 124, stdout: '', stderr: 'command timed out', notFound: false })
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    proc.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: 127,
        stdout: Buffer.concat(stdout).toString(),
        stderr: `${Buffer.concat(stderr).toString()}${error.message}`,
        notFound: error.code === 'ENOENT'
      })
    })
    proc.once('close', (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        notFound: false
      })
    })
  })
}

function docker(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return runCommand('docker', args, timeoutMs)
}

function unavailableHarness(
  image: string,
  skipReason: string,
  dockerVersion: string | null
): ContainerHarness {
  const throwUnavailable = (): never => {
    throw new Error(`relay container harness unavailable: ${skipReason}`)
  }
  return {
    available: false,
    skipReason,
    image,
    containerName: null,
    dockerVersion,
    homeDir: CONTAINER_HOME,
    capabilities: emptyCapabilities(),
    platformUrl: null,
    execInContainer: async () => throwUnavailable(),
    getContainerPlatformUrl: throwUnavailable,
    checkPlatformReachable: async () => false,
    stop: async () => {}
  }
}

/** Blocks the event loop only at exit, where async docker reaping is impossible. */
function reapContainerSync(containerName: string): void {
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 15_000 })
}

process.on('exit', () => {
  for (const harness of activeHarnesses) {
    if (harness.containerName) {
      reapContainerSync(harness.containerName)
    }
  }
})

async function probeTools(containerName: string, deadline: number): Promise<{
  capabilities: ContainerCapabilities
  missing: string[]
  home: string
}> {
  const capabilities = emptyCapabilities()
  const missing: string[] = []
  let home = ''
  while (Date.now() < deadline) {
    const result = await docker(
      ['exec', containerName, '/bin/bash', '-c', probeScript()],
      10_000
    )
    if (result.exitCode === 0) {
      capabilities.bash = true
      capabilities.curl = true
      capabilities.openssl = true
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('node=')) {
          const value = line.slice('node='.length)
          capabilities.node = value !== 'absent'
          capabilities.nodeVersion = capabilities.node ? value : null
        }
        if (line.startsWith('home=')) {
          home = line.slice('home='.length)
        }
      }
      return { capabilities, missing, home }
    }
    for (const tool of ['bash', 'curl', 'openssl']) {
      if (result.stderr.includes(`missing:${tool}`) && !missing.includes(tool)) {
        missing.push(tool)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { capabilities, missing, home }
}

function probeScript(): string {
  return [
    'for c in bash curl openssl; do',
    '  command -v "$c" >/dev/null 2>&1 || { echo "missing:$c" >&2; exit 1; };',
    'done',
    'if command -v node >/dev/null 2>&1; then echo "node=$(node --version)"; else echo "node=absent"; fi',
    'echo "home=$HOME"'
  ].join('\n')
}

/**
 * Starts a unique `relay-e2e-<rand>` container and a host forwarder bound to
 * 0.0.0.0, returning `skipReason` instead of throwing when Docker or the image
 * is missing (CI without Docker must not go red).
 */
export async function startContainerHarness(
  options: ContainerHarnessOptions
): Promise<ContainerHarness> {
  const image = options.image ?? DEFAULT_CONTAINER_IMAGE
  if (!Number.isInteger(options.platformPort) || options.platformPort <= 0) {
    throw new Error(`platformPort must be a positive integer, got ${options.platformPort}`)
  }

  const version = await docker(['version', '--format', '{{.Server.Version}}'], 10_000)
  if (version.notFound) {
    return unavailableHarness(image, 'docker CLI not found on PATH', null)
  }
  if (version.exitCode !== 0) {
    return unavailableHarness(
      image,
      `docker daemon unavailable: ${version.stderr.trim() || `exit ${version.exitCode}`}`,
      null
    )
  }
  const dockerVersion = version.stdout.trim()

  const imageInspect = await docker(['image', 'inspect', '--format', '{{.Id}}', image])
  if (imageInspect.exitCode !== 0) {
    return unavailableHarness(
      image,
      `image ${image} not present locally (not pulled: this environment has no Docker Hub access)`,
      dockerVersion
    )
  }

  const containerName = `relay-e2e-${randomBytes(4).toString('hex')}`
  let hop: TcpDelayHop | null = null
  try {
    hop = await startTcpDelayHop(options.platformPort, { bindHost: '0.0.0.0' })
  } catch (error) {
    return unavailableHarness(
      image,
      `could not start host forwarder: ${(error as Error).message}`,
      dockerVersion
    )
  }

  // host.docker.internal is built into Docker Desktop; native Linux Docker
  // needs the host-gateway entry, and adding it on macOS would shadow the
  // desktop-provided route.
  const hostArgs =
    process.platform === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : []
  const run = await docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      containerName,
      ...hostArgs,
      '-e',
      `HOME=${CONTAINER_HOME}`,
      '--entrypoint',
      '/bin/bash',
      image,
      '-c',
      'exec sleep infinity'
    ],
    60_000
  )
  if (run.exitCode !== 0) {
    await hop.close()
    throw new Error(`docker run failed (${run.exitCode}): ${run.stderr.trim()}`)
  }

  const platformUrl = `http://host.docker.internal:${hop.port}`
  const harness: ContainerHarness = {
    available: true,
    image,
    containerName,
    dockerVersion,
    homeDir: CONTAINER_HOME,
    capabilities: emptyCapabilities(),
    platformUrl,
    execInContainer: async (command) => {
      const result = await docker(['exec', containerName, '/bin/bash', '-c', command], 120_000)
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
    getContainerPlatformUrl: () => platformUrl,
    checkPlatformReachable: async (path = '/health') => {
      const result = await docker(
        ['exec', containerName, '/bin/bash', '-c', `curl -fsS --max-time 5 ${platformUrl}${path}`],
        20_000
      )
      return result.exitCode === 0
    },
    stop: async () => {
      activeHarnesses.delete(harness)
      await hop?.close()
      if (harness.containerName) {
        await docker(['rm', '-f', harness.containerName], 30_000)
      }
    }
  }
  activeHarnesses.add(harness)

  await harness.execInContainer(`mkdir -p ${CONTAINER_HOME}`)
  const probe = await probeTools(containerName, Date.now() + (options.probeTimeoutMs ?? 15_000))
  harness.capabilities = probe.capabilities
  if (probe.home) {
    harness.homeDir = probe.home
  }
  if (probe.missing.length > 0) {
    await harness.stop()
    return unavailableHarness(
      image,
      `image ${image} is missing required tools: ${probe.missing.join(', ')}`,
      dockerVersion
    )
  }
  if (!probe.capabilities.bash) {
    await harness.stop()
    return unavailableHarness(
      image,
      `container tools did not become ready within ${options.probeTimeoutMs ?? 15_000}ms`,
      dockerVersion
    )
  }
  return harness
}
