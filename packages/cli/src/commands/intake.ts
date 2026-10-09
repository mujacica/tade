import { readFile } from 'node:fs/promises'
import {
  defaultConfigPath,
  describeLook,
  EMPTY_MEANS_NOBODY,
  INTAKE_IS_SOMEBODY_ELSE,
  INTAKE_SETUP,
  INTAKE_SOURCES,
  inboxActs,
  inboxWaiting,
  intakeDecision,
  intakeItem,
  intakeMapped,
  intakeUnfinished,
  loadConfig,
  MATERIAL_LABEL,
  METADATA_IS_DISCLOSURE,
  NEVER_REPLIED_TO,
  tadeHome,
  WAITING_STATES,
  watchedFrom,
} from '@tade/core'
import { newestOf, readSpool, spool, spoolIdProblem } from '@tade/extension-intake'
import {
  approveIntake,
  inboxFrom,
  intakeGrant,
  intakeWouldRun,
  openIntakeRow,
  refuseIntake,
  retryIntake,
  wouldRunSays,
} from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import { readSchedules } from '@tade/workbench/schedules'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { withWorkbench } from '../with-workbench.ts'

// The local intake door, from the command line.
//
// **Writing a request and reading the spool are both questions of the
// filesystem, so neither needs the window.** The spool is append-only — one
// file per revision, written once and renamed into place — which is what makes
// it safe to write while a window is open and safe to read whether one is.
//
// **And writing a request is not making work.** This puts a request where the
// `intake.cli` watch will find it; what happens then is the owner's own grant
// in `surfaces.intake`, read at the moment the watch looks. Off, which is the
// default, the request sits in the spool and nothing comes of it — so this
// command says what the grant currently is rather than leaving somebody to
// wonder why nothing happened.
//
// **It is not an API and it never becomes one.** A file got into the spool
// because somebody with an account on this machine wrote it, and the grant
// still decides, because a door that trusted whoever could write a file would
// be a door with no rule behind it.

/** The body, from a flag, a file, or standard input. */
async function bodyOf(opts: { body?: string; bodyFile?: string }): Promise<string> {
  if (opts.bodyFile) return await readFile(opts.bodyFile, 'utf8')
  if (opts.body !== undefined) return opts.body
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

export function registerIntake(program: Command, io: Io, setExit: (code: number) => void): void {
  const intake = program
    .command('intake')
    .description('Hand Tade a request from outside, and read what has been handed to it')

  intake
    .command('add <project>')
    .description('Write a request into the intake spool for a project')
    .option(
      '--id <id>',
      'the request’s own id; a new revision of one that exists when it is reused',
    )
    .option('--from <handle>', 'who asked, as this door is told; must be on the project’s own list')
    .option(
      '--body <text>',
      'the request, verbatim; standard input when neither this nor --body-file is given',
    )
    .option('--body-file <path>', 'read the request from a file')
    .option('--url <url>', 'where the request is, if it is anywhere else')
    .option('--close', 'withdraw it: a new revision saying the request is over')
    .option('--json', 'machine-readable output')
    .action(
      async (
        project: string,
        opts: {
          id?: string
          from?: string
          body?: string
          bodyFile?: string
          url?: string
          close?: boolean
          json?: boolean
        },
      ) => {
        const home = tadeHome()
        if (!opts.from) {
          io.err(
            'say who asked, with --from: a request with nobody behind it is refused by the rule',
          )
          setExit(Exit.invalidInput)
          return
        }
        const id = opts.id ?? `req-${Date.now().toString(36)}`
        const problem = spoolIdProblem(id)
        if (problem) {
          io.err(problem)
          setExit(Exit.invalidInput)
          return
        }
        const body = opts.close ? (opts.body ?? '') : await bodyOf(opts)
        if (!opts.close && !body.trim()) {
          io.err('say what the request is, with --body, --body-file or on standard input')
          setExit(Exit.invalidInput)
          return
        }
        let written: Awaited<ReturnType<typeof spool>>
        try {
          written = await spool(home, {
            id,
            project,
            requester: { id: opts.from, label: '', bot: false },
            body,
            url: opts.url ?? '',
            attachments: [],
            closed: opts.close === true,
          })
        } catch (err) {
          io.err(err instanceof Error ? err.message : String(err))
          setExit(Exit.error)
          return
        }
        // What the rule would say about it, now, read out of the config — so
        // that a request written against a grant that is off says so here
        // rather than sitting in a folder looking accepted.
        const cfg = await loadConfig(defaultConfigPath())
        const would = cfg.ok
          ? (() => {
              const grant = intakeGrant(cfg.config, 'cli')
              const decision = intakeDecision(
                { source: 'cli', from: project, requester: written.entry.requester },
                grant,
                intakeMapped(project, grant),
              )
              return decision.outcome === 'accepted'
                ? `the rule would accept it, ${grant.mode}, under ${decision.granted.grant}`
                : `the rule would not act on it yet: ${decision.because}`
            })()
          : 'the config could not be read, so what the rule would say is unknown'
        if (opts.json) {
          io.out(
            JSON.stringify(
              { id: written.entry.id, revision: written.entry.revision, file: written.file, would },
              null,
              2,
            ),
          )
          return
        }
        io.out(
          `${opts.close ? 'withdrew' : 'wrote'} ${written.entry.id} at revision ${written.entry.revision} for ${project}`,
        )
        io.out(would)
        io.out('Nothing starts from here: the watch looks on its own clock, and the grant decides.')
      },
    )

  intake
    .command('list [project]')
    .description('What is in the intake spool, newest revision of each request')
    .option('--all', 'every revision, not only the newest of each')
    .option('--json', 'machine-readable output')
    .action(async (project: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const read = await readSpool(tadeHome())
      const mine = project ? read.entries.filter((one) => one.project === project) : read.entries
      const rows = opts.all ? mine : [...newestOf(mine).values()]
      if (opts.json) {
        io.out(JSON.stringify({ requests: rows, broken: read.broken }, null, 2))
        return
      }
      if (rows.length === 0 && read.broken.length === 0) {
        io.out(project ? `nothing for ${project}` : 'nothing in the spool')
        return
      }
      for (const one of rows) {
        io.out(
          `${intakeItem({ source: 'cli', externalId: one.id })}  r${one.revision}  ${one.project}  @${one.requester.id}${one.closed ? '  withdrawn' : ''}`,
        )
      }
      // Named, never passed over: a file somebody hand-edited is a request that
      // would otherwise have vanished without a word.
      for (const one of read.broken) io.err(`${one.file} could not be read: ${one.problem}`)
    })

  intake
    .command('grant')
    .description('What the rule currently says about requests from the local door')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const cfg = await loadConfig(defaultConfigPath())
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.error)
        return
      }
      const grant = intakeGrant(cfg.config, 'cli')
      if (opts.json) {
        io.out(JSON.stringify(grant, null, 2))
        return
      }
      io.out(`surfaces.intake.enabled: ${grant.on}`)
      io.out(`${grant.path}.accept: ${grant.accept}`)
      io.out(`${grant.path}.projects: ${grant.projects.join(' ') || 'none'}`)
      io.out(`${grant.path}.from: ${grant.from.join(' ') || 'nobody'}`)
      io.out(`${grant.path}.mode: ${grant.mode}`)
      io.out(`${grant.path}.template: ${grant.template || 'none: one task'}`)
      io.out(`${grant.path}.reply: ${grant.reply}`)
      io.out(`${grant.path}.names: ${grant.names}`)
      io.out('')
      io.out(EMPTY_MEANS_NOBODY)
      io.out(INTAKE_IS_SOMEBODY_ELSE)
      // Said here, where somebody is reading what the rule allows: the two
      // acts are separate, and the second one is about disclosure rather than
      // about talking. Printed whether or not either is on — a person
      // deciding whether to turn one on is exactly who needs it.
      io.out(METADATA_IS_DISCLOSURE)
      io.out(NEVER_REPLIED_TO)
    })

  // --- the inbox: what has been handed to this machine, and what to do about one
  //
  // Reading is three commands and none of them opens the workbench: the
  // journal and the task files are files, and the rule that questions never
  // need the window is what makes `tade intake` answerable while one is open.
  // Acting is three more, and every one of them goes through `withWorkbench`,
  // which is where "ask it there, or close it first" is said.

  intake
    .command('status', { isDefault: true })
    .description('Per source: what the grant says, when it last looked, and what is waiting')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const home = tadeHome()
      const cfg = await loadConfig(defaultConfigPath())
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.error)
        return
      }
      const events = await readJournal(home)
      const rows = await inboxFrom({ home, events })
      const waiting = inboxWaiting(rows)
      const kept = readSchedules(home)
      const sources = INTAKE_SOURCES.map((source) => {
        const grant = intakeGrant(cfg.config, source)
        const mine = rows.filter((row) => row.source === source)
        // The watch's own schedule, found by what it watches rather than by a
        // name somebody may have changed.
        const schedule = kept.find(
          (one) => one.does.kind === 'watch' && one.does.watch === `intake.${source}`,
        )
        const look = schedule ? (watchedFrom(events, schedule.id).looks[0] ?? null) : null
        return {
          source,
          grant,
          /** Why nothing could come in yet, for the steps below. Null when it could. */
          unfinished: intakeUnfinished(grant),
          schedule: schedule?.id ?? null,
          // A look that could not look is not a look that found nothing, and
          // `describeLook` is the one place that difference is written down.
          look: look ? describeLook(look) : null,
          lookedAt: look?.at ?? null,
          handed: mine.length,
          waiting: mine.filter((row) => WAITING_STATES.includes(row.state)).length,
        }
      })
      if (opts.json) {
        io.out(JSON.stringify({ sources, waiting: waiting.length, handed: rows.length }, null, 2))
        return
      }
      for (const one of sources) {
        const bits = [
          one.grant.on && one.grant.accept ? 'accept on' : 'accept off',
          // Three words rather than two, because "reply on" alone does not say
          // whether a status names somebody's repository and laptop.
          one.grant.reply
            ? one.grant.names
              ? 'reply on, named'
              : 'reply on, unnamed'
            : 'reply off',
          one.grant.mode,
          one.grant.template ? `${one.grant.template}` : 'no template',
        ]
        io.out(`${one.source}  ${bits.join('  ')}`)
        io.out(
          `  ${one.schedule ? `${one.schedule}: ${one.look ?? 'has not looked yet'}` : 'nothing is watching it'}`,
        )
        io.out(
          `  ${one.handed} handed over, ${one.waiting} waiting for you${one.unfinished ? `, and ${one.unfinished}` : ''}`,
        )
      }
      // The steps, for a source nobody has finished writing a grant for. Here
      // rather than in a page of its own because this is where somebody is
      // deciding, and a connector whose grant a person cannot work out how to
      // write is a connector nobody turns on.
      for (const one of sources.filter((each) => each.unfinished)) {
        io.out('')
        io.out(`to turn ${one.source} on:`)
        for (const step of INTAKE_SETUP[one.source]) io.out(`  ${step}`)
      }
      io.out('')
      io.out(INTAKE_IS_SOMEBODY_ELSE)
    })

  intake
    .command('inbox [project]')
    .description('What has been handed to this machine, and where each one stands')
    .option('--waiting', 'only the ones waiting for you')
    .option('--json', 'machine-readable output')
    .action(async (project: string | undefined, opts: { waiting?: boolean; json?: boolean }) => {
      const home = tadeHome()
      const all = await inboxFrom({
        home,
        events: await readJournal(home),
        ...(project ? { project } : {}),
      })
      const rows = opts.waiting ? inboxWaiting(all) : all
      if (opts.json) {
        io.out(JSON.stringify({ requests: rows }, null, 2))
        return
      }
      if (rows.length === 0) {
        io.out(
          project
            ? `nothing has been handed to ${project}`
            : 'nothing has been handed to this machine',
        )
        return
      }
      const width = Math.max(0, ...rows.map((row) => row.item.length))
      for (const row of rows) {
        const what = row.template ? `${row.template.name}@${row.template.version}` : '—'
        io.out(
          `${row.item.padEnd(width)}  ${row.state.padEnd(8)}  ${row.project}  @${row.requester || '—'}  ${what}`,
        )
        io.out(`${' '.repeat(width)}  ${row.because}`)
      }
    })

  intake
    .command('show <id>')
    .description('One request: where it came from, what it says, and what approving it would start')
    .option('--dry-run', 'what approving it would start, and start nothing')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { dryRun?: boolean; json?: boolean }) => {
      const home = tadeHome()
      const cfg = await loadConfig(defaultConfigPath())
      const opened = await openIntakeRow({ home, events: await readJournal(home), item: id })
      if (!opened) {
        io.err(`nothing called ${id} has been handed to this machine`)
        setExit(Exit.invalidInput)
        return
      }
      // A dry run with no config read is not a dry run: it would print nothing
      // about what would start and look exactly like a request that would
      // start nothing. Said, and refused, rather than quietly left out.
      if (opts.dryRun && !cfg.ok) {
        io.err(
          `${cfg.path}: invalid config, so what approving it would start cannot be worked out (run \`tade config --check\`)`,
        )
        setExit(Exit.error)
        return
      }
      const would =
        opts.dryRun && cfg.ok
          ? await intakeWouldRun(
              { home, config: cfg.config, events: (filter) => readJournal(home, filter) },
              opened.row,
            )
          : null
      if (opts.json) {
        io.out(JSON.stringify({ ...opened, ...(would ? { would } : {}) }, null, 2))
        return
      }
      const width = Math.max(0, ...opened.facts.map((fact) => fact.label.length))
      for (const fact of opened.facts) io.out(`${fact.label.padEnd(width)}  ${fact.value}`)
      io.out('')
      io.out(`state     ${opened.row.state}: ${opened.row.because}`)
      for (const { act, off } of inboxActs(opened.row)) {
        io.out(`  ${act.padEnd(8)}${off ? `not now: ${off}` : 'yes'}`)
      }
      if (would) {
        io.out('')
        for (const line of wouldRunSays(would)) io.out(line)
      }
      io.out('')
      // The label over the region, then what Tade wrote down — which carries
      // the whole wording of what material means inside it, in the same bytes
      // the agent on this work reads.
      io.out(MATERIAL_LABEL)
      if (opened.material.body === null) {
        io.out(`  ${opened.material.problem ?? 'there is nothing to read'}`)
        return
      }
      io.out(`  (${opened.material.where})`)
      io.out('')
      io.out(opened.material.body.trimEnd())
    })

  intake
    .command('approve <id>')
    .description('Lift the park on what a request made, so the queue starts it')
    .option('--start', 'and start what waits on nothing, now')
    .action(async (id: string, opts: { start?: boolean }) => {
      await withWorkbench(io, setExit, async (tade) => {
        const acted = await approveIntake(tade, {
          item: id,
          ...(opts.start ? { start: true } : {}),
          by: 'you',
        })
        io.out(acted.said)
      })
    })

  intake
    .command('refuse <id>')
    .description('Say no to a request: written down, nothing posted, no agent stopped')
    .option('--why <text>', 'why, for whoever reads the journal')
    .action(async (id: string, opts: { why?: string }) => {
      await withWorkbench(io, setExit, async (tade) => {
        const acted = await refuseIntake(tade, {
          item: id,
          ...(opts.why ? { why: opts.why } : {}),
          by: 'you',
        })
        io.out(acted.said)
      })
    })

  intake
    .command('retry <id>')
    .description('Try a delivery that failed again, by asking its source for it again')
    .action(async (id: string) => {
      await withWorkbench(io, setExit, async (tade) => {
        // No `again` here, deliberately: asking a source again means running
        // that source's watch, and only an open window runs the extensions.
        // `retryIntake` says that in its own words rather than this command
        // guessing at a second way in.
        const acted = await retryIntake(tade, { item: id, by: 'you' })
        io.out(acted.said)
      })
    })
}
