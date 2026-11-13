import { useState } from 'react'
import { Cloud, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorCodeOf } from '../../../shared/json-fields'
import { connectCloudProject, WEB_CLOUD_CONNECT_ERROR_CODE } from './web-cloud-connect'
import { createLocalStorageWebCloudDeviceKey } from './web-cloud-device-key'
import { adoptWebRuntimeClient } from './preload-api/web-runtime-session'
import {
  saveStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { translate } from '@/i18n/i18n'

type WebConnectCloudFormProps = {
  existingEnvironment: StoredWebRuntimeEnvironment | null
  onConnected: () => void
}

type CloudError = { code: string; message: string }

function defaultCloudApiUrl(): string {
  return String(import.meta.env.VITE_ORCA_CLOUD_API_URL ?? '').trim()
}

export default function WebConnectCloudForm({
  existingEnvironment,
  onConnected
}: WebConnectCloudFormProps): React.JSX.Element {
  const [apiUrl, setApiUrl] = useState(defaultCloudApiUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [deviceName, setDeviceName] = useState('Orca Web')
  const [error, setError] = useState<CloudError | null>(null)
  const [connecting, setConnecting] = useState(false)

  const submit = async (): Promise<void> => {
    setError(null)
    if (!apiUrl.trim() || !username.trim() || !password) {
      setError({
        code: WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed,
        message: 'Enter the platform address, username and password.'
      })
      return
    }
    setConnecting(true)
    try {
      const connection = await connectCloudProject({
        apiUrl: apiUrl.trim(),
        username: username.trim(),
        password,
        deviceName: deviceName.trim() || 'Orca Web',
        deviceKeyStore: createLocalStorageWebCloudDeviceKey(),
        previousEnvironment: existingEnvironment
      })
      try {
        // Why persist before mounting: the App's preload layer reads this record.
        saveStoredWebRuntimeEnvironment(connection.environment)
      } catch (err) {
        connection.client.close()
        throw err
      }
      // Why adopt: the ticket was consumed by the validation probe, so the App
      // must use this exact live socket instead of upgrading the stored offer again.
      adoptWebRuntimeClient(connection.client, connection.environment)
      onConnected()
    } catch (err) {
      setError({
        code: errorCodeOf(err) ?? WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed,
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setConnecting(false)
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="web-cloud-api-url">
          {translate('auto.web.WebConnect.cloudApiUrl', 'Platform address')}
        </Label>
        <Input
          id="web-cloud-api-url"
          value={apiUrl}
          onChange={(event) => setApiUrl(event.target.value)}
          placeholder="https://cloud.example.com"
          autoComplete="url"
          spellCheck={false}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="web-cloud-username">
          {translate('auto.web.WebConnect.cloudUsername', 'Username')}
        </Label>
        <Input
          id="web-cloud-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          spellCheck={false}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="web-cloud-password">
          {translate('auto.web.WebConnect.cloudPassword', 'Password')}
        </Label>
        <Input
          id="web-cloud-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="web-cloud-device-name">
          {translate('auto.web.WebConnect.cloudDeviceName', 'Device name')}
        </Label>
        <Input
          id="web-cloud-device-name"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.web.WebConnect.cloudDeviceNameHint',
            'Shown in the platform device list. Signing in enrols this browser on first use.'
          )}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="font-mono text-xs">{error.code}</span>
          <p className="mt-1">{error.message}</p>
        </div>
      )}

      <Button type="submit" disabled={connecting}>
        {connecting ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <Cloud size={15} aria-hidden />
        )}
        {connecting
          ? translate('auto.web.WebConnect.signingIn', 'Signing in…')
          : translate('auto.web.WebConnect.cloudConnect', 'Sign in and connect')}
      </Button>
    </form>
  )
}
