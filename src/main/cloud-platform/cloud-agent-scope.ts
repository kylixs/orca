import { isAbsolute, join } from 'node:path'
import { readField, readString } from '../../shared/json-fields'
import {
  checkCloudTargetScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'

/**
 * Which agent RPCs a cloud session may drive, and whose workspace they address.
 *
 * The `agent` permission alone is not a boundary: an agent CLI runs commands, and a
 * structured session drives one. A client picks the worktree a launch runs in and
 * names a session id for every later call, so both are bounded by the ticket's
 * workspace root rather than trusted.
 *
 * A session id resolves to its worktree through the host's session record; a
 * terminal-backed session still has a live PTY, so the terminal lookup is the
 * fallback. A host that cannot answer either lookup refuses the call.
 *
 * Methods that describe the host's provider catalog, span every session, or reach
 * host-side data with no workspace address cannot be bounded and stay closed.
 */

export type CloudAgentScope =
  | { kind: 'create' }
  | { kind: 'session' }
  | { kind: 'deny'; message: string }

/** Starts work; the target worktree must resolve inside the caller's workspace root. */
export const CLOUD_AGENT_CREATE_METHODS: ReadonlySet<string> = new Set([
  'agent.launch',
  'agent.launchReplay',
  'agentSession.create',
  'agentSession.createSupport',
  'agentSession.ensure'
])

/** Addresses an existing session by id; the session's worktree is the boundary. */
export const CLOUD_AGENT_SESSION_METHODS: ReadonlySet<string> = new Set([
  'agentSession.rewind',
  'agentSession.conversationCommand',
  'agentSession.send',
  'agentSession.cancel',
  'agentSession.queuedMessageUpdate',
  'agentSession.queuedMessageEditHold',
  'agentSession.queuedMessageSend',
  'agentSession.queuedMessageDelete',
  'agentSession.queuedMessagesResume',
  'agentSession.respondToApproval',
  'agentSession.respondToQuestion',
  'agentSession.setOption',
  'agentSession.hold',
  'agentSession.release',
  'agentSession.close',
  'agentSession.history',
  'agentSession.subscribe',
  'agentSession.unsubscribe',
  'agentSession.acknowledgeAttention',
  'agentSession.threadGoal',
  'agentSession.conversationOutline',
  'agentSession.continueInterrupted',
  'agentSession.readVisual',
  'agentSession.commands',
  'agentSession.options',
  'agentSession.handoffStatus'
])

/**
 * No address that could be bounded. Attachments reach the host's own file store
 * (and `read` takes an absolute path); the rest are host-window, host-global or
 * fleet-wide, or take an optional id list whose absence means "every session".
 */
export const CLOUD_AGENT_DENIED_METHODS: ReadonlySet<string> = new Set([
  'agentSession.agents',
  'agentSession.modelCatalog',
  'agentSession.subscribeStatus',
  'agentSession.subscribeTurnCompletions',
  'agentSession.restartResumable',
  'agentSession.restartResumableDismiss',
  'agentSession.restartContinue',
  'agentSession.restartResume',
  'agentSessionAttachment.uploadStart',
  'agentSessionAttachment.uploadAppend',
  'agentSessionAttachment.uploadCommit',
  'agentSessionAttachment.uploadAbort',
  'agentSessionAttachment.read',
  'agentTeams.tmuxCompat',
  'agentTeams.prepareLaunch',
  'agentHooks.prepareCodexForWslPane'
])

/** The granted prefixes; anything else beginning with `agent` is not ours to classify. */
const AGENT_PREFIXES: readonly string[] = [
  'agent.',
  'agentSession.',
  'agentSessionAttachment.',
  'agentTeams.',
  'agentHooks.',
  'agentProvider.'
]

export function cloudAgentScopeOf(method: string): CloudAgentScope | null {
  if (CLOUD_AGENT_CREATE_METHODS.has(method)) {
    return { kind: 'create' }
  }
  if (CLOUD_AGENT_SESSION_METHODS.has(method)) {
    return { kind: 'session' }
  }
  if (CLOUD_AGENT_DENIED_METHODS.has(method)) {
    return { kind: 'deny', message: deniedMessage(method) }
  }
  // Fail closed: an agent method nobody classified is not "harmless".
  if (AGENT_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return { kind: 'deny', message: deniedMessage(method) }
  }
  return null
}

function deniedMessage(method: string): string {
  if (method.startsWith('agentSessionAttachment.')) {
    return `Method '${method}' reaches the host's attachment store, which is not bounded to your workspace.`
  }
  if (method.startsWith('agentTeams.') || method.startsWith('agentHooks.')) {
    return `Method '${method}' acts on the host's own window and is not available to cloud sessions.`
  }
  if (method === 'agentSession.agents' || method === 'agentSession.modelCatalog') {
    return `Method '${method}' describes the host's provider catalog and is not available to cloud sessions.`
  }
  if (method.startsWith('agentSession.')) {
    return `Method '${method}' answers across every session on the host and is not available to cloud sessions.`
  }
  return `Method '${method}' is not available to cloud sessions.`
}

export type CloudAgentScopeRuntime = {
  resolveWorktreeRootPath: (worktreeSelector: string) => Promise<string>
  /** The worktree a session runs in; null when no record or live terminal matches. */
  resolveAgentSessionContext?: (sessionId: string) => { worktreeId: string } | null
  /** Fallback for a terminal-backed session, whose id may still be a live handle. */
  resolveTerminalContext?: (
    terminalHandle: string
  ) => { worktreeId: string; connectionId: string | null } | null
}

export async function checkCloudAgentScope(
  args: { runtime: CloudAgentScopeRuntime; roots: CloudPathRoots; method: string; params: unknown },
  scope: CloudAgentScope
): Promise<CloudPathDecision> {
  if (scope.kind === 'deny') {
    return { ok: false, reason: 'agent_scope', message: scope.message }
  }
  if (scope.kind === 'session') {
    return await checkSession(args)
  }
  return await checkCreate(args)
}

/** A launch names its target; a session create names a worktree or an attached workspace id. */
async function checkCreate(args: {
  runtime: CloudAgentScopeRuntime
  roots: CloudPathRoots
  method: string
  params: unknown
}): Promise<CloudPathDecision> {
  if (args.method === 'agent.launch' || args.method === 'agent.launchReplay') {
    return await checkLaunchTarget(args)
  }
  const selector = createWorktreeSelector(args.params)
  if (selector === null) {
    return {
      ok: false,
      reason: 'agent_worktree_required',
      message: 'A cloud agent launch must name the workspace it runs in.'
    }
  }
  return await checkWorkspace(args, selector)
}

/**
 * Only an existing workspace can be bounded: the host derives a new checkout's
 * path from its own settings, the same reason `worktree.create` stays refused.
 */
async function checkLaunchTarget(args: {
  runtime: CloudAgentScopeRuntime
  roots: CloudPathRoots
  method: string
  params: unknown
}): Promise<CloudPathDecision> {
  const target = readField(args.params, 'target')
  const kind = readString(target, 'kind')
  if (kind === null) {
    return {
      ok: false,
      reason: 'agent_worktree_required',
      message: 'A cloud agent launch must name the workspace it runs in.'
    }
  }
  if (kind !== 'existing') {
    return {
      ok: false,
      reason: 'agent_target_unbounded',
      message:
        'A cloud agent launch must open an existing workspace; create it with managed worktree creation first.'
    }
  }
  const selector = readString(target, 'worktree')
  if (selector === null) {
    return {
      ok: false,
      reason: 'agent_worktree_required',
      message: 'A cloud agent launch must name the workspace it runs in.'
    }
  }
  return await checkWorkspace(args, selector)
}

function createWorktreeSelector(params: unknown): string | null {
  const direct = readString(params, 'worktree')
  if (direct !== null) {
    return direct
  }
  const workspaceId = readString(readField(params, 'location'), 'workspaceId')
  return workspaceId === null ? null : `id:${workspaceId}`
}

async function checkSession(args: {
  runtime: CloudAgentScopeRuntime
  roots: CloudPathRoots
  params: unknown
}): Promise<CloudPathDecision> {
  const sessionId =
    readString(args.params, 'sessionId') ??
    readString(readField(args.params, 'envelope'), 'sessionId')
  // Why both lookups: a host that cannot say where a session runs cannot prove it
  // belongs to the caller, so the call is refused rather than assumed in scope.
  const context =
    sessionId === null
      ? null
      : (args.runtime.resolveAgentSessionContext?.(sessionId) ??
        args.runtime.resolveTerminalContext?.(sessionId) ??
        null)
  if (context === null) {
    return {
      ok: false,
      reason: 'agent_session_unknown',
      message: 'This agent session is not available to the cloud session.'
    }
  }
  return await checkWorkspaceFromId(args, context.worktreeId)
}

async function checkWorkspace(
  args: {
    runtime: CloudAgentScopeRuntime
    roots: CloudPathRoots
    method: string
    params: unknown
  },
  selector: string
): Promise<CloudPathDecision> {
  let worktreePath: string
  try {
    worktreePath = await args.runtime.resolveWorktreeRootPath(selector)
  } catch {
    return {
      ok: false,
      reason: 'worktree_unknown',
      message: 'This worktree is not available to the cloud session.'
    }
  }
  const scope = checkCloudTargetScope(args.roots, 'write', worktreePath)
  if (!scope.ok) {
    return scope
  }
  return await checkLaunchExtras(args, worktreePath)
}

async function checkWorkspaceFromId(
  args: { runtime: CloudAgentScopeRuntime; roots: CloudPathRoots },
  worktreeId: string
): Promise<CloudPathDecision> {
  let worktreePath: string
  try {
    worktreePath = await args.runtime.resolveWorktreeRootPath(`id:${worktreeId}`)
  } catch {
    return {
      ok: false,
      reason: 'agent_session_unknown',
      message: 'This agent session is not available to the cloud session.'
    }
  }
  return checkCloudTargetScope(args.roots, 'write', worktreePath)
}

/**
 * A launch may also name a start directory and a terminal to reuse; either would
 * otherwise drive a shell outside the workspace the target selector passed.
 */
async function checkLaunchExtras(
  args: { runtime: CloudAgentScopeRuntime; roots: CloudPathRoots; params: unknown },
  worktreePath: string
): Promise<CloudPathDecision> {
  const cwd = readString(args.params, 'cwd')
  if (cwd !== null) {
    const cwdScope = checkCloudTargetScope(
      args.roots,
      'write',
      isAbsolute(cwd) ? cwd : join(worktreePath, cwd)
    )
    if (!cwdScope.ok) {
      return cwdScope
    }
  }
  const reuseHandle = readString(readField(args.params, 'reuseTerminal'), 'handle')
  if (reuseHandle === null) {
    return { ok: true }
  }
  const context = args.runtime.resolveTerminalContext?.(reuseHandle) ?? null
  if (context === null) {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'This terminal is not available to the cloud session.'
    }
  }
  return await checkWorkspaceFromId(args, context.worktreeId)
}
