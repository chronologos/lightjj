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
