// ─── Fixed-Point Engine V2 Types ───
//
// All physics state uses three-scale fixed-point:
//   FP_POS  (shift 20) — positions, radii, distances      (int32)
//   FP_VEL  (shift 30) — velocities                       (safe integer)
//   FP_COEF (shift 40) — coefficients, multipliers         (bigint)

import type { PRNG } from '../v1/types.js'
import type { GameConfig } from '../../config/gameConfig.js'
import type { EasingType } from '../v1/drama.js'
import {
  FP_POS, FP_VEL, FP_COEF,
  toPos, toVel, toCoef,
  radiansToIdx,
} from '../../utils/v2/fpmath.js'

// ─── Trait V2 ───

export type TraitNameV2 = 'aggressive' | 'evasive' | 'heavy' | 'chaotic' | 'precise'

export type TraitV2 = {
  name: TraitNameV2
  restMul: bigint       // FP_COEF
  tanKickMul: bigint    // FP_COEF
  minSpeedMul: bigint   // FP_COEF
  jitterMul: bigint     // FP_COEF
  gravityMul: bigint    // FP_COEF
}

// ─── Skill V2 ───

export type SkillV2 = {
  splitAggroMul: bigint  // FP_COEF
  tetherResMul: bigint   // FP_COEF (always FP_COEF = 1.0, deprecated)
  tetherDefMul: bigint   // FP_COEF
  powerMul: bigint       // FP_COEF
  accelMul: bigint       // FP_COEF - acceleration boost multiplier
}

export const DEFAULT_SKILL_V2: SkillV2 = {
  splitAggroMul: FP_COEF,
  tetherResMul: FP_COEF,
  tetherDefMul: FP_COEF,
  powerMul: FP_COEF,
  accelMul: FP_COEF,
}

// ─── Orb V2 ───

export type OrbV2 = {
  x: number; y: number           // FP_POS (int32)
  vx: number; vy: number         // FP_VEL (safe integer, NOT int32)
  radius: number                 // FP_POS (int32)
  justCollided: boolean
  hadTether: boolean
  color: string
  prng: PRNG
  trait: TraitV2
  owner: Uint8Array
  gen: number
  splitCooldown: number
  skill: SkillV2
}

// ─── Tether V2 ───

export type TetherV2 = {
  anchorX: number; anchorY: number  // FP_POS (int32)
  color: string
  protect: number                   // integer frame count
  rest?: number                     // FP_POS (int32)
}

// ─── Flash V2 (rendering only, kept as float) ───

export type FlashV2 = {
  x: number; y: number   // FP_POS for position
  color: string
  life: number
  maxLife: number
}

// ─── Shockwave V2 ───

export type ShockwaveV2 = {
  x: number; y: number         // FP_POS
  r: number                    // FP_POS (current radius)
  maxR: number                 // FP_POS
  life: number                 // integer frames remaining
  maxLife: number              // integer frames total
  color: string
  thickness: number            // FP_POS
  kind: 'split' | 'impact'
  affectsTethers: boolean
}

// ─── V2 Config (fixed-point, converted once at init) ───

export type V2ConfigFp = {
  // FP_POS (int32)
  cx: number; cy: number
  boundaryRadius: number
  rectHalfWidth: number; rectHalfHeight: number
  orbRadius: number
  breakSpeedMin: number
  springRest: number
  centerShiftRadius: number
  shockMaxRadius: number; shockThickness: number; shockImpactThreshold: number
  edgeBandWidth: number; edgeInsetPixels: number

  // FP_VEL (number, safe integer)
  minSpeed: number; maxSpeed: number; twoOrbsMaxSpeed: number
  baseSpeed: number; edgeMinSpeedGate: number
  vnThreshold_vel: number

  // FP_VEL² (bigint)
  keThreshold_vel2: bigint

  // FP_COEF (bigint)
  restitution: bigint; tangentImpulse: bigint
  gravityBase: bigint; gravityAmpFrac: bigint
  edgeGravityStrength: bigint
  edgeGuideK: bigint; edgeGuideRadiusTargetFrac: bigint
  orbRestitution: bigint
  childSpeedMul: bigint; radiusScale: bigint
  hitDamping: bigint; springK: bigint; springDamping: bigint
  sdGravityMul: bigint; sdTangentMul: bigint; sdRestMul: bigint

  // Integer (no scaling)
  twoOrbsRampFrames: number
  immunityFrames: number; cooldownFrames: number
  maxGenerations: number; maxOrbsCap: number; enableBelowOrbs: number
  gravityPeriodFrames: number; oscillateBelowOrbs: number
  sdAfterFrames: number; sdRampFrames: number; sdCenterShiftPeriodFrames: number
  edgeGravityCount: number
  shockLifeFrames: number
  dramaTargetFrames: number

  // Angle index (0..4095)
  splitAngleSpread: number

  // Booleans / enums
  shape: 'circle' | 'rect'
  splitEnabled: boolean
  sdEnabled: boolean
  edgeGuideEnabled: boolean
  shockEnabled: boolean; shockRespectProtect: boolean
  shockCutMode: 'anchor' | 'segment'
  shockTriggerOnSplit: boolean; shockTriggerOnImpact: boolean
  shockImpactCutsTethers: boolean
  disableTraits: boolean

  // Drama config (easing type stored as enum, rest as FP_COEF)
  dramaShrinkStart: bigint   // FP_COEF (0..1 fraction)
  dramaShrinkTo: bigint      // FP_COEF
  dramaRestMulEnd: bigint    // FP_COEF
  dramaGravMulEnd: bigint    // FP_COEF
  dramaJitterMulEnd: bigint  // FP_COEF
  dramaEasing: EasingType

  // Spawn config (passed through, used at init only)
  spawnMode: 'rings' | 'random'
  spawnPad: number
  spawnStartInset: number
  spawnRingGap: number
  spawnRingsMin: number
  spawnRingsMax: number
  spawnVelocity: 'none' | 'tangent' | 'outward'
  spawnJitter: boolean
}

// ─── Engine State V2 ───

export type EngineStateV2 = {
  engineVersion: 2
  frame: number
  orbs: OrbV2[]
  tethers: TetherV2[][]
  flashes: FlashV2[]
  shockwaves: ShockwaveV2[]
  scores: Record<string, { framesAlive: number; tethersDestroyed: number; score: number }>
  twoOrbsStartFrame?: number
  econ?: import('../v1/types.js').EngineState['econ']
}

// ─── Config Converter ───

export function convertConfigToV2(gc: GameConfig): V2ConfigFp {
  const sw = gc.fx?.shockwave
  const sd = gc.suddenDeath
  const dr = gc.drama
  const eg = gc.edgeGuide
  const sp = gc.orbs.spawn

  return {
    // FP_POS
    cx: toPos(gc.canvas.width / 2),
    cy: toPos(gc.canvas.height / 2),
    boundaryRadius: toPos(gc.boundary.radius),
    rectHalfWidth: toPos(gc.boundary.rectHalfWidth ?? gc.canvas.width / 2),
    rectHalfHeight: toPos(gc.boundary.rectHalfHeight ?? gc.canvas.height / 2),
    orbRadius: toPos(gc.orbs.radius),
    breakSpeedMin: toPos(gc.tethers.breakSpeedMin ?? 0),
    springRest: toPos(gc.tethers.springRest ?? 0),
    centerShiftRadius: toPos(sd?.centerShiftRadius ?? 0),
    shockMaxRadius: toPos(sw?.maxRadius ?? 0),
    shockThickness: toPos(sw?.ringThickness ?? 0),
    shockImpactThreshold: toPos(sw?.impactThreshold ?? 0),
    edgeBandWidth: toPos(eg?.bandWidth ?? 0),
    edgeInsetPixels: toPos(gc.edgeGravity?.insetPixels ?? 0),

    // FP_VEL
    minSpeed: toVel(gc.boundary.minSpeed),
    maxSpeed: toVel(gc.boundary.maxSpeed),
    twoOrbsMaxSpeed: toVel(gc.boundary.twoOrbsMaxSpeed),
    baseSpeed: toVel(gc.orbs.baseSpeed ?? gc.orbs.speed ?? 3),
    edgeMinSpeedGate: toVel(eg?.minSpeedGate ?? 0),
    vnThreshold_vel: toVel(gc.split.vnThreshold),

    // FP_VEL²
    keThreshold_vel2: BigInt(Math.round(gc.split.keThreshold * FP_VEL * FP_VEL)),

    // FP_COEF
    restitution: toCoef(gc.boundary.restitution),
    tangentImpulse: toCoef(gc.boundary.tangentImpulse),
    gravityBase: toCoef(gc.gravity.base),
    gravityAmpFrac: toCoef(gc.gravity.ampFrac),
    edgeGravityStrength: toCoef(gc.edgeGravity?.strength ?? 0),
    edgeGuideK: toCoef(eg?.k ?? 0),
    edgeGuideRadiusTargetFrac: toCoef(eg?.radiusTargetFrac ?? 0),
    orbRestitution: toCoef(gc.collisions.orbRestitution),
    childSpeedMul: toCoef(gc.split.childSpeedMul),
    radiusScale: toCoef(gc.split.radiusScale),
    hitDamping: toCoef(gc.tethers.hitDamping),
    springK: toCoef(gc.tethers.springK ?? 0),
    springDamping: toCoef(gc.tethers.springDamping ?? 0),
    sdGravityMul: toCoef(sd?.gravityMultiplier ?? 1),
    sdTangentMul: toCoef((sd as any)?.tangentImpulseMul ?? 1),
    sdRestMul: toCoef((sd as any)?.restitutionMul ?? 1),

    // Integer
    twoOrbsRampFrames: gc.boundary.twoOrbsRampFrames ?? 0,
    immunityFrames: gc.tethers.immunityFrames ?? 0,
    cooldownFrames: gc.split.cooldownFrames,
    maxGenerations: gc.split.maxGenerations,
    maxOrbsCap: gc.split.maxOrbsCap,
    enableBelowOrbs: gc.split.enableBelowOrbs ?? 999,
    gravityPeriodFrames: gc.gravity.periodFrames,
    oscillateBelowOrbs: gc.gravity.oscillateBelowOrbs,
    sdAfterFrames: sd?.afterFrames ?? 99999,
    sdRampFrames: sd?.rampFrames ?? 0,
    sdCenterShiftPeriodFrames: sd?.centerShiftPeriodFrames ?? 600,
    edgeGravityCount: gc.edgeGravity?.count ?? 0,
    shockLifeFrames: sw?.lifeFrames ?? 0,
    dramaTargetFrames: dr?.targetFrames ?? 7200,

    // Angle index
    splitAngleSpread: radiansToIdx(gc.split.angleSpread),

    // Booleans / enums
    shape: gc.boundary.shape ?? 'circle',
    splitEnabled: gc.split.enabled,
    sdEnabled: sd?.enabled ?? false,
    edgeGuideEnabled: eg?.enabled ?? false,
    shockEnabled: sw?.enabled ?? false,
    shockRespectProtect: sw?.respectProtect ?? true,
    shockCutMode: sw?.cutMode ?? 'anchor',
    shockTriggerOnSplit: sw?.triggerOnSplit ?? false,
    shockTriggerOnImpact: sw?.triggerOnImpact ?? false,
    shockImpactCutsTethers: sw?.impactCutsTethers ?? false,
    disableTraits: gc.disableTraits ?? false,

    // Drama
    dramaShrinkStart: toCoef(dr?.shrinkStart ?? 0.7),
    dramaShrinkTo: toCoef(dr?.shrinkTo ?? 1.0),
    dramaRestMulEnd: toCoef(dr?.restitutionMulEnd ?? 1.0),
    dramaGravMulEnd: toCoef(dr?.gravityMulEnd ?? 1.8),
    dramaJitterMulEnd: toCoef(dr?.jitterMulEnd ?? 1.6),
    dramaEasing: dr?.easing ?? 'easeOutCubic',

    // Spawn
    spawnMode: sp?.mode ?? 'random',
    spawnPad: sp?.pad ?? 4,
    spawnStartInset: sp?.startInset ?? 6,
    spawnRingGap: sp?.ringGap ?? (gc.orbs.radius * 2 + (sp?.pad ?? 4)),
    spawnRingsMin: sp?.ringsMin ?? 1,
    spawnRingsMax: sp?.ringsMax ?? 1,
    spawnVelocity: sp?.velocity ?? 'tangent',
    spawnJitter: sp?.jitter ?? false,
  }
}

// ─── Trait Converter ───

export function convertTraitToV2(t: import('../v1/types.js').Trait): TraitV2 {
  return {
    name: t.name as TraitNameV2,
    restMul: toCoef(t.restMul),
    tanKickMul: toCoef(t.tanKickMul),
    minSpeedMul: toCoef(t.minSpeedMul),
    jitterMul: toCoef(t.jitterMul),
    gravityMul: toCoef(t.gravityMul),
  }
}

// ─── Skill Converter ───

export function convertSkillToV2(s: import('../v1/types.js').Skill): SkillV2 {
  return {
    splitAggroMul: toCoef(s.splitAggroMul),
    tetherResMul: toCoef(s.tetherResMul),
    tetherDefMul: toCoef(s.tetherDefMul),
    powerMul: toCoef(s.powerMul),
    accelMul: toCoef(s.accelMul ?? 1.0),
  }
}
