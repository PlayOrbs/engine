import { EngineConfig, EngineState, Player, Tether, Trait, PRNG, InitOpts, Skill } from './types.js'
import { makePRNG, sha256Concat } from '../../utils/rng.js'
import { stepFrame as physicsStep } from './physics.js'
import { processTethers } from './tethers.js'
import { applyScoring, initEconomicsFromConfig, applyEconomicScoring, finalizeIfNeeded } from '../../economics/scoring.js'
import { detSin, detCos } from './determinism.js'
import { applyBoundaryTethers, pruneEliminated, segIntersectsAnnulus } from '../../utils/engine_helpers.js'
import { toHex } from '../../utils/utils.js'
import { perOrbSeed, synthesizeBotPlayers } from '../../utils/seeds.js'

export { perOrbSeed, synthesizeBotPlayers }

/** Count unique player owners from orbs array */
export function countUniqueOwners(orbs: { owner: Uint8Array }[]): number {
  const seen = new Set<string>()
  for (const o of orbs) {
    seen.add(toHex(o.owner))
  }
  return seen.size
}

export function synthesizePlayers(roundSeed: Uint8Array, count: number, colors: string[]): Player[] {
  const out: Player[] = []
  const tagPub = new Uint8Array([112, 117, 98]) // 'pub'
  const tagNnc = new Uint8Array([110, 110, 99]) // 'nnc'
  for (let i = 0; i < count; i++) {
    const idx = new Uint8Array([i & 0xff])
    const pubkey = sha256Concat(roundSeed, tagPub, idx)
    const joinNonce = sha256Concat(roundSeed, tagNnc, idx)
    // Derive color from pubkey (deterministic per player identity)
    const color = (()=>{
      let h = 0
      for (let j = 0; j < Math.min(pubkey.length, 8); j++) {
        h = ((h << 5) - h + pubkey[j]) | 0
      }
      const hue = ((h % 360) + 360) % 360
      return `hsl(${hue}, 70%, 60%)`
    })()
    out.push({ pubkey, joinNonce, color })
  }
  return out
}

/**
 * Compare two Uint8Array owners lexicographically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareOwners(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * Resolve spawn overlaps deterministically without RNG.
 * Called after all orbs are created with their spawn overrides applied.
 */
function resolveSpawnOverlaps(orbs: import('./types.js').Orb[], cfg: EngineConfig): void {
  if (orbs.length < 2) return

  const pad = cfg.orbs.spawn?.pad ?? 0
  const eps = 1e-9
  const iterations = 12
  const cx = cfg.canvas.width / 2
  const cy = cfg.canvas.height / 2
  const shape = cfg.boundary.shape || 'circle'
  const R = cfg.boundary.radius
  const RX = cfg.boundary.rectHalfWidth ?? R
  const RY = cfg.boundary.rectHalfHeight ?? R

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        const a = orbs[i]
        const b = orbs[j]
        const minDist = a.radius + b.radius + pad
        const minDist2 = minDist * minDist

        const dx = b.x - a.x
        const dy = b.y - a.y
        const d2 = dx * dx + dy * dy

        // No overlap: skip entirely
        if (d2 >= minDist2) continue

        // Track positions before push to know if clamping is needed
        const axBefore = a.x, ayBefore = a.y
        const bxBefore = b.x, byBefore = b.y

        const d = Math.sqrt(d2)
        const overlap = minDist - d
        const push = overlap / 2

        if (d2 > eps) {
          // Push along normalized (dx, dy)
          const nx = dx / d
          const ny = dy / d
          a.x -= nx * push
          a.y -= ny * push
          b.x += nx * push
          b.y += ny * push
        } else {
          // Same position: use velocity directions
          const speedA = Math.sqrt(a.vx * a.vx + a.vy * a.vy)
          const speedB = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
          let dirAx = speedA > eps ? a.vx / speedA : 1
          let dirAy = speedA > eps ? a.vy / speedA : 0
          let dirBx = speedB > eps ? b.vx / speedB : 1
          let dirBy = speedB > eps ? b.vy / speedB : 0

          // Check if directions are effectively identical
          const dotDir = dirAx * dirBx + dirAy * dirBy
          if (dotDir > 0.9999) {
            // Apply perpendicular nudge based on owner ordering
            const cmp = compareOwners(a.owner, b.owner)
            const perpx = -dirAy
            const perpy = dirAx
            const tiny = 0.01
            if (cmp > 0) {
              // a is "bigger" pubkey
              a.x += perpx * tiny
              a.y += perpy * tiny
              b.x -= perpx * tiny
              b.y -= perpy * tiny
            } else {
              a.x -= perpx * tiny
              a.y -= perpy * tiny
              b.x += perpx * tiny
              b.y += perpy * tiny
            }
          }

          // Move each orb along its own direction
          a.x += dirAx * push
          a.y += dirAy * push
          b.x -= dirBx * push
          b.y -= dirBy * push
        }

        // Only clamp orbs that were actually moved
        const aMoved = a.x !== axBefore || a.y !== ayBefore
        const bMoved = b.x !== bxBefore || b.y !== byBefore

        if (shape === 'circle') {
          if (aMoved) {
            const odx = a.x - cx
            const ody = a.y - cy
            const od = Math.sqrt(odx * odx + ody * ody)
            const maxD = R - a.radius
            if (od > maxD && od > eps) {
              a.x = cx + (odx / od) * maxD
              a.y = cy + (ody / od) * maxD
            }
          }
          if (bMoved) {
            const odx = b.x - cx
            const ody = b.y - cy
            const od = Math.sqrt(odx * odx + ody * ody)
            const maxD = R - b.radius
            if (od > maxD && od > eps) {
              b.x = cx + (odx / od) * maxD
              b.y = cy + (ody / od) * maxD
            }
          }
        } else {
          if (aMoved) {
            const maxX = RX - a.radius
            const maxY = RY - a.radius
            a.x = Math.max(cx - maxX, Math.min(cx + maxX, a.x))
            a.y = Math.max(cy - maxY, Math.min(cy + maxY, a.y))
          }
          if (bMoved) {
            const maxX = RX - b.radius
            const maxY = RY - b.radius
            b.x = Math.max(cx - maxX, Math.min(cx + maxX, b.x))
            b.y = Math.max(cy - maxY, Math.min(cy + maxY, b.y))
          }
        }
      }
    }
  }
}

function deriveTrait(prng: PRNG): Trait {
  const i = prng.nextU32() % 5
  if (i === 0) return { name: 'aggressive', restMul: 1.02, tanKickMul: 1.25, minSpeedMul: 1.2, jitterMul: 1.1, gravityMul: 1.0 }
  if (i === 1) return { name: 'evasive',    restMul: 0.98, tanKickMul: 1.5,  minSpeedMul: 1.0, jitterMul: 1.2, gravityMul: 0.9 }
  if (i === 2) return { name: 'heavy',      restMul: 0.95, tanKickMul: 0.8,  minSpeedMul: 0.9, jitterMul: 0.8, gravityMul: 1.3 }
  if (i === 3) return { name: 'chaotic',    restMul: 1.00, tanKickMul: 1.35, minSpeedMul: 1.15, jitterMul: 1.6, gravityMul: 1.0 }
  return               { name: 'precise',    restMul: 1.01, tanKickMul: 1.0,  minSpeedMul: 1.0, jitterMul: 0.6, gravityMul: 1.0 }
}

/**
 * Fisher-Yates shuffle using deterministic PRNG
 * Returns a shuffled copy of the input array
 */
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

/**
 * Generate deterministic ring spawn slots based ONLY on round seed and player count N.
 * Uses chord-based geometric spacing for accurate no-overlap placement.
 * No player-specific data (pubkeys, join order) affects slot geometry.
 *
 * @param roundSeed - Round seed for deterministic PRNG
 * @param N - Number of players
 * @param cfg - Engine config
 * @returns Array of {x, y, vx, vy} for each player in engine order
 */
function generateRingSpawnSlots(
  roundSeed: Uint8Array,
  N: number,
  cfg: EngineConfig
): Array<{ x: number; y: number; vx: number; vy: number }> {
  const spawn = cfg.orbs.spawn
  const pad = spawn?.pad ?? 4
  const startInset = spawn?.startInset ?? 16
  const velocityMode = spawn?.velocity ?? 'tangent'
  const jitterEnabled = spawn?.jitter ?? false
  const ringsMin = spawn?.ringsMin ?? 1
  const ringsMax = spawn?.ringsMax ?? 1
  const ro = cfg.orbs.radius
  const R = cfg.boundary.radius
  const cx = cfg.canvas.width / 2
  const cy = cfg.canvas.height / 2
  const baseSpeed = cfg.orbs.baseSpeed ?? 8
  const ringGap = spawn?.ringGap ?? (2 * ro + pad)

  // Seed-only PRNG for spawn
  const prSpawn = makePRNG(sha256Concat(roundSeed, new TextEncoder().encode('spawn')))
  const prOrder = prSpawn.derive('order')
  const prK = prSpawn.derive('K')
  const prJitter = prSpawn.derive('jitter')

  // Global rotation
  const phi0 = prSpawn.nextF32() * 2 * Math.PI

  // Build all possible rings with chord-based capacity
  type RingInfo = { radius: number; slots: number; dThetaMin: number }
  const allRings: RingInfo[] = []
  const r0 = R - startInset - ro
  let k = 0

  while (true) {
    const rk = r0 - k * ringGap
    if (rk < ro + 8) break // Stop when ring too small

    // Chord-based minimum angular separation for no overlap
    const chordLen = 2 * ro + pad
    const dThetaMin = 2 * Math.asin(Math.min(1, chordLen / (2 * rk)))

    // Slot capacity with small safety margin
    const slots = Math.max(1, Math.ceil((2 * Math.PI) / (dThetaMin * 1.03)))

    allRings.push({ radius: rk, slots, dThetaMin })
    k++
  }

  if (allRings.length === 0) {
    // Degenerate case: no valid rings, fall back to center placement
    const result: Array<{ x: number; y: number; vx: number; vy: number }> = []
    for (let i = 0; i < N; i++) {
      result.push({ x: cx, y: cy, vx: 0, vy: 0 })
    }
    return result
  }

  // Select K rings to use (seeded randomization)
  const K = Math.min(
    allRings.length,
    Math.max(ringsMin, ringsMin + (prK.nextU32() % (ringsMax - ringsMin + 1)))
  )
  const rings = allRings.slice(0, K)

  // Check capacity
  const totalSlots = rings.reduce((sum, r) => sum + r.slots, 0)
  if (totalSlots < N) {
    // Need more rings; add innermost rings until we have enough
    for (let i = K; i < allRings.length && totalSlots < N; i++) {
      rings.push(allRings[i])
    }
  }

  // Fisher-Yates permutation of player indices (seed-only)
  const playerOrder = Array.from({ length: N }, (_, i) => i)
  const permutedOrder = fisherYatesShuffle(playerOrder, prOrder)

  // Round-robin assignment across rings
  type Assignment = { playerIdx: number; ringIdx: number; slotIdx: number }
  const assignments: Assignment[] = []
  const ringCounts = new Array(rings.length).fill(0)

  for (let i = 0; i < N; i++) {
    const playerIdx = permutedOrder[i]
    const ringIdx = i % rings.length

    // Check if ring has capacity
    if (ringCounts[ringIdx] < rings[ringIdx].slots) {
      const slotIdx = ringCounts[ringIdx]
      assignments.push({ playerIdx, ringIdx, slotIdx })
      ringCounts[ringIdx]++
    } else {
      // Find next available ring (overflow handling)
      let foundSlot = false
      for (let j = 0; j < rings.length; j++) {
        const tryRing = (ringIdx + j) % rings.length
        if (ringCounts[tryRing] < rings[tryRing].slots) {
          const slotIdx = ringCounts[tryRing]
          assignments.push({ playerIdx, ringIdx: tryRing, slotIdx })
          ringCounts[tryRing]++
          foundSlot = true
          break
        }
      }
      if (!foundSlot) {
        // Absolute overflow: place at center (should not happen with proper HARD_CAP)
      }
    }
  }

  // Generate final positions
  const result: Array<{ x: number; y: number; vx: number; vy: number }> = []

  for (const assign of assignments) {
    const ring = rings[assign.ringIdx]
    const dTheta = (2 * Math.PI) / ring.slots
    let theta = phi0 + assign.slotIdx * dTheta
    let r = ring.radius

    // Apply safe bounded jitter if enabled
    if (jitterEnabled) {
      // Angular jitter: bounded to half the available slack
      const slack = dTheta - ring.dThetaMin
      const maxAngularJitter = 0.5 * slack
      const angularJitter = (prJitter.nextF32() * 2 - 1) * maxAngularJitter
      theta += angularJitter

      // Radial jitter: small, bounded
      const maxRadialJitter = Math.min(ringGap / 4, ro)
      const radialJitter = (prJitter.nextF32() * 2 - 1) * maxRadialJitter
      r += radialJitter
    }

    // Position using deterministic trig
    const x = cx + r * detCos(theta)
    const y = cy + r * detSin(theta)

    // Velocity based on mode
    let vx = 0, vy = 0

    if (velocityMode === 'tangent') {
      // Tangent: perpendicular to radius
      const tx = -detSin(theta)
      const ty = detCos(theta)
      vx = baseSpeed * tx
      vy = baseSpeed * ty
    } else if (velocityMode === 'outward') {
      // Radial outward
      const nx = detCos(theta)
      const ny = detSin(theta)
      vx = baseSpeed * nx
      vy = baseSpeed * ny
    }
    // velocityMode === 'none' handled in initFromSeed (use per-orb PRNG)

    result[assign.playerIdx] = { x, y, vx, vy }
  }

  // Fill any missing slots with center position (overflow fallback)
  for (let i = 0; i < N; i++) {
    if (!result[i]) {
      result[i] = { x: cx, y: cy, vx: 0, vy: 0 }
    }
  }

  return result
}

export function initFromSeed(roundSeed: Uint8Array, players: Player[], cfg: EngineConfig, opts?: InitOpts): { state: EngineState, prngs: Map<string, ReturnType<typeof makePRNG>> } {
  const state: EngineState = { frame: 0, orbs: [], tethers: [], flashes: [], shockwaves: [], scores: {} }
  const prngs = new Map<string, ReturnType<typeof makePRNG>>()
  const cx = cfg.canvas.width / 2, cy = cfg.canvas.height / 2


  // Determine spawn mode
  const spawnMode = cfg.orbs.spawn?.mode ?? 'random'
  const useRingSpawn = spawnMode === 'rings' && cfg.boundary.shape !== 'rect'

  // Generate spawn slots (if ring mode)
  let ringSlots: Array<{ x: number; y: number; vx: number; vy: number }> | undefined
  if (useRingSpawn) {
    ringSlots = generateRingSpawnSlots(roundSeed, players.length, cfg)
  }

  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const seed = perOrbSeed(roundSeed, p)
    const master = makePRNG(seed)
    const prInit = master.derive('init')
    const prBounce = master.derive('bounce')
    const trait: Trait = cfg.disableTraits
      ? { name: 'precise', restMul: 1.0, tanKickMul: 1.0, minSpeedMul: 1.0, jitterMul: 1.0, gravityMul: 1.0 }
      : deriveTrait(master.derive('trait'))
    prngs.set('bounce:'+i, prBounce)

    // Position and velocity
    let x: number, y: number, vx: number, vy: number

    if (ringSlots) {
      // Ring spawn mode: use pre-computed slots
      const slot = ringSlots[i]
      x = slot.x
      y = slot.y

      // Velocity: use slot velocity unless mode is 'none'
      if (cfg.orbs.spawn?.velocity === 'none') {
        // Fall back to random velocity (old behavior)
        const s = cfg.orbs.baseSpeed ?? 8
        vx = (prInit.nextF32() - 0.5) * 2 * s
        vy = (prInit.nextF32() - 0.5) * 2 * s
      } else {
        vx = slot.vx
        vy = slot.vy
      }
    } else {
      // Random spawn mode (default/backward compatible)
      const baseR = cfg.boundary.radius * 0.3
      const theta = prInit.nextF32() * Math.PI * 2
      const r = baseR * (0.8 + prInit.nextF32() * 0.4)
      const s = cfg.orbs.baseSpeed ?? 8
      x = cx + detCos(theta) * r
      y = cy + detSin(theta) * r
      vx = (prInit.nextF32() - 0.5) * 2 * s
      vy = (prInit.nextF32() - 0.5) * 2 * s
    }

    // Apply player-chosen spawn override if provided
    const ownerHex = toHex(p.pubkey)
    const spawnOverride = opts?.spawnByOwnerHex?.[ownerHex]
    if (spawnOverride) {
      if (spawnOverride.x !== undefined) x = spawnOverride.x
      if (spawnOverride.y !== undefined) y = spawnOverride.y
      if (spawnOverride.angle !== undefined && spawnOverride.speed !== undefined) {
        vx = spawnOverride.speed * detCos(spawnOverride.angle)
        vy = spawnOverride.speed * detSin(spawnOverride.angle)
      }
    }

    // Lookup skill multipliers
    const skillMul = opts?.multipliersByOwnerHex?.[ownerHex]
    const skill: Skill = skillMul ?? { splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 }

    const o = {
      x, y, vx, vy,
      justCollided: false,
      hadTether: false,
      color: p.color || '#ffffff',
      prng: prBounce,
      trait,
      owner: p.pubkey,
      radius: cfg.orbs.radius,
      gen: 0,
      splitCooldown: 0,
      skill,
    }
    state.orbs.push(o)
    state.tethers.push([] as Tether[])
  }

  // Resolve spawn overlaps deterministically (no RNG)
  resolveSpawnOverlaps(state.orbs, cfg)


  // Initialize deterministic economics if provided
  try { initEconomicsFromConfig(state, cfg) } catch {}

  return { state, prngs }
}

/**
 * Replay a complete game from seed to end
 *
 * Deterministic: Same inputs (seed, players, cfg) produce identical outcomes
 * Uses advanceFrame() in a loop for single codepath with live games
 */
export function replay(roundSeed: Uint8Array, players: Player[], transcript: any[], maxFrames: number, cfg: EngineConfig) {
  const { state, prngs } = initFromSeed(roundSeed, players, cfg)


  let frames = 0
  while (frames < maxFrames && countUniqueOwners(state.orbs) > 1) {
    advanceFrame(state, cfg, prngs)
    frames++
  }


  return { state }
}

// NOTE: Engine guard disabled because physicsStep mutates state in place
// The same state object is reused across frames, making WeakMap-based guards ineffective

export function advanceFrame(state: EngineState, cfg: EngineConfig, prngs: Map<string, ReturnType<typeof makePRNG>>): EngineState {

  const { state: st, events } = physicsStep(state, cfg, prngs)

  // Shockwave config
  const lifeFrames = cfg.fx?.shockwave?.lifeFrames ?? 30
  const maxRadius  = cfg.fx?.shockwave?.maxRadius  ?? cfg.boundary.radius
  const thickness  = cfg.fx?.shockwave?.ringThickness ?? 20
  const respectProtect = cfg.fx?.shockwave?.respectProtect ?? false
  const cutMode = cfg.fx?.shockwave?.cutMode ?? 'segment'

  // Handle events: boundary_hit and shock
  for (const e of events) {
    if (e.type === "boundary_hit") {
      const idx = e.orbIndex
      const color = st.orbs[idx].color
      st.tethers[idx].push({ anchorX: e.anchorX, anchorY: e.anchorY, color, protect: 1 })
      st.orbs[idx].hadTether = true
    } else if (e.type === "shock") {
      const life = Math.max(1, Math.floor(lifeFrames))
      const kind = e.kind ?? 'split'
      const affectsTethers = kind === 'split'
        ? true
        : !!cfg.fx?.shockwave?.impactCutsTethers
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

  // Owners list BEFORE prune (full hex ids) - one per orb for index mapping
  const ownersBefore = st.orbs.map(o => toHex(o.owner))
  const tetherEvents = processTethers(st, cfg)
  const frameEvents = [...events, ...tetherEvents]
  applyScoring(st, frameEvents)
  // Prune: remove orbs that had tether but now have none
  pruneEliminated(st)
  // Owners list AFTER prune - one per orb for index mapping
  const ownersAfter = st.orbs.map(o => toHex(o.owner))
  // Apply deterministic economic scoring for this frame
  let tpEvents: ReturnType<typeof applyEconomicScoring> = []
  try { tpEvents = applyEconomicScoring(st, frameEvents, ownersBefore, ownersAfter) } catch {}

  // Handle TP trigger events: remove orbs that cashed out
  if (tpEvents.length > 0) {
    const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
    const remainingOrbs: typeof st.orbs = []
    const remainingTethers: typeof st.tethers = []
    for (let i = 0; i < st.orbs.length; i++) {
      if (!tpOrbIndices.has(i)) {
        remainingOrbs.push(st.orbs[i])
        remainingTethers.push(st.tethers[i])
      }
    }
    st.orbs = remainingOrbs
    st.tethers = remainingTethers

    // After TP removals, finalize if <=1 orb remaining
    const ownersPostTP = st.orbs.map(o => toHex(o.owner))
    finalizeIfNeeded(st, ownersPostTP)
  }

  // Animate shockwaves and cut tethers
  // Note: shockwaves can always cut tethers, immunity only affects direct orb-tether contact
  if (st.shockwaves.length) {
    const next: typeof st.shockwaves = []
    for (let wi = 0; wi < st.shockwaves.length; wi++) {
      const w = st.shockwaves[wi]
      w.life -= 1
      const t = 1 - (w.life / w.maxLife)
      w.r = w.maxR * t

      if (w.affectsTethers) {
        const rIn = Math.max(0, w.r - w.thickness * 0.5)
        const rOut = w.r + w.thickness * 0.5
        const rIn2 = rIn * rIn, rOut2 = rOut * rOut

        for (let oi = 0; oi < st.tethers.length; oi++) {
          const list = st.tethers[oi]
          if (!list || !list.length) continue
          const orb = st.orbs[oi]
          let write = 0
          for (let ti = 0; ti < list.length; ti++) {
            const th = list[ti]
            if (respectProtect && th.protect && th.protect > 0) { list[write++] = th; continue }
            const hit = (cutMode === 'anchor')
              ? (() => {
                  const dx = th.anchorX - w.x, dy = th.anchorY - w.y
                  const d2 = dx*dx + dy*dy
                  return d2 >= rIn2 && d2 <= rOut2
                })()
              : segIntersectsAnnulus(w.x, w.y, rIn, rOut, th.anchorX, th.anchorY, orb.x, orb.y)
            if (!hit) list[write++] = th
          }
          if (write !== list.length) list.length = write

          // if all tethers removed, keep orb alive
          if (list.length === 0) {
            st.orbs[oi].hadTether = false
          }
        }
      }

      if (w.life > 0) next.push(w)
    }
    st.shockwaves = next
  }

  return st
}
