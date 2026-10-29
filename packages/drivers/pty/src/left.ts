import { readSync } from 'node:fs'
import { codeOf } from './held.ts'

// What a lane's master still holds once its program has ended. On Linux a
// program that prints and ends at once can lose what it printed last: the
// master says it was hung up while those bytes are still on their way to it,
// and libuv takes a hangup after a short read for the end without reading
// again (`uv__stream_io`). So the driver reads the rest itself, ahead of
// node-pty letting the master go. On Ubuntu 22.04, 367 of 400 programs that
// printed 16 KB and ended lost their last line without it, and none with it
// (`ending.test.ts`). On macOS the master has nothing left by then and says so
// at once, which is why `left.test.ts` holds this to real descriptors instead.

/**
 * What `fd` still holds: read until it says there is no more, which on Linux
 * waits for the bytes still on their way to a master. The master does not
 * block, so this is a few system calls. Anything but the two ways a master
 * says it has no more is said, naming the lane, with whatever was read before
 * it.
 */
export function leftIn(fd: number, lane: string, said: (trouble: Error) => void): string {
  const chunk = Buffer.alloc(64 * 1024)
  let rest = ''
  for (;;) {
    let n: number
    try {
      n = readSync(fd, chunk)
    } catch (error) {
      // EIO once the program's end is read, EAGAIN where the master has no
      // more for now: either way, all there was.
      const code = codeOf(error)
      if (code !== 'EIO' && code !== 'EAGAIN')
        said(
          new Error(`the end of what ${lane} printed could not be read: ${error}`, {
            cause: error,
          }),
        )
      return rest
    }
    if (n === 0) return rest
    rest += chunk.toString('utf8', 0, n)
  }
}
