import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
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
 */

const INSTALL = installCommandTemplateSource()
const INSTALL_URL = 'https://platform.example/install/host.sh?download=abc&token=def'
const installCommand = (url: string): string =>
  renderInstallCommand(INSTALL.template, INSTALL.file, url)
const runLiner = (
  body: string | null,
  options: { extraStubs?: Record<string, string> } = {}
): OneLinerRun =>
  runOneLiner(installCommand(INSTALL_URL), { body, scratchPrefix: 'orca-u275-', ...options })

describe('U275: install one-liner runs under a real shell', () => {
  test('模板取自 app.js 源码，转义与引号不被测试重写', () => {
    assert.ok(INSTALL.source.includes('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).endsWith('exit "$code"'))
    assert.ok(installCommand(INSTALL_URL).includes('安装脚本退出码 ${code}，临时文件保留在'))
    assert.ok(installCommand(INSTALL_URL).includes(`curl -fsSL "${INSTALL_URL}" -o `))
  })

  test('下载失败：外层退出 65 并提示重新生成，不留下临时文件', () => {
    const run = runLiner(null)

    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /安装失败：命令已失效或网络不可达，请让管理员重新生成（65）/)
    assert.deepEqual(run.kept, [], 'a failed download must not leave a script behind')
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
