import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash, draftYaml, readDraft, type Template, templateDirs } from '@tade/core'
import { Moved, NotOffered, NotThere } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { webDrafting } from '../../src/wire/web-drafting.ts'

// Saving one field of one draft, against real files.
//
// **Real files and not a stub**, for the reason the repository's git tests use
// real repositories: the thing being checked is what happens on disk — that a
// published version is never touched, that a draft that moved under a screen
// is refused with what is true now, and that what is written is what the pure
// validator produced. A stub of `writeDraft` would make every one of those a
// test about the stub.

const FROM = { how: 'remote', device: '00112233445566aa' } as const

const draft: Template = {
  template: 'reproduce-and-fix',
  version: 4,
  title: 'Reproduce, then fix',
  about: 'two steps',
  project_input: 'repo',
  said_input: 'about',
  inputs: {
    repo: { kind: 'project', required: true, about: 'which repository' },
    about: { kind: 'text', required: true, about: 'what this run is' },
  },
  agents: [
    {
      name: 'reproduce',
      prompt: 'Write a failing test.',
      touches: [],
      after: [],
      reads: [],
      leaves_checks: 'red',
    },
  ],
}

async function homeWith(template: Template = draft): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tade-drafting-'))
  const dirs = templateDirs(home)
  await mkdir(dirs.drafts, { recursive: true })
  await writeFile(join(dirs.drafts, `${template.template}.yaml`), draftYaml(template), 'utf8')
  return home
}

const rev = (template: Template = draft) => contentHash(draftYaml(template))

function drafting(home: string, over: { unlocked?: boolean } = {}) {
  const saved: string[] = []
  return {
    saved,
    web: webDrafting({
      home,
      drafting: () => over.unlocked ?? true,
      saved: (name) => saved.push(name),
      now: () => Date.parse('2026-10-09T14:30:00.000Z'),
    }),
  }
}

describe('saving one field of one draft', () => {
  it('writes the field, and says what no run reads until somebody publishes', async () => {
    const home = await homeWith()
    const made = drafting(home)
    const out = await made.web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'template',
        field: 'title',
        value: 'Reproduce a bug, then fix it',
      },
      FROM,
    )
    expect(out.did).toBe(true)
    expect(out.said).toContain('no run reads until somebody here publishes it')
    // On disk, through the same writer the window's own form uses.
    const text = await readFile(join(templateDirs(home).drafts, 'reproduce-and-fix.yaml'), 'utf8')
    expect(text).toContain('Reproduce a bug, then fix it')
    // And the revision it answers with is the one a second save must echo.
    expect(out.rev).toBe(contentHash(text))
    // The fold that reads the templates on a clock of its own is told, because
    // a file edit writes no journal line for it to notice.
    expect(made.saved).toEqual(['reproduce-and-fix'])
  })

  it('writes a step’s field, resolved by the step’s name', async () => {
    const home = await homeWith()
    const out = await drafting(home).web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'reproduce',
        field: 'prompt',
        value: 'Write a failing test, and nothing else.',
      },
      FROM,
    )
    expect(out.did).toBe(true)
    const text = await readFile(join(templateDirs(home).drafts, 'reproduce-and-fix.yaml'), 'utf8')
    expect(text).toContain('nothing else')
  })

  it('refuses a step name that is not there, rather than writing somewhere else', async () => {
    // **The failure this prevents**: a position moves when somebody adds a
    // step, so a save against one would write the right field of the wrong
    // agent — silently. The name is resolved against the draft this save just
    // read.
    const home = await homeWith()
    await expect(
      drafting(home).web.save(
        {
          template: 'reproduce-and-fix',
          was: rev(),
          scope: 'renamed',
          field: 'prompt',
          value: 'x',
        },
        FROM,
      ),
    ).rejects.toBeInstanceOf(NotThere)
  })

  it('refuses a draft that has moved, with what is true now', async () => {
    const home = await homeWith()
    const made = drafting(home)
    // Somebody at the machine, or another phone, saved first.
    await made.web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'template',
        field: 'about',
        value: 'the first save',
      },
      FROM,
    )
    const moved = made.web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'template',
        field: 'about',
        value: 'the second save',
      },
      FROM,
    )
    await expect(moved).rejects.toBeInstanceOf(Moved)
    // The truth goes back with the refusal, so the page redraws rather than
    // showing a toast about a world it cannot see.
    await moved.catch((err: unknown) => {
      expect((err as Moved).rev).not.toBe(rev())
      expect((err as Moved).message).toContain('edited since this screen was drawn')
    })
    // And the second value is not on disk: the first save stands.
    const text = await readFile(join(templateDirs(home).drafts, 'reproduce-and-fix.yaml'), 'utf8')
    expect(text).toContain('the first save')
    expect(text).not.toContain('the second save')
  })

  it('refuses a draft that is not there at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-drafting-none-'))
    await expect(
      drafting(home).web.save(
        {
          template: 'nothing-here',
          was: 'sha256:aaaa',
          scope: 'template',
          field: 'title',
          value: 'x',
        },
        FROM,
      ),
    ).rejects.toBeInstanceOf(NotThere)
  })

  it('refuses a field the validator does not know, with the validator’s sentence', async () => {
    // `editWorkflow` is the pure validator the file goes through, so a save can
    // never write what publishing would refuse — and the refusal is its own
    // words rather than a `500`.
    const home = await homeWith()
    const refused = drafting(home).web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'template',
        field: 'version',
        value: '9',
      },
      FROM,
    )
    await expect(refused).rejects.toBeInstanceOf(NotOffered)
    await refused.catch((err: unknown) => {
      expect((err as Error).message).toContain('not a field of this template')
    })
  })

  it('refuses a step name the validator will not have, with its sentence', async () => {
    const home = await homeWith()
    const refused = drafting(home).web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'reproduce',
        field: 'name',
        value: 'A Step',
      },
      FROM,
    )
    await expect(refused).rejects.toBeInstanceOf(NotOffered)
  })

  it('answers a value that was already that as an answer, not a failure', async () => {
    const home = await homeWith()
    const out = await drafting(home).web.save(
      {
        template: 'reproduce-and-fix',
        was: rev(),
        scope: 'template',
        field: 'title',
        value: 'Reproduce, then fix',
      },
      FROM,
    )
    expect(out.did).toBe(false)
    expect(out.said).toContain('was already that')
    expect(out.rev).toBe(rev())
  })

  it('never writes outside the drafts directory, whatever it is handed', async () => {
    // Enforcement by absence: `writeDraft` builds its own path and nothing
    // passed in can move it. The gate refuses a name like this first
    // (`DRAFT_NAME`), and this is the second answer behind it.
    const home = await homeWith()
    await expect(
      drafting(home).web.save(
        { template: '../escaped', was: rev(), scope: 'template', field: 'title', value: 'x' },
        FROM,
      ),
    ).rejects.toBeInstanceOf(NotThere)
  })

  it('saves every field the designer’s own form offers, including a wait', async () => {
    // **The round trip the two patterns exist for.** `workflowFields` is what
    // the page draws and `editWorkflow` is what the save goes through, so a
    // field the first produces and the second refuses — or one the bound in
    // `drafting.ts` refuses on the way in — is a box somebody taps that can
    // only ever answer no. The dependency fields are the pair that would go
    // first, and the reason beside a wait is the whole argument.
    const two: Template = {
      ...draft,
      agents: [
        draft.agents[0] as (typeof draft.agents)[number],
        {
          name: 'fix',
          prompt: 'Make it pass.',
          touches: [],
          after: [{ agent: 'reproduce', why: 'the fix needs the failing test' }],
          reads: [],
          leaves_checks: 'green',
        },
      ],
    }
    const home = await homeWith(two)
    const made = drafting(home)
    for (const [scope, field, value] of [
      ['template', 'title', 'Reproduce a bug, then fix it'],
      ['template', 'about', 'two steps, in order'],
      ['reproduce', 'prompt', 'Write one failing test.'],
      ['fix', 'why:reproduce', 'the fix needs that test red first'],
      ['fix', 'after:reproduce', 'false'],
    ] as const) {
      const read = await readDraft(home, 'reproduce-and-fix')
      if ('problem' in read) throw new Error(read.problem)
      const out = await made.web.save(
        { template: 'reproduce-and-fix', was: rev(read.template), scope, field, value },
        FROM,
      )
      expect(out.did, `${scope}.${field}`).toBe(true)
    }
    // And the last of them actually took the wait off.
    const after = await readDraft(home, 'reproduce-and-fix')
    if ('problem' in after) throw new Error(after.problem)
    expect(after.template.agents[1]?.after).toEqual([])
  })

  it('reads the setting at every save, so turning it off means something now', async () => {
    const home = await homeWith()
    expect(drafting(home, { unlocked: false }).web.unlocked()).toBe(false)
    expect(drafting(home).web.unlocked()).toBe(true)
  })
})
