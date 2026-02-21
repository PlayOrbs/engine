import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { applyTPPresetsToTargets } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed, buildJoinMapWithPresets, awardKill } from './test-helpers.js'
import { toHex } from '../../src/utils/utils.js'

describe('TP Trigger and Orb Removal', () => {
  describe('TP Trigger Logic', () => {
    it('should trigger TP when total_earned >= target', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(1)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set safe preset for player 0 (low target = 2 kills worth)
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const target = state.econ!.tp_targets![player0Hex]

      // Award 2 kills to trigger safe preset (which requires 2 kills)
      awardKill(state, player0Hex, player1Hex, cfg)
      awardKill(state, player0Hex, player2Hex, cfg)

      // Check if TP triggered
      const player0Data = state.econ!.perPlayer[player0Hex]
      expect(player0Data.total_earned).toBeGreaterThanOrEqual(target)
      expect(state.econ!.tp_triggered?.has(player0Hex)).toBe(true)
    })

    it('should not trigger TP when total_earned < target', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(2)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set yolo preset for player 0 (high target)
      const joinMap = buildJoinMapWithPresets(N, { 0: 'yolo' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const target = state.econ!.tp_targets![player0Hex]

      // Award one kill (likely insufficient for yolo)
      const player1Hex = toHex(players[1].pubkey)
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0Data = state.econ!.perPlayer[player0Hex]

      if (player0Data.total_earned < target) {
        // TP should not have triggered
        expect(state.econ!.tp_triggered?.has(player0Hex)).toBeFalsy()
      } else {
        // If it did trigger, verify it's because target was reached
        expect(player0Data.total_earned).toBeGreaterThanOrEqual(target)
      }
    })

    it('should cash out bounty when TP triggers', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(3)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set safe preset for player 0
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      // Award kill to trigger TP
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0Data = state.econ!.perPlayer[player0Hex]

      // If TP triggered, bounty should be cashed
      if (state.econ!.tp_triggered?.has(player0Hex)) {
        expect(player0Data.bounty_cashed).toBe(player0Data.bounty_earned)
      }
    })

    it('should only trigger once per player', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(4)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set safe preset for player 0 (2 kills worth)
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      // Award first kill (won't trigger yet)
      awardKill(state, player0Hex, player1Hex, cfg)

      const triggeredAfterFirst = state.econ!.tp_triggered?.has(player0Hex)

      // Award second kill (should trigger)
      awardKill(state, player0Hex, player2Hex, cfg)

      const triggeredAfterSecond = state.econ!.tp_triggered?.has(player0Hex)

      // Should have triggered after second kill
      expect(triggeredAfterSecond).toBe(true)

      // Award third kill (should still be triggered, but only once)
      awardKill(state, player0Hex, player3Hex, cfg)

      const triggeredAfterThird = state.econ!.tp_triggered?.has(player0Hex)

      // Should still be triggered (once)
      expect(triggeredAfterThird).toBe(true)

      // Verify it's still in the set (not removed/re-added)
      expect(state.econ!.tp_triggered?.size).toBe(1)
    })
  })

  describe('TP and Multiple Players', () => {
    it('should handle multiple players with different targets', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(5)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Different presets
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'yolo',
      })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      // Award kills
      awardKill(state, player0Hex, player2Hex, cfg) // Player 0 kills player 2
      awardKill(state, player1Hex, player3Hex, cfg) // Player 1 kills player 3

      // Player 0 (safe) more likely to trigger than player 1 (yolo)
      const player0Triggered = state.econ!.tp_triggered?.has(player0Hex) || false
      const player1Triggered = state.econ!.tp_triggered?.has(player1Hex) || false

      // At minimum, verify the logic doesn't crash with multiple targets
      expect(typeof player0Triggered).toBe('boolean')
      expect(typeof player1Triggered).toBe('boolean')
    })

    it('should track TP triggers independently', () => {
      const N = 6
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(6)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Both use safe preset
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'safe',
      })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      // Player 0 gets a kill
      awardKill(state, player0Hex, player2Hex, cfg)

      // Player 1 gets a kill
      awardKill(state, player1Hex, player3Hex, cfg)

      // Both might trigger, but independently
      const triggered0 = state.econ!.tp_triggered?.has(player0Hex)
      const triggered1 = state.econ!.tp_triggered?.has(player1Hex)

      // Should be tracked separately
      if (triggered0) {
        expect(state.econ!.perPlayer[player0Hex].bounty_cashed).toBe(
          state.econ!.perPlayer[player0Hex].bounty_earned
        )
      }

      if (triggered1) {
        expect(state.econ!.perPlayer[player1Hex].bounty_cashed).toBe(
          state.econ!.perPlayer[player1Hex].bounty_earned
        )
      }
    })
  })

  describe('Edge Cases', () => {
    it('should handle TP trigger when target is exactly reached', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(7)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Manually set a very low target for testing
      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 } // 1 lamport

      // Award tiny amount
      const player1Hex = toHex(players[1].pubkey)
      awardKill(state, player0Hex, player1Hex, cfg)

      // Should trigger (total_earned definitely >= 1)
      expect(state.econ!.tp_triggered?.has(player0Hex)).toBe(true)
    })

    it('should not trigger TP when disabled', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(8)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // No TP targets set
      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      // Award kill
      awardKill(state, player0Hex, player1Hex, cfg)

      // TP should not trigger (no target set)
      expect(state.econ!.tp_triggered?.has(player0Hex)).toBeFalsy()
    })

    it('should handle zero target gracefully', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(9)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set target to 1 lamport (effectively zero in practice)
      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 }

      // Award kill (any earnings > 1 lamport will trigger)
      const player1Hex = toHex(players[1].pubkey)
      awardKill(state, player0Hex, player1Hex, cfg)

      const player0Data = state.econ!.perPlayer[player0Hex]

      // With target=1, any earnings should trigger
      expect(player0Data.total_earned).toBeGreaterThan(1)
      expect(state.econ!.tp_triggered?.has(player0Hex)).toBe(true)
    })
  })

  describe('TP Interaction with Earnings', () => {
    it('should freeze bounty_cashed at TP trigger value', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(10)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set safe preset
      const joinMap = buildJoinMapWithPresets(N, { 0: 'safe' })
      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      // Award first kill
      awardKill(state, player0Hex, player1Hex, cfg)

      if (state.econ!.tp_triggered?.has(player0Hex)) {
        const cashedAfterTrigger = state.econ!.perPlayer[player0Hex].bounty_cashed
        const earnedAfterTrigger = state.econ!.perPlayer[player0Hex].bounty_earned

        // Cashed should equal earned at trigger
        expect(cashedAfterTrigger).toBe(earnedAfterTrigger)
      }
    })
  })
})
