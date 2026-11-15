import * as React from 'react'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

/**
 * Per-format renderer registry (FS-1, design §4.2/§4.3).
 *
 * This module must stay type-only apart from the lazy factories: importing a
 * renderer here would pull every format (and its dependencies) into the main
 * cloud chunk.
 */

export type CloudFileSourceKind = 'text' | 'binary'

export type CloudFileRendererId =
  | 'markdown'
  | 'html'
  | 'drawio'
  | 'code'
  | 'image'
  | 'pdf'
  | 'binary'

export type CloudFileMode = 'preview' | 'source'

export type CloudFileRendererProps = {
  path: string
  mode: CloudFileMode
  readOnly: boolean
  /** Source === 'text'. */
  text?: string
  /** Source === 'binary'. */
  binary?: { base64: string; mimeType: string | null }
  /** Monaco language id for the source surface. */
  language?: string
  onChange?: (value: string) => void
  onSave?: () => void
  /** Hosts keep their legacy test hooks; renderers use it when present. */
  testId?: string
}

export type CloudFileMatch = {
  suffix?: string
  extension?: string
  fileName?: string
  /** Exact MIME or a `type/*` prefix. */
  mimeType?: string
}

export type CloudFileRendererDescriptor = {
  id: CloudFileRendererId
  source: CloudFileSourceKind
  /** Array order is priority; a descriptor's own entries are checked in order. */
  match: readonly CloudFileMatch[]
  defaultMode: CloudFileMode
  canPreview: boolean
  canEditSource: boolean
  /** Monaco language override; the host falls back to detectLanguage. */
  language?: string
  component: React.LazyExoticComponent<React.ComponentType<CloudFileRendererProps>>
}

function lazyRenderer(
  id: CloudFileRendererId,
  load: () => Promise<{ default: React.ComponentType<CloudFileRendererProps> }>
): React.LazyExoticComponent<React.ComponentType<CloudFileRendererProps>> {
  return lazyWithRetry(load, { reloadKey: `cloud.renderer.${id}` })
}

const MarkdownRenderer = lazyRenderer('markdown', async () => {
  const module = await import('./markdown-file-renderer')
  return { default: module.MarkdownFileRenderer }
})

const HtmlRenderer = lazyRenderer('html', async () => {
  const module = await import('./html-file-renderer')
  return { default: module.HtmlFileRenderer }
})

const DrawioRenderer = lazyRenderer('drawio', async () => {
  const module = await import('./drawio-file-renderer')
  return { default: module.DrawioFileRenderer }
})

const ImageRenderer = lazyRenderer('image', async () => {
  const module = await import('./image-file-renderer')
  return { default: module.ImageFileRenderer }
})

const PdfRenderer = lazyRenderer('pdf', async () => {
  const module = await import('./pdf-file-renderer')
  return { default: module.PdfFileRenderer }
})

const BinaryRenderer = lazyRenderer('binary', async () => {
  const module = await import('./binary-placeholder-renderer')
  return { default: module.BinaryPlaceholderRenderer }
})

/** Shared Monaco surface for every source-mode text format. */
const CODE_RENDERER_COMPONENT = lazyRenderer('code', async () => {
  const module = await import('./code-file-renderer')
  return { default: module.CodeFileRenderer }
})

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'] as const

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
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

export const CLOUD_CODE_FILE_RENDERER: CloudFileRendererDescriptor = {
  id: 'code',
  source: 'text',
  // Fallback: every path that is not a known format is opened as text, then
  // refined to the binary placeholder when the host reports binary content.
  match: [],
  defaultMode: 'source',
  canPreview: false,
  canEditSource: true,
  component: CODE_RENDERER_COMPONENT
}

export const CLOUD_BINARY_FILE_RENDERER: CloudFileRendererDescriptor = {
  id: 'binary',
  source: 'binary',
  match: CLOUD_BINARY_EXTENSIONS.map((extension) => ({ extension })),
  defaultMode: 'preview',
  canPreview: false,
  canEditSource: false,
  component: BinaryRenderer
}

/** Ordered: specific text formats, then images/PDF/binaries, then the code fallback. */
export const CLOUD_FILE_RENDERERS: readonly CloudFileRendererDescriptor[] = [
  {
    id: 'markdown',
    source: 'text',
    match: [{ extension: 'md' }, { extension: 'markdown' }, { extension: 'mdx' }],
    defaultMode: 'preview',
    canPreview: true,
    canEditSource: true,
    component: MarkdownRenderer
  },
  {
    id: 'html',
    source: 'text',
    match: [{ extension: 'html' }, { extension: 'htm' }],
    defaultMode: 'preview',
    canPreview: true,
    canEditSource: true,
    component: HtmlRenderer
  },
  {
    id: 'drawio',
    source: 'text',
    match: [{ extension: 'drawio' }],
    defaultMode: 'preview',
    canPreview: true,
    canEditSource: true,
    language: 'xml',
    component: DrawioRenderer
  },
  {
    id: 'image',
    source: 'binary',
    match: [
      // Composite suffix first: flow.drawio.svg renders as an image.
      { suffix: '.drawio.svg' },
      ...IMAGE_EXTENSIONS.map((extension) => ({ extension })),
      { mimeType: 'image/*' }
    ],
    defaultMode: 'preview',
    canPreview: true,
    canEditSource: false,
    component: ImageRenderer
  },
  {
    id: 'pdf',
    source: 'binary',
    match: [{ extension: 'pdf' }, { mimeType: 'application/pdf' }],
    defaultMode: 'preview',
    canPreview: false,
    canEditSource: false,
    component: PdfRenderer
  },
  CLOUD_BINARY_FILE_RENDERER,
  CLOUD_CODE_FILE_RENDERER
]

function fileNameOf(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

export function cloudFileExtension(relativePath: string): string {
  const name = fileNameOf(relativePath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

function mimeMatches(actual: string, expected: string): boolean {
  if (expected.endsWith('/*')) {
    return actual.startsWith(expected.slice(0, -1))
  }
  return actual === expected
}

function matchEntry(
  name: string,
  extension: string,
  mimeType: string | null,
  entry: CloudFileMatch
): boolean {
  if (entry.suffix !== undefined && !name.endsWith(entry.suffix.toLowerCase())) {
    return false
  }
  if (entry.fileName !== undefined && name !== entry.fileName.toLowerCase()) {
    return false
  }
  if (entry.extension !== undefined && extension !== entry.extension.toLowerCase()) {
    return false
  }
  if (entry.mimeType !== undefined) {
    if (mimeType === null || !mimeMatches(mimeType.toLowerCase(), entry.mimeType.toLowerCase())) {
      return false
    }
  }
  return (
    entry.suffix !== undefined ||
    entry.fileName !== undefined ||
    entry.extension !== undefined ||
    entry.mimeType !== undefined
  )
}

export type CloudFileResolveOptions = {
  mimeType?: string | null
  /** The host reported binary content; refine an otherwise text fallback. */
  binary?: boolean
}

/**
 * Two-stage resolution (design §4.3): path-only at open time, then refined with
 * the host's MIME/binary verdict after the read.
 */
export function resolveCloudFileFormat(
  relativePath: string,
  options: CloudFileResolveOptions = {}
): CloudFileRendererDescriptor {
  const name = fileNameOf(relativePath).toLowerCase()
  const extension = cloudFileExtension(relativePath)
  const mimeType = options.mimeType ?? null

  for (const renderer of CLOUD_FILE_RENDERERS) {
    if (renderer.match.some((entry) => matchEntry(name, extension, mimeType, entry))) {
      return renderer
    }
  }
  if (options.binary === true || (mimeType !== null && !mimeType.startsWith('text/'))) {
    return CLOUD_BINARY_FILE_RENDERER
  }
  return CLOUD_CODE_FILE_RENDERER
}

export function isCloudFileBinaryRenderer(
  renderer: CloudFileRendererDescriptor | CloudFileRendererId
): boolean {
  const id = typeof renderer === 'string' ? renderer : renderer.id
  return id === 'image' || id === 'pdf' || id === 'binary'
}
