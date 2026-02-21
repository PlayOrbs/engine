import { describe, it, expect } from 'vitest'
import { initFromSeed, replay, advanceFrame } from '../src/core/v1/sim.js'
import { EngineConfig } from '../src/core/v1/types.js'
import { sumPerKillSchedule } from '../src/economics/scoring.js'

/**
 * Practice/Sim mode parity tests
 * Ensure practice mode uses identical physics and economics as live mode
 */

function makeTestConfig(
  N: number,
  entry: number,
  mode: 'paid' | 'free_sim',
  tpTargets?: Record<string, number>
): EngineConfig {
  const roster = Array.from({ length: N }, (_, i) =>
    i.toString(16).padStart(64, '0')
  )

  return {
    canvas: { width: 800, height: 600 },
    boundary: { radius: 300, restitution: 0.5, tangentImpulse: 0.5, minSpeed: 1 },
    burst: { lineWidth: 2 },
    orbs: { radius: 10, baseSpeed: 8, colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] },
    economicsInputs: {
      header: {
        round_id: 1,
        seed_hex: 'deadbeef',
        map_id: 'test_map',
        rules_hash: 'rules123',
        build_hash: 'build456',
        mode,
        economy_model: 'weighted_kill_v2_inherit',
        dev_fee_bps: 2000
      },
      economic_params: {
        total_players: N,
        entry_amount_lamports: entry,
        bounty_bps: 7000,
        survival_bps: 3000,
        simulated: mode === 'free_sim'
      },
      roster,
      tp_targets_lamports: tpTargets
    }
  }
}

function makePlayers(N: number) {
  return Array.from({ length: N }, (_, i) => {
    const pubkey = new Uint8Array(32)
    pubkey[0] = i
    const joinNonce = new Uint8Array(32)
    joinNonce[0] = i
    return { pubkey, joinNonce, color: '#ffffff' }
  })
}

describe('Practice Mode Parity', () => {
  it('practice and live modes produce identical physics results', () => {
    const seed = new Uint8Array(32).fill(42)
    const N = 4
    const players = makePlayers(N)

    const paidCfg = makeTestConfig(N, 10_000_000, 'paid')
    const freeCfg = makeTestConfig(N, 10_000_000, 'free_sim')

    const { state: paidInit } = initFromSeed(seed, players, paidCfg)
    const { state: freeInit } = initFromSeed(seed, players, freeCfg)

    // Initial orb positions should be identical
    expect(paidInit.orbs.length).toBe(freeInit.orbs.length)
    for (let i = 0; i < paidInit.orbs.length; i++) {
      expect(paidInit.orbs[i].x).toBe(freeInit.orbs[i].x)
      expect(paidInit.orbs[i].y).toBe(freeInit.orbs[i].y)
      expect(paidInit.orbs[i].vx).toBe(freeInit.orbs[i].vx)
      expect(paidInit.orbs[i].vy).toBe(freeInit.orbs[i].vy)
    }
  })

  it('practice mode initializes same economic schedule as live', () => {
    const seed = new Uint8Array(32).fill(123)
    const N = 5
    const entry = 10_000_000 // 0.01 SOL
    const players = makePlayers(N)

    const paidCfg = makeTestConfig(N, entry, 'paid')
    const freeCfg = makeTestConfig(N, entry, 'free_sim')

    const { state: paidState } = initFromSeed(seed, players, paidCfg)
    const { state: freeState } = initFromSeed(seed, players, freeCfg)

    // Both should have economics initialized
    expect(paidState.econ).toBeDefined()
    expect(freeState.econ).toBeDefined()

    // Pots should match
    expect(paidState.econ!.pots.bounty_pot_lamports).toBe(freeState.econ!.pots.bounty_pot_lamports)
    expect(paidState.econ!.pots.survival_pot_lamports).toBe(freeState.econ!.pots.survival_pot_lamports)

    // Schedules should match
    const paidSched = paidState.econ!.perKillSchedule
    const freeSched = freeState.econ!.perKillSchedule
    expect(paidSched).toBeDefined()
    expect(freeSched).toBeDefined()

    for (let A = N; A >= 2; A--) {
      expect(paidSched![A]).toBe(freeSched![A])
    }

    // Verify sum equals bounty_pot
    const paidSum = sumPerKillSchedule(paidSched!, N)
    const freeSum = sumPerKillSchedule(freeSched!, N)
    expect(paidSum).toBe(paidState.econ!.pots.bounty_pot_lamports)
    expect(freeSum).toBe(freeState.econ!.pots.bounty_pot_lamports)
  })

  it('practice mode honors TP targets identically to live', () => {
    const seed = new Uint8Array(32).fill(99)
    const N = 3
    const entry = 10_000_000
    const players = makePlayers(N)
    const roster = players.map(p => {
      let hex = ''
      for (let i = 0; i < p.pubkey.length; i++) {
        hex += p.pubkey[i].toString(16).padStart(2, '0')
      }
      return hex
    })

    const tpTargets = {
      [roster[0]]: 15_000_000 // 0.015 SOL
    }

    const paidCfg = makeTestConfig(N, entry, 'paid', tpTargets)
    const freeCfg = makeTestConfig(N, entry, 'free_sim', tpTargets)

    const { state: paidState } = initFromSeed(seed, players, paidCfg)
    const { state: freeState } = initFromSeed(seed, players, freeCfg)

    // Both should have TP targets
    expect(paidState.econ!.tp_targets).toEqual(tpTargets)
    expect(freeState.econ!.tp_targets).toEqual(tpTargets)
  })

  it('replay produces deterministic results independent of mode', () => {
    const seed = new Uint8Array(32).fill(77)
    const N = 4
    const entry = 10_000_000
    const players = makePlayers(N)

    const paidCfg = makeTestConfig(N, entry, 'paid')
    const freeCfg = makeTestConfig(N, entry, 'free_sim')

    const { state: paidReplay } = replay(seed, players, [], 100, paidCfg)
    const { state: freeReplay } = replay(seed, players, [], 100, freeCfg)

    // Final orb count should match
    expect(paidReplay.orbs.length).toBe(freeReplay.orbs.length)

    // Final frame should match
    expect(paidReplay.frame).toBe(freeReplay.frame)

    // If economics are present, final bounty distribution should match
    if (paidReplay.econ && freeReplay.econ) {
      const paidRoster = paidReplay.econ.roster
      const freeRoster = freeReplay.econ.roster

      for (const playerId of paidRoster) {
        const paidPlayer = paidReplay.econ.perPlayer[playerId]
        const freePlayer = freeReplay.econ.perPlayer[playerId]

        expect(paidPlayer.bounty_earned).toBe(freePlayer.bounty_earned)
        expect(paidPlayer.survival_earned).toBe(freePlayer.survival_earned)
        expect(paidPlayer.total_earned).toBe(freePlayer.total_earned)
        expect(paidPlayer.kills).toBe(freePlayer.kills)
      }
    }
  })

  it('advanceFrame step-by-step matches replay for determinism', () => {
    const seed = new Uint8Array(32).fill(55)
    const N = 3
    const entry = 10_000_000
    const players = makePlayers(N)
    const cfg = makeTestConfig(N, entry, 'free_sim')

    // Replay method
    const { state: replayState } = replay(seed, players, [], 50, cfg)

    // Step-by-step method
    const { state: stepState, prngs } = initFromSeed(seed, players, cfg)
    for (let i = 0; i < 50 && stepState.orbs.length > 1; i++) {
      advanceFrame(stepState, cfg, prngs)
    }

    // Results should be identical
    expect(stepState.frame).toBe(replayState.frame)
    expect(stepState.orbs.length).toBe(replayState.orbs.length)

    // Economics should match
    if (stepState.econ && replayState.econ) {
      for (const playerId of stepState.econ.roster) {
        const stepPlayer = stepState.econ.perPlayer[playerId]
        const replayPlayer = replayState.econ.perPlayer[playerId]

        expect(stepPlayer.bounty_earned).toBe(replayPlayer.bounty_earned)
        expect(stepPlayer.total_earned).toBe(replayPlayer.total_earned)
        expect(stepPlayer.kills).toBe(replayPlayer.kills)
      }
    }
  })
})
