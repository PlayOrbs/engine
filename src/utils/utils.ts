export const toHex = (a: Uint8Array) => {
  let s = "";
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
  return s;
};

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
};

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const enc = new TextEncoder();
export const tag = (s: string) => enc.encode(s);
