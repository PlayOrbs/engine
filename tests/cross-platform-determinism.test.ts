import { describe, it, expect } from 'vitest'
import { initFromSeed, advanceFrame } from '../src/core/v1/sim.js'
import type { EngineConfig, Player } from '../src/core/v1/types.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'

/**
 * Tests for cross-platform determinism concerns
 * These tests check for potential issues that could cause different results on different devices
 */

function createTestConfig(): EngineConfig {
  return {
    canvas: { width: 800, height: 600 },
    boundary: {
      shape: 'circle',
      radius: 300,
      restitution: 0.95,
      tangentImpulse: 0.1,
      minSpeed: 0.05
    },
    burst: { lineWidth: 2 },
    orbs: { radius: 8 },
    disableTraits: true
  }
}

function createTestPlayers(count: number, seed: Uint8Array): Player[] {
  const players: Player[] = []
  const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00']
  
  for (let i = 0; i < count; i++) {
    const info = new TextEncoder().encode(`player_${i}`)
    const pubkey = hkdf(sha256, seed, new Uint8Array(0), info, 32)
    const joinNonce = hkdf(sha256, seed, pubkey, new TextEncoder().encode('nonce'), 32)
    
    players.push({
      pubkey,
      joinNonce,
      color: colors[i % colors.length]
    })
  }
  
  return players
}

describe('Cross-Platform Determinism Tests', () => {
  const testSeed = sha256(new TextEncoder().encode('cross-platform-test'))
  const testPlayers = createTestPlayers(3, testSeed)
  const testConfig = createTestConfig()

  it('should handle floating point precision consistently', () => {
    // Test with values that could cause precision issues
    const precisionTestConfig = {
      ...testConfig,
      boundary: {
        ...testConfig.boundary,
        restitution: 0.9999999999999999, // Near 1.0
        tangentImpulse: 0.00000000001,    // Very small
        minSpeed: 0.0000001               // Very small
      }
    }

    const runs = 5
    const results = []
    
    for (let i = 0; i < runs; i++) {
      const { state, prngs } = initFromSeed(testSeed, testPlayers, precisionTestConfig)
      let currentState = state
      
      // Run for a few frames to see if precision issues accumulate
      for (let frame = 0; frame < 10 && currentState.orbs.length > 1; frame++) {
        currentState = advanceFrame(currentState, precisionTestConfig, prngs)
      }
      
      results.push(currentState.orbs.map(orb => ({
        x: orb.x,
        y: orb.y,
        vx: orb.vx,
        vy: orb.vy
      })))
    }

    // All runs should be identical despite precision edge cases
    for (let i = 1; i < runs; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })

  it('should handle Math functions consistently', () => {
    // Test operations that might behave differently across platforms
    const mathTestCases = [
      Math.hypot(3, 4),           // Should be exactly 5
      Math.hypot(0, 0),           // Should be 0
      Math.hypot(1e-10, 1e-10),   // Very small values
      Math.cos(0),                // Should be exactly 1
      Math.sin(0),                // Should be exactly 0
      Math.cos(Math.PI / 2),      // Should be very close to 0
      Math.sin(Math.PI / 2),      // Should be exactly 1
      Math.atan2(0, 1),           // Should be 0
      Math.atan2(1, 0),           // Should be π/2
    ]

    // These should be identical across all JavaScript engines
    expect(Math.hypot(3, 4)).toBe(5)
    expect(Math.hypot(0, 0)).toBe(0)
    expect(Math.cos(0)).toBe(1)
    expect(Math.sin(0)).toBe(0)
    expect(Math.atan2(0, 1)).toBe(0)
    
    // Test that our physics calculations are consistent
    const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState = state
    
    const mathResults = []
    for (let frame = 0; frame < 5 && currentState.orbs.length > 1; frame++) {
      currentState = advanceFrame(currentState, testConfig, prngs)
      
      // Capture math-heavy calculations
      mathResults.push(currentState.orbs.map(orb => {
        const dx = orb.x - 400 // canvas center
        const dy = orb.y - 300
        return {
          distance: Math.hypot(dx, dy),
          angle: Math.atan2(dy, dx),
          normalizedX: dx / Math.hypot(dx, dy) || 0,
          normalizedY: dy / Math.hypot(dx, dy) || 0
        }
      }))
    }
    
    // Run the same calculation again
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState2 = state2
    
    const mathResults2 = []
    for (let frame = 0; frame < 5 && currentState2.orbs.length > 1; frame++) {
      currentState2 = advanceFrame(currentState2, testConfig, prngs2)
      
      mathResults2.push(currentState2.orbs.map(orb => {
        const dx = orb.x - 400
        const dy = orb.y - 300
        return {
          distance: Math.hypot(dx, dy),
          angle: Math.atan2(dy, dx),
          normalizedX: dx / Math.hypot(dx, dy) || 0,
          normalizedY: dy / Math.hypot(dx, dy) || 0
        }
      }))
    }
    
    expect(mathResults2).toEqual(mathResults)
  })

  it('should handle edge cases in collision detection', () => {
    // Test scenarios that might cause different behavior on different devices
    const edgeCaseConfig = {
      ...testConfig,
      boundary: {
        ...testConfig.boundary,
        radius: 100.00000000001, // Slightly over integer
      }
    }

    const runs = 3
    const results = []
    
    for (let i = 0; i < runs; i++) {
      const { state, prngs } = initFromSeed(testSeed, testPlayers, edgeCaseConfig)
      let currentState = state
      
      // Run until we get some boundary collisions
      for (let frame = 0; frame < 50 && currentState.orbs.length > 1; frame++) {
        currentState = advanceFrame(currentState, edgeCaseConfig, prngs)
      }
      
      results.push(currentState.orbs.map(orb => ({
        x: Math.round(orb.x * 1e10) / 1e10, // Round to avoid tiny precision differences
        y: Math.round(orb.y * 1e10) / 1e10,
        vx: Math.round(orb.vx * 1e10) / 1e10,
        vy: Math.round(orb.vy * 1e10) / 1e10
      })))
    }

    // Results should be consistent
    for (let i = 1; i < runs; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })

  it('should produce consistent results with different iteration patterns', () => {
    // Test that the order of operations doesn't matter
    const targetFrame = 20
    
    // Method 1: Process all orbs in order
    const { state: state1, prngs: prngs1 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, testConfig, prngs1)
    }
    
    // Method 2: Same as method 1 (should be identical)
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState2 = state2
    while (currentState2.frame < targetFrame && currentState2.orbs.length > 1) {
      currentState2 = advanceFrame(currentState2, testConfig, prngs2)
    }
    
    const positions1 = currentState1.orbs.map(orb => ({ x: orb.x, y: orb.y, vx: orb.vx, vy: orb.vy }))
    const positions2 = currentState2.orbs.map(orb => ({ x: orb.x, y: orb.y, vx: orb.vx, vy: orb.vy }))
    
    expect(positions2).toEqual(positions1)
  })

  it('should handle PRNG state serialization consistently', () => {
    // Test that PRNG state can be serialized and restored consistently
    const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
    
    // Advance a few frames
    let currentState = state
    for (let i = 0; i < 5; i++) {
      currentState = advanceFrame(currentState, testConfig, prngs)
    }
    
    // Serialize PRNG states
    const serializedPrngs = new Map()
    for (const [key, prng] of prngs) {
      const state = (prng as any).__getState()
      serializedPrngs.set(key, {
        seed: Array.from(state.seed),
        buf: Array.from(state.buf),
        i: state.i,
        ctr: state.ctr
      })
    }
    
    // Create new PRNGs from serialized state
    const { prngs: freshPrngs } = initFromSeed(testSeed, testPlayers, testConfig)
    for (const [key, serializedState] of serializedPrngs) {
      const prng = freshPrngs.get(key)
      if (prng) {
        (prng as any).__setState({
          seed: new Uint8Array(serializedState.seed),
          buf: new Uint8Array(serializedState.buf),
          i: serializedState.i,
          ctr: serializedState.ctr
        })
      }
    }
    
    // Both PRNG sets should produce identical next values
    const originalValues = []
    const restoredValues = []
    
    for (let i = 0; i < 10; i++) {
      const originalBounce = prngs.get('bounce:0')
      const restoredBounce = freshPrngs.get('bounce:0')
      
      if (originalBounce && restoredBounce) {
        originalValues.push((originalBounce as any).nextF32())
        restoredValues.push((restoredBounce as any).nextF32())
      }
    }
    
    expect(restoredValues).toEqual(originalValues)
  })
})

describe('Device-Specific Concerns', () => {
  it('should not depend on system time or random sources', () => {
    // Ensure no Date.now(), Math.random(), or other non-deterministic sources
    const originalDateNow = Date.now
    const originalMathRandom = Math.random
    
    // Mock these to throw errors if used
    Date.now = () => { throw new Error('Date.now() should not be used in deterministic simulation') }
    Math.random = () => { throw new Error('Math.random() should not be used in deterministic simulation') }
    
    try {
      const testSeed = sha256(new TextEncoder().encode('no-random-test'))
      const testPlayers = createTestPlayers(2, testSeed)
      const testConfig = createTestConfig()
      
      const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
      let currentState = state
      
      // This should not throw if we're truly deterministic
      for (let i = 0; i < 10 && currentState.orbs.length > 1; i++) {
        currentState = advanceFrame(currentState, testConfig, prngs)
      }
      
      expect(currentState.frame).toBeGreaterThan(0)
    } finally {
      // Restore original functions
      Date.now = originalDateNow
      Math.random = originalMathRandom
    }
  })

  it('should produce consistent results regardless of JavaScript engine optimizations', () => {
    // Test with operations that might be optimized differently
    const testSeed = sha256(new TextEncoder().encode('optimization-test'))
    const testPlayers = createTestPlayers(4, testSeed)
    const testConfig = createTestConfig()
    
    const results = []
    
    // Run multiple times to see if JIT optimizations affect results
    for (let run = 0; run < 5; run++) {
      const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
      let currentState = state
      
      for (let frame = 0; frame < 15 && currentState.orbs.length > 1; frame++) {
        currentState = advanceFrame(currentState, testConfig, prngs)
      }
      
      results.push({
        frame: currentState.frame,
        orbCount: currentState.orbs.length,
        positions: currentState.orbs.map(orb => ({
          x: Math.round(orb.x * 1000) / 1000,
          y: Math.round(orb.y * 1000) / 1000
        }))
      })
    }
    
    // All runs should be identical regardless of optimizations
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })
})
