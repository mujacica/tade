import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  addToContext,
  CONTEXT_MAX,
  ContextNotOurs,
  ContextTooBig,
  NoTaskFolder,
} from '../src/context.ts'
import { taskContextPath } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// Adding to what a task's agent is told: the containment, the bound, and the
// one thing an append can never do.
//
// **A real home, real folders and real symlinks.** What is being asked here is
// whether a link out of Tade's home is written through, and that is not a
// question a fake filesystem can answer — the whole point of `realpath` and
// `O_NOFOLLOW` is what the kernel does with a link.

const shut: Workbench[] = []

afterEach(async () => {
  for (const one of shut) await one.close().catch(() => {})
  shut.length = 0
})

async function open() {
  const repo = mkrepo()
  const home = tmp('tade-context-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  const client = await Workbench.open({ home })
  shut.push(client)
  const task = await client.createTask({
    project: 'app',
    slug: 'migration',
    intent: 'the migration keeps failing',
  })
  return { home, repo, client, task: task.id }
}

/** What the context file holds, or the empty string for none. */
function contextOf(home: string, task: string): string {
  try {
    return readFileSync(taskContextPath(home, task), 'utf8')
  } catch {
    return ''
  }
}

describe('adding to a task’s context', () => {
  it('appends under a heading Tade wrote, with the words verbatim beneath it', async () => {
    const one = await open()
    const add = '  The COLUMN is nullable.\n\n    See the ticket.  '
    const made = await addToContext(one.client, {
      task: one.task,
      add,
      by: 'device 00112233445566aa',
      at: Date.parse('2026-10-09T11:00:00.000Z'),
    })
    const text = contextOf(one.home, one.task)
    // **Verbatim**, indentation and case and blank line and trailing spaces:
    // this is not a note and nothing here trims anything. The heading above
    // it is Tade's and says where it came from, so an agent reading its
    // context can tell what arrived afterwards from what the owner wrote.
    expect(text).toContain(add)
    expect(text).toContain('## Added 2026-10-09T11:00:00.000Z by device 00112233445566aa')
    expect(made.bytes).toBe(text.length)
    expect(made.heading).toContain('by device 00112233445566aa')
  })

  it('makes the file where a task never had one', async () => {
    const one = await open()
    expect(existsSync(taskContextPath(one.home, one.task))).toBe(false)
    await addToContext(one.client, { task: one.task, add: 'first', by: 'you', at: 1 })
    expect(contextOf(one.home, one.task)).toContain('first')
  })

  it('writes down how much was added and never a word of it', async () => {
    const one = await open()
    await addToContext(one.client, {
      task: one.task,
      add: 'the column is nullable',
      by: 'device 00112233445566aa',
      at: 1,
    })
    const lines = await one.client.events({ types: ['context_added'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.task).toBe(one.task)
    expect(lines[0]?.detail).toMatchObject({
      by: 'device 00112233445566aa',
      added: 'the column is nullable'.length,
    })
    // The text is in the file, where the agent reads it. A journal holding a
    // copy would put somebody's words in two places with one unreachable.
    expect(JSON.stringify(lines[0]?.detail)).not.toContain('nullable')
  })

  it('writes nothing down when the write itself failed', async () => {
    // The order is the file, then the line: nothing is written down that did
    // not happen, so a throw leaves no record claiming it did.
    const one = await open()
    await expect(
      addToContext(one.client, { task: 'app/nothing', add: 'x', by: 'you', at: 1 }),
    ).rejects.toThrow(NoTaskFolder)
    expect(await one.client.events({ types: ['context_added'] })).toEqual([])
  })

  it('cannot lose what somebody wrote here, whichever order the two land in', async () => {
    // **The property an If-Match was reaching for**, and an append has it by
    // construction: there is no shape in the call for what the context should
    // *become*. Two at once, both from the same door, and both survive —
    // which is `aloneOn`'s doing and is why the write goes through it.
    const one = await open()
    await Promise.all([
      addToContext(one.client, { task: one.task, add: 'from the phone', by: 'device aa', at: 1 }),
      addToContext(one.client, { task: one.task, add: 'from the keyboard', by: 'you', at: 2 }),
    ])
    const text = contextOf(one.home, one.task)
    expect(text).toContain('from the phone')
    expect(text).toContain('from the keyboard')
    expect(await one.client.events({ types: ['context_added'] })).toHaveLength(2)
  })

  it('keeps an edit somebody made at the machine between two appends', async () => {
    const one = await open()
    await addToContext(one.client, {
      task: one.task,
      add: 'from the phone',
      by: 'device aa',
      at: 1,
    })
    // Somebody edits the file itself, which is what an owner at the machine
    // does and what nothing here may undo.
    const where = taskContextPath(one.home, one.task)
    writeFileSync(where, `${readFileSync(where, 'utf8')}\nand a line typed here\n`)
    await addToContext(one.client, {
      task: one.task,
      add: 'and more from away',
      by: 'device aa',
      at: 2,
    })
    const text = contextOf(one.home, one.task)
    expect(text).toContain('and a line typed here')
    expect(text).toContain('and more from away')
  })
})

describe('what it refuses to write', () => {
  it('refuses a task id that is not one, before it builds any path at all', async () => {
    const one = await open()
    for (const task of [
      '',
      'app',
      '../../etc/passwd',
      'app/../other',
      'app/one/two',
      'APP/One',
      'app/one two',
      'app/..',
    ]) {
      await expect(
        addToContext(one.client, { task, add: 'x', by: 'you', at: 1 }),
        task,
      ).rejects.toThrow(NoTaskFolder)
    }
  })

  it('refuses a context file that is a symlink, rather than following it', async () => {
    // **`O_NOFOLLOW`, and that one is atomic**: the check and the write are
    // the same call, so there is no window in which a link could be put there
    // between them.
    const one = await open()
    const elsewhere = join(tmp('tade-elsewhere-'), 'somebody-elses.md')
    writeFileSync(elsewhere, 'theirs\n')
    symlinkSync(elsewhere, taskContextPath(one.home, one.task))
    await expect(
      addToContext(one.client, { task: one.task, add: 'mine', by: 'device aa', at: 1 }),
    ).rejects.toThrow(ContextNotOurs)
    expect(readFileSync(elsewhere, 'utf8')).toBe('theirs\n')
  })

  it('refuses a task folder that resolves outside Tade’s home', async () => {
    // What `taskDir` on its own does **not** catch: joining names produces a
    // path inside the home and says nothing about what the directories on it
    // are. A folder that is a link pointing out of the home is the case, and a
    // home restored from a backup is how somebody gets one without meaning to.
    const one = await open()
    const outside = tmp('tade-outside-')
    const theirs = join(outside, 'tasks', 'escaped')
    mkdirSync(theirs, { recursive: true })
    writeFileSync(join(theirs, 'context.md'), 'theirs\n')
    const folder = taskDir(one.home, 'app/escaped')
    mkdirSync(join(folder, '..'), { recursive: true })
    symlinkSync(theirs, folder)
    await expect(
      addToContext(one.client, { task: 'app/escaped', add: 'mine', by: 'device aa', at: 1 }),
    ).rejects.toThrow(ContextNotOurs)
    expect(readFileSync(join(theirs, 'context.md'), 'utf8')).toBe('theirs\n')
  })

  it('refuses a task with no folder at all', async () => {
    const one = await open()
    await expect(
      addToContext(one.client, { task: 'app/never-made', add: 'x', by: 'you', at: 1 }),
    ).rejects.toThrow(NoTaskFolder)
  })

  it('refuses rather than truncating once the context is as big as one may be', async () => {
    // A **total** and not a per-append bound: without one a phone could add
    // four thousand characters a thousand times and rewrite an agent's
    // instructions by accumulation. And a refusal rather than a cut, because
    // half of what somebody wrote, written down verbatim, is a lie about what
    // they said.
    const one = await open()
    writeFileSync(taskContextPath(one.home, one.task), 'x'.repeat(CONTEXT_MAX - 10))
    await expect(
      addToContext(one.client, { task: one.task, add: 'this will not fit', by: 'you', at: 1 }),
    ).rejects.toThrow(ContextTooBig)
    // Nothing was written, and nothing was cut off the end of what was there.
    expect(contextOf(one.home, one.task).length).toBe(CONTEXT_MAX - 10)
    expect(await one.client.events({ types: ['context_added'] })).toEqual([])
  })

  it('says how big it is now, so a caller can say how much room is left', async () => {
    const one = await open()
    writeFileSync(taskContextPath(one.home, one.task), 'x'.repeat(CONTEXT_MAX))
    await addToContext(one.client, { task: one.task, add: 'x', by: 'you', at: 1 }).then(
      () => expect.fail('that should not have fitted'),
      (err: unknown) => {
        expect(err).toBeInstanceOf(ContextTooBig)
        expect((err as ContextTooBig).bytes).toBe(CONTEXT_MAX)
      },
    )
  })
})
