// Diff parsing utilities — extracts structured data from unified diff output

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  content: string
}

export interface DiffHunk {
  header: string
  oldStart: number  // line number where this hunk starts in the old file
  newStart: number  // line number where this hunk starts in the new file
  newCount: number  // number of lines in the new file version
  lines: DiffLine[]
}

export interface DiffFile {
  header: string
  filePath: string
  // Source path for pure renames (from `rename from <path>` in git-diff header).
  // Only present when jj emits an explicit rename record — rename-with-edits
  // decomposes into separate A+D entries instead. Used by Discard to pass BOTH
  // paths to `jj restore -c`: dest-only would delete the new path without
  // restoring the source, turning the rename into a delete.
  sourcePath?: string
  hunks: DiffHunk[]
}

export function parseDiffContent(raw: string): DiffFile[] {
  if (!raw) return []

  const files: DiffFile[] = []
  const lines = raw.split('\n')
  let currentFile: DiffFile | null = null
  let currentHunk: DiffHunk | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('=== ') || line.startsWith('Modified ') || line.startsWith('Added ') || line.startsWith('Deleted ') || line.startsWith('Copied ') || line.startsWith('Renamed ')) {
      // jj uses different diff headers than git
      currentFile = { header: line, filePath: '', hunks: [] }
      files.push(currentFile)
      currentHunk = null
    } else if (line.startsWith('@@')) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      currentHunk = {
        header: line,
        oldStart: hunkMatch ? parseInt(hunkMatch[1]) : 1,
        newStart: hunkMatch ? parseInt(hunkMatch[2]) : 1,
        newCount: hunkMatch ? parseInt(hunkMatch[3] ?? '1') : 1,
        lines: [],
      }
      if (currentFile) {
        currentFile.hunks.push(currentHunk)
      } else {
        currentFile = { header: '(unknown file)', filePath: '(unknown file)', hunks: [currentHunk] }
        files.push(currentFile)
      }
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      // file markers — attach to current file header
      if (currentFile) {
        currentFile.header += '\n' + line
      }
    } else if (currentFile && line.startsWith('rename from ')) {
      currentFile.sourcePath = line.slice('rename from '.length)
      currentFile.header += '\n' + line
    } else if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line })
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', content: line })
      } else {
        currentHunk.lines.push({ type: 'context', content: line })
      }
    } else if (currentFile && line.trim()) {
      // Lines between file header and first hunk (e.g. "Binary file..." or index lines)
      currentFile.header += '\n' + line
    }
  }

  // Compute filePath for each file now that headers are fully assembled
  for (const file of files) {
    if (!file.filePath) {
      file.filePath = filePathFromHeader(file.header)
    }
  }

  return files
}

// Extract file path from diff header for matching with changedFiles.
// Uses the b/ (destination) path from git-style headers to handle copies/renames
// correctly — the a/ path is the source and can appear in multiple diff entries.
export function filePathFromHeader(header: string): string {
  // jj headers: "Modified regular file src/main.go:" or "Added regular file new.go:" etc.
  // Also git-style: "diff --git a/file b/file"
  const firstLine = header.split('\n')[0]
  // Match jj-style: "Modified regular file path/to/file:"
  const jjMatch = firstLine.match(/^(?:Modified|Added|Deleted|Copied|Renamed)\s+(?:regular\s+)?file\s+(.+?)(?::)?$/)
  if (jjMatch) return jjMatch[1]
  // Match git-style: "diff --git a/source b/destination"
  // Use b/ (destination) to avoid duplicate keys on copies/renames
  const gitMatch = firstLine.match(/^diff --git a\/.+? b\/(.+)$/)
  if (gitMatch) return gitMatch[1]
  return firstLine
}
