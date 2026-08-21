import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateDirectoryOptions,
  CreateFileOptions,
  ExportDocumentOptions,
  ExportDocumentResult,
  FileChangeEvent,
  HistorySnapshot,
  MarkdownDesktopAPI,
  MergeFileResult,
  RenameOptions,
  SaveAttachmentOptions,
  SaveFileOptions,
  SearchOptions,
  UpdateState,
} from '../src/shared/types'

const CHANNELS = {
  selectWorkspace: 'workspace:select',
  openWorkspace: 'workspace:open',
  getWorkspace: 'workspace:get',
  listFiles: 'workspace:list-files',
  listDirectories: 'workspace:list-directories',
  readFile: 'file:read',
  saveFile: 'file:save',
  listSnapshots: 'history:list-snapshots',
  restoreSnapshot: 'history:restore-snapshot',
  mergeFile: 'file:merge',
  saveAttachment: 'file:save-attachment',
  loadLocalImage: 'file:load-local-image',
  exportDocument: 'file:export-document',
  createFile: 'file:create',
  createDirectory: 'directory:create',
  rename: 'path:rename',
  trash: 'path:trash',
  search: 'search:full-text',
  listRecent: 'recent:list',
  removeRecent: 'recent:remove',
  openExternal: 'external:open',
  updateState: 'update:state',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  fileChanged: 'workspace:file-changed',
} as const

const api: MarkdownDesktopAPI = {
  selectWorkspace: () => ipcRenderer.invoke(CHANNELS.selectWorkspace),
  openWorkspace: (workspacePath) => ipcRenderer.invoke(CHANNELS.openWorkspace, workspacePath),
  getWorkspace: () => ipcRenderer.invoke(CHANNELS.getWorkspace),
  listMarkdownFiles: () => ipcRenderer.invoke(CHANNELS.listFiles),
  listDirectories: () => ipcRenderer.invoke(CHANNELS.listDirectories),
  readFile: (filePath) => ipcRenderer.invoke(CHANNELS.readFile, filePath),
  saveFile: (filePath, content, options?: SaveFileOptions) => ipcRenderer.invoke(CHANNELS.saveFile, filePath, content, options),
  listSnapshots: (filePath): Promise<HistorySnapshot[]> => ipcRenderer.invoke(CHANNELS.listSnapshots, filePath),
  restoreSnapshot: (filePath, snapshotId) => ipcRenderer.invoke(CHANNELS.restoreSnapshot, filePath, snapshotId),
  mergeFile: (filePath, baseContent, localContent): Promise<MergeFileResult> => ipcRenderer.invoke(CHANNELS.mergeFile, filePath, baseContent, localContent),
  saveAttachment: (options: SaveAttachmentOptions) => ipcRenderer.invoke(CHANNELS.saveAttachment, options),
  loadLocalImage: (markdownPath, reference) => ipcRenderer.invoke(CHANNELS.loadLocalImage, markdownPath, reference),
  exportDocument: (options: ExportDocumentOptions): Promise<ExportDocumentResult | null> => ipcRenderer.invoke(CHANNELS.exportDocument, options),
  createFile: (options: CreateFileOptions) => ipcRenderer.invoke(CHANNELS.createFile, options),
  createDirectory: (options: CreateDirectoryOptions) => ipcRenderer.invoke(CHANNELS.createDirectory, options),
  rename: (options: RenameOptions) => ipcRenderer.invoke(CHANNELS.rename, options),
  trash: (filePath) => ipcRenderer.invoke(CHANNELS.trash, filePath),
  search: (query, options?: SearchOptions) => ipcRenderer.invoke(CHANNELS.search, query, options),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateGetState),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateCheck),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateDownload),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(CHANNELS.updateInstall),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateState) => listener(payload)
    ipcRenderer.on(CHANNELS.updateState, handler)
    return () => ipcRenderer.removeListener(CHANNELS.updateState, handler)
  },
  listRecentWorkspaces: () => ipcRenderer.invoke(CHANNELS.listRecent),
  removeRecentWorkspace: (workspacePath) => ipcRenderer.invoke(CHANNELS.removeRecent, workspacePath),
  onFileChanged: (listener: (event: FileChangeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: FileChangeEvent) => listener(payload)
    ipcRenderer.on(CHANNELS.fileChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.fileChanged, handler)
  },
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
}

contextBridge.exposeInMainWorld('markdownDesktop', api)
