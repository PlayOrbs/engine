// ─── Fixed-Point Tether Processing (V2) ───
//
// Geometry (distToSegSq) uses FP_POS.
// Speed gate uses FP_VEL.
// Hit damping uses FP_COEF applied to FP_VEL.

import type { EngineStateV2, V2ConfigFp } from './types_v2.js'
import { FP_COEF, FP_COEF_SHIFT_N, FP_POS_SHIFT_N, VEL_EXTRA_N } from '../../utils/v2/fpmath.js'

// ─── distToSegSq in FP_POS ───
// Returns d² in FP_POS² (bigint) and t_fp in FP_POS (number).

function distToSegSqFp(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { d2: bigint; t: number } {
  const vx = x2 - x1, vy = y2 - y1
  const wx = px - x1, wy = py - y1
  const c2 = BigInt(vx) * BigInt(vx) + BigInt(vy) * BigInt(vy) // FP_POS²
  let t_fp = 0

  if (c2 > 0n) {
    const c1 = BigInt(vx) * BigInt(wx) + BigInt(vy) * BigInt(wy) // FP_POS²
    // t = clamp(c1/c2, 0, 1) in FP_POS
    if (c1 <= 0n) {
      t_fp = 0
    } else if (c1 >= c2) {
      t_fp = 1048576 // FP_POS = 1.0
    } else {
      t_fp = Number((c1 << FP_POS_SHIFT_N) / c2)
    }
  }

  // Closest point on segment
  const cx = x1 + Number((BigInt(t_fp) * BigInt(vx)) >> FP_POS_SHIFT_N)
  const cy = y1 + Number((BigInt(t_fp) * BigInt(vy)) >> FP_POS_SHIFT_N)
  const dx = px - cx, dy = py - cy
  const d2 = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy) // FP_POS²

  return { d2, t: t_fp }
}

// FP_POS value for 0.95 threshold (used for self-tether skip)
const SELF_TETHER_T = Math.round(0.95 * 1048576) // 996_147

export function processTethersV2(state: EngineStateV2, cfg: V2ConfigFp): any[] {
  const r2 = BigInt(cfg.orbRadius) * BigInt(cfg.orbRadius) // FP_POS²
  const toDelete: Array<Set<number>> = state.tethers.map(() => new Set())
  const events: any[] = []

  // Early-game immunity
  if (cfg.immunityFrames > 0 && state.frame < cfg.immunityFrames) {
    return events
  }

  // Speed gate: breakSpeedMin converted to FP_VEL, then squared
  const hasBsm = cfg.breakSpeedMin > 0

  // Hit damping factor: (1 - hitDamping) as FP_COEF
  const dampFactor = FP_COEF - cfg.hitDamping

  // Sudden death start frame
  const sdStart = cfg.sdEnabled ? cfg.sdAfterFrames : Infinity

  for (let i = 0; i < state.orbs.length; i++) {
    const oi = state.orbs[i]
    for (let owner = 0; owner < state.tethers.length; owner++) {
      const list = state.tethers[owner]
      const ownerOrb = state.orbs[owner]
      if (!list || !ownerOrb) continue
      for (let idx = 0; idx < list.length; idx++) {
        const t = list[idx]
        if (t.protect > 0) continue

        const { d2, t: segT } = distToSegSqFp(
          oi.x, oi.y,
          t.anchorX, t.anchorY,
          ownerOrb.x, ownerOrb.y,
        )

        // Self-tether skip: if this orb IS the owner and segT > 0.95
        if (owner === i && segT > SELF_TETHER_T) continue

        // Hit check: d² <= r² and segT in [0, FP_POS]
        if (d2 <= r2 && segT >= 0 && segT <= 1048576) {
          // Same-owner immunity
          const sameOwner = !!(
            oi.owner && ownerOrb.owner &&
            oi.owner.length === ownerOrb.owner.length &&
            oi.owner.every((v: number, k: number) => v === ownerOrb.owner[k])
          )
          if (sameOwner) continue

          // Speed gate: v² >= (breakSpeedMin * tetherDefMul)²
          if (hasBsm) {
            const v2 = BigInt(oi.vx) * BigInt(oi.vx) + BigInt(oi.vy) * BigInt(oi.vy) // FP_VEL²
            // breakSpeedMin is FP_POS → convert to FP_VEL via * 1024n, then apply tetherDefMul
            const bsmBaseVel = BigInt(cfg.breakSpeedMin) * VEL_EXTRA_N
            const bsmEffVel = (bsmBaseVel * ownerOrb.skill.tetherDefMul) >> FP_COEF_SHIFT_N
            const thr2 = bsmEffVel * bsmEffVel // FP_VEL²
            if (v2 < thr2) continue
          }

          // Hit damping (disabled during sudden death)
          if (state.frame < sdStart && cfg.hitDamping > 0n) {
            oi.vx = Number((BigInt(oi.vx) * dampFactor) >> FP_COEF_SHIFT_N)
            oi.vy = Number((BigInt(oi.vy) * dampFactor) >> FP_COEF_SHIFT_N)
          }

          toDelete[owner].add(idx)
          events.push({ type: 'tether_destroyed', owner, attacker: i })
        }
      }
    }
  }

  // Delete marked tethers
  for (let owner = 0; owner < state.tethers.length; owner++) {
    const del = toDelete[owner]
    if (del.size === 0) continue
    state.tethers[owner] = state.tethers[owner].filter((_, idx) => !del.has(idx))
  }

  // Clear protect flags
  for (let owner = 0; owner < state.tethers.length; owner++) {
    const list = state.tethers[owner]
    if (!list) continue
    for (let i = 0; i < list.length; i++) {
      if (list[i].protect > 0) list[i].protect = 0
    }
  }

  return events
}
