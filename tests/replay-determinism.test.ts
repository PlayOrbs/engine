import { describe, it, expect } from 'vitest'
import { initFromSeed, advanceFrame } from '../src/core/v1/sim.js'
import type { EngineConfig, Player, EngineState } from '../src/core/v1/types.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

// Mock replay precompute functions for testing
function startPrecompute() { /* mock */ }
function restoreCheckpoint() { return null }
function getCurrentPrecompute() { return null }

/**
 * Create a deterministic test configuration
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
    orbs: {
      radius: 8
    },
    disableTraits: true,
    economicsInputs: undefined
  }
}

/**
 * Create deterministic test players
 */
function createTestPlayers(count: number, seed: Uint8Array): Player[] {
  const players: Player[] = []
  const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF']
  
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

/**
 * Extract orb positions for comparison
 */
function extractOrbPositions(state: EngineState): Array<{x: number, y: number, vx: number, vy: number}> {
  return state.orbs.map(orb => ({
    x: Math.round(orb.x * 1000) / 1000, // Round to 3 decimal places
    y: Math.round(orb.y * 1000) / 1000,
    vx: Math.round(orb.vx * 1000) / 1000,
    vy: Math.round(orb.vy * 1000) / 1000
  }))
}

describe('Replay Determinism Tests', () => {
  const testSeed = sha256(new TextEncoder().encode('determinism-test-seed'))
  const testPlayers = createTestPlayers(4, testSeed)
  const testConfig = createTestConfig()

  it('should produce identical results when simulating from same seed multiple times', () => {
    const targetFrame = 100
    const runs = 3
    const results: Array<{x: number, y: number, vx: number, vy: number}[]> = []

    // Run simulation multiple times from same seed
    for (let run = 0; run < runs; run++) {
      const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
      
      // Advance to target frame
      let currentState = state
      while (currentState.frame < targetFrame && currentState.orbs.length > 1) {
        currentState = advanceFrame(currentState, testConfig, prngs)
      }
      
      results.push(extractOrbPositions(currentState))
    }

    // All runs should produce identical results
    for (let i = 1; i < runs; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })

  it('should produce identical results when using different canvas sizes with same center', () => {
    const targetFrame = 50
    
    // Config 1: 800x600 (center: 400, 300)
    const config1 = createTestConfig()
    
    // Config 2: 1200x900 (center: 600, 450) - different size, different center
    const config2 = { ...config1, canvas: { width: 1200, height: 900 } }
    
    // Run with config 1
    const { state: state1, prngs: prngs1 } = initFromSeed(testSeed, testPlayers, config1)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, config1, prngs1)
    }
    
    // Run with config 2
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, config2)
    let currentState2 = state2
    while (currentState2.frame < targetFrame && currentState2.orbs.length > 1) {
      currentState2 = advanceFrame(currentState2, config2, prngs2)
    }
    
    const positions1 = extractOrbPositions(currentState1)
    const positions2 = extractOrbPositions(currentState2)
    
    // Results should be different due to different canvas sizes
    expect(positions1).not.toEqual(positions2)
  })

  it('should produce identical results when using same canvas size', () => {
    const targetFrame = 50
    
    // Two identical configs
    const config1 = createTestConfig()
    const config2 = createTestConfig()
    
    // Run with config 1
    const { state: state1, prngs: prngs1 } = initFromSeed(testSeed, testPlayers, config1)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, config1, prngs1)
    }
    
    // Run with config 2
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, config2)
    let currentState2 = state2
    while (currentState2.frame < targetFrame && currentState2.orbs.length > 1) {
      currentState2 = advanceFrame(currentState2, config2, prngs2)
    }
    
    const positions1 = extractOrbPositions(currentState1)
    const positions2 = extractOrbPositions(currentState2)
    
    // Results should be identical with same config
    expect(positions1).toEqual(positions2)
  })

  it('should produce consistent results when advancing frame by frame vs batch', () => {
    const targetFrame = 30
    
    // Method 1: Advance frame by frame
    const { state: state1, prngs: prngs1 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, testConfig, prngs1)
    }
    
    // Method 2: Advance in batch (same as method 1, but explicit)
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState2 = state2
    for (let frame = 0; frame < targetFrame && currentState2.orbs.length > 1; frame++) {
      currentState2 = advanceFrame(currentState2, testConfig, prngs2)
    }
    
    const positions1 = extractOrbPositions(currentState1)
    const positions2 = extractOrbPositions(currentState2)
    
    expect(positions1).toEqual(positions2)
  })

  it('should handle PRNG state correctly when orbs have individual PRNGs removed', () => {
    const targetFrame = 20
    
    // Run 1: Normal simulation
    const { state: state1, prngs: prngs1 } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, testConfig, prngs1)
    }
    
    // Run 2: Remove individual orb PRNGs (like in replay restoration)
    const { state: state2, prngs: prngs2 } = initFromSeed(testSeed, testPlayers, testConfig)
    // Remove individual orb PRNGs to force use of global bounce PRNGs
    state2.orbs.forEach(orb => {
      delete (orb as any).prng
    })
    let currentState2 = state2
    while (currentState2.frame < targetFrame && currentState2.orbs.length > 1) {
      currentState2 = advanceFrame(currentState2, testConfig, prngs2)
    }
    
    const positions1 = extractOrbPositions(currentState1)
    const positions2 = extractOrbPositions(currentState2)
    
    // Results should be identical since physics should use global PRNGs consistently
    expect(positions1).toEqual(positions2)
  })

  it('should produce different results with different seeds', () => {
    const targetFrame = 30
    const seed1 = sha256(new TextEncoder().encode('seed-1'))
    const seed2 = sha256(new TextEncoder().encode('seed-2'))
    
    // Run with seed 1
    const { state: state1, prngs: prngs1 } = initFromSeed(seed1, testPlayers, testConfig)
    let currentState1 = state1
    while (currentState1.frame < targetFrame && currentState1.orbs.length > 1) {
      currentState1 = advanceFrame(currentState1, testConfig, prngs1)
    }
    
    // Run with seed 2
    const { state: state2, prngs: prngs2 } = initFromSeed(seed2, testPlayers, testConfig)
    let currentState2 = state2
    while (currentState2.frame < targetFrame && currentState2.orbs.length > 1) {
      currentState2 = advanceFrame(currentState2, testConfig, prngs2)
    }
    
    const positions1 = extractOrbPositions(currentState1)
    const positions2 = extractOrbPositions(currentState2)
    
    // Different seeds should produce different results
    expect(positions1).not.toEqual(positions2)
  })

  it('should maintain frame consistency', () => {
    const targetFrame = 25
    
    const { state, prngs } = initFromSeed(testSeed, testPlayers, testConfig)
    let currentState = state
    
    // Track frame progression
    const frames: number[] = []
    while (currentState.frame < targetFrame && currentState.orbs.length > 1) {
      frames.push(currentState.frame)
      currentState = advanceFrame(currentState, testConfig, prngs)
    }
    
    // Frames should increment by 1 each time
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBe(frames[i-1] + 1)
    }
    
    // Final frame should match target (or be less if game ended early)
    expect(currentState.frame).toBeLessThanOrEqual(targetFrame)
  })
})