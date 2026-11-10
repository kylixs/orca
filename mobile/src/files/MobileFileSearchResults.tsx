import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { FileExplorerRow, TreeNode } from './file-tree'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT } from '../../../src/shared/runtime-file-contracts'
import type { MobileFileCategory } from './file-category'
import {
  FILE_SEARCH_RESULT_LIMIT,
  LEGACY_FILE_LIST_LIMIT,
  type MobileFileSearchState,
  type useMobileFileSearch
} from './use-mobile-file-search'

export function MobileFileSearchResults(props: {
  status: ReturnType<typeof useMobileFileSearch>['status']
  error: string | null
  rows: TreeNode[]
  note: string | null
  onRetry: () => void
  renderItem: ListRenderItem<FileExplorerRow>
}) {
  if (props.status === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.stateText}>Searching files...</Text>
      </View>
    )
  }
  if (props.status === 'offline') {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>{props.error ?? 'Offline'}</Text>
        <Pressable style={styles.retryButton} onPress={props.onRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }
  if (props.status === 'error') {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>{props.error}</Text>
        <Pressable style={styles.retryButton} onPress={props.onRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }
  if (props.rows.length === 0) {
    return (
      <View style={styles.state}>
        <Text style={styles.emptyText}>No matching files</Text>
        {/* A filter can empty a capped result set; the cap note still applies to it. */}
        {props.note ? <Text style={styles.searchNote}>{props.note}</Text> : null}
      </View>
    )
  }
  return (
    <FlatList
      data={props.rows}
      renderItem={props.renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
      ListHeaderComponent={props.note ? <Text style={styles.searchNote}>{props.note}</Text> : null}
    />
  )
}

type MobileFileSearchNoteInput = Pick<
  MobileFileSearchState,
  'status' | 'legacyFallback' | 'libraryTruncated' | 'totalCount' | 'results'
>

/** The header copy that keeps a capped result from reading as the whole library. */
export function mobileFileSearchNote(
  search: MobileFileSearchNoteInput,
  category: MobileFileCategory,
  filteredCount: number
): string | null {
  if (search.status !== 'ready') {
    return null
  }
  const fetched = search.results.length
  if (search.legacyFallback) {
    const cappedMatches =
      search.totalCount > fetched
        ? `; showing first ${fetched} of ${search.totalCount} matches`
        : ''
    if (search.libraryTruncated) {
      return `Showing first ${LEGACY_FILE_LIST_LIMIT}${cappedMatches}; results may be incomplete`
    }
    if (search.totalCount > fetched) {
      return `Showing first ${fetched} of ${search.totalCount} matches`
    }
    return `Showing ${filteredCount} of ${search.totalCount} matches`
  }
  const first =
    search.totalCount > fetched
      ? `Showing first ${fetched} of ${search.totalCount} matches`
      : `${filteredCount} match${filteredCount === 1 ? '' : 'es'}`
  const capped =
    category !== 'all' && search.totalCount > fetched
      ? ` Filters apply to these first ${FILE_SEARCH_RESULT_LIMIT} results only.`
      : ''
  const tooLarge = search.libraryTruncated
    ? ` File library exceeds ${MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT.toLocaleString('en-US')} files; results may be incomplete.`
    : ''
  return `${first}${capped}${tooLarge}`
}
