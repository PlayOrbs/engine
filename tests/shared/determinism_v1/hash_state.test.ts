import { describe, it, expect } from 'vitest'
import { initFromSeed, advanceFrame } from '../../../src/core/v1/sim.js'
import { hashStateV1 } from './hash_state.js'
import { baselineConfig, makePlayers, makeSeed } from './scenarios.js'

describe('hashStateV1', () => {
  it('identical deep-cloned states produce identical hashes', () => {
    const seed = makeSeed('hash-clone-test-v1')
    const players = makePlayers(3)

    const { state: stateA, prngs: prngsA } = initFromSeed(seed, players, baselineConfig)
    const { state: stateB, prngs: prngsB } = initFromSeed(seed, players, baselineConfig)

    // Advance both identically
    for (let i = 0; i < 100; i++) {
      advanceFrame(stateA, baselineConfig, prngsA)
      advanceFrame(stateB, baselineConfig, prngsB)
    }

    const hashA = hashStateV1(stateA)
    const hashB = hashStateV1(stateB)
    expect(hashA).toBe(hashB)
  })

  it('states differing only in PRNG state produce different hashes', () => {
    const seed = makeSeed('hash-prng-diff-test-v1')
    const players = makePlayers(3)

    const { state: stateA, prngs: prngsA } = initFromSeed(seed, players, baselineConfig)
    const { state: stateB, prngs: prngsB } = initFromSeed(seed, players, baselineConfig)

    // Advance both identically
    for (let i = 0; i < 50; i++) {
      advanceFrame(stateA, baselineConfig, prngsA)
      advanceFrame(stateB, baselineConfig, prngsB)
    }

    // Now consume one extra PRNG value from stateA's first orb
    // This changes PRNG state without changing any physics field
    stateA.orbs[0].prng.nextU32()

    const hashA = hashStateV1(stateA)
    const hashB = hashStateV1(stateB)
    expect(hashA).not.toBe(hashB)
  })

  it('states differing only in one orb velocity produce different hashes', () => {
    const seed = makeSeed('hash-vel-diff-test-v1')
    const players = makePlayers(2)

    const { state: stateA, prngs: prngsA } = initFromSeed(seed, players, baselineConfig)
    const { state: stateB, prngs: prngsB } = initFromSeed(seed, players, baselineConfig)

    for (let i = 0; i < 20; i++) {
      advanceFrame(stateA, baselineConfig, prngsA)
      advanceFrame(stateB, baselineConfig, prngsB)
    }

    // Mutate one velocity in stateA
    stateA.orbs[0].vx += 1

    const hashA = hashStateV1(stateA)
    const hashB = hashStateV1(stateB)
    expect(hashA).not.toBe(hashB)
  })

  it('hash is a 64-char hex string (sha256)', () => {
    const seed = makeSeed('hash-format-test-v1')
    const players = makePlayers(2)
    const { state } = initFromSeed(seed, players, baselineConfig)

    const hash = hashStateV1(state)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hash is stable across repeated calls on same state', () => {
    const seed = makeSeed('hash-stable-test-v1')
    const players = makePlayers(2)
    const { state, prngs } = initFromSeed(seed, players, baselineConfig)

    for (let i = 0; i < 10; i++) advanceFrame(state, baselineConfig, prngs)

    const h1 = hashStateV1(state)
    const h2 = hashStateV1(state)
    const h3 = hashStateV1(state)
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
  })
})
