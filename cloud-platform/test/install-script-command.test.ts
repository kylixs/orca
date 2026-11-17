import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  requireCommand,
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

  test('shellQuote 复用单引号转义实现', () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`)
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
