import { sha256 } from '@noble/hashes/sha2.js'
import { Input } from '../core/v1/types.js'

export function order(inputs: Input[]): Input[] {
  return inputs.slice().sort((a, b) => a.frame - b.frame)
}

export function hashInput(i: Input): Uint8Array {
  const enc = new TextEncoder()
  const payload = (() => {
    switch (i.kind) {
      case 'join': return JSON.stringify(['join', i.frame, Array.from(i.player), Array.from(i.sig)])
      case 'nudge': return JSON.stringify(['nudge', i.frame, Array.from(i.player), i.thrust, i.nonce.toString(), Array.from(i.sig)])
      case 'disconnect': return JSON.stringify(['disconnect', i.frame, Array.from(i.player), Array.from(i.sig)])
    }
  })()
  return sha256(enc.encode(payload))
}

export function rollingHash(inputs: Input[]): Uint8Array {
  const enc = new TextEncoder()
  let acc: Uint8Array<ArrayBufferLike> = new Uint8Array(0) as Uint8Array<ArrayBufferLike>
  for (const i of order(inputs)) {
    const h = hashInput(i)
    const merged = new Uint8Array(acc.length + h.length)
    merged.set(acc, 0); merged.set(h, acc.length)
    acc = sha256(merged)
  }
  return acc as unknown as Uint8Array
}
