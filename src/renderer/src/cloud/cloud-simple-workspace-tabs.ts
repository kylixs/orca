/**
 * Tab state machine for the embedded simple workspace (U46-5a, design §4.4).
 *
 * Pure so the shell can hold it in a reducer and tests can drive it directly.
 * Terminal/editor/preview panes are mounted by the shell through a registry;
 * their content orders (U46-5b, U46-6/7) plug in without touching this state.
 */

import { createBrowserUuid } from '../lib/browser-uuid'
import type { CloudWorkspaceDiffSource } from './cloud-workspace-diff-tab-model'
import {
  mergeHostTabsIntoState,
  type CloudSimpleHostTerminalTab
} from './cloud-simple-workspace-session-tabs'

export type CloudSimpleWorkspaceTabKind = 'terminal' | 'editor' | 'preview' | 'diff'

/** Host-owned terminal handle snapshot; absent until a host snapshot confirms the tab. */
export type CloudSimpleWorkspaceHostTerminal = {
  leafId: string
  /** null while the host still restores the PTY (pending-handle). */
  terminal: string | null
  ptyId: string | null
  /** >1 means the host tab is a split; only the active leaf is rendered here. */
  leafCount: number
}

export type CloudSimpleWorkspaceTab =
  | { id: string; kind: 'terminal'; title: string; host?: CloudSimpleWorkspaceHostTerminal }
  | { id: string; kind: 'editor'; title: string; path: string }
  | {
      id: string
      kind: 'preview'
      title: string
      path: string
      mode: 'preview' | 'image' | 'binary'
    }
  | {
      id: string
      kind: 'diff'
      title: string
      path: string
      /** Working-tree rows omit this; a commit row carries its commit identity. */
      source?: CloudWorkspaceDiffSource
    }

/** One PTY per terminal tab; the device session allows 12 sockets total. */
export const CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS = 6

export type CloudSimpleWorkspaceTabsState = {
  tabs: CloudSimpleWorkspaceTab[]
  activeId: string | null
  /** Tab id → unsaved buffer; absent means clean. */
  dirty: Record<string, boolean>
  /** True once a host snapshot has set the active tab; later snapshots keep the local choice. */
  hostSynced?: boolean
}

export type CloudSimpleWorkspaceTabsAction =
  | { type: 'open'; tab: CloudSimpleWorkspaceTab; activate?: boolean }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'setDirty'; id: string; dirty: boolean }
  /** Replace host terminal tabs with a projection; local file/preview/diff tabs survive. */
  | { type: 'host-snapshot'; tabs: readonly CloudSimpleHostTerminalTab[]; activeId: string | null }
  | { type: 'reset' }

export function cloudSimpleWorkspaceTabsInitialState(
  tabs: CloudSimpleWorkspaceTab[] = []
): CloudSimpleWorkspaceTabsState {
  return { tabs, activeId: tabs[0]?.id ?? null, dirty: {} }
}

function isFileBacked(
  tab: CloudSimpleWorkspaceTab
): tab is Extract<CloudSimpleWorkspaceTab, { path: string }> {
  return tab.kind === 'editor' || tab.kind === 'preview'
}

/** Same file = one tab; an editor and a preview of it share the slot. */
function findExisting(
  state: CloudSimpleWorkspaceTabsState,
  tab: CloudSimpleWorkspaceTab
): CloudSimpleWorkspaceTab | undefined {
  return state.tabs.find(
    (candidate) =>
      candidate.id === tab.id ||
      (isFileBacked(candidate) && isFileBacked(tab) && candidate.path === tab.path)
  )
}

export function cloudSimpleWorkspaceTabsReducer(
  state: CloudSimpleWorkspaceTabsState,
  action: CloudSimpleWorkspaceTabsAction
): CloudSimpleWorkspaceTabsState {
  switch (action.type) {
    case 'open': {
      const existing = findExisting(state, action.tab)
      if (existing) {
        return state.activeId === existing.id ? state : { ...state, activeId: existing.id }
      }
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeId: action.activate === false ? state.activeId : action.tab.id
      }
    }
    case 'activate': {
      if (state.activeId === action.id || !state.tabs.some((tab) => tab.id === action.id)) {
        return state
      }
      return { ...state, activeId: action.id }
    }
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index === -1) {
        return state
      }
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      const dirty = { ...state.dirty }
      delete dirty[action.id]
      if (state.activeId !== action.id) {
        return { tabs, activeId: state.activeId, dirty }
      }
      // Right neighbor first, then left (design §4.4).
      const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1] ?? null
      return { tabs, activeId: neighbor?.id ?? null, dirty }
    }
    case 'setDirty': {
      if (!state.tabs.some((tab) => tab.id === action.id)) {
        return state
      }
      if (!action.dirty) {
        if (!state.dirty[action.id]) {
          return state
        }
        const dirty = { ...state.dirty }
        delete dirty[action.id]
        return { ...state, dirty }
      }
      return state.dirty[action.id]
        ? state
        : { ...state, dirty: { ...state.dirty, [action.id]: true } }
    }
    case 'host-snapshot':
      return mergeHostTabsIntoState(state, action.tabs, action.activeId)
    case 'reset':
      return cloudSimpleWorkspaceTabsInitialState()
  }
}

/** Host identity contract: a tab id without ':' and a UUID leaf id. */
export const CLOUD_TERMINAL_TAB_ID_PREFIX = 'terminal-'

/** The leaf half of a local terminal tab id, so `terminal.create` adopts both hints. */
export function cloudTerminalLeafId(tabId: string): string {
  return tabId.startsWith(CLOUD_TERMINAL_TAB_ID_PREFIX)
    ? tabId.slice(CLOUD_TERMINAL_TAB_ID_PREFIX.length)
    : tabId
}

/** Lowest unused terminal number; the id is minted in the host's adoptable shape. */
export function nextTerminalTab(
  tabs: CloudSimpleWorkspaceTab[],
  id = `${CLOUD_TERMINAL_TAB_ID_PREFIX}${createBrowserUuid()}`
): Extract<CloudSimpleWorkspaceTab, { kind: 'terminal' }> | null {
  if (
    tabs.filter((tab) => tab.kind === 'terminal').length >= CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS
  ) {
    return null
  }
  const used = new Set<number>()
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') {
      continue
    }
    const match = /^Terminal (\d+)$/.exec(tab.title)
    if (match) {
      used.add(Number(match[1]))
    }
  }
  let number = 1
  while (used.has(number)) {
    number += 1
  }
  return {
    id,
    kind: 'terminal',
    title: `Terminal ${number}`
  }
}

export function cloudSimpleWorkspaceFileTab(
  path: string,
  kind?: 'editor'
): Extract<CloudSimpleWorkspaceTab, { kind: 'editor' }>
export function cloudSimpleWorkspaceFileTab(
  path: string,
  kind: 'preview',
  mode: 'preview' | 'image' | 'binary'
): Extract<CloudSimpleWorkspaceTab, { kind: 'preview' }>
export function cloudSimpleWorkspaceFileTab(
  path: string,
  kind: 'editor' | 'preview' = 'editor',
  mode: 'preview' | 'image' | 'binary' = 'preview'
): CloudSimpleWorkspaceTab {
  const title = path.split('/').at(-1) ?? path
  return kind === 'preview'
    ? { id: `preview:${path}`, kind, title, path, mode }
    : { id: `file:${path}`, kind, title, path }
}

/** A diff tab never shares the editor/preview slot: source and diff coexist. */
export function cloudSimpleWorkspaceDiffTab(
  path: string,
  source?: CloudWorkspaceDiffSource
): Extract<CloudSimpleWorkspaceTab, { kind: 'diff' }> {
  const title = path.split('/').at(-1) ?? path
  // Commit identity is part of the id, so the same file in two commits opens twice.
  if (source?.kind === 'commit') {
    return {
      id: `diff:${source.commitOid}:${path}`,
      kind: 'diff',
      title,
      path,
      source
    }
  }
  return { id: `diff:${path}`, kind: 'diff', title, path }
}

export function cloudSimpleWorkspaceDirtyCount(state: CloudSimpleWorkspaceTabsState): number {
  return Object.values(state.dirty).filter(Boolean).length
}
