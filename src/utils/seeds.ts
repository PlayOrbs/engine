import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha256Concat } from "./rng.js";
import { Player } from "../core/v1/types.js";
import { tag } from "./utils.js";

const HKDF_SALT = tag("orbs-hkdf-v1");

export const perOrbSeed = (roundSeed: Uint8Array, player: Player): Uint8Array =>
  sha256Concat(tag("orbs-per-orb"), roundSeed, player.pubkey, player.joinNonce);

/**
 * Derive a deterministic join nonce for a player at a given index.
 * 
 * This is the canonical way to generate join nonces for real players.
 * Uses HKDF to derive from the round seed with format: 'join_nonce:{index}'
 * 
 * Critical for determinism: same seed + index → same nonce
 * 
 * @param roundSeed - The round's cryptographic seed (32 bytes)
 * @param playerIndex - The player's index in the roster (0-based)
 * @returns 32-byte join nonce
 */
export function deriveJoinNonce(roundSeed: Uint8Array, playerIndex: number): Uint8Array {
  const info = new TextEncoder().encode(`join_nonce:${playerIndex}`);
  return hkdf(sha256, roundSeed, new Uint8Array(0), info, 32);
}

/**
 * Build a Player object from a pubkey and roster index.
 * Derives the join nonce deterministically.
 * 
 * @param pubkey - Player's public key (32 bytes)
 * @param roundSeed - Round seed for nonce derivation
 * @param playerIndex - Player's index in the roster
 * @param color - Optional orb color
 * @returns Player object with derived join nonce
 */
export function buildPlayer(
  pubkey: Uint8Array,
  roundSeed: Uint8Array,
  playerIndex: number,
  color?: string
): Player {
  return {
    pubkey,
    joinNonce: deriveJoinNonce(roundSeed, playerIndex),
    color,
  };
}

export function synthesizeBotPlayers(roundSeed: Uint8Array, count: number, colors: string[]): Player[] {
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const infoPub = tag(`bot_pubkey:${i}`);
    const infoNnc = tag(`bot_nonce:${i}`);
    const pubkey = hkdf(sha256, roundSeed, HKDF_SALT, infoPub, 32);
    const joinNonce = hkdf(sha256, roundSeed, HKDF_SALT, infoNnc, 32);
    out.push({ pubkey, joinNonce, color: colors[i % colors.length] });
  }
  return out;
}
