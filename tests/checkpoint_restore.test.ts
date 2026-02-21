import { describe, it, expect } from 'vitest'
import { initFromSeed } from '../src/core/v1/sim.js'
import { RunnerV1 } from '../src/core/v2/engine_runner.js'
import { baselineConfig, makePlayers, makeSeed } from './shared/determinism_v2/scenarios.js'
import { sha256 } from '@noble/hashes/sha2.js'

function hashState(state: any): string {
  // Hash orb positions + velocities + frame for determinism check
  const parts: string[] = [`f=${state.frame}`]
  for (const o of state.orbs) {
    parts.push(`${o.x},${o.y},${o.vx},${o.vy},${o.radius}`)
  }
  const raw = parts.join('|')
  const hash = sha256(new TextEncoder().encode(raw))
  return Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')
}

describe('Checkpoint Restore Determinism', () => {
  it('RunnerV1: restore from checkpoint produces identical state', () => {
    const seed = makeSeed('cp-test-1')
    const players = makePlayers(4)
    const cfg = { ...baselineConfig, debug: false } as any

    const { state, prngs } = initFromSeed(seed, players, cfg)
    const runner = new RunnerV1(state, prngs, cfg)

    // Advance 500 frames
    for (let i = 0; i < 500; i++) runner.step()
    expect(runner.getFrame()).toBe(500)

    // Make checkpoint
    const cp = runner.makeCheckpoint()

    // Advance to 1000
    for (let i = 0; i < 500; i++) runner.step()
    expect(runner.getFrame()).toBe(1000)
    const hash1 = hashState(runner.getRenderState())

    // Restore checkpoint at 500
    runner.restoreCheckpoint(cp)
    expect(runner.getFrame()).toBe(500)

    // Advance to 1000 again
    for (let i = 0; i < 500; i++) runner.step()
    expect(runner.getFrame()).toBe(1000)
    const hash2 = hashState(runner.getRenderState())

    console.log(`Direct:   ${hash1}`)
    console.log(`Restored: ${hash2}`)
    expect(hash2).toBe(hash1)
  })

  it('RunnerV1: restore from frame 0 checkpoint matches fresh run', () => {
    const seed = makeSeed('cp-test-2')
    const players = makePlayers(4)
    const cfg = { ...baselineConfig, debug: false } as any

    // Run 1: fresh simulation to frame 2000
    const { state: s1, prngs: p1 } = initFromSeed(seed, players, cfg)
    const r1 = new RunnerV1(s1, p1, cfg)
    for (let i = 0; i < 2000; i++) r1.step()
    const hashFresh = hashState(r1.getRenderState())

    // Run 2: checkpoint at frame 0, advance to 2000
    const { state: s2, prngs: p2 } = initFromSeed(seed, players, cfg)
    const r2 = new RunnerV1(s2, p2, cfg)
    const cp0 = r2.makeCheckpoint()
    for (let i = 0; i < 2000; i++) r2.step()
    const hashDirect = hashState(r2.getRenderState())

    // Run 3: restore from cp0, advance to 2000
    r2.restoreCheckpoint(cp0)
    expect(r2.getFrame()).toBe(0)
    for (let i = 0; i < 2000; i++) r2.step()
    const hashRestored = hashState(r2.getRenderState())

    console.log(`Fresh:    ${hashFresh}`)
    console.log(`Direct:   ${hashDirect}`)
    console.log(`Restored: ${hashRestored}`)

    expect(hashDirect).toBe(hashFresh)
    expect(hashRestored).toBe(hashFresh)
  })

  it('RunnerV1: multiple checkpoint/restore cycles stay deterministic', () => {
    const seed = makeSeed('cp-test-3')
    const players = makePlayers(3)
    const cfg = { ...baselineConfig, debug: false } as any

    const { state, prngs } = initFromSeed(seed, players, cfg)
    const runner = new RunnerV1(state, prngs, cfg)

    // Advance 240, checkpoint, advance 240, checkpoint, advance 240
    for (let i = 0; i < 240; i++) runner.step()
    const cp240 = runner.makeCheckpoint()

    for (let i = 0; i < 240; i++) runner.step()
    const cp480 = runner.makeCheckpoint()

    for (let i = 0; i < 240; i++) runner.step()
    const hashDirect = hashState(runner.getRenderState())

    // Restore cp240, advance to 720
    runner.restoreCheckpoint(cp240)
    for (let i = 0; i < 480; i++) runner.step()
    const hashFrom240 = hashState(runner.getRenderState())

    // Restore cp480, advance to 720
    runner.restoreCheckpoint(cp480)
    for (let i = 0; i < 240; i++) runner.step()
    const hashFrom480 = hashState(runner.getRenderState())

    console.log(`Direct:   ${hashDirect}`)
    console.log(`From 240: ${hashFrom240}`)
    console.log(`From 480: ${hashFrom480}`)

    expect(hashFrom240).toBe(hashDirect)
    expect(hashFrom480).toBe(hashDirect)
  })

  it('RunnerV1: precompute-style run matches replay-style run (checkpoint 0 restore + advance)', () => {
    // This test mimics the exact flow that causes the prod bug:
    // 1. Precompute: init → advance to end, save checkpoints
    // 2. Replay: restore checkpoint 0 → advance to end
    // They must produce identical final state.
    const seed = makeSeed('cp-precompute-replay')
    const players = makePlayers(3)
    const cfg = { ...baselineConfig, debug: false } as any

    const { state, prngs } = initFromSeed(seed, players, cfg)
    const runner = new RunnerV1(state, prngs, cfg)

    // Precompute: save checkpoint at frame 0, then advance with periodic checkpoints
    const checkpoints: { frame: number; cp: unknown }[] = []
    checkpoints.push({ frame: 0, cp: runner.makeCheckpoint() })

    const TARGET = 3000
    for (let i = 0; i < TARGET; i++) {
      runner.step()
      if (runner.getFrame() % 240 === 0) {
        checkpoints.push({ frame: runner.getFrame(), cp: runner.makeCheckpoint() })
      }
    }
    const precomputeEndHash = hashState(runner.getRenderState())
    const precomputeEndFrame = runner.getFrame()
    console.log(`Precompute end: frame=${precomputeEndFrame} hash=${precomputeEndHash}`)

    // Replay: restore from checkpoint 0, advance to same frame
    runner.restoreCheckpoint(checkpoints[0].cp)
    expect(runner.getFrame()).toBe(0)

    for (let i = 0; i < TARGET; i++) {
      runner.step()
    }
    const replayEndHash = hashState(runner.getRenderState())
    const replayEndFrame = runner.getFrame()
    console.log(`Replay end:     frame=${replayEndFrame} hash=${replayEndHash}`)

    expect(replayEndFrame).toBe(precomputeEndFrame)
    expect(replayEndHash).toBe(precomputeEndHash)

    // Also test: restore from mid checkpoint, advance to end
    const midCp = checkpoints[Math.floor(checkpoints.length / 2)]
    runner.restoreCheckpoint(midCp.cp)
    const remaining = TARGET - midCp.frame
    for (let i = 0; i < remaining; i++) {
      runner.step()
    }
    const midRestoreHash = hashState(runner.getRenderState())
    console.log(`Mid restore:    frame=${runner.getFrame()} hash=${midRestoreHash}`)

    expect(runner.getFrame()).toBe(precomputeEndFrame)
    expect(midRestoreHash).toBe(precomputeEndHash)
  })
})
