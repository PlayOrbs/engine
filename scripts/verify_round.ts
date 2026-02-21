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
function dequantizeSpawn(xQ: number, yQ: number, rotQ: number): { xNorm: number; yNorm: number; rotRad: number } {
  // Quantization: q = round(norm * 10000) where norm is [-1, 1]
  // Dequantize: norm = q / 10000
  const xNorm = xQ / 10000
  const yNorm = yQ / 10000
  const rotRad = (rotQ / 10000) * Math.PI  // rotQ is 0-20000 mapping to 0-2π
  return { xNorm, yNorm, rotRad }
}

async function main() {
  const args = parseArgs()
  
  console.log(`\n🔍 Verifying Round ${args.roundId} (Tier ${args.tierId}) on ${args.network}\n`)
  
  // Load dfinity packages
  console.log('Loading ICP packages...')
  await loadDfinityPackages()
  
  // Create ICP actor
  const config = ICP_CONFIG[args.network]
  const agent = HttpAgent.createSync({ host: config.host })
  const actor = Actor.createActor(createIdl(), {
    agent,
    canisterId: Principal.fromText(config.canisterId),
  })
  
  // Fetch seed
  console.log('Fetching round seed...')
  const seedResult = await actor.get_revealed_seed(args.tierId, BigInt(args.roundId))
  if (!seedResult || seedResult.length === 0) {
    console.error('❌ Seed not revealed for this round. Round may not be settled yet.')
    process.exit(1)
  }
  const seedProof = seedResult[0]
  const seedHex = toHex(seedProof.seed)
  console.log(`  Seed: ${seedHex.slice(0, 16)}...`)
  
  // Fetch round snapshot (contains on-chain results)
  console.log('Fetching round snapshot...')
  const snapshotResult = await actor.get_round_snapshot(args.tierId, BigInt(args.roundId))
  if (!snapshotResult || snapshotResult.length === 0) {
    console.error('❌ Round snapshot not found.')
    process.exit(1)
  }
  const snapshot = snapshotResult[0]
  const configVersion = snapshot.config_version
  console.log(`  Config version: ${configVersion}`)
  console.log(`  Players: ${snapshot.players.length}`)
  
  // Find on-chain winner (placement === 1)
  const onChainWinner = snapshot.players.find((p: any) => p.placement === 1)
  const onChainWinnerHex = onChainWinner ? toHex(onChainWinner.player) : null
  
  // Fetch player configs
  console.log('Fetching player configs...')
  const configsResult = await actor.list_player_configs_if_revealed(BigInt(args.roundId), args.tierId)
  if ('Err' in configsResult) {
    console.error(`❌ Failed to fetch player configs: ${configsResult.Err}`)
    process.exit(1)
  }
  const playerConfigs = configsResult.Ok
  console.log(`  Configs: ${playerConfigs.length}`)
  
  // Fetch engine config
  console.log('Fetching engine config...')
  const engineConfigResult = await actor.get_engine_config(configVersion)
  if (!engineConfigResult || engineConfigResult.length === 0) {
    console.error(`❌ Engine config ${configVersion} not found.`)
    process.exit(1)
  }
  const rawConfig = JSON.parse(engineConfigResult[0].config_json)
  // The config from ICP may be wrapped in a 'config' property
  const engineConfig = rawConfig.config || rawConfig
  
  if (args.verbose) {
    console.log('  Engine config keys:', Object.keys(engineConfig))
    console.log('  orbs config:', JSON.stringify(engineConfig.orbs, null, 2))
  }
  
  // Ensure orbs.spawn exists with defaults if missing
  if (engineConfig.orbs && !engineConfig.orbs.spawn) {
    engineConfig.orbs.spawn = {
      mode: 'rings',
      pad: 20,
      startInset: 40,
      ringGap: 30,
      ringsMin: 1,
      ringsMax: 2,
      velocity: 'tangent',
      jitter: true,
    }
  }
  
  // Build players from configs
  const players = playerConfigs.map((cfg: any) => {
    const pubkeyHex = toHex(cfg.player_pubkey)
    const spawn = dequantizeSpawn(cfg.spawn_x_q, cfg.spawn_y_q, cfg.spawn_rot_q)
    
    // Find join_ts from snapshot for roster ordering
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
  
  // Sort by joinTs (roster order)
  players.sort((a: any, b: any) => a.joinTs - b.joinTs)
  
  console.log('\n📋 Roster (sorted by join time):')
  players.forEach((p: any, i: number) => {
    console.log(`  ${i + 1}. ${p.pubkeyHex.slice(0, 8)}... (joined: ${p.joinTs})`)
  })
  
  // Import engine
  console.log('\n⚙️  Running simulation...')
  const { initFromSeedV2, advanceFrameV2, countUniqueOwnersV2 } = await import('../src/core/v2/sim_v2.js')
  
  // Convert hex to Uint8Array
  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    }
    return bytes
  }
  
  // Convert to engine player format
  // Player type expects: { pubkey: Uint8Array; joinNonce: Uint8Array; color?: string }
  const enginePlayers = players.map((p: any, index: number) => ({
    pubkey: hexToBytes(p.pubkeyHex),
    joinNonce: new Uint8Array(8), // Not used for determinism, just needs to exist
  }))
  
  // Build skill multipliers map (InitOpts.multipliersByOwnerHex)
  const multipliersByOwnerHex: Record<string, any> = {}
  for (const p of players) {
    multipliersByOwnerHex[p.pubkeyHex] = {
      splitAggroMul: 1.0 + (p.allocSplit / 100),
      tetherResMul: 1.0, // deprecated, always 1.0
      tetherDefMul: 1.0 + (p.allocTether / 100),
      powerMul: 1.0 + (p.allocPower / 100),
    }
  }
  
  // Build spawn positions map (InitOpts.spawnByOwnerHex)
  // Convert normalized [-1, 1] to pixel coordinates
  const cx = engineConfig.canvas.width / 2
  const cy = engineConfig.canvas.height / 2
  const R = engineConfig.boundary.radius
  const baseSpeed = engineConfig.orbs.baseSpeed ?? 2
  
  const spawnByOwnerHex: Record<string, any> = {}
  for (const p of players) {
    spawnByOwnerHex[p.pubkeyHex] = {
      x: cx + p.spawnXNorm * R,
      y: cy + p.spawnYNorm * R,
      angle: p.spawnRotRad,
      speed: baseSpeed,
    }
  }
  
  if (args.verbose) {
    console.log('  Skill multipliers:', JSON.stringify(multipliersByOwnerHex, null, 2))
  }
  
  // Convert seed hex to bytes
  const seedBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = parseInt(seedHex.substr(i * 2, 2), 16)
  }
  
  // Initialize simulation with opts (args: roundSeed, players, config, opts)
  const initOpts = { multipliersByOwnerHex, spawnByOwnerHex }
  const { state, cfg } = initFromSeedV2(seedBytes, enginePlayers, engineConfig, initOpts)
  
  // Run simulation
  const maxFrames = 72000 // 10 minutes at 120fps
  let frame = 0
  let currentState = state
  while (countUniqueOwnersV2(currentState.orbs) > 1 && frame < maxFrames) {
    const result = advanceFrameV2(currentState, cfg)
    currentState = result.state
    frame++
    
    if (args.verbose && frame % 6000 === 0) {
      console.log(`  Frame ${frame}: ${countUniqueOwnersV2(currentState.orbs)} players remaining`)
    }
  }
  
  // Find winner - in V2, orbs are removed when eliminated, so remaining orbs are all alive
  // Get unique owners from remaining orbs
  const remainingOwners = new Set<string>()
  for (const o of currentState.orbs) {
    remainingOwners.add(toHex(o.owner))
  }
  const winnerHex = remainingOwners.size === 1 ? Array.from(remainingOwners)[0] : null
  
  console.log(`\n✅ Simulation complete at frame ${frame}`)
  console.log(`   Unique owners remaining: ${countUniqueOwnersV2(currentState.orbs)}`)
  
  // Compare results - display as Solana pubkeys (base58)
  const onChainWinnerPubkey = onChainWinnerHex ? hexToPubkey(onChainWinnerHex) : null
  const simulatedWinnerPubkey = winnerHex ? hexToPubkey(winnerHex) : null
  
  console.log('\n📊 Results:')
  console.log(`   On-chain winner:  ${onChainWinnerPubkey || 'N/A'}`)
  console.log(`   Simulated winner: ${simulatedWinnerPubkey || 'N/A'}`)
  
  if (onChainWinnerHex && winnerHex) {
    if (onChainWinnerHex === winnerHex) {
      console.log('\n🎉 VERIFIED: Simulation matches on-chain result!')
    } else {
      console.log('\n❌ MISMATCH: Simulation does not match on-chain result!')
      console.log('   This could indicate:')
      console.log('   - Different engine config version')
      console.log('   - Missing or incorrect player configs')
      console.log('   - Engine bug')
      process.exit(1)
    }
  } else {
    console.log('\n⚠️  Could not compare results (missing winner data)')
  }
  
  // Show final rankings
  if (args.verbose) {
    console.log('\n📈 Final State:')
    state.orbs.forEach((o: any, i: number) => {
      console.log(`   Orb ${i}: owner=${o.ownerHex.slice(0, 8)}... alive=${o.alive}`)
    })
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
