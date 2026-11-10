import {
  TERMINAL_FILE_URL_REGEX_SOURCE,
  TERMINAL_HTTP_URL_MAX_LENGTH,
  TERMINAL_HTTP_URL_REGEX_SOURCE
} from '../terminal-webview-url-tap'

/**
 * Word-ish spans of one rendered terminal line, in UTF-16 string indices.
 *
 * Everything is derived from the same line text the cell mapping uses. URLs, slash-bearing paths,
 * full-width alphanumerics and multi-code-unit graphemes are atomic: the segmenter may not split
 * them and the join pass may not grow them. The base splitter has two interchangeable arms
 * (`Intl.Segmenter('zh')`, and a Chrome-74 regex fallback) that both feed the same post-merge, so
 * the two arms cannot drift into different selections.
 */

export type TerminalLineToken = {
  start: number
  end: number
  kind: 'word' | 'cjk'
  atomic: boolean
}

type Span = { start: number; end: number }
type SegmenterPart = { index: number; segment: string }
type SegmenterLike = { segment(input: string): Iterable<SegmenterPart> }

const CJK_TEST_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u
const BASE_CHUNK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]+/gu
const WORD_CHUNK_RE = /[\p{L}\p{N}\p{M}_]+/gu
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_]/u
const JOIN_GAP_RE = /^[._/:@~+=?&#%-]+$/
const SUFFIX_RE = /[+#%]/
const SENTENCE_PUNCTUATION_RE = /[。，、；：！？,;:'"“”‘’（）【】《》]/
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])(?:️|[\u{1F3FB}-\u{1F3FF}])?(?:‍(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])(?:️|[\u{1F3FB}-\u{1F3FF}])?)*/gu
const COMBINING_RE = /[\p{L}\p{N}][\p{M}]+/gu
const FULLWIDTH_ALNUM_RE = /[Ａ-Ｚａ-ｚ０-９]+/g
const SLASH_PATH_RE =
  /(?:~[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z0-9._-]+[\\/])[A-Za-z0-9._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g

let cachedSegmenter: SegmenterLike | null | undefined

function getSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) {
    return cachedSegmenter
  }
  try {
    type SegmenterConstructor = new (
      locale: string,
      options: { granularity: 'word' }
    ) => SegmenterLike
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the constructor is feature-detected and its segment() contract is the one above.
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
    cachedSegmenter = Segmenter ? new Segmenter('zh', { granularity: 'word' }) : null
  } catch {
    cachedSegmenter = null
  }
  return cachedSegmenter
}

/** Tests delete or replace `Intl.Segmenter`; the cache must not outlive that edit. */
export function resetTokenizerForTests(): void {
  cachedSegmenter = undefined
}

function hasWordCharacter(text: string): boolean {
  return WORD_CHAR_RE.test(text)
}

function pushMatches(line: string, regex: RegExp, spans: Span[], minimumLength = 1): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    if (match[0].length >= minimumLength) {
      spans.push({ start: match.index, end: match.index + match[0].length })
    }
    if (match[0].length === 0) {
      regex.lastIndex += 1
    }
  }
}

function mergeOverlappingSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Span[] = []
  for (const span of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

function atomicSpans(line: string): Span[] {
  const spans: Span[] = []
  pushMatches(line, new RegExp(TERMINAL_HTTP_URL_REGEX_SOURCE, 'gi'), spans)
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    if (spans[i]!.end - spans[i]!.start > TERMINAL_HTTP_URL_MAX_LENGTH) {
      spans.splice(i, 1)
    }
  }
  pushMatches(line, new RegExp(TERMINAL_FILE_URL_REGEX_SOURCE, 'gi'), spans)
  const slashPaths: Span[] = []
  pushMatches(line, SLASH_PATH_RE, slashPaths, 3)
  for (const span of slashPaths) {
    // Why: only a span made entirely of separators (`/`, `../`) is prose. Dropping a real path's
    // leading or trailing slash turns `/var/log/` into a relative path and loses the URL's tail.
    if (!/^[.\\/]+$/.test(line.slice(span.start, span.end))) {
      spans.push(span)
    }
  }
  pushMatches(line, FULLWIDTH_ALNUM_RE, spans)
  pushMatches(line, COMBINING_RE, spans, 2)
  pushMatches(line, EMOJI_RE, spans)
  return mergeOverlappingSpans(spans)
}

function subtractAtomics(start: number, end: number, atomics: readonly Span[]): Span[] {
  let cursor = start
  const pieces: Span[] = []
  for (const atomic of atomics) {
    if (atomic.end <= cursor || atomic.start >= end) {
      continue
    }
    if (atomic.start > cursor) {
      pieces.push({ start: cursor, end: atomic.start })
    }
    cursor = Math.max(cursor, atomic.end)
    if (cursor >= end) {
      break
    }
  }
  if (cursor < end) {
    pieces.push({ start: cursor, end })
  }
  return pieces
}

function fallbackBaseSpans(line: string): Span[] {
  const spans: Span[] = []
  BASE_CHUNK_RE.lastIndex = 0
  let chunk: RegExpExecArray | null
  while ((chunk = BASE_CHUNK_RE.exec(line)) !== null) {
    if (CJK_TEST_RE.test(chunk[0])) {
      spans.push({ start: chunk.index, end: chunk.index + chunk[0].length })
    } else {
      const words: Span[] = []
      pushMatches(chunk[0], WORD_CHUNK_RE, words)
      for (const word of words) {
        spans.push({ start: chunk.index + word.start, end: chunk.index + word.end })
      }
    }
  }
  return spans
}

function segmenterBaseSpans(line: string, segmenter: SegmenterLike): Span[] {
  const spans: Span[] = []
  for (const part of segmenter.segment(line)) {
    if (part.segment.length > 0 && hasWordCharacter(part.segment)) {
      spans.push({ start: part.index, end: part.index + part.segment.length })
    }
  }
  return spans
}

function trimSentenceEdges(line: string, span: Span): Span {
  let start = span.start
  let end = span.end
  while (start < end && (/\s/.test(line[start]!) || SENTENCE_PUNCTUATION_RE.test(line[start]!))) {
    start += 1
  }
  while (
    end > start &&
    (/\s/.test(line[end - 1]!) || SENTENCE_PUNCTUATION_RE.test(line[end - 1]!))
  ) {
    end -= 1
  }
  return { start, end }
}

function baseTokens(line: string, atomics: readonly Span[]): Span[] {
  const spans: Span[] = []
  const segmenter = getSegmenter()
  let raw: Span[] | null = null
  if (segmenter) {
    try {
      raw = segmenterBaseSpans(line, segmenter)
    } catch {
      raw = null
    }
  }
  for (const candidate of raw ?? fallbackBaseSpans(line)) {
    for (const piece of subtractAtomics(candidate.start, candidate.end, atomics)) {
      const trimmed = trimSentenceEdges(line, piece)
      if (trimmed.end > trimmed.start && hasWordCharacter(line.slice(trimmed.start, trimmed.end))) {
        spans.push(trimmed)
      }
    }
  }
  return spans
}

function tokenKind(line: string, span: Span): 'word' | 'cjk' {
  return CJK_TEST_RE.test(line.slice(span.start, span.end)) ? 'cjk' : 'word'
}

function canJoin(line: string, previous: Span, next: Span): boolean {
  if (previous.end >= next.start) {
    return false
  }
  const gap = line.slice(previous.end, next.start)
  return (
    JOIN_GAP_RE.test(gap) &&
    hasWordCharacter(line.slice(previous.start, previous.end)) &&
    hasWordCharacter(line.slice(next.start, next.end))
  )
}

function mergeJoinable(line: string, tokens: TerminalLineToken[]): TerminalLineToken[] {
  const merged: TerminalLineToken[] = []
  for (const token of tokens) {
    const previous = merged[merged.length - 1]
    if (previous && !previous.atomic && !token.atomic && canJoin(line, previous, token)) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: token.end,
        kind: tokenKind(line, { start: previous.start, end: token.end }),
        atomic: false
      }
    } else {
      merged.push({ ...token })
    }
  }
  return merged
}

function attachSuffixes(line: string, tokens: TerminalLineToken[]): void {
  for (const token of tokens) {
    if (token.atomic || !hasWordCharacter(line.slice(token.start, token.end))) {
      continue
    }
    let end = token.end
    while (end < line.length && SUFFIX_RE.test(line[end]!)) {
      end += 1
    }
    // Why: `a#b` is a join token, not an `a#` token plus `b`; only a suffix that ends the word
    // (`C++`, `100%`, `C#`) is absorbed here.
    const followedByWord = end < line.length && hasWordCharacter(line[end]!)
    if (
      end > token.end &&
      !followedByWord &&
      !tokens.some((other) => other !== token && other.start >= token.end && other.start < end)
    ) {
      token.end = end
    }
  }
}

function mergeAdjacentCjk(line: string, tokens: TerminalLineToken[]): TerminalLineToken[] {
  const merged: TerminalLineToken[] = []
  for (const token of tokens) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      !previous.atomic &&
      !token.atomic &&
      token.kind === 'cjk' &&
      previous.kind === 'cjk' &&
      previous.end === token.start
    ) {
      previous.end = token.end
    } else {
      merged.push({ ...token })
    }
  }
  return merged
}

export function tokenizeTerminalLine(line: string): TerminalLineToken[] {
  if (!line) {
    return []
  }
  try {
    const atomics = atomicSpans(line)
    const atomicTokens: TerminalLineToken[] = atomics.map((span) => ({
      ...span,
      kind: tokenKind(line, span),
      atomic: true
    }))
    const tokens = [
      ...baseTokens(line, atomics).map((span) => ({
        ...span,
        kind: tokenKind(line, span),
        atomic: false
      })),
      ...atomicTokens
    ].sort((a, b) => a.start - b.start || b.end - a.end)
    attachSuffixes(line, tokens)
    return mergeAdjacentCjk(line, mergeJoinable(line, tokens))
  } catch {
    // The tokenizer must never take a long press down with it.
    return []
  }
}
