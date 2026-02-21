import { describe, it, expect } from 'vitest'
import { initFromSeed, advanceFrame } from '../src/core/v1/sim.js'
import type { EngineConfig, Player } from '../src/core/v1/types.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'

/**
 * Tests to ensure games produce identical results on desktop vs mobile devices
 * The key is that both devices must use the SAME logical canvas size
 */

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

function extractGameResult(state: any) {
  return {
    finalFrame: state.frame,
    orbCount: state.orbs.length,
    winner: state.orbs.length === 1 ? state.orbs[0].color : null,
    finalPositions: state.orbs.map((orb: any) => ({
      x: Math.round(orb.x * 1000) / 1000,
      y: Math.round(orb.y * 1000) / 1000,
      color: orb.color
    }))
  }
}

describe('Desktop vs Mobile Consistency', () => {
  const testSeed = sha256(new TextEncoder().encode('desktop-mobile-test'))
  const testPlayers = createTestPlayers(3, testSeed)

  it('should produce identical results with same logical canvas size', () => {
    // Both desktop and mobile should use the SAME logical canvas size
    const logicalCanvasConfig: EngineConfig = {
      canvas: { width: 800, height: 600 }, // Fixed logical size
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

    // Simulate desktop game
    const { state: desktopState, prngs: desktopPrngs } = initFromSeed(testSeed, testPlayers, logicalCanvasConfig)
    let currentDesktopState = desktopState
    
    // Run game to completion or max frames
    const maxFrames = 200
    while (currentDesktopState.frame < maxFrames && currentDesktopState.orbs.length > 1) {
      currentDesktopState = advanceFrame(currentDesktopState, logicalCanvasConfig, desktopPrngs)
    }

    // Simulate mobile game (same config!)
    const { state: mobileState, prngs: mobilePrngs } = initFromSeed(testSeed, testPlayers, logicalCanvasConfig)
    let currentMobileState = mobileState
    
    while (currentMobileState.frame < maxFrames && currentMobileState.orbs.length > 1) {
      currentMobileState = advanceFrame(currentMobileState, logicalCanvasConfig, mobilePrngs)
    }

    // Results should be identical
    const desktopResult = extractGameResult(currentDesktopState)
    const mobileResult = extractGameResult(currentMobileState)

    expect(mobileResult).toEqual(desktopResult)
  })

  it('should produce DIFFERENT results with different canvas sizes (demonstrating the problem)', () => {
    // Desktop config (large screen)
    const desktopConfig: EngineConfig = {
      canvas: { width: 1920, height: 1080 }, // Large desktop
      boundary: {
        shape: 'circle',
        radius: 500,
        restitution: 0.95,
        tangentImpulse: 0.1,
        minSpeed: 0.05
      },
      burst: { lineWidth: 2 },
      orbs: { radius: 8 },
      disableTraits: true
    }

    // Mobile config (small screen)
    const mobileConfig: EngineConfig = {
      canvas: { width: 375, height: 667 }, // iPhone size
      boundary: {
        shape: 'circle',
        radius: 150,
        restitution: 0.95,
        tangentImpulse: 0.1,
        minSpeed: 0.05
      },
      burst: { lineWidth: 2 },
      orbs: { radius: 8 },
      disableTraits: true
    }

    // Run desktop simulation
    const { state: desktopState, prngs: desktopPrngs } = initFromSeed(testSeed, testPlayers, desktopConfig)
    let currentDesktopState = desktopState
    
    for (let i = 0; i < 50 && currentDesktopState.orbs.length > 1; i++) {
      currentDesktopState = advanceFrame(currentDesktopState, desktopConfig, desktopPrngs)
    }

    // Run mobile simulation
    const { state: mobileState, prngs: mobilePrngs } = initFromSeed(testSeed, testPlayers, mobileConfig)
    let currentMobileState = mobileState
    
    for (let i = 0; i < 50 && currentMobileState.orbs.length > 1; i++) {
      currentMobileState = advanceFrame(currentMobileState, mobileConfig, mobilePrngs)
    }

    const desktopResult = extractGameResult(currentDesktopState)
    const mobileResult = extractGameResult(currentMobileState)

    // Results should be DIFFERENT due to different canvas sizes
    expect(mobileResult).not.toEqual(desktopResult)
  })

  it('should handle typical mobile vs desktop screen ratios consistently', () => {
    // Test common aspect ratios but with same logical canvas
    const configs = [
      // Desktop ultrawide
      { width: 800, height: 600, name: 'desktop-standard' },
      // Mobile portrait  
      { width: 800, height: 600, name: 'mobile-portrait' }, // Same logical size!
      // Tablet
      { width: 800, height: 600, name: 'tablet' }, // Same logical size!
    ]

    const results = []

    for (const config of configs) {
      const engineConfig: EngineConfig = {
        canvas: { width: config.width, height: config.height },
        boundary: {
          shape: 'circle',
          radius: 300, // Same relative to canvas
          restitution: 0.95,
          tangentImpulse: 0.1,
          minSpeed: 0.05
        },
        burst: { lineWidth: 2 },
        orbs: { radius: 8 },
        disableTraits: true
      }

      const { state, prngs } = initFromSeed(testSeed, testPlayers, engineConfig)
      let currentState = state
      
      for (let i = 0; i < 30 && currentState.orbs.length > 1; i++) {
        currentState = advanceFrame(currentState, engineConfig, prngs)
      }

      results.push({
        device: config.name,
        result: extractGameResult(currentState)
      })
    }

    // All results should be identical since we used same logical canvas size
    for (let i = 1; i < results.length; i++) {
      expect(results[i].result).toEqual(results[0].result)
    }
  })

  it('should verify PRNG consistency across device types', () => {
    // Test that PRNG produces same sequence on different "devices"
    const config: EngineConfig = {
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

    // Simulate different devices with same config
    const deviceTypes = ['desktop', 'mobile', 'tablet']
    const prngSequences = []

    for (const deviceType of deviceTypes) {
      const { prngs } = initFromSeed(testSeed, testPlayers, config)
      
      // Extract PRNG sequence
      const sequence = []
      const bounceRng = prngs.get('bounce:0')
      if (bounceRng) {
        for (let i = 0; i < 20; i++) {
          sequence.push((bounceRng as any).nextF32())
        }
      }
      
      prngSequences.push({ device: deviceType, sequence })
    }

    // All devices should produce identical PRNG sequences
    for (let i = 1; i < prngSequences.length; i++) {
      expect(prngSequences[i].sequence).toEqual(prngSequences[0].sequence)
    }
  })
})

describe('Real-World Device Simulation', () => {
  it('should simulate actual device configurations', () => {
    const testSeed = sha256(new TextEncoder().encode('real-device-test'))
    const testPlayers = createTestPlayers(4, testSeed)

    // CRITICAL: Both devices must use the SAME logical canvas configuration
    const UNIVERSAL_CONFIG: EngineConfig = {
      canvas: { width: 800, height: 600 }, // Fixed logical size for ALL devices
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

    // Simulate game on "desktop"
    const { state: desktopState, prngs: desktopPrngs } = initFromSeed(testSeed, testPlayers, UNIVERSAL_CONFIG)
    let desktopGame = desktopState
    
    // Simulate game on "mobile" 
    const { state: mobileState, prngs: mobilePrngs } = initFromSeed(testSeed, testPlayers, UNIVERSAL_CONFIG)
    let mobileGame = mobileState

    // Run both games in parallel
    const maxFrames = 100
    while (desktopGame.frame < maxFrames && mobileGame.frame < maxFrames && 
           desktopGame.orbs.length > 1 && mobileGame.orbs.length > 1) {
      
      desktopGame = advanceFrame(desktopGame, UNIVERSAL_CONFIG, desktopPrngs)
      mobileGame = advanceFrame(mobileGame, UNIVERSAL_CONFIG, mobilePrngs)
      
      // Verify they stay in sync every 10 frames
      if (desktopGame.frame % 10 === 0) {
        expect(mobileGame.frame).toBe(desktopGame.frame)
        expect(mobileGame.orbs.length).toBe(desktopGame.orbs.length)
        
        // Check positions are identical
        for (let i = 0; i < desktopGame.orbs.length; i++) {
          expect(Math.round(mobileGame.orbs[i].x * 1000)).toBe(Math.round(desktopGame.orbs[i].x * 1000))
          expect(Math.round(mobileGame.orbs[i].y * 1000)).toBe(Math.round(desktopGame.orbs[i].y * 1000))
        }
      }
    }

    // Final results should be identical
    expect(extractGameResult(mobileGame)).toEqual(extractGameResult(desktopGame))
  })
})
