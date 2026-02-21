export type TestResult = { ok: boolean; messages: string[] }
export function ok(msg?: string): TestResult { return { ok: true, messages: msg ? [msg] : [] } }
export function fail(msg: string): TestResult { return { ok: false, messages: [msg] } }
export function merge(a: TestResult, b: TestResult): TestResult {
  return { ok: a.ok && b.ok, messages: [...a.messages, ...b.messages] }
}
export function eq(a: any, b: any, msg: string): TestResult {
  if (a === b) return ok()
  return fail(`${msg}: expected ${String(b)} got ${String(a)}`)
}
export function truthy(cond: any, msg: string): TestResult {
  return cond ? ok() : fail(msg)
}
export function arrayEqual<T>(a: T[], b: T[], msg: string): TestResult {
  if (a.length !== b.length) return fail(`${msg}: length ${a.length}!==${b.length}`)
  for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return fail(`${msg}: index ${i} mismatch`)
  return ok()
}
export function diffJSON(expected: any, actual: any): string {
  try {
    const e = JSON.stringify(expected, null, 2)
    const a = JSON.stringify(actual, null, 2)
    return `Expected vs Actual\n--- Expected ---\n${e}\n--- Actual ---\n${a}`
  } catch { return 'diff unavailable' }
}
