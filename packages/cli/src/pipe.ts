// A reader that stops reading — `tade web status | head -2` — is the shell
// saying it has enough, not an error: the same quiet end `head` gives `cat`,
// rather than an unhandled EPIPE and a stack trace.
//
// No dependency of its own, because `bin.ts` puts it on stdout before it loads
// anything (see there).

/** What `endsQuietly` listens on: stdout, or anything shaped like it. */
export interface Piped {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  listenerCount(event: 'error'): number
}

/**
 * An EPIPE on `stream` ends the process quietly; any other error is thrown, as
 * Node throws one nobody listens for — but only while nobody else listens.
 *
 * Put on first, before anything else is loaded, so it is the first listener
 * on the stream for good. The window adds its own (`hangingUp`), which takes an
 * error on its terminal for the terminal having gone and closes the window as
 * quitting does. Rethrowing past that one is what TADE-5 and TADE-6 were: the
 * terminal's `write EIO`, thrown out of this listener before `hangingUp` was
 * told, taken by `watchProcess` for a crash — and the restore it ran on the way
 * down wrote to the same terminal and threw again, since nothing had stopped
 * writing to it.
 */
export function endsQuietly(stream: Piped, exit: () => void): void {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') return exit()
    if (stream.listenerCount('error') === 1) throw error
  })
}
