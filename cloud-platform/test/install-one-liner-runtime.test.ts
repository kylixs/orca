import { test, describe, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInstallTemplateInterpolations,
  installCommandTemplateSource,
  renderInstallCommand,
  runOneLiner,
  type OneLinerRun
} from './e2e/helpers/install-command-harness.ts'

/**
 * U275: the copied one-liner is a shell program, so its contract (65 on a failed
 * download, the install script's own exit code including 128+n, temp-file
 * cleanup) can only be proven by running it. The command under test is derived
 * from app.js source, never re-typed here, so drift in the wizard cannot pass.
 * U276: a transfer cut mid-body leaves a partial file, so the failure case
 * writes bytes before failing and asserts the wrapper removed them.
 * U281: a signal mid-download must clean the partial file via the EXIT trap.
 */

const INSTALL = installCommandTemplateSource()
const INSTALL_URL = 'https://platform.example/install/host.sh?download=abc&token=def'
const installCommand = (url: string): string =>
  renderInstallCommand(INSTALL.template, INSTALL.file, url)
const runLiner = (
  body: string | null,
  options: { extraStubs?: Record<string, string>; failure?: 'unreachable' | 'partial' } = {}
): OneLinerRun =>
  runOneLiner(installCommand(INSTALL_URL), { body, scratchPrefix: 'orca-u275-', ...options })

/** Files the one-liner itself creates: anything else in TMPDIR is not residue. */
function installScripts(run: OneLinerRun): string[] {
  return run.kept.filter((name) => /^orca-install-.*\.sh$/.test(name))
}

/**
 * U283: every case runs the one-liner under bash, and the interrupt cases need
 * POSIX process groups (negative pid), so state the requirement instead of
 * failing with an opaque spawn error on Windows or a bash-less host.
 */
function bashAvailable(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const probe = spawnSync('bash', ['-c', 'true'])
  return probe.error === undefined && probe.status === 0
}

const POSIX_BASH = bashAvailable()

/** SIGQUIT can be ignored by the container runtime; probe the trap contract itself. */
const QUIT_TRAP = ((): boolean => {
  if (!POSIX_BASH) {
    return false
  }
  return spawnSync('bash', ['-c', "trap 'exit 131' QUIT; kill -QUIT $$"]).status === 131
})()

function bashTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  test(name, async (t) => {
    if (!POSIX_BASH) {
      t.skip('posix shell required')
      return
    }
    await fn(t)
  })
}

// U281: curl starts writing, proves it with a marker, then hangs so the shell
// can be interrupted mid-transfer (unlike the sync harness, which must reap).
const INTERRUPTED_CURL = `#!/usr/bin/env bash
prev=""
out=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '#!/usr/bin/env bash\\necho U281-PARTIAL\\n' > "$out"
: > "$HOME/u281-download-started"
sleep 60
`

type InterruptedRun = {
  code: number | null
  signal: NodeJS.Signals | null
  /** Files present mid-download; the script proves bytes were written. */
  during: string[]
  partialBody: string
  /** Files left after the shell exited. */
  kept: string[]
  stderr: string
}

function waitForDownloadStart(
  child: ChildProcess,
  marker: string,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A missing bash surfaces as 'error'; unhandled it would hang to timeout.
    child.on('error', reject)
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      if (existsSync(marker)) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for the download to start'))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

/** U283: stub curl and its `sleep` are group members; the shell alone is not enough. */
function killGroup(child: ChildProcess): void {
  const pid = child.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // Group already reaped (ESRCH): fall through to the direct kill.
    }
  }
  child.kill('SIGKILL')
}

/** Runs the one-liner in its own process group, interrupts it mid-download. */
async function runInterrupted(interrupt: 'SIGINT' | 'SIGQUIT' = 'SIGINT'): Promise<InterruptedRun> {
  const home = mkdtempSync(join(tmpdir(), 'orca-u281-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), INTERRUPTED_CURL, { mode: 0o755 })
  const tmpDir = join(home, 'tmp')
  mkdirSync(tmpDir)
  const child = spawn('bash', ['-c', installCommand(INSTALL_URL)], {
    cwd: home,
    detached: true,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpDir },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  // Attach before the kill: a fast exit must not race the listener.
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('exit', (code, signal) => resolve([code, signal]))
  })
  try {
    await waitForDownloadStart(child, join(home, 'u281-download-started'))
    const during = readdirSync(tmpDir)
    const partial = during.find((name) => /^orca-install-.*\.sh$/.test(name))
    const partialBody = partial ? readFileSync(join(tmpDir, partial), 'utf8') : ''
    const pid = child.pid
    assert.ok(pid !== undefined, 'spawn must return a pid')
    process.kill(-pid, interrupt)
    const [code, signal] = await exited
    return { code, signal, during, partialBody, kept: readdirSync(tmpDir), stderr }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child)
    }
    rmSync(home, { recursive: true, force: true })
  }
}

describe('U275: the renderer evaluates in a single pass', () => {
  // Pure string assertions: no shell, so these must not be gated on POSIX bash.
  test('URL 中字面 ${file} 不被二次替换，\\${code} 仍解码', () => {
    const url = 'https://platform.example/x/${file}/y'
    const rendered = installCommand(url)

    assert.ok(rendered.includes(`"${url}"`), rendered)
    assert.ok(!rendered.includes('x/${TMPDIR:-/tmp}/orca-install-$$.sh/y'), rendered)
    // The literal exit-code placeholder is decoded exactly once.
    assert.ok(rendered.includes('安装脚本退出码 ${code}，'), rendered)
    assert.ok(!rendered.includes('\\${code}'), rendered)
  })
})

describe('U275: template interpolation contract', () => {
  test('模板必须同时插值 ${file} 与 ${url}', () => {
    assert.doesNotThrow(() => assertInstallTemplateInterpolations('a ${file} b ${url} c'))
    assert.throws(
      () => assertInstallTemplateInterpolations('a "${url}" -o /tmp/x.sh'),
      /must interpolate both \$\{file\} and \$\{url\}; missing: \$\{file\}/
    )
    assert.throws(
      () => assertInstallTemplateInterpolations('a "/tmp/x.sh" -o "${file}"'),
      /must interpolate both \$\{file\} and \$\{url\}; missing: \$\{url\}/
    )
  })
})

describe('U275/U276: install one-liner runs under a real shell', () => {
  // Source-shape only; the cases below that spawn bash stay gated.
  test('模板取自 app.js 源码，转义与引号不被测试重写', () => {
    assert.ok(INSTALL.source.includes('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).endsWith('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).includes('安装脚本退出码 ${code}，临时文件保留在'))
    assert.ok(installCommand(INSTALL_URL).includes(`curl -fsSL "${INSTALL_URL}" -o `))
  })

  bashTest('下载失败且未创建文件（curl 22）：外层退出 65 并提示重新生成', () => {
    const run = runLiner(null)

    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(installScripts(run), [])
  })

  bashTest('下载中途断开（curl 18）写入半截文件：外层 65 且目录无 orca-install-*.sh 残留', () => {
    const run = runLiner(null, { failure: 'partial' })

    assert.ok(
      existsSync(join(run.home, 'u276-partial-written')),
      'the stub must actually write bytes to the -o target before failing'
    )
    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(
      installScripts(run),
      [],
      'a partial download must be removed before the 65 exit'
    )
  })

  for (const code of [64, 69, 70]) {
    bashTest(`安装脚本退出 ${code}：外层原码透传，保留脚本供诊断`, () => {
      const run = runLiner(`echo 'STUB-${code}: 安装脚本自有失败' >&2\nexit ${code}`)

      assert.equal(run.status, code, run.stderr)
      assert.match(run.stderr, new RegExp(`STUB-${code}: 安装脚本自有失败`))
      assert.equal(run.kept.length, 1, 'a failed install keeps the script')
      assert.ok(
        run.stderr.includes(
          `安装脚本退出码 ${code}，临时文件保留在 ${join(run.tmpDir, run.kept[0])}`
        ),
        run.stderr
      )
    })
  }

  bashTest('安装脚本被 SIGTERM 杀死：外层退出 143（128+15），不被压成 1', () => {
    const run = runLiner('kill -TERM $$\n')

    assert.equal(run.status, 143, run.stderr)
    assert.equal(run.kept.length, 1, 'a signalled install keeps the script')
    assert.ok(run.stderr.includes('安装脚本退出码 143，临时文件保留在'), run.stderr)
  })

  bashTest('安装脚本成功：外层退出 0 并删除临时文件', () => {
    const run = runLiner("echo 'STUB-OK'\nexit 0")

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /STUB-OK/)
    assert.deepEqual(run.kept, [], 'a successful install removes the script')
    assert.doesNotMatch(run.stderr, /未能删除|临时文件保留/)
  })

  bashTest('清理失败：告警到 stderr，但仍以安装脚本的 0 退出', () => {
    const run = runLiner("echo 'STUB-OK'\nexit 0", {
      // Simulates a read-only temp location; a stub keeps the case deterministic.
      extraStubs: { rm: '#!/usr/bin/env bash\nexit 1\n' }
    })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /安装完成，但临时文件未能删除：/)
    assert.equal(run.kept.length, 1, 'the undeletable script is still there')
  })
})

describe('U281/U283: interruption and cleanup failure', () => {
  bashTest(
    '下载中途 SIGINT：外层经 trap 恰以 130 退出，且 TMPDIR 无 orca-install-*.sh 残留',
    async () => {
      const run = await runInterrupted('SIGINT')

      // §2-141: prove the signal hit an in-flight download, not a no-op.
      assert.ok(
        run.during.some((name) => /^orca-install-.*\.sh$/.test(name)),
        `the stub must create the -o target before hanging; saw: ${run.during.join(', ')}`
      )
      assert.match(run.partialBody, /U281-PARTIAL/, 'the partial body must be on disk mid-download')
      assert.deepEqual(
        run.kept.filter((name) => /^orca-install-.*\.sh$/.test(name)),
        [],
        'an interrupted download must not leave orca-install-*.sh behind'
      )
      assert.equal(
        run.signal,
        null,
        `the INT trap must exit rather than die by signal: ${run.stderr}`
      )
      // U283: only SIGINT was sent, so an INT→TERM reroute must not pass as 143.
      assert.equal(run.code, 130, `SIGINT must exit through the INT trap with 130; ${run.stderr}`)
    }
  )

  bashTest(
    '下载中途 SIGQUIT：外层经 trap 恰以 131 退出，且无 orca-install-*.sh 残留',
    async (t) => {
      if (!QUIT_TRAP) {
        t.skip('SIGQUIT trap unavailable in this environment')
        return
      }
      const run = await runInterrupted('SIGQUIT')

      assert.ok(
        run.during.some((name) => /^orca-install-.*\.sh$/.test(name)),
        `the stub must create the -o target before hanging; saw: ${run.during.join(', ')}`
      )
      assert.match(run.partialBody, /U281-PARTIAL/, 'the partial body must be on disk mid-download')
      assert.deepEqual(
        run.kept.filter((name) => /^orca-install-.*\.sh$/.test(name)),
        [],
        'a SIGQUIT-interrupted download must not leave orca-install-*.sh behind'
      )
      assert.equal(
        run.signal,
        null,
        `the QUIT trap must exit rather than die by signal: ${run.stderr}`
      )
      assert.equal(run.code, 131, `SIGQUIT must exit through the QUIT trap with 131; ${run.stderr}`)
    }
  )

  bashTest('下载中断留下半截文件且 rm 失败：告警含完整路径、外层 65、文件仍残留', () => {
    const run = runLiner(null, {
      failure: 'partial',
      extraStubs: { rm: '#!/usr/bin/env bash\nexit 1\n' }
    })

    assert.ok(
      existsSync(join(run.home, 'u276-partial-written')),
      'the stub must actually write bytes to the -o target before failing'
    )
    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    const [kept] = installScripts(run)
    assert.ok(kept, `the undeletable partial download must remain; saw: ${run.kept.join(', ')}`)
    // U283: residue is the expected outcome here, and the warning names the path.
    assert.ok(
      run.stderr.includes(`临时文件清理失败：${join(run.tmpDir, kept)}`),
      `the warning must name the kept file; ${run.stderr}`
    )
  })
})
