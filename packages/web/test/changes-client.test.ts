import { describe, expect, it } from 'vitest'
import {
  countSaid,
  diffRows,
  figureOf,
  fileSaid,
  markWord,
  stateFor,
  takenSaid,
} from '../src/assets/pages/agent-changes-shape.js'
import { changesPath, pathOf, viewOf } from '../src/assets/routes.js'

// The page's half of an agent's changes: what an answer says, as rows and words.

const file = (over: Record<string, unknown> = {}) => ({
  path: 'src/a.ts',
  mark: 'M',
  added: 2,
  removed: 1,
  says: 'lines',
  text: '@@ -1 +1,2 @@\n-old\n+new\n+more\n',
  taken: 0,
  ...over,
})

describe('an agent’s changes, on the page', () => {
  it('is its own screen under the agent’s, in both directions', () => {
    expect(viewOf('/t/tade/away%20fix/changes')).toEqual({
      view: 'changes',
      project: 'tade',
      task: 'away fix',
    })
    expect(pathOf({ view: 'changes', project: 'tade', task: 'away fix' })).toBe(
      '/t/tade/away%20fix/changes',
    )
    expect(changesPath('tade/away-fix')).toBe('/t/tade/away-fix/changes')
    expect(viewOf('/t/tade/x/other').view).toBe('nowhere')
  })

  it('reads every line by its first character, and keeps an empty line as a row', () => {
    expect(
      diffRows('@@ -1 +1 @@\n context\n-gone\n+came\n\n\\ No newline at end of file\n'),
    ).toEqual([
      { line: '@@ -1 +1 @@', kind: 'hunk' },
      { line: ' context', kind: 'same' },
      { line: '-gone', kind: 'del' },
      { line: '+came', kind: 'add' },
      { line: '', kind: 'same' },
      { line: '\\ No newline at end of file', kind: 'meta' },
    ])
    expect(diffRows(null)).toEqual([])
  })

  it('counts the files and the lines either way, and a dash where git did not count', () => {
    const answer = { says: 'files', files: [file(), file({ added: 3, removed: 0 })] }
    expect(figureOf(answer)).toBe('2 files · +5 −1')
    expect(figureOf({ says: 'files', files: [file({ added: null, removed: null })] })).toBe(
      '1 file',
    )
    expect(figureOf({ says: 'none', files: [] })).toBe('')
    expect(countSaid(null, null)).toBe('—')
    expect(countSaid(4, null)).toBe('+4 −—')
    expect(markWord('?')).toBe('new')
    expect(markWord('Z')).toBe('changed')
  })

  it('says per file what did not come, and what the cleaning took out', () => {
    expect(fileSaid(file())).toBeNull()
    expect(fileSaid(file({ says: 'binary' }))).toContain('binary')
    expect(fileSaid(file({ says: 'unread' }))).toContain('could not')
    expect(takenSaid(file())).toBeNull()
    expect(takenSaid(file({ taken: 2 }))).toContain('2 taken out')
  })

  it('has a state for every answer without files, and none for one with them', () => {
    expect(stateFor({ says: 'files', files: [file()] }, null)).toBeNull()
    expect(stateFor(null, null)).toBeNull()
    expect(stateFor(null, 'offline')).toMatchObject({ kind: 'error', line: 'offline' })
    for (const says of ['none', 'not looked', 'not granted', 'not here', 'unread']) {
      const one = stateFor({ says, base: 'main', files: [] }, null)
      expect(one?.title, says).toBeTruthy()
    }
    expect(stateFor({ says: 'none', base: 'main', files: [] }, null)?.line).toContain('main')
    expect(stateFor({ says: 'unread', base: null, files: [] }, null)?.kind).toBe('error')
  })
})
