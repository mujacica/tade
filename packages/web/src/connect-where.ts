import type { Surface } from './surface.ts'

// Where this machine's guided pages that connect a source answer (REMOTE-TADE
// §6.4, `connected.ts`): the one answer `tade web connect` prints and Settings
// › Intake draws, so the terminal and the window cannot say two things about
// the same listener.
//
// **The loopback listener and nowhere else**, because the page and its presses
// are `here` routes (`CONNECTS`): a `lan` bind has no listener that is this
// machine, so they answer nowhere, and on the public name they are the `404`
// of a path nobody built. So the answer is never a public name or a LAN
// address — a link that leads to a refusal is worse than a sentence saying
// why — and from another machine the way in is the SSH forward, which is the
// reach that can already edit `config.yaml`.

/** Where they answer and how to get there, or why they answer nowhere. */
export type ConnectWhere = { url: string; how: string } | { url: null; why: string }

/** Said where the away view is off: nothing serves the pages at all. */
export const CONNECT_OFF =
  'the away view serves them, and it is off: `tade web on`, or Away view in Settings'

/** Said where it listens on the network: no listener there is this machine. */
export const CONNECT_ON_LAN =
  'the away view listens on the network, where nothing is this machine, so they answer nowhere: `tade web on` without --lan puts it back on this machine alone'

/**
 * Where the guided pages answer for this surface. `listening` is the window's
 * answer about its own listener, which a shell cannot ask: a port another
 * program held is a page that would not open, said rather than linked to.
 */
export function connectWhere(
  surface: Pick<Surface, 'enabled' | 'bind' | 'port'>,
  listening = true,
): ConnectWhere {
  if (!surface.enabled) return { url: null, why: CONNECT_OFF }
  if (surface.bind === 'lan') return { url: null, why: CONNECT_ON_LAN }
  if (!listening) {
    return {
      url: null,
      why: `nothing is listening on port ${surface.port} here: Away view in Settings says why`,
    }
  }
  const port = surface.port
  return {
    url: `http://localhost:${port}/connect`,
    how: `here, or from another machine through \`ssh -L ${port}:localhost:${port}\``,
  }
}
