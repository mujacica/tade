import {
  defaultConfigPath,
  dryRunSays,
  INPUT_MEANS,
  isTemplateName,
  loadConfig,
  PERSONA_RULE,
  personaDirs,
  provenanceOf,
  publishTemplate,
  readDraft,
  readPersonas,
  readPublished,
  readTemplates,
  rejectTemplate,
  saysProvenance,
  tadeHome,
  templateDirs,
  templateProblems,
} from '@tade/core'
import { dryRunTemplate, type TemplateDeps } from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Personas and templates from the command line: reading them, checking one,
// asking what one would do, and publishing it.
//
// **Everything here but `publish` is a question, and questions never need the
// window.** The journal, the task files and the template files are read
// directly, so all of this answers with a window open or shut — and a dry run
// from here warns about the same collisions the window would, because it reads
// the same facts.
//
// **`publish` is here and nowhere else, and that is the enforcement.** It is
// the act that turns a file somebody wrote — or imported, or was sent — into
// something the orchestrator may stamp out, so it is a person at this machine
// and there is no tool for it. The orchestrator can list, dry-run and use what
// is already published; it cannot publish, and it cannot mint one.
//
// **Launching is not here.** Making tasks needs the workbench, and the window
// holds it, so the one door that stamps a template out is the orchestrator's
// `tade_template_use` — through the window, through the plan path, with every
// task parked. The group's help says so, rather than offering a command that
// could only ever answer "open the window first".

const DEPS = async (configPath: string, io: Io): Promise<TemplateDeps | null> => {
  const cfg = await loadConfig(configPath)
  if (!cfg.ok) {
    io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
    return null
  }
  const home = tadeHome()
  return { home, config: cfg.config, events: (filter) => readJournal(home, filter) }
}

/**
 * `mine` or `mine@2`, which is how every surface already writes one.
 *
 * A flag rather than this was the obvious shape and was wrong: commander's
 * root `--version` wins over a subcommand's own option of that name, so
 * `templates dry-run mine --version 1` printed Tade's version and dry-ran
 * something else. This is also the spelling `tade_templates` lists them in and
 * the one provenance reads back, so there is one way to write it.
 */
function nameAndVersion(said: string): { name: string; version?: number } {
  const at = said.lastIndexOf('@')
  if (at <= 0) return { name: said }
  const version = Number(said.slice(at + 1))
  // Not a number after the @ is a name with an @ in it, which `templateNameProblem`
  // refuses by itself — with a better message than anything guessed here.
  if (!Number.isInteger(version) || version <= 0) return { name: said }
  return { name: said.slice(0, at), version }
}

/** `--input summary=...` as pairs, refusing one with no `=` rather than guessing. */
function inputsOf(said: readonly string[] | undefined): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const pair of said ?? []) {
    const at = pair.indexOf('=')
    if (at <= 0) return `--input takes name=value, and "${pair}" is not one`
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

export function registerTemplates(program: Command, io: Io, setExit: (code: number) => void): void {
  const group = program
    .command('templates')
    .description(
      'Reusable workflows: a stored plan with holes in it. Reading, checking, asking what one would do, and publishing.\n' +
        'Using one makes tasks, which needs the window: ask the orchestrator for it there.',
    )

  group
    .command('list', { isDefault: true })
    .description('What is there: built in, drafted, published, turned down')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async () => {
      const home = tadeHome()
      const { templates, rejected } = await readTemplates(home)
      if (templates.length === 0) {
        io.out(
          `nothing yet. Write one in ${templateDirs(home).drafts}, then \`tade templates check\`.`,
        )
        return
      }
      for (const one of templates) {
        const versions =
          one.versions.length > 0
            ? `published ${one.versions.map((v) => `@${v}`).join(', ')}`
            : 'nothing published'
        const where = one.builtIn ? 'built in' : one.draft ? 'drafted' : 'published only'
        io.out(`${one.name} — ${where}, ${versions}`)
        if (one.draft?.ok) {
          io.out(`  ${one.draft.template.title}`)
          if (one.unpublished) {
            io.out(
              `  the draft says version ${one.draft.template.version}, which is not published yet`,
            )
          }
        }
        if (one.draft && !one.draft.ok) {
          io.out('  its draft will not read:')
          for (const problem of one.draft.problems) io.out(`    ${problem}`)
        }
      }
      if (rejected.length > 0) io.out(`\nturned down: ${rejected.join(', ')}`)
    })

  group
    .command('show <name>')
    .description(
      'One template: what it takes, what it would make, and what made each version.\n' +
        'As `mine`, or `mine@2` for a published version',
    )
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (said: string) => {
      const home = tadeHome()
      const { name, version } = nameAndVersion(said)
      const read = await readPublished(home, name, version)
      if ('problem' in read) {
        // A draft is not published, and saying only that would hide a draft
        // sitting right there: show it, marked as what it is.
        const draft = await draftOf(home, name)
        if (!draft) {
          io.err(read.problem)
          setExit(Exit.invalidInput)
          return
        }
        io.out(`${name} — a draft, not published. ${read.problem}`)
        sayTemplate(io, draft, null)
        return
      }
      io.out(saysProvenance(provenanceOf(read)))
      // A draft sitting beside it at another version is the thing somebody is
      // about to publish, and showing only the published one hides it.
      const draft = await draftOf(home, name)
      if (draft && draft.version !== read.template.version) {
        io.out(`there is also a draft at version ${draft.version}, not published yet`)
      }
      sayTemplate(io, read.template, read.hash)
    })

  group
    .command('check <name>')
    .description('Whether a draft holds together, before anybody fills it in')
    .action(async (name: string) => {
      const home = tadeHome()
      // The store's own answer, not a path built here: a second `join` on a
      // name from a command line is a second way out of the folder, even in a
      // message — and a message naming a file somewhere else reads as a bug.
      const read = await readDraft(home, name)
      if ('problem' in read) {
        io.err(read.problem)
        setExit(Exit.invalidInput)
        return
      }
      const draft = read.template
      const { personas, broken } = await readPersonas(home)
      for (const one of broken) {
        io.out(
          `a persona will not read, so a template naming it cannot be checked: ${one.name} (${one.where})`,
        )
        for (const problem of one.problems) io.out(`  ${problem}`)
      }
      const checked = templateProblems(draft, { personas })
      for (const warning of checked.warnings) io.out(`warning  ${warning}`)
      if (checked.problems.length > 0) {
        for (const problem of checked.problems) io.err(problem)
        setExit(Exit.invalidInput)
        return
      }
      io.out(`${name}@${draft.version} holds together.`)
      // The human rule, said where a human is about to decide. It is not in
      // the suite because nothing mechanical can check it against a tree that
      // has not been named yet.
      io.out('Dry-run it against the real tree before you publish it: a template that cannot')
      io.out('dry-run cleanly is not one to publish.')
    })

  group
    .command('dry-run <name>')
    .description(
      'What it would make, and it makes none of it.\n' +
        'Your own draft as `mine`, or a published version as `mine@2`',
    )
    .option('-i, --input <pair...>', 'name=value, once per input')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (said: string, opts: { input?: string[]; config: string }) => {
      const deps = await DEPS(opts.config, io)
      if (!deps) {
        setExit(Exit.invalidInput)
        return
      }
      const inputs = inputsOf(opts.input)
      if (typeof inputs === 'string') {
        io.err(inputs)
        setExit(Exit.invalidInput)
        return
      }
      const { name, version } = nameAndVersion(said)
      const dry = await dryRunTemplate(deps, {
        template: name,
        ...(version === undefined ? {} : { version }),
        inputs,
        // A person at this machine asking about their own draft, which is
        // exactly what `check` tells them to do before publishing it. Naming a
        // version asks for that published one instead.
        drafts: true,
      })
      if ('problem' in dry) {
        io.err(dry.problem)
        setExit(Exit.invalidInput)
        return
      }
      for (const line of dryRunSays(dry)) io.out(line)
      if (dry.problems.length > 0) setExit(Exit.invalidInput)
    })

  group
    .command('publish <name>')
    .description('Take a snapshot of a draft at its version. A published version never changes')
    .action(async (name: string) => {
      if (!isTemplateName(name)) {
        io.err(`${name} is not a name Tade will use`)
        setExit(Exit.invalidInput)
        return
      }
      const home = tadeHome()
      const { personas } = await readPersonas(home)
      const result = await publishTemplate({ home, name, personas })
      if (result.kind === 'refused') {
        for (const problem of result.problems) io.err(problem)
        setExit(Exit.invalidInput)
        return
      }
      if (result.kind === 'unchanged') {
        io.out(`${name}@${result.version} is already published, unchanged (${result.hash}).`)
        return
      }
      for (const warning of result.warnings) io.out(`warning  ${warning}`)
      io.out(`${name}@${result.version} published (${result.hash}).`)
      io.out(result.path)
      io.out('Its personas are folded in, so nothing you edit afterwards changes what it makes.')
    })

  group
    .command('reject <name>')
    .description('Turn a draft down, keeping it so the same idea is not drafted twice')
    .action(async (name: string) => {
      if (!isTemplateName(name)) {
        io.err(`${name} is not a name Tade will use`)
        setExit(Exit.invalidInput)
        return
      }
      try {
        io.out(`${name} — turned down, kept at ${await rejectTemplate(tadeHome(), name)}`)
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.invalidInput)
      }
    })
}

export function registerPersonas(program: Command, io: Io, setExit: (code: number) => void): void {
  const group = program
    .command('personas')
    .description(`Start defaults a template stamps out. ${PERSONA_RULE}`)

  group
    .command('list', { isDefault: true })
    .description('Which there are, which are yours, and which will not read')
    .action(async () => {
      const home = tadeHome()
      const read = await readPersonas(home)
      for (const [name, persona] of [...read.personas].sort(([a], [b]) => a.localeCompare(b))) {
        const mine = read.source.get(name) === 'yours'
        const over = read.overridden.includes(name) ? ', standing in for Tade’s own' : ''
        io.out(`${name} — ${persona.title}${mine ? ` (yours${over})` : ' (built in)'}`)
      }
      for (const one of read.broken) {
        io.out(`${one.name} — will not read, so it is not loaded: ${one.where}`)
        for (const problem of one.problems) io.out(`  ${problem}`)
      }
      io.out('')
      io.out(`write one in ${personaDirs(home).active}. ${PERSONA_RULE}`)
    })

  group
    .command('show <name>')
    .description('One persona: what it sets, and what its agent is told')
    .action(async (name: string) => {
      const read = await readPersonas(tadeHome())
      const persona = read.personas.get(name)
      if (!persona) {
        const broken = read.broken.find((one) => one.name === name)
        io.err(
          broken
            ? `${name} will not read: ${broken.problems.join('; ')}`
            : `there is no persona called ${name}`,
        )
        setExit(Exit.invalidInput)
        return
      }
      io.out(`${persona.name} — ${persona.title} (${read.source.get(name) ?? 'built in'})`)
      if (persona.done !== undefined) {
        io.out(
          `done: ${
            typeof persona.done === 'string'
              ? persona.done
              : Object.entries(persona.done)
                  .map(([where, rule]) => `${where}: ${rule}`)
                  .join(', ')
          }`,
        )
      }
      if (persona.produces) io.out(`produces: ${persona.produces}`)
      if (persona.thinking) io.out(`thinking: ${persona.thinking}`)
      if (persona.model) io.out(`model: ${persona.model}`)
      if (persona.touches) io.out(`touches: ${persona.touches.join(', ') || '(nothing)'}`)
      io.out('')
      io.out(persona.prompt)
    })
}

/**
 * The draft of one template, or null when there is none that reads.
 *
 * Through the store's own door rather than reading the file here, so the name
 * is checked in exactly one place: a second `join` on a name from a command
 * line is a second way out of the folder.
 */
async function draftOf(home: string, name: string) {
  const read = await readDraft(home, name)
  return 'problem' in read ? null : read.template
}

/** One template, as something to read: what it takes, then what it would make. */
function sayTemplate(
  io: Io,
  template: Parameters<typeof templateProblems>[0],
  hash: string | null,
): void {
  io.out(template.title)
  if (template.about.trim()) io.out(`\n${template.about.trim()}`)
  io.out('\nit takes:')
  for (const [name, input] of Object.entries(template.inputs)) {
    const named = [
      template.project_input === name ? 'the project' : null,
      template.said_input === name ? 'the request, verbatim' : null,
      template.name_suffix === name ? 'what every task name ends with' : null,
    ].filter(Boolean)
    io.out(
      `  ${name}  ${input.kind}${input.required ? '' : ', optional'} — ${input.about || INPUT_MEANS[input.kind]}${named.length ? ` (${named.join('; ')})` : ''}`,
    )
  }
  io.out('\nit would make:')
  for (const agent of template.agents) {
    const from = agent.from_persona ?? agent.persona
    const waits = agent.after.map((dep) => `after ${dep.agent} — ${dep.why}`)
    io.out(
      `  ${agent.name}${from ? `  ${from}` : ''}${agent.produces ? `  produces ${agent.produces}` : ''}`,
    )
    for (const wait of waits) io.out(`    ${wait}`)
    if (agent.reads.length > 0) io.out(`    reads what ${agent.reads.join(', ')} produced`)
    if (agent.leaves_checks === 'red') io.out('    expected to leave the checks red')
  }
  if (hash) io.out(`\n${hash} — a published version never changes.`)
}
