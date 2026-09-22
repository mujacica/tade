import type { AuthKind, ServerScope } from './port.ts'

// The servers Tade knows about, listed and off.
//
// It ships in code, the way `BUILTIN_EXTENSIONS` does, and not as files
// written into everybody's home: a catalogue in the home cannot be corrected
// by an upgrade, and a stale entry pointing at a moved package is worse than
// no entry at all. What a person writes in `mcp.servers.<name>` and what is
// here are merged by name — the catalogue fills in what they did not write —
// and a name they wrote a `command` for is theirs from then on.
//
// What earns a place: it is widely used; what Tade starts is a program a
// person installs rather than code fetched at every start; it needs at most a
// token; what it does fits in one line; and it does not duplicate something
// Tade already does better through a port of its own.
//
// Deliberately not here, each for a reason worth saying out loud:
//
//   filesystem — agents already have better file tools, and it hands a third
//     party a writable handle Tade's gate can see the call to but not the
//     effect of.
//   fetch — it turns any URL into text a model reads, which is the widest
//     prompt-injection surface there is, on a machine that also has your
//     keys. A person may declare it; Tade will not suggest it.
//   git — Tade *is* what knows about git here, through `--porcelain=v2` and
//     the `Forge` port, and a second opinion about what is committed is
//     exactly the drift `commit_seen` exists to stop.
//   anything whose only sign-in is a browser flow — listed with the sentence
//     about tokens, rather than shipped as an entry that cannot work.

/** One server Tade knows about: everything but whether somebody wants it. */
export interface CatalogueEntry {
  name: string
  title: string
  /** What it is, in a line. */
  description: string
  /** What somebody is doing when they reach for it, as the Extensions page says it. */
  workflow: readonly string[]
  transport: string
  command?: string
  args?: readonly string[]
  url?: string
  env?: Readonly<Record<string, string>>
  header?: Readonly<Record<string, string>>
  auth?: AuthKind
  authName?: string
  /** The environment variables its credential has always been read from, in order. */
  variables?: readonly string[]
  scope?: ServerScope
  /** The line a person runs to get the program. Shown, and run in a lane they watch. */
  install?: string
  /** What is true about it that nobody would guess, said on its page. */
  note?: string
}

/**
 * The catalogue.
 *
 * Every address here is the one its vendor published when the entry was
 * written, and nothing in the suite can check that it still answers — the
 * tests are offline, on purpose. What proves an entry is a person turning it
 * on and Tade dialling it, which is why nothing here is on.
 */
export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    name: 'github',
    title: 'GitHub',
    description: 'Issues, pull requests and code search on GitHub.',
    workflow: [
      'Ask about an issue or a pull request by number and get what it actually says.',
      'Search code across the repositories a token can see, without cloning them.',
      "Tade's own review path is the Forge port; this is for what that deliberately does not do.",
    ],
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'bearer',
    variables: ['GITHUB_MCP_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
    note: 'Reviews, checks and merges are the Forge port’s, not this server’s.',
  },
  {
    name: 'sentry',
    title: 'Sentry (MCP)',
    description: 'Errors, traces and releases in Sentry, as its own server answers them.',
    workflow: [
      'Ask about an issue, a trace or a release in your own words.',
      'Reach the parts of Sentry the Sentry extension does not cover.',
    ],
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'bearer',
    variables: ['SENTRY_MCP_TOKEN', 'SENTRY_AUTH_TOKEN'],
    note: 'Not the Sentry extension: that one is `sentry`, this is `mcp-sentry`.',
  },
  {
    name: 'context7',
    title: 'Context7',
    description: "A library's current documentation, looked up by name and version.",
    workflow: [
      'Ask what a library’s API is now, rather than what a model remembers it being.',
      'Hand an agent the documentation for the version the project actually pins.',
    ],
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    auth: 'bearer',
    variables: ['CONTEXT7_API_KEY'],
  },
  {
    name: 'notion',
    title: 'Notion',
    description: 'Pages and databases in Notion.',
    workflow: [
      'Read the page a decision was written on, without leaving what you are doing.',
      'Look something up in a database your team keeps.',
    ],
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'bearer',
    variables: ['NOTION_TOKEN', 'NOTION_API_KEY'],
  },
  {
    name: 'grafana',
    title: 'Grafana',
    description: 'Dashboards, queries and alerts in Grafana.',
    workflow: [
      'Ask what a dashboard is showing right now, without opening it.',
      'Run a query against the data behind a panel while working on what it measures.',
    ],
    transport: 'http',
    url: 'https://your-grafana/api/plugins/grafana-mcp-app/resources/mcp',
    auth: 'bearer',
    variables: ['GRAFANA_API_KEY', 'GRAFANA_TOKEN'],
    note: 'The URL here is a shape to fill in with your own Grafana.',
  },
  {
    name: 'cloudflare',
    title: 'Cloudflare',
    description: 'Workers, DNS records and logs on Cloudflare.',
    workflow: [
      'Ask what a worker is doing, or what its logs said, while changing it.',
      'Read a zone’s DNS without leaving what you are doing.',
    ],
    transport: 'sse',
    url: 'https://observability.mcp.cloudflare.com/sse',
    auth: 'bearer',
    variables: ['CLOUDFLARE_API_TOKEN'],
    note: 'Cloudflare runs a server per product; this is the observability one.',
  },
  {
    name: 'slack',
    title: 'Slack',
    description: 'Read and post in the channels a token can see.',
    workflow: [
      'Read what was said in a channel about the thing you are working on.',
      'Post where a team is watching, once somebody decided to.',
    ],
    transport: 'http',
    url: 'https://slack.com/api/mcp',
    auth: 'bearer',
    variables: ['SLACK_MCP_TOKEN', 'SLACK_BOT_TOKEN'],
    note: 'Posting is outward-facing: narrow it with `tools`.',
  },
  {
    name: 'postgres',
    title: 'Postgres',
    description: "Read a database's schema and query it.",
    workflow: [
      'Ask what a table actually looks like before writing a migration against it.',
      'Run a read query against a development database while working on the code that writes it.',
    ],
    transport: 'stdio',
    command: 'mcp-server-postgres',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${project}` is the declaration's own placeholder, put in at spawn.
    args: ['${project}'],
    scope: 'project',
    auth: 'env',
    authName: 'DATABASE_URL',
    variables: ['DATABASE_URL'],
    install: 'npm install --global @modelcontextprotocol/server-postgres',
    note: 'Its credential is a connection string, kept where credentials are kept.',
  },
  {
    name: 'sqlite',
    title: 'SQLite',
    description: 'The same, for a database that is a file.',
    workflow: [
      'Ask what is in the database a project ships with.',
      'Check a schema change against the file the tests run on.',
    ],
    transport: 'stdio',
    command: 'mcp-server-sqlite',
    scope: 'project',
    install: 'pipx install mcp-server-sqlite',
  },
  {
    name: 'playwright',
    title: 'Playwright',
    description: 'Drive a real browser.',
    workflow: [
      'Have an agent open the page it just changed and say what it sees.',
      'Reproduce something that only happens in a browser.',
    ],
    transport: 'stdio',
    command: 'mcp-server-playwright',
    install: 'npm install --global @playwright/mcp',
    note: 'Heavy: turning it on means a browser starts when an agent reaches for it.',
  },
]

/** One catalogue entry by name, or null. */
export function catalogued(
  name: string,
  catalogue: readonly CatalogueEntry[] = CATALOGUE,
): CatalogueEntry | null {
  return catalogue.find((one) => one.name === name) ?? null
}
