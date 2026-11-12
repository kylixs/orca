/**
 * Which parameters of each file RPC carry a project-relative path.
 *
 * The earlier version guessed from a `…relativePath` suffix. That silently
 * skipped every field spelled differently — `relativePaths` (batch existence
 * checks), `entryRelativePath`, `implicitRootRelativePath` — so those calls ran
 * with **no path check at all**, and it also passed absolute-path methods
 * (`files.browseServerDir`, the terminal-artifact pair) whose path never gets
 * compared to the project root.
 *
 * So the table is explicit and the default is refusal: a file method missing
 * from it is not "pathless", it is unverifiable.
 */

export type CloudFilePaths = {
  singular: readonly string[]
  plural: readonly string[]
}

const SINGLE = (name: string): CloudFilePaths => ({ singular: [name], plural: [] })

export const CLOUD_FILE_PATH_PARAMS: Readonly<Record<string, CloudFilePaths>> = {
  // Candidate paths are listed, so they are read addresses like any other.
  'files.listAll': { singular: [], plural: ['candidatePaths'] },
  'files.read': SINGLE('relativePath'),
  'files.readDir': SINGLE('relativePath'),
  'files.readChunk': SINGLE('relativePath'),
  'files.stat': SINGLE('relativePath'),
  'files.readPreview': SINGLE('relativePath'),
  'files.open': SINGLE('relativePath'),
  'files.openDiff': SINGLE('relativePath'),
  'files.readDocPreview': {
    // The preview resolves its own root relative to the file it was opened from.
    singular: ['relativePath', 'entryRelativePath', 'implicitRootRelativePath'],
    plural: ['authorizedRootRelativePaths']
  },
  'files.pathsExist': { singular: [], plural: ['relativePaths'] },
  'files.searchPaths': { singular: [], plural: ['excludePaths'] },
  'files.write': SINGLE('relativePath'),
  'files.writeBase64': SINGLE('relativePath'),
  'files.createFile': SINGLE('relativePath'),
  'files.createDir': SINGLE('relativePath'),
  'files.createDirNoClobber': SINGLE('relativePath'),
  'files.delete': SINGLE('relativePath'),
  'files.rename': { singular: ['oldRelativePath', 'newRelativePath'], plural: [] },
  'files.copy': { singular: ['sourceRelativePath', 'destinationRelativePath'], plural: [] },
  'files.commitUpload': { singular: ['tempRelativePath', 'finalRelativePath'], plural: [] }
}

/**
 * Methods whose only address is an absolute path (`files.browseServerDir`,
 * terminal artifacts). Project-relative checking cannot bound them, so they are
 * refused rather than allowed unchecked. `files.resolveTerminalPath` resolves a
 * terminal's cwd, which is outside the project whenever the shell cd'd out.
 */
export const CLOUD_FILE_UNBOUNDED_METHODS: ReadonlySet<string> = new Set([
  'files.browseServerDir',
  'files.readTerminalArtifact',
  'files.readTerminalArtifactPreview',
  'files.writeTerminalArtifact',
  'files.resolveTerminalPath'
])

/** Methods that address a worktree only (no per-file path). */
export const CLOUD_FILE_WORKTREE_ONLY_METHODS: ReadonlySet<string> = new Set([
  'files.list',
  'files.listMarkdownDocuments',
  // `files.search` patterns are globs, not paths; nothing resolves a path here.
  'files.search',
  'files.watch',
  'files.unwatch'
])
