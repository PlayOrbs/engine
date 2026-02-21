// ─── Deterministic State Hashing for V1 Engine ───
//
// Canonical serialization of EngineState → sha256 hex string.
// Used by both Node tests and browser manual harness.
//
// Rules:
//   - Explicit field ordering (not JSON.stringify)
//   - All numbers written as decimal strings separated by '|'
//   - Owner bytes as hex
//   - PRNG state serialized per orb (seed + buf + i + ctr)
//   - Tethers in array order per orb
//   - Excludes rendering-only fields (color, flashes, shockwave color)
//   - Includes all fields that influence future frames

import { sha256 } from '@noble/hashes/sha2.js'
import type { EngineState } from '../../../src/core/v1/types.js'

/**
 * Extract PRNG internal state as a deterministic string.
 * Uses __getState() which returns { seed, buf, i, ctr }.
 * If __getState is unavailable, returns a sentinel so the hash still works
 * (but won't distinguish PRNG differences — should never happen in practice).
 */
function serializePrng(prng: any): string {
  if (typeof prng?.__getState === 'function') {
    const st = prng.__getState()
    return `${bytesToHex(st.seed)}|${bytesToHex(st.buf)}|${st.i}|${st.ctr}`
  }
  return 'NO_PRNG_STATE'
}

/**
 * Serialize EngineState into a deterministic Uint8Array.
 * Field order is fixed and explicit — no dependency on JS object key ordering.
 */
export function serializeStateDeterministic(state: EngineState): Uint8Array {
  const parts: string[] = []

  // Frame
  parts.push(`F:${state.frame}`)

  // twoOrbsStartFrame (influences speed cap logic)
  parts.push(`T2:${state.twoOrbsStartFrame ?? -1}`)

  // Orbs (in array order — array order is deterministic)
  parts.push(`OC:${state.orbs.length}`)
  for (let i = 0; i < state.orbs.length; i++) {
    const o = state.orbs[i]
    // Physics state
    parts.push(`O${i}:${o.x}|${o.y}|${o.vx}|${o.vy}|${o.radius}|${o.gen}|${o.splitCooldown}|${o.hadTether ? 1 : 0}|${o.justCollided ? 1 : 0}`)
    // Owner bytes as hex (deterministic identity)
    parts.push(`W${i}:${bytesToHex(o.owner)}`)
    // Trait multipliers (all 5 fields)
    parts.push(`R${i}:${o.trait.restMul}|${o.trait.tanKickMul}|${o.trait.minSpeedMul}|${o.trait.jitterMul}|${o.trait.gravityMul}`)
    // Skill multipliers (all 4 fields including tetherResMul)
    parts.push(`K${i}:${o.skill.splitAggroMul}|${o.skill.tetherResMul}|${o.skill.tetherDefMul}|${o.skill.powerMul}`)
    // PRNG state (determines future randomness)
    parts.push(`P${i}:${serializePrng(o.prng)}`)
  }

  // Tethers (per orb, in array order)
  // Tether fields: anchorX, anchorY, protect, rest? (color is render-only)
  parts.push(`TC:${state.tethers.length}`)
  for (let i = 0; i < state.tethers.length; i++) {
    const list = state.tethers[i]
    parts.push(`TL${i}:${list.length}`)
    for (let j = 0; j < list.length; j++) {
      const t = list[j]
      parts.push(`T${i}.${j}:${t.anchorX}|${t.anchorY}|${t.protect}|${t.rest ?? 0}`)
    }
  }

  // Shockwaves (influence tether cutting in future frames)
  parts.push(`SC:${state.shockwaves.length}`)
  for (let i = 0; i < state.shockwaves.length; i++) {
    const w = state.shockwaves[i]
    parts.push(`S${i}:${w.x}|${w.y}|${w.r}|${w.maxR}|${w.life}|${w.maxLife}|${w.thickness}|${w.kind}|${w.affectsTethers ? 1 : 0}`)
  }

  // Scores (guard nullish, sorted by key for determinism)
  const scores = state.scores ?? {}
  const scoreKeys = Object.keys(scores).sort()
  parts.push(`XC:${scoreKeys.length}`)
  for (const k of scoreKeys) {
    const s = scores[k]
    parts.push(`X${k}:${s.framesAlive}|${s.tethersDestroyed}|${s.score}`)
  }

  const canonical = parts.join('\n')
  return new TextEncoder().encode(canonical)
}

/**
 * Compute sha256 hex hash of the deterministic state serialization.
 */
export function hashStateV1(state: EngineState): string {
  const bytes = serializeStateDeterministic(state)
  const digest = sha256(bytes)
  return bytesToHex(digest)
}

/**
 * Assert invariants on every orb in the state.
 * Throws with a diff-friendly message on first violation.
 */
export function assertInvariants(state: EngineState, frameLabel?: string): void {
  const ctx = frameLabel ?? `frame ${state.frame}`
  for (let i = 0; i < state.orbs.length; i++) {
    const o = state.orbs[i]
    if (Number.isNaN(o.vx) || !Number.isFinite(o.vx)) {
      throw new Error(`[${ctx}] orb ${i} vx=${o.vx} is NaN/Infinity`)
    }
    if (Number.isNaN(o.vy) || !Number.isFinite(o.vy)) {
      throw new Error(`[${ctx}] orb ${i} vy=${o.vy} is NaN/Infinity`)
    }
    if (Number.isNaN(o.x) || !Number.isFinite(o.x)) {
      throw new Error(`[${ctx}] orb ${i} x=${o.x} is NaN/Infinity`)
    }
    if (Number.isNaN(o.y) || !Number.isFinite(o.y)) {
      throw new Error(`[${ctx}] orb ${i} y=${o.y} is NaN/Infinity`)
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}
