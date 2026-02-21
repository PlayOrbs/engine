import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { applyTPPresetsToTargets } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed, buildJoinMapWithPresets } from './test-helpers.js'
import { toHex } from '../../src/utils/utils.js'

describe('TP Apply Targets - Join Presets', () => {
  describe('applyTPPresetsToTargets', () => {
    it('should apply preset to tp_targets', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(1)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Create join map with preset for player 0
      const joinMap = buildJoinMapWithPresets(N, { 0: 'balanced' })

      // Apply presets
      applyTPPresetsToTargets(state, joinMap)

      // Verify target was set
      const player0Hex = toHex(players[0].pubkey)
      expect(state.econ!.tp_targets).toBeDefined()
      expect(state.econ!.tp_targets![player0Hex]).toBe(state.econ!.tp_presets_lamports!.balanced)
    })

    it('should apply multiple different presets', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(2)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Different presets for different players
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'safe',
        1: 'balanced',
        2: 'fierce',
        3: 'yolo',
      })

      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      expect(state.econ!.tp_targets![player0Hex]).toBe(state.econ!.tp_presets_lamports!.safe)
      expect(state.econ!.tp_targets![player1Hex]).toBe(state.econ!.tp_presets_lamports!.balanced)
      expect(state.econ!.tp_targets![player2Hex]).toBe(state.econ!.tp_presets_lamports!.fierce)
      expect(state.econ!.tp_targets![player3Hex]).toBe(state.econ!.tp_presets_lamports!.yolo)
    })

    it('should not set target for disabled TP', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(3)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Create join map with TP disabled for all players
      const joinMap = buildJoinMapWithPresets(N, {})

      applyTPPresetsToTargets(state, joinMap)

      // No targets should be set
      expect(Object.keys(state.econ!.tp_targets || {}).length).toBe(0)
    })

    it('should handle manual targetSol override', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(4)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Create join map with manual override
      const player0Hex = toHex(players[0].pubkey)
      const manualTargetSol = 0.05 // 0.05 SOL
      const joinMap = {
        [player0Hex]: {
          frame: 0,
          player: players[0].pubkey,
          joinNonce: new Uint8Array(8),
          modePaid: false,
          tp: { enabled: true, targetSol: manualTargetSol },
        },
      }

      applyTPPresetsToTargets(state, joinMap as any)

      // Manual target should be set (in lamports)
      const expectedLamports = Math.round(manualTargetSol * 1_000_000_000)
      expect(state.econ!.tp_targets![player0Hex]).toBe(expectedLamports)
    })

    it('should prioritize preset over manual targetSol', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(5)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Create join map with both preset and manual override
      const player0Hex = toHex(players[0].pubkey)
      const joinMap = {
        [player0Hex]: {
          frame: 0,
          player: players[0].pubkey,
          joinNonce: new Uint8Array(8),
          modePaid: false,
          tp: { enabled: true, preset: 'balanced', targetSol: 0.05 },
        },
      }

      applyTPPresetsToTargets(state, joinMap as any)

      // Preset should take priority
      expect(state.econ!.tp_targets![player0Hex]).toBe(state.econ!.tp_presets_lamports!.balanced)
    })

    it('should handle empty join map gracefully', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(6)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Empty join map
      applyTPPresetsToTargets(state, {})

      // Should not crash, targets should be empty or undefined
      const targetCount = Object.keys(state.econ!.tp_targets || {}).length
      expect(targetCount).toBe(0)
    })

    it('should handle missing econ gracefully', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(7)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Remove econ
      delete state.econ

      const joinMap = buildJoinMapWithPresets(N, { 0: 'balanced' })

      // Should not crash
      expect(() => applyTPPresetsToTargets(state, joinMap)).not.toThrow()
    })

    it('should handle missing tp_presets_lamports gracefully', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(8)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Remove presets
      delete state.econ!.tp_presets_lamports

      const joinMap = buildJoinMapWithPresets(N, { 0: 'balanced' })

      // Should not crash (but won't set any targets)
      expect(() => applyTPPresetsToTargets(state, joinMap)).not.toThrow()
    })
  })

  describe('Preset Target Consistency', () => {
    it('should set same target for same preset across multiple players', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(9)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // All players use 'balanced'
      const joinMap = buildJoinMapWithPresets(N, {
        0: 'balanced',
        1: 'balanced',
        2: 'balanced',
        3: 'balanced',
      })

      applyTPPresetsToTargets(state, joinMap)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)
      const player2Hex = toHex(players[2].pubkey)
      const player3Hex = toHex(players[3].pubkey)

      const target0 = state.econ!.tp_targets![player0Hex]
      const target1 = state.econ!.tp_targets![player1Hex]
      const target2 = state.econ!.tp_targets![player2Hex]
      const target3 = state.econ!.tp_targets![player3Hex]

      // All should be identical
      expect(target0).toBe(target1)
      expect(target1).toBe(target2)
      expect(target2).toBe(target3)
    })

    it('should set different targets for different presets', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(10)
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

      const target0 = state.econ!.tp_targets![player0Hex]
      const target1 = state.econ!.tp_targets![player1Hex]

      // Should be different
      expect(target0).not.toBe(target1)
      expect(target0).toBeLessThan(target1) // safe < yolo
    })
  })
})
