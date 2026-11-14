import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PROVISION_ASSIGNMENTS_PER_BEAT,
  createCloudProvisionAssignmentExecutor,
  isProvisionableCheckoutPath,
  parseCloudProvisionAssignments,
  type CloudProvisionAssignment,
  type CloudProvisionAssignmentExecutorDeps
} from './cloud-provision-assignment'
import type { CloudProvisionReport } from './cloud-project-provision'

/** Pure contracts of the U37 assignment executor: parse, path gate, run discipline. */

function assignment(overrides: Partial<CloudProvisionAssignment> = {}): CloudProvisionAssignment {
  return {
    projectId: 'proj_ab12cd34',
    path: '/srv/orca-projects/payment-service',
    repoUrl: 'https://git.example.com/pay/payment-service.git',
    defaultBranch: 'main',
    ...overrides
  }
}

function stubDeps(overrides: Partial<CloudProvisionAssignmentExecutorDeps> = {}): {
  deps: CloudProvisionAssignmentExecutorDeps
  reports: CloudProvisionReport[]
  roots: string[]
} {
  const reports: CloudProvisionReport[] = []
  const roots: string[] = []
  return {
    reports,
    roots,
    deps: {
      provision: async (input) => {
        roots.push(input.projectRoot)
        return { ok: true, provisioned: true }
      },
      report: (report) => {
        reports.push(report)
      },
      ...overrides
    }
  }
}

/** Lets the background serial chain run to completion before asserting. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('parseCloudProvisionAssignments', () => {
  it('旧平台字段缺席（undefined/非数组）解析为零指派', () => {
    expect(parseCloudProvisionAssignments(undefined)).toEqual([])
    expect(parseCloudProvisionAssignments(null)).toEqual([])
    expect(parseCloudProvisionAssignments({ projectId: 'proj_x' })).toEqual([])
    expect(parseCloudProvisionAssignments('projet_x')).toEqual([])
  })

  it('逐项解析字段，错型或缺字段只丢该条', () => {
    const parsed = parseCloudProvisionAssignments([
      assignment(),
      { projectId: 'proj_nopath', repoUrl: 'https://git.test/n.git', defaultBranch: 'main' },
      {
        projectId: 42,
        path: '/srv/typed',
        repoUrl: 'https://git.test/t.git',
        defaultBranch: 'main'
      },
      'proj_stray',
      assignment({ projectId: 'proj_ok2', path: '/srv/two' })
    ])
    expect(parsed).toEqual([assignment(), assignment({ projectId: 'proj_ok2', path: '/srv/two' })])
  })

  it('空 projectId 丢弃：没有 id 的失败无处回报', () => {
    expect(parseCloudProvisionAssignments([assignment({ projectId: '' })])).toEqual([])
  })

  it('单拍上限 16 条，余量静默丢弃（平台下拍续发）', () => {
    const entries = Array.from({ length: MAX_PROVISION_ASSIGNMENTS_PER_BEAT + 4 }, (_, index) =>
      assignment({ projectId: `proj_${index}` })
    )
    const parsed = parseCloudProvisionAssignments(entries)
    expect(parsed).toHaveLength(MAX_PROVISION_ASSIGNMENTS_PER_BEAT)
    expect(parsed[0].projectId).toBe('proj_0')
    expect(parsed[MAX_PROVISION_ASSIGNMENTS_PER_BEAT - 1].projectId).toBe('proj_15')
  })

  it('超长字段截断，防一条恶意条目撑爆心跳循环', () => {
    const parsed = parseCloudProvisionAssignments([
      assignment({
        projectId: 'p'.repeat(500),
        path: `/srv/${'d'.repeat(5000)}`,
        repoUrl: `https://git.test/${'x'.repeat(5000)}`,
        defaultBranch: 'b'.repeat(500)
      })
    ])
    expect(parsed[0].projectId.length).toBeLessThanOrEqual(128)
    expect(parsed[0].path.length).toBeLessThanOrEqual(4096)
    expect(parsed[0].repoUrl.length).toBeLessThanOrEqual(4096)
    expect(parsed[0].defaultBranch.length).toBeLessThanOrEqual(200)
  })
})

describe('isProvisionableCheckoutPath（平台 validateProjectPath 的宿主孪生）', () => {
  it('接受规范绝对路径：POSIX 与 Windows 两种分隔风格', () => {
    expect(isProvisionableCheckoutPath('/srv/orca-projects/payment-service')).toBe(true)
    expect(isProvisionableCheckoutPath('C:\\repos\\payment-service')).toBe(true)
    expect(isProvisionableCheckoutPath('C:/repos/payment-service')).toBe(true)
  })

  it('拒绝相对、穿越、空段、尾分隔符、混用反斜杠、控制字符', () => {
    expect(isProvisionableCheckoutPath('srv/payment-service')).toBe(false)
    expect(isProvisionableCheckoutPath('')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv/../etc')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv/./svc')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv//svc')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv/svc/')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv/svc\\other')).toBe(false)
    expect(isProvisionableCheckoutPath('/srv/svc\t')).toBe(false)
    expect(isProvisionableCheckoutPath('C:repos')).toBe(false)
    expect(isProvisionableCheckoutPath('C:\\repos\\svc\\')).toBe(false)
    // 与平台契约一致：文件系统根不是合法检出根。
    expect(isProvisionableCheckoutPath('/')).toBe(false)
  })
})

describe('createCloudProvisionAssignmentExecutor', () => {
  it('有指派即执行并回报 ok（克隆成功与 already-provisioned 幂等短路的两种结果）', async () => {
    const first = stubDeps()
    const executor = createCloudProvisionAssignmentExecutor(first.deps)
    executor(assignment())
    await settle()
    expect(first.roots).toEqual(['/srv/orca-projects/payment-service'])
    expect(first.reports).toEqual([{ projectId: 'proj_ab12cd34', ok: true }])

    const second = stubDeps({
      provision: async () => ({ ok: true, provisioned: false })
    })
    createCloudProvisionAssignmentExecutor(second.deps)(assignment({ projectId: 'proj_b' }))
    await settle()
    expect(second.reports).toEqual([{ projectId: 'proj_b', ok: true }])
  })

  it('重复指派去重：在途项目的第二次指派被忽略，结束后锁释放', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const { deps, reports } = stubDeps({
      provision: async () => {
        calls += 1
        await gate
        return { ok: true, provisioned: true }
      }
    })
    const executor = createCloudProvisionAssignmentExecutor(deps)
    const pending = assignment()
    executor(pending)
    executor(pending)
    executor(pending)
    await settle()
    expect(calls).toBe(1)

    release()
    await settle()
    expect(calls).toBe(1)
    expect(reports).toEqual([{ projectId: 'proj_ab12cd34', ok: true }])

    // 平台未翻转前每拍重发：结束后再次指派必须重新执行（幂等短路吸收）。
    executor(pending)
    await settle()
    expect(calls).toBe(2)
  })

  it('跨项目串行：第二个克隆等第一个结束后才开始', async () => {
    const trace: string[] = []
    const { deps } = stubDeps({
      provision: async (input) => {
        trace.push(`start:${input.projectRoot}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        trace.push(`end:${input.projectRoot}`)
        return { ok: true, provisioned: true }
      }
    })
    const executor = createCloudProvisionAssignmentExecutor(deps)
    executor(assignment({ projectId: 'proj_a', path: '/srv/a' }))
    executor(assignment({ projectId: 'proj_b', path: '/srv/b' }))
    await settle()
    expect(trace).toEqual(['start:/srv/a', 'end:/srv/a', 'start:/srv/b', 'end:/srv/b'])
  })

  it('防御校验拒绝：坏 path/url/branch 各回报对应失败码，且不触碰 runtime', async () => {
    const cases: { input: Partial<CloudProvisionAssignment>; code: string }[] = [
      { input: { path: 'srv/relative' }, code: 'PROVISION_FAILED' },
      { input: { path: '/srv/../etc' }, code: 'PROVISION_FAILED' },
      { input: { repoUrl: 'ext::sh -c calc' }, code: 'CLONE_URL_INVALID' },
      { input: { repoUrl: 'ftp://git.example.com/pay.git' }, code: 'CLONE_URL_INVALID' },
      { input: { defaultBranch: '-b' }, code: 'BRANCH_INVALID' },
      { input: { defaultBranch: '../escape' }, code: 'BRANCH_INVALID' }
    ]
    for (const item of cases) {
      const { deps, reports, roots } = stubDeps()
      createCloudProvisionAssignmentExecutor(deps)(assignment(item.input))
      await settle()
      expect(roots, JSON.stringify(item.input)).toEqual([])
      expect(reports, JSON.stringify(item.input)).toEqual([
        {
          projectId: 'proj_ab12cd34',
          ok: false,
          error: expect.stringContaining(item.code)
        }
      ])
    }
  })

  it('maintenance 宿主跳过：不执行也不回报，维护结束后恢复执行（§8①）', async () => {
    let maintenance = true
    const { deps, reports, roots } = stubDeps({ inMaintenance: () => maintenance })
    const executor = createCloudProvisionAssignmentExecutor(deps)
    executor(assignment())
    await settle()
    expect(roots).toEqual([])
    expect(reports).toEqual([])

    maintenance = false
    executor(assignment())
    await settle()
    expect(roots).toEqual(['/srv/orca-projects/payment-service'])
    expect(reports).toEqual([{ projectId: 'proj_ab12cd34', ok: true }])
  })

  it('runtime 未暴露 provision 面（provision 为 null）静默跳过，等下拍重发', async () => {
    const reports: CloudProvisionReport[] = []
    const executor = createCloudProvisionAssignmentExecutor({
      provision: null,
      report: (report) => reports.push(report)
    })
    expect(() => executor(assignment())).not.toThrow()
    await settle()
    expect(reports).toEqual([])
  })

  it('runtime_unavailable 静默跳过：不回报失败（failed 是粘性的）', async () => {
    const { deps, reports } = stubDeps({
      provision: async () => {
        throw new Error('runtime_unavailable')
      }
    })
    createCloudProvisionAssignmentExecutor(deps)(assignment())
    await settle()
    expect(reports).toEqual([])
  })

  it('执行器永不抛入心跳循环：克隆异常变成 PROVISION_FAILED 回报，后续指派照常执行', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { deps, reports } = stubDeps({
        provision: (input) => {
          if (input.projectRoot === '/srv/bad') {
            throw new Error('git clone failed: https://user:token@git.example.com/pay.git')
          }
          return Promise.resolve({ ok: true, provisioned: true })
        }
      })
      const executor = createCloudProvisionAssignmentExecutor(deps)
      expect(() => executor(assignment({ projectId: 'proj_bad', path: '/srv/bad' }))).not.toThrow()
      executor(assignment({ projectId: 'proj_good' }))
      await settle()
      expect(reports).toEqual([
        {
          projectId: 'proj_bad',
          ok: false,
          error: 'PROVISION_FAILED: 项目准备失败，请查看主机日志。'
        },
        { projectId: 'proj_good', ok: true }
      ])
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
