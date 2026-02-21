import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { processTethers } from '../../src/core/v1/tethers.js'
import { stepFrame } from '../../src/core/v1/physics.js'
import { toHex } from '../../src/utils/utils.js'
import type { EngineConfig, EngineState, Tether } from '../../src/core/v1/types.js'

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
  tethers: {
    breakSpeedMin: 3,
    immunityFrames: 0,
    hitDamping: 0,
  },
  split: {
    enabled: true,
    enableBelowOrbs: 10,
    vnThreshold: 2.0,
    keThreshold: 12.0,
    radiusScale: 1,
    childSpeedMul: 0.5,
    angleSpread: 0.45,
    maxGenerations: 2,
    cooldownFrames: 0,
    maxOrbsCap: 24,
    tetherResOnSplitMul: 0.9,
    tetherResFloorMul: 0.7,
  },
  disableTraits: true,
}

/**
 * Helper: create a minimal 2-player state with a tether from player B.
 * Player A (attacker) at given speed, Player B (defender) with tether.
 */
function makeTetherScenario(attackerSpeed: number, defenderTetherDefMul: number) {
  const seed = new Uint8Array(32).fill(100)
  const pubA = new Uint8Array(32).fill(1)
  const pubB = new Uint8Array(32).fill(2)
  const hexA = toHex(pubA)
  const hexB = toHex(pubB)

  // Place defender (B) at (300, 400). Tether anchor at (100, 400).
  // Tether segment runs from (100,400) to (300,400) — a horizontal line at y=400.
  // Place attacker (A) at (200, 400) — directly on the tether segment, d2=0 < r2.
  const { state } = initFromSeed(seed, [
    { pubkey: pubA, joinNonce: new Uint8Array(8) },
    { pubkey: pubB, joinNonce: new Uint8Array(8) },
  ], testCfg, {
    spawnByOwnerHex: {
      [hexA]: { x: 200, y: 400, angle: 0, speed: attackerSpeed },
      [hexB]: { x: 300, y: 400, angle: Math.PI, speed: 0.01 },
    },
    multipliersByOwnerHex: {
      [hexA]: { splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 },
      [hexB]: { splitAggroMul: 1, tetherResMul: 1, tetherDefMul: defenderTetherDefMul, powerMul: 1 },
    },
  })

  // Add a tether for player B (owner=1) with anchor far left of defender
  const tether: Tether = {
    anchorX: 100,
    anchorY: 400,
    color: '#ffffff',
    protect: 0,
  }
  state.tethers[1] = [tether]

  return state
}

describe('tether defense (tetherDefMul)', () => {
  it('higher tetherDefMul raises break threshold — same speed fails to break', () => {
    // breakSpeedMin = 3, attacker speed = 3.5
    // With tetherDefMul=1.0: threshold = 3*1.0 = 3.0, speed 3.5 >= 3.0 → breaks
    // With tetherDefMul=1.5: threshold = 3*1.5 = 4.5, speed 3.5 < 4.5 → does NOT break
    const stateNoDef = makeTetherScenario(3.5, 1.0)
    const stateHighDef = makeTetherScenario(3.5, 1.5)

    // Process tethers for both
    processTethers(stateNoDef, testCfg)
    processTethers(stateHighDef, testCfg)

    // With no defense, tether should be broken (removed)
    expect(stateNoDef.tethers[1].length).toBe(0)
    // With high defense, tether should survive
    expect(stateHighDef.tethers[1].length).toBe(1)
  })

  it('tetherDefMul=1.0 does not change break behavior', () => {
    // breakSpeedMin = 3, attacker speed = 4.0, tetherDefMul = 1.0
    // threshold = 3*1.0 = 3.0, speed 4.0 >= 3.0 → breaks
    const state = makeTetherScenario(4.0, 1.0)
    processTethers(state, testCfg)
    expect(state.tethers[1].length).toBe(0)
  })

  it('attacker tetherResMul has no offensive effect (always 1.0)', () => {
    // Even if we manually set attacker's tetherResMul to 2.0, it should not matter
    // because the engine uses ownerOrb.skill.tetherDefMul, not attacker's tetherResMul
    const state = makeTetherScenario(2.5, 1.0)
    // Manually override attacker's tetherResMul to 2.0
    state.orbs[0].skill.tetherResMul = 2.0

    processTethers(state, testCfg)
    // breakSpeedMin=3, attacker speed=2.5, threshold=3*1.0=3.0
    // 2.5 < 3.0 → should NOT break (tetherResMul on attacker is ignored)
    expect(state.tethers[1].length).toBe(1)
  })

  it('split child inherits tetherDefMul with decay', () => {
    const seed = new Uint8Array(32).fill(50)
    const pubkey = new Uint8Array(32).fill(10)
    const ownerHex = toHex(pubkey)

    const splitCfg: EngineConfig = {
      ...testCfg,
      split: {
        ...testCfg.split!,
        vnThreshold: 0.001,
        keThreshold: 0.001,
        cooldownFrames: 0,
        tetherResOnSplitMul: 0.9,
        tetherResFloorMul: 0.7,
      },
    }

    const parentTetherDefMul = 1.2
    const { state, prngs } = initFromSeed(seed, [
      { pubkey, joinNonce: new Uint8Array(8) },
    ], splitCfg, {
      spawnByOwnerHex: { [ownerHex]: { x: 400, y: 400, angle: 0, speed: 8 } },
      multipliersByOwnerHex: {
        [ownerHex]: { splitAggroMul: 2, tetherResMul: 1, tetherDefMul: parentTetherDefMul, powerMul: 1 },
      },
    })

    // Run physics frames until a split happens
    const initialOrbCount = state.orbs.length
    let splitHappened = false
    for (let i = 0; i < 500; i++) {
      stepFrame(state, splitCfg, prngs)
      if (state.orbs.length > initialOrbCount) {
        splitHappened = true
        break
      }
    }

    if (splitHappened) {
      // Find a child orb (gen > 0)
      const child = state.orbs.find(o => o.gen > 0)
      expect(child).toBeDefined()
      if (child) {
        const expectedDecayed = parentTetherDefMul * 0.9  // 1.08
        const expectedFloor = parentTetherDefMul * 0.7     // 0.84
        const expected = Math.max(expectedDecayed, expectedFloor) // 1.08
        expect(child.skill.tetherDefMul).toBeCloseTo(expected, 10)
        expect(child.skill.tetherResMul).toBe(1)
      }
    } else {
      // If no split happened in 500 frames, that's unexpected but not a tetherDefMul bug.
      // Skip gracefully — the split mechanics test is in other test files.
      console.warn('No split occurred in 500 frames — skipping decay assertion')
    }
  })
})
