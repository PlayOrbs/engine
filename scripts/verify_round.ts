#!/usr/bin/env bun
/**
 * Round Verification Script
 * 
 * Fetches round data from ICP canister and runs deterministic simulation
 * to verify the winner matches on-chain results.
 * 
 * Usage:
 *   bun scripts/verify_round.ts --round 123 --tier 0 --network mainnet
 *   bun scripts/verify_round.ts --round 456 --tier 1 --network devnet
 * 
 * Options:
 *   --round <id>     Round ID to verify (required)
 *   --tier <id>      Tier ID (default: 0)
 *   --network <net>  Network: mainnet or devnet (default: mainnet)
 *   --verbose        Show detailed simulation output
 */

// ICP canister configuration
const ICP_CONFIG = {
  mainnet: {
    canisterId: 'uy5s7-myaaa-aaaam-qfnua-cai',
    host: 'https://icp-api.io',
  },
  devnet: {
    canisterId: '2lvus-jqaaa-aaaam-qerkq-cai',
    host: 'https://icp-api.io',
  },
}

// Dynamic imports for ICP
let HttpAgent: any
let Actor: any
let Principal: any
let IDL: any
let bs58: any

async function loadDfinityPackages() {
  const [agent, principal, candid, bs58Module] = await Promise.all([
    import('@dfinity/agent'),
    import('@dfinity/principal'),
    import('@dfinity/candid'),
    import('bs58'),
  ])
  HttpAgent = agent.HttpAgent
  Actor = agent.Actor
  Principal = principal.Principal
  IDL = candid.IDL
  bs58 = bs58Module.default
}

// Convert hex to Solana pubkey (base58)
function hexToPubkey(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bs58.encode(bytes)
}

// Minimal IDL for read-only operations
function createIdl() {
  const SeedProofIDL = IDL.Record({
    seed: IDL.Vec(IDL.Nat8),
    chunk_id: IDL.Nat64,
    merkle_root: IDL.Vec(IDL.Nat8),
    root_signature: IDL.Vec(IDL.Nat8),
    proof_siblings: IDL.Vec(IDL.Vec(IDL.Nat8)),
    proof_positions: IDL.Vec(IDL.Bool),
  })

  const PlayerConfigOutputIDL = IDL.Record({
    player_config_hash: IDL.Vec(IDL.Nat8),
    round_id: IDL.Nat64,
    tier_id: IDL.Nat8,
    player_pubkey: IDL.Vec(IDL.Nat8),
    tp_preset: IDL.Nat16,
    spawn_x_q: IDL.Int16,
    spawn_y_q: IDL.Int16,
    spawn_rot_q: IDL.Nat16,
    alloc_split: IDL.Nat8,
    alloc_tether: IDL.Nat8,
    alloc_power: IDL.Nat8,
    created_at: IDL.Nat64,
  })

  const RoundPlayerSnapshot = IDL.Record({
    player: IDL.Vec(IDL.Nat8),
    join_ts: IDL.Nat64,
    tp_preset: IDL.Nat8,
    payout_lamports: IDL.Nat64,
    placement: IDL.Nat8,
    kills: IDL.Nat8,
    orb_earned_atoms: IDL.Opt(IDL.Nat64),
    player_config_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
  })

  const RoundSnapshot = IDL.Record({
    tier_id: IDL.Nat8,
    round_id: IDL.Nat64,
    season_id: IDL.Nat16,
    players: IDL.Vec(RoundPlayerSnapshot),
    did_emit: IDL.Bool,
    emit_tx_sig: IDL.Opt(IDL.Text),
    config_version: IDL.Text,
  })

  const EngineConfigIDL = IDL.Record({
    version: IDL.Text,
    config_json: IDL.Text,
    created_at: IDL.Nat64,
  })

  return ({ IDL: idl }: any) => IDL.Service({
    get_revealed_seed: IDL.Func(
      [IDL.Nat8, IDL.Nat64],
      [IDL.Opt(SeedProofIDL)],
      ['query']
    ),
    get_round_snapshot: IDL.Func(
      [IDL.Nat8, IDL.Nat64],
      [IDL.Opt(RoundSnapshot)],
      ['query']
    ),
    list_player_configs_if_revealed: IDL.Func(
      [IDL.Nat64, IDL.Nat8],
      [IDL.Variant({ Ok: IDL.Vec(PlayerConfigOutputIDL), Err: IDL.Text })],
      ['query']
    ),
    get_engine_config: IDL.Func(
      [IDL.Text],
      [IDL.Opt(EngineConfigIDL)],
      ['query']
    ),
  })
}

// Parse CLI args
interface Args {
  roundId: number
  tierId: number
  network: 'mainnet' | 'devnet'
  verbose: boolean
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let roundId = -1
  let tierId = 0
  let network: 'mainnet' | 'devnet' = 'mainnet'
  let verbose = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--round' && args[i + 1]) roundId = parseInt(args[i + 1], 10)
    if (args[i] === '--tier' && args[i + 1]) tierId = parseInt(args[i + 1], 10)
    if (args[i] === '--network' && args[i + 1]) {
      const net = args[i + 1].toLowerCase()
      if (net === 'devnet' || net === 'mainnet') network = net
    }
    if (args[i] === '--verbose') verbose = true
  }

  if (roundId < 0) {
    console.error('Error: --round <id> is required')
    console.error('Usage: bun scripts/verify_round.ts --round 123 --tier 0 --network mainnet')
    process.exit(1)
  }

  return { roundId, tierId, network, verbose }
}

// Convert bytes to hex
function toHex(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Dequantize spawn position - returns normalized values in [-1, 1] range
// Must match SDK's dequantizeSpawn exactly
function dequantizeSpawn(xQ: number, yQ: number, rotQ: number): { xNorm: number; yNorm: number; rotRad: number } {
  // x_q, y_q are i16 quantized to [-32767, 32767] mapping to [-1, 1]
  // rot_q is u16 quantized to [0, 65535] mapping to [0, 2π]
  const xNorm = xQ / 32767
  const yNorm = yQ / 32767
  const rotRad = (rotQ / 65535) * 2 * Math.PI
  return { xNorm, yNorm, rotRad }
}

// Convert hex to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

// ─── STEP 1: Create ICP Actor ─────────────────────────────────────────────────
async function createIcpActor(network: 'mainnet' | 'devnet') {
  const config = ICP_CONFIG[network]
  const agent = HttpAgent.createSync({ host: config.host })
  return Actor.createActor(createIdl(), {
    agent,
    canisterId: Principal.fromText(config.canisterId),
  })
}

// ─── STEP 2: Fetch Round Data ─────────────────────────────────────────────────
interface RoundData {
  seedHex: string
  snapshot: any
  playerConfigs: any[]
  engineConfig: any
  configVersion: string
  onChainWinnerHex: string
}

async function fetchRoundData(actor: any, roundId: number, tierId: number): Promise<RoundData> {
  // Fetch seed
  console.log('Fetching round seed...')
  const seedResult = await actor.get_revealed_seed(tierId, BigInt(roundId))
  if (!seedResult || seedResult.length === 0) {
    console.error('❌ Seed not revealed for this round. Round may not be settled yet.')
    process.exit(1)
  }
  const seedHex = toHex(seedResult[0].seed)
  console.log(`  Seed: ${seedHex.slice(0, 16)}...`)

  // Fetch round snapshot
  console.log('Fetching round snapshot...')
  const snapshotResult = await actor.get_round_snapshot(tierId, BigInt(roundId))
  if (!snapshotResult || snapshotResult.length === 0) {
    console.error('❌ Round snapshot not found. Round may not exist or is not yet archived.')
    process.exit(1)
  }
  const snapshot = snapshotResult[0]

  // Validate round data
  if (!snapshot.players || snapshot.players.length === 0) {
    console.error('❌ Round has no players. Round may not exist.')
    process.exit(1)
  }
  const onChainWinner = snapshot.players.find((p: any) => p.placement === 1)
  if (!onChainWinner) {
    console.error('❌ Round has no winner. Round may not be settled yet.')
    process.exit(1)
  }

  const configVersion = snapshot.config_version
  console.log(`  Config version: ${configVersion}`)
  console.log(`  Players: ${snapshot.players.length}`)

  // Fetch player configs
  console.log('Fetching player configs...')
  const configsResult = await actor.list_player_configs_if_revealed(BigInt(roundId), tierId)
  if ('Err' in configsResult) {
    console.error(`❌ Failed to fetch player configs: ${configsResult.Err}`)
    process.exit(1)
  }
  console.log(`  Configs: ${configsResult.Ok.length}`)

  // Fetch engine config
  console.log('Fetching engine config...')
  const engineConfigResult = await actor.get_engine_config(configVersion)
  if (!engineConfigResult || engineConfigResult.length === 0) {
    console.error(`❌ Engine config ${configVersion} not found.`)
    process.exit(1)
  }
  const rawConfig = JSON.parse(engineConfigResult[0].config_json)
  const engineConfig = rawConfig.config || rawConfig

  // Ensure orbs.spawn exists with defaults if missing
  if (engineConfig.orbs && !engineConfig.orbs.spawn) {
    engineConfig.orbs.spawn = {
      mode: 'rings', pad: 20, startInset: 40, ringGap: 30,
      ringsMin: 1, ringsMax: 2, velocity: 'tangent', jitter: true,
    }
  }

  return {
    seedHex,
    snapshot,
    playerConfigs: configsResult.Ok,
    engineConfig,
    configVersion,
    onChainWinnerHex: toHex(onChainWinner.player),
  }
}

// ─── STEP 3: Build Players ────────────────────────────────────────────────────
interface PlayerData {
  pubkeyHex: string
  joinTs: number
  spawnXNorm: number
  spawnYNorm: number
  spawnRotRad: number
  allocSplit: number
  allocTether: number
  allocPower: number
  tpPreset: number
}

function buildPlayers(playerConfigs: any[], snapshot: any): PlayerData[] {
  const players = playerConfigs.map((cfg: any) => {
    const pubkeyHex = toHex(cfg.player_pubkey)
    const spawn = dequantizeSpawn(cfg.spawn_x_q, cfg.spawn_y_q, cfg.spawn_rot_q)
    const snapshotPlayer = snapshot.players.find((p: any) => toHex(p.player) === pubkeyHex)
    const joinTs = snapshotPlayer ? Number(snapshotPlayer.join_ts) : 0

    return {
      pubkeyHex,
      joinTs,
      spawnXNorm: spawn.xNorm,
      spawnYNorm: spawn.yNorm,
      spawnRotRad: spawn.rotRad,
      allocSplit: cfg.alloc_split,
      allocTether: cfg.alloc_tether,
      allocPower: cfg.alloc_power,
      tpPreset: cfg.tp_preset,
    }
  })

  // Sort by joinTs with pubkey tiebreaker (matches orb-workers)
  players.sort((a, b) => {
    const joinDiff = a.joinTs - b.joinTs
    if (joinDiff !== 0) return joinDiff
    return hexToPubkey(a.pubkeyHex).localeCompare(hexToPubkey(b.pubkeyHex))
  })

  return players
}

// ─── STEP 4: Build Simulation Inputs ──────────────────────────────────────────
function buildSimulationInputs(players: PlayerData[], engineConfig: any, args: Args, seedHex: string, configVersion: string) {
  // Skill multipliers (diminishing returns curve)
  const skillCurve = { a: 0.5, k: 0.5 }
  const calcMul = (points: number) => 1 + skillCurve.a * (1 - Math.exp(-skillCurve.k * points))

  // accelMul replaces powerMul in V2 (3.1.0+). Old rounds used accelMul=1.0 (fallback)
  const clean = configVersion.split('-')[0].split('+')[0]
  const [maj, min] = clean.split('.').map(n => parseInt(n, 10) || 0)
  const useAccel = maj > 3 || (maj === 3 && min >= 1)

  const multipliersByOwnerHex: Record<string, any> = {}
  for (const p of players) {
    multipliersByOwnerHex[p.pubkeyHex] = {
      splitAggroMul: calcMul(p.allocSplit),
      tetherResMul: 1.0,
      tetherDefMul: calcMul(p.allocTether),
      powerMul: 1,  // deprecated – replaced by accelMul in V2
      accelMul: useAccel ? calcMul(p.allocPower) : 1,
    }
  }

  // Spawn positions
  const cx = engineConfig.canvas.width / 2
  const cy = engineConfig.canvas.height / 2
  const R = engineConfig.boundary.radius
  const baseSpeed = engineConfig.orbs.baseSpeed ?? 8

  const spawnByOwnerHex: Record<string, any> = {}
  for (const p of players) {
    spawnByOwnerHex[p.pubkeyHex] = {
      x: cx + p.spawnXNorm * R,
      y: cy + p.spawnYNorm * R,
      angle: p.spawnRotRad,
      speed: baseSpeed,
    }
  }

  // Economics inputs
  const roster = players.map(p => p.pubkeyHex)
  const economicsInputs = {
    header: {
      round_id: args.roundId,
      seed_hex: seedHex,
      map_id: 'default',
      rules_hash: 'verify',
      build_hash: 'verify',
      mode: 'paid' as const,
      economy_model: 'weighted_kill_v2_inherit' as const,
      dev_fee_bps: 0,
    },
    economic_params: {
      total_players: players.length,
      entry_amount_lamports: 8_000_000,
      bounty_bps: 7000,
      survival_bps: 3000,
    },
    roster,
  }

  // Engine players
  const enginePlayers = players.map(p => ({
    pubkey: hexToBytes(p.pubkeyHex),
    joinNonce: new Uint8Array(8),
  }))

  // Seed bytes
  const seedBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = parseInt(seedHex.substr(i * 2, 2), 16)
  }

  return {
    multipliersByOwnerHex,
    spawnByOwnerHex,
    economicsInputs,
    enginePlayers,
    seedBytes,
  }
}

// ─── STEP 5: Run Simulation ───────────────────────────────────────────────────
async function runSimulation(
  seedBytes: Uint8Array,
  enginePlayers: any[],
  engineConfig: any,
  economicsInputs: any,
  multipliersByOwnerHex: Record<string, any>,
  spawnByOwnerHex: Record<string, any>,
  verbose: boolean
) {
  const { initFromSeedV2, advanceFrameV2, countUniqueOwnersV2 } = await import('../src/core/v2/sim_v2.js')

  const configWithEcon = { ...engineConfig, economicsInputs }
  const initOpts = { multipliersByOwnerHex, spawnByOwnerHex }
  const { state, cfg } = initFromSeedV2(seedBytes, enginePlayers, configWithEcon, initOpts)

  const maxFrames = 72000
  let frame = 0
  let currentState = state

  while (countUniqueOwnersV2(currentState.orbs) > 1 && frame < maxFrames) {
    const result = advanceFrameV2(currentState, cfg)
    currentState = result.state
    frame++
    if (verbose && frame % 6000 === 0) {
      console.log(`  Frame ${frame}: ${countUniqueOwnersV2(currentState.orbs)} players remaining`)
    }
  }

  // Find winner
  const remainingOwners = new Set<string>()
  for (const o of currentState.orbs) {
    remainingOwners.add(toHex(o.owner))
  }
  const winnerHex = remainingOwners.size === 1 ? Array.from(remainingOwners)[0] : null

  return { currentState, frame, winnerHex, countUniqueOwnersV2 }
}

// ─── STEP 6: Verify Winner ────────────────────────────────────────────────────
function verifyWinner(onChainWinnerHex: string, simulatedWinnerHex: string | null): boolean {
  const onChainPubkey = hexToPubkey(onChainWinnerHex)
  const simPubkey = simulatedWinnerHex ? hexToPubkey(simulatedWinnerHex) : null

  console.log('\n📊 Results:')
  console.log(`   On-chain winner:  ${onChainPubkey}`)
  console.log(`   Simulated winner: ${simPubkey || 'N/A'}`)

  if (simulatedWinnerHex && onChainWinnerHex === simulatedWinnerHex) {
    console.log('\n🎉 VERIFIED: Simulation matches on-chain result!')
    return true
  } else if (simulatedWinnerHex) {
    console.log('\n❌ MISMATCH: Simulation does not match on-chain result!')
    console.log('   This could indicate:')
    console.log('   - Different engine config version')
    console.log('   - Missing or incorrect player configs')
    console.log('   - Engine bug')
    return false
  } else {
    console.log('\n⚠️  Could not compare results (missing winner data)')
    return false
  }
}

// ─── STEP 7: Build Rankings ───────────────────────────────────────────────────
interface RankingEntry {
  pubkeyHex: string
  placement: number
  kills: number
  framesAlive: number
  deathFrame?: number
}

function buildSimulatedRankings(currentState: any, players: PlayerData[]): RankingEntry[] {
  const perPlayer = currentState.econ?.perPlayer || {}

  // Count inherited/lost kills
  const inheritedKills: Record<string, number> = {}
  const lostKills: Record<string, number> = {}
  const killInheritEvents = (currentState.econ?.events?.filter((e: any) => e.type === 'KillInheritance') || []) as any[]

  for (const ev of killInheritEvents) {
    const victimKills = (perPlayer[ev.victim_id] as any)?.kills || 0
    inheritedKills[ev.killer_id] = (inheritedKills[ev.killer_id] || 0) + victimKills
    lostKills[ev.victim_id] = (lostKills[ev.victim_id] || 0) + victimKills
  }

  // Build rankings
  const simRankings: RankingEntry[] = []
  for (const [pubkeyHex, data] of Object.entries(perPlayer)) {
    const directKills = (data as any).kills || 0
    const inherited = inheritedKills[pubkeyHex] || 0
    const lost = lostKills[pubkeyHex] || 0
    simRankings.push({
      pubkeyHex,
      placement: 0,
      kills: directKills + inherited - lost,
      framesAlive: (data as any).framesAlive || 0,
      deathFrame: (data as any).death_frame,
    })
  }

  // Sort by framesAlive desc, kills desc, roster index
  const rosterOrder = players.map(p => p.pubkeyHex)
  simRankings.sort((a, b) => {
    if (b.framesAlive !== a.framesAlive) return b.framesAlive - a.framesAlive
    if (b.kills !== a.kills) return b.kills - a.kills
    return rosterOrder.indexOf(a.pubkeyHex) - rosterOrder.indexOf(b.pubkeyHex)
  })

  for (let i = 0; i < simRankings.length; i++) {
    simRankings[i].placement = i + 1
  }

  return simRankings
}

function buildOnChainRankings(snapshot: any): { pubkeyHex: string; placement: number; kills: number }[] {
  return snapshot.players
    .map((p: any) => ({ pubkeyHex: toHex(p.player), placement: p.placement, kills: p.kills }))
    .sort((a: any, b: any) => a.placement - b.placement)
}

// ─── STEP 8: Verify Roster ────────────────────────────────────────────────────
function verifyRoster(onChainRankings: any[], simRankings: RankingEntry[]): boolean {
  console.log('\n📋 Full Roster Verification:')
  console.log('   Place | On-Chain                           | Simulated                          | Kills | DeathFrame')
  console.log('   ------|------------------------------------|------------------------------------|-------|----------')

  let allMatch = true
  for (let i = 0; i < Math.max(onChainRankings.length, simRankings.length); i++) {
    const onChain = onChainRankings[i]
    const sim = simRankings[i]

    const onChainPubkey = onChain ? hexToPubkey(onChain.pubkeyHex) : 'N/A'
    const simPubkey = sim ? hexToPubkey(sim.pubkeyHex) : 'N/A'
    const onChainKills = onChain ? onChain.kills : '-'
    const simKills = sim ? sim.kills : '-'
    const deathFrame = sim ? (sim.deathFrame ?? 'winner') : '-'
    const framesAlive = sim ? sim.framesAlive : '-'

    const placeMatch = onChain && sim && onChain.pubkeyHex === sim.pubkeyHex
    const killsMatch = onChain && sim && onChain.kills === sim.kills
    const marker = placeMatch ? (killsMatch ? '✅' : '⚠️') : '❌'

    if (!placeMatch) allMatch = false

    console.log(`   ${marker} ${i + 1}   | ${onChainPubkey.padEnd(34)} | ${simPubkey.padEnd(34)} | ${String(onChainKills).padEnd(1)}/${String(simKills).padEnd(1)}   | ${framesAlive}`)
  }

  if (allMatch) {
    console.log('\n🎉 FULL ROSTER VERIFIED: All placements match!')
  } else {
    console.log('\n❌ ROSTER MISMATCH: Some placements differ!')
  }

  return allMatch
}

// ─── STEP 9: Verify Payouts ───────────────────────────────────────────────────
function verifyPayouts(onChainRankings: any[], currentState: any, snapshot: any): boolean {
  const perPlayer = currentState.econ?.perPlayer || {}

  console.log('\n💰 Payout Verification:')
  console.log('   Player                              | On-Chain      | Simulated     | Diff')
  console.log('   ------------------------------------|---------------|---------------|------')

  let payoutMatch = true
  let totalOnChain = 0
  let totalSimulated = 0

  for (const onChain of onChainRankings) {
    const simData = perPlayer[onChain.pubkeyHex] as any
    const onChainPayout = Number(snapshot.players.find((p: any) => toHex(p.player) === onChain.pubkeyHex)?.payout_lamports || 0)
    const simPayout = simData ? Math.round(simData.total_earned || 0) : 0

    totalOnChain += onChainPayout
    totalSimulated += simPayout

    const diff = onChainPayout - simPayout
    const diffStr = diff === 0 ? '✅' : (diff > 0 ? `+${diff}` : `${diff}`)
    const marker = diff === 0 ? '✅' : '⚠️'

    if (diff !== 0) payoutMatch = false

    const pubkey = hexToPubkey(onChain.pubkeyHex)
    console.log(`   ${marker} ${pubkey.padEnd(34)} | ${(onChainPayout / 1e9).toFixed(6)} SOL | ${(simPayout / 1e9).toFixed(6)} SOL | ${diffStr}`)
  }

  console.log('   ------------------------------------|---------------|---------------|------')
  console.log(`   Total                               | ${(totalOnChain / 1e9).toFixed(6)} SOL | ${(totalSimulated / 1e9).toFixed(6)} SOL |`)

  // Show TP events
  const tpEvents = (currentState.econ?.events?.filter((e: any) => e.type === 'TPCashout') || []) as any[]
  if (tpEvents.length > 0) {
    console.log('\n📤 TP Cashout Events:')
    for (const tp of tpEvents) {
      console.log(`   Frame ${tp.frame}: ${hexToPubkey(tp.player_id)} cashed out ${(tp.amount / 1e9).toFixed(6)} SOL (target: ${(tp.target / 1e9).toFixed(6)} SOL)`)
    }
  }

  // Show kill inheritance events
  const inheritEvents = (currentState.econ?.events?.filter((e: any) => e.type === 'KillInheritance') || []) as any[]
  if (inheritEvents.length > 0) {
    console.log('\n🔄 Kill Inheritance Events:')
    for (const ev of inheritEvents) {
      console.log(`   Frame ${ev.frame}: ${hexToPubkey(ev.killer_id).slice(0, 8)}... inherited ${(ev.transferred / 1e9).toFixed(6)} SOL from ${hexToPubkey(ev.victim_id).slice(0, 8)}...`)
    }
  }

  if (payoutMatch) {
    console.log('\n🎉 PAYOUTS VERIFIED: All payouts match!')
  } else {
    console.log('\n⚠️  PAYOUT MISMATCH: Some payouts differ (may be due to rounding or dev fee)')
  }

  return payoutMatch
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs()
  console.log(`\n🔍 Verifying Round ${args.roundId} (Tier ${args.tierId}) on ${args.network}\n`)

  // Step 1: Load ICP packages and create actor
  console.log('Loading ICP packages...')
  await loadDfinityPackages()
  const actor = await createIcpActor(args.network)

  // Step 2: Fetch round data
  const roundData = await fetchRoundData(actor, args.roundId, args.tierId)

  // Step 3: Build players
  const players = buildPlayers(roundData.playerConfigs, roundData.snapshot)
  console.log('\n📋 Roster (sorted by join time):')
  players.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.pubkeyHex.slice(0, 8)}... (joined: ${p.joinTs}, alloc: split=${p.allocSplit} tether=${p.allocTether} power=${p.allocPower})`)
  })

  // Step 4: Build simulation inputs
  console.log('\n⚙️  Running simulation...')
  const simInputs = buildSimulationInputs(players, roundData.engineConfig, args, roundData.seedHex, roundData.configVersion)

  if (args.verbose) {
    console.log('  Skill multipliers:', JSON.stringify(simInputs.multipliersByOwnerHex, null, 2))
  }

  // Step 5: Run simulation
  const simResult = await runSimulation(
    simInputs.seedBytes,
    simInputs.enginePlayers,
    roundData.engineConfig,
    simInputs.economicsInputs,
    simInputs.multipliersByOwnerHex,
    simInputs.spawnByOwnerHex,
    args.verbose
  )

  console.log(`\n✅ Simulation complete at frame ${simResult.frame}`)
  console.log(`   Unique owners remaining: ${simResult.countUniqueOwnersV2(simResult.currentState.orbs)}`)

  // Step 6: Verify winner
  const winnerMatch = verifyWinner(roundData.onChainWinnerHex, simResult.winnerHex)
  if (!winnerMatch && simResult.winnerHex) {
    process.exit(1)
  }

  // Step 7: Build rankings
  const simRankings = buildSimulatedRankings(simResult.currentState, players)
  const onChainRankings = buildOnChainRankings(roundData.snapshot)

  // Step 8: Verify roster
  const rosterMatch = verifyRoster(onChainRankings, simRankings)
  if (!rosterMatch) {
    console.log('\n🔍 Debug - Simulated perPlayer data:')
    const perPlayer = simResult.currentState.econ?.perPlayer || {}
    for (const [hex, data] of Object.entries(perPlayer)) {
      console.log(`   ${hexToPubkey(hex)}: framesAlive=${(data as any).framesAlive}, kills=${(data as any).kills}`)
    }
  }

  // Step 9: Verify payouts
  verifyPayouts(onChainRankings, simResult.currentState, roundData.snapshot)
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
