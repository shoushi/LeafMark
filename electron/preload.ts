import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateDirectoryOptions,
  CreateFileOptions,
  FileChangeEvent,
  MarkdownDesktopAPI,
  RenameOptions,
  SaveFileOptions,
  SearchOptions,
} from '../src/shared/types'

const CHANNELS = {
  selectWorkspace: 'workspace:select',
  openWorkspace: 'workspace:open',
  getWorkspace: 'workspace:get',
  listFiles: 'workspace:list-files',
  listDirectories: 'workspace:list-directories',
  readFile: 'file:read',
  saveFile: 'file:save',
  createFile: 'file:create',
  createDirectory: 'directory:create',
  rename: 'path:rename',
  trash: 'path:trash',
  search: 'search:full-text',
  listRecent: 'recent:list',
  removeRecent: 'recent:remove',
  openExternal: 'external:open',
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
  createFile: (options: CreateFileOptions) => ipcRenderer.invoke(CHANNELS.createFile, options),
  createDirectory: (options: CreateDirectoryOptions) => ipcRenderer.invoke(CHANNELS.createDirectory, options),
  rename: (options: RenameOptions) => ipcRenderer.invoke(CHANNELS.rename, options),
  trash: (filePath) => ipcRenderer.invoke(CHANNELS.trash, filePath),
  search: (query, options?: SearchOptions) => ipcRenderer.invoke(CHANNELS.search, query, options),
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
