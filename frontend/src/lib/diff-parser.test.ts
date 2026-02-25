import { describe, it, expect } from 'vitest'
import { parseDiffContent, filePathFromHeader } from './diff-parser'

describe('parseDiffContent', () => {
  it('returns empty array for empty input', () => {
    expect(parseDiffContent('')).toEqual([])
  })

  it('parses a single file with one hunk', () => {
    const raw = `Modified regular file src/main.go:
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(1)
    expect(files[0].header).toBe('Modified regular file src/main.go:')
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].header).toBe('@@ -1,3 +1,4 @@')
    expect(files[0].hunks[0].lines).toHaveLength(4)
    expect(files[0].hunks[0].lines[1]).toEqual({ type: 'add', content: '+added' })
  })

  it('parses multiple files', () => {
    const raw = `Modified regular file a.go:
@@ -1,2 +1,2 @@
-old
+new
Added regular file b.go:
@@ -0,0 +1,1 @@
+content`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(2)
    expect(files[0].header).toBe('Modified regular file a.go:')
    expect(files[1].header).toBe('Added regular file b.go:')
  })

  it('attaches --- and +++ lines to file header', () => {
    const raw = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].header).toContain('--- a/foo.ts')
    expect(files[0].header).toContain('+++ b/foo.ts')
  })

  it('classifies context lines correctly', () => {
    const raw = `Modified regular file f.go:
@@ -1,3 +1,3 @@
 context
-removed
+added`
    const files = parseDiffContent(raw)
    const lines = files[0].hunks[0].lines
    expect(lines[0].type).toBe('context')
    expect(lines[1].type).toBe('remove')
    expect(lines[2].type).toBe('add')
  })

  it('handles multiple hunks in one file', () => {
    const raw = `Modified regular file f.go:
@@ -1,2 +1,2 @@
-a
+b
@@ -10,2 +10,2 @@
-c
+d`
    const files = parseDiffContent(raw)
    expect(files[0].hunks).toHaveLength(2)
  })

  it('creates (unknown file) fallback when hunk appears without file header', () => {
    const raw = `@@ -1,1 +1,1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(1)
    expect(files[0].header).toBe('(unknown file)')
    expect(files[0].filePath).toBe('(unknown file)')
  })

  it('handles binary file headers (no hunks)', () => {
    const raw = `Added regular file image.png:
Binary file differs`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(1)
    expect(files[0].header).toContain('Added regular file image.png:')
    expect(files[0].header).toContain('Binary file differs')
    expect(files[0].hunks).toHaveLength(0)
    expect(files[0].filePath).toBe('image.png')
  })

  it('populates filePath on parsed files', () => {
    const raw = `Modified regular file src/main.go:
@@ -1,1 +1,1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].filePath).toBe('src/main.go')
  })

  it('populates filePath with spaces in path', () => {
    const raw = `Modified regular file path with spaces/file.go:
@@ -1,1 +1,1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].filePath).toBe('path with spaces/file.go')
  })

  it('parses hunk line numbers from @@ header', () => {
    const raw = `Modified regular file src/main.go:
@@ -10,5 +12,8 @@
 context
+added`
    const files = parseDiffContent(raw)
    expect(files[0].hunks[0].newStart).toBe(12)
    expect(files[0].hunks[0].newCount).toBe(8)
  })

  it('parses hunk line numbers without count (defaults to 1)', () => {
    const raw = `Modified regular file src/main.go:
@@ -1 +1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].hunks[0].newStart).toBe(1)
    expect(files[0].hunks[0].newCount).toBe(1)
  })

  it('parses new file hunk @@ -0,0 +1,5 @@', () => {
    const raw = `Added regular file new.go:
@@ -0,0 +1,5 @@
+line1
+line2
+line3
+line4
+line5`
    const files = parseDiffContent(raw)
    expect(files[0].hunks[0].newStart).toBe(1)
    expect(files[0].hunks[0].newCount).toBe(5)
  })

  // --- Context expansion: hunk line number parsing ---

  it('parses multiple hunks with gaps between them', () => {
    const raw = `Modified regular file src/main.go:
@@ -1,3 +1,4 @@
 line1
+added1
 line2
 line3
@@ -20,3 +21,4 @@
 line20
+added2
 line21
 line22`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(1)
    expect(files[0].hunks).toHaveLength(2)
    // First hunk starts at line 1 in new file
    expect(files[0].hunks[0].newStart).toBe(1)
    expect(files[0].hunks[0].newCount).toBe(4)
    // Second hunk starts at line 21 — gap of lines 5..20 between hunks
    expect(files[0].hunks[1].newStart).toBe(21)
    expect(files[0].hunks[1].newCount).toBe(4)
  })

  it('parses first hunk not starting at line 1 (gap above)', () => {
    const raw = `Modified regular file src/main.go:
@@ -10,3 +10,4 @@
 line10
+added
 line11
 line12`
    const files = parseDiffContent(raw)
    expect(files[0].hunks).toHaveLength(1)
    // Hunk starts at line 10 — lines 1..9 are not shown (gap above)
    expect(files[0].hunks[0].newStart).toBe(10)
    expect(files[0].hunks[0].newCount).toBe(4)
  })

  it('parses consecutive hunks with no gap (adjacent)', () => {
    // First hunk: newStart=1, newCount=3 → covers lines 1..3
    // Second hunk: newStart=4, newCount=3 → covers lines 4..6 (immediately adjacent)
    const raw = `Modified regular file src/main.go:
@@ -1,3 +1,3 @@
-old1
+new1
 line2
 line3
@@ -4,3 +4,3 @@
 line4
-old5
+new5
 line6`
    const files = parseDiffContent(raw)
    expect(files[0].hunks).toHaveLength(2)
    expect(files[0].hunks[0].newStart).toBe(1)
    expect(files[0].hunks[0].newCount).toBe(3)
    expect(files[0].hunks[1].newStart).toBe(4)
    expect(files[0].hunks[1].newCount).toBe(3)
    // No gap: hunk[0] ends at line 3, hunk[1] starts at line 4
    const hunk0End = files[0].hunks[0].newStart + files[0].hunks[0].newCount
    expect(hunk0End).toBe(files[0].hunks[1].newStart)
  })

  it('parses hunk with large newStart (e.g., line 500)', () => {
    const raw = `Modified regular file src/big.go:
@@ -498,5 +500,6 @@
 line500
 line501
+added
 line502
 line503
 line504`
    const files = parseDiffContent(raw)
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].newStart).toBe(500)
    expect(files[0].hunks[0].newCount).toBe(6)
    expect(files[0].hunks[0].lines).toHaveLength(6)
  })
})

describe('filePathFromHeader', () => {
  it('extracts path from jj-style Modified header', () => {
    expect(filePathFromHeader('Modified regular file src/main.go:')).toBe('src/main.go')
  })

  it('extracts path from jj-style Added header', () => {
    expect(filePathFromHeader('Added regular file new.go:')).toBe('new.go')
  })

  it('extracts path from jj-style Deleted header', () => {
    expect(filePathFromHeader('Deleted regular file old.go:')).toBe('old.go')
  })

  it('extracts path from git-style header', () => {
    expect(filePathFromHeader('diff --git a/src/foo.ts b/src/foo.ts')).toBe('src/foo.ts')
  })

  it('returns first line for unrecognized format', () => {
    expect(filePathFromHeader('something unexpected')).toBe('something unexpected')
  })

  it('handles multi-line header (uses first line only)', () => {
    expect(filePathFromHeader('Modified regular file f.go:\n--- a/f.go')).toBe('f.go')
  })

  it('extracts path from Renamed header', () => {
    expect(filePathFromHeader('Renamed regular file old.go:')).toBe('old.go')
  })

  it('extracts path from Copied header', () => {
    expect(filePathFromHeader('Copied regular file copy.go:')).toBe('copy.go')
  })

  it('extracts path with spaces', () => {
    expect(filePathFromHeader('Modified regular file path with spaces/file.go:')).toBe('path with spaces/file.go')
  })

  it('uses destination (b/) path for git-style copy/rename headers', () => {
    // Copies produce "diff --git a/source b/destination" where source != destination.
    // Using the b/ path avoids duplicate keys when the same source is copied to multiple destinations.
    expect(filePathFromHeader('diff --git a/src/old.go b/pkg/new.go')).toBe('pkg/new.go')
  })

  it('extracts git-style path with spaces', () => {
    expect(filePathFromHeader('diff --git a/path with spaces/file.ts b/path with spaces/file.ts')).toBe('path with spaces/file.ts')
  })
})
