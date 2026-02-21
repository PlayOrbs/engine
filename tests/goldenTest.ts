import { initFromSeed, advanceFrame } from "../src/core/v1/sim.js";
import { computeResultHash } from "../src/economics/scoring.js";
import type { EngineConfig, Player } from "../src/core/v1/types.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function makeConfigWithEconomics(
  seed: Uint8Array,
  roster: string[],
  mode: "paid" | "free_sim" = "free_sim"
): EngineConfig {
  const total_players = roster.length;
  const entry_amount_lamports = Math.trunc(0.025 * 1_000_000_000); // 0.025 SOL
  const bounty_bps = 6000;
  const survival_bps = 3000;
  const economicsInputs = {
    header: {
      round_id: 1,
      seed_hex: toHex(seed),
      map_id: "default",
      rules_hash: "r0",
      build_hash: "r0",
      mode,
      economy_model: 'fixed_total_v0' as const, // Use fixed model to respect bounty_bps/survival_bps
      dev_fee_bps: 0, // No dev fee for tests
    },
    economic_params: {
      total_players,
      entry_amount_lamports,
      bounty_bps,
      survival_bps,
      simulated: mode === "free_sim",
    },
    roster: [...roster],
  };
  const cfg: EngineConfig = {
    canvas: { width: 300, height: 300 },
    boundary: {
      shape: "circle",
      radius: 340,
      restitution: 1.22,
      tangentImpulse: 0.12,
      minSpeed: 0.6,
      maxSpeed: 13.0,
      twoOrbsMaxSpeed: 23.5,
      twoOrbsRampFrames: 600,
    },
    burst: { lineWidth: 2 },
    orbs: { radius: 6 },
    tethers: {
      hitDamping: 0.002, // shave 2% speed on spawn to avoid pop
      springRest: 0, // ~ a bit longer than spawn distance
      springK: 0.0, // stiffness per frame (px -> px/frame)
      springDamping: 0.0, // damping along spring dir (px/frame -> px/frame)
    },
    gravity: {
      base: 0.00003,
      ampFrac: 0.6,
      periodFrames: 360,
      oscillateBelowOrbs: 4,
    },
    edgeGravity: { strength: 0.05, count: 0, insetPixels: 24 },
    collisions: { orbRestitution: 1.09 },
    split: {
      enabled: true,
      vnThreshold: 0.18,
      keThreshold: 0.1,
      radiusScale: 0.72,
      childSpeedMul: 0.62,
      angleSpread: 0.35,
      maxGenerations: 2,
      cooldownFrames: 240,
      maxOrbsCap: 64,
    },
    suddenDeath: {
      enabled: true,
      afterFrames: 900,
      durationFrames: 720,
      gravityMultiplier: 2.6,
      centerShiftRadius: 80,
      centerShiftPeriodFrames: 150,
    },
    economicsInputs,
    disableTraits: true,
  };
  return cfg;
}

function makePlayers(seed: Uint8Array, roster: string[]): Player[] {
  return roster.map((pid, idx) => {
    const pubkey = hexToBytes(pid);
    const info = new TextEncoder().encode("join_nonce:" + idx);
    const joinNonce = hkdf(sha256, seed, new Uint8Array(0), info, 32);
    const color = undefined;
    return { pubkey, joinNonce, color };
  });
}

function simulateOnce(
  seed: Uint8Array,
  roster: string[],
  mode: "paid" | "free_sim"
): any {
  const players = makePlayers(seed, roster);
  const cfg = makeConfigWithEconomics(seed, roster, mode);
  const { state, prngs } = initFromSeed(seed, players, cfg);
  let guard = 0,
    maxFrames = 8000;
  while (guard < maxFrames && state.orbs.length > 1) {
    const st = advanceFrame(state, cfg, prngs);
    Object.assign(state, st);
    guard++;
  }
  let econ = (state as any).econ;
  let events = econ?.events || [];
  let bounties = events.filter((e: any) => e.type === "BountyPayout");
  let survival = events.filter((e: any) => e.type === "SurvivalAward");
  while (survival.length !== 1 && state.orbs.length > 1) {
    // Step extra budget to force finalization
    let extra = 80000;
    while (extra-- > 0 && state.orbs.length > 1) {
      const st = advanceFrame(state, cfg, prngs);
      Object.assign(state, st);
    }
    econ = (state as any).econ;
    events = econ?.events || [];
    bounties = events.filter((e: any) => e.type === "BountyPayout");
    survival = events.filter((e: any) => e.type === "SurvivalAward");
  }
  if (econ && !econ.result_hash) {
    try {
      econ.result_hash = computeResultHash(state);
    } catch {}
  }
  const per_player = econ
    ? (econ.roster as string[]).map((pid) => ({
        player_id: pid,
        ...econ.perPlayer[pid],
      }))
    : [];
  if (
    typeof process !== "undefined" &&
    process.env &&
    (process.env.TEST_LOG === "1" || process.env.TEST_LOG === "true")
  ) {
    // Print a compact one-line summary for debug
    const hash = econ?.result_hash ? String(econ.result_hash).slice(0, 8) : "—";
    // @ts-ignore
    // eslint-disable-next-line no-console
    console.log(
      `[golden] frames=${guard} alive=${state.orbs.length} bounties=${bounties.length} survival=${survival.length} hash=${hash}`
    );
  }
  const out = {
    header: econ?.header,
    economic_params: econ?.economic_params,
    pots: econ?.pots,
    events,
    per_player,
    winner_id: econ?.winner_id,
    result_hash: econ?.result_hash,
  };
  return { out, bounties, survival, econ };
}

export function runGoldenTest(): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  // Fixed seed and roster
  const seed = hexToBytes(
    "c3b9a2c1d44e2f0a13b7ee5d9a5c4f8b77aa55bb66ccddeeff00112233445166"
  );
  const roster = [
    "1111111111111111111111111111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ].sort();
  const mode: "paid" | "free_sim" = "free_sim";

  // Two runs must be identical
  const r1 = simulateOnce(seed, roster, mode);
  const r2 = simulateOnce(seed, roster, mode);
  if (!r1.out || !r2.out) {
    ok = false;
    messages.push("No outputs produced");
  }
  if (r1.out.result_hash !== r2.out.result_hash) {
    ok = false;
    messages.push("result_hash mismatch across runs");
  }

  // Economics assertions
  const total_players = r1.out.economic_params?.total_players || roster.length;
  const bounty_pot = r1.out.pots?.bounty_pot_lamports || 0;
  const survival_pot = r1.out.pots?.survival_pot_lamports || 0;
  const per_kill = r1.out.pots?.bounty_per_kill_lamports || 0;
  const expected_per_kill = Math.trunc(
    bounty_pot / Math.max(1, total_players - 1)
  );
  if (per_kill !== expected_per_kill) {
    ok = false;
    messages.push("bounty_per_kill mismatch");
  }

  const paidSum = sum(r1.bounties.map((e: any) => e.amount || 0));
  if (paidSum > bounty_pot) {
    ok = false;
    messages.push("bounty payouts exceed pot");
  }

  if (r1.survival.length !== 1) {
    ok = false;
    messages.push("expected exactly one SurvivalAward event");
  } else if ((r1.survival[0].amount || 0) !== survival_pot) {
    ok = false;
    messages.push("survival award amount mismatch");
  }

  // Totals check per player
  const per = r1.out.per_player || [];
  for (const p of per) {
    const total = (p.bounty_earned || 0) + (p.survival_earned || 0);
    if (total !== (p.total_earned || 0)) {
      ok = false;
      messages.push(`total mismatch for ${String(p.player_id).slice(0, 8)}`);
    }
  }

  messages.push(`Golden test: ${ok ? "OK" : "FAIL"}`);
  if (
    typeof process !== "undefined" &&
    process.env &&
    (process.env.TEST_LOG === "1" || process.env.TEST_LOG === "true")
  ) {
    // @ts-ignore
    // eslint-disable-next-line no-console
    console.log(messages.join("\n"));
  }
  return { ok, messages };
}

// Optional: enable running in browser via console when using a debug flag
// @ts-ignore
if (typeof window !== "undefined") {
  // @ts-ignore
  (window as any).runGoldenTest = runGoldenTest;
}
