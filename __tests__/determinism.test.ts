import { sha256 } from '@noble/hashes/sha2.js'
import { initFromSeed } from '../src/core/v1/sim.js'
import { stepFrame as physicsStep } from '../src/core/v1/physics.js'
import { processTethers } from '../src/core/v1/tethers.js'
import { order, rollingHash } from '../src/utils/transcript.js'
import { EngineConfig, Player } from '../src/core/v1/types.js'

const cfg: EngineConfig = {
  canvas: { width: 480, height: 720 },
  boundary: { radius: 240, restitution: 0.95, tangentImpulse: 0.1, minSpeed: 0.05 },
  burst: { lineWidth: 1 },
  orbs: { radius: 12 },
}

function makePlayers(n: number): Player[] {
  const players: Player[] = []
  for (let i = 0; i < n; i++) {
    const pubkey = new Uint8Array(32); pubkey[0] = i
    const joinNonce = new Uint8Array(32); joinNonce[0] = 100 + i
    players.push({ pubkey, joinNonce, color: ['#ff6b35','#8b5cf6','#10b981','#f59e0b'][i % 4] })
  }
  return players
}

describe('Determinism', () => {
  test('same seed + players => identical state after N frames', () => {
    const seed = sha256(new TextEncoder().encode('round-1'))
    const players = makePlayers(2)
    const A = initFromSeed(seed, players, cfg)
    const B = initFromSeed(seed, players, cfg)
    const steps = 200
    for (let i = 0; i < steps; i++) {
      physicsStep(A.state, cfg, A.prngs)
      processTethers(A.state, cfg)
      physicsStep(B.state, cfg, B.prngs)
      processTethers(B.state, cfg)
    }
    expect(JSON.stringify(A.state)).toBe(JSON.stringify(B.state))
  })

  test('rolling hash changes when one input byte changes', () => {
    const transcriptA = order([{ kind: 'join', frame: 1, player: new Uint8Array([1]), sig: new Uint8Array([2]) } as any])
    const transcriptB = order([{ kind: 'join', frame: 1, player: new Uint8Array([1]), sig: new Uint8Array([3]) } as any])
    const hA = rollingHash(transcriptA)
    const hB = rollingHash(transcriptB)
    expect(Buffer.from(hA).toString('hex')).not.toBe(Buffer.from(hB).toString('hex'))
  })

  test('rolling hash invariant to input order when frames differ (sorted by frame)', () => {
    const a = [
      { kind: 'join', frame: 2, player: new Uint8Array([2]), sig: new Uint8Array([9]) } as any,
      { kind: 'join', frame: 1, player: new Uint8Array([1]), sig: new Uint8Array([8]) } as any,
    ]
    const b = [
      { kind: 'join', frame: 1, player: new Uint8Array([1]), sig: new Uint8Array([8]) } as any,
      { kind: 'join', frame: 2, player: new Uint8Array([2]), sig: new Uint8Array([9]) } as any,
    ]
    const hA = rollingHash(a)
    const hB = rollingHash(b)
    expect(Buffer.from(hA).toString('hex')).toBe(Buffer.from(hB).toString('hex'))
  })
})
