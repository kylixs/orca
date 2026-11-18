import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * U275: the copied one-liner is a shell program, so its contract (65 on a failed
 * download, the install script's own exit code including 128+n, temp-file
 * cleanup) can only be proven by running it. The command under test is derived
 * from app.js source, never re-typed here, so drift in the wizard cannot pass.
 */

const APP_SOURCE = fileURLToPath(new URL('../apps/web/app.js', import.meta.url))

function extractInstallCommand(): { command: (url: string) => string; source: string } {
  const app = readFileSync(APP_SOURCE, 'utf8')
  const fn = /function installCommand\(url\) \{\n([\s\S]*?)\n\}/.exec(app)
  assert.ok(fn, 'app.js must define installCommand(url)')
  const body = fn[1]
  const file = /const file = '([^']+)'/.exec(body)?.[1]
  assert.ok(file, 'installCommand must bind the temp file path')
  const literal = /return `([\s\S]*?)`/.exec(body)?.[1]
  assert.ok(literal, 'installCommand must return a template literal')

  // Guard the template shape: evaluating it below is only faithful while these
  // are the sole interpolations. A new `${...}` makes this test red, not wrong.
  const interpolations = [
    ...new Set([...literal.matchAll(/(?<!\\)\$\{(\w+)\}/g)].map((m) => m[1]))
  ].sort()
  assert.deepEqual(interpolations, ['file', 'url'], literal)
  assert.ok(literal.includes('\\${code}'), 'the exit-code message must escape ${code}')

  const command = (url: string): string =>
    literal
      .replace(/\\\$\{code\}/g, '${code}')
      .replace(/\$\{url\}/g, () => url)
      .replace(/\$\{file\}/g, () => file)
  return { command, source: body }
}

const INSTALL = extractInstallCommand()
const INSTALL_URL = 'https://platform.example/install/host.sh?download=abc&token=def'

type OneLinerRun = {
  status: number | null
  stdout: string
  stderr: string
  tmpDir: string
  kept: string[]
}

const scratchDirs: string[] = []

after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Runs the extracted one-liner with a stub curl. `body === null` makes the
 * download fail; otherwise the stub writes `body` to the `-o` target and exits
 * 0, so the only exit code left is the install script's own.
 */
function runOneLiner(body: string | null, extraStubs: Record<string, string> = {}): OneLinerRun {
  const home = mkdtempSync(join(tmpdir(), 'orca-u275-'))
  scratchDirs.push(home)
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const curl =
    body === null
      ? '#!/usr/bin/env bash\nexit 22\n'
      : `#!/usr/bin/env bash
prev=""
out=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
cat > "$out" <<'ORCA_U275_STUB'
${body}
ORCA_U275_STUB
exit 0
`
  writeFileSync(join(bin, 'curl'), curl, { mode: 0o755 })
  for (const [name, script] of Object.entries(extraStubs)) {
    writeFileSync(join(bin, name), script, { mode: 0o755 })
  }
  const tmpDir = join(home, 'tmp')
  mkdirSync(tmpDir)
  const result = spawnSync('bash', ['-c', INSTALL.command(INSTALL_URL)], {
    encoding: 'utf8',
    cwd: home,
    timeout: 10_000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpDir }
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    tmpDir,
    kept: readdirSync(tmpDir)
  }
}

describe('U275: install one-liner runs under a real shell', () => {
  test('模板取自 app.js 源码，转义与引号不被测试重写', () => {
    assert.ok(INSTALL.source.includes('exit "$code"'))
    assert.ok(INSTALL.command(INSTALL_URL).endsWith('exit "$code"'))
    assert.ok(INSTALL.command(INSTALL_URL).includes('安装脚本退出码 ${code}，临时文件保留在'))
    assert.ok(INSTALL.command(INSTALL_URL).includes(`curl -fsSL "${INSTALL_URL}" -o `))
  })

  test('下载失败：外层退出 65 并提示重新生成，不留下临时文件', () => {
    const run = runOneLiner(null)

    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(run.kept, [], 'a failed download must not leave a script behind')
  })

  for (const code of [64, 69, 70]) {
    test(`安装脚本退出 ${code}：外层原码透传，保留脚本供诊断`, () => {
      const run = runOneLiner(`echo 'STUB-${code}: 安装脚本自有失败' >&2\nexit ${code}`)

      assert.equal(run.status, code, run.stderr)
      assert.match(run.stderr, new RegExp(`STUB-${code}: 安装脚本自有失败`))
      assert.equal(run.kept.length, 1, 'a failed install keeps the script')
      assert.ok(
        run.stderr.includes(`安装脚本退出码 ${code}，临时文件保留在 ${join(run.tmpDir, run.kept[0])}`),
        run.stderr
      )
    })
  }

  test('安装脚本被 SIGTERM 杀死：外层退出 143（128+15），不被压成 1', () => {
    const run = runOneLiner('kill -TERM $$\n')

    assert.equal(run.status, 143, run.stderr)
    assert.equal(run.kept.length, 1, 'a signalled install keeps the script')
    assert.ok(run.stderr.includes('安装脚本退出码 143，临时文件保留在'), run.stderr)
  })

  test('安装脚本成功：外层退出 0 并删除临时文件', () => {
    const run = runOneLiner("echo 'STUB-OK'\nexit 0")

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /STUB-OK/)
    assert.deepEqual(run.kept, [], 'a successful install removes the script')
    assert.doesNotMatch(run.stderr, /未能删除|临时文件保留/)
  })

  test('清理失败：告警到 stderr，但仍以安装脚本的 0 退出', () => {
    const run = runOneLiner("echo 'STUB-OK'\nexit 0", {
      // Simulates a read-only temp location; a stub keeps the case deterministic.
      rm: '#!/usr/bin/env bash\nexit 1\n'
    })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /安装完成，但临时文件未能删除：/)
    assert.equal(run.kept.length, 1, 'the undeletable script is still there')
  })
})
