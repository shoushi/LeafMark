import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from 'electron'
import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  CreateDirectoryOptions,
  CreateFileOptions,
  FileChangeEvent,
  MarkdownDocument,
  MarkdownFileInfo,
  RenameOptions,
  SaveFileOptions,
  SavedFileResult,
  SearchOptions,
  SearchResult,
  WorkspaceDirectoryInfo,
  WorkspaceInfo,
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

const MARKDOWN_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdown',
  '.mkdn',
  '.mkd',
  '.mdwn',
])
const suppressedWatchPaths = new Map<string, number>()

function watchKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])
const RECENT_LIMIT = 10

let mainWindow: BrowserWindow | null = null
let currentWorkspace: WorkspaceInfo | null = null
let nativeWatcher: FSWatcher | null = null
const fallbackWatchers = new Map<string, FSWatcher>()
let watcherGeneration = 0

function markdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function relativePath(filePath: string): string {
  if (!currentWorkspace) return path.basename(filePath)
  return path.relative(currentWorkspace.path, filePath).split(path.sep).join('/')
}

function assertInside(filePath: string, allowRoot = false): string {
  if (!currentWorkspace) throw new Error('No workspace is open')
  const resolved = path.resolve(filePath)
  const rel = path.relative(currentWorkspace.path, resolved)
  if ((!allowRoot && !rel) || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Path must be inside the open workspace')
  }
  return resolved
}

async function assertExisting(filePath: string, allowRoot = false): Promise<string> {
  const resolved = assertInside(filePath, allowRoot)
  const real = await fs.realpath(resolved)
  // Check the resolved symlink target as well as the lexical path.
  assertInside(real, allowRoot)
  return resolved
}

async function assertNew(filePath: string): Promise<string> {
  const resolved = assertInside(filePath)
  const parent = await fs.realpath(path.dirname(resolved))
  assertInside(parent, true)
  return resolved
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function newlineKind(content: string): MarkdownDocument['newline'] {
  const hasCrlf = content.includes('\r\n')
  const hasLf = content.replace(/\r\n/g, '').includes('\n')
  if (hasCrlf && hasLf) return 'mixed'
  if (hasCrlf) return 'crlf'
  if (hasLf) return 'lf'
  return 'none'
}

async function fileInfo(filePath: string): Promise<MarkdownFileInfo> {
  const stat = await fs.stat(filePath)
  return {
    path: filePath,
    relativePath: relativePath(filePath),
    name: path.basename(filePath),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    isDirectory: false,
  }
}

async function listMarkdownFiles(): Promise<MarkdownFileInfo[]> {
  if (!currentWorkspace) return []
  const result: MarkdownFileInfo[] = []
  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && markdownPath(child)) {
        try { result.push(await fileInfo(child)) } catch { /* file disappeared */ }
      }
    }
  }
  await walk(currentWorkspace.path)
  return result
}

async function directoryInfo(directoryPath: string): Promise<WorkspaceDirectoryInfo> {
  return {
    path: directoryPath,
    relativePath: relativePath(directoryPath),
    name: path.basename(directoryPath) || directoryPath,
    isDirectory: true,
  }
}

async function listDirectories(): Promise<WorkspaceDirectoryInfo[]> {
  if (!currentWorkspace) return []
  const result: WorkspaceDirectoryInfo[] = [await directoryInfo(currentWorkspace.path)]
  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue
      const child = path.join(directory, entry.name)
      try {
        result.push(await directoryInfo(child))
        await walk(child)
      } catch {
        // A directory may disappear while the workspace is being scanned.
      }
    }
  }
  await walk(currentWorkspace.path)
  return result
}

async function readMarkdownFile(filePath: string): Promise<MarkdownDocument> {
  const resolved = await assertExisting(filePath)
  const stat = await fs.stat(resolved)
  if (!stat.isFile()) throw new Error('Only files can be read')
  const bytes = await fs.readFile(resolved)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const content = bytes.toString('utf8', hasBom ? 3 : 0)
  return {
    path: resolved,
    content,
    encoding: 'utf8',
    hasBom,
    newline: newlineKind(content),
    size: bytes.length,
    modifiedAt: stat.mtimeMs,
    hash: hashBytes(bytes),
  }
}

async function atomicSave(filePath: string, content: string, options: SaveFileOptions = {}): Promise<SavedFileResult> {
  const resolved = await assertExisting(filePath)
  const existing = await fs.readFile(resolved)
  const stat = await fs.stat(resolved)
  const currentHash = hashBytes(existing)
  if (options.expectedHash && options.expectedHash !== currentHash) {
    const error = new Error('The file changed on disk since it was opened')
    error.name = 'ExternalFileChangedError'
    throw error
  }
  if (options.expectedModifiedAt !== undefined && Math.abs(options.expectedModifiedAt - stat.mtimeMs) > 1) {
    const error = new Error('The file changed on disk since it was opened')
    error.name = 'ExternalFileChangedError'
    throw error
  }
  const body = Buffer.from(`${options.hasBom ? '\ufeff' : ''}${content}`, 'utf8')
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`
  suppressedWatchPaths.set(watchKey(resolved), Date.now() + 1_500)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', stat.mode & 0o777)
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await fs.rename(temporary, resolved)
    } catch (error) {
      // Windows does not replace an existing file with rename(). Keep the
      // same-directory temp-file path and use the safest available fallback.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
      await fs.rm(resolved, { force: true })
      await fs.rename(temporary, resolved)
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  const savedStat = await fs.stat(resolved)
  const savedBytes = await fs.readFile(resolved)
  return { path: resolved, size: savedBytes.length, modifiedAt: savedStat.mtimeMs, hash: hashBytes(savedBytes) }
}

function childName(name: string): string {
  const value = String(name || '').trim()
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('A simple child name is required')
  }
  return value
}

async function createFile(options: CreateFileOptions): Promise<MarkdownFileInfo> {
  const parent = await assertExisting(options.parentPath || currentWorkspace?.path || '', true)
  const target = await assertNew(path.join(parent, childName(options.name)))
  const handle = await fs.open(target, 'wx')
  try { await handle.writeFile(options.content || '', 'utf8') } finally { await handle.close() }
  return fileInfo(target)
}

async function createDirectory(options: CreateDirectoryOptions): Promise<{ path: string; name: string }> {
  const parent = await assertExisting(options.parentPath || currentWorkspace?.path || '', true)
  const name = childName(options.name)
  const target = await assertNew(path.join(parent, name))
  await fs.mkdir(target)
  return { path: target, name }
}

async function renamePath(options: RenameOptions): Promise<{ path: string; name: string; isDirectory: boolean }> {
  const source = await assertExisting(options.path, true)
  const sourceStat = await fs.stat(source)
  const destination = path.isAbsolute(options.newName)
    ? await assertNew(options.newName)
    : await assertNew(path.join(path.dirname(source), childName(options.newName)))
  await fs.rename(source, destination)
  return { path: destination, name: path.basename(destination), isDirectory: sourceStat.isDirectory() }
}

async function searchMarkdown(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const needle = String(query || '')
  if (!needle) return []
  const files = await listMarkdownFiles()
  const caseSensitive = Boolean(options.caseSensitive)
  const normalizedNeedle = caseSensitive ? needle : needle.toLocaleLowerCase()
  const limit = Math.max(1, Math.min(options.maxResults || 200, 2000))
  const results: SearchResult[] = []
  for (const file of files) {
    let content: string
    try { content = (await fs.readFile(file.path, 'utf8')).replace(/^\ufeff/, '') } catch { continue }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length && results.length < limit; index += 1) {
      const line = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase()
      let from = 0
      let count = 0
      let firstColumn = -1
      while (from <= line.length) {
        const found = line.indexOf(normalizedNeedle, from)
        if (found < 0) break
        if (firstColumn < 0) firstColumn = found
        count += 1
        from = found + Math.max(1, normalizedNeedle.length)
      }
      if (count) {
        results.push({
          path: file.path,
          relativePath: file.relativePath,
          line: index + 1,
          column: firstColumn + 1,
          preview: lines[index].trim().slice(0, 240),
          matchCount: count,
        })
      }
    }
    if (results.length >= limit) break
  }
  return results
}

function recentFile(): string {
  return path.join(app.getPath('userData'), 'recent-workspaces.json')
}

async function loadRecent(): Promise<WorkspaceInfo[]> {
  try {
    const data = JSON.parse(await fs.readFile(recentFile(), 'utf8')) as unknown
    if (!Array.isArray(data)) return []
    const valid: WorkspaceInfo[] = []
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const itemPath = typeof (item as { path?: unknown }).path === 'string' ? path.resolve((item as { path: string }).path) : ''
      if (!itemPath) continue
      try { if (!(await fs.stat(itemPath)).isDirectory()) continue } catch { continue }
      valid.push({ path: itemPath, name: path.basename(itemPath), lastOpenedAt: Number((item as { lastOpenedAt?: unknown }).lastOpenedAt) || 0 })
    }
    return valid.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)).slice(0, RECENT_LIMIT)
  } catch { return [] }
}

async function writeRecent(items: WorkspaceInfo[]): Promise<void> {
  await fs.mkdir(path.dirname(recentFile()), { recursive: true })
  await fs.writeFile(recentFile(), JSON.stringify(items.slice(0, RECENT_LIMIT), null, 2), 'utf8')
}

async function rememberWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const items = await loadRecent()
  const remaining = items.filter((item) => item.path !== workspace.path)
  remaining.unshift({ ...workspace, lastOpenedAt: Date.now() })
  await writeRecent(remaining)
}

async function closeWatcher(): Promise<void> {
  watcherGeneration += 1
  nativeWatcher?.close()
  nativeWatcher = null
  for (const watcher of fallbackWatchers.values()) watcher.close()
  fallbackWatchers.clear()
}

function sendFileChange(event: FileChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNELS.fileChanged, event)
}

async function handleWatchEvent(filePath: string, kind: 'rename' | 'change', generation: number): Promise<void> {
  if (generation !== watcherGeneration || !currentWorkspace) return
  const suppressionExpiresAt = suppressedWatchPaths.get(watchKey(filePath))
  if (suppressionExpiresAt && suppressionExpiresAt > Date.now()) return
  if (suppressionExpiresAt) suppressedWatchPaths.delete(watchKey(filePath))
  let stat
  try { stat = await fs.stat(filePath) } catch {
    if (markdownPath(filePath)) sendFileChange({ type: 'unlink', path: filePath, relativePath: relativePath(filePath), isDirectory: false })
    return
  }
  if (stat.isDirectory()) return
  if (!markdownPath(filePath)) return
  sendFileChange({
    type: kind === 'change' ? 'change' : 'add',
    path: filePath,
    relativePath: relativePath(filePath),
    isDirectory: false,
    modifiedAt: stat.mtimeMs,
  })
}

async function installFallbackWatcher(root: string, generation: number): Promise<void> {
  const directories: string[] = []
  const collect = async (directory: string): Promise<void> => {
    directories.push(directory)
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) await collect(path.join(directory, entry.name))
    }
  }
  await collect(root)
  if (generation !== watcherGeneration) return
  for (const directory of directories) {
    if (fallbackWatchers.has(directory)) continue
    try {
      const watcher = watchFs(directory, (kind, filename) => {
        if (!filename) return
        const target = path.join(directory, filename.toString())
        void handleWatchEvent(target, kind, generation)
        if (kind === 'rename') void installFallbackWatcher(root, generation)
      })
      fallbackWatchers.set(directory, watcher)
    } catch { /* directory may disappear during setup */ }
  }
}

async function watchWorkspace(root: string): Promise<void> {
  await closeWatcher()
  const generation = watcherGeneration
  try {
    nativeWatcher = watchFs(root, { recursive: true }, (kind, filename) => {
      if (!filename) return
      void handleWatchEvent(path.join(root, filename.toString()), kind, generation)
    })
  } catch {
    await installFallbackWatcher(root, generation)
  }
}

async function setWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
  const real = await fs.realpath(path.resolve(workspacePath))
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Workspace must be a directory')
  await closeWatcher()
  currentWorkspace = { path: real, name: path.basename(real) || real }
  try {
    await rememberWorkspace(currentWorkspace)
  } catch (error) {
    console.warn('[LeafMark] failed to remember workspace', error)
  }
  await watchWorkspace(real)
  return currentWorkspace
}

async function selectWorkspace(): Promise<WorkspaceInfo | null> {
  const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  return setWorkspace(result.filePaths[0])
}

async function openExternal(url: string): Promise<void> {
  const parsed = new URL(String(url))
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Only http, https, and mailto links are allowed')
  await shell.openExternal(parsed.toString())
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.selectWorkspace, () => selectWorkspace())
  ipcMain.handle(CHANNELS.openWorkspace, (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== 'string') throw new Error('Invalid workspace path')
    return setWorkspace(workspacePath)
  })
  ipcMain.handle(CHANNELS.getWorkspace, () => currentWorkspace)
  ipcMain.handle(CHANNELS.listFiles, () => listMarkdownFiles())
  ipcMain.handle(CHANNELS.listDirectories, () => listDirectories())
  ipcMain.handle(CHANNELS.readFile, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path')
    return readMarkdownFile(filePath)
  })
  ipcMain.handle(CHANNELS.saveFile, (_event, filePath: unknown, content: unknown, options?: SaveFileOptions) => {
    if (typeof filePath !== 'string' || typeof content !== 'string') throw new Error('Invalid save request')
    return atomicSave(filePath, content, options || {})
  })
  ipcMain.handle(CHANNELS.createFile, (_event, options: CreateFileOptions) => createFile(options))
  ipcMain.handle(CHANNELS.createDirectory, (_event, options: CreateDirectoryOptions) => createDirectory(options))
  ipcMain.handle(CHANNELS.rename, (_event, options: RenameOptions) => renamePath(options))
  ipcMain.handle(CHANNELS.trash, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') throw new Error('Invalid path')
    const resolved = await assertExisting(filePath)
    await shell.trashItem(resolved)
  })
  ipcMain.handle(CHANNELS.search, (_event, query: unknown, options?: SearchOptions) => searchMarkdown(String(query || ''), options || {}))
  ipcMain.handle(CHANNELS.listRecent, () => loadRecent())
  ipcMain.handle(CHANNELS.removeRecent, async (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== 'string') throw new Error('Invalid workspace path')
    await writeRecent((await loadRecent()).filter((item) => item.path !== path.resolve(workspacePath)))
  })
  ipcMain.handle(CHANNELS.openExternal, (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('Invalid URL')
    return openExternal(url)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error(`[LeafMark] did-fail-load ${errorCode} ${errorDescription}: ${validatedURL}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[LeafMark] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  const rendererEntry = path.join(app.getAppPath(), 'dist', 'index.html')
  if (!app.isPackaged) void mainWindow.loadURL(devUrl).catch(() => mainWindow?.loadFile(rendererEntry))
  else void mainWindow.loadFile(rendererEntry)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.disableHardwareAcceleration()

void app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { void closeWatcher() })
