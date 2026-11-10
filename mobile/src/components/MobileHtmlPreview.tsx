import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { Code, Eye } from 'lucide-react-native'
import { openExternalLink } from '../platform/external-link'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { htmlPreviewNavigationDecision } from './html-preview-scheme'
import {
  HTML_PREVIEW_INTERCEPTION_SCRIPT,
  isHtmlPreviewBlockedMessage
} from './html-preview-interception'
import type { MobileHtmlPreviewMode } from '../files/mobile-html-open-mode'

const BLOCKED_TOAST_MS = 2500

export type MobileHtmlPreviewFrameProps = {
  html: string
  mode: MobileHtmlPreviewMode
  onModeChange?: (mode: MobileHtmlPreviewMode) => void
  showToolbar?: boolean
  onExternalLink: (url: string) => void
  onBlockedScheme?: (url: string) => void
  /** Rendered by the caller when `mode` is `source`; the frame owns no source view of its own. */
  renderSource?: () => React.ReactNode
}

export type MobileHtmlPreviewProps = {
  html: string
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
}

/**
 * The phone's HTML frame: a WebView with JS enabled, no object bridge, one fixed-sentinel message
 * channel that can only raise the blocked-link toast, and a navigation policy that only lets a top
 * frame leave for http(s)/mailto. It holds no mode: the caller owns that.
 */
export function MobileHtmlPreviewFrame(props: MobileHtmlPreviewFrameProps) {
  const [blocked, setBlocked] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastVisible = useRef(false)

  const showBlockedToast = useCallback(() => {
    // Why: a page can post the sentinel in a loop; one toast per visible window is enough.
    if (toastVisible.current) {
      return
    }
    toastVisible.current = true
    setBlocked(true)
    toastTimer.current = setTimeout(() => {
      toastVisible.current = false
      setBlocked(false)
    }, BLOCKED_TOAST_MS)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) {
        clearTimeout(toastTimer.current)
      }
      toastVisible.current = false
    },
    []
  )

  const shouldStartLoad = (request: { url: string; isTopFrame?: boolean }): boolean => {
    // Android's WebViewClient supplies isTopFrame from WebResourceRequest.isForMainFrame(); the
    // legacy String overload (API < 24) is main-frame only, so a missing value keeps the top-frame
    // policy without ever turning a reported subframe into one.
    const decision = htmlPreviewNavigationDecision({
      url: request.url,
      isTopFrame: request.isTopFrame
    })
    if (decision === 'external') {
      props.onExternalLink(request.url)
    } else if (decision === 'block') {
      showBlockedToast()
      props.onBlockedScheme?.(request.url)
    }
    return decision === 'allow'
  }

  /**
   * The channel is fixed-sentinel only: anything that is not byte-for-byte the value is ignored, so
   * a message can neither reflect a URL nor open a link. Page script can post the sentinel itself
   * and forge the toast; that is the accepted boundary (design §9), not a host capability.
   */
  const onMessage = (event: WebViewMessageEvent): void => {
    if (isHtmlPreviewBlockedMessage(event.nativeEvent.data)) {
      showBlockedToast()
    }
  }

  return (
    <View style={styles.container}>
      {(props.showToolbar ?? true) ? (
        <HtmlPreviewModeToolbar mode={props.mode} onModeChange={props.onModeChange} />
      ) : null}
      {props.mode === 'preview' ? (
        <>
          <WebView
            style={styles.webview}
            originWhitelist={['*']}
            source={{ html: props.html }}
            javaScriptEnabled
            // Why: only the initial inline document and subframes render in place; a top-frame tap
            // is handed to the scheme policy and either leaves for an allowed host or is refused.
            onShouldStartLoadWithRequest={shouldStartLoad}
            // Why: Android executes a tapped javascript: link without consulting the navigation
            // callback, so the DOM fence has to exist before the first tap. The native patch turns
            // the before-content pass into a real document-start script, which is what makes the
            // window-capture listener earlier than every page script. On Android the before-content
            // pass (document-start) covers subframes; the post-load pass is main-frame only and is
            // the fallback for documents the document-start script did not reach. The script also
            // adopts same-origin document.write frames. The native layer drops subframe messages.
            injectedJavaScriptBeforeContentLoaded={HTML_PREVIEW_INTERCEPTION_SCRIPT}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
            injectedJavaScript={HTML_PREVIEW_INTERCEPTION_SCRIPT}
            injectedJavaScriptForMainFrameOnly={false}
            onMessage={onMessage}
            // Why: the prop is iOS-only. Passing false on Android claims a behaviour that does
            // not exist there; leave the platform default (selection on) alone.
            textInteractionEnabled={Platform.OS === 'ios' ? true : undefined}
          />
          {blocked ? (
            <View style={styles.toast} pointerEvents="none">
              {/* Why: accessibilityLiveRegion is Android-only, so iOS announces nothing here.
                  The in-frame toast is still visible; a native iOS announcement is future work. */}
              <Text style={styles.toastText} accessibilityLiveRegion="polite">
                This link type isn&apos;t supported in preview
              </Text>
            </View>
          ) : null}
        </>
      ) : (
        props.renderSource?.()
      )}
    </View>
  )
}

/** Session-file wrapper: the frame with its own mode state and the Preview/Source toolbar. */
export function MobileHtmlPreview({ html, renderSource }: MobileHtmlPreviewProps) {
  const [mode, setMode] = useState<MobileHtmlPreviewMode>('preview')
  return (
    <MobileHtmlPreviewFrame
      html={html}
      mode={mode}
      onModeChange={setMode}
      showToolbar
      onExternalLink={openExternalLink}
      renderSource={renderSource}
    />
  )
}

function HtmlPreviewModeToolbar(props: {
  mode: MobileHtmlPreviewMode
  onModeChange?: (mode: MobileHtmlPreviewMode) => void
}) {
  return (
    // A tab pair, not two buttons: which side is showing is carried by the active style, and a
    // style is announced to nobody.
    <View style={styles.toolbar} accessibilityRole="tablist">
      <Pressable
        style={[styles.toggle, props.mode === 'preview' && styles.toggleActive]}
        onPress={() => props.onModeChange?.('preview')}
        hitSlop={8}
        accessibilityRole="tab"
        // Both, because they reach different readers: `accessibilityState` is what the phone's
        // screen reader takes, and react-native-web drops it entirely -- measured, the DOM carries
        // no `aria-selected` without the line below.
        accessibilityState={{ selected: props.mode === 'preview' }}
        aria-selected={props.mode === 'preview'}
        accessibilityLabel="Preview rendered HTML"
      >
        <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.toggleText}>Preview</Text>
      </Pressable>
      <Pressable
        style={[styles.toggle, props.mode === 'source' && styles.toggleActive]}
        onPress={() => props.onModeChange?.('source')}
        hitSlop={8}
        accessibilityRole="tab"
        accessibilityState={{ selected: props.mode === 'source' }}
        aria-selected={props.mode === 'source'}
        accessibilityLabel="View HTML source"
      >
        <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.toggleText}>Source</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  toggleText: { color: colors.textSecondary, fontSize: typography.metaSize },
  webview: { flex: 1, backgroundColor: '#ffffff' },
  toast: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.xl,
    alignItems: 'center'
  },
  toastText: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
})
