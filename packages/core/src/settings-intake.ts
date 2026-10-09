import type { Config } from './config.ts'
import {
  EMPTY_MEANS_NOBODY,
  INTAKE_IS_SOMEBODY_ELSE,
  INTAKE_MODES,
  INTAKE_SOURCES,
  METADATA_IS_DISCLOSURE,
  PROPOSE_IS_THE_TYPING,
} from './intake.ts'
import { INTAKE_REPLY_CAP, INTAKE_SAYINGS, NEVER_REPLIED_TO } from './intake-outbox.ts'
import type { Setting, SettingGroup } from './settings.ts'

// Intake's controls, as a person changes them.
//
// Its own half of `settingsOf`, for the reason the away view's and the
// projects' halves are: that file reached the size a file is allowed to be.
//
// Two things about the shape here rather than in `settings.ts`:
//
// **Every row is a `never` key, by one entry in `reach.ts`.** So nothing here
// is ever written on an orchestrator's say-so, whoever asked and however they
// asked — which is the point, because the orchestrator reads review comments,
// tool descriptions and pages somebody pasted, and the sentence an injected one
// would most like obeyed is "put me on the list".
//
// **The sentence a control is tempted to leave out is in `means`.** Turning a
// source on means somebody else's words reach an agent that runs as you, with
// your keys, and Tade sandboxes nothing. `INTAKE_IS_SOMEBODY_ELSE` says it once
// so no surface can say the comfortable half.

/** One row per source, and the surface's own switch above them. */
export function intakeGroup(config: Config): SettingGroup {
  const intake = config.surfaces.intake
  const settings: Setting[] = [
    {
      path: 'surfaces.intake.enabled',
      title: 'Accept work from outside',
      means: `on: the sources you turned on are read, on their own clock; off: nothing outside this machine can make work here, whatever a source says. ${INTAKE_IS_SOMEBODY_ELSE}`,
      value: String(intake.enabled),
      fallback: 'false',
      type: { kind: 'flag' },
      // Honestly live: every door reads the config at the moment it acts, so
      // turning this off stops the next look rather than the next window.
      live: true,
    },
  ]
  for (const source of INTAKE_SOURCES) {
    const grant = intake.sources[source]
    const at = `surfaces.intake.sources.${source}`
    settings.push(
      {
        path: `${at}.accept`,
        title: `Accept from ${source}`,
        means: `on: requests ${source} hands over may become work in the projects below; off: they are read and refused, and the refusal is written down`,
        value: String(grant.accept),
        fallback: 'false',
        type: { kind: 'flag' },
        live: true,
      },
      {
        path: `${at}.projects`,
        title: `Projects ${source} may make work in`,
        means:
          'which repositories a request from this source can become work in. Empty means nowhere, and a project not on the list is refused with the list named',
        value: grant.projects.join(' '),
        fallback: 'none',
        type: { kind: 'text', placeholder: 'tade sentry-cli' },
        live: true,
      },
      {
        path: `${at}.from`,
        title: `Whose requests ${source} may hand over`,
        means: `the handles, as ${source} names them, whose requests count. ${EMPTY_MEANS_NOBODY}`,
        value: grant.from.join(' '),
        fallback: 'nobody',
        type: { kind: 'text', placeholder: 'kim' },
        live: true,
        keywords: ['allowlist', 'who', 'requester', 'handle'],
      },
      {
        path: `${at}.mode`,
        title: `What an accepted ${source} request does`,
        means: PROPOSE_IS_THE_TYPING,
        value: grant.mode,
        fallback: 'propose',
        type: { kind: 'choice', options: [...INTAKE_MODES] },
        live: true,
        keywords: ['propose', 'queue', 'approve', 'parked'],
      },
      {
        path: `${at}.template`,
        title: `The template ${source} requests are stamped from`,
        means:
          'a published template, chosen here and never by whoever sent the request. Empty makes one ordinary task instead',
        value: grant.template,
        fallback: 'none: one task',
        type: { kind: 'text', placeholder: 'github-bug' },
        live: true,
        keywords: ['template', 'workflow'],
      },
      {
        path: `${at}.document`,
        title: `Which of that template's documents a ${source} request fills`,
        means:
          'the name of one of the template’s document inputs, for a template that declares more than one and requires none of them. Empty takes the only one, or the only one it requires',
        value: grant.document,
        fallback: 'the obvious one',
        type: { kind: 'text', placeholder: 'report' },
        live: true,
        keywords: ['document', 'body', 'input'],
      },
      {
        path: `${at}.reply`,
        title: `Say a status back to ${source}`,
        means: `on: where a request got to goes back as one of ${INTAKE_SAYINGS.length} sentences Tade wrote — picked up, queued, being worked on, up for review, finished, stopped — one each, at most ${INTAKE_REPLY_CAP} a day per request; off: nothing is posted anywhere. Never a word an agent wrote, never a diff, never a file name, never a link. ${NEVER_REPLIED_TO}`,
        value: String(grant.reply),
        fallback: 'false',
        type: { kind: 'flag' },
        live: true,
        keywords: ['comment', 'post', 'back', 'status', 'outbox'],
      },
      {
        path: `${at}.names`,
        title: `Let a ${source} status name the work`,
        means: `on: a status says which task and which machine; off: it says where the request got to and nothing else. ${METADATA_IS_DISCLOSURE}`,
        value: String(grant.names),
        fallback: 'false',
        type: { kind: 'flag' },
        live: true,
        keywords: ['disclosure', 'task', 'machine', 'hostname', 'metadata', 'public'],
      },
    )
  }
  return {
    id: 'intake',
    title: 'Intake',
    about: `Work that arrives from outside this machine — a ticket somebody filed, a line typed at the local door — read on a clock like every other watch, with no listener and no inbound port. Off by default, and every source is a separate act. ${INTAKE_IS_SOMEBODY_ELSE}`,
    keywords: [
      'intake',
      'inbox',
      'ticket',
      'issue',
      'request',
      'github',
      'linear',
      'slack',
      'outside',
      'grant',
      'allowlist',
      'propose',
      'requester',
    ],
    settings,
  }
}
