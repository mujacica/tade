// A reload is this process starting again, never a second one beside it.
//
// It used to start a new `tade` detached and end: the new one was in a session
// of its own, the shell took the terminal back the moment the old one ended,
// and two programs read one keyboard. Whatever the shell read never reached the
// window, the half of a mouse report or a reply the window read instead was
// typed into the line as numbers and punctuation, and ctrl+c went to the shell.
// A child that is not detached is no better: the shell waits for the process
// it started, not for its children, and takes the terminal back all the same.
//
// The terminal is the process's, so the process is what stays: `execve` puts
// the new window in this one, with its pid, its place in the foreground and
// its standard streams, and the shell never sees anything end. The same pid is
// also why agents still running find the reloaded window: their way back
// (`TADE_SOCKET`) is named after it.
//
// What exiting does is done first, since `execve` does none of it: everything
// listening for `exit` is told (what `runProgram` started, the locks this
// process holds), because a pid that never ends can never be found gone.

/** What starting again needs of the process, which a test may stand in for. */
export interface Again {
  execPath: string
  execArgv: readonly string[]
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  /** Absent where Node has none: Windows. */
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never
  emit(event: 'exit', code: number): unknown
  stderr: { write(text: string): unknown }
  exit(code: number): never
}

/**
 * Run this command again in place of this process, with the arguments and the
 * Node flags it was started with. Call it last: once the window has given the
 * terminal back and everything has closed.
 */
export function startAgain(proc: Again = process as unknown as Again): never {
  if (!proc.execve) {
    proc.stderr.write('Tade cannot start itself again here: run `tade` again.\n')
    return proc.exit(0)
  }
  // What exiting would have run, run here, once: nothing after `execve` is
  // this program.
  proc.emit('exit', 0)
  return proc.execve(proc.execPath, [proc.execPath, ...proc.execArgv, ...proc.argv.slice(1)], {
    ...proc.env,
  })
}
