import { describe, expect, it } from 'vitest'
import { doneFor, PERSONA_RULE, parsePersona, REFUSED } from '../src/personas.ts'
import { BUILT_IN_PERSONAS } from '../src/templates-builtin.ts'

// A persona is task-start defaults and nothing else, and the whole of what is
// worth testing is the refusals: what it may not say, said in the words of the
// rule rather than as "unrecognized key", and a block that will not read
// refused whole rather than loaded with a field missing.

describe('a persona', () => {
  const file = (block: string, body = 'Do the thing.') => `---\n${block}\n---\n\n${body}\n`

  it('is the told fields, and the body is what its agent is told', () => {
    const read = parsePersona(
      'implementer',
      file(
        'persona: implementer\ntitle: Implementer\ndone: said\nthinking: high',
        'Make one change.',
      ),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.persona).toMatchObject({
      name: 'implementer',
      title: 'Implementer',
      done: 'said',
      thinking: 'high',
      prompt: 'Make one change.',
    })
  })

  it('may give a done rule per workspace, because a shared checkout cannot keep one', () => {
    const read = parsePersona(
      'implementer',
      file('persona: implementer\ndone:\n  worktree: committed\n  checkout: said'),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(doneFor(read.persona.done, 'worktree')).toBe('committed')
    expect(doneFor(read.persona.done, 'checkout')).toBe('said')
  })

  // The point of the list: the answer has to teach, because the mistake it
  // catches is somebody reaching for the field they wanted.
  it.each(REFUSED.map(([field]) => field))('refuses %s, in the words of the rule', (field) => {
    const read = parsePersona('p', file(`persona: p\n${field}: anything`))
    expect(read.ok).toBe(false)
    if (read.ok) return
    const said = read.problems.join('\n')
    expect(said).toContain(`${field} is not a persona's to set`)
    expect(said).toContain(PERSONA_RULE)
  })

  it('refuses a field nobody wired, so a typo is never a setting silently ignored', () => {
    const read = parsePersona('p', file('persona: p\nproduceses: plan.md'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toMatch(/produceses/)
  })

  it('refuses a block that will not read, rather than loading it with a field missing', () => {
    const read = parsePersona('p', file('persona: p\ndone: [this: is'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toMatch(/not readable/)
  })

  it('refuses a file with no block at all, naming the shape it wants', () => {
    const read = parsePersona('p', 'just some prose about an implementer')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toMatch(/starts with ---/)
  })

  it('refuses a name in the block that is not the name of the file', () => {
    const read = parsePersona('tester', file('persona: implementer'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toContain('the file is called tester.md')
  })

  it('refuses a document that would escape the task’s own folder', () => {
    const read = parsePersona('p', file('persona: p\nproduces: ../../etc/passwd'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toMatch(/climbs out of the task's folder/)
  })

  it('refuses one that tells its agent nothing', () => {
    const read = parsePersona('p', '---\npersona: p\n---\n\n   \n')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.join('\n')).toMatch(/tells its agent nothing/)
  })

  it('every one Tade ships reads, and none of them says anything authority', () => {
    for (const [name, text] of Object.entries(BUILT_IN_PERSONAS)) {
      const read = parsePersona(name, text)
      expect(read.ok, `${name}: ${read.ok ? '' : read.problems.join('; ')}`).toBe(true)
    }
    expect(Object.keys(BUILT_IN_PERSONAS).sort()).toEqual([
      'documenter',
      'implementer',
      'planner',
      'reviewer',
      'tester',
      'triage',
    ])
  })
})
