/**
 * Device Test Runner
 * Tool for manually testing game consistency across different devices
 */

import { initFromSeed, advanceFrame } from '../sim.js'
import type { EngineConfig, Player } from '../types.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'

export interface DeviceTestResult {
  deviceInfo: {
    userAgent: string
    screenWidth: number
    screenHeight: number
    devicePixelRatio: number
    platform: string
  }
  gameResult: {
    seed: string
    finalFrame: number
    orbCount: number
    winner: string | null
    finalPositions: Array<{ x: number; y: number; color: string }>
    checksum: string
  }
  timestamp: number
}

/**
 * Create a standardized test configuration that should be identical across all devices
 */
export function createUniversalTestConfig(): EngineConfig {
  return {
    // CRITICAL: Fixed logical canvas size - never change this!
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
    disableTraits: true,
    economicsInputs: undefined
  }
}

/**
 * Create deterministic test players
 */
export function createTestPlayers(count: number, seed: Uint8Array): Player[] {
  const players: Player[] = []
  const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF']
  
  for (let i = 0; i < count; i++) {
    const info = new TextEncoder().encode(`test_player_${i}`)
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
 * Run a standardized test game and return results
 */
export function runDeviceTest(testName: string = 'standard'): DeviceTestResult {
  // Create deterministic test seed
  const testSeed = sha256(new TextEncoder().encode(`device-test-${testName}`))
  const seedHex = Array.from(testSeed).map(b => (b as number).toString(16).padStart(2, '0')).join('')
  
  // Create test players and config
  const players = createTestPlayers(4, testSeed)
  const config = createUniversalTestConfig()
  
  // Run the game
  const { state, prngs } = initFromSeed(testSeed, players, config)
  let currentState = state
  
  const maxFrames = 300 // Run until completion or max frames
  while (currentState.frame < maxFrames && currentState.orbs.length > 1) {
    currentState = advanceFrame(currentState, config, prngs)
  }
  
  // Extract final positions
  const finalPositions = currentState.orbs.map(orb => ({
    x: Math.round(orb.x * 1000) / 1000, // Round to avoid tiny precision differences
    y: Math.round(orb.y * 1000) / 1000,
    color: orb.color
  }))
  
  // Create checksum of final state for easy comparison
  const stateString = JSON.stringify({
    frame: currentState.frame,
    orbCount: currentState.orbs.length,
    positions: finalPositions
  })
  const checksumBytes = sha256(new TextEncoder().encode(stateString))
  const checksum = Array.from(checksumBytes)
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  
  // Gather device info
  const deviceInfo = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
    screenWidth: typeof screen !== 'undefined' ? screen.width : 0,
    screenHeight: typeof screen !== 'undefined' ? screen.height : 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'Node.js'
  }
  
  return {
    deviceInfo,
    gameResult: {
      seed: seedHex.slice(0, 16),
      finalFrame: currentState.frame,
      orbCount: currentState.orbs.length,
      winner: currentState.orbs.length === 1 ? currentState.orbs[0].color : null,
      finalPositions,
      checksum
    },
    timestamp: Date.now()
  }
}

/**
 * Compare two device test results
 */
export function compareDeviceResults(result1: DeviceTestResult, result2: DeviceTestResult): {
  identical: boolean
  differences: string[]
} {
  const differences: string[] = []
  
  // Check basic game outcome
  if (result1.gameResult.finalFrame !== result2.gameResult.finalFrame) {
    differences.push(`Final frame: ${result1.gameResult.finalFrame} vs ${result2.gameResult.finalFrame}`)
  }
  
  if (result1.gameResult.orbCount !== result2.gameResult.orbCount) {
    differences.push(`Orb count: ${result1.gameResult.orbCount} vs ${result2.gameResult.orbCount}`)
  }
  
  if (result1.gameResult.winner !== result2.gameResult.winner) {
    differences.push(`Winner: ${result1.gameResult.winner} vs ${result2.gameResult.winner}`)
  }
  
  // Check checksum (most important)
  if (result1.gameResult.checksum !== result2.gameResult.checksum) {
    differences.push(`Checksum: ${result1.gameResult.checksum} vs ${result2.gameResult.checksum}`)
  }
  
  // Check positions if counts match
  if (result1.gameResult.orbCount === result2.gameResult.orbCount) {
    for (let i = 0; i < result1.gameResult.finalPositions.length; i++) {
      const pos1 = result1.gameResult.finalPositions[i]
      const pos2 = result2.gameResult.finalPositions[i]
      
      if (Math.abs(pos1.x - pos2.x) > 0.001 || Math.abs(pos1.y - pos2.y) > 0.001) {
        differences.push(`Orb ${i} position: (${pos1.x}, ${pos1.y}) vs (${pos2.x}, ${pos2.y})`)
      }
    }
  }
  
  return {
    identical: differences.length === 0,
    differences
  }
}

/**
 * Generate a test report for sharing between devices
 */
export function generateTestReport(result: DeviceTestResult): string {
  return `
# Device Test Report

## Device Info
- **User Agent**: ${result.deviceInfo.userAgent}
- **Screen**: ${result.deviceInfo.screenWidth}x${result.deviceInfo.screenHeight}
- **Device Pixel Ratio**: ${result.deviceInfo.devicePixelRatio}
- **Platform**: ${result.deviceInfo.platform}
- **Timestamp**: ${new Date(result.timestamp).toISOString()}

## Game Result
- **Seed**: ${result.gameResult.seed}...
- **Final Frame**: ${result.gameResult.finalFrame}
- **Orb Count**: ${result.gameResult.orbCount}
- **Winner**: ${result.gameResult.winner || 'No winner'}
- **Checksum**: ${result.gameResult.checksum}

## Final Positions
${result.gameResult.finalPositions.map((pos, i) => 
  `- Orb ${i} (${pos.color}): (${pos.x}, ${pos.y})`
).join('\n')}

---
*Copy this report and compare with other devices*
`.trim()
}

// Browser-friendly exports for manual testing
if (typeof window !== 'undefined') {
  (window as any).deviceTest = {
    run: runDeviceTest,
    compare: compareDeviceResults,
    report: generateTestReport
  }
}
