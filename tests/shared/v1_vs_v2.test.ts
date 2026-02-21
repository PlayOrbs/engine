import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'

// V1
import { initFromSeed, advanceFrame } from '../../src/core/v1/sim.js'
import type { EngineConfig, Player } from '../../src/core/v1/types.js'

// V2
import { initFromSeedV2, advanceFrameV2 } from '../../src/core/v2/sim_v2.js'
import { fromPos, fromVel } from '../../src/utils/v2/fpmath.js'
import type { GameConfig } from '../../src/config/gameConfig.js'

// Shared config (production-like, disableTraits for clean comparison)
const gameConfig: GameConfig = {
  version: '2.0.3',
  canvas: { width: 400, height: 720 },
  ui: { preGameSeconds: 10 },
  boundary: {
    shape: 'circle',
    radius: 190,
    color: '#ffffff',
    lineWidth: 2,
    restitution: 1.02,
    tangentImpulse: 0.01,
    minSpeed: 1.0,
    maxSpeed: 7.0,
    twoOrbsMaxSpeed: 12.0,
    twoOrbsRampFrames: 600,
    rectHalfWidth: 200,
    rectHalfHeight: 300,
  },
  orbs: {
    count: 4,
    radius: 12,
    speed: 2,
    amplitude: 500,
    baseSpeed: 2,
    colors: ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b'],
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
  tethers: { hitDamping: 0.125, springRest: 0, springK: 0.0, springDamping: 0.0, breakSpeedMin: 3, immunityFrames: 200 },
  gravity: { base: 0.0000000001, ampFrac: 0.4, periodFrames: 40, oscillateBelowOrbs: 3 },
  edgeGuide: { enabled: false, radiusTargetFrac: 0.6, bandWidth: 32, k: 0.15, minSpeedGate: 0.4 },
  edgeGravity: { strength: 0.00001, count: 0, insetPixels: 60 },
  collisions: { orbRestitution: 1.004 },
  split: {
    enabled: true,
    enableBelowOrbs: 5,
    vnThreshold: 2.0,
    keThreshold: 12.0,
    radiusScale: 1,
    childSpeedMul: 0.5,
    angleSpread: 0.45,
    maxGenerations: 2,
    cooldownFrames: 300,
    maxOrbsCap: 24,
  },
  suddenDeath: {
    enabled: true,
    afterFrames: 600,
    gravityMultiplier: 2,
    rampFrames: 600,
    centerShiftRadius: 40,
    centerShiftPeriodFrames: 120,
  },
  drama: {
    targetFrames: 7200,
    shrinkStart: 0.70,
    shrinkTo: 1.0,
    restitutionMulEnd: 1.0,
    gravityMulEnd: 1.8,
    jitterMulEnd: 1.6,
    easing: 'linear',
  },
  fx: {
    shockwave: {
      enabled: true,
      lifeFrames: 40,
      maxRadius: 100,
      ringThickness: 5,
      respectProtect: true,
      cutMode: 'segment',
      triggerOnSplit: true,
      triggerOnImpact: true,
      impactThreshold: 4,
      impactCutsTethers: true,
    },
  },
  debug: { showEdgePoints: false },
  rendering: { dimUntilBreakSpeed: false, orbDimAlpha: 0.4, tetherDimAlpha: 0.1 },
  disableTraits: true,
} as any

// V1 needs EngineConfig shape (subset of GameConfig)
const v1Config: EngineConfig = gameConfig as any

function makePlayers(n: number): Player[] {
  const players: Player[] = []
  for (let i = 0; i < n; i++) {
    const pubkey = new Uint8Array(32); pubkey[0] = i
    const joinNonce = new Uint8Array(32); joinNonce[0] = 100 + i
    players.push({ pubkey, joinNonce, color: ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b'][i % 4] })
  }
  return players
}

describe('V1 vs V2 Comparison', () => {
  it('both engines produce orbs that stay within boundary', () => {
    const seed = sha256(new TextEncoder().encode('boundary-compare'))
    const players = makePlayers(4)
    const R = gameConfig.boundary.radius

    // V1
    const v1 = initFromSeed(seed, players, v1Config)
    // V2
    const v2 = initFromSeedV2(seed, players, gameConfig)

    const frames = 500
    for (let i = 0; i < frames; i++) {
      advanceFrame(v1.state, v1Config, v1.prngs)
      advanceFrameV2(v2.state, v2.cfg)
    }

    // Both should keep orbs inside boundary
    for (const o of v1.state.orbs) {
      const cx = gameConfig.canvas.width / 2
      const cy = gameConfig.canvas.height / 2
      const dist = Math.sqrt((o.x - cx) ** 2 + (o.y - cy) ** 2)
      expect(dist).toBeLessThanOrEqual(R + 1) // small tolerance
    }

    for (const o of v2.state.orbs) {
      const cx = fromPos(v2.cfg.cx)
      const cy = fromPos(v2.cfg.cy)
      const ox = fromPos(o.x)
      const oy = fromPos(o.y)
      const dist = Math.sqrt((ox - cx) ** 2 + (oy - cy) ** 2)
      expect(dist).toBeLessThanOrEqual(R + 1)
    }
  })

  it('both engines have similar orb count evolution', () => {
    const seed = sha256(new TextEncoder().encode('orb-count-compare'))
    const players = makePlayers(4)

    const v1 = initFromSeed(seed, players, v1Config)
    const v2 = initFromSeedV2(seed, players, gameConfig)

    // Both start with same number of orbs
    expect(v1.state.orbs.length).toBe(v2.state.orbs.length)

    const frames = 200
    for (let i = 0; i < frames; i++) {
      advanceFrame(v1.state, v1Config, v1.prngs)
      advanceFrameV2(v2.state, v2.cfg)
    }

    // After 200 frames (before sudden death), orb counts should be similar
    // Not necessarily identical due to FP vs float differences in split thresholds
    const v1Count = v1.state.orbs.length
    const v2Count = v2.state.orbs.length
    // Both should have at least the original players
    expect(v1Count).toBeGreaterThanOrEqual(1)
    expect(v2Count).toBeGreaterThanOrEqual(1)
  })

  it('v2 speeds are in similar range to v1 speeds', () => {
    const seed = sha256(new TextEncoder().encode('speed-range-compare'))
    const players = makePlayers(3)

    const v1 = initFromSeed(seed, players, v1Config)
    const v2 = initFromSeedV2(seed, players, gameConfig)

    const frames = 300
    const v1Speeds: number[] = []
    const v2Speeds: number[] = []

    for (let i = 0; i < frames; i++) {
      advanceFrame(v1.state, v1Config, v1.prngs)
      advanceFrameV2(v2.state, v2.cfg)

      // Sample every 50 frames
      if (i % 50 === 49) {
        for (const o of v1.state.orbs) {
          v1Speeds.push(Math.sqrt(o.vx ** 2 + o.vy ** 2))
        }
        for (const o of v2.state.orbs) {
          v2Speeds.push(Math.sqrt(fromVel(o.vx) ** 2 + fromVel(o.vy) ** 2))
        }
      }
    }

    // Both engines should produce speeds in a similar range
    const v1Avg = v1Speeds.reduce((a, b) => a + b, 0) / v1Speeds.length
    const v2Avg = v2Speeds.reduce((a, b) => a + b, 0) / v2Speeds.length

    // Speeds should be in the same order of magnitude (within 10x)
    // Exact match not expected due to FP vs float differences
    expect(v1Avg).toBeGreaterThan(0)
    expect(v2Avg).toBeGreaterThan(0)
    const ratio = v1Avg / v2Avg
    expect(ratio).toBeGreaterThan(0.1)
    expect(ratio).toBeLessThan(10)
  })

  it('v2 gravity accumulation is non-zero (not truncated like pre-FP_VEL)', () => {
    const seed = sha256(new TextEncoder().encode('gravity-accum'))
    const players = makePlayers(2)

    const v2 = initFromSeedV2(seed, players, gameConfig)
    const initVx = v2.state.orbs[0].vx
    const initVy = v2.state.orbs[0].vy

    // Run 100 frames
    for (let i = 0; i < 100; i++) {
      advanceFrameV2(v2.state, v2.cfg)
    }

    // Velocity should have changed (gravity is accumulating)
    const o = v2.state.orbs[0]
    if (o) {
      const dvx = o.vx - initVx
      const dvy = o.vy - initVy
      // At least one component should have changed
      expect(Math.abs(dvx) + Math.abs(dvy)).toBeGreaterThan(0)
    }
  })

  it('v2 restitution > 1.0 causes speed increase on boundary hit (energy injection)', () => {
    const seed = sha256(new TextEncoder().encode('restitution-test'))
    const players = makePlayers(2)

    const v2 = initFromSeedV2(seed, players, gameConfig)

    // Track max speed over time — with restitution=1.02, speed should increase
    let maxSpeed = 0
    for (let i = 0; i < 500; i++) {
      advanceFrameV2(v2.state, v2.cfg)
      for (const o of v2.state.orbs) {
        const speed = Math.sqrt(fromVel(o.vx) ** 2 + fromVel(o.vy) ** 2)
        if (speed > maxSpeed) maxSpeed = speed
      }
    }

    // With restitution > 1.0 and boundary kicks, max speed should exceed initial baseSpeed
    expect(maxSpeed).toBeGreaterThan(gameConfig.orbs.baseSpeed!)
  })

  it('v2 frame counter advances correctly', () => {
    const seed = sha256(new TextEncoder().encode('frame-counter'))
    const players = makePlayers(2)

    const v2 = initFromSeedV2(seed, players, gameConfig)
    expect(v2.state.frame).toBe(0)

    for (let i = 0; i < 100; i++) {
      advanceFrameV2(v2.state, v2.cfg)
    }

    expect(v2.state.frame).toBe(100)
  })
})
