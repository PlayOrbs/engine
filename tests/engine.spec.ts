import { runGoldenTest } from './goldenTest.js'
import { runAllEngineTests } from './testSuite.js'

function failWith(messages: string[]): never {
  const out = messages.join('\n')
  throw new Error(out)
}

describe('Arena Engine — Deterministic Scoring', () => {
  it('golden test (single scenario) passes determinism and pot invariants', () => {
    const res = runGoldenTest()
    if (!res.ok) failWith(res.messages)
  })

  it('full suite: hashing, pots, ordering, tie-break, zeroed free, fuzz invariants', () => {
    const res = runAllEngineTests()
    if (!res.ok) failWith(res.messages)
  },100000);
})
