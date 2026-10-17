import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * The folder a driver's pipe files go in. Made when the first lane needs one,
 * not with the driver: a driver is made just to be asked whether tmux is here
 * (`chooseDriver`, `tade setup --check`), and one that tmux was not here for was
 * never let go of, so it left an empty folder behind each time. Removed by
 * `remove`, after which the next lane makes another.
 */
export class OutputFolder {
  private dir: string | null = null
  private n = 0

  /** A new file for one lane's output. */
  next(): string {
    if (this.dir === null) this.dir = mkdtempSync(join(tmpdir(), 'tade-tmux-'))
    return join(this.dir, `lane-${++this.n}.out`)
  }

  /** Take the folder away, retrying where tmux may still be writing to it. */
  remove(retry: boolean): void {
    if (this.dir === null) return
    const retries = retry ? { maxRetries: 5, retryDelay: 20 } : {}
    rmSync(this.dir, { recursive: true, force: true, ...retries })
    this.dir = null
  }
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
