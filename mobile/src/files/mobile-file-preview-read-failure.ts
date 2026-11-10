import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { isNonReadPreviewMessage } from './mobile-file-preview-target-size'
import {
  clearFileReadFailure,
  recordFileReadFailure,
  type FileReadFailureScope
} from './file-read-failures'

/** A read failure is published for the list badge; transport messages are not file failures. */
export function recordMobileFilePreviewResult(
  scope: FileReadFailureScope,
  path: string,
  result: MobileFilePreviewResult
): void {
  if (!path) {
    return
  }
  if (result.status === 'error' || result.status === 'waiting') {
    if (!isNonReadPreviewMessage(result.message)) {
      recordFileReadFailure(scope, path, result.message)
    }
    return
  }
  clearFileReadFailure(scope, path)
}
