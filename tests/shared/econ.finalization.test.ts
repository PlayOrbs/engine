import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { applyTPPresetsToTargets, sumPerKillSchedule, finalizeIfNeeded } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed, buildJoinMapWithPresets } from './test-helpers.js'
import { toHex } from '../../src/utils/utils.js'

/**
 * Tests for game finalization logic
 * 
 * Verifies:
 * 1. Winner receives survival pot + remaining bounty
 * 2. All player pool funds are distributed (no funds lost)
 * 3. Finalization is idempotent (calling twice doesn't double-award)
 * 4. TP cashouts don't cause fund leakage
 */

const ENTRY_SOL = 0.01
const DEV_FEE_BPS = 2000
const LAMPORTS_PER_SOL = 1_000_000_000

function lamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}

function runDeterministicSim(seed: Uint8Array, N: number, tpPresets?: Record<number, 'safe' | 'balanced' | 'fierce' | 'yolo'>) {
  const entryLamports = lamports(ENTRY_SOL)
  const cfg = makeTestConfig(N, entryLamports, 'paid', undefined)
  const players = makePlayers(N)

  const { state } = initFromSeed(seed, players, cfg)

  if (tpPresets) {
    const joinMap = buildJoinMapWithPresets(N, tpPresets)
    applyTPPresetsToTargets(state, joinMap)
  }

  return { state, players }
}

/**
 * Award a kill and update bounty_remaining properly
 * This simulates the actual engine behavior
 */
function awardKillWithBountyTracking(state: any, killerHex: string, victimHex: string) {
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
    const payout = Math.min(perKillSchedule[alive], state.econ.bounty_remaining || 0)
    if (payout > 0) {
      killerData.bounty_earned = (killerData.bounty_earned || 0) + payout
      state.econ.bounty_remaining -= payout
    }

    // Inherit victim's uncashed bounty (zero-sum) for weighted_kill_v2_inherit
    if (state.econ.header.economy_model === 'weighted_kill_v2_inherit') {
      const victimBounty = victimData.bounty_earned || 0
      const victimCashed = victimData.cashed_bounty || 0
      const uncashedBounty = victimBounty - victimCashed

      if (uncashedBounty > 0) {
        killerData.bounty_earned += uncashedBounty
        victimData.bounty_earned -= uncashedBounty
      }
    }
  }

  // Update total earned
  killerData.total_earned = (killerData.bounty_earned || 0) + (killerData.survival_earned || 0)

  // Remove orb
  if (state.orbs.length > 0) {
    state.orbs.pop()
  }
}

describe('Game Finalization: Remaining Bounty Distribution', () => {
  it('winner receives survival pot + remaining bounty when game ends normally', () => {
    const N = 4
    const seed = makeTestSeed(600)
    const { state, players } = runDeterministicSim(seed, N)

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const survivalPot = state.econ!.pots.survival_pot_lamports
    const schedule = state.econ!.perKillSchedule!

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)
    const p3 = toHex(players[3].pubkey)

    // P0 kills P1 (4 alive -> 3 alive)
    awardKillWithBountyTracking(state, p0, p1)
    // P0 kills P2 (3 alive -> 2 alive)
    awardKillWithBountyTracking(state, p0, p2)
    // P0 kills P3 (2 alive -> 1 alive, game ends)
    awardKillWithBountyTracking(state, p0, p3)

    // Finalize the game
    finalizeIfNeeded(state, [p0])

    const p0Data = state.econ!.perPlayer[p0]

    // P0's bounty should be schedule[4] + schedule[3] + schedule[2]
    const expectedBounty = schedule[4] + schedule[3] + schedule[2]
    expect(p0Data.bounty_earned).toBe(expectedBounty)

    // Remaining bounty should be 0 (all distributed)
    expect(state.econ!.bounty_remaining).toBe(0)

    // P0's survival should include survival pot (remaining bounty is 0 in this case)
    expect(p0Data.survival_earned).toBe(survivalPot)

    // Total earned should be bounty + survival
    expect(p0Data.total_earned).toBe(expectedBounty + survivalPot)
  })

  it('winner receives remaining bounty when kills are incomplete', () => {
    const N = 5
    const seed = makeTestSeed(601)
    const { state, players } = runDeterministicSim(seed, N)

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const survivalPot = state.econ!.pots.survival_pot_lamports
    const schedule = state.econ!.perKillSchedule!

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)
    const p3 = toHex(players[3].pubkey)
    const p4 = toHex(players[4].pubkey)

    // Only 2 kills happen (not all bounty distributed)
    // P0 kills P1 (5 alive -> 4 alive)
    awardKillWithBountyTracking(state, p0, p1)
    // P0 kills P2 (4 alive -> 3 alive)
    awardKillWithBountyTracking(state, p0, p2)

    // Simulate remaining players leaving (P3, P4 disconnect)
    state.orbs.pop() // P3 leaves
    state.orbs.pop() // P4 leaves

    // Now only P0 remains
    const remainingBountyBefore = state.econ!.bounty_remaining

    // Finalize the game
    finalizeIfNeeded(state, [p0])

    const p0Data = state.econ!.perPlayer[p0]

    // P0's bounty should be schedule[5] + schedule[4]
    const expectedBounty = schedule[5] + schedule[4]
    expect(p0Data.bounty_earned).toBe(expectedBounty)

    // Remaining bounty was schedule[3] + schedule[2] - now awarded to winner
    const expectedRemainingBounty = schedule[3] + schedule[2]
    expect(remainingBountyBefore).toBe(expectedRemainingBounty)

    // After finalization, remaining bounty should be 0
    expect(state.econ!.bounty_remaining).toBe(0)

    // P0's survival should include survival pot + remaining bounty
    expect(p0Data.survival_earned).toBe(survivalPot + expectedRemainingBounty)
  })

  it('all player pool funds are distributed (no fund leakage)', () => {
    const N = 5
    const seed = makeTestSeed(602)
    const { state, players } = runDeterministicSim(seed, N)

    const entryLamports = lamports(ENTRY_SOL)
    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS / 10_000))
    const playerPool = totalPot - devFee

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)

    // Some kills happen
    awardKillWithBountyTracking(state, p0, p1)
    awardKillWithBountyTracking(state, p2, toHex(players[3].pubkey))

    // Simulate game ending with P0 and P2 remaining, P0 wins
    state.orbs.pop() // P2 leaves

    // Finalize
    finalizeIfNeeded(state, [p0])

    // Sum all player earnings
    const totalDistributed = Object.values(state.econ!.perPlayer).reduce(
      (sum: number, p: any) => sum + (p.total_earned || 0),
      0
    )

    // All player pool funds should be distributed
    expect(totalDistributed).toBe(playerPool)
    expect(state.econ!.bounty_remaining).toBe(0)
  })

  it('finalization is idempotent (calling twice does not double-award)', () => {
    const N = 3
    const seed = makeTestSeed(603)
    const { state, players } = runDeterministicSim(seed, N)

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)

    // P0 kills everyone
    awardKillWithBountyTracking(state, p0, p1)
    awardKillWithBountyTracking(state, p0, p2)

    // Finalize once
    finalizeIfNeeded(state, [p0])
    const totalAfterFirst = state.econ!.perPlayer[p0].total_earned

    // Finalize again (should be no-op)
    finalizeIfNeeded(state, [p0])
    const totalAfterSecond = state.econ!.perPlayer[p0].total_earned

    expect(totalAfterSecond).toBe(totalAfterFirst)
    expect(state.econ!.finalized).toBe(true)
  })
})

describe('Game Finalization: TP Cashout Scenarios', () => {
  it('TP cashout does not cause fund leakage', () => {
    const N = 4
    const seed = makeTestSeed(610)
    const { state, players } = runDeterministicSim(seed, N, { 0: 'safe' })

    const entryLamports = lamports(ENTRY_SOL)
    const totalPot = entryLamports * N
    const devFee = Math.trunc(totalPot * (DEV_FEE_BPS / 10_000))
    const playerPool = totalPot - devFee

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)
    const p3 = toHex(players[3].pubkey)

    // P0 kills P1 (may trigger TP)
    awardKillWithBountyTracking(state, p0, p1)
    // P0 kills P2
    awardKillWithBountyTracking(state, p0, p2)

    // P0 triggers TP and leaves, P3 wins by default
    if (state.econ!.tp_triggered?.has(p0)) {
      state.orbs.pop() // P0 leaves after TP
      finalizeIfNeeded(state, [p3])
    } else {
      // P0 kills P3 and wins
      awardKillWithBountyTracking(state, p0, p3)
      finalizeIfNeeded(state, [p0])
    }

    // Sum all player earnings
    const totalDistributed = Object.values(state.econ!.perPlayer).reduce(
      (sum: number, p: any) => sum + (p.total_earned || 0),
      0
    )

    // All player pool funds should be distributed
    expect(totalDistributed).toBe(playerPool)
  })

  it('winner gets remaining bounty after TP player leaves', () => {
    const N = 4
    const seed = makeTestSeed(611)
    const { state, players } = runDeterministicSim(seed, N, { 0: 'safe', 1: 'safe' })

    const survivalPot = state.econ!.pots.survival_pot_lamports

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)
    const p2 = toHex(players[2].pubkey)
    const p3 = toHex(players[3].pubkey)

    // P0 kills P2 (may trigger TP for P0)
    awardKillWithBountyTracking(state, p0, p2)
    // P1 kills P3 (may trigger TP for P1)
    awardKillWithBountyTracking(state, p1, p3)

    // Both P0 and P1 may have triggered TP
    // Simulate both leaving, no one wins normally
    // In this case, the last remaining player should get remaining bounty

    const remainingBountyBefore = state.econ!.bounty_remaining

    // P0 leaves (TP or disconnect)
    state.orbs.pop()

    // P1 is the winner
    finalizeIfNeeded(state, [p1])

    const p1Data = state.econ!.perPlayer[p1]

    // P1 should get survival pot + remaining bounty
    expect(p1Data.survival_earned).toBe(survivalPot + remainingBountyBefore)
    expect(state.econ!.bounty_remaining).toBe(0)
  })
})

describe('Game Finalization: Edge Cases', () => {
  it('handles 2 player game correctly', () => {
    const N = 2
    const seed = makeTestSeed(620)
    const { state, players } = runDeterministicSim(seed, N)

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const survivalPot = state.econ!.pots.survival_pot_lamports
    const schedule = state.econ!.perKillSchedule!

    const p0 = toHex(players[0].pubkey)
    const p1 = toHex(players[1].pubkey)

    // P0 kills P1 (only kill possible)
    awardKillWithBountyTracking(state, p0, p1)

    // Finalize
    finalizeIfNeeded(state, [p0])

    const p0Data = state.econ!.perPlayer[p0]

    // P0 gets all bounty (schedule[2] = entire bounty pot)
    expect(p0Data.bounty_earned).toBe(schedule[2])
    expect(schedule[2]).toBe(bountyPot)

    // P0 gets survival pot (no remaining bounty since all distributed)
    expect(p0Data.survival_earned).toBe(survivalPot)

    // Total should be bounty + survival
    expect(p0Data.total_earned).toBe(bountyPot + survivalPot)
  })

  it('handles game where no kills happen (all disconnect except winner)', () => {
    const N = 4
    const seed = makeTestSeed(621)
    const { state, players } = runDeterministicSim(seed, N)

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const survivalPot = state.econ!.pots.survival_pot_lamports

    const p0 = toHex(players[0].pubkey)

    // No kills - all other players disconnect
    state.orbs.pop()
    state.orbs.pop()
    state.orbs.pop()

    // P0 is the only one left
    finalizeIfNeeded(state, [p0])

    const p0Data = state.econ!.perPlayer[p0]

    // P0 gets no bounty from kills
    expect(p0Data.bounty_earned).toBe(0)

    // P0 gets survival pot + entire remaining bounty
    expect(p0Data.survival_earned).toBe(survivalPot + bountyPot)

    // Total should be entire player pool
    expect(p0Data.total_earned).toBe(bountyPot + survivalPot)

    // No bounty remaining
    expect(state.econ!.bounty_remaining).toBe(0)
  })
})
