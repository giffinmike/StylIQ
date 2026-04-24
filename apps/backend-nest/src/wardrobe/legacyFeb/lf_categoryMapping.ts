// Copied verbatim from 7fd819b08:apps/backend-nest/src/wardrobe/logic/categoryMapping.ts
// Part of the LEGACY FEB OUTFITS strict-containment path.
// Do not import from wardrobe/logic/*, wardrobe/studio/*, or ai/*.

/**
 * CANONICAL Category → Slot Mapping Module
 *
 * This is the SINGLE SOURCE OF TRUTH for all category-to-slot mappings in the app.
 * All consumers (wardrobe.service, outfitPlanPrompt, feedbackFilters, etc.) MUST use this.
 *
 * DO NOT define category mappings elsewhere. Import from here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All 21 MainCategory values from the canonical taxonomy.
 * Matches: categoryTypes.ts, categories.json, create-wardrobe-item.dto.ts
 */
export type MainCategory =
  | 'Tops'
  | 'Bottoms'
  | 'Outerwear'
  | 'Shoes'
  | 'Accessories'
  | 'Undergarments'
  | 'Activewear'
  | 'Formalwear'
  | 'Loungewear'
  | 'Sleepwear'
  | 'Swimwear'
  | 'Maternity'
  | 'Unisex'
  | 'Costumes'
  | 'TraditionalWear'
  | 'Dresses'
  | 'Skirts'
  | 'Bags'
  | 'Headwear'
  | 'Jewelry'
  | 'Other';

/**
 * All possible Slot values for outfit assembly.
 * These are the internal buckets used for outfit generation and Pinecone filtering.
 */
export type Slot =
  | 'tops'
  | 'bottoms'
  | 'shoes'
  | 'outerwear'
  | 'accessories'
  | 'dresses'
  | 'activewear'
  | 'swimwear'
  | 'undergarments'
  | 'other';

/**
 * Plan categories - what the LLM can generate in outfit plans.
 * Subset that includes outerwear-generation-relevant slots.
 */
export type PlanCategory =
  | 'Tops'
  | 'Bottoms'
  | 'Dresses'
  | 'Shoes'
  | 'Outerwear'
  | 'Accessories'
  | 'Activewear'
  | 'Swimwear'
  | 'Undergarments'
  | 'Other';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Mappings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MAIN_CATEGORY_TO_SLOT: Maps ALL 21 MainCategories to their Slot.
 * Every MainCategory MUST have an entry - no undefined returns.
 *
 * Design decisions:
 * - Skirts → bottoms (worn in place of pants)
 * - Bags, Headwear, Jewelry → accessories (accessory-like items)
 * - Formalwear → dresses (suits/tuxedos are dress-code items, assemble like one-piece)
 * - TraditionalWear → dresses (kimonos, saris are dress-like one-piece items)
 * - Loungewear, Sleepwear, Maternity, Unisex, Costumes → other (specialized, not auto-included)
 */
export const MAIN_CATEGORY_TO_SLOT: Record<MainCategory, Slot> = {
  // Core outfit slots
  Tops: 'tops',
  Bottoms: 'bottoms',
  Shoes: 'shoes',
  Outerwear: 'outerwear',
  Accessories: 'accessories',
  Dresses: 'dresses',
  Activewear: 'activewear',
  Swimwear: 'swimwear',
  Undergarments: 'undergarments',

  // Mapped to core slots
  Skirts: 'bottoms', // Worn in place of pants/bottoms
  Bags: 'accessories', // Accessory-like
  Headwear: 'accessories', // Accessory-like
  Jewelry: 'accessories', // Accessory-like
  Formalwear: 'dresses', // Suits/tuxedos treated as one-piece formal
  TraditionalWear: 'dresses', // Kimonos, saris are dress-like

  // Specialized categories → 'other' bucket
  Loungewear: 'other',
  Sleepwear: 'other',
  Maternity: 'other',
  Unisex: 'other',
  Costumes: 'other',
  Other: 'other',
};

/**
 * SLOT_TO_MAIN_CATEGORIES: Reverse mapping for filtering.
 * For each slot, lists which MainCategories should match.
 */
export const SLOT_TO_MAIN_CATEGORIES: Record<Slot, readonly MainCategory[]> = {
  tops: ['Tops'],
  bottoms: ['Bottoms', 'Skirts'],
  shoes: ['Shoes'],
  outerwear: ['Outerwear'],
  accessories: ['Accessories', 'Bags', 'Headwear', 'Jewelry'],
  dresses: ['Dresses', 'Formalwear', 'TraditionalWear'],
  activewear: ['Activewear'],
  swimwear: ['Swimwear'],
  undergarments: ['Undergarments'],
  other: [
    'Loungewear',
    'Sleepwear',
    'Maternity',
    'Unisex',
    'Costumes',
    'Other',
  ],
};

/**
 * SLOT_TO_PINECONE_FILTER: Pinecone metadata filter for each slot.
 * Uses $in operator to match any of the MainCategories that map to this slot.
 * EVERY slot has a filter - no undefined returns.
 */
export const SLOT_TO_PINECONE_FILTER: Record<Slot, Record<string, any>> = {
  tops: { main_category: { $eq: 'Tops' } },
  bottoms: { main_category: { $in: ['Bottoms', 'Skirts'] } },
  shoes: { main_category: { $eq: 'Shoes' } },
  outerwear: { main_category: { $eq: 'Outerwear' } },
  accessories: {
    main_category: { $in: ['Accessories', 'Bags', 'Headwear', 'Jewelry'] },
  },
  dresses: {
    main_category: { $in: ['Dresses', 'Formalwear', 'TraditionalWear'] },
  },
  activewear: { main_category: { $eq: 'Activewear' } },
  swimwear: { main_category: { $eq: 'Swimwear' } },
  undergarments: { main_category: { $eq: 'Undergarments' } },
  other: {
    main_category: {
      $in: [
        'Loungewear',
        'Sleepwear',
        'Maternity',
        'Unisex',
        'Costumes',
        'Other',
      ],
    },
  },
};

/**
 * PLAN_CATEGORY_TO_SLOT: Maps LLM plan categories (PascalCase) to slots.
 */
export const PLAN_CATEGORY_TO_SLOT: Record<PlanCategory, Slot> = {
  Tops: 'tops',
  Bottoms: 'bottoms',
  Dresses: 'dresses',
  Shoes: 'shoes',
  Outerwear: 'outerwear',
  Accessories: 'accessories',
  Activewear: 'activewear',
  Swimwear: 'swimwear',
  Undergarments: 'undergarments',
  Other: 'other',
};

/**
 * SLOT_TO_PLAN_CATEGORY: Reverse mapping - slot to plan category.
 */
export const SLOT_TO_PLAN_CATEGORY: Record<Slot, PlanCategory> = {
  tops: 'Tops',
  bottoms: 'Bottoms',
  dresses: 'Dresses',
  shoes: 'Shoes',
  outerwear: 'Outerwear',
  accessories: 'Accessories',
  activewear: 'Activewear',
  swimwear: 'Swimwear',
  undergarments: 'Undergarments',
  other: 'Other',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a MainCategory to its Slot.
 * NEVER returns undefined - all 21 categories are mapped.
 * Handles null/undefined/empty gracefully by returning 'other'.
 */
export function mapMainCategoryToSlot(
  category: string | null | undefined,
): Slot {
  // Handle null/undefined/empty
  if (!category || typeof category !== 'string') return 'other';
  const trimmed = category.trim();
  if (!trimmed) return 'other';

  const slot = MAIN_CATEGORY_TO_SLOT[trimmed as MainCategory];
  if (slot) return slot;

  // Fallback: try case-insensitive match
  const normalized =
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  const slotNormalized = MAIN_CATEGORY_TO_SLOT[normalized as MainCategory];
  if (slotNormalized) return slotNormalized;

  // Ultimate fallback: 'other'
  console.warn(
    `[categoryMapping] Unknown category "${category}", defaulting to 'other'`,
  );
  return 'other';
}

/**
 * Maps an LLM plan category (PascalCase) to its Slot.
 */
export function mapPlanCategoryToSlot(planCategory: string): Slot {
  const slot = PLAN_CATEGORY_TO_SLOT[planCategory as PlanCategory];
  if (slot) return slot;

  // Try treating it as a MainCategory
  return mapMainCategoryToSlot(planCategory);
}

/**
 * Gets the Pinecone filter for a slot.
 * ALWAYS returns a filter - never undefined.
 */
export function pineconeFilterForSlot(slot: Slot): Record<string, any> {
  return SLOT_TO_PINECONE_FILTER[slot];
}

/**
 * Gets the Pinecone filter for a plan category (from LLM).
 * ALWAYS returns a filter.
 */
export function pineconeFilterForPlanCategory(
  planCategory: string,
): Record<string, any> {
  const slot = mapPlanCategoryToSlot(planCategory);
  return pineconeFilterForSlot(slot);
}

/**
 * Returns true if this slot is eligible for auto-inclusion in outfits.
 * 'other' slot items are available but not auto-required.
 */
export function isOutfitEligibleSlot(slot: Slot): boolean {
  return slot !== 'other';
}

/**
 * Returns true if this MainCategory is eligible for outfit generation.
 */
export function isOutfitEligibleCategory(category: string): boolean {
  const slot = mapMainCategoryToSlot(category);
  return isOutfitEligibleSlot(slot);
}

/**
 * Gets all MainCategories that map to a given slot.
 */
export function getMainCategoriesForSlot(slot: Slot): readonly MainCategory[] {
  return SLOT_TO_MAIN_CATEGORIES[slot];
}

/**
 * Checks if a MainCategory string is valid.
 */
export function isValidMainCategory(
  category: string,
): category is MainCategory {
  return category in MAIN_CATEGORY_TO_SLOT;
}

/**
 * Gets all valid MainCategory values.
 */
export function getAllMainCategories(): MainCategory[] {
  return Object.keys(MAIN_CATEGORY_TO_SLOT) as MainCategory[];
}

/**
 * Gets all valid Slot values.
 */
export function getAllSlots(): Slot[] {
  return Object.keys(SLOT_TO_PINECONE_FILTER) as Slot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot-Based Item Helpers (for filtering without hardcoded category comparisons)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Item-like type for slot checking - only requires main_category field.
 */
type ItemLike = { main_category?: string | null };

/**
 * Checks if an item belongs to a specific slot.
 * Use this instead of: item.main_category === 'Tops'
 *
 * @example
 * // Instead of: item.main_category === 'Tops'
 * isSlot(item, 'tops')
 *
 * // Instead of: item.main_category === 'Bottoms' || item.main_category === 'Skirts'
 * isSlot(item, 'bottoms') // automatically includes Skirts
 */
export function isSlot(item: ItemLike, slot: Slot): boolean {
  return mapMainCategoryToSlot(item.main_category) === slot;
}

/**
 * Checks if an item belongs to any of the specified slots.
 *
 * @example
 * isAnySlot(item, ['tops', 'dresses']) // true if top or dress
 */
export function isAnySlot(item: ItemLike, slots: Slot[]): boolean {
  const itemSlot = mapMainCategoryToSlot(item.main_category);
  return slots.includes(itemSlot);
}

/**
 * Gets the slot of an item.
 *
 * @example
 * const slot = getSlot(item); // 'tops', 'bottoms', etc.
 */
export function getSlot(item: ItemLike): Slot {
  return mapMainCategoryToSlot(item.main_category);
}

/**
 * Checks if an item's main_category exactly matches a given category.
 * This is for subcategory-level checks where slot mapping is too broad.
 * Use sparingly - prefer isSlot() for most cases.
 *
 * @example
 * // For Loafers enforcement where you need specifically 'Shoes', not the slot
 * isMainCategory(item, 'Shoes')
 */
export function isMainCategory(
  item: ItemLike,
  category: MainCategory,
): boolean {
  if (!item.main_category) return false;
  return (
    item.main_category === category ||
    item.main_category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Filter items by slot.
 *
 * @example
 * const tops = filterBySlot(catalog, 'tops');
 * const bottoms = filterBySlot(catalog, 'bottoms'); // includes Skirts
 */
export function filterBySlot<T extends ItemLike>(items: T[], slot: Slot): T[] {
  return items.filter((item) => isSlot(item, slot));
}

/**
 * Group items by their slot.
 *
 * @example
 * const grouped = groupBySlot(catalog);
 * // { tops: [...], bottoms: [...], shoes: [...], ... }
 */
export function groupBySlot<T extends ItemLike>(items: T[]): Record<Slot, T[]> {
  const result: Record<Slot, T[]> = {
    tops: [],
    bottoms: [],
    shoes: [],
    outerwear: [],
    accessories: [],
    dresses: [],
    activewear: [],
    swimwear: [],
    undergarments: [],
    other: [],
  };

  for (const item of items) {
    const slot = getSlot(item);
    result[slot].push(item);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refinement Keywords (for parsing user refinement text)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keywords for detecting category intent in refinement text.
 * Used by refinement parser to determine which slots user wants to change.
 */
export const REFINEMENT_CATEGORY_KEYWORDS: Record<Slot, readonly string[]> = {
  tops: [
    'shirt',
    'top',
    'tee',
    't-shirt',
    'blouse',
    'sweater',
    'hoodie',
    'cardigan',
    'polo',
    'tank',
    'camisole',
    'tunic',
    'henley',
  ],
  bottoms: [
    'pants',
    'jeans',
    'shorts',
    'trousers',
    'bottom',
    'chinos',
    'skirt',
    'joggers',
    'leggings',
    'culottes',
    'slacks',
  ],
  dresses: [
    'dress',
    'gown',
    'romper',
    'jumpsuit',
    'midi',
    'maxi',
    'mini dress',
    'cocktail',
    'evening',
  ],
  shoes: [
    'shoes',
    'sneakers',
    'boots',
    'loafers',
    'sandals',
    'heels',
    'footwear',
    'oxfords',
    'flats',
    'mules',
    'pumps',
    'trainers',
  ],
  outerwear: [
    'jacket',
    'coat',
    'blazer',
    'outerwear',
    'windbreaker',
    'puffer',
    'cardigan',
    'vest',
    'parka',
    'trench',
  ],
  accessories: [
    'belt',
    'accessory',
    'accessories',
    'watch',
    'hat',
    'scarf',
    'bag',
    'jewelry',
    'necklace',
    'bracelet',
    'earrings',
    'sunglasses',
    'tie',
  ],
  activewear: [
    'activewear',
    'athletic',
    'gym',
    'workout',
    'sports bra',
    'running',
    'training',
    'performance',
    'yoga',
    'leggings',
    'track',
  ],
  swimwear: [
    'swimwear',
    'bikini',
    'swimsuit',
    'swim trunks',
    'bathing suit',
    'rash guard',
    'cover-up',
    'one-piece',
    'beach',
  ],
  undergarments: [
    'underwear',
    'bra',
    'briefs',
    'boxers',
    'undershirt',
    'camisole',
    'shapewear',
    'socks',
    'panties',
    'lingerie',
    'thong',
  ],
  other: [
    'loungewear',
    'pajamas',
    'robe',
    'sleepwear',
    'costume',
    'maternity',
    'kimono',
    'saree',
  ],
};

/**
 * Detects which slot(s) are mentioned in refinement text.
 */
export function detectSlotsInText(text: string): Slot[] {
  const lowerText = text.toLowerCase();
  const detectedSlots: Slot[] = [];

  for (const [slot, keywords] of Object.entries(REFINEMENT_CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        if (!detectedSlots.includes(slot as Slot)) {
          detectedSlots.push(slot as Slot);
        }
        break; // Found one keyword for this slot, move to next slot
      }
    }
  }

  return detectedSlots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports for tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total number of MainCategories (for test assertions).
 */
export const MAIN_CATEGORY_COUNT = 21;

/**
 * Total number of Slots (for test assertions).
 */
export const SLOT_COUNT = 10;
