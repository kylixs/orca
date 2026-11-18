import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function waitForDownloadStart(marker: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
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

/** Runs the one-liner in its own process group, interrupts it mid-download. */
async function runInterrupted(): Promise<InterruptedRun> {
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
    await waitForDownloadStart(join(home, 'u281-download-started'))
    const during = readdirSync(tmpDir)
    const partial = during.find((name) => /^orca-install-.*\.sh$/.test(name))
    const partialBody = partial ? readFileSync(join(tmpDir, partial), 'utf8') : ''
    const pid = child.pid
    assert.ok(pid !== undefined, 'spawn must return a pid')
    process.kill(-pid, 'SIGINT')
    const [code, signal] = await exited
    return { code, signal, during, partialBody, kept: readdirSync(tmpDir), stderr }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(home, { recursive: true, force: true })
  }
}

describe('U275: the renderer evaluates in a single pass', () => {
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
  test('模板取自 app.js 源码，转义与引号不被测试重写', () => {
    assert.ok(INSTALL.source.includes('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).endsWith('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).includes('安装脚本退出码 ${code}，临时文件保留在'))
    assert.ok(installCommand(INSTALL_URL).includes(`curl -fsSL "${INSTALL_URL}" -o `))
  })

  test('下载失败且未创建文件（curl 22）：外层退出 65 并提示重新生成', () => {
    const run = runLiner(null)

    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(installScripts(run), [])
  })

  test('下载中途断开（curl 18）写入半截文件：外层 65 且目录无 orca-install-*.sh 残留', () => {
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
    test(`安装脚本退出 ${code}：外层原码透传，保留脚本供诊断`, () => {
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

  test('安装脚本被 SIGTERM 杀死：外层退出 143（128+15），不被压成 1', () => {
    const run = runLiner('kill -TERM $$\n')

    assert.equal(run.status, 143, run.stderr)
    assert.equal(run.kept.length, 1, 'a signalled install keeps the script')
    assert.ok(run.stderr.includes('安装脚本退出码 143，临时文件保留在'), run.stderr)
  })

  test('安装脚本成功：外层退出 0 并删除临时文件', () => {
    const run = runLiner("echo 'STUB-OK'\nexit 0")

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /STUB-OK/)
    assert.deepEqual(run.kept, [], 'a successful install removes the script')
    assert.doesNotMatch(run.stderr, /未能删除|临时文件保留/)
  })

  test('清理失败：告警到 stderr，但仍以安装脚本的 0 退出', () => {
    const run = runLiner("echo 'STUB-OK'\nexit 0", {
      // Simulates a read-only temp location; a stub keeps the case deterministic.
      extraStubs: { rm: '#!/usr/bin/env bash\nexit 1\n' }
    })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /安装完成，但临时文件未能删除：/)
    assert.equal(run.kept.length, 1, 'the undeletable script is still there')
  })
})

describe('U281: interruption and cleanup failure', () => {
  test('下载中途 SIGINT：外层经 trap 退出，且 TMPDIR 无 orca-install-*.sh 残留', async () => {
    const run = await runInterrupted()

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
    assert.equal(run.signal, null, `the INT trap must exit rather than die by signal: ${run.stderr}`)
    assert.ok(
      run.code === 130 || run.code === 143,
      `an interrupt must exit through the trap (130/143), got ${run.code}; ${run.stderr}`
    )
  })

  test('下载失败且 rm 失败：stderr 告警清理失败，仍以 65 退出', () => {
    const run = runLiner(null, { extraStubs: { rm: '#!/usr/bin/env bash\nexit 1\n' } })

    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /临时文件清理失败：.*orca-install-\d+\.sh/)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(installScripts(run), [])
  })
})
