import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { htmlPreviewWithInertLinks } from './html-preview-inert-links'
import { useHtmlPreviewLinkGrant } from './use-html-preview-link-grant'
import { openExternalLink } from '../platform/external-link'
import type { MobileHtmlPreviewMode } from '../files/mobile-html-open-mode'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MobileHtmlPreviewFrameProps, MobileHtmlPreviewProps } from './MobileHtmlPreview'

/**
 * The `sandbox` the preview frame carries, and the whole of what makes it safe to render an
 * agent-produced artifact inside the page's own document.
 *
 * No `allow-scripts`: a script in the artifact does not run. No `allow-same-origin`: the frame is an
 * opaque origin, so it reaches no storage, no cookie and nothing the page holds — and it is not
 * same-origin with the document the shell injects its bridge object into, which Chromium places in
 * every same-origin frame. The shell refuses a non-main-frame bridge message by rule as well, so
 * that fence is two deep.
 *
 * `allow-top-navigation-by-user-activation` is the one capability granted, and it is what keeps a
 * link in the artifact working (ruling 29): a tap becomes a top-frame navigation the shell's
 * navigation policy cancels and hands to its external-link opener.
 */
export const MOBILE_HTML_PREVIEW_SANDBOX = 'allow-top-navigation-by-user-activation'

/**
 * The same frame against a shell that cannot open what a tap would aim at.
 *
 * The token buys nothing there: the shell cancels the navigation and drops it, so a tap would do
 * nothing and the page would be offering an affordance it cannot honour. Dropping it is the second
 * of the two fences the inert-link pass sets -- see `html-preview-inert-links.ts` for why neither
 * stands in for the other. Everything else about the frame is unchanged, opaque origin and all.
 */
export const MOBILE_HTML_PREVIEW_SEALED_SANDBOX = ''

/**
 * Web sibling: the artifact rendered in a sealed frame, with the native component's Preview/Source
 * toggle intact.
 *
 * `srcdoc` rather than a `blob:` URL, measured: `srcdoc` is admitted under the policy the shell
 * already ships, because a `srcdoc` frame has no URL to match and inherits its embedder's policy
 * instead, while a `blob:` frame is refused by `frame-src 'none'` on both engines. The inherited
 * policy then governs everything the artifact tries to fetch, exactly as it did before.
 */
export function MobileHtmlPreviewFrame(props: MobileHtmlPreviewFrameProps) {
  // The shell's answer for this session, asked once: the page mounts after `init` and a session's
  // grants do not change for the life of the document.
  const linksOpen = useHtmlPreviewLinkGrant()
  // Only the path that rewrites pays for a parse, and only when the artifact changes.
  const rendered = useMemo(
    () => (linksOpen ? props.html : htmlPreviewWithInertLinks(props.html)),
    [linksOpen, props.html]
  )

  return (
    <View style={styles.container}>
      {(props.showToolbar ?? true) ? (
        <HtmlPreviewModeToolbar mode={props.mode} onModeChange={props.onModeChange} />
      ) : null}
      {/* The Source tab shows what the author wrote, never the rewrite: the rewrite is a rendering
          decision about this shell, and a reader who flipped to Source to read the markup would
          otherwise be shown markup that was never in the artifact. */}
      {props.mode === 'preview' ? (
        <PreviewFrame html={rendered} linksOpen={linksOpen} />
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

/**
 * The frame, as a DOM element react-native-web passes through untouched.
 *
 * Written as an `iframe` rather than through a react-native primitive because there is no primitive
 * for it, and `srcdoc` is set as an attribute so React never has to be told the content is trusted:
 * the browser parses it inside a frame that can run nothing.
 */
function PreviewFrame({ html, linksOpen }: { html: string; linksOpen: boolean }) {
  return (
    <View style={styles.frame}>
      <iframe
        title="HTML preview"
        sandbox={linksOpen ? MOBILE_HTML_PREVIEW_SANDBOX : MOBILE_HTML_PREVIEW_SEALED_SANDBOX}
        srcDoc={html}
        style={IFRAME_STYLE}
        // The artifact is untrusted, so nothing it navigates to may learn where it came from or
        // reach back through `window.opener`.
        referrerPolicy="no-referrer"
      />
    </View>
  )
}

/** A DOM style, not a `StyleSheet` entry: this element is an `iframe` and not a react-native view. */
const IFRAME_STYLE = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: '#ffffff'
} as const

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
  frame: { flex: 1, backgroundColor: '#ffffff' }
})
