// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudCreateProjectInput,
  CloudCreateProjectResult,
  CloudProvisionableHost
} from '../../../shared/cloud-platform-ipc'
import { CloudNewProjectDialog, isValidProjectDirName } from './cloud-new-project-dialog'
import type { CloudBridge } from './use-cloud-session'

// Radix selects need real pointer/portal behaviour, so the dialog is tested
// against lightweight stand-ins whose items are plain buttons (repo pattern:
// ExperimentalPane/AppearancePane).
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  type SelectValue = { value?: string; onValueChange?: (value: string) => void }
  const SelectContext = React.createContext<SelectValue>({})
  return {
    Select: ({ value, onValueChange, children }: SelectValue & { children?: React.ReactNode }) => {
      const context = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange])
      return (
        <SelectContext.Provider value={context}>
          <div data-slot="select" data-value={value ?? ''}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ''}</span>,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

const HOST: CloudProvisionableHost = {
  id: 'host_1',
  name: 'dev-001',
  online: true,
  provisionable: true,
  projectDirs: ['payment-service', 'risk-report']
}

function makeBridge(
  options: {
    hosts?: CloudProvisionableHost[]
    create?: (input: CloudCreateProjectInput) => Promise<CloudCreateProjectResult>
  } = {}
): CloudBridge {
  return {
    login: async () => ({ status: 'signed-out' }),
    getLoginContext: async () => null,
    logout: async () => ({ status: 'signed-out' }),
    getState: async () => ({ status: 'signed-out' }),
    listProjects: async () => [],
    openProject: async () => ({ ok: false, code: 'UNUSED' }),
    openWorkspace: async () => ({ ok: false, code: 'UNUSED' }),
    registerProjects: async () => ({
      environments: [],
      failures: [],
      removedEnvironmentIds: []
    }),
    retryPrepare: async () => ({ ok: false, code: 'UNUSED' }),
    createProject: options.create ?? (async () => ({ ok: false, code: 'UNUSED' })),
    archiveProject: async () => ({ ok: false, code: 'UNUSED' }),
    listProvisionableHosts: async () => options.hosts ?? [],
    closeProject: async () => ({ ok: true }),
    rpc: async () => ({ ok: true, result: {} }),
    onConnectionChanged: () => () => undefined
  }
}

function renderDialog(
  bridge: CloudBridge,
  onOpenChange: (open: boolean) => void = () => undefined
) {
  return render(
    <CloudNewProjectDialog
      bridge={bridge}
      open
      onOpenChange={onOpenChange}
      onCreated={() => undefined}
    />
  )
}

/** The dir select lists only the selected host's directories. */
async function chooseExistingDir(name: string): Promise<void> {
  fireEvent.click(await screen.findByText(name))
}

afterEach(cleanup)

describe('目录名校验', () => {
  it('接受单级安全名称，拒绝分隔符、相对段与控制字符', () => {
    expect(isValidProjectDirName('payment-service')).toBe(true)
    expect(isValidProjectDirName('  支付服务  ')).toBe(true)
    expect(isValidProjectDirName('')).toBe(false)
    expect(isValidProjectDirName('a/b')).toBe(false)
    expect(isValidProjectDirName('a\\b')).toBe(false)
    expect(isValidProjectDirName('..')).toBe(false)
    expect(isValidProjectDirName('.')).toBe(false)
    expect(isValidProjectDirName('/srv/absolute')).toBe(false)
    expect(isValidProjectDirName('a\tb')).toBe(false)
    expect(isValidProjectDirName('a'.repeat(201))).toBe(false)
  })
})

describe('新建云端项目对话框', () => {
  it('打开时显示字段，仓库地址标注可选，关闭后不再渲染', async () => {
    const bridge = makeBridge({ hosts: [HOST] })
    const { rerender } = renderDialog(bridge)
    expect(screen.getByLabelText('名称')).toBeTruthy()
    expect(screen.getByText('目录')).toBeTruthy()
    expect(screen.getByLabelText('仓库地址')).toBeTruthy()
    expect(screen.getByLabelText('默认分支')).toBeTruthy()
    expect(screen.getByText(/可选，填写后由宿主克隆/)).toBeTruthy()

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

  it('名称与目录必填；仓库地址留空也能提交，且不携带 repoUrl', async () => {
    const inputs: CloudCreateProjectInput[] = []
    const created = {
      ok: true as const,
      projectId: 'proj_new',
      environment: {
        projectId: 'proj_new',
        projectName: 'Demo',
        projectRoot: '/srv/projects/payment-service',
        environmentId: 'env_new'
      }
    }
    const bridge = makeBridge({
      hosts: [HOST],
      create: async (input) => {
        inputs.push(input)
        return created
      }
    })
    renderDialog(bridge)
    const create = screen.getByRole('button', { name: '创建' })

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    expect(create.hasAttribute('disabled')).toBe(true)

    await chooseExistingDir('payment-service')
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))
    fireEvent.click(create)

    await waitFor(() => expect(inputs).toHaveLength(1))
    expect(inputs[0]).toEqual({
      name: 'Demo',
      dir: 'payment-service',
      defaultBranch: 'main',
      hostId: 'host_1'
    })
  })

  it('新建目录模式下非法名称禁用提交并提示原因', async () => {
    renderDialog(makeBridge({ hosts: [HOST] }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    fireEvent.click(await screen.findByRole('radio', { name: '新建目录' }))

    const dir = screen.getByLabelText('目录')
    fireEvent.change(dir, { target: { value: '../escape' } })
    await screen.findByText(/不能包含/)
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(dir, { target: { value: 'fresh-dir' } })
    await waitFor(() => expect(screen.queryByText(/不能包含/)).toBeNull())
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
  })

  it('宿主未上报目录时自动切到新建目录并可提交', async () => {
    const inputs: CloudCreateProjectInput[] = []
    const created = {
      ok: true as const,
      projectId: 'proj_new',
      environment: {
        projectId: 'proj_new',
        projectName: 'Demo',
        projectRoot: '/srv/projects/fresh-dir',
        environmentId: 'env_new'
      }
    }
    renderDialog(
      makeBridge({
        hosts: [{ ...HOST, projectDirs: [] }],
        create: async (input) => {
          inputs.push(input)
          return created
        }
      })
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    await screen.findByText('dev-001')
    const dir = screen.getByLabelText('目录')
    expect(dir.tagName).toBe('INPUT')
    fireEvent.change(dir, { target: { value: 'fresh-dir' } })
    const create = screen.getByRole('button', { name: '创建' })
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))
    fireEvent.click(create)
    await waitFor(() => expect(inputs).toHaveLength(1))
    expect(inputs[0]?.dir).toBe('fresh-dir')
  })

  it('切换主机后清空已选目录，新主机没有目录时自动改新建', async () => {
    renderDialog(
      makeBridge({
        hosts: [
          HOST,
          { id: 'host_2', name: 'dev-002', online: true, provisionable: true, projectDirs: [] }
        ]
      })
    )
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
    // Two eligible hosts stay unselected until the user picks one.
    fireEvent.click(await screen.findByText('dev-001'))
    await chooseExistingDir('risk-report')
    const create = screen.getByRole('button', { name: '创建' })
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))

    fireEvent.click(screen.getByText('dev-002'))
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(true))
    expect(screen.getByLabelText('目录').tagName).toBe('INPUT')
  })

  it('没有可创建项目的主机时提示原因并禁用提交', async () => {
    renderDialog(makeBridge({ hosts: [{ ...HOST, provisionable: false }] }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Demo' } })
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
    await chooseExistingDir('payment-service')
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
    await chooseExistingDir('payment-service')
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
    await chooseExistingDir('payment-service')
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: 'https://git.example.com/demo.git' }
    })
    fireEvent.change(screen.getByLabelText('项目 Key'), { target: { value: 'demo-key' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(inputs[0]).toEqual({
      name: 'Demo Service',
      dir: 'payment-service',
      key: 'demo-key',
      repoUrl: 'https://git.example.com/demo.git',
      defaultBranch: 'main',
      hostId: 'host_1'
    })
  })
})
