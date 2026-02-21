// ─── Fixed-Point Drama Multipliers (V2) ───
//
// All outputs are FP_COEF bigints. Easing is computed in BigInt arithmetic.
// Called once per frame (not per orb), so BigInt cost is negligible.

import { FP_COEF, FP_COEF_SHIFT_N } from './fpmath.js'
import type { EasingType } from '../../core/v1/drama.js'
import type { V2ConfigFp } from '../../core/v2/types_v2.js'

export type DramaMultipliersV2 = {
  shrink: bigint    // FP_COEF — boundary radius multiplier (1.0 = no shrink)
  restMul: bigint   // FP_COEF — restitution multiplier
  gravMul: bigint   // FP_COEF — gravity multiplier
  jitterMul: bigint // FP_COEF — jitter multiplier
}

// ─── Easing functions in FP_COEF ───
// Input t: bigint in [0, FP_COEF] representing [0, 1]
// Output: bigint in [0, FP_COEF]

function linearFp(t: bigint): bigint {
  return t
}

function easeInQuadFp(t: bigint): bigint {
  // t² / FP_COEF
  return (t * t) / FP_COEF
}

function easeOutCubicFp(t: bigint): bigint {
  // 1 - (1-t)³
  const inv = FP_COEF - t
  const inv3 = (inv * inv * inv) / (FP_COEF * FP_COEF)
  return FP_COEF - inv3
}

function getEasingFp(type: EasingType): (t: bigint) => bigint {
  switch (type) {
    case 'linear': return linearFp
    case 'easeInQuad': return easeInQuadFp
    case 'easeOutCubic': return easeOutCubicFp
    default: return easeOutCubicFp
  }
}

export function dramaMultipliersV2(frame: number, cfg: V2ConfigFp): DramaMultipliersV2 {
  const targetFrames = cfg.dramaTargetFrames
  if (targetFrames <= 0) {
    return { shrink: FP_COEF, restMul: FP_COEF, gravMul: FP_COEF, jitterMul: FP_COEF }
  }

  const ease = getEasingFp(cfg.dramaEasing)

  // t = min(1, frame / targetFrames) in FP_COEF
  const t = frame >= targetFrames
    ? FP_COEF
    : (BigInt(frame) * FP_COEF) / BigInt(targetFrames)

  // ─── Shrink ───
  // p = max(0, (t - shrinkStart) / (1 - shrinkStart))
  // shrink = 1 - (1 - shrinkTo) * easeOutCubic(p)
  let shrink = FP_COEF
  if (t > cfg.dramaShrinkStart) {
    const denom = FP_COEF - cfg.dramaShrinkStart
    const p = denom > 0n
      ? ((t - cfg.dramaShrinkStart) * FP_COEF) / denom
      : FP_COEF
    const pEased = easeOutCubicFp(p) // always easeOutCubic for shrink (matches v1)
    const shrinkRange = FP_COEF - cfg.dramaShrinkTo // (1 - shrinkTo) in FP_COEF
    shrink = FP_COEF - (shrinkRange * pEased) / FP_COEF
  }

  // ─── Restitution multiplier ───
  // restMul = 1 - (1 - restitutionMulEnd) * t
  // = FP_COEF - (FP_COEF - restMulEnd) * t / FP_COEF
  const restRange = FP_COEF - cfg.dramaRestMulEnd
  const restMul = FP_COEF - (restRange * t) / FP_COEF

  // ─── Gravity multiplier ───
  // gravMul = 1 + (gravityMulEnd - 1) * ease(t)
  const gravRange = cfg.dramaGravMulEnd - FP_COEF // (gravMulEnd - 1) in FP_COEF
  const tEased = ease(t)
  const gravMul = FP_COEF + (gravRange * tEased) / FP_COEF

  // ─── Jitter multiplier ───
  // jitterMul = 1 + (jitterMulEnd - 1) * ease(t)
  const jitRange = cfg.dramaJitterMulEnd - FP_COEF
  const jitterMul = FP_COEF + (jitRange * tEased) / FP_COEF

  return { shrink, restMul, gravMul, jitterMul }
}
