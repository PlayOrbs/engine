import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../../src/core/v1/sim.js'
import { applyEconomicScoring, applyTPPresetsToTargets } from '../../src/economics/scoring.js'
import { makeTestConfig, makePlayers, makeTestSeed, buildJoinMapWithPresets } from './test-helpers.js'
import { toHex } from '../../src/utils/utils.js'

/**
 * Helper: Manually duplicate an orb in state to simulate a split.
 * Copies orb at `srcIdx`, pushes a clone with same owner, and adds empty tethers.
 */
function simulateSplit(state: any, srcIdx: number): number {
  const parent = state.orbs[srcIdx]
  const child = {
    ...parent,
    x: parent.x + 10,
    y: parent.y + 10,
    vx: parent.vx * 0.5,
    vy: parent.vy * 0.5,
    gen: (parent.gen || 0) + 1,
    splitCooldown: 240,
    hadTether: false,
    // Deep-copy owner so it's the same bytes but a different reference
    owner: new Uint8Array(parent.owner),
    prng: parent.prng,
    trait: parent.trait,
    skill: { ...parent.skill },
  }
  state.orbs.push(child)
  state.tethers.push([])
  return state.orbs.length - 1
}

describe('TP with Split Orbs', () => {
  /**
   * Core scenario: Player 0 has split into multiple orbs.
   * When TP triggers, ALL orbs belonging to that player must be removed.
   */
  describe('applyEconomicScoring returns tp_trigger events for all split orbs', () => {
    it('should emit tp_trigger for every orb owned by the cashing-out player', () => {
      const N = 4
      const entryLamports = 100_000_000 // 0.1 SOL
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(42)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      // Set a very low TP target for player 0 so any kill triggers it
      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 } // 1 lamport target
      state.econ!.tp_triggered = new Set<string>()

      // Simulate player 0 splitting into 3 orbs (original + 2 children)
      // Find player 0's orb index
      const p0Indices: number[] = []
      for (let i = 0; i < state.orbs.length; i++) {
        if (toHex(state.orbs[i].owner) === player0Hex) {
          p0Indices.push(i)
        }
      }
      expect(p0Indices.length).toBe(1)
      const origIdx = p0Indices[0]

      // Split twice
      const child1Idx = simulateSplit(state, origIdx)
      const child2Idx = simulateSplit(state, origIdx)

      // Verify player 0 now owns 3 orbs
      const p0OrbCount = state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length
      expect(p0OrbCount).toBe(3)

      // Give player 0 some bounty earnings to exceed the 1 lamport target
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000

      // Build owners lists (all orbs alive)
      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore] // no eliminations this frame

      // Call the real applyEconomicScoring
      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // TP should have triggered
      expect(state.econ!.tp_triggered!.has(player0Hex)).toBe(true)

      // Collect all orb indices from tp_trigger events
      const tpOrbIndices = tpEvents.map(e => e.orbIndex)

      // Find all indices that player 0 owns
      const allP0Indices: number[] = []
      for (let i = 0; i < state.orbs.length; i++) {
        if (toHex(state.orbs[i].owner) === player0Hex) {
          allP0Indices.push(i)
        }
      }

      // THE KEY ASSERTION: every orb owned by player 0 must have a tp_trigger event
      expect(allP0Indices.length).toBe(3)
      for (const idx of allP0Indices) {
        expect(tpOrbIndices).toContain(idx)
      }
      expect(tpEvents.length).toBe(3) // exactly 3 events, one per orb
    })

    it('should emit only 1 tp_trigger event for a non-split player', () => {
      const N = 4
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(43)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 }
      state.econ!.tp_triggered = new Set<string>()

      // Give earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000

      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      expect(tpEvents.length).toBe(1)
      expect(tpEvents[0].ownerHex).toBe(player0Hex)
    })
  })

  describe('sim.ts orb removal removes ALL split orbs on TP cashout', () => {
    it('should remove all orbs belonging to the cashed-out player', () => {
      const N = 4
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(44)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 }
      state.econ!.tp_triggered = new Set<string>()

      // Simulate split: player 0 has 3 orbs
      const origIdx = state.orbs.findIndex((o: any) => toHex(o.owner) === player0Hex)
      simulateSplit(state, origIdx)
      simulateSplit(state, origIdx)

      const totalOrbsBefore = state.orbs.length
      const p0OrbsBefore = state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length
      expect(p0OrbsBefore).toBe(3)

      // Give earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000

      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      // Call applyEconomicScoring (same as sim.ts does)
      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // Simulate the removal logic from sim.ts
      if (tpEvents.length > 0) {
        const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
        const remainingOrbs: typeof state.orbs = []
        const remainingTethers: typeof state.tethers = []
        for (let i = 0; i < state.orbs.length; i++) {
          if (!tpOrbIndices.has(i)) {
            remainingOrbs.push(state.orbs[i])
            remainingTethers.push(state.tethers[i])
          }
        }
        state.orbs = remainingOrbs
        state.tethers = remainingTethers
      }

      // After removal, NO orbs should belong to player 0
      const p0OrbsAfter = state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length
      expect(p0OrbsAfter).toBe(0)

      // Other players' orbs should be untouched
      const expectedRemaining = totalOrbsBefore - p0OrbsBefore
      expect(state.orbs.length).toBe(expectedRemaining)
    })

    it('should not remove orbs of other players when one player cashes out', () => {
      const N = 6
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(45)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      state.econ!.tp_targets = { [player0Hex]: 1 }
      state.econ!.tp_triggered = new Set<string>()

      // Split player 0 into 2 orbs
      const p0Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player0Hex)
      simulateSplit(state, p0Idx)

      // Split player 1 into 2 orbs (player 1 does NOT have TP)
      const p1Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player1Hex)
      simulateSplit(state, p1Idx)

      // Give player 0 earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000

      const p1OrbsBefore = state.orbs.filter((o: any) => toHex(o.owner) === player1Hex).length
      expect(p1OrbsBefore).toBe(2)

      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // Remove orbs (sim.ts logic)
      if (tpEvents.length > 0) {
        const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
        const remainingOrbs: typeof state.orbs = []
        const remainingTethers: typeof state.tethers = []
        for (let i = 0; i < state.orbs.length; i++) {
          if (!tpOrbIndices.has(i)) {
            remainingOrbs.push(state.orbs[i])
            remainingTethers.push(state.tethers[i])
          }
        }
        state.orbs = remainingOrbs
        state.tethers = remainingTethers
      }

      // Player 1's orbs should all still be present
      const p1OrbsAfter = state.orbs.filter((o: any) => toHex(o.owner) === player1Hex).length
      expect(p1OrbsAfter).toBe(p1OrbsBefore)
    })
  })

  describe('multiple players with splits and TP', () => {
    it('should handle two players both triggering TP with split orbs', () => {
      const N = 6
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(46)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      // Both players have TP targets
      state.econ!.tp_targets = {
        [player0Hex]: 1,
        [player1Hex]: 1,
      }
      state.econ!.tp_triggered = new Set<string>()

      // Split both players
      const p0Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player0Hex)
      simulateSplit(state, p0Idx)

      const p1Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player1Hex)
      simulateSplit(state, p1Idx)
      simulateSplit(state, p1Idx) // player 1 has 3 orbs

      // Give both earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000
      state.econ!.perPlayer[player1Hex].bounty_earned = 2000
      state.econ!.perPlayer[player1Hex].total_earned = 2000

      const totalOrbsBefore = state.orbs.length
      const p0Count = state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length
      const p1Count = state.orbs.filter((o: any) => toHex(o.owner) === player1Hex).length
      expect(p0Count).toBe(2)
      expect(p1Count).toBe(3)

      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // Both should trigger
      expect(state.econ!.tp_triggered!.has(player0Hex)).toBe(true)
      expect(state.econ!.tp_triggered!.has(player1Hex)).toBe(true)

      // Should have 5 tp_trigger events total (2 for p0 + 3 for p1)
      expect(tpEvents.length).toBe(5)

      // Remove orbs
      const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
      const remainingOrbs: typeof state.orbs = []
      const remainingTethers: typeof state.tethers = []
      for (let i = 0; i < state.orbs.length; i++) {
        if (!tpOrbIndices.has(i)) {
          remainingOrbs.push(state.orbs[i])
          remainingTethers.push(state.tethers[i])
        }
      }
      state.orbs = remainingOrbs
      state.tethers = remainingTethers

      // Neither player should have orbs remaining
      expect(state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length).toBe(0)
      expect(state.orbs.filter((o: any) => toHex(o.owner) === player1Hex).length).toBe(0)

      // Remaining orbs should be from other players only
      expect(state.orbs.length).toBe(totalOrbsBefore - p0Count - p1Count)
    })
  })

  describe('edge cases', () => {
    it('should not trigger TP when only 1 unique player remains (even with splits)', () => {
      const N = 2
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(47)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      const player1Hex = toHex(players[1].pubkey)

      state.econ!.tp_targets = { [player0Hex]: 1 }
      state.econ!.tp_triggered = new Set<string>()

      // Give earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 1000
      state.econ!.perPlayer[player0Hex].total_earned = 1000

      // Split player 0
      const p0Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player0Hex)
      simulateSplit(state, p0Idx)

      // Remove player 1's orb (simulating elimination)
      const p1Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player1Hex)
      state.orbs.splice(p1Idx, 1)
      state.tethers.splice(p1Idx, 1)

      // Now only player 0 remains (with 2 split orbs)
      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // TP should NOT trigger when only 1 unique player left
      expect(tpEvents.length).toBe(0)
      expect(state.econ!.tp_triggered!.has(player0Hex)).toBe(false)
    })

    it('should handle player with many splits (stress test)', () => {
      const N = 4
      const entryLamports = 100_000_000
      const cfg = makeTestConfig(N, entryLamports, 'free_sim')
      const seed = makeTestSeed(48)
      const players = makePlayers(N)

      const { state } = initFromSeed(seed, players, cfg)

      const player0Hex = toHex(players[0].pubkey)
      state.econ!.tp_targets = { [player0Hex]: 1 }
      state.econ!.tp_triggered = new Set<string>()

      // Split player 0 into 8 orbs total
      const p0Idx = state.orbs.findIndex((o: any) => toHex(o.owner) === player0Hex)
      for (let i = 0; i < 7; i++) {
        simulateSplit(state, p0Idx)
      }

      const p0OrbCount = state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length
      expect(p0OrbCount).toBe(8)

      // Give earnings
      state.econ!.perPlayer[player0Hex].bounty_earned = 5000
      state.econ!.perPlayer[player0Hex].total_earned = 5000

      const ownersBefore = state.orbs.map((o: any) => toHex(o.owner))
      const ownersAfter = [...ownersBefore]

      const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

      // All 8 orbs should have tp_trigger events
      expect(tpEvents.length).toBe(8)

      // All events should reference player 0
      for (const ev of tpEvents) {
        expect(ev.ownerHex).toBe(player0Hex)
      }

      // Verify all indices are unique
      const indices = new Set(tpEvents.map(e => e.orbIndex))
      expect(indices.size).toBe(8)

      // Remove and verify
      const tpOrbIndices = new Set(tpEvents.map(e => e.orbIndex))
      state.orbs = state.orbs.filter((_: any, i: number) => !tpOrbIndices.has(i))

      expect(state.orbs.filter((o: any) => toHex(o.owner) === player0Hex).length).toBe(0)
    })
  })
})
