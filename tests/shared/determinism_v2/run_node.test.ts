// ─── V2 Determinism Node Test ───
//
// Runs 3 scenarios × 200k frames each.
// Asserts invariants every frame, computes golden hash at end.
// Run with: pnpm vitest run engine/tests/determinism_v2/run_node.test.ts

import { describe, it, expect } from 'vitest'
import { initFromSeedV2, advanceFrameV2 } from '../../../src/core/v2/sim_v2.js'
import { hashStateV2, assertInvariants } from './hash_state.js'
import { scenarios } from './scenarios.js'
import type { GameConfig } from '../../../src/config/gameConfig.js'

describe('V2 Cross-Runtime Determinism (Node)', () => {
  for (const scenario of scenarios) {
    it(`${scenario.name}: ${scenario.frames} frames`, () => {
      const { state, cfg } = initFromSeedV2(
        scenario.seed,
        scenario.players,
        scenario.config,
      )

      const invariantInterval = 1000
      const logInterval = 10_000
      const t0 = Date.now()

      for (let f = 0; f < scenario.frames; f++) {
        advanceFrameV2(state, cfg)

        if ((f + 1) % invariantInterval === 0) {
          assertInvariants(state)
        }
        if ((f + 1) % logInterval === 0) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
          console.log(`  [${scenario.name}] ${f + 1}/${scenario.frames} frames (${elapsed}s, ${state.orbs.length} orbs)`)
        }
      }

      assertInvariants(state)
      const totalSec = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  [${scenario.name}] done in ${totalSec}s`)

      const finalHash = hashStateV2(state)
      console.log(`[${scenario.name}] frames=${state.frame} orbs=${state.orbs.length} hash=${finalHash}`)

      if (scenario.goldenHash === '') {
        // First run: print hash for committing
        console.log(`  → GOLDEN HASH (commit this): '${finalHash}'`)
      } else {
        if (finalHash !== scenario.goldenHash) {
          // Diff-friendly failure
          console.error(`  MISMATCH!`)
          console.error(`    expected: ${scenario.goldenHash}`)
          console.error(`    got:      ${finalHash}`)
          console.error(`    frame:    ${state.frame}`)
          console.error(`    orbs:     ${state.orbs.length}`)
          for (let i = 0; i < Math.min(state.orbs.length, 5); i++) {
            const o = state.orbs[i]
            console.error(`    orb[${i}]: x=${o.x} y=${o.y} vx=${o.vx} vy=${o.vy}`)
          }
        }
        expect(finalHash).toBe(scenario.goldenHash)
      }
    }, 600_000) // 10 minute timeout per scenario
  }
})
