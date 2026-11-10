import { Buffer } from 'buffer/index.js'

/** Longest name ext4/APFS accept for one path component. */
const MAX_FILE_NAME_BYTES = 255
const MAX_EXTENSION_CHARS = 20

// oxlint-disable-next-line eslint/no-control-regex -- SAFETY: stripping control characters is exactly the sanitization the filename contract requires.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/g

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  html: 'text/html',
  htm: 'text/html',
  json: 'text/plain',
  md: 'text/plain',
  mdx: 'text/plain',
  txt: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  jsx: 'text/plain',
  py: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  cpp: 'text/plain',
  h: 'text/plain',
  css: 'text/plain',
  scss: 'text/plain',
  sh: 'text/plain',
  yaml: 'text/plain',
  yml: 'text/plain',
  toml: 'text/plain',
  xml: 'text/plain'
}

const UTI_BY_EXTENSION: Record<string, string> = {
  png: 'public.png',
  jpg: 'public.jpeg',
  jpeg: 'public.jpeg',
  gif: 'com.compuserve.gif',
  webp: 'org.webmproject.webp',
  bmp: 'com.microsoft.bmp',
  ico: 'com.microsoft.ico',
  svg: 'public.svg-image',
  pdf: 'com.adobe.pdf',
  zip: 'public.zip-archive',
  mp4: 'public.mpeg-4',
  m4v: 'public.mpeg-4',
  mov: 'com.apple.quicktime-movie',
  webm: 'org.webmproject.webm',
  mp3: 'public.mp3',
  wav: 'com.microsoft.waveform-audio',
  m4a: 'public.mpeg-4-audio',
  html: 'public.plain-text',
  htm: 'public.plain-text'
}

export const DEFAULT_MIME_TYPE = 'application/octet-stream'
export const DEFAULT_UTI = 'public.data'
export const PLAIN_TEXT_UTI = 'public.plain-text'

/**
 * The one name the app writes into its cache and offers to the system picker.
 *
 * Path separators, Windows-reserved characters, control characters, and Unicode bidi overrides
 * are removed because a remote file name may contain any of them and the destination is a real
 * local filesystem. The result is byte-truncated at 255 while keeping a short extension.
 */
export function safeLocalFileName(input: string): string {
  const basename = input.split(/[\\/]/).findLast(Boolean) ?? ''
  let name = basename
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(ILLEGAL_NAME_CHARS, '_')
    .trim()
  // A name made only of dots names no file (`..` escapes the directory).
  name = name.replace(/^\.+$/, '')
  if (name.length === 0) {
    return 'file'
  }
  return truncateFileNameUtf8(name)
}

export function extensionOfFileName(name: string): string {
  const basename = name.split(/[\\/]/).findLast(Boolean) ?? ''
  const dot = basename.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension, and trailing dots name nothing.
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1).toLowerCase() : ''
}

export function mimeTypeForFileName(name: string): string {
  return MIME_BY_EXTENSION[extensionOfFileName(name)] ?? DEFAULT_MIME_TYPE
}

/** Code and plain text share `text/plain`; HTML keeps its own MIME but reports as text for UTI. */
export function utiForFileName(name: string): string {
  const extension = extensionOfFileName(name)
  const known = UTI_BY_EXTENSION[extension]
  if (known) {
    return known
  }
  return mimeTypeForFileName(name).startsWith('text/') ? PLAIN_TEXT_UTI : DEFAULT_UTI
}

/**
 * Appends ` (n)` before the extension until the name is unused.
 *
 * SAF's `createFileAsync` throws when the document already exists, which would surface as a
 * permission error on a perfectly valid destination folder.
 */
export function uniqueLocalFileName(
  requestedName: string,
  existingNames: Iterable<string>
): string {
  const safeName = safeLocalFileName(requestedName)
  const taken = new Set(Array.from(existingNames, (name) => name.toLowerCase()))
  if (!taken.has(safeName.toLowerCase())) {
    return safeName
  }
  const dot = safeName.lastIndexOf('.')
  const hasExtension = dot > 0
  const base = hasExtension ? safeName.slice(0, dot) : safeName
  const extension = hasExtension ? safeName.slice(dot) : ''
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${extension}`
    if (!taken.has(candidate.toLowerCase())) {
      return candidate
    }
  }
  return `${base} (${Date.now()})${extension}`
}

function truncateFileNameUtf8(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES) {
    return name
  }
  const dot = name.lastIndexOf('.')
  const suffixLength = name.length - dot - 1
  const extension =
    dot > 0 && suffixLength > 0 && suffixLength <= MAX_EXTENSION_CHARS ? name.slice(dot) : ''
  const base = extension ? name.slice(0, dot) : name
  const budget = MAX_FILE_NAME_BYTES - Buffer.byteLength(extension, 'utf8')
  return `${truncateByBytes(base, budget)}${extension}`
}

function truncateByBytes(value: string, maxBytes: number): string {
  let result = ''
  let used = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) {
      break
    }
    result += character
    used += bytes
  }
  return result || 'file'
}
