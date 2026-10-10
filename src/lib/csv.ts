/** Escape a CSV cell and neutralize spreadsheet formulas in user-controlled text. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (s === '') return ''
  if (/^[\t ]*[=+\-@]/.test(s)) s = `'${s}`
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function sanitizeCsvFilename(name: string | null | undefined, maxLen = 64): string {
  const safe = (name ?? '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'ledger'
  return safe.replace(/^[ .]+|[ .]+$/g, '').slice(0, maxLen) || 'ledger'
}
