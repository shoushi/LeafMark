import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from 'electron'
import { existsSync, promises as fs, watch as watchFs, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { marked } from 'marked'
import { autoUpdater } from 'electron-updater'
import type {
  CreateDirectoryOptions,
  CreateFileOptions,
  FileChangeEvent,
  HistorySnapshot,
  MarkdownDocument,
  MarkdownFileInfo,
  MergeFileResult,
  RenameOptions,
  SaveFileOptions,
  SavedFileResult,
  SearchOptions,
  SearchResult,
  SaveAttachmentOptions,
  SavedAttachmentResult,
  ExportDocumentFormat,
  ExportDocumentOptions,
  ExportDocumentResult,
  WorkspaceDirectoryInfo,
  WorkspaceInfo,
  UpdateState,
} from '../src/shared/types'
import { mergeThreeWay } from '../src/shared/merge'
import { closeSearchIndex, searchIndexed } from './searchIndex'

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
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.leafmark'])
const RECENT_LIMIT = 10
const HISTORY_DIRECTORY = '.leafmark/history'
const HISTORY_MAX_SNAPSHOTS = 120
const HISTORY_MAX_BYTES = 32 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const IMAGE_MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
  ['image/x-icon', '.ico'],
])
const IMAGE_FILE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
])

let mainWindow: BrowserWindow | null = null
let currentWorkspace: WorkspaceInfo | null = null
let nativeWatcher: FSWatcher | null = null
const fallbackWatchers = new Map<string, FSWatcher>()
let watcherGeneration = 0
let updateState: UpdateState = { status: 'disabled', message: '当前版本未配置更新渠道。' }

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

interface HistorySnapshotRecord extends HistorySnapshot {
  version: 1
}

function snapshotPathSegments(filePath: string): string[] {
  return relativePath(filePath)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
}

function historyRoot(): string {
  if (!currentWorkspace) throw new Error('No workspace is open')
  return path.join(currentWorkspace.path, HISTORY_DIRECTORY)
}

async function historyDirectory(filePath: string, create: boolean): Promise<string | null> {
  const resolved = await assertExisting(filePath)
  const directory = path.join(historyRoot(), ...snapshotPathSegments(resolved))
  if (create) {
    await fs.mkdir(directory, { recursive: true })
  } else {
    try {
      const stat = await fs.stat(directory)
      if (!stat.isDirectory()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const realDirectory = await fs.realpath(directory)
  assertInside(realDirectory, true)
  return realDirectory
}

function snapshotId(value: string): string {
  const normalized = String(value || '')
  if (!normalized || normalized !== path.basename(normalized) || /[\\/]/.test(normalized)) {
    throw new Error('Invalid history snapshot id')
  }
  return normalized
}

async function writeHistorySnapshot(filePath: string, bytes: Buffer): Promise<void> {
  try {
    const directory = await historyDirectory(filePath, true)
    if (!directory) return
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const content = bytes.toString('utf8', hasBom ? 3 : 0)
    const record: HistorySnapshotRecord = {
      version: 1,
      id: `${Date.now()}-${randomUUID()}`,
      relativePath: relativePath(filePath),
      createdAt: Date.now(),
      size: bytes.length,
      hash: hashBytes(bytes),
      content,
      hasBom,
    }
    const target = path.join(directory, `${record.id}.json`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(target, 'wx')
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
    await pruneHistorySnapshots()
  } catch (error) {
    // History is a safety net and must not make a valid save fail. The normal
    // save path still remains protected by its hash/mtime checks.
    console.warn('[LeafMark] failed to write history snapshot', error)
  }
}

async function readHistorySnapshot(filePath: string, id: string): Promise<HistorySnapshotRecord> {
  const directory = await historyDirectory(filePath, false)
  if (!directory) throw new Error('History snapshot not found')
  const target = path.join(directory, `${snapshotId(id)}.json`)
  const realTarget = await fs.realpath(target)
  assertInside(realTarget, true)
  const raw = JSON.parse(await fs.readFile(realTarget, 'utf8')) as Partial<HistorySnapshotRecord>
  if (raw.version !== 1 || raw.id !== id || raw.relativePath !== relativePath(filePath) || typeof raw.content !== 'string') {
    throw new Error('Invalid history snapshot')
  }
  return {
    version: 1,
    id: raw.id,
    relativePath: raw.relativePath,
    createdAt: Number(raw.createdAt) || 0,
    size: Number(raw.size) || Buffer.byteLength(raw.content, 'utf8'),
    hash: typeof raw.hash === 'string' ? raw.hash : hashBytes(Buffer.from(raw.content, 'utf8')),
    content: raw.content,
    hasBom: Boolean(raw.hasBom),
  }
}

async function collectHistorySnapshotFiles(): Promise<Array<{ path: string; record: HistorySnapshotRecord }>> {
  const root = historyRoot()
  const result: Array<{ path: string; record: HistorySnapshotRecord }> = []
  const walk = async (directory: string): Promise<void> => {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue
      try {
        const raw = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<HistorySnapshotRecord>
        if (raw.version !== 1 || typeof raw.id !== 'string' || typeof raw.relativePath !== 'string' || typeof raw.content !== 'string') continue
        result.push({
          path: target,
          record: {
            version: 1,
            id: raw.id,
            relativePath: raw.relativePath,
            createdAt: Number(raw.createdAt) || 0,
            size: Number(raw.size) || Buffer.byteLength(raw.content, 'utf8'),
            hash: typeof raw.hash === 'string' ? raw.hash : hashBytes(Buffer.from(raw.content, 'utf8')),
            content: raw.content,
            hasBom: Boolean(raw.hasBom),
          },
        })
      } catch {
        // Ignore incomplete snapshots left by an interrupted write.
      }
    }
  }
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) return []
  } catch { return [] }
  const realRoot = await fs.realpath(root)
  assertInside(realRoot, true)
  await walk(realRoot)
  return result
}

async function pruneHistorySnapshots(): Promise<void> {
  const all = await collectHistorySnapshotFiles()
  all.sort((left, right) => right.record.createdAt - left.record.createdAt || right.record.id.localeCompare(left.record.id))
  let retained = 0
  let retainedBytes = 0
  for (const item of all) {
    const keepNewestOversize = retained === 0
    const withinLimits = retained < HISTORY_MAX_SNAPSHOTS
      && (retainedBytes + item.record.size <= HISTORY_MAX_BYTES || keepNewestOversize)
    if (withinLimits) {
      retained += 1
      retainedBytes += item.record.size
    } else {
      await fs.rm(item.path, { force: true }).catch(() => undefined)
    }
  }
}

async function listSnapshots(filePath: string): Promise<HistorySnapshot[]> {
  const directory = await historyDirectory(filePath, false)
  if (!directory) return []
  const result: HistorySnapshot[] = []
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return [] }
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue
    try {
      const record = await readHistorySnapshot(filePath, path.basename(entry.name, '.json'))
      result.push(record)
    } catch { /* ignore invalid or concurrently removed snapshots */ }
  }
  return result.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
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
  // Capture the exact bytes that are about to be replaced. This happens only
  // after the optimistic-concurrency guards pass, so a rejected save never
  // creates a misleading history entry.
  await writeHistorySnapshot(resolved, existing)
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

async function restoreSnapshot(filePath: string, id: string): Promise<SavedFileResult> {
  const resolved = await assertExisting(filePath)
  const snapshot = await readHistorySnapshot(resolved, id)
  const current = await fs.readFile(resolved)
  return atomicSave(resolved, snapshot.content, {
    expectedHash: hashBytes(current),
    hasBom: snapshot.hasBom,
  })
}

async function mergeFile(filePath: string, baseContent: string, localContent: string): Promise<MergeFileResult> {
  const remote = await readMarkdownFile(filePath)
  const merged = mergeThreeWay(baseContent, localContent, remote.content)
  return {
    path: remote.path,
    remoteContent: remote.content,
    remoteHash: remote.hash,
    remoteModifiedAt: remote.modifiedAt,
    remoteSize: remote.size,
    remoteHasBom: remote.hasBom,
    content: merged.content,
    hasConflicts: merged.hasConflicts,
  }
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

function attachmentMimeType(name: string, mimeType?: string): { mimeType: string; extension: string } {
  const normalizedMime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase()
  const mimeExtension = IMAGE_MIME_EXTENSIONS.get(normalizedMime)
  if (mimeExtension) return { mimeType: normalizedMime, extension: mimeExtension }
  const fileMimeType = IMAGE_FILE_EXTENSIONS.get(path.extname(name).toLowerCase())
  if (fileMimeType) return { mimeType: fileMimeType, extension: IMAGE_MIME_EXTENSIONS.get(fileMimeType) || '.png' }
  throw new Error('Only supported image attachments are allowed')
}

function attachmentStem(name: string): string {
  const basename = path.basename(String(name || '').replaceAll('\\', '/'))
  const parsed = path.parse(basename)
  let stem = parsed.name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 96)
  if (!stem) stem = 'image'
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `image-${stem}`
  return stem
}

function encodedMarkdownPath(filePath: string): string {
  return filePath
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function saveAttachment(options: SaveAttachmentOptions): Promise<SavedAttachmentResult> {
  const documentPath = await assertExisting(options.markdownPath)
  const documentStat = await fs.stat(documentPath)
  if (!documentStat.isFile() || !markdownPath(documentPath)) throw new Error('Attachments require a Markdown file')

  const sourceData = options.data
  const bytes = sourceData instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(sourceData))
    : Buffer.from(sourceData)
  if (!bytes.length) throw new Error('The image attachment is empty')
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Image attachments must be 25 MB or smaller')

  const originalName = String(options.name || '').trim()
  const { mimeType, extension } = attachmentMimeType(originalName, options.mimeType)
  const attachmentDirectory = path.join(currentWorkspace?.path || '', 'attachments')
  try {
    const existingDirectory = await fs.realpath(attachmentDirectory)
    assertInside(existingDirectory, true)
    if (!(await fs.stat(existingDirectory)).isDirectory()) throw new Error('The attachments path is not a directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.mkdir(attachmentDirectory, { recursive: true })
    const realDirectory = await fs.realpath(attachmentDirectory)
    assertInside(realDirectory, true)
  }

  const stem = attachmentStem(originalName)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const filename = `${stem}${suffix ? `-${suffix}` : ''}${extension}`
    const target = await assertNew(path.join(attachmentDirectory, filename))
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(target, 'wx')
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      const relativePath = encodedMarkdownPath(path.relative(path.dirname(documentPath), target))
      const alt = stem.replace(/\s+/g, ' ').trim() || 'image'
      return {
        path: target,
        relativePath,
        name: filename,
        mimeType,
        size: bytes.length,
        markdown: `![${alt.replace(/]/g, '\\]')}](${relativePath})`,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }
  throw new Error('Could not choose a unique attachment name')
}

async function loadLocalImage(markdownPathValue: string, referenceValue: string): Promise<string> {
  const documentPath = await assertExisting(markdownPathValue)
  if (!markdownPath(documentPath) || !(await fs.stat(documentPath)).isFile()) {
    throw new Error('A Markdown document is required to resolve an image')
  }

  const reference = String(referenceValue || '').trim()
  if (!reference || reference.startsWith('/') || reference.startsWith('\\') || /^[a-z][a-z\d+.-]*:/i.test(reference)) {
    throw new Error('Only relative workspace image references are allowed')
  }
  const encodedPath = reference.split(/[?#]/, 1)[0]
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(encodedPath)
  } catch {
    throw new Error('Invalid image reference')
  }
  if (!decodedPath || path.isAbsolute(decodedPath)) throw new Error('Invalid image reference')

  const target = await assertExisting(path.resolve(path.dirname(documentPath), decodedPath.replaceAll('/', path.sep)))
  const stat = await fs.stat(target)
  if (!stat.isFile()) throw new Error('The image reference is not a file')
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('Images larger than 25 MB cannot be previewed')
  const { mimeType } = attachmentMimeType(target)
  const bytes = await fs.readFile(target)
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case "'": return '&#39;'
      case '"': return '&quot;'
      default: return character
    }
  })
}

function exportTitle(content: string, suggestedName?: string): string {
  const heading = content.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim()
  if (heading) return heading.replace(/[*_`~]/g, '').trim() || 'LeafMark 文档'
  const name = path.basename(String(suggestedName || ''), path.extname(String(suggestedName || ''))).trim()
  return name || 'LeafMark 文档'
}

function renderExportHtml(content: string, suggestedName?: string): string {
  const title = exportTitle(content, suggestedName)
  const rendered = marked.parse(content, { gfm: true, breaks: false })
  const body = typeof rendered === 'string' ? rendered : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { max-width: 860px; margin: 0 auto; padding: 48px 32px 72px; color: #1f2937; background: #fff; line-height: 1.75; }
    h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 .6em; line-height: 1.25; }
    h1 { margin-top: 0; }
    a { color: #2563eb; }
    img { max-width: 100%; height: auto; }
    blockquote { margin: 1em 0; padding: .25em 1em; border-left: 4px solid #cbd5e1; color: #475569; }
    pre { overflow: auto; padding: 16px; border-radius: 8px; background: #0f172a; color: #e2e8f0; }
    code { padding: .12em .3em; border-radius: 4px; background: #f1f5f9; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre code { padding: 0; background: transparent; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 10px; border: 1px solid #d1d5db; text-align: left; }
    th { background: #f8fafc; }
  </style>
</head>
<body>
${body}
</body>
</html>
`
}

async function exportDocument(options: ExportDocumentOptions): Promise<ExportDocumentResult | null> {
  const format: ExportDocumentFormat = options.format === 'html' ? 'html' : 'markdown'
  const extension = format === 'html' ? '.html' : '.md'
  const suggestedName = String(options.suggestedName || '').trim()
  const suggestedBase = path.basename(suggestedName, path.extname(suggestedName)) || 'untitled'
  const dialogOptions = {
    title: format === 'html' ? '导出 HTML' : '导出 Markdown',
    defaultPath: `${suggestedBase}${extension}`,
    filters: format === 'html'
      ? [{ name: 'HTML 文件', extensions: ['html'] }, { name: '所有文件', extensions: ['*'] }]
      : [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }],
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (result.canceled || !result.filePath) return null

  const selectedExtension = path.extname(result.filePath).toLowerCase()
  const selectedPath = selectedExtension === extension ? result.filePath : `${result.filePath}${extension}`
  const output = format === 'html' ? renderExportHtml(String(options.content), suggestedName) : String(options.content)
  await fs.writeFile(selectedPath, output, 'utf8')
  return { path: selectedPath, format, size: Buffer.byteLength(output, 'utf8') }
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

async function searchMarkdownLegacy(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
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

async function searchMarkdown(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  if (!currentWorkspace || !String(query || '').trim()) return []
  return searchIndexed(currentWorkspace.path, await listMarkdownFiles(), query, options)
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
  await closeSearchIndex()
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

let updaterConfigured = false

function updateConfigPath(): string {
  return path.join(process.resourcesPath, 'app-update.yml')
}

function updatesEnabled(): boolean {
  return app.isPackaged
    && process.env.LEAFMARK_UPDATE_DISABLED !== '1'
    && existsSync(updateConfigPath())
}

function publishUpdateState(next: UpdateState): void {
  updateState = next
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.updateState, updateState)
  }
}

function updateDetails(info: { version?: string; releaseDate?: string }): Pick<UpdateState, 'version' | 'releaseDate'> {
  return {
    ...(info.version ? { version: info.version } : {}),
    ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
  }
}

function updateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configureAutoUpdater(): void {
  if (updaterConfigured) return
  updaterConfigured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  if (!updatesEnabled()) {
    publishUpdateState({ status: 'disabled', message: '当前版本未配置更新渠道。' })
    return
  }

  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', ...updateDetails(info) }))
  autoUpdater.on('update-not-available', (info) => publishUpdateState({ status: 'not-available', ...updateDetails(info) }))
  autoUpdater.on('download-progress', (info) => publishUpdateState({
    status: 'downloading',
    progress: Math.max(0, Math.min(100, Number(info.percent) || 0)),
  }))
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({ status: 'downloaded', ...updateDetails(info), progress: 100 }))
  autoUpdater.on('error', (error) => publishUpdateState({ status: 'error', message: updateErrorMessage(error) }))
  publishUpdateState({ status: 'idle' })
}

async function checkForUpdates(): Promise<UpdateState> {
  if (!updatesEnabled()) {
    publishUpdateState({ status: 'disabled', message: '当前版本未配置更新渠道。' })
    return updateState
  }
  publishUpdateState({ status: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publishUpdateState({ status: 'error', message: updateErrorMessage(error) })
  }
  return updateState
}

async function downloadUpdate(): Promise<UpdateState> {
  if (!updatesEnabled()) {
    publishUpdateState({ status: 'disabled', message: '当前版本未配置更新渠道。' })
    return updateState
  }
  if (updateState.status !== 'available') return updateState
  publishUpdateState({ ...updateState, status: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    publishUpdateState({ status: 'error', message: updateErrorMessage(error) })
  }
  return updateState
}

function installUpdate(): void {
  if (!updatesEnabled() || updateState.status !== 'downloaded') {
    throw new Error('没有可安装的更新')
  }
  autoUpdater.quitAndInstall(false, true)
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
  ipcMain.handle(CHANNELS.listSnapshots, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') throw new Error('Invalid history path')
    return listSnapshots(filePath)
  })
  ipcMain.handle(CHANNELS.restoreSnapshot, (_event, filePath: unknown, id: unknown) => {
    if (typeof filePath !== 'string' || typeof id !== 'string') throw new Error('Invalid history restore request')
    return restoreSnapshot(filePath, id)
  })
  ipcMain.handle(CHANNELS.mergeFile, (_event, filePath: unknown, baseContent: unknown, localContent: unknown) => {
    if (typeof filePath !== 'string' || typeof baseContent !== 'string' || typeof localContent !== 'string') {
      throw new Error('Invalid merge request')
    }
    return mergeFile(filePath, baseContent, localContent)
  })
  ipcMain.handle(CHANNELS.saveAttachment, (_event, options: unknown) => {
    if (!options || typeof options !== 'object') throw new Error('Invalid attachment request')
    const request = options as Partial<SaveAttachmentOptions>
    if (typeof request.markdownPath !== 'string' || !(request.data instanceof ArrayBuffer || request.data instanceof Uint8Array)) {
      throw new Error('Invalid attachment request')
    }
    if (request.name !== undefined && typeof request.name !== 'string') throw new Error('Invalid attachment name')
    if (request.mimeType !== undefined && typeof request.mimeType !== 'string') throw new Error('Invalid attachment MIME type')
    return saveAttachment(request as SaveAttachmentOptions)
  })
  ipcMain.handle(CHANNELS.loadLocalImage, (_event, markdownPathValue: unknown, referenceValue: unknown) => {
    if (typeof markdownPathValue !== 'string' || typeof referenceValue !== 'string') {
      throw new Error('Invalid local image request')
    }
    return loadLocalImage(markdownPathValue, referenceValue)
  })
  ipcMain.handle(CHANNELS.exportDocument, (_event, options: unknown) => {
    if (!options || typeof options !== 'object') throw new Error('Invalid export request')
    const request = options as Partial<ExportDocumentOptions>
    if (typeof request.content !== 'string' || (request.format !== 'markdown' && request.format !== 'html')) {
      throw new Error('Invalid export request')
    }
    if (request.suggestedName !== undefined && typeof request.suggestedName !== 'string') {
      throw new Error('Invalid export name')
    }
    return exportDocument(request as ExportDocumentOptions)
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
  ipcMain.handle(CHANNELS.updateGetState, () => updateState)
  ipcMain.handle(CHANNELS.updateCheck, () => checkForUpdates())
  ipcMain.handle(CHANNELS.updateDownload, () => downloadUpdate())
  ipcMain.handle(CHANNELS.updateInstall, () => installUpdate())
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
  configureAutoUpdater()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { void closeWatcher(); void closeSearchIndex() })
