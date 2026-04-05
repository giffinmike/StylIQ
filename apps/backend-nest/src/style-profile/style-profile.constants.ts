// ── Single-select enum values (enforced via @IsIn in DTO) ──

export const FORMALITY_FLOOR_VALUES = [
  'No minimum',
  'Casual',
  'Smart Casual',
  'Business Casual',
  'Business Formal',
  'Black Tie',
] as const;

export const SILHOUETTE_PREFERENCE_VALUES = [
  'Structured',
  'Relaxed',
  'Mix of both',
] as const;

export const CARE_TOLERANCE_VALUES = [
  'Easy care only',
  'Some special care ok',
  'Any care routine ok',
] as const;

export const METAL_PREFERENCE_VALUES = [
  'Gold',
  'Silver',
  'Rose Gold',
  'Mixed metals',
  'No preference',
] as const;

export const CONTRAST_PREFERENCE_VALUES = [
  'High contrast',
  'Medium contrast',
  'Low contrast',
  'No preference',
] as const;

export const FOOTWEAR_COMFORT_VALUES = [
  'Comfort first',
  'Balanced',
  'Style first',
] as const;

export const WALKABILITY_REQUIREMENT_VALUES = [
  'Low',
  'Medium',
  'High',
] as const;

export const FOOT_WIDTH_VALUES = ['Narrow', 'Standard', 'Wide'] as const;

export const TREND_APPETITE_VALUES = [
  'Classic / timeless',
  'Selectively trendy',
  'Trend-forward',
  'Cutting edge',
] as const;

// ── Column allowlist (all valid DB columns for UPSERT gating) ──

export const ALLOWED_COLUMNS = new Set([
  // Existing columns (40)
  'body_type',
  'skin_tone',
  'undertone',
  'hair_color',
  'eye_color',
  'proportions',
  'climate',
  'height',
  'weight',
  'chest',
  'waist',
  'hip',
  'shoulder_width',
  'inseam',
  'shoe_size',
  'all_measurements',
  'favorite_colors',
  'color_preferences',
  'disliked_styles',
  'style_keywords',
  'style_preferences',
  'fit_preferences',
  'preferred_brands',
  'daily_activities',
  'shopping_habits',
  'personality_traits',
  'fabric_preferences',
  'occasions',
  'style_icons',
  'budget_level',
  'budget_min',
  'budget_max',
  'fashion_confidence',
  'fashion_boldness',
  'trend_appetite',
  'goals',
  'lifestyle_notes',
  'unit_preference',
  'prefs_jsonb',
  'is_style_profile_complete',
  // New columns (13)
  'coverage_no_go',
  'avoid_colors',
  'avoid_materials',
  'formality_floor',
  'walkability_requirement',
  'pattern_preferences',
  'avoid_patterns',
  'silhouette_preference',
  'care_tolerance',
  'metal_preference',
  'contrast_preference',
  'footwear_comfort',
  'foot_width',
]);

// Columns that are TEXT[] in Postgres — need explicit cast for empty arrays
export const TEXT_ARRAY_COLUMNS = new Set([
  'favorite_colors',
  'color_preferences',
  'disliked_styles',
  'style_keywords',
  'style_preferences',
  'fit_preferences',
  'preferred_brands',
  'daily_activities',
  'shopping_habits',
  'personality_traits',
  'fabric_preferences',
  'occasions',
  'style_icons',
  'goals',
  'coverage_no_go',
  'avoid_colors',
  'avoid_materials',
  'pattern_preferences',
  'avoid_patterns',
]);
