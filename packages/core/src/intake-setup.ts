import type { IntakeSource } from './intake.ts'

// What turning a source on takes, and whether somebody has finished doing it.
//
// Its own file for the reason `settings-intake.ts` is one: these are read by
// people rather than by code, and they grow by one entry per source while
// `intake.ts` is the rule and must not. Nothing here decides anything — the
// rule is `intakeDecision`'s, and this only says whether somebody has finished
// writing the thing that rule reads.

/**
 * What turning each source on actually takes, in order, in the owner's words.
 *
 * Here rather than in each connector because every surface that offers a
 * source has to be able to say it — `tade intake status`, the Settings page,
 * whatever comes next — and a second copy is a second answer. The sentences
 * name keys and programs and nothing reads them: they are read by people.
 *
 * **One entry per source, so tsc names the one somebody forgot.** A source
 * whose grant a person cannot work out how to write is a source nobody turns
 * on, and that has been the whole failure mode of every connector anybody has
 * shipped.
 */
export const INTAKE_SETUP: Readonly<Record<IntakeSource, readonly string[]>> = {
  cli: [
    'Nothing to install: no key, no endpoint, no account.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.cli.accept: true.',
    'surfaces.intake.sources.cli.projects: the projects it may make work in.',
    'surfaces.intake.sources.cli.from: the handles whose requests count. Empty means nobody.',
    'A watch: Settings › Extensions, or a schedule over intake.cli.',
    'Then `tade intake add <id> --project <p> --from <who>` and write the request.',
  ],
  github: [
    'A credential: `gh auth login`, or $GITHUB_TOKEN with `repo` for a private repository.',
    'A label on the repository — `tade` is the one Tade suggests — and nothing defaults to it.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.github.accept: true.',
    'surfaces.intake.sources.github.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.github.from: the logins whose LABELLING counts, not whose issues.',
    'A watch, told the label: Settings › Extensions, or a schedule over intake.github.',
    'Then label an issue. mode is propose, so a task is made and parked for you to approve.',
    'For a workflow rather than one task: template: bug-repro-fix-review, document: report.',
  ],
}

/**
 * Whether a source's grant is written far enough to do anything, and what is
 * missing — for a surface deciding whether to print the setup above.
 *
 * Null when it would work. Never a refusal of its own: the rule is
 * `intakeDecision`'s, and this only says whether somebody has finished writing
 * the thing that rule reads.
 */
export function intakeUnfinished(grant: {
  on: boolean
  accept: boolean
  projects: readonly string[]
  from: readonly string[]
}): string | null {
  if (!grant.on) return 'surfaces.intake.enabled is off'
  if (!grant.accept) return 'accept is off'
  if (grant.projects.length === 0) return 'no project is on its list'
  if (grant.from.length === 0) return 'nobody is on its list'
  return null
}
