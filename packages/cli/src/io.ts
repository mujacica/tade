/** Exit codes shared by every command. */
export const Exit = {
  ok: 0,
  error: 1,
  invalidInput: 2,
} as const

export interface Io {
  out: (line: string) => void
  err: (line: string) => void
}

export const defaultIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
}
