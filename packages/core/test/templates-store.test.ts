import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fillTemplate, foldPersonas } from '../src/templates.ts'
import {
  contentHash,
  draftYaml,
  parseTemplate,
  personaDirs,
  publishedVersions,
  publishTemplate,
  readDraft,
  readPersonas,
  readPublished,
  readTemplates,
  rejectTemplate,
  snapshotYaml,
  templateDirs,
  templateNameProblem,
  writeDraft,
} from '../src/templates-store.ts'

// What "published" has to mean for a run made in March to be able to say what
// it was made from: a snapshot written once, never rewritten, with no clock in
// it and with its personas already folded in — so nothing anybody edits
// afterwards can change what an existing task came from.

const DRAFT = `template: mine
version: 1
title: One change
project_input: project
said_input: summary
name_suffix: ticket
inputs:
  project: { kind: project }
  ticket: { kind: slug }
  summary: { kind: text }
agents:
  - name: fix
    persona: implementer
    prompt: Fix it.
`

describe('the template store', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tade-templates-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const draft = async (text = DRAFT, name = 'mine') => {
    await mkdir(templateDirs(home).drafts, { recursive: true })
    await writeFile(join(templateDirs(home).drafts, `${name}.yaml`), text, 'utf8')
  }
  const personas = async () => (await readPersonas(home)).personas

  it('reads Tade’s own personas with no directory anywhere', async () => {
    const read = await readPersonas(home)
    expect(read.broken).toEqual([])
    expect([...read.personas.keys()]).toContain('implementer')
    expect(read.source.get('implementer')).toBe('built-in')
    expect(read.overridden).toEqual([])
  })

  it('lets one of yours stand in for one of Tade’s, and says which', async () => {
    const dirs = personaDirs(home)
    await mkdir(dirs.active, { recursive: true })
    await writeFile(
      join(dirs.active, 'implementer.md'),
      '---\npersona: implementer\ndone: said\n---\n\nMine, not Tade’s.\n',
      'utf8',
    )
    const read = await readPersonas(home)
    expect(read.personas.get('implementer')?.prompt).toBe('Mine, not Tade’s.')
    expect(read.source.get('implementer')).toBe('yours')
    expect(read.overridden).toEqual(['implementer'])
  })

  it('names a persona that will not read rather than loading it half-way', async () => {
    const dirs = personaDirs(home)
    await mkdir(dirs.active, { recursive: true })
    await writeFile(
      join(dirs.active, 'broken.md'),
      '---\npersona: broken\naccount: mine\n---\n\nx\n',
      'utf8',
    )
    const read = await readPersonas(home)
    expect(read.personas.has('broken')).toBe(false)
    expect(read.broken[0]?.name).toBe('broken')
    expect(read.broken[0]?.problems.join('\n')).toMatch(/account is not a persona's to set/)
    // And the others still loaded, which is the whole reason it is named.
    expect(read.personas.has('implementer')).toBe(true)
  })

  it('publishes a draft as a snapshot with its personas folded in', async () => {
    await draft()
    const result = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    const text = await readFile(result.path, 'utf8')
    expect(contentHash(text)).toBe(result.hash)
    const read = parseTemplate('mine', text)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const agent = read.template.agents[0]
    expect(agent?.persona).toBeUndefined()
    expect(agent?.from_persona).toBe('implementer')
    expect(agent?.from_persona_hash).toMatch(/^sha256:[0-9a-f]{12}$/)
    // The persona's own words are in the snapshot, ahead of the agent's.
    expect(agent?.prompt).toContain('You are making one change')
    expect(agent?.prompt.trimEnd().endsWith('Fix it.')).toBe(true)
  })

  it('carries no clock, so the same draft always hashes the same', async () => {
    await draft()
    const first = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') return
    const text = await readFile(first.path, 'utf8')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    // Published again from the same bytes: nothing to do, same hash.
    const again = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(again.kind).toBe('unchanged')
    if (again.kind !== 'unchanged') return
    expect(again.hash).toBe(first.hash)
  })

  it('refuses to change a version that is published, naming the one to bump to', async () => {
    await draft()
    await publishTemplate({ home, name: 'mine', personas: await personas() })
    await draft(DRAFT.replace('Fix it.', 'Fix it differently.'))
    const result = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.problems.join('\n')).toMatch(/bump version to 2/)
    // And the file on disk is exactly what it was.
    const text = await readFile(join(templateDirs(home).published, 'mine', '1.yaml'), 'utf8')
    expect(text).toContain('Fix it.')
    expect(text).not.toContain('Fix it differently.')
  })

  it('a run keeps exactly what it was made from, whatever happens to the persona afterwards', async () => {
    await draft()
    const published = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') return
    const before = await readPublished(home, 'mine')
    expect('problem' in before).toBe(false)
    if ('problem' in before) return

    // Somebody rewrites the persona the template was published with.
    const dirs = personaDirs(home)
    await mkdir(dirs.active, { recursive: true })
    await writeFile(
      join(dirs.active, 'implementer.md'),
      '---\npersona: implementer\ndone: said\n---\n\nSomething else entirely.\n',
      'utf8',
    )
    const after = await readPublished(home, 'mine')
    expect('problem' in after).toBe(false)
    if ('problem' in after) return
    expect(after.hash).toBe(before.hash)
    expect(after.template.agents[0]?.prompt).toContain('You are making one change')
    expect(after.template.agents[0]?.prompt).not.toContain('Something else entirely')
  })

  it('publishes a bumped version beside the old one, and keeps both', async () => {
    await draft()
    await publishTemplate({ home, name: 'mine', personas: await personas() })
    await draft(DRAFT.replace('version: 1', 'version: 2').replace('Fix it.', 'Fix it better.'))
    const second = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(second.kind).toBe('published')
    expect(await publishedVersions(home, 'mine')).toEqual([2, 1])
    // Newest when none is named; the old one still reads exactly as it did.
    const newest = await readPublished(home, 'mine')
    expect('problem' in newest ? '' : newest.template.version).toBe(2)
    const old = await readPublished(home, 'mine', 1)
    expect('problem' in old ? '' : old.template.agents[0]?.prompt).toContain('Fix it.')
  })

  it('refuses a version behind one already published', async () => {
    await draft(DRAFT.replace('version: 1', 'version: 5'))
    await publishTemplate({ home, name: 'mine', personas: await personas() })
    await draft(DRAFT.replace('version: 1', 'version: 3'))
    const result = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.problems.join('\n')).toMatch(/behind 5, which is published: bump version to 6/)
  })

  it('refuses to publish a draft that does not hold together, and writes nothing', async () => {
    await draft(DRAFT.replace('persona: implementer', 'persona: wizard'))
    const result = await publishTemplate({ home, name: 'mine', personas: await personas() })
    expect(result.kind).toBe('refused')
    expect(await publishedVersions(home, 'mine')).toEqual([])
  })

  it('refuses to publish over a name Tade ships', async () => {
    await draft(
      DRAFT.replace('template: mine', 'template: bug-repro-fix-review'),
      'bug-repro-fix-review',
    )
    const result = await publishTemplate({
      home,
      name: 'bug-repro-fix-review',
      personas: await personas(),
    })
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.problems.join('\n')).toMatch(/one Tade ships/)
  })

  it('will not use a draft nobody published, and says what to do', async () => {
    await draft()
    const read = await readPublished(home, 'mine')
    expect('problem' in read).toBe(true)
    if (!('problem' in read)) return
    expect(read.problem).toMatch(/A draft is not published/)
  })

  it('lists what is there: Tade’s own, a draft, and which versions are published', async () => {
    await draft()
    await publishTemplate({ home, name: 'mine', personas: await personas() })
    await draft(DRAFT.replace('version: 1', 'version: 2'))
    const listed = await readTemplates(home)
    const mine = listed.templates.find((one) => one.name === 'mine')
    expect(mine).toMatchObject({ versions: [1], builtIn: false, unpublished: true })
    const builtIn = listed.templates.find((one) => one.name === 'bug-repro-fix-review')
    expect(builtIn).toMatchObject({ versions: [1], builtIn: true, draft: null })
  })

  it('names a draft that will not read rather than dropping it from the list', async () => {
    await draft('template: mine\nversion: [this: is\n')
    const listed = await readTemplates(home)
    const mine = listed.templates.find((one) => one.name === 'mine')
    expect(mine?.draft?.ok).toBe(false)
    expect(mine?.draft?.ok === false && mine.draft.problems.join('\n')).toMatch(/not readable/)
  })

  // A name reaches the store from a command line and from a tool call, so it
  // is a value from outside being joined onto a path. Refused at every door
  // that joins one — and the harm it would do is not a missing file: a file
  // that is not YAML comes back as a parse error carrying its first line,
  // which in a tool's answer is that line handed to a model.
  it.each([
    '../../../../etc/passwd',
    '..',
    '.',
    'templates/../../secrets',
    '/etc/hosts',
    'has space',
    'Upper',
  ])('refuses the name %s at every door that joins one onto a path', async (name) => {
    expect(templateNameProblem(name)).toBeTruthy()
    const drafted = await readDraft(home, name)
    expect('problem' in drafted && drafted.problem).toMatch(/not a name Tade will use/)
    const published = await readPublished(home, name)
    expect('problem' in published && published.problem).toMatch(/not a name Tade will use/)
    expect(await publishedVersions(home, name)).toEqual([])
    const result = await publishTemplate({ home, name, personas: await personas() })
    expect(result.kind).toBe('refused')
    await expect(rejectTemplate(home, name)).rejects.toThrow(/not a name Tade will use/)
  })

  it('refuses a draft whose own name is not one a file can be called', async () => {
    await draft(DRAFT.replace('template: mine', 'template: my_thing'), 'my_thing')
    const result = await publishTemplate({ home, name: 'my_thing', personas: await personas() })
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.problems.join('\n')).toMatch(/not a name Tade will use/)
  })

  it('writes a snapshot that reads back as the same thing it was', async () => {
    const read = parseTemplate('mine', DRAFT)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const folded = foldPersonas(read.template, await personas(), () => 'sha256:000000000000')
    const text = snapshotYaml(folded)
    const again = parseTemplate('mine', text)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(snapshotYaml(again.template)).toBe(text)
    // And a snapshot fills in with no personas at hand at all, which is the
    // whole point of folding them in.
    const fill = fillTemplate(again.template, {
      inputs: { project: 'shop', ticket: '1', summary: 'x' },
      projects: ['shop'],
      workspace: () => 'worktree',
      home,
      provenance: { template: 'mine', version: 1, hash: contentHash(text), builtIn: false },
      personas: new Map(),
    })
    expect(fill.ok).toBe(true)
    if (!fill.ok) return
    expect(fill.plan.agents[0]?.prompt).toContain('You are making one change')
  })

  // --- a draft written back, as the form in the window saves one

  it('writes a draft into the drafts directory and nowhere else', async () => {
    const read = parseTemplate('mine', DRAFT)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const written = await writeDraft(home, read.template)
    expect(written).toEqual({ path: join(templateDirs(home).drafts, 'mine.yaml') })
    // Read back by the door a draft is read by, which is the only thing that
    // makes the form and the file the same template.
    const again = await readDraft(home, 'mine')
    expect('problem' in again).toBe(false)
    if ('problem' in again) return
    expect(again.template.title).toBe('One change')
    // A draft is not a snapshot and has no content hash, so nothing can read
    // one as something a run was made from.
    expect(again.hash).toBe('')
  })

  it('says in the file that saving rewrites it, because a comment is not kept', async () => {
    const read = parseTemplate('mine', DRAFT)
    if (!read.ok) return
    await writeDraft(home, read.template)
    const text = await readFile(join(templateDirs(home).drafts, 'mine.yaml'), 'utf8')
    expect(text).toContain('Tade rewrites this file')
    expect(text).toContain('templates check')
    // The same fields in the same order as a snapshot, so the diff somebody
    // reads when they publish is the change they made and not a reordering.
    const folded = foldPersonas(read.template, new Map(), () => '')
    expect(
      text
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n'),
    ).toBe(
      snapshotYaml(folded)
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n'),
    )
  })

  it('refuses a name that would reach outside the drafts directory', async () => {
    const read = parseTemplate('mine', DRAFT)
    if (!read.ok) return
    for (const name of ['../../../../etc/passwd', 'a/b', '.', '..', 'Mine', '']) {
      const refused = await writeDraft(home, { ...read.template, template: name })
      expect('problem' in refused, name).toBe(true)
      if ('problem' in refused) expect(refused.problem).toBe(templateNameProblem(name))
    }
    // Nothing was written anywhere: a refusal rather than a sanitising, so
    // there is no sanitised path to have got wrong.
    await expect(readFile(join(templateDirs(home).drafts, 'passwd'), 'utf8')).rejects.toThrow()
  })

  it('refuses a draft under a name Tade ships, at the save rather than at the publish', async () => {
    const read = parseTemplate(
      'bug-repro-fix-review',
      DRAFT.replace('mine', 'bug-repro-fix-review'),
    )
    if (!read.ok) return
    const refused = await writeDraft(home, read.template)
    expect('problem' in refused).toBe(true)
    if ('problem' in refused) expect(refused.problem).toContain("Tade's own source")
  })

  it('round-trips: what a draft is written as is what reading it back gives', async () => {
    const read = parseTemplate('mine', DRAFT)
    if (!read.ok) return
    const once = draftYaml(read.template)
    const again = parseTemplate('mine', once)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(draftYaml(again.template)).toBe(once)
  })
})
