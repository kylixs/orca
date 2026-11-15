// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudSimpleWorkspaceTabsAction } from './cloud-simple-workspace-tabs'
import {
  CloudWorkspacePreviewTab,
  cloudWorkspacePreviewKind,
  createCloudWorkspacePreviewTab,
  isCloudWorkspaceBinaryPath
} from './cloud-workspace-preview-tab'

/** U46-7b T5: image data URLs, HTML sandbox, drawio degradation, PDF preview, binary placeholders. */

const ALL: CloudProjectPermission[] = ['open', 'terminal', 'file:read']

function bridge(replies: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const rpc: CloudRpc = async (method, params) => {
    calls.push({ method, params })
    const reply = replies[method]
    return reply ? reply(params) : { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

function previewReply(result: Record<string, unknown>): CloudRpcOutcome {
  return { ok: true, result }
}

function renderTab(options: {
  path: string
  replies?: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>
  permissions?: CloudProjectPermission[]
}) {
  const mock = bridge(
    options.replies ?? {
      'files.readPreview': () =>
        previewReply({
          content: 'iVBORw0KGgo=',
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        })
    }
  )
  const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
  render(
    <CloudWorkspacePreviewTab
      tab={{
        id: `preview:${options.path}`,
        kind: 'preview',
        title: options.path.split('/').at(-1) ?? options.path,
        path: options.path,
        mode: 'preview'
      }}
      active
      dispatch={dispatch}
      rpc={mock.rpc}
      workspacePath="/srv/checkout"
      permissions={options.permissions ?? ALL}
    />
  )
  return mock
}

afterEach(cleanup)

describe('预览类型分发', () => {
  it('按扩展名区分图片、HTML、drawio、PDF 与二进制', () => {
    expect(cloudWorkspacePreviewKind('assets/logo.png')).toBe('image')
    expect(cloudWorkspacePreviewKind('assets/logo.JPG')).toBe('image')
    expect(cloudWorkspacePreviewKind('assets/icon.svg')).toBe('image')
    expect(cloudWorkspacePreviewKind('docs/index.html')).toBe('html')
    expect(cloudWorkspacePreviewKind('docs/legacy.htm')).toBe('html')
    expect(cloudWorkspacePreviewKind('design/flow.drawio')).toBe('drawio')
    // A .drawio.svg is a real SVG document, so it renders as an image.
    expect(cloudWorkspacePreviewKind('design/flow.drawio.svg')).toBe('image')
    expect(cloudWorkspacePreviewKind('docs/spec.pdf')).toBe('pdf')
    expect(cloudWorkspacePreviewKind('dist/app.bin')).toBe('binary')
  })

  it('识别常见二进制扩展，文本与可预览类型不受影响（U59②）', () => {
    expect(isCloudWorkspaceBinaryPath('dist/app.bin')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('tools/run.exe')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('lib/native.so')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('lib/native.dylib')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('release/app.zip')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('build/main.wasm')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('cache/mod.pyc')).toBe(true)
    expect(isCloudWorkspaceBinaryPath('src/a.ts')).toBe(false)
    expect(isCloudWorkspaceBinaryPath('README.md')).toBe(false)
    expect(isCloudWorkspaceBinaryPath('assets/logo.png')).toBe(false)
    expect(isCloudWorkspaceBinaryPath('docs/spec.pdf')).toBe(false)
  })
})

describe('工作区预览标签', () => {
  it('PNG 经 files.readPreview 渲染为 data URL 图片', async () => {
    const mock = renderTab({ path: 'assets/logo.png' })
    const image = await screen.findByTestId('cloud-workspace-preview-image')
    expect(mock.calls).toEqual([
      {
        method: 'files.readPreview',
        params: { worktree: 'path:/srv/checkout', relativePath: 'assets/logo.png' }
      }
    ])
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(image.getAttribute('alt')).toBe('logo.png')
  })

  it('SVG 也走 data URL 图片，不注入文档', async () => {
    renderTab({
      path: 'assets/icon.svg',
      replies: {
        'files.readPreview': () =>
          previewReply({
            content: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
            isBinary: true,
            isImage: true,
            mimeType: 'image/svg+xml'
          })
      }
    })
    const image = await screen.findByTestId('cloud-workspace-preview-image')
    expect(image.getAttribute('src')).toBe(
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
    )
  })

  it('HTML 在空 sandbox iframe 中渲染，脚本被禁用；可切到源码', async () => {
    const html = '<!doctype html><html><body><script>window.__xss=true</script>hi</body></html>'
    renderTab({
      path: 'docs/index.html',
      replies: {
        'files.readPreview': () => previewReply({ content: html, isBinary: false })
      }
    })

    const frame = await screen.findByTestId('cloud-workspace-preview-html-frame')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toBe(html)
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')

    await userEvent.click(screen.getByTestId('cloud-workspace-preview-mode-source'))
    const source = screen.getByTestId('cloud-workspace-preview-html-source')
    expect(source.textContent).toContain('window.__xss=true')
    expect(screen.queryByTestId('cloud-workspace-preview-html-frame')).toBeNull()

    await userEvent.click(screen.getByTestId('cloud-workspace-preview-mode-preview'))
    expect(screen.getByTestId('cloud-workspace-preview-html-frame')).toBeTruthy()
  })

  it('drawio 如实降级为源码视图，不加载第三方查看器', async () => {
    const source = '<mxfile><diagram>flow</diagram></mxfile>'
    const mock = renderTab({
      path: 'design/flow.drawio',
      replies: {
        'files.readPreview': () => previewReply({ content: source, isBinary: false })
      }
    })

    const degraded = await screen.findByTestId('cloud-workspace-preview-drawio-degraded')
    expect(degraded.textContent).toContain('drawio')
    expect(screen.getByTestId('cloud-workspace-preview-drawio-source').textContent).toBe(source)
    expect(screen.queryByTestId('cloud-workspace-preview-html-frame')).toBeNull()
    expect(mock.calls.map((call) => call.method)).toEqual(['files.readPreview'])
  })

  it('drawio.svg 直接按图片渲染', async () => {
    renderTab({
      path: 'design/flow.drawio.svg',
      replies: {
        'files.readPreview': () =>
          previewReply({
            content: 'PHN2Zy8+',
            isBinary: true,
            isImage: true,
            mimeType: 'image/svg+xml'
          })
      }
    })
    const image = await screen.findByTestId('cloud-workspace-preview-image')
    expect(image.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('其他二进制显示占位与下载提示', async () => {
    renderTab({
      path: 'dist/app.bin',
      replies: {
        'files.readPreview': () =>
          previewReply({
            content: '',
            isBinary: true,
            isImage: false,
            mimeType: 'application/octet-stream'
          })
      }
    })
    const binary = await screen.findByTestId('cloud-workspace-preview-binary')
    expect(binary.textContent).toContain('二进制')
    expect(binary.textContent).toContain('application/octet-stream')
    expect(binary.textContent).toContain('下载')
    expect(screen.queryByTestId('cloud-workspace-preview-image')).toBeNull()
  })

  it('PDF 读取 base64 后交给原生查看器', async () => {
    const mock = renderTab({
      path: 'docs/spec.pdf',
      replies: {
        'files.readPreview': () =>
          previewReply({
            content: 'JVBERi0=',
            isBinary: true,
            isImage: false,
            mimeType: 'application/pdf'
          })
      }
    })
    const frame = await screen.findByTestId('cloud-workspace-pdf-frame')
    expect(frame.getAttribute('src')).toBe('data:application/pdf;base64,JVBERi0=')
    expect(mock.calls).toHaveLength(1)
  })

  it('file_too_large 如实显示错误并可重试', async () => {
    let attempt = 0
    const mock = renderTab({
      path: 'assets/huge.png',
      replies: {
        'files.readPreview': () =>
          attempt++ === 0
            ? { ok: false, code: 'file_too_large' }
            : previewReply({
                content: 'iVBORw0KGgo=',
                isBinary: true,
                isImage: true,
                mimeType: 'image/png'
              })
      }
    })

    await screen.findByText('file_too_large')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByTestId('cloud-workspace-preview-image')
    expect(mock.calls).toHaveLength(2)
  })

  it('无 file:read 时降级且零 RPC', async () => {
    const mock = renderTab({ path: 'assets/logo.png', permissions: ['open'] })
    await screen.findByTestId('cloud-workspace-preview-denied')
    expect(mock.calls).toEqual([])
  })

  it('工厂把 RPC/权限绑定进 shell 注册组件', async () => {
    const mock = bridge({
      'files.readPreview': () =>
        previewReply({
          content: 'iVBORw0KGgo=',
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        })
    })
    const Component = createCloudWorkspacePreviewTab({
      rpc: mock.rpc,
      workspacePath: '/srv/checkout',
      permissions: ALL
    })
    const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
    render(
      <Component
        tab={{ id: 'preview:a.png', kind: 'preview', title: 'a.png', path: 'a.png', mode: 'image' }}
        active
        dispatch={dispatch}
      />
    )
    await waitFor(() => expect(screen.getByTestId('cloud-workspace-preview-image')).toBeTruthy())
  })
})
