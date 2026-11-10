export type FileActionFailureCode =
  | 'cancelled'
  | 'too_large'
  | 'changed'
  | 'read_failed'
  | 'unavailable'
  | 'no_app'
  | 'save_failed'

export class FileActionError extends Error {
  readonly code: FileActionFailureCode

  constructor(code: FileActionFailureCode, message: string) {
    super(message)
    this.name = 'FileActionError'
    this.code = code
  }
}

export const FILE_TOO_LARGE_DESKTOP_MESSAGE = 'File is too large; save it on desktop.'
export const TERMINAL_TOO_LARGE_MESSAGE = 'Too large for mobile; open on desktop'
export const SHARING_UNAVAILABLE_MESSAGE = 'Update Orca on this device to save or open files'
