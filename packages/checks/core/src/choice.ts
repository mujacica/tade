import type { Check } from './port.ts'

// Which of a project's checks Tade runs on this machine.
//
// What a project checks is read out of what it already says — the hook that
// runs before a commit, the workflows that run on every change — and that
// reading also says which of them cannot run *here*: a step that needs a
// secret, a database, or the runner's own answer to an `if`. That is a fact
// about the machine, and it is right nearly always. What it is not is a
// decision, and there are two a person is owed: not running a check here that
// the project runs, and running one here that the reading gave up on.
//
// Both live in Tade's own config, under the project — `checks.run_here`, keyed
// by check id — and never in a file in the repository. A file Tade writes into
// somebody's tree so that Tade can read it back is the exact duplication that
// taking `.tade/checks.yaml` away was for, and it would be that again under
// any other name.
//
// Only what *differs* from the reading is written down, which is what keeps it
// both small and current: a project that adds a step to its CI tomorrow is
// checked here tomorrow, because nothing anywhere had to list it. An entry for
// a check that is no longer read is ignored rather than refused — a renamed
// step is not a config error, and the safe direction is the reading's answer.

/** What somebody said about running a check here. A check nobody answered is absent. */
export type Chosen = Readonly<Record<string, boolean>>

/** What a check somebody turned off says for itself, wherever a skip is read. */
export const TURNED_OFF = 'you turned it off here'

/**
 * The checks as this machine runs them: what somebody said, over what the
 * reading said.
 *
 * Turning one off gives it a `skip` like any other, so everything downstream
 * treats it as exactly what it now is — a check that does not run here — with
 * no second notion of exclusion for the runner, the record and the page to
 * disagree about. It also stops being `required`, because a rollup is what a
 * run here adds up to: a required check nothing ever runs would leave every
 * commit `unknown` for good, which is the one way this could draw something
 * worse than it found.
 *
 * Turning one on lifts the reading's skip and nothing else. Whether merging
 * waits on it stays what the project said, because `required: false` was set
 * for two different reasons — CI is willing to be red on it, or nothing here
 * could run it — and only the second is the one somebody just answered.
 */
export function withChoices(checks: readonly Check[], chosen: Chosen): Check[] {
  return checks.map((check) => {
    const said = chosen[check.id]
    if (said === undefined) return check
    if (said) return check.skip ? { ...check, skip: undefined } : check
    return check.skip ? check : { ...check, skip: TURNED_OFF, required: false }
  })
}

/**
 * What `run_here` holds for one check after somebody presses the control on
 * it: nothing, where there was an entry, and otherwise the opposite of what
 * the reading says.
 *
 * So the config never comes to hold an answer that merely agrees with the
 * reading, and pressing twice leaves the file exactly as it was found.
 */
export function chosenAfter(chosen: Chosen, id: string, runsHere: boolean): boolean | undefined {
  return chosen[id] === undefined ? !runsHere : undefined
}
