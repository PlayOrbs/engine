export type EasingType = "linear" | "easeInQuad" | "easeOutCubic";

export type DramaConfig = {
  targetFrames: number;
  shrinkStart: number;
  shrinkTo: number;
  restitutionMulEnd: number;
  gravityMulEnd: number;
  jitterMulEnd: number;
  easing?: EasingType; // Easing function for gravity/jitter ramp (default 'easeInQuad')
};

export const DRAMA_DEFAULTS: DramaConfig = {
  targetFrames: 60 * 120,
  shrinkStart: 0.7,
  shrinkTo: 1.0,
  restitutionMulEnd: 1.0,
  gravityMulEnd: 1.8,
  jitterMulEnd: 1.6,
};

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - x, 3);
}
function easeInQuad(x: number) {
  return x * x;
}
function linear(x: number) {
  return x;
}

function getEasing(type?: EasingType): (x: number) => number {
  switch (type) {
    case "linear":
      return linear;
    case "easeOutCubic":
      return easeOutCubic;
    case "easeInQuad":
      return easeInQuad;
    default:
      return easeOutCubic;
  }
}

export function dramaMultipliers(frame: number, cfg?: Partial<DramaConfig>) {
  const d = { ...DRAMA_DEFAULTS, ...cfg };
  const ease = getEasing(d.easing);
  const t = Math.min(1, frame / d.targetFrames);
  const p = Math.max(0, (t - d.shrinkStart) / (1 - d.shrinkStart)); 
  const shrink = 1 - (1 - d.shrinkTo) * easeOutCubic(p);
  const restMul = 1 - (1 - d.restitutionMulEnd) * t;
  const gravMul = 1 + (d.gravityMulEnd - 1) * ease(t);
  const jitterMul = 1 + (d.jitterMulEnd - 1) * ease(t);
  return { shrink, restMul, gravMul, jitterMul };
}
