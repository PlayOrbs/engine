import { describe, it, expect } from 'vitest'
import { initFromSeed, advanceFrame } from '../src/core/v1/sim.js'
import { makeTestConfig, makePlayers, makeTestSeed } from './test-helpers.js'
import { toHex } from '../src/utils/utils.js'

/**
 * Tests for ranking consistency
 * 
 * Verifies that:
 * 1. econ.perPlayer.framesAlive matches the actual winner determination
 * 2. The player with highest framesAlive is rank 1
 * 3. Rankings are consistent with econ.winner_id after finalization
 */

const ENTRY_SOL = 0.01
const LAMPORTS_PER_SOL = 1_000_000_000

function lamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}

/**
 * Run simulation to completion and return final state
 */
function runFullSimulation(seed: Uint8Array, N: number) {
  const entryLamports = lamports(ENTRY_SOL)
  const cfg = makeTestConfig(N, entryLamports, 'paid', undefined)
  const players = makePlayers(N)

  const { state, prngs } = initFromSeed(seed, players, cfg)

  const maxFrames = 120 * 60 * 2 // 2 minutes max
  while (state.orbs.length > 1 && state.frame < maxFrames) {
    advanceFrame(state, cfg, prngs)
  }

  return { state, players, cfg }
}

/**
 * Extract rankings from econ.perPlayer (same logic as engine-runner)
 */
function extractRankingsFromEcon(state: any, players: any[]): Array<{
  player: string
  framesAlive: number
  kills: number
  rank: number
}> {
  const rankings: Array<{
    player: string
    framesAlive: number
    kills: number
    rank: number
  }> = []

  for (const p of players) {
    const fullHex = toHex(p.pubkey)
    const econData = state.econ?.perPlayer?.[fullHex]

    rankings.push({
      player: fullHex,
      framesAlive: econData?.framesAlive ?? 0,
      kills: econData?.kills ?? 0,
      rank: 0,
    })
  }

  // Sort by framesAlive descending, then kills, then roster index
  rankings.sort((a, b) => {
    if (b.framesAlive !== a.framesAlive) {
      return b.framesAlive - a.framesAlive
    }
    if (b.kills !== a.kills) {
      return b.kills - a.kills
    }
    const aIdx = players.findIndex((p: any) => toHex(p.pubkey) === a.player)
    const bIdx = players.findIndex((p: any) => toHex(p.pubkey) === b.player)
    return aIdx - bIdx
  })

  // Assign ranks
  rankings.forEach((r, i) => {
    r.rank = i + 1
  })

  return rankings
}

describe('Ranking Consistency: econ.perPlayer.framesAlive matches winner', () => {
  it('rank 1 player has highest framesAlive', () => {
    const seed = makeTestSeed(100)
    const { state, players } = runFullSimulation(seed, 3)

    const rankings = extractRankingsFromEcon(state, players)

    // Rank 1 should have highest framesAlive
    const rank1 = rankings.find(r => r.rank === 1)!
    const rank2 = rankings.find(r => r.rank === 2)!
    const rank3 = rankings.find(r => r.rank === 3)!

    expect(rank1.framesAlive).toBeGreaterThanOrEqual(rank2.framesAlive)
    expect(rank2.framesAlive).toBeGreaterThanOrEqual(rank3.framesAlive)
  })

  it('econ.winner_id matches rank 1 player after finalization', () => {
    const seed = makeTestSeed(101)
    const { state, players } = runFullSimulation(seed, 4)

    // Game should be finalized
    expect(state.econ?.finalized).toBe(true)

    const rankings = extractRankingsFromEcon(state, players)
    const rank1 = rankings.find(r => r.rank === 1)!

    // winner_id should match rank 1
    expect(state.econ?.winner_id).toBe(rank1.player)
  })

  it('surviving player (orbs.length === 1) is rank 1', () => {
    const seed = makeTestSeed(102)
    const { state, players } = runFullSimulation(seed, 3)

    // Should have exactly 1 orb remaining
    expect(state.orbs.length).toBe(1)

    const survivorHex = toHex(state.orbs[0].owner)
    const rankings = extractRankingsFromEcon(state, players)
    const rank1 = rankings.find(r => r.rank === 1)!

    // Survivor should be rank 1
    expect(rank1.player).toBe(survivorHex)
  })

  it('rankings are deterministic across multiple runs', () => {
    const seed = makeTestSeed(103)

    // Run simulation twice with same seed
    const run1 = runFullSimulation(seed, 4)
    const run2 = runFullSimulation(seed, 4)

    const rankings1 = extractRankingsFromEcon(run1.state, run1.players)
    const rankings2 = extractRankingsFromEcon(run2.state, run2.players)

    // Rankings should be identical
    expect(rankings1.length).toBe(rankings2.length)
    for (let i = 0; i < rankings1.length; i++) {
      expect(rankings1[i].player).toBe(rankings2[i].player)
      expect(rankings1[i].rank).toBe(rankings2[i].rank)
      expect(rankings1[i].framesAlive).toBe(rankings2[i].framesAlive)
      expect(rankings1[i].kills).toBe(rankings2[i].kills)
    }
  })

  it('all players have framesAlive > 0 after simulation', () => {
    const seed = makeTestSeed(104)
    const { state, players } = runFullSimulation(seed, 5)

    const rankings = extractRankingsFromEcon(state, players)

    // All players should have participated (framesAlive > 0)
    for (const r of rankings) {
      expect(r.framesAlive).toBeGreaterThan(0)
    }
  })

  it('total_earned is highest for rank 1 (winner gets survival pot)', () => {
    const seed = makeTestSeed(105)
    const { state, players } = runFullSimulation(seed, 3)

    const rankings = extractRankingsFromEcon(state, players)
    const rank1Hex = rankings.find(r => r.rank === 1)!.player

    // Get total_earned for each player
    const earnings = rankings.map(r => ({
      rank: r.rank,
      totalEarned: state.econ?.perPlayer?.[r.player]?.total_earned ?? 0,
    }))

    // Rank 1 should have highest earnings (gets survival pot)
    const rank1Earnings = earnings.find(e => e.rank === 1)!.totalEarned
    for (const e of earnings) {
      if (e.rank !== 1) {
        expect(rank1Earnings).toBeGreaterThanOrEqual(e.totalEarned)
      }
    }
  })
})

describe('Ranking Consistency: Edge Cases', () => {
  it('handles 2-player game correctly', () => {
    const seed = makeTestSeed(200)
    const { state, players } = runFullSimulation(seed, 2)

    const rankings = extractRankingsFromEcon(state, players)

    expect(rankings.length).toBe(2)
    expect(rankings[0].rank).toBe(1)
    expect(rankings[1].rank).toBe(2)
    expect(rankings[0].framesAlive).toBeGreaterThan(rankings[1].framesAlive)
  })

  it('tie-break by kills when framesAlive is equal', () => {
    // This is a synthetic test - in practice framesAlive rarely ties
    // But the logic should handle it
    const seed = makeTestSeed(201)
    const { state, players } = runFullSimulation(seed, 3)

    const rankings = extractRankingsFromEcon(state, players)

    // Verify sorting is stable and correct
    for (let i = 0; i < rankings.length - 1; i++) {
      const curr = rankings[i]
      const next = rankings[i + 1]

      if (curr.framesAlive === next.framesAlive) {
        // If framesAlive ties, higher kills should be ranked higher
        expect(curr.kills).toBeGreaterThanOrEqual(next.kills)
      }
    }
  })
})
