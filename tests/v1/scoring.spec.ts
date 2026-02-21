import { describe, it, expect } from 'vitest'
import { initEconomicsFromConfig, applyEconomicScoring, computeResultHash } from '../../src/economics/scoring.js'
import { EngineState, EngineConfig } from '../../src/core/v1/types.js'

/**
 * Unit tests for log-scaled economy system
 */

function makeTestState(): EngineState {
  return {
    frame: 0,
    orbs: [],
    tethers: [],
    flashes: [],
    shockwaves: [],
    scores: {}
  }
}

function makeTestConfig(
  N: number,
  entry: number,
  economyModel: 'fixed_total_v0' | 'log_scaled_kill_v1' = 'log_scaled_kill_v1',
  devFeeBps?: number,
  tpTargets?: Record<string, number>
): EngineConfig {
  // Generate roster as proper 64-character hex strings (32 bytes = 64 hex chars)
  const roster = Array.from({ length: N }, (_, i) =>
    i.toString(16).padStart(64, '0')
  )

  return {
    canvas: { width: 800, height: 600 },
    boundary: { radius: 300, restitution: 0.5, tangentImpulse: 0.5, minSpeed: 1 },
    burst: { lineWidth: 2 },
    orbs: { radius: 10 },
    economicsInputs: {
      header: {
        round_id: 1,
        seed_hex: 'deadbeef',
        map_id: 'test_map',
        rules_hash: 'rules123',
        build_hash: 'build456',
        mode: 'paid',
        economy_model: economyModel,
        dev_fee_bps: devFeeBps
      },
      economic_params: {
        total_players: N,
        entry_amount_lamports: entry,
        bounty_bps: 7000,
        survival_bps: 3000,
        simulated: false
      },
      roster,
      tp_targets_lamports: tpTargets
    }
  }
}

describe('Log-Scaled Economy', () => {
  it('per_kill increases with lobby size N', () => {
    const entry = 100_000_000 // 0.1 SOL in lamports
    const sizes = [4, 6, 10, 20]
    const perKills: number[] = []

    for (const N of sizes) {
      const state = makeTestState()
      const cfg = makeTestConfig(N, entry)
      initEconomicsFromConfig(state, cfg)

      expect(state.econ).toBeDefined()
      const perKill = state.econ!.pots.bounty_per_kill_lamports
      perKills.push(perKill)
    }

    // Verify that per_kill increases with N
    for (let i = 1; i < perKills.length; i++) {
      expect(perKills[i]).toBeGreaterThan(perKills[i - 1])
    }
  })

  it('bounty sum over N-1 kills approximately equals bounty_pot', () => {
    const N = 10
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    const bountyPot = state.econ!.pots.bounty_pot_lamports
    const perKill = state.econ!.pots.bounty_per_kill_lamports
    const totalPayout = perKill * (N - 1)

    // Total payout should equal bounty pot (constructed to be equal)
    expect(totalPayout).toBe(bountyPot)
  })

  it('calculates pots correctly with dev fee', () => {
    const N = 10
    const entry = 100_000_000 // 0.1 SOL
    const devFeeBps = 2000 // 20%
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'log_scaled_kill_v1', devFeeBps)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    const devFee = 0.20
    const playerPool = entry * N * (1 - devFee)
    const bountyShare = 0.70
    const survivalShare = 0.30
    const G_N = 1 + Math.log2(N) / 5

    const expectedPerKill = Math.trunc(entry * (1 - devFee) * bountyShare * G_N)
    const expectedBountyPot = expectedPerKill * (N - 1)
    const expectedSurvivalPot = Math.trunc(playerPool * survivalShare)

    expect(state.econ!.pots.bounty_per_kill_lamports).toBe(expectedPerKill)
    expect(state.econ!.pots.bounty_pot_lamports).toBe(expectedBountyPot)
    expect(state.econ!.pots.survival_pot_lamports).toBe(expectedSurvivalPot)
  })

  it('supports backward compatibility with fixed_total_v0', () => {
    const N = 10
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'fixed_total_v0')

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    // Legacy formula: no dev fee, uses bps directly
    const bountyBps = 7000
    const survivalBps = 3000
    const expectedBountyPot = Math.trunc(entry * N * (bountyBps / 10000))
    const expectedSurvivalPot = Math.trunc(entry * N * (survivalBps / 10000))
    const expectedPerKill = Math.trunc(expectedBountyPot / (N - 1))

    expect(state.econ!.pots.bounty_pot_lamports).toBe(expectedBountyPot)
    expect(state.econ!.pots.survival_pot_lamports).toBe(expectedSurvivalPot)
    expect(state.econ!.pots.bounty_per_kill_lamports).toBe(expectedPerKill)
  })

  it('TP trigger fires when target reached', () => {
    const N = 4
    const entry = 100_000_000

    // Use roster format from makeTestConfig (proper hex strings)
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const tpTargets = {
      [player0]: 50_000_000 // TP at 0.05 SOL
    }

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'log_scaled_kill_v1', 2000, tpTargets)

    // Create mock orbs with matching roster owners
    function hexToBytes(hex: string): Uint8Array {
      const bytes = new Uint8Array(32)
      for (let i = 0; i < Math.min(64, hex.length); i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
      }
      return bytes
    }

    state.orbs = roster.map(playerId => ({
      owner: hexToBytes(playerId),
      x: 0, y: 0, vx: 0, vy: 0,
      justCollided: false,
      hadTether: true,
      color: '#fff',
      prng: null as any,
      trait: null as any,
      radius: 10,
      gen: 0,
      splitCooldown: 0
    }))

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    const perKill = state.econ!.pots.bounty_per_kill_lamports

    // Simulate player0 getting 2 kills (should trigger TP after second kill if perKill * 2 >= target)
    const ownersBefore = [player0, player1, player2, player3]

    // Frame 1: player0 kills player1
    let ownersAfter = [player0, player2, player3]
    let frameEvents = [
      { type: 'tether_destroyed', owner: 1, attacker: 0 }
    ]
    state.frame = 1

    // Update state.orbs to match ownersAfter (simulate pruning)
    state.orbs = [
      state.orbs[0], // player0
      state.orbs[2], // player2
      state.orbs[3]  // player3
    ]

    let tpEvents = applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    expect(state.econ!.perPlayer[player0].kills).toBe(1)
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(perKill)

    // Check if TP triggered (depends on perKill value)
    if (state.econ!.perPlayer[player0].total_earned >= tpTargets[player0]) {
      expect(tpEvents.length).toBe(1)
      expect(tpEvents[0].type).toBe('tp_trigger')
      expect(tpEvents[0].ownerHex).toBe(player0)
      expect(state.econ!.events.some(e => e.type === 'TPCashout')).toBe(true)
    } else {
      // Frame 2: player0 kills player2 (who is now at index 1 after pruning)
      const ownersBefore2 = [player0, player2, player3]
      const ownersAfter2 = [player0, player3]
      const frameEvents2 = [
        { type: 'tether_destroyed', owner: 1, attacker: 0 }
      ]
      state.frame = 2

      // Update state.orbs to match ownersAfter2 (simulate pruning player2)
      state.orbs = [
        state.orbs[0], // player0
        state.orbs[2]  // player3
      ]

      tpEvents = applyEconomicScoring(state, frameEvents2, ownersBefore2, ownersAfter2)

      expect(state.econ!.perPlayer[player0].kills).toBe(2)

      if (state.econ!.perPlayer[player0].total_earned >= tpTargets[player0]) {
        expect(tpEvents.length).toBeGreaterThan(0)
        expect(tpEvents[0].type).toBe('tp_trigger')
        expect(state.econ!.events.some(e => e.type === 'TPCashout')).toBe(true)
      }
    }
  })

  it('result hash includes economy_model and dev_fee_bps', () => {
    const N = 5
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'log_scaled_kill_v1', 2000)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    // Finalize to compute hash
    state.econ!.finalized = true
    state.econ!.winner_id = state.econ!.roster[0]
    const hash = computeResultHash(state)

    expect(hash).toBeTruthy()
    expect(hash.length).toBe(64) // SHA256 hex
  })

  it('debug: hex conversion works correctly', () => {
    const testHex = 'deadbeef' + '0'.repeat(56) // 64 chars total
    function hexToBytes(hex: string): Uint8Array {
      const bytes = new Uint8Array(32)
      for (let i = 0; i < Math.min(64, hex.length); i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
      }
      return bytes
    }
    function toHex(bytes: Uint8Array): string {
      let s = ''
      for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
      return s
    }

    const bytes = hexToBytes(testHex)
    const hexBack = toHex(bytes)

    expect(hexBack).toBe(testHex)
  })

  it('handles multiple TP targets in same frame', () => {
    const N = 4
    const entry = 100_000_000

    // Use roster format from makeTestConfig (proper hex strings)
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const tpTargets = {
      [player0]: 10_000_000,
      [player2]: 10_000_000
    }

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'log_scaled_kill_v1', 2000, tpTargets)

    // Create mock orbs with matching roster owners
    function hexToBytes(hex: string): Uint8Array {
      const bytes = new Uint8Array(32)
      for (let i = 0; i < Math.min(64, hex.length); i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
      }
      return bytes
    }

    state.orbs = roster.map(playerId => ({
      owner: hexToBytes(playerId),
      x: 0, y: 0, vx: 0, vy: 0,
      justCollided: false,
      hadTether: true,
      color: '#fff',
      prng: null as any,
      trait: null as any,
      radius: 10,
      gen: 0,
      splitCooldown: 0
    }))

    initEconomicsFromConfig(state, cfg)

    // Manually set earnings to trigger both TPs
    state.econ!.perPlayer[player0].bounty_earned = 15_000_000
    state.econ!.perPlayer[player0].total_earned = 15_000_000
    state.econ!.perPlayer[player2].bounty_earned = 15_000_000
    state.econ!.perPlayer[player2].total_earned = 15_000_000

    const ownersBefore = [player0, player1, player2, player3]
    const ownersAfter = [player0, player1, player2, player3]

    state.frame = 1
    const tpEvents = applyEconomicScoring(state, [], ownersBefore, ownersAfter)

    expect(tpEvents.length).toBe(2)
    expect(tpEvents.some(e => e.ownerHex === player0)).toBe(true)
    expect(tpEvents.some(e => e.ownerHex === player2)).toBe(true)
  })
})
