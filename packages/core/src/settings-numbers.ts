import { z } from 'zod'
import { ConfigSchema } from './config.ts'
import type { SettingGroup, SettingKind } from './settings.ts'

// What a number row takes: whole ones, or a fraction of its unit — twelve
// dollars fifty — and that is read from the schema, never said again on the
// row. Every number used to be parsed as a count, so a budget of 12.50 was
// refused with "needs a whole number" by a schema that takes it; a flag on
// each row would only have been a second place to say it wrongly. Its own
// file because `settings.ts` is at its budget, the reason `settings-keep.ts`
// gives.

type NumberKind = Extract<SettingKind, { kind: 'number' }>

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

/** What was typed as the number it is, or undefined where the row cannot take it. */
export function numberFrom(type: NumberKind, text: string): number | undefined {
  const value = Number(text)
  if (type.fraction) return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
  const takes = type.decimals ? Number.isFinite(value) : Number.isInteger(value)
  // Above zero, unless the row goes lower: where nought is off (`from: 0`) it
  // is taken typed as the arrows reach it, or off could never be written.
  const enough = type.from === undefined ? value > 0 : value >= type.from
  return takes && enough ? value : undefined
}

/** What a number row wanted instead, when what was typed is not one it takes. */
export function numberWanted(type: NumberKind): string {
  if (type.fraction) return 'a number from 0 to 1'
  const what = type.decimals ? 'a number' : 'a whole number'
  return type.from === undefined ? `${what} above zero` : `${what} from ${type.from} up`
}

/**
 * What the arrows make of a number. A share moves a tenth at a time and never
 * leaves 0 to 1; anything else moves by one and never goes below `from` — and
 * keeps the places it was written with, since 2.3 less one is
 * 1.2999999999999998 otherwise.
 */
export function numberStepped(type: NumberKind, written: string, delta: number): string {
  const now = Number(written) || 0
  if (type.fraction) {
    // A tenth at a time, rounded: 0.1 + 0.1 is 0.30000000000000004 otherwise.
    return String(Math.min(1, Math.max(0, Math.round((now + delta * 0.1) * 10) / 10)))
  }
  const places = written.split('.')[1]?.length ?? 0
  return String(Number(Math.max(type.from ?? 1, now + delta).toFixed(places)))
}
