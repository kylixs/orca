import * as React from 'react'
import { toast } from 'sonner'
import { errorCodeOf } from '../../../shared/json-fields'
import type {
  CloudCreateProjectResult,
  CloudProvisionableHost
} from '../../../shared/cloud-platform-ipc'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { CloudBridge } from './use-cloud-session'

/** Minimal self-service creation form; the platform derives the host path from `key`. */
export function CloudNewProjectDialog({
  bridge,
  open,
  onOpenChange,
  onCreated
}: {
  bridge: CloudBridge
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Takes the whole reply: a failure that still carries `projectId` means the
   * platform created the project, so the entry surfaces it in the retry banner.
   */
  onCreated: (result: CloudCreateProjectResult) => Promise<void> | void
}): React.JSX.Element {
  const [name, setName] = React.useState('')
  const [key, setKey] = React.useState('')
  const [repoUrl, setRepoUrl] = React.useState('')
  const [branch, setBranch] = React.useState('main')
  const [hosts, setHosts] = React.useState<CloudProvisionableHost[] | null>(null)
  const [hostId, setHostId] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setName('')
    setKey('')
    setRepoUrl('')
    setBranch('main')
    setHostId('')
    setHosts(null)
    setError(null)
    void bridge
      .listProvisionableHosts()
      .then((list) => {
        if (cancelled) {
          return
        }
        setHosts(list)
        const eligible = list.filter((host) => host.provisionable)
        // Why: with one eligible host there is nothing to choose; multiple hosts
        // stay unselected so the user sees which machine receives the project.
        if (eligible.length === 1) {
          setHostId(eligible[0].id)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHosts([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [bridge, open])

  const eligibleHosts = (hosts ?? []).filter((host) => host.provisionable)
  const canSubmit =
    !submitting &&
    hosts !== null &&
    eligibleHosts.length > 0 &&
    hostId !== '' &&
    name.trim() !== '' &&
    repoUrl.trim() !== ''

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await bridge.createProject({
        name: name.trim(),
        ...(key.trim() ? { key: key.trim() } : {}),
        repoUrl: repoUrl.trim(),
        defaultBranch: branch.trim() || 'main',
        hostId
      })
      if (!result.ok) {
        if (result.projectId && result.project) {
          await onCreated(result)
          onOpenChange(false)
          return
        }
        setError(result.message ? `${result.code}：${result.message}` : result.code)
        return
      }
      await onCreated(result)
      toast.success(translate('auto.cloud.projectCreated', '云端项目已创建'), {
        description: result.environment.projectName
      })
      onOpenChange(false)
    } catch (cause) {
      setError(errorCodeOf(cause) ?? (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{translate('auto.cloud.newProject', '新建云端项目')}</DialogTitle>
          <DialogDescription>
            {translate(
              'auto.cloud.newProjectHint',
              '项目会创建在所选主机的项目目录下，随后自动准备并打开。'
            )}
          </DialogDescription>
        </DialogHeader>
        {/* No <form>: a form makes Radix render a hidden native select whose
            unmatched value fires onValueChange('') before the options mount. */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-name">
              {translate('auto.cloud.projectName', '名称')}
            </Label>
            <Input
              id="cloud-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-key">
              {translate('auto.cloud.projectKey', '项目 Key')}
            </Label>
            <Input
              id="cloud-project-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={translate(
                'auto.cloud.projectKeyPlaceholder',
                '留空时根据名称自动生成（小写字母/数字/._-）'
              )}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-repo">
              {translate('auto.cloud.projectRepoUrl', '仓库地址')}
            </Label>
            <Input
              id="cloud-project-repo"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="https://… / git@… / /absolute/path"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-branch">
              {translate('auto.cloud.projectBranch', '默认分支')}
            </Label>
            <Input
              id="cloud-project-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-host">
              {translate('auto.cloud.projectHost', '主机')}
            </Label>
            <Select value={hostId} onValueChange={setHostId} disabled={eligibleHosts.length === 0}>
              <SelectTrigger id="cloud-project-host">
                <SelectValue
                  placeholder={translate('auto.cloud.projectHostPlaceholder', '选择主机')}
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleHosts.map((host) => (
                  <SelectItem key={host.id} value={host.id}>
                    {host.online
                      ? host.name
                      : translate('auto.cloud.hostOffline', '{{name}}（离线）', {
                          name: host.name
                        })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hosts !== null && eligibleHosts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.cloud.noProjectHost',
                  '当前没有可创建项目的主机，请联系管理员配置 ORCA_CLOUD_PROJECTS_ROOT。'
                )}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {translate('auto.cloud.cancel', '取消')}
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
              {submitting
                ? translate('auto.cloud.creating', '正在创建…')
                : translate('auto.cloud.create', '创建')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
