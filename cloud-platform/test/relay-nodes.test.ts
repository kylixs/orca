import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_ROUTE_KEY_PATTERN,
  createRelayNodeRegistry,
  ipOfDirectAddr,
  parseInstallNonce,
  parseRelayRegistration,
  routeKeyFromDirectAddrs
} from '../apps/api/src/relay-nodes.ts'
import { parseBrowserPath, resolveRelayEnv } from '../apps/relay/src/relay.ts'

/**
 * M114b: a relay's dialable address decides what `/connect` hands a client, so
 * both the registration parser and the registry's host bookkeeping are pinned
 * here — including the pre-`host` bodies old relays still send.
 */

describe('中继注册体解析：host 三种情况', () => {
  test('显式 host 保留（并去掉首尾空白）', () => {
    assert.deepEqual(parseRelayRegistration({ port: 18443, host: 'relay.example.test' }), {
      host: 'relay.example.test',
      browserHost: undefined,
      installNonce: undefined,
      port: 18443
    })
    assert.deepEqual(parseRelayRegistration({ port: 18443, host: '  relay.example.test  ' }), {
      host: 'relay.example.test',
      browserHost: undefined,
      installNonce: undefined,
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
      browserHost: undefined,
      installNonce: undefined,
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

describe('中继注册体解析：browserHost 白名单（W6b）', () => {
  test('合法 host[:port] 保留（并去掉首尾空白）', () => {
    const plain = parseRelayRegistration({ port: 18443, browserHost: 'relay-browser.example.test' })
    assert.equal(plain?.browserHost, 'relay-browser.example.test')
    const withPort = parseRelayRegistration({
      port: 18443,
      browserHost: ' relay.example.test:8443 '
    })
    assert.equal(withPort?.browserHost, 'relay.example.test:8443')
  })

  test('缺字段、旧注册体、空白串、非字符串都是 undefined', () => {
    assert.equal(parseRelayRegistration({ port: 18443 })?.browserHost, undefined)
    assert.equal(
      parseRelayRegistration({ port: 18443, browserHost: '   ' })?.browserHost,
      undefined
    )
    assert.equal(parseRelayRegistration({ port: 18443, browserHost: 42 })?.browserHost, undefined)
  })

  test('白名单外字符置空：scheme、路径、空白、越界端口都不收', () => {
    for (const bad of [
      'https://relay.example.test',
      'relay.example.test/h/dev-001',
      'relay example.test',
      'relay.example.test:0',
      'relay.example.test:99999'
    ]) {
      assert.equal(
        parseRelayRegistration({ port: 18443, browserHost: bad })?.browserHost,
        undefined,
        bad
      )
    }
  })

  test('白名单外的宣告打 warn：含形状不含值，同一值不重复刷屏', () => {
    const warns: string[] = []
    const original = console.warn
    console.warn = (...parts: unknown[]) => {
      warns.push(parts.map(String).join(' '))
    }
    try {
      const bad = 'https://warn-probe.example.test'
      parseRelayRegistration({ port: 18443, browserHost: bad })
      parseRelayRegistration({ port: 18443, browserHost: bad })
      parseRelayRegistration({ port: 18443 })
      parseRelayRegistration({ port: 18443, browserHost: '   ' })
    } finally {
      console.warn = original
    }
    assert.equal(warns.length, 1, warns.join('\n'))
    assert.match(warns[0], /not a bare host\[:port\]/)
    assert.equal(
      warns[0].includes('warn-probe.example.test'),
      false,
      'the untrusted value must not reach the log'
    )
  })
})

describe('中继注册体解析：installNonce（U183 R10a）', () => {
  test('合法 nonce 保留并去掉首尾空白', () => {
    assert.equal(
      parseRelayRegistration({ port: 18443, installNonce: ' install-AbC_123-' })?.installNonce,
      'install-AbC_123-'
    )
    assert.equal(parseInstallNonce({ installNonce: 'install-AbC_123-' }), 'install-AbC_123-')
  })

  test('缺失、null、空白串与非字符串：缺失回退为 undefined', () => {
    assert.equal(parseRelayRegistration({ port: 18443 })?.installNonce, undefined)
    assert.equal(parseInstallNonce({}), undefined)
    assert.equal(parseInstallNonce({ installNonce: null }), undefined)
    assert.equal(parseInstallNonce({ installNonce: '   ' }), undefined)
  })

  test('非字符串、白名单外字符、超 128 字符都是非法', () => {
    assert.equal(parseInstallNonce({ installNonce: 42 }), null)
    for (const bad of ['has space', 'semi;colon', 'slash/path', 'dotted.nonce', '中文']) {
      assert.equal(parseInstallNonce({ installNonce: bad }), null, bad)
    }
    assert.equal(parseInstallNonce({ installNonce: 'a'.repeat(128) }), 'a'.repeat(128))
    assert.equal(parseInstallNonce({ installNonce: 'a'.repeat(129) }), null)
    assert.equal(parseRelayRegistration({ port: 18443, installNonce: 'a'.repeat(129) }), null)
  })
})

describe('routeKey 形状契约：平台闸门与中继 /h/ 解析器对拍（MIN-3）', () => {
  // The two deployment units each hold their own copy of `^[A-Za-z0-9_-]+$`;
  // a one-sided tightening would mint entry URLs the relay answers with 404.
  // Keys containing `/` are out of scope: the relay splits the URL path on it,
  // so such input is never a single key on that side.
  const samples = [
    ['dev-001', true],
    ['ip-10-0-0-8', true],
    ['a_b', true],
    ['W6b_Entry-1', true],
    ['-lead', true],
    ['w6b.bad.key', false],
    ['a b', false],
    ['a%2Fb', false],
    ['trail.', false],
    ['..', false],
    ['', false],
    ['键', false]
  ] as const

  test('同一组样本两侧判定一致', () => {
    for (const [key, accepted] of samples) {
      const platform = BROWSER_ROUTE_KEY_PATTERN.test(key)
      const relay = parseBrowserPath(`/h/${key}/web-index.html`) !== null
      assert.equal(platform, relay, `both sides must agree on ${JSON.stringify(key)}`)
      assert.equal(platform, accepted, `verdict for ${JSON.stringify(key)}`)
    }
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
    const moved = registry.register(
      { id: 'relay-a', host: 'relay.example.test', port: 18443 },
      2_000
    )
    assert.equal(moved.host, 'relay.example.test')
  })

  test('注册顺序即优先级，掉线节点离开 healthy', () => {
    const registry = createRelayNodeRegistry()
    registry.register({ id: 'relay-a', host: '10.0.0.1', port: 18441 }, 1_000)
    registry.register({ id: 'relay-b', host: '10.0.0.2', port: 18442 }, 2_000)
    assert.deepEqual(
      registry.healthy(2_500).map((node) => node.id),
      ['relay-a', 'relay-b']
    )

    assert.deepEqual(
      registry.healthy(32_000, 30_000).map((node) => node.id),
      ['relay-b']
    )
    assert.deepEqual(
      registry.all().map((node) => node.id),
      ['relay-a', 'relay-b']
    )
  })
})

describe('中继注册表：browserHost 随最新注册体（W6b）', () => {
  test('首注册无 browserHost 为空串，报了才有值', () => {
    const registry = createRelayNodeRegistry()
    const bare = registry.register({ id: 'relay-a', port: 18443 }, 1_000)
    assert.equal(bare.browserHost, '')
    const edged = registry.register(
      { id: 'relay-b', browserHost: 'relay-browser.example.test', port: 18444 },
      2_000
    )
    assert.equal(edged.browserHost, 'relay-browser.example.test')
  })

  test('再次注册未报 browserHost：清空（关闭浏览器模式必须停止被推荐）', () => {
    const registry = createRelayNodeRegistry()
    registry.register(
      { id: 'relay-a', browserHost: 'relay-browser.example.test', port: 18443 },
      1_000
    )
    const refreshed = registry.register({ id: 'relay-a', port: 18443 }, 2_000)
    assert.equal(refreshed.browserHost, '', 'a disabled edge must not stay advertised')
  })
})

describe('中继注册表：installNonce 随最新注册体（U183 R10a）', () => {
  test('未报时为空串，报了才有值（旧中继兼容）', () => {
    const registry = createRelayNodeRegistry()
    assert.equal(registry.register({ id: 'relay-old', port: 18443 }, 1_000).installNonce, '')
    const node = registry.register(
      { id: 'relay-new', installNonce: 'install-AbC_123-', port: 18444 },
      2_000
    )
    assert.equal(node.installNonce, 'install-AbC_123-')
  })

  test('再次注册未报 nonce：清空（重启成旧版本后旧值不得冒充本次安装）', () => {
    const registry = createRelayNodeRegistry()
    registry.register({ id: 'relay-a', installNonce: 'install-AbC_123-', port: 18443 }, 1_000)
    const refreshed = registry.register({ id: 'relay-a', port: 18443 }, 2_000)
    assert.equal(refreshed.installNonce, '')
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

/**
 * U38: `/install/relay.sh` writes `ORCA_CLOUD_*`, while the entry used to read
 * only the bare names — a copy-of-the-script deployment silently dialed the
 * loopback default. The resolver must prefer the new names, keep the old ones
 * alive, and say out loud whenever it had to degrade.
 */
describe('中继 env 解析：安装脚本名优先，旧名兼容，降级必告警', () => {
  test('安装脚本写入的 ORCA_CLOUD_* 名被读取', () => {
    const resolved = resolveRelayEnv({
      ORCA_CLOUD_API_URL: 'http://100.103.213.12:18787',
      ORCA_CLOUD_INTERNAL_TOKEN: 'token-a'
    })
    assert.equal(resolved.apiUrl, 'http://100.103.213.12:18787')
    assert.equal(resolved.internalToken, 'token-a')
    assert.deepEqual(resolved.warnings, [], 'a complete env must stay silent')
  })

  test('两套名字都在时 ORCA_CLOUD_* 胜出并告警分歧', () => {
    const resolved = resolveRelayEnv({
      ORCA_CLOUD_API_URL: 'http://new:18787',
      API_URL: 'http://old:18787',
      ORCA_CLOUD_INTERNAL_TOKEN: 'new-token',
      INTERNAL_TOKEN: 'old-token'
    })
    assert.equal(resolved.apiUrl, 'http://new:18787')
    assert.equal(resolved.internalToken, 'new-token')
    assert.equal(resolved.warnings.length, 2)
    assert.match(resolved.warnings[0], /ORCA_CLOUD_API_URL/)
    assert.match(resolved.warnings[1], /ORCA_CLOUD_INTERNAL_TOKEN/)
  })

  test('照抄旧 env 名仍可用（既有部署零破坏），但点名将改写', () => {
    const resolved = resolveRelayEnv({
      API_URL: 'http://100.103.213.12:18787',
      INTERNAL_TOKEN: 'legacy-token'
    })
    assert.equal(resolved.apiUrl, 'http://100.103.213.12:18787')
    assert.equal(resolved.internalToken, 'legacy-token')
    assert.equal(resolved.warnings.length, 2)
    assert.match(resolved.warnings[0], /ORCA_CLOUD_API_URL unset/)
  })

  test('全缺省回落默认值，且告警点名期望的 env 名（不再静默吞掉）', () => {
    const resolved = resolveRelayEnv({})
    assert.equal(resolved.apiUrl, 'http://127.0.0.1:18787')
    assert.equal(resolved.internalToken, 'internal-test-token')
    assert.equal(resolved.warnings.length, 2)
    assert.match(
      resolved.warnings[0],
      /ORCA_CLOUD_API_URL unset; defaulting to http:\/\/127\.0\.0\.1:18787/
    )
    assert.match(resolved.warnings[1], /ORCA_CLOUD_INTERNAL_TOKEN unset/)
  })

  test('空白串视为未设置，同样走回落并告警', () => {
    const resolved = resolveRelayEnv({ ORCA_CLOUD_API_URL: '   ', ORCA_CLOUD_INTERNAL_TOKEN: '  ' })
    assert.equal(resolved.warnings.length, 2)
    assert.equal(resolved.internalToken, 'internal-test-token')
  })
})
