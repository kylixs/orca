import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRelayRouteFreshness,
  type RelayRouteLike
} from '../src/relay-route-freshness.ts'

const HOST_OFFLINE_MS = 60_000
const NOW = 1_700_000_000_000
const TARGET = '127.0.0.1:16811'

function route(updatedAt?: number): RelayRouteLike {
  return { target: TARGET, ...(updatedAt === undefined ? {} : { updatedAt }) }
}

test('新鲜路由（10s）判为不陈旧', () => {
  const result = evaluateRelayRouteFreshness({
    route: route(NOW - 10_000),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(result.relayRouteUpdatedAt, NOW - 10_000)
  assert.equal(result.relayRouteAgeSec, 10)
  assert.equal(result.relayRouteStale, false)
})

test('静默 200s 超过 3×心跳窗判为陈旧', () => {
  const result = evaluateRelayRouteFreshness({
    route: route(NOW - 200_000),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(result.relayRouteAgeSec, 200)
  assert.equal(result.relayRouteStale, true)
})

test('离线宿主残留路由不因 hostOnline 门而永远不可达', () => {
  // No liveness input exists: age alone decides, so an offline host's route ages out.
  const result = evaluateRelayRouteFreshness({
    route: route(NOW - 181_000),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(result.relayRouteStale, true)
})

test('3×心跳窗边界：恰好 180s 不陈旧，超出才陈旧', () => {
  const atBoundary = evaluateRelayRouteFreshness({
    route: route(NOW - 180_000),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(atBoundary.relayRouteStale, false)
  const past = evaluateRelayRouteFreshness({
    route: route(NOW - 181_000),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(past.relayRouteStale, true)
})

test('目标漂移无视年龄判为陈旧', () => {
  const result = evaluateRelayRouteFreshness({
    route: route(NOW),
    directAddrs: ['10.0.0.1:16811'],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(result.relayRouteStale, true)
})

test('目标漂移且 age 未知仍判为陈旧', () => {
  const result = evaluateRelayRouteFreshness({
    route: route(),
    directAddrs: ['10.0.0.1:16811'],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.equal(result.relayRouteUpdatedAt, null)
  assert.equal(result.relayRouteAgeSec, null)
  assert.equal(result.relayRouteStale, true)
})

test('旧快照缺 updatedAt 且目标匹配：年龄与结论均为未知', () => {
  const result = evaluateRelayRouteFreshness({
    route: route(),
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.deepEqual(result, {
    relayRouteUpdatedAt: null,
    relayRouteAgeSec: null,
    relayRouteStale: null
  })
})

test('无路由：三字段均为 null', () => {
  const result = evaluateRelayRouteFreshness({
    route: undefined,
    directAddrs: [TARGET],
    now: NOW,
    hostOfflineMs: HOST_OFFLINE_MS
  })
  assert.deepEqual(result, {
    relayRouteUpdatedAt: null,
    relayRouteAgeSec: null,
    relayRouteStale: null
  })
})
