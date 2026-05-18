import { describe, it, expect } from 'vitest'
import { parseDiffContent, filePathFromHeader, newSideAddedLines, expandTabs, hunkIndexForLine, oldCount } from './diff-parser'

describe('expandTabs', () => {
  it('passes through tab-free strings unchanged', () => {
    expect(expandTabs('hello world')).toBe('hello world')
    expect(expandTabs('')).toBe('')
  })

  it('expands leading tab to full width at column 0', () => {
    expect(expandTabs('\tfoo')).toBe('    foo')
    expect(expandTabs('\t\tfoo')).toBe('        foo')
  })

  it('expands mid-line tab to next tab stop', () => {
    expect(expandTabs('a\tb')).toBe('a   b')
    expect(expandTabs('ab\tc')).toBe('ab  c')
    expect(expandTabs('abc\td')).toBe('abc d')
    expect(expandTabs('abcd\te')).toBe('abcd    e')
  })

  it('respects custom tab width', () => {
    expect(expandTabs('\tx', 8)).toBe('        x')
    expect(expandTabs('ab\tx', 2)).toBe('ab  x')
  })
})

describe('parseDiffContent tab expansion', () => {
  it('expands tabs in source content, not in the diff marker (issue #9)', () => {
    const raw = [
      'Modified regular file main.go:',
      '@@ -1,2 +1,2 @@',
      '+\tfoo',
      '-\t\tbar',
      ' \tbaz',
      '+nospace',
    ].join('\n')
    const lines = parseDiffContent(raw)[0].hunks[0].lines
    expect(lines[0]).toEqual({ type: 'add', content: '+    foo', raw: '+\tfoo' })
    expect(lines[1]).toEqual({ type: 'remove', content: '-        bar', raw: '-\t\tbar' })
    expect(lines[2]).toEqual({ type: 'context', content: '     baz', raw: ' \tbaz' })
    expect(lines[3]).toEqual({ type: 'add', content: '+nospace' }) // no raw when no tabs
  })
})

describe('parseDiffContent', () => {
  it('returns empty array for empty input', () => {
    expect(parseDiffContent('')).toEqual([])
  })

  it('returns empty array for newline-only input', () => {
    // The trailing-'' pop guard short-circuits the degenerate single-newline
    // case to an empty array, same as empty input.
    expect(parseDiffContent('\n')).toEqual([])
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
    expect(files[0].isBinary).toBe(true)
  })

  it('populates filePath on parsed files', () => {
    const raw = `Modified regular file src/main.go:
@@ -1,1 +1,1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].filePath).toBe('src/main.go')
    expect(files[0].isBinary).toBe(false)
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
    // newCount is reconciled from actual parsed lines (not the header's
    // claimed count) — context-expand uses newStart+newCount for gap bounds.
    const raw = `Modified regular file src/main.go:
@@ -10,5 +12,3 @@
 context
+added
 trailing`
    const files = parseDiffContent(raw)
    expect(files[0].hunks[0].newStart).toBe(12)
    expect(files[0].hunks[0].newCount).toBe(3)
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

  it('parses sourcePath from git-style rename header', () => {
    // Pure rename: jj diff --tool :git emits `rename from`/`rename to` with no hunks.
    // sourcePath feeds Discard — passing only dest to `jj restore -c` would
    // delete the new path without restoring the old one.
    const raw = `diff --git a/src/old.go b/src/new.go
rename from src/old.go
rename to src/new.go`
    const files = parseDiffContent(raw)
    expect(files).toHaveLength(1)
    expect(files[0].filePath).toBe('src/new.go')
    expect(files[0].sourcePath).toBe('src/old.go')
    expect(files[0].hunks).toHaveLength(0)
    expect(files[0].header).toContain('rename from src/old.go')
  })

  it('leaves sourcePath undefined for non-rename diffs', () => {
    const raw = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-old
+new`
    const files = parseDiffContent(raw)
    expect(files[0].sourcePath).toBeUndefined()
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

// Real `jj diff --tool :git` output captured from a scratch repo. Covers the
// extended-header / metadata-line shapes that the jj-style "Modified regular
// file" tests above don't reach. These are what production actually parses
// (handlers.go always passes --tool :git).
describe('parseDiffContent — :git extended headers', () => {
  it('drops "\\ No newline at end of file" marker (not a content line)', () => {
    // Mis-parsing this as context inflates newCount → context-expand inserts
    // a phantom gap row.
    const raw = `diff --git a/no-newline.txt b/no-newline.txt
index e64015c0c3..26e4ff4f04 100644
--- a/no-newline.txt
+++ b/no-newline.txt
@@ -1,3 +1,3 @@
 line1
-line2
+MODIFIED
 line3
\\ No newline at end of file`
    const f = parseDiffContent(raw)[0]
    expect(f.filePath).toBe('no-newline.txt')
    expect(f.hunks[0].lines).toHaveLength(4)
    expect(f.hunks[0].newCount).toBe(3) // line1, MODIFIED, line3 — NOT 4
    expect(f.hunks[0].lines.map(l => l.type)).toEqual(['context', 'remove', 'add', 'context'])
  })

  it('mode-change-only: old/new mode lines, no hunks', () => {
    const raw = `diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755`
    const f = parseDiffContent(raw)[0]
    expect(f.filePath).toBe('mode.sh')
    expect(f.hunks).toHaveLength(0)
    expect(f.header).toContain('old mode 100644')
    expect(f.header).toContain('new mode 100755')
  })

  it('git-style binary marker (different from jj-style "Binary file differs")', () => {
    const raw = `diff --git a/image.bin b/image.bin
index f6aa613aa0..e99cea4cf6 100644
Binary files a/image.bin and b/image.bin differ`
    const f = parseDiffContent(raw)[0]
    expect(f.filePath).toBe('image.bin')
    expect(f.hunks).toHaveLength(0)
    expect(f.header).toContain('Binary files a/image.bin and b/image.bin differ')
    expect(f.isBinary).toBe(true)
  })

  it('new file: new file mode + --- /dev/null', () => {
    const raw = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000000..03a0d6dfaf
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,1 @@
+NEW`
    const f = parseDiffContent(raw)[0]
    expect(f.filePath).toBe('newfile.txt')
    expect(f.header).toContain('new file mode 100644')
    expect(f.header).toContain('--- /dev/null')
    expect(f.hunks[0].lines).toEqual([{ type: 'add', content: '+NEW' }])
  })

  it('deleted file: deleted file mode + +++ /dev/null', () => {
    const raw = `diff --git a/deleted.txt b/deleted.txt
deleted file mode 100644
index ce01362503..0000000000
--- a/deleted.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-hello`
    const f = parseDiffContent(raw)[0]
    expect(f.filePath).toBe('deleted.txt')
    expect(f.header).toContain('deleted file mode 100644')
    expect(f.header).toContain('+++ /dev/null')
    expect(f.hunks[0].lines).toEqual([{ type: 'remove', content: '-hello' }])
  })

  it('hunk header with trailing function context', () => {
    // jj :git includes the surrounding line after the second @@; the regex
    // is start-anchored only so the trailer is ignored for newStart/newCount.
    const raw = `diff --git a/f.go b/f.go
--- a/f.go
+++ b/f.go
@@ -47,2 +47,2 @@ func Fragment(node, context) {
-old
+new`
    const h = parseDiffContent(raw)[0].hunks[0]
    expect(h.newStart).toBe(47)
    expect(h.newCount).toBe(1)
    expect(h.header).toBe('@@ -47,2 +47,2 @@ func Fragment(node, context) {')
  })

  it('UTF-8 path (jj emits raw, not C-quoted)', () => {
    const raw = `diff --git a/üñî.txt b/üñî.txt
index ce01362503..14be0d41c6 100644
--- a/üñî.txt
+++ b/üñî.txt
@@ -1,1 +1,1 @@
-hello
+hello2`
    expect(parseDiffContent(raw)[0].filePath).toBe('üñî.txt')
  })

  it('index line attaches to header (not swallowed into hunk)', () => {
    const raw = `diff --git a/f.txt b/f.txt
index abc123..def456 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-a
+b`
    const f = parseDiffContent(raw)[0]
    expect(f.header).toContain('index abc123..def456 100644')
    expect(f.hunks[0].lines).toHaveLength(2)
  })

  it('removed line whose content starts with -- is a hunk line, not a file marker', () => {
    // `--counter`, Lua/SQL/Haskell `--` comments etc render as `---…` in
    // unified diff. The `---`/`+++` file-marker branch must be gated on
    // !currentHunk or these lines disappear from the diff and skew newCount.
    const raw = `diff --git a/f.lua b/f.lua
--- a/f.lua
+++ b/f.lua
@@ -1,3 +1,2 @@
 keep
--- a comment was here
 keep2`
    const f = parseDiffContent(raw)[0]
    expect(f.hunks[0].lines).toHaveLength(3)
    expect(f.hunks[0].lines[1]).toEqual({ type: 'remove', content: '--- a comment was here' })
    expect(f.hunks[0].newCount).toBe(2)
    // Real file markers (before @@) still attach to the header.
    expect(f.header).toContain('--- a/f.lua')
    expect(f.header).toContain('+++ b/f.lua')
    expect(f.header).not.toContain('a comment was here')
  })

  it('added line whose content starts with ++ is a hunk line, not a file marker', () => {
    const raw = `Modified regular file f.c:
@@ -1,2 +1,3 @@
 keep
+++counter;
 keep2`
    const f = parseDiffContent(raw)[0]
    expect(f.hunks[0].lines).toHaveLength(3)
    expect(f.hunks[0].lines[1]).toEqual({ type: 'add', content: '+++counter;' })
    expect(f.hunks[0].newCount).toBe(3)
  })

  it('drops the trailing empty string from a newline-terminated diff', () => {
    // jj's `--tool :git` output is newline-terminated; raw.split('\n') leaves
    // a final '' that previously fell through to the hunk branch as a phantom
    // {type:'context', content:''} line, over-counting newCount by 1 in the
    // last hunk and shifting context-expand's trailing-gap boundary.
    const raw = 'Modified regular file f.go:\n@@ -1,2 +1,2 @@\n-old\n+new\n line2\n'
    const f = parseDiffContent(raw)[0]
    expect(f.hunks[0].lines).toHaveLength(3)
    expect(f.hunks[0].lines.map(l => l.type)).toEqual(['remove', 'add', 'context'])
    expect(f.hunks[0].newCount).toBe(2)
  })

  it('does not drop a trailing added-blank-line', () => {
    // `+` alone is a real added blank line. It precedes the trailing '' from
    // the terminating newline; only the latter should be dropped.
    const raw = 'Modified regular file f.go:\n@@ -1,1 +1,2 @@\n keep\n+\n'
    const f = parseDiffContent(raw)[0]
    expect(f.hunks[0].lines).toHaveLength(2)
    expect(f.hunks[0].lines[1]).toEqual({ type: 'add', content: '+' })
    expect(f.hunks[0].newCount).toBe(2)
  })

  it('parse(raw + "\\n") deep-equals parse(raw) — pop is a pure normalization', () => {
    // Locks the invariant: the trailing-newline pop only removes the spurious
    // '' from split() and never alters the parse of the actual content.
    const raw = `diff --git a/f.lua b/f.lua
--- a/f.lua
+++ b/f.lua
@@ -1,3 +1,2 @@
 keep
--- a comment was here
 keep2`
    expect(parseDiffContent(raw + '\n')).toEqual(parseDiffContent(raw))
  })

  it('--/++ content as the LAST hunk line of a newline-terminated diff', () => {
    // The only place the trailing-newline pop and the !currentHunk gate
    // interact: the '' after the final `---…` content line must be dropped,
    // and the `---…` line itself must not be misclassified as a file marker.
    const raw = '@@ -1,2 +1,1 @@\n keep\n--- comment\n'
    const f = parseDiffContent(raw)[0]
    expect(f.hunks[0].lines).toHaveLength(2)
    expect(f.hunks[0].lines[1]).toEqual({ type: 'remove', content: '--- comment' })
    expect(f.hunks[0].newCount).toBe(1)
  })
})

describe('newSideAddedLines', () => {
  const hunk = (newStart: number, types: ('add' | 'remove' | 'context')[]) => ({
    header: '@@', oldStart: 1, newStart, newCount: 0,
    lines: types.map(type => ({ type, content: '' })),
  })

  it('collects add lines, advances on context, skips remove', () => {
    // newStart=5: ctx@5, add@6, rem(no advance), add@7, ctx@8
    const s = newSideAddedLines([hunk(5, ['context', 'add', 'remove', 'add', 'context'])])
    expect([...s].sort()).toEqual([6, 7])
  })

  it('handles multi-hunk — counter resets per hunk', () => {
    const s = newSideAddedLines([
      hunk(1, ['add', 'context']),       // add@1
      hunk(10, ['context', 'add']),      // add@11
    ])
    expect([...s].sort((a, b) => a - b)).toEqual([1, 11])
  })

  it('all-removed hunk yields empty set', () => {
    expect(newSideAddedLines([hunk(1, ['remove', 'remove'])]).size).toBe(0)
  })

  it('empty hunks → empty set', () => {
    expect(newSideAddedLines([]).size).toBe(0)
  })
})

describe('hunkIndexForLine', () => {
  const mk = (oldStart: number, newStart: number, types: ('add' | 'remove' | 'context')[]) => ({
    header: '@@', oldStart, newStart,
    newCount: types.filter(t => t !== 'remove').length,
    lines: types.map(type => ({ type, content: '' })),
  })
  // Hunk 0: old 5-7 (rem,ctx,ctx), new 5-7 (ctx,ctx,add). Hunk 1: old 20-20, new 20-21.
  const hunks = [
    mk(5, 5, ['remove', 'context', 'context', 'add']),
    mk(20, 20, ['context', 'add']),
  ]

  it('new-side: line in first hunk', () => {
    expect(hunkIndexForLine(hunks, 6, 'new')).toBe(0)
  })
  it('new-side: line in second hunk', () => {
    expect(hunkIndexForLine(hunks, 21, 'new')).toBe(1)
  })
  it('new-side: line between hunks → -1', () => {
    expect(hunkIndexForLine(hunks, 15, 'new')).toBe(-1)
  })
  it('new-side: default param is new', () => {
    expect(hunkIndexForLine(hunks, 21)).toBe(1)
  })
  it('old-side uses oldStart + oldCount', () => {
    expect(oldCount(hunks[0])).toBe(3) // rem + ctx + ctx
    expect(hunkIndexForLine(hunks, 5, 'old')).toBe(0)
    expect(hunkIndexForLine(hunks, 7, 'old')).toBe(0)
    expect(hunkIndexForLine(hunks, 8, 'old')).toBe(-1)
  })
  it('empty hunks → -1', () => {
    expect(hunkIndexForLine([], 1)).toBe(-1)
  })
})
