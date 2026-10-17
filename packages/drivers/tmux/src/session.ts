import { startServer } from './scope.ts'

// The session every lane is a window of.
//
// It is made once, by whichever lane opens first, and every lane opened while
// it is being made waits for that one (`ensureSession` in `index.ts`). Asked
// for by each open on its own, every open that found no session made one, and
// tmux refused all but the first with `duplicate session`: four lanes opened
// together on a fresh driver were one lane and three errors, every time — and
// opening them together is what a machine starting its agents does.

type Tmux = (args: string[]) => Promise<string>

export interface SessionOptions {
  socket: string
  session: string
  scrollback: number
  cgroup: string
  env: NodeJS.ProcessEnv
  trouble: (problem: Error) => void
}

export function sessionExists(tmux: Tmux, session: string): Promise<boolean> {
  return tmux(['has-session', '-t', session]).then(
    () => true,
    () => false,
  )
}

/** Make the session where there is none, and set what every lane on the server needs. */
export async function makeSession(
  opts: SessionOptions,
  tmux: Tmux,
  cols: number,
  rows: number,
): Promise<void> {
  if (!(await sessionExists(tmux, opts.session))) {
    await startServer(opts, tmux, [
      'new-session',
      '-d',
      '-s',
      opts.session,
      '-n',
      'tade',
      '-x',
      String(cols),
      '-y',
      String(rows),
      // A window that stays, so the session outlives any one lane.
      'sh -c "while :; do sleep 3600; done"',
    ])
  }
  // Our own server, so these are safe to set for everything on it.
  await tmux(['set-option', '-g', 'history-limit', String(opts.scrollback)]).catch(() => {})
  // A finished command leaves a dead pane holding its exit status, which is
  // the only way tmux will tell us what it was.
  await tmux(['set-option', '-wg', 'remain-on-exit', 'on']).catch(() => {})
}
