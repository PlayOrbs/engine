import { initFromSeed, synthesizePlayers, advanceFrame, replay, perOrbSeed } from './src/core/v1/sim.js'
import { processTethers } from './src/core/v1/tethers.js'
import { EngineConfig } from './src/core/v1/types.js'

const te = new TextEncoder()

function makeCfg(): EngineConfig {
  return {
    canvas: { width: 480, height: 720 },
    boundary: { radius: 200, restitution: 0.95, tangentImpulse: 0.1, minSpeed: 0.05 },
    burst: { lineWidth: 1 },
    orbs: { radius: 12 },
  }
}

describe('engine/sim', () => {
  function viewOrbs(orbs: any[]) {
    return orbs.map(o => ({ x:o.x, y:o.y, vx:o.vx, vy:o.vy, color:o.color, owner: o.owner, radius:o.radius, gen:o.gen, splitCooldown:o.splitCooldown, trait:o.trait?.name }))
  }
  function ownerShortKey(state:any, idx:number): string {
    const arr: number[] = Array.from(state.orbs[idx].owner || [])
    return arr.map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,8)
  }

  test('initFromSeed is deterministic for same seed and players', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-1')
    const colors = ['#a', '#b', '#c']
    const players = synthesizePlayers(roundSeed, 3, colors)

    const { state: s1 } = initFromSeed(roundSeed, players, cfg)
    const { state: s2 } = initFromSeed(roundSeed, players, cfg)

    expect(viewOrbs(s1.orbs)).toEqual(viewOrbs(s2.orbs))
    expect(s1.tethers).toEqual(s2.tethers)
    expect(s1.frame).toBe(0)
    expect(s2.frame).toBe(0)
  })

  test('advanceFrame increments frame and spawns a tether on boundary hit', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-boundary')
    const colors = ['#ff00ff']
    const players = synthesizePlayers(roundSeed, 1, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    // Place orb near boundary and give outward velocity to force a boundary hit
    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const R = cfg.boundary.radius
    const r = cfg.orbs.radius

    state.orbs[0].x = cx + (R - r - 0.5)
    state.orbs[0].y = cy
    state.orbs[0].vx = 2
    state.orbs[0].vy = 0
    state.orbs[0].justCollided = false
    state.orbs[0].hadTether = false
    state.tethers[0] = []

    const st1 = advanceFrame(state, cfg, prngs)

    expect(st1.frame).toBe(1)
    expect(st1.tethers[0].length).toBe(1)
    // protect flag gets cleared at end of processTethers()
    expect(st1.tethers[0][0].protect).toBe(0)
    // hadTether should be true after boundary hit
    expect(st1.orbs[0].hadTether).toBe(true)
  })

  test('prunes orbs that had a tether but now have none', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-prune')
    const colors = ['#1', '#2']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Prevent new boundary hits by keeping orbs at center and stationary
    for (let i = 0; i < state.orbs.length; i++) {
      state.orbs[i].x = cx
      state.orbs[i].y = cy
      state.orbs[i].vx = 0
      state.orbs[i].vy = 0
      state.tethers[i] = []
    }

    // Mark orb 0 as having had a tether previously but currently none
    state.orbs[0].hadTether = true

    const st1 = advanceFrame(state, cfg, prngs)

    // Orb 0 should be pruned
    expect(st1.orbs.length).toBe(1)
    expect(st1.tethers.length).toBe(1)
  })

  test('scoring increments framesAlive per frame for each orb', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-score')
    const colors = ['#1', '#2']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Keep orbs away from boundary to avoid tether events and pruning
    for (let i = 0; i < state.orbs.length; i++) {
      state.orbs[i].x = cx
      state.orbs[i].y = cy
      state.orbs[i].vx = 0
      state.orbs[i].vy = 0
    }

    const st1 = advanceFrame(state, cfg, prngs)
    const st2 = advanceFrame(st1, cfg, prngs)

    expect(st2.frame).toBe(2)
    const k0 = ownerShortKey(st2, 0)
    const k1 = ownerShortKey(st2, 1)
    expect(st2.scores[k0].framesAlive).toBe(2)
    expect(st2.scores[k1].framesAlive).toBe(2)
  })

  test('tether is deleted when a non-owner orb crosses the segment', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-cross')
    const colors = ['#a', '#b']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner orb (0) at center, stationary
    state.orbs[0].x = cx
    state.orbs[0].y = cy
    state.orbs[0].vx = 0
    state.orbs[0].vy = 0
    state.orbs[0].hadTether = true

    // Other orb (1) placed on the tether segment midpoint to ensure crossing
    // Segment: anchor (-100, 0) -> owner (0, 0) in canvas-centered coords
    // Place orb1 at (-50, 0) relative to center; far enough to avoid orb-orb overlap
    state.orbs[1].x = cx - 50
    state.orbs[1].y = cy
    state.orbs[1].vx = 0
    state.orbs[1].vy = 0

    // Two tethers for owner 0: one horizontal (to be cut), one vertical (to remain)
    state.tethers[0] = [
      { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 0 },
      { anchorX: cx, anchorY: cy - 100, color: '#a', protect: 0 },
    ]

    const st1 = advanceFrame(state, cfg, prngs)

    // One tether should be removed due to crossing; the vertical one should remain
    expect(st1.tethers[0].length).toBe(1)
    expect(st1.tethers[0][0].anchorX).toBe(cx)
    expect(st1.tethers[0][0].anchorY).toBe(cy - 100)
  })

  test('owner does not delete its own tether near endpoint (segT>0.95)', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-self-immunity')
    const colors = ['#a']
    const players = synthesizePlayers(roundSeed, 1, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Single owner orb at center, stationary
    state.orbs[0].x = cx
    state.orbs[0].y = cy
    state.orbs[0].vx = 0
    state.orbs[0].vy = 0
    state.orbs[0].hadTether = true

    // Tether segment ends at owner position, so for the owner's own point, segT ~ 1 (>0.95)
    state.tethers[0] = [
      { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 0 },
    ]

    const st1 = advanceFrame(state, cfg, prngs)
    expect(st1.tethers[0].length).toBe(1)
    expect(st1.tethers[0][0].anchorX).toBe(cx - 100)
    expect(st1.tethers[0][0].anchorY).toBe(cy)
  })

  test('overlapping orbs are separated to at least 2*radius after one frame', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-overlap')
    const colors = ['#1', '#2']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const minDist = 2 * cfg.orbs.radius

    // Force both orbs to exactly the same position with zero velocity
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0
    state.orbs[1].x = cx; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0

    const st1 = advanceFrame(state, cfg, prngs)
    const dx = st1.orbs[1].x - st1.orbs[0].x
    const dy = st1.orbs[1].y - st1.orbs[0].y
    const d = Math.hypot(dx, dy)
    const EPS = 1e-3
    expect(d).toBeGreaterThanOrEqual(minDist - EPS)
  })

  test('boundary bounce reflects normal and applies tangent impulse', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-bounce')
    const colors = ['#f0f']
    const players = synthesizePlayers(roundSeed, 1, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const R = cfg.boundary.radius
    const r = cfg.orbs.radius

    // Disable boundary jitter for determinism
    prngs.delete('bounce:0')

    // Place orb near right boundary moving outward to trigger a hit
    state.orbs[0].x = cx + (R - r - 0.1)
    state.orbs[0].y = cy
    state.orbs[0].vx = 2
    state.orbs[0].vy = 0
    state.orbs[0].justCollided = false

    const preNormal = 2 // along +x
    const preTangent = 0 // along +y

    const st1 = advanceFrame(state, cfg, prngs)

    // Compute local frame at post-collision position
    const dx = st1.orbs[0].x - cx
    const dy = st1.orbs[0].y - cy
    const dist = Math.hypot(dx, dy) || 1
    const nx = dx / dist
    const ny = dy / dist
    const tx = -ny
    const ty = nx

    const postNormal = st1.orbs[0].vx * nx + st1.orbs[0].vy * ny
    const postTangent = st1.orbs[0].vx * tx + st1.orbs[0].vy * ty

    // Normal component should flip inward
    expect(postNormal).toBeLessThanOrEqual(0)

    // Tangent should increase by approx tangentImpulse
    expect(postTangent).toBeGreaterThanOrEqual(preTangent + cfg.boundary.tangentImpulse - 0.02)

    // Normal magnitude should be roughly restitution * preNormal
    expect(Math.abs(postNormal)).toBeGreaterThanOrEqual(Math.abs(preNormal) * cfg.boundary.restitution - 0.05)
  })

  test('two different orbs can cut two separate tethers of same owner in one frame', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-multi-cross')
    const colors = ['#a', '#b', '#c']
    const players = synthesizePlayers(roundSeed, 3, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Place owner (0) at center, stationary; set hadTether=false to avoid prune when list empties
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0; state.orbs[0].hadTether = false

    // Orb 1 crosses horizontal segment; Orb 2 crosses vertical segment
    state.orbs[1].x = cx - 50; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0
    state.orbs[2].x = cx; state.orbs[2].y = cy - 50; state.orbs[2].vx = 0; state.orbs[2].vy = 0

    state.tethers[0] = [
      { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 0 },
      { anchorX: cx, anchorY: cy - 100, color: '#a', protect: 0 },
    ]

    const st1 = advanceFrame(state, cfg, prngs)

    // Both tethers should be deleted; owner remains because hadTether was false
    expect(st1.tethers[0].length).toBe(0)
    // Ensure owner orb still exists (not pruned)
    expect(st1.orbs.length).toBe(3)
  })

  test('tether protect flag clears after one frame', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-protect-clear')
    const colors = ['#a']
    const players = synthesizePlayers(roundSeed, 1, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner orb at center; pre-create a tether with protect=1
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0
    state.tethers[0] = [ { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 1 } ]

    const st1 = advanceFrame(state, cfg, prngs)
    expect(st1.tethers[0].length).toBe(1)
    expect(st1.tethers[0][0].protect).toBe(0)
  })

  test('scoring increments when a tether is destroyed (owner score +1)', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-score-destroy')
    const colors = ['#a', '#b']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner (0) with a tether; other orb (1) placed to cut it
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0; state.orbs[0].hadTether = true
    state.orbs[1].x = cx - 50; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0
    state.tethers[0] = [ { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 0 } ]

    // Precompute ownerShort for player 0 before prune
    const k0 = Buffer.from(players[0].pubkey).toString('hex').slice(0,8)
    const st1 = advanceFrame(state, cfg, prngs)
    const s0 = st1.scores[k0]
    expect(s0).toBeDefined()
    expect(s0.tethersDestroyed).toBeGreaterThanOrEqual(1)
    expect(s0.score).toBeGreaterThanOrEqual(1)
  })

  test('prunes only orbs that hadTether=true and now have zero tethers', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-prune-condition')
    const colors = ['#A', '#B']
    const players = synthesizePlayers(roundSeed, 2, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Keep both stationary at center to avoid spawning new tethers
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0
    state.orbs[1].x = cx; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0

    // No tethers for either
    state.tethers[0] = []
    state.tethers[1] = []

    // Mark orb 0 as previously tethered, orb 1 as never tethered
    state.orbs[0].hadTether = true
    state.orbs[1].hadTether = false

    const st1 = advanceFrame(state, cfg, prngs)

    // Only orb 0 should be pruned; orb 1 should remain
    expect(st1.orbs.length).toBe(1)
    expect(st1.tethers.length).toBe(1)
    expect(st1.orbs[0].color).toBe(players[1].color)
  })

  test('boundary tether anchor lies on circle and color/hadTether correct', () => {
    const cfg = makeCfg()
    const roundSeed = te.encode('seed-anchor')
    const colors = ['#abc']
    const players = synthesizePlayers(roundSeed, 1, colors)
    const { state, prngs } = initFromSeed(roundSeed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const R = cfg.boundary.radius
    const r = cfg.orbs.radius

    // Disable jitter for determinism
    prngs.delete('bounce:0')

    // Place just inside boundary moving outward to trigger a hit
    state.orbs[0].x = cx + (R - r - 0.1)
    state.orbs[0].y = cy
    state.orbs[0].vx = 2
    state.orbs[0].vy = 0
    state.tethers[0] = []

    const st1 = advanceFrame(state, cfg, prngs)

    expect(st1.tethers[0].length).toBe(1)
    const t0 = st1.tethers[0][0]
    const distAnchor = Math.hypot(t0.anchorX - cx, t0.anchorY - cy)
    const EPS = 1e-3
    expect(Math.abs(distAnchor - R)).toBeLessThan(EPS)
    expect(t0.color).toBe(st1.orbs[0].color)
    expect(st1.orbs[0].hadTether).toBe(true)
  })

  test('replay(maxFrames) parity with advanceFrame over same frames (state core parity)', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-replay-parity')
    const players = synthesizePlayers(seed, 3, ['#1','#2','#3'])
    const frames = 5

    // Advance via orchestrator
    const { state: s1, prngs } = initFromSeed(seed, players, cfg)
    for (let i = 0; i < frames; i++) {
      advanceFrame(s1, cfg, prngs)
    }

    // Replay path via exported ESM function
    const { state: s2 } = replay(seed, players, [], frames, cfg)

    // Compare orbs and tethers arrays shallowly (scores may differ)
    expect(JSON.stringify({ f:s1.frame, orbs:s1.orbs, tethers:s1.tethers })).toBe(
      JSON.stringify({ f:s2.frame, orbs:s2.orbs, tethers:s2.tethers })
    )
  })

  test('minSpeed tangential boost applied when velocity below threshold', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-minspeed')
    const players = synthesizePlayers(seed, 1, ['#x'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Place slightly off-center so tangent is well-defined
    state.orbs[0].x = cx + 10
    state.orbs[0].y = cy
    state.orbs[0].vx = 0
    state.orbs[0].vy = 0

    const st1 = advanceFrame(state, cfg, prngs)
    const speed = Math.hypot(st1.orbs[0].vx, st1.orbs[0].vy)
    const traitMul = (st1.orbs[0] as any).trait?.minSpeedMul ?? 1
    const expected = cfg.boundary.minSpeed * traitMul
    expect(speed).toBeGreaterThanOrEqual(expected - 1e-6)
  })

  test('protect window prevents same-frame deletion; deletes on next frame', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-protect-window')
    const players = synthesizePlayers(seed, 2, ['#o','#x'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner at center with protect=1 tether; other orb on crossing point
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0
    state.orbs[1].x = cx - 50; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0
    state.tethers[0] = [{ anchorX: cx - 100, anchorY: cy, color: '#o', protect: 1 }]

    const st1 = advanceFrame(state, cfg, prngs)
    // Not deleted due to protect window; protect cleared to 0
    expect(st1.tethers[0].length).toBe(1)
    expect(st1.tethers[0][0].protect).toBe(0)

    const st2 = advanceFrame(st1, cfg, prngs)
    // Now deletion occurs on next frame
    expect(st2.tethers[0].length).toBe(0)
  })

  test('gravity induces inward radial velocity component (with minSpeed disabled)', () => {
    const cfg0 = makeCfg()
    const cfg = { ...cfg0, boundary: { ...cfg0.boundary, minSpeed: 0 } }
    const seed = te.encode('seed-gravity')
    const players = synthesizePlayers(seed, 1, ['#g'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    state.orbs[0].x = cx + 10
    state.orbs[0].y = cy
    state.orbs[0].vx = 0
    state.orbs[0].vy = 0

    const st1 = advanceFrame(state, cfg, prngs)
    const dx = st1.orbs[0].x - cx
    const dy = st1.orbs[0].y - cy
    const dist = Math.hypot(dx, dy) || 1
    const nx = dx / dist
    const ny = dy / dist
    const radial = st1.orbs[0].vx * nx + st1.orbs[0].vy * ny
    expect(radial).toBeLessThan(0)
  })

  test('no double tether spawn across consecutive frames for one bounce', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-no-double')
    const players = synthesizePlayers(seed, 1, ['#z'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const R = cfg.boundary.radius
    const r = cfg.orbs.radius

    // Disable jitter for determinism
    prngs.delete('bounce:0')

    // Place near boundary moving outward
    state.orbs[0].x = cx + (R - r - 0.1)
    state.orbs[0].y = cy
    state.orbs[0].vx = 2
    state.orbs[0].vy = 0
    state.tethers[0] = []

    const st1 = advanceFrame(state, cfg, prngs)
    const st2 = advanceFrame(st1, cfg, prngs)

    expect(st2.tethers[0].length).toBe(1)
  })

  test('synthesizePlayers derives deterministic color from pubkey', () => {
    const seed = te.encode('seed-colors')
    const players = synthesizePlayers(seed, 5, [])
    // Each player gets a unique HSL color derived from their pubkey
    for (const p of players) {
      expect(p.color).toMatch(/^hsl\(\d+, 70%, 60%\)$/)
    }
    // Same seed → same colors (deterministic)
    const players2 = synthesizePlayers(seed, 5, [])
    expect(players.map(p => p.color)).toEqual(players2.map(p => p.color))
    // Different players get different colors (high probability with 360 hues)
    const uniqueColors = new Set(players.map(p => p.color))
    expect(uniqueColors.size).toBeGreaterThan(1)
  })

  test('perOrbSeed is deterministic per player and unique across players', () => {
    const seed = te.encode('seed-perorb')
    const players = synthesizePlayers(seed, 3, ['#1'])
    const a1 = perOrbSeed(seed, players[0])
    const a2 = perOrbSeed(seed, players[0])
    const b = perOrbSeed(seed, players[1])
    const c = perOrbSeed(seed, players[2])
    expect(Buffer.from(a1).toString('hex')).toBe(Buffer.from(a2).toString('hex'))
    expect(Buffer.from(a1).toString('hex')).not.toBe(Buffer.from(b).toString('hex'))
    expect(Buffer.from(a1).toString('hex')).not.toBe(Buffer.from(c).toString('hex'))
  })

  test('justCollided is set on bounce then resets next frame', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-justcollide')
    const players = synthesizePlayers(seed, 1, ['#j'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2
    const R = cfg.boundary.radius
    const r = cfg.orbs.radius

    // Disable jitter for determinism
    prngs.delete('bounce:0')

    state.orbs[0].x = cx + (R - r - 0.1)
    state.orbs[0].y = cy
    state.orbs[0].vx = 2
    state.orbs[0].vy = 0
    state.orbs[0].justCollided = false
    state.tethers[0] = []

    const st1 = advanceFrame(state, cfg, prngs)
    expect(st1.orbs[0].justCollided).toBe(true)

    const st2 = advanceFrame(st1, cfg, prngs)
    expect(st2.orbs[0].justCollided).toBe(false)
  })

  test('replay early-stops when only a single orb exists', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-replay-single')
    const players = synthesizePlayers(seed, 1, ['#s'])
    const frames = 10
    const { state } = replay(seed, players, [], frames, cfg)
    // Since there is only one orb, while loop never runs
    expect(state.frame).toBe(0)
    expect(state.orbs.length).toBe(1)
  })

  test('scoring increments by 2 when two tethers are destroyed in one frame', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-score-2')
    const players = synthesizePlayers(seed, 3, ['#a','#b','#c'])
    const { state, prngs } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner at center with two tethers; two other orbs placed to cut both
    state.orbs[0].x = cx; state.orbs[0].y = cy; state.orbs[0].vx = 0; state.orbs[0].vy = 0; state.orbs[0].hadTether = true
    state.orbs[1].x = cx - 50; state.orbs[1].y = cy; state.orbs[1].vx = 0; state.orbs[1].vy = 0
    state.orbs[2].x = cx; state.orbs[2].y = cy - 50; state.orbs[2].vx = 0; state.orbs[2].vy = 0
    state.tethers[0] = [
      { anchorX: cx - 100, anchorY: cy, color: '#a', protect: 0 },
      { anchorX: cx, anchorY: cy - 100, color: '#a', protect: 0 },
    ]

    // Precompute ownerShort for player 0 before prune
    const k0 = Buffer.from(players[0].pubkey).toString('hex').slice(0,8)
    const st1 = advanceFrame(state, cfg, prngs)
    const s0 = st1.scores[k0]
    expect(s0.tethersDestroyed).toBeGreaterThanOrEqual(2)
    expect(s0.score).toBeGreaterThanOrEqual(2)
  })

  test('advanceFrame returns the same state reference (in-place mutation)', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-same-ref')
    const players = synthesizePlayers(seed, 1, ['#r'])
    const { state, prngs } = initFromSeed(seed, players, cfg)
    const ret = advanceFrame(state, cfg, prngs)
    expect(ret).toBe(state)
  })

  test('processTethers returns no events when there are no deletions', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-no-events')
    const players = synthesizePlayers(seed, 2, ['#1','#2'])
    const { state } = initFromSeed(seed, players, cfg)

    // No tethers and orbs far from any anchors
    state.tethers.forEach((_, i) => state.tethers[i] = [])
    const ev = processTethers(state, cfg)
    expect(ev.length).toBe(0)
  })

  test('processTethers events carry correct owner for deletions', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-ev-owner')
    const players = synthesizePlayers(seed, 2, ['#o','#x'])
    const { state } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Owner 0 with one tether; orb 1 on the segment
    state.orbs[0].x = cx; state.orbs[0].y = cy
    state.orbs[1].x = cx - 50; state.orbs[1].y = cy
    state.tethers[0] = [{ anchorX: cx - 100, anchorY: cy, color: '#o', protect: 0 }]

    const ev = processTethers(state, cfg)
    expect(ev.length).toBe(1)
    expect(ev[0].type).toBe('tether_destroyed')
    expect(ev[0].owner).toBe(0)
  })

  test('no deletion when orb is beyond anchor (segT < 0)', () => {
    const cfg = makeCfg()
    const seed = te.encode('seed-segT-neg')
    const players = synthesizePlayers(seed, 2, ['#o','#x'])
    const { state } = initFromSeed(seed, players, cfg)

    const cx = cfg.canvas.width / 2
    const cy = cfg.canvas.height / 2

    // Segment: anchor at (cx-100, cy) to owner at (cx, cy)
    // Place orb 1 further left at (cx-200, cy) so projection outside segment (segT<0)
    state.orbs[0].x = cx; state.orbs[0].y = cy
    state.orbs[1].x = cx - 200; state.orbs[1].y = cy
    state.tethers[0] = [{ anchorX: cx - 100, anchorY: cy, color: '#o', protect: 0 }]

    const ev = processTethers(state, cfg)
    expect(ev.length).toBe(0)
    expect(state.tethers[0].length).toBe(1)
  })

  test('synthesizePlayers pubkey/joinNonce are 32 bytes and differ', () => {
    const seed = te.encode('seed-keys')
    const players = synthesizePlayers(seed, 2, ['#a','#b'])
    expect(players[0].pubkey.length).toBe(32)
    expect(players[0].joinNonce.length).toBe(32)
    expect(Buffer.from(players[0].pubkey).toString('hex')).not.toBe(Buffer.from(players[1].pubkey).toString('hex'))
    expect(Buffer.from(players[0].joinNonce).toString('hex')).not.toBe(Buffer.from(players[1].joinNonce).toString('hex'))
  })
})
