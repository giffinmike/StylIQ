// FROZEN constants for AI Outfit Studio learning attribution.
//
// These are the only sourceFeature literal values that the wardrobe-side
// generation/refine pipeline controls today. Verified verbatim:
//   - 'outfit_refinement' at apps/backend-nest/src/wardrobe/wardrobe.service.ts:378
//   - 'elite_scoring'     at apps/backend-nest/src/ai/elite/eliteScoring.ts:763
//                         (called from wardrobe.service.ts:2472, 4024)
//
// Note: 'studio' is also a Studio-attributed sourceFeature, but it is emitted
// by apps/backend-nest/src/outfit/outfit.controller.ts:142 (the
// OUTFIT_SAVED_FROM_HOME pipeline). That file is OUT OF SCOPE for this PR
// and intentionally NOT pinned here. Its byte-identical preservation is
// guaranteed by "no other files changed" and verified by SQL diff.

export const SOURCE_FEATURE_REFINEMENT = 'outfit_refinement' as const;
export const SOURCE_FEATURE_ELITE = 'elite_scoring' as const;

export type StudioPipelineSourceFeature =
  | typeof SOURCE_FEATURE_REFINEMENT
  | typeof SOURCE_FEATURE_ELITE;
