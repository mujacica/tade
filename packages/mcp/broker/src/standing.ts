import type { DeclaredServer, McpTrouble, ServerSettings } from '@tade/mcp-core'

// How a server is, in one word, for whoever has room for one word.
//
// Here rather than in the window for the reason `shown.ts` is: what is true
// about a server is the broker's to say, and the window draws it and decides
// nothing. Pure — a declaration and what happened the last time anybody talked
// to it in, a word out — because it is read on the draw path, and anything that
// looked at a process or a clock to answer this would be a poll four times a
// second.
//
// It says only what is known. A server nobody has talked to yet is `unknown`
// and never `on`: the warm-up happens after the window is up, and a light that
// went green before anybody had asked the server anything would be the one
// reassurance this is here to stop.

/**
 * What a strip can say about one server.
 *
 * `broken` and `unreachable` are two different jobs for whoever reads it:
 * broken is something to go and fix — a program that is not installed, a
 * credential nothing has, a declaration that does not say where — and
 * unreachable is a server that was fine and has stopped answering, which is
 * the drop this was built for and usually comes right on its own.
 */
export type ServerState = 'off' | 'unknown' | 'on' | 'unreachable' | 'broken'

/** One server, as a light says it. */
export interface ServerStanding {
  name: string
  state: ServerState
}

/**
 * Which of the two bad words a trouble is.
 *
 * The kinds already carry the distinction, so it is read off them rather than
 * guessed at from a message: `unavailable` is what it needs not being here and
 * `unsupported` is something it was asked that it cannot do — both somebody's
 * to fix — while `timeout` and `gone` are a server that was reachable and is
 * not. A `refused` is the server answering, which is about the call and not
 * about the server, and never reaches here.
 */
function wordFor(trouble: McpTrouble): ServerState {
  return trouble === 'timeout' || trouble === 'gone' ? 'unreachable' : 'broken'
}

/**
 * How one server is: off until somebody turns it on, broken while something
 * about it has to be fixed first, and otherwise whatever came of the last time
 * anybody talked to it.
 *
 * `talked` is `undefined` where nobody has, and `null` where it answered.
 */
export function stateOf(
  server: DeclaredServer,
  talked: McpTrouble | null | undefined,
): ServerState {
  // Off is first and beats everything: a server nobody turned on was never
  // connected, so there is nothing else true about it to say.
  if (!server.declaration.enabled) return 'off'
  if (server.problem !== null) return 'broken'
  if (talked === undefined) return 'unknown'
  return talked === null ? 'on' : wordFor(talked)
}

/**
 * Every server somebody has decided about, with how each is.
 *
 * Decided about either way, which is what `mcp.servers` naming one means — the
 * same reading the page's `decided` is. The catalogue's own that nobody has
 * touched are left out: they are a list of things you *could* turn on, and a
 * lamp each would be a row of dark ones for software nobody here has ever run.
 */
export function standingsOf(
  servers: readonly DeclaredServer[],
  talked: (name: string) => McpTrouble | null | undefined,
  written: Readonly<Record<string, ServerSettings | undefined>> | undefined,
): ServerStanding[] {
  return servers
    .filter((server) => written?.[server.declaration.name] !== undefined)
    .map((server) => ({
      name: server.declaration.name,
      state: stateOf(server, talked(server.declaration.name)),
    }))
}
