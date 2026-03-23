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
    // Block spans the conflict-region content in ours/theirs (1-indexed, half-open).
    // ours[2..4) = 'context line','ours only'; theirs[2..4) = 'theirs A','theirs B'.
    expect(r.blocks).toEqual([{ aFrom: 2, aTo: 4, bFrom: 2, bTo: 4 }])
  })

  it('emits one block per conflict region', () => {
    // Two regions → two blocks, each bounded exactly at <<<<<<< / >>>>>>> in
    // ours/theirs coordinates. MergePanel reads these instead of running LCS.
    const raw = [
      'A',
      '<<<<<<<',
      '+++++++ s1',
      'ours1',
      '+++++++ s2',
      'theirs1',
      '>>>>>>>',
      'B',
      '<<<<<<<',
      '+++++++ s1',
      'ours2a',
      'ours2b',
      '+++++++ s2',
      'theirs2',
      '>>>>>>>',
      'C',
    ].join('\n')
    const r = reconstructSides(raw)!
    // ours = A,ours1,B,ours2a,ours2b,C ; theirs = A,theirs1,B,theirs2,C
    expect(r.blocks).toEqual([
      { aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 },
      { aFrom: 4, aTo: 6, bFrom: 4, bTo: 5 },
    ])
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

  it('added line of 6+ chars in diff section does NOT false-positive as +++++++ marker', () => {
    // Inside %%%%%%% diff, added lines get a single `+` prefix. A content line
    // of 6 `+` chars becomes `+++++++` (7 total) which MATCHES the snapshot
    // marker pattern. Without mode!=='diff' gate, parser misreads diff-content
    // as a snapshot section start → wrong sideNum, wrong output.
    const raw = [
      '<<<<<<<',
      '%%%%%%% s1',
      ' ctx',
      '+++++++',    // ← added line: content is 6 plusses, diff-prefixed = 7 plusses
      '+++++++ s2',  // ← THIS is the real snapshot marker (outside diff mode)
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    // ours should contain ctx + the 6-plus line (diff-added content)
    expect(r.ours).toBe('ctx\n++++++')
    expect(r.base).toBe('ctx')
    expect(r.theirs).toBe('theirs')
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

  it('escalated region: shorter `<` run inside is content, NOT nested-null', () => {
    // jj escalated to 8 chars because file has 7-char `<<<<<<<` line. That
    // line appears INSIDE the region (snapshot content). Previously M_START
    // {7,} re-matched it → `inRegion=true` already → `return null` → false
    // fallback to raw editor. The mLen guard treats <mLen runs as content.
    const raw = [
      '<<<<<<<<',             // 8-char start (escalated)
      '++++++++ s1',
      '<<<<<<<',              // CONTENT: 7-char run, <mLen=8 → not a marker
      'ours rest',
      '++++++++ s2',
      'theirs',
      '>>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.ours).toBe('<<<<<<<\nours rest')
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

describe('reconstructSides — SideRef parsing', () => {
  // jj emits `changeId commitId "description"` when it can attribute a side.
  // change_id uses [k-z] alphabet (disambiguates from hex commit_id).

  it.each([
    // [marker-label-text, expected-ref | undefined]
    ['wlykovwr 562576c8 "commit msg"',           { changeId: 'wlykovwr', commitId: '562576c8' }],
    ['diff to: xyzmnopq 99aabbcc "to commit"',   { changeId: 'xyzmnopq', commitId: '99aabbcc' }],
    ['diff from: klmnopqr 12345678 "from"',      { changeId: 'klmnopqr', commitId: '12345678' }],
    ['Contents of side #1',                      undefined],
    ['Changes from base to side #2',             undefined],
    ['abc12345 562576c8 "hex-like changeId"',    undefined],  // change_id must be [k-z]
    ['wlykovwr nothex "non-hex commit"',         undefined],
  ])('parses %j → %j', (label, expected) => {
    const raw = [
      'common',
      '<<<<<<<',
      `+++++++ ${label}`,
      'ours',
      '+++++++ theirs-side',
      'theirs',
      '>>>>>>>',
      'common',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.oursRef).toEqual(expected)
  })

  it('both sides get refs independently', () => {
    const raw = [
      '<<<<<<<',
      '+++++++ wlykovwr 562576c8 "ours commit"',
      'ours',
      '+++++++ xyzmnopq 99aabbcc "theirs commit"',
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    expect(r.oursRef).toEqual({ changeId: 'wlykovwr', commitId: '562576c8' })
    expect(r.theirsRef).toEqual({ changeId: 'xyzmnopq', commitId: '99aabbcc' })
  })

  it('\\\\\\\\\\\\\\ "to:" ref overrides %%%%%%% "from:" ref (same as label precedence)', () => {
    const raw = [
      '<<<<<<<',
      '%%%%%%% diff from: zzzzzzzz 11111111 "base — should NOT be oursRef"',
      '\\\\\\\\\\\\\\ diff to: wlykovwr 562576c8 "ours — the real ref"',
      ' ctx',
      '-old',
      '+new',
      '+++++++ xyzmnopq 99aabbcc "theirs"',
      'theirs',
      '>>>>>>>',
    ].join('\n')
    const r = reconstructSides(raw)!
    // The "to:" ref is what :ours keeps → that's the one MergePanel should show.
    expect(r.oursRef?.changeId).toBe('wlykovwr')
  })
})
