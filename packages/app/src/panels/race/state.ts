import type { Race } from '@tade/core'
import type { PanelInputs } from '../../panels.ts'
import { diffPanel } from '../diff/state.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// A race, compared: the entrants given one request side by side, in the order
// the facts put them (`racesIn` in core), one race at a time. The drawing is
// beside this in `view.ts`.
//
// Looking at a race picks nothing. The order is the facts', not a verdict, and
// what a row leads to is reading its change in the patch reader or going to its
// agent. Picking is a press of its own, and a second press to say yes, because
// it stops every other entrant — their branches kept, but their agents gone.

export interface RacePanel {
  kind: 'race'
  /** Which race, among those the window can see. */
  race: number
  /** The entrant the keyboard is on. */
  index: number
  /** Lines of the list scrolled past. */
  scroll: number
  /** Whether the list follows the row the keyboard is on: the wheel lets go of it. */
  following: boolean
  /** The entrant a pick is waiting to be said yes to, by its task id. */
  confirming: string | null
  /** What the panel last said: why a press did nothing. */
  said: string | null
  busy: false
}

export function racePanel(race = 0): RacePanel {
  return {
    kind: 'race',
    race,
    index: 0,
    scroll: 0,
    following: true,
    confirming: null,
    said: null,
    busy: false,
  }
}

/** The race the panel is on, or undefined where there is none. */
export function raceShown(panel: RacePanel, races: readonly Race[]): Race | undefined {
  return races[Math.min(panel.race, Math.max(0, races.length - 1))]
}

/**
 * ↑↓ walk the entrants and ← → the races; enter reads the change the keyboard
 * is on, `a` goes to its agent, `p` asks to pick it — and while a pick waits,
 * enter or `y` says yes and escape says no.
 */
export function raceKey(
  panel: RacePanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  const races = inputs.races ?? []
  if (panel.confirming) {
    if (key === 'enter' || data === 'y') return pick(panel)
    if (key === 'escape' || data === 'n') return stay({ ...panel, confirming: null })
    return stay(panel)
  }
  const race = raceShown(panel, races)
  const last = Math.max(0, (race?.racers.length ?? 1) - 1)
  const at = (index: number) =>
    stay({ ...panel, index: Math.max(0, Math.min(last, index)), following: true, said: null })
  const other = (to: number) => stay({ ...racePanel(Math.max(0, Math.min(races.length - 1, to))) })
  if (key === 'escape') return close
  if (key === 'up') return at(panel.index - 1)
  if (key === 'down') return at(panel.index + 1)
  if (key === 'home') return at(0)
  if (key === 'end') return at(last)
  if (key === 'left') return other(panel.race - 1)
  if (key === 'right' || key === 'tab') return other((panel.race + 1) % Math.max(1, races.length))
  if (key === 'enter') return read(panel, race, inputs)
  if (data === 'a') return toAgent(panel, race)
  if (data === 'p') return askToPick(panel, race)
  return stay(panel)
}

/** A row pressed is chosen; pressed again, it is read. The buttons are the keys. */
export function raceClick(
  panel: RacePanel,
  control: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  const races = inputs.races ?? []
  const race = raceShown(panel, races)
  if (control === 'close') return close
  if (control === 'cancel') return stay({ ...panel, confirming: null })
  if (control === 'confirm' && panel.confirming) return pick(panel)
  if (control === 'patch') return read(panel, race, inputs)
  if (control === 'agent') return toAgent(panel, race)
  if (control === 'pick') return askToPick(panel, race)
  if (control.startsWith('race:')) {
    const to = Number(control.slice('race:'.length))
    return races[to] ? stay(racePanel(to)) : stay(panel)
  }
  if (control.startsWith('row:')) {
    const index = Number(control.slice('row:'.length))
    if (!race?.racers[index]) return stay(panel)
    if (index === panel.index) return read(panel, race, inputs)
    return stay({ ...panel, index, following: true, said: null })
  }
  return stay(panel)
}

/** The patch reader on that entrant's change. One with nothing to read stays, and says which. */
function read(panel: RacePanel, race: Race | undefined, inputs: PanelInputs): PanelOutcome {
  const racer = race?.racers[panel.index]
  if (!racer) return stay(panel)
  const task = racer.facts.task
  const files = inputs.raceFiles?.[task]
  if (files === undefined) {
    return stay({ ...panel, said: `what ${nameOf(task)} changed has not been looked at yet` })
  }
  if (files.length === 0) return stay({ ...panel, said: `${nameOf(task)} has nothing to read` })
  return { panel: diffPanel(task, files, 0), submit: false }
}

function toAgent(panel: RacePanel, race: Race | undefined): PanelOutcome {
  const racer = race?.racers[panel.index]
  return racer ? { panel, submit: true, choice: `agent:${racer.facts.task}` } : stay(panel)
}

/** Ask to pick the entrant the keyboard is on, or say why there is nothing to pick. */
function askToPick(panel: RacePanel, race: Race | undefined): PanelOutcome {
  const racer = race?.racers[panel.index]
  if (!race || !racer) return stay(panel)
  if (race.won) {
    return stay({
      ...panel,
      said: `${race.name} was decided already: ${nameOf(race.won.task)} was picked`,
    })
  }
  return stay({ ...panel, confirming: racer.facts.task, said: null })
}

function pick(panel: RacePanel): PanelOutcome {
  const task = panel.confirming
  if (!task) return stay(panel)
  return { panel: { ...panel, confirming: null }, submit: true, choice: `pick:${task}` }
}

function nameOf(task: string): string {
  return task.split('/')[1] ?? task
}
