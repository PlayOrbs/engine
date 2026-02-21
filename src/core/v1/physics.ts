import { EngineState, EngineConfig } from './types.js'
import { makePRNG } from '../../utils/rng.js'
import { dramaMultipliers } from './drama.js'
import { detSin, detCos } from './determinism.js'

export function stepFrame(state: EngineState, cfg: EngineConfig, prngs: Map<string, ReturnType<typeof makePRNG>>): { state: EngineState, events: any[] } {
  const cx = cfg.canvas.width / 2
  const cy = cfg.canvas.height / 2
  const dm = dramaMultipliers(state.frame, cfg.drama)
  const baseRadius = cfg.boundary.radius
  const shape = cfg.boundary.shape || 'circle'
  const R = baseRadius * dm.shrink
  const RX = (cfg.boundary.rectHalfWidth ?? baseRadius) * dm.shrink
  const RY = (cfg.boundary.rectHalfHeight ?? baseRadius) * dm.shrink
  const rDefault = cfg.orbs.radius
  const outEvents: any[] = []
  const pendingSplitMap = new Map<number, { idx:number; nx:number; ny:number }>()

  // Sudden death parameters (deterministic)
  let gCenterX = cx, gCenterY = cy
  let suddenDeathMul = 1
  let suddenDeathActive = false
  let orbAttraction = 0
  const suddenDeathMaxOrbs = cfg.suddenDeath?.maxOrbs ?? 2
  // Start sudden death
  if (cfg.suddenDeath?.enabled && state.orbs.length <= suddenDeathMaxOrbs && state.twoOrbsStartFrame !== undefined) {
    const after = Math.max(0, cfg.suddenDeath.afterFrames ?? 0)
    const elapsed = state.frame - (state.twoOrbsStartFrame ?? state.frame)
    if (elapsed >= after) {
      // Sudden death stays active until end of round once triggered
      suddenDeathActive = true
      const targetMul = Math.max(1, cfg.suddenDeath.gravityMultiplier ?? 1)
      const rampFrames = Math.max(0, (cfg.suddenDeath as any).rampFrames ?? 0)
      if (rampFrames > 0) {
        // Smooth ramp from 1x to targetMul over rampFrames
        const rampElapsed = elapsed - after
        const t = Math.min(1, rampElapsed / rampFrames)
        suddenDeathMul = 1 + (targetMul - 1) * t
      } else {
        suddenDeathMul = targetMul
      }
      orbAttraction = cfg.suddenDeath.orbAttraction ?? 0
      const rad = Math.max(0, cfg.suddenDeath.centerShiftRadius ?? 0)
      if (rad > 0) {
        const period = Math.max(1, cfg.suddenDeath.centerShiftPeriodFrames ?? 120)
        // Derive deterministic starting angle from seed_hex (first 4 hex chars = 2 bytes)
        const seedHex = state.econ?.header?.seed_hex
        if (!seedHex || seedHex.length < 4) {
          throw new Error('seed_hex required for sudden death center shift')
        }
        const seedVal = parseInt(seedHex.slice(0, 4), 16)
        const seedOffset = (seedVal / 65536) * 2 * Math.PI
        const t = (elapsed - after) / period
        const ang = seedOffset + 2 * Math.PI * t
        gCenterX = cx + rad * detCos(ang)
        gCenterY = cy + rad * detSin(ang)
      }
    }
  }
  
  // Apply orb-to-orb attraction during sudden death (deterministic)
  if (suddenDeathActive && orbAttraction > 0 && state.orbs.length === 2) {
    const a = state.orbs[0]
    const b = state.orbs[1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const nx = dx / dist
    const ny = dy / dist
    // Apply attraction force (pulls orbs toward each other)
    a.vx += nx * orbAttraction
    a.vy += ny * orbAttraction
    b.vx -= nx * orbAttraction
    b.vy -= ny * orbAttraction
  }

  for (let index = 0; index < state.orbs.length; index++) {
    const o = state.orbs[index]
    o.x += o.vx
    o.y += o.vy
    const dx = o.x - cx
    const dy = o.y - cy
    const dist = Math.hypot(dx, dy) || 1
    const ro = (o as any).radius ?? rDefault
    if (shape === 'circle') {
      if (dist >= R - ro) {
        const nx = dx / dist
        const ny = dy / dist
        const target = R - ro
        o.x = cx + nx * target
        o.y = cy + ny * target
        if (!o.justCollided) {
          outEvents.push({ type: 'boundary_hit', orbIndex: index, anchorX: cx + nx * R, anchorY: cy + ny * R })
          o.hadTether = true
          o.justCollided = true
        }
        const dot = o.vx * nx + o.vy * ny
        o.vx = o.vx - 2 * dot * nx
        o.vy = o.vy - 2 * dot * ny
        const trait = (o as any).trait
        const sdRestMul = suddenDeathActive ? (cfg.suddenDeath?.restitutionMul ?? 1) : 1
        const rest = cfg.boundary.restitution * sdRestMul
        o.vx *= rest
        o.vy *= rest
        const pr = (o as any).prng || prngs.get('bounce:'+index)
        const tangentSign = pr ? ((pr as any).nextF32() < 0.5 ? 1 : -1) : 1
        const tx = -ny * tangentSign
        const ty = nx * tangentSign
        const sdTangentMul = suddenDeathActive ? (cfg.suddenDeath?.tangentImpulseMul ?? 1) : 1
        const tangentKick = (cfg.boundary.tangentImpulse) * (trait?.tanKickMul ?? 1) * dm.gravMul * sdTangentMul
        o.vx += tx * tangentKick
        o.vy += ty * tangentKick
        if (pr) {
          const jitter = ((pr as any).nextF32() - 0.5) * 0.02 * (trait?.jitterMul ?? 1) * dm.jitterMul
          o.vx += tx * jitter
          o.vy += ty * jitter
        }
      } else {
        o.justCollided = false
      }
    } else {
      // Rectangular boundary centered at (cx,cy)
      const maxX = RX - ro
      const maxY = RY - ro
      let hit = false
      let nx = 0, ny = 0
      let anchorX = 0, anchorY = 0
      let px = o.x - cx
      let py = o.y - cy
      let overX = Math.abs(px) - maxX
      let overY = Math.abs(py) - maxY
      if (overX > 0 || overY > 0) {
        hit = true
        if (overX >= overY) {
          // Hit vertical wall
          nx = Math.sign(px)
          ny = 0
          px = Math.max(-maxX, Math.min(maxX, px))
          o.x = cx + px
          // anchor at outer wall
          anchorX = cx + (nx > 0 ? RX : -RX)
          anchorY = Math.max(cy - RY, Math.min(cy + RY, o.y))
        } else {
          // Hit horizontal wall
          nx = 0
          ny = Math.sign(py)
          py = Math.max(-maxY, Math.min(maxY, py))
          o.y = cy + py
          anchorY = cy + (ny > 0 ? RY : -RY)
          anchorX = Math.max(cx - RX, Math.min(cx + RX, o.x))
        }
      }
      if (hit) {
        if (!o.justCollided) {
          outEvents.push({ type: 'boundary_hit', orbIndex: index, anchorX, anchorY })
          o.hadTether = true
          o.justCollided = true
        }
        const dot = o.vx * nx + o.vy * ny
        o.vx = o.vx - 2 * dot * nx
        o.vy = o.vy - 2 * dot * ny
        const baseRest = 1.0
        const trait = (o as any).trait
        const sdRestMul = suddenDeathActive ? (cfg.suddenDeath?.restitutionMul ?? 1) : 1
        const rest = Math.min(1.0, baseRest * (trait?.restMul ?? 1) * dm.restMul * sdRestMul)
        o.vx *= rest
        o.vy *= rest
        const pr = (o as any).prng || prngs.get('bounce:'+index)
        const tangentSign = pr ? ((pr as any).nextF32() < 0.5 ? 1 : -1) : 1
        const tx = -ny * tangentSign
        const ty = nx * tangentSign
        const sdTangentMul = suddenDeathActive ? (cfg.suddenDeath?.tangentImpulseMul ?? 1) : 1
        const tangentKick = 0.12 * (trait?.tanKickMul ?? 1) * sdTangentMul
        o.vx += tx * tangentKick
        o.vy += ty * tangentKick
        if (pr) {
          const jitter = ((pr as any).nextF32() - 0.5) * 0.02 * (trait?.jitterMul ?? 1) * dm.jitterMul
          o.vx += tx * jitter
          o.vy += ty * jitter
        }
      } else {
        o.justCollided = false
      }
    }
    // Base gravity toward center, optionally oscillating when few orbs remain
    let g = cfg.gravity?.base ?? 0.00001
    const grav = cfg.gravity
    if (grav && state.orbs.length <= (grav.oscillateBelowOrbs ?? 0)) {
      const period = Math.max(1, grav.periodFrames || 1)
      const phase = (state.frame % period) / period
      const factor = Math.max(0, 1 + (grav.ampFrac || 0) * detSin(2 * Math.PI * phase))
      g *= factor
    }
    const trait = (o as any).trait
    g *= (trait?.gravityMul ?? 1) * dm.gravMul * suddenDeathMul
    // gravity center (may shift during sudden death)
    const gdx = o.x - gCenterX
    const gdy = o.y - gCenterY
    o.vx += -gdx * g
    o.vy += -gdy * g

    // Elastic tethers: apply spring force from each anchor to this orb
    if (cfg.tethers && state.tethers[index] && state.tethers[index].length > 0) {
      const k = cfg.tethers.springK ?? 0
      const restGlobal = cfg.tethers.springRest ?? 0
      const c = cfg.tethers.springDamping ?? 0
      if (k > 0 || c > 0) {
        const list = state.tethers[index]
        for (let ti = 0; ti < list.length; ti++) {
          const t = list[ti]
          // direction from anchor -> orb
          const sx = o.x - t.anchorX
          const sy = o.y - t.anchorY
          const L = Math.hypot(sx, sy)
          if (L > 1e-6) {
            const ux = sx / L
            const uy = sy / L
            const rest = (t.rest ?? restGlobal)
            const ext = L - rest
            let a = 0
            if (k > 0) a += -k * ext
            if (c > 0) {
              const vpar = o.vx * ux + o.vy * uy
              a += -c * vpar
            }
            o.vx += ux * a
            o.vy += uy * a
          }
        }
      }
    }

    const v = Math.hypot(o.vx, o.vy)
    const minSpBase = (cfg.boundary.minSpeed ?? 0.05) * ((trait?.minSpeedMul ?? 1))
    const minSp = minSpBase * Math.max(1, dm.gravMul)
    if (v < minSp) {
      const distG = Math.hypot(gdx, gdy) || 1
      const nxg = gdx / distG
      const nyg = gdy / distG
      const prMin = (o as any).prng || prngs.get('bounce:'+index)
      const minSpSign = prMin ? ((prMin as any).nextF32() < 0.5 ? 1 : -1) : 1
      const tx = -nyg * minSpSign
      const ty = nxg * minSpSign
      o.vx += tx * minSp
      o.vy += ty * minSp
    }
    // Edge gravity points (only for circle shape): gently attract towards discrete points on the edge
    if (shape !== 'rect' && cfg.edgeGravity && (cfg.edgeGravity.strength || 0) > 0) {
      const strength = cfg.edgeGravity.strength
      const count = Math.max(1, cfg.edgeGravity.count || 4)
      const inset = Math.max(0, cfg.edgeGravity.insetPixels ?? 24)
      const radiusOnEdge = Math.max(0, R - inset)
      // Stronger when close to boundary
      const margin = 24
      const ro2 = (o as any).radius ?? rDefault
      const closeness = Math.max(0, Math.min(1, (dist - (R - ro2 - margin)) / margin))
      if (closeness > 0) {
        let bestDx = 0, bestDy = 0, bestD2 = Number.POSITIVE_INFINITY
        for (let k = 0; k < count; k++) {
          const ang = (2 * Math.PI * k) / count
          const px = cx + radiusOnEdge * detCos(ang)
          const py = cy + radiusOnEdge * detSin(ang)
          const ex = px - o.x
          const ey = py - o.y
          const d2 = ex*ex + ey*ey
          if (d2 < bestD2) { bestD2 = d2; bestDx = ex; bestDy = ey }
        }
        const len = Math.hypot(bestDx, bestDy) || 1
        const ax = (bestDx / len) * strength * closeness
        const ay = (bestDy / len) * strength * closeness
        o.vx += ax
        o.vy += ay
      }
    }

    // Edge guide: tangential steering near target radius (energy-neutral, circle only)
    if (shape !== 'rect' && cfg.edgeGuide?.enabled) {
      const radiusTargetFrac = cfg.edgeGuide.radiusTargetFrac ?? 0.92
      const bandWidth = Math.max(0, cfg.edgeGuide.bandWidth ?? 28)
      const kGuide = cfg.edgeGuide.k ?? 0.004
      const minSpeedGate = cfg.edgeGuide.minSpeedGate ?? 0.8

      // Validate config
      if (radiusTargetFrac > 0 && radiusTargetFrac < 1 && bandWidth > 0) {
        const r = dist // distance from center
        const rTarget = radiusTargetFrac * R
        const s = Math.hypot(o.vx, o.vy)

        // Only steer if within band and above speed gate
        if (r >= rTarget - bandWidth && r <= rTarget + bandWidth && s >= minSpeedGate) {
          // Unit normal: from center to orb
          const nx = dx / Math.max(dist, 1e-9)
          const ny = dy / Math.max(dist, 1e-9)

          // Two tangent directions
          const t1x = -ny
          const t1y = nx
          const t2x = ny
          const t2y = -nx

          // Pick tangent aligned with velocity
          const dot1 = o.vx * t1x + o.vy * t1y
          const dot2 = o.vx * t2x + o.vy * t2y
          const tx = dot1 > dot2 ? t1x : t2x
          const ty = dot1 > dot2 ? t1y : t2y

          // Make acceleration orthogonal to velocity (no speed change)
          const vHatX = o.vx / Math.max(s, 1e-9)
          const vHatY = o.vy / Math.max(s, 1e-9)
          const dotTV = tx * vHatX + ty * vHatY
          const tOrthX = tx - dotTV * vHatX
          const tOrthY = ty - dotTV * vHatY
          const tOrthLen = Math.hypot(tOrthX, tOrthY)

          if (tOrthLen > 1e-9) {
            const tOrthNormX = tOrthX / tOrthLen
            const tOrthNormY = tOrthY / tOrthLen

            // Distance factor: pull back toward target ring
            const d = Math.max(-1, Math.min(1, (r - rTarget) / bandWidth))

            // Apply acceleration (perpendicular to velocity)
            const ax = kGuide * d * tOrthNormX
            const ay = kGuide * d * tOrthNormY
            o.vx += ax
            o.vy += ay
          }
        }
      }
    }

    // Cap maximum speed with optional low-orb ramp (always clamp)
    // powerMul: Higher values allow faster max velocity, enabling more aggressive play
    if (cfg.boundary.maxSpeed && cfg.boundary.maxSpeed > 0) {
      let cap = cfg.boundary.maxSpeed
      if (state.orbs.length <= suddenDeathMaxOrbs) {
        const rampFrames = Math.max(1, cfg.boundary.twoOrbsRampFrames ?? 720)
        if (state.twoOrbsStartFrame === undefined) state.twoOrbsStartFrame = state.frame
        const start = state.twoOrbsStartFrame ?? state.frame
        const t = Math.max(0, Math.min(1, (state.frame - start) / rampFrames))
        const max2 = cfg.boundary.twoOrbsMaxSpeed ?? cap
        cap = cap + (max2 - cap) * t
      } else if (state.twoOrbsStartFrame !== undefined) {
        state.twoOrbsStartFrame = undefined
      }
      const v2 = Math.hypot(o.vx, o.vy)
      const orbCap = cap * o.skill.powerMul
      if (v2 > orbCap) {
        o.vx = (o.vx / v2) * orbCap
        o.vy = (o.vy / v2) * orbCap
      }
    }
  }

  for (let i = 0; i < state.orbs.length; i++) {
    for (let j = i + 1; j < state.orbs.length; j++) {
      const a = state.orbs[i], b = state.orbs[j]
      let dx = b.x - a.x, dy = b.y - a.y
      let d = Math.hypot(dx, dy)
      const ra = (a as any).radius ?? rDefault
      const rb = (b as any).radius ?? rDefault
      const min = ra + rb
      if (d === 0) { d = 0.0001; dx = 0.0001; dy = 0 }
      // High-impact detection (pre-resolution). Require actual contact.
      const splitBelowOrbs = cfg.split?.enableBelowOrbs ?? Number.POSITIVE_INFINITY
      if (cfg.split?.enabled && state.orbs.length <= splitBelowOrbs) {
        const nx = dx / d, ny = dy / d
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy
        const vn = rvx * nx + rvy * ny
        const va2 = a.vx*a.vx + a.vy*a.vy
        const vb2 = b.vx*b.vx + b.vy*b.vy
        const KE = 0.5 * (va2 + vb2)
        // splitAggroMul tradeoff: Higher values lower YOUR split thresholds (easier to split).
        // This is a self-tradeoff stat - more splits = more orbs but weaker tether defense on children.
        // Uses sqrt scaling for gentler effect; clamp to at least 0.01 to avoid divide-by-zero.
        const splitAggroA = Math.max(0.01, a.skill.splitAggroMul)
        const splitAggroB = Math.max(0.01, b.skill.splitAggroMul)
        const vnThreshA = cfg.split!.vnThreshold / Math.sqrt(splitAggroA)
        const vnThreshB = cfg.split!.vnThreshold / Math.sqrt(splitAggroB)
        const keThreshA = cfg.split!.keThreshold / Math.sqrt(splitAggroA)
        const keThreshB = cfg.split!.keThreshold / Math.sqrt(splitAggroB)
        const gateA = (d <= min + 1e-6) && Math.abs(vn) >= vnThreshA && KE >= keThreshA
        const gateB = (d <= min + 1e-6) && Math.abs(vn) >= vnThreshB && KE >= keThreshB
        if (state.orbs.length + pendingSplitMap.size < (cfg.split!.maxOrbsCap ?? Number.POSITIVE_INFINITY)) {
          if (gateA && a.gen < (cfg.split!.maxGenerations ?? 0) && a.splitCooldown === 0 && !pendingSplitMap.has(i)) {
            pendingSplitMap.set(i, { idx: i, nx, ny })
          }
          if (gateB && b.gen < (cfg.split!.maxGenerations ?? 0) && b.splitCooldown === 0 && !pendingSplitMap.has(j)) {
            pendingSplitMap.set(j, { idx: j, nx: -nx, ny: -ny })
          }
        }
      }
      // If either orb is scheduled to split this frame, skip collision resolution so split applies at impact
      const skipResolve = !!(cfg.split?.enabled && (pendingSplitMap.has(i) || pendingSplitMap.has(j)))
      if (!skipResolve && d < min) {
        const overlap = (min - d) / 2
        const nx = dx / d, ny = dy / d
        a.x -= nx * overlap; a.y -= ny * overlap
        b.x += nx * overlap; b.y += ny * overlap
        const tx = -ny, ty = nx
        const va_n = a.vx * nx + a.vy * ny
        const vb_n = b.vx * nx + b.vy * ny
        const va_t = a.vx * tx + a.vy * ty
        const vb_t = b.vx * tx + b.vy * ty

        // Equal-mass collision with configurable restitution along normal
        const e = cfg.collisions?.orbRestitution ?? 1.0
        const va_n_after = 0.5 * ((1 - e) * va_n + (1 + e) * vb_n)
        const vb_n_after = 0.5 * ((1 + e) * va_n + (1 - e) * vb_n)
        a.vx = va_n_after * nx + va_t * tx
        a.vy = va_n_after * ny + va_t * ty
        b.vx = vb_n_after * nx + vb_t * tx
        b.vy = vb_n_after * ny + vb_t * ty

        // Impact-triggered shockwave
        const vn = vb_n - va_n
        if (
          cfg.fx?.shockwave?.enabled &&
          cfg.fx.shockwave.triggerOnImpact &&
          Math.abs(vn) >= (cfg.fx.shockwave.impactThreshold ?? 0)
        ) {
          outEvents.push({
            type: "shock",
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            color: '#ffffff',
            kind: 'impact',
          })
        }
      }
    }
  }

  // Apply deterministic splits after resolving all pairs
  if (cfg.split?.enabled && pendingSplitMap.size > 0) {
    const dm = dramaMultipliers(state.frame, cfg.drama)
    const entries = [...pendingSplitMap.values()].sort((p,q)=>p.idx - q.idx)
    for (const ps of entries) {
      if (state.orbs.length >= (cfg.split!.maxOrbsCap ?? Number.POSITIVE_INFINITY)) break
      const parent = state.orbs[ps.idx]
      if (!parent) continue
      // Re-check eligibility (cooldown may have changed if multiple splits happened earlier this frame)
      if ((parent as any).splitCooldown > 0 || (parent as any).gen >= (cfg.split!.maxGenerations ?? 0)) continue
      const n = { x: ps.nx, y: ps.ny }
      const t = { x: -n.y, y: n.x }
      const ang = cfg.split!.angleSpread ?? 0.35
      const cos = detCos(ang), sin = detSin(ang)
      const d1 = { x: t.x * cos - t.y * sin, y: t.x * sin + t.y * cos }
      const d2 = { x: t.x * cos + t.y * sin, y: t.y * cos - t.x * sin } // rotate -ang
      const rChild = Math.max(3, ((parent as any).radius ?? rDefault) * (cfg.split!.radiusScale ?? 0.68))
      const sep = 0.6 * rChild
      // positions
      let x1 = parent.x + d1.x * sep, y1 = parent.y + d1.y * sep
      let x2 = parent.x + d2.x * sep, y2 = parent.y + d2.y * sep
      // clamp inside boundary
      if (shape === 'circle') {
        const clamp = (x:number, y:number) => {
          const vx = x - cx, vy = y - cy
          const L = Math.hypot(vx, vy)
          const maxL = Math.max(0, (cfg.boundary.radius * dm.shrink) - rChild)
          if (L > maxL && L > 0) { const s = maxL / L; return { x: cx + vx*s, y: cy + vy*s } }
          return { x, y }
        }
        ({x:x1,y:y1} = clamp(x1,y1));
        ({x:x2,y:y2} = clamp(x2,y2));
      } else {
        const RX = (cfg.boundary.rectHalfWidth ?? rDefault) * dm.shrink
        const RY = (cfg.boundary.rectHalfHeight ?? rDefault) * dm.shrink
        x1 = Math.max(cx - RX + rChild, Math.min(cx + RX - rChild, x1))
        y1 = Math.max(cy - RY + rChild, Math.min(cy + RY - rChild, y1))
        x2 = Math.max(cx - RX + rChild, Math.min(cx + RX - rChild, x2))
        y2 = Math.max(cy - RY + rChild, Math.min(cy + RY - rChild, y2))
      }
      // velocities
      const vp = Math.hypot(parent.vx, parent.vy)
      const base = 0.5
      const childMul = cfg.split!.childSpeedMul ?? 0.6
      let v1x = base * parent.vx + childMul * vp * d1.x
      let v1y = base * parent.vy + childMul * vp * d1.y
      let v2x = base * parent.vx + childMul * vp * d2.x
      let v2y = base * parent.vy + childMul * vp * d2.y
      // energy cap: do not exceed parent's energy
      const KEp = 0.5 * (vp*vp)
      const KEc = 0.5 * (v1x*v1x + v1y*v1y + v2x*v2x + v2y*v2y)
      if (KEc > KEp && KEc > 0) {
        const s = Math.sqrt(KEp / KEc)
        v1x *= s; v1y *= s; v2x *= s; v2y *= s
      }
      // build children
      const pr1 = parent.prng.derive('splitA:'+ parent.gen)
      const pr2 = parent.prng.derive('splitB:'+ parent.gen)
      // Inherit skill with tether defense penalty on split (multiplicative with floor).
      // splitAggroMul tradeoff: child orbs get reduced tetherDefMul, making them
      // easier for enemies to disrupt. This balances the benefit of more orbs.
      const tetherResOnSplitMul = cfg.split!.tetherResOnSplitMul ?? 0.9
      const tetherResFloorMul = cfg.split!.tetherResFloorMul ?? 0.7
      const decayedTetherDef = parent.skill.tetherDefMul * tetherResOnSplitMul
      const floorTetherDef = parent.skill.tetherDefMul * tetherResFloorMul
      const childSkill = {
        splitAggroMul: parent.skill.splitAggroMul,
        tetherResMul: parent.skill.tetherResMul,
        tetherDefMul: Math.max(decayedTetherDef, floorTetherDef),
        powerMul: parent.skill.powerMul,
      }
      const childCommon = {
        color: parent.color,
        owner: parent.owner,
        trait: parent.trait,
        gen: (parent.gen || 0) + 1,
        splitCooldown: cfg.split!.cooldownFrames ?? 240,
        radius: rChild,
        hadTether: false,
        justCollided: false,
        skill: childSkill,
      }
      const c1 = { x: x1, y: y1, vx: v1x, vy: v1y, prng: pr1, ...childCommon }
      const c2 = { x: x2, y: y2, vx: v2x, vy: v2y, prng: pr2, ...childCommon }
      // clear parent tethers, replace parent with c1, append c2 with empty tethers
      state.tethers[ps.idx] = []
      state.orbs[ps.idx] = c1 as any
      state.orbs.push(c2 as any)
      state.tethers.push([])
      // visual flash (engine-managed, deterministic)
      const life = 36
      state.flashes.push({ x: parent.x, y: parent.y, color: (parent as any).color, life, maxLife: life })
      // shock event for tether-cutting shockwave
      if (cfg.fx?.shockwave?.enabled && (cfg.fx.shockwave.triggerOnSplit !== false)) {
        outEvents.push({
          type: "shock",
          x: parent.x,
          y: parent.y,
          strength: 1,
          color: (parent as any).color,
          kind: 'split',
        })
      }
    }
  }

  // Decrement split cooldowns
  if (cfg.split?.enabled) {
    for (let k = 0; k < state.orbs.length; k++) {
      const o = state.orbs[k] as any
      if (o.splitCooldown && o.splitCooldown > 0) o.splitCooldown -= 1
    }
  }

  // Final clamp after all forces and collisions to enforce max speed strictly
  if (cfg.boundary.maxSpeed && cfg.boundary.maxSpeed > 0) {
    let cap = cfg.boundary.maxSpeed
    if (state.orbs.length <= suddenDeathMaxOrbs) {
      const rampFrames = Math.max(1, cfg.boundary.twoOrbsRampFrames ?? 720)
      if (state.twoOrbsStartFrame === undefined) state.twoOrbsStartFrame = state.frame
      const start = state.twoOrbsStartFrame ?? state.frame
      const t = Math.max(0, Math.min(1, (state.frame - start) / rampFrames))
      const max2 = cfg.boundary.twoOrbsMaxSpeed ?? cap
      cap = cap + (max2 - cap) * t
    } else if (state.twoOrbsStartFrame !== undefined) {
      state.twoOrbsStartFrame = undefined
    }
    for (let k = 0; k < state.orbs.length; k++) {
      const ov = state.orbs[k]
      const v2 = Math.hypot(ov.vx, ov.vy)
      const orbCap = cap * ov.skill.powerMul
      if (v2 > orbCap) {
        ov.vx = (ov.vx / v2) * orbCap
        ov.vy = (ov.vy / v2) * orbCap
      }
    }
  }

  state.frame += 1
  return { state, events: outEvents }
}
