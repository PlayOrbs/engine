// ─── Engine Runner Abstraction ───
//
// Hides V1/V2 engine differences behind a uniform interface.
// Upper layers (gameLoop, replay, precompute) only interact with EngineRunner.
// All version branching lives here.

import type { EngineState, EngineConfig } from '../v1/types.js'
import type { EngineStateV2, V2ConfigFp, OrbV2, TetherV2 } from './types_v2.js'
import { advanceFrame, countUniqueOwners } from '../v1/sim.js'
import { advanceFrameV2, countUniqueOwnersV2, initFromSeedV2 } from './sim_v2.js'
import { stateV2ToRenderState } from './render_bridge_v2.js'
import { makePRNG } from '../../utils/rng.js'

// Re-export V2 init and types for external use
export { initFromSeedV2 }
export type { EngineStateV2, V2ConfigFp }

// ─── Interface ───

export interface EngineRunner {
  /** Step one frame. Returns physics+tether events for this frame. */
  step(): { events: any[] }

  /** Float render-compatible state. V1: state directly. V2: projected via fromPos/fromVel. */
  getRenderState(): EngineState

  /** Current frame number. */
  getFrame(): number

  /** True when econ.finalized is set. */
  isFinalized(): boolean

  /** Opaque checkpoint blob. Caller stores it, never inspects internals. */
  makeCheckpoint(): unknown

  /** Restore from a previously made checkpoint. */
  restoreCheckpoint(cp: unknown): void

  /** Count unique owners (for end-of-game detection). */
  countUniqueOwners(): number
}

// ─── PRNG serialization types ───

type PrngState = {
  seed: Uint8Array
  buf: Uint8Array
  i: number
  ctr: number
}

// ─── RunnerV1 ───

type CheckpointV1 = {
  engineVersion: 1
  frame: number
  state: EngineState
  prngs: Array<{ key: string; st: PrngState }>
  orbPrngs: Array<PrngState | null>
}

export class RunnerV1 implements EngineRunner {
  state: EngineState
  prngs: Map<string, any>
  private cfg: EngineConfig

  constructor(state: EngineState, prngs: Map<string, any>, cfg: EngineConfig) {
    this.state = state
    this.prngs = prngs
    this.cfg = cfg
  }

  step(): { events: any[] } {
    // V1 advanceFrame is monolithic: physics + tethers + scoring + prune + econ + TP + shockwaves
    if (this.state.frame % 1200 === 0) {
      console.debug(`[RunnerV1] step() frame=${this.state.frame}`) // TODO: remove after verification
    }
    const newState = advanceFrame(this.state, this.cfg, this.prngs)
    this.state = newState
    return { events: [] } // V1 handles events internally
  }

  getRenderState(): EngineState {
    return this.state // already float
  }

  getFrame(): number {
    return this.state.frame
  }

  isFinalized(): boolean {
    return !!(this.state.econ as any)?.finalized
  }

  makeCheckpoint(): unknown {
    const clonedState = cloneStateV1(this.state)
    return {
      engineVersion: 1 as const,
      frame: this.state.frame,
      state: clonedState,
      prngs: serializePrngsMap(this.prngs),
      orbPrngs: serializeOrbPrngsV1(this.state),
    } satisfies CheckpointV1
  }

  restoreCheckpoint(cp: unknown): void {
    const c = cp as CheckpointV1
    this.state = structuredClone(c.state)
    this.prngs = deserializePrngsMap(c.prngs)
    restoreOrbPrngsV1(this.state, c.orbPrngs, this.prngs)
  }

  countUniqueOwners(): number {
    return countUniqueOwners(this.state.orbs)
  }
}

// ─── RunnerV2 ───

type CheckpointV2 = {
  engineVersion: 2
  frame: number
  stateV2: EngineStateV2 // orbs have prng stripped
  fpCfg: V2ConfigFp
  orbPrngs: Array<PrngState | null>
}

export class RunnerV2 implements EngineRunner {
  private stateV2: EngineStateV2
  private fpCfg: V2ConfigFp
  private renderState: EngineState | undefined

  constructor(stateV2: EngineStateV2, fpCfg: V2ConfigFp) {
    this.stateV2 = stateV2
    this.fpCfg = fpCfg
    this.renderState = undefined
  }

  step(): { events: any[] } {
    // Engine handles physics + econ internally (deterministic unit)
    const { state: st, events: frameEvents } = advanceFrameV2(this.stateV2, this.fpCfg)
    this.stateV2 = st

    // Project render state (mutate in-place for perf)
    this.renderState = stateV2ToRenderState(st, this.fpCfg, this.renderState)

    return { events: frameEvents }
  }

  getRenderState(): EngineState {
    if (!this.renderState) {
      this.renderState = stateV2ToRenderState(this.stateV2, this.fpCfg)
    }
    return this.renderState
  }

  getFrame(): number {
    return this.stateV2.frame
  }

  isFinalized(): boolean {
    return !!(this.stateV2.econ as any)?.finalized
  }

  makeCheckpoint(): unknown {
    return {
      engineVersion: 2 as const,
      frame: this.stateV2.frame,
      stateV2: cloneStateV2(this.stateV2),
      fpCfg: this.fpCfg, // immutable config, no clone needed
      orbPrngs: serializeOrbPrngsV2(this.stateV2),
    } satisfies CheckpointV2
  }

  restoreCheckpoint(cp: unknown): void {
    const c = cp as CheckpointV2
    this.stateV2 = restoreStateV2FromCheckpoint(c)
    this.fpCfg = c.fpCfg
    // Re-project render state
    this.renderState = stateV2ToRenderState(this.stateV2, this.fpCfg, this.renderState)
  }

  countUniqueOwners(): number {
    return countUniqueOwnersV2(this.stateV2.orbs)
  }
}

// ─── V1 checkpoint helpers ───

function cloneStateV1(st: EngineState): EngineState {
  // Shallow copy orbs without prng (functions can't be cloned)
  const stCopy = { ...st, orbs: st.orbs.map(o => ({ ...o })) }
  stCopy.orbs.forEach(orb => { delete (orb as any).prng })

  if (typeof structuredClone !== 'undefined') {
    return structuredClone(stCopy)
  }

  const cloned = JSON.parse(JSON.stringify(stCopy)) as EngineState
  cloned.orbs.forEach(orb => {
    if (orb.owner && !(orb.owner instanceof Uint8Array)) {
      const arr = new Uint8Array(Object.keys(orb.owner).length)
      Object.keys(orb.owner).forEach(key => { arr[parseInt(key)] = (orb.owner as any)[key] })
      orb.owner = arr
    }
  })
  return cloned
}

function serializePrngsMap(map: Map<string, any>): Array<{ key: string; st: PrngState }> {
  const out: Array<{ key: string; st: PrngState }> = []
  for (const [k, pr] of map.entries()) {
    if (typeof pr.__getState === 'function') {
      out.push({ key: k, st: pr.__getState() })
    }
  }
  return out
}

function deserializePrngsMap(list: Array<{ key: string; st: PrngState }>): Map<string, any> {
  const map = new Map<string, any>()
  for (const it of list) {
    const pr = makePRNG(new Uint8Array(it.st.seed))
    if (typeof (pr as any).__setState === 'function') (pr as any).__setState(it.st)
    map.set(it.key, pr)
  }
  return map
}

function serializeOrbPrngsV1(state: EngineState): Array<PrngState | null> {
  return state.orbs.map((o: any) => {
    if (o.prng && typeof o.prng.__getState === 'function') return o.prng.__getState()
    return null
  })
}

function restoreOrbPrngsV1(
  state: EngineState,
  orbPrngs: Array<PrngState | null>,
  mapPrngs: Map<string, any>,
): void {
  for (let i = 0; i < state.orbs.length; i++) {
    if (orbPrngs && orbPrngs[i]) {
      const st = orbPrngs[i]!
      const pr = makePRNG(new Uint8Array(st.seed))
      if (typeof (pr as any).__setState === 'function') (pr as any).__setState(st)
      ;(state.orbs[i] as any).prng = pr
    } else {
      const pr = mapPrngs.get('bounce:' + i)
      if (pr) (state.orbs[i] as any).prng = pr
    }
  }
}

// ─── V2 checkpoint helpers ───

function cloneStateV2(st: EngineStateV2): EngineStateV2 {
  // Deep copy without PRNG instances (they're not structuredClone-safe)
  // Orbs: copy each orb, set prng to null
  const orbs: OrbV2[] = st.orbs.map(o => ({
    x: o.x, y: o.y, vx: o.vx, vy: o.vy,
    radius: o.radius,
    justCollided: o.justCollided,
    hadTether: o.hadTether,
    color: o.color,
    prng: null as any, // stripped — restored from orbPrngs
    trait: { ...o.trait },
    owner: new Uint8Array(o.owner),
    gen: o.gen,
    splitCooldown: o.splitCooldown,
    skill: { ...o.skill },
  }))

  // Tethers: shallow copy each tether object
  const tethers: TetherV2[][] = st.tethers.map(list =>
    list.map(t => ({ anchorX: t.anchorX, anchorY: t.anchorY, color: t.color, protect: t.protect }))
  )

  // Flashes and shockwaves: shallow copy
  const flashes = st.flashes.map(f => ({ ...f }))
  const shockwaves = st.shockwaves.map(w => ({ ...w }))

  // Scores: deep copy
  const scores: typeof st.scores = {}
  for (const [k, v] of Object.entries(st.scores)) {
    scores[k] = { ...v }
  }

  // Econ: structuredClone is safe here (no PRNG instances, just plain data)
  let econ = st.econ
  if (econ) {
    // tp_triggered is a Set which structuredClone handles, but JSON doesn't
    econ = structuredClone(econ)
  }

  return {
    engineVersion: 2,
    frame: st.frame,
    orbs,
    tethers,
    flashes,
    shockwaves,
    scores,
    twoOrbsStartFrame: st.twoOrbsStartFrame,
    econ,
  }
}

function serializeOrbPrngsV2(st: EngineStateV2): Array<PrngState | null> {
  return st.orbs.map(o => {
    if (o.prng && typeof (o.prng as any).__getState === 'function') {
      return (o.prng as any).__getState()
    }
    return null
  })
}

function restoreStateV2FromCheckpoint(cp: CheckpointV2): EngineStateV2 {
  // Deep clone the stored state (which has prng: null on orbs)
  const st = cloneStateV2(cp.stateV2)

  // Restore PRNG instances from serialized states
  for (let i = 0; i < st.orbs.length; i++) {
    const prngState = cp.orbPrngs[i]
    if (prngState) {
      const pr = makePRNG(new Uint8Array(prngState.seed))
      if (typeof (pr as any).__setState === 'function') (pr as any).__setState(prngState)
      st.orbs[i].prng = pr
    }
  }

  return st
}

// ─── Version gate helper ───

export function shouldUseV2(configVersion: string): boolean {
  // V2 engine not yet production-ready — gate at 3.0.0+
  const clean = configVersion.split('-')[0].split('+')[0]
  const parts = clean.split('.')
  const maj = parseInt(parts[0], 10) || 0
  return maj >= 3
}
