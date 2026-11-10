import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  panels: { hostId: string; worktreeId: string; name?: string }[]
  previews: {
    route: { ok: true; params: Record<string, string | undefined> } | { ok: false; message: string }
  }[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  panels: [],
  previews: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('../files/MobileFileExplorerPanel', () => ({
  MobileFileExplorerPanel: (props: { hostId: string; worktreeId: string; name?: string }) => {
    dependencies.panels.push(props)
    return null
  }
}))

vi.mock('../files/MobileFilePreviewScreen', () => ({
  MobileFilePreviewScreen: (props: RouteDependencies['previews'][number]) => {
    dependencies.previews.push(props)
    return null
  }
}))

import MobileFileExplorerScreen from '../../app/h/[hostId]/files/[worktreeId]'
import MobileFilePreviewRoute from '../../app/h/[hostId]/files/preview/[worktreeId]'

async function renderExplorer(): Promise<void> {
  await act(async () => {
    create(createElement(MobileFileExplorerScreen))
  })
}

async function renderPreview(): Promise<void> {
  await act(async () => {
    create(createElement(MobileFilePreviewRoute))
  })
}

beforeEach(() => {
  dependencies.panels.length = 0
  dependencies.previews.length = 0
  dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
  vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', 'ota')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the native file explorer route', () => {
  it('stays native in an OTA build, where the shell lacks the file actions', async () => {
    await renderExplorer()
    expect(dependencies.panels).toEqual([
      {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        name: 'my worktree',
        embedded: false
      }
    ])
  })

  it('takes the first value of a repeated param', async () => {
    dependencies.params = {
      hostId: ['host-a', 'host-b'],
      worktreeId: ['wt-1', 'wt-2'],
      name: ['first', 'second']
    }
    await renderExplorer()
    expect(dependencies.panels[0]).toMatchObject({
      hostId: 'host-a',
      worktreeId: 'wt-1',
      name: 'first'
    })
  })

  it('stays native in a build without the shell', async () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', undefined)
    await renderExplorer()
    expect(dependencies.panels).toHaveLength(1)
  })
})

describe('the native file preview route', () => {
  beforeEach(() => {
    dependencies.params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'docs/readme.md'
    }
  })

  it('stays native in an OTA build and hands the route to the screen', async () => {
    await renderPreview()
    expect(dependencies.previews[0]?.route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'docs/readme.md',
        source: 'worktree'
      }
    })
  })

  it('keeps the file path out of the pathname and in the route params', async () => {
    dependencies.params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'docs/a b/../c.md'
    }
    await renderPreview()
    const route = dependencies.previews[0]?.route
    expect(route?.ok && route.params.relativePath).toBe('docs/a b/../c.md')
  })

  it('refuses a preview route without a file path', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1' }
    await renderPreview()
    expect(dependencies.previews[0]?.route).toEqual({
      ok: false,
      message: 'Unable to load preview'
    })
  })
})
