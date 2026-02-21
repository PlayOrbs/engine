import { EngineState, EngineConfig } from './types.js'
import { DRAMA_DEFAULTS } from './drama.js'

function easeOutCubic(x: number) { return 1 - Math.pow(1 - x, 3) }

function distToSegSq(px:number, py:number, x1:number, y1:number, x2:number, y2:number) {
  const vx = x2 - x1, vy = y2 - y1
  const wx = px - x1, wy = py - y1
  const c2 = vx*vx + vy*vy
  let t = 0
  if (c2 > 0) {
    const c1 = vx*wx + vy*wy
    t = Math.max(0, Math.min(1, c1 / c2))
  }
  const cx = x1 + t * vx, cy = y1 + t * vy
  const dx = px - cx, dy = py - cy
  return { d2: dx*dx + dy*dy, t }
}

export function processTethers(state: EngineState, cfg: EngineConfig): any[] {
  const r2 = cfg.orbs.radius * cfg.orbs.radius
  const toDelete: Array<Set<number>> = state.tethers.map(() => new Set())
  const events: any[] = []

  // Early-game immunity: no tether breaks for first N frames
  const immunityFrames = cfg.tethers?.immunityFrames ?? 0
  if (immunityFrames > 0 && state.frame < immunityFrames) {
    return events // no tether processing during immunity period
  }

  // Speed gate: require minimum orb speed to break tether via direct contact.
  // Keeps early-round eliminations slower; shockwaves bypass this gate.
  const breakSpeedMin = cfg.tethers?.breakSpeedMin ?? 0
  const breakSpeedMin2 = breakSpeedMin > 0 ? breakSpeedMin * breakSpeedMin : 0

  for (let i = 0; i < state.orbs.length; i++) {
    const oi = state.orbs[i]
    for (let owner = 0; owner < state.tethers.length; owner++) {
      const list = state.tethers[owner]
      const ownerOrb = state.orbs[owner]
      if (!list || !ownerOrb) continue
      for (let idx = 0; idx < list.length; idx++) {
        const t = list[idx]
        if (t.protect > 0) continue
        const { d2, t: segT } = distToSegSq(oi.x, oi.y, t.anchorX, t.anchorY, ownerOrb.x, ownerOrb.y)
        if (owner === i && segT > 0.95) continue
        if (d2 <= r2 && segT >= 0 && segT <= 1) {
          // Same-owner immunity: orbs from the same player cannot delete their own owner's tethers
          const sameOwner = !!( (oi as any).owner && (ownerOrb as any).owner &&
            (oi as any).owner.length === (ownerOrb as any).owner.length &&
            (oi as any).owner.every((v:number, k:number) => v === (ownerOrb as any).owner[k]) )
          if (sameOwner) continue

          // Speed gate check: orb must be moving fast enough to break tether.
          // tetherDefMul: Defensive stat on tether OWNER – higher values raise the
          // threshold, making the owner's tethers harder to break.
          if (breakSpeedMin2 > 0) {
            const v2 = oi.vx * oi.vx + oi.vy * oi.vy
            const breakSpeedMinEff = breakSpeedMin * ownerOrb.skill.tetherDefMul
            const thr2 = breakSpeedMinEff * breakSpeedMinEff
            if (v2 < thr2) continue // too slow, skip this tether break
          }

          // Dampen the collider orb's speed a bit on tether hit
          // Disable damping once sudden death starts
          const suddenDeathStart = cfg.suddenDeath?.afterFrames ?? Infinity
          if (state.frame < suddenDeathStart) {
            let damp = Math.max(0, Math.min(1, (cfg.tethers?.hitDamping ?? 0)))
            if (damp > 0) {
              const factor = 1 - damp
              oi.vx *= factor
              oi.vy *= factor
            }
          }
          toDelete[owner].add(idx)
          // owner: victim orb index, attacker: collider orb index
          events.push({ type: 'tether_destroyed', owner, attacker: i })
        }
      }
    }
  }

  for (let owner = 0; owner < state.tethers.length; owner++) {
    const del = toDelete[owner]
    if (del.size === 0) continue
    state.tethers[owner] = state.tethers[owner].filter((_, idx) => !del.has(idx))
  }

  for (let owner = 0; owner < state.tethers.length; owner++) {
    const list = state.tethers[owner]
    if (!list) continue
    for (let i = 0; i < list.length; i++) {
      if (list[i].protect > 0) list[i].protect = 0
    }
  }
  return events
}
