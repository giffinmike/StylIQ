// apps/backend-nest/src/wardrobe/studio/types.ts
//
// AI Outfit Studio — strict deterministic builder types.
// Studio-local; NOT shared with any other AI feature.

import type { ParsedConstraints } from '../logic/constraints';
import type { StudioContext } from '../logic/studioContext';
import type { WeatherContext } from '../logic/weather';
import type { UserStyle } from '../logic/style';
import type { UserPresentation } from '../logic/presentationFilter';

/**
 * Wardrobe item in Studio-local shape. Mirrors the subset of CatalogItem
 * fields the deterministic builder reads. Kept minimal on purpose.
 */
export interface StudioItem {
  id: string;
  label: string;
  name?: string;
  image?: string;
  image_url?: string;
  main_category?: string;
  subcategory?: string;
  color?: string;
  color_family?: string;
  shoe_style?: string;
  dress_code?: string;
  formality_score?: number;
  brand?: string;
  material?: string;
  sleeve_length?: string;
  layering?: string;
  waterproof_rating?: number | string;
  rain_ok?: boolean;
}

/**
 * Strict 5-slot outfit structure. Top/Bottom/Shoes are mandatory.
 * Layer and Accessory are optional and explicitly null when absent.
 */
export interface StudioSlots {
  top: StudioItem;
  bottom: StudioItem;
  shoes: StudioItem;
  layer: StudioItem | null;
  accessory: StudioItem | null;
}

/**
 * Studio outfit returned to callers.
 * `items` stays a non-null ordered array (backward-compatible with the
 * existing frontend renderer). `slots` is the new strict structural field.
 */
export interface StudioOutfit {
  outfit_id: string;
  title: string;
  why: string;
  reasoning: string;
  score: number;
  items: StudioItem[];
  slots: StudioSlots;
}

export interface StyleProfileSnapshot {
  avoid_colors?: string[];
  avoid_materials?: string[];
  avoid_patterns?: string[];
  avoid_subcategories?: string[];
  disliked_styles?: string[];
  favorite_colors?: string[];
  preferred_brands?: string[];
  fit_preferences?: string[];
  fabric_preferences?: string[];
  style_preferences?: string[];
  silhouette_preference?: string | null;
  contrast_preference?: string | null;
  formality_floor?: number | null;
  dressBias?: 'Casual' | 'SmartCasual' | 'BusinessCasual' | 'Business' | null;
}

/**
 * Context bundle threaded through filters, compatibility checks, scoring,
 * and the builder. Produced once per request in wardrobe.service.ts.
 */
export interface StudioBuildContext {
  effectiveQuery: string;
  parsedConstraints: ParsedConstraints;
  studio: StudioContext;
  userStyle?: UserStyle;
  userPresentation: UserPresentation;
  weather?: WeatherContext;
  styleProfile: StyleProfileSnapshot | null;
  // Populated by the orchestrator from deriveEnvironmentTier(ctx) before
  // downstream scoring runs. Optional in the type so that upstream
  // constructors (wardrobe.service.ts) do not need to know about it —
  // the orchestrator attaches it via spread before passing ctx forward.
  environmentTier?:
    | 'NORMAL'
    | 'EXTREME_HEAT'
    | 'EXTREME_COLD'
    | 'ATHLETIC'
    | 'FORMAL_EVENT';
}

export type StudioInvariantCode =
  | 'WARDROBE_INSUFFICIENT_TOPS'
  | 'WARDROBE_INSUFFICIENT_BOTTOMS'
  | 'WARDROBE_INSUFFICIENT_SHOES'
  | 'WARDROBE_INSUFFICIENT_COMPATIBLE'
  | 'STUDIO_SLOT_INVARIANT_FAILED';

/**
 * Thrown when the wardrobe cannot satisfy a mandatory slot or when a
 * post-assembly invariant fails. Caught at the controller boundary and
 * translated to HTTP 422. No silent degradation.
 */
export class StudioInvariantError extends Error {
  readonly code: StudioInvariantCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: StudioInvariantCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StudioInvariantError';
    this.code = code;
    this.details = details;
  }
}
