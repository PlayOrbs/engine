const LUT_SIZE = 4096;
const TWO_PI = Math.PI * 2;
const INV_TWO_PI = 1 / TWO_PI;
const mask = LUT_SIZE - 1;
let SIN_LUT: Float64Array | null = null;

function initSinLut(): Float64Array {
  const lut = new Float64Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / LUT_SIZE) * TWO_PI;
    lut[i] = Math.sin(t);
  }
  return lut;
}

export function detSin(x: number): number {
  if (!SIN_LUT) SIN_LUT = initSinLut();
  const u = x * INV_TWO_PI;
  const f = u - Math.floor(u);
  const idx = f * LUT_SIZE;
  const i0 = (idx | 0) & mask;
  const i1 = (i0 + 1) & mask;
  const t = idx - (idx | 0);
  const y = SIN_LUT[i0] * (1 - t) + SIN_LUT[i1] * t;
  return Math.round(y * 1e12) * 1e-12;
}

export function detCos(x: number): number {
  return detSin(x + Math.PI / 2);
}
