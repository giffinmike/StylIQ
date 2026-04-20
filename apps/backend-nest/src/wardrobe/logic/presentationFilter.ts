// apps/backend-nest/src/wardrobe/logic/presentationFilter.ts
// Gender/presentation-aware filtering (mirrors ai.service.ts exactly)

export type UserPresentation = 'masculine' | 'feminine' | 'mixed';

/**
 * Normalize raw gender_presentation string into one of three values.
 * Check female/feminine FIRST — 'female'.includes('male') is true in JS!
 */
export function resolveUserPresentation(
  genderPresentation: string,
): UserPresentation {
  const gp = (genderPresentation || '').toLowerCase().replace(/[\s_-]+/g, '');
  // Check female/feminine FIRST — 'female'.includes('male') is true in JS!
  if (gp.includes('female') || gp.includes('feminin') || gp === 'woman')
    return 'feminine';
  if (gp.includes('male') || gp.includes('masculin') || gp === 'man')
    return 'masculine';
  // "other", "nonbinary", "rathernotsay", empty → 'mixed' (allow all)
  return 'mixed';
}

/**
 * Returns true if this item is feminine-coded and should be excluded for masculine users.
 * Mirrors ai.service.ts + capsuleEngine.inferGarmentFlags() exactly.
 */
export function isFeminineItem(
  mainCategory: string,
  subcategory: string,
  name: string,
): boolean {
  const cat = mainCategory || '';
  const sub = (subcategory || '').toLowerCase();
  const nm = (name || '').toLowerCase();

  // Main category hard blocks
  if (cat === 'Dresses' || cat === 'Skirts') return true;

  // Subcategory feminine-only detection (matches ai.service.ts + capsuleEngine)
  const isDress = sub.endsWith('dress');
  const isSkirt = sub.includes('skirt');
  const isBlouse = sub.includes('blouse');
  const isGown = sub.includes('gown');
  const isHeels =
    (sub.includes('heel') && !nm.includes('heel tab')) ||
    sub.includes('stiletto') ||
    sub.includes('pump') ||
    sub.includes('slingback') ||
    sub.includes('mary jane');
  const isBalletFlat =
    sub.includes('ballet flat') ||
    (nm.includes('ballet') && nm.includes('flat'));
  const isEarring = sub.includes('earring') || nm.includes('earring');
  const isBracelet = sub.includes('bracelet') || nm.includes('bracelet');
  const isAnklet = sub.includes('anklet') || nm.includes('anklet');
  const isPurse =
    sub.includes('purse') ||
    sub.includes('handbag') ||
    sub.includes('clutch') ||
    nm.includes('purse') ||
    nm.includes('handbag');

  return (
    isDress ||
    isSkirt ||
    isBlouse ||
    isGown ||
    isHeels ||
    isBalletFlat ||
    isEarring ||
    isBracelet ||
    isAnklet ||
    isPurse
  );
}

/**
 * Infer implicit presentation from wardrobe composition when no style profile exists.
 * Returns 'feminine' if ≥70% of non-accessory items are feminine-coded,
 * 'masculine' if ≤5%, or null if genuinely mixed or too few items.
 */
export function inferImplicitPresentation(
  items: {
    main_category?: string;
    category?: string;
    subcategory?: string;
    name?: string;
  }[],
): UserPresentation | null {
  const wearable = items.filter((item) => {
    const cat = (item.main_category || item.category || '').toLowerCase();
    return cat !== 'accessories' && cat !== 'jewelry' && cat !== 'bags';
  });
  if (wearable.length < 5) return null;
  const feminineCount = wearable.filter((item) =>
    isFeminineItem(
      item.main_category || item.category || '',
      item.subcategory || '',
      item.name || '',
    ),
  ).length;
  const ratio = feminineCount / wearable.length;
  if (ratio >= 0.7) return 'feminine';
  if (ratio <= 0.05) return 'masculine';
  return null;
}

/** Build the gender directive string for LLM prompts. */
export function buildGenderDirective(presentation: UserPresentation): string {
  if (presentation === 'masculine')
    return `\n════════════════════════\nGENDER CONTEXT\n════════════════════════\nThis user presents masculine. NEVER include dresses, skirts, gowns, blouses, heels, ballet flats, purses, or any feminine-coded garments. Only use items from the wardrobe list provided.\n`;
  if (presentation === 'feminine')
    return `\n════════════════════════\nGENDER CONTEXT\n════════════════════════\nThis user presents feminine. Dresses, skirts, and all feminine garments are allowed and encouraged when appropriate.\n`;
  return ''; // mixed → no additional guidance
}
