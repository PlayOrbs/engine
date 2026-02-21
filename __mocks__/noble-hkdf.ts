export function hkdf(hash: any, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  // Non-crypto HKDF stand-in for tests: just repeat input bytes deterministically
  const out = new Uint8Array(length)
  let j = 0
  for (let i = 0; i < length; i++) {
    const a = ikm[i % ikm.length] || 0
    const b = salt[i % (salt.length || 1)] || 0
    const c = info[i % (info.length || 1)] || 0
    out[i] = (a ^ ((b + c + i) & 0xff)) & 0xff
    j = (j + 1) % 256
  }
  return out
}
