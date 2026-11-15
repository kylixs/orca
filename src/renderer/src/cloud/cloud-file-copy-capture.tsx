import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import { cloudFileUtf8Bytes, createCloudFileCopyReporter } from './cloud-file-copy-audit'
import { cloudClipboardFailureReason, writeCloudClipboardText } from './cloud-clipboard-write'

/**
 * Copy capture shared by the editor and preview tabs (U66 §3.3/AC-45/AC-48):
 * the whole-file button goes through the clipboard API, Ctrl+C through the DOM
 * copy event. Both report `file_copy` best-effort; neither blocks the copy.
 */
export type CloudFileCopyCapture = {
  copyStatus: 'idle' | 'copied' | 'failed'
  copyWholeFile: () => Promise<void>
  captureCopy: (event: React.ClipboardEvent<HTMLElement>) => void
}

export function useCloudFileCopyCapture(
  rpc: CloudRpc,
  path: string,
  wholeText: string
): CloudFileCopyCapture {
  const reporter = React.useMemo(() => createCloudFileCopyReporter(rpc), [rpc])
  const [copyStatus, setCopyStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const resetRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const explicitCopyAtRef = React.useRef(0)

  React.useEffect(
    () => () => {
      if (resetRef.current !== null) {
        clearTimeout(resetRef.current)
      }
    },
    []
  )

  const showCopyStatus = (status: 'copied' | 'failed'): void => {
    setCopyStatus(status)
    if (resetRef.current !== null) {
      clearTimeout(resetRef.current)
    }
    resetRef.current = setTimeout(() => setCopyStatus('idle'), 1_500)
  }

  const copyWholeFile = async (): Promise<void> => {
    explicitCopyAtRef.current = Date.now()
    try {
      await writeCloudClipboardText(wholeText)
    } catch (error) {
      showCopyStatus('failed')
      void reporter.reportFailure({
        path,
        copyKind: 'content-whole',
        capturePoint: 'web-clipboard-api',
        sizeBytes: cloudFileUtf8Bytes(wholeText),
        reason: cloudClipboardFailureReason(error)
      })
      return
    }
    showCopyStatus('copied')
    void reporter.report({
      path,
      text: wholeText,
      copyKind: 'content-whole',
      capturePoint: 'web-clipboard-api',
      sizeBytes: cloudFileUtf8Bytes(wholeText),
      isBinary: false
    })
  }

  const captureCopy = (event: React.ClipboardEvent<HTMLElement>): void => {
    // Why: the whole-file button may fall back to execCommand, which emits its
    // own copy event; one action must stay one event (§2.4).
    if (Date.now() - explicitCopyAtRef.current < 1_500) {
      return
    }
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text.length === 0) {
      return
    }
    void reporter.report({
      path,
      text,
      copyKind: 'content-selection',
      capturePoint: 'dom-copy-listener'
    })
  }

  return { copyStatus, copyWholeFile, captureCopy }
}

/** Shared label/disabled state so both tabs keep one copy affordance. */
export function CloudFileCopyButton({
  capture,
  disabled,
  testId
}: {
  capture: CloudFileCopyCapture
  disabled: boolean
  testId: string
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId}
      disabled={disabled}
      onClick={() => void capture.copyWholeFile()}
    >
      {capture.copyStatus === 'copied'
        ? '已复制'
        : capture.copyStatus === 'failed'
          ? '复制失败'
          : '复制内容'}
    </Button>
  )
}
