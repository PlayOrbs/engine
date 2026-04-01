export type Vec2 = { x: number; y: number }
export type TraitName = "aggressive" | "evasive" | "heavy" | "chaotic" | "precise"
export type Trait = {
  name: TraitName
  restMul: number
  tanKickMul: number
  minSpeedMul: number
  jitterMul: number
  gravityMul: number
}
export type PRNG = { nextU32: () => number; nextF32: () => number; derive: (info: string) => PRNG }
/**
 * Per-orb skill multipliers that influence gameplay without guaranteeing outcomes.
 * All multipliers default to 1.0 (neutral). Values are inherited by child orbs on split.
 *
 * - splitAggroMul: Self-tradeoff stat. Higher values lower YOUR split thresholds (easier to split),
 *   but child orbs receive reduced tetherDefMul. Encourages aggressive/chaotic playstyle.
 * - tetherResMul: DEPRECATED – always 1.0. Kept for serialization compat with old rounds.
 * - tetherDefMul: Defensive stat. Higher values raise the speed threshold enemies need to
 *   break YOUR tethers, making your orbs harder to eliminate. Applied to tether owner.
 * - powerMul: Speed cap multiplier. Higher values allow faster maximum orb velocity,
 *   enabling more aggressive movement and harder-to-dodge attacks.
 */
export type Skill = { splitAggroMul: number; tetherResMul: number; tetherDefMul: number; powerMul: number; accelMul?: number }
export type Orb = {
  x:number; y:number; vx:number; vy:number;
  justCollided:boolean; hadTether:boolean;
  color:string;
  prng: PRNG; trait: Trait;
  owner: Uint8Array;
  radius: number;
  gen: number;
  splitCooldown: number;
  skill: Skill;
}
export type Tether = { anchorX:number; anchorY:number; color:string; protect:number; rest?: number }
export type Flash = { x:number; y:number; color:string; life:number; maxLife:number }
export type Player = { pubkey: Uint8Array; joinNonce: Uint8Array; color?: string }
export type InputJoin = { kind:"join"; frame:number; player: Uint8Array; sig: Uint8Array }
export type InputNudge = { kind:"nudge"; frame:number; player: Uint8Array; thrust: Vec2; nonce: bigint; sig: Uint8Array }
export type InputDisc = { kind:"disconnect"; frame:number; player: Uint8Array; sig: Uint8Array }
export type Input = InputJoin | InputNudge | InputDisc
export type EngineConfig = {
  canvas: { width:number; height:number }
  boundary: { shape?: 'circle' | 'rect'; radius:number; rectHalfWidth?:number; rectHalfHeight?:number; restitution:number; tangentImpulse:number; minSpeed:number; maxSpeed?:number; twoOrbsMaxSpeed?:number; twoOrbsRampFrames?:number }
  burst: { lineWidth:number }
  orbs: {
    radius:number
    baseSpeed?: number
    spawn?: {
      mode?: 'rings' | 'random'           // default 'random'
      pad?: number                         // extra spacing between neighbors; default 4
      startInset?: number                  // inset from boundary for outer ring; default 16
      ringGap?: number                     // default 2*radius + pad
      ringsMin?: number                    // minimum rings to use; default 1
      ringsMax?: number                    // maximum rings to use; default 1
      velocity?: 'none' | 'tangent' | 'outward'  // default 'tangent'
      jitter?: boolean                     // safe bounded jitter; default false
    }
  }
  tethers?: { hitDamping:number; springK?:number; springRest?:number; springDamping?:number; breakSpeedMin?:number; immunityFrames?:number; showBreakParticles?:boolean }
  gravity?: { base:number; ampFrac:number; periodFrames:number; oscillateBelowOrbs:number }
  edgeGravity?: { strength:number; count:number; insetPixels?:number }
  edgeGuide?: { enabled?:boolean; radiusTargetFrac?:number; bandWidth?:number; k?:number; minSpeedGate?:number }
  collisions?: { orbRestitution:number }
  disableTraits?: boolean
  debug?: boolean
  fx?: {
    shockwave?: {
      enabled?: boolean
      lifeFrames?: number
      maxRadius?: number
      ringThickness?: number
      triggerOnImpact?: boolean
      impactThreshold?: number
      triggerOnSplit?: boolean
      respectProtect?: boolean
      cutMode?: 'anchor' | 'segment'
      impactCutsTethers?: boolean
    }
  }
  split?: {
    enabled: boolean
    enableBelowOrbs?: number
    vnThreshold: number
    keThreshold: number
    radiusScale: number
    childSpeedMul: number
    angleSpread: number
    maxGenerations: number
    cooldownFrames: number
    maxOrbsCap: number
    tetherResOnSplitMul?: number
    tetherResFloorMul?: number
  }
  suddenDeath?: {
    enabled: boolean
    afterFrames: number
    gravityMultiplier: number
    rampFrames?: number  // Frames to ramp from 1x to full gravityMultiplier (default 0 = instant)
    centerShiftRadius?: number
    centerShiftPeriodFrames?: number
    orbAttraction?: number  // Force pulling orbs toward each other during sudden death
    maxOrbs?: number  // Trigger sudden death when orbs <= this value (default 2)
    tangentImpulseMul?: number  // Multiplier for boundary kick during sudden death
    restitutionMul?: number  // Multiplier for restitution during sudden death
  }
  drama?: {
    targetFrames: number      // Frames over which drama ramps up (default 7200 = 2 min)
    shrinkStart: number       // When to start shrinking (0-1, default 0.7)
    shrinkTo: number          // Final shrink multiplier (default 1.0 = no shrink)
    restitutionMulEnd: number // Final restitution multiplier (default 1.0)
    gravityMulEnd: number     // Final gravity multiplier (default 1.8)
    jitterMulEnd: number      // Final jitter multiplier (default 1.6)
    easing?: 'linear' | 'easeInQuad' | 'easeOutCubic'  // Easing curve (default 'easeInQuad')
  }
  rendering?: {
    dimUntilBreakSpeed: boolean
    orbDimAlpha: number
    tetherDimAlpha: number
  }
  economicsInputs?: {
    header: { round_id:number; seed_hex:string; map_id:string; rules_hash:string; build_hash:string; mode?: 'paid' | 'free_sim'; economy_model?: 'fixed_total_v0' | 'log_scaled_kill_v1' | 'weighted_kill_v2' | 'weighted_kill_v2_inherit'; dev_fee_bps?: number; payout_model?: 'v1_inherit' | 'v2_top3' }
    economic_params: { total_players:number; entry_amount_lamports:number; bounty_bps:number; survival_bps:number; simulated?: boolean }
    roster: string[]
    tp_targets_lamports?: Record<string, number>
  }
}
export type PlayerScore = {
  framesAlive: number;
  tethersDestroyed: number;
  score: number;
}
export type SpawnInput = { x?: number; y?: number; angle?: number; speed?: number }
export type InitOpts = {
  multipliersByOwnerHex?: Record<string, Skill>
  spawnByOwnerHex?: Record<string, SpawnInput>
}

export type EngineState = {
  frame:number
  orbs: Orb[]
  tethers: Tether[][]
  flashes: Flash[]
  shockwaves: Array<{ x:number; y:number; r:number; maxR:number; life:number; maxLife:number; color:string; thickness:number; kind:'split'|'impact'; affectsTethers:boolean }>
  scores: Record<string, PlayerScore>
  twoOrbsStartFrame?: number
  // Deterministic economic scoring (optional)
  econ?: {
    // Inputs
    header: { round_id:number; seed_hex:string; map_id:string; rules_hash:string; build_hash:string; mode?: 'paid' | 'free_sim'; economy_model?: 'fixed_total_v0' | 'log_scaled_kill_v1' | 'weighted_kill_v2' | 'weighted_kill_v2_inherit'; dev_fee_bps?: number; payout_model?: 'v1_inherit' | 'v2_top3' }
    economic_params: { total_players:number; entry_amount_lamports:number; bounty_bps:number; survival_bps:number; simulated?: boolean }
    roster: string[] // full 64-hex player ids, lexicographically sorted
    rosterIndex: Record<string, number>
    // Pots
    pots: { bounty_pot_lamports:number; survival_pot_lamports:number; bounty_per_kill_lamports?:number }
    bounty_remaining:number
    // Weighted kill schedule (for weighted_kill_v2)
    perKillSchedule?: Record<number, number> // A -> payout lamports
    weights_meta?: { model:string; dev_fee_bps:number; bounty_share_bps:number; survival_share_bps:number }
    // Per-player tallies (by player_id hex)
    perPlayer: Record<string, { kills:number; framesAlive:number; spawn_frame:number; last_alive_frame:number; death_frame?: number; bounty_earned:number; survival_earned:number; total_earned:number; cashed_bounty?:number; placement?:number }>
    prevOwners?: string[]
    // Take Profit (TP) tracking
    tp_presets_lamports?: Record<'safe' | 'balanced' | 'fierce' | 'yolo', number>
    tp_targets?: Record<string, number>
    tp_triggered?: Set<string>
    // Ordered telemetry events
    events: Array<
      | { type:'BountyPayout'; frame:number; killer_id:string; victim_id:string; amount:number; bounty_remaining:number; alive_before?:number }
      | { type:'SurvivalAward'; frame:number; winner_id:string; amount:number }
      | { type:'TieBreak'; frame:number; winner_id:string; losers:string[]; rule_chain:string[] }
      | { type:'TPCashout'; frame:number; player_id:string; amount:number; target:number }
      | { type:'KillInheritance'; frame:number; killer_id:string; victim_id:string; transferred:number }
    >
    winner_id?: string
    finalized?: boolean
    result_hash?: string
  }
}
