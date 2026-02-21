export function sha256(input: Uint8Array): Uint8Array {
  // Simple deterministic non-crypto hash for tests
  const out = new Uint8Array(32)
  let a = 0x12345678 >>> 0
  for (let i = 0; i < input.length; i++) {
    a = (a ^ input[i]) >>> 0
    a = (a + ((a << 7) ^ (a >>> 3))) >>> 0
  }
  for (let i = 0; i < 32; i++) {
    a = (a + ((a << 5) ^ (a >>> 11)) + i) >>> 0
    out[i] = a & 0xff
  }
  return out
}
