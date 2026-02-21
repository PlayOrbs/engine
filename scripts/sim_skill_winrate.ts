#!/usr/bin/env bun
/**
 * Monte Carlo simulation to measure win rate vs skill multiplier tiers.
 * 
 * Usage:
 *   bun scripts/sim_skill_winrate.ts --trials 1000 --players 8
 *   bun scripts/sim_skill_winrate.ts --trials 100 --players 6 --seed 42
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { initFromSeed, countUniqueOwners, synthesizePlayers, advanceFrame } from '../src/core/v1/sim.js'
import { initFromSeedV2, advanceFrameV2, countUniqueOwnersV2 } from '../src/core/v2/sim_v2.js'
import { toHex } from '../src/utils/utils.js'
import type { EngineConfig, Player } from '../src/core/v1/types.js'
import type { GameConfig } from '../src/config/gameConfig.js'

// Parse CLI args
type Args = {
  trials: number; players: number; seed: number; maxFrames: number
  stress: boolean; exaggerated: boolean
  onlyTether: boolean; onlySplit: boolean; onlyPower: boolean
  grid: boolean
  v2: boolean; compare: boolean
  configPath: string | null
}
function parseArgs(): Args {
  const args = process.argv.slice(2)
  let trials = 500
  let players = 8
  let seed = 1
  let maxFrames = 36000
  let stress = false
  let exaggerated = false
  let onlyTether = false
  let onlySplit = false
  let onlyPower = false
  let grid = false
  let v2 = false
  let compare = false
  let configPath: string | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trials' && args[i + 1]) trials = parseInt(args[i + 1], 10)
    if (args[i] === '--players' && args[i + 1]) players = parseInt(args[i + 1], 10)
    if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[i + 1], 10)
    if (args[i] === '--maxFrames' && args[i + 1]) maxFrames = parseInt(args[i + 1], 10)
    if (args[i] === '--stress') stress = true
    if (args[i] === '--exaggerated') exaggerated = true
    if (args[i] === '--only-tether') onlyTether = true
    if (args[i] === '--only-split') onlySplit = true
    if (args[i] === '--only-power') onlyPower = true
    if (args[i] === '--grid') grid = true
    if (args[i] === '--v2') v2 = true
    if (args[i] === '--compare') compare = true
    if (args[i] === '--config' && args[i + 1]) configPath = args[i + 1]
  }

  return { trials, players, seed, maxFrames, stress, exaggerated, onlyTether, onlySplit, onlyPower, grid, v2, compare, configPath }
}

// Generate deterministic seed for trial
function trialSeed(masterSeed: number, trialIndex: number): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setUint32(0, masterSeed, true)
  view.setUint32(4, trialIndex, true)
  return sha256(buf)
}

// Stress test config - tuned to exercise multipliers more aggressively
function makeStressConfig(): EngineConfig {
  return {
    canvas: { width: 400, height: 720 },
    boundary: {
      shape: 'circle',
      radius: 190,
      restitution: 1.05,
      tangentImpulse: 0.02,
      minSpeed: 1.0,
      maxSpeed: 3.0, // Lower so powerMul clamps bind
      twoOrbsMaxSpeed: 6.0,
      twoOrbsRampFrames: 300,
    },
    burst: { lineWidth: 0.8 },
    orbs: {
      radius: 12,
      baseSpeed: 3,
      spawn: {
        mode: 'rings',
        pad: 20,
        startInset: 40,
        ringGap: 30,
        ringsMin: 1,
        ringsMax: 2,
        velocity: 'tangent',
      },
    },
    tethers: {
      hitDamping: 0.1,
      breakSpeedMin: 1.5, // Lower so breaks occur more often
      immunityFrames: 60,
    },
    gravity: {
      base: 0.0001,
      ampFrac: 0.5,
      periodFrames: 30,
      oscillateBelowOrbs: 6,
    },
    collisions: { orbRestitution: 1.02 },
    split: {
      enabled: true,
      enableBelowOrbs: 8, // Split triggers with more orbs so splitAggroMul matters
      vnThreshold: 3,
      keThreshold: 10.0,
      radiusScale: 0.8,
      childSpeedMul: 0.6,
      angleSpread: 0.4,
      maxGenerations: 2,
      cooldownFrames: 120,
      maxOrbsCap: 24,
    },
    suddenDeath: {
      enabled: true,
      afterFrames: 300,
      gravityMultiplier: 3,
      centerShiftRadius: 0,
      orbAttraction: 0.001,
      tangentImpulseMul: 3.0,
      restitutionMul: 1.3,
    },
    fx: {
      shockwave: {
        enabled: true,
        lifeFrames: 30,
        maxRadius: 80,
        ringThickness: 4,
        respectProtect: true,
        cutMode: 'segment',
        triggerOnSplit: true,
        triggerOnImpact: true,
        impactThreshold: 3,
        impactCutsTethers: true,
      },
    },
    disableTraits: true,
    debug: false,
  }
}

// Real game config v1.2.2 (no economics for pure survival mechanics)
function makeProdConfig(): EngineConfig {
  return {
    canvas: { width: 400, height: 720 },
    boundary: {
      shape: 'circle',
      radius: 190,
      restitution: 1.02,
      tangentImpulse: 0.01,
      minSpeed: 0.5,
      maxSpeed: 5.0,
      twoOrbsMaxSpeed: 8.0,
      twoOrbsRampFrames: 200000000,
      rectHalfWidth: 200,
      rectHalfHeight: 300,
    },
    burst: { lineWidth: 0.8 },
    orbs: {
      radius: 12,
      baseSpeed: 2,
      spawn: {
        mode: 'rings',
        pad: 58,
        startInset: 104,
        ringGap: 30,
        ringsMin: 1,
        ringsMax: 5,
        velocity: 'none',
        jitter: false,
      },
    },
    tethers: {
      hitDamping: 0.125,
      springRest: 0,
      springK: 0.0,
      springDamping: 0.0,
      breakSpeedMin: 3,
      immunityFrames: 200,
    },
    gravity: {
      base: 0.0000000001,
      ampFrac: 0.4,
      periodFrames: 40,
      oscillateBelowOrbs: 3,
    },
    edgeGuide: {
      enabled: false,
      radiusTargetFrac: 0.6,
      bandWidth: 32,
      k: 0.15,
      minSpeedGate: 0.4,
    },
    edgeGravity: {
      strength: 0.00001,
      count: 0,
      insetPixels: 60,
    },
    collisions: { orbRestitution: 1.004 },
    split: {
      enabled: true,
      enableBelowOrbs: 99, // Allow splitting at any time
      vnThreshold: 5,
      keThreshold: 20.0,
      radiusScale: 1,
      childSpeedMul: 0.5,
      angleSpread: 0.45,
      maxGenerations: 2,
      cooldownFrames: 180,
      maxOrbsCap: 24,
    },
    suddenDeath: {
      enabled: true,
      afterFrames: 600,
      gravityMultiplier: 2,
      centerShiftRadius: 0, // Disabled - requires seed_hex from economics
      centerShiftPeriodFrames: 150,
      orbAttraction: 0,
      tangentImpulseMul: 5.0,
      restitutionMul: 1.5,
    },
    fx: {
      shockwave: {
        enabled: true,
        lifeFrames: 40,
        maxRadius: 100,
        ringThickness: 5,
        respectProtect: true,
        cutMode: 'segment',
        triggerOnSplit: true,
        triggerOnImpact: true,
        impactThreshold: 4,
        impactCutsTethers: true,
      },
    },
    disableTraits: true,
    debug: false,
    // No economicsInputs - disables TP and economic scoring
  }
}

// Multiplier presets (tetherDefMul added for V2 compatibility)
const MILD_SKILL = { splitAggroMul: 1.10, tetherResMul: 1.10, tetherDefMul: 1.10, powerMul: 1.08 }
const EXAGGERATED_SKILL = { splitAggroMul: 2.0, tetherResMul: 2.0, tetherDefMul: 2.0, powerMul: 2.0 }
const BASELINE = { splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 }

type TrialResult = {
  winner: string | null
  resolved: boolean
  frames: number
  splits: number
  finalOrbCount: number
}

// Run a single trial with split tracking (V1 engine)
function runTrialV1(
  roundSeed: Uint8Array,
  players: Player[],
  cfg: EngineConfig,
  highSkillSet: Set<string>,
  highSkill: typeof BASELINE,
  maxFrames: number
): TrialResult {
  const multipliersByOwnerHex: Record<string, typeof BASELINE> = {}
  for (const p of players) {
    const hex = toHex(p.pubkey)
    multipliersByOwnerHex[hex] = highSkillSet.has(hex) ? highSkill : BASELINE
  }

  const { state, prngs } = initFromSeed(roundSeed, players, cfg, { multipliersByOwnerHex })

  let frames = 0
  let splits = 0
  let prevOrbCount = state.orbs.length

  while (frames < maxFrames && countUniqueOwners(state.orbs) > 1) {
    advanceFrame(state, cfg, prngs)
    frames++
    if (state.orbs.length > prevOrbCount) {
      splits += state.orbs.length - prevOrbCount
    }
    prevOrbCount = state.orbs.length
  }

  const uniqueOwners = countUniqueOwners(state.orbs)
  const finalOrbCount = state.orbs.length
  if (uniqueOwners === 1) {
    const winnerHex = toHex(state.orbs[0].owner)
    return { winner: winnerHex, resolved: true, frames, splits, finalOrbCount }
  } else if (uniqueOwners === 0) {
    return { winner: null, resolved: true, frames, splits, finalOrbCount }
  } else {
    return { winner: null, resolved: false, frames, splits, finalOrbCount }
  }
}

// Run a single trial with split tracking (V2 fixed-point engine)
function runTrialV2(
  roundSeed: Uint8Array,
  players: Player[],
  gcRaw: GameConfig,
  highSkillSet: Set<string>,
  highSkill: typeof BASELINE,
  maxFrames: number
): TrialResult {
  const multipliersByOwnerHex: Record<string, typeof BASELINE> = {}
  for (const p of players) {
    const hex = toHex(p.pubkey)
    multipliersByOwnerHex[hex] = highSkillSet.has(hex) ? highSkill : BASELINE
  }

  const { state, cfg } = initFromSeedV2(roundSeed, players, gcRaw, { multipliersByOwnerHex })

  let frames = 0
  let splits = 0
  let prevOrbCount = state.orbs.length

  while (frames < maxFrames && countUniqueOwnersV2(state.orbs) > 1) {
    advanceFrameV2(state, cfg)
    frames++
    if (state.orbs.length > prevOrbCount) {
      splits += state.orbs.length - prevOrbCount
    }
    prevOrbCount = state.orbs.length
  }

  const uniqueOwners = countUniqueOwnersV2(state.orbs)
  const finalOrbCount = state.orbs.length
  if (uniqueOwners === 1) {
    const winnerHex = toHex(state.orbs[0].owner)
    return { winner: winnerHex, resolved: true, frames, splits, finalOrbCount }
  } else if (uniqueOwners === 0) {
    return { winner: null, resolved: true, frames, splits, finalOrbCount }
  } else {
    return { winner: null, resolved: false, frames, splits, finalOrbCount }
  }
}

// Wrapper that calls V1 or V2 based on flag
function runTrial(
  roundSeed: Uint8Array,
  players: Player[],
  cfg: EngineConfig,
  highSkillSet: Set<string>,
  highSkill: typeof BASELINE,
  maxFrames: number,
  useV2: boolean = false
): TrialResult {
  if (useV2) {
    return runTrialV2(roundSeed, players, cfg as unknown as GameConfig, highSkillSet, highSkill, maxFrames)
  }
  return runTrialV1(roundSeed, players, cfg, highSkillSet, highSkill, maxFrames)
}

// Chi-square test for 2x1 contingency (observed vs expected 50/50)
function chiSquare(highWins: number, baseWins: number): { chi2: number; pValue: string } {
  const total = highWins + baseWins
  if (total === 0) return { chi2: 0, pValue: 'N/A' }
  const expected = total / 2
  const chi2 = ((highWins - expected) ** 2 + (baseWins - expected) ** 2) / expected

  // Approximate p-value thresholds for 1 df
  let pValue: string
  if (chi2 >= 10.83) pValue = 'p < 0.001'
  else if (chi2 >= 6.63) pValue = 'p < 0.01'
  else if (chi2 >= 3.84) pValue = 'p < 0.05'
  else pValue = 'p >= 0.05 (not significant)'

  return { chi2, pValue }
}

// Grid search parameters
const GRID_SPLIT_AGGRO = [1.0, 1.25, 1.5, 1.75, 2.0]
const GRID_TETHER_ON_SPLIT = [0.95, 0.9, 0.85]
const GRID_TETHER_FLOOR = [0.7, 0.8]

type GridResult = {
  splitAggroMul: number
  tetherResOnSplitMul: number
  tetherResFloorMul: number
  resolved: number
  unresolved: number
  highWins: number
  baseWins: number
  highRate: number
  avgFrames: number
  avgSplits: number
  avgFinalOrbs: number
  chi2: number
  pValue: string
}

// Run trials for a single grid combo with progress logging
function runGridCombo(
  trials: number,
  N: number,
  masterSeed: number,
  maxFrames: number,
  baseCfg: EngineConfig,
  splitAggroMul: number,
  tetherResOnSplitMul: number,
  tetherResFloorMul: number,
  comboId: string,
  useV2: boolean = false
): GridResult {
  const cfg = {
    ...baseCfg,
    split: {
      ...baseCfg.split!,
      tetherResOnSplitMul,
      tetherResFloorMul,
    }
  }
  const colors = ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']
  const HIGH_SKILL = { splitAggroMul, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 }

  let highWins = 0, baseWins = 0, unresolved = 0
  let totalFrames = 0, totalSplits = 0, totalFinalOrbs = 0
  const startTime = Date.now()

  console.log(`  [${comboId}] Starting: splitAggro=${splitAggroMul}, onSplit=${tetherResOnSplitMul}, floor=${tetherResFloorMul}`)

  for (let t = 0; t < trials; t++) {
    const roundSeed = trialSeed(masterSeed, t)
    const trialPlayers = synthesizePlayers(roundSeed, N, colors)
    const highSkillSet = new Set<string>()
    for (let i = 0; i < Math.floor(N / 2); i++) {
      highSkillSet.add(toHex(trialPlayers[i].pubkey))
    }

    const result = runTrial(roundSeed, trialPlayers, cfg, highSkillSet, HIGH_SKILL, maxFrames, useV2)
    totalFrames += result.frames
    totalSplits += result.splits
    totalFinalOrbs += result.finalOrbCount

    if (!result.resolved) {
      unresolved++
    } else if (result.winner) {
      if (highSkillSet.has(result.winner)) highWins++
      else baseWins++
    }

    // Log progress every 50 trials
    if ((t + 1) % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const currentRate = (highWins + baseWins) > 0 ? (highWins / (highWins + baseWins) * 100).toFixed(1) : '?'
      console.log(`  [${comboId}] Trial ${t + 1}/${trials} (${elapsed}s) - winRate: ${currentRate}%, splits: ${totalSplits}`)
    }
  }

  const resolved = highWins + baseWins
  const highRate = resolved > 0 ? highWins / resolved * 100 : 0
  const avgFrames = trials > 0 ? totalFrames / trials : 0
  const avgSplits = trials > 0 ? totalSplits / trials : 0
  const avgFinalOrbs = trials > 0 ? totalFinalOrbs / trials : 0
  const { chi2, pValue } = chiSquare(highWins, baseWins)

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = highRate >= 45 && highRate <= 55 ? '✓ NEUTRAL' : highRate > 55 ? '↑ HIGH' : '↓ LOW'
  console.log(`  [${comboId}] Done in ${totalTime}s => ${highRate.toFixed(1)}% ${status} (${avgSplits.toFixed(1)} splits/trial)`)

  return {
    splitAggroMul, tetherResOnSplitMul, tetherResFloorMul,
    resolved, unresolved, highWins, baseWins, highRate,
    avgFrames, avgSplits, avgFinalOrbs, chi2, pValue
  }
}

// Get number of CPU cores for parallelism
const numCPUs = navigator?.hardwareConcurrency ?? 4

async function runGridSearch(args: Args) {
  const { trials, players: N, seed: masterSeed, maxFrames, stress, v2 } = args
  const baseCfg = stress ? makeStressConfig() : makeProdConfig()
  const engineLabel = v2 ? 'V2 (fixed-point)' : 'V1 (float)'

  // Build all combos
  const combos: Array<{ splitAggro: number; tetherOnSplit: number; tetherFloor: number }> = []
  for (const splitAggro of GRID_SPLIT_AGGRO) {
    for (const tetherOnSplit of GRID_TETHER_ON_SPLIT) {
      for (const tetherFloor of GRID_TETHER_FLOOR) {
        combos.push({ splitAggro, tetherOnSplit, tetherFloor })
      }
    }
  }

  const totalCombos = combos.length
  const startTime = Date.now()

  console.log('=== Split Aggro Grid Search ===')
  console.log(`Engine: ${engineLabel} | Trials per combo: ${trials} | Players: ${N}`)
  console.log(`Total combos: ${totalCombos} | Parallel workers: ${numCPUs}`)
  console.log(`Split aggro values: ${GRID_SPLIT_AGGRO.join(', ')}`)
  console.log(`Tether on-split mul: ${GRID_TETHER_ON_SPLIT.join(', ')}`)
  console.log(`Tether floor mul: ${GRID_TETHER_FLOOR.join(', ')}`)
  console.log('')
  console.log('Starting parallel execution...')
  console.log('')

  // Run combos in parallel batches
  const results: GridResult[] = []
  let completed = 0

  // Process in batches of numCPUs
  for (let i = 0; i < combos.length; i += numCPUs) {
    const batch = combos.slice(i, i + numCPUs)
    const batchPromises = batch.map(async (combo, idx) => {
      const comboId = `${i + idx + 1}`.padStart(2, '0')
      const result = runGridCombo(
        trials, N, masterSeed, maxFrames, baseCfg,
        combo.splitAggro, combo.tetherOnSplit, combo.tetherFloor,
        comboId, v2
      )
      return result
    })

    const batchResults = await Promise.all(batchPromises)
    results.push(...batchResults)
    completed += batch.length

    // Log progress after each batch
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const eta = completed > 0 ? ((Date.now() - startTime) / completed * (totalCombos - completed) / 1000).toFixed(0) : '?'
    console.log(`[${elapsed}s] Completed ${completed}/${totalCombos} combos (ETA: ${eta}s remaining)`)
    
    // Log each result in the batch
    for (const r of batchResults) {
      const winRateStr = r.highRate.toFixed(1) + '%'
      const status = r.highRate >= 45 && r.highRate <= 55 ? '✓ NEUTRAL' : r.highRate > 55 ? '↑ HIGH' : '↓ LOW'
      console.log(`  splitAggro=${r.splitAggroMul.toFixed(2)}, onSplit=${r.tetherResOnSplitMul}, floor=${r.tetherResFloorMul} => ${winRateStr} ${status} (${r.avgSplits.toFixed(1)} splits/trial)`)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('')
  console.log(`=== Grid Search Complete in ${totalTime}s ===`)
  console.log('')
  console.log('splitAggro | onSplit | floor | winRate | avgSplits | avgFrames | chi2   | p-value')
  console.log('-'.repeat(90))

  // Sort by win rate distance from 50%
  const sortedResults = [...results].sort((a, b) => Math.abs(a.highRate - 50) - Math.abs(b.highRate - 50))

  for (const r of sortedResults) {
    const winRateStr = r.highRate.toFixed(1).padStart(5) + '%'
    const marker = r.highRate >= 45 && r.highRate <= 55 ? ' ★' : ''
    console.log(
      `${r.splitAggroMul.toFixed(2).padStart(10)} | ` +
      `${r.tetherResOnSplitMul.toFixed(2).padStart(7)} | ` +
      `${r.tetherResFloorMul.toFixed(2).padStart(5)} | ` +
      `${winRateStr.padStart(7)} | ` +
      `${r.avgSplits.toFixed(1).padStart(9)} | ` +
      `${r.avgFrames.toFixed(0).padStart(9)} | ` +
      `${r.chi2.toFixed(2).padStart(6)} | ` +
      `${r.pValue}${marker}`
    )
  }

  // Find best neutral combo (closest to 50% with higher splits)
  const neutralCandidates = results
    .filter(r => r.resolved >= trials * 0.5) // At least 50% resolved
    .sort((a, b) => {
      const aDist = Math.abs(a.highRate - 50)
      const bDist = Math.abs(b.highRate - 50)
      if (Math.abs(aDist - bDist) < 2) {
        // If similar distance to 50%, prefer higher splits
        return b.avgSplits - a.avgSplits
      }
      return aDist - bDist
    })

  if (neutralCandidates.length > 0) {
    const best = neutralCandidates[0]
    console.log('')
    console.log('╔══════════════════════════════════════╗')
    console.log('║       BEST NEUTRAL COMBO             ║')
    console.log('╠══════════════════════════════════════╣')
    console.log(`║ splitAggroMul:      ${best.splitAggroMul.toFixed(2).padEnd(16)}║`)
    console.log(`║ tetherResOnSplitMul: ${best.tetherResOnSplitMul.toFixed(2).padEnd(15)}║`)
    console.log(`║ tetherResFloorMul:  ${best.tetherResFloorMul.toFixed(2).padEnd(16)}║`)
    console.log('╠══════════════════════════════════════╣')
    console.log(`║ Win rate:           ${(best.highRate.toFixed(1) + '%').padEnd(16)}║`)
    console.log(`║ Avg splits/trial:   ${best.avgSplits.toFixed(1).padEnd(16)}║`)
    console.log(`║ Avg frames/trial:   ${best.avgFrames.toFixed(0).padEnd(16)}║`)
    console.log(`║ Statistical sig:    ${best.pValue.padEnd(16)}║`)
    console.log('╚══════════════════════════════════════╝')
  }

  // Summary stats
  const neutralCount = results.filter(r => r.highRate >= 45 && r.highRate <= 55).length
  const highSplitNeutral = results.filter(r => r.highRate >= 45 && r.highRate <= 55 && r.avgSplits > 1).length
  console.log('')
  console.log(`Summary: ${neutralCount}/${totalCombos} combos are neutral (45-55%), ${highSplitNeutral} with >1 avg splits`)
}

async function runSingleMode(args: Args) {
  const { trials, players: N, seed: masterSeed, maxFrames, stress, exaggerated, onlyTether, onlySplit, onlyPower, v2, configPath } = args
  
  let cfg: EngineConfig
  let configLabel: string
  if (configPath) {
    const fs = await import('fs')
    const raw = fs.readFileSync(configPath, 'utf-8')
    cfg = JSON.parse(raw) as EngineConfig
    configLabel = (cfg as any).version || configPath
    // Disable centerShiftRadius since we don't have economics/seed_hex
    if (cfg.suddenDeath) {
      cfg.suddenDeath.centerShiftRadius = 0
    }
  } else {
    cfg = stress ? makeStressConfig() : makeProdConfig()
    configLabel = stress ? 'STRESS TEST' : 'PROD v1.2.2'
  }
  const engineLabel = v2 ? 'V2 (fixed-point)' : 'V1 (float)'

  let HIGH_SKILL: typeof BASELINE
  const mul = exaggerated ? 2.0 : 1.1
  if (onlyTether) {
    HIGH_SKILL = { splitAggroMul: 1, tetherResMul: mul, tetherDefMul: mul, powerMul: 1 }
  } else if (onlySplit) {
    HIGH_SKILL = { splitAggroMul: mul, tetherResMul: 1, tetherDefMul: 1, powerMul: 1 }
  } else if (onlyPower) {
    HIGH_SKILL = { splitAggroMul: 1, tetherResMul: 1, tetherDefMul: 1, powerMul: mul }
  } else {
    HIGH_SKILL = exaggerated ? EXAGGERATED_SKILL : MILD_SKILL
  }

  const isolatedLabel = onlyTether ? ' (ONLY tetherResMul)' : onlySplit ? ' (ONLY splitAggroMul)' : onlyPower ? ' (ONLY powerMul)' : ''
  const colors = ['#ff6b35', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

  console.log('=== Skill Multiplier Win Rate Simulation ===')
  console.log(`Engine: ${engineLabel} | Config: ${configLabel} | Multipliers: ${exaggerated ? 'EXAGGERATED (2x)' : 'MILD (1.1x)'}${isolatedLabel}`)
  console.log(`Trials: ${trials} | Players: ${N} (${Math.floor(N / 2)} high-skill, ${N - Math.floor(N / 2)} baseline)`)
  console.log(`High-skill: splitAggroMul=${HIGH_SKILL.splitAggroMul}, tetherResMul=${HIGH_SKILL.tetherResMul}, powerMul=${HIGH_SKILL.powerMul}`)
  console.log(`Max frames per trial: ${maxFrames}`)
  console.log(`Master seed: ${masterSeed}`)
  console.log('')

  let highWins = 0, baseWins = 0, unresolved = 0
  let totalFrames = 0, totalSplits = 0

  const startTime = Date.now()

  for (let t = 0; t < trials; t++) {
    const roundSeed = trialSeed(masterSeed, t)
    const trialPlayers = synthesizePlayers(roundSeed, N, colors)
    const highSkillSet = new Set<string>()
    for (let i = 0; i < Math.floor(N / 2); i++) {
      highSkillSet.add(toHex(trialPlayers[i].pubkey))
    }

    const result = runTrial(roundSeed, trialPlayers, cfg, highSkillSet, HIGH_SKILL, maxFrames, v2)
    totalFrames += result.frames
    totalSplits += result.splits

    if (!result.resolved) {
      unresolved++
    } else if (result.winner) {
      if (highSkillSet.has(result.winner)) highWins++
      else baseWins++
    }

    if ((t + 1) % 100 === 0 || t === trials - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const avgFrames = Math.round(totalFrames / (t + 1))
      process.stdout.write(`\rProgress: ${t + 1}/${trials} (${elapsed}s, avg ${avgFrames} frames/trial)`)
    }
  }

  console.log('\n')

  const resolved = highWins + baseWins
  const highRate = resolved > 0 ? (highWins / resolved * 100).toFixed(1) : '0'
  const baseRate = resolved > 0 ? (baseWins / resolved * 100).toFixed(1) : '0'
  const lift = baseWins > 0 ? (((highWins - baseWins) / baseWins) * 100).toFixed(1) : 'N/A'
  const avgSplits = trials > 0 ? (totalSplits / trials).toFixed(1) : '0'

  console.log('Results:')
  console.log(`  Resolved trials: ${resolved}`)
  console.log(`  Unresolved (excluded): ${unresolved}`)
  console.log(`  High-skill wins: ${highWins} (${highRate}%)`)
  console.log(`  Baseline wins:   ${baseWins} (${baseRate}%)`)
  console.log(`  Relative lift:   ${Number(lift) >= 0 ? '+' : ''}${lift}%`)
  console.log(`  Avg splits/trial: ${avgSplits}`)
  console.log('')

  const { chi2, pValue } = chiSquare(highWins, baseWins)
  console.log(`Chi-square: ${chi2.toFixed(2)}, ${pValue}`)

  if (resolved > 50 && highWins <= baseWins * 1.1) {
    console.log('')
    console.log('Note: Win rate lift is minimal. Consider increasing multipliers:')
    console.log('  - tetherResMul has the most direct impact (higher = harder to break your tethers)')
    console.log('  - powerMul affects max speed (higher = faster orb, more aggressive)')
    console.log('  - splitAggroMul is a tradeoff (higher = easier to split, but weaker tether defense after)')
  }
}

async function main() {
  const args = parseArgs()
  if (args.grid) {
    await runGridSearch(args)
  } else {
    await runSingleMode(args)
  }
}

main().catch(console.error)
