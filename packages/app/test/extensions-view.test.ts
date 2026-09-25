import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { SEEN_BY_AGENTS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { pressable, type Target } from '../src/hits.ts'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { extensionSetupPanel, type SetupFieldView } from '../src/panels/extensions/setup.ts'
import {
  type ExtensionsPanel,
  type ExtensionView,
  extensionControls,
  extensionsPanel,
  HARNESS,
  type McpServerOffer,
  SERVERS as SERVERS_ROW,
  WRITTEN,
} from '../src/panels/extensions/state.ts'
import { extensionsScrollable, extensionsSize } from '../src/panels/extensions/view.ts'
import { COLOUR } from '../src/skin.ts'
import type { Drawn } from '../src/ui.ts'

// What the Extensions panel has to be true at every width.
//
// The goldens say what it looks like on the two terminals they were drawn on;
// these say what holds on all the others — that the page says the whole of
// what an extension offers rather than a count of it, that everything it says
// can be reached, and that a credential is never on it.

const jev: ExtensionView = {
  name: 'jev',
  title: 'Jev',
  description: 'Asks a judge bounded questions about diffs, logs, requests, plans and queues.',
  workflow: [
    'Reviews what agents wrote, when nobody has time to: turn the review watch on and every branch that goes quiet is read against the review pack.',
    'Judges anything else in front of you (jev_ask): a diff, an issue list, a failing log.',
  ],
  source: 'built-in',
  state: 'ready',
  problem: null,
  tools: [
    {
      name: 'jev_ask',
      summary: 'Judge anything against questions you write',
      for: ['orchestrator', 'agent'],
    },
    { name: 'jev_grep', summary: 'Grep that reads', for: ['orchestrator', 'agent'] },
    {
      name: 'jev_review',
      summary: 'Read a change against the review pack',
      for: ['orchestrator', 'agent'],
    },
    {
      name: 'jev_findings',
      summary: 'What the review watch has looked at',
      for: ['orchestrator', 'agent'],
    },
    {
      name: 'jev_verdict',
      summary: 'Write down what a finding turned out to be',
      for: ['orchestrator'],
    },
    {
      name: 'jev_read_request',
      summary: 'A second, independent reading of what was asked for',
      for: ['orchestrator'],
    },
    { name: 'jev_plan_check', summary: 'Read a plan before you keep it', for: ['orchestrator'] },
    { name: 'jev_queue_order', summary: 'Suggest what should come first', for: ['orchestrator'] },
  ],
  actions: [
    { id: 'flagged', title: 'What Jev flagged' },
    { id: 'review', title: 'Review the latest commits' },
  ],
  options: [
    { key: 'key', label: 'API key', value: 'tsk_0123456789', have: 'config.yaml', secret: true },
    { key: 'model', label: 'Version', value: 'jev-1.13.0', have: '', secret: false },
  ],
  unknownSettings: [],
  configurable: true,
  folder: null,
  watches: [
    {
      id: 'review',
      title: 'Review what agents change',
      means:
        'When an agent’s branch stops moving, reads its whole diff against what it branched from.',
      every: '10m',
      project: 'checkout',
      on: null,
    },
    {
      id: 'circles',
      title: 'Agents going in circles',
      means: 'Looks at what each agent has been doing, and reads the ones going round.',
      every: '10m',
      project: 'checkout',
      on: 'agents-going-in-circles',
    },
  ],
}

const sentry: ExtensionView = {
  name: 'sentry',
  title: 'Sentry',
  description: 'Reads the errors your projects send to Sentry.',
  workflow: ['Turns an error into work (sentry_fix): an agent in its own worktree.'],
  source: 'built-in',
  state: 'needs setup',
  problem: 'no Sentry token: paste one in, or set $SENTRY_AUTH_TOKEN',
  tools: [
    {
      name: 'sentry_issues',
      summary: "List a project's Sentry issues",
      for: ['orchestrator', 'agent'],
    },
  ],
  actions: [],
  options: [{ key: 'token', label: 'API key', value: '', have: '', secret: true }],
  unknownSettings: ['orgg'],
  configurable: true,
  folder: null,
  watches: [],
}

const broken: ExtensionView = {
  name: 'standup',
  title: 'standup',
  description: 'Reads out what each agent did yesterday.',
  workflow: [],
  source: 'yours',
  state: 'broken',
  problem: "SyntaxError: Unexpected token '!'",
  tools: [],
  actions: [],
  options: [],
  unknownSettings: [],
  configurable: false,
  folder: '/Users/me/.tade/extensions/standup',
  watches: [],
}

const off: ExtensionView = {
  name: 'release-notes',
  title: 'release-notes',
  description: 'Drafts release notes from merged work.',
  workflow: [],
  source: 'yours',
  state: 'off',
  problem: 'not turned on',
  tools: [],
  actions: [],
  options: [],
  unknownSettings: [],
  configurable: false,
  folder: '/Users/me/.tade/extensions/release-notes',
  watches: [],
}

const EXTENSIONS = [jev, sentry, broken, off]
const WRITTEN_TOOLS = [
  {
    name: 'standup-notes',
    why: 'Reads out what each agent did yesterday.',
    path: '/p/s.ts',
    on: false,
  },
]
const HARNESS_PIECES = [
  { name: 'plan-mode', where: '~/.pi/agent/extensions' },
  { name: 'linear', where: '~/.claude.json (Claude Code)' },
]

/** The catalogue: servers nobody has decided about, each with what it is for. */
const SERVERS: McpServerOffer[] = [
  {
    name: 'github',
    title: 'GitHub',
    description: 'Issues, pull requests and code search on GitHub.',
    workflow: ['Ask about an issue by number and get what it actually says.'],
    how: 'https://api.githubcopilot.com/mcp/',
    needs: 'github needs a credential: paste one, or set $GITHUB_TOKEN',
    install: null,
    note: null,
    fetches: false,
  },
  {
    name: 'sqlite',
    title: 'SQLite',
    description: 'Read a database that is a file.',
    workflow: [],
    how: 'mcp-server-sqlite',
    needs: null,
    install: 'pipx install mcp-server-sqlite',
    note: null,
    fetches: false,
  },
]

/** One somebody turned on, as the page shows a live source of tools. */
const SERVER_ON: ExtensionView = {
  name: 'mcp-linear',
  title: 'Linear',
  description: 'Issues in Linear. From the MCP server `linear`, which nobody here wrote.',
  workflow: ['Ask about an issue by its number.'],
  source: 'mcp',
  state: 'ready',
  problem: null,
  tools: [{ name: 'mcp_linear_search', summary: 'Find an issue', for: ['agent', 'orchestrator'] }],
  actions: [],
  options: [],
  unknownSettings: [],
  configurable: false,
  folder: null,
  watches: [],
  server: {
    name: 'linear',
    how: 'npx linear-mcp --stdio',
    on: true,
    decided: true,
    install: null,
    note: null,
    asked: '2026-09-21T08:00:00.000Z',
    dropped: [{ name: 'weird', why: 'its parameters are not an object' }],
    // A command of somebody's own that downloads its code at every start,
    // said beside it rather than refused.
    fetches: true,
    theirs: { mcp_linear_search: 'searchIssues' },
  },
}

/** One somebody turned off: never connected, so there is nothing else to say. */
const SERVER_OFF: ExtensionView = {
  ...SERVER_ON,
  name: 'mcp-postgres',
  title: 'Postgres',
  description: 'Read a database’s schema and query it.',
  workflow: [],
  state: 'off',
  tools: [],
  server: {
    name: 'postgres',
    how: 'mcp-server-postgres',
    on: false,
    decided: true,
    install: 'npm install --global @modelcontextprotocol/server-postgres',
    note: null,
    asked: null,
    dropped: [],
    fetches: false,
    theirs: {},
  },
}

const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 120,
    height: 34,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    home: '~/.tade',
    route: null,
    spend: null,
    panes: [],
    project: 'checkout',
    date: (at: number) => new Date(at).toISOString().slice(0, 10),
    items: [],
    changes: [],
    ahead: null,
    branch: null,
    base: null,
    diff: null,
    choices: [],
    settings: [],
    accounts: [],
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 0,
    levels: [],
    openRows: [],
    browsing: null,
    homeDir: '/Users/me',
    entries: [],
    searching: false,
    viewing: null,
    talkKey: 'ctrl+space',
    talkMode: 'hold',
    bindings: {},
    running: 0,
    branches: [],
    checkout: null,
    found: 0,
    terminalName: 'terminal',
    extensions: EXTENSIONS,
    harnessExtensions: HARNESS_PIECES,
    servers: SERVERS,
    written: WRITTEN_TOOLS,
    extensionView: null,
    setup: null,
    extensionsRoot: '~/.tade/extensions',
    models: [],
    modelTarget: 'the orchestrator',
    currentModel: null,
    ...over,
  }) as PanelContext

const facts = {
  skin: COLOUR,
  extensions: EXTENSIONS,
  written: WRITTEN_TOOLS,
  harnessExtensions: HARNESS_PIECES,
  servers: SERVERS,
  project: 'checkout',
  date: (at: number) => new Date(at).toISOString().slice(0, 10),
}

const drawnAt = (panel: ExtensionsPanel, over: Partial<PanelContext> = {}): Drawn =>
  drawPanel(panel, context(over)).panel

const plainRows = (drawn: Drawn) => drawn.rows.map((row) => stripTerminalSequences(row))

/** Everything the panel says about one extension, read by scrolling to the end of it. */
function wholePage(panel: ExtensionsPanel, over: Partial<PanelContext> = {}): string {
  const ctx = { width: 120, height: 34, ...over }
  const most = extensionsScrollable(panel, facts, ctx.width, ctx.height).body
  const { room } = extensionsSize(ctx.width, ctx.height)
  const said: string[] = []
  for (let scroll = 0; ; scroll = Math.min(most, scroll + room)) {
    said.push(...plainRows(drawnAt({ ...panel, scroll, following: false }, over)))
    if (scroll >= most) break
  }
  return said.join('\n')
}

/** The widths worth trying: from a terminal nobody should use to a wide one. */
const WIDTHS = [40, 48, 56, 64, 72, 80, 96, 104, 120, 160]

describe('the extensions page at any width', () => {
  it('draws a box of one width, whatever the terminal is', () => {
    for (const width of WIDTHS) {
      for (const chosen of ['jev', 'sentry', 'standup', 'release-notes', WRITTEN, HARNESS]) {
        const drawn = drawnAt(extensionsPanel(chosen), { width, height: 26 })
        const widths = new Set(plainRows(drawn).map((row) => visibleWidth(row)))
        expect([...widths], `${chosen} at ${width}`).toHaveLength(1)
        expect([...widths][0], `${chosen} at ${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('never puts a click where the panel is not', () => {
    for (const width of WIDTHS) {
      const drawn = drawnAt({ ...extensionsPanel('jev'), focus: 'body' }, { width, height: 26 })
      const panelWidth = visibleWidth(plainRows(drawn)[0] ?? '')
      for (const hit of drawn.hits) {
        expect(hit.from, `at ${width}`).toBeGreaterThanOrEqual(0)
        expect(hit.to, `at ${width}`).toBeLessThan(panelWidth)
        expect(hit.row, `at ${width}`).toBeLessThan(drawn.rows.length)
      }
    }
  })

  it('says every tool it has, with what each is for, rather than counting them', () => {
    // The whole reason the page was rebuilt: a heading saying "8 tools" and
    // never which is how an extension that does eight things is read as doing
    // the one thing its watch does.
    for (const width of [80, 120, 160]) {
      const said = wholePage(extensionsPanel('jev'), { width })
      for (const tool of jev.tools) expect(said, `${tool.name} at ${width}`).toContain(tool.name)
      for (const watch of jev.watches) {
        // A long name gives up its end to the button that turns the watch on,
        // and says it did with an ellipsis.
        const name = width >= 96 ? watch.title : watch.title.slice(0, 10)
        expect(said, `${watch.title} at ${width}`).toContain(name)
      }
      expect(said, `at ${width}`).toContain('HOW IT IS USED')
      expect(said, `at ${width}`).toContain('Version')
    }
  })

  it('says what a key is, and where to put one when there is none', () => {
    const said = wholePage(extensionsPanel('jev'))
    expect(said).toContain('tsk_0123456789')
    // And where there is none, where to put one — not a shell profile.
    const missing = wholePage(extensionsPanel('sentry'))
    expect(missing).toContain('not set — Set up…')
    expect(missing).toContain('Set up…')
  })

  it('says of one that is off that nothing in it has run, rather than inventing the rest', () => {
    const said = wholePage(extensionsPanel('release-notes'))
    expect(said).toContain('never imported')
    expect(said).toContain('Turn on')
    // Broken is listed as broken, with the reason, and stops nothing else.
    const bad = wholePage(extensionsPanel('standup'))
    expect(bad).toContain("SyntaxError: Unexpected token '!'")
    expect(bad).toContain('Open folder')
    expect(plainRows(drawnAt(extensionsPanel('standup'))).join('\n')).toContain('Jev')
  })

  it('reaches everything it says by scrolling, and stops at the end of it', () => {
    for (const width of WIDTHS) {
      const panel = extensionsPanel('jev')
      const most = extensionsScrollable(panel, facts, width, 26).body
      const { room } = extensionsSize(width, 26)
      // What is left after the last scroll is exactly the room there is: a
      // page that could be scrolled past its own end has rows nobody can read.
      const last = plainRows(
        drawnAt({ ...panel, scroll: most, following: false }, { width, height: 26 }),
      )
      const beyond = plainRows(
        drawnAt({ ...panel, scroll: most + 5, following: false }, { width, height: 26 }),
      )
      expect(beyond.join('\n'), `at ${width}`).toBe(last.join('\n'))
      expect(room, `at ${width}`).toBeGreaterThan(0)
    }
  })

  it('keeps the control the keyboard is on in view while you tab through them', () => {
    const controls = extensionControls('jev', EXTENSIONS, WRITTEN_TOOLS)
    expect(controls.length).toBeGreaterThan(3)
    controls.forEach((control, index) => {
      const drawn = drawnAt({ ...extensionsPanel('jev'), focus: 'body', index })
      const lit = drawn.hits.some(
        (hit) => hit.target.kind === 'control' && hit.target.id === control,
      )
      expect(lit, control).toBe(true)
    })
  })

  it('lights everything that can be clicked', () => {
    const panel = { ...extensionsPanel('jev'), focus: 'list' as const }
    const rest = drawnAt(panel)
    const targets: Target[] = []
    for (const hit of rest.hits) {
      if (!pressable(hit.target) || hit.target.kind !== 'control') continue
      // The one you are on is already lit, by being the one you are on.
      if (hit.target.id === 'pick:jev') continue
      if (!targets.some((one) => JSON.stringify(one) === JSON.stringify(hit.target)))
        targets.push(hit.target)
    }
    expect(targets.length).toBeGreaterThan(3)
    for (const target of targets) {
      const lit = drawnAt(panel, { pointer: { hover: target, pressed: null } })
      expect(lit.rows.join('\n'), JSON.stringify(target)).not.toBe(rest.rows.join('\n'))
    }
  })

  it('draws a bar beside each side, and lets go of neither at the foot', () => {
    // Twenty of them, on a terminal where neither side fits: both scroll.
    const many = [
      ...EXTENSIONS,
      ...Array.from({ length: 16 }, (_, i) => ({ ...off, name: `one-${i}`, title: `one-${i}` })),
    ]
    const panel = { ...extensionsPanel('jev'), listScroll: 4 }
    const drawn = drawnAt(panel, { extensions: many, height: 24 })
    const bars = drawn.hits.filter((hit) => hit.target.kind === 'scrollbar')
    const areas = new Set(bars.map((hit) => (hit.target as { area: string }).area))
    expect([...areas].sort()).toEqual(['panel', 'panel-side'])
    // Each one is a column, and it is the same column on every row it is on.
    for (const area of areas) {
      const mine = bars.filter((hit) => (hit.target as { area: string }).area === area)
      expect(new Set(mine.map((hit) => hit.from)).size, area).toBe(1)
      expect(
        mine.every((hit) => hit.from === hit.to),
        area,
      ).toBe(true)
      expect(mine.length, area).toBeGreaterThan(4)
    }
    // And one thumb: a run of the same painted cell, not a box per row.
    const { room } = extensionsSize(120, 24)
    const shown = plainRows(drawn)
    expect(shown.filter((row) => row.includes('█')).length).toBeGreaterThan(0)
    expect(room).toBeGreaterThan(0)
    // The two rows at the foot are the foot: no bar, and Done on the last of
    // them, whatever the page is scrolled to.
    const scrolled = drawnAt(
      { ...panel, scroll: 999, following: false },
      { extensions: many, height: 24 },
    )
    const rows = plainRows(scrolled)
    const foot = rows.length - 2
    expect(rows[foot]).toContain('Done')
    // The page's own bar stops where the page does. The list's runs on beside
    // the foot, because the list does: the two rows at the foot are the
    // right-hand side's, and nothing of the page is drawn over them.
    const page = bars.filter((hit) => (hit.target as { area: string }).area === 'panel')
    expect(page.every((hit) => hit.row < foot)).toBe(true)
    // The row above Done is the foot's other half, and says nothing while
    // nothing is happening: a line of instructions drawn under every
    // extension there is was read once and then never again.
    const { side } = extensionsSize(120, 24)
    expect((rows[foot - 1] ?? '').slice(side + 2).replace(/[│\s]/g, '')).toBe('')
    expect(
      scrolled.hits.some((hit) => hit.target.kind === 'control' && hit.target.id === 'close'),
    ).toBe(true)
  })

  it('gives the wheel over the list the list, and over the page the page', () => {
    const drawn = drawnAt(extensionsPanel('jev'))
    const { side } = extensionsSize(120, 34)
    const scrolls = drawn.hits.filter((hit) => hit.target.kind === 'scroll')
    expect(scrolls.length).toBeGreaterThan(4)
    for (const hit of scrolls) {
      expect((hit.target as { area: string }).area).toBe('panel-side')
      // The side and its bar, and nothing of what is beside them — a column
      // in from the panel's own border. The wheel over the page is the
      // panel's own area, which the window lays under this one.
      expect(hit.from).toBe(1)
      expect(hit.to).toBe(side + 1)
    }
    // And a name in the list is still clickable through it.
    const pick = drawn.hits.filter(
      (hit) => hit.target.kind === 'control' && hit.target.id.startsWith('pick:'),
    )
    expect(pick.length).toBeGreaterThan(3)
    for (const hit of pick) {
      const over = drawn.hits.filter((one) => one.row === hit.row && one.from <= hit.from)
      expect(over.at(-1)?.target.kind).not.toBe('scroll')
    }
  })

  it('offers the catalogue as one row, with every server off and what each needs', () => {
    const said = wholePage(extensionsPanel(SERVERS_ROW))
    expect(said).toContain('none of them on')
    for (const server of SERVERS) {
      expect(said).toContain(server.title)
      expect(said).toContain(server.description)
    }
    // Nothing is installed behind a spinner: the line is shown, and running
    // it is a button that types it into a terminal you are looking at.
    expect(said).toContain('pipx install mcp-server-sqlite')
    expect(said).toContain('Install…')
    expect(extensionControls(SERVERS_ROW, EXTENSIONS, WRITTEN_TOOLS, SERVERS)).toEqual([
      'server:github',
      'install:sqlite',
      'server:sqlite',
    ])
    expect(said).toContain('needs a credential')
    expect(said).toContain('Turn on')
    // One row in the list, not twelve: the list stays findable.
    const rows = plainRows(drawnAt(extensionsPanel(SERVERS_ROW))).join('\n')
    expect(rows).toContain('MCP servers')
    // The clause once over the whole list, never three lines under each of
    // them: what Tade holds a server to is nothing, and every row here has a
    // `Turn on` beside it.
    expect(said).toContain('nothing here holds it')
  })

  it('says of a server that is on where it is, and what the server calls each tool', () => {
    const over = { extensions: [...EXTENSIONS, SERVER_ON] }
    const said = wholePage(extensionsPanel('mcp-linear'), over)
    expect(said).toContain('THE SERVER')
    expect(said).toContain('npx linear-mcp --stdio')
    expect(said).toContain('mcp_linear_search')
    // The server's own name for it, beside Tade's, so its documentation can
    // be read against this page.
    expect(said).toContain('searchIssues')
    // Whose words these are, said where the words are.
    expect(said).toContain('nobody here')
    // What it offered that Tade will not hand on, and why.
    expect(said).toContain('weird is not offered')
    // A command that downloads its code every time it starts says so.
    expect(said).toContain('fetches code from the network')
    // What turning it on means is said where turning it on is the decision,
    // not on every page of every server that is already on forever.
    expect(said).not.toContain('runs as you')
  })

  it('says of a server that is off that it was never connected, and nothing else', () => {
    const over = { extensions: [...EXTENSIONS, SERVER_OFF] }
    const said = wholePage(extensionsPanel('mcp-postgres'), over)
    expect(said).toContain('never connected')
    expect(said).toContain('Turn on')
    expect(said).toContain('npm install --global @modelcontextprotocol/server-postgres')
    // No tools, no version, no "last asked": nothing has asked it anything.
    expect(said).not.toContain('TOOLS')
    expect(said).not.toContain('Last asked')
    // Tade holds somebody else's program to nothing, and this is the row
    // where somebody is about to decide, so this is where that is said.
    expect(said).toContain('runs as you')
    expect(said).toContain('scratch directory of its own')
  })

  it('lists what each harness loads by itself without claiming any of it', () => {
    const said = wholePage(extensionsPanel(HARNESS))
    expect(said).toContain('harness')
    expect(said).toContain('plan-mode')
    // Somebody else's MCP servers are listed where they are, and named as
    // theirs: reading what a harness loads is not adopting it.
    expect(said).toContain('linear')
    expect(said).toContain('~/.claude.json (Claude Code)')
  })

  it('says so when the search matches nothing, rather than showing an empty page', () => {
    const said = plainRows(drawnAt({ ...extensionsPanel(), search: 'nothing like this' })).join(
      '\n',
    )
    // Said once, at the head, in the words that were typed — and not again
    // underneath it.
    expect(said).toContain('Nothing matches “nothing like this”')
    expect(said.match(/Nothing matches/g)).toHaveLength(1)
  })
})

// Pasting a key is the one thing this page does that reaches outside it, and
// `0600` is not the answer to who can read one: agents run as you. So the
// panel says so above the fields, where somebody is deciding — and only where
// there is a key to paste, because on a panel of ordinary settings it would
// be a warning about nothing.
describe('setting one up, where a key is pasted', () => {
  const field = (over: Partial<SetupFieldView> = {}): SetupFieldView => ({
    key: 'token',
    label: 'Auth token',
    help: '',
    placeholder: '',
    kind: 'secret',
    choices: [],
    ...over,
  })

  const setup = (fields: readonly SetupFieldView[]) => ({
    title: 'Sentry',
    state: 'needs-setup',
    problem: 'no Sentry token',
    guide: ['Paste it below.'],
    links: [],
    fields,
  })

  /** What the panel says, read across the wrap: the box's own edges are not words. */
  const said = (fields: readonly SetupFieldView[], width = 120) =>
    plainRows(
      drawPanel(extensionSetupPanel('sentry', []), context({ width, setup: setup(fields) })).panel,
    )
      .map((row) =>
        row
          .replace(/^[│╭╰]/u, '')
          .replace(/[│╮╯]$/u, '')
          .trim(),
      )
      .join(' ')
      .replace(/\s+/gu, ' ')

  it('says who else can read the key, and what to do instead, at every width', () => {
    for (const width of WIDTHS) {
      const page = said([field()], width)
      expect(page, `at ${width}`).toContain(SEEN_BY_AGENTS)
      // A warning with nothing to do about it is one people scroll past, so
      // the way out is in the same breath rather than a page away.
      expect(page, `at ${width}`).toContain('export its variable instead')
    }
  })

  it('says nothing about keys on a panel that asks for none', () => {
    const page = said([field({ key: 'org', label: 'Organization', kind: 'text' })])
    expect(page).not.toContain(SEEN_BY_AGENTS)
    expect(page).toContain('Organization')
  })

  it('never draws the key itself as anything but itself', () => {
    // The other half of the same decision: it is in a file you can read, so
    // hiding it in the field would protect nothing and cost you the check
    // against the console that issued it.
    const page = said([field({ key: 'token' })])
    expect(page).not.toContain('••')
  })
})
