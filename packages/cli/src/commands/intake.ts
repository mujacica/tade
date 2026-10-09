import { readFile } from 'node:fs/promises'
import {
  defaultConfigPath,
  EMPTY_MEANS_NOBODY,
  INTAKE_IS_SOMEBODY_ELSE,
  intakeDecision,
  intakeItem,
  intakeMapped,
  loadConfig,
  tadeHome,
} from '@tade/core'
import { newestOf, readSpool, spool, spoolIdProblem } from '@tade/extension-intake'
import { intakeGrant } from '@tade/workbench'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

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
      io.out('')
      io.out(EMPTY_MEANS_NOBODY)
      io.out(INTAKE_IS_SOMEBODY_ELSE)
    })
}
