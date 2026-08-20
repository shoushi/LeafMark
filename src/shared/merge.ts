/**
 * Small, dependency-free, line based three-way merge used by the Electron
 * main process.  The renderer never gets filesystem access; it only receives
 * the result through the typed preload API.
 */

export interface MergeResult {
  content: string
  hasConflicts: boolean
}

interface DiffHunk {
  start: number
  end: number
  replacement: string[]
}

interface EditOperation {
  type: 'equal' | 'delete' | 'insert'
  line?: string
}

interface LineDocument {
  lines: string[]
  trailingNewline: boolean
}

function splitLines(content: string): LineDocument {
  const normalized = content.replace(/\r\n?/g, '\n')
  const trailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`
}

/** Myers shortest-edit-script backtracking, operating on complete lines. */
function diffOperations(base: string[], variant: string[]): EditOperation[] {
  const n = base.length
  const m = variant.length
  const max = n + m
  let frontier = new Map<number, number>([[1, 0]])
  const trace: Map<number, number>[] = []

  for (let distance = 0; distance <= max; distance += 1) {
    trace.push(new Map(frontier))
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? 0
      const right = frontier.get(diagonal - 1) ?? 0
      let x = diagonal === -distance || (diagonal !== distance && right < down)
        ? down
        : right + 1
      let y = x - diagonal

      while (x < n && y < m && base[x] === variant[y]) {
        x += 1
        y += 1
      }
      frontier.set(diagonal, x)
      if (x >= n && y >= m) {
        return backtrackOperations(base, variant, trace, distance)
      }
    }
  }
  return []
}

function backtrackOperations(
  base: string[],
  variant: string[],
  trace: Map<number, number>[],
  distance: number,
): EditOperation[] {
  const operations: EditOperation[] = []
  let x = base.length
  let y = variant.length

  for (let current = distance; current > 0; current -= 1) {
    const previous = trace[current]
    const diagonal = x - y
    const down = previous.get(diagonal + 1) ?? 0
    const right = previous.get(diagonal - 1) ?? 0
    const previousDiagonal = diagonal === -current || (diagonal !== current && right < down)
      ? diagonal + 1
      : diagonal - 1
    const previousX = previous.get(previousDiagonal) ?? 0
    const previousY = previousX - previousDiagonal

    while (x > previousX && y > previousY) {
      operations.push({ type: 'equal', line: base[x - 1] })
      x -= 1
      y -= 1
    }
    if (x === previousX) {
      operations.push({ type: 'insert', line: variant[y - 1] })
      y -= 1
    } else {
      operations.push({ type: 'delete', line: base[x - 1] })
      x -= 1
    }
  }

  while (x > 0 && y > 0) {
    operations.push({ type: 'equal', line: base[x - 1] })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    operations.push({ type: 'delete', line: base[x - 1] })
    x -= 1
  }
  while (y > 0) {
    operations.push({ type: 'insert', line: variant[y - 1] })
    y -= 1
  }
  return operations.reverse()
}

function diffHunks(base: string[], variant: string[]): DiffHunk[] {
  const operations = diffOperations(base, variant)
  const hunks: DiffHunk[] = []
  let baseIndex = 0
  let current: DiffHunk | undefined

  const finish = () => {
    if (!current) return
    hunks.push(current)
    current = undefined
  }

  for (const operation of operations) {
    if (operation.type === 'equal') {
      finish()
      baseIndex += 1
    } else if (operation.type === 'delete') {
      current ??= { start: baseIndex, end: baseIndex, replacement: [] }
      current.end += 1
      baseIndex += 1
    } else {
      current ??= { start: baseIndex, end: baseIndex, replacement: [] }
      current.replacement.push(operation.line ?? '')
    }
  }
  finish()
  return hunks
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

function renderVariant(base: string[], hunks: DiffHunk[], start: number, end: number): string[] {
  const output: string[] = []
  let cursor = start
  for (const hunk of hunks) {
    if (hunk.start < start || hunk.start > end || hunk.start >= end && hunk.start !== start) continue
    if (hunk.start > cursor) output.push(...base.slice(cursor, hunk.start))
    output.push(...hunk.replacement)
    cursor = Math.max(cursor, hunk.end)
  }
  if (cursor < end) output.push(...base.slice(cursor, end))
  return output
}

function conflictBlock(local: string[], remote: string[]): string[] {
  return ['<<<<<<< LOCAL', ...local, '=======', ...remote, '>>>>>>> DISK']
}

function mergeLines(base: string[], local: string[], remote: string[]): { lines: string[]; hasConflicts: boolean } {
  if (sameLines(local, base)) return { lines: remote, hasConflicts: false }
  if (sameLines(remote, base)) return { lines: local, hasConflicts: false }
  if (sameLines(local, remote)) return { lines: local, hasConflicts: false }

  const localHunks = diffHunks(base, local)
  const remoteHunks = diffHunks(base, remote)
  const output: string[] = []
  let baseIndex = 0
  let localIndex = 0
  let remoteIndex = 0
  let hasConflicts = false

  while (baseIndex < base.length || localIndex < localHunks.length || remoteIndex < remoteHunks.length) {
    const localHunk = localHunks[localIndex]
    const remoteHunk = remoteHunks[remoteIndex]
    const nextStart = Math.min(localHunk?.start ?? base.length, remoteHunk?.start ?? base.length)

    if (baseIndex < nextStart) {
      output.push(...base.slice(baseIndex, nextStart))
      baseIndex = nextStart
      continue
    }

    if (!localHunk && !remoteHunk) break
    if (!localHunk || (remoteHunk && remoteHunk.start < localHunk.start)) {
      output.push(...remoteHunk!.replacement)
      baseIndex = Math.max(baseIndex, remoteHunk!.end)
      remoteIndex += 1
      continue
    }
    if (!remoteHunk || localHunk.start < remoteHunk.start) {
      output.push(...localHunk.replacement)
      baseIndex = Math.max(baseIndex, localHunk.end)
      localIndex += 1
      continue
    }

    // Both sides start at this base position. Identical edits are safe; two
    // different insertions/replacements become a conventional conflict block.
    if (localHunk.end === remoteHunk.end && sameLines(localHunk.replacement, remoteHunk.replacement)) {
      output.push(...localHunk.replacement)
      baseIndex = Math.max(baseIndex, localHunk.end)
      localIndex += 1
      remoteIndex += 1
      continue
    }

    let conflictEnd = Math.max(localHunk.end, remoteHunk.end)
    let localEndIndex = localIndex + 1
    let remoteEndIndex = remoteIndex + 1
    let expanded = true
    while (expanded) {
      expanded = false
      const nextLocal = localHunks[localEndIndex]
      if (nextLocal && nextLocal.start < conflictEnd) {
        conflictEnd = Math.max(conflictEnd, nextLocal.end)
        localEndIndex += 1
        expanded = true
      }
      const nextRemote = remoteHunks[remoteEndIndex]
      if (nextRemote && nextRemote.start < conflictEnd) {
        conflictEnd = Math.max(conflictEnd, nextRemote.end)
        remoteEndIndex += 1
        expanded = true
      }
    }

    const localVariant = renderVariant(base, localHunks.slice(localIndex, localEndIndex), baseIndex, conflictEnd)
    const remoteVariant = renderVariant(base, remoteHunks.slice(remoteIndex, remoteEndIndex), baseIndex, conflictEnd)
    output.push(...conflictBlock(localVariant, remoteVariant))
    hasConflicts = true
    baseIndex = conflictEnd
    localIndex = localEndIndex
    remoteIndex = remoteEndIndex
  }

  if (baseIndex < base.length) output.push(...base.slice(baseIndex))
  return { lines: output, hasConflicts }
}

export function mergeThreeWay(baseContent: string, localContent: string, remoteContent: string): MergeResult {
  const base = splitLines(baseContent)
  const local = splitLines(localContent)
  const remote = splitLines(remoteContent)
  const merged = mergeLines(base.lines, local.lines, remote.lines)
  // A remote newline is the least surprising output format when the disk
  // version changed only in its newline convention; otherwise retain base.
  const trailingNewline = remote.trailingNewline || (!remote.lines.length && (local.trailingNewline || base.trailingNewline))
  return { content: joinLines(merged.lines, trailingNewline), hasConflicts: merged.hasConflicts }
}

