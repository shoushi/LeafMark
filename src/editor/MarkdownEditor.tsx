import React, {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { EditorView } from '@codemirror/view'
import type { ExportDocumentFormat, ExportDocumentResult } from '../shared/types'
import { CodeMirrorSourceEditor } from './CodeMirrorSourceEditor'

import './editor.css'

export type MarkdownEditorMode = 'wysiwyg' | 'source' | 'reader'

export type MarkdownEditorCommand =
  | { type: 'find'; query?: string }
  | { type: 'replace-all'; query: string; replacement: string }
  | { type: 'save' }
  | { type: 'focus' }

export interface MarkdownEditorProps {
  /** The Markdown document. The component is intentionally controlled. */
  value: string
  onChange: (value: string) => void
  mode: MarkdownEditorMode
  onModeChange: (mode: MarkdownEditorMode) => void
  filePath?: string
  onSave?: () => void | Promise<void>
  onExport?: (format: ExportDocumentFormat) => ExportDocumentResult | null | void | Promise<ExportDocumentResult | null | void>
  onCommand?: (command: MarkdownEditorCommand) => void
  readOnly?: boolean
  placeholder?: string
  className?: string
}

const SAFE_URI = /^(?:(?:https?|mailto|tel|asset|blob):|(?:\/?|\.\.?\/|[^:/?#\s]+(?:\/[^?#\s]*)?(?:[?#].*)?)|#|data:image\/(?:png|gif|webp|svg\+xml);)/i
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)
}

function imageFilesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const fromFiles = Array.from(transfer.files)
  const files = fromFiles.length
    ? fromFiles
    : Array.from(transfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
  return files.filter(isImageFile)
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: SAFE_URI,
    ADD_ATTR: ['target', 'rel'],
  })
}

function encodeRichValue(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27')
}

function protectRichSyntax(source: string): string {
  const mermaidBlocks: string[] = []
  const withoutMermaid = source.replace(/```([^\n]*)\n([\s\S]*?)```/g, (full, language: string, body: string) => {
    if (language.trim().toLowerCase() !== 'mermaid') return full
    const index = mermaidBlocks.push(body.replace(/\n$/, '')) - 1
    return `\n<div data-leafmark-mermaid="${encodeRichValue(mermaidBlocks[index])}"></div>\n`
  })
  return withoutMermaid.replace(/(`[^`\n]+`)|(\$\$[\s\S]+?\$\$)|(\$(?!\s)(?:\\.|[^$\n])+\$)/g, (full, code: string, blockMath: string, inlineMath: string) => {
    if (code) return full
    const display = Boolean(blockMath)
    const expression = (blockMath || inlineMath).replace(/^\$\$?|\$\$?$/g, '').trim()
    return display
      ? `\n<div data-leafmark-katex="${encodeRichValue(expression)}" data-display="true"></div>\n`
      : `<span data-leafmark-katex="${encodeRichValue(expression)}"></span>`
  })
}

function markdownToHtml(source: string): string {
  const html = marked.parse(protectRichSyntax(source), { gfm: true, breaks: false })
  return sanitizeHtml(typeof html === 'string' ? html : '')
}

function isLocalImageReference(reference: string): boolean {
  const value = reference.trim()
  return Boolean(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.startsWith('#')
    && !/^[a-z][a-z\d+.-]*:/i.test(value)
}

async function hydrateLocalImages(container: HTMLElement, markdownPath: string): Promise<void> {
  const images = Array.from(container.querySelectorAll('img'))
  await Promise.all(images.map(async (image) => {
    const reference = image.dataset.markdownSrc ?? image.getAttribute('src') ?? ''
    if (!isLocalImageReference(reference)) return
    image.dataset.markdownSrc = reference
    try {
      image.src = await window.markdownDesktop.loadLocalImage(markdownPath, reference)
      image.removeAttribute('data-image-error')
    } catch {
      image.dataset.imageError = 'true'
    }
  }))
}

let mermaidConfigured = false
let richRenderId = 0
let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null
let katexModulePromise: Promise<typeof import('katex')> | null = null

async function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidModulePromise ??= import('mermaid')
  return mermaidModulePromise
}

async function loadKatex(): Promise<typeof import('katex')> {
  katexModulePromise ??= import('katex')
  return katexModulePromise
}

async function hydrateRichContent(container: HTMLElement): Promise<void> {
  const mermaidNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-leafmark-mermaid]'))
  if (mermaidNodes.length) {
    const mermaidModule = await loadMermaid()
    const mermaid = mermaidModule.default
    if (!mermaidConfigured) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
      mermaidConfigured = true
    }
    for (const node of mermaidNodes) {
      try {
        const source = decodeURIComponent(node.dataset.leafmarkMermaid ?? '')
        const rendered = await mermaid.render(`leafmark-mermaid-${++richRenderId}`, source)
        node.innerHTML = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { html: true, svg: true, svgFilters: true } })
        node.removeAttribute('data-render-error')
      } catch {
        node.textContent = decodeURIComponent(node.dataset.leafmarkMermaid ?? '')
        node.dataset.renderError = 'true'
      }
    }
  }

  const katexNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-leafmark-katex]'))
  if (!katexNodes.length) return
  const katex = (await loadKatex()).default
  for (const node of katexNodes) {
    try {
      const expression = decodeURIComponent(node.dataset.leafmarkKatex ?? '')
      const rendered = katex.renderToString(expression, {
        displayMode: node.dataset.display === 'true',
        throwOnError: false,
        output: 'htmlAndMathml',
      })
      node.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true, svg: true } })
      node.removeAttribute('data-render-error')
    } catch {
      node.textContent = decodeURIComponent(node.dataset.leafmarkKatex ?? '')
      node.dataset.renderError = 'true'
    }
  }
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  const content = Array.from(element.childNodes).map(inlineMarkdown).join('')

  switch (tag) {
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return `**${content}**`
    case 'em':
    case 'i':
      return `*${content}*`
    case 'del':
    case 's':
      return `~~${content}~~`
    case 'code':
      return `\`${content.replace(/`/g, '\\`')}\``
    case 'a': {
      const href = element.getAttribute('href') ?? ''
      return href ? `[${content}](${href.replace(/\)/g, '\\)')})` : content
    }
    case 'img': {
      const src = element.getAttribute('data-markdown-src') ?? element.getAttribute('src') ?? ''
      const alt = element.getAttribute('alt') ?? ''
      return src ? `![${alt}](${src.replace(/\)/g, '\\)')})` : ''
    }
    default:
      return content
  }
}

function tableMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.children)
      .filter((cell) => ['th', 'td'].includes(cell.tagName.toLowerCase()))
      .map((cell) => inlineMarkdown(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()),
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length), 1)
  const padded = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')])
  const header = `| ${padded[0].join(' | ')} |`
  const divider = `| ${padded[0].map(() => '---').join(' | ')} |`
  const body = padded.slice(1).map((row) => `| ${row.join(' | ')} |`)
  return [header, divider, ...body].join('\n')
}

function listMarkdown(list: HTMLElement, ordered: boolean, depth = 0): string {
  const indent = '  '.repeat(depth)
  let index = 1
  return Array.from(list.children)
    .filter((child) => child.tagName.toLowerCase() === 'li')
    .map((child) => {
      const item = child as HTMLElement
      const nested = Array.from(item.children).find((element) => ['ul', 'ol'].includes(element.tagName.toLowerCase())) as
        | HTMLElement
        | undefined
      const inline = Array.from(item.childNodes)
        .filter((node) => !(node.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes((node as HTMLElement).tagName.toLowerCase())))
        .map(inlineMarkdown)
        .join('')
        .replace(/\n+/g, ' ')
        .trim()
      const checkbox = item.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null
      const taskPrefix = checkbox ? `[${checkbox.checked ? 'x' : ' '}] ` : ''
      const marker = ordered ? `${index++}.` : '-'
      const firstLine = `${indent}${marker} ${taskPrefix}${inline}`.trimEnd()
      if (!nested) return firstLine
      return `${firstLine}\n${listMarkdown(nested, nested.tagName.toLowerCase() === 'ol', depth + 1)}`
    })
    .join('\n')
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').trim()
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  const content = Array.from(element.childNodes).map(inlineMarkdown).join('').trim()

  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${content}`.trimEnd()
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return content
  if (tag === 'blockquote') {
    return Array.from(element.childNodes)
      .map((child) => blockMarkdown(child))
      .join('\n\n')
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n')
  }
  if (tag === 'ul' || tag === 'ol') return listMarkdown(element, tag === 'ol')
  if (tag === 'pre') {
    const code = element.querySelector('code')
    const language = code?.className.match(/language-([\w-]+)/)?.[1] ?? ''
    const text = code?.textContent ?? element.textContent ?? ''
    return `\`\`\`${language}\n${text.replace(/\n$/, '')}\n\`\`\``
  }
  if (tag === 'hr') return '---'
  if (tag === 'table') return tableMarkdown(element)
  if (tag === 'img') return inlineMarkdown(element)
  if (tag === 'br') return ''
  return content
}

/** Best-effort HTML -> Markdown conversion for the common WYSIWYG constructs. */
function htmlToMarkdown(element: HTMLElement): string {
  const blocks = Array.from(element.childNodes)
    .map(blockMarkdown)
    .map((block) => block.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

function countWords(source: string): number {
  const cjk = source.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latin = source
    .replace(/[\u3400-\u9fff]/g, ' ')
    .match(/[A-Za-zÀ-ž0-9_]+/g)?.length ?? 0
  return cjk + latin
}

function countOccurrences(source: string, query: string): number {
  if (!query) return 0
  let count = 0
  let from = 0
  while (from <= source.length) {
    const index = source.indexOf(query, from)
    if (index < 0) break
    count += 1
    from = index + Math.max(query.length, 1)
  }
  return count
}

function isShortcut(event: KeyboardEvent, key: string): boolean {
  return event.key.toLowerCase() === key && (event.metaKey || event.ctrlKey)
}

function updateRef<T>(ref: MutableRefObject<T>, value: T): void {
  ref.current = value
}

export function MarkdownEditor({
  value,
  onChange,
  mode,
  onModeChange,
  filePath,
  onSave,
  onExport,
  onCommand,
  readOnly = false,
  placeholder = '开始输入 Markdown…',
  className = '',
}: MarkdownEditorProps): React.ReactElement {
  const editableRef = useRef<HTMLDivElement>(null)
  const sourceViewRef = useRef<EditorView | null>(null)
  const readerRef = useRef<HTMLElement>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onExportRef = useRef(onExport)
  const onCommandRef = useRef(onCommand)
  const attachmentPreviewUrlsRef = useRef<string[]>([])
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [attachmentStatus, setAttachmentStatus] = useState('')
  const [exportFormat, setExportFormat] = useState<ExportDocumentFormat>('markdown')
  const [exportBusy, setExportBusy] = useState(false)
  const [exportStatus, setExportStatus] = useState('')

  updateRef(valueRef, value)
  updateRef(onChangeRef, onChange)
  updateRef(onSaveRef, onSave)
  updateRef(onExportRef, onExport)
  updateRef(onCommandRef, onCommand)

  useEffect(() => () => {
    for (const url of attachmentPreviewUrlsRef.current) URL.revokeObjectURL(url)
    attachmentPreviewUrlsRef.current = []
  }, [])

  const html = useMemo(() => markdownToHtml(value), [value])
  const words = useMemo(() => countWords(value), [value])
  const characters = useMemo(() => Array.from(value).length, [value])
  const matches = useMemo(() => countOccurrences(value, findQuery), [value, findQuery])

  useEffect(() => {
    if (mode !== 'wysiwyg' || !editableRef.current) return
    const appliedValue = editableRef.current.dataset.markdownValue
    if (appliedValue !== value) {
      editableRef.current.innerHTML = html
      editableRef.current.dataset.markdownValue = value
    }
  }, [html, mode, value])

  useEffect(() => {
    if (!filePath) return
    const container = mode === 'wysiwyg' ? editableRef.current : mode === 'reader' ? readerRef.current : null
    if (!container) return
    void hydrateLocalImages(container, filePath)
    void hydrateRichContent(container)
  }, [filePath, html, mode])

  useEffect(() => {
    if (mode === 'source') sourceViewRef.current?.focus()
  }, [mode])

  const emitCommand = (command: MarkdownEditorCommand): void => {
    onCommandRef.current?.(command)
  }

  const save = (): void => {
    emitCommand({ type: 'save' })
    void onSaveRef.current?.()
  }

  const exportCurrent = async (): Promise<void> => {
    const callback = onExportRef.current
    if (!callback || exportBusy) return
    setExportBusy(true)
    setExportStatus(`正在导出 ${exportFormat === 'html' ? 'HTML' : 'Markdown'}…`)
    try {
      const result = await callback(exportFormat)
      setExportStatus(result ? `已导出为 ${exportFormat === 'html' ? 'HTML' : 'Markdown'}` : '已取消导出')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExportStatus(`导出失败：${message}`)
    } finally {
      setExportBusy(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (isShortcut(event, 's')) {
      event.preventDefault()
      if (!readOnly) save()
      return
    }
    if (isShortcut(event, 'f')) {
      event.preventDefault()
      setFindOpen(true)
      emitCommand({ type: 'find', query: findQuery })
    }
  }

  const handleWysiwygInput = (): void => {
    if (!editableRef.current || readOnly) return
    const nextValue = htmlToMarkdown(editableRef.current)
    editableRef.current.dataset.markdownValue = nextValue
    if (nextValue !== value) onChangeRef.current(nextValue)
  }

  const saveImageFiles = async (
    files: File[],
    sourceSelection?: { value: string; start: number; end: number },
    wysiwygSelection?: Range,
  ): Promise<void> => {
    if (!files.length || !filePath || readOnly || mode === 'reader') return
    setAttachmentStatus(`正在保存 ${files.length} 张图片…`)
    try {
      const attachments = []
      for (const file of files) {
        const data = await file.arrayBuffer()
        const attachment = await window.markdownDesktop.saveAttachment({
          markdownPath: filePath,
          data,
          name: file.name,
          mimeType: file.type,
        })
        attachments.push({ attachment, file })
      }

      if (mode === 'source') {
        const currentValue = valueRef.current
        const currentSelection = sourceViewRef.current?.state.selection.main
        const selection = currentValue === sourceSelection?.value && sourceSelection
          ? sourceSelection
          : {
            value: currentValue,
            start: currentSelection?.from ?? currentValue.length,
            end: currentSelection?.to ?? currentValue.length,
          }
        const inserted = attachments.map(({ attachment }) => attachment.markdown).join('\n')
        const start = Math.max(0, Math.min(selection.start, selection.value.length))
        const end = Math.max(start, Math.min(selection.end, selection.value.length))
        const nextValue = `${selection.value.slice(0, start)}${inserted}${selection.value.slice(end)}`
        valueRef.current = nextValue
        if (sourceViewRef.current) {
          sourceViewRef.current.dispatch({
            changes: { from: start, to: end, insert: inserted },
            selection: { anchor: start + inserted.length },
          })
          sourceViewRef.current.focus()
        } else {
          onChangeRef.current(nextValue)
        }
      } else if (editableRef.current) {
        const editable = editableRef.current
        const range = wysiwygSelection && editable.contains(wysiwygSelection.commonAncestorContainer)
          ? wysiwygSelection.cloneRange()
          : document.createRange()
        if (!wysiwygSelection || !editable.contains(wysiwygSelection.commonAncestorContainer)) {
          range.selectNodeContents(editable)
          range.collapse(false)
        }
        range.deleteContents()
        const fragment = document.createDocumentFragment()
        attachments.forEach(({ attachment, file }, index) => {
          if (index > 0) fragment.appendChild(document.createTextNode('\n'))
          const image = document.createElement('img')
          const previewUrl = URL.createObjectURL(file)
          attachmentPreviewUrlsRef.current.push(previewUrl)
          image.src = previewUrl
          image.alt = attachment.name.replace(/\.[^.]+$/, '')
          image.dataset.markdownSrc = attachment.relativePath
          image.dataset.leafmarkAttachment = 'true'
          image.draggable = false
          fragment.appendChild(image)
        })
        range.insertNode(fragment)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        handleWysiwygInput()
      }
      setAttachmentStatus(`${attachments.length} 张图片已添加到 attachments`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法保存图片附件'
      setAttachmentStatus(`图片附件失败：${message}`)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    if (readOnly || !filePath || (mode !== 'source' && mode !== 'wysiwyg')) return
    const files = imageFilesFromTransfer(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    const sourceSelection = mode === 'source' && sourceViewRef.current
      ? {
        value: sourceViewRef.current?.state.doc.toString() ?? valueRef.current,
        start: sourceViewRef.current?.state.selection.main.from ?? valueRef.current.length,
        end: sourceViewRef.current?.state.selection.main.to ?? valueRef.current.length,
      }
      : undefined
    const selection = mode === 'wysiwyg' ? window.getSelection() : null
    const wysiwygSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined
    void saveImageFiles(files, sourceSelection, wysiwygSelection)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (readOnly || !filePath || (mode !== 'source' && mode !== 'wysiwyg')) return
    if (!imageFilesFromTransfer(event.dataTransfer).length) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    if (readOnly || !filePath || (mode !== 'source' && mode !== 'wysiwyg')) return
    const files = imageFilesFromTransfer(event.dataTransfer)
    if (!files.length) return
    event.preventDefault()
    const sourceSelection = mode === 'source' && sourceViewRef.current
      ? {
        value: sourceViewRef.current?.state.doc.toString() ?? valueRef.current,
        start: sourceViewRef.current?.state.selection.main.from ?? valueRef.current.length,
        end: sourceViewRef.current?.state.selection.main.to ?? valueRef.current.length,
      }
      : undefined
    const selection = mode === 'wysiwyg' ? window.getSelection() : null
    const wysiwygSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined
    void saveImageFiles(files, sourceSelection, wysiwygSelection)
  }

  const replaceAll = (): void => {
    if (!findQuery || readOnly) return
    const nextValue = value.split(findQuery).join(replacement)
    if (nextValue !== value) onChangeRef.current(nextValue)
    emitCommand({ type: 'replace-all', query: findQuery, replacement })
  }

  const rootClassName = ['markdown-editor', className].filter(Boolean).join(' ')
  const displayName = filePath || '未命名.md'

  return (
    <section
      className={rootClassName}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-label="Markdown 编辑器"
    >
      <header className="markdown-editor__toolbar">
        <div className="markdown-editor__modes" role="tablist" aria-label="编辑模式">
          {(['reader', 'wysiwyg', 'source'] as MarkdownEditorMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={mode === item ? 'is-active' : ''}
              role="tab"
              aria-selected={mode === item}
              onClick={() => onModeChange(item)}
            >
              {item === 'reader' ? '阅读' : item === 'wysiwyg' ? '所见即所得' : '源码'}
            </button>
          ))}
        </div>
        <div className="markdown-editor__file" title={filePath}>{displayName}</div>
        <div className="markdown-editor__actions">
          <button type="button" onClick={() => { setFindOpen((open) => !open); emitCommand({ type: 'find', query: findQuery }) }}>
            查找替换
          </button>
          <label className="markdown-editor__export-format">
            <span className="sr-only">导出格式</span>
            <select
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value as ExportDocumentFormat)}
              disabled={!onExport || exportBusy}
              aria-label="导出格式"
            >
              <option value="markdown">Markdown (.md)</option>
              <option value="html">HTML (.html)</option>
            </select>
          </label>
          <button type="button" onClick={() => void exportCurrent()} disabled={!onExport || exportBusy}>导出</button>
          <button type="button" onClick={save} disabled={readOnly}>保存</button>
        </div>
      </header>

      {findOpen && (
        <div className="markdown-editor__findbar" role="search">
          <label>
            查找
            <input value={findQuery} onChange={(event) => setFindQuery(event.target.value)} autoFocus />
          </label>
          <label>
            替换为
            <input value={replacement} onChange={(event) => setReplacement(event.target.value)} />
          </label>
          <span className="markdown-editor__match-count">{matches} 处</span>
          <button type="button" onClick={replaceAll} disabled={!findQuery || readOnly}>全部替换</button>
          <button type="button" onClick={() => setFindOpen(false)} aria-label="关闭查找">关闭</button>
        </div>
      )}

      <div className={`markdown-editor__body markdown-editor__body--${mode}`}>
        {mode === 'wysiwyg' && (
          <div
            ref={editableRef}
            className="markdown-editor__wysiwyg"
            contentEditable={!readOnly}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={handleWysiwygInput}
            onFocus={() => emitCommand({ type: 'focus' })}
          />
        )}
        {mode === 'source' && (
          <CodeMirrorSourceEditor
            value={value}
            onChange={(next) => onChangeRef.current(next)}
            readOnly={readOnly}
            placeholder={placeholder}
            viewRef={sourceViewRef}
          />
        )}
        {mode === 'reader' && (
          <article ref={readerRef} className="markdown-editor__reader" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>

      <footer className="markdown-editor__status">
        {attachmentStatus && <span className="markdown-editor__attachment-status" aria-live="polite">{attachmentStatus}</span>}
        {exportStatus && <span className="markdown-editor__export-status" aria-live="polite">{exportStatus}</span>}
        <span>{words} 字词</span>
        <span>{characters} 字符</span>
        <span>{mode === 'reader' ? '阅读模式' : readOnly ? '只读' : '可编辑'}</span>
      </footer>
    </section>
  )
}

export default MarkdownEditor
