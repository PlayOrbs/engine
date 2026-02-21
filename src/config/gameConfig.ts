/**
 * Game Configuration Type
 *
 * Type definition for the engine config. Actual config values
 * are fetched from ICP canisters at runtime.
 */

import { sha256JSON } from "../utils/hash";

export type GameConfig = {
  version: string;
  canvas: {
    width: number;
    height: number;
  };
  ui: {
    preGameSeconds: number;
  };
  boundary: {
    shape: "circle" | "rect";
    radius: number;
    color: string;
    lineWidth: number;
    restitution: number;
    tangentImpulse: number;
    minSpeed: number;
    maxSpeed: number;
    twoOrbsMaxSpeed: number;
    twoOrbsRampFrames: number;
    rectHalfWidth?: number;
    rectHalfHeight?: number;
  };
  orbs: {
    count: number;
    radius: number;
    speed: number;
    amplitude: number;
    colors: string[];
    baseSpeed?: number;
    spawn?: {
      mode?: "rings" | "random"; // default 'random'
      pad?: number; // default 4 (extra arc spacing)
      minInnerClear?: number; // default 16 (keep center clear)
      startInset?: number; // default 6 (inset first ring from boundary)
      ringGap?: number; // default 2*radius + pad
      velocity?: "none" | "tangent" | "outward"; // default 'tangent'
      assign?: "seedOnly" | "none"; // default 'seedOnly'
      ringsMin: number; // at least 1 ring
      ringsMax: number; // up to 3 rings, chosen from seed
      jitter: boolean; // small deterministic random offsets
    };
  };
  burst: {
    lineCount: number;
    minLength: number;
    maxLength: number;
    lineWidth: number;
    clashDistance: number;
  };
  performance: {
    maxLines: number;
    animationDuration: number;
  };
  tethers: {
    hitDamping: number;
    springRest: number;
    springK: number;
    breakSpeedMin?: number;
    springDamping: number;
    immunityFrames?: number;
  };
  gravity: {
    base: number;
    ampFrac: number;
    periodFrames: number;
    oscillateBelowOrbs: number;
  };
  edgeGuide: {
    enabled: boolean;
    radiusTargetFrac: number; // Steer at 92% of boundary radius
    bandWidth: number; // ±28px band around target
    k: number; // Steering strength
    minSpeedGate: number; // Only steer if speed ≥ 0.8
  };
  edgeGravity: {
    strength: number;
    count: number;
    insetPixels: number;
  };
  collisions: {
    orbRestitution: number;
  };
  split: {
    enabled: boolean;
    enableBelowOrbs?: number;
    vnThreshold: number;
    keThreshold: number;
    radiusScale: number;
    childSpeedMul: number;
    angleSpread: number;
    maxGenerations: number;
    cooldownFrames: number;
    maxOrbsCap: number;
  };
  suddenDeath: {
    enabled: boolean;
    afterFrames: number;
    gravityMultiplier: number;
    rampFrames?: number;
    centerShiftRadius: number;
    centerShiftPeriodFrames: number;
  };
  drama?: {
    targetFrames: number;
    shrinkStart: number;
    shrinkTo: number;
    restitutionMulEnd: number;
    gravityMulEnd: number;
    jitterMulEnd: number;
    easing?: "linear" | "easeInQuad" | "easeOutCubic";
  };
  fx: {
    shockwave: {
      enabled: boolean;
      lifeFrames: number;
      maxRadius: number;
      ringThickness: number;
      respectProtect: boolean;
      cutMode?: "anchor" | "segment";
      triggerOnSplit?: boolean;
      triggerOnImpact?: boolean;
      impactThreshold?: number;
      impactCutsTethers?: boolean;
    };
  };
  debug: {
    showEdgePoints: boolean;
  };
  rendering?: {
    dimUntilBreakSpeed: boolean;
    orbDimAlpha: number;
    tetherDimAlpha: number;
  };
  disableTraits: boolean;
};

/**
 * Get deterministic hash of config for verification
 * Uses canonical JSON (sorted keys) to ensure same hash across environments
 */
export async function getConfigHash(
  config: GameConfig,
  short: boolean = false,
): Promise<string> {
  return sha256JSON(config, short);
}
