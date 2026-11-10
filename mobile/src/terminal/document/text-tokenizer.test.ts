import { afterEach, describe, expect, it } from 'vitest'
import { resetTokenizerForTests, tokenizeTerminalLine } from './text-tokenizer'

const originalSegmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')

function tokenTexts(line: string) {
  return tokenizeTerminalLine(line).map((token) => ({
    text: line.slice(token.start, token.end),
    start: token.start,
    end: token.end
  }))
}

function useSegmenter(value: unknown): void {
  Object.defineProperty(Intl, 'Segmenter', {
    value,
    configurable: true,
    writable: true
  })
  resetTokenizerForTests()
}

function restoreSegmenter(): void {
  if (originalSegmenter) {
    Object.defineProperty(Intl, 'Segmenter', originalSegmenter)
  } else {
    Reflect.deleteProperty(Intl, 'Segmenter')
  }
  resetTokenizerForTests()
}

afterEach(restoreSegmenter)

/** The test-plan vectors that both segmenter arms must split identically. */
const PARITY_VECTORS = [
  '中文abc',
  '中文 😀 English',
  '前缀中文: https://example.com/path?q=中文',
  'abc中文def',
  '你好，世界！Hello.',
  '全角：ＡＢＣ１２３',
  'emoji: 👨‍👩‍👧‍👦 family',
  '组合: é café',
  '制表: \t中文\tABC',
  'foo-bar',
  'key=value',
  'a@b.com',
  'C++',
  '100%',
  'a#b',
  '中华人民共和国万岁',
  '春夏秋冬风花雪',
  '修复，登录流程',
  '验证 权限边界 & token',
  'https://example.com/',
  '/var/log/',
  'C:\\',
  './src/',
  'file:///tmp/a.txt'
] as const

describe('terminal line tokenizer', () => {
  it('keeps join-set words and suffix operators whole', () => {
    expect(tokenTexts('foo-bar')).toEqual([{ text: 'foo-bar', start: 0, end: 7 }])
    expect(tokenTexts('key=value')).toEqual([{ text: 'key=value', start: 0, end: 9 }])
    expect(tokenTexts('a@b.com')).toEqual([{ text: 'a@b.com', start: 0, end: 7 }])
    expect(tokenTexts('C++')).toEqual([{ text: 'C++', start: 0, end: 3 }])
    expect(tokenTexts('100%')).toEqual([{ text: '100%', start: 0, end: 4 }])
    expect(tokenTexts('a#b')).toEqual([{ text: 'a#b', start: 0, end: 3 }])
  })

  it('keeps full-width alphanumerics atomic', () => {
    expect(tokenTexts('ＡＢＣ１２３')).toEqual([{ text: 'ＡＢＣ１２３', start: 0, end: 6 }])
  })

  it('keeps URLs, slash paths and graphemes atomic', () => {
    const url = 'https://example.com/path?q=中文'
    expect(tokenTexts(url)).toEqual([{ text: url, start: 0, end: url.length }])
    expect(tokenTexts('src/main.ts:42')).toEqual([{ text: 'src/main.ts:42', start: 0, end: 14 }])

    const combining = 'éx'
    expect(tokenizeTerminalLine(combining)[0]).toMatchObject({ start: 0, end: 2 })

    const family = '👨‍👩‍👧‍👦 family'
    expect(tokenizeTerminalLine(family)[0]).toMatchObject({
      start: 0,
      end: family.indexOf(' ')
    })
  })

  it('keeps a URL or path whole when it ends with a separator', () => {
    for (const value of [
      'https://example.com/',
      'https://example.com/a/',
      '/var/log/',
      'C:\\',
      './src/',
      'file:///tmp/'
    ]) {
      expect(tokenTexts(value), value).toEqual([{ text: value, start: 0, end: value.length }])
    }
    // Only a span made entirely of separators is prose.
    expect(tokenTexts('open ../ now')).toEqual([
      { text: 'open', start: 0, end: 4 },
      { text: 'now', start: 9, end: 12 }
    ])
  })

  it('splits mixed Latin and CJK at script boundaries and joins adjacent CJK', () => {
    expect(tokenTexts('中文abc')).toEqual([
      { text: '中文', start: 0, end: 2 },
      { text: 'abc', start: 2, end: 5 }
    ])
    expect(tokenTexts('中华人民共和国万岁')).toEqual([
      { text: '中华人民共和国万岁', start: 0, end: 9 }
    ])
    expect(tokenTexts('登录流程')).toEqual([{ text: '登录流程', start: 0, end: 4 }])
  })

  it('trims sentence punctuation at token edges', () => {
    expect(tokenTexts('你好，世界！')).toEqual([
      { text: '你好', start: 0, end: 2 },
      { text: '世界', start: 3, end: 5 }
    ])
  })

  it('matches the segmenter arm when Intl.Segmenter is deleted', () => {
    const line = '修复，登录流程 foo-bar C++ ＡＢＣ１２３'
    const withSegmenter = tokenTexts(line)
    useSegmenter(undefined)
    expect(tokenTexts(line)).toEqual(withSegmenter)
    expect(tokenTexts('中华人民共和国万岁')).toEqual([
      { text: '中华人民共和国万岁', start: 0, end: 9 }
    ])
  })

  it('falls back when the segmenter constructor throws', () => {
    const line = 'key=value 登录流程 C++'
    const expected = tokenTexts(line)
    useSegmenter(
      class {
        constructor() {
          throw new Error('no segmenter')
        }
      }
    )
    expect(tokenTexts(line)).toEqual(expected)
  })

  it('falls back when segment() throws', () => {
    const line = 'a@b.com 中华 people'
    const expected = tokenTexts(line)
    useSegmenter(
      class {
        segment(): never {
          throw new Error('segment failed')
        }
      }
    )
    expect(tokenTexts(line)).toEqual(expected)
  })

  it('tokenizes on a Chrome 74 runtime without Array.prototype.at', () => {
    const line = '中文abc foo-bar https://example.com/ /var/log/'
    const expected = tokenTexts(line)
    const atDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'at')
    try {
      Reflect.deleteProperty(Array.prototype, 'at')
      useSegmenter(undefined)
      expect(tokenTexts(line)).toEqual(expected)
      expect(tokenTexts(line).map((token) => token.text)).toEqual([
        '中文',
        'abc',
        'foo-bar',
        'https://example.com/',
        '/var/log/'
      ])
    } finally {
      if (atDescriptor) {
        Reflect.defineProperty(Array.prototype, 'at', atDescriptor)
      }
      restoreSegmenter()
    }
  })

  it.each(PARITY_VECTORS)('matches the segmenter arm when Intl.Segmenter is absent: %s', (line) => {
    const expected = tokenTexts(line)
    useSegmenter(undefined)
    expect(tokenTexts(line)).toEqual(expected)
  })

  it.each(PARITY_VECTORS)('matches the segmenter arm when the constructor throws: %s', (line) => {
    const expected = tokenTexts(line)
    useSegmenter(
      class {
        constructor() {
          throw new Error('no segmenter')
        }
      }
    )
    expect(tokenTexts(line)).toEqual(expected)
  })
})
