// ─── Determinism Test Scenarios for V1 Engine ───
//
// Shared configs and player factories for Node + browser harness.
// All configs are fully specified — no optional fields left to defaults.

import { sha256 } from '@noble/hashes/sha2.js'
import type { EngineConfig, Player } from '../../../src/core/v1/types.js'

export function makePlayers(n: number): Player[] {
  const players: Player[] = []
  for (let i = 0; i < n; i++) {
    const pubkey = new Uint8Array(32)
    pubkey[0] = i & 0xff
    pubkey[1] = (i >> 8) & 0xff
    const joinNonce = new Uint8Array(32)
    joinNonce[0] = 100 + (i & 0xff)
    players.push({ pubkey, joinNonce, color: ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b'][i % 4] })
  }
  return players
}

export function makeSeed(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(label))
}

// ─── Scenario: baseline ───
// Normal production-like config, 4 players, moderate dynamics.
export const baselineConfig: EngineConfig = {
  canvas: { width: 400, height: 720 },
  boundary: {
    shape: 'circle', radius: 190,
    restitution: 1.02, tangentImpulse: 0.01, minSpeed: 1.0,
    maxSpeed: 7.0, twoOrbsMaxSpeed: 12.0, twoOrbsRampFrames: 600,
    rectHalfWidth: 200, rectHalfHeight: 300,
  },
  orbs: {
    radius: 12, baseSpeed: 2,
    spawn: { mode: 'rings', pad: 2, startInset: 104, ringGap: 30, ringsMin: 1, ringsMax: 5, velocity: 'none', jitter: false },
  },
  burst: { lineWidth: 0.8 },
  tethers: { hitDamping: 0.125, springRest: 0, springK: 0.0, springDamping: 0.0, breakSpeedMin: 3, immunityFrames: 200 },
  gravity: { base: 0.0000000001, ampFrac: 0.4, periodFrames: 40, oscillateBelowOrbs: 3 },
  edgeGuide: { enabled: false, radiusTargetFrac: 0.6, bandWidth: 32, k: 0.15, minSpeedGate: 0.4 },
  edgeGravity: { strength: 0.00001, count: 0, insetPixels: 60 },
  collisions: { orbRestitution: 1.004 },
  split: {
    enabled: true, enableBelowOrbs: 5, vnThreshold: 2.0, keThreshold: 12.0,
    radiusScale: 1, childSpeedMul: 0.5, angleSpread: 0.45,
    maxGenerations: 2, cooldownFrames: 300, maxOrbsCap: 24,
  },
  suddenDeath: {
    enabled: true, afterFrames: 600, gravityMultiplier: 2, rampFrames: 600,
    centerShiftRadius: 40, centerShiftPeriodFrames: 120,
  },
  drama: {
    targetFrames: 7200, shrinkStart: 0.70, shrinkTo: 1.0,
    restitutionMulEnd: 1.0, gravityMulEnd: 1.8, jitterMulEnd: 1.6, easing: 'linear',
  },
  fx: {
    shockwave: {
      enabled: true, lifeFrames: 40, maxRadius: 100, ringThickness: 5,
      respectProtect: true, cutMode: 'segment',
      triggerOnSplit: true, triggerOnImpact: true, impactThreshold: 4, impactCutsTethers: true,
    },
  },
  debug: false,
  rendering: { dimUntilBreakSpeed: false, orbDimAlpha: 0.4, tetherDimAlpha: 0.1 },
  disableTraits: true,
}

// ─── Scenario: gravityAccum ───
// Strong gravity, 2 orbs, verify velocity grows over time.
export const gravityAccumConfig: EngineConfig = {
  ...baselineConfig,
  gravity: { base: 0.001, ampFrac: 0.5, periodFrames: 20, oscillateBelowOrbs: 10 },
  split: { ...baselineConfig.split!, enabled: false },
  suddenDeath: { enabled: false, afterFrames: 999999, gravityMultiplier: 1, rampFrames: 1, centerShiftRadius: 0, centerShiftPeriodFrames: 1 },
}

// ─── Scenario: stressTest ───
// 10 orbs, near-cap speeds, all dynamics cranked up.
export const stressConfig: EngineConfig = {
  canvas: { width: 400, height: 720 },
  boundary: {
    shape: 'circle', radius: 190,
    restitution: 1.05,
    tangentImpulse: 0.08,
    minSpeed: 2.0,
    maxSpeed: 10.0,
    twoOrbsMaxSpeed: 15.0,
    twoOrbsRampFrames: 300,
    rectHalfWidth: 200, rectHalfHeight: 300,
  },
  orbs: {
    radius: 10, baseSpeed: 8,
    spawn: { mode: 'rings', pad: 1, startInset: 20, ringGap: 24, ringsMin: 1, ringsMax: 3, velocity: 'none', jitter: false },
  },
  burst: { lineWidth: 0.8 },
  tethers: {
    hitDamping: 0.2,
    springRest: 20,
    springK: 0.005,
    springDamping: 0.01,
    breakSpeedMin: 2,
    immunityFrames: 60,
  },
  gravity: { base: 0.0001, ampFrac: 0.6, periodFrames: 30, oscillateBelowOrbs: 20 },
  edgeGuide: { enabled: true, radiusTargetFrac: 0.5, bandWidth: 40, k: 0.2, minSpeedGate: 0.3 },
  edgeGravity: { strength: 0.001, count: 4, insetPixels: 40 },
  collisions: { orbRestitution: 1.01 },
  split: {
    enabled: true, enableBelowOrbs: 20,
    vnThreshold: 1.0,
    keThreshold: 4.0,
    radiusScale: 1, childSpeedMul: 0.6, angleSpread: 0.5,
    maxGenerations: 3, cooldownFrames: 120, maxOrbsCap: 30,
  },
  suddenDeath: {
    enabled: true, afterFrames: 200,
    gravityMultiplier: 3, rampFrames: 200,
    centerShiftRadius: 50, centerShiftPeriodFrames: 80,
  },
  drama: {
    targetFrames: 5000, shrinkStart: 0.3, shrinkTo: 0.85,
    restitutionMulEnd: 1.2, gravityMulEnd: 3.0, jitterMulEnd: 2.5, easing: 'linear',
  },
  fx: {
    shockwave: {
      enabled: true, lifeFrames: 30, maxRadius: 80, ringThickness: 8,
      respectProtect: false, cutMode: 'segment',
      triggerOnSplit: true, triggerOnImpact: true, impactThreshold: 3, impactCutsTethers: true,
    },
  },
  debug: false,
  rendering: { dimUntilBreakSpeed: false, orbDimAlpha: 0.4, tetherDimAlpha: 0.1 },
  disableTraits: false,
}

export interface ScenarioDef {
  name: string
  seed: Uint8Array
  players: Player[]
  config: EngineConfig
  frames: number
  goldenHash: string
}

export const scenarios: ScenarioDef[] = [
  {
    name: 'baseline',
    seed: makeSeed('determinism-baseline-v1'),
    players: makePlayers(4),
    config: baselineConfig,
    frames: 50_000,
    goldenHash: '',  // Will be captured on first run
  },
  {
    name: 'gravityAccum',
    seed: makeSeed('determinism-gravity-v1'),
    players: makePlayers(2),
    config: gravityAccumConfig,
    frames: 50_000,
    goldenHash: '',  // Will be captured on first run
  },
  {
    name: 'tenOrbsHighSpeedStress',
    seed: makeSeed('determinism-stress-10orbs-v1'),
    players: makePlayers(10),
    config: stressConfig,
    frames: 50_000,
    goldenHash: '',  // Will be captured on first run
  },
]
