import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  FP_POS, FP_VEL, FP_COEF, FP_COEF_SHIFT_N,
  VEL_EXTRA,
  toPos, toVel, toCoef, fromPos, fromVel,
  posToVel, velToPos,
  mulPos, divPos, hypotPos,
  hypotVel,
  dotVelPos, mulVelPos, applyCoefVel,
  isqrt,
  absFp, signFp, clampFp,
  sinFp, cosFp, radiansToIdx,
  setDebug, assertSafeVel, assertInt32,
} from '../../src/utils/v2/fpmath.js'

beforeAll(() => setDebug(true))
afterAll(() => setDebug(false))

// ─── Constants ───

describe('constants', () => {
  it('FP_POS = 2^20', () => {
    expect(FP_POS).toBe(1_048_576)
  })
  it('FP_VEL = 2^30', () => {
    expect(FP_VEL).toBe(1_073_741_824)
  })
  it('FP_COEF = 2^40', () => {
    expect(FP_COEF).toBe(1_099_511_627_776n)
  })
  it('VEL_EXTRA = 1024 = 2^10', () => {
    expect(VEL_EXTRA).toBe(1024)
  })
})

// ─── Conversions ───

describe('toPos', () => {
  it('converts 0', () => expect(toPos(0)).toBe(0))
  it('converts 1.0', () => expect(toPos(1.0)).toBe(FP_POS))
  it('converts 720 (canvas height)', () => expect(toPos(720)).toBe(720 * FP_POS))
  it('converts -190', () => expect(toPos(-190)).toBe(-190 * FP_POS))
  it('converts 0.5', () => expect(toPos(0.5)).toBe(Math.round(0.5 * FP_POS)))
  it('result fits int32', () => {
    const v = toPos(720)
    expect(v).toBeLessThan(2_147_483_647)
    expect(v).toBeGreaterThan(-2_147_483_648)
  })
})

describe('toVel', () => {
  it('converts 0', () => expect(toVel(0)).toBe(0))
  it('converts 1.0', () => expect(toVel(1.0)).toBe(FP_VEL))
  it('converts 2.0 (vnThreshold)', () => expect(toVel(2.0)).toBe(2_147_483_648))
  it('converts 12 (maxSpeed)', () => expect(toVel(12)).toBe(12_884_901_888))
  it('result is safe integer', () => {
    expect(Number.isSafeInteger(toVel(12))).toBe(true)
    expect(Number.isSafeInteger(toVel(20))).toBe(true)
  })
  it('exceeds int32 for speed > 2', () => {
    expect(toVel(2.0)).toBeGreaterThan(2_147_483_647)
  })
})

describe('toCoef', () => {
  it('converts 1.0', () => expect(toCoef(1.0)).toBe(FP_COEF))
  it('converts 1e-10 (gravity)', () => expect(toCoef(1e-10)).toBe(110n))
  it('converts 1.02 (restitution)', () => expect(toCoef(1.02)).toBe(BigInt(Math.round(1.02 * 1099511627776))))
  it('converts 0.01 (tangentImpulse)', () => expect(toCoef(0.01)).toBe(10_995_116_278n))
})

describe('fromPos / fromVel', () => {
  it('roundtrips pos', () => {
    expect(fromPos(toPos(123.456))).toBeCloseTo(123.456, 4)
  })
  it('roundtrips vel', () => {
    expect(fromVel(toVel(7.5))).toBeCloseTo(7.5, 6)
  })
})

describe('posToVel / velToPos', () => {
  it('posToVel(1) = 1024', () => expect(posToVel(1)).toBe(1024))
  it('posToVel(FP_POS) = FP_VEL', () => expect(posToVel(FP_POS)).toBe(FP_VEL))
  it('posToVel max pos stays safe integer', () => {
    const result = posToVel(754_974_720)
    expect(result).toBe(754_974_720 * 1024)
    expect(Number.isSafeInteger(result)).toBe(true)
  })

  it('velToPos(2049) = 2 (positive floor)', () => expect(velToPos(2049)).toBe(2))
  it('velToPos(1024) = 1', () => expect(velToPos(1024)).toBe(1))
  it('velToPos(1023) = 0', () => expect(velToPos(1023)).toBe(0))
  it('velToPos(0) = 0', () => expect(velToPos(0)).toBe(0))
  it('velToPos(-1) = -1 (floor toward -∞)', () => expect(velToPos(-1)).toBe(-1))
  it('velToPos(-1024) = -1', () => expect(velToPos(-1024)).toBe(-1))
  it('velToPos(-2049) = -3 (arithmetic shift semantics)', () => expect(velToPos(-2049)).toBe(-3))
  it('large FP_VEL converts correctly', () => {
    expect(velToPos(13_142_599_925)).toBe(12_834_570)
    expect(Number.isSafeInteger(velToPos(13_142_599_925))).toBe(true)
  })

  it('velToPos matches BigInt >> 10n for positive', () => {
    expect(velToPos(12_884_901_888)).toBe(Number(BigInt(12_884_901_888) >> 10n))
  })
  it('velToPos matches BigInt >> 10n for negative', () => {
    expect(velToPos(-12_884_901_888)).toBe(Number(BigInt(-12_884_901_888) >> 10n))
  })
})

// ─── FP_POS Arithmetic ───

describe('mulPos', () => {
  it('1.0 * 1.0 = 1.0', () => {
    expect(mulPos(FP_POS, FP_POS)).toBe(FP_POS)
  })
  it('2.0 * 3.0 = 6.0', () => {
    expect(mulPos(2 * FP_POS, 3 * FP_POS)).toBe(6 * FP_POS)
  })
  it('handles negative', () => {
    expect(mulPos(-FP_POS, FP_POS)).toBe(-FP_POS)
  })
})

describe('divPos', () => {
  it('1.0 / 1.0 = 1.0', () => {
    expect(divPos(FP_POS, FP_POS)).toBe(FP_POS)
  })
  it('6.0 / 3.0 = 2.0', () => {
    expect(divPos(6 * FP_POS, 3 * FP_POS)).toBe(2 * FP_POS)
  })
  it('unit normal: divPos(dx, dist) ≈ FP_POS for dx=dist', () => {
    const d = toPos(190)
    expect(divPos(d, d)).toBe(FP_POS)
  })
})

describe('hypotPos', () => {
  it('(3,4) triangle', () => {
    const h = hypotPos(toPos(3), toPos(4))
    expect(fromPos(h)).toBeCloseTo(5.0, 3)
  })
  it('(0,0) = 0', () => {
    expect(hypotPos(0, 0)).toBe(0)
  })
})

// ─── FP_VEL Arithmetic ───

describe('hypotVel', () => {
  it('(3,4) triangle in vel', () => {
    const h = hypotVel(toVel(3), toVel(4))
    expect(fromVel(h)).toBeCloseTo(5.0, 5)
  })
})

// ─── Cross-Scale ───

describe('dotVelPos', () => {
  it('parallel vectors', () => {
    const vx = toVel(5), vy = toVel(0)
    const nx = FP_POS, ny = 0 // unit vector (1,0)
    const dot = dotVelPos(vx, vy, nx, ny)
    expect(fromVel(dot)).toBeCloseTo(5.0, 5)
  })
  it('perpendicular vectors = 0', () => {
    const vx = toVel(5), vy = toVel(0)
    const nx = 0, ny = FP_POS // unit vector (0,1)
    expect(dotVelPos(vx, vy, nx, ny)).toBe(0)
  })
})

describe('mulVelPos', () => {
  it('v * 1.0 = v', () => {
    const v = toVel(7.5)
    expect(mulVelPos(v, FP_POS)).toBe(v)
  })
  it('v * 0.5', () => {
    const v = toVel(10)
    const half = Math.round(0.5 * FP_POS)
    const result = mulVelPos(v, half)
    expect(fromVel(result)).toBeCloseTo(5.0, 3)
  })
})

describe('applyCoefVel', () => {
  it('identity: coef=1.0 preserves v exactly', () => {
    const v = toVel(7.0)
    expect(applyCoefVel(v, toCoef(1.0))).toBe(v)
  })
  it('coef=1.0 preserves negative v', () => {
    const v = toVel(-3.5)
    expect(applyCoefVel(v, toCoef(1.0))).toBe(v)
  })
  it('coef=0.5 halves v (truncated)', () => {
    const v = toVel(10)
    const result = applyCoefVel(v, toCoef(0.5))
    expect(result).toBe(Math.floor(toVel(10) / 2))
  })
  it('restitution 1.02 on max speed stays safe', () => {
    const v = toVel(12)
    const result = applyCoefVel(v, toCoef(1.02))
    expect(Number.isSafeInteger(result)).toBe(true)
    expect(fromVel(result)).toBeCloseTo(12.24, 2)
  })
  it('returns safe integer for large inputs', () => {
    const v = toVel(18) // beyond normal max
    const result = applyCoefVel(v, toCoef(1.5))
    expect(Number.isSafeInteger(result)).toBe(true)
  })
})

// ─── isqrt ───

describe('isqrt', () => {
  it('isqrt(0) = 0', () => expect(isqrt(0n)).toBe(0n))
  it('isqrt(1) = 1', () => expect(isqrt(1n)).toBe(1n))
  it('isqrt(4) = 2', () => expect(isqrt(4n)).toBe(2n))
  it('isqrt(9) = 3', () => expect(isqrt(9n)).toBe(3n))
  it('isqrt(10) = 3 (floor)', () => expect(isqrt(10n)).toBe(3n))
  it('isqrt(large) correct', () => {
    const n = 1_000_000_000_000n
    const s = isqrt(n)
    expect(s).toBe(1_000_000n)
  })
  it('throws on negative', () => {
    expect(() => isqrt(-1n)).toThrow()
  })
})

// ─── Number Helpers ───

describe('absFp / signFp / clampFp', () => {
  it('absFp', () => {
    expect(absFp(5)).toBe(5)
    expect(absFp(-5)).toBe(5)
    expect(absFp(0)).toBe(0)
  })
  it('signFp', () => {
    expect(signFp(5)).toBe(1)
    expect(signFp(-5)).toBe(-1)
    expect(signFp(0)).toBe(0)
  })
  it('clampFp', () => {
    expect(clampFp(5, 0, 10)).toBe(5)
    expect(clampFp(-1, 0, 10)).toBe(0)
    expect(clampFp(15, 0, 10)).toBe(10)
  })
})

// ─── Trig LUT ───

describe('trig LUT', () => {
  it('sin(0) = 0', () => expect(sinFp(0)).toBe(0))
  it('sin(1024) = FP_POS (sin 90°)', () => expect(sinFp(1024)).toBe(FP_POS))
  it('sin(2048) ≈ 0 (sin 180°)', () => expect(Math.abs(sinFp(2048))).toBeLessThan(2))
  it('sin(3072) = -FP_POS (sin 270°)', () => expect(sinFp(3072)).toBe(-FP_POS))
  it('cos(0) = FP_POS', () => expect(cosFp(0)).toBe(FP_POS))
  it('cos(1024) ≈ 0', () => expect(Math.abs(cosFp(1024))).toBeLessThan(2))
  it('radiansToIdx(0) = 0', () => expect(radiansToIdx(0)).toBe(0))
  it('radiansToIdx(π/2) = 1024', () => expect(radiansToIdx(Math.PI / 2)).toBe(1024))
  it('radiansToIdx(2π) wraps to 0', () => expect(radiansToIdx(2 * Math.PI)).toBe(0))
  it('sin² + cos² ≈ FP_POS² for various angles', () => {
    for (let i = 0; i < 4096; i += 128) {
      const s = sinFp(i), c = cosFp(i)
      const sum = s * s + c * c
      const expected = FP_POS * FP_POS
      expect(Math.abs(sum - expected)).toBeLessThan(FP_POS * 2) // < 2 LSB error
    }
  })
})

// ─── Assertions ───

describe('assertions', () => {
  it('assertSafeVel passes for safe integers', () => {
    expect(() => assertSafeVel(0)).not.toThrow()
    expect(() => assertSafeVel(12_884_901_888)).not.toThrow()
    expect(() => assertSafeVel(-12_884_901_888)).not.toThrow()
  })
  it('assertSafeVel throws for non-safe', () => {
    expect(() => assertSafeVel(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    expect(() => assertSafeVel(1.5)).toThrow()
    expect(() => assertSafeVel(NaN)).toThrow()
    expect(() => assertSafeVel(Infinity)).toThrow()
  })
  it('assertInt32 passes for int32', () => {
    expect(() => assertInt32(0)).not.toThrow()
    expect(() => assertInt32(754_974_720)).not.toThrow()
    expect(() => assertInt32(-754_974_720)).not.toThrow()
  })
  it('assertInt32 throws for values > int32', () => {
    expect(() => assertInt32(2_147_483_648)).toThrow()
    expect(() => assertInt32(12_884_901_888)).toThrow()
  })
})

// ─── Fuzz: velToPos matches BigInt >> 10n ───

describe('fuzz: velToPos consistency', () => {
  it('matches BigInt >> 10n for 10k random values', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 10_000; i++) {
      // Random safe integer in [-20*FP_VEL, 20*FP_VEL]
      const range = 20 * FP_VEL
      const v = Math.floor(rng() * range * 2) - range
      const expected = Number(BigInt(v) >> 10n)
      expect(velToPos(v)).toBe(expected)
    }
  })
})

// ─── Fuzz: applyCoefVel returns safe integers ───

describe('fuzz: applyCoefVel safe integers', () => {
  it('returns safe integer for 10k random inputs', () => {
    const rng = mulberry32(123)
    for (let i = 0; i < 10_000; i++) {
      const v = Math.floor(rng() * 20 * FP_VEL * 2) - 20 * FP_VEL
      const coef = BigInt(Math.floor(rng() * Number(10n * FP_COEF)))
      const result = applyCoefVel(v, coef)
      expect(Number.isSafeInteger(result)).toBe(true)
    }
  })
})

// ─── Fuzz: dotVelPos returns safe integers ───

describe('fuzz: dotVelPos safe integers', () => {
  it('returns safe integer for 10k random inputs', () => {
    const rng = mulberry32(456)
    for (let i = 0; i < 10_000; i++) {
      const vx = Math.floor(rng() * 20 * FP_VEL * 2) - 20 * FP_VEL
      const vy = Math.floor(rng() * 20 * FP_VEL * 2) - 20 * FP_VEL
      // Unit-ish normal in FP_POS (magnitude ≤ FP_POS)
      const nx = Math.floor(rng() * FP_POS * 2) - FP_POS
      const ny = Math.floor(rng() * FP_POS * 2) - FP_POS
      const result = dotVelPos(vx, vy, nx, ny)
      expect(Number.isSafeInteger(result)).toBe(true)
    }
  })
})

// ─── Gravity accumulation sanity ───

describe('gravity dv nonzero', () => {
  it('gravity base 1e-10 produces nonzero dv at max dx', () => {
    const g_coef = toCoef(1e-10) // 110n
    const dx_fp = toPos(380)     // max distance
    const dx_vel = BigInt(dx_fp) * 1024n
    const dv = Number((dx_vel * g_coef) >> 40n)
    expect(dv).toBeGreaterThan(0)
    expect(dv).toBe(40)
  })

  it('worst-case gravity (sd + drama + trait) produces meaningful dv', () => {
    const combined = 1e-10 * 2 * 1.8 * 1.3
    const g_coef = toCoef(combined) // 515n
    const dx_fp = toPos(380)
    const dx_vel = BigInt(dx_fp) * 1024n
    const dv = Number((dx_vel * g_coef) >> 40n)
    expect(dv).toBe(191)
  })
})

// ─── keThreshold / vnThreshold verification ───

describe('threshold conversions', () => {
  it('vnThreshold_vel for 2.0', () => {
    expect(toVel(2.0)).toBe(2_147_483_648)
  })

  it('keThreshold_vel2 for 12.0', () => {
    const ke = BigInt(Math.round(12.0 * FP_VEL * FP_VEL))
    expect(ke).toBe(13_835_058_055_282_163_712n)
  })
})

// ─── Simple PRNG for fuzz tests ───

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
