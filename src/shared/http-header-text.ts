/** A response header as text; repeated headers arrive as an array. */
export function headerText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}
