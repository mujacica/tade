import { statSync } from 'node:fs'

// How a lane's output gets out of tmux: `pipe-pane` hands what the pane prints
// to `cat`, which appends it to a file of this instance's that the poller
// reads. Two things about that are easy to get wrong, and what a command that
// prints and exits at once said is what either costs: the pipe has to be
// attached in the invocation that opens the window (`open` in `index.ts`), and
// tmux calling a pane dead is not `cat` having written down the last of it
// (`written`, read by `reap`).

/**
 * The `pipe-pane` that writes what a pane prints to `pipe`, and says when it
 * has written the last of it.
 *
 * `cat` ends when tmux closes the pipe — as the pane dies from tmux 3.8, and
 * only with the window before that — and takes the file's write permission
 * away once it has: the one way to say so that adds nothing to the folder. A
 * marker file would be one more entry made after a lane was closed, in a
 * folder `shutdown` may be removing at that moment.
 */
export function piping(window: string, pipe: string): string[] {
  const file = shellArg(pipe)
  return ['pipe-pane', '-O', '-t', window, `cat >> ${file}; chmod a-w ${file}`]
}

/**
 * Whether the `cat` writing `pipe` has written the last of it and ended. A
 * file not there yet is a `cat` that has not started, which is not one that
 * has finished.
 */
export function written(pipe: string): boolean {
  const file = statSync(pipe, { throwIfNoEntry: false })
  return file !== undefined && (file.mode & 0o222) === 0
}

// And how a value gets into tmux whole, through tmux and the shell it hands
// some of them to.

/**
 * An argument tmux reads as itself. tmux ends a command at any argument that
 * ends in `;`, not only at a `;` on its own, so a lane's directory or a value
 * of its environment that ended in one split the call opening it, and what
 * followed was read as a command: `unknown command`. An argument ending in
 * `\;` is tmux's way of saying a `;` that ends nothing.
 */
export function literal(arg: string): string {
  return arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg
}

export function quote(argv: string[]): string {
  return argv.map(shellArg).join(' ')
}

export function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
