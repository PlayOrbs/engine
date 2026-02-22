# @orbs/engine

Deterministic physics and game engine for Orb Battle.

## Quick Start: Verify a Round

Verify any settled round by fetching data from ICP and running the simulation locally:

```bash
bun scripts/verify_round.ts --round 122 --tier 0 --network mainnet
```

Output:
```
🔍 Verifying Round 122 (Tier 0) on mainnet

📋 Roster (sorted by join time):
  1. 61492f46... (joined: 1771661230)
  2. e081a134... (joined: 1771661235)
  3. dfb73a3b... (joined: 1771662535)

⚙️  Running simulation...

✅ Simulation complete at frame 1774

📊 Results:
   On-chain winner:  G4Hxua7oTweCPwtLP9FSPpsaCyGhWDa7PxvtbZ2JPboM
   Simulated winner: G4Hxua7oTweCPwtLP9FSPpsaCyGhWDa7PxvtbZ2JPboM

🎉 VERIFIED: Simulation matches on-chain result!
```

## Overview

This package provides the core simulation engine for Orb Battle, featuring:

- **Deterministic Physics**: Reproducible simulations across all platforms
- **Economics System**: Weighted kill rewards, survival bonuses, and take-profit mechanics
- **PRNG System**: Cryptographically-derived randomness for fair gameplay
- **Trait System**: Unique orb behaviors (aggressive, evasive, heavy, chaotic, precise)
- **Collision Detection**: Efficient orb-orb and boundary collision handling
- **Replay Support**: Full state serialization for game replays

## Installation

```bash
npm install @orbs/engine
```

## Usage

```typescript
import { initFromSeed, advanceFrame } from '@orbs/engine/sim'
import type { EngineConfig, Player } from '@orbs/engine/types'

// Initialize game
const config: EngineConfig = { /* ... */ }
const seed = new Uint8Array(32) // Deterministic seed
const players: Player[] = [ /* ... */ ]

const state = initFromSeed(config, seed, players)

// Run simulation
for (let i = 0; i < 1000; i++) {
  advanceFrame(state, config)
}
```

## Exports

- `sim` - Core simulation functions (initFromSeed, advanceFrame, replay)
- `types` - TypeScript types (EngineState, EngineConfig, Player, Orb, etc.)
- `physics` - Physics step function
- `scoring` - Economics and scoring logic
- `rng` - PRNG utilities
- `seeds` - Seed generation utilities
- `tethers` - Boundary tether mechanics
- `determinism` - Deterministic math functions
- `transcript` - Input ordering and hashing
- `utils` - Utility functions (toHex, hexToBytes, clamp, etc.)

## Key Features

### Deterministic Simulation

All physics calculations use deterministic math functions to ensure identical results across platforms:

```typescript
import { detSin, detCos } from '@orbs/engine/determinism'
```

### Economics System

Supports multiple economy models:
- `weighted_kill_v2_inherit` - Weighted kills with bounty inheritance
- `weighted_kill_v2` - Weighted kills without inheritance
- `fixed_total_v0` - Fixed total prize pool
- `log_scaled_kill_v1` - Logarithmically scaled rewards

### Take Profit (TP) System

Players can set take-profit targets to cash out earnings:

```typescript
import { applyTPPresetsToTargets, buildTpPresetsLamports } from '@orbs/engine/scoring'
```

### Trait System

Each orb has unique behavioral traits affecting:
- Restitution (bounce behavior)
- Tangent kick (collision response)
- Minimum speed
- Jitter amount
- Gravity multiplier

### Skill Multipliers

Per-orb skill multipliers influence gameplay without guaranteeing outcomes:

- **tetherResMul**: Offensive stat. Higher values lower the speed threshold required to break enemy tethers.
- **powerMul**: Speed cap multiplier. Higher values allow faster maximum orb velocity.
- **splitAggroMul**: Self-tradeoff stat. Higher values lower your split thresholds (easier to split), but child orbs receive reduced tetherResMul.

All multipliers default to 1.0 (neutral) and are inherited by child orbs on split.

## Skill & Determinism

The physics simulation is fully deterministic:

- **Reproducible outcomes**: Given the same seed, player configuration, and engine config, the simulation produces identical results across all platforms and executions.
- **No hidden randomness**: All randomness derives from the cryptographic seed via explicit PRNG usage. No `Math.random()`, `Date.now()`, or environment-dependent values are used.
- **Stat influence, not guarantees**: Player skill multipliers influence gameplay dynamics but do not guarantee victory in isolation. Outcomes depend on the complex interaction of all players, positions, and physics.
- **Validation**: Engine behavior has been validated via large-scale Monte Carlo simulation to confirm that no single stat configuration provides a dominant advantage.

Frame evolution depends solely on:
1. Round seed (cryptographic)
2. Player inputs (signed actions)
3. Engine configuration (static per round)

## Simulation Tools

### Verification Compatibility

> **ℹ️ The verifier supports rounds with config version 3.0.0+** (V2 engine). Older rounds (config < 3.0.0) used the V1 engine and cannot be verified with this script.
>
> - **Mainnet**: Rounds ~130+ (config 3.0.0+)
> - **Devnet**: Rounds ~940+ (config 3.0.0+)


### Round Verification (`scripts/verify_round.ts`)

Verify any settled round by fetching data from ICP and running the deterministic simulation locally.

```bash
# Verify a mainnet round
bun scripts/verify_round.ts --round 131 --tier 0 --network mainnet

# Verify a devnet round
bun scripts/verify_round.ts --round 950 --tier 0 --network devnet

# Verbose output (show frame progress)
bun scripts/verify_round.ts --round 131 --tier 0 --network mainnet --verbose
```

**What it does:**
1. Fetches round seed from ICP canister
2. Fetches player configs (spawn positions, skill allocations)
3. Fetches engine config version used for that round
4. Runs the deterministic simulation
5. Compares simulated winner with on-chain result

**Options:**
- `--round <id>` - Round ID to verify (required)
- `--tier <id>` - Tier ID (default: 0)
- `--network <net>` - Network: `mainnet` or `devnet` (default: mainnet)
- `--verbose` - Show detailed simulation progress

### Win Rate Simulation (`scripts/sim_skill_winrate.ts`)

A Monte Carlo simulation tool for validating skill multiplier balance. **Not wired into CI** - intended as a reference and analysis tool.

```bash
# Basic run (500 trials, 8 players)
bun scripts/sim_skill_winrate.ts --trials 500 --players 8

# Isolated stat testing
bun scripts/sim_skill_winrate.ts --trials 1000 --only-tether --exaggerated
bun scripts/sim_skill_winrate.ts --trials 1000 --only-split --exaggerated
bun scripts/sim_skill_winrate.ts --trials 1000 --only-power --exaggerated

# Grid search for splitAggroMul tuning
bun scripts/sim_skill_winrate.ts --grid --trials 200 --players 6
```

**What it demonstrates:**
- Win rate distribution between high-skill and baseline players
- Statistical significance via chi-square test
- Average splits per trial (for splitAggroMul analysis)
- Parameter sweep for finding neutral configurations

## Testing

```bash
npm test          # Run tests in watch mode
npm run test:run  # Run tests once
```

## Architecture

The engine is designed to be:
- **Pure**: No side effects, same inputs → same outputs
- **Deterministic**: Reproducible across all platforms
- **Efficient**: Optimized for 120 FPS simulation
- **Testable**: Comprehensive test coverage

## License

MIT
