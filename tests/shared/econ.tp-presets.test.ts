import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { buildTpPresetsLamports, sumTopKillsLamports } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed } from './test-helpers.js'

describe('TP Presets - Engine Computation', () => {
  describe('buildTpPresetsLamports', () => {
    it('should compute presets based on kill equivalents', () => {
      const N = 8
      const entryLamports = 10_000_000 // 0.01 SOL
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(1)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Verify presets were computed
      expect(state.econ).toBeDefined()
      expect(state.econ!.tp_presets_lamports).toBeDefined()

      const presets = state.econ!.tp_presets_lamports!
      expect(presets.safe).toBeGreaterThan(0)
      expect(presets.balanced).toBeGreaterThan(0)
      expect(presets.fierce).toBeGreaterThan(0)
      expect(presets.yolo).toBeGreaterThan(0)
    })

    it('should maintain monotonicity: safe < balanced < fierce < yolo', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(2)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const presets = state.econ!.tp_presets_lamports!

      // Verify strict monotonicity
      expect(presets.safe).toBeLessThan(presets.balanced)
      expect(presets.balanced).toBeLessThan(presets.fierce)
      expect(presets.fierce).toBeLessThan(presets.yolo)
    })

    it('should be deterministic for the same roster', () => {
      const N = 6
      const entryLamports = 10_000_000
      const cfg1 = makeTestConfig(N, entryLamports, 'free_sim')
      const cfg2 = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(3)
      const players = makePlayers(N)

      const { state: state1 } = initFromSeed(seed, players, cfg1)
      const { state: state2 } = initFromSeed(seed, players, cfg2)

      const presets1 = state1.econ!.tp_presets_lamports!
      const presets2 = state2.econ!.tp_presets_lamports!

      // Exact equality
      expect(presets1.safe).toBe(presets2.safe)
      expect(presets1.balanced).toBe(presets2.balanced)
      expect(presets1.fierce).toBe(presets2.fierce)
      expect(presets1.yolo).toBe(presets2.yolo)
    })

    it('should scale with pot size', () => {
      const N = 8
      const smallEntry = 5_000_000 // 0.005 SOL
      const largeEntry = 50_000_000 // 0.05 SOL

      const cfgSmall = makeTestConfig(N, smallEntry, 'free_sim')
      const cfgLarge = makeTestConfig(N, largeEntry, 'free_sim')
      const seed = makeTestSeed(4)
      const players = makePlayers(N)

      const { state: stateSmall } = initFromSeed(seed, players, cfgSmall)
      const { state: stateLarge } = initFromSeed(seed, players, cfgLarge)

      const presetsSmall = stateSmall.econ!.tp_presets_lamports!
      const presetsLarge = stateLarge.econ!.tp_presets_lamports!

      // Larger entry should result in larger presets (approximately 10x)
      const ratio = largeEntry / smallEntry
      expect(presetsLarge.safe).toBeGreaterThan(presetsSmall.safe * (ratio * 0.9))
      expect(presetsLarge.balanced).toBeGreaterThan(presetsSmall.balanced * (ratio * 0.9))
      expect(presetsLarge.fierce).toBeGreaterThan(presetsSmall.fierce * (ratio * 0.9))
      expect(presetsLarge.yolo).toBeGreaterThan(presetsSmall.yolo * (ratio * 0.9))
    })

    it('should respect bounty pot limits (no minting)', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(5)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const presets = state.econ!.tp_presets_lamports!
      const bountyPot = state.econ!.pots.bounty_pot_lamports

      // Even yolo should be within bounty pot
      expect(presets.yolo).toBeLessThanOrEqual(bountyPot)
    })
  })

  describe('sumTopKillsLamports', () => {
    it('should sum top K kills correctly', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(6)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const perKillSchedule = state.econ!.perKillSchedule!

      // Safe = top 2 kills
      const safe = sumTopKillsLamports(perKillSchedule, N, 2)
      expect(safe).toBe(perKillSchedule[N] + perKillSchedule[N - 1])

      // Balanced = top 4 kills
      const balanced = sumTopKillsLamports(perKillSchedule, N, 4)
      expect(balanced).toBe(
        perKillSchedule[N] +
        perKillSchedule[N - 1] +
        perKillSchedule[N - 2] +
        perKillSchedule[N - 3]
      )
    })

    it('should return 0 for k=0', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(7)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const perKillSchedule = state.econ!.perKillSchedule!

      const result = sumTopKillsLamports(perKillSchedule, N, 0)
      expect(result).toBe(0)
    })

    it('should handle k > N-1 gracefully', () => {
      const N = 4
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(8)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const perKillSchedule = state.econ!.perKillSchedule!

      // Only 3 kills possible (N-1), asking for 10
      const result = sumTopKillsLamports(perKillSchedule, N, 10)

      // Should sum all available kills
      const allKills = (perKillSchedule[4] || 0) + (perKillSchedule[3] || 0) + (perKillSchedule[2] || 0)
      expect(result).toBe(allKills)
    })
  })

  describe('Preset Snapshots', () => {
    it('should produce stable preset values for N=8', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(9)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const presets = state.econ!.tp_presets_lamports!

      // Snapshot for N=8 with 0.01 SOL entry
      expect({
        safe: presets.safe,
        balanced: presets.balanced,
        fierce: presets.fierce,
        yolo: presets.yolo,
      }).toMatchSnapshot('presets-n8-entry0.01')
    })

    it('should produce stable preset values for N=16', () => {
      const N = 16
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(10)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const presets = state.econ!.tp_presets_lamports!

      // Snapshot for N=16 with 0.01 SOL entry
      expect({
        safe: presets.safe,
        balanced: presets.balanced,
        fierce: presets.fierce,
        yolo: presets.yolo,
      }).toMatchSnapshot('presets-n16-entry0.01')
    })
  })

  describe('Preset Ratios', () => {
    it('should maintain consistent ratios between presets', () => {
      const N = 8
      const entryLamports = 10_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(11)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)
      const presets = state.econ!.tp_presets_lamports!

      // Balanced should be roughly 2x safe (2 kills vs 4 kills)
      const balancedRatio = presets.balanced / presets.safe
      expect(balancedRatio).toBeGreaterThan(1.5)
      expect(balancedRatio).toBeLessThan(3.0)

      // Fierce should be roughly 3x safe (2 kills vs 6 kills)
      const fierceRatio = presets.fierce / presets.safe
      expect(fierceRatio).toBeGreaterThan(2.0)
      expect(fierceRatio).toBeLessThan(5.0)

      // Yolo should be roughly 4x safe (2 kills vs 8 kills)
      const yoloRatio = presets.yolo / presets.safe
      expect(yoloRatio).toBeGreaterThan(2.5)
      expect(yoloRatio).toBeLessThan(6.0)
    })
  })
})
