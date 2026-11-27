import { join } from 'node:path'
import type { SkillDirs } from './skills.ts'

// Where a home's skills are on its disk. Apart from `skills.ts`, whose text is
// put in an agent's prompt and read where the window is drawn — in a browser
// too (`pure.ts`).

export function skillDirs(root: string): SkillDirs {
  return {
    root,
    active: join(root, 'active'),
    proposed: join(root, 'proposed'),
    rejected: join(root, 'rejected'),
  }
}
