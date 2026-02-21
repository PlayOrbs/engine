// ─── Three-Scale Fixed-Point Math for Engine V2 ───
//
// FP_POS  (shift 20) — positions, radii, distances, thresholds  (int32)
// FP_VEL  (shift 30) — velocities                               (safe integer, NOT int32)
// FP_COEF (shift 40) — coefficients (gravity, restitution, etc.) (bigint)
//
// RULES:
//   • No JS bitwise operators on FP_VEL values (they coerce to int32, corrupting values > 2^31).
//   • Bitwise allowed on FP_POS (proven int32-safe) and BigInt (arbitrary precision).
//   • All coefficient applications shift by >> 40n. No other shift constants.
//   • All FP_VEL helpers return safe integers.

// ─── Constants ───

export const FP_POS_SHIFT = 20;
export const FP_POS = 1 << 20; // 1_048_576

export const FP_VEL_SHIFT = 30;
export const FP_VEL = 1073741824; // 1 << 30, stored as number (not bitwise — would be fine here but consistent)

export const FP_COEF_SHIFT = 40;
export const FP_COEF = 1099511627776n; // 1n << 40n
export const FP_COEF_SHIFT_N = 40n;

export const VEL_EXTRA = 1024; // 2^10, used as multiplier/divisor (NOT bitshift)
export const VEL_EXTRA_N = 1024n;

export const FP_POS_N = BigInt(FP_POS);
export const FP_POS_SHIFT_N = 20n;

// ─── Debug flag ───
// Set to true during development/testing to enable assertions.
// Should be false in production builds.
let _DEBUG = false;
export function setDebug(on: boolean): void { _DEBUG = on; }
export function isDebug(): boolean { return _DEBUG; }

// ─── Assertions ───

export function assertSafeVel(v: number, label?: string): void {
  if (!_DEBUG) return;
  if (!Number.isSafeInteger(v)) {
    throw new Error(`FP_VEL invariant violated${label ? ` (${label})` : ''}: ${v} is not a safe integer`);
  }
}

export function assertInt32(v: number, label?: string): void {
  if (!_DEBUG) return;
  if ((v | 0) !== v) {
    throw new Error(`FP_POS int32 invariant violated${label ? ` (${label})` : ''}: ${v}`);
  }
}

// ─── Conversions ───

export function toPos(x: number): number {
  const v = Math.round(x * FP_POS);
  assertInt32(v, 'toPos');
  return v;
}

export function toVel(x: number): number {
  const v = Math.round(x * FP_VEL);
  assertSafeVel(v, 'toVel');
  return v;
}

export function toCoef(x: number): bigint {
  return BigInt(Math.round(x * 1099511627776)); // x * 2^40
}

export function fromPos(x: number): number {
  return x / FP_POS;
}

export function fromVel(x: number): number {
  return x / FP_VEL;
}

export function posToVel(x_pos: number): number {
  return x_pos * 1024;
}

export function velToPos(v: number): number {
  return Math.floor(v / 1024);
}

// ─── FP_POS Arithmetic ───

export function mulPos(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) >> FP_POS_SHIFT_N);
}

export function divPos(n: number, d: number): number {
  return Number((BigInt(n) << FP_POS_SHIFT_N) / BigInt(d));
}

export function hypotPos(dx: number, dy: number): number {
  return Number(isqrt(BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)));
}

// ─── FP_VEL Arithmetic ───

export function hypotVel(vx: number, vy: number): number {
  return Number(isqrt(BigInt(vx) * BigInt(vx) + BigInt(vy) * BigInt(vy)));
}

// ─── Cross-Scale Arithmetic ───

/** Dot product of FP_VEL vector · FP_POS unit vector → FP_VEL */
export function dotVelPos(vx: number, vy: number, nx: number, ny: number): number {
  return Number((BigInt(vx) * BigInt(nx) + BigInt(vy) * BigInt(ny)) >> FP_POS_SHIFT_N);
}

/** Multiply FP_VEL scalar by FP_POS scalar → FP_VEL */
export function mulVelPos(v: number, n: number): number {
  return Number((BigInt(v) * BigInt(n)) >> FP_POS_SHIFT_N);
}

/** Apply FP_COEF coefficient to FP_VEL value → FP_VEL. Always >> 40n. */
export function applyCoefVel(v_vel: number, c_coef: bigint): number {
  return Number((BigInt(v_vel) * c_coef) >> FP_COEF_SHIFT_N);
}

// ─── BigInt Helpers ───

/** Integer square root via Newton's method. Returns floor(sqrt(n)). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt: negative input');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

// ─── Number Helpers ───

export function absFp(x: number): number {
  return x < 0 ? -x : x;
}

export function signFp(x: number): number {
  return x < 0 ? -1 : x > 0 ? 1 : 0;
}

export function clampFp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function maxFp(a: number, b: number): number {
  return a > b ? a : b;
}

export function minFp(a: number, b: number): number {
  return a < b ? a : b;
}

// ─── Trig LUT ───
// 4096-entry sine table at FP_POS precision. No interpolation.
// sinFp(idx) returns sin(2π * idx / 4096) * FP_POS, rounded to nearest integer.

const LUT_SIZE = 4096;
const LUT_MASK = 4095;
let SIN_LUT: Int32Array | null = null;

function initSinLut(): Int32Array {
  const lut = new Int32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    lut[i] = Math.round(Math.sin((2 * Math.PI * i) / LUT_SIZE) * FP_POS);
  }
  return lut;
}

function ensureLut(): Int32Array {
  if (!SIN_LUT) SIN_LUT = initSinLut();
  return SIN_LUT;
}

/** Sine at angle index (0..4095) → FP_POS */
export function sinFp(idx: number): number {
  return ensureLut()[idx & LUT_MASK];
}

/** Cosine at angle index (0..4095) → FP_POS */
export function cosFp(idx: number): number {
  return ensureLut()[(idx + 1024) & LUT_MASK];
}

/** Convert radians to angle index (0..4095) */
export function radiansToIdx(rad: number): number {
  return Math.round((rad / (2 * Math.PI)) * 4096) & LUT_MASK;
}
