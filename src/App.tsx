import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkdownEditor, type MarkdownEditorMode } from './editor'
import type {
  FileChangeEvent,
  ExportDocumentFormat,
  ExportDocumentResult,
  HistorySnapshot,
  MarkdownDocument,
  MarkdownFileInfo,
  SearchResult,
  WorkspaceDirectoryInfo,
  WorkspaceInfo,
  UpdateState,
} from './shared/types'
import './ui/app.css'

type Tab = MarkdownDocument & {
  draft: string
  dirty: boolean
  externalChange?: boolean
}

type CreateDialogKind = 'file' | 'directory'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn'])
const INVALID_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_WINDOWS_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function validateCreateName(kind: CreateDialogKind, rawName: string): { name?: string; error?: string } {
  const value = rawName.trim()
  if (!value) return { error: '请输入名称。' }
  if (value === '.' || value === '..') return { error: '名称不能是 . 或 ..。' }
  if (INVALID_NAME_PATTERN.test(value)) return { error: '名称包含 Windows 不允许的字符：< > : " / \\ | ? *' }
  if (/[. ]$/.test(value)) return { error: '名称不能以空格或句点结尾。' }
  if (RESERVED_WINDOWS_NAME_PATTERN.test(value)) return { error: '名称不能使用 Windows 保留设备名。' }

  if (kind === 'file') {
    const extensionMatch = /\.[^.]+$/.exec(value)
    if (!extensionMatch) return { name: `${value}.md` }
    if (!MARKDOWN_EXTENSIONS.has(extensionMatch[0].toLowerCase())) {
      return { error: '请使用 Markdown 扩展名（例如 .md 或 .markdown）。' }
    }
  }
  return { name: value }
}

function createErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/EEXIST|already exists|已存在/i.test(message)) return '同名项目已存在，请换一个名称。'
  return message || '创建失败，请稍后重试。'
}

const basename = (path: string) => path.replaceAll('\\', '/').split('/').pop() || path

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [files, setFiles] = useState<MarkdownFileInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [mode, setMode] = useState<MarkdownEditorMode>('wysiwyg')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('leafmark-theme') === 'dark' ? 'dark' : 'light',
  )
  const [focusMode, setFocusMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('准备就绪')
  const [createDialog, setCreateDialog] = useState<CreateDialogKind | null>(null)
  const [createName, setCreateName] = useState('untitled.md')
  const [createParentPath, setCreateParentPath] = useState('')
  const [directories, setDirectories] = useState<WorkspaceDirectoryInfo[]>([])
  const [directoriesLoading, setDirectoriesLoading] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const [historyDialog, setHistoryDialog] = useState<{ path: string; snapshots: HistorySnapshot[] } | null>(null)
  const [historySelectedId, setHistorySelectedId] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'disabled' })

  const activeTab = tabs.find((tab) => tab.path === activePath)

  const refreshFiles = useCallback(async () => {
    const next = await window.markdownDesktop.listMarkdownFiles()
    setFiles(next)
  }, [])

  const refreshDirectories = useCallback(async () => {
    const next = await window.markdownDesktop.listDirectories()
    setDirectories(next)
    return next
  }, [])

  const openWorkspace = useCallback(async () => {
    const selected = await window.markdownDesktop.selectWorkspace()
    if (!selected) return
    setWorkspace(selected)
    setTabs([])
    setActivePath(null)
    setResults([])
    setMessage(`已打开 ${selected.name}`)
    await Promise.all([refreshFiles(), refreshDirectories()])
  }, [refreshDirectories, refreshFiles])

  const openFile = useCallback(async (path: string) => {
    setActivePath(path)
    if (tabs.some((tab) => tab.path === path)) return
    setBusy(true)
    try {
      const document = await window.markdownDesktop.readFile(path)
      setTabs((current) => [...current, { ...document, draft: document.content, dirty: false }])
      setMessage(`已打开 ${basename(path)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [tabs])

  const saveTab = useCallback(async (path: string, silent = false) => {
    const tab = tabs.find((candidate) => candidate.path === path)
    if (!tab || !tab.dirty) return
    const draftAtSave = tab.draft
    try {
      const saved = await window.markdownDesktop.saveFile(path, draftAtSave, {
        expectedHash: tab.hash,
        hasBom: tab.hasBom,
      })
      setTabs((current) => current.map((item) => {
        if (item.path !== path) return item
        const draftUnchanged = item.draft === draftAtSave
        return {
          ...item,
          content: draftAtSave,
          dirty: !draftUnchanged,
          externalChange: draftUnchanged ? false : item.externalChange,
          hash: saved.hash,
          modifiedAt: saved.modifiedAt,
          size: saved.size,
        }
      }))
      if (!silent) setMessage(`已保存 ${basename(path)}`)
    } catch (error) {
      setTabs((current) => current.map((item) => item.path === path
        ? { ...item, externalChange: true }
        : item))
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [tabs])

  const exportTab = useCallback(async (path: string, format: ExportDocumentFormat): Promise<ExportDocumentResult | null> => {
    const tab = tabs.find((candidate) => candidate.path === path)
    if (!tab) return null
    setMessage(`正在导出 ${basename(path)}…`)
    try {
      const result = await window.markdownDesktop.exportDocument({
        content: tab.draft,
        format,
        suggestedName: basename(path),
      })
      if (!result) {
        setMessage('已取消导出')
        return null
      }
      setMessage(`已导出 ${basename(result.path)}`)
      return result
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }, [tabs])

  const reloadTab = useCallback(async (path: string) => {
    const document = await window.markdownDesktop.readFile(path)
    setTabs((current) => current.map((item) => item.path === path
      ? { ...document, draft: document.content, dirty: false, externalChange: false }
      : item))
    setMessage(`已重新载入 ${basename(path)}`)
  }, [])

  const mergeDiskVersion = useCallback(async (path: string) => {
    const tab = tabs.find((candidate) => candidate.path === path)
    if (!tab) return
    setBusy(true)
    try {
      const result = await window.markdownDesktop.mergeFile(path, tab.content, tab.draft)
      setTabs((current) => current.map((item) => item.path === path
        ? {
            ...item,
            content: result.remoteContent,
            draft: result.content,
            dirty: result.content !== result.remoteContent,
            externalChange: result.hasConflicts,
            hash: result.remoteHash,
            modifiedAt: result.remoteModifiedAt,
            size: result.remoteSize,
            hasBom: result.remoteHasBom,
          }
        : item))
      setMessage(result.hasConflicts ? '合并完成，但存在冲突标记，请检查后保存。' : '已合并磁盘版本。')
    } catch (error) {
      setMessage(`合并失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [tabs])

  const openHistory = useCallback(async (path: string) => {
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const snapshots = await window.markdownDesktop.listSnapshots(path)
      setHistoryDialog({ path, snapshots })
      setHistorySelectedId(snapshots[0]?.id ?? null)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const closeHistory = () => {
    if (historyBusy) return
    setHistoryDialog(null)
    setHistorySelectedId(null)
    setHistoryError('')
  }

  const restoreSelectedSnapshot = async () => {
    if (!historyDialog || !historySelectedId || historyBusy) return
    setHistoryBusy(true)
    setHistoryError('')
    try {
      await window.markdownDesktop.restoreSnapshot(historyDialog.path, historySelectedId)
      const document = await window.markdownDesktop.readFile(historyDialog.path)
      setTabs((current) => current.map((item) => item.path === historyDialog.path
        ? { ...document, draft: document.content, dirty: false, externalChange: false }
        : item))
      await refreshFiles()
      const snapshots = await window.markdownDesktop.listSnapshots(historyDialog.path)
      setHistoryDialog({ path: historyDialog.path, snapshots })
      setHistorySelectedId(snapshots[0]?.id ?? null)
      setMessage(`已恢复 ${basename(historyDialog.path)} 的历史版本。`)
    } catch (error) {
      setHistoryError(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setHistoryBusy(false)
    }
  }

  useEffect(() => {
    void window.markdownDesktop.getWorkspace().then(async (current) => {
      if (!current) return
      setWorkspace(current)
      await Promise.all([refreshFiles(), refreshDirectories()])
    })
  }, [refreshDirectories, refreshFiles])

  useEffect(() => {
    let active = true
    void window.markdownDesktop.getUpdateState().then((state) => {
      if (active) setUpdateState(state)
    }).catch(() => undefined)
    const unsubscribe = window.markdownDesktop.onUpdateState((state) => {
      if (active) setUpdateState(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => window.markdownDesktop.onFileChanged((event: FileChangeEvent) => {
    void refreshFiles()
    if (event.type !== 'change' && event.type !== 'unlink') return
    setTabs((current) => current.map((tab) => {
      if (tab.path !== event.path) return tab
      return { ...tab, externalChange: true }
    }))
  }), [refreshFiles])

  useEffect(() => {
    if (!activeTab?.dirty || activeTab.externalChange) return
    const timer = window.setTimeout(() => void saveTab(activeTab.path, true), 1200)
    return () => window.clearTimeout(timer)
  }, [activeTab?.draft, activeTab?.dirty, activeTab?.externalChange, activeTab?.path, saveTab])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('leafmark-theme', theme)
  }, [theme])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activePath) {
        event.preventDefault()
        void saveTab(activePath)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openWorkspace()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activePath, openWorkspace, saveTab])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const timer = window.setTimeout(() => {
      void window.markdownDesktop.search(query, { maxResults: 50 }).then(setResults)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const outline = useMemo(() => {
    if (!activeTab) return []
    return activeTab.draft.split(/\r?\n/).flatMap((line, index) => {
      const match = /^(#{1,6})\s+(.+)$/.exec(line)
      return match ? [{ level: match[1].length, title: match[2], line: index + 1 }] : []
    })
  }, [activeTab?.draft])

  const directoryOptions = useMemo(() => {
    if (!workspace) return []
    const root = directories.find((directory) => directory.path === workspace.path) ?? {
      path: workspace.path,
      relativePath: '',
      name: workspace.name,
      isDirectory: true as const,
    }
    return [root, ...directories.filter((directory) => directory.path !== root.path)]
  }, [directories, workspace])

  const selectedHistorySnapshot = historyDialog?.snapshots.find((snapshot) => snapshot.id === historySelectedId)

  const openCreateDialog = (kind: CreateDialogKind) => {
    if (!workspace) return
    setCreateDialog(kind)
    setCreateName(kind === 'file' ? 'untitled.md' : '新建文件夹')
    setCreateParentPath(workspace.path)
    setCreateError('')
    setDirectoriesLoading(true)
    void refreshDirectories()
      .catch((error) => setCreateError(createErrorMessage(error)))
      .finally(() => setDirectoriesLoading(false))
  }

  const updateAction = async (): Promise<void> => {
    try {
      if (updateState.status === 'available') {
        await window.markdownDesktop.downloadUpdate()
      } else if (updateState.status === 'downloaded') {
        await window.markdownDesktop.installUpdate()
      } else {
        await window.markdownDesktop.checkForUpdates()
      }
    } catch (error) {
      setMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const updateButtonLabel = updateState.status === 'available'
    ? '下载更新'
    : updateState.status === 'downloaded'
      ? '重启安装'
      : updateState.status === 'checking' || updateState.status === 'downloading'
        ? '检查更新中…'
        : '检查更新'

  const closeCreateDialog = () => {
    if (createBusy) return
    setCreateDialog(null)
    setCreateError('')
  }

  const submitCreate = async () => {
    if (!createDialog || createBusy) return
    const validation = validateCreateName(createDialog, createName)
    if (validation.error || !validation.name) {
      setCreateError(validation.error ?? '请输入有效名称。')
      return
    }
    const parentPath = createParentPath || workspace?.path
    if (!parentPath) {
      setCreateError('请先打开一个工作区。')
      return
    }

    setCreateBusy(true)
    setCreateError('')
    try {
      if (createDialog === 'file') {
        const file = await window.markdownDesktop.createFile({ name: validation.name, parentPath })
        await refreshFiles()
        setCreateDialog(null)
        await openFile(file.path)
        setMessage(`已创建 ${basename(file.path)}`)
      } else {
        const directory = await window.markdownDesktop.createDirectory({ name: validation.name, parentPath })
        await refreshDirectories()
        setCreateDialog(null)
        setMessage(`已创建文件夹 ${directory.name}`)
      }
    } catch (error) {
      setCreateError(createErrorMessage(error))
    } finally {
      setCreateBusy(false)
    }
  }

  useEffect(() => {
    if (!createDialog) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeCreateDialog()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [createDialog, createBusy])

  const closeTab = (path: string) => {
    const target = tabs.find((tab) => tab.path === path)
    if (target?.dirty && !window.confirm(`${basename(path)} 尚未保存，确定关闭？`)) return
    const index = tabs.findIndex((tab) => tab.path === path)
    const next = tabs.filter((tab) => tab.path !== path)
    setTabs(next)
    if (activePath === path) setActivePath(next[Math.max(0, index - 1)]?.path ?? null)
  }

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <header className="titlebar">
        <div className="brand"><span>叶</span> LeafMark</div>
        <div className="title-actions">
          <button onClick={() => void openWorkspace()}>打开工作区</button>
          <button onClick={() => openCreateDialog('file')} disabled={!workspace}>新建</button>
          <button onClick={() => openCreateDialog('directory')} disabled={!workspace}>文件夹</button>
          <button onClick={() => setFocusMode((value) => !value)}>专注</button>
          <button onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? '深色' : '浅色'}
          </button>
          <button
            className="update-action"
            onClick={() => void updateAction()}
            disabled={updateState.status === 'disabled' || updateState.status === 'checking' || updateState.status === 'downloading'}
            title={updateState.message || '检查 LeafMark 更新'}
          >
            {updateButtonLabel}
            {updateState.status === 'downloading' && updateState.progress !== undefined ? ` ${Math.round(updateState.progress)}%` : ''}
          </button>
        </div>
      </header>

      <main className="workspace-layout">
        <aside className="left-panel">
          <div className="workspace-name">{workspace?.name ?? '尚未打开工作区'}</div>
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档…"
          />
          <div className="file-list">
            {(query ? results : files).map((item) => {
              const file = 'relativePath' in item ? item : null
              const path = item.path
              return (
                <button
                  className={`file-item ${activePath === path ? 'active' : ''}`}
                  key={`${path}-${'line' in item ? item.line : ''}`}
                  onClick={() => void openFile(path)}
                  title={file?.relativePath ?? path}
                >
                  <span className="file-icon">MD</span>
                  <span><b>{basename(path)}</b><small>{'preview' in item ? item.preview : file?.relativePath}</small></span>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="document-panel">
          <nav className="tabs">
            {tabs.map((tab) => (
              <button key={tab.path} className={activePath === tab.path ? 'active' : ''} onClick={() => setActivePath(tab.path)}>
                {tab.dirty ? '● ' : ''}{basename(tab.path)}
                <span onClick={(event) => { event.stopPropagation(); closeTab(tab.path) }}>×</span>
              </button>
            ))}
          </nav>
          {activeTab ? (
            <>
              {activeTab.externalChange && (
                <div className="conflict-banner">
                  磁盘文件发生变化。为防止覆盖，自动保存已暂停。
                  <button onClick={() => void reloadTab(activeTab.path)}>载入磁盘版本</button>
                  <button onClick={() => void mergeDiskVersion(activeTab.path)}>合并磁盘版本</button>
                  <button onClick={() => void openHistory(activeTab.path)} disabled={historyLoading}>历史</button>
                  <button onClick={() => setTabs((current) => current.map((tab) => tab.path === activeTab.path ? { ...tab, externalChange: false } : tab))}>保留编辑内容</button>
                </div>
              )}
              <MarkdownEditor
                value={activeTab.draft}
                onChange={(draft) => setTabs((current) => current.map((tab) => tab.path === activeTab.path
                  ? { ...tab, draft, dirty: draft !== tab.content }
                  : tab))}
                mode={mode}
                onModeChange={setMode}
                filePath={activeTab.path}
                onSave={() => saveTab(activeTab.path)}
                onExport={(format) => exportTab(activeTab.path, format)}
              />
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-mark">叶</div>
              <h1>写作，留在你的文件里</h1>
              <p>打开一个 Markdown 工作区，开始本地优先的编辑与阅读。</p>
              <button onClick={() => void openWorkspace()}>选择文件夹</button>
            </div>
          )}
        </section>

        <aside className="right-panel">
          <h3>文档大纲</h3>
          {outline.length ? outline.map((heading) => (
            <div className="outline-item" style={{ paddingLeft: `${(heading.level - 1) * 12}px` }} key={`${heading.line}-${heading.title}`}>
              {heading.title}<small> L{heading.line}</small>
            </div>
          )) : <p className="muted">暂无标题</p>}
        </aside>
      </main>

      <footer className="statusbar">
        <span>{busy ? '处理中…' : message}</span>
        <span>{activeTab ? `${activeTab.draft.length} 字符 · ${mode}` : '本地优先 · 无账号'}</span>
      </footer>

      {createDialog && (
        <div className="dialog-backdrop">
          <form
            className="create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-dialog-title"
            onSubmit={(event) => { event.preventDefault(); void submitCreate() }}
          >
            <div className="dialog-header">
              <div>
                <h2 id="create-dialog-title">{createDialog === 'file' ? '新建 Markdown 文件' : '新建文件夹'}</h2>
                <p>创建后会立即出现在当前工作区。</p>
              </div>
              <button className="dialog-close" type="button" onClick={closeCreateDialog} disabled={createBusy} aria-label="关闭">×</button>
            </div>

            <div className="dialog-type-switch" aria-label="创建类型">
              <button
                type="button"
                className={createDialog === 'file' ? 'active' : ''}
                aria-pressed={createDialog === 'file'}
                disabled={createBusy}
                onClick={() => { setCreateDialog('file'); setCreateName('untitled.md'); setCreateError('') }}
              >
                Markdown 文件
              </button>
              <button
                type="button"
                className={createDialog === 'directory' ? 'active' : ''}
                aria-pressed={createDialog === 'directory'}
                disabled={createBusy}
                onClick={() => { setCreateDialog('directory'); setCreateName('新建文件夹'); setCreateError('') }}
              >
                文件夹
              </button>
            </div>

            <label className="dialog-field" htmlFor="create-name">
              <span>名称</span>
              <input
                id="create-name"
                value={createName}
                onChange={(event) => { setCreateName(event.target.value); if (createError) setCreateError('') }}
                autoFocus
                disabled={createBusy}
                aria-invalid={Boolean(createError)}
                aria-describedby={createError ? 'create-dialog-error' : 'create-dialog-hint'}
              />
              <small id="create-dialog-hint">
                {createDialog === 'file' ? '未填写扩展名时会自动添加 .md。' : '文件夹名称不能包含路径分隔符。'}
              </small>
            </label>

            <label className="dialog-field" htmlFor="create-parent">
              <span>位置</span>
              <select
                id="create-parent"
                value={createParentPath}
                onChange={(event) => setCreateParentPath(event.target.value)}
                disabled={createBusy || directoriesLoading}
              >
                {directoryOptions.map((directory) => (
                  <option value={directory.path} key={directory.path}>
                    {directory.relativePath ? directory.relativePath : `${directory.name}（工作区根目录）`}
                  </option>
                ))}
              </select>
              {directoriesLoading && <small>正在读取可用文件夹…</small>}
            </label>

            {createError && <div className="dialog-error" id="create-dialog-error" role="alert">{createError}</div>}

            <div className="dialog-actions">
              <button type="button" onClick={closeCreateDialog} disabled={createBusy}>取消</button>
              <button type="submit" className="primary" disabled={createBusy || directoriesLoading}>
                {createBusy ? '创建中…' : '创建'}
              </button>
            </div>
          </form>
        </div>
      )}

      {historyDialog && (
        <div className="dialog-backdrop">
          <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title">
            <div className="dialog-header">
              <div>
                <h2 id="history-dialog-title">历史版本 · {basename(historyDialog.path)}</h2>
                <p>每次成功保存前会保留一个快照，历史目录不会出现在文档列表中。</p>
              </div>
              <button className="dialog-close" type="button" onClick={closeHistory} disabled={historyBusy} aria-label="关闭">×</button>
            </div>

            <div className="history-layout">
              <div className="history-list" aria-label="历史版本列表">
                {historyDialog.snapshots.length ? historyDialog.snapshots.map((snapshot) => (
                  <button
                    className={`history-item ${snapshot.id === historySelectedId ? 'active' : ''}`}
                    key={snapshot.id}
                    type="button"
                    onClick={() => setHistorySelectedId(snapshot.id)}
                    disabled={historyBusy}
                  >
                    <b>{new Date(snapshot.createdAt).toLocaleString()}</b>
                    <small>{snapshot.size.toLocaleString()} 字节 · {snapshot.hash.slice(0, 8)}</small>
                  </button>
                )) : <p className="muted history-empty">暂无历史快照</p>}
              </div>
              <div className="history-preview-wrap">
                <div className="history-preview-label">预览</div>
                <pre className="history-preview">{selectedHistorySnapshot?.content ?? '选择一个历史版本查看内容。'}</pre>
              </div>
            </div>

            {historyError && <div className="dialog-error" role="alert">{historyError}</div>}
            <div className="dialog-actions">
              <button type="button" onClick={closeHistory} disabled={historyBusy}>关闭</button>
              <button type="button" className="primary" onClick={() => void restoreSelectedSnapshot()} disabled={historyBusy || !selectedHistorySnapshot}>
                {historyBusy ? '恢复中…' : '恢复此版本'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
