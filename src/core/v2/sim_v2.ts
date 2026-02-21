// ─── Fixed-Point Simulation V2 ───
//
// initFromSeedV2: create initial state with FP positions/velocities
// advanceFrameV2: one frame of physics + tethers + shockwaves + economics

import type { Player, Trait, PRNG, InitOpts, Skill } from '../v1/types.js'
import type { GameConfig } from '../../config/gameConfig.js'
import type {
  EngineStateV2, V2ConfigFp, OrbV2, TetherV2, TraitV2, SkillV2,
} from './types_v2.js'
import { convertConfigToV2, convertTraitToV2, convertSkillToV2, DEFAULT_SKILL_V2 } from './types_v2.js'
import { stepFrameV2 } from './physics_v2.js'
import { processTethersV2 } from './tethers_v2.js'
import { makePRNG, sha256Concat } from '../../utils/rng.js'
import { toHex } from '../../utils/utils.js'
import { perOrbSeed } from '../../utils/seeds.js'
import { segIntersectsAnnulus } from '../../utils/engine_helpers.js'
import {
  FP_POS, FP_VEL, toPos, toVel, fromPos,
  mulPos, divPos, hypotPos, sinFp, cosFp,
  clampFp,
} from '../../utils/v2/fpmath.js'
import {
  applyScoring,
  initEconomicsFromConfig,
  applyEconomicScoring,
  finalizeIfNeeded,
} from '../../economics/scoring.js'

export { perOrbSeed }

// ─── Count unique owners ───
export function countUniqueOwnersV2(orbs: { owner: Uint8Array }[]): number {
  const seen = new Set<string>()
  for (const o of orbs) seen.add(toHex(o.owner))
  return seen.size
}

// ─── Derive trait (same logic as v1, returns V2 FP_COEF trait) ───
function deriveTraitV2(prng: PRNG): TraitV2 {
  const i = prng.nextU32() % 5
  const raw: Trait =
    i === 0 ? { name: 'aggressive', restMul: 1.02, tanKickMul: 1.25, minSpeedMul: 1.2, jitterMul: 1.1, gravityMul: 1.0 } :
    i === 1 ? { name: 'evasive',    restMul: 0.98, tanKickMul: 1.5,  minSpeedMul: 1.0, jitterMul: 1.2, gravityMul: 0.9 } :
    i === 2 ? { name: 'heavy',      restMul: 0.95, tanKickMul: 0.8,  minSpeedMul: 0.9, jitterMul: 0.8, gravityMul: 1.3 } :
    i === 3 ? { name: 'chaotic',    restMul: 1.00, tanKickMul: 1.35, minSpeedMul: 1.15, jitterMul: 1.6, gravityMul: 1.0 } :
              { name: 'precise',    restMul: 1.01, tanKickMul: 1.0,  minSpeedMul: 1.0, jitterMul: 0.6, gravityMul: 1.0 }
  return convertTraitToV2(raw)
}

// ─── Fisher-Yates shuffle ───
function fisherYatesShuffle<T>(arr: T[], prng: PRNG): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = prng.nextU32() % (i + 1)
    const temp = result[i]
    result[i] = result[j]
    result[j] = temp
  }
  return result
}

// ─── Compare owners lexicographically ───
function compareOwners(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

// ─── Ring spawn slots (FP_POS positions, FP_VEL velocities) ───
function generateRingSpawnSlotsV2(
  roundSeed: Uint8Array,
  N: number,
  cfg: V2ConfigFp,
  gcRaw: GameConfig,
): Array<{ x: number; y: number; vx: number; vy: number }> {
  const pad = toPos(cfg.spawnPad)
  const startInset = toPos(cfg.spawnStartInset)
  const ro = cfg.orbRadius
  const R = cfg.boundaryRadius
  const baseSpeed = cfg.baseSpeed // FP_VEL
  const ringGap = toPos(cfg.spawnRingGap)

  const prSpawn = makePRNG(sha256Concat(roundSeed, new TextEncoder().encode('spawn')))
  const prOrder = prSpawn.derive('order')
  const prK = prSpawn.derive('K')
  const prJitter = prSpawn.derive('jitter')

  // Global rotation as angle index (0..4095)
  const phi0Idx = (prSpawn.nextU32() >>> 0) % 4096

  // Build rings
  type RingInfo = { radius: number; slots: number; dThetaIdx: number }
  const allRings: RingInfo[] = []
  const r0 = R - startInset - ro
  let k = 0

  while (true) {
    const rk = r0 - k * ringGap
    if (rk < ro + toPos(8)) break

    // Chord-based minimum angular separation
    // dTheta = 2 * asin(chordLen / (2 * rk))
    // chordLen = 2*ro + pad (all FP_POS)
    const chordLen = 2 * ro + pad
    // Convert to float for asin, then back to angle index
    const chordFloat = fromPos(chordLen)
    const rkFloat = fromPos(rk)
    const dThetaRad = 2 * Math.asin(Math.min(1, chordFloat / (2 * rkFloat)))
    const dThetaIdx = Math.max(1, Math.round((dThetaRad / (2 * Math.PI)) * 4096))

    // Slot capacity with safety margin
    const slots = Math.max(1, Math.ceil(4096 / (dThetaIdx * 1.03)))
    allRings.push({ radius: rk, slots, dThetaIdx })
    k++
  }

  if (allRings.length === 0) {
    return Array.from({ length: N }, () => ({ x: cfg.cx, y: cfg.cy, vx: 0, vy: 0 }))
  }

  const K = Math.min(
    allRings.length,
    Math.max(cfg.spawnRingsMin, cfg.spawnRingsMin + (prK.nextU32() % (cfg.spawnRingsMax - cfg.spawnRingsMin + 1)))
  )
  const rings = allRings.slice(0, K)

  let totalSlots = rings.reduce((sum, r) => sum + r.slots, 0)
  if (totalSlots < N) {
    for (let i = K; i < allRings.length && totalSlots < N; i++) {
      rings.push(allRings[i])
      totalSlots += allRings[i].slots
    }
  }

  const playerOrder = Array.from({ length: N }, (_, i) => i)
  const permutedOrder = fisherYatesShuffle(playerOrder, prOrder)

  type Assignment = { playerIdx: number; ringIdx: number; slotIdx: number }
  const assignments: Assignment[] = []
  const ringCounts = new Array(rings.length).fill(0)

  for (let i = 0; i < N; i++) {
    const playerIdx = permutedOrder[i]
    const ringIdx = i % rings.length
    if (ringCounts[ringIdx] < rings[ringIdx].slots) {
      assignments.push({ playerIdx, ringIdx, slotIdx: ringCounts[ringIdx] })
      ringCounts[ringIdx]++
    } else {
      for (let j = 0; j < rings.length; j++) {
        const tryRing = (ringIdx + j) % rings.length
        if (ringCounts[tryRing] < rings[tryRing].slots) {
          assignments.push({ playerIdx, ringIdx: tryRing, slotIdx: ringCounts[tryRing] })
          ringCounts[tryRing]++
          break
        }
      }
    }
  }

  const result: Array<{ x: number; y: number; vx: number; vy: number }> = []

  for (const assign of assignments) {
    const ring = rings[assign.ringIdx]
    const dThetaIdx = Math.floor(4096 / ring.slots)
    let thetaIdx = (phi0Idx + assign.slotIdx * dThetaIdx) & 4095
    let r = ring.radius

    if (cfg.spawnJitter) {
      const slackIdx = dThetaIdx - ring.dThetaIdx
      const maxAngJitter = Math.floor(slackIdx / 2)
      // Integer-only angular jitter: signed int32 mapped to [-maxAngJitter, maxAngJitter)
      const angRaw = (prJitter.nextU32() | 0) // int32
      const angJitter = maxAngJitter > 0 ? Number(BigInt(angRaw) * BigInt(maxAngJitter) / 2147483648n) : 0
      thetaIdx = (thetaIdx + angJitter + 4096) & 4095

      const maxRadJitter = Math.min(Math.floor(ringGap / 4), ro)
      // Integer-only radial jitter: signed int32 mapped to [-maxRadJitter, maxRadJitter) in FP_POS
      const radRaw = (prJitter.nextU32() | 0) // int32
      const radJitter = maxRadJitter > 0 ? Number(BigInt(radRaw) * BigInt(maxRadJitter) / 2147483648n) : 0
      r += radJitter
    }

    const x = cfg.cx + mulPos(r, cosFp(thetaIdx))
    const y = cfg.cy + mulPos(r, sinFp(thetaIdx))

    let vx = 0, vy = 0
    if (cfg.spawnVelocity === 'tangent') {
      // Tangent: perpendicular to radius. sin(θ+π/2) = cos(θ), cos(θ+π/2) = -sin(θ)
      const txIdx = (thetaIdx + 1024) & 4095 // θ + 90°
      // tx = -sin(θ), ty = cos(θ) → use sinFp/cosFp
      const tx = -sinFp(thetaIdx) // FP_POS
      const ty = cosFp(thetaIdx)  // FP_POS
      // vx = baseSpeed * tx (FP_VEL * FP_POS → FP_VEL, via mulVelPos)
      vx = Number((BigInt(baseSpeed) * BigInt(tx)) >> 20n)
      vy = Number((BigInt(baseSpeed) * BigInt(ty)) >> 20n)
    } else if (cfg.spawnVelocity === 'outward') {
      const nx = cosFp(thetaIdx)
      const ny = sinFp(thetaIdx)
      vx = Number((BigInt(baseSpeed) * BigInt(nx)) >> 20n)
      vy = Number((BigInt(baseSpeed) * BigInt(ny)) >> 20n)
    }

    result[assign.playerIdx] = { x, y, vx, vy }
  }

  for (let i = 0; i < N; i++) {
    if (!result[i]) result[i] = { x: cfg.cx, y: cfg.cy, vx: 0, vy: 0 }
  }

  return result
}

// ─── Resolve spawn overlaps (FP_POS) ───
function resolveSpawnOverlapsV2(orbs: OrbV2[], cfg: V2ConfigFp): void {
  if (orbs.length < 2) return

  const pad = toPos(cfg.spawnPad)
  const iterations = 12

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        const a = orbs[i], b = orbs[j]
        const minDist = a.radius + b.radius + pad
        const minDist2 = BigInt(minDist) * BigInt(minDist)

        const dx = b.x - a.x, dy = b.y - a.y
        const d2 = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)
        if (d2 >= minDist2) continue

        const axBefore = a.x, ayBefore = a.y
        const bxBefore = b.x, byBefore = b.y

        const d = Number(isqrtLocal(d2))
        const overlap = minDist - d
        const push = Math.floor(overlap / 2)

        if (d > 0) {
          const nx = divPos(dx, d)
          const ny = divPos(dy, d)
          a.x -= mulPos(nx, push); a.y -= mulPos(ny, push)
          b.x += mulPos(nx, push); b.y += mulPos(ny, push)
        } else {
          // Same position: use velocity directions
          const speedA = hypotPos(Math.floor(a.vx / 1024), Math.floor(a.vy / 1024)) // approximate in FP_POS
          const speedB = hypotPos(Math.floor(b.vx / 1024), Math.floor(b.vy / 1024))
          let dirAx = speedA > 0 ? divPos(Math.floor(a.vx / 1024), speedA) : FP_POS
          let dirAy = speedA > 0 ? divPos(Math.floor(a.vy / 1024), speedA) : 0
          let dirBx = speedB > 0 ? divPos(Math.floor(b.vx / 1024), speedB) : FP_POS
          let dirBy = speedB > 0 ? divPos(Math.floor(b.vy / 1024), speedB) : 0

          // Check if directions are effectively identical
          const dotDir = mulPos(dirAx, dirBx) + mulPos(dirAy, dirBy)
          if (dotDir > Math.round(0.9999 * FP_POS)) {
            const cmp = compareOwners(a.owner, b.owner)
            const perpx = -dirAy, perpy = dirAx
            const tiny = toPos(0.01)
            if (cmp > 0) {
              a.x += mulPos(perpx, tiny); a.y += mulPos(perpy, tiny)
              b.x -= mulPos(perpx, tiny); b.y -= mulPos(perpy, tiny)
            } else {
              a.x -= mulPos(perpx, tiny); a.y -= mulPos(perpy, tiny)
              b.x += mulPos(perpx, tiny); b.y += mulPos(perpy, tiny)
            }
          }

          a.x += mulPos(dirAx, push); a.y += mulPos(dirAy, push)
          b.x -= mulPos(dirBx, push); b.y -= mulPos(dirBy, push)
        }

        // Clamp inside boundary
        const aMoved = a.x !== axBefore || a.y !== ayBefore
        const bMoved = b.x !== bxBefore || b.y !== byBefore

        if (cfg.shape === 'circle') {
          if (aMoved) clampToCircle(a, cfg)
          if (bMoved) clampToCircle(b, cfg)
        } else {
          if (aMoved) clampToRect(a, cfg)
          if (bMoved) clampToRect(b, cfg)
        }
      }
    }
  }
}

function clampToCircle(o: OrbV2, cfg: V2ConfigFp): void {
  const dx = o.x - cfg.cx, dy = o.y - cfg.cy
  const d = hypotPos(dx, dy)
  const maxD = cfg.boundaryRadius - o.radius
  if (d > maxD && d > 0) {
    const nx = divPos(dx, d)
    const ny = divPos(dy, d)
    o.x = cfg.cx + mulPos(nx, maxD)
    o.y = cfg.cy + mulPos(ny, maxD)
  }
}

function clampToRect(o: OrbV2, cfg: V2ConfigFp): void {
  const maxX = cfg.rectHalfWidth - o.radius
  const maxY = cfg.rectHalfHeight - o.radius
  o.x = clampFp(o.x, cfg.cx - maxX, cfg.cx + maxX)
  o.y = clampFp(o.y, cfg.cy - maxY, cfg.cy + maxY)
}

// Local isqrt (avoid circular import)
function isqrtLocal(n: bigint): bigint {
  if (n < 2n) return n
  let x = n, y = (x + 1n) >> 1n
  while (y < x) { x = y; y = (x + n / x) >> 1n }
  return x
}

// ─── initFromSeedV2 ───
export function initFromSeedV2(
  roundSeed: Uint8Array,
  players: Player[],
  gcRaw: GameConfig,
  opts?: InitOpts,
): { state: EngineStateV2; cfg: V2ConfigFp } {
  const cfg = convertConfigToV2(gcRaw)

  const state: EngineStateV2 = {
    engineVersion: 2,
    frame: 0,
    orbs: [],
    tethers: [],
    flashes: [],
    shockwaves: [],
    scores: {},
  }

  const useRingSpawn = cfg.spawnMode === 'rings' && cfg.shape !== 'rect'
  let ringSlots: Array<{ x: number; y: number; vx: number; vy: number }> | undefined
  if (useRingSpawn) {
    ringSlots = generateRingSpawnSlotsV2(roundSeed, players.length, cfg, gcRaw)
  }

  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const seed = perOrbSeed(roundSeed, p)
    const master = makePRNG(seed)
    const prInit = master.derive('init')
    const prBounce = master.derive('bounce')
    const trait: TraitV2 = gcRaw.disableTraits
      ? convertTraitToV2({ name: 'precise', restMul: 1.0, tanKickMul: 1.0, minSpeedMul: 1.0, jitterMul: 1.0, gravityMul: 1.0 })
      : deriveTraitV2(master.derive('trait'))

    let x: number, y: number, vx: number, vy: number

    if (ringSlots) {
      const slot = ringSlots[i]
      x = slot.x; y = slot.y
      if (cfg.spawnVelocity === 'none') {
        const sBig = BigInt(cfg.baseSpeed) // FP_VEL as bigint
        // Integer-only: signed int32 mapped to [-s, s) via BigInt truncation
        // nextU32() | 0 coerces uint32 → signed int32 [-2^31, 2^31-1]
        // BigInt division truncates toward zero (deterministic)
        const rvx = prInit.nextU32() | 0 // signed int32
        const rvy = prInit.nextU32() | 0
        vx = Number(BigInt(rvx) * sBig / 2147483648n)
        vy = Number(BigInt(rvy) * sBig / 2147483648n)
      } else {
        vx = slot.vx; vy = slot.vy
      }
    } else {
      // Random spawn — all integer math
      // baseR = boundaryRadius * 3 / 10 (integer approximation of 0.3)
      const baseR = Math.floor(cfg.boundaryRadius * 3 / 10)
      const thetaIdx = (prInit.nextU32() >>> 0) % 4096
      // r = baseR * (0.8 + u * 0.4) → integer: baseR * (819 + (u32 % 410)) / 1024
      const rFrac = 819 + ((prInit.nextU32() >>> 0) % 410) // [819, 1228] representing [0.8, 1.2) * 1024
      const r = Math.floor((baseR * rFrac) / 1024)
      x = cfg.cx + mulPos(r, cosFp(thetaIdx))
      y = cfg.cy + mulPos(r, sinFp(thetaIdx))
      const sBig = BigInt(cfg.baseSpeed)
      const rvx = prInit.nextU32() | 0 // signed int32
      const rvy = prInit.nextU32() | 0
      vx = Number(BigInt(rvx) * sBig / 2147483648n)
      vy = Number(BigInt(rvy) * sBig / 2147483648n)
    }

    // Spawn override
    const ownerHex = toHex(p.pubkey)
    const spawnOverride = opts?.spawnByOwnerHex?.[ownerHex]
    if (spawnOverride) {
      if (spawnOverride.x !== undefined) x = toPos(spawnOverride.x)
      if (spawnOverride.y !== undefined) y = toPos(spawnOverride.y)
      if (spawnOverride.angle !== undefined && spawnOverride.speed !== undefined) {
        const angIdx = Math.round((spawnOverride.angle / (2 * Math.PI)) * 4096) & 4095
        const spd = toVel(spawnOverride.speed)
        vx = Number((BigInt(spd) * BigInt(cosFp(angIdx))) >> 20n)
        vy = Number((BigInt(spd) * BigInt(sinFp(angIdx))) >> 20n)
      }
    }

    // Skill multipliers
    const skillMulRaw = opts?.multipliersByOwnerHex?.[ownerHex]
    const skill: SkillV2 = skillMulRaw ? convertSkillToV2(skillMulRaw) : { ...DEFAULT_SKILL_V2 }

    const o: OrbV2 = {
      x, y, vx, vy,
      justCollided: false,
      hadTether: false,
      color: p.color || '#ffffff',
      prng: prBounce,
      trait,
      owner: p.pubkey,
      radius: cfg.orbRadius,
      gen: 0,
      splitCooldown: 0,
      skill,
    }
    state.orbs.push(o)
    state.tethers.push([])
  }

  resolveSpawnOverlapsV2(state.orbs, cfg)

  // Initialize economics from config (same as V1 — engine owns econ)
  if ((gcRaw as any).economicsInputs) {
    try { initEconomicsFromConfig(state as any, gcRaw as any) } catch (err) {
      console.warn('[sim_v2] initEconomicsFromConfig failed:', err)
    }
  }

  return { state, cfg }
}

// ─── advanceFrameV2 (physics + tethers + economics) ───
export function advanceFrameV2(state: EngineStateV2, cfg: V2ConfigFp): { state: EngineStateV2; events: any[] } {
  const { state: st, events } = stepFrameV2(state, cfg)

  // Shockwave config
  const lifeFrames = cfg.shockLifeFrames || 30
  const maxRadius = cfg.shockMaxRadius || cfg.boundaryRadius
  const thickness = cfg.shockThickness || toPos(20)

  // Handle events
  for (const e of events) {
    if (e.type === 'boundary_hit') {
      const idx = e.orbIndex
      const color = st.orbs[idx].color
      st.tethers[idx].push({ anchorX: e.anchorX, anchorY: e.anchorY, color, protect: 1 })
      st.orbs[idx].hadTether = true
    } else if (e.type === 'shock') {
      const life = Math.max(1, lifeFrames)
      const kind = e.kind ?? 'split'
      const affectsTethers = kind === 'split' ? true : cfg.shockImpactCutsTethers
      st.shockwaves.push({
        x: e.x, y: e.y,
        r: 0,
        maxR: Math.max(1, maxRadius),
        life, maxLife: life,
        color: e.color ?? '#ffffff',
        thickness,
        kind,
        affectsTethers,
      })
    }
  }

  // Owners list BEFORE prune (full hex ids)
  const ownersBefore = st.orbs.map(o => toHex(o.owner))

  // Tether processing
  const tetherEvents = processTethersV2(st, cfg)
  const frameEvents = [...events, ...tetherEvents]

  // Economics: scoring → prune → economic scoring → TP → finalize
  applyScoring(st as any, frameEvents)
  pruneEliminatedV2(st)
  const ownersAfter = st.orbs.map(o => toHex(o.owner))

  let tpEvents: ReturnType<typeof applyEconomicScoring> = []
  if ((st as any).econ) {
    try { tpEvents = applyEconomicScoring(st as any, frameEvents, ownersBefore, ownersAfter) } catch (err) {
      console.warn('[sim_v2] applyEconomicScoring failed:', err)
    }
  }

  // Handle TP trigger events: remove orbs that cashed out
  if (tpEvents.length > 0) {
    const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
    const remainingOrbs: OrbV2[] = []
    const remainingTethers: TetherV2[][] = []
    for (let i = 0; i < st.orbs.length; i++) {
      if (!tpOrbIndices.has(i)) {
        remainingOrbs.push(st.orbs[i])
        remainingTethers.push(st.tethers[i])
      }
    }
    st.orbs = remainingOrbs
    st.tethers = remainingTethers

    const ownersPostTP = st.orbs.map(o => toHex(o.owner))
    finalizeIfNeeded(st as any, ownersPostTP)
  }

  // Animate shockwaves and cut tethers
  if (st.shockwaves.length) {
    const next: typeof st.shockwaves = []
    for (let wi = 0; wi < st.shockwaves.length; wi++) {
      const w = st.shockwaves[wi]
      w.life -= 1
      // t = 1 - life/maxLife → progress in FP_POS
      const progress = w.maxLife > 0 ? Math.floor(((w.maxLife - w.life) * w.maxR) / w.maxLife) : w.maxR
      w.r = progress

      if (w.affectsTethers) {
        const halfThick = Math.floor(w.thickness / 2)
        const rIn = Math.max(0, w.r - halfThick)
        const rOut = w.r + halfThick
        // All in FP_POS — use float conversion for segIntersectsAnnulus (shared v1 helper)
        const rInF = fromPos(rIn), rOutF = fromPos(rOut)
        const wxF = fromPos(w.x), wyF = fromPos(w.y)

        for (let oi = 0; oi < st.tethers.length; oi++) {
          const list = st.tethers[oi]
          if (!list || !list.length) continue
          const orb = st.orbs[oi]
          let write = 0
          for (let ti = 0; ti < list.length; ti++) {
            const th = list[ti]
            if (cfg.shockRespectProtect && th.protect > 0) { list[write++] = th; continue }
            const hit = cfg.shockCutMode === 'anchor'
              ? (() => {
                  const dx = th.anchorX - w.x, dy = th.anchorY - w.y
                  const d2 = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)
                  const rIn2 = BigInt(rIn) * BigInt(rIn)
                  const rOut2 = BigInt(rOut) * BigInt(rOut)
                  return d2 >= rIn2 && d2 <= rOut2
                })()
              : segIntersectsAnnulus(
                  wxF, wyF, rInF, rOutF,
                  fromPos(th.anchorX), fromPos(th.anchorY),
                  fromPos(orb.x), fromPos(orb.y),
                )
            if (!hit) list[write++] = th
          }
          if (write !== list.length) list.length = write
          if (list.length === 0) st.orbs[oi].hadTether = false
        }
      }

      if (w.life > 0) next.push(w)
    }
    st.shockwaves = next
  }

  return { state: st, events: frameEvents }
}

// ─── Prune eliminated orbs ───
export function pruneEliminatedV2(state: EngineStateV2): void {
  const keep: boolean[] = []
  for (let i = 0; i < state.orbs.length; i++) {
    const o = state.orbs[i]
    const hasTethers = state.tethers[i] && state.tethers[i].length > 0
    keep.push(!o.hadTether || hasTethers)
  }

  const newOrbs: OrbV2[] = []
  const newTethers: TetherV2[][] = []
  for (let i = 0; i < state.orbs.length; i++) {
    if (keep[i]) {
      newOrbs.push(state.orbs[i])
      newTethers.push(state.tethers[i])
    }
  }
  state.orbs = newOrbs
  state.tethers = newTethers
}

// ─── Replay V2 ───
export function replayV2(
  roundSeed: Uint8Array,
  players: Player[],
  _transcript: any[],
  maxFrames: number,
  gcRaw: GameConfig,
): { state: EngineStateV2 } {
  const { state, cfg } = initFromSeedV2(roundSeed, players, gcRaw)
  let frames = 0
  while (frames < maxFrames && countUniqueOwnersV2(state.orbs) > 1) {
    advanceFrameV2(state, cfg) // returns { state, events } but we only need state mutation
    frames++
  }
  return { state }
}
