import type { JsonSchema } from './port.ts'

// Tool parameters are JSON Schema, which is what every harness takes
// underneath, so an extension writes them once. These are the few shapes a
// tool needs, and the check a call's input gets before a tool sees it.

export function object(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const string = (description: string): JsonSchema => ({ type: 'string', description })
export const number = (description: string): JsonSchema => ({ type: 'number', description })
export const boolean = (description: string): JsonSchema => ({ type: 'boolean', description })

export function oneOf(values: readonly string[], description: string): JsonSchema {
  return { type: 'string', enum: [...values], description }
}

export function list(items: JsonSchema, description: string): JsonSchema {
  return { type: 'array', items, description }
}

/**
 * Why an input will not do, in words the caller can fix it from, or null.
 *
 * Only what a tool relies on: required values present, and each value of the
 * kind the schema says. Extra keys are let through — a model adding one is
 * not a reason to refuse the call it meant.
 */
export function inputProblem(schema: JsonSchema, input: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const key of required) {
    const value = input[key]
    if (value === undefined || value === null || value === '') {
      const about =
        typeof properties[key]?.description === 'string' ? `: ${properties[key]?.description}` : ''
      return `${key} is needed${about}`
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key]
    if (!property || value === undefined || value === null) continue
    const want = property.type
    const ok =
      want === 'string'
        ? typeof value === 'string'
        : want === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : want === 'boolean'
            ? typeof value === 'boolean'
            : want === 'array'
              ? Array.isArray(value)
              : want === 'object'
                ? typeof value === 'object'
                : true
    if (!ok) return `${key} should be a ${String(want)}`
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      return `${key} should be one of ${(property.enum as unknown[]).join(', ')}`
    }
  }
  return null
}
