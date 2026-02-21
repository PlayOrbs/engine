import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { initFromSeedV2, advanceFrameV2, countUniqueOwnersV2 } from '../../src/core/v2/sim_v2.js'
import type { GameConfig } from '../../src/config/gameConfig.js'
import type { Player } from '../../src/core/v1/types.js'
import { fromPos, fromVel, toVel } from '../../src/utils/v2/fpmath.js'

// ─── Production-like config (based on gameConfig.v2.0.3) ───
const testConfig: GameConfig = {
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

function makePlayers(n: number): Player[] {
  const players: Player[] = []
  for (let i = 0; i < n; i++) {
    const pubkey = new Uint8Array(32); pubkey[0] = i
    const joinNonce = new Uint8Array(32); joinNonce[0] = 100 + i
    players.push({ pubkey, joinNonce, color: ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b'][i % 4] })
  }
  return players
}

function hashState(state: any): string {
  const orbData = state.orbs.map((o: any) => `${o.x},${o.y},${o.vx},${o.vy}`).join('|')
  const bytes = new TextEncoder().encode(orbData)
  const h = sha256(bytes)
  return Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Tests ───

describe('V2 Determinism', () => {
  it('same seed + players => identical state after 1000 frames', () => {
    const seed = sha256(new TextEncoder().encode('determinism-test-1'))
    const players = makePlayers(4)

    const A = initFromSeedV2(seed, players, testConfig)
    const B = initFromSeedV2(seed, players, testConfig)

    for (let i = 0; i < 1000; i++) {
      advanceFrameV2(A.state, A.cfg)
      advanceFrameV2(B.state, B.cfg)
    }

    expect(hashState(A.state)).toBe(hashState(B.state))
    expect(A.state.frame).toBe(B.state.frame)
    expect(A.state.orbs.length).toBe(B.state.orbs.length)
  })

  it('same seed + players => identical state after 5000 frames', () => {
    const seed = sha256(new TextEncoder().encode('determinism-test-5k'))
    const players = makePlayers(5)

    const A = initFromSeedV2(seed, players, testConfig)
    const B = initFromSeedV2(seed, players, testConfig)

    for (let i = 0; i < 5000; i++) {
      advanceFrameV2(A.state, A.cfg)
      advanceFrameV2(B.state, B.cfg)
    }

    expect(hashState(A.state)).toBe(hashState(B.state))
  })

  it('different seeds => different states', () => {
    const seedA = sha256(new TextEncoder().encode('seed-A'))
    const seedB = sha256(new TextEncoder().encode('seed-B'))
    const players = makePlayers(3)

    const A = initFromSeedV2(seedA, players, testConfig)
    const B = initFromSeedV2(seedB, players, testConfig)

    for (let i = 0; i < 500; i++) {
      advanceFrameV2(A.state, A.cfg)
      advanceFrameV2(B.state, B.cfg)
    }

    expect(hashState(A.state)).not.toBe(hashState(B.state))
  })

  it('gravity accumulates over 1000 frames (velocity > 0)', () => {
    const seed = sha256(new TextEncoder().encode('gravity-test'))
    const players = makePlayers(2)
    const { state, cfg } = initFromSeedV2(seed, players, testConfig)

    // Record initial velocity magnitude
    const o = state.orbs[0]
    const initSpeed = Math.sqrt(fromVel(o.vx) ** 2 + fromVel(o.vy) ** 2)

    for (let i = 0; i < 1000; i++) {
      advanceFrameV2(state, cfg)
    }

    // After 1000 frames, orbs should still be moving (gravity + boundary kicks)
    const o2 = state.orbs[0]
    if (o2) {
      const speed = Math.sqrt(fromVel(o2.vx) ** 2 + fromVel(o2.vy) ** 2)
      expect(speed).toBeGreaterThan(0)
    }
  })

  it('all velocities remain safe integers throughout simulation', () => {
    const seed = sha256(new TextEncoder().encode('safe-int-test'))
    const players = makePlayers(4)
    const { state, cfg } = initFromSeedV2(seed, players, testConfig)

    for (let i = 0; i < 2000; i++) {
      advanceFrameV2(state, cfg)
      for (const o of state.orbs) {
        expect(Number.isSafeInteger(o.vx)).toBe(true)
        expect(Number.isSafeInteger(o.vy)).toBe(true)
      }
    }
  })

  it('all positions remain int32 throughout simulation', () => {
    const seed = sha256(new TextEncoder().encode('int32-pos-test'))
    const players = makePlayers(4)
    const { state, cfg } = initFromSeedV2(seed, players, testConfig)

    for (let i = 0; i < 2000; i++) {
      advanceFrameV2(state, cfg)
      for (const o of state.orbs) {
        expect((o.x | 0) === o.x).toBe(true)
        expect((o.y | 0) === o.y).toBe(true)
      }
    }
  })

  it('speed cap enforced: no orb exceeds maxSpeed', () => {
    const seed = sha256(new TextEncoder().encode('speed-cap-test'))
    const players = makePlayers(3)
    const { state, cfg } = initFromSeedV2(seed, players, testConfig)
    const maxVel = toVel(12.5) // slightly above twoOrbsMaxSpeed to account for powerMul

    for (let i = 0; i < 3000; i++) {
      advanceFrameV2(state, cfg)
      for (const o of state.orbs) {
        const speed2 = BigInt(o.vx) * BigInt(o.vx) + BigInt(o.vy) * BigInt(o.vy)
        const max2 = BigInt(maxVel) * BigInt(maxVel)
        expect(speed2 <= max2).toBe(true)
      }
    }
  })
})

describe('V2 Init - velocity generation property tests', () => {
  it('int32-to-FP_VEL mapping: output always safe integer and within [-s, s]', () => {
    // Property test: for all signed int32 values r, Number(BigInt(r) * sBig / 2147483648n)
    // must be a safe integer and in [-s, s].
    const s = toVel(2) // baseSpeed = 2 → FP_VEL scale
    const sBig = BigInt(s)

    // Test boundary int32 values
    const edgeCases: number[] = [
      0,                  // zero
      1,                  // smallest positive
      -1,                 // smallest negative
      2147483647,         // INT32_MAX (0x7FFFFFFF)
      -2147483648,        // INT32_MIN (0x80000000)
      1073741824,         // 2^30
      -1073741824,        // -2^30
    ]

    for (const r of edgeCases) {
      const v = Number(BigInt(r) * sBig / 2147483648n)
      expect(Number.isSafeInteger(v)).toBe(true)
      expect(v >= -s && v <= s).toBe(true)
    }

    // INT32_MIN maps to exactly -s
    const vMin = Number(BigInt(-2147483648) * sBig / 2147483648n)
    expect(vMin).toBe(-s)

    // INT32_MAX maps to s - 1 (truncation toward zero)
    const vMax = Number(BigInt(2147483647) * sBig / 2147483648n)
    expect(vMax).toBe(s - 1)

    // Zero maps to zero
    expect(Number(BigInt(0) * sBig / 2147483648n)).toBe(0)
  })

  it('int32-to-FP_VEL mapping: fuzz 10k random int32 values', () => {
    const s = toVel(7) // maxSpeed-scale
    const sBig = BigInt(s)

    // Use a seeded PRNG for reproducibility
    const seed = sha256(new TextEncoder().encode('vel-fuzz'))
    const { state, cfg } = initFromSeedV2(seed, makePlayers(2), testConfig)
    const prng = state.orbs[0].prng

    for (let i = 0; i < 10_000; i++) {
      const r = prng.nextU32() | 0 // signed int32
      const v = Number(BigInt(r) * sBig / 2147483648n)
      expect(Number.isSafeInteger(v)).toBe(true)
      expect(v >= -s).toBe(true)
      expect(v <= s).toBe(true)
    }
  })

  it('BigInt division truncates toward zero (not floor)', () => {
    // Positive: 3n / 2n = 1n (truncate, same as floor)
    expect(Number(3n / 2n)).toBe(1)
    // Negative: -3n / 2n = -1n (truncate toward zero, NOT -2 which would be floor)
    expect(Number(-3n / 2n)).toBe(-1)
    // This means our mapping is symmetric: for r and -r, |v(r)| === |v(-r)| (±1 from truncation)
    const sBig = BigInt(toVel(2))
    const rPos = 1000000
    const rNeg = -1000000
    const vPos = Number(BigInt(rPos) * sBig / 2147483648n)
    const vNeg = Number(BigInt(rNeg) * sBig / 2147483648n)
    expect(vPos).toBe(-vNeg) // symmetric
  })

  it('init velocities are safe integers for all orbs', () => {
    // Run multiple seeds to cover different PRNG sequences
    for (let trial = 0; trial < 20; trial++) {
      const seed = sha256(new TextEncoder().encode(`init-vel-safe-${trial}`))
      const players = makePlayers(5)
      const { state } = initFromSeedV2(seed, players, testConfig)
      for (const o of state.orbs) {
        expect(Number.isSafeInteger(o.vx)).toBe(true)
        expect(Number.isSafeInteger(o.vy)).toBe(true)
      }
    }
  })
})

describe('V2 Determinism - Long run', () => {
  it('10k frames deterministic (hash match)', () => {
    const seed = sha256(new TextEncoder().encode('long-run-10k'))
    const players = makePlayers(5)

    const A = initFromSeedV2(seed, players, testConfig)
    const B = initFromSeedV2(seed, players, testConfig)

    for (let i = 0; i < 10_000; i++) {
      advanceFrameV2(A.state, A.cfg)
      advanceFrameV2(B.state, B.cfg)
    }

    expect(hashState(A.state)).toBe(hashState(B.state))
  })
})
