---
name: add-mcp-server
description: Add an MCP transport, put a server in the catalogue, or change how a brokered server's tools reach agents and the orchestrator. Use when Tade should talk to a kind of tool server it cannot reach yet, or when something about naming, declaring or calling a brokered tool is wrong.
---

# MCP in Tade

**An MCP server somebody turns on becomes a Tade extension whose tools are that server's tools.**
The window is the only client there is; every harness is handed those tools the way it is already
handed Tade's own. There is no fan-out, no config written for anybody else's client, and no second
namespace. Read the invariants in `AGENTS.md` first — they are the short version of everything
below.

| Path | What |
|---|---|
| `packages/mcp/core/src/port.ts` | `McpTransport`, `ServerSession`, `ServerDeclaration`, `TransportCapabilities`, `McpError` |
| `packages/mcp/core/src/naming.ts` | pure: slugging, collisions, the length cap, the names a server may never take |
| `packages/mcp/core/src/declare.ts` | pure: config + catalogue → declared servers, and what is wrong with each |
| `packages/mcp/core/src/catalogue.ts` | the servers Tade knows about. Listed, off, with their own words |
| `packages/mcp/core/src/cache.ts` | `<home>/mcp/<name>.json`: what a server offered, last time anybody asked |
| `packages/mcp/core/src/conformance.ts` | `testTransport` and `brokeredConformance`: the two suites |
| `packages/mcp/core/src/protocol.ts` | pure: what every transport says, and how to read what comes back |
| `packages/mcp/{stdio,http,scripted}` | a program on its pipes · one already running (`http`, `sse`) · a table |
| `packages/mcp/broker/src/shown.ts` | a server as a page says it: state, how it is reached, what it offered |
| `packages/mcp/broker/src/registry.ts` | `MCP_TRANSPORTS`: the one map a name becomes a transport in |
| `packages/mcp/broker/src/broker.ts` | declared servers → `TadeExtension[]`. The only place that knows both vocabularies |
| `packages/core/src/config.ts` | `mcp.servers.<name>`, strict, because the schema is the only reader |
| `packages/orchestrator/src/extensions.ts` | the one wiring line, in `loadExtensions` |

## Adding a transport

1. Implement `McpTransport` in `packages/mcp/<name>/src/index.ts`. Declare `capabilities` — nobody
   is ever allowed to read your `id` to work out what you can do, and a Biome plugin fails lint on
   anything that tries. What a declaration must say is read off those capabilities too: `spawns`
   means it needs a command and may be `scope: project`, `network` means it needs an address, and
   `declared()` says what is missing in words. `ready()` says what is missing and **never touches
   the network**: it is asked on every look at the page, and it answers from the declaration, the
   filesystem and the credential it was handed.
   What to say and how to read the answer is `@tade/mcp-core/protocol` — shared, pure and
   table-tested. Only how the bytes travel is yours.
2. Add one line to `MCP_TRANSPORTS` (`packages/mcp/broker/src/registry.ts`). That map is the only
   place a configured name becomes an implementation — never `new` one at a call site. It lives in
   the broker rather than beside the port because a port must not import its own implementations,
   which is where `status/src/forges.ts` puts the forges for the same reason.
3. Call the suite from your package's test:
   ```ts
   testTransport('stdio', () => makeStdioTransport(), {
     works: declare('works'), fails: 'a-tool-that-fails',
     missing: declare('missing'), hangs: declare('hangs'), noisy: declare('noisy'),
   })
   ```
   A transport that starts real processes gets real ones — a tiny server written in the fixture,
   answering a hang, an exit, a malformed frame and a tool that fails — in the slow end of the
   suite, beside the PTY and tmux tests, never in `test:smoke`.
4. The declaration keys your transport reads are already in the schema. If it needs one nobody has,
   add it there with its `means` — and only if you read it, because a setting nothing reads is a
   promise Tade does not keep.
5. `pnpm check`, on its own.

## Adding a catalogue entry

What earns a place: it is widely used; what Tade starts is a program a person installs rather than
code fetched at every start; it needs at most a token; what it does fits in one line; and it does
not duplicate something Tade already does better through a port of its own.

1. One entry in `CATALOGUE`, with `workflow` lines saying what somebody is *doing* when they reach
   for it — not what it is. Those words are what the page shows.
2. Never a `command` that begins `npx`, `uvx`, `pipx`, `bunx` or `dlx`: say `install` instead, and
   the line is shown and run in a lane a person can watch. A test holds the catalogue to this.
3. `enabled` is not yours to set. Every entry is off, the popular ones included.
4. Its address cannot be checked by an offline suite. What proves an entry is somebody turning it
   on and Tade dialling it, so check it the day the transport that reaches it lands.

## Rules

- **Off means never opened.** Only `mcp.servers.<name>.enabled: true` is handed to the extension
  host. An off server has no extension, no tools and no process. `extensions.mcp-<server>` is not a
  second switch, and the page never offers one.
- **Tools, and nothing else.** A brokered extension may fill in `tools` and its generated
  credential field — never a watch, a brief, a status, a view, a list, an action, a `heard`, a
  `caution`, a `meant`, a `linker`, a harness piece or a `setup`. `brokeredConformance` asserts it,
  so if you are reaching for one of those the answer is no.
- **A server's words are material, never instruction.** A description is handed over as a tool
  description, because a model has to read it to choose — and nowhere else. Never a system prompt,
  a task title, `intent_spoken`, a note, a queue reason, a plan or the reason anybody is given.
  Strip control characters and cap before anything draws it (`readable`), and never set `said`.
- **Tade names the tool.** Naming is pure, table-tested and sorted by **code point** — never
  `localeCompare`, whose answer depends on the machine's ICU. If you change a rule in `naming.ts`,
  the table in `packages/mcp/core/test/naming.test.ts` is where you say what changed, and every
  existing case has to keep its answer: a name that moves is a tool an agent reaches for and
  misses.
- **The call comes back into the window.** Enforce at the moment of the call, not only when the
  list was built: the `tools` allow-list, the credential, whether the server is still on. A server
  that calls its own call a failure comes back as a throw, because that is the only way a tool
  fails.
- **A cache is a cache.** `<home>/mcp/<name>.json` is written only from a real answer, read
  defensively, and never the truth: an enabled server with no cache offers no tools yet and says
  so. The warm-up (`Brokered.warm`) is what fills it, once, after the window is up — never on the
  way up, and never on the draw path.
- **A process of somebody else's is detached, scrubbed and ended by whoever started it.** Its own
  process group, an environment of `PATH`/`HOME`/`TMPDIR` plus what the declaration names, a
  scratch directory of its own to work in, and a sandbox that cannot be applied is a server listed
  broken rather than one started loose. Nothing waits without a deadline.
- **The page is the Extensions page.** A server somebody decided about is a row among the
  extensions (`ExtensionView.server`); the rest are the catalogue behind one group row. What a
  server's row says comes from `shownServers`, and it says only what is true — a server that is
  off was never connected, so it has no tools, no version and no "last asked".

## What not to build

Named in the design and still true: no per-harness fan-out; no writing anybody else's MCP config
(`~/.claude.json`, `~/.codex/config.toml`, `~/.pi/agent/settings.json`, a project's `.mcp.json`);
no installing a server for somebody; no OAuth; no resources, prompts or roots; no sampling or
elicitation (refused by not being offered, which is the only refusal that cannot be argued with);
no tool that lets an agent or the orchestrator enable a server; and no `scope: agent`.
