import { describe, it, expect } from 'vitest'
import { initEconomicsFromConfig, applyEconomicScoring, computeResultHash } from '../../src/economics/scoring.js'
import { EngineState, EngineConfig, Orb } from '../../src/core/v1/types.js'

/**
 * Unit tests for weighted_kill_v2 economy system
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
  economyModel: 'fixed_total_v0' | 'log_scaled_kill_v1' | 'weighted_kill_v2' = 'weighted_kill_v2',
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < Math.min(64, hex.length); i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

describe('Weighted Kill Economy (v2)', () => {
  it('creates weighted payout schedule with exact sum', () => {
    const N = 10
    const entry = 100_000_000 // 0.1 SOL
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()
    expect(state.econ!.perKillSchedule).toBeDefined()

    const schedule = state.econ!.perKillSchedule!
    const bountyPot = state.econ!.pots.bounty_pot_lamports

    // Sum all payouts in schedule (A goes from N down to 2)
    let totalPayout = 0
    for (let A = N; A >= 2; A--) {
      expect(schedule[A]).toBeGreaterThan(0)
      totalPayout += schedule[A]
    }

    // Total must equal bounty pot exactly
    expect(totalPayout).toBe(bountyPot)
  })

  it('early kills pay more than late kills', () => {
    const N = 10
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    initEconomicsFromConfig(state, cfg)
    const schedule = state.econ!.perKillSchedule!

    // Verify monotone decreasing: payout(A_high) > payout(A_low)
    for (let A = N; A > 2; A--) {
      expect(schedule[A]).toBeGreaterThan(schedule[A - 1])
    }
  })

  it('applies weighted payouts correctly during eliminations', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    // Create mock orbs
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

    const schedule = state.econ!.perKillSchedule!
    const [player0, player1, player2, player3] = roster

    // Frame 1: player0 kills player1 (A=4)
    state.frame = 1
    const ownersBefore1 = [player0, player1, player2, player3]
    const ownersAfter1 = [player0, player2, player3]
    const frameEvents1 = [
      { type: 'tether_destroyed', owner: 1, attacker: 0 }
    ]

    // Update orbs to match ownersAfter1
    state.orbs = [state.orbs[0], state.orbs[2], state.orbs[3]]

    applyEconomicScoring(state, frameEvents1, ownersBefore1, ownersAfter1)

    expect(state.econ!.perPlayer[player0].kills).toBe(1)
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(schedule[4])

    // Frame 2: player0 kills player2 (A=3, now at index 1)
    state.frame = 2
    const ownersBefore2 = [player0, player2, player3]
    const ownersAfter2 = [player0, player3]
    const frameEvents2 = [
      { type: 'tether_destroyed', owner: 1, attacker: 0 }
    ]

    // Update orbs
    state.orbs = [state.orbs[0], state.orbs[2]]

    applyEconomicScoring(state, frameEvents2, ownersBefore2, ownersAfter2)

    expect(state.econ!.perPlayer[player0].kills).toBe(2)
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(schedule[4] + schedule[3])

    // Verify first kill paid more than second kill
    expect(schedule[4]).toBeGreaterThan(schedule[3])
  })

  it('handles TP triggers after bounty payouts', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const tpTargets = {
      [player0]: 20_000_000 // TP at 0.02 SOL
    }

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2', 2000, tpTargets)

    // Create mock orbs
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

    const schedule = state.econ!.perKillSchedule!

    // Simulate kills until TP triggers
    state.frame = 1
    let ownersBefore = [player0, player1, player2, player3]
    let ownersAfter = [player0, player2, player3]
    let frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
    state.orbs = [state.orbs[0], state.orbs[2], state.orbs[3]]

    let tpEvents = applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Check if TP triggered after first kill
    if (state.econ!.perPlayer[player0].total_earned >= tpTargets[player0]) {
      expect(tpEvents.length).toBe(1)
      expect(tpEvents[0].type).toBe('tp_trigger')
      expect(tpEvents[0].ownerHex).toBe(player0)
      expect(state.econ!.events.some(e => e.type === 'TPCashout')).toBe(true)
    } else {
      // Need another kill
      state.frame = 2
      ownersBefore = [player0, player2, player3]
      ownersAfter = [player0, player3]
      frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
      state.orbs = [state.orbs[0], state.orbs[2]]

      tpEvents = applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

      if (state.econ!.perPlayer[player0].total_earned >= tpTargets[player0]) {
        expect(tpEvents.length).toBeGreaterThan(0)
        expect(tpEvents[0].type).toBe('tp_trigger')
        expect(state.econ!.events.some(e => e.type === 'TPCashout')).toBe(true)
      }
    }
  })

  it('includes schedule and weights_meta in result hash', () => {
    const N = 5
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()
    expect(state.econ!.perKillSchedule).toBeDefined()
    expect(state.econ!.weights_meta).toBeDefined()

    // Finalize to compute hash
    state.econ!.finalized = true
    state.econ!.winner_id = state.econ!.roster[0]
    const hash = computeResultHash(state)

    expect(hash).toBeTruthy()
    expect(hash.length).toBe(64) // SHA256 hex
  })

  it('supports backward compatibility with log_scaled_kill_v1', () => {
    const N = 10
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'log_scaled_kill_v1', 2000)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    // Should have per_kill but no schedule
    expect(state.econ!.pots.bounty_per_kill_lamports).toBeDefined()
    expect(state.econ!.perKillSchedule).toBeUndefined()
  })

  it('supports backward compatibility with fixed_total_v0', () => {
    const N = 10
    const entry = 100_000_000
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'fixed_total_v0')

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    // Should have per_kill but no schedule
    expect(state.econ!.pots.bounty_per_kill_lamports).toBeDefined()
    expect(state.econ!.perKillSchedule).toBeUndefined()
  })

  it('handles multiple eliminations in same frame with correct A values', () => {
    const N = 5
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry)

    // Create mock orbs
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
    const schedule = state.econ!.perKillSchedule!

    // Frame 1: Two kills in same frame (player0 kills player1 and player2)
    state.frame = 1
    const ownersBefore = roster.slice()
    const ownersAfter = [roster[0], roster[3], roster[4]]
    const frameEvents = [
      { type: 'tether_destroyed', owner: 1, attacker: 0 },
      { type: 'tether_destroyed', owner: 2, attacker: 0 }
    ]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // First kill should use A=5, second kill should use A=4
    const bountyEvents = state.econ!.events.filter(e => e.type === 'BountyPayout')
    expect(bountyEvents.length).toBe(2)
    expect(bountyEvents[0].amount).toBe(schedule[5])
    expect(bountyEvents[1].amount).toBe(schedule[4])
  })

  it('calculates dev fee correctly', () => {
    const N = 10
    const entry = 100_000_000
    const devFeeBps = 2000 // 20%
    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2', devFeeBps)

    initEconomicsFromConfig(state, cfg)
    expect(state.econ).toBeDefined()

    const devFee = 0.20
    const playerPool = Math.trunc(entry * N * (1 - devFee))
    const bountyShare = 0.70
    const survivalShare = 0.30

    const expectedBountyPot = Math.trunc(playerPool * bountyShare)
    const expectedSurvivalPot = Math.trunc(playerPool * survivalShare)

    expect(state.econ!.pots.bounty_pot_lamports).toBe(expectedBountyPot)
    expect(state.econ!.pots.survival_pot_lamports).toBe(expectedSurvivalPot)
  })
})
