import { describe, expect, it } from 'vitest'
import {
  assignmentsIn,
  envLine,
  HIDDEN,
  hiddenLine,
  isCredentialName,
  namesSystemdReads,
  SOURCE_LINE,
  unitIn,
} from '../src/env-files.ts'
import { envMoveNamedBy } from '../src/reach.ts'

// The files that set an environment, read for names and lines: a literal is
// handed back to be digested or moved, anything a shell works out is named and
// left, and nothing in a shape this does not know throws.

describe('a shell file', () => {
  it('names each assignment at its line, with a literal value and whether it can move', () => {
    const text = [
      '# keys',
      'export OPENROUTER_API_KEY="sk-or-123"',
      "export ANTHROPIC_API_KEY='sk-ant-456'",
      'GITHUB_TOKEN=ghp_789 # a comment',
      'export EMPTY_KEY=',
      'export PATH="$HOME/bin:$PATH"',
    ].join('\n')
    const found = assignmentsIn(text, 'sh')
    expect(found.map((one) => [one.name, one.line, one.state, one.movable])).toEqual([
      ['OPENROUTER_API_KEY', 2, 'literal', true],
      ['ANTHROPIC_API_KEY', 3, 'literal', true],
      ['GITHUB_TOKEN', 4, 'literal', true],
      ['EMPTY_KEY', 5, 'empty', false],
      ['PATH', 6, 'computed', false],
    ])
    expect(found[0]?.value).toBe('sk-or-123')
    expect(found[2]?.value).toBe('ghp_789')
  })

  it('leaves what the shell works out, and what sits inside a block, where it is', () => {
    const text = [
      'export A_TOKEN="$(op read op://vault/a)"',
      'export B_TOKEN=$OTHER',
      'if [ -n "$WORK" ]; then',
      '  export C_TOKEN=abc',
      'fi',
      'export D_TOKEN=after',
      'case $HOST in',
      'box) export E_TOKEN=x ;;',
      'esac',
      "export F_TOKEN='it''s'",
    ].join('\n')
    const by = Object.fromEntries(assignmentsIn(text, 'sh').map((one) => [one.name, one]))
    expect(by.A_TOKEN?.state).toBe('computed')
    expect(by.B_TOKEN?.state).toBe('computed')
    expect(by.C_TOKEN).toMatchObject({ state: 'literal', movable: false })
    expect(by.C_TOKEN?.why).toContain('inside a block')
    expect(by.D_TOKEN).toMatchObject({ state: 'literal', movable: true })
    expect(by.F_TOKEN?.movable).toBe(false)
  })

  it('reads fish for names, and never offers to move one', () => {
    const found = assignmentsIn('set -gx OPENAI_API_KEY sk-1\nset -x PLAIN_KEY "two"\n', 'fish')
    expect(found.map((one) => [one.name, one.state, one.movable])).toEqual([
      ['OPENAI_API_KEY', 'literal', false],
      ['PLAIN_KEY', 'literal', false],
    ])
  })

  it('never throws on a file in a shape it does not know', () => {
    expect(() => assignmentsIn('\u0000\u0001 = = export =\n"unterminated', 'sh')).not.toThrow()
    expect(() => assignmentsIn("x='", 'envfile')).not.toThrow()
    expect(unitIn('Environment="unterminated').assignments).toEqual([])
  })
})

describe('an environment file and a unit', () => {
  it('reads NAME=value lines as systemd does, quotes taken off', () => {
    const found = assignmentsIn('# c\n; c\nA_KEY=\'one\'\nexport B_KEY="two"\nC_KEY=\n', 'envfile')
    expect(found.map((one) => [one.name, one.state, one.value])).toEqual([
      ['A_KEY', 'literal', 'one'],
      ['B_KEY', 'literal', 'two'],
      ['C_KEY', 'empty', undefined],
    ])
  })

  it("reads a unit's Environment= words and the files EnvironmentFile= names", () => {
    const unit = unitIn(
      [
        '[Service]',
        'Environment="PATH=/usr/bin" LANG=C.UTF-8',
        'Environment=SENTRY_TOKEN=abc',
        'EnvironmentFile=-%h/.config/tade/env',
      ].join('\n'),
    )
    expect(unit.assignments.map((one) => one.name)).toEqual(['PATH', 'LANG', 'SENTRY_TOKEN'])
    expect(unit.files).toEqual(['-%h/.config/tade/env'])
  })
})

describe('writing and showing', () => {
  it('writes a line every reader reads as the same characters, and refuses one none can', () => {
    expect(envLine('A_KEY', 'sk-1 two')).toBe("A_KEY='sk-1 two'")
    expect(() => envLine('A_KEY', "it's")).toThrow(/single quote/)
    expect(() => envLine('1BAD', 'x')).toThrow()
    expect(namesSystemdReads(`${envLine('A_KEY', 'v')}\n${envLine('B_KEY', 'w')}\n`)).toEqual([
      'A_KEY',
      'B_KEY',
    ])
  })

  it('shows a line with its value hidden, never its length or first characters', () => {
    expect(hiddenLine('export OPENROUTER_API_KEY="sk-or-123"')).toBe(
      `export OPENROUTER_API_KEY=${HIDDEN}`,
    )
    expect(hiddenLine('export OPENROUTER_API_KEY="sk-or-123"')).not.toContain('sk-')
  })

  it('reads the one file only where it is there', () => {
    expect(SOURCE_LINE).toContain('[ -f "$HOME/.config/tade/env" ]')
    expect(SOURCE_LINE).toContain('set -a')
  })

  it('knows a credential by its name', () => {
    expect(isCredentialName('OPENROUTER_API_KEY')).toBe(true)
    expect(isCredentialName('GITHUB_TOKEN')).toBe(true)
    expect(isCredentialName('DB_PASSWORD')).toBe(true)
    expect(isCredentialName('PATH')).toBe(false)
    expect(isCredentialName('KEYBOARD')).toBe(false)
  })
})

describe('the person’s words that ask for a move', () => {
  it('are named by what they would say, and an unrelated line is not', () => {
    expect(envMoveNamedBy(['move my keys into one file please'])).not.toBeNull()
    expect(envMoveNamedBy(['consolidate the env file on the vps'])).not.toBeNull()
    expect(envMoveNamedBy(['put them in ~/.config/tade/env'])).not.toBeNull()
    expect(envMoveNamedBy(['how are the agents doing', 'what keys does the vps have'])).toBeNull()
  })
})
