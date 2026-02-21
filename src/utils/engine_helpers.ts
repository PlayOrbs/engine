import { EngineState } from "../core/v1/types.js";

export function applyBoundaryTethers(st: EngineState, events: any[]) {
  for (const e of events) if (e.type === "boundary_hit") {
    const i = e.orbIndex;
    const color = st.orbs[i].color;
    st.tethers[i].push({ anchorX: e.anchorX, anchorY: e.anchorY, color, protect: 1 });
    st.orbs[i].hadTether = true;
  }
}

export function pruneEliminated(st: EngineState) {
  const orbs: typeof st.orbs = [];
  const tethers: typeof st.tethers = [];
  for (let i = 0; i < st.orbs.length; i++) {
    const hasAny = st.tethers[i] && st.tethers[i].length > 0;
    if (!st.orbs[i].hadTether || hasAny) { orbs.push(st.orbs[i]); tethers.push(st.tethers[i]); }
  }
  st.orbs = orbs;
  st.tethers = tethers;
}

/**
 * Test if a line segment intersects an annulus (ring).
 *
 * @param cx - Ring center X
 * @param cy - Ring center Y
 * @param rIn - Inner radius
 * @param rOut - Outer radius
 * @param ax - Segment start X
 * @param ay - Segment start Y
 * @param bx - Segment end X
 * @param by - Segment end Y
 * @returns true if segment intersects the annulus
 */
export function segIntersectsAnnulus(
  cx: number, cy: number, rIn: number, rOut: number,
  ax: number, ay: number, bx: number, by: number
): boolean {
  const vx = bx - ax, vy = by - ay;
  const wx = ax - cx, wy = ay - cy;
  const vv = vx * vx + vy * vy || 1;
  // Closest approach param t in [0,1]
  let t = -(wx * vx + wy * vy) / vv;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = ax + t * vx, py = ay + t * vy;
  const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
  const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
  // If closest approach is within the ring, we intersect.
  if (d2 >= rIn2 && d2 <= rOut2) return true;
  // Also handle the case where the segment crosses the ring edges:
  const da2 = (ax - cx) * (ax - cx) + (ay - cy) * (ay - cy);
  const db2 = (bx - cx) * (bx - cx) + (by - cy) * (by - cy);
  const aIn = da2 < rIn2, aOut = da2 > rOut2;
  const bIn = db2 < rIn2, bOut = db2 > rOut2;
  // If endpoints straddle either inner or outer radius, it's a hit.
  const crossesInner = (aIn !== bIn);
  const crossesOuter = (aOut !== bOut);
  return crossesInner || crossesOuter;
}
