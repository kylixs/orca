import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { loadMobileHtmlOpenMode, saveMobileHtmlOpenMode } from '../storage/preferences'
import type { MobileHtmlOpenMode, MobileHtmlPreviewMode } from './mobile-html-open-mode'

/**
 * The list's HTML tap policy: a stored mode opens directly, `ask` raises the two-mode chooser, and
 * only the chooser (with its remember switch on) writes the preference.
 */
export function useMobileFileHtmlOpenMode(
  openPreview: (relativePath: string, name: string, mode?: MobileHtmlPreviewMode) => void
) {
  const [mode, setMode] = useState<MobileHtmlOpenMode>('ask')
  const [pending, setPending] = useState<{ relativePath: string; name: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Survives closeChooser: the deferred onSelect runs after the drawer has closed.
  const pendingTargetRef = useRef<{ relativePath: string; name: string } | null>(null)
  // A chooser choice owns the session; a preference read that started earlier must not undo it.
  const manualChoiceRef = useRef<MobileHtmlPreviewMode | null>(null)

  // Reloaded on focus so Browser settings' Ask applies to the next file tap.
  useFocusEffect(
    useCallback(() => {
      manualChoiceRef.current = null
      let active = true
      void loadMobileHtmlOpenMode().then((stored) => {
        if (active) {
          setMode(manualChoiceRef.current ?? stored)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  const previewFile = useCallback(
    (relativePath: string, name: string) => {
      if (classifyMobileArtifact(relativePath) !== 'html') {
        openPreview(relativePath, name)
        return
      }
      if (mode === 'ask') {
        pendingTargetRef.current = { relativePath, name }
        setPending({ relativePath, name })
        return
      }
      openPreview(relativePath, name, mode)
    },
    [mode, openPreview]
  )

  const selectMode = useCallback(
    (next: MobileHtmlPreviewMode, remember: boolean) => {
      const chosen = pendingTargetRef.current
      pendingTargetRef.current = null
      setPending(null)
      if (!chosen) {
        return
      }
      manualChoiceRef.current = next
      openPreview(chosen.relativePath, chosen.name, next)
      if (!remember) {
        return
      }
      void saveMobileHtmlOpenMode(next).then(
        () => setMode(next),
        () => setNotice('Could not save HTML open mode. Try again.')
      )
    },
    [openPreview]
  )

  return {
    previewFile,
    pending,
    selectMode,
    notice,
    dismissNotice: () => setNotice(null),
    closeChooser: () => setPending(null),
    dismissChooser: () => {
      pendingTargetRef.current = null
      setPending(null)
    }
  }
}
