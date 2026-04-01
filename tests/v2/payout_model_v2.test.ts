import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { sumPerKillSchedule, finalizeIfNeeded } from '../../src/economics/scoring.js'
import { makePlayers, makeTestSeed, makeRoster } from '../shared/test-helpers.js'
import { toHex } from '../../src/utils/utils.js'
import type { EngineConfig } from '../../src/core/v1/types.js'

/**
 * Tests for v2_top3 payout model
 *
 * Verifies:
 * 1. Player pool == 85% of total entry fees (15% dev fee)
 * 2. Bounty pot == 40% of player pool
 * 3. Survival pot == 60% of player pool
 * 4. Lobby < 4: survival split 70/30 to top 2
 * 5. Lobby >= 4: survival split 65/25/10 to top 3
 * 6. No inheritance occurs (victim bounty stays with victim)
 * 7. No TP triggers (even if targets set)
 * 8. Tiebreak produces deterministic placement
 * 9. sum(payouts) == 85% player pool exactly
 */

const ENTRY_SOL = 0.01
const DEV_FEE_BPS_V2 = 1500
const LAMPORTS_PER_SOL = 1_000_000_000

function lamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}

/**
 * Build a v2_top3 test config
 */
function makeV2Config(
  N: number,
  entryLamports: number,
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
    orbs: { radius: 20 },
    disableTraits: true,
    debug: false,
    economicsInputs: {
      header: {
        round_id: 1,
        seed_hex: '0000000000000000000000000000000000000000000000000000000000000000',
        map_id: 'test',
        rules_hash: 'test',
        build_hash: 'test',
        mode: 'paid',
        economy_model: 'weighted_kill_v2',
        dev_fee_bps: DEV_FEE_BPS_V2,
        payout_model: 'v2_top3',
      },
      roster: rosterHex,
      economic_params: {
        total_players: N,
        entry_amount_lamports: entryLamports,
        bounty_bps: 4000,
        survival_bps: 6000,
      },
      tp_targets_lamports: tpTargets,
    },
  }
}

function runV2Sim(seed: Uint8Array, N: number, tpTargets?: Record<string, number>) {
  const entryLamports = lamports(ENTRY_SOL)
  const cfg = makeV2Config(N, entryLamports, tpTargets)
  const players = makePlayers(N)
  const { state } = initFromSeed(seed, players, cfg)
  return { state, players, entryLamports }
}

/**
 * Award a kill with bounty tracking (v2: no inheritance)
 */
function awardKillV2(state: any, killerHex: string, victimHex: string) {
  if (!state.econ || !state.econ.perPlayer) return

  const killerData = state.econ.perPlayer[killerHex]
  const victimData = state.econ.perPlayer[victimHex]
  if (!killerData || !victimData) return

  killerData.kills = (killerData.kills || 0) + 1

  // Mark death frame
  if (victimData.death_frame === undefined) victimData.death_frame = state.frame

  const alive = state.orbs.length
  const perKillSchedule = state.econ.perKillSchedule
  if (perKillSchedule && perKillSchedule[alive]) {
    const payout = Math.min(perKillSchedule[alive], state.econ.bounty_remaining || 0)
    if (payout > 0) {
      killerData.bounty_earned = (killerData.bounty_earned || 0) + payout
      state.econ.bounty_remaining -= payout

      state.econ.events.push({
        type: 'BountyPayout',
        frame: state.frame,
        killer_id: killerHex,
        victim_id: victimHex,
        amount: payout,
        bounty_remaining: state.econ.bounty_remaining,
        alive_before: alive,
      })
    }
  }

  // NO inheritance for v2_top3

  killerData.total_earned = (killerData.bounty_earned || 0) + (killerData.survival_earned || 0)

  // Advance frame so framesAlive differs between eliminations
  state.frame += 60

  // Update framesAlive for remaining alive players
  const aliveOwners = new Set<string>()
  for (const orb of state.orbs) {
    aliveOwners.add(toHex(orb.owner))
  }
  // Don't count victim as alive
  aliveOwners.delete(victimHex)
  for (const pid of aliveOwners) {
    const p = state.econ.perPlayer[pid]
    if (p) {
      p.framesAlive += 60
      p.last_alive_frame = state.frame
    }
  }

  // Remove one orb
  if (state.orbs.length > 0) {
    state.orbs.pop()
  }
}

// =============================================================================
// Pool Split Tests
// =============================================================================

describe('v2_top3: Pool Split Verification', () => {
  const playerCounts = [2, 3, 4, 5, 8, 10]

  it.each(playerCounts)('player pool == 85%% of total for N=%d', (N) => {
    const seed = makeTestSeed(N)
    const { state, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const expectedDevFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const expectedPlayerPool = totalPot - expectedDevFee

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const survivalPot = state.econ!.pots.survival_pot_lamports

    expect(bountyPot + survivalPot).toBe(expectedPlayerPool)
  })

  it.each(playerCounts)('bounty pot == 40%% of player pool for N=%d', (N) => {
    const seed = makeTestSeed(N)
    const { state, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const playerPool = totalPot - devFee
    const expectedBounty = Math.trunc(playerPool * 0.40)

    expect(state.econ!.pots.bounty_pot_lamports).toBe(expectedBounty)
  })

  it.each(playerCounts)('survival pot == 60%% of player pool for N=%d', (N) => {
    const seed = makeTestSeed(N)
    const { state, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const playerPool = totalPot - devFee
    const expectedSurvival = Math.trunc(playerPool * 0.60)

    expect(state.econ!.pots.survival_pot_lamports).toBe(expectedSurvival)
  })

  it.each(playerCounts)('per-kill schedule sums to bounty pot for N=%d', (N) => {
    const seed = makeTestSeed(N)
    const { state } = runV2Sim(seed, N)

    const schedule = state.econ!.perKillSchedule!
    const bountyPot = state.econ!.pots.bounty_pot_lamports

    expect(sumPerKillSchedule(schedule, N)).toBe(bountyPot)
  })
})

// =============================================================================
// Survival Split Tests
// =============================================================================

describe('v2_top3: Survival Split — Lobby < 4 (Top 2: 70/30)', () => {
  it('3-player lobby: 1st gets 70%, 2nd gets 30% of survival pot', () => {
    const N = 3
    const seed = makeTestSeed(700)
    const { state, players, entryLamports } = runV2Sim(seed, N)

    const survivalPot = state.econ!.pots.survival_pot_lamports

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)

    // P0 kills P2 (3 -> 2)
    awardKillV2(state, p0, p2)
    // P0 kills P1 (2 -> 1)
    awardKillV2(state, p0, p1)

    // Finalize
    finalizeIfNeeded(state, [p0])

    expect(state.econ!.finalized).toBe(true)

    // Check placements
    const p0Data = state.econ!.perPlayer[p0]
    const p1Data = state.econ!.perPlayer[p1]
    const p2Data = state.econ!.perPlayer[p2]

    expect(p0Data.placement).toBe(1)
    expect(p1Data.placement).toBe(2)
    expect(p2Data.placement).toBe(3)

    // Check survival awards
    const expected1st = Math.trunc(survivalPot * 0.70)
    const expected2nd = Math.trunc(survivalPot * 0.30)

    expect(p0Data.survival_earned).toBe(expected1st)
    expect(p1Data.survival_earned).toBe(expected2nd)
    expect(p2Data.survival_earned).toBe(0)
  })

  it('2-player lobby: 1st gets 70%, 2nd gets 30% of survival pot', () => {
    const N = 2
    const seed = makeTestSeed(701)
    const { state, players, entryLamports } = runV2Sim(seed, N)

    const survivalPot = state.econ!.pots.survival_pot_lamports

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)

    // P0 kills P1
    awardKillV2(state, p0, p1)

    finalizeIfNeeded(state, [p0])

    const p0Data = state.econ!.perPlayer[p0]
    const p1Data = state.econ!.perPlayer[p1]

    expect(p0Data.placement).toBe(1)
    expect(p1Data.placement).toBe(2)

    expect(p0Data.survival_earned).toBe(Math.trunc(survivalPot * 0.70))
    expect(p1Data.survival_earned).toBe(Math.trunc(survivalPot * 0.30))
  })
})

describe('v2_top3: Survival Split — Lobby >= 4 (Top 3: 65/25/10)', () => {
  it('4-player lobby: top 3 get 65/25/10 of survival pot', () => {
    const N = 4
    const seed = makeTestSeed(710)
    const { state, players } = runV2Sim(seed, N)

    const survivalPot = state.econ!.pots.survival_pot_lamports

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)
    const p3 = toHex(players[3].pubkey)

    // Kill order: P3 dies first, then P2, then P1
    awardKillV2(state, p0, p3)
    awardKillV2(state, p0, p2)
    awardKillV2(state, p0, p1)

    finalizeIfNeeded(state, [p0])

    expect(state.econ!.finalized).toBe(true)

    const p0Data = state.econ!.perPlayer[p0]
    const p1Data = state.econ!.perPlayer[p1]
    const p2Data = state.econ!.perPlayer[p2]
    const p3Data = state.econ!.perPlayer[p3]

    expect(p0Data.placement).toBe(1)
    expect(p1Data.placement).toBe(2)
    expect(p2Data.placement).toBe(3)
    expect(p3Data.placement).toBe(4)

    expect(p0Data.survival_earned).toBe(Math.trunc(survivalPot * 0.65))
    expect(p1Data.survival_earned).toBe(Math.trunc(survivalPot * 0.25))
    expect(p2Data.survival_earned).toBe(Math.trunc(survivalPot * 0.10))
    expect(p3Data.survival_earned).toBe(0)
  })

  it('8-player lobby: top 3 get 65/25/10 of survival pot', () => {
    const N = 8
    const seed = makeTestSeed(711)
    const { state, players } = runV2Sim(seed, N)

    const survivalPot = state.econ!.pots.survival_pot_lamports

    // Kill in reverse order: p7, p6, p5, p4, p3, p2, p1
    for (let i = N - 1; i >= 1; i--) {
      awardKillV2(state, toHex(players[0].pubkey), toHex(players[i].pubkey))
    }

    finalizeIfNeeded(state, [toHex(players[0].pubkey)])

    expect(state.econ!.finalized).toBe(true)

    const p0 = state.econ!.perPlayer[toHex(players[0].pubkey)]
    const p1 = state.econ!.perPlayer[toHex(players[1].pubkey)]
    const p2 = state.econ!.perPlayer[toHex(players[2].pubkey)]

    expect(p0.placement).toBe(1)
    expect(p1.placement).toBe(2)
    expect(p2.placement).toBe(3)

    expect(p0.survival_earned).toBe(Math.trunc(survivalPot * 0.65))
    expect(p1.survival_earned).toBe(Math.trunc(survivalPot * 0.25))
    expect(p2.survival_earned).toBe(Math.trunc(survivalPot * 0.10))

    // Players 3-7 get nothing
    for (let i = 3; i < N; i++) {
      const pData = state.econ!.perPlayer[toHex(players[i].pubkey)]
      expect(pData.survival_earned).toBe(0)
    }
  })
})

// =============================================================================
// No Inheritance Tests
// =============================================================================

describe('v2_top3: No Inheritance', () => {
  it('victim bounty stays with victim (no transfer to killer)', () => {
    const N = 4
    const seed = makeTestSeed(720)
    const { state, players } = runV2Sim(seed, N)

    const schedule = state.econ!.perKillSchedule!

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)

    // P0 kills P1 (earns schedule[4])
    awardKillV2(state, p0, p1)
    expect(state.econ!.perPlayer[p0].bounty_earned).toBe(schedule[4])

    // P2 kills P0 (earns schedule[3], should NOT inherit P0's bounty)
    awardKillV2(state, p2, p0)

    // P2 should only have schedule[3], NOT schedule[3] + schedule[4]
    expect(state.econ!.perPlayer[p2].bounty_earned).toBe(schedule[3])

    // P0's bounty should remain as schedule[4]
    expect(state.econ!.perPlayer[p0].bounty_earned).toBe(schedule[4])

    // No KillInheritance events
    const inheritanceEvents = state.econ!.events.filter((e: any) => e.type === 'KillInheritance')
    expect(inheritanceEvents.length).toBe(0)
  })
})

// =============================================================================
// No TP Tests
// =============================================================================

describe('v2_top3: No Take Profit', () => {
  it('TP targets are not set even if passed in config', () => {
    const N = 4
    const roster = makeRoster(N)
    const rosterHex = roster.map(toHex)
    const tpTargets: Record<string, number> = {}
    rosterHex.forEach((hex) => { tpTargets[hex] = lamports(0.005) })

    const seed = makeTestSeed(730)
    const { state } = runV2Sim(seed, N, tpTargets)

    // TP should be undefined for v2
    expect(state.econ!.tp_targets).toBeUndefined()
    expect(state.econ!.tp_presets_lamports).toBeUndefined()
  })

  it('no TPCashout events occur', () => {
    const N = 4
    const seed = makeTestSeed(731)
    const { state, players } = runV2Sim(seed, N)

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)

    awardKillV2(state, p0, p1)

    const tpEvents = state.econ!.events.filter((e: any) => e.type === 'TPCashout')
    expect(tpEvents.length).toBe(0)
  })
})

// =============================================================================
// Sum(payouts) == 85% Player Pool
// =============================================================================

describe('v2_top3: Total Payout Conservation', () => {
  const playerCounts = [2, 3, 4, 5, 8, 10]

  it.each(playerCounts)('sum(all payouts) == 85%% player pool for N=%d (all kills by one player)', (N) => {
    const seed = makeTestSeed(740 + N)
    const { state, players, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const expectedPlayerPool = totalPot - devFee

    const p0 = toHex(players[0].pubkey)

    // P0 kills everyone in reverse order
    for (let i = N - 1; i >= 1; i--) {
      awardKillV2(state, p0, toHex(players[i].pubkey))
    }

    // Finalize
    finalizeIfNeeded(state, [p0])

    // Sum all player earnings
    const totalDistributed = Object.values(state.econ!.perPlayer).reduce(
      (sum: number, p: any) => sum + (p.total_earned || 0),
      0
    )

    expect(totalDistributed).toBe(expectedPlayerPool)
    expect(state.econ!.bounty_remaining).toBe(0)
  })

  it('sum(payouts) == player pool when kills are distributed across players', () => {
    const N = 6
    const seed = makeTestSeed(750)
    const { state, players, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const expectedPlayerPool = totalPot - devFee

    const hexes = players.map(p => toHex(p.pubkey))

    // Mixed kill pattern: P0 kills P5, P1 kills P4, P0 kills P3, P1 kills P2, P0 kills P1
    awardKillV2(state, hexes[0], hexes[5])
    awardKillV2(state, hexes[1], hexes[4])
    awardKillV2(state, hexes[0], hexes[3])
    awardKillV2(state, hexes[1], hexes[2])
    awardKillV2(state, hexes[0], hexes[1])

    finalizeIfNeeded(state, [hexes[0]])

    const totalDistributed = Object.values(state.econ!.perPlayer).reduce(
      (sum: number, p: any) => sum + (p.total_earned || 0),
      0
    )

    expect(totalDistributed).toBe(expectedPlayerPool)
    expect(state.econ!.bounty_remaining).toBe(0)
  })

  it('sum(payouts) == player pool when no kills happen (all disconnect)', () => {
    const N = 4
    const seed = makeTestSeed(751)
    const { state, players, entryLamports } = runV2Sim(seed, N)

    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS_V2 / 10_000))
    const expectedPlayerPool = totalPot - devFee

    const p0 = toHex(players[0].pubkey)

    // Everyone disconnects except P0
    state.orbs.pop()
    state.orbs.pop()
    state.orbs.pop()

    finalizeIfNeeded(state, [p0])

    const totalDistributed = Object.values(state.econ!.perPlayer).reduce(
      (sum: number, p: any) => sum + (p.total_earned || 0),
      0
    )

    expect(totalDistributed).toBe(expectedPlayerPool)
  })
})

// =============================================================================
// Tiebreak / Placement Tests
// =============================================================================

describe('v2_top3: Tiebreak and Placement', () => {
  it('tiebreak uses framesAlive > kills > rosterIndex', () => {
    const N = 4
    const seed = makeTestSeed(760)
    const { state, players } = runV2Sim(seed, N)

    const hexes = players.map(p => toHex(p.pubkey))

    // Kill order determines framesAlive ranking
    // P3 dies first (least framesAlive), P2 dies second, P1 dies third
    awardKillV2(state, hexes[0], hexes[3])
    awardKillV2(state, hexes[0], hexes[2])
    awardKillV2(state, hexes[0], hexes[1])

    finalizeIfNeeded(state, [hexes[0]])

    // P0 survived longest, P1 second longest, P2 third, P3 last
    expect(state.econ!.perPlayer[hexes[0]].placement).toBe(1)
    expect(state.econ!.perPlayer[hexes[1]].placement).toBe(2)
    expect(state.econ!.perPlayer[hexes[2]].placement).toBe(3)
    expect(state.econ!.perPlayer[hexes[3]].placement).toBe(4)
  })

  it('placement is deterministic across runs', () => {
    const N = 5
    const seed = makeTestSeed(761)

    // Run 1
    const { state: state1, players: players1 } = runV2Sim(seed, N)
    const hexes1 = players1.map(p => toHex(p.pubkey))
    for (let i = N - 1; i >= 1; i--) awardKillV2(state1, hexes1[0], hexes1[i])
    finalizeIfNeeded(state1, [hexes1[0]])

    // Run 2
    const { state: state2, players: players2 } = runV2Sim(seed, N)
    const hexes2 = players2.map(p => toHex(p.pubkey))
    for (let i = N - 1; i >= 1; i--) awardKillV2(state2, hexes2[0], hexes2[i])
    finalizeIfNeeded(state2, [hexes2[0]])

    // Same placements
    for (let i = 0; i < N; i++) {
      expect(state1.econ!.perPlayer[hexes1[i]].placement)
        .toBe(state2.econ!.perPlayer[hexes2[i]].placement)
    }

    // Same payouts
    for (let i = 0; i < N; i++) {
      expect(state1.econ!.perPlayer[hexes1[i]].total_earned)
        .toBe(state2.econ!.perPlayer[hexes2[i]].total_earned)
    }
  })
})

// =============================================================================
// Finalization Edge Cases
// =============================================================================

describe('v2_top3: Finalization Edge Cases', () => {
  it('finalization is idempotent', () => {
    const N = 3
    const seed = makeTestSeed(770)
    const { state, players } = runV2Sim(seed, N)

    const p0 = toHex(players[0].pubkey)
    awardKillV2(state, p0, toHex(players[2].pubkey))
    awardKillV2(state, p0, toHex(players[1].pubkey))

    finalizeIfNeeded(state, [p0])
    const total1 = state.econ!.perPlayer[p0].total_earned

    finalizeIfNeeded(state, [p0])
    const total2 = state.econ!.perPlayer[p0].total_earned

    expect(total2).toBe(total1)
  })

  it('remaining bounty goes to 1st place', () => {
    const N = 5
    const seed = makeTestSeed(771)
    const { state, players } = runV2Sim(seed, N)

    const schedule = state.econ!.perKillSchedule!
    const p0 = toHex(players[0].pubkey)

    // Only 2 kills, then everyone else disconnects
    awardKillV2(state, p0, toHex(players[4].pubkey))
    awardKillV2(state, p0, toHex(players[3].pubkey))

    const remainingBounty = state.econ!.bounty_remaining

    // Others disconnect
    state.orbs.pop()
    state.orbs.pop()

    finalizeIfNeeded(state, [p0])

    // P0 (1st place) should get the remaining bounty added to bounty_earned
    const p0KillBounty = schedule[5] + schedule[4]
    expect(state.econ!.perPlayer[p0].bounty_earned).toBe(p0KillBounty + remainingBounty)
    expect(state.econ!.bounty_remaining).toBe(0)
  })
})
