import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderHostUnit,
  renderRelayUnit,
  renderSystemdUnit
} from '../apps/api/src/systemd-unit-template.ts'
import { hostInstallScript } from '../apps/api/src/server.ts'

const HOST_UNIT = `[Unit]
Description=Orca Cloud 宿主代理
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
EnvironmentFile=%h/.orca-cloud/host.env
ExecStart=/usr/bin/orca-ide --host-mode
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`

const RELAY_UNIT = `[Unit]
Description=Orca Cloud 中继
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
EnvironmentFile=/opt/orca/relay.env
ExecStart=/usr/bin/node /opt/orca/current/apps/relay/src/relay.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`

describe('H10a: systemd unit 模板', () => {
  test('renderSystemdUnit 渲染完整且参数化的单元', () => {
    const unit = renderSystemdUnit({
      description: 'Demo',
      execStart: '/bin/demo --run',
      environmentFile: '/tmp/demo.env',
      restartPreventExitStatus: 78,
      startLimitIntervalSec: 30,
      startLimitBurst: 3,
      extraServiceLines: ['WorkingDirectory=/tmp']
    })
    assert.equal(
      unit,
      `[Unit]
Description=Demo
StartLimitIntervalSec=30
StartLimitBurst=3

[Service]
EnvironmentFile=/tmp/demo.env
ExecStart=/bin/demo --run
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
WorkingDirectory=/tmp

[Install]
WantedBy=default.target
`
    )
  })

  test('renderHostUnit 含 78 与 host.env，且无退出码 3', () => {
    assert.equal(renderHostUnit({ binPath: '/usr/bin/orca-ide' }), HOST_UNIT)
    assert.match(HOST_UNIT, /^RestartPreventExitStatus=78$/m)
    assert.doesNotMatch(HOST_UNIT, /RestartPreventExitStatus=.*\b3\b/)
  })

  test('renderRelayUnit 用 current 入口与 <root>/relay.env，且不含 78', () => {
    assert.equal(renderRelayUnit({ nodePath: '/usr/bin/node', root: '/opt/orca' }), RELAY_UNIT)
    assert.doesNotMatch(RELAY_UNIT, /RestartPreventExitStatus/)
    assert.doesNotMatch(RELAY_UNIT, /host\.env/)
  })

  test('renderRelayUnit 容忍 root 末尾斜杠', () => {
    assert.equal(renderRelayUnit({ nodePath: '/usr/bin/node', root: '/opt/orca/' }), RELAY_UNIT)
  })

  test('renderRelayUnit 接受自定义入口（仓库模式）', () => {
    const unit = renderRelayUnit({
      nodePath: '/usr/bin/node',
      root: '/opt/orca',
      entry: '/opt/orca/cloud-platform/apps/relay/src/relay.ts'
    })
    assert.match(
      unit,
      /^ExecStart=\/usr\/bin\/node \/opt\/orca\/cloud-platform\/apps\/relay\/src\/relay\.ts$/m
    )
    assert.doesNotMatch(unit, /\/current\//)
  })

  test('缺少必填参数直接报错', () => {
    const base = {
      description: 'Demo',
      execStart: '/bin/demo',
      environmentFile: '/tmp/demo.env',
      startLimitBurst: 5
    }
    assert.throws(() => renderSystemdUnit({ ...base, description: '' }), /description/)
    assert.throws(() => renderSystemdUnit({ ...base, execStart: '' }), /execStart/)
    assert.throws(() => renderSystemdUnit({ ...base, environmentFile: '' }), /environmentFile/)
    assert.throws(() => renderSystemdUnit({ ...base, startLimitBurst: 0 }), /startLimitBurst/)
    assert.throws(() => renderHostUnit({ binPath: '' }), /binPath/)
    assert.throws(() => renderRelayUnit({ nodePath: '', root: '/opt/orca' }), /nodePath/)
    assert.throws(() => renderRelayUnit({ nodePath: '/usr/bin/node', root: '' }), /root/)
  })

  test('host 安装脚本仍嵌入字节等价的 unit', () => {
    const script = hostInstallScript({ platformUrl: 'https://platform.example', token: 'tok' })
    assert.ok(script.includes(renderHostUnit({ binPath: '$ORCA_HOST_BIN' })))
    assert.match(script, /^Description=Orca Cloud 宿主代理$/m)
    assert.match(script, /^EnvironmentFile=%h\/\.orca-cloud\/host\.env$/m)
    assert.match(script, /^ExecStart=\$ORCA_HOST_BIN --host-mode$/m)
    assert.match(script, /^RestartPreventExitStatus=78$/m)
  })
})
