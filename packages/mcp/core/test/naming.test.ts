import {
  NAME_CAP,
  type NamedTool,
  nameProblem,
  namesFor,
  narrowed,
  type OfferedTool,
  prefixFor,
  RESERVED,
  SERVER_NAME_CAP,
  serverNameProblem,
  slugOf,
} from '@tade/mcp-core'
import { describe, expect, it } from 'vitest'

// What a brokered tool is called, and what it may never be called.
//
// All of §6.1 lives here as tables, because this is the one piece of the
// design that a model notices going wrong: a name that moves is a tool an
// agent reaches for and misses, and a name that shadows one of Tade's own is
// a tool that quietly never wins.

const tool = (name: string, over: Partial<OfferedTool> = {}): OfferedTool => ({
  name,
  description: 'Does a thing.',
  input: { type: 'object', properties: {} },
  ...over,
})

const named = (server: string, tools: readonly OfferedTool[]): (string | null)[] =>
  namesFor(server, tools).map((one) => one.name)

describe('a server’s name', () => {
  it.each([
    ['linear', null],
    ['github', null],
    ['a', null],
    ['sentry-mcp', null],
    ['x9', null],
    ['', 'a server needs a name'],
    ['Linear', 'not a usable name'],
    ['my_server', 'not a usable name'],
    ['-linear', 'not a usable name'],
    ['linear.io', 'not a usable name'],
    ['a-very-long-server-name', 'longer than 16 characters'],
  ])('%s', (name, said) => {
    const problem = serverNameProblem(name)
    if (said === null) expect(problem).toBeNull()
    else expect(problem).toContain(said)
  })

  it('leaves room for its tools’ names, whatever it is called', () => {
    const longest = 'x'.repeat(SERVER_NAME_CAP)
    expect(serverNameProblem(longest)).toBeNull()
    expect(prefixFor(longest).length).toBeLessThan(NAME_CAP - 8)
  })
})

describe('a server’s own tool name, as letters Tade can use', () => {
  it.each([
    // Run-of-not-letters becomes one underscore, and that is the whole rule:
    // camel case is not split, because `HTTPServer` has no one right answer
    // and a rule with an exception in it is a rule that moves.
    ['searchIssues', 'searchissues'],
    ['search-issues', 'search_issues'],
    ['Search.Issues', 'search_issues'],
    ['SEARCH  ISSUES', 'search_issues'],
    ['__search__', 'search'],
    ['search/issues/v2', 'search_issues_v2'],
    ['issue#1', 'issue_1'],
    ['проблема', 'tool'],
    ['', 'tool'],
    ['---', 'tool'],
  ])('%s becomes %s', (given, want) => {
    expect(slugOf(given)).toBe(want)
  })
})

describe('the name a harness is given', () => {
  it('is the server’s name, then the tool’s, and cannot be anything else', () => {
    expect(named('linear', [tool('searchIssues')])).toEqual(['mcp_linear_searchissues'])
    expect(named('sentry-mcp', [tool('issue')])).toEqual(['mcp_sentry_mcp_issue'])
  })

  it('is the same today as it was yesterday, whatever order the server said them in', () => {
    const tools = [tool('b'), tool('a'), tool('c')]
    const forwards = named('linear', tools)
    const backwards = named('linear', [...tools].reverse())
    expect(forwards).toEqual(backwards)
    // Sorted by the server's own name, so what a model learned is what it
    // finds: nothing here depends on what arrived first.
    expect(forwards).toEqual(['mcp_linear_a', 'mcp_linear_b', 'mcp_linear_c'])
  })

  it('gives the first of two that slug the same the slug, and the rest a number', () => {
    expect(named('linear', [tool('search-issues'), tool('searchIssues'), tool('Search.Issues')])) //
      .toEqual([
        // Sorted by what the server called them: `Search.Issues` first, then
        // `search-issues`, which slugs the same and so takes the number.
        'mcp_linear_search_issues',
        'mcp_linear_search_issues_2',
        'mcp_linear_searchissues',
      ])
  })

  it('cuts a name too long for a provider, and keeps two long ones apart', () => {
    const long = `${'a'.repeat(60)}_one`
    const other = `${'a'.repeat(60)}_two`
    const [first, second] = named('linear', [tool(long), tool(other)]) as [string, string]
    expect(first.length).toBeLessThanOrEqual(NAME_CAP)
    expect(second.length).toBeLessThanOrEqual(NAME_CAP)
    // They cut to the same letters, and the digest of what the server called
    // them is what keeps them two tools rather than one.
    expect(first).not.toBe(second)
    // `mcp__tade__` plus the name stays inside the 64 several providers cap at.
    expect(`mcp__tade__${first}`.length).toBeLessThanOrEqual(64)
  })

  it('drops what no harness could register, and says why, rather than breaking the server', () => {
    const made = namesFor('linear', [
      tool('good'),
      tool('bad', { input: { type: 'string' } }),
      tool('nameless', { description: '' }),
      { name: '', description: 'x', input: { type: 'object' } },
    ])
    const dropped = made.filter((one) => one.name === null)
    expect(made.filter((one) => one.name !== null).map((one) => one.name)).toEqual([
      'mcp_linear_good',
    ])
    expect(dropped).toHaveLength(3)
    for (const one of dropped) expect(one.dropped).toBeTruthy()
  })
})

describe('a name that would shadow one of Tade’s own', () => {
  it.each([
    ['mcp_linear_search', null],
    ['tade_status', "one of Tade's own names"],
    ['tade_done', "one of Tade's own names"],
    ['status', "one of Tade's own names"],
    ['approve', "one of Tade's own names"],
    ['deny', "one of Tade's own names"],
    ['tade', "one of Tade's own names"],
    ['Search', 'not a usable tool name'],
    ['search-issues', 'not a usable tool name'],
    ['_search', 'not a usable tool name'],
    ['', 'not a usable tool name'],
    [`mcp_x_${'a'.repeat(NAME_CAP)}`, `longer than ${NAME_CAP}`],
  ])('%s', (name, said) => {
    const problem = nameProblem(name)
    if (said === null) expect(problem).toBeNull()
    else expect(problem).toContain(said)
  })

  it('is never what comes out of naming a server’s tools, whatever they are called', () => {
    // The prefix is what actually answers — this is the fourth layer, and it
    // is here so a change to one of the other three cannot quietly open it.
    for (const server of ['tade', 'status', 'approve', 'mcp', 'x']) {
      for (const one of RESERVED) {
        for (const name of namesFor(server, [tool(one), tool(`tade_${one}`)])) {
          if (name.name === null) continue
          expect(nameProblem(name.name), name.name).toBeNull()
        }
      }
    }
  })
})

describe('a server narrowed to the tools it was turned on for', () => {
  const made = (): NamedTool[] => namesFor('linear', [tool('a'), tool('b'), tool('c')])

  it('offers all of them when nobody said otherwise', () => {
    expect(narrowed(made(), []).map((one) => one.name)).toEqual([
      'mcp_linear_a',
      'mcp_linear_b',
      'mcp_linear_c',
    ])
  })

  it('offers only the ones named, and says why the rest are not there', () => {
    const only = narrowed(made(), ['mcp_linear_b'])
    expect(only.map((one) => one.name)).toEqual([null, 'mcp_linear_b', null])
    expect(only[0]?.dropped).toContain('turned on for')
  })
})
