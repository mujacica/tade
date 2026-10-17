import type { AttachOptions } from '@tade/drivers-core'
import { quote } from './pipe.ts'

// What a terminal somewhere else runs to be shown one lane: a session of its
// own, grouped with the one every lane is a window of.
//
// **Not `tmux attach`.** A session has one current window for every client on
// it, so a second terminal attached to another lane moved the first one there
// too: two agents opened at once were the same agent twice. A session made
// with `new-session -t` shares the windows and keeps a current window of its
// own (the conformance suite opens two at once to hold this).
//
// **It goes when its terminal does**, by a `client-detached` hook on it, so
// nothing is left for `adopt` or a person to find. **Never by
// `destroy-unattached`**, which is what the option is for and which ends the
// whole tmux server — every agent on it — in three runs of eight on 3.4, the
// tmux Ubuntu 24.04 ships (built in a container and measured). The hook ended
// none in ninety rounds of three clients hung up or killed, 3.4 and 3.3a.
//
// **The lane takes the size of the terminal looking at it**, set as a size —
// `resize-window -x -y` at attach and from a `client-resized` hook — because a
// lane keeps the size it was opened at, and a terminal of another size was
// shown it cropped: an agent's input line below the bottom of the screen.
// Never by `window-size latest` or `resize-window -A`, which make the window
// follow its clients and, with the session ending under them, crash 3.4 the
// same way. The size stays the window's own (`manual`), as `resize` leaves it.
//
// **Embedded, it brings nothing of tmux's own**: no status line, no prefix
// key (every key is the agent's; the window it is drawn in is how you leave),
// and the mouse on, so the wheel scrolls tmux's history of the lane and the
// window hands it the notches (`scrolling: lane`). A person at a terminal of
// their own gets tmux as it is, prefix and all.
//
// Every word is quoted for `sh`, which is what runs it here and what a remote
// login shell is when `ssh` hands it over.

/** The lane's size made the terminal's, as tmux runs it once its client is attached. */
const FITTED = 'resize-window -x #{client_width} -y #{client_height}'

/** The line for one lane, on the server `socket`, whose lanes are windows of `session`. */
export function attachLine(
  socket: string,
  session: string,
  lane: string,
  options: AttachOptions = {},
): string {
  const then = (...words: string[]) => [';', ...words]
  return quote([
    'tmux',
    '-L',
    socket,
    'new-session',
    '-t',
    session,
    ...(options.embedded
      ? [
          ...then('set-option', 'status', 'off'),
          ...then('set-option', 'prefix', 'None'),
          ...then('set-option', 'mouse', 'on'),
        ]
      : []),
    ...then('set-hook', 'client-detached', 'kill-session'),
    ...then('set-hook', 'client-resized', `run-shell -C '${FITTED}'`),
    ...then('select-window', '-t', `:${windowName(lane)}`),
    ...then('run-shell', '-C', FITTED),
  ])
}

/** The name a lane's window is opened with: its id, as tmux takes a name. */
export function windowName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane'
}
