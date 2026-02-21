import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { applyTPPresetsToTargets } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed, buildJoinMapWithPresets, awardKill } from './test-helpers.js'
import { toHex } from '../../src/utils/utils.js'

describe('Inheritance + TP Interplay', () => {
  describe('Inheritance Without TP', () => {
    it('should inherit uncashed bounty from victim', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(1)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)

      // Player 0 kills player 1
      awardKill(state, player0Hex, player1Hex, cfg)

      const player1Bounty = state.econ!.perPlayer[player1Hex].bounty_earned

      // Player 2 kills player 0 (who has uncashed bounty)
      awardKill(state, player2Hex, player0Hex, cfg)

      const player2Data = state.econ!.perPlayer[player2Hex]

      // Player 2 should have inherited player 0's uncashed bounty
      // (player1Bounty was never cashed by player 0)
      expect(player2Data.bounty_earned).toBeGreaterThan(state.econ!.perKillSchedule![N])
    })
  })

  describe('Inheritance With TP', () => {
    it('should not inherit cashed bounty after TP trigger', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(2)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Player 0 has TP enabled (safe preset)
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)

      // Player 0 kills player 1
      awardKill(state, player0Hex, player1Hex, cfg)

      // If TP triggered, bounty was cashed
      const tpTriggered = state.econ!.tp_triggered?.has(player0Hex) || false
      const player0Data = state.econ!.perPlayer[player0Hex]
      const cashedBounty = player0Data.bounty_cashed || 0

      // Player 2 kills player 0
      awardKill(state, player2Hex, player0Hex, cfg)

      const player2Data = state.econ!.perPlayer[player2Hex]

      if (tpTriggered && cashedBounty > 0) {
        // Inheritance should be reduced by cashed amount
        const expectedInheritance = player0Data.bounty_earned - cashedBounty
        const player2BaseKill = state.econ!.perKillSchedule![N]

        // Player 2's bounty = base kill + inherited uncashed bounty
        const expectedTotal = player2BaseKill + expectedInheritance
        expect(player2Data.bounty_earned).toBe(expectedTotal)
      }
    })

    it('should inherit full bounty if TP never triggered', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(3)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Player 0 has TP enabled (yolo preset - high threshold)
      const joinMap = buildJoinMapWithPresets(N, { 0: 'yolo' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)

      // Player 0 kills player 1 (likely won't trigger yolo)
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0DataAfterKill = { ...state.econ!.perPlayer[player0Hex] }
      const tpTriggered = state.econ!.tp_triggered?.has(player0Hex) || false

      // Player 2 kills player 0
      awardKill(state, player2Hex, player0Hex, cfg)

      const player2Data = state.econ!.perPlayer[player2Hex]

      if (!tpTriggered) {
        // Player 2 should inherit full bounty (no cash-out)
        // Player 0's bounty after the first kill (before being killed)
        const player0Bounty = player0DataAfterKill.bounty_earned
        const player0Cashed = player0DataAfterKill.cashed_bounty || 0
        const uncashed = player0Bounty - player0Cashed

        // Player 2 gets base kill + uncashed inheritance
        const player2BaseKill = state.econ!.perKillSchedule![N - 1] // One player already dead
        const expectedMinimum = player2BaseKill + uncashed

        expect(player2Data.bounty_earned).toBeGreaterThanOrEqual(expectedMinimum)
      }
    })

    it('should maintain no-minting invariant with inheritance and TP', () => {
      const N = 6
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(4)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Multiple players with TP
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'balanced',
      })
      applyTPPresetsToTargets(state, joinMap)

      const bountyPot = state.econ!.pots.bounty_pot_lamports

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      // Series of kills
      awardKill(state, player0Hex, player2Hex, cfg)
      awardKill(state, player1Hex, player3Hex, cfg)

      // Sum all earned bounty
      let totalEarned = 0
      for (const playerHex of Object.keys(state.econ!.perPlayer)) {
        totalEarned += state.econ!.perPlayer[playerHex].bounty_earned || 0
      }

      // Total earned should never exceed bounty pot (no minting)
      expect(totalEarned).toBeLessThanOrEqual(bountyPot)
    })
  })

  describe('Chain Inheritance', () => {
    it('should handle multi-hop inheritance with TP', () => {
      const N = 5
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(5)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Player 0 has safe TP
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      // Chain: P0 kills P1 → P2 kills P0 → P3 kills P2
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0DataAfterFirstKill = { ...state.econ!.perPlayer[player0Hex] }

      awardKill(state, player2Hex, player0Hex, cfg)

      const player2DataAfterSecondKill = { ...state.econ!.perPlayer[player2Hex] }

      awardKill(state, player3Hex, player2Hex, cfg)

      const player3Data = state.econ!.perPlayer[player3Hex]

      // Player 3 should have accumulated bounty from the chain
      // (minus any cashed amounts)
      expect(player3Data.bounty_earned).toBeGreaterThan(0)
    })

    it('should correctly compute uncashed inheritance across multiple kills', () => {
      const N = 6
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(6)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Players 0 and 1 have TP
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'balanced',
      })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)
      const player4Hex = toHex(players[4].pubkey)

      // Complex kill sequence
      awardKill(state, player0Hex, player2Hex, cfg) // P0 kills P2
      awardKill(state, player1Hex, player3Hex, cfg) // P1 kills P3
      awardKill(state, player4Hex, player0Hex, cfg) // P4 kills P0

      const player0Data = state.econ!.perPlayer[player0Hex]
      const player4Data = state.econ!.perPlayer[player4Hex]

      // Calculate expected inheritance
      const player0Cashed = player0Data.bounty_cashed || 0
      const player0Uncashed = player0Data.bounty_earned - player0Cashed

      // Player 4's bounty should include uncashed portion from P0
      const player4BaseKill = state.econ!.perKillSchedule![N - 2] // 2 players already dead
      const expectedMinimum = player4BaseKill + player0Uncashed

      expect(player4Data.bounty_earned).toBeGreaterThanOrEqual(expectedMinimum)
    })
  })

  describe('Zero-Sum Validation', () => {
    it('should maintain zero-sum with TP cashing and inheritance', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(7)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Half the players have TP
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'balanced',
        2: 'fierce',
        3: 'yolo',
      })
      applyTPPresetsToTargets(state, joinMap)

      const bountyPot = state.econ!.pots.bounty_pot_lamports

      // Series of kills
      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)
      const player4Hex = toHex(players[4].pubkey)
      const player5Hex = toHex(players[5].pubkey)

      awardKill(state, player0Hex, player4Hex, cfg)
      awardKill(state, player1Hex, player5Hex, cfg)
      awardKill(state, player2Hex, player0Hex, cfg)
      awardKill(state, player3Hex, player1Hex, cfg)

      // Calculate total distributed bounty (earned - uncashed)
      let totalDistributed = 0
      let totalCashed = 0

      for (const playerHex of Object.keys(state.econ!.perPlayer)) {
        const playerData = state.econ!.perPlayer[playerHex]
        totalDistributed += playerData.bounty_earned || 0
        totalCashed += playerData.bounty_cashed || 0
      }

      // Total earned should not exceed bounty pot
      expect(totalDistributed).toBeLessThanOrEqual(bountyPot)

      // Cashed amounts should be subtracted from circulation (inheritance pool)
      // But total earned across all players should still respect the pot limit
      expect(totalCashed).toBeLessThanOrEqual(totalDistributed)
    })
  })

  describe('Edge Cases with Inheritance and TP', () => {
    it('should handle victim with zero bounty', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(8)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      // Player 0 kills player 1 who has no bounty yet
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0Data = state.econ!.perPlayer[player0Hex]

      // Should get base kill value only
      const baseKill = state.econ!.perKillSchedule![N]
      expect(player0Data.bounty_earned).toBe(baseKill)
    })

    it('should handle victim with fully cashed bounty', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(9)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Player 0 has TP
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)

      // Player 0 kills player 1 (may trigger TP and cash out)
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0Data = state.econ!.perPlayer[player0Hex]
      const tpTriggered = state.econ!.tp_triggered?.has(player0Hex)

      if (tpTriggered && player0Data.bounty_cashed === player0Data.bounty_earned) {
        // Player 0 has fully cashed bounty
        // Player 2 kills player 0
        awardKill(state, player2Hex, player0Hex, cfg)

        const player2Data = state.econ!.perPlayer[player2Hex]

        // Player 2 should get base kill only (no inheritance)
        const baseKill = state.econ!.perKillSchedule![N - 1]
        expect(player2Data.bounty_earned).toBe(baseKill)
      }
    })
  })
})
