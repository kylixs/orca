import { useMemo } from 'react'
import { MobileFileMediaPreview } from './MobileFileMediaPreview'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import { MobileFilePreviewEditableSource } from './MobileFilePreviewEditableSource'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { MobileHtmlPreviewFrame } from '../components/MobileHtmlPreview'
import { openExternalLink } from '../platform/external-link'
import { findRelativeHtmlAssetRefs, relativeHtmlAssetWarning } from './html-relative-assets'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'

type Props = {
  preview: MobileFilePreviewResult
  client?: MobileFilePreviewRpcSender | null
  relativePath: string
  title: string
  editable: boolean
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
  imageWidth: number
  imageHeight: number
  htmlMode?: MobileHtmlPreviewMode
  /** False once the read is truncated, so Preview cannot mount the frame. */
  htmlRenderable?: boolean
  /** Terminal artifacts are source-only even when they look like HTML. */
  sourceOnly?: boolean
  truncatedNote?: string
  onDraftChange: (content: string) => void
  onImageError: () => void
  /** Null where the only retry is a re-dial this document cannot make. */
  onRetry: (() => void) | null
}

export function MobileFilePreviewBody({ preview, ...options }: Props) {
  if (preview.status === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.stateText}>{preview.message}</Text>
      </View>
    )
  }
  if (preview.status === 'error' || preview.status === 'waiting') {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>{preview.message}</Text>
        {options.onRetry ? (
          <Pressable style={styles.retryButton} onPress={options.onRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }
  if (preview.status === 'empty') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <View style={styles.state}>
        <Text style={styles.stateText}>Empty file</Text>
      </View>
    )
  }
  if (preview.kind === 'media') {
    return (
      <MobileFileMediaPreview
        media={preview.media}
        client={options.client ?? null}
        title={options.title}
      />
    )
  }
  if (preview.kind === 'image') {
    return (
      <View style={styles.imageContainer}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.imageScrollContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri: preview.dataUri }}
            style={[styles.image, { width: options.imageWidth, height: options.imageHeight }]}
            resizeMode="contain"
            onError={options.onImageError}
            accessibilityLabel={`${options.title} image`}
          />
        </ScrollView>
      </View>
    )
  }
  if (preview.kind === 'markdown') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <MobileFileMarkdownPreview
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
      />
    )
  }
  if (preview.kind === 'html') {
    if (options.editable) {
      return <EditablePreviewSource {...options} />
    }
    const renderable = options.htmlRenderable ?? !preview.truncated
    if (!options.sourceOnly && renderable && options.htmlMode === 'preview') {
      return <HtmlRenderedPreview content={preview.content} />
    }
    return (
      <MobileFilePreviewSourceText
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        truncatedNote={options.truncatedNote}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
      />
    )
  }
  if (options.editable) {
    return <EditablePreviewSource {...options} />
  }
  const htmlFile = classifyMobileArtifact(options.relativePath) === 'html'
  return (
    <MobileFilePreviewSourceText
      relativePath={options.relativePath}
      content={preview.content}
      truncated={preview.truncated}
      truncatedNote={htmlFile ? options.truncatedNote : undefined}
      byteLength={preview.byteLength}
      initialLine={options.lineColumn?.line}
    />
  )
}

function HtmlRenderedPreview({ content }: { content: string }) {
  const warning = useMemo(() => {
    const refs = findRelativeHtmlAssetRefs(content)
    return relativeHtmlAssetWarning(refs)
  }, [content])
  return (
    <View style={styles.htmlPreviewContainer}>
      {warning ? (
        <View style={styles.htmlAssetWarning}>
          <Text style={styles.htmlAssetWarningText}>{warning}</Text>
        </View>
      ) : null}
      <MobileHtmlPreviewFrame
        html={content}
        mode="preview"
        showToolbar={false}
        onExternalLink={(url) => openExternalLink(url)}
      />
    </View>
  )
}

function EditablePreviewSource(options: {
  title: string
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
  onDraftChange: (content: string) => void
}) {
  return (
    <MobileFilePreviewEditableSource
      title={options.title}
      draftContent={options.draftContent}
      saveError={options.saveError}
      lineColumn={options.lineColumn}
      onDraftChange={options.onDraftChange}
    />
  )
}
