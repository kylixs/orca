// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOUD_BINARY_EXTENSIONS,
  CLOUD_BINARY_FILE_RENDERER,
  CLOUD_CODE_FILE_RENDERER,
  CLOUD_FILE_RENDERERS,
  cloudFileExtension,
  cloudImageMimeType,
  resolveCloudFileFormat
} from './registry'
import {
  clearCloudFileModePreference,
  cloudFileModePreferenceKey,
  initialCloudFileMode,
  readCloudFileModePreference,
  writeCloudFileModePreference
} from './viewer-mode-preference'

afterEach(() => {
  window.sessionStorage.clear()
})

describe('文件渲染器注册表：L1 格式匹配矩阵', () => {
  it('Markdown 家族默认预览，可切源码', () => {
    for (const path of ['README.md', 'docs/guide.markdown', 'docs/component.mdx']) {
      const renderer = resolveCloudFileFormat(path)
      expect(renderer.id).toBe('markdown')
      expect(renderer.source).toBe('text')
      expect(renderer.defaultMode).toBe('preview')
      expect(renderer.canPreview).toBe(true)
      expect(renderer.canEditSource).toBe(true)
    }
  })

  it('HTML 与 drawio 归文本宿主，默认预览且源码可编辑', () => {
    for (const path of ['docs/index.html', 'docs/legacy.htm']) {
      expect(resolveCloudFileFormat(path)).toMatchObject({
        id: 'html',
        source: 'text',
        defaultMode: 'preview',
        canEditSource: true
      })
    }
    expect(resolveCloudFileFormat('design/flow.drawio')).toMatchObject({
      id: 'drawio',
      source: 'text',
      defaultMode: 'preview',
      canEditSource: true,
      language: 'xml'
    })
  })

  it('图片族一律二进制预览，复合后缀与大小写都命中', () => {
    for (const path of [
      'assets/logo.png',
      'assets/photo.JPG',
      'assets/photo.jpeg',
      'assets/anim.gif',
      'assets/photo.webp',
      'assets/icon.bmp',
      'assets/icon.ico',
      'assets/icon.svg',
      'assets/photo.avif',
      'design/flow.drawio.svg'
    ]) {
      expect(resolveCloudFileFormat(path)).toMatchObject({
        id: 'image',
        source: 'binary',
        defaultMode: 'preview'
      })
    }
  })

  it('CSV/TSV 表格默认预览且源码可切', () => {
    for (const path of ['data/table.csv', 'data/table.TSV']) {
      expect(resolveCloudFileFormat(path)).toMatchObject({
        id: 'csv',
        source: 'text',
        defaultMode: 'preview',
        canPreview: true,
        canEditSource: true
      })
    }
    expect(resolveCloudFileFormat('notes.unknown', { mimeType: 'text/csv' }).id).toBe('csv')
  })

  it('JSON/XML/YAML/Mermaid 归预览树或图，源码可切', () => {
    const cases: [string, string][] = [
      ['config/app.json', 'json'],
      ['config/tsconfig.jsonc', 'json'],
      ['pom.xml', 'xml'],
      ['config/app.yml', 'yaml'],
      ['config/app.yaml', 'yaml'],
      ['design/flow.mmd', 'mermaid'],
      ['docs/flow.mermaid', 'mermaid']
    ]
    for (const [path, id] of cases) {
      expect(resolveCloudFileFormat(path)).toMatchObject({
        id,
        source: 'text',
        defaultMode: 'preview',
        canPreview: true,
        canEditSource: true
      })
    }
    expect(resolveCloudFileFormat('a.unknown', { mimeType: 'application/xml' }).id).toBe('xml')
    expect(resolveCloudFileFormat('a.unknown', { mimeType: 'text/x-mermaid' }).id).toBe('mermaid')
  })

  it('PDF 真预览走二进制宿主，无源码切换', () => {
    expect(resolveCloudFileFormat('docs/spec.PDF')).toMatchObject({
      id: 'pdf',
      source: 'binary',
      defaultMode: 'preview',
      canPreview: true,
      canEditSource: false
    })
  })

  it('已知二进制扩展全部落入占位渲染器', () => {
    for (const extension of CLOUD_BINARY_EXTENSIONS) {
      expect(resolveCloudFileFormat(`dist/file.${extension}`)).toBe(CLOUD_BINARY_FILE_RENDERER)
    }
    expect(resolveCloudFileFormat('dist/archive.zip').id).toBe('binary')
    expect(resolveCloudFileFormat('tools/run.exe').id).toBe('binary')
  })

  it('代码与未知文本回退 Monaco 源码，全语言沿用 detectLanguage 映射', () => {
    for (const path of [
      'src/a.ts',
      'src/a.tsx',
      'app.py',
      'main.go',
      'lib.rs',
      'Dockerfile',
      'Makefile',
      '.env',
      'docs/unknown.unknownext'
    ]) {
      expect(resolveCloudFileFormat(path)).toBe(CLOUD_CODE_FILE_RENDERER)
      expect(resolveCloudFileFormat(path)).toMatchObject({
        id: 'code',
        source: 'text',
        defaultMode: 'source'
      })
    }
  })

  it('读取后按 MIME/二进制标志 refine', () => {
    expect(resolveCloudFileFormat('notes.unknown', { binary: true }).id).toBe('binary')
    expect(resolveCloudFileFormat('notes.unknown', { mimeType: 'image/avif' }).id).toBe('image')
    expect(resolveCloudFileFormat('notes.unknown', { mimeType: 'application/pdf' }).id).toBe('pdf')
    // A known text extension with binary payload must not stay in Monaco.
    expect(resolveCloudFileFormat('notes.txt', { binary: true }).id).toBe('binary')
  })

  it('辅助函数：扩展名、图片 MIME 回退、注册表条目数', () => {
    expect(cloudFileExtension('a/b/README.MD')).toBe('md')
    expect(cloudFileExtension('Makefile')).toBe('')
    expect(cloudImageMimeType('logo.JPG')).toBe('image/jpeg')
    expect(cloudImageMimeType('photo.avif')).toBe('image/avif')
    expect(cloudImageMimeType('a.ts')).toBeNull()
    expect(CLOUD_FILE_RENDERERS).toHaveLength(12)
  })
})

describe('渲染器模式偏好（sessionStorage，按渲染器 id）', () => {
  it('合法值可读写，缺失/非法值忽略', () => {
    expect(readCloudFileModePreference('markdown')).toBeNull()
    writeCloudFileModePreference('markdown', 'source')
    expect(readCloudFileModePreference('markdown')).toBe('source')
    expect(window.sessionStorage.getItem(cloudFileModePreferenceKey('markdown'))).toBe('source')

    window.sessionStorage.setItem(cloudFileModePreferenceKey('markdown'), 'bogus')
    expect(readCloudFileModePreference('markdown')).toBeNull()

    clearCloudFileModePreference('markdown')
    expect(readCloudFileModePreference('markdown')).toBeNull()
  })

  it('新标签优先用偏好；纯源码格式不记忆', () => {
    const markdown = resolveCloudFileFormat('README.md')
    expect(initialCloudFileMode(markdown)).toBe('preview')

    writeCloudFileModePreference('markdown', 'source')
    expect(initialCloudFileMode(markdown)).toBe('source')

    writeCloudFileModePreference('code', 'preview')
    expect(initialCloudFileMode(CLOUD_CODE_FILE_RENDERER)).toBe('source')
  })
})
