import { base, frame, type Scenario } from './fixtures.ts'

// The window as a phone draws it (§10 T4 of the Duo plan): the same drawing,
// at the size the full view fits on the Duo's large screen sideways — 129
// columns by 38 rows of 12 px type — with the sidebar's edge put on the fold,
// the centre column, as the page holds it there (`FarFace.holdSidebar`,
// `full-fit.js`). The phone paints these rows exactly as the pictures do
// (`full-cells.js`, held by `test/full-cells.test.ts`).

export const PHONE_SCREENS: Scenario[] = [
  {
    name: 'the-full-view-on-a-phone',
    about:
      'The window drawn by a phone held sideways on the Duo’s large screen, at 129 columns, with the sidebar’s edge on the fold.',
    state: { ...base(), sizes: { sidebarWidth: 64 } },
    frame: frame({ width: 129, height: 38 }),
  },
]
