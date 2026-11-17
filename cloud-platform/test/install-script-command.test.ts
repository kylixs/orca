import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  requireCommand,
  requireNodeVersion,
  requireWritableDir,
  shellQuote,
  systemdAvailable
} from '../apps/api/src/install-script-command.ts'
import { hostInstallScript, relayInstallScript } from '../apps/api/src/server.ts'

describe('U183 R12: install-script command helper', () => {
  test('requireCommand 探测 PATH 并以 EX_CONFIG 78 失败', () => {
    const snippet = requireCommand('node', '未找到 node')
    assert.match(snippet, /command -v node/)
    assert.match(snippet, /未找到 node/)
    assert.match(snippet, /exit 78/)
  })

  test('requireCommand 支持多候选命令（host 的 orca-ide/orca）', () => {
    const snippet = requireCommand(['orca-ide', 'orca'], '未找到 Orca 宿主程序')
    assert.match(snippet, /command -v orca-ide/)
    assert.match(snippet, /command -v orca/)
    assert.match(snippet, /exit 78/)
  })

  test('systemdAvailable 是可作 if 条件的 systemctl 探测', () => {
    assert.match(systemdAvailable(), /command -v systemctl/)
  })

  test('requireNodeVersion 以 64 拒绝低于门槛的 Node', () => {
    const snippet = requireNodeVersion('"$NODE_BIN"', 22, 18, 'Node.js 版本过低（64）')
    assert.match(snippet, /process\.versions\.node/)
    assert.match(snippet, /-lt 22/)
    assert.match(snippet, /-lt 18/)
    assert.match(snippet, /exit 64/)
  })

  test('requireWritableDir 以 78 拒绝不可写的安装根', () => {
    const snippet = requireWritableDir('$ORCA_RELAY_ROOT', '安装根不可写（78）')
    assert.match(snippet, /mkdir -p "\$ORCA_RELAY_ROOT"/)
    assert.match(snippet, /-w "\$ORCA_RELAY_ROOT"/)
    assert.match(snippet, /安装根不可写/)
    assert.match(snippet, /exit 78/)
  })

  test('shellQuote 复用单引号转义实现', () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  })

  test('H9a: host 脚本解析宿主程序真实路径并以 --host-mode 启动', () => {
    const script = hostInstallScript({
      platformUrl: 'https://platform.example',
      token: 'tok'
    })
    // ORCA_HOST_BIN is the resolved absolute path from `command -v`.
    assert.match(script, /ORCA_HOST_BIN="\$\(command -v orca-ide/)
    assert.match(script, /\$ORCA_HOST_BIN --host-mode/)
    // Bare `orca` must never be the start command (GNOME Orca collision).
    assert.doesNotMatch(script, /(^|[^A-Za-z_])orca --host-mode/)
    // Host mode pins its own profile so the state file path is predictable.
    assert.match(script, /ORCA_USER_DATA_PATH=/)
    assert.match(script, /orca-cloud-host-state\.json/)
    // Re-enrolment is a one-shot CLI flag, never a persistent env entry.
    assert.doesNotMatch(script, /ORCA_CLOUD_REENROLL/)
  })

  test('host/relay 生成脚本都消费 helper 片段', () => {
    const host = hostInstallScript({ platformUrl: 'https://platform.example', token: 'tok' })
    const relay = relayInstallScript({
      platformUrl: 'https://platform.example',
      internalToken: 'tok'
    })
    assert.match(host, /command -v orca-ide/)
    assert.match(host, /exit 78/)
    assert.match(relay, /command -v node/)
    assert.match(relay, /exit 78/)
    for (const script of [host, relay]) {
      assert.match(script, /command -v systemctl/)
    }
  })
})
