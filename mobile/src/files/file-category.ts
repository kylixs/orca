import { extensionOfFileName } from './file-download-naming'

export type MobileFileCategory = 'all' | 'code' | 'docs' | 'media' | 'images' | 'other'

export const MOBILE_FILE_CATEGORIES: readonly MobileFileCategory[] = [
  'all',
  'code',
  'docs',
  'media',
  'images',
  'other'
]

export const MOBILE_FILE_CATEGORY_LABELS: Record<MobileFileCategory, string> = {
  all: 'All',
  code: 'Code',
  docs: 'Docs',
  media: 'Media',
  images: 'Images',
  other: 'Other'
}

const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'bash',
  'zsh',
  'fish',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sql',
  'graphql',
  'gql',
  'lua',
  'pl',
  'ex',
  'exs',
  'erl',
  'clj',
  'cljs',
  'hs',
  'ml',
  'dart',
  'proto'
])

// PDF is deliberately Docs: that is the filter users look under for a document.
const DOCS_EXTENSIONS = new Set([
  'md',
  'mdx',
  'markdown',
  'txt',
  'pdf',
  'doc',
  'docx',
  'rtf',
  'odt',
  'tex',
  'rst',
  'adoc'
])

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'heic',
  'tiff',
  'tif'
])

const MEDIA_EXTENSIONS = new Set([
  'mp3',
  'mp4',
  'mov',
  'webm',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'ogv',
  'mkv',
  'avi',
  'm4v',
  '3gp'
])

export function fileCategoryForPath(relativePath: string): Exclude<MobileFileCategory, 'all'> {
  const extension = extensionOfFileName(relativePath)
  if (CODE_EXTENSIONS.has(extension)) {
    return 'code'
  }
  if (DOCS_EXTENSIONS.has(extension)) {
    return 'docs'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'images'
  }
  if (MEDIA_EXTENSIONS.has(extension)) {
    return 'media'
  }
  return 'other'
}

export function matchesFileCategory(relativePath: string, category: MobileFileCategory): boolean {
  return category === 'all' || fileCategoryForPath(relativePath) === category
}
