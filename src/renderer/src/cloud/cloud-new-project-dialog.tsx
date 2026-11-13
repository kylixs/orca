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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { CloudBridge } from './use-cloud-session'

function hasSeparatorOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || character === '/' || character === '\\') {
      return true
    }
  }
  return false
}

/**
 * A directory is a single relative segment under the host's projects root
 * (FR-3.7): no separators, no `.`/`..`, no control characters.
 */
export function isValidProjectDirName(value: string): boolean {
  const dir = value.trim()
  return (
    dir !== '' && dir !== '.' && dir !== '..' && dir.length <= 200 && !hasSeparatorOrControl(dir)
  )
}

type DirMode = 'existing' | 'new'

/** Self-service creation: pick or name a directory; the repo URL is optional. */
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
  const [dirMode, setDirMode] = React.useState<DirMode>('existing')
  const [existingDir, setExistingDir] = React.useState('')
  const [newDir, setNewDir] = React.useState('')
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
    setDirMode('existing')
    setExistingDir('')
    setNewDir('')
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
          setDirMode(eligible[0].projectDirs.length > 0 ? 'existing' : 'new')
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
  const selectedHost = eligibleHosts.find((host) => host.id === hostId) ?? null
  const dir = dirMode === 'existing' ? existingDir : newDir.trim()
  const dirValid = dirMode === 'existing' ? existingDir !== '' : isValidProjectDirName(newDir)
  const canSubmit =
    !submitting &&
    hosts !== null &&
    eligibleHosts.length > 0 &&
    hostId !== '' &&
    name.trim() !== '' &&
    dirValid

  const pickHost = (nextId: string): void => {
    setHostId(nextId)
    setExistingDir('')
    // A host that reports no directories can only offer creating a new one.
    const next = eligibleHosts.find((host) => host.id === nextId)
    if (next && next.projectDirs.length === 0) {
      setDirMode('new')
    }
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await bridge.createProject({
        name: name.trim(),
        dir,
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
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
              '项目会落在所选主机的项目目录下；仓库地址可不填，宿主直接使用已有目录。'
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
            <Label htmlFor="cloud-project-host">
              {translate('auto.cloud.projectHost', '主机')}
            </Label>
            <Select value={hostId} onValueChange={pickHost} disabled={eligibleHosts.length === 0}>
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cloud-project-dir">{translate('auto.cloud.projectDir', '目录')}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={dirMode}
              onValueChange={(value) => {
                if (value === 'existing' || value === 'new') {
                  setDirMode(value)
                }
              }}
            >
              <ToggleGroupItem value="existing">
                {translate('auto.cloud.projectDirExisting', '选择已有目录')}
              </ToggleGroupItem>
              <ToggleGroupItem value="new">
                {translate('auto.cloud.projectDirNew', '新建目录')}
              </ToggleGroupItem>
            </ToggleGroup>
            {dirMode === 'existing' ? (
              <Select
                value={existingDir}
                onValueChange={setExistingDir}
                disabled={!selectedHost || selectedHost.projectDirs.length === 0}
              >
                <SelectTrigger id="cloud-project-dir">
                  <SelectValue
                    placeholder={translate('auto.cloud.projectDirPlaceholder', '选择主机上的目录')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(selectedHost?.projectDirs ?? []).map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="cloud-project-dir"
                value={newDir}
                onChange={(event) => setNewDir(event.target.value)}
                placeholder={translate('auto.cloud.projectDirNewPlaceholder', '如 payment-service')}
              />
            )}
            {dirMode === 'new' && newDir.trim() !== '' && !isValidProjectDirName(newDir) ? (
              <p className="text-xs text-destructive">
                {translate(
                  'auto.cloud.projectDirInvalid',
                  '目录名只能是单级名称，不能包含 / \\ 或 ..'
                )}
              </p>
            ) : null}
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
                '可选，留空时根据名称自动生成（小写字母/数字/._-）'
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
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.cloud.projectRepoOptional',
                '可选，填写后由宿主克隆；不填则直接使用目录。'
              )}
            </p>
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
