import { describe, it, expect } from 'vitest'
import { initEconomicsFromConfig, applyEconomicScoring } from '../../src/economics/scoring.js'
import { EngineState, EngineConfig } from '../../src/core/v1/types.js'

/**
 * Unit tests for weighted_kill_v2_inherit bounty inheritance system
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
  economyModel: 'weighted_kill_v2' | 'weighted_kill_v2_inherit' = 'weighted_kill_v2_inherit',
  tpTargets?: Record<string, number>
): EngineConfig {
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
        dev_fee_bps: 2000
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

describe('Bounty Inheritance (weighted_kill_v2_inherit)', () => {
  it('transfers uncashed bounty from victim to killer', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2_inherit')

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

    // Frame 1: player1 kills player2 (A=4)
    state.frame = 1
    let ownersBefore = [player0, player1, player2, player3]
    let ownersAfter = [player0, player1, player3]
    let frameEvents = [{ type: 'tether_destroyed', owner: 2, attacker: 1 }]
    state.orbs = [state.orbs[0], state.orbs[1], state.orbs[3]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Player1 should have scheduled bounty
    expect(state.econ!.perPlayer[player1].bounty_earned).toBe(schedule[4])
    expect(state.econ!.perPlayer[player1].cashed_bounty).toBeUndefined()

    // Frame 2: player0 kills player1 (A=3)
    state.frame = 2
    ownersBefore = [player0, player1, player3]
    ownersAfter = [player0, player3]
    frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
    state.orbs = [state.orbs[0], state.orbs[2]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Player0 should have: scheduled[3] + inherited bounty from player1
    const expectedBounty = schedule[3] + schedule[4]
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(expectedBounty)

    // Verify inheritance event was logged
    const inheritEvents = state.econ!.events.filter(e => e.type === 'KillInheritance')
    expect(inheritEvents.length).toBe(1)
    expect(inheritEvents[0].killer_id).toBe(player0)
    expect(inheritEvents[0].victim_id).toBe(player1)
    expect(inheritEvents[0].transferred).toBe(schedule[4])

    // Player1's bounty should be reduced to 0 (all transferred)
    expect(state.econ!.perPlayer[player1].bounty_earned).toBe(0)
  })

  it('does not transfer cashed bounty after TP', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const tpTargets = {
      [player1]: 20_000_000 // Low TP for player1
    }

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2_inherit', tpTargets)

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

    // Frame 1: player1 kills player2 (A=4), earns bounty
    state.frame = 1
    let ownersBefore = [player0, player1, player2, player3]
    let ownersAfter = [player0, player1, player3]
    let frameEvents = [{ type: 'tether_destroyed', owner: 2, attacker: 1 }]
    state.orbs = [state.orbs[0], state.orbs[1], state.orbs[3]]

    let tpEvents = applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Check if player1's TP triggered
    const player1Bounty = state.econ!.perPlayer[player1].bounty_earned

    if (player1Bounty >= tpTargets[player1]) {
      // TP triggered - cashed_bounty should be set
      expect(tpEvents.length).toBe(1)
      expect(tpEvents[0].ownerHex).toBe(player1)
      expect(state.econ!.perPlayer[player1].cashed_bounty).toBe(player1Bounty)

      // Frame 2: player0 kills player1 (A=3)
      // Player1 already cashed out, so no inheritance should occur
      state.frame = 2
      ownersBefore = [player0, player1, player3]
      ownersAfter = [player0, player3]
      frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
      state.orbs = [state.orbs[0], state.orbs[2]]

      applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

      // Player0 should only have scheduled bounty, no inheritance
      expect(state.econ!.perPlayer[player0].bounty_earned).toBe(schedule[3])

      // No inheritance event should be logged
      const inheritEvents = state.econ!.events.filter(e => e.type === 'KillInheritance')
      expect(inheritEvents.length).toBe(0)
    }
  })

  it('does not transfer in weighted_kill_v2 mode (no inheritance)', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2') // No inheritance

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

    // Frame 1: player1 kills player2
    state.frame = 1
    let ownersBefore = [player0, player1, player2, player3]
    let ownersAfter = [player0, player1, player3]
    let frameEvents = [{ type: 'tether_destroyed', owner: 2, attacker: 1 }]
    state.orbs = [state.orbs[0], state.orbs[1], state.orbs[3]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Frame 2: player0 kills player1
    state.frame = 2
    ownersBefore = [player0, player1, player3]
    ownersAfter = [player0, player3]
    frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
    state.orbs = [state.orbs[0], state.orbs[2]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Player0 should only have scheduled bounty, NO inheritance
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(schedule[3])

    // No inheritance events should exist
    const inheritEvents = state.econ!.events.filter(e => e.type === 'KillInheritance')
    expect(inheritEvents.length).toBe(0)
  })

  it('allows killer to TP immediately after inheriting bounty', () => {
    const N = 4
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2, player3] = roster

    const tpTargets = {
      [player0]: 40_000_000 // Set so that schedule[3] + inherited bounty triggers TP
    }

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2_inherit', tpTargets)

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

    // Frame 1: player1 kills player2
    state.frame = 1
    let ownersBefore = [player0, player1, player2, player3]
    let ownersAfter = [player0, player1, player3]
    let frameEvents = [{ type: 'tether_destroyed', owner: 2, attacker: 1 }]
    state.orbs = [state.orbs[0], state.orbs[1], state.orbs[3]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Frame 2: player0 kills player1 and inherits bounty
    state.frame = 2
    ownersBefore = [player0, player1, player3]
    ownersAfter = [player0, player3]
    frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 0 }]
    state.orbs = [state.orbs[0], state.orbs[2]]

    const tpEvents = applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // Player0's total should be schedule[3] + inherited bounty
    const totalBounty = schedule[3] + schedule[4]
    expect(state.econ!.perPlayer[player0].bounty_earned).toBe(totalBounty)

    // If this exceeds TP target, TP should trigger
    if (totalBounty >= tpTargets[player0]) {
      expect(tpEvents.length).toBeGreaterThan(0)
      expect(tpEvents[0].type).toBe('tp_trigger')
      expect(tpEvents[0].ownerHex).toBe(player0)

      // TPCashout event should exist
      const tpCashoutEvents = state.econ!.events.filter(e => e.type === 'TPCashout')
      expect(tpCashoutEvents.length).toBe(1)
      expect(tpCashoutEvents[0].player_id).toBe(player0)
    }
  })

  it('maintains no-minting invariant across all operations', () => {
    const N = 5
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2_inherit')

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
    const bountyPot = state.econ!.pots.bounty_pot_lamports

    // Simulate multiple kills with inheritance (player 0 kills everyone)
    let currentRoster = [...roster]
    let currentOrbs = [...state.orbs]
    let frame = 1

    while (currentRoster.length > 1) {
      const victim = currentRoster[currentRoster.length - 1]
      const killer = currentRoster[0]

      state.frame = frame
      const ownersBefore = [...currentRoster]
      const ownersAfter = currentRoster.filter(p => p !== victim)
      const victimIdx = currentOrbs.length - 1 // Last orb is victim

      const frameEvents = [{ type: 'tether_destroyed', owner: victimIdx, attacker: 0 }]

      currentOrbs = currentOrbs.filter((_, idx) => idx !== victimIdx)
      state.orbs = currentOrbs

      applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

      currentRoster = ownersAfter
      frame++
    }

    // After all eliminations, only player0 should have all the bounty
    // (accumulated through scheduled payouts + inheritance)
    // Plus survival pot goes to winner but that's handled in finalization
    const winnerBounty = state.econ!.perPlayer[roster[0]].bounty_earned || 0

    // Winner should have accumulated all scheduled bounty payouts through inheritance
    // The sum of schedule[N]..schedule[2] should equal bounty_pot
    expect(winnerBounty).toBe(bountyPot)
  })

  it('handles self-elimination correctly (no inheritance)', () => {
    const N = 3
    const entry = 100_000_000
    const roster = Array.from({ length: N }, (_, i) =>
      i.toString(16).padStart(64, '0')
    )
    const [player0, player1, player2] = roster

    const state = makeTestState()
    const cfg = makeTestConfig(N, entry, 'weighted_kill_v2_inherit')

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

    // Manually set player1 to have some bounty
    state.econ!.perPlayer[player1].bounty_earned = 10_000_000

    // Frame 1: player1 self-eliminates (attacker === victim)
    state.frame = 1
    const ownersBefore = [player0, player1, player2]
    const ownersAfter = [player0, player2]
    const frameEvents = [{ type: 'tether_destroyed', owner: 1, attacker: 1 }]
    state.orbs = [state.orbs[0], state.orbs[2]]

    applyEconomicScoring(state, frameEvents, ownersBefore, ownersAfter)

    // No inheritance should occur for self-elimination
    const inheritEvents = state.econ!.events.filter(e => e.type === 'KillInheritance')
    expect(inheritEvents.length).toBe(0)
  })
})
