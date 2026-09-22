// A deterministic child process for driver conformance tests.
// Raw mode means the tty does not echo, so captured output is exactly what
// this program prints: one `got:<line>` per line of input.
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)

// Built from a character code: an escape written into a regular expression is
// usually somebody's mistake, and lint says so.
const POINTER_REPORT = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+;\\d+;\\d+[Mm])`, 'g')

let buffer = ''
process.stdout.write(`ready ${process.stdout.columns}x${process.stdout.rows}\r\n`)

process.stdout.on('resize', () => {
  process.stdout.write(`size ${process.stdout.columns}x${process.stdout.rows}\r\n`)
})

process.stdin.on('data', (chunk) => {
  buffer += chunk
  // A pointer report has no newline in it, so it would never complete a line
  // and would sit in the buffer for ever. It is answered on its own, with the
  // escape written out so that a capture can show it was received at all.
  buffer = buffer.replace(POINTER_REPORT, (_all, rest) => {
    process.stdout.write(`saw:<${rest}\r\n`)
    return ''
  })
  let i = buffer.indexOf('\r')
  let j = buffer.indexOf('\n')
  while (i >= 0 || j >= 0) {
    const cut = i >= 0 && (j < 0 || i < j) ? i : j
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line === 'exit') process.exit(0)
    // Colour, for checking that a styled capture keeps it and a plain one does not.
    if (line === 'paint') process.stdout.write('\x1b[38;5;196mred\x1b[0m \x1b[1mbold\x1b[0m\r\n')
    // Take the whole screen and ask for the mouse, the way a program that
    // draws its own interface does: no scrollback for anybody else to move,
    // and the wheel its own to answer.
    if (line === 'screen') {
      process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
      process.stdout.write('\x1b[2J\x1b[Hown screen\r\n')
    }
    // Repaint the whole screen in place, every row of it, leaving nothing
    // blank at the bottom — which is what a program that draws its own
    // interface does between one keystroke and the next, and what a program
    // that only ever *appends* never does. A fixture whose own screen left
    // its last row empty was kinder than Claude Code, whose bottom row always
    // says something, and a window that stopped reading such a lane looked
    // right in every test there was.
    const repainting = line.startsWith('repaint ')
    if (repainting) {
      const said = line.slice('repaint '.length)
      const rows = process.stdout.rows ?? 24
      process.stdout.write('\x1b[2J')
      for (let row = 1; row <= rows; row++) {
        process.stdout.write(`\x1b[${row};1H${said} on row ${row}`)
      }
    }
    // Take the screen and ask only about presses — the narrower of the two
    // ways a program can ask for the mouse, and the one a window may not send
    // movement to: 1000 and no 1002 or 1003.
    if (line === 'presses') {
      process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
      process.stdout.write('\x1b[2J\x1b[Hown screen, presses only\r\n')
    }
    // The same, without asking for the mouse: nobody can scroll this at all.
    if (line === 'quiet') {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[Hown screen, no mouse\r\n')
    }
    // Two painted blocks with plain spaces between them: what a row of
    // buttons is, and where a capture that carries paint across the gap
    // shows up as a band of colour nobody drew.
    if (line === 'gap')
      process.stdout.write('\x1b[48;5;238mone\x1b[0m        \x1b[48;5;238mtwo\x1b[0m\r\n')
    // Never after a repaint: a line printed under one would scroll the screen
    // and leave its bottom row blank, which is the very thing it is here to
    // avoid.
    if (line.length > 0 && !repainting) process.stdout.write(`got:${line}\r\n`)
    // A prompt, and no newline after it: this is where a shell leaves the
    // cursor, and the only way to ask for it on purpose.
    if (line === 'prompt') process.stdout.write('$ ')
    i = buffer.indexOf('\r')
    j = buffer.indexOf('\n')
  }
})
