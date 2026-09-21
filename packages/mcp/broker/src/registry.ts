import {
  type MakeTransport,
  McpError,
  type McpTransport,
  type TransportOptions,
} from '@tade/mcp-core'
import { makeScriptedTransport } from '@tade/mcp-scripted'

// The transports there are, by name: the one registry every call site goes
// through, so adding a way of reaching a server is an implementation and a
// line here — never a `new` somewhere that assumed a server was always a
// program on this machine.
//
// It lives here rather than beside the port because a port must not import
// its own implementations, and the broker is the lowest thing that needs
// one: it is the only place that knows both vocabularies, and everything
// above it — the window, the CLI — reaches a server through it. That is
// where `status/src/forges.ts` puts the forges, for the same reason.
//
// `scripted` is registered and chosen for nobody: a server that answers
// whatever you wrote down is what the conformance suite, the broker's own
// tests and every harness test run on, so whoever wants it names it.

export const MCP_TRANSPORTS: Readonly<Record<string, MakeTransport>> = {
  scripted: makeScriptedTransport,
}

/**
 * A transport by name, or the reason there is none called that. The one
 * lookup: nothing anywhere else turns a configured name into an
 * implementation, and nothing anywhere `new`s a concrete one.
 */
export function makeTransport(
  name: string,
  options: TransportOptions = {},
  transports: Readonly<Record<string, MakeTransport>> = MCP_TRANSPORTS,
): McpTransport {
  const make = transports[name]
  if (!make) {
    throw new McpError(
      'unsupported',
      `there is no transport called ${name} (there is ${Object.keys(transports).join(', ')})`,
    )
  }
  return make(options)
}
