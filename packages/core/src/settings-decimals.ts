import { z } from 'zod'
import { ConfigSchema } from './config.ts'
import type { SettingGroup } from './settings.ts'

// Which number rows take a fraction of their unit, read from the config
// schema (`settings-numbers.ts` says why it is read rather than said). Apart
// from the arithmetic on a number, which the Settings panel does wherever it is
// drawn — a browser included — and which has no need of the whole schema.

/**
 * The schema a dotted config path names, through its defaults and optionals
 * and into a map such as `projects` by its entries' schema, whatever the key —
 * or null where the path names nothing in it.
 */
function schemaAt(path: string): z.ZodType | null {
  let here: z.ZodType | undefined = ConfigSchema
  const parts = path.split('.')
  while (here) {
    if (
      here instanceof z.ZodOptional ||
      here instanceof z.ZodDefault ||
      here instanceof z.ZodPrefault ||
      here instanceof z.ZodNullable
    ) {
      here = here.unwrap() as z.ZodType
      continue
    }
    const part = parts.shift()
    if (part === undefined) return here
    if (here instanceof z.ZodObject) here = here.shape[part] as z.ZodType | undefined
    else if (here instanceof z.ZodRecord) here = here.valueType as z.ZodType
    else return null
  }
  return null
}

/** Whether the config takes a number with a fraction at this path: dollars do, counts do not. */
function takesDecimals(path: string): boolean {
  const leaf = schemaAt(path)
  return leaf instanceof z.ZodNumber && !leaf.isInt
}

/** Every number row told by its schema whether it takes decimals. */
export function withDecimals(groups: SettingGroup[]): SettingGroup[] {
  return groups.map((group) => ({
    ...group,
    settings: group.settings.map((setting) =>
      setting.type.kind === 'number' && takesDecimals(setting.path)
        ? { ...setting, type: { ...setting.type, decimals: true } }
        : setting,
    ),
  }))
}
