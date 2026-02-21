import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { initFromSeedV2, advanceFrameV2 } from '../../../src/core/v2/sim_v2.js'
import { hashStateV2 } from './hash_state.js'
import { baselineConfig, makePlayers, makeSeed } from './scenarios.js'

describe('hashStateV2', () => {
  it('identical deep-cloned states produce identical hashes', () => {
    const seed = makeSeed('hash-clone-test')
    const players = makePlayers(3)

    const { state: stateA, cfg } = initFromSeedV2(seed, players, baselineConfig)
    const { state: stateB } = initFromSeedV2(seed, players, baselineConfig)

    // Advance both identically
    for (let i = 0; i < 100; i++) {
      advanceFrameV2(stateA, cfg)
      advanceFrameV2(stateB, cfg)
    }

    const hashA = hashStateV2(stateA)
    const hashB = hashStateV2(stateB)
    expect(hashA).toBe(hashB)
  })

  it('states differing only in PRNG state produce different hashes', () => {
    const seed = makeSeed('hash-prng-diff-test')
    const players = makePlayers(3)

    const { state: stateA, cfg } = initFromSeedV2(seed, players, baselineConfig)
    const { state: stateB } = initFromSeedV2(seed, players, baselineConfig)

    // Advance both identically
    for (let i = 0; i < 50; i++) {
      advanceFrameV2(stateA, cfg)
      advanceFrameV2(stateB, cfg)
    }

    // Now consume one extra PRNG value from stateA's first orb
    // This changes PRNG state without changing any physics field
    stateA.orbs[0].prng.nextU32()

    const hashA = hashStateV2(stateA)
    const hashB = hashStateV2(stateB)
    expect(hashA).not.toBe(hashB)
  })

  it('states differing only in one orb velocity produce different hashes', () => {
    const seed = makeSeed('hash-vel-diff-test')
    const players = makePlayers(2)

    const { state: stateA, cfg } = initFromSeedV2(seed, players, baselineConfig)
    const { state: stateB } = initFromSeedV2(seed, players, baselineConfig)

    for (let i = 0; i < 20; i++) {
      advanceFrameV2(stateA, cfg)
      advanceFrameV2(stateB, cfg)
    }

    // Mutate one velocity in stateA
    stateA.orbs[0].vx += 1

    const hashA = hashStateV2(stateA)
    const hashB = hashStateV2(stateB)
    expect(hashA).not.toBe(hashB)
  })

  it('hash is a 64-char hex string (sha256)', () => {
    const seed = makeSeed('hash-format-test')
    const players = makePlayers(2)
    const { state } = initFromSeedV2(seed, players, baselineConfig)

    const hash = hashStateV2(state)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hash is stable across repeated calls on same state', () => {
    const seed = makeSeed('hash-stable-test')
    const players = makePlayers(2)
    const { state, cfg } = initFromSeedV2(seed, players, baselineConfig)

    for (let i = 0; i < 10; i++) advanceFrameV2(state, cfg)

    const h1 = hashStateV2(state)
    const h2 = hashStateV2(state)
    const h3 = hashStateV2(state)
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
  })
})
