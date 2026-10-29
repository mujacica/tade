import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { leftIn } from '../src/left.ts'

// What a master still holds once its program has ended. A real master only has
// anything left on Linux (`ending.test.ts` proves that end to end), so each way
// a descriptor answers is held here with a real one that answers it that way.

const where = mkdtempSync(join(tmpdir(), 'tade-left-'))
afterAll(() => rmSync(where, { recursive: true, force: true }))

/** `leftIn` over a descriptor opened on `path`, closed after, and what it said. */
function read(path: string, flags: number | string = 'r') {
  const fd = openSync(path, flags)
  const said: Error[] = []
  try {
    return { rest: leftIn(fd, 'app/agent', (trouble) => said.push(trouble)), said }
  } finally {
    closeSync(fd)
  }
}

describe('what a descriptor still holds', () => {
  it('is all of it, read past one chunk to where it says there is no more', () => {
    const printed = `${'x'.repeat(100_000)}\ngot it\n`
    writeFileSync(join(where, 'printed'), printed)
    expect(read(join(where, 'printed'))).toEqual({ rest: printed, said: [] })
  })

  it('is nothing, and no trouble, where it has nothing for now', () => {
    // An empty pipe that does not block answers EAGAIN, as a master with
    // nothing more for now does.
    const fifo = join(where, 'fifo')
    execFileSync('mkfifo', [fifo])
    expect(read(fifo, constants.O_RDWR | constants.O_NONBLOCK)).toEqual({ rest: '', said: [] })
  })

  it('is said, naming the lane, when it cannot be read', () => {
    const { rest, said } = read(where)
    expect(rest).toBe('')
    expect(said).toHaveLength(1)
    expect(said[0]?.message).toMatch(
      /^the end of what app\/agent printed could not be read: .*EISDIR/,
    )
    expect(said[0]?.cause).toMatchObject({ code: 'EISDIR' })
  })
})
