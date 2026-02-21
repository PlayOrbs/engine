import type { Player, EngineConfig } from '../../src/core/v1/types.js'
import { toHex } from '../../src/utils/utils.js'

// Type for Join - minimal interface needed for tests
export type Join = {
  frame: number
  player: Uint8Array
  joinNonce: Uint8Array
  modePaid: boolean
  tp?: { enabled: boolean; preset?: 'safe' | 'balanced' | 'fierce' | 'yolo' }
}

/**
 * Test helpers for TP preset tests
 * Provides utilities for creating deterministic test data
 */

/**
 * Generate N synthetic pubkeys for testing
 * Uses deterministic sequence for reproducible tests
 */
export function makeRoster(N: number): Uint8Array[] {
  const roster: Uint8Array[] = []
  for (let i = 0; i < N; i++) {
    const pubkey = new Uint8Array(32)
    // Simple deterministic pattern: fill with player index
    pubkey.fill(i + 1)
    roster.push(pubkey)
  }
  return roster
}

/**
 * Generate N players with pubkeys and join nonces
 */
export function makePlayers(N: number, baseNonce = 0): Player[] {
  const roster = makeRoster(N)
  return roster.map((pubkey, i) => {
    const joinNonce = new Uint8Array(8)
    // Deterministic nonce based on player index
    const view = new DataView(joinNonce.buffer)
    view.setBigUint64(0, BigInt(baseNonce + i), true)
    return { pubkey, joinNonce }
  })
}

/**
 * Build a test engine config with specified parameters
 */
export function makeTestConfig(
  N: number,
  entryLamports: number,
  mode: 'paid' | 'free_sim',
  tpTargets?: Record<string, number>
): EngineConfig {
  const roster = makeRoster(N)
  const rosterHex = roster.map(toHex)

  return {
    canvas: { width: 1200, height: 800 },
    boundary: {
      radius: 400,
      restitution: 0.8,
      tangentImpulse: 0.1,
      minSpeed: 1.0,
      maxSpeed: 8.0,
    },
    burst: { lineWidth: 1 },
    orbs: {
      radius: 20,
    },
    disableTraits: true,
    debug: false, // Set to true to see debug logs
    economicsInputs: {
      header: {
        round_id: 1,
        seed_hex: '0000000000000000000000000000000000000000000000000000000000000000',
        map_id: 'test',
        rules_hash: 'test',
        build_hash: 'test',
        mode: mode,
        economy_model: 'weighted_kill_v2_inherit',
        dev_fee_bps: mode === 'paid' ? 2000 : 1000,
      },
      roster: rosterHex,
      economic_params: {
        total_players: N,
        entry_amount_lamports: entryLamports,
        bounty_bps: 7000,
        survival_bps: 3000,
      },
      tp_targets_lamports: tpTargets,
    },
  }
}

/**
 * Build join map with TP presets for testing
 */
export function buildJoinMapWithPresets(
  N: number,
  presets: Record<number, 'safe' | 'balanced' | 'fierce' | 'yolo'>
): Record<string, Join> {
  const roster = makeRoster(N)
  const joinMap: Record<string, Join> = {}

  roster.forEach((pubkey, i) => {
    const playerHex = toHex(pubkey)
    const joinNonce = new Uint8Array(8)
    const view = new DataView(joinNonce.buffer)
    view.setBigUint64(0, BigInt(i), true)

    const preset = presets[i]
    joinMap[playerHex] = {
      frame: 0,
      player: pubkey,
      joinNonce,
      modePaid: false,
      tp: preset
        ? { enabled: true, preset }
        : { enabled: false },
    }
  })

  return joinMap
}

/**
 * Helper to award a kill in the engine state
 * Updates scores and economics (simplified for testing)
 * NOTE: This simulates the kill payout but does NOT remove orbs or trigger full scoring.
 * For full TP trigger logic, you need to call applyEconomicScoring after manipulating state.
 */
export function awardKill(
  state: any,
  killerHex: string,
  victimHex: string,
  cfg: EngineConfig
): void {
  if (!state.econ || !state.econ.perPlayer) return

  const killerData = state.econ.perPlayer[killerHex]
  const victimData = state.econ.perPlayer[victimHex]

  if (!killerData || !victimData) return

  // Increment kill count
  killerData.kills = (killerData.kills || 0) + 1

  // Award bounty from schedule
  const alive = state.orbs.length
  const perKillSchedule = state.econ.perKillSchedule
  if (perKillSchedule && perKillSchedule[alive]) {
    const payout = perKillSchedule[alive]
    killerData.bounty_earned = (killerData.bounty_earned || 0) + payout

    // Inherit victim's uncashed bounty (zero-sum) for weighted_kill_v2_inherit
    if (state.econ.header.economy_model === 'weighted_kill_v2_inherit') {
      const victimBounty = victimData.bounty_earned || 0
      const victimCashed = victimData.cashed_bounty || 0
      const uncashedBounty = victimBounty - victimCashed

      if (uncashedBounty > 0) {
        killerData.bounty_earned += uncashedBounty
        // Transfer (don't mint)
        victimData.bounty_earned -= uncashedBounty
      }
    }
  }

  // Update total earned
  killerData.total_earned = (killerData.bounty_earned || 0) + (killerData.survival_earned || 0)

  // Check TP trigger (mimics engine logic)
  if (state.econ.tp_targets && state.econ.tp_targets[killerHex]) {
    const target = state.econ.tp_targets[killerHex]

    // Initialize tp_triggered if needed
    if (!state.econ.tp_triggered) {
      state.econ.tp_triggered = new Set()
    }

    // Only trigger if not already triggered and total_earned >= target
    if (!state.econ.tp_triggered.has(killerHex) && killerData.total_earned >= target) {
      state.econ.tp_triggered.add(killerHex)

      // Cash out (for inheritance model)
      if (state.econ.header.economy_model === 'weighted_kill_v2_inherit') {
        const cashed = killerData.cashed_bounty || 0
        const amountToCash = Math.max(0, killerData.bounty_earned - cashed)
        killerData.cashed_bounty = (killerData.cashed_bounty || 0) + amountToCash
      }
    }
  }
}

/**
 * Create a deterministic seed for testing
 */
export function makeTestSeed(index: number): Uint8Array {
  const seed = new Uint8Array(32)
  seed.fill(0)
  seed[0] = index
  return seed
}
