// A deterministic child process for driver conformance tests.
// Raw mode means the tty does not echo, so captured output is exactly what
// this program prints: one `got:<line>` per line of input.
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)

let buffer = ''
process.stdout.write(`ready ${process.stdout.columns}x${process.stdout.rows}\r\n`)

process.stdout.on('resize', () => {
  process.stdout.write(`size ${process.stdout.columns}x${process.stdout.rows}\r\n`)
})

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i = buffer.indexOf('\r')
  let j = buffer.indexOf('\n')
  while (i >= 0 || j >= 0) {
    const cut = i >= 0 && (j < 0 || i < j) ? i : j
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line === 'exit') process.exit(0)
    if (line.length > 0) process.stdout.write(`got:${line}\r\n`)
    i = buffer.indexOf('\r')
    j = buffer.indexOf('\n')
  }
})
