import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type CarriedFile,
  fileDecision,
  fileHash,
  fileNamed,
  filesToCarry,
  fileThere,
  personaDirs,
  putFile,
  templateDirs,
  writeCarried,
} from '../src/index.ts'

// The files a remote is given of this home (`carry-files.ts`) — the personas
// somebody wrote and the templates somebody published — and the one writer a
// carried setting goes through where no window holds the home.

const PERSONA = `---
persona: reviewer
title: Reviewer
done: said
---

Read the change before you say anything about it.
`

const TEMPLATE = (version: number) => `template: triage
version: ${version}
title: Look at a report
project_input: project
said_input: summary
inputs:
  project: { kind: project }
  summary: { kind: text }
agents:
  - name: look
    persona: implementer
    prompt: Look at it.
`

describe('the files a home gives a remote', () => {
  it('is nothing in a home with neither, and every written persona and published version in one with both', async () => {
    const home = tmp('tade-carry-files-')
    expect(await filesToCarry(home)).toEqual([])
    mkdirSync(personaDirs(home).active, { recursive: true })
    writeFileSync(join(personaDirs(home).active, 'reviewer.md'), PERSONA)
    // Not a name Tade makes a file from, and not a persona file: neither is carried.
    writeFileSync(join(personaDirs(home).active, 'Not A Name.md'), PERSONA)
    writeFileSync(join(personaDirs(home).active, 'notes.txt'), 'x')
    const published = join(templateDirs(home).published, 'triage')
    mkdirSync(published, { recursive: true })
    writeFileSync(join(published, '1.yaml'), TEMPLATE(1))
    writeFileSync(join(published, '2.yaml'), TEMPLATE(2))
    writeFileSync(join(published, 'draft.yaml'), TEMPLATE(3))
    expect((await filesToCarry(home)).map(fileNamed)).toEqual([
      'persona reviewer',
      'template triage@1',
      'template triage@2',
    ])
  })

  it('writes one only whole, refusing what would not load and any path a name could make', async () => {
    const home = tmp('tade-carry-files-')
    const persona: CarriedFile = { kind: 'persona', name: 'reviewer', text: PERSONA }
    await putFile(home, persona)
    expect(await fileThere(home, persona)).toBe(PERSONA)
    await expect(
      putFile(home, { kind: 'template', name: 'triage', version: 2, text: TEMPLATE(1) }),
    ).rejects.toThrow('it says version 1, and was sent as 2')
    await expect(putFile(home, { kind: 'persona', name: 'x', text: 'no block' })).rejects.toThrow()
    // Refused reading the persona, and again where the path is made.
    await expect(
      putFile(home, { kind: 'persona', name: '../escape', text: PERSONA }),
    ).rejects.toThrow(/not a (persona )?name/)
    await expect(fileThere(home, { kind: 'persona', name: '../escape' })).rejects.toThrow(
      'is not a name Tade will use',
    )
    await expect(
      fileThere(home, { kind: 'template', name: 'triage', version: 1.5 }),
    ).rejects.toThrow('is not a version Tade publishes')
    expect(await fileThere(home, { kind: 'template', name: 'triage', version: 1 })).toBeNull()
  })

  it('writes a persona over only the one last carried, and a published version never', () => {
    const persona: CarriedFile = { kind: 'persona', name: 'reviewer', text: PERSONA }
    const template: CarriedFile = {
      kind: 'template',
      name: 'triage',
      version: 1,
      text: TEMPLATE(1),
    }
    const edited = `${PERSONA}\nAnd say thank you.\n`
    const decide = (
      file: CarriedFile,
      current: string | null,
      lastHash: string | null,
      force = false,
    ) => fileDecision({ file, current, lastHash, force })
    expect(decide(persona, null, null)).toBe('written')
    expect(decide(persona, PERSONA, null)).toBe('same')
    expect(decide(persona, edited, null)).toBe('theirs')
    expect(decide(persona, edited, fileHash(edited))).toBe('written')
    expect(decide(persona, edited, fileHash(PERSONA))).toBe('theirs')
    expect(decide(persona, edited, null, true)).toBe('written')
    expect(decide(template, null, null)).toBe('written')
    expect(decide(template, TEMPLATE(1), null)).toBe('same')
    expect(decide(template, TEMPLATE(1).replace('Look at it.', 'Other.'), null, true)).toBe(
      'refused',
    )
  })
})

describe('a carried setting written where no window holds the home', () => {
  const by = { device: 'd1', from: 'mac' }

  it('writes 0600 and says it was carried, and of a key how long it was and never what', async () => {
    const config = join(tmp('tade-carry-files-'), 'config.yaml')
    const lines: unknown[] = []
    const log = async (line: unknown) => {
      lines.push(line)
    }
    await writeCarried(
      config,
      { path: 'agents.commit', value: 'as-you-go', carry: 'kept', by },
      log,
    )
    await writeCarried(
      config,
      { path: 'extensions.jev.key', value: 'jev-0123456789', carry: 'pressed', by },
      log,
    )
    expect(readFileSync(config, 'utf8')).toContain('commit: as-you-go')
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(lines).toEqual([
      {
        type: 'config_changed',
        detail: {
          path: 'agents.commit',
          was: '',
          now: 'as-you-go',
          by: 'device d1',
          carried: 'mac',
        },
      },
      {
        type: 'config_changed',
        detail: {
          path: 'extensions.jev.key',
          was: 'not set',
          now: 'set',
          by: 'device d1',
          carried: 'mac',
        },
      },
    ])
  })

  it('puts the file back as it was where the config would not load with it, and writes no line', async () => {
    const config = join(tmp('tade-carry-files-'), 'config.yaml')
    const lines: unknown[] = []
    const log = async (line: unknown) => {
      lines.push(line)
    }
    await expect(
      writeCarried(config, { path: 'agents.commit', value: 'whenever', carry: 'kept', by }, log),
    ).rejects.toThrow()
    expect(() => readFileSync(config, 'utf8')).toThrow()
    writeFileSync(config, 'agents:\n  commit: never\n')
    await expect(
      writeCarried(config, { path: 'agents.commit', value: 'whenever', carry: 'kept', by }, log),
    ).rejects.toThrow()
    expect(readFileSync(config, 'utf8')).toBe('agents:\n  commit: never\n')
    expect(lines).toEqual([])
  })
})
