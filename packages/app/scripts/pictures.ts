import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { draw } from '../src/view.ts'
import { SCENARIOS, type Scenario } from '../test/screens/scenarios.ts'
import { type Box, cropGrid, reel, type Shot, shot } from './ansi-svg.ts'
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

/** The demo at the top of the README: one request, from asking to done. */
export const REEL: Reel = {
  file: 'tade.svg',
  title: 'tade',
  about:
    'Tade in a terminal: a project with nothing running, a request typed to the orchestrator, ' +
    'the orchestrator calling its tools, an agent at work asking for approval, and the brief.',
  frames: [
    { scenario: 'first-open', hold: 3 },
    { scenario: 'typing-to-tade', hold: 3 },
    { scenario: 'orchestrator-at-work', hold: 4 },
    { scenario: 'watching-an-agent', hold: 4 },
    { scenario: 'a-brief-on-demand', hold: 4 },
  ],
}

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
      'The work tab beside an agent: its branch, the commits on it and how many carry its task’s ' +
      'trailer, the pull request it is out for with what CI says, and the project’s own checks ' +
      'run here — format and types green, tests red with what they printed.',
  },
  {
    file: 'reviews.svg',
    scenario: 'what-an-agent-has-done',
    crop: { top: 2, width: 29, height: 21 },
    about:
      'The REVIEWS section down the side: every review that is open, each with what it is waiting ' +
      'on — a draft with red checks, one that is ready, one that wants you.',
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
    file: 'queue.svg',
    scenario: 'a-chain-in-the-queue',
    crop: { top: 2, height: 25 },
    title: 'tade — the smart queue',
    about:
      'Queued work opened: the chain it is in drawn as boxes — schema, then api, then this one, ' +
      'then docs — why each waits, and what its agent will be told.',
  },
  {
    file: 'queue-held.svg',
    scenario: 'a-smart-queue',
    crop: { top: 2, left: 29, width: 91, height: 22 },
    about:
      'Queued work held because what it waited on failed: what happened, and the choices — wait ' +
      'for a retry, start anyway, remove.',
  },
  {
    file: 'schedules.svg',
    scenario: 'a-schedule',
    crop: { top: 2, height: 23 },
    title: 'tade — schedules',
    about:
      'A schedule: every Monday at 09:00 it starts an agent, what that agent is told, when it ' +
      'runs next, what happens to a run missed while Tade was closed, and every run so far.',
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
    file: 'editor.svg',
    scenario: 'editing-a-file',
    crop: 'panel',
    about:
      'A file open in the window: highlighted, numbered, typed into, with save, copy path and ' +
      'open in your own editor along the bottom.',
  },
  {
    file: 'diff.svg',
    scenario: 'diff',
    crop: 'panel',
    about:
      'A changed file as a diff, with buttons to open it in your editor or ask the agent about it.',
  },
  {
    file: 'search.svg',
    scenario: 'searching',
    crop: 'panel',
    about:
      'ctrl+k: one box over agents, files in every worktree and the lines inside them, each result ' +
      'saying which project and which agent it belongs to.',
  },
  {
    file: 'asking.svg',
    scenario: 'asking-in-search',
    crop: 'panel',
    about:
      'A sentence typed into search: its letters match nothing, so under MIGHT MEAN are the two ' +
      'things already in the list that a judge says were meant — stopping that agent, and the agent itself.',
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
    file: 'terminals.svg',
    scenario: 'a-shell-beside-the-agent',
    crop: { top: 2, height: 21 },
    about:
      'A shell open beside the agent, in the same worktree and on the same branch, with a divider ' +
      'you can drag.',
  },
  {
    file: 'changes.svg',
    scenario: 'files-marked-by-git',
    crop: { top: 2, width: 29, height: 20 },
    about:
      'The side of the window: files coloured the way git sees them, and the branch, worktree and ' +
      'path the agent is working in.',
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
      'what that bought in commits and lines, how the project’s own checks have been going, ' +
      'and each project against the budget you set it.',
  },
  {
    file: 'resources.svg',
    scenario: 'resource-usage',
    crop: 'panel',
    about:
      'What Tade and everything it runs is using: CPU and memory by project, by kind, and by agent.',
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
    file: 'sentry.svg',
    scenario: 'an-agent-on-a-sentry-issue',
    crop: { top: 2, height: 21 },
    about:
      'An agent a Sentry watch started: the issue and the trace it came from are one click away ' +
      'under GIT, and the context file it was given is the first thing it reads.',
  },
  {
    file: 'models.svg',
    scenario: 'choosing-a-model',
    crop: 'panel',
    about:
      'Choosing a model: every model the harness is signed in to, with what it costs in, out and ' +
      'cached, filtered as you type.',
  },
  {
    file: 'accounts.svg',
    scenario: 'settings-accounts',
    crop: 'panel',
    about:
      "Accounts: each harness's own sign-in, a second Claude Code account beside it, how much of " +
      'the plan is used, and what can be done to each.',
  },
  {
    file: 'projects.svg',
    scenario: 'another-project-needs-you',
    crop: { top: 0, height: 9 },
    about:
      'Projects along the top, and an agent in one you are not looking at asking for approval — ' +
      'answerable from where you are.',
  },
  {
    file: 'keys.svg',
    scenario: 'keys',
    crop: 'panel',
    about:
      'The keys Tade keeps, talking first: push to talk, search, the next agent, a new agent, a ' +
      'terminal, mute — and what each one does, with everything else going to the agent you are at.',
  },
  {
    file: 'brief.svg',
    scenario: 'a-brief-on-demand',
    crop: { top: 23, height: 11 },
    about:
      'The brief: one paragraph of what is blocked, what is moving and what the extensions found, ' +
      'with what to ask about next offered beside it.',
  },
  {
    file: 'settings.svg',
    scenario: 'settings',
    crop: 'panel',
    about:
      'Settings over the window: categories down the side, and for each one a real control with ' +
      'what it means beside it — here the talk key, the speech engine, the microphone and quiet hours.',
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

export interface Written {
  file: string
  bytes: number
}

/** Draw every picture the README uses into `dir`, and say what was written. */
export function writePictures(dir: string): Written[] {
  mkdirSync(dir, { recursive: true })
  const written: Written[] = []
  const shots: Shot[] = REEL.frames.map((frame) => ({
    grid: gridOf(frame.scenario),
    hold: frame.hold,
    about: frame.scenario,
  }))
  const animated = reel(shots, REEL.title === undefined ? {} : { title: REEL.title })
  writeFileSync(join(dir, REEL.file), animated)
  written.push({ file: REEL.file, bytes: animated.length })
  for (const picture of PICTURES) {
    const svg = shot(
      gridOf(picture.scenario, picture.crop),
      picture.title === undefined ? {} : { title: picture.title },
    )
    writeFileSync(join(dir, picture.file), svg)
    written.push({ file: picture.file, bytes: svg.length })
  }
  return written
}
