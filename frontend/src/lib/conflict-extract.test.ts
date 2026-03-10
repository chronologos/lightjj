import { describe, it, expect } from 'vitest'
import { reconstructSides } from './conflict-extract'

describe('reconstructSides', () => {
  it('extracts from Diff-style (one %%%%%%% + one +++++++)', () => {
    // Most common jj output: diff section for side #1, snapshot for side #2.
    const raw = [
      'shared header',
      '<<<<<<< Conflict 1 of 1',
      '%%%%%%% Changes from base to side #1',
      ' context line',
      '-base only',
      '+ours only',
      '+++++++ Contents of side #2',
      'theirs A',
      'theirs B',
      '>>>>>>> Conflict 1 of 1 ends',
      'shared footer',
    ].join('\n')

    const r = reconstructSides(raw)!
    expect(r).not.toBeNull()
    expect(r.base).toBe(['shared header', 'context line', 'base only', 'shared footer'].join('\n'))
    expect(r.ours).toBe(['shared header', 'context line', 'ours only', 'shared footer'].join('\n'))
    expect(r.theirs).toBe(['shared header', 'theirs A', 'theirs B', 'shared footer'].join('\n'))
    expect(r.oursLabel).toBe('Changes from base to side #1')
    expect(r.theirsLabel).toBe('Contents of side #2')
  })

  it('extracts from DiffExperimental-style (two %%%%%%% sections) — base NOT doubled', () => {
    // ui.conflict-marker-style = "diff-experimental" emits TWO diff sections,
    // both diffing from the SAME base. Only the first contributes to base[].
    const raw = [
      '<<<<<<<',
      '%%%%%%% from base to side #1',
      ' shared',
      '-base only',
      '+ours only',
      '%%%%%%% from base to side #2',
      ' shared',
      '-base only',
      '+theirs only',
      '>>>>>>>',
    ].join('\n')

    const r = reconstructSides(raw)!
    expect(r.base).toBe('shared\nbase only')  // NOT 'shared\nbase only\nshared\nbase only'
    expect(r.ours).toBe('shared\nours only')
    expect(r.theirs).toBe('shared\ntheirs only')
  })

  it('extracts from Snapshot-style (two +++++++ + one -------)', () => {
    // ui.conflict-marker-style = "snapshot"
    const raw = [
      'pre',
      '<<<<<<< Conflict 1 of 1',
      '+++++++ Contents of side #1',
      'ours',
      '------- Contents of base',
      'base',
      '+++++++ Contents of side #2',
      'theirs',
      '>>>>>>>',
      'post',
    ].join('\n')

    const r = reconstructSides(raw)!
    expect(r.base).toBe('pre\nbase\npost')
    expect(r.ours).toBe('pre\nours\npost')
    expect(r.theirs).toBe('pre\ntheirs\npost')
  })

  it('handles multiple conflict regions with shared spans between them', () => {
    const raw = [
      'A',
      '<<<<<<<',
      '+++++++ side 1',
      'ours1',
      '+++++++ side 2',
      'theirs1',
      '>>>>>>>',
      'B',  // shared between both conflicts
      '<<<<<<<',
      '+++++++ side 1',
      'ours2',
      '+++++++ side 2',
      'theirs2',
      '>>>>>>>',
      'C',
    ].join('\n')

    const r = reconstructSides(raw)!
    expect(r.ours).toBe('A\nours1\nB\nours2\nC')
    expect(r.theirs).toBe('A\ntheirs1\nB\ntheirs2\nC')
    // No ------- or %%%% sections → base gets only the shared spans
    expect(r.base).toBe('A\nB\nC')
  })

  it('returns null for 3+ sides', () => {
    const raw = [
      '<<<<<<<',
      '+++++++ s1',
      'a',
      '+++++++ s2',
      'b',
      '+++++++ s3',  // third side — N-way
      'c',
      '>>>>>>>',
    ].join('\n')
    expect(reconstructSides(raw)).toBeNull()
  })

  it('returns null for git-style markers (<<<<<<< but no jj markers)', () => {
    const raw = [
      '<<<<<<< HEAD',
      'ours',
      '=======',  // git uses =, not jj's % or +
      'theirs',
      '>>>>>>> branch',
    ].join('\n')
    expect(reconstructSides(raw)).toBeNull()
  })

  it('returns null for unterminated region', () => {
    const raw = '<<<<<<<\n+++++++ s1\na\n+++++++ s2\nb'
    expect(reconstructSides(raw)).toBeNull()
  })

  it('returns null for nested/malformed (second <<<<<<< before >>>>>>>)', () => {
    const raw = '<<<<<<<\n+++++++ s1\na\n<<<<<<<\nb'
    expect(reconstructSides(raw)).toBeNull()
  })

  it('handles escalated marker length (8+ chars)', () => {
    // jj escalates if file content already has 7-char marker-lookalikes.
    const raw = [
      'pre',
      '<<<<<<<<',       // 8 chars
      '++++++++ s1',
      'ours',
      '++++++++ s2',
      'theirs',
      '>>>>>>>>',
      'post',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.ours).toBe('pre\nours\npost')
    expect(r.theirs).toBe('pre\ntheirs\npost')
  })

  it('no markers → all three identical (valid, not null)', () => {
    const raw = 'clean file\nno conflicts\n'
    const r = reconstructSides(raw)!
    expect(r.base).toBe(raw)
    expect(r.ours).toBe(raw)
    expect(r.theirs).toBe(raw)
    expect(r.oursLabel).toBe('')
  })

  it('extracts quoted commit descriptions as labels', () => {
    // jj's actual marker format includes commit IDs + quoted descriptions
    const raw = [
      '<<<<<<< Conflict 1 of 1',
      '%%%%%%% Changes from base to side #1',
      '+ours',
      '+++++++ wlykovwr 562576c8 "Side Y: different edit"',
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.oursLabel).toBe('Changes from base to side #1')
    expect(r.theirsLabel).toBe('Side Y: different edit')
  })

  it('prefers \\\\\\\\\\\\\\ "to:" sub-marker label over %%%%%%% "from:" label', () => {
    // %%%%%%% line has "from: <base>" — picking this side keeps the TO state.
    // The \\\\\\\ sub-marker names what :ours actually keeps. Without it, a
    // diff-style side would show the BASE commit's description as the pane header.
    const raw = [
      '<<<<<<< Conflict 1 of 1',
      '%%%%%%% diff from: lpymxuwk 75ef1147 "Base commit"',
      '\\\\\\\\\\\\\\ diff to: abc12345 99887766 "Actual ours commit"',
      ' context',
      '-removed',
      '+added',
      '+++++++ wlykovwr 562576c8 "Theirs commit"',
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.oursLabel).toBe('Actual ours commit')   // NOT "Base commit"
    expect(r.theirsLabel).toBe('Theirs commit')
    // \\\\\\\ line is label-only, not content — should NOT appear in reconstructed sides
    expect(r.ours).toBe('context\nadded')
    expect(r.base).toBe('context\nremoved')
  })

  it('handles %%%%%%% diff section with multi-line changes', () => {
    const raw = [
      '<<<<<<<',
      '%%%%%%% s1',
      ' keep1',
      '-del1',
      '-del2',
      '+add1',
      '+add2',
      '+add3',
      ' keep2',
      '+++++++ s2',
      'x',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.base).toBe('keep1\ndel1\ndel2\nkeep2')
    expect(r.ours).toBe('keep1\nadd1\nadd2\nadd3\nkeep2')
    expect(r.theirs).toBe('x')
  })

  it('returns null for region with only 1 side', () => {
    const raw = '<<<<<<<\n+++++++ s1\nonly\n>>>>>>>'
    expect(reconstructSides(raw)).toBeNull()
  })

  it('normalizes CRLF — sides come out LF-only', () => {
    // Remote merge bug: CRLF file content → split('\n') left \r on line tails →
    // diffBlocks LCS found no matches between visually-identical lines →
    // → arrow copied only a tail subset. Normalization guarantees the LCS
    // (and CM6's doc, which also normalizes) see the same line content.
    const raw = [
      'shared\r',
      '<<<<<<< Conflict 1 of 1\r',
      '+++++++ s1\r',
      'ours\r',
      '+++++++ s2\r',
      'theirs\r',
      '>>>>>>>\r',
      'footer\r',
    ].join('\n')  // CRLF = \r on each line + \n join

    const r = reconstructSides(raw)!
    // Trailing \r → \n means the file HAD a terminating line break → preserved.
    expect(r.ours).toBe('shared\nours\nfooter\n')
    expect(r.theirs).toBe('shared\ntheirs\nfooter\n')
    expect(r.ours.includes('\r')).toBe(false)
    expect(r.theirs.includes('\r')).toBe(false)
    // The real assertion: ours and theirs agree line-for-line on the shared
    // spans. Pre-fix, theirs' 'shared' had \r, ours' would too — but mixed-EOL
    // conflicts (jj markers are LF, content may be CRLF) made them diverge.
    expect(r.ours.split('\n')[0]).toBe(r.theirs.split('\n')[0])
  })

  it('normalizes lone CR — TrimRight(\\n) on CRLF-terminated file leaves trailing \\r', () => {
    // Backend's Run() does bytes.TrimRight(out, "\n") — CRLF file ends with
    // a lone \r after the strip. Pre-fix, that \r survived split('\n') on
    // the last line and CM6 normalized it to \n (phantom line) while
    // theirsLines.length stayed the same → block position mismatch.
    const raw = 'line1\nline2\r'  // lone CR at end
    const r = reconstructSides(raw)!
    // Trailing lone \r → \n → split gives trailing '' — preserved through join
    expect(r.ours).toBe('line1\nline2\n')
    expect(r.ours.includes('\r')).toBe(false)
  })

  it('diff-prefixed dash content does NOT match M_BASE (mode gate)', () => {
    // bughunter bug_025: file line `------` (6 dashes) deleted → jj prefixes
    // `-` → 7 dashes total → matched the old {7,} regex → parser switched to
    // base mode mid-diff, losing subsequent additions. jj doesn't escalate
    // for 6-dash content (only ≥7 triggers), so the exact-length check alone
    // doesn't help here — the mode gate does (M_BASE is Snapshot-style-only;
    // it never appears after %%%%%%% in any jj output).
    const raw = [
      '<<<<<<<',
      '%%%%%%% Changes from base to side #1',
      ' context',
      '-------',   // diff prefix `-` + content `------` = 7 dashes. Mode gate → treated as content.
      '+replacement',
      '+++++++ Contents of side #2',
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.base).toBe('context\n------')   // `-` stripped, `------` pushed to base
    expect(r.ours).toBe('context\nreplacement')
    expect(r.theirs).toBe('theirs')
  })

  it('escalated markers: 7-dash content in snapshot section is NOT a marker', () => {
    // bughunter bug_027: jj escalates because file has 7-dash line. Markers
    // become 8 chars. The 7-dash content line appears verbatim in a snapshot
    // section. Old {7,} regex matched it (7 ≥ 7); exact-length matching
    // (mLen=8) rejects it (7 ≠ 8).
    const raw = [
      '<<<<<<<<',              // 8-char (escalated)
      '++++++++ Side 1',
      'line above',
      '-------',               // CONTENT: 7 dashes. mLen=8 → not a marker.
      'line below',
      '++++++++ Side 2',
      'theirs',
      '>>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.ours).toBe('line above\n-------\nline below')  // ------- preserved
    expect(r.theirs).toBe('theirs')
  })

  it('diff-prefixed plus content does NOT match M_SNAP (escalated case)', () => {
    // bughunter bug_026: `+` prefix + `++++++` content = 7 pluses. With
    // escalated 8-char markers, exact-length matching rejects the 7-char line.
    const raw = [
      '<<<<<<<<',              // 8-char
      '%%%%%%%% Changes from base to side #1',
      ' context',
      '+++++++',               // diff prefix `+` + content `++++++` = 7 pluses. Not 8 → content.
      ' more context',
      '++++++++ Contents of side #2',
      'theirs',
      '>>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.ours).toBe('context\n++++++\nmore context')  // `++++++` (de-prefixed) in ours
    expect(r.theirs).toBe('theirs')
  })

  it('marker-lookalike content OUTSIDE regions is treated as content', () => {
    // `-------` markdown rule, `+++++++` ASCII art, etc. in normal file content
    // should NOT trigger the !inRegion → return null path.
    const raw = [
      '# README',
      '-------',       // markdown horizontal rule — NOT a base marker
      '<<<<<<< Conflict 1 of 1',
      '+++++++ s1',
      'ours',
      '+++++++ s2',
      'theirs',
      '>>>>>>>',
      '%%%%%%%',       // comment-art line — NOT a diff marker
      'footer',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r).not.toBeNull()
    expect(r.ours).toBe('# README\n-------\nours\n%%%%%%%\nfooter')
    expect(r.theirs).toBe('# README\n-------\ntheirs\n%%%%%%%\nfooter')
  })
})
