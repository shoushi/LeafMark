/**
 * Public contract between the renderer and the Electron preload bridge.
 *
 * The renderer only receives this deliberately small, typed surface.  Node
 * APIs and ipcRenderer are never exposed to the page.
 */

export type MarkdownFileExtension =
  | '.md'
  | '.markdown'
  | '.mdown'
  | '.mkdn'
  | '.mkd'
  | '.mdwn'

export interface WorkspaceInfo {
  /** Absolute path of the workspace root, as selected by the user. */
  path: string
  name: string
  lastOpenedAt?: number
}

export interface MarkdownFileInfo {
  /** Absolute path. All file-operation APIs require this to be in the active workspace. */
  path: string
  /** Path relative to the active workspace, using `/` separators. */
  relativePath: string
  name: string
  size: number
  modifiedAt: number
  isDirectory: false
}

export interface WorkspaceDirectoryInfo {
  /** Absolute path of a directory in the active workspace. */
  path: string
  /** Path relative to the active workspace, using `/` separators. The root has an empty value. */
  relativePath: string
  name: string
  isDirectory: true
}

export interface MarkdownDocument {
  path: string
  content: string
  /** UTF-8 is currently the only encoding written by the MVP. */
  encoding: 'utf8'
  hasBom: boolean
  newline: 'lf' | 'crlf' | 'mixed' | 'none'
  size: number
  modifiedAt: number
  /** SHA-256 of the bytes read from disk; pass it back to saveFile for conflict detection. */
  hash: string
}

export interface SaveFileOptions {
  /** Hash returned by readFile. Saving fails if the on-disk bytes changed since that read. */
  expectedHash?: string
  /** Optional mtime guard for callers that do not keep a hash. */
  expectedModifiedAt?: number
  hasBom?: boolean
}

export interface SavedFileResult {
  path: string
  size: number
  modifiedAt: number
  hash: string
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink'
  path: string
  relativePath: string
  isDirectory: boolean
  modifiedAt?: number
}

export interface SearchOptions {
  caseSensitive?: boolean
  maxResults?: number
}

export interface SearchResult {
  path: string
  relativePath: string
  line: number
  column: number
  preview: string
  matchCount: number
}

export interface CreateFileOptions {
  parentPath?: string
  name: string
  content?: string
}

export interface CreateDirectoryOptions {
  parentPath?: string
  name: string
}

export interface RenameOptions {
  path: string
  /** A new name in the same directory, or an absolute destination in the active workspace. */
  newName: string
}

export interface MarkdownDesktopAPI {
  /** Open the native directory picker and make the chosen directory active. */
  selectWorkspace(): Promise<WorkspaceInfo | null>
  /** Open a previously selected directory by absolute path. */
  openWorkspace(path: string): Promise<WorkspaceInfo>
  getWorkspace(): Promise<WorkspaceInfo | null>
  listMarkdownFiles(): Promise<MarkdownFileInfo[]>
  listDirectories(): Promise<WorkspaceDirectoryInfo[]>
  readFile(path: string): Promise<MarkdownDocument>
  saveFile(path: string, content: string, options?: SaveFileOptions): Promise<SavedFileResult>
  createFile(options: CreateFileOptions): Promise<MarkdownFileInfo>
  createDirectory(options: CreateDirectoryOptions): Promise<{ path: string; name: string }>
  rename(options: RenameOptions): Promise<{ path: string; name: string; isDirectory: boolean }>
  trash(path: string): Promise<void>
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  listRecentWorkspaces(): Promise<WorkspaceInfo[]>
  removeRecentWorkspace(path: string): Promise<void>
  onFileChanged(listener: (event: FileChangeEvent) => void): () => void
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    markdownDesktop: MarkdownDesktopAPI
  }
}
