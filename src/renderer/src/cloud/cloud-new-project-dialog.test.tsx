// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudCreateProjectInput,
  CloudCreateProjectResult,
  CloudProvisionableHost
} from '../../../shared/cloud-platform-ipc'
import { CloudNewProjectDialog } from './cloud-new-project-dialog'
import type { CloudBridge } from './use-cloud-session'

const HOST: CloudProvisionableHost = {
  id: 'host_1',
  name: 'dev-001',
  online: true,
  provisionable: true
}

function makeBridge(
  options: {
    hosts?: CloudProvisionableHost[]
    create?: (input: CloudCreateProjectInput) => Promise<CloudCreateProjectResult>
  } = {}
): CloudBridge {
  return {
    login: async () => ({ status: 'signed-out' }),
    logout: async () => ({ status: 'signed-out' }),
    getState: async () => ({ status: 'signed-out' }),
    listProjects: async () => [],
    openProject: async () => ({ ok: false, code: 'UNUSED' }),
    openWorkspace: async () => ({ ok: false, code: 'UNUSED' }),
    registerProjects: async () => ({ environments: [], failures: [] }),
    retryPrepare: async () => ({ ok: false, code: 'UNUSED' }),
    createProject: options.create ?? (async () => ({ ok: false, code: 'UNUSED' })),
    listProvisionableHosts: async () => options.hosts ?? [],
    closeProject: async () => ({ ok: true }),
    rpc: async () => ({ ok: true, result: {} }),
    onConnectionChanged: () => () => undefined
  }
}

afterEach(cleanup)

describe('新建云端项目对话框', () => {
  it('打开时显示字段，关闭后不再渲染', async () => {
    const bridge = makeBridge({ hosts: [HOST] })
    const { rerender } = render(
      <CloudNewProjectDialog
        bridge={bridge}
        open
        onOpenChange={() => undefined}
        onCreated={() => undefined}
      />
    )
    expect(screen.getByLabelText('名称')).toBeTruthy()
    expect(screen.getByLabelText('仓库地址')).toBeTruthy()
    expect(screen.getByLabelText('默认分支')).toBeTruthy()

    rerender(
      <CloudNewProjectDialog
        bridge={bridge}
        open={false}
        onOpenChange={() => undefined}
        onCreated={() => undefined}
      />
    )
    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())
  })

  it('没有可创建项目的主机时提示原因并禁用提交', async () => {
    const bridge = makeBridge({ hosts: [{ ...HOST, provisionable: false }] })
    render(
      <CloudNewProjectDialog
        bridge={bridge}
        open
        onOpenChange={() => undefined}
        onCreated={() => undefined}
      />
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: 'https://git.example.com/demo.git' }
    })
    await screen.findByText(/当前没有可创建项目的主机/)
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true)
  })

  it('平台已创建但准备失败时交给回调并关闭，不内联停留', async () => {
    const created: CloudCreateProjectResult = {
      ok: false,
      code: 'CLONE_FAILED',
      projectId: 'proj_new',
      project: {
        id: 'proj_new',
        key: 'broken-source',
        name: 'Broken Source',
        hostName: 'dev-001',
        hostStatus: 'online',
        downloadRestricted: false,
        status: 'failed',
        provisioningError: 'CLONE_FAILED'
      }
    }
    const results: CloudCreateProjectResult[] = []
    const changes: boolean[] = []
    const bridge = makeBridge({ hosts: [HOST], create: async () => created })
    render(
      <CloudNewProjectDialog
        bridge={bridge}
        open
        onOpenChange={(open) => changes.push(open)}
        onCreated={(result) => {
          results.push(result)
        }}
      />
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Broken Source' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: '/srv/missing.git' }
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(results).toEqual([created]))
    expect(changes).toEqual([false])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('未创建项目的前置失败仍内联显示并保持打开', async () => {
    const onCreated = vi.fn()
    const changes: boolean[] = []
    const bridge = makeBridge({
      hosts: [HOST],
      create: async () => ({ ok: false, code: 'PROJECT_KEY_TAKEN', message: 'Key 已存在' })
    })
    render(
      <CloudNewProjectDialog
        bridge={bridge}
        open
        onOpenChange={(open) => changes.push(open)}
        onCreated={onCreated}
      />
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: '/srv/demo.git' }
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await screen.findByText(/PROJECT_KEY_TAKEN/)
    expect(onCreated).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  })

  it('提交后把输入交给 bridge 并回调创建成功', async () => {
    const inputs: CloudCreateProjectInput[] = []
    const created = {
      ok: true as const,
      projectId: 'proj_new',
      environment: {
        projectId: 'proj_new',
        projectName: 'Demo Service',
        projectRoot: '/srv/projects/demo-service',
        environmentId: 'env_new'
      }
    }
    const onCreated: Parameters<typeof CloudNewProjectDialog>[0]['onCreated'] = async () =>
      undefined
    const onOpenChange = (open: boolean): void => {
      expect(open).toBe(false)
    }
    const calls: unknown[] = []
    const bridge = makeBridge({
      hosts: [HOST],
      create: async (input) => {
        inputs.push(input)
        calls.push(created)
        return created
      }
    })
    render(
      <CloudNewProjectDialog
        bridge={bridge}
        open
        onOpenChange={onOpenChange}
        onCreated={(entry) => {
          calls.push(entry)
          return onCreated(entry)
        }}
      />
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo Service' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: 'https://git.example.com/demo.git' }
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(inputs[0]).toEqual({
      name: 'Demo Service',
      repoUrl: 'https://git.example.com/demo.git',
      defaultBranch: 'main',
      hostId: 'host_1'
    })
  })
})
