// Line endings of a file being edited. The editors work in '\n' (CodeMirror,
// ProseMirror and the conflict model all normalize), so whatever writes text back
// must restore what was there — otherwise changing one line of a CRLF file rewrites
// every line of it.

export type Eol = '\n' | '\r\n' | 'mixed'

/** 'mixed' = anything that isn't uniformly LF or uniformly CRLF (incl. lone CR):
 *  no single separator reproduces the file. */
export function detectEol(text: string): Eol {
  if (!text.includes('\r')) return '\n'
  return /(^|[^\r])\n|\r(?!\n)/.test(text) ? 'mixed' : '\r\n'
}

/** Put `eol` back into '\n'-separated text. */
export const withEol = (text: string, eol: '\n' | '\r\n'): string =>
  eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text

/** Why a file can't be edited through the JSON API: invalid UTF-8 arrives as U+FFFD,
 *  and saving would write the replacement characters over the original bytes. */
export const notUtf8Message = (path: string) =>
  `${path} is not valid UTF-8 — editing it here would corrupt it. Use an external editor.`
