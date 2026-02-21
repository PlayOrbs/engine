import { EngineConfig, EngineState } from '../core/v1/types.js'
import { sha256 } from '@noble/hashes/sha2.js'

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2,'0')
  return s
}

export function applyScoring(state: EngineState, events: any[]): void {
  for (let i = 0; i < state.orbs.length; i++) {
    const ownerShort = toHex(state.orbs[i].owner).slice(0,8)
    const entry = state.scores[ownerShort] || { framesAlive: 0, tethersDestroyed: 0, score: 0 }
    entry.framesAlive += 1
    state.scores[ownerShort] = entry
  }
  for (const e of events) {
    if (e.type === 'tether_destroyed' && typeof e.owner === 'number') {
      const idx = e.owner
      if (idx >= 0 && idx < state.orbs.length) {
        const ownerShort = toHex(state.orbs[idx].owner).slice(0,8)
        const entry = state.scores[ownerShort] || { framesAlive: 0, tethersDestroyed: 0, score: 0 }
        entry.tethersDestroyed += 1
        entry.score += 1
        state.scores[ownerShort] = entry
      }
    }
  }
}

// ========== Deterministic Economic Scoring ==========

export type EngineEvent = {
  type: 'tp_trigger'
  orbIndex: number
  ownerHex: string
  frame: number
  targetLamports: number
}

function toFullHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2,'0')
  return s
}

function floorDiv(a: number, b: number): number { return Math.trunc(a / b) }

/**
 * Helper: Sum per-kill schedule and verify it equals bounty_pot
 * Used for debugging and invariant checking
 */
export function sumPerKillSchedule(perKillSchedule: Record<number, number>, Amax: number): number {
  let sum = 0
  for (let A = Amax; A >= 2; A--) {
    sum += perKillSchedule[A] || 0
  }
  return sum
}

/**
 * Helper: Sum top K kills from schedule (for TP presets)
 * Returns lamports value of first K eliminations
 */
export function sumTopKillsLamports(perKillSchedule: Record<number, number>, N: number, k: number): number {
  let total = 0
  for (let A = N; A >= 2 && k > 0; A--, k--) {
    total += perKillSchedule[A] || 0
  }
  return total
}

/**
 * Build deterministic TP preset targets based on kill equivalents
 * Uses perKillSchedule to compute exact lamport values
 */
export function buildTpPresetsLamports(
  perKillSchedule: Record<number, number>,
  N: number
): Record<'safe' | 'balanced' | 'fierce' | 'yolo', number> {
  return {
    safe: sumTopKillsLamports(perKillSchedule, N, 2),
    balanced: sumTopKillsLamports(perKillSchedule, N, 4),
    fierce: sumTopKillsLamports(perKillSchedule, N, 6),
    yolo: sumTopKillsLamports(perKillSchedule, N, 8),
  }
}

export function initEconomicsFromConfig(state: EngineState, cfg: EngineConfig): void {
  const econIn = cfg.economicsInputs
  if (!econIn) {
    if (cfg.debug) {
      console.log('[Economics] No economicsInputs provided, skipping initialization')
    }
    return
  }

  const header = econIn.header
  const params = econIn.economic_params
  const roster = econIn.roster

  // Validation: roster must match total_players
  if (!roster || !params) {
    if (cfg.debug) {
      console.warn('[Economics] Missing roster or params, skipping initialization')
    }
    return
  }

  if (roster.length !== params.total_players) {
    if (cfg.debug) {
      console.warn(`[Economics] Roster length mismatch: roster=${roster.length}, total_players=${params.total_players}. Skipping initialization.`)
    }
    return
  }

  const N = params.total_players
  const entry = params.entry_amount_lamports
  const economy_model = header.economy_model ?? 'weighted_kill_v2_inherit'

  let bounty_pot: number
  let survival_pot: number
  let per_kill: number | undefined
  let perKillSchedule: Record<number, number> | undefined
  let weights_meta: { model: string; dev_fee_bps: number; bounty_share_bps: number; survival_share_bps: number } | undefined

  if (economy_model === 'fixed_total_v0') {
    // Legacy model: use bounty_bps and survival_bps directly
    bounty_pot = Math.max(0, Math.trunc(entry * N * (params.bounty_bps / 10000)))
    survival_pot = Math.max(0, Math.trunc(entry * N * (params.survival_bps / 10000)))
    const denom = Math.max(1, N - 1)
    per_kill = floorDiv(bounty_pot, denom)
  } else if (economy_model === 'log_scaled_kill_v1') {
    // log_scaled_kill_v1: Apply dev fee and log scaling
    const dev_fee = (header.dev_fee_bps ?? 2000) / 10000
    const bounty_share = 0.70
    const survival_share = 0.30
    const G_N = 1 + Math.log2(N) / 5

    const player_pool = entry * N * (1 - dev_fee)
    per_kill = Math.trunc(entry * (1 - dev_fee) * bounty_share * G_N)
    bounty_pot = per_kill * (N - 1)
    survival_pot = Math.trunc(player_pool * survival_share)
  } else {
    // weighted_kill_v2 and weighted_kill_v2_inherit: Log-weighted kill payouts with exact sum
    const dev_fee_bps = header.dev_fee_bps ?? 2000
    const dev_fee = dev_fee_bps / 10000
    const bounty_share = 0.70
    const survival_share = 0.30

    const player_pool = Math.trunc(entry * N * (1 - dev_fee))
    bounty_pot = Math.trunc(player_pool * bounty_share)
    survival_pot = Math.trunc(player_pool * survival_share)

    // Build weight schedule: w(A) = 1 + log2(A) for A = N..2
    const weights: Record<number, number> = {}
    let W = 0
    for (let A = N; A >= 2; A--) {
      weights[A] = 1 + Math.log2(A)
      W += weights[A]
    }

    // Compute per-kill schedule
    perKillSchedule = {}
    let sumSched = 0
    for (let A = N; A >= 2; A--) {
      const payout = Math.trunc((bounty_pot * weights[A]) / W)
      perKillSchedule[A] = payout
      sumSched += payout
    }

    // Fix rounding: add remaining lamports to earliest kills
    let delta = bounty_pot - sumSched
    for (let A = N; A >= 2 && delta > 0; A--) {
      perKillSchedule[A]++
      delta--
    }

    // Verify exact sum invariant
    if (cfg.debug) {
      const finalSum = sumPerKillSchedule(perKillSchedule, N)
      if (finalSum !== bounty_pot) {
        console.error(`[Economics] INVARIANT VIOLATION: perKillSchedule sum (${finalSum}) != bounty_pot (${bounty_pot})`)
      } else {
        console.log(`[Economics] Weighted schedule verified: sum=${finalSum} lamports (${(finalSum / 1e9).toFixed(3)} SOL)`)
      }
    }

    weights_meta = {
      model: economy_model,
      dev_fee_bps,
      bounty_share_bps: Math.trunc(bounty_share * 10000),
      survival_share_bps: Math.trunc(survival_share * 10000)
    }
  }

  const rosterIndex: Record<string, number> = {}
  for (let i = 0; i < roster.length; i++) rosterIndex[roster[i]] = i

  const perPlayer: Record<string, {
    kills: number
    framesAlive: number
    spawn_frame: number
    last_alive_frame: number
    death_frame?: number
    bounty_earned: number
    survival_earned: number
    total_earned: number
  }> = {}

  for (const pid of roster) {
    perPlayer[pid] = {
      kills: 0,
      framesAlive: 0,
      spawn_frame: 0,
      last_alive_frame: -1,
      bounty_earned: 0,
      survival_earned: 0,
      total_earned: 0
    }
  }

  // Build TP presets if we have a weighted schedule
  let tp_presets_lamports: Record<'safe' | 'balanced' | 'fierce' | 'yolo', number> | undefined
  if (perKillSchedule) {
    tp_presets_lamports = buildTpPresetsLamports(perKillSchedule, N)
    if (cfg.debug) {
      console.log(`[Economics] TP Presets: safe=${(tp_presets_lamports.safe / 1e9).toFixed(3)} SOL, balanced=${(tp_presets_lamports.balanced / 1e9).toFixed(3)} SOL, fierce=${(tp_presets_lamports.fierce / 1e9).toFixed(3)} SOL, yolo=${(tp_presets_lamports.yolo / 1e9).toFixed(3)} SOL`)
    }
  }

  state.econ = {
    header,
    economic_params: params,
    roster,
    rosterIndex,
    pots: {
      bounty_pot_lamports: bounty_pot,
      survival_pot_lamports: survival_pot,
      bounty_per_kill_lamports: per_kill
    },
    bounty_remaining: bounty_pot,
    perKillSchedule,
    weights_meta,
    perPlayer,
    events: [],
    winner_id: undefined,
    finalized: false,
    result_hash: undefined,
    prevOwners: [],
    tp_presets_lamports,
    tp_targets: econIn.tp_targets_lamports,
    tp_triggered: new Set<string>()
  }

  if (cfg.debug) {
    const tpCount = econIn.tp_targets_lamports ? Object.keys(econIn.tp_targets_lamports).length : 0
    console.log(`[Economics] Initialized: model=${economy_model}, players=${N}, bounty=${(bounty_pot / 1e9).toFixed(3)} SOL, survival=${(survival_pot / 1e9).toFixed(3)} SOL, TP targets=${tpCount}`)
  }
}

/**
 * Apply TP presets to players based on their join configuration
 * Call this after initEconomicsFromConfig to resolve preset -> lamports
 *
 * @param state - Engine state with econ initialized
 * @param joinMap - Map of playerHex -> Join config
 */
export function applyTPPresetsToTargets(state: EngineState, joinMap: Record<string, { tp?: { enabled: boolean; preset?: string; targetSol?: number } }>): void {
  const econ = state.econ
  if (!econ || !econ.tp_presets_lamports) return

  if (!econ.tp_targets) {
    econ.tp_targets = {}
  }

  for (const playerHex of econ.roster) {
    const join = joinMap[playerHex]
    if (!join?.tp?.enabled) continue

    // Preset takes priority
    const preset = join.tp.preset as 'safe' | 'balanced' | 'fierce' | 'yolo' | undefined;
    if (preset && preset in econ.tp_presets_lamports) {
      econ.tp_targets[playerHex] = econ.tp_presets_lamports[preset]
    } else if (typeof join.tp.targetSol === 'number' && !econ.tp_targets[playerHex]) {
      // Manual override (only if not already set by preset)
      econ.tp_targets[playerHex] = Math.max(0, Math.round(join.tp.targetSol * 1_000_000_000))
    }
  }
}

export function applyEconomicScoring(state: EngineState, frameEvents: any[], ownersBefore: string[], ownersAfter: string[]): EngineEvent[] {
  const engineEvents: EngineEvent[] = []
  const econ = state.econ
  if (!econ) return engineEvents
  if (econ.finalized) return engineEvents

  // Update framesAlive and last_alive_frame for alive owners AFTER prune (eliminated this frame don’t advance)
  const aliveSet = new Set<string>(ownersAfter)
  for (const pid of aliveSet) {
    const p = econ.perPlayer[pid]
    if (p) {
      p.framesAlive += 1
      p.last_alive_frame = state.frame
    }
  }

  // Map orb index -> owner id at pre-prune for killer attribution
  const idxToOwner: Record<number,string> = {}
  for (let i = 0; i < ownersBefore.length; i++) idxToOwner[i] = ownersBefore[i]

  // Eliminations are owners present before and absent after
  const beforeSet = new Set<string>(ownersBefore)
  const eliminated: string[] = []
  for (const pid of beforeSet) if (!aliveSet.has(pid)) eliminated.push(pid)

  if (eliminated.length > 0) {
    // Stable order by roster index
    eliminated.sort((a,b)=> (econ.rosterIndex[a]??0) - (econ.rosterIndex[b]??0))

    // For each eliminated victim, find last tether_destroyed event against that victim's orb index in this frame
    // Build mapping victim_ownerId -> last attacker_ownerId
    const lastHit: Record<string, string | undefined> = {}
    for (let i = 0; i < frameEvents.length; i++) {
      const e = frameEvents[i]
      if (e && e.type === 'tether_destroyed' && typeof e.owner === 'number') {
        const victimOwner = idxToOwner[e.owner]
        const attackerOwner = (typeof e.attacker === 'number') ? idxToOwner[e.attacker] : undefined
        if (victimOwner) lastHit[victimOwner] = attackerOwner
      }
    }

    // Track alive count for weighted payouts
    let currentAliveCount = beforeSet.size

    // Step 1: Process scheduled kill bounty payouts
    for (const victim_id of eliminated) {
      const killer_id = lastHit[victim_id]
      // Mark death frame
      const vp = econ.perPlayer[victim_id]
      if (vp && vp.death_frame === undefined) vp.death_frame = state.frame

      if (killer_id && killer_id !== victim_id) {
        // Determine payout based on model
        let payout = 0
        if (econ.perKillSchedule && currentAliveCount >= 2) {
          // weighted_kill_v2: use schedule based on alive count
          payout = econ.perKillSchedule[currentAliveCount] ?? 0
        } else if (econ.pots.bounty_per_kill_lamports !== undefined) {
          // fixed_total_v0 or log_scaled_kill_v1: flat per-kill
          payout = econ.pots.bounty_per_kill_lamports
        }

        const amount = Math.min(payout, econ.bounty_remaining)
        if (amount > 0) {
          econ.bounty_remaining -= amount
          const kp = econ.perPlayer[killer_id]
          if (kp) {
            kp.kills += 1
            kp.bounty_earned += amount
            kp.total_earned = kp.bounty_earned + kp.survival_earned
          }
          econ.events.push({
            type: 'BountyPayout',
            frame: state.frame,
            killer_id,
            victim_id,
            amount,
            bounty_remaining: econ.bounty_remaining,
            alive_before: currentAliveCount
          })
        }
      }

      // Decrement alive count for next elimination in same frame
      currentAliveCount--
    }

    // Step 2: Inheritance (weighted_kill_v2_inherit only)
    if (econ.header.economy_model === 'weighted_kill_v2_inherit') {
      for (const victim_id of eliminated) {
        const killer_id = lastHit[victim_id]
        if (killer_id && killer_id !== victim_id) {
          const vp = econ.perPlayer[victim_id]
          const kp = econ.perPlayer[killer_id]
          if (vp && kp) {
            const cashed = vp.cashed_bounty || 0
            const uncashed = Math.max(0, (vp.bounty_earned || 0) - cashed)
            if (uncashed > 0) {
              // Transfer without minting
              kp.bounty_earned += uncashed
              vp.bounty_earned -= uncashed
              kp.total_earned = kp.bounty_earned + (kp.survival_earned || 0)
              vp.total_earned = vp.bounty_earned + (vp.survival_earned || 0)
              econ.events.push({
                type: 'KillInheritance',
                frame: state.frame,
                killer_id,
                victim_id,
                transferred: uncashed
              })
            }
          }
        }
      }
    }
  }

  // Step 3: Check for TP triggers after bounty payouts and inheritance
  if (econ.tp_targets && !econ.tp_triggered) {
    econ.tp_triggered = new Set<string>()
  }

  if (econ.tp_targets) {
    // Build mapping of alive owners to their orb indices (post-prune)
    // Uses number[] to handle split orbs (multiple orbs per owner)
    const ownerToIndices: Record<string, number[]> = {}
    for (let i = 0; i < state.orbs.length; i++) {
      const ownerHex = toFullHex(state.orbs[i].owner)
      if (!ownerToIndices[ownerHex]) ownerToIndices[ownerHex] = []
      ownerToIndices[ownerHex].push(i)
    }

    // Don't trigger TP if only 1 unique player left (winner gets survival pot instead)
    const uniqueOwnersForTP = [...new Set(ownersAfter)]
    if (uniqueOwnersForTP.length <= 1) {
      // Skip TP check - game is ending, winner will get survival award
    } else {
      for (const ownerHex of uniqueOwnersForTP) {
        const target = econ.tp_targets[ownerHex]
        if (target !== undefined && !econ.tp_triggered!.has(ownerHex)) {
          const player = econ.perPlayer[ownerHex]
          if (player && player.total_earned >= target) {
          // Mark as triggered
          econ.tp_triggered!.add(ownerHex)

          // Calculate amount to cash out (uncashed portion only for inheritance model)
          const cashed = player.cashed_bounty || 0
          const amountToCash = Math.max(0, (player.bounty_earned || 0) - cashed)

          // Update cashed_bounty for inheritance model
          if (econ.header.economy_model === 'weighted_kill_v2_inherit') {
            player.cashed_bounty = (player.cashed_bounty || 0) + amountToCash
          }

          // Add economics log (log total earned for consistency)
          econ.events.push({
            type: 'TPCashout',
            frame: state.frame,
            player_id: ownerHex,
            amount: player.total_earned,
            target
          })

          // Emit engine event for every orb owned by this player (handles split orbs)
          const orbIndices = ownerToIndices[ownerHex]
          if (orbIndices) {
            for (const orbIndex of orbIndices) {
              engineEvents.push({
                type: 'tp_trigger',
                orbIndex,
                ownerHex,
                frame: state.frame,
                targetLamports: target
              })
            }
          }
        }
      }
    }
    } // end else (ownersAfter.length > 1)
  }

  // Finalize when <= 1 unique player alive (deduplicate for split orbs)
  const uniqueOwnersAfter = [...new Set(ownersAfter)]
  if (uniqueOwnersAfter.length <= 1) {
    let winner_id: string | undefined = ownersAfter[0]
    if (!winner_id) {
      // 0 alive: tie-break among eliminated this frame
      const candidates = eliminated
      if (candidates.length > 0) {
        let best = candidates[0]
        for (let i = 1; i < candidates.length; i++) {
          const a = econ.perPlayer[best]
          const b = econ.perPlayer[candidates[i]]
          if (!a || !b) continue
          if (b.framesAlive > a.framesAlive) { best = candidates[i]; continue }
          if (b.framesAlive < a.framesAlive) { continue }
          if (b.kills > a.kills) { best = candidates[i]; continue }
          if (b.kills < a.kills) { continue }
          // smaller roster index wins
          if ((econ.rosterIndex[candidates[i]] ?? 999999) < (econ.rosterIndex[best] ?? 999999)) { best = candidates[i] }
        }
        winner_id = best
        const losers = candidates.filter(x=>x!==best)
        econ.events.push({ type:'TieBreak', frame: state.frame, winner_id, losers, rule_chain: ['framesAlive','kills','rosterIndex'] })
      }
    }
    if (winner_id) {
      finalizeGame(state, winner_id)
    }
  }

  return engineEvents
}

/**
 * Finalize game with the given winner.
 * Awards survival pot + any remaining bounty to winner.
 * This is the single source of truth for game finalization.
 */
function finalizeGame(state: EngineState, winner_id: string): void {
  const econ = state.econ
  if (!econ || econ.finalized) return

  // Award survival pot + any remaining bounty to winner
  const survivalAward = econ.pots?.survival_pot_lamports || 0
  const remainingBounty = econ.bounty_remaining || 0
  const totalAward = survivalAward + remainingBounty
  
  const wp = econ.perPlayer?.[winner_id]
  if (wp) {
    wp.survival_earned = (wp.survival_earned || 0) + totalAward
    wp.total_earned = (wp.bounty_earned || 0) + wp.survival_earned
  }
  
  // Clear remaining bounty since it's been awarded
  econ.bounty_remaining = 0
  
  econ.events.push({ type: 'SurvivalAward', frame: state.frame, winner_id, amount: totalAward })
  econ.winner_id = winner_id
  econ.finalized = true
  econ.result_hash = computeResultHash(state)
}

/**
 * Finalize game if <=1 owner remains and not already finalized.
 * Called after TP removals to handle the case where TP cashout leaves only the winner.
 */
export function finalizeIfNeeded(state: EngineState, ownersAfter: string[]): void {
  const econ = state.econ
  if (!econ || econ.finalized) return
  const uniqueOwners = [...new Set(ownersAfter)]
  if (uniqueOwners.length > 1) return

  const winner_id = uniqueOwners[0]
  if (winner_id) {
    finalizeGame(state, winner_id)
  }
}

export function computeResultHash(state: EngineState): string {
  const econ = state.econ
  if (!econ) return ''

  const header = econ.header
  const economic_params = econ.economic_params
  const pots = econ.pots
  const events = econ.events

  const per_player = econ.roster.map((pid: string) => ({
    player_id: pid,
    ...econ.perPlayer[pid]
  }))

  // Build payload with stable field ordering
  const out: any = {
    header: {
      ...header,
      economy_model: header.economy_model ?? 'weighted_kill_v2_inherit'
    },
    economic_params,
    pots,
    events,
    per_player,
    winner_id: econ.winner_id
  }

  // Include weights_meta if present (weighted_kill_v2/inherit)
  if (econ.weights_meta) {
    out.weights_meta = econ.weights_meta
  }

  // Include perKillSchedule if present (weighted_kill_v2/inherit)
  if (econ.perKillSchedule) {
    out.perKillSchedule = econ.perKillSchedule
  }

  // Include tp_targets_lamports if present
  if (econ.tp_targets) {
    out.tp_targets_lamports = econ.tp_targets
  }

  const json = JSON.stringify(out)
  const digest = sha256(new TextEncoder().encode(json))
  let hex = ''
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2,'0')
  return hex
}
