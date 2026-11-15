/** Extension/MIME catalog shared by the renderer registry and binary hosts. */

export function cloudFileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

export function cloudFileExtension(relativePath: string): string {
  const name = cloudFileName(relativePath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
  'avif'
] as const

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/** MIME fallback for a host that returns image bytes without a MIME header. */
export function cloudImageMimeType(relativePath: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[cloudFileExtension(relativePath)] ?? null
}

/** Known binary extensions the editor must never open (U59②). */
export const CLOUD_BINARY_EXTENSIONS = [
  'bin',
  'exe',
  'dll',
  'so',
  'dylib',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'class',
  'jar',
  'wasm',
  'pyc',
  'pyo',
  'o',
  'a',
  'lib',
  'node',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'wav',
  'flac',
  'ogg',
  'webm',
  'sqlite',
  'db',
  'iso',
  'dmg',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp'
] as const
