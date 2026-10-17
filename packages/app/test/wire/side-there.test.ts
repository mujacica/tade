import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema, remoteDocumentPath } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { IntakeIn } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What is pressed down the side while standing in a project on another
// machine, through the whole window — so the press goes through the router, as
// a person's does, rather than calling an action by its name:
//
// - one of its requests, its row in that machine's INTAKE pressed, and the page
//   that only reads in front — labelled with its machine, the request's own
//   words under the label that says whose they are, and approving it said to be
//   that machine's;
// - one of its documents, its row in DOCUMENTS pressed, read here over the link
//   into a copy in this home and opened in the viewer.
//
// The far end is a real away view (`far.ts`) carrying both, and the link the
// scripted one.

const REQUEST: IntakeIn = {
  item: 'github:412',
  source: 'github',
  externalId: 'acme/tade#412',
  project: 'tade',
  state: 'proposed',
  because: 'tade/webhook-load is parked, waiting for a person to approve it',
  grant: 'surfaces.intake.sources.github',
  stamp: { name: 'triage', version: 3 },
  revision: 'r2',
  taken: 'r2',
  hash: 'sha256:00',
  ref: 'acme/tade#412',
  watch: 'intake.github',
  schedule: 'github-issues',
  mode: 'propose',
  attempts: 0,
  tries: 3,
  said: [],
  unsent: [],
  tasks: ['tade/webhook-load'],
  work: [
    {
      task: 'tade/webhook-load',
      parked: true,
      started: false,
      finished: false,
      held: null,
      state: 'parked',
    },
  ],
  run: '',
  at: Date.now() - 60_000,
  approve: 'tade/webhook-load',
  locally: [],
  // Short, so the side's narrow column draws it whole.
  title: 'Dropped',
  who: 'kim',
  url: 'https://github.com/acme/tade/issues/412',
  material: 'The hook drops deliveries under load.',
  materialProblem: '',
  would: null,
}

describe('pressed down the side of a project on another machine', () => {
  let terminal: FakeTerminal
  let home: string
  let root: string
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    home = one.home
    root = one.repo.root
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))

  /** Click the first place a label is drawn on the last frame, top down. */
  function press(label: string, from = 0): void {
    const lines = rows()
    for (let row = from; row < lines.length; row++) {
      const col = lines[row]?.indexOf(label) ?? -1
      if (col >= 0) {
        wired.click(col + 1, row)
        return
      }
    }
    throw new Error(`"${label}" is not on screen`)
  }

  /** The window, linked to a far end called `vps` set up by `ready`, standing in its project tade. */
  async function standingThere(ready: (far: FarEnd) => void): Promise<FarEnd> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    ready(far)
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    await writeFile(
      join(home, 'config.yaml'),
      [
        `projects:\n  app:\n    root: ${root}`,
        'remotes:\n  vps:',
        ...Object.entries(vps).map(([key, value]) => `    ${key}: ${value}`),
        '',
      ].join('\n'),
    )
    await wired.start({
      config: ConfigSchema.parse({ projects: { app: { root } }, remotes: { vps } }),
      remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    })
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    const top = rows()[0] ?? ''
    wired.click(top.indexOf('vps') + 1, 0)
    await until(
      'its projects',
      () =>
        rows()
          .slice(1)
          .some((row) => row.includes('tade')),
      20_000,
    )
    terminal.press('\r')
    return far
  }

  it('opens one of its requests from its INTAKE on a page that only reads, and says approving it is that machine’s', async () => {
    const far = await standingThere((one) => {
      one.intake = [REQUEST]
    })
    await until('its request down the side', () => shown('Dropped'), 20_000)

    press('Dropped', 1)
    await until('the page', () => shown('acme/tade#412 on vps'), 20_000)
    expect(shown('Approving it is vps’s')).toBe(true)
    // Its own words are further down the page, read by scrolling it.
    terminal.press('\x1b[6~')
    terminal.press('\x1b[6~')
    await until('its own words', () => shown('The hook drops deliveries under load.'), 20_000)
    expect(shown('THE REQUEST ITSELF')).toBe(true)
    expect(shown('a Approve')).toBe(false)
    // Nothing here acts on it: a letter is not an approval, and escape closes the page.
    terminal.press('a')
    terminal.press('\x1b')
    await until('the page closed', () => !shown('acme/tade#412 on vps'), 20_000)
    expect(far.acted).toEqual([])
  })

  it('reads one of its documents from its DOCUMENTS into a copy here and opens it in the viewer', async () => {
    const at = new Date().toISOString()
    const text = '# The plan\n\nRing the doorbell on every delivery.\n'
    await standingThere((one) => {
      one.machine = {
        at,
        version: '0.2.3',
        newer: null,
        public: null,
        problems: [],
        schedules: [],
        documents: [
          {
            task: 'tade/plan',
            project: 'tade',
            name: 'PLAN.md',
            state: 'written',
            at,
            bytes: text.length,
            triaged: false,
          },
        ],
      }
      one.documents.set('tade/plan/PLAN.md', { at, text })
    })
    // Offered as a press once it is linked and has said what its work produced.
    await until('its document down the side', () => shown('tade/plan · press'), 20_000)

    press('PLAN.md', 1)
    await until(
      'the document, in the viewer',
      () => shown('Ring the doorbell on every delivery.'),
      20_000,
    )
    // What was opened is a copy in this home, read over the link — never a path there.
    const copy = remoteDocumentPath(home, 'vps', 'tade/plan', 'PLAN.md')
    expect(await readFile(copy, 'utf8')).toBe(text)
  })
})
