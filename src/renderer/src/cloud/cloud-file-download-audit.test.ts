import { describe, expect, it } from 'vitest'
import {
  desktopDownloadBlockedEventBody,
  desktopFileDownloadEventBody,
  localSavedName
} from './cloud-file-download-audit'
import { cloudCopyCapturePoint } from './cloud-file-copy-audit'

/** U68 R-02/R-03: the desktop download capture bodies — client-declared
 * outcomes for AC-41, and the frontend-block producer for AC-42. */

describe('desktop file download audit bodies（U66 §3.2 C3 / §2.4 C8）', () => {
  it('下载成功：client-declared，携带 method/kind/surface 与 savedName', () => {
    const body = desktopFileDownloadEventBody({
      path: 'src/config/app.ts',
      fileName: 'app.ts',
      result: 'success',
      sizeBytes: 4096,
      savedName: 'app-copy.ts',
      surface: 'desktop'
    })
    expect(body).toMatchObject({
      eventType: 'file_download',
      result: 'success',
      metadata: {
        fileName: 'app.ts',
        path: 'src/config/app.ts',
        method: 'files.readChunk',
        kind: 'file',
        surface: 'desktop',
        capturePoint: 'download-runtime-client',
        captureConfidence: 'client-declared',
        sizeBytes: 4096,
        savedName: 'app-copy.ts'
      }
    })
    expect(String(body.traceId)).toMatch(/^tr_/)
  })

  it('取消/失败带 reason，且不产生 success 字段', () => {
    const cancelled = desktopFileDownloadEventBody({
      path: 'src/a.ts',
      fileName: 'a.ts',
      result: 'failure',
      reason: 'client_cancelled',
      surface: 'desktop'
    })
    expect(cancelled).toMatchObject({
      eventType: 'file_download',
      result: 'failure',
      metadata: { reason: 'client_cancelled' }
    })
    expect(cancelled.metadata).not.toHaveProperty('savedName')
    expect(cancelled.metadata).not.toHaveProperty('sizeBytes')
  })

  it('前端拦截：download_blocked + frontend-block + policy deny（§2.4）', () => {
    const body = desktopDownloadBlockedEventBody({
      path: 'dist/secret.bin',
      fileName: 'secret.bin',
      reason: 'outside-runtime-worktree',
      surface: 'desktop'
    })
    expect(body).toMatchObject({
      eventType: 'download_blocked',
      result: 'denied',
      metadata: {
        capturePoint: 'frontend-block',
        captureConfidence: 'client-declared',
        policy: 'deny',
        reason: 'outside-runtime-worktree'
      }
    })
  })

  it('本地保存名取目的地尾部，POSIX 与 Windows 均可', () => {
    expect(localSavedName('/Users/dev/Downloads/app.ts')).toBe('app.ts')
    expect(localSavedName('C:\\Users\\dev\\Downloads\\app.ts')).toBe('app.ts')
  })

  it('桌面表面的复制写口是 desktop-clipboard-ipc，浏览器是 web-clipboard-api', () => {
    expect(cloudCopyCapturePoint('desktop')).toBe('desktop-clipboard-ipc')
    expect(cloudCopyCapturePoint('web')).toBe('web-clipboard-api')
  })
})
