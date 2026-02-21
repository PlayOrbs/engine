/**
 * Build Hash System
 * 
 * This hash ensures deterministic replay across all components.
 * Any change to physics, economics, or simulation logic MUST update this hash.
 * 
 * Version History:
 * - v1: Initial deterministic replay system with economics scoring
 */

export const BUILD_HASH = 'v1' as const
export const ENGINE_VERSION_V1 = 1 as const
export const ENGINE_VERSION_V2 = 2 as const
export type EngineVersion = typeof ENGINE_VERSION_V1 | typeof ENGINE_VERSION_V2
