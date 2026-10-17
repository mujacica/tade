import { compareVersions, parseVersion } from '@tade/core'
import type { AttachOptions, Availability } from '@tade/drivers-core'
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
// **It goes to the lane's window by its id** (`:@3`, the `@3` in the session
// just made), never by a name. A window's name is whatever `setTitle` last
// made it, and a lane retitled was not found by the name it opened with — or
// was found by its first letters in another lane's — and the terminal was
// left on the session's current window: another agent. A bare `@3` would let
// tmux pick any session that has it.
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

/** The line for the lane in `window` (`@3`), on the server `socket`, whose lanes are windows of `session`. */
export function attachLine(
  socket: string,
  session: string,
  window: string,
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
    ...then('select-window', '-t', `:${window}`),
    ...then('run-shell', '-C', FITTED),
  ])
}

/** The name a lane's window is opened with: its id, as tmux takes a name. */
export function windowName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane'
}

/**
 * The oldest tmux this driver works on: `run-shell -C`, which fits a lane to
 * the terminal above, is 3.2's.
 *
 * A floor rather than a second line for older ones. Without `-C` the size can
 * only be fitted by a shell starting another tmux client from inside the
 * server on every resize, on whatever PATH that server was started with. And
 * below 3.0 nothing could write to a lane at all (`send-keys -H`), so there
 * was always a floor; nothing said it. Built in a `node:22` container, the
 * conformance suite passes whole on 3.2a and fails only its attach cases on
 * 3.1c and 3.0a — Debian 11's and Ubuntu 20.04's, both past their support.
 *
 * The driver's `programs` declares the same floor as tmux's `oldest`, so the
 * Programs list in setup and Settings › Updates never tick a tmux that
 * `available()` refuses.
 */
export const OLDEST = '3.2'

/**
 * Whether the tmux that answered `-V` with `said` can hold lanes. Nothing
 * answered is not installed. A tmux that names no version (`tmux master`) is
 * one nobody can tell is too old, and is let be.
 *
 * What is wrong, and never how to install anything: a driver cannot know
 * whether this is a Mac with Homebrew or a server with apt, and setup puts
 * its own line for this machine after the reason — the same one its Programs
 * list offers, out of the `install` this driver declares.
 */
export function availableAs(said: string | null): Availability {
  if (said === null) return { ok: false, reason: 'tmux is not installed' }
  const version = parseVersion(said)
  if (version === null || compareVersions(version, OLDEST) >= 0) return { ok: true }
  return {
    ok: false,
    reason: `${said.trim()} is older than ${OLDEST}, the first that can show a lane in a terminal of its own`,
  }
}
