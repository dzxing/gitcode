// JSON is untrusted until its shape has been checked by the caller.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(text)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
