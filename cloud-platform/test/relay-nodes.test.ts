import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRelayNodeRegistry,
  ipOfDirectAddr,
  parseRelayRegistration,
  routeKeyFromDirectAddrs
} from '../apps/api/src/relay-nodes.ts'

/**
 * M114b: a relay's dialable address decides what `/connect` hands a client, so
 * both the registration parser and the registry's host bookkeeping are pinned
 * here — including the pre-`host` bodies old relays still send.
 */

describe('中继注册体解析：host 三种情况', () => {
  test('显式 host 保留（并去掉首尾空白）', () => {
    assert.deepEqual(parseRelayRegistration({ port: 18443, host: 'relay.example.test' }), {
      host: 'relay.example.test',
      port: 18443
    })
    assert.deepEqual(parseRelayRegistration({ port: 18443, host: '  relay.example.test  ' }), {
      host: 'relay.example.test',
      port: 18443
    })
  })

  test('无 host 返回 undefined，旧注册体不报错', () => {
    const parsed = parseRelayRegistration({ port: 18443 })
    assert.ok(parsed)
    assert.equal(parsed.host, undefined)
    assert.equal('host' in parsed, true, 'the key stays present so callers need no shape switch')
    assert.deepEqual(parseRelayRegistration({ id: 'relay-a', port: 18443 }), {
      id: 'relay-a',
      host: undefined,
      port: 18443
    })
  })

  test('空白串 host 剔除为 undefined', () => {
    assert.equal(parseRelayRegistration({ port: 18443, host: '   ' })?.host, undefined)
    assert.equal(parseRelayRegistration({ port: 18443, host: '\t\n' })?.host, undefined)
  })

  test('端口仍是一票否决项', () => {
    assert.equal(parseRelayRegistration({ host: 'relay.example.test' }), null)
    assert.equal(parseRelayRegistration({ port: 0, host: 'relay.example.test' }), null)
    assert.equal(parseRelayRegistration({ port: 70000, host: 'relay.example.test' }), null)
  })
})

describe('中继注册表：host 的保留与更新', () => {
  test('首注册无 host 时为空串，由平台回填注册来源地址', () => {
    const registry = createRelayNodeRegistry()
    const node = registry.register({ id: 'relay-a', port: 18443 }, 1_000)
    assert.equal(node.host, '')
    assert.equal(node.port, 18443)
  })

  test('再次注册未报 host：保留原地址（来源 IP 不应把显式地址冲掉）', () => {
    const registry = createRelayNodeRegistry()
    registry.register({ id: 'relay-a', host: 'relay.example.test', port: 18443 }, 1_000)
    const refreshed = registry.register({ id: 'relay-a', port: 18443 }, 2_000)
    assert.equal(refreshed.host, 'relay.example.test')
    assert.equal(refreshed.lastSeenAt, 2_000)
  })

  test('再次注册报新 host：地址更新', () => {
    const registry = createRelayNodeRegistry()
    registry.register({ id: 'relay-a', host: '10.0.0.8', port: 18443 }, 1_000)
    const moved = registry.register({ id: 'relay-a', host: 'relay.example.test', port: 18443 }, 2_000)
    assert.equal(moved.host, 'relay.example.test')
  })

  test('注册顺序即优先级，掉线节点离开 healthy', () => {
    const registry = createRelayNodeRegistry()
    registry.register({ id: 'relay-a', host: '10.0.0.1', port: 18441 }, 1_000)
    registry.register({ id: 'relay-b', host: '10.0.0.2', port: 18442 }, 2_000)
    assert.deepEqual(registry.healthy(2_500).map((node) => node.id), ['relay-a', 'relay-b'])

    assert.deepEqual(registry.healthy(32_000, 30_000).map((node) => node.id), ['relay-b'])
    assert.deepEqual(registry.all().map((node) => node.id), ['relay-a', 'relay-b'])
  })
})

describe('默认路由键：取上报 IP 而非主机名', () => {
  test('IPv4 带端口的直连地址 → ip-<点改横线>', () => {
    assert.equal(routeKeyFromDirectAddrs(['192.168.2.202:5210'], 'dev-001'), 'ip-192-168-2-202')
    assert.equal(ipOfDirectAddr('192.168.2.202:5210'), '192.168.2.202')
  })

  test('IPv6 中括号与裸字面量 → 冒号改横线', () => {
    assert.equal(routeKeyFromDirectAddrs(['[fe80::1]:5210'], 'dev-001'), 'ip-fe80--1')
    assert.equal(ipOfDirectAddr('[fe80::1]:5210'), 'fe80::1')
    assert.equal(ipOfDirectAddr('fe80::1'), 'fe80::1')
    assert.equal(routeKeyFromDirectAddrs(['fe80::1'], 'dev-001'), 'ip-fe80--1')
  })

  test('取首个直连地址，后续地址不影响', () => {
    assert.equal(
      routeKeyFromDirectAddrs(['10.0.0.8:9', '192.168.2.202:5210'], 'dev-001'),
      'ip-10-0-0-8'
    )
  })

  test('无直连地址回退主机名（与旧行为一致）', () => {
    assert.equal(routeKeyFromDirectAddrs([], 'dev-001'), 'dev-001')
    assert.equal(routeKeyFromDirectAddrs([''], 'dev-001'), 'dev-001')
    assert.equal(routeKeyFromDirectAddrs(['localhost:9'], 'dev-001'), 'ip-localhost')
  })

  test('派生键不含点（中继拒绝带点的 SNI 路由键）', () => {
    for (const addr of ['192.168.2.202:5210', '[fe80::1]:5210', 'fe80::1']) {
      assert.equal(routeKeyFromDirectAddrs([addr], 'dev-001').includes('.'), false)
    }
  })
})
