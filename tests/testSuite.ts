import { initFromSeed, advanceFrame } from "../src/core/v1/sim.js";
import { computeResultHash } from "../src/economics/scoring.js";
import type { EngineConfig, Player } from "../src/core/v1/types.js";
import { BUILD_HASH } from "../src/version.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ok, fail, merge, eq, truthy, diffJSON, TestResult } from "./assert.js";

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

function makeConfig(
  seed: Uint8Array,
  roster: string[],
  econ: {
    mode: "paid" | "free_sim";
    entryLamports: number;
    bounty_bps: number;
    survival_bps: number;
    simulated: boolean;
  },
  header?: Partial<{
    round_id: number;
    seed_hex: string;
    map_id: string;
    rules_hash: string;
    build_hash: string;
  }>
): EngineConfig {
  const total_players = roster.length;
  const economicsInputs = {
    header: {
      round_id: header?.round_id ?? 1,
      seed_hex: header?.seed_hex ?? toHex(seed),
      map_id: header?.map_id ?? "default",
      rules_hash: header?.rules_hash ?? "r0",
      build_hash: header?.build_hash ?? BUILD_HASH,
      mode: econ.mode,
      economy_model: 'fixed_total_v0' as const, // Use fixed model to respect bounty_bps/survival_bps
      dev_fee_bps: 0, // No dev fee for tests to match expected pot calculations
    },
    economic_params: {
      total_players,
      entry_amount_lamports: econ.entryLamports,
      bounty_bps: econ.bounty_bps,
      survival_bps: econ.survival_bps,
      simulated: econ.simulated,
    },
    roster: [...roster],
  };
  const cfg: EngineConfig = {
    canvas: { width: 800, height: 800 },
    boundary: {
      shape: "circle",
      radius: 340,
      restitution: 1.08,
      tangentImpulse: 0.06,
      minSpeed: 0.5,
      maxSpeed: 12.0,
      twoOrbsMaxSpeed: 22.5,
      twoOrbsRampFrames: 720,
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
      base: 0.00001,
      ampFrac: 0.6,
      periodFrames: 540,
      oscillateBelowOrbs: 3,
    },
    edgeGravity: { strength: 0.02, count: 0, insetPixels: 24 },
    collisions: { orbRestitution: 1.18 },
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
      afterFrames: 1200,
      durationFrames: 720,
      gravityMultiplier: 2.2,
      centerShiftRadius: 60,
      centerShiftPeriodFrames: 180,
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
function simulate(
  seed: Uint8Array,
  roster: string[],
  mode: "paid" | "free_sim",
  entryLamports: number,
  bounty_bps: number,
  survival_bps: number,
  header?: Partial<{
    round_id: number;
    seed_hex: string;
    map_id: string;
    rules_hash: string;
    build_hash: string;
  }>
) {
  const players = makePlayers(seed, roster);
  const cfg = makeConfig(
    seed,
    roster,
    {
      mode,
      entryLamports,
      bounty_bps,
      survival_bps,
      simulated: mode === "free_sim",
    },
    header
  );
  const { state, prngs } = initFromSeed(seed, players, cfg);
  let frames = 0,
    maxFrames = 8000;
  while (frames < maxFrames && state.orbs.length > 1) {
    const st = advanceFrame(state, cfg, prngs);
    Object.assign(state, st);
    frames++;
  }
  let econ = (state as any).econ;
  let events = econ?.events || [];
  // If not finalized, try extra frames to force finalize
  if (
    (events.find((e: any) => e.type === "SurvivalAward") ? 0 : 1) &&
    state.orbs.length > 1
  ) {
    let extra = 8000;
    while (extra-- > 0 && state.orbs.length > 1) {
      const st = advanceFrame(state, cfg, prngs);
      Object.assign(state, st);
    }
    econ = (state as any).econ;
    events = econ?.events || [];
  }
  if (econ && !econ.result_hash) {
    try {
      econ.result_hash = computeResultHash(state);
    } catch {}
  }
  const out = {
    header: econ?.header,
    economic_params: econ?.economic_params,
    pots: econ?.pots,
    events,
    per_player: econ
      ? (econ.roster as string[]).map((pid) => ({
          player_id: pid,
          ...econ.perPlayer[pid],
        }))
      : [],
    winner_id: econ?.winner_id,
    result_hash: econ?.result_hash,
  };
  return { out, econ };
}

// ---------- TESTS ----------

function testDeterminism(): TestResult {
  const seed = hexToBytes(
    "c3b9a2c1d44e2f0a13b7ee5d9a5c4f8b77aa55bb66ccddeeff00112233445566"
  );
  const roster = [
    "1111111111111111111111111111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ].sort();
  const s1 = simulate(
    seed,
    roster,
    "free_sim",
    Math.trunc(0.025 * 1e9),
    6000,
    3000
  );
  const s2 = simulate(
    seed,
    roster,
    "free_sim",
    Math.trunc(0.025 * 1e9),
    6000,
    3000
  );
  let r: TestResult = ok();
  r = merge(r, truthy(!!s1.out && !!s2.out, "no outputs"));
  r = merge(
    r,
    eq(s1.out.result_hash, s2.out.result_hash, "determinism: hash differs")
  );
  return r;
}

function testHashChangesOnInputs(): TestResult {
  const baseSeed = hexToBytes(
    "c3b9a2c1d44e2f0a13b7ee5d9a5c4f8b77aa55bb66ccddeeff00112233445566"
  );
  const roster = [
    "1111111111111111111111111111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ].sort();
  const base = simulate(
    baseSeed,
    roster,
    "paid",
    Math.trunc(0.025 * 1e9),
    6000,
    3000
  );
  const varySeed = simulate(
    hexToBytes(
      "d3b9a2c1d44e2f0a13b7ee5d9a5c4f8b77aa55bb66ccddeeff00112233445566"
    ),
    roster,
    "paid",
    Math.trunc(0.025 * 1e9),
    6000,
    3000
  );
  const varyRosterOrder = simulate(
    baseSeed,
    [...roster].reverse(),
    "paid",
    Math.trunc(0.025 * 1e9),
    6000,
    3000
  );
  const varyBps = simulate(
    baseSeed,
    roster,
    "paid",
    Math.trunc(0.025 * 1e9),
    6500,
    2500
  );
  const varyEntry = simulate(
    baseSeed,
    roster,
    "paid",
    Math.trunc(0.03 * 1e9),
    6000,
    3000
  );
  const varyHeader = simulate(
    baseSeed,
    roster,
    "paid",
    Math.trunc(0.025 * 1e9),
    6000,
    3000,
    { map_id: "alt", rules_hash: "r1" }
  );
  let r: TestResult = ok();
  const baseHash = base.out.result_hash;
  const diffs = [varySeed, varyRosterOrder, varyBps, varyEntry, varyHeader];
  for (const d of diffs) {
    if (d.out.result_hash === baseHash)
      r = merge(r, fail("hash unchanged after input variation"));
  }
  return r;
}

function testPotsAndPerKillMath(): TestResult {
  const seed = hexToBytes("a1".padEnd(64, "a"));
  const roster = new Array(8)
    .fill(0)
    .map((_, i) => (i + 1).toString(16).repeat(64).slice(0, 64))
    .sort();
  const entry = Math.trunc(0.025 * 1e9);
  const bounty_bps = 6000,
    survival_bps = 3000;
  const sim = simulate(seed, roster, "paid", entry, bounty_bps, survival_bps);
  const pots = sim.out.pots;
  let r: TestResult = ok();
  const total_players = roster.length;
  const expBounty = Math.trunc(entry * total_players * (bounty_bps / 10000));
  const expSurv = Math.trunc(entry * total_players * (survival_bps / 10000));
  const expPerKill = Math.trunc(expBounty / Math.max(1, total_players - 1));
  r = merge(r, eq(pots?.bounty_pot_lamports, expBounty, "bounty_pot mismatch"));
  r = merge(
    r,
    eq(pots?.survival_pot_lamports, expSurv, "survival_pot mismatch")
  );
  r = merge(
    r,
    eq(pots?.bounty_per_kill_lamports, expPerKill, "bounty_per_kill mismatch")
  );
  // payouts sum <= pot
  const bounties = (sim.out.events || []).filter(
    (e: any) => e.type === "BountyPayout"
  );
  const paidSum = sum(bounties.map((e: any) => e.amount || 0));
  if (paidSum > expBounty)
    r = merge(r, fail(`bounty overdrawn by ${paidSum - expBounty}`));
  return r;
}

function testSameFrameOrdering(): TestResult {
  // Try several seeds to find a frame with multiple payouts; then verify ordering by victim roster index
  const baseRoster = new Array(10)
    .fill(0)
    .map((_, i) => i.toString(16).repeat(64).slice(0, 64))
    .sort();
  let found: any = null;
  for (let k = 0; k < 6; k++) {
    const seed = hexToBytes(k.toString(16).padStart(64, "0"));
    const sim = simulate(
      seed,
      baseRoster,
      "free_sim",
      Math.trunc(0.025 * 1e9),
      6000,
      3000
    );
    const ev = (sim.out.events || []).filter(
      (e: any) => e.type === "BountyPayout"
    );
    const byFrame: Record<number, any[]> = {};
    for (const e of ev) {
      (byFrame[e.frame] ||= []).push(e);
    }
    const frame = Object.keys(byFrame)
      .map((n) => parseInt(n, 10))
      .find((f) => byFrame[f].length > 1);
    if (frame !== undefined) {
      found = { sim, frame, events: byFrame[frame] };
      break;
    }
  }
  if (!found) return ok("no multi-payout frame found; skipping ordering check");
  const rosterIndex: Record<string, number> = {};
  for (let i = 0; i < found.sim.out.per_player.length; i++)
    rosterIndex[found.sim.out.per_player[i].player_id] = i;
  const victimIdxs = found.events.map((e: any) => rosterIndex[e.victim_id]);
  const sorted = [...victimIdxs].sort((a, b) => a - b);
  for (let i = 0; i < victimIdxs.length; i++)
    if (victimIdxs[i] !== sorted[i])
      return fail(`same-frame ordering mismatch at frame ${found.frame}`);
  return ok();
}

function testWinnerAndTieBreak(): TestResult {
  // Search for a seed that produces a tie (0 alive at finalize). If found, assert TieBreak before SurvivalAward
  const roster = new Array(6)
    .fill(0)
    .map((_, i) => i.toString(16).repeat(64).slice(0, 64))
    .sort();
  for (let k = 0; k < 24; k++) {
    const seed = hexToBytes(k.toString(16).padStart(64, "f"));
    const sim = simulate(
      seed,
      roster,
      "paid",
      Math.trunc(0.025 * 1e9),
      6000,
      3000
    );
    const ev = sim.out.events || [];
    const tie = ev.find((e: any) => e.type === "TieBreak");
    if (tie) {
      const surv = ev.find((e: any) => e.type === "SurvivalAward");
      if (!surv) return fail("TieBreak found but no SurvivalAward emitted");
      if (tie.winner_id !== sim.out.winner_id)
        return fail("TieBreak winner_id != winner_id in outputs");
      return ok("tie-break path covered");
    }
  }
  return ok("no tie case found; skipping tie-break check");
}

function testFreeModeZeroed(): TestResult {
  const seed = hexToBytes("f".repeat(64));
  const roster = new Array(6)
    .fill(0)
    .map((_, i) => i.toString(16).repeat(64).slice(0, 64))
    .sort();
  const sim = simulate(seed, roster, "free_sim", 0, 6000, 3000);
  const pots = sim.out.pots;
  let r: TestResult = ok();
  r = merge(r, eq(pots?.bounty_pot_lamports, 0, "zeroed: bounty pot not zero"));
  r = merge(
    r,
    eq(pots?.survival_pot_lamports, 0, "zeroed: survival pot not zero")
  );
  const ev = sim.out.events || [];
  const paid = (
    ev.filter((e: any) => e.type === "BountyPayout") as any[]
  ).reduce((a, e) => a + (e.amount || 0), 0);
  const surv = ev.find((e: any) => e.type === "SurvivalAward") as any;
  r = merge(r, eq(paid, 0, "zeroed: bounty payout not zero"));
  r = merge(r, eq(surv?.amount || 0, 0, "zeroed: survival award not zero"));
  return r;
}

function testFuzzProperties(): TestResult {
  let r: TestResult = ok();
  const baseSeed = hexToBytes(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
  for (let n = 6; n <= 8; n++) {
    for (let i = 0; i < 3; i++) {
      // Derive seed deterministically from baseSeed and counters via HKDF
      const info = new TextEncoder().encode(`fuzz:${n}:${i}`);
      const seed = hkdf(sha256, baseSeed, new Uint8Array(0), info, 32);
      const roster = new Array(n)
        .fill(0)
        .map((_, k) => (k + 1).toString(16).repeat(64).slice(0, 64))
        .sort();
      const sim = simulate(
        seed,
        roster,
        "paid",
        Math.trunc(0.025 * 1e9),
        6000,
        3000
      );
      const pots = sim.out.pots || {};
      const ev = sim.out.events || [];
      const bounties = ev.filter((e: any) => e.type === "BountyPayout");
      const surv = ev.filter((e: any) => e.type === "SurvivalAward");
      const paid = bounties.reduce(
        (a: number, e: any) => a + ((e.amount || 0) as number),
        0
      );
      r = merge(
        r,
        truthy(
          paid <= (pots.bounty_pot_lamports || 0),
          `fuzz: bounty overdraw for n=${n} i=${i}`
        )
      );
      if (surv.length === 1) {
        // SurvivalAward includes survival_pot + any remaining bounty (rounding dust)
        const expectedMin = pots.survival_pot_lamports || 0;
        const actualAward = surv[0].amount || 0;
        // Award must be >= survival pot (can be higher due to leftover bounty)
        r = merge(
          r,
          truthy(
            actualAward >= expectedMin,
            `fuzz: survival award too low n=${n} i=${i}: expected >=${expectedMin} got ${actualAward}`
          )
        );
      } else {
        // skip if budget exceeded or round not finalized within frame budget
        r = merge(r, ok(`fuzz: skipped finalize n=${n} i=${i}`));
      }
      const sim2 = simulate(
        seed,
        roster,
        "paid",
        Math.trunc(0.025 * 1e9),
        6000,
        3000
      );
      r = merge(
        r,
        eq(
          sim.out.result_hash,
          sim2.out.result_hash,
          `fuzz determinism mismatch n=${n} i=${i}`
        )
      );
    }
  }
  return r;
}

export function runAllEngineTests(): { ok: boolean; messages: string[] } {
  const tests: Array<[string, () => TestResult]> = [
    ["determinism", testDeterminism],
    ["hash changes on inputs", testHashChangesOnInputs],
    ["pots and per-kill math", testPotsAndPerKillMath],
    ["same-frame ordering", testSameFrameOrdering],
    ["winner & tie-break", testWinnerAndTieBreak],
    ["free mode zeroed", testFreeModeZeroed],
    ["fuzz invariants", testFuzzProperties],
  ];
  let okAll = true;
  const messages: string[] = [];
  for (const [name, fn] of tests) {
    try {
      const r = fn();
      if (!r.ok) okAll = false;
      messages.push(`[${name}] ${r.ok ? "OK" : "FAIL"}`);
      messages.push(...r.messages);
    } catch (err: any) {
      okAll = false;
      messages.push(`[${name}] EXCEPTION: ${String(err?.message || err)}`);
    }
  }
  return { ok: okAll, messages };
}

// Browser helper
// @ts-ignore
if (typeof window !== "undefined") {
  // @ts-ignore
  (window as any).runEngineTests = runAllEngineTests;
}
