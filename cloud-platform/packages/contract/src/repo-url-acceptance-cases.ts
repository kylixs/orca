/**
 * Repo-URL cases the platform contract and the host provisioner must judge the
 * same way. Both validators import these so a rule drift fails on both sides.
 */

export const REPO_URL_ACCEPT = [
  '/srv/git/repo.git',
  'C:\\repos\\demo.git',
  'file:///srv/git/repo.git',
  'file://localhost/srv/git/repo.git'
] as const

export const REPO_URL_REJECT = [
  // SCP-like without user@: the host requires it, so the platform must too.
  'example.com:org/repo.git',
  'localhost:org/repo.git',
  // UNC points at an SMB share, a remote surface the host must not open.
  '\\\\server\\share\\repo.git',
  '//server/share/repo.git'
] as const
