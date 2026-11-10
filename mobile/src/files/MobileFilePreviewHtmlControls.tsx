import { Text, View } from 'react-native'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { MobileFileHtmlModeToolbar } from './MobileFileHtmlModeToolbar'
import { MobileFileOpenModeSheet } from './MobileFileOpenModeSheet'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'

/** Everything HTML-specific around the body: the one mode toolbar, its banners and the chooser. */
export function MobileFilePreviewHtmlControls(props: {
  htmlFile: boolean
  sourceOnly: boolean
  readFailed: boolean
  mode: MobileHtmlPreviewMode
  truncated: boolean
  notice: string | null
  fileLabel: string
  sheetVisible: boolean
  onChangeMode: (mode: MobileHtmlPreviewMode) => void
  onSelectMode: (mode: MobileHtmlPreviewMode, remember: boolean) => void
  onDismissNotice: () => void
  onCloseSheet: () => void
}) {
  const showModeControls = props.htmlFile && !props.sourceOnly && !props.readFailed
  return (
    <>
      {props.notice ? (
        <HostRouteNoticeBanner
          message={props.notice}
          tone="failure"
          onDismiss={props.onDismissNotice}
        />
      ) : null}
      {showModeControls ? (
        <MobileFileHtmlModeToolbar
          mode={props.mode}
          previewDisabled={props.truncated}
          onChange={props.onChangeMode}
        />
      ) : null}
      {props.truncated ? (
        <View style={styles.htmlTruncatedBanner}>
          <Text style={styles.htmlTruncatedBannerText} accessibilityLiveRegion="polite">
            File is larger than 512 KB. Rendering is unavailable; open the source or use desktop
            Orca.
          </Text>
        </View>
      ) : null}
      <MobileFileOpenModeSheet
        visible={props.sheetVisible}
        fileLabel={props.fileLabel}
        previewDisabled={props.truncated}
        onSelect={props.onSelectMode}
        onClose={props.onCloseSheet}
      />
    </>
  )
}
