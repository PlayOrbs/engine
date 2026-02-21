import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { detCos, detSin } from '../../src/core/v1/determinism.js'
import { toHex } from '../../src/utils/utils.js'
import type { EngineConfig } from '../../src/core/v1/types.js'

const testCfg: EngineConfig = {
  canvas: { width: 800, height: 800 },
  boundary: {
    shape: 'circle',
    radius: 380,
    restitution: 1.0,
    tangentImpulse: 0.02,
    minSpeed: 1,
    maxSpeed: 8.0,
  },
  burst: { lineWidth: 2 },
  orbs: { radius: 16, baseSpeed: 8 },
  disableTraits: true,
}

describe('skill multipliers', () => {
  it('applies multipliers from opts', () => {
    const seed = new Uint8Array(32).fill(1)
    const pubkey = new Uint8Array(32).fill(42)
    const players = [{ pubkey, joinNonce: new Uint8Array(8) }]
    const ownerHex = toHex(pubkey)
    const { state } = initFromSeed(seed, players, testCfg, {
      multipliersByOwnerHex: { [ownerHex]: { splitAggroMul: 1.5, tetherResMul: 1, tetherDefMul: 1.2, powerMul: 1.2 } }
    })
    expect(state.orbs[0].skill).toEqual({ splitAggroMul: 1.5, tetherResMul: 1, tetherDefMul: 1.2, powerMul: 1.2 })
  })

  it('defaults to 1.0 when no opts', () => {
    const seed = new Uint8Array(32).fill(2)
    const players = [{ pubkey: new Uint8Array(32).fill(99), joinNonce: new Uint8Array(8) }]
    const { state } = initFromSeed(seed, players, testCfg)
    expect(state.orbs[0].skill).toEqual({ splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 })
  })

  it('defaults to 1.0 when opts provided but player not in map', () => {
    const seed = new Uint8Array(32).fill(3)
    const pubkey = new Uint8Array(32).fill(55)
    const players = [{ pubkey, joinNonce: new Uint8Array(8) }]
    const { state } = initFromSeed(seed, players, testCfg, {
      multipliersByOwnerHex: { 'deadbeef': { splitAggroMul: 2, tetherResMul: 1, tetherDefMul: 2, powerMul: 2 } }
    })
    expect(state.orbs[0].skill).toEqual({ splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 })
  })
})

describe('spawn override', () => {
  it('applies x/y/angle/speed from opts', () => {
    const seed = new Uint8Array(32).fill(4)
    const pubkey = new Uint8Array(32).fill(77)
    const players = [{ pubkey, joinNonce: new Uint8Array(8) }]
    const ownerHex = toHex(pubkey)
    const angle = Math.PI / 4
    const speed = 10
    const { state } = initFromSeed(seed, players, testCfg, {
      spawnByOwnerHex: { [ownerHex]: { x: 100, y: 200, angle, speed } }
    })
    expect(state.orbs[0].x).toBe(100)
    expect(state.orbs[0].y).toBe(200)
    expect(state.orbs[0].vx).toBeCloseTo(speed * detCos(angle), 10)
    expect(state.orbs[0].vy).toBeCloseTo(speed * detSin(angle), 10)
  })

  it('applies only x/y when angle/speed not provided', () => {
    const seed = new Uint8Array(32).fill(5)
    const pubkey = new Uint8Array(32).fill(88)
    const players = [{ pubkey, joinNonce: new Uint8Array(8) }]
    const ownerHex = toHex(pubkey)
    // Get baseline velocity without override
    const { state: baseline } = initFromSeed(seed, players, testCfg)
    // Now with x/y override only
    const { state } = initFromSeed(seed, players, testCfg, {
      spawnByOwnerHex: { [ownerHex]: { x: 150, y: 250 } }
    })
    expect(state.orbs[0].x).toBe(150)
    expect(state.orbs[0].y).toBe(250)
    // Velocity should match baseline (unchanged)
    expect(state.orbs[0].vx).toBe(baseline.orbs[0].vx)
    expect(state.orbs[0].vy).toBe(baseline.orbs[0].vy)
  })

  it('uses fallback when no spawn override', () => {
    const seed = new Uint8Array(32).fill(6)
    const players = [{ pubkey: new Uint8Array(32).fill(66), joinNonce: new Uint8Array(8) }]
    const { state: s1 } = initFromSeed(seed, players, testCfg)
    const { state: s2 } = initFromSeed(seed, players, testCfg, {})
    expect(s1.orbs[0].x).toBe(s2.orbs[0].x)
    expect(s1.orbs[0].y).toBe(s2.orbs[0].y)
    expect(s1.orbs[0].vx).toBe(s2.orbs[0].vx)
    expect(s1.orbs[0].vy).toBe(s2.orbs[0].vy)
  })

  it('is deterministic across multiple calls', () => {
    const seed = new Uint8Array(32).fill(7)
    const pubkey = new Uint8Array(32).fill(33)
    const players = [{ pubkey, joinNonce: new Uint8Array(8) }]
    const ownerHex = toHex(pubkey)
    const opts = {
      spawnByOwnerHex: { [ownerHex]: { x: 300, y: 400, angle: 1.0, speed: 5 } },
      multipliersByOwnerHex: { [ownerHex]: { splitAggroMul: 1.1, tetherResMul: 1, tetherDefMul: 1.2, powerMul: 1.3 } }
    }
    const { state: s1 } = initFromSeed(seed, players, testCfg, opts)
    const { state: s2 } = initFromSeed(seed, players, testCfg, opts)
    expect(s1.orbs[0].x).toBe(s2.orbs[0].x)
    expect(s1.orbs[0].y).toBe(s2.orbs[0].y)
    expect(s1.orbs[0].vx).toBe(s2.orbs[0].vx)
    expect(s1.orbs[0].vy).toBe(s2.orbs[0].vy)
    expect(s1.orbs[0].skill).toEqual(s2.orbs[0].skill)
  })
})

describe('spawn overlap resolution', () => {
  const cfgWithPad: EngineConfig = {
    ...testCfg,
    orbs: { ...testCfg.orbs, spawn: { pad: 4 } },
  }

  it('resolves two orbs at same x/y with same angle deterministically', () => {
    const seed = new Uint8Array(32).fill(10)
    const pubkeyA = new Uint8Array(32).fill(11)
    const pubkeyB = new Uint8Array(32).fill(22)
    const players = [
      { pubkey: pubkeyA, joinNonce: new Uint8Array(8) },
      { pubkey: pubkeyB, joinNonce: new Uint8Array(8) },
    ]
    const hexA = toHex(pubkeyA)
    const hexB = toHex(pubkeyB)
    const angle = Math.PI / 3
    const speed = 5
    const { state } = initFromSeed(seed, players, cfgWithPad, {
      spawnByOwnerHex: {
        [hexA]: { x: 400, y: 400, angle, speed },
        [hexB]: { x: 400, y: 400, angle, speed },
      }
    })

    const orbA = state.orbs[0]
    const orbB = state.orbs[1]
    const dx = orbB.x - orbA.x
    const dy = orbB.y - orbA.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const minDist = orbA.radius + orbB.radius + (cfgWithPad.orbs.spawn?.pad ?? 0)

    // Orbs should be separated by at least minDist
    expect(dist).toBeGreaterThanOrEqual(minDist - 0.001)
  })

  it('is deterministic across multiple calls with overlapping spawns', () => {
    const seed = new Uint8Array(32).fill(11)
    const pubkeyA = new Uint8Array(32).fill(33)
    const pubkeyB = new Uint8Array(32).fill(44)
    const players = [
      { pubkey: pubkeyA, joinNonce: new Uint8Array(8) },
      { pubkey: pubkeyB, joinNonce: new Uint8Array(8) },
    ]
    const hexA = toHex(pubkeyA)
    const hexB = toHex(pubkeyB)
    const opts = {
      spawnByOwnerHex: {
        [hexA]: { x: 300, y: 300, angle: 0, speed: 3 },
        [hexB]: { x: 300, y: 300, angle: 0, speed: 3 },
      }
    }
    const { state: s1 } = initFromSeed(seed, players, cfgWithPad, opts)
    const { state: s2 } = initFromSeed(seed, players, cfgWithPad, opts)

    expect(s1.orbs[0].x).toBe(s2.orbs[0].x)
    expect(s1.orbs[0].y).toBe(s2.orbs[0].y)
    expect(s1.orbs[1].x).toBe(s2.orbs[1].x)
    expect(s1.orbs[1].y).toBe(s2.orbs[1].y)
  })

  it('does not change positions when no overlap exists', () => {
    const seed = new Uint8Array(32).fill(12)
    const pubkeyA = new Uint8Array(32).fill(55)
    const pubkeyB = new Uint8Array(32).fill(66)
    const players = [
      { pubkey: pubkeyA, joinNonce: new Uint8Array(8) },
      { pubkey: pubkeyB, joinNonce: new Uint8Array(8) },
    ]
    const hexA = toHex(pubkeyA)
    const hexB = toHex(pubkeyB)
    // Place orbs far apart
    const { state } = initFromSeed(seed, players, cfgWithPad, {
      spawnByOwnerHex: {
        [hexA]: { x: 200, y: 400, angle: 0, speed: 5 },
        [hexB]: { x: 600, y: 400, angle: Math.PI, speed: 5 },
      }
    })

    // Positions should remain as specified (no overlap resolution needed)
    expect(state.orbs[0].x).toBe(200)
    expect(state.orbs[0].y).toBe(400)
    expect(state.orbs[1].x).toBe(600)
    expect(state.orbs[1].y).toBe(400)
  })
})
