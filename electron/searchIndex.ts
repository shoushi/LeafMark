import initSqlJs from 'sql.js'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { MarkdownFileInfo, SearchOptions, SearchResult } from '../src/shared/types'

interface IndexedRow {
  path: string
  relativePath: string
  modifiedAt: number
  content: string
}

interface SearchIndexState {
  workspacePath: string
  databasePath: string
  db: import('sql.js').SqlJsDatabase
  fts5: boolean
}

let state: SearchIndexState | null = null
let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

async function getSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (sqlModule) return sqlModule
  sqlModule = await initSqlJs({ locateFile: (file) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm')), file) })
  return sqlModule
}

function databasePath(workspacePath: string): string {
  return path.join(workspacePath, '.leafmark', 'search.sqlite')
}

function schedulePersist(): void {
  if (!state || persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persist()
  }, 350)
}

async function persist(): Promise<void> {
  if (!state) return
  const bytes = state.db.export()
  await fs.mkdir(path.dirname(state.databasePath), { recursive: true })
  await fs.writeFile(state.databasePath, bytes)
}

async function ensureState(workspacePath: string): Promise<SearchIndexState> {
  const resolved = path.resolve(workspacePath)
  if (state?.workspacePath === resolved) return state
  if (state) {
    await persist().catch(() => undefined)
    state.db.close()
    state = null
  }
  const sql = await getSqlModule()
  let bytes: Uint8Array | undefined
  try { bytes = await fs.readFile(databasePath(resolved)) } catch { /* first index */ }
  const db = new sql.Database(bytes)
  db.run('PRAGMA journal_mode = DELETE;')
  let fts5 = true
  try {
    db.run('CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(path UNINDEXED, relativePath UNINDEXED, modifiedAt UNINDEXED, content)')
  } catch {
    // The stock sql.js WASM build may omit optional FTS5 extensions. Keep the
    // same persisted SQLite index and use the content column as a safe fallback.
    fts5 = false
    db.run('CREATE TABLE IF NOT EXISTS documents(path TEXT PRIMARY KEY, relativePath TEXT NOT NULL, modifiedAt REAL NOT NULL, content TEXT NOT NULL)')
  }
  state = { workspacePath: resolved, databasePath: databasePath(resolved), db, fts5 }
  return state
}

function rowValue(row: unknown[], index: number): string {
  return String(row[index] ?? '')
}

async function readIndexedRows(index: SearchIndexState): Promise<IndexedRow[]> {
  const result = index.db.exec('SELECT path, relativePath, modifiedAt, content FROM documents')
  if (!result.length) return []
  return result[0].values.map((row: unknown[]) => ({
    path: rowValue(row, 0),
    relativePath: rowValue(row, 1),
    modifiedAt: Number(row[2]) || 0,
    content: rowValue(row, 3),
  }))
}

export async function syncSearchIndex(workspacePath: string, files: MarkdownFileInfo[]): Promise<void> {
  const index = await ensureState(workspacePath)
  const rows = await readIndexedRows(index)
  const byPath = new Map(rows.map((row) => [row.path, row]))
  const nextPaths = new Set(files.map((file) => file.path))
  for (const row of rows) {
    if (!nextPaths.has(row.path)) index.db.run('DELETE FROM documents WHERE path = ?', [row.path])
  }
  for (const file of files) {
    const existing = byPath.get(file.path)
    if (existing && Math.abs(existing.modifiedAt - file.modifiedAt) < 1 && existing.relativePath === file.relativePath) continue
    const content = await fs.readFile(file.path, 'utf8').then((value) => value.replace(/^\ufeff/, '')).catch(() => '')
    index.db.run('DELETE FROM documents WHERE path = ?', [file.path])
    index.db.run('INSERT INTO documents(path, relativePath, modifiedAt, content) VALUES (?, ?, ?, ?)', [file.path, file.relativePath, file.modifiedAt, content])
  }
  schedulePersist()
}

function matchRows(rows: IndexedRow[], query: string, options: SearchOptions): SearchResult[] {
  const needle = String(query || '')
  if (!needle) return []
  const caseSensitive = Boolean(options.caseSensitive)
  const normalizedNeedle = caseSensitive ? needle : needle.toLocaleLowerCase()
  const limit = Math.max(1, Math.min(options.maxResults || 200, 2000))
  const output: SearchResult[] = []
  for (const row of rows) {
    const lines = row.content.split(/\r?\n/)
    for (let index = 0; index < lines.length && output.length < limit; index += 1) {
      const source = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase()
      let from = 0
      let count = 0
      let firstColumn = -1
      while (from <= source.length) {
        const found = source.indexOf(normalizedNeedle, from)
        if (found < 0) break
        if (firstColumn < 0) firstColumn = found
        count += 1
        from = found + Math.max(1, normalizedNeedle.length)
      }
      if (count) output.push({ path: row.path, relativePath: row.relativePath, line: index + 1, column: firstColumn + 1, preview: lines[index].trim().slice(0, 240), matchCount: count })
    }
    if (output.length >= limit) break
  }
  return output
}

export async function searchIndexed(workspacePath: string, files: MarkdownFileInfo[], query: string, options: SearchOptions): Promise<SearchResult[]> {
  await syncSearchIndex(workspacePath, files)
  const index = await ensureState(workspacePath)
  const escaped = String(query || '').trim().split(/\s+/).filter(Boolean).map((part) => `"${part.replaceAll('"', '""')}"`).join(' AND ')
  let rows: IndexedRow[] = []
  if (escaped && index.fts5) {
    try {
      const result = index.db.exec('SELECT path, relativePath, modifiedAt, content FROM documents WHERE documents MATCH ?', [escaped])
      rows = result.length ? result[0].values.map((row: unknown[]) => ({ path: rowValue(row, 0), relativePath: rowValue(row, 1), modifiedAt: Number(row[2]) || 0, content: rowValue(row, 3) })) : []
    } catch { /* FTS syntax/tokenizer fallback below */ }
  }
  // FTS tokenizers do not split all CJK text as users expect. If FTS yields no
  // candidate, scan the already-indexed rows while preserving substring search.
  if (!rows.length) rows = await readIndexedRows(index)
  return matchRows(rows, query, options)
}

export async function closeSearchIndex(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  if (!state) return
  await persist().catch(() => undefined)
  state.db.close()
  state = null
}
