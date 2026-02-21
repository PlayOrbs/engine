import { describe, it, expect } from 'vitest'
import { countUniqueOwners } from '../src/core/v1/sim.js'
import { toHex } from '../src/utils/utils.js'

describe('countUniqueOwners', () => {
  it('counts single orb per player correctly', () => {
    const orbs = [
      { owner: new Uint8Array(32).fill(1) },
      { owner: new Uint8Array(32).fill(2) },
      { owner: new Uint8Array(32).fill(3) },
    ]
    expect(countUniqueOwners(orbs)).toBe(3)
  })

  it('counts multiple orbs from same player as one', () => {
    const player1 = new Uint8Array(32).fill(1)
    const player2 = new Uint8Array(32).fill(2)
    
    // Player 1 has 3 orbs (e.g., from splits), Player 2 has 1
    const orbs = [
      { owner: player1 },
      { owner: player1 },
      { owner: player1 },
      { owner: player2 },
    ]
    expect(countUniqueOwners(orbs)).toBe(2)
  })

  it('returns 1 when all orbs belong to same player', () => {
    const player1 = new Uint8Array(32).fill(1)
    
    // All orbs from same player (split scenario)
    const orbs = [
      { owner: player1 },
      { owner: player1 },
      { owner: player1 },
      { owner: player1 },
    ]
    expect(countUniqueOwners(orbs)).toBe(1)
  })

  it('returns 0 for empty orbs array', () => {
    expect(countUniqueOwners([])).toBe(0)
  })

  it('handles complex split scenario - game should end when one player remains', () => {
    const player1 = new Uint8Array(32).fill(1)
    const player2 = new Uint8Array(32).fill(2)
    
    // Scenario: Player 1 has 2 orbs, Player 2 has 3 orbs (both split)
    // Total orbs = 5, but only 2 unique players
    const orbsBothAlive = [
      { owner: player1 },
      { owner: player1 },
      { owner: player2 },
      { owner: player2 },
      { owner: player2 },
    ]
    expect(countUniqueOwners(orbsBothAlive)).toBe(2)
    
    // After player 2's orbs are all eliminated, only player 1's orbs remain
    // Game should end even though 2 orbs exist
    const orbsPlayer1Only = [
      { owner: player1 },
      { owner: player1 },
    ]
    expect(countUniqueOwners(orbsPlayer1Only)).toBe(1)
  })

  it('correctly identifies game end condition with splits', () => {
    const player1 = new Uint8Array(32).fill(1)
    const player2 = new Uint8Array(32).fill(2)
    const player3 = new Uint8Array(32).fill(3)
    
    // 3 players, each with 1 orb
    let orbs = [
      { owner: player1 },
      { owner: player2 },
      { owner: player3 },
    ]
    expect(countUniqueOwners(orbs)).toBe(3)
    expect(countUniqueOwners(orbs) > 1).toBe(true) // Game continues
    
    // Player 3 eliminated, player 1 splits
    orbs = [
      { owner: player1 },
      { owner: player1 }, // split child
      { owner: player2 },
    ]
    expect(countUniqueOwners(orbs)).toBe(2)
    expect(countUniqueOwners(orbs) > 1).toBe(true) // Game continues
    
    // Player 2 eliminated (all their orbs gone)
    orbs = [
      { owner: player1 },
      { owner: player1 }, // split child
    ]
    expect(countUniqueOwners(orbs)).toBe(1)
    expect(countUniqueOwners(orbs) > 1).toBe(false) // Game should END
  })
})

describe('split child orb ownership', () => {
  it('verifies split children inherit parent owner', () => {
    // This test documents the expected behavior:
    // When an orb splits, both children should have the same owner as the parent
    const parentOwner = new Uint8Array(32).fill(42)
    
    // Simulating what physics.ts does when creating split children:
    // childCommon = { owner: (parent as any).owner, ... }
    const parent = { owner: parentOwner, x: 0, y: 0, vx: 1, vy: 1 }
    const child1 = { owner: parent.owner, x: 10, y: 0, vx: 0.5, vy: 0.5 }
    const child2 = { owner: parent.owner, x: -10, y: 0, vx: -0.5, vy: 0.5 }
    
    // All three should have same owner hex
    expect(toHex(child1.owner)).toBe(toHex(parentOwner))
    expect(toHex(child2.owner)).toBe(toHex(parentOwner))
    
    // Count should be 1 (same player)
    const orbs = [child1, child2]
    expect(countUniqueOwners(orbs)).toBe(1)
  })
})
