// ANSI to HTML, for looking at screens outside a terminal.
//
// Only what the window emits: reset, bold, and 256-colour foreground and
// background. Anything else is dropped, which is the honest thing for a page
// meant to show what the window draws rather than to be a terminal.

const CUBE = [0, 95, 135, 175, 215, 255]
const SYSTEM = [
  '#000000',
  '#cd0000',
  '#00cd00',
  '#cdcd00',
  '#0000ee',
  '#cd00cd',
  '#00cdcd',
  '#e5e5e5',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#5c5cff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
]

export function colour256(n: number): string {
  if (n < 16) return SYSTEM[n] ?? '#ffffff'
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  return `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})`
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function ansiToHtml(line: string): string {
  let fg: string | null = null
  let bg: string | null = null
  let bold = false
  let out = ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is a parser of control characters.
  const parts = line.split(/(\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/)
  for (const part of parts) {
    if (part.startsWith('\x1b]')) continue
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2, -1).split(';').map(Number)
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]
        if (code === 0 || Number.isNaN(code)) {
          fg = null
          bg = null
          bold = false
        } else if (code === 1) bold = true
        else if (code === 38 && codes[i + 1] === 5) {
          fg = colour256(codes[i + 2] ?? 7)
          i += 2
        } else if (code === 48 && codes[i + 1] === 5) {
          bg = colour256(codes[i + 2] ?? 0)
          i += 2
        }
      }
      continue
    }
    if (part === '') continue
    const style = [
      fg ? `color:${fg}` : '',
      bg ? `background:${bg}` : '',
      bold ? 'font-weight:700' : '',
    ]
      .filter(Boolean)
      .join(';')
    out += style ? `<span style="${style}">${escapeHtml(part)}</span>` : escapeHtml(part)
  }
  return out
}
