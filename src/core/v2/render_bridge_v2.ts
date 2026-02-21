// ─── Render Bridge: V2 fixed-point → V1 float EngineState ───
//
// Converts EngineStateV2 (FP_POS/FP_VEL/FP_COEF) into a V1-shaped EngineState
// that the renderer, leaderboard, and all UI can consume unchanged.
//
// Performance: mutates `out` in-place when provided to avoid allocations at 120hz.

import type { EngineState, Orb, Tether, Flash, Skill, Trait } from '../v1/types.js'
import type { EngineStateV2, V2ConfigFp, OrbV2, TetherV2, FlashV2, ShockwaveV2 } from './types_v2.js'
import { fromPos, fromVel } from '../../utils/v2/fpmath.js'

const FP_COEF_F = 1099511627776 // Number(1n << 40n)

function coefToFloat(c: bigint): number {
  return Number(c) / FP_COEF_F
}

function projectOrb(src: OrbV2, dst: Orb | undefined): Orb {
  const x = fromPos(src.x)
  const y = fromPos(src.y)
  const vx = fromVel(src.vx)
  const vy = fromVel(src.vy)
  const radius = fromPos(src.radius)

  const skill: Skill = {
    splitAggroMul: coefToFloat(src.skill.splitAggroMul),
    tetherResMul: coefToFloat(src.skill.tetherResMul),
    tetherDefMul: coefToFloat(src.skill.tetherDefMul),
    powerMul: coefToFloat(src.skill.powerMul),
  }

  const trait: Trait = {
    name: src.trait.name,
    restMul: coefToFloat(src.trait.restMul),
    tanKickMul: coefToFloat(src.trait.tanKickMul),
    minSpeedMul: coefToFloat(src.trait.minSpeedMul),
    jitterMul: coefToFloat(src.trait.jitterMul),
    gravityMul: coefToFloat(src.trait.gravityMul),
  }

  if (dst) {
    dst.x = x; dst.y = y; dst.vx = vx; dst.vy = vy
    dst.radius = radius
    dst.justCollided = src.justCollided
    dst.hadTether = src.hadTether
    dst.color = src.color
    dst.owner = src.owner
    dst.gen = src.gen
    dst.splitCooldown = src.splitCooldown
    dst.skill = skill
    dst.trait = trait
    // prng: renderer doesn't use it, but type requires it — keep existing ref
    return dst
  }

  return {
    x, y, vx, vy, radius,
    justCollided: src.justCollided,
    hadTether: src.hadTether,
    color: src.color,
    prng: null as any, // renderer never reads prng
    trait,
    owner: src.owner,
    gen: src.gen,
    splitCooldown: src.splitCooldown,
    skill,
  }
}

function projectTether(src: TetherV2): Tether {
  return {
    anchorX: fromPos(src.anchorX),
    anchorY: fromPos(src.anchorY),
    color: src.color,
    protect: src.protect,
  }
}

function projectFlash(src: FlashV2): Flash {
  return {
    x: fromPos(src.x),
    y: fromPos(src.y),
    color: src.color,
    life: src.life,
    maxLife: src.maxLife,
  }
}

function projectShockwave(src: ShockwaveV2): EngineState['shockwaves'][0] {
  return {
    x: fromPos(src.x),
    y: fromPos(src.y),
    r: fromPos(src.r),
    maxR: fromPos(src.maxR),
    life: src.life,
    maxLife: src.maxLife,
    color: src.color,
    thickness: fromPos(src.thickness),
    kind: src.kind,
    affectsTethers: src.affectsTethers,
  }
}

export function stateV2ToRenderState(
  st: EngineStateV2,
  _fpCfg: V2ConfigFp,
  out?: EngineState,
): EngineState {
  if (!out) {
    // First call — allocate fresh
    const orbs = st.orbs.map(o => projectOrb(o, undefined))
    const tethers = st.tethers.map(list => list.map(projectTether))
    const flashes = st.flashes.map(projectFlash)
    const shockwaves = st.shockwaves.map(projectShockwave)

    return {
      frame: st.frame,
      orbs,
      tethers,
      flashes,
      shockwaves,
      scores: st.scores,
      twoOrbsStartFrame: st.twoOrbsStartFrame,
      econ: st.econ,
    }
  }

  // Mutate in-place for perf
  out.frame = st.frame

  // Orbs — resize and update in-place
  const orbCount = st.orbs.length
  if (out.orbs.length > orbCount) out.orbs.length = orbCount
  for (let i = 0; i < orbCount; i++) {
    out.orbs[i] = projectOrb(st.orbs[i], out.orbs[i])
  }

  // Tethers — resize outer array, rebuild inner arrays (tethers change frequently)
  const tetherCount = st.tethers.length
  if (out.tethers.length > tetherCount) out.tethers.length = tetherCount
  for (let i = 0; i < tetherCount; i++) {
    out.tethers[i] = st.tethers[i].map(projectTether)
  }

  // Flashes — rebuild (short-lived, small count)
  out.flashes = st.flashes.map(projectFlash)

  // Shockwaves — rebuild (short-lived, small count)
  out.shockwaves = st.shockwaves.map(projectShockwave)

  // Shared by reference (no conversion needed)
  out.scores = st.scores
  out.twoOrbsStartFrame = st.twoOrbsStartFrame
  out.econ = st.econ

  return out
}
