import { readArrayValue, readString } from '../../shared/json-fields'
import {
  provisionFailureMessage,
  validateCloudBranchName,
  validateCloudCloneUrl,
  type CloudProjectProvisionInput,
  type CloudProjectProvisionResult,
  type CloudProvisionReport
} from './cloud-project-provision'

/**
 * U37: the heartbeat response's `provisionAssignments`, executed outside any
 * ticket so a repo-ful project can reach `ready` without a first `/connect`.
 */

export type CloudProvisionAssignment = {
  projectId: string
  path: string
  repoUrl: string
  defaultBranch: string
}

/** Same per-beat bound the platform applies when deriving the list. */
export const MAX_PROVISION_ASSIGNMENTS_PER_BEAT = 16

const MAX_PROJECT_ID_LENGTH = 128
const MAX_ASSIGNMENT_PATH_LENGTH = 4096
const MAX_ASSIGNMENT_URL_LENGTH = 4096
const MAX_ASSIGNMENT_BRANCH_LENGTH = 200

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * Host-side twin of the platform's `validateProjectPath`: the platform enforced
 * this at creation, so a non-canonical root here means a tampered or drifting
 * peer. Kept dependency-free for the same reason `cloud-credential.ts` is.
 */
export function isProvisionableCheckoutPath(value: string): boolean {
  if (value === '') {
    return false
  }
  if (hasControlCharacter(value)) {
    return false
  }
  const isPosix = value.startsWith('/')
  const isWindows = WINDOWS_ABSOLUTE.test(value)
  if (!isPosix && !isWindows) {
    return false
  }
  const rootOnly = isPosix ? '/' : value.slice(0, 3)
  if (value !== rootOnly && /[\\/]$/.test(value)) {
    return false
  }
  // Both separator styles are legal on a Windows host; POSIX paths take `/` only.
  if (isPosix && value.includes('\\')) {
    return false
  }
  const body = isPosix ? value.slice(1) : value.slice(3)
  return body
    .split(/[\\/]/)
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Defensive read of the heartbeat field: a malformed entry is dropped, never a
 * whole beat. Old platforms omit the field entirely, which parses as none.
 */
export function parseCloudProvisionAssignments(value: unknown): CloudProvisionAssignment[] {
  const entries = readArrayValue(value)
  if (entries === null) {
    return []
  }
  const assignments: CloudProvisionAssignment[] = []
  for (const entry of entries) {
    if (assignments.length === MAX_PROVISION_ASSIGNMENTS_PER_BEAT) {
      break
    }
    const projectId = readString(entry, 'projectId')
    const path = readString(entry, 'path')
    const repoUrl = readString(entry, 'repoUrl')
    const defaultBranch = readString(entry, 'defaultBranch')
    // No id means the outcome could never be reported back, so the entry is noise.
    if (
      projectId === null ||
      projectId === '' ||
      path === null ||
      repoUrl === null ||
      defaultBranch === null
    ) {
      continue
    }
    assignments.push({
      projectId: projectId.slice(0, MAX_PROJECT_ID_LENGTH),
      path: path.slice(0, MAX_ASSIGNMENT_PATH_LENGTH),
      repoUrl: repoUrl.slice(0, MAX_ASSIGNMENT_URL_LENGTH),
      defaultBranch: defaultBranch.slice(0, MAX_ASSIGNMENT_BRANCH_LENGTH)
    })
  }
  return assignments
}

export type CloudProvisionAssignmentExecutor = (assignment: CloudProvisionAssignment) => void

/** Parses the beat's raw field and fans it out; a bad listener must never break the beat loop. */
export function notifyProvisionAssignments(
  listeners: Iterable<(assignment: CloudProvisionAssignment) => void>,
  rawAssignments: unknown
): void {
  for (const assignment of parseCloudProvisionAssignments(rawAssignments)) {
    for (const listener of listeners) {
      try {
        listener(assignment)
      } catch (error) {
        console.warn('[cloud] provision assignment listener failed:', error)
      }
    }
  }
}

export type CloudProvisionAssignmentExecutorDeps = {
  /** Null while no runtime exposes the provision surface; the assignment is skipped. */
  provision: ((input: CloudProjectProvisionInput) => Promise<CloudProjectProvisionResult>) | null
  report: (report: CloudProvisionReport) => void
  /** Maintenance hosts take no new assignments (§8①); the platform re-sends later. */
  inMaintenance?: () => boolean
}

/**
 * Serial, per-project-deduplicated runner: one clone at a time, a repeat for a
 * project already in flight is dropped (`cloneToPath`'s per-path lock is the
 * second gate). Every failure becomes a report; nothing ever throws into the
 * heartbeat loop that calls it.
 */
export function createCloudProvisionAssignmentExecutor(
  deps: CloudProvisionAssignmentExecutorDeps
): CloudProvisionAssignmentExecutor {
  const inFlightByProjectId = new Set<string>()
  let chain: Promise<void> = Promise.resolve()
  return (assignment) => {
    if (inFlightByProjectId.has(assignment.projectId)) {
      return
    }
    inFlightByProjectId.add(assignment.projectId)
    chain = chain
      .then(() => executeProvisionAssignment(deps, assignment))
      .catch((error: unknown) => console.warn('[cloud] provision assignment failed:', error))
      .finally(() => {
        inFlightByProjectId.delete(assignment.projectId)
      })
  }
}

/** Runs one assignment; every failure is reported, never thrown. */
async function executeProvisionAssignment(
  deps: CloudProvisionAssignmentExecutorDeps,
  assignment: CloudProvisionAssignment
): Promise<void> {
  const provision = deps.provision
  // Not the clone's fault: stay silent and let the platform re-send the assignment.
  if (deps.inMaintenance?.() === true || provision === null) {
    return
  }
  const fail = (code: string) =>
    deps.report({
      projectId: assignment.projectId,
      ok: false,
      error: `${code}: ${provisionFailureMessage(code)}`
    })
  if (!isProvisionableCheckoutPath(assignment.path)) {
    fail('PROVISION_FAILED')
    return
  }
  const url = validateCloudCloneUrl(assignment.repoUrl)
  if (!url.ok) {
    fail(url.code)
    return
  }
  if (assignment.defaultBranch.trim() !== '') {
    const branch = validateCloudBranchName(assignment.defaultBranch)
    if (!branch.ok) {
      fail(branch.code)
      return
    }
  }
  let result: CloudProjectProvisionResult
  try {
    result = await provision({
      projectRoot: assignment.path,
      repoUrl: assignment.repoUrl,
      defaultBranch: assignment.defaultBranch
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'runtime_unavailable') {
      return
    }
    // Why no detail: the report reaches the platform audit log, and spawned-git
    // errors can echo a repo URL that embeds credentials.
    console.warn('[cloud] provision assignment failed unexpectedly:', error)
    result = {
      ok: false,
      code: 'PROVISION_FAILED',
      message: provisionFailureMessage('PROVISION_FAILED')
    }
  }
  deps.report({
    projectId: assignment.projectId,
    ok: result.ok,
    ...(result.ok ? {} : { error: `${result.code}: ${result.message}` })
  })
}
