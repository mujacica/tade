import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { isPersonaName, type Persona, parsePersona } from './personas.ts'
import { joined } from './queue.ts'
import {
  foldPersonas,
  Template,
  type TemplateAgent,
  type TemplateProvenance,
  templateProblems,
} from './templates.ts'
import { BUILT_IN_PERSONAS, BUILT_IN_TEMPLATES } from './templates-builtin.ts'

// Where personas and templates live, and what "published" means.
//
// Nothing is in a repository. Both are Tade's own files, under Tade's own home
// beside the skills, the journal and the task folders — so no project needs a
// `.gitignore` line, no project is touched, and a project Tade has stamped a
// hundred templates into looks exactly like one it has never seen. There is no
// `docs/` folder for any of this and no database.
//
//   <TADE_HOME>/personas/{active,proposed,rejected}/<name>.md
//   <TADE_HOME>/templates/{drafts,rejected}/<name>.yaml
//   <TADE_HOME>/templates/published/<name>/<version>.yaml
//
// Personas keep the three directories the lessons already have, and the
// argument is already written: a proposal is inert until somebody reads it,
// and a turned-down one is kept so the same idea is not proposed twice.
//
// **Templates do not, and this is the one place this slice overrules the
// research it was written from.** research.md §9.6 says publishing a template
// is moving its file into `active/`, "which means it is scriptable, reviewable
// and undoable with `mv`". That is true and it cannot be squared with the
// thing a template has to promise: a run made in March must say what it was
// made from, and a file in `active/` is a file somebody edits in April. So
// publishing here *takes a snapshot* — a separate immutable file, named by
// version, with its personas already folded in — and the draft goes on being a
// draft. What a run was made from is then a thing that exists rather than a
// thing that was true once:
//
// - a published version is written once and never rewritten. Publishing the
//   same bytes again is nothing; publishing different bytes under the same
//   version is **refused**, naming the version to bump to;
// - the personas are *folded in* at publish, with each one's hash, so a
//   persona edited afterwards cannot change what a published template does;
// - the snapshot carries **no clock**, so its hash is a pure function of its
//   content — which is what a content hash has to be for any of the above to
//   mean anything. When a thing was published is the journal's.
//
// **Publishing is a local human act, and that is enforced by absence.** There
// is no tool here the orchestrator can reach: it may list, dry-run and use
// what is already published, and the path that writes a snapshot exists only
// in the CLI. An imported template is a draft like any other, and it stays
// one until somebody at this machine reads it and publishes it.

/**
 * Why a name is not one Tade will make a file from, or null when it is.
 *
 * **Every door below that joins a name onto a path goes through this first.**
 * A name reaches here from a command line and from a tool call — so it is a
 * value from outside this program being joined onto a path, and the one that
 * got away would not have been a missing file: `templates show
 * ../../../../etc/passwd` read somewhere else entirely, and a file that is not
 * YAML comes back as a parse error carrying the first line of it, which in a
 * tool's answer is that line handed to a model. Hence a refusal rather than a
 * sanitising: a name Tade could not have written is a caller that is confused,
 * and quietly reading a different file than the one it asked for is worse.
 *
 * The rule is a lesson's rule (`isPersonaName`) — lowercase, digits, dashes —
 * which has no `/`, no `.` and no `..` in it, so there is nothing to escape
 * with rather than a list of escapes to keep up with.
 */
export function templateNameProblem(name: string): string | null {
  return isTemplateName(name)
    ? null
    : `"${name}" is not a name Tade will use: lowercase letters, digits and dashes`
}

/** `sha256:` and the first twelve hex characters, which is what is shown. */
export function contentHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`
}

export interface TemplateDirs {
  root: string
  /** Where a template is written and edited. Being here is not being published. */
  drafts: string
  /** One folder per template, one immutable file per version. */
  published: string
  /** Kept, so the same idea is not proposed twice. */
  rejected: string
}

export function templateDirs(home: string): TemplateDirs {
  const root = join(home, 'templates')
  return {
    root,
    drafts: join(root, 'drafts'),
    published: join(root, 'published'),
    rejected: join(root, 'rejected'),
  }
}

export interface PersonaDirs {
  root: string
  active: string
  proposed: string
  rejected: string
}

export function personaDirs(home: string): PersonaDirs {
  const root = join(home, 'personas')
  return {
    root,
    active: join(root, 'active'),
    proposed: join(root, 'proposed'),
    rejected: join(root, 'rejected'),
  }
}

/** Something that is there and will not read, named rather than passed over. */
export interface Broken {
  name: string
  /** Where it is, as a person would go and look. */
  where: string
  problems: string[]
}

export interface PersonasRead {
  personas: Map<string, Persona>
  /** Which of them Tade ships, and which the person wrote. */
  source: Map<string, 'built-in' | 'yours'>
  broken: Broken[]
  /** One of yours standing in for one of Tade's, which is allowed and said. */
  overridden: string[]
}

/** The files in one directory, `.md` or `.yaml`, in a stable order. */
async function filesIn(dir: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith(extension))
      .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // No directory is none of them, and nothing is wrong with that.
    return []
  }
}

/**
 * Every persona there is: Tade's own, then the ones in `active/`, which win.
 *
 * A persona of yours standing in for one of Tade's is allowed on purpose —
 * "implementer should always say this here" is the main thing anybody wants —
 * and it is *said* rather than silent. It cannot reach back into anything
 * already published, because a published template has its personas folded in.
 */
export async function readPersonas(home: string): Promise<PersonasRead> {
  const personas = new Map<string, Persona>()
  const source = new Map<string, 'built-in' | 'yours'>()
  const broken: Broken[] = []
  const overridden: string[] = []
  for (const [name, text] of Object.entries(BUILT_IN_PERSONAS)) {
    const read = parsePersona(name, text)
    // A built-in that will not parse is Tade's own bug, and it is named here
    // rather than thrown: one broken persona must not stop the others loading.
    if (!read.ok) broken.push({ name, where: 'built in', problems: read.problems })
    else {
      personas.set(name, read.persona)
      source.set(name, 'built-in')
    }
  }
  const dirs = personaDirs(home)
  for (const file of await filesIn(dirs.active, '.md')) {
    const name = file.slice(0, -'.md'.length)
    const where = join(dirs.active, file)
    let text: string
    try {
      text = await readFile(where, 'utf8')
    } catch (err) {
      broken.push({ name, where, problems: [(err as Error).message] })
      continue
    }
    const read = parsePersona(name, text)
    if (!read.ok) {
      broken.push({ name, where, problems: read.problems })
      continue
    }
    if (source.get(name) === 'built-in') overridden.push(name)
    personas.set(name, read.persona)
    source.set(name, 'yours')
  }
  return { personas, source, broken, overridden }
}

/** A persona's hash, over the file as it would be written. */
export function personaHash(persona: Persona): string {
  // Over the fields rather than over the bytes, so whitespace in a file nobody
  // meant to change does not read as a different persona. The order is fixed
  // here, which is the whole of what makes it reproducible.
  return contentHash(
    stringifyYaml({
      persona: persona.name,
      title: persona.title,
      ...(persona.done !== undefined ? { done: persona.done } : {}),
      ...(persona.produces !== undefined ? { produces: persona.produces } : {}),
      ...(persona.thinking !== undefined ? { thinking: persona.thinking } : {}),
      ...(persona.model !== undefined ? { model: persona.model } : {}),
      ...(persona.touches !== undefined ? { touches: persona.touches } : {}),
      prompt: persona.prompt,
    }),
  )
}

export type TemplateParse = { ok: true; template: Template } | { ok: false; problems: string[] }

/** One template file, parsed as far as its shape. Never throws. */
export function parseTemplate(name: string, text: string): TemplateParse {
  let body: unknown
  try {
    body = parseYaml(text)
  } catch (err) {
    return { ok: false, problems: [`not readable: ${(err as Error).message.split('\n')[0]}`] }
  }
  const parsed = Template.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => {
        const at = issue.path.join('.')
        return at ? `${at}: ${issue.message}` : issue.message
      }),
    }
  }
  if (parsed.data.template !== name) {
    return {
      ok: false,
      problems: [`it says template: ${parsed.data.template}, and the file is called ${name}`],
    }
  }
  return { ok: true, template: parsed.data }
}

/**
 * The draft of one template, or why there is none that reads.
 *
 * Deliberately a separate door from `readPublished`: a draft is a file
 * somebody is still editing, and the only thing allowed to read one is a
 * person at this machine asking what it would do. Nothing that stamps a
 * template out comes through here.
 */
export async function readDraft(
  home: string,
  name: string,
): Promise<Published | { problem: string }> {
  const refused = templateNameProblem(name)
  if (refused) return { problem: refused }
  const path = join(templateDirs(home).drafts, `${name}.yaml`)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { problem: `there is no draft at ${path}` }
  }
  const read = parseTemplate(name, text)
  if (!read.ok) return { problem: `${path}: ${joined(read.problems)}` }
  // No hash: a draft is not a snapshot, and giving one a content hash would
  // make a thing somebody is still editing look like something a run could
  // have been made from.
  return { template: read.template, hash: '', builtIn: false }
}

/** One published version of one template, as it was written down. */
export interface Published {
  template: Template
  hash: string
  builtIn: boolean
}

export function provenanceOf(one: Published): TemplateProvenance {
  return {
    template: one.template.template,
    version: one.template.version,
    hash: one.hash || null,
    builtIn: one.builtIn,
  }
}

/** Every version of one template that is published, newest first. */
export async function publishedVersions(home: string, name: string): Promise<number[]> {
  if (templateNameProblem(name)) return []
  if (BUILT_IN_TEMPLATES[name]) {
    const read = parseTemplate(name, BUILT_IN_TEMPLATES[name])
    return read.ok ? [read.template.version] : []
  }
  const dir = join(templateDirs(home).published, name)
  const found = (await filesIn(dir, '.yaml'))
    .map((file) => Number(file.slice(0, -'.yaml'.length)))
    .filter((version) => Number.isInteger(version) && version > 0)
  return found.sort((a, b) => b - a)
}

/**
 * One published version: the newest when none is named.
 *
 * This is the only door `use` and `dry-run` go through, so a draft nobody
 * published can never be stamped out by the orchestrator. A built-in is
 * published by construction — its bytes are in Tade's own source.
 */
export async function readPublished(
  home: string,
  name: string,
  version?: number,
): Promise<Published | { problem: string }> {
  const refused = templateNameProblem(name)
  if (refused) return { problem: refused }
  const builtIn = BUILT_IN_TEMPLATES[name]
  if (builtIn) {
    const read = parseTemplate(name, builtIn)
    if (!read.ok)
      return { problem: `${name} is built in and will not read: ${joined(read.problems)}` }
    if (version !== undefined && version !== read.template.version) {
      return {
        problem: `${name} is built in at version ${read.template.version}, and there is no ${version}`,
      }
    }
    return { template: read.template, hash: contentHash(builtIn), builtIn: true }
  }
  const versions = await publishedVersions(home, name)
  const want = version ?? versions[0]
  if (want === undefined) {
    return {
      problem: `nothing called ${name} is published${versions.length === 0 ? '. A draft is not published: read it, then `tade templates publish`' : ''}`,
    }
  }
  if (!versions.includes(want)) {
    return {
      problem: `${name}@${want} is not published${versions.length ? `; there ${versions.length === 1 ? 'is' : 'are'} ${joined(versions.map(String))}` : ''}`,
    }
  }
  const path = join(templateDirs(home).published, name, `${want}.yaml`)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { problem: `${name}@${want}: ${(err as Error).message}` }
  }
  const read = parseTemplate(name, text)
  if (!read.ok) {
    return { problem: `${name}@${want} will not read: ${joined(read.problems)}` }
  }
  return { template: read.template, hash: contentHash(text), builtIn: false }
}

/** What one template is, across its draft and its published versions. */
export interface TemplateStanding {
  name: string
  /** The draft, when there is one, or why it will not read. */
  draft: TemplateParse | null
  /** Published versions, newest first. */
  versions: number[]
  builtIn: boolean
  /** The draft says a version that is already published, with other bytes. */
  unpublished: boolean
}

/** Every template there is: built in, drafted, published, turned down. */
export async function readTemplates(home: string): Promise<{
  templates: TemplateStanding[]
  rejected: string[]
}> {
  const dirs = templateDirs(home)
  const names = new Set<string>(Object.keys(BUILT_IN_TEMPLATES))
  const drafts = new Map<string, TemplateParse>()
  for (const file of await filesIn(dirs.drafts, '.yaml')) {
    const name = file.slice(0, -'.yaml'.length)
    names.add(name)
    try {
      drafts.set(name, parseTemplate(name, await readFile(join(dirs.drafts, file), 'utf8')))
    } catch (err) {
      drafts.set(name, { ok: false, problems: [(err as Error).message] })
    }
  }
  let published: string[] = []
  try {
    published = (await readdir(dirs.published, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    published = []
  }
  for (const name of published) names.add(name)
  const templates: TemplateStanding[] = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const versions = await publishedVersions(home, name)
    const draft = drafts.get(name) ?? null
    const standing: TemplateStanding = {
      name,
      draft,
      versions,
      builtIn: Boolean(BUILT_IN_TEMPLATES[name]),
      unpublished: false,
    }
    if (draft?.ok) {
      standing.unpublished = !versions.includes(draft.template.version)
    }
    templates.push(standing)
  }
  return { templates, rejected: (await filesIn(dirs.rejected, '.yaml')).map((f) => f.slice(0, -5)) }
}

/**
 * The published file's bytes for a template, with every field written out.
 *
 * Built field by field in a fixed order rather than handed the parsed object,
 * because the hash of this text is what immutability is measured against: key
 * order deciding whether a version "changed" would make the promise depend on
 * which version of a YAML library was installed. Defaults are written out too,
 * so a snapshot says what it does rather than what a schema would have filled
 * in.
 *
 * No clock, no path, no machine name. The hash is a function of the content
 * and nothing else; when it was published is the journal's.
 */
export function snapshotYaml(template: Template): string {
  return [
    '# Published by Tade. This file is immutable: a change is a new version.',
    '# Its personas are folded in, so nothing outside it can change what it makes.',
    stringifyYaml(bodyOf(template), { lineWidth: 0 }),
  ].join('\n')
}

/**
 * A draft's bytes, as the form writes one back.
 *
 * The same fields in the same order as a snapshot, deliberately: a draft that
 * was published should differ from its snapshot in the header and nothing
 * else, so the diff a person reads when they publish is the change they made
 * rather than a reordering.
 *
 * **It says what it costs.** Writing a draft from the form rewrites the file,
 * so anything in it that is not a field — a comment somebody left, their own
 * key order, a blank line between two steps — is not kept. That is a real loss
 * and the header is where somebody finds out about it, rather than by
 * noticing their comments gone.
 */
export function draftYaml(template: Template): string {
  return [
    '# A draft. Tade rewrites this file when the form saves it, so a comment',
    '# here is not kept — edit by hand or edit in the form, whichever you prefer.',
    '# `tade templates check` is the same validator the form runs.',
    stringifyYaml(bodyOf(template), { lineWidth: 0 }),
  ].join('\n')
}

/** Every field of a template, written out in one fixed order. */
function bodyOf(template: Template): Record<string, unknown> {
  const agent = (one: TemplateAgent) => ({
    name: one.name,
    ...(one.from_persona !== undefined ? { from_persona: one.from_persona } : {}),
    ...(one.from_persona_hash !== undefined ? { from_persona_hash: one.from_persona_hash } : {}),
    ...(one.persona !== undefined ? { persona: one.persona } : {}),
    ...(one.project_input !== undefined ? { project_input: one.project_input } : {}),
    prompt: one.prompt,
    ...(one.done !== undefined ? { done: one.done } : {}),
    ...(one.produces !== undefined ? { produces: one.produces } : {}),
    ...(one.thinking !== undefined ? { thinking: one.thinking } : {}),
    ...(one.model !== undefined ? { model: one.model } : {}),
    touches: one.touches,
    after: one.after.map((dep) => ({ agent: dep.agent, why: dep.why })),
    reads: one.reads,
    leaves_checks: one.leaves_checks,
  })
  const body = {
    template: template.template,
    version: template.version,
    title: template.title,
    about: template.about,
    project_input: template.project_input,
    said_input: template.said_input,
    ...(template.name_suffix !== undefined ? { name_suffix: template.name_suffix } : {}),
    inputs: Object.fromEntries(
      Object.entries(template.inputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, input]) => [
          name,
          { kind: input.kind, required: input.required, about: input.about },
        ]),
    ),
    agents: template.agents.map(agent),
  }
  return body
}

export type PublishResult =
  | { kind: 'published'; version: number; hash: string; path: string; warnings: string[] }
  | { kind: 'unchanged'; version: number; hash: string; path: string }
  | { kind: 'refused'; problems: string[] }

/**
 * Publish a draft: validate it, fold its personas in, and write the snapshot —
 * or refuse, with every reason.
 *
 * Only ever called from the CLI, by a person at this machine. The validation
 * here is the template's own shape; whether it stands up against the real tree
 * is `dry-run`'s answer, and the recipe says to read one before publishing,
 * because that is a human rule and belongs where humans read.
 */
export async function publishTemplate(req: {
  home: string
  name: string
  personas: ReadonlyMap<string, Persona>
}): Promise<PublishResult> {
  const { home, name } = req
  const refused = templateNameProblem(name)
  if (refused) return { kind: 'refused', problems: [refused] }
  if (BUILT_IN_TEMPLATES[name]) {
    return {
      kind: 'refused',
      problems: [
        `${name} is one Tade ships, and its bytes are in Tade's own source: give yours another name and publish that`,
      ],
    }
  }
  const dirs = templateDirs(home)
  const draft = join(dirs.drafts, `${name}.yaml`)
  let text: string
  try {
    text = await readFile(draft, 'utf8')
  } catch {
    return { kind: 'refused', problems: [`there is no draft at ${draft}`] }
  }
  const read = parseTemplate(name, text)
  if (!read.ok) return { kind: 'refused', problems: read.problems }
  const checked = templateProblems(read.template, { personas: req.personas })
  if (checked.problems.length > 0) return { kind: 'refused', problems: checked.problems }

  const version = read.template.version
  const already = await publishedVersions(home, name)
  const newest = already[0]
  const snapshot = snapshotYaml(foldPersonas(read.template, req.personas, personaHash))
  const hash = contentHash(snapshot)
  const path = join(dirs.published, name, `${version}.yaml`)
  if (already.includes(version)) {
    const there = await readFile(path, 'utf8').catch(() => '')
    if (contentHash(there) === hash) return { kind: 'unchanged', version, hash, path }
    return {
      kind: 'refused',
      problems: [
        `${name}@${version} is published and a published version never changes: bump version to ${(newest ?? version) + 1} and publish that. What ran on ${version} says ${version}, and has to go on saying it`,
      ],
    }
  }
  if (newest !== undefined && version < newest) {
    return {
      kind: 'refused',
      problems: [
        `${name}@${version} is behind ${newest}, which is published: bump version to ${newest + 1}`,
      ],
    }
  }
  await mkdir(join(dirs.published, name), { recursive: true })
  await writeFile(path, snapshot, 'utf8')
  return { kind: 'published', version, hash, path, warnings: checked.warnings }
}

/**
 * Write a draft back, as the form saves one.
 *
 * **Drafts only, and by absence rather than by a check**: the path is the
 * drafts directory and nothing passed in can move it, so there is no shape in
 * which this writes a published version. A published version is immutable and
 * `publishTemplate` is the only thing that writes one.
 *
 * **It refuses a name Tade ships.** Those live in Tade's own source and a
 * draft beside one would be a second answer to the same name, which is the
 * thing `publishTemplate` already refuses — said here too, at the save, so
 * nobody edits for ten minutes to be told at the end.
 */
export async function writeDraft(
  home: string,
  template: Template,
): Promise<{ path: string } | { problem: string }> {
  const name = template.template
  const refused = templateNameProblem(name)
  if (refused) return { problem: refused }
  if (BUILT_IN_TEMPLATES[name]) {
    return {
      problem: `${name} is one Tade ships, and its bytes are in Tade's own source: give yours another name`,
    }
  }
  const dirs = templateDirs(home)
  await mkdir(dirs.drafts, { recursive: true })
  const path = join(dirs.drafts, `${name}.yaml`)
  await writeFile(path, draftYaml(template), 'utf8')
  return { path }
}

/** Turn a draft down, keeping it so the same idea is not drafted twice. */
export async function rejectTemplate(home: string, name: string): Promise<string> {
  const refused = templateNameProblem(name)
  if (refused) throw new Error(refused)
  const dirs = templateDirs(home)
  await mkdir(dirs.rejected, { recursive: true })
  const to = join(dirs.rejected, `${name}.yaml`)
  await rename(join(dirs.drafts, `${name}.yaml`), to)
  return to
}

/** Whether a name is one Tade will make a file from. */
export function isTemplateName(name: string): boolean {
  return isPersonaName(name)
}
