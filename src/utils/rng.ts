import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

export function sha256Concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length }
  return sha256(out)
}

export function makePRNG(seed: Uint8Array) {
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0), i = 0, ctr = 0
  const seedCopy = new Uint8Array(seed)
  function refill() {
    const info = new TextEncoder().encode('blk:' + ctr++)
    buf = hkdf(sha256, seedCopy, new Uint8Array(0), info, 4096)
    i = 0
  }
  function nextU32() {
    if (i + 4 > buf.length) refill()
    const v = ((buf[i]<<24)|(buf[i+1]<<16)|(buf[i+2]<<8)|buf[i+3]) >>> 0
    i += 4
    return v
  }
  const api = {
    nextU32,
    nextF32: () => nextU32() / 4294967296,
    derive: (info: string) => makePRNG(sha256Concat(seedCopy, new TextEncoder().encode(info))),
    __getState: () => ({ seed: new Uint8Array(seedCopy), buf: new Uint8Array(buf as Uint8Array), i, ctr }),
    __setState: (st: { seed: Uint8Array; buf: Uint8Array; i: number; ctr: number }) => { seedCopy.set(st.seed); buf = new Uint8Array(st.buf); i = st.i; ctr = st.ctr },
  }
  return api
}
