import { describe, it, expect } from 'vitest'
import { toVel, toCoef, toPos, FP_COEF, FP_VEL, FP_COEF_SHIFT_N, applyCoefVel } from '../../src/utils/v2/fpmath.js'

// ─── Tether Break Speed Comparison ───
// From tethers_v2.ts:96-102
// v² >= (breakSpeedMin * tetherDefMul)²
describe('Tether Break Speed Comparison', () => {
  const VEL_EXTRA_N = 1024n

  it('should NOT break tether when speed < breakSpeedMin', () => {
    // Orb moving at speed 2.0, breakSpeedMin = 3.0, tetherDefMul = 1.0
    const orbSpeed = 2.0
    const breakSpeedMin = 3.0
    const tetherDefMul = FP_COEF // 1.0

    const vx = toVel(orbSpeed)
    const vy = 0
    const v2 = BigInt(vx) * BigInt(vx) + BigInt(vy) * BigInt(vy) // FP_VEL²

    // breakSpeedMin is FP_POS, convert to FP_VEL via * 1024n
    const bsmBaseVel = BigInt(toPos(breakSpeedMin)) * VEL_EXTRA_N
    const bsmEffVel = (bsmBaseVel * tetherDefMul) >> FP_COEF_SHIFT_N
    const thr2 = bsmEffVel * bsmEffVel // FP_VEL²

    // v² < thr² → should NOT break
    expect(v2 < thr2).toBe(true)
  })

  it('should break tether when speed >= breakSpeedMin', () => {
    // Orb moving at speed 4.0, breakSpeedMin = 3.0, tetherDefMul = 1.0
    const orbSpeed = 4.0
    const breakSpeedMin = 3.0
    const tetherDefMul = FP_COEF // 1.0

    const vx = toVel(orbSpeed)
    const vy = 0
    const v2 = BigInt(vx) * BigInt(vx) + BigInt(vy) * BigInt(vy) // FP_VEL²

    const bsmBaseVel = BigInt(toPos(breakSpeedMin)) * VEL_EXTRA_N
    const bsmEffVel = (bsmBaseVel * tetherDefMul) >> FP_COEF_SHIFT_N
    const thr2 = bsmEffVel * bsmEffVel // FP_VEL²

    // v² >= thr² → should break
    expect(v2 >= thr2).toBe(true)
  })

  it('tetherDefMul > 1.0 should raise effective threshold', () => {
    // Orb moving at speed 4.0, breakSpeedMin = 3.0, tetherDefMul = 1.5
    // Effective threshold = 3.0 * 1.5 = 4.5
    const orbSpeed = 4.0
    const breakSpeedMin = 3.0
    const tetherDefMul = toCoef(1.5)

    const vx = toVel(orbSpeed)
    const vy = 0
    const v2 = BigInt(vx) * BigInt(vx) + BigInt(vy) * BigInt(vy)

    const bsmBaseVel = BigInt(toPos(breakSpeedMin)) * VEL_EXTRA_N
    const bsmEffVel = (bsmBaseVel * tetherDefMul) >> FP_COEF_SHIFT_N
    const thr2 = bsmEffVel * bsmEffVel

    // 4.0 < 4.5 → should NOT break
    expect(v2 < thr2).toBe(true)

    // But at speed 5.0, should break
    const vx5 = toVel(5.0)
    const v2_5 = BigInt(vx5) * BigInt(vx5)
    expect(v2_5 >= thr2).toBe(true)
  })
})

// ─── Speed Cap Comparison ───
// From physics_v2.ts:531-536
// speed > orbCap → clamp velocity
describe('Speed Cap Comparison', () => {
  it('should NOT cap when speed <= maxSpeed', () => {
    const speed = toVel(5.0)
    const maxSpeed = toVel(7.0)
    const powerMul = FP_COEF // 1.0
    const orbCap = applyCoefVel(maxSpeed, powerMul)

    expect(speed <= orbCap).toBe(true)
  })

  it('should cap when speed > maxSpeed', () => {
    const speed = toVel(8.0)
    const maxSpeed = toVel(7.0)
    const powerMul = FP_COEF // 1.0
    const orbCap = applyCoefVel(maxSpeed, powerMul)

    expect(speed > orbCap).toBe(true)
  })

  it('powerMul > 1.0 should raise speed cap', () => {
    const speed = toVel(8.0)
    const maxSpeed = toVel(7.0)
    const powerMul = toCoef(1.2) // 1.2x multiplier → cap = 8.4

    const orbCap = applyCoefVel(maxSpeed, powerMul)

    // 8.0 < 8.4 → should NOT cap
    expect(speed <= orbCap).toBe(true)
  })
})

// ─── Min Speed Boost Comparison ───
// From physics_v2.ts:388-398
// speed < minSp → apply boost
describe('Min Speed Boost Comparison', () => {
  it('should boost when speed < minSpeed', () => {
    const speed = toVel(0.5)
    const minSpeed = toVel(1.0)
    const minSpeedMul = FP_COEF // 1.0
    const accelMul = FP_COEF // 1.0

    let minSpCoef = minSpeedMul
    minSpCoef = (minSpCoef * accelMul) >> FP_COEF_SHIFT_N
    const minSp = applyCoefVel(minSpeed, minSpCoef)

    expect(speed < minSp).toBe(true)
  })

  it('should NOT boost when speed >= minSpeed', () => {
    const speed = toVel(1.5)
    const minSpeed = toVel(1.0)
    const minSpeedMul = FP_COEF
    const accelMul = FP_COEF

    let minSpCoef = minSpeedMul
    minSpCoef = (minSpCoef * accelMul) >> FP_COEF_SHIFT_N
    const minSp = applyCoefVel(minSpeed, minSpCoef)

    expect(speed >= minSp).toBe(true)
  })

  it('accelMul > 1.0 should raise effective minSpeed', () => {
    // With accelMul = 2.0, effective minSpeed = 1.0 * 2.0 = 2.0
    const speed = toVel(1.5)
    const minSpeed = toVel(1.0)
    const minSpeedMul = FP_COEF
    const accelMul = toCoef(2.0)

    let minSpCoef = minSpeedMul
    minSpCoef = (minSpCoef * accelMul) >> FP_COEF_SHIFT_N
    const minSp = applyCoefVel(minSpeed, minSpCoef)

    // 1.5 < 2.0 → should boost
    expect(speed < minSp).toBe(true)
  })
})

// ─── Shockwave Impact Threshold Comparison ───
// From physics_v2.ts:649-655
// vnAbs >= threshold_vel → trigger shockwave
describe('Shockwave Impact Threshold Comparison', () => {
  const VEL_EXTRA = 1024

  // posToVel: FP_POS → FP_VEL via * 1024
  const posToVel = (pos: number): number => pos * VEL_EXTRA

  it('should NOT trigger shockwave when impact < threshold', () => {
    const impactVn = toVel(3.0) // relative velocity
    const impactThreshold = toPos(4.0) // config threshold in FP_POS
    const threshold_vel = posToVel(impactThreshold)

    expect(Math.abs(impactVn) < threshold_vel).toBe(true)
  })

  it('should trigger shockwave when impact >= threshold', () => {
    const impactVn = toVel(5.0)
    const impactThreshold = toPos(4.0)
    const threshold_vel = posToVel(impactThreshold)

    expect(Math.abs(impactVn) >= threshold_vel).toBe(true)
  })
})

// ─── Split Detection Threshold Comparison ───
// From physics_v2.ts:594-598
// vn² >= vnTh² AND sum_v² >= 2 * keTh
describe('Split Detection Threshold Comparison', () => {
  it('should NOT split when vn < vnThreshold', () => {
    const vnThreshold = 6.0
    const vnTh_vel = toVel(vnThreshold)
    const vnTh2_base = BigInt(vnTh_vel) * BigInt(vnTh_vel)

    // With splitAggroMul = 1.0, threshold stays the same
    const aggroMul = FP_COEF
    const vnTh2_adj = (vnTh2_base << FP_COEF_SHIFT_N) / aggroMul

    // Collision with vn = 3.0 (below threshold)
    const vn = toVel(3.0)
    const vn2 = BigInt(vn) * BigInt(vn)

    // vn² < vnTh² → should NOT split
    expect(vn2 < vnTh2_adj).toBe(true)
  })

  it('should split when vn >= vnThreshold', () => {
    const vnThreshold = 6.0
    const vnTh_vel = toVel(vnThreshold)
    const vnTh2_base = BigInt(vnTh_vel) * BigInt(vnTh_vel)

    const aggroMul = FP_COEF
    const vnTh2_adj = (vnTh2_base << FP_COEF_SHIFT_N) / aggroMul

    // Collision with vn = 7.0 (above threshold)
    const vn = toVel(7.0)
    const vn2 = BigInt(vn) * BigInt(vn)

    // vn² >= vnTh² → should split (if KE also passes)
    expect(vn2 >= vnTh2_adj).toBe(true)
  })

  it('splitAggroMul > 1.0 should lower effective threshold', () => {
    const vnThreshold = 6.0
    const vnTh_vel = toVel(vnThreshold)
    const vnTh2_base = BigInt(vnTh_vel) * BigInt(vnTh_vel)

    // With splitAggroMul = 2.0, effective threshold = 6.0 / sqrt(2) ≈ 4.24
    // But since we compare vn², threshold² is divided by 2
    const aggroMul = toCoef(2.0)
    const vnTh2_adj = (vnTh2_base << FP_COEF_SHIFT_N) / aggroMul

    // vn = 5.0: vn² = 25, vnTh²/2 = 36/2 = 18
    // 25 >= 18 → should split
    const vn = toVel(5.0)
    const vn2 = BigInt(vn) * BigInt(vn)

    expect(vn2 >= vnTh2_adj).toBe(true)
  })

  it('KE threshold must also be met for split', () => {
    const keThreshold = 36.0 // sum of v² must be >= 2 * 36 = 72
    const keThreshold_vel2 = BigInt(Math.round(keThreshold * FP_VEL * FP_VEL))

    const aggroMul = FP_COEF
    const keTh2_adj = (keThreshold_vel2 << FP_COEF_SHIFT_N) / aggroMul

    // Two orbs at speed 5.0 each: sum_v² = 25 + 25 = 50
    const speed1 = toVel(5.0)
    const speed2 = toVel(5.0)
    const sum_v2 = BigInt(speed1) * BigInt(speed1) + BigInt(speed2) * BigInt(speed2)

    // 50 < 72 → should NOT split (KE check fails)
    expect(sum_v2 < 2n * keTh2_adj).toBe(true)

    // Two orbs at speed 7.0 each: sum_v² = 49 + 49 = 98
    const speed3 = toVel(7.0)
    const sum_v2_high = BigInt(speed3) * BigInt(speed3) * 2n

    // 98 >= 72 → KE check passes
    expect(sum_v2_high >= 2n * keTh2_adj).toBe(true)
  })
})
