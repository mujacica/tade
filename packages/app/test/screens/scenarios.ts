import { AGENT_SCREENS } from './scenarios/agents.ts'
import { EXTENSION_SCREENS } from './scenarios/extensions.ts'
import { FILE_SCREENS } from './scenarios/files.ts'
import type { Scenario } from './scenarios/fixtures.ts'
import { PANEL_SCREENS } from './scenarios/panels.ts'
import { QUEUE_SCREENS } from './scenarios/queue.ts'
import { SCHEDULE_SCREENS } from './scenarios/schedules.ts'
import { SEARCH_SCREENS } from './scenarios/search.ts'
import { SETTINGS_SCREENS } from './scenarios/settings.ts'
import { SPEND_SCREENS } from './scenarios/spend.ts'
import { WINDOW_SCREENS } from './scenarios/window.ts'

// The screens the window must keep looking like.
//
// Each scenario is a state and a frame, drawn with fixed data so the result is
// the same on every machine: no clock, no git, no terminal. They are what the
// golden files under `__screens__/` are drawn from, and what the gallery shows
// a person reviewing a change to how Tade looks.
//
// Add one whenever the window gains a state worth protecting. Name it for what
// somebody would be doing when they saw it — and put it in the file for what it
// is about, beside the ones it will be read next to. This file is only the
// gathering; the world they are all drawn against is `scenarios/fixtures.ts`.
//
// Nothing keys on the order or on which file a scenario came from: a golden is
// found by `scenario.name`, and so is a picture.

export type { Scenario } from './scenarios/fixtures.ts'

export const SCENARIOS: Scenario[] = [
  ...AGENT_SCREENS,
  ...QUEUE_SCREENS,
  ...SCHEDULE_SCREENS,
  ...WINDOW_SCREENS,
  ...EXTENSION_SCREENS,
  ...SETTINGS_SCREENS,
  ...SPEND_SCREENS,
  ...FILE_SCREENS,
  ...SEARCH_SCREENS,
  ...PANEL_SCREENS,
]
