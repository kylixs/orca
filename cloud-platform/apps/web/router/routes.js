/* U106 管理台 hash 路由表与解析/格式化（纯模块，无 DOM、无 history）。 */

/**
 * @typedef {'login'|'workbench'|'projects'|'workspace'|'hosts'|'relays'|'users'|'audit'|'settings'|'forbidden'|'not-found'} RouteName
 * @typedef {Record<string, string>} RouteParams
 * @typedef {URLSearchParams} RouteQuery
 * @typedef {{ name: RouteName, params: RouteParams, query: RouteQuery }} Route
 */

/** 无 hash 的根地址回落到此路由。 */
export const DEFAULT_ROUTE = 'workbench'

// 字面段大小写敏感；`:id` 为不透明参数。顺序只影响同长度的字面匹配，当前无冲突。
const ROUTE_PATTERNS = Object.freeze([
  { name: 'login', segments: ['login'] },
  { name: 'workbench', segments: ['workbench'] },
  { name: 'projects', segments: ['projects'] },
  { name: 'projects', segments: ['projects', ':id'] },
  { name: 'workspace', segments: ['workspace', ':id'] },
  { name: 'hosts', segments: ['hosts'] },
  { name: 'hosts', segments: ['hosts', ':id'] },
  { name: 'relays', segments: ['relays'] },
  { name: 'users', segments: ['users'] },
  { name: 'users', segments: ['users', ':id'] },
  { name: 'audit', segments: ['audit'] },
  { name: 'settings', segments: ['settings'] },
  { name: 'forbidden', segments: ['forbidden'] },
  { name: 'not-found', segments: ['not-found'] }
])

/** 去重后的路由名，供导航/文档校验。 */
export const ROUTE_NAMES = Object.freeze([
  ...new Set(ROUTE_PATTERNS.map((pattern) => pattern.name))
])

/**
 * 解析 `#/...`。未知形态一律返回显式 `not-found`（不回落工作台）。
 * 空 hash 与 `#/` 视为入口默认路由。空值查询参数被丢弃（规范化）。
 * @param {string} hash
 * @returns {Route}
 */
export function parseHash(hash) {
  const source = typeof hash === 'string' ? hash : ''
  const fragment = source.startsWith('#') ? source.slice(1) : source
  const queryIndex = fragment.indexOf('?')
  const rawPath = queryIndex === -1 ? fragment : fragment.slice(0, queryIndex)
  const query = normalizeQuery(
    new URLSearchParams(queryIndex === -1 ? '' : fragment.slice(queryIndex + 1))
  )
  const notFound = () => ({ name: 'not-found', params: {}, query })

  if (rawPath === '' || rawPath === '/') {
    return { name: DEFAULT_ROUTE, params: {}, query }
  }
  if (!rawPath.startsWith('/')) {
    return notFound()
  }

  const trimmed = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const segments = trimmed.slice(1).split('/')

  for (const pattern of ROUTE_PATTERNS) {
    if (pattern.segments.length !== segments.length) {
      continue
    }
    /** @type {RouteParams} */
    const params = {}
    let matched = true
    for (let index = 0; index < pattern.segments.length; index += 1) {
      const expected = pattern.segments[index]
      const actual = segments[index]
      if (expected.startsWith(':')) {
        // 字面段按原样比较，参数段才解码：百分号编码不能伪装成字面路由。
        let decoded
        try {
          decoded = decodeURIComponent(actual)
        } catch {
          matched = false
          break
        }
        if (decoded === '') {
          matched = false
          break
        }
        params[expected.slice(1)] = decoded
      } else if (expected !== actual) {
        matched = false
        break
      }
    }
    if (matched) {
      return { name: pattern.name, params, query }
    }
  }
  return notFound()
}

/**
 * 生成规范 hash；路径参数按 `encodeURIComponent` 编码，查询保持迭代顺序。
 * @param {{ name: RouteName, params?: RouteParams, query?: RouteQuery | Iterable<[string, unknown]> | Record<string, unknown> }} route
 * @returns {string}
 */
export function buildHash(route) {
  const name = route?.name
  const query = toQuery(route?.query)
  if (name === 'not-found') {
    return withQuery('#/not-found', query)
  }

  const params = route?.params ?? {}
  const patterns = ROUTE_PATTERNS.filter((pattern) => pattern.name === name)
  if (patterns.length === 0) {
    throw new RangeError(`未知路由：${String(name)}`)
  }

  const usable = patterns.filter((candidate) =>
    candidate.segments.every((segment) => !segment.startsWith(':') || hasParam(params, segment))
  )
  // 参数更具体的变体优先（`projects/:id` 胜过 `projects`）。
  const pattern =
    usable.length === 0
      ? patterns[0]
      : usable.reduce((best, candidate) =>
          candidate.segments.length > best.segments.length ? candidate : best
        )

  const path = pattern.segments
    .map((segment) =>
      segment.startsWith(':') ? encodeURIComponent(requireParam(params, segment.slice(1))) : segment
    )
    .join('/')
  return withQuery(`#/${path}`, query)
}

/** @param {Record<string, string>} params @param {string} segment */
function hasParam(params, segment) {
  const value = params[segment.slice(1)]
  return typeof value === 'string' && value !== ''
}

/** @param {Record<string, string>} params @param {string} key */
function requireParam(params, key) {
  const value = params[key]
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`路由缺少参数：${key}`)
  }
  return value
}

/** @param {URLSearchParams} input @returns {RouteQuery} */
function normalizeQuery(input) {
  const query = new URLSearchParams()
  for (const [key, value] of input) {
    if (value !== '') {
      query.append(key, value)
    }
  }
  return query
}

/**
 * @param {RouteQuery | Iterable<[string, unknown]> | Record<string, unknown> | undefined} input
 * @returns {RouteQuery}
 */
function toQuery(input) {
  const query = new URLSearchParams()
  if (input === undefined || input === null) {
    return query
  }
  if (input instanceof URLSearchParams) {
    for (const [key, value] of input) {
      if (value !== '') {
        query.append(key, value)
      }
    }
    return query
  }
  const entries =
    typeof input[Symbol.iterator] === 'function'
      ? /** @type {Iterable<[string, unknown]>} */ (input)
      : Object.entries(input)
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    query.append(String(key), String(value))
  }
  return query
}

/** @param {string} base @param {RouteQuery} query */
function withQuery(base, query) {
  const serialized = query.toString()
  return serialized === '' ? base : `${base}?${serialized}`
}
