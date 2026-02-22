// ─── Fixed-Point Physics Step (V2) ───
//
// Three-scale fixed-point: FP_POS (positions), FP_VEL (velocities), FP_COEF (coefficients).
// No JS bitwise on FP_VEL. All coefficient applications use >> 40n.

import type { EngineStateV2, V2ConfigFp, OrbV2, SkillV2 } from './types_v2.js'
import { dramaMultipliersV2 } from '../../utils/v2/drama_v2.js'
import type { DramaMultipliersV2 } from '../../utils/v2/drama_v2.js'
import {
  FP_POS, FP_VEL, FP_COEF, FP_COEF_SHIFT_N, FP_POS_SHIFT_N, FP_POS_N,
  VEL_EXTRA, VEL_EXTRA_N,
  toPos, toVel, toCoef,
  velToPos, posToVel,
  mulPos, divPos, hypotPos, hypotVel,
  dotVelPos, mulVelPos, applyCoefVel,
  isqrt, absFp, clampFp, sinFp, cosFp, radiansToIdx,
  assertSafeVel,
} from '../../utils/v2/fpmath.js'

// Jitter max coefficient: toCoef(0.02) = BigInt(Math.round(0.02 * 2**40))
const JITTER_MAX_COEF = 21990232556n // toCoef(0.02)
const INT32_HALF_N = 2147483648n     // 2^31, for mapping int32 → [-1, 1) in FP_COEF

export function stepFrameV2(
  state: EngineStateV2,
  cfg: V2ConfigFp,
): { state: EngineStateV2; events: any[] } {
  const dm = dramaMultipliersV2(state.frame, cfg)
  const outEvents: any[] = []
  const pendingSplitMap = new Map<number, { idx: number; nx: number; ny: number }>()

  // Shrunk boundary radius (FP_POS)
  const R = applyCoefPos(cfg.boundaryRadius, dm.shrink)
  const RX = applyCoefPos(cfg.rectHalfWidth, dm.shrink)
  const RY = applyCoefPos(cfg.rectHalfHeight, dm.shrink)

  // ─── Sudden death ───
  let gCenterX = cfg.cx, gCenterY = cfg.cy
  let sdMul = FP_COEF // 1.0
  let sdActive = false
  const sdMaxOrbs = 2

  if (cfg.sdEnabled && state.orbs.length <= sdMaxOrbs && state.twoOrbsStartFrame !== undefined) {
    const elapsed = state.frame - state.twoOrbsStartFrame
    if (elapsed >= cfg.sdAfterFrames) {
      sdActive = true
      if (cfg.sdRampFrames > 0) {
        const rampElapsed = elapsed - cfg.sdAfterFrames
        // t = min(1, rampElapsed / rampFrames) in FP_COEF
        const t = rampElapsed >= cfg.sdRampFrames
          ? FP_COEF
          : (BigInt(rampElapsed) * FP_COEF) / BigInt(cfg.sdRampFrames)
        // sdMul = 1 + (target - 1) * t
        const range = cfg.sdGravityMul - FP_COEF
        sdMul = FP_COEF + (range * t) / FP_COEF
      } else {
        sdMul = cfg.sdGravityMul
      }

      // Center shift (requires seed_hex from economics; skip if unavailable)
      const seedHex = state.econ?.header?.seed_hex
      if (cfg.centerShiftRadius > 0 && seedHex && seedHex.length >= 4) {
        const period = Math.max(1, cfg.sdCenterShiftPeriodFrames)
        const seedVal = parseInt(seedHex.slice(0, 4), 16)
        // seedOffset as angle index: (seedVal / 65536) * 4096
        const seedIdx = Math.round((seedVal / 65536) * 4096) & 4095
        const sdElapsed = elapsed - cfg.sdAfterFrames
        // phase angle index: seedIdx + (sdElapsed * 4096 / period)
        const phaseIdx = (seedIdx + Math.floor((sdElapsed * 4096) / period)) & 4095
        gCenterX = cfg.cx + mulPos(cfg.centerShiftRadius, cosFp(phaseIdx))
        gCenterY = cfg.cy + mulPos(cfg.centerShiftRadius, sinFp(phaseIdx))
      }
    }
  }

  // ─── Per-orb physics ───
  for (let index = 0; index < state.orbs.length; index++) {
    const o = state.orbs[index]

    // Integration: position += velocity (FP_VEL → FP_POS)
    o.x += velToPos(o.vx)
    o.y += velToPos(o.vy)

    if (cfg.shape === 'circle') {
      circleBoundary(o, index, cfg, R, dm, sdActive, outEvents)
    } else {
      rectBoundary(o, index, cfg, RX, RY, dm, sdActive, outEvents)
    }

    // ─── Gravity ───
    applyGravity(o, state, cfg, dm, sdMul, gCenterX, gCenterY)

    // ─── Spring tethers ───
    applySpringTethers(o, index, state, cfg)

    // ─── Min speed boost ───
    applyMinSpeed(o, index, cfg, dm, gCenterX, gCenterY)

    // ─── Edge gravity points ───
    if (cfg.shape !== 'rect' && cfg.edgeGravityCount > 0 && cfg.edgeGravityStrength > 0n) {
      applyEdgeGravity(o, cfg, R)
    }

    // ─── Edge guide ───
    if (cfg.shape !== 'rect' && cfg.edgeGuideEnabled) {
      applyEdgeGuide(o, cfg, R)
    }

    // ─── Speed cap ───
    applySpeedCap(o, state, cfg, sdMaxOrbs)
  }

  // ─── Orb-orb collisions + split detection ───
  for (let i = 0; i < state.orbs.length; i++) {
    for (let j = i + 1; j < state.orbs.length; j++) {
      const a = state.orbs[i], b = state.orbs[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const d2 = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)
      let d_fp = Number(isqrt(d2))
      const min_fp = a.radius + b.radius

      if (d_fp === 0) { d_fp = 1; dx = 1; dy = 0 }

      // Split detection (pre-resolution)
      if (cfg.splitEnabled && state.orbs.length <= (cfg.enableBelowOrbs)) {
        detectSplit(a, b, i, j, dx, dy, d_fp, min_fp, state, cfg, pendingSplitMap)
      }

      // Collision resolution
      const skipResolve = cfg.splitEnabled && (pendingSplitMap.has(i) || pendingSplitMap.has(j))
      if (!skipResolve && d_fp < min_fp) {
        resolveOrbCollision(a, b, dx, dy, d_fp, min_fp, cfg, outEvents)
      }
    }
  }

  // ─── Apply splits ───
  if (cfg.splitEnabled && pendingSplitMap.size > 0) {
    applySplits(state, cfg, dm, R, RX, RY, pendingSplitMap, outEvents)
  }

  // ─── Decrement split cooldowns ───
  if (cfg.splitEnabled) {
    for (let k = 0; k < state.orbs.length; k++) {
      if (state.orbs[k].splitCooldown > 0) state.orbs[k].splitCooldown -= 1
    }
  }

  // ─── Final speed clamp ───
  finalSpeedClamp(state, cfg, sdMaxOrbs)

  state.frame += 1
  return { state, events: outEvents }
}

// ─── Helper: apply FP_COEF to FP_POS → FP_POS ───
function applyCoefPos(pos: number, coef: bigint): number {
  return Number((BigInt(pos) * coef) >> FP_COEF_SHIFT_N)
}

// ─── Circle boundary collision ───
function circleBoundary(
  o: OrbV2, index: number,
  cfg: V2ConfigFp, R: number,
  dm: DramaMultipliersV2, sdActive: boolean,
  outEvents: any[],
): void {
  const dx = o.x - cfg.cx, dy = o.y - cfg.cy
  const dist = hypotPos(dx, dy) || 1

  if (dist >= R - o.radius) {
    const nx = divPos(dx, dist)
    const ny = divPos(dy, dist)
    const target = R - o.radius
    o.x = cfg.cx + mulPos(nx, target)
    o.y = cfg.cy + mulPos(ny, target)

    if (!o.justCollided) {
      outEvents.push({
        type: 'boundary_hit', orbIndex: index,
        anchorX: cfg.cx + mulPos(nx, R),
        anchorY: cfg.cy + mulPos(ny, R),
      })
      o.hadTether = true
      o.justCollided = true
    }

    // Reflect velocity: dot = v · n (FP_VEL · FP_POS → FP_VEL)
    const dot_vel = dotVelPos(o.vx, o.vy, nx, ny)
    o.vx = o.vx - 2 * mulVelPos(dot_vel, nx)
    o.vy = o.vy - 2 * mulVelPos(dot_vel, ny)

    // Restitution
    const sdRestCoef = sdActive ? cfg.sdRestMul : FP_COEF
    const restCoef = (cfg.restitution * sdRestCoef) >> FP_COEF_SHIFT_N
    o.vx = applyCoefVel(o.vx, restCoef)
    o.vy = applyCoefVel(o.vy, restCoef)

    // Tangent kick (integer-only coin flip)
    const pr = o.prng
    const tangentSign = (pr.nextU32() & 1) === 0 ? 1 : -1
    const sdTangentCoef = sdActive ? cfg.sdTangentMul : FP_COEF
    // combined = tangentImpulse * tanKickMul * gravMul * sdTangentMul
    let kickCoef = cfg.tangentImpulse
    kickCoef = (kickCoef * o.trait.tanKickMul) >> FP_COEF_SHIFT_N
    kickCoef = (kickCoef * dm.gravMul) >> FP_COEF_SHIFT_N
    kickCoef = (kickCoef * sdTangentCoef) >> FP_COEF_SHIFT_N

    // tangent direction in FP_POS, upshift to FP_VEL via BigInt * 1024n
    const tx_vel = BigInt(tangentSign > 0 ? -ny : ny) * VEL_EXTRA_N
    const ty_vel = BigInt(tangentSign > 0 ? nx : -nx) * VEL_EXTRA_N
    o.vx += Number((tx_vel * kickCoef) >> FP_COEF_SHIFT_N)
    o.vy += Number((ty_vel * kickCoef) >> FP_COEF_SHIFT_N)

    // Jitter (integer-only: map int32 → [-JITTER_MAX, JITTER_MAX) as FP_COEF)
    const jR = (pr.nextU32() | 0) // int32
    const jitterCoef = (BigInt(jR) * JITTER_MAX_COEF) / INT32_HALF_N
    let jCoef = (jitterCoef * o.trait.jitterMul) >> FP_COEF_SHIFT_N
    jCoef = (jCoef * dm.jitterMul) >> FP_COEF_SHIFT_N
    o.vx += Number((tx_vel * jCoef) >> FP_COEF_SHIFT_N)
    o.vy += Number((ty_vel * jCoef) >> FP_COEF_SHIFT_N)
  } else {
    o.justCollided = false
  }
}

// ─── Rect boundary collision ───
function rectBoundary(
  o: OrbV2, index: number,
  cfg: V2ConfigFp, RX: number, RY: number,
  dm: DramaMultipliersV2, sdActive: boolean,
  outEvents: any[],
): void {
  const maxX = RX - o.radius
  const maxY = RY - o.radius
  let px = o.x - cfg.cx
  let py = o.y - cfg.cy
  const overX = absFp(px) - maxX
  const overY = absFp(py) - maxY
  let hit = false
  let nx = 0, ny = 0
  let anchorX = 0, anchorY = 0

  if (overX > 0 || overY > 0) {
    hit = true
    if (overX >= overY) {
      nx = px > 0 ? FP_POS : -FP_POS
      ny = 0
      px = clampFp(px, -maxX, maxX)
      o.x = cfg.cx + px
      anchorX = cfg.cx + (px > 0 ? RX : -RX)
      anchorY = clampFp(o.y, cfg.cy - RY, cfg.cy + RY)
    } else {
      nx = 0
      ny = py > 0 ? FP_POS : -FP_POS
      py = clampFp(py, -maxY, maxY)
      o.y = cfg.cy + py
      anchorY = cfg.cy + (py > 0 ? RY : -RY)
      anchorX = clampFp(o.x, cfg.cx - RX, cfg.cx + RX)
    }
  }

  if (hit) {
    if (!o.justCollided) {
      outEvents.push({ type: 'boundary_hit', orbIndex: index, anchorX, anchorY })
      o.hadTether = true
      o.justCollided = true
    }

    const dot_vel = dotVelPos(o.vx, o.vy, nx, ny)
    o.vx = o.vx - 2 * mulVelPos(dot_vel, nx)
    o.vy = o.vy - 2 * mulVelPos(dot_vel, ny)

    // Rect uses base restitution = 1.0, clamped to ≤ 1.0
    const sdRestCoef = sdActive ? cfg.sdRestMul : FP_COEF
    let restCoef = (o.trait.restMul * dm.restMul) >> FP_COEF_SHIFT_N
    restCoef = (restCoef * sdRestCoef) >> FP_COEF_SHIFT_N
    if (restCoef > FP_COEF) restCoef = FP_COEF // clamp to 1.0
    o.vx = applyCoefVel(o.vx, restCoef)
    o.vy = applyCoefVel(o.vy, restCoef)

    // Tangent kick (rect uses hardcoded 0.12 base in v1, integer-only coin flip)
    const pr = o.prng
    const tangentSign = (pr.nextU32() & 1) === 0 ? 1 : -1
    const sdTangentCoef = sdActive ? cfg.sdTangentMul : FP_COEF
    let kickCoef = toCoef(0.12)
    kickCoef = (kickCoef * o.trait.tanKickMul) >> FP_COEF_SHIFT_N
    kickCoef = (kickCoef * sdTangentCoef) >> FP_COEF_SHIFT_N

    const tx_vel = BigInt(tangentSign > 0 ? -ny : ny) * VEL_EXTRA_N
    const ty_vel = BigInt(tangentSign > 0 ? nx : -nx) * VEL_EXTRA_N
    o.vx += Number((tx_vel * kickCoef) >> FP_COEF_SHIFT_N)
    o.vy += Number((ty_vel * kickCoef) >> FP_COEF_SHIFT_N)

    // Jitter (integer-only)
    const jR = (pr.nextU32() | 0) // int32
    const jitterCoef = (BigInt(jR) * JITTER_MAX_COEF) / INT32_HALF_N
    let jCoef = (jitterCoef * o.trait.jitterMul) >> FP_COEF_SHIFT_N
    jCoef = (jCoef * dm.jitterMul) >> FP_COEF_SHIFT_N
    o.vx += Number((tx_vel * jCoef) >> FP_COEF_SHIFT_N)
    o.vy += Number((ty_vel * jCoef) >> FP_COEF_SHIFT_N)
  } else {
    o.justCollided = false
  }
}

// ─── Gravity ───
function applyGravity(
  o: OrbV2, state: EngineStateV2, cfg: V2ConfigFp,
  dm: DramaMultipliersV2, sdMul: bigint,
  gCenterX: number, gCenterY: number,
): void {
  let g_coef = cfg.gravityBase

  // Oscillation
  if (state.orbs.length <= cfg.oscillateBelowOrbs && cfg.gravityPeriodFrames > 0) {
    const period = cfg.gravityPeriodFrames
    const phaseIdx = Math.floor((state.frame % period) * 4096 / period) & 4095
    const sin_val = sinFp(phaseIdx) // FP_POS
    // factor = 1 + ampFrac * sin(phase) → FP_COEF + (ampFrac * sin_val) >> 20
    const ampSin = (cfg.gravityAmpFrac * BigInt(sin_val)) >> FP_POS_SHIFT_N
    let factor = FP_COEF + ampSin
    if (factor < 0n) factor = 0n
    g_coef = (g_coef * factor) >> FP_COEF_SHIFT_N
  }

  // Multipliers
  g_coef = (g_coef * o.trait.gravityMul) >> FP_COEF_SHIFT_N
  g_coef = (g_coef * dm.gravMul) >> FP_COEF_SHIFT_N
  g_coef = (g_coef * sdMul) >> FP_COEF_SHIFT_N

  // Direction (FP_POS)
  const gdx = o.x - gCenterX
  const gdy = o.y - gCenterY

  // Upshift to FP_VEL, apply coefficient
  const gdx_vel = BigInt(gdx) * VEL_EXTRA_N
  const gdy_vel = BigInt(gdy) * VEL_EXTRA_N
  o.vx -= Number((gdx_vel * g_coef) >> FP_COEF_SHIFT_N)
  o.vy -= Number((gdy_vel * g_coef) >> FP_COEF_SHIFT_N)
}

// ─── Spring tethers ───
function applySpringTethers(
  o: OrbV2, index: number,
  state: EngineStateV2, cfg: V2ConfigFp,
): void {
  const list = state.tethers[index]
  if (!list || list.length === 0) return
  if (cfg.springK <= 0n && cfg.springDamping <= 0n) return

  for (let ti = 0; ti < list.length; ti++) {
    const t = list[ti]
    const sx = o.x - t.anchorX
    const sy = o.y - t.anchorY
    const L = hypotPos(sx, sy)
    if (L < 1) continue // avoid division by zero

    const ux = divPos(sx, L)
    const uy = divPos(sy, L)
    const rest = t.rest ?? cfg.springRest
    const ext = L - rest // FP_POS (can be negative)

    // Spring force: a = -k * ext (FP_COEF * FP_POS → FP_VEL via upshift)
    if (cfg.springK > 0n) {
      const ext_vel = BigInt(ext) * VEL_EXTRA_N
      const a_vel = Number((ext_vel * cfg.springK) >> FP_COEF_SHIFT_N)
      o.vx -= mulVelPos(a_vel, ux)
      o.vy -= mulVelPos(a_vel, uy)
    }

    // Damping: a = -c * v_parallel
    if (cfg.springDamping > 0n) {
      const vpar = dotVelPos(o.vx, o.vy, ux, uy) // FP_VEL
      const damp_vel = applyCoefVel(vpar, cfg.springDamping)
      o.vx -= mulVelPos(damp_vel, ux)
      o.vy -= mulVelPos(damp_vel, uy)
    }
  }
}

// ─── Min speed boost ───
function applyMinSpeed(
  o: OrbV2, _index: number,
  cfg: V2ConfigFp, dm: DramaMultipliersV2,
  gCenterX: number, gCenterY: number,
): void {
  const speed = hypotVel(o.vx, o.vy)
  // minSp = minSpeed * minSpeedMul * accelMul * max(1, gravMul)
  let minSpCoef = o.trait.minSpeedMul
  if (dm.gravMul > FP_COEF) {
    minSpCoef = (minSpCoef * dm.gravMul) >> FP_COEF_SHIFT_N
  }
  // Apply skill accelMul for faster acceleration
  minSpCoef = (minSpCoef * o.skill.accelMul) >> FP_COEF_SHIFT_N
  const minSp = applyCoefVel(cfg.minSpeed, minSpCoef)

  if (speed < minSp) {
    const gdx = o.x - gCenterX
    const gdy = o.y - gCenterY
    const distG = hypotPos(gdx, gdy) || 1
    const nxg = divPos(gdx, distG)
    const nyg = divPos(gdy, distG)
    const pr = o.prng
    const minSpSign = (pr.nextU32() & 1) === 0 ? 1 : -1
    // tangent direction in FP_POS
    const tx = minSpSign > 0 ? -nyg : nyg
    const ty = minSpSign > 0 ? nxg : -nxg
    // Add minSp in tangent direction (FP_VEL * FP_POS → FP_VEL)
    o.vx += mulVelPos(minSp, tx)
    o.vy += mulVelPos(minSp, ty)
  }
}

// ─── Edge gravity ───
function applyEdgeGravity(o: OrbV2, cfg: V2ConfigFp, R: number): void {
  const dx = o.x - cfg.cx, dy = o.y - cfg.cy
  const dist = hypotPos(dx, dy) || 1
  const radiusOnEdge = R - cfg.edgeInsetPixels
  if (radiusOnEdge <= 0) return

  // Closeness: how near to boundary (0..FP_COEF)
  const margin = toPos(24)
  const threshold = R - o.radius - margin
  if (dist <= threshold) return
  // closeness = clamp((dist - threshold) / margin, 0, 1) in FP_COEF
  const over = dist - threshold
  const closeness = over >= margin ? FP_COEF : (BigInt(over) * FP_COEF) / BigInt(margin)

  // Find nearest edge point
  let bestDx = 0, bestDy = 0, bestD2 = 0x7FFFFFFFFFFFFFFFn
  for (let k = 0; k < cfg.edgeGravityCount; k++) {
    const angIdx = Math.floor((k * 4096) / cfg.edgeGravityCount) & 4095
    const px = cfg.cx + mulPos(radiusOnEdge, cosFp(angIdx))
    const py = cfg.cy + mulPos(radiusOnEdge, sinFp(angIdx))
    const ex = px - o.x, ey = py - o.y
    const d2 = BigInt(ex) * BigInt(ex) + BigInt(ey) * BigInt(ey)
    if (d2 < bestD2) { bestD2 = d2; bestDx = ex; bestDy = ey }
  }

  const len = hypotPos(bestDx, bestDy) || 1
  const ux = divPos(bestDx, len)
  const uy = divPos(bestDy, len)

  // dv = unit_dir * strength * closeness
  // unit_dir is FP_POS, upshift to FP_VEL
  const ux_vel = BigInt(ux) * VEL_EXTRA_N
  const uy_vel = BigInt(uy) * VEL_EXTRA_N
  const combined = (cfg.edgeGravityStrength * closeness) >> FP_COEF_SHIFT_N
  o.vx += Number((ux_vel * combined) >> FP_COEF_SHIFT_N)
  o.vy += Number((uy_vel * combined) >> FP_COEF_SHIFT_N)
}

// ─── Edge guide ───
function applyEdgeGuide(o: OrbV2, cfg: V2ConfigFp, R: number): void {
  if (cfg.edgeGuideRadiusTargetFrac <= 0n || cfg.edgeBandWidth <= 0) return

  const dx = o.x - cfg.cx, dy = o.y - cfg.cy
  const dist = hypotPos(dx, dy) || 1
  const rTarget = applyCoefPos(R, cfg.edgeGuideRadiusTargetFrac)
  const speed = hypotVel(o.vx, o.vy)

  if (dist < rTarget - cfg.edgeBandWidth || dist > rTarget + cfg.edgeBandWidth) return
  if (speed < cfg.edgeMinSpeedGate) return

  // Unit normal from center to orb (FP_POS)
  const nx = divPos(dx, dist)
  const ny = divPos(dy, dist)

  // Two tangent directions
  const t1x = -ny, t1y = nx
  const t2x = ny, t2y = -nx

  // Pick tangent aligned with velocity
  const dot1 = dotVelPos(o.vx, o.vy, t1x, t1y)
  const dot2 = dotVelPos(o.vx, o.vy, t2x, t2y)
  const tx = dot1 > dot2 ? t1x : t2x
  const ty = dot1 > dot2 ? t1y : t2y

  // Make acceleration orthogonal to velocity
  // vHat = v / speed (FP_POS unit vector from FP_VEL)
  // We compute in FP_POS by dividing FP_VEL by speed_vel, then scaling to FP_POS
  const vHatX = Number((BigInt(o.vx) * FP_POS_N) / BigInt(speed || 1))
  const vHatY = Number((BigInt(o.vy) * FP_POS_N) / BigInt(speed || 1))

  const dotTV = mulPos(tx, vHatX) + mulPos(ty, vHatY)
  const tOrthX = tx - mulPos(dotTV, vHatX)
  const tOrthY = ty - mulPos(dotTV, vHatY)
  const tOrthLen = hypotPos(tOrthX, tOrthY)
  if (tOrthLen < 1) return

  const tOrthNormX = divPos(tOrthX, tOrthLen)
  const tOrthNormY = divPos(tOrthY, tOrthLen)

  // Distance factor: d = clamp((dist - rTarget) / bandWidth, -1, 1) in FP_COEF
  const diff = dist - rTarget
  let d_coef: bigint
  if (diff >= cfg.edgeBandWidth) d_coef = FP_COEF
  else if (diff <= -cfg.edgeBandWidth) d_coef = -FP_COEF
  else d_coef = (BigInt(diff) * FP_COEF) / BigInt(cfg.edgeBandWidth)

  // Apply: dv = k * d * tOrthNorm
  const kd = (cfg.edgeGuideK * d_coef) >> FP_COEF_SHIFT_N
  const tox_vel = BigInt(tOrthNormX) * VEL_EXTRA_N
  const toy_vel = BigInt(tOrthNormY) * VEL_EXTRA_N
  o.vx += Number((tox_vel * kd) >> FP_COEF_SHIFT_N)
  o.vy += Number((toy_vel * kd) >> FP_COEF_SHIFT_N)
}

// ─── Speed cap ───
function computeSpeedCap(state: EngineStateV2, cfg: V2ConfigFp, sdMaxOrbs: number): number {
  let cap = cfg.maxSpeed // FP_VEL
  if (state.orbs.length <= sdMaxOrbs) {
    const rampFrames = Math.max(1, cfg.twoOrbsRampFrames || 720)
    if (state.twoOrbsStartFrame === undefined) state.twoOrbsStartFrame = state.frame
    const start = state.twoOrbsStartFrame
    const elapsed = state.frame - start
    const t = elapsed >= rampFrames ? FP_COEF : (BigInt(elapsed) * FP_COEF) / BigInt(rampFrames)
    // cap = maxSpeed + (twoOrbsMaxSpeed - maxSpeed) * t
    const range = BigInt(cfg.twoOrbsMaxSpeed - cfg.maxSpeed)
    cap = cfg.maxSpeed + Number((range * t) / FP_COEF)
  } else if (state.twoOrbsStartFrame !== undefined) {
    state.twoOrbsStartFrame = undefined
  }
  return cap
}

function applySpeedCap(o: OrbV2, state: EngineStateV2, cfg: V2ConfigFp, sdMaxOrbs: number): void {
  if (cfg.maxSpeed <= 0) return
  const cap = computeSpeedCap(state, cfg, sdMaxOrbs)
  const speed = hypotVel(o.vx, o.vy)
  const orbCap = applyCoefVel(cap, o.skill.powerMul)
  if (speed > orbCap && speed > 0) {
    o.vx = Number((BigInt(o.vx) * BigInt(orbCap)) / BigInt(speed))
    o.vy = Number((BigInt(o.vy) * BigInt(orbCap)) / BigInt(speed))
  }
}

function finalSpeedClamp(state: EngineStateV2, cfg: V2ConfigFp, sdMaxOrbs: number): void {
  if (cfg.maxSpeed <= 0) return
  const cap = computeSpeedCap(state, cfg, sdMaxOrbs)
  for (let k = 0; k < state.orbs.length; k++) {
    const ov = state.orbs[k]
    const speed = hypotVel(ov.vx, ov.vy)
    const orbCap = applyCoefVel(cap, ov.skill.powerMul)
    if (speed > orbCap && speed > 0) {
      ov.vx = Number((BigInt(ov.vx) * BigInt(orbCap)) / BigInt(speed))
      ov.vy = Number((BigInt(ov.vy) * BigInt(orbCap)) / BigInt(speed))
    }
  }
}

// ─── Split detection ───
function detectSplit(
  a: OrbV2, b: OrbV2,
  i: number, j: number,
  dx: number, dy: number, d_fp: number, min_fp: number,
  state: EngineStateV2, cfg: V2ConfigFp,
  pendingSplitMap: Map<number, { idx: number; nx: number; ny: number }>,
): void {
  // Contact check: d <= min + epsilon (1 FP_POS unit)
  if (d_fp > min_fp + 1) return

  const nx = divPos(dx, d_fp)
  const ny = divPos(dy, d_fp)

  // Relative velocity normal component (FP_VEL)
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy
  const vn = dotVelPos(rvx, rvy, nx, ny)

  // vn² vs vnThreshold² (both FP_VEL²)
  const vn2 = BigInt(vn) * BigInt(vn)
  const va2 = BigInt(a.vx) * BigInt(a.vx) + BigInt(a.vy) * BigInt(a.vy)
  const vb2 = BigInt(b.vx) * BigInt(b.vx) + BigInt(b.vy) * BigInt(b.vy)
  const sum_v2 = va2 + vb2

  // Per-orb split aggro (FP_COEF, clamped to min 0.01)
  const minAggro = toCoef(0.01)
  const aggroA = a.skill.splitAggroMul > minAggro ? a.skill.splitAggroMul : minAggro
  const aggroB = b.skill.splitAggroMul > minAggro ? b.skill.splitAggroMul : minAggro

  // vnThreshold² adjusted by aggro: vnTh² / aggro (since sqrt(aggro)² = aggro)
  const vnTh_vel = BigInt(cfg.vnThreshold_vel)
  const vnTh2_base = vnTh_vel * vnTh_vel

  // For orb A: vnTh2_adj = (vnTh2_base << 40) / aggroA
  const vnTh2_A = (vnTh2_base << FP_COEF_SHIFT_N) / aggroA
  const vnTh2_B = (vnTh2_base << FP_COEF_SHIFT_N) / aggroB

  // KE threshold adjusted: keTh / aggro (same sqrt trick)
  const keTh2_A = (cfg.keThreshold_vel2 << FP_COEF_SHIFT_N) / aggroA
  const keTh2_B = (cfg.keThreshold_vel2 << FP_COEF_SHIFT_N) / aggroB

  // vn2 needs same scaling for comparison: vn2 << 40
  const vn2_scaled = vn2 << FP_COEF_SHIFT_N
  const sum_v2_scaled = sum_v2 << FP_COEF_SHIFT_N

  const gateA = vn2_scaled >= vnTh2_A && sum_v2_scaled >= 2n * keTh2_A
  const gateB = vn2_scaled >= vnTh2_B && sum_v2_scaled >= 2n * keTh2_B

  const maxPending = cfg.maxOrbsCap - state.orbs.length - pendingSplitMap.size
  if (maxPending <= 0) return

  if (gateA && a.gen < cfg.maxGenerations && a.splitCooldown === 0 && !pendingSplitMap.has(i)) {
    pendingSplitMap.set(i, { idx: i, nx, ny })
  }
  if (gateB && b.gen < cfg.maxGenerations && b.splitCooldown === 0 && !pendingSplitMap.has(j)) {
    pendingSplitMap.set(j, { idx: j, nx: -nx, ny: -ny })
  }
}

// ─── Orb-orb collision resolution ───
function resolveOrbCollision(
  a: OrbV2, b: OrbV2,
  dx: number, dy: number, d_fp: number, min_fp: number,
  cfg: V2ConfigFp, outEvents: any[],
): void {
  const overlap = Math.floor((min_fp - d_fp) / 2)
  const nx = divPos(dx, d_fp)
  const ny = divPos(dy, d_fp)
  const tx = -ny, ty = nx

  // Push apart (FP_POS)
  a.x -= mulPos(nx, overlap); a.y -= mulPos(ny, overlap)
  b.x += mulPos(nx, overlap); b.y += mulPos(ny, overlap)

  // Decompose velocities (FP_VEL · FP_POS → FP_VEL)
  const va_n = dotVelPos(a.vx, a.vy, nx, ny)
  const vb_n = dotVelPos(b.vx, b.vy, nx, ny)
  const va_t = dotVelPos(a.vx, a.vy, tx, ty)
  const vb_t = dotVelPos(b.vx, b.vy, tx, ty)

  // Equal-mass collision with restitution e
  // Precompute: half_1_minus_e = round(0.5*(1-e) * 2^40)
  //             half_1_plus_e  = round(0.5*(1+e) * 2^40)
  const e_coef = cfg.orbRestitution
  const half_1_minus_e = (FP_COEF - e_coef) / 2n
  const half_1_plus_e = (FP_COEF + e_coef) / 2n

  const va_n_new = Number((BigInt(va_n) * half_1_minus_e + BigInt(vb_n) * half_1_plus_e) >> FP_COEF_SHIFT_N)
  const vb_n_new = Number((BigInt(va_n) * half_1_plus_e + BigInt(vb_n) * half_1_minus_e) >> FP_COEF_SHIFT_N)

  // Reconstruct (FP_VEL * FP_POS → FP_VEL)
  a.vx = mulVelPos(va_n_new, nx) + mulVelPos(va_t, tx)
  a.vy = mulVelPos(va_n_new, ny) + mulVelPos(va_t, ty)
  b.vx = mulVelPos(vb_n_new, nx) + mulVelPos(vb_t, tx)
  b.vy = mulVelPos(vb_n_new, ny) + mulVelPos(vb_t, ty)

  // Impact shockwave
  const vn = vb_n - va_n // FP_VEL
  if (cfg.shockEnabled && cfg.shockTriggerOnImpact) {
    const vnAbs = absFp(vn)
    const threshold_vel = posToVel(cfg.shockImpactThreshold)
    if (vnAbs >= threshold_vel) {
      outEvents.push({
        type: 'shock',
        x: Math.floor((a.x + b.x) / 2),
        y: Math.floor((a.y + b.y) / 2),
        color: '#ffffff',
        kind: 'impact',
      })
    }
  }
}

// ─── Apply splits ───
function applySplits(
  state: EngineStateV2, cfg: V2ConfigFp,
  dm: DramaMultipliersV2, R: number, RX: number, RY: number,
  pendingSplitMap: Map<number, { idx: number; nx: number; ny: number }>,
  outEvents: any[],
): void {
  const entries = [...pendingSplitMap.values()].sort((p, q) => p.idx - q.idx)

  for (const ps of entries) {
    if (state.orbs.length >= cfg.maxOrbsCap) break
    const parent = state.orbs[ps.idx]
    if (!parent) continue
    if (parent.splitCooldown > 0 || parent.gen >= cfg.maxGenerations) continue

    const n_x = ps.nx, n_y = ps.ny
    const t_x = -n_y, t_y = n_x

    // Rotate tangent by ±angleSpread using LUT
    const cosA = cosFp(cfg.splitAngleSpread)
    const sinA = sinFp(cfg.splitAngleSpread)
    // d1 = rotate(t, +angle): (tx*cos - ty*sin, tx*sin + ty*cos)
    const d1x = mulPos(t_x, cosA) - mulPos(t_y, sinA)
    const d1y = mulPos(t_x, sinA) + mulPos(t_y, cosA)
    // d2 = rotate(t, -angle): (tx*cos + ty*sin, ty*cos - tx*sin)
    const d2x = mulPos(t_x, cosA) + mulPos(t_y, sinA)
    const d2y = mulPos(t_y, cosA) - mulPos(t_x, sinA)

    // Child radius (FP_POS)
    const rChildRaw = applyCoefPos(parent.radius, cfg.radiusScale)
    const rChild = Math.max(toPos(3), rChildRaw)

    // Separation
    const sep = Math.floor(rChild * 6 / 10) // 0.6 * rChild in FP_POS

    // Positions
    let x1 = parent.x + mulPos(d1x, sep)
    let y1 = parent.y + mulPos(d1y, sep)
    let x2 = parent.x + mulPos(d2x, sep)
    let y2 = parent.y + mulPos(d2y, sep)

    // Clamp inside boundary
    if (cfg.shape === 'circle') {
      const clampCircle = (x: number, y: number): { x: number; y: number } => {
        const vx = x - cfg.cx, vy = y - cfg.cy
        const L = hypotPos(vx, vy)
        const maxL = applyCoefPos(R, FP_COEF) - rChild // R already shrunk
        if (L > maxL && L > 0) {
          const nx = divPos(vx, L)
          const ny = divPos(vy, L)
          return { x: cfg.cx + mulPos(nx, maxL), y: cfg.cy + mulPos(ny, maxL) }
        }
        return { x, y }
      };
      ({ x: x1, y: y1 } = clampCircle(x1, y1));
      ({ x: x2, y: y2 } = clampCircle(x2, y2))
    } else {
      const clampRect = (x: number, lo: number, hi: number) => clampFp(x, lo, hi)
      x1 = clampRect(x1, cfg.cx - RX + rChild, cfg.cx + RX - rChild)
      y1 = clampRect(y1, cfg.cy - RY + rChild, cfg.cy + RY - rChild)
      x2 = clampRect(x2, cfg.cx - RX + rChild, cfg.cx + RX - rChild)
      y2 = clampRect(y2, cfg.cy - RY + rChild, cfg.cy + RY - rChild)
    }

    // Child velocities (FP_VEL)
    const vp = hypotVel(parent.vx, parent.vy)
    // base = 0.5 * parent velocity
    const halfVx = Math.floor(parent.vx / 2)
    const halfVy = Math.floor(parent.vy / 2)
    // childMul * vp * direction (FP_VEL * FP_COEF * FP_POS → FP_VEL)
    // = (vp * childSpeedMul) >> 40 * direction >> 20
    const vpScaled = applyCoefVel(vp, cfg.childSpeedMul) // FP_VEL
    let v1x = halfVx + mulVelPos(vpScaled, d1x)
    let v1y = halfVy + mulVelPos(vpScaled, d1y)
    let v2x = halfVx + mulVelPos(vpScaled, d2x)
    let v2y = halfVy + mulVelPos(vpScaled, d2y)

    // Energy cap: children should not exceed parent's KE
    const KEp = BigInt(parent.vx) * BigInt(parent.vx) + BigInt(parent.vy) * BigInt(parent.vy)
    const KEc = BigInt(v1x) * BigInt(v1x) + BigInt(v1y) * BigInt(v1y) +
                BigInt(v2x) * BigInt(v2x) + BigInt(v2y) * BigInt(v2y)
    if (KEc > KEp && KEc > 0n) {
      // scale = sqrt(KEp / KEc) → scale² = KEp / KEc
      // Multiply each velocity by scale: v' = v * isqrt(KEp * SCALE²) / isqrt(KEc * SCALE²)
      // Simpler: v' = v * isqrt(KEp) / isqrt(KEc)
      const sqrtP = isqrt(KEp)
      const sqrtC = isqrt(KEc)
      if (sqrtC > 0n) {
        v1x = Number((BigInt(v1x) * sqrtP) / sqrtC)
        v1y = Number((BigInt(v1y) * sqrtP) / sqrtC)
        v2x = Number((BigInt(v2x) * sqrtP) / sqrtC)
        v2y = Number((BigInt(v2y) * sqrtP) / sqrtC)
      }
    }

    // Build children
    const pr1 = parent.prng.derive('splitA:' + parent.gen)
    const pr2 = parent.prng.derive('splitB:' + parent.gen)

    // Inherit skill with tether defense penalty
    const tetherResOnSplitMul = toCoef(0.9)
    const tetherResFloorMul = toCoef(0.7)
    const decayedDef = (parent.skill.tetherDefMul * tetherResOnSplitMul) >> FP_COEF_SHIFT_N
    const floorDef = (parent.skill.tetherDefMul * tetherResFloorMul) >> FP_COEF_SHIFT_N
    const childSkill: SkillV2 = {
      splitAggroMul: parent.skill.splitAggroMul,
      tetherResMul: parent.skill.tetherResMul,
      tetherDefMul: decayedDef > floorDef ? decayedDef : floorDef,
      powerMul: parent.skill.powerMul,
      accelMul: parent.skill.accelMul,
    }

    const childCommon = {
      color: parent.color,
      owner: parent.owner,
      trait: parent.trait,
      gen: parent.gen + 1,
      splitCooldown: cfg.cooldownFrames,
      radius: rChild,
      hadTether: false,
      justCollided: false,
      skill: childSkill,
    }

    const c1: OrbV2 = { x: x1, y: y1, vx: v1x, vy: v1y, prng: pr1, ...childCommon }
    const c2: OrbV2 = { x: x2, y: y2, vx: v2x, vy: v2y, prng: pr2, ...childCommon }

    state.tethers[ps.idx] = []
    state.orbs[ps.idx] = c1
    state.orbs.push(c2)
    state.tethers.push([])

    // Visual flash
    const life = 36
    state.flashes.push({ x: parent.x, y: parent.y, color: parent.color, life, maxLife: life })

    // Shock event
    if (cfg.shockEnabled && cfg.shockTriggerOnSplit) {
      outEvents.push({
        type: 'shock',
        x: parent.x, y: parent.y,
        strength: 1,
        color: parent.color,
        kind: 'split',
      })
    }
  }
}
