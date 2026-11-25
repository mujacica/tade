import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stillsOf, type Visit, type WorldAt } from '../../web/scripts/still.ts'
import { draw } from '../src/view.ts'
import { DESK, PHONE } from '../test/screens/scenarios/away-page.ts'
import { SCENARIOS, type Scenario } from '../test/screens/scenarios.ts'
import { type Box, cropGrid, reel, type Shot, shot } from './ansi-svg.ts'
import { pageReel } from './page-svg.ts'
import { type Grid, toGrid } from './terminal.ts'

// The pictures the README is made of.
//
// Every one is drawn from a scenario the golden tests already protect, so the
// README cannot show a window Tade no longer has: change how something looks,
// run `pnpm screens --assets`, and the page shows the new one. Nothing here is
// taken by hand, and nothing is touched up.
//
// A picture is a scenario and a rectangle of it. The rectangle is the whole
// window where the point is the window, and the panel alone where the point is
// the panel — the same crop a person would make with a screenshot tool, except
// that this one is written down.
//
// **The away view's page is in here too, and it is not a photograph.** A
// browser is deliberately not in this repository's lockfile, so nothing one
// took could be redrawn by `pnpm screens --assets` or held to its bytes by
// `pictures.test.ts`. So the page draws itself instead: `PAGE_REEL` runs the
// page's own `boot.js` and every screen it routes to in a stand-in document
// (`packages/web/scripts/still.ts`), over the projection of a made-up world
// (`scenarios/away-page.ts`), and puts what it built — with the page's own
// stylesheets, pinned to the size it is of — in an SVG's `<foreignObject>`
// (`page-svg.ts`), which the browser showing the README lays out. Bytes that are
// the same on every machine, of a page that changes when the page does. Whether
// the stand-in builds what Chromium builds is `packages/web/scripts/
// browser-stills.ts`'s question, where a browser is on the machine.

export interface Picture {
  /** File name under the pictures folder. */
  file: string
  /** The scenario it is drawn from. */
  scenario: string
  /** Alt text: what somebody who cannot see it is told. */
  about: string
  /**
   * Which part of the screen: a rectangle, or `'panel'` for whatever panel is
   * over the window — which is found by its own border, so a panel that grows
   * a row is still framed rather than cut in half.
   */
  crop?: Box | 'panel'
  /** The caption in the frame's title bar. No title bar, left out. */
  title?: string
}

export interface Reel {
  file: string
  about: string
  title?: string
  /** The frames, in order, with how long each is held in seconds. */
  frames: readonly { scenario: string; hold: number }[]
}

/**
 * The demo at the top of the README: one request, from asking to what its work
 * came to.
 *
 * It ends on the agent's ACTIONS tab — its own commits, the review it is out
 * for and the project's checks run here — because that is what the README says
 * Tade is for, agent work becoming merged work, and a demo that stops at an
 * agent working shows the half every tool already has.
 */
export const REEL: Reel = {
  file: 'tade.svg',
  title: 'tade',
  about:
    'Tade in a terminal: a project with nothing running, a request typed to the orchestrator, ' +
    'the orchestrator calling its tools, an agent at work asking for approval, and then what ' +
    'its work came to — its own commits, the review it is out for and the project’s checks run here.',
  frames: [
    { scenario: 'first-open', hold: 3 },
    { scenario: 'typing-to-tade', hold: 3 },
    { scenario: 'orchestrator-at-work', hold: 4 },
    { scenario: 'watching-an-agent', hold: 4 },
    { scenario: 'what-an-agent-has-done', hold: 5 },
  ],
}

/**
 * The away view's page, as the README shows it: a desk and then a phone.
 *
 * Every frame is a path the page routes, on a device of `PAGE_WORLD`'s, at the
 * size it is drawn; `pictures.test.ts` holds each path to a screen the page
 * knows. The desk keeps Tade folded to its line at the foot — one press of `\`
 * — so each screen has the room to be seen; the phone has it in the tab bar.
 */
export const PAGE_REEL = {
  file: 'away-page.svg',
  about:
    'The away view on a laptop and then a phone, each screen the page itself drawing the same ' +
    'morning as the window: the overview with what needs you and its presses, the agent ' +
    'waiting on `npm i stripe@15` with Allow and Deny and its screen, two plans with their ' +
    'steps, what the morning cost against each plan’s limits, and three phones — the ' +
    'overview, that agent and the conversation with Tade.',
  width: 1280,
  height: 800,
  /** Where a phone would type it, which is where `tade web` says it listens. */
  at: 'localhost:7654',
  /** Where the world is, so each visit's own process can load it. */
  world: {
    module: new URL('../test/screens/scenarios/away-page.ts', import.meta.url).href,
    name: 'PAGE_WORLD',
  } satisfies WorldAt,
  desk: {
    device: DESK.id,
    width: 1280,
    height: 800,
    pointer: 'fine',
    folded: ['tade'],
    // What Chromium measures a plan's map at in a 1280 desk with the menu and
    // the side open, which the map spreads its steps across. `pnpm screens
    // --page` says the new number when the layout moves.
    measured: { '.runs-map': 510 },
    paths: ['/', '/t/checkout/stripe-v15', '/plans', '/spend'],
  } satisfies Visit,
  deskHold: 4,
  phone: {
    device: PHONE.id,
    width: 360,
    height: 744,
    pointer: 'coarse',
    paths: ['/', '/t/checkout/stripe-v15', '/talk'],
  } satisfies Visit,
  phoneHold: 6,
} as const

/**
 * The away view's Machines, alone: the overview's section of that name on a
 * laptop with the menu folded to its rail, over a world where the laptop is
 * busy and the server it links to is quiet (`scenarios/away-machines.ts`).
 */
export const MACHINES_PAGE = {
  file: 'away-machines.svg',
  about:
    'The away view’s Machines: this laptop, busy, with its processors at 92% in red and its ' +
    'memory at 84% in amber, and the server it links to, quiet at 4% and 11% with 1.6 TB of ' +
    'its disk free — each with a sparkline, its disk, and what Tade and its agents use of it.',
  width: 960,
  height: 560,
  at: 'localhost:7654',
  world: {
    module: new URL('../test/screens/scenarios/away-machines.ts', import.meta.url).href,
    name: 'MACHINES_WORLD',
  } satisfies WorldAt,
  visit: {
    device: DESK.id,
    width: 960,
    height: 560,
    pointer: 'fine',
    folded: ['menu', 'side', 'tade'],
    only: 'MACHINES',
    paths: ['/'],
  } satisfies Visit,
} as const

export const PICTURES: readonly Picture[] = [
  {
    file: 'window.svg',
    scenario: 'watching-an-agent',
    title: 'tade — checkout',
    about:
      'The Tade window: agents down the left with what each has spent, the changes they have made, ' +
      'the files, an agent at work in the middle asking to run a command, and the orchestrator below.',
  },
  {
    file: 'work.svg',
    scenario: 'what-an-agent-has-done',
    title: 'tade — what an agent has done',
    about:
      'The ACTIONS tab beside an agent: the commits that carry its own task’s trailer with what ' +
      'each touched, what is changed and not committed and whose that is, the pull request it is ' +
      'out for, and the project’s own checks run here — a tick each, a mark for how long it took ' +
      'beside the figure, and what it counted, with the tests red and the file they failed in.',
  },
  {
    file: 'collide.svg',
    scenario: 'work-that-would-collide',
    crop: { top: 2, left: 0, width: 90, height: 13 },
    title: 'tade — work that would collide',
    about:
      'Two agents the conflict forecast says would collide, both with uncommitted changes in one ' +
      'file: each wears ⇄ after its name down the side, and in the plan the line under its box ' +
      'names the other — while the work queued after both waits for them, and nothing is stopped.',
  },
  {
    file: 'evaluations.svg',
    scenario: 'evaluations-by-harness',
    crop: 'panel',
    about:
      'Evaluations by harness: for each one, how many agents it ran, how many finished and landed, ' +
      'how often the first push was green, the reds caught on this machine before CI, what the ' +
      'judge raised and how its verdicts came out, what a landed agent cost — billed money and a ' +
      'plan’s list price each over its own agents — and how long work took to finish. Counts ' +
      'first, and a rate only from five.',
  },
  {
    file: 'reviews.svg',
    scenario: 'what-an-agent-has-done',
    crop: { top: 2, width: 29, height: 21 },
    about:
      'The REVIEWS section down the side: every review open on the project you are in, each as two ' +
      'rows — its number and title over where it stands, and under that what its checks and ' +
      'verdicts came to and how long it has been open. A draft with red checks, one that is ready, ' +
      'one that wants you.',
  },
  {
    file: 'orchestrator.svg',
    scenario: 'orchestrator-at-work',
    crop: { top: 22, height: 12 },
    about:
      'The orchestrator answering "run the webhook tests and tell me what broke": each tool it ' +
      'called shown as it runs, one failing with the reason, and what it is doing about it.',
  },
  {
    file: 'voice.svg',
    scenario: 'talking',
    title: 'tade — push to talk',
    about:
      'Push to talk: the strip says it is listening, a level meter moves with your voice, and ' +
      'letting go sends what you said.',
  },
  {
    file: 'agents.svg',
    scenario: 'every-kind-of-agent',
    crop: { top: 2, width: 29, height: 21 },
    about:
      'Agents down the side, one of each kind: working, idle, waiting for approval, failed, ' +
      'finished, queued and paused.',
  },
  {
    file: 'approval.svg',
    scenario: 'watching-an-agent',
    crop: { top: 10, left: 30, width: 70, height: 12 },
    about:
      'An agent at work — what it understood, the files it read and edited — stopped at a command ' +
      'it wants to run, with Allow once and Deny beside it.',
  },
  {
    file: 'plan.svg',
    scenario: 'the-plan',
    crop: { top: 2, left: 31, width: 89, height: 24 },
    title: 'tade — the plan',
    about:
      'The whole plan at once, from `plan` on the SMART QUEUE: a column per step, a box per task ' +
      'with what it is doing, an arrow for every wait, and under it the reason for each one.',
  },
  {
    file: 'watches.svg',
    scenario: 'a-watch',
    crop: { top: 2, left: 29, width: 91, height: 21 },
    about:
      'A watch the Sentry extension offers: every hour it looks, starts an agent on each new ' +
      'issue, and keeps what it found and every look — including the ones that went wrong.',
  },
  {
    file: 'diff.svg',
    scenario: 'commenting-on-a-change-in-the-editor',
    crop: 'panel',
    about:
      'A changed file clicked in CHANGES: the editor it opens in, with git’s answer drawn into it — ' +
      'added lines green, the line that was there red — and a comment being written on a line, ' +
      'to Tade, with another kept and both waiting to be sent.',
  },
  {
    file: 'search.svg',
    scenario: 'searching',
    crop: 'panel',
    about:
      'ctrl+k: one box over agents, files in every worktree and the lines inside them, each result ' +
      'saying which project and which agent it belongs to — and an agent found by what it was ' +
      'asked for rather than by what it is called, with the line that said so under its name.',
  },
  {
    file: 'jev.svg',
    scenario: 'what-jev-flagged',
    crop: 'panel',
    about:
      'What Jev has read this week and what it cost, each question by how often it fired and how ' +
      'often a person said it was right, whether its probabilities mean what they say, and every ' +
      'finding with what became of it.',
  },
  {
    file: 'notes.svg',
    scenario: 'adding-a-note',
    crop: 'panel',
    about:
      'A note being written: about this project or about everything, kept word for word, the same ' +
      'thing that saying "remember …" to Tade does.',
  },
  {
    file: 'spend.svg',
    scenario: 'spend',
    crop: 'panel',
    about:
      'Spend: every agent and the orchestrator with its model, tokens, share, runtime and cost, ' +
      'money nobody priced marked where it is read and a plan’s own turns counted as the plan ' +
      'they are, what that bought in commits and lines, how the project’s own checks have been ' +
      'going, and each project against the budget you set it.',
  },
  {
    file: 'extensions.svg',
    scenario: 'extensions',
    crop: 'panel',
    about:
      'The Extensions panel: every one of them down the side with what it is doing at a glance, ' +
      'and the one you are on beside it — what it is for in the work you do, what you can press, ' +
      'what it can be given, every tool it brings, and what it offers to watch.',
  },
  {
    file: 'intake-request.svg',
    scenario: 'intake-one-request',
    crop: 'panel',
    about:
      'One request in front of you: where it came from — the source, their own id, the ' +
      'revision, who asked, the key that allowed it, the mode, the published template version ' +
      'it is stamped from, the raw material and its hash — then what approving it would ' +
      'start, the wait between the two tasks with the reason for it, a warning that one of them ' +
      'and an agent already working both change the same file, and the keys to approve, approve ' +
      'and start, or refuse.',
  },
  {
    file: 'accounts.svg',
    scenario: 'settings-accounts',
    crop: 'panel',
    about:
      "Accounts, a tab for each machine: each harness's own sign-in, a second Claude Code " +
      'account beside it that one project runs as, how much of the plan is used, and what can ' +
      'be done to each.',
  },
  {
    file: 'machines.svg',
    scenario: 'a-project-on-another-machine',
    crop: { top: 0, height: 21 },
    about:
      'Projects on two machines along the top: this Mac’s checkout and search first, then the VPS ' +
      'with tade and web, and the lab box with firmware, each tab carrying the marks its own machine ' +
      'gave its agents. Standing in tade on the VPS, the side lists its agents, its queued work and ' +
      'its schedules as rows of this machine, and the pane says where it is and how it stands.',
  },
]

function scenarioNamed(name: string): Scenario {
  const found = SCENARIOS.find((one) => one.name === name)
  if (!found) throw new Error(`no scenario called ${name}`)
  return found
}

/**
 * Where the panel over the window is: its top-left corner, the corner closing
 * its own top row, and the corner under the first one.
 */
export function panelBox(grid: Grid): Box {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? []
    const left = row.findIndex((cell) => cell.ch === '\u256d' || cell.ch === '\u250f')
    if (left < 0) continue
    const right = row.findIndex(
      (cell, x) => x > left && (cell.ch === '\u256e' || cell.ch === '\u2513'),
    )
    let bottom = y
    for (let below = y + 1; below < grid.length; below++) {
      const corner = grid[below]?.[left]?.ch
      if (corner === '\u2570' || corner === '\u2517') {
        bottom = below
        break
      }
    }
    if (right < 0 || bottom === y) break
    return { top: y, left, width: right - left + 1, height: bottom - y + 1 }
  }
  throw new Error('no panel on this screen')
}

function gridOf(name: string, crop?: Box | 'panel') {
  const scenario = scenarioNamed(name)
  const grid = toGrid(draw(scenario.state, scenario.frame).rows)
  if (!crop) return grid
  return cropGrid(grid, crop === 'panel' ? panelBox(grid) : crop)
}

export interface Drawn {
  file: string
  /** The picture, exactly as the file of that name has to hold it. */
  svg: string
}

export interface Written {
  file: string
  bytes: number
}

/** The away view's reel: the page run over `PAGE_WORLD`, a frame a screen, then the phones. */
async function drawPage(): Promise<Drawn> {
  const stills = await stillsOf(PAGE_REEL.world, [PAGE_REEL.desk, PAGE_REEL.phone])
  const desk = stills.slice(0, PAGE_REEL.desk.paths.length)
  const phone = stills.slice(PAGE_REEL.desk.paths.length)
  const frames = [
    ...desk.map((still) => ({
      stills: [still],
      hold: PAGE_REEL.deskHold,
      caption: `${PAGE_REEL.at}${still.path}`,
      about: `${still.path} on a laptop`,
    })),
    {
      stills: phone,
      hold: PAGE_REEL.phoneHold,
      caption: `${PAGE_REEL.at} on a phone`,
      about: `${PAGE_REEL.phone.paths.join(', ')} on a phone`,
    },
  ]
  return {
    file: PAGE_REEL.file,
    svg: pageReel(frames, {
      width: PAGE_REEL.width,
      height: PAGE_REEL.height,
      label: 'Tade’s away view',
    }),
  }
}

/** The away view's Machines: one still, one frame. */
async function drawMachines(): Promise<Drawn> {
  const stills = await stillsOf(MACHINES_PAGE.world, [MACHINES_PAGE.visit])
  return {
    file: MACHINES_PAGE.file,
    svg: pageReel(
      [{ stills, hold: 1, caption: `${MACHINES_PAGE.at}/`, about: 'Machines on a laptop' }],
      {
        width: MACHINES_PAGE.width,
        height: MACHINES_PAGE.height,
        label: 'Tade’s away view: Machines',
      },
    ),
  }
}

/**
 * Every picture the README uses, drawn.
 *
 * Separate from writing them because the test that holds `images/` to this has
 * to read the same bytes without touching the tree: four agents share this
 * checkout, and a test that wrote the pictures to check them would be a test
 * that made the change it was looking for.
 *
 * Asynchronous for the away view's page alone, which boots the way a page
 * does: it asks, and draws when it is answered.
 */
export async function drawPictures(): Promise<Drawn[]> {
  const shots: Shot[] = REEL.frames.map((frame) => ({
    grid: gridOf(frame.scenario),
    hold: frame.hold,
    about: frame.scenario,
  }))
  const drawn: Drawn[] = [
    { file: REEL.file, svg: reel(shots, REEL.title === undefined ? {} : { title: REEL.title }) },
  ]
  for (const picture of PICTURES) {
    drawn.push({
      file: picture.file,
      svg: shot(
        gridOf(picture.scenario, picture.crop),
        picture.title === undefined ? {} : { title: picture.title },
      ),
    })
  }
  drawn.push(...(await Promise.all([drawPage(), drawMachines()])))
  return drawn
}

/** Draw every picture the README uses into `dir`, and say what was written. */
export async function writePictures(dir: string): Promise<Written[]> {
  mkdirSync(dir, { recursive: true })
  const written: Written[] = []
  for (const one of await drawPictures()) {
    writeFileSync(join(dir, one.file), one.svg)
    written.push({ file: one.file, bytes: one.svg.length })
  }
  return written
}
