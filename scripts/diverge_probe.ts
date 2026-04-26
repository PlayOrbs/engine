#!/usr/bin/env bun
/**
 * Divergence Probe
 *
 * Fetches a round's inputs once, then runs the simulation TWO ways:
 *  A) LIVE-style init — mirrors balls-game/src/services/gameInitializer.ts
 *     (buildPlayers/buildEconomicsInputs/buildSpawnOverrides/buildSkillMultipliers)
 *     plus gameInstanceManager.ts TP-preset application.
 *  B) REPLAY-style init — mirrors balls-game/src/ui/hooks/usePrecompute.ts
 *     (inline economicsInputs, inline spawns, inline multipliers with
 *     shouldUseAccelMul gate).
 *
 * Both sims receive the SAME fetched data, so any divergence must be in the
 * transformation code — not the fetch. If winners match, the bug is elsewhere
 * (likely in the data-fetch difference between live-pre-settlement and replay-
 * post-settlement, which is the next probe to extend this script with).
 *
 * Usage:
 *   bun scripts/diverge_probe.ts --round 30 --tier 1 --network mainnet
 */
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

function deriveJoinNonce(roundSeed: Uint8Array, playerIndex: number): Uint8Array {
  const info = new TextEncoder().encode(`join_nonce:${playerIndex}`)
  return hkdf(sha256, roundSeed, new Uint8Array(0), info, 32)
}

const ICP_CONFIG = {
  mainnet: { canisterId: 'uy5s7-myaaa-aaaam-qfnua-cai', host: 'https://icp-api.io' },
  devnet:  { canisterId: '2lvus-jqaaa-aaaam-qerkq-cai', host: 'https://icp-api.io' },
}

const SOLANA_CONFIG = {
  mainnet: {
    rpc: 'https://rpc.playorbs.com/rpc',
    programId: 'CZGSRyEqc9RkCsGbknF92FQQJqPF7SzQDH7avmfRUaqd',
  },
  devnet: {
    rpc: 'https://api.devnet.solana.com',
    programId: 'CZGSRyEqc9RkCsGbknF92FQQJqPF7SzQDH7avmfRUaqd',
  },
}

// Anchor discriminator for RoundPlayerV2 (from sdk/src/modules/fetch.ts:231).
const ROUND_PLAYER_V2_DISCRIMINATOR = new Uint8Array([0xa2, 0xd1, 0x23, 0x78, 0x52, 0xba, 0x51, 0xf1])

let HttpAgent: any, Actor: any, Principal: any, IDL: any, bs58: any
let Connection: any, PublicKey: any

async function loadDeps() {
  const [agent, principal, candid, bs58m, web3] = await Promise.all([
    import('@dfinity/agent'),
    import('@dfinity/principal'),
    import('@dfinity/candid'),
    import('bs58'),
    import('@solana/web3.js'),
  ])
  HttpAgent = agent.HttpAgent
  Actor = agent.Actor
  Principal = principal.Principal
  IDL = candid.IDL
  bs58 = bs58m.default
  Connection = web3.Connection
  PublicKey = web3.PublicKey
}

function toHex(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

function hexToBase58(hex: string): string {
  return bs58.encode(hexToBytes(hex))
}

function dequantizeSpawn(xQ: number, yQ: number, rotQ: number) {
  return {
    xNorm: xQ / 32767,
    yNorm: yQ / 32767,
    rotRad: (rotQ / 65535) * 2 * Math.PI,
  }
}

function shouldUseAccelMul(v: string): boolean {
  const clean = v.split('-')[0].split('+')[0]
  const [maj, min] = clean.split('.').map(n => parseInt(n, 10) || 0)
  return maj > 3 || (maj === 3 && min >= 1)
}

function hashState(state: any): string {
  // Stable-ish hash of the subset of state that determines the winner.
  // We deep-copy and stringify with sorted keys, then sha256.
  const stable = JSON.stringify(state, (_k, v) => {
    if (v instanceof Uint8Array) return `u8:${toHex(v)}`
    if (typeof v === 'bigint') return `bi:${v.toString()}`
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: any = {}
      for (const k of Object.keys(v).sort()) sorted[k] = v[k]
      return sorted
    }
    return v
  })
  return toHex(sha256(new TextEncoder().encode(stable))).slice(0, 16)
}

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
    round_id: IDL.Nat64, tier_id: IDL.Nat8,
    player_pubkey: IDL.Vec(IDL.Nat8),
    tp_preset: IDL.Nat16,
    spawn_x_q: IDL.Int16, spawn_y_q: IDL.Int16, spawn_rot_q: IDL.Nat16,
    alloc_split: IDL.Nat8, alloc_tether: IDL.Nat8, alloc_power: IDL.Nat8,
    created_at: IDL.Nat64,
  })
  const RoundPlayerSnapshot = IDL.Record({
    player: IDL.Vec(IDL.Nat8), join_ts: IDL.Nat64, tp_preset: IDL.Nat8,
    payout_lamports: IDL.Nat64, placement: IDL.Nat8, kills: IDL.Nat8,
    orb_earned_atoms: IDL.Opt(IDL.Nat64),
    player_config_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
  })
  const RoundSnapshot = IDL.Record({
    tier_id: IDL.Nat8, round_id: IDL.Nat64, season_id: IDL.Nat16,
    players: IDL.Vec(RoundPlayerSnapshot),
    did_emit: IDL.Bool, emit_tx_sig: IDL.Opt(IDL.Text),
    config_version: IDL.Text,
  })
  const EngineConfigIDL = IDL.Record({
    version: IDL.Text, config_json: IDL.Text, created_at: IDL.Nat64,
  })
  return ({ IDL: idl }: any) => IDL.Service({
    get_revealed_seed: IDL.Func([IDL.Nat8, IDL.Nat64], [IDL.Opt(SeedProofIDL)], ['query']),
    get_round_snapshot: IDL.Func([IDL.Nat8, IDL.Nat64], [IDL.Opt(RoundSnapshot)], ['query']),
    list_player_configs_if_revealed: IDL.Func(
      [IDL.Nat64, IDL.Nat8],
      [IDL.Variant({ Ok: IDL.Vec(PlayerConfigOutputIDL), Err: IDL.Text })],
      ['query']
    ),
    get_engine_config: IDL.Func([IDL.Text], [IDL.Opt(EngineConfigIDL)], ['query']),
  })
}

// Shared fetched data (byte-identical for both paths)
interface FetchedData {
  seed: Uint8Array
  seedHex: string
  configVersion: string
  engineConfig: any
  snapshot: any
  // Roster from ICP snapshot — sorted by snapshot join_ts + pubkey tiebreaker
  // (matches loadGameData behaviour for archived rounds / replay path).
  rosterHexIcp: string[]
  // Roster from Solana RoundPlayerV2 PDAs — sorted by on-chain join_ts + pubkey
  // tiebreaker (matches sdk.getRoundRoster() behaviour used by the live path).
  rosterHexSolana: string[]
  // joinDataByOwnerHex — same shape as gameData.joinDataByOwnerHex in production.
  // Content is from ICP player_configs; both live and replay read from ICP for
  // per-player spawn/alloc/tp. Only roster ordering differs between paths.
  joinDataByOwnerHex: Record<string, {
    spawnXNorm: number; spawnYNorm: number; spawnRotRad: number
    allocSplitAggro: number; allocTetherRes: number; allocOrbPower: number
    tpPreset: number
  }>
  payoutModel: string
  tierEntryLamports: number
  onChainWinnerHex: string
}

async function fetchSolanaRoster(
  connection: any,
  programId: any,
  tierId: number,
  roundId: number,
): Promise<string[]> {
  // Mirror sdk/src/modules/fetch.ts:fetchRoundRoster — filter by discriminator
  // + tier_id + round_id, decode join_ts from raw bytes, sort by joinTs + pubkey.
  // Returns [] for settled rounds: RoundPlayerV2 PDAs are closed once all
  // payouts process. In that case, fall through to fetchSolanaRosterFromHistory.
  const tierIdBytes = new Uint8Array([tierId])
  const roundIdBytes = new Uint8Array(8)
  const view = new DataView(roundIdBytes.buffer)
  view.setBigUint64(0, BigInt(roundId), true) // little-endian (Anchor default)

  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(ROUND_PLAYER_V2_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: bs58.encode(tierIdBytes) } },
      { memcmp: { offset: 9, bytes: bs58.encode(roundIdBytes) } },
    ],
  })

  // Account layout after 8-byte discriminator:
  //   offset 8:   tier_id (1)
  //   offset 9:   round_id (8 LE)
  //   offset 17:  season_id (2 LE)
  //   offset 19:  player (32)
  //   offset 51:  stats (32)
  //   offset 83:  join_ts (8 LE, i64)
  const entries: { hex: string; joinTs: number }[] = []
  for (const a of accounts) {
    const data: Uint8Array = a.account.data instanceof Uint8Array
      ? a.account.data
      : new Uint8Array(a.account.data)
    if (data.length < 91) continue
    const player = data.slice(19, 51)
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const joinTs = Number(dv.getBigInt64(83, true))
    entries.push({ hex: toHex(player), joinTs })
  }
  entries.sort((a, b) => {
    if (a.joinTs !== b.joinTs) return a.joinTs - b.joinTs
    const aB58 = hexToBase58(a.hex), bB58 = hexToBase58(b.hex)
    return aB58 < bB58 ? -1 : aB58 > bB58 ? 1 : 0
  })
  return entries.map(e => e.hex)
}

// Computed via sha256("event:PlayerJoinedV2").slice(0, 8) — see events.rs:106
// Verify after first run: print the discriminator of any observed event and
// double-check. Anchor events are "event:<StructName>" for the hash preimage.
const PLAYER_JOINED_V2_DISCRIMINATOR = (() => {
  const name = 'event:PlayerJoinedV2'
  return sha256(new TextEncoder().encode(name)).slice(0, 8)
})()

function findRoundPagePda(programId: any, tierId: number, pageIndex: number) {
  // PDA: ["round_page", tier_id.to_be_bytes()(1), page_index.to_be_bytes()(4 BE u32)]
  const tierBytes = new Uint8Array([tierId])
  const pageBytes = new Uint8Array(4)
  new DataView(pageBytes.buffer).setUint32(0, pageIndex, false) // big-endian
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('round_page'), tierBytes, pageBytes],
    programId,
  )[0]
}

function parsePlayerJoinedV2FromLogs(logs: string[]): { roundId: number; tierId: number; player: string } | null {
  // Anchor emits events as "Program data: <base64>" where bytes are
  // [discriminator(8) | borsh-serialized fields]. For PlayerJoinedV2:
  //   round_id: u64 LE (8), tier_id: u8 (1), player: Pubkey (32),
  //   player_config_hash: [u8;32], tp_preset: u8
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/)
    if (!m) continue
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(Buffer.from(m[1], 'base64')) } catch { continue }
    if (bytes.length < 8 + 8 + 1 + 32) continue
    let match = true
    for (let i = 0; i < 8; i++) if (bytes[i] !== PLAYER_JOINED_V2_DISCRIMINATOR[i]) { match = false; break }
    if (!match) continue
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const roundId = Number(dv.getBigUint64(8, true))
    const tierId = bytes[16]
    const player = bytes.slice(17, 49)
    return { roundId, tierId, player: toHex(player) }
  }
  return null
}

async function fetchSolanaRosterFromHistory(
  connection: any,
  programId: any,
  tierId: number,
  roundId: number,
  expectedCount: number,
): Promise<string[]> {
  // Reconstruct the Solana roster from transaction history for a SETTLED round
  // whose RoundPlayerV2 PDAs have been closed. Scan signatures that touched the
  // RoundPage PDA (oldest-first), decode PlayerJoinedV2 events in each tx's
  // logs, filter to our round_id, sort by blockTime + pubkey. blockTime matches
  // the join_ts written by the program (both from cluster clock).
  //
  // getSignaturesForAddress returns newest-first, so we page all the way back
  // then walk oldest-first. Early-exit once we've found expectedCount players.
  const PAGE_SIZE = 120
  const pageIndex = Math.floor(roundId / PAGE_SIZE)
  const roundPagePda = findRoundPagePda(programId, tierId, pageIndex)

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  console.log(`     (paging signatures for RoundPage ${roundPagePda.toBase58().slice(0, 8)}...)`)
  const allSigs: any[] = []
  let before: string | undefined
  for (let i = 0; i < 50; i++) {
    const batch = await connection.getSignaturesForAddress(
      roundPagePda,
      { limit: 1000, before },
    )
    if (!batch || batch.length === 0) break
    allSigs.push(...batch)
    before = batch[batch.length - 1].signature
    if (batch.length < 1000) break
    await sleep(150)
  }
  console.log(`     collected ${allSigs.length} signatures; scanning oldest→newest for round ${roundId}...`)

  // Reverse to oldest-first, so joins for low round_ids (like round 30) are hit
  // first and we early-exit fast.
  allSigs.reverse()

  const entries: { hex: string; joinTs: number }[] = []
  const seen = new Set<string>()

  // Use getTransactions (batched) where possible; fall back to per-sig with delay.
  const BATCH = 25
  for (let i = 0; i < allSigs.length && entries.length < expectedCount; i += BATCH) {
    const chunk = allSigs.slice(i, i + BATCH).map(s => s.signature)
    let txs: any[]
    try {
      txs = await connection.getTransactions(chunk, { maxSupportedTransactionVersion: 0 })
    } catch (e: any) {
      // Rate limit: back off and retry once serially.
      await sleep(2000)
      txs = []
      for (const sig of chunk) {
        try { txs.push(await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 })) }
        catch { txs.push(null) }
        await sleep(150)
      }
    }
    for (const tx of txs) {
      if (!tx || !tx.meta || tx.meta.err) continue
      const logs: string[] = tx.meta.logMessages || []
      const parsed = parsePlayerJoinedV2FromLogs(logs)
      if (!parsed) continue
      if (parsed.tierId !== tierId || parsed.roundId !== roundId) continue
      if (seen.has(parsed.player)) continue
      seen.add(parsed.player)
      entries.push({ hex: parsed.player, joinTs: Number(tx.blockTime ?? 0) })
      if (entries.length >= expectedCount) break
    }
    await sleep(150)
  }

  entries.sort((a, b) => {
    if (a.joinTs !== b.joinTs) return a.joinTs - b.joinTs
    const aB58 = hexToBase58(a.hex), bB58 = hexToBase58(b.hex)
    return aB58 < bB58 ? -1 : aB58 > bB58 ? 1 : 0
  })
  return entries.map(e => e.hex)
}

async function fetchShared(
  actor: any,
  roundId: number,
  tierId: number,
  solanaConn: any,
  solanaProgramId: any,
): Promise<FetchedData> {
  console.log(`→ Fetching round ${roundId} tier ${tierId}...`)

  const seedRes = await actor.get_revealed_seed(tierId, BigInt(roundId))
  if (!seedRes || seedRes.length === 0) throw new Error('Seed not revealed')
  const seed = new Uint8Array(seedRes[0].seed)
  const seedHex = toHex(seed)

  const snapRes = await actor.get_round_snapshot(tierId, BigInt(roundId))
  if (!snapRes || snapRes.length === 0) throw new Error('Snapshot not found')
  const snapshot = snapRes[0]
  const configVersion: string = snapshot.config_version
  const payoutModel: string = (snapshot as any).payout_model || 'v2_top3'

  const cfgRes = await actor.list_player_configs_if_revealed(BigInt(roundId), tierId)
  if ('Err' in cfgRes) throw new Error(`player configs: ${cfgRes.Err}`)
  const playerConfigs: any[] = cfgRes.Ok

  const engCfgRes = await actor.get_engine_config(configVersion)
  if (!engCfgRes || engCfgRes.length === 0) throw new Error(`engine config ${configVersion} not found`)
  const rawConfig = JSON.parse(engCfgRes[0].config_json)
  const engineConfig = rawConfig.config || rawConfig
  if (engineConfig.orbs && !engineConfig.orbs.spawn) {
    engineConfig.orbs.spawn = {
      mode: 'rings', pad: 20, startInset: 40, ringGap: 30,
      ringsMin: 1, ringsMax: 2, velocity: 'tangent', jitter: true,
    }
  }

  // ICP roster: sort snapshot players by join_ts asc, then pubkey base58 asc —
  // matches loadGameData's ordering for archived rounds (replay path).
  const entries = snapshot.players
    .filter((p: any) => p.placement > 0)
    .map((p: any) => ({ player: toHex(p.player), joinTs: Number(p.join_ts), tpPreset: p.tp_preset }))
  entries.sort((a: any, b: any) => {
    if (a.joinTs !== b.joinTs) return a.joinTs - b.joinTs
    const aB58 = hexToBase58(a.player), bB58 = hexToBase58(b.player)
    return aB58 < bB58 ? -1 : aB58 > bB58 ? 1 : 0
  })
  const rosterHexIcp = entries.map((e: any) => e.player)

  // Solana roster: fetch on-chain RoundPlayerV2 PDAs and sort by on-chain
  // join_ts — mirrors what the LIVE client sees via sdk.getRoundRoster().
  // For settled rounds the PDAs are closed, so fall through to reconstruct
  // from PlayerJoinedV2 event logs indexed against the RoundPage PDA.
  console.log('  → fetching Solana roster (live RoundPlayerV2 PDAs)...')
  let rosterHexSolana = await fetchSolanaRoster(solanaConn, solanaProgramId, tierId, roundId)
  if (rosterHexSolana.length === 0) {
    console.log('  → RoundPlayerV2 PDAs closed; reconstructing from event history...')
    rosterHexSolana = await fetchSolanaRosterFromHistory(solanaConn, solanaProgramId, tierId, roundId, rosterHexIcp.length)
  }

  const joinDataByOwnerHex: FetchedData['joinDataByOwnerHex'] = {}
  for (const cfg of playerConfigs) {
    const hex = toHex(cfg.player_pubkey)
    const spawn = dequantizeSpawn(cfg.spawn_x_q, cfg.spawn_y_q, cfg.spawn_rot_q)
    const snap = entries.find((e: any) => e.player === hex)
    joinDataByOwnerHex[hex] = {
      spawnXNorm: spawn.xNorm,
      spawnYNorm: spawn.yNorm,
      spawnRotRad: spawn.rotRad,
      allocSplitAggro: cfg.alloc_split,
      allocTetherRes: cfg.alloc_tether,
      allocOrbPower: cfg.alloc_power,
      tpPreset: snap ? snap.tpPreset : 0,
    }
  }

  // Derive entry lamports from total payout (same formula as verify_round.ts).
  const DEV_FEE_BPS = 1500
  const totalPayout = snapshot.players.reduce((s: number, p: any) => s + Number(p.payout_lamports), 0)
  const tierEntryLamports = Math.round(totalPayout / (rosterHexIcp.length * (1 - DEV_FEE_BPS / 10000)))

  const winner = snapshot.players.find((p: any) => p.placement === 1)
  return {
    seed, seedHex, configVersion, engineConfig, snapshot,
    rosterHexIcp, rosterHexSolana, joinDataByOwnerHex, payoutModel, tierEntryLamports,
    onChainWinnerHex: toHex(winner.player),
  }
}

// ─── Builders: LIVE style vs REPLAY style ─────────────────────────────────────

const SKILL_A = 0.5, SKILL_K = 0.5
const calcMul = (points: number) => 1 + SKILL_A * (1 - Math.exp(-SKILL_K * points))

// Mirrors balls-game/src/services/gameInitializer.ts:buildSkillMultipliers — NO configVersion gate.
function buildLiveMultipliers(joinData: FetchedData['joinDataByOwnerHex']) {
  const out: Record<string, any> = {}
  for (const [hex, d] of Object.entries(joinData)) {
    out[hex] = {
      splitAggroMul: calcMul(d.allocSplitAggro ?? 0),
      tetherResMul: 1,
      tetherDefMul: calcMul(d.allocTetherRes ?? 0),
      powerMul: 1,
      accelMul: calcMul(d.allocOrbPower ?? 0),
    }
  }
  return out
}

// Mirrors balls-game/src/ui/hooks/usePrecompute.ts — gated on configVersion.
function buildReplayMultipliers(joinData: FetchedData['joinDataByOwnerHex'], configVersion: string) {
  const useAccel = shouldUseAccelMul(configVersion)
  const out: Record<string, any> = {}
  for (const [hex, d] of Object.entries(joinData)) {
    out[hex] = {
      splitAggroMul: calcMul(d.allocSplitAggro ?? 0),
      tetherResMul: 1,
      tetherDefMul: calcMul(d.allocTetherRes ?? 0),
      powerMul: 1,
      accelMul: useAccel ? calcMul(d.allocOrbPower ?? 0) : 1,
    }
  }
  return out
}

function buildSpawns(joinData: FetchedData['joinDataByOwnerHex'], engineConfig: any) {
  const cx = engineConfig.canvas.width / 2
  const cy = engineConfig.canvas.height / 2
  const R = engineConfig.boundary.radius
  const baseSpeed = engineConfig.orbs.baseSpeed ?? 8
  const out: Record<string, any> = {}
  for (const [hex, d] of Object.entries(joinData)) {
    out[hex] = { x: cx + d.spawnXNorm * R, y: cy + d.spawnYNorm * R, angle: d.spawnRotRad, speed: baseSpeed }
  }
  return out
}

function buildJoinMap(joinData: FetchedData['joinDataByOwnerHex']) {
  const presetNames: Record<number, string> = { 1: 'safe', 2: 'balanced', 3: 'fierce', 4: 'yolo' }
  const out: Record<string, { tp?: { enabled: boolean; preset?: string } }> = {}
  for (const [hex, d] of Object.entries(joinData)) {
    const tp = d.tpPreset ?? 0
    if (tp > 0 && tp <= 4) out[hex] = { tp: { enabled: true, preset: presetNames[tp] } }
  }
  return out
}

// Mirrors gameInitializer.ts:buildEconomicsInputs (LIVE path).
function buildLiveEconomicsInputs(d: FetchedData, roundId: number, roster: string[]) {
  const isV1 = d.payoutModel === 'v1_inherit'
  const isFree = d.tierEntryLamports === 0
  return {
    header: {
      round_id: roundId,
      seed_hex: d.seedHex,
      map_id: 'default',            // matches ECONOMICS_CONSTANTS.MAP_ID default
      rules_hash: 'v1',             // matches ECONOMICS_CONSTANTS.RULES_HASH
      build_hash: 'live-probe',
      mode: isFree ? 'free_sim' : 'paid',
      economy_model: isV1 ? 'weighted_kill_v2_inherit' : 'weighted_kill_v2',
      dev_fee_bps: isV1 ? 2000 : 1500,
      payout_model: d.payoutModel,
    },
    economic_params: {
      total_players: roster.length,
      entry_amount_lamports: d.tierEntryLamports,
      bounty_bps: isV1 ? 7000 : 4000,
      survival_bps: isV1 ? 3000 : 6000,
      simulated: isFree,
    },
    roster: [...roster],
    tp_targets_lamports: undefined,
  }
}

// Mirrors usePrecompute.ts inline construction (REPLAY path).
function buildReplayEconomicsInputs(d: FetchedData, roundId: number, roster: string[]) {
  const isV1 = d.payoutModel === 'v1_inherit'
  return {
    header: {
      round_id: roundId,
      seed_hex: d.seedHex,
      map_id: 'default',
      rules_hash: 'v1',
      build_hash: 'replay-probe',
      mode: 'paid' as const,                // hardcoded in replay
      economy_model: isV1 ? 'weighted_kill_v2_inherit' : 'weighted_kill_v2',
      dev_fee_bps: isV1 ? 2000 : 1500,
      payout_model: d.payoutModel,
    },
    roster,
    economic_params: {
      total_players: roster.length,
      entry_amount_lamports: d.tierEntryLamports,
      bounty_bps: isV1 ? 7000 : 4000,
      survival_bps: isV1 ? 3000 : 6000,
    },
  }
}

function buildPlayers(seed: Uint8Array, rosterHex: string[]) {
  return rosterHex.map((hex, idx) => ({
    pubkey: hexToBytes(hex),
    joinNonce: deriveJoinNonce(seed, idx),
  }))
}

// ─── Sim runner ───────────────────────────────────────────────────────────────

async function runSim(label: string, d: FetchedData, roundId: number, style: 'live' | 'replay') {
  const { initFromSeedV2, advanceFrameV2, countUniqueOwnersV2 } = await import('../src/core/v2/sim_v2.js')
  const { applyTPPresetsToTargets } = await import('../src/economics/scoring.js')

  // LIVE reads roster from Solana RoundPlayerV2 PDAs (via sdk.getRoundRoster).
  // REPLAY reads roster from the ICP snapshot (via loadGameData).
  const roster = style === 'live' ? d.rosterHexSolana : d.rosterHexIcp
  const players = buildPlayers(d.seed, roster)
  const multipliers = style === 'live'
    ? buildLiveMultipliers(d.joinDataByOwnerHex)
    : buildReplayMultipliers(d.joinDataByOwnerHex, d.configVersion)
  const spawns = buildSpawns(d.joinDataByOwnerHex, d.engineConfig)
  const econInputs = style === 'live'
    ? buildLiveEconomicsInputs(d, roundId, roster)
    : buildReplayEconomicsInputs(d, roundId, roster)
  const joinMap = buildJoinMap(d.joinDataByOwnerHex)

  const cfg = { ...d.engineConfig, economicsInputs: econInputs, debug: false }
  const { state, cfg: fpCfg } = initFromSeedV2(d.seed, players as any, cfg as any, { spawnByOwnerHex: spawns, multipliersByOwnerHex: multipliers } as any)
  applyTPPresetsToTargets(state as any, joinMap)

  const frame0Hash = hashState(state)

  const MAX = 72000
  let cur = state
  let frame = 0
  while (countUniqueOwnersV2(cur.orbs) > 1 && frame < MAX) {
    const res = advanceFrameV2(cur, fpCfg)
    cur = res.state
    frame++
  }

  // Rank by (framesAlive desc, kills desc, rosterIdx asc) — matches UI winner logic.
  const perPlayer = cur.econ?.perPlayer || {}
  const ranked = Object.entries(perPlayer)
    .map(([hex, data]: [string, any]) => ({
      hex,
      framesAlive: data.framesAlive || 0,
      kills: data.kills || 0,
      rosterIdx: roster.indexOf(hex),
    }))
    .sort((a, b) => {
      if (b.framesAlive !== a.framesAlive) return b.framesAlive - a.framesAlive
      if (b.kills !== a.kills) return b.kills - a.kills
      return a.rosterIdx - b.rosterIdx
    })
  const winnerHex = ranked[0]?.hex ?? null
  const finalHash = hashState(cur)

  console.log(`\n[${label}]`)
  console.log(`  accelMul sample: ${Object.values(multipliers)[0]?.accelMul?.toFixed(4)}`)
  console.log(`  econInputs.header.mode: ${(econInputs as any).header.mode}`)
  console.log(`  econInputs has simulated field: ${'simulated' in ((econInputs as any).economic_params ?? {})}`)
  console.log(`  frame0 hash:  ${frame0Hash}`)
  console.log(`  final frame:  ${frame}`)
  console.log(`  final hash:   ${finalHash}`)
  console.log(`  winner:       ${winnerHex ? hexToBase58(winnerHex) : 'n/a'} (kills=${ranked[0]?.kills}, framesAlive=${ranked[0]?.framesAlive})`)

  return { winnerHex, frame0Hash, finalHash, frame, initState: state, econInputs, multipliers }
}

// Walk two objects and return paths where they differ, up to a cap. Handles
// Uint8Array and bigint. Ignores undefined-vs-missing (different shape but no
// semantic diff) — reports those separately as "shape".
function deepDiff(a: any, b: any, path = '', out: string[] = [], cap = 50): string[] {
  if (out.length >= cap) return out
  const norm = (v: any) => {
    if (v instanceof Uint8Array) return `u8:${toHex(v)}`
    if (typeof v === 'bigint') return `bi:${v.toString()}`
    return v
  }
  if (a === b) return out
  const aT = typeof a, bT = typeof b
  if (a && b && aT === 'object' && bT === 'object' && !(a instanceof Uint8Array) && !(b instanceof Uint8Array)) {
    if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path || '<root>'}: array/object mismatch`); return out }
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
    const sorted = [...keys].sort()
    for (const k of sorted) {
      if (out.length >= cap) break
      const childPath = path ? `${path}.${k}` : k
      deepDiff(a[k], b[k], childPath, out, cap)
    }
    return out
  }
  const na = norm(a), nb = norm(b)
  if (na !== nb) {
    const show = (v: any) => {
      if (v === undefined) return '∅'
      if (typeof v === 'string' && v.length > 40) return `${v.slice(0, 40)}…`
      return JSON.stringify(v)
    }
    out.push(`${path || '<root>'}: live=${show(na)}  replay=${show(nb)}`)
  }
  return out
}

function parseArgs() {
  const a = process.argv.slice(2)
  let roundId = -1, tierId = 0, network: 'mainnet' | 'devnet' = 'mainnet'
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--round' && a[i+1]) roundId = parseInt(a[i+1], 10)
    if (a[i] === '--tier'  && a[i+1]) tierId  = parseInt(a[i+1], 10)
    if (a[i] === '--network' && a[i+1]) network = a[i+1] as any
  }
  if (roundId < 0) {
    console.error('usage: bun scripts/diverge_probe.ts --round <id> --tier <id> [--network mainnet|devnet]')
    process.exit(1)
  }
  return { roundId, tierId, network }
}

function rosterDiff(live: string[], replay: string[]) {
  const max = Math.max(live.length, replay.length)
  const rows: string[] = []
  for (let i = 0; i < max; i++) {
    const l = live[i] ? hexToBase58(live[i]).slice(0, 8) : '—'
    const r = replay[i] ? hexToBase58(replay[i]).slice(0, 8) : '—'
    const mark = live[i] === replay[i] ? '  ' : '≠ '
    rows.push(`  [${i}] ${mark} live=${l}   replay=${r}`)
  }
  return rows.join('\n')
}

async function main() {
  const args = parseArgs()
  await loadDeps()
  const icpCfg = ICP_CONFIG[args.network]
  const solCfg = SOLANA_CONFIG[args.network]
  const agent = HttpAgent.createSync({ host: icpCfg.host })
  const actor = Actor.createActor(createIdl(), { agent, canisterId: Principal.fromText(icpCfg.canisterId) })
  const solanaConn = new Connection(solCfg.rpc, 'confirmed')
  const solanaProgramId = new PublicKey(solCfg.programId)

  const data = await fetchShared(actor, args.roundId, args.tierId, solanaConn, solanaProgramId)

  console.log(`\nRound:          ${args.roundId}  tier: ${args.tierId}  network: ${args.network}`)
  console.log(`config_version: ${data.configVersion}  shouldUseAccelMul: ${shouldUseAccelMul(data.configVersion)}`)
  console.log(`payout_model:   ${data.payoutModel}`)
  console.log(`entry_lamports: ${data.tierEntryLamports}`)
  console.log(`ICP roster    (${data.rosterHexIcp.length}, sorted by snapshot join_ts+pubkey):`)
  for (let i = 0; i < data.rosterHexIcp.length; i++) {
    const hex = data.rosterHexIcp[i]
    const jd = data.joinDataByOwnerHex[hex]
    console.log(`  [${i}] ${hexToBase58(hex).slice(0, 8)}  tp=${jd?.tpPreset}  splits=${jd?.allocSplitAggro} tether=${jd?.allocTetherRes} power=${jd?.allocOrbPower}`)
  }
  console.log(`Solana roster (${data.rosterHexSolana.length}, sorted by on-chain join_ts+pubkey):`)
  for (let i = 0; i < data.rosterHexSolana.length; i++) {
    console.log(`  [${i}] ${hexToBase58(data.rosterHexSolana[i]).slice(0, 8)}`)
  }
  const rostersMatch =
    data.rosterHexIcp.length === data.rosterHexSolana.length &&
    data.rosterHexIcp.every((h, i) => h === data.rosterHexSolana[i])
  console.log(`roster match (Solana vs ICP): ${rostersMatch ? '✅' : '❌'}`)
  if (!rostersMatch) {
    console.log('roster diff (live=Solana, replay=ICP):')
    console.log(rosterDiff(data.rosterHexSolana, data.rosterHexIcp))
  }
  console.log(`on-chain winner: ${hexToBase58(data.onChainWinnerHex)}`)

  const live   = await runSim('LIVE',   data, args.roundId, 'live')
  const replay = await runSim('REPLAY', data, args.roundId, 'replay')

  console.log('\n─── Comparison ───')
  console.log(`frame0 hash match: ${live.frame0Hash === replay.frame0Hash ? '✅' : '❌'}  (live=${live.frame0Hash}, replay=${replay.frame0Hash})`)
  console.log(`final hash match:  ${live.finalHash === replay.finalHash ? '✅' : '❌'}  (live=${live.finalHash}, replay=${replay.finalHash})`)
  console.log(`winner match:      ${live.winnerHex === replay.winnerHex ? '✅' : '❌'}`)

  if (live.frame0Hash !== replay.frame0Hash) {
    console.log('\n─── Init-input diff (econInputs) ───')
    const inputDiffs = deepDiff(live.econInputs, replay.econInputs)
    if (inputDiffs.length === 0) console.log('  (identical)')
    else for (const d of inputDiffs) console.log(`  ${d}`)

    console.log('\n─── Init-input diff (multipliers) ───')
    const mulDiffs = deepDiff(live.multipliers, replay.multipliers)
    if (mulDiffs.length === 0) console.log('  (identical)')
    else for (const d of mulDiffs) console.log(`  ${d}`)

    console.log('\n─── Init-state diff (frame 0 state) ───')
    const stateDiffs = deepDiff(live.initState, replay.initState)
    if (stateDiffs.length === 0) console.log('  (identical — drift must be in cfg)')
    else {
      console.log(`  ${stateDiffs.length} leaf diff(s) (showing up to 50):`)
      for (const d of stateDiffs) console.log(`  ${d}`)
    }
  }

  console.log(`  live winner:   ${live.winnerHex ? hexToBase58(live.winnerHex) : 'n/a'}`)
  console.log(`  replay winner: ${replay.winnerHex ? hexToBase58(replay.winnerHex) : 'n/a'}`)
  console.log(`  onchain winner:${hexToBase58(data.onChainWinnerHex)}`)

  if (live.winnerHex !== replay.winnerHex) {
    console.log('\n✅  Reproduced divergence!')
    if (!rostersMatch) {
      console.log('    Solana and ICP rosters differ → LIVE and REPLAY see different')
      console.log('    roster orderings → deriveJoinNonce(seed, idx) produces different')
      console.log('    nonces → different spawns → different winner. This is the bug.')
    } else {
      console.log('    Rosters match but winners differ → init-code drift is enough')
      console.log('    to flip the winner for this round.')
    }
  } else if (!rostersMatch) {
    console.log('\nℹ️  Rosters differ between Solana and ICP, but both happen to produce')
    console.log('   the same winner for this round. In a closer round, the same roster')
    console.log('   drift could flip the winner. Worth investigating why they differ.')
  } else {
    console.log('\nℹ️  Rosters match and both paths produced the same winner. Divergence')
    console.log('   must be in POST-INIT state mutation during the live loop (e.g., TP')
    console.log('   preset applied after sim started, or something writing to FP state).')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
