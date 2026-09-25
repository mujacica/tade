import type { Ui } from '@tade/app'
import {
  defaultConfigPath,
  describeWhen,
  loadConfig,
  scheduleIdOf,
  tadeHome,
  type WatchChoice,
  type WatchOffered,
  watchesToOffer,
  watchSchedule,
} from '@tade/core'
import { loadExtensions } from '@tade/orchestrator'
import { Schedules } from '@tade/workbench/schedules'

// Which watches to turn on, asked once, in the first minute.
//
// Nothing is watched until somebody says so and nothing suggests one, so
// without this a person has to find out that watches exist before they can
// want one — and the handful that turn themselves on do it precisely because
// being on costs nothing anybody has to agree to, which is not true of the
// rest.
//
// It is part of the extensions step rather than a step of its own, and that is
// the whole of how it avoids becoming the step people learn to skip: that step
// is finished once every extension has been decided about, so this is asked on
// a machine where nothing has been decided and never again. Which is also why
// it need not subtract what somebody has turned off since — on that machine
// there is nothing to subtract.
//
// What it writes is an ordinary schedule under the id the Extensions page
// would have used, so the button there turns off the thing this turned on.

/** A watch as the first minute has it: what to say about it, and what to write. */
interface Offer {
  choice: WatchChoice
  watch: WatchOffered
}

/**
 * Offer the watches, and turn on whichever are chosen.
 *
 * Read afresh rather than from the look the step was handed: the extensions
 * somebody has just turned on are the ones whose watches are worth offering,
 * and none of them was loaded when that look was taken.
 */
export async function setUpWatches(ui: Ui, home = tadeHome()): Promise<void> {
  const here = await watchesHere(home)
  if (!here || here.projects.length === 0) return
  const { offers, projects } = here
  const offered = offers.filter((one) => one.choice.state === 'offered')
  const cannot = offers.filter((one) => one.choice.state === 'cannot')
  const already = offers.filter((one) => one.choice.state === 'on')
  if (offered.length === 0 && cannot.length === 0) return

  ui.say('A watch is Tade looking for work on a clock: a red build, a new error, a dependency')
  ui.say('with a vulnerability in it. Each one is off until you say so, and Settings › Extensions')
  ui.say('turns any of them on or off again later.')
  ui.say('')
  for (const one of [...offered, ...cannot]) ui.say(`  ${lineFor(one.choice)}`)
  if (already.length > 0) {
    // Said and never asked: these turn themselves on because being on costs
    // nothing anybody has to agree to, and a tick that changed nothing would
    // be a lie. Taking one away is the queue's.
    ui.say('')
    ui.say(
      `  already on, and nothing to decide: ${already.map((one) => one.choice.title).join(', ')}`,
    )
  }
  ui.say('')
  if (offered.length === 0) {
    // Everything there is wants a key first, so there is nothing to answer.
    // Said rather than skipped: what it needs is how somebody comes to set it
    // up, and a question with no options is a question people learn to skip.
    ui.say('  nothing to turn on yet — Settings › Extensions once one of them has what it needs')
    return
  }

  const suggested = offered.filter((one) => one.choice.ticked)
  const where = projects.length === 1 ? projects[0] : `all ${projects.length} projects`
  const suggests =
    suggested.length > 0
      ? `the ${suggested.length} Tade suggests — ${suggested.map((one) => one.choice.title).join(', ')}`
      : ''
  const none = 'none for now'
  const pick = 'let me pick'
  const options = [...(suggests ? [suggests] : []), pick, none]
  const answer = options[await ui.choose(`Which should Tade watch for in ${where}?`, options)]

  const picked: Offer[] = []
  if (answer === pick) {
    for (const one of offered) {
      // Its own sentence, where there is room for it: the list above is one
      // line each so it can be scanned, and this is the question itself.
      ui.say(`  ${one.choice.means}`)
      if (await ui.confirm(`watch for ${one.choice.title.toLowerCase()}?`, one.choice.ticked)) {
        picked.push(one)
      }
    }
  } else if (answer !== none) {
    picked.push(...suggested)
  }
  if (picked.length === 0) {
    ui.say('  none on — Settings › Extensions whenever you want one')
    return
  }
  turnOn(home, picked, projects)
  ui.say(
    `  watching in ${projects.join(', ')}: ${picked.map((one) => one.choice.title).join(', ')}`,
  )
}

/** One watch on one line: what it is, how often it looks, and what it costs. */
function lineFor(one: WatchChoice): string {
  const mark = one.state === 'cannot' ? '·' : one.ticked ? '●' : '○'
  const often = one.state === 'cannot' ? '' : ` — ${describeWhen({ every: one.every })}`
  return `${mark} ${one.title}${often} — ${one.costs}`
}

/**
 * The schedules, written where the window will read them.
 *
 * Named as the Extensions page names one, so that the button there is turning
 * off the same schedule: the watch's own title, or the title and the project
 * where one name would otherwise have to serve two.
 */
function turnOn(home: string, picked: readonly Offer[], projects: readonly string[]): void {
  const kept = Schedules.open(home)
  const now = Date.now()
  for (const one of picked) {
    for (const project of projects) {
      const name = projects.length === 1 ? one.choice.title : `${one.choice.title} in ${project}`
      kept.set(
        watchSchedule(one.watch, { id: scheduleIdOf(name), name, project, by: 'you' }, now),
        'you',
      )
    }
  }
}

/**
 * Every watch the extensions here offer, and the projects they would watch.
 *
 * Never throws: nothing to offer is nothing asked, not a failed setup.
 */
async function watchesHere(home: string): Promise<{ offers: Offer[]; projects: string[] } | null> {
  const loaded = await loadConfig(defaultConfigPath())
  if (!loaded.ok) return null
  const config = loaded.config
  try {
    const host = await loadExtensions({ config, home, configPath: defaultConfigPath() })
    const watching = new Set(
      Schedules.open(home)
        .all()
        .flatMap((one) => (one.does.kind === 'watch' ? [one.does.watch] : [])),
    )
    const watches = host.watches()
    const choices = watchesToOffer(watches, (id) => watching.has(id))
    return {
      offers: choices.flatMap((choice) => {
        const watch = watches.find((one) => one.id === choice.id)
        return watch ? [{ choice, watch }] : []
      }),
      projects: Object.keys(config.projects),
    }
  } catch {
    return null
  }
}
