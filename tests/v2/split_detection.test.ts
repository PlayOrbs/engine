import { describe, it, expect } from 'vitest'
import { initFromSeedV2, advanceFrameV2 } from '../../src/core/v2/sim_v2.js'
import { toVel, toCoef, FP_COEF } from '../../src/utils/v2/fpmath.js'
import type { GameConfig } from '../../src/config/gameConfig.js'
import type { Player } from '../../src/core/v1/types.js'

// Helper to create a Uint8Array from a number for test purposes
const toBytes = (n: number): Uint8Array => {
  const arr = new Uint8Array(32)
  arr[0] = n
  return arr
}

// Test config with split enabled
const makeTestConfig = (vnThreshold: number, keThreshold: number): GameConfig => ({
  version: 'test',
  canvas: { width: 400, height: 720 },
  ui: { preGameSeconds: 10 },
  boundary: {
    shape: 'circle',
    radius: 190,
    color: '#ffffff',
    lineWidth: 2,
    restitution: 1.0, // No speed boost on wall bounce
    tangentImpulse: 0,
    minSpeed: 0.5,
    maxSpeed: 7.0,
    twoOrbsMaxSpeed: 12.0,
    twoOrbsRampFrames: 600,
    rectHalfWidth: 200,
    rectHalfHeight: 300,
  },
  orbs: {
    count: 5,
    radius: 12,
    speed: 2,
    amplitude: 500,
    baseSpeed: 2,
    colors: ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'],
    spawn: {
      mode: 'rings',
      pad: 2,
      startInset: 104,
      ringGap: 30,
      ringsMin: 1,
      ringsMax: 5,
      velocity: 'none',
      jitter: false,
    },
  },
  burst: { lineCount: 15, minLength: 50, maxLength: 200, lineWidth: 0.8, clashDistance: 25 },
  performance: { maxLines: 5000, animationDuration: 75000 },
  tethers: { hitDamping: 0.1, springRest: 0, springK: 0.0, springDamping: 0.0, breakSpeedMin: 3, immunityFrames: 200 },
  gravity: { base: 0, ampFrac: 0, periodFrames: 40, oscillateBelowOrbs: 3 },
  edgeGuide: { enabled: false, radiusTargetFrac: 0.6, bandWidth: 32, k: 0.15, minSpeedGate: 0.4 },
  edgeGravity: { strength: 0, count: 0, insetPixels: 60 },
  collisions: { orbRestitution: 1.0 }, // No speed boost on orb collision
  split: {
    enabled: true,
    enableBelowOrbs: 10,
    vnThreshold,
    keThreshold,
    radiusScale: 1,
    childSpeedMul: 0.5,
    angleSpread: 0.45,
    maxGenerations: 2,
    cooldownFrames: 300,
    maxOrbsCap: 24,
  },
  suddenDeath: {
    enabled: false,
    afterFrames: 99999,
    gravityMultiplier: 1,
    rampFrames: 600,
    centerShiftRadius: 0,
    centerShiftPeriodFrames: 120,
  },
  drama: {
    targetFrames: 99999,
    shrinkStart: 1.0,
    shrinkTo: 1.0,
    restitutionMulEnd: 1.0,
    gravityMulEnd: 1.0,
    jitterMulEnd: 1.0,
    easing: 'linear',
  },
  fx: {
    shockwave: {
      enabled: false,
      lifeFrames: 40,
      maxRadius: 100,
      ringThickness: 5,
      respectProtect: true,
      cutMode: 'segment',
      triggerOnSplit: false,
      triggerOnImpact: false,
      impactThreshold: 4,
      impactCutsTethers: false,
    },
  },
  debug: { showEdgePoints: false },
  rendering: { dimUntilBreakSpeed: false, orbDimAlpha: 0.4, tetherDimAlpha: 0.1 },
  disableTraits: true,
})

// Create test players with correct Player type
const makeTestPlayers = (count: number): Player[] => {
  return Array.from({ length: count }, (_, i) => ({
    pubkey: toBytes(i + 1),
    joinNonce: toBytes(100 + i),
    color: '#ff0000',
  }))
}

describe('V2 Split Detection Thresholds', () => {
  it('should NOT split when vn < vnThreshold (low velocity collision)', () => {
    // Config with high threshold (6.0) - requires near max speed to split
    const config = makeTestConfig(6.0, 36.0)
    const players = makeTestPlayers(2)
    
    // Initialize with a seed
    const seed = new Uint8Array(32).fill(42)
    const init = initFromSeedV2(seed, players, config)
    let state = init.state
    const cfg = init.cfg
    
    // Run for a few hundred frames - orbs start at baseSpeed=2.0
    // With vnThreshold=6.0, they should NOT split at low speeds
    const initialOrbCount = state.orbs.length
    
    for (let i = 0; i < 500; i++) {
      const result = advanceFrameV2(state, cfg)
      state = result.state
    }
    
    // Should still have same number of orbs (no splits at low speed)
    expect(state.orbs.length).toBe(initialOrbCount)
  })

  it('should split when vn >= vnThreshold (high velocity collision)', () => {
    // Config with low threshold (1.0) and low KE threshold (2.0) - splits easily
    const config = makeTestConfig(1.0, 2.0)
    const players = makeTestPlayers(2)
    
    const seed = new Uint8Array(32).fill(42)
    const init = initFromSeedV2(seed, players, config)
    let state = init.state
    const cfg = init.cfg
    
    const initialOrbCount = state.orbs.length
    
    // Run until we see a split or timeout
    let splitOccurred = false
    for (let i = 0; i < 2000 && !splitOccurred; i++) {
      const result = advanceFrameV2(state, cfg)
      state = result.state
      if (state.orbs.length > initialOrbCount) {
        splitOccurred = true
      }
    }
    
    expect(splitOccurred).toBe(true)
    expect(state.orbs.length).toBeGreaterThan(initialOrbCount)
  })

  it('vnThreshold comparison should use correct fixed-point math', () => {
    // Verify the threshold conversion is correct
    const vnThreshold = 6.0
    const vnTh_vel = toVel(vnThreshold)
    const vnTh2_base = BigInt(vnTh_vel) * BigInt(vnTh_vel)
    
    // When splitAggroMul = 1.0 (FP_COEF), the adjusted threshold should equal base
    const aggroMul = FP_COEF // 1.0 in fixed-point
    const vnTh2_adj = (vnTh2_base << 40n) / aggroMul
    
    // vnTh2_adj should equal vnTh2_base when aggro = 1.0
    expect(vnTh2_adj).toBe(vnTh2_base)
    
    // Test with vn = 3.0 (below threshold of 6.0)
    const vn = toVel(3.0)
    const vn2 = BigInt(vn) * BigInt(vn)
    
    // vn² should be less than vnTh² (3² = 9 < 6² = 36)
    expect(vn2 < vnTh2_adj).toBe(true)
    
    // Test with vn = 7.0 (above threshold of 6.0)
    const vnHigh = toVel(7.0)
    const vn2High = BigInt(vnHigh) * BigInt(vnHigh)
    
    // vn² should be greater than vnTh² (7² = 49 > 6² = 36)
    expect(vn2High >= vnTh2_adj).toBe(true)
  })

  it('splitAggroMul > 1.0 should lower effective threshold', () => {
    const vnThreshold = 6.0
    const vnTh_vel = toVel(vnThreshold)
    const vnTh2_base = BigInt(vnTh_vel) * BigInt(vnTh_vel)
    
    // With splitAggroMul = 2.0, threshold should be halved
    const aggroMul2x = toCoef(2.0)
    const vnTh2_adj_2x = (vnTh2_base << 40n) / aggroMul2x
    
    // Adjusted threshold should be half of base (36 / 2 = 18)
    // So vn = 5.0 (vn² = 25) should now pass the check
    const vn5 = toVel(5.0)
    const vn2_5 = BigInt(vn5) * BigInt(vn5)
    
    // With aggro=1.0: 25 < 36 (no split)
    expect(vn2_5 < vnTh2_base).toBe(true)
    
    // With aggro=2.0: 25 > 18 (split!)
    expect(vn2_5 >= vnTh2_adj_2x).toBe(true)
  })
})
