// apps/backend-nest/src/wardrobe/prompts/outfitPlanPrompt.ts
// STATELESS, DETERMINISTIC outfit planning engine
// NO personal preferences, NO learning, NO bias - pure constraints-based logic

/**
 * OutfitPlanSlot category type.
 * Matches PlanCategory in categoryMapping.ts.
 * ALL outfit-eligible slots are represented.
 */
export type OutfitPlanSlot = {
  category:
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
  description: string;
  formality?: number;
};

export type OutfitPlan = {
  title: string;
  slots: OutfitPlanSlot[];
};

export type OutfitPlanResponse = {
  outfits: OutfitPlan[];
};

// Derive formality from query keywords
export function deriveFormality(query: string): number {
  const q = query.toLowerCase();
  if (/\b(formal|business|interview|wedding|gala|black.?tie)\b/.test(q))
    return 9;
  if (/\b(smart.?casual|business.?casual|dinner|date|upscale)\b/.test(q))
    return 7;
  if (/\b(casual|everyday|relaxed|weekend|brunch)\b/.test(q)) return 4;
  if (/\b(gym|workout|athletic|exercise|training)\b/.test(q)) return 2;
  if (/\b(lounge|home|sleep|pajama)\b/.test(q)) return 1;
  return 5; // default middle
}

// Derive occasion from query
export function deriveOccasion(query: string): string | null {
  const q = query.toLowerCase();
  if (/\b(work|office|meeting|interview)\b/.test(q)) return 'work';
  if (/\b(date|dinner|restaurant)\b/.test(q)) return 'date';
  if (/\b(wedding|formal|gala)\b/.test(q)) return 'formal event';
  if (/\b(gym|workout|exercise|training)\b/.test(q)) return 'athletic';
  if (/\b(weekend|casual|everyday|errand)\b/.test(q)) return 'casual';
  if (/\b(party|club|night.?out)\b/.test(q)) return 'nightlife';
  if (/\b(beach|pool|vacation)\b/.test(q)) return 'vacation';
  return null;
}

// Derive season from query or weather
function deriveSeason(
  query: string,
  weather?: { temp_f?: number },
): string | null {
  const q = query.toLowerCase();
  if (/\b(winter|cold|freezing|snow)\b/.test(q)) return 'winter';
  if (/\b(summer|hot|warm|beach)\b/.test(q)) return 'summer';
  if (/\b(spring|mild)\b/.test(q)) return 'spring';
  if (/\b(fall|autumn|cool)\b/.test(q)) return 'fall';

  // Derive from temperature if provided
  if (weather?.temp_f !== undefined) {
    if (weather.temp_f < 40) return 'winter';
    if (weather.temp_f < 60) return 'fall';
    if (weather.temp_f < 75) return 'spring';
    return 'summer';
  }
  return null;
}

// Derive weather condition
function deriveWeather(
  query: string,
  weather?: { temp_f?: number; condition?: string },
): string | null {
  if (weather?.condition) return weather.condition;
  const q = query.toLowerCase();
  if (/\b(rain|rainy|wet)\b/.test(q)) return 'rainy';
  if (/\b(snow|snowy|snowing)\b/.test(q)) return 'snowy';
  if (/\b(hot|sunny|warm)\b/.test(q)) return 'warm';
  if (/\b(cold|freezing|chilly)\b/.test(q)) return 'cold';
  return null;
}

// Refinement action types - slot-level only, NO item names
export type RefinementAction = {
  keep_slots: string[]; // Categories to keep (e.g., ["Tops", "Shoes"])
  change_slots: string[]; // Categories to change (e.g., ["Bottoms"])
};

export function buildOutfitPlanPrompt(
  userQuery: string,
  options?: {
    styleAgent?: string; // ignored - no personalization
    userStyleProfile?: {
      preferredColors?: string[];
      favoriteBrands?: string[];
      styleKeywords?: string[];
      dressBias?: string;
      occasions?: string[];
      avoidSubcategories?: string[];
      stylePreferences?: string[];
      fitPreferences?: string[];
      fabricPreferences?: string[];
      climate?: string;
    } | null;
    weather?: {
      temp_f?: number;
      condition?: string;
      humidity?: number;
    };
    availableItems?: string[];
    refinementAction?: RefinementAction; // Slot-level only - NO item names ever
    genderDirective?: string; // Layer 2 defense-in-depth
  },
): string {
  const { weather, availableItems, refinementAction, genderDirective } =
    options || {};

  // Derive constraints from query
  const formality = deriveFormality(userQuery);
  const occasion = deriveOccasion(userQuery);
  const season = deriveSeason(userQuery, weather);
  const weatherCondition = deriveWeather(userQuery, weather);

  // Build constraints object
  const constraints: Record<string, unknown> = {
    formality,
  };
  if (occasion) constraints.occasion = occasion;
  if (weatherCondition) constraints.weather = weatherCondition;
  if (season) constraints.season = season;

  // Build available items constraint (for wardrobe filtering)
  let availableItemsConstraint = '';
  if (availableItems?.length) {
    availableItemsConstraint = `
WARDROBE CONSTRAINT (only use item types from this list):
${availableItems.join(', ')}`;
  }

  // Build refinement instruction - SLOT-LEVEL ONLY, NO ITEM NAMES
  let refinementInstruction = '';
  if (refinementAction && refinementAction.change_slots.length > 0) {
    refinementInstruction = `
REFINEMENT MODE:
- SKIP these categories (already selected, do not include in output): ${refinementAction.keep_slots.join(', ')}
- GENERATE NEW descriptions ONLY for: ${refinementAction.change_slots.join(', ')}
- Output ONLY the slots that need to change`;
  }

  // Build style profile soft guidance (all approved signals)
  const sp = options?.userStyleProfile as
    | Record<string, any>
    | null
    | undefined;
  let styleProfileBlock = '';
  if (sp) {
    const lines: string[] = [];
    if (sp.preferredColors?.length)
      lines.push(`- Preferred colors: ${sp.preferredColors.join(', ')}`);
    if (sp.favoriteBrands?.length)
      lines.push(`- Preferred brands: ${sp.favoriteBrands.join(', ')}`);
    if (sp.occasions?.length)
      lines.push(`- Typical occasions: ${sp.occasions.join(', ')}`);
    if (sp.avoidSubcategories?.length)
      lines.push(
        `- Disliked styles (avoid): ${sp.avoidSubcategories.join(', ')}`,
      );
    if (sp.stylePreferences?.length)
      lines.push(`- Style preferences: ${sp.stylePreferences.join(', ')}`);
    if (sp.styleKeywords?.length)
      lines.push(`- Style keywords: ${sp.styleKeywords.join(', ')}`);
    if (sp.fitPreferences?.length)
      lines.push(`- Fit preferences: ${sp.fitPreferences.join(', ')}`);
    if (sp.fabricPreferences?.length)
      lines.push(`- Fabric preferences: ${sp.fabricPreferences.join(', ')}`);
    if (sp.climate) lines.push(`- Climate: ${sp.climate}`);
    if (sp.dressBias) lines.push(`- Dress bias: ${sp.dressBias}`);

    // P0 hard vetoes — LLM must respect
    if (sp.coverageNoGo?.length)
      lines.push(
        `HARD RULE — Coverage restrictions (NEVER include items violating these): ${sp.coverageNoGo.join(', ')}`,
      );
    if (sp.avoidColors?.length)
      lines.push(
        `HARD RULE — NEVER use these colors: ${sp.avoidColors.join(', ')}`,
      );
    if (sp.avoidMaterials?.length)
      lines.push(
        `HARD RULE — NEVER use these materials: ${sp.avoidMaterials.join(', ')}`,
      );
    if (sp.formalityFloor)
      lines.push(
        `HARD RULE — Minimum formality: ${sp.formalityFloor} (never suggest items below this level)`,
      );
    if (sp.walkabilityRequirement && sp.walkabilityRequirement !== 'Low')
      lines.push(
        `HARD RULE — Walkability requirement: ${sp.walkabilityRequirement} (avoid impractical footwear)`,
      );

    // P1 soft preferences
    if (sp.patternPreferences?.length)
      lines.push(`- Preferred patterns: ${sp.patternPreferences.join(', ')}`);
    if (sp.avoidPatterns?.length)
      lines.push(`- Avoided patterns: ${sp.avoidPatterns.join(', ')}`);
    if (sp.silhouettePreference)
      lines.push(`- Silhouette preference: ${sp.silhouettePreference}`);

    if (lines.length > 0) {
      styleProfileBlock = `
STYLE PREFERENCES (soft guidance — prefer but do not override constraints):
${lines.join('\n')}`;
    }
  }

  return `SYSTEM: Stateless outfit planning engine. Generate exactly 3 ranked outfits. No commentary.

INPUT:
{
  "request": "${userQuery}",
  "constraints": ${JSON.stringify(constraints)}
}
${availableItemsConstraint}${refinementInstruction}${styleProfileBlock}${genderDirective || ''}

OUTPUT (JSON only):
{
  "outfits": [
    {
      "title": "Pick #1: [Safe/Classic choice]",
      "why": "One sentence explaining why this outfit works for the request",
      "slots": [
        {"category": "Tops", "description": "generic item", "formality": N},
        {"category": "Bottoms", "description": "generic item", "formality": N},
        {"category": "Shoes", "description": "generic item", "formality": N},
        {"category": "Outerwear", "description": "optional layer if appropriate", "formality": N},
        {"category": "Accessories", "description": "optional accessory if appropriate", "formality": N}
      ]
    },
    {
      "title": "Pick #2: [Different vibe — dress option if appropriate]",
      "why": "One sentence explaining the different approach",
      "slots": [
        {"category": "Dresses", "description": "midi dress in neutral tone", "formality": N},
        {"category": "Shoes", "description": "strappy sandals", "formality": N},
        {"category": "Accessories", "description": "statement earrings", "formality": N}
      ]
    },
    {
      "title": "Pick #3: [Wildcard/Bold choice]",
      "why": "One sentence explaining the creative twist",
      "slots": [...]
    }
  ]
}

RULES:
- Exactly 3 outfits: #1 safe, #2 different vibe, #3 controlled wildcard
- Each outfit MUST include a "why" field: one concise sentence explaining why this combination works
- Each outfit uses one of two STRUCTURES:
  A) SEPARATES: Tops + Bottoms + Shoes [+ Outerwear] [+ Accessories]
  B) ONE-PIECE: Dresses + Shoes [+ Outerwear] [+ Accessories]
- NEVER combine Tops+Bottoms with Dresses in the same outfit
- Activewear slots replace Tops+Bottoms for athletic/gym contexts
- Swimwear is a standalone slot for beach/pool contexts
- Valid categories: Tops, Bottoms, Dresses, Shoes, Outerwear, Accessories, Activewear, Swimwear, Undergarments, Other
- CRITICAL: If an item is a dress, gown, romper, or jumpsuit, its category MUST be 'Dresses', never 'Bottoms'
- Only omit Outerwear if weather/context makes it inappropriate (e.g., hot summer day)
- Only omit Accessories if none would enhance the outfit
- Prefer COMPLETE outfits with 3-5 items over minimal 2-item outfits
- Description: generic (e.g., "dark jeans", "white sneakers", "navy blazer", "light bomber jacket", "leather belt")
- No brands, no specific items, no images, no item names
- Formality 1-10 per slot
- JSON only, no extra text

QUALITY OVERRIDE (applies to all picks):
- Do NOT introduce changes that reduce overall outfit coherence, appropriateness, or quality
- If a variation would weaken the outfit, keep the stronger original element
- Never force a change just to appear different
- Prioritize contextual fit, balance, and good judgment over variation
- A strong Pick #1 repeated is better than a weak Pick #2 or Pick #3

PICK #2 DIFFERENT VIBE CONSTRAINTS (critical):
- MUST stay in the same formality band as Pick #1 (±1 level max)
- MUST reuse at least 2 core pieces from Pick #1
- MAY change only 1–2 elements (e.g., shoes, outerwear, color palette, OR silhouette)
- MUST respect mood, activity, and comfort signals from the request
- Must feel like "another way to wear this outfit," not a new aesthetic
- Do NOT switch aesthetic category (preppy stays preppy, streetwear stays streetwear)
- Do NOT introduce incompatible pieces (e.g., athletic shoes with tailored pants)
- Do NOT ignore practicality or comfort constraints

VARIATION DISTRIBUTION (critical):
- Avoid concentrating changes in a single category (e.g., only changing shoes)
- Ensure variation is distributed across major garment groups (tops, bottoms, shoes)
- Maintain visual and functional coherence across all picks
- Do not rely on minor pieces (accessories, outerwear) for primary differentiation

PICK #3 WILDCARD CONSTRAINTS (critical):
- MUST remain appropriate for the user's activity and weather
- MUST respect the user's style profile and preferences
- MUST reuse at least 2 pieces from Pick #1 or Pick #2
- MAY introduce only ONE experimental element (color, silhouette, texture, OR accessory)
- MUST be realistically wearable today (no costume, no theme shifts)
- Do NOT change the overall aesthetic category (casual stays casual, formal stays formal)
- Do NOT introduce incompatible formality levels (e.g., sneakers with suit)
- Do NOT ignore comfort or practicality constraints
- Think "edge of comfort zone" not "completely different person"`;
}

/**
 * START WITH ITEM PROMPT - PATH #2 ONLY
 * =====================================
 * This is an ISOLATED prompt builder for the "Start with 1 Item" flow.
 * It instructs the LLM to build ALL 3 outfits AROUND a specific centerpiece item.
 *
 * CRITICAL CONSTRAINTS:
 * - The centerpiece item MUST appear in ALL 3 outfits
 * - The LLM must NOT generate a slot for the centerpiece's category
 * - All outfits must be DESIGNED around the centerpiece, not have it appended
 */
/**
 * CenterpieceItem category type.
 * Matches PlanCategory in categoryMapping.ts.
 */
export type CenterpieceItem = {
  category:
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
  description: string; // e.g., "navy blue chinos", "white leather sneakers"
  color?: string;
  formality?: number;
  style?: string; // e.g., "casual", "preppy", "streetwear"
};

export function buildStartWithItemPrompt(
  userQuery: string,
  centerpieceItem: CenterpieceItem,
  options?: {
    weather?: {
      temp_f?: number;
      condition?: string;
      humidity?: number;
    };
    availableItems?: string[];
  },
): string {
  const { weather, availableItems } = options || {};

  // Derive constraints from query
  const formality = deriveFormality(userQuery);
  const occasion = deriveOccasion(userQuery);
  const season = deriveSeason(userQuery, weather);
  const weatherCondition = deriveWeather(userQuery, weather);

  // Build constraints object
  const constraints: Record<string, unknown> = {
    formality,
  };
  if (occasion) constraints.occasion = occasion;
  if (weatherCondition) constraints.weather = weatherCondition;
  if (season) constraints.season = season;

  // Build available items constraint (for wardrobe filtering)
  let availableItemsConstraint = '';
  if (availableItems?.length) {
    availableItemsConstraint = `
WARDROBE CONSTRAINT (only use item types from this list):
${availableItems.join(', ')}`;
  }

  // Determine which categories to generate (exclude centerpiece + structural complements)
  // All plan-visible categories (from canonical categoryMapping)
  const allCategories = [
    'Tops',
    'Bottoms',
    'Dresses',
    'Shoes',
    'Outerwear',
    'Accessories',
    'Activewear',
    'Swimwear',
    'Undergarments',
    'Other',
  ];
  const centerpieceCatLc = centerpieceItem.category.toLowerCase();
  const structuralExclusions = new Set<string>();
  structuralExclusions.add(centerpieceCatLc);
  if (centerpieceCatLc === 'dresses') {
    structuralExclusions.add('tops');
    structuralExclusions.add('bottoms');
  } else if (centerpieceCatLc === 'tops' || centerpieceCatLc === 'bottoms') {
    structuralExclusions.add('dresses');
  }
  const categoriesToGenerate = allCategories.filter(
    (c) => !structuralExclusions.has(c.toLowerCase()),
  );

  // Build centerpiece description
  const centerpieceDesc = [
    centerpieceItem.color,
    centerpieceItem.description,
    centerpieceItem.style ? `(${centerpieceItem.style} style)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `SYSTEM: Stateless outfit planning engine - START WITH ITEM MODE. Generate exactly 3 ranked outfits built AROUND a specific centerpiece item. No commentary.

CENTERPIECE ITEM (MUST be in ALL 3 outfits):
{
  "category": "${centerpieceItem.category}",
  "description": "${centerpieceDesc}",
  "formality": ${centerpieceItem.formality ?? formality}
}

INPUT:
{
  "request": "${userQuery}",
  "constraints": ${JSON.stringify(constraints)}
}
${availableItemsConstraint}

CRITICAL RULES:
1. The centerpiece ${centerpieceItem.category} is ALREADY SELECTED - do NOT generate a slot for ${centerpieceItem.category}
2. ALL 3 outfits must be designed to COMPLEMENT the centerpiece item
3. Match formality, color palette, and aesthetic to work WITH the centerpiece
4. Only generate slots for: ${categoriesToGenerate.join(', ')}

OUTPUT (JSON only):
{
  "outfits": [
    {
      "title": "Pick #1: [Safe/Classic pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining why these items complement the centerpiece",
      "slots": [
        {"category": "${categoriesToGenerate[0]}", "description": "item that complements centerpiece", "formality": N},
        {"category": "${categoriesToGenerate[1]}", "description": "item that complements centerpiece", "formality": N}
        // Include Outerwear/Accessories only if appropriate
      ]
    },
    {
      "title": "Pick #2: [Different vibe with the ${centerpieceItem.category}]",
      "why": "One sentence explaining the different styling approach",
      "slots": [...]
    },
    {
      "title": "Pick #3: [Creative pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining the creative pairing",
      "slots": [...]
    }
  ]
}

RULES:
- Exactly 3 outfits, all featuring the same centerpiece ${centerpieceItem.category}
- Each outfit MUST include a "why" field explaining the styling rationale
- DO NOT include a slot for ${centerpieceItem.category} (already selected)
- Each outfit needs: slots for categories EXCEPT ${centerpieceItem.category}
- Description: generic (e.g., "dark jeans", "white sneakers", "navy blazer")
- All items must COMPLEMENT the centerpiece: ${centerpieceDesc}
- Match colors, formality, and aesthetic to work with the centerpiece
- No brands, no specific items, no images, no item names
- Formality 1-10 per slot (match centerpiece formality: ${centerpieceItem.formality ?? formality})
- JSON only, no extra text

QUALITY OVERRIDE (applies to all picks):
- Every item must look GOOD with the centerpiece ${centerpieceItem.category}
- Do NOT suggest items that clash with the centerpiece's color or style
- Prioritize cohesive outfits over forced variety
- All 3 outfits should be genuinely wearable with the centerpiece

PICK #2 DIFFERENT VIBE CONSTRAINTS:
- MUST stay in the same formality band as Pick #1 (±1 level max)
- MUST change 1-2 items to create a different vibe
- MUST still complement the centerpiece ${centerpieceItem.category}

PICK #3 CREATIVE CONSTRAINTS:
- MAY introduce one experimental element
- MUST still work with the centerpiece ${centerpieceItem.category}
- MUST be realistically wearable
- Think "creative pairing" not "incompatible styling"`;
}

/**
 * START WITH ITEM PROMPT V2 - PATH #2 ONLY (EXTENDED)
 * ====================================================
 * This is an ISOLATED prompt builder for the "Start with 1 Item" flow.
 * V2 adds explicit support for mood chips and freeform text prompts.
 *
 * CRITICAL CONSTRAINTS:
 * - The centerpiece item MUST appear in ALL 3 outfits
 * - The LLM must NOT generate a slot for the centerpiece's category
 * - All outfits must be DESIGNED around the centerpiece, not have it appended
 * - Mood chips and freeform prompts are incorporated as styling intent
 *
 * THIS FUNCTION IS COMPLETELY ISOLATED FROM PATH #1.
 * DO NOT MODIFY buildOutfitPlanPrompt() - it is read-only.
 */
export type StartWithItemInputV2 = {
  centerpieceItem: CenterpieceItem;
  moodPrompts?: string[]; // e.g., ["Create an outfit with a confident vibe..."]
  freeformPrompt?: string; // User's typed/spoken intent
  weather?: {
    temp_f?: number;
    condition?: string;
    humidity?: number;
  };
  availableItems?: string[];
};

export function buildStartWithItemPromptV2(
  input: StartWithItemInputV2,
): string {
  const {
    centerpieceItem,
    moodPrompts,
    freeformPrompt,
    weather,
    availableItems,
  } = input;

  // Build combined styling intent from mood + freeform prompt
  const stylingIntentParts: string[] = [];

  if (moodPrompts && moodPrompts.length > 0) {
    // Extract mood keywords from mood prompts
    const moodKeywords = moodPrompts
      .map((p) => {
        // Extract the mood descriptor (e.g., "confident", "low-key", "playful")
        const match = p.match(/with (?:a |an )?(\w+(?:[- ]\w+)?)/i);
        return match ? match[1] : '';
      })
      .filter(Boolean);

    if (moodKeywords.length > 0) {
      stylingIntentParts.push(`Mood: ${moodKeywords.join(', ')}`);
    }
  }

  if (freeformPrompt && freeformPrompt.trim()) {
    stylingIntentParts.push(`User request: ${freeformPrompt.trim()}`);
  }

  const stylingIntent =
    stylingIntentParts.length > 0
      ? stylingIntentParts.join('. ')
      : 'Create a versatile, well-coordinated outfit';

  // Derive constraints (using local copies of helper functions to avoid coupling)
  const formality = deriveFormality(stylingIntent);
  const occasion = deriveOccasion(stylingIntent);
  const season = deriveSeason(stylingIntent, weather);
  const weatherCondition = deriveWeather(stylingIntent, weather);

  // Build constraints object
  const constraints: Record<string, unknown> = {
    formality: centerpieceItem.formality ?? formality,
  };
  if (occasion) constraints.occasion = occasion;
  if (weatherCondition) constraints.weather = weatherCondition;
  if (season) constraints.season = season;

  // Build available items constraint
  let availableItemsConstraint = '';
  if (availableItems?.length) {
    availableItemsConstraint = `
WARDROBE CONSTRAINT (only use item types from this list):
${availableItems.join(', ')}`;
  }

  // Determine which categories to generate (exclude centerpiece + structural complements)
  // All plan-visible categories (from canonical categoryMapping)
  const allCategories = [
    'Tops',
    'Bottoms',
    'Dresses',
    'Shoes',
    'Outerwear',
    'Accessories',
    'Activewear',
    'Swimwear',
    'Undergarments',
    'Other',
  ];
  const centerpieceCatLc = centerpieceItem.category.toLowerCase();
  const structuralExclusions = new Set<string>();
  structuralExclusions.add(centerpieceCatLc);
  if (centerpieceCatLc === 'dresses') {
    structuralExclusions.add('tops');
    structuralExclusions.add('bottoms');
  } else if (centerpieceCatLc === 'tops' || centerpieceCatLc === 'bottoms') {
    structuralExclusions.add('dresses');
  }
  const categoriesToGenerate = allCategories.filter(
    (c) => !structuralExclusions.has(c.toLowerCase()),
  );

  // Build centerpiece description
  const centerpieceDesc = [
    centerpieceItem.color,
    centerpieceItem.description,
    centerpieceItem.style ? `(${centerpieceItem.style} style)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Build mood instruction if moods selected
  let moodInstruction = '';
  if (moodPrompts && moodPrompts.length > 0) {
    moodInstruction = `
STYLING MOOD (apply to ALL 3 outfits):
${moodPrompts.join('\n')}`;
  }

  // Build user intent instruction if provided
  let userIntentInstruction = '';
  if (freeformPrompt && freeformPrompt.trim()) {
    userIntentInstruction = `
USER'S SPECIFIC REQUEST:
"${freeformPrompt.trim()}"
You MUST incorporate this request into ALL 3 outfits while maintaining the centerpiece.`;
  }

  return `SYSTEM: Stateless outfit planning engine - START WITH ITEM MODE V2. Generate exactly 3 ranked outfits built AROUND a specific centerpiece item, incorporating mood and user intent. No commentary.

CENTERPIECE ITEM (MUST be in ALL 3 outfits - NON-NEGOTIABLE):
{
  "category": "${centerpieceItem.category}",
  "description": "${centerpieceDesc}",
  "formality": ${centerpieceItem.formality ?? formality}
}
${moodInstruction}${userIntentInstruction}

INPUT:
{
  "styling_intent": "${stylingIntent}",
  "constraints": ${JSON.stringify(constraints)}
}
${availableItemsConstraint}

CRITICAL RULES:
1. The centerpiece ${centerpieceItem.category} is ALREADY SELECTED - do NOT generate a slot for ${centerpieceItem.category}
2. ALL 3 outfits must be designed to COMPLEMENT the centerpiece item
3. Match formality, color palette, and aesthetic to work WITH the centerpiece
4. Only generate slots for: ${categoriesToGenerate.join(', ')}
5. Apply the mood/intent to ALL items selected${
    moodPrompts?.length
      ? '\n6. Each outfit must reflect the specified mood(s): ' +
        moodPrompts
          .map((p) => p.match(/with (?:a |an )?(\w+)/i)?.[1])
          .filter(Boolean)
          .join(', ')
      : ''
  }

COMPOSITION REQUIREMENT (MANDATORY):
Each outfit MUST contain:
- The locked centerpiece (${centerpieceItem.category}) - already selected
- AT LEAST 2 complementary wardrobe items from DIFFERENT categories
- Forming a COMPLETE, wearable look (minimum 3 items total per outfit)

Do NOT generate:
- Single-item complements (centerpiece + 1 item only)
- Accessory-only fills (centerpiece + accessory only)
- Under-filled combinations

OUTPUT (JSON only):
{
  "outfits": [
    {
      "title": "Pick #1: [Safe/Classic pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining why these items complement the centerpiece",
      "slots": [
        {"category": "${categoriesToGenerate[0]}", "description": "item that complements centerpiece and mood", "formality": N},
        {"category": "${categoriesToGenerate[1]}", "description": "item that complements centerpiece and mood", "formality": N}
      ]
    },
    {
      "title": "Pick #2: [Different vibe with the ${centerpieceItem.category}]",
      "why": "One sentence explaining the different styling approach",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    },
    {
      "title": "Pick #3: [Creative pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining the creative pairing",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    }
  ]
}

RULES:
- Exactly 3 outfits, all featuring the same centerpiece ${centerpieceItem.category}
- Each outfit MUST include a "why" field explaining the styling rationale
- DO NOT include a slot for ${centerpieceItem.category} (already selected)
- Each outfit MUST have AT LEAST 2 slots (2 complementary items + centerpiece = 3+ total)
- Each slot category must be DISTINCT (no duplicate categories)
- Description: generic (e.g., "dark jeans", "white sneakers", "navy blazer")
- All items must COMPLEMENT the centerpiece: ${centerpieceDesc}
- Match colors, formality, and aesthetic to work with the centerpiece
- Apply mood/intent styling to item descriptions
- No brands, no specific items, no images, no item names
- Formality 1-10 per slot (match centerpiece formality: ${centerpieceItem.formality ?? formality})
- JSON only, no extra text

QUALITY OVERRIDE (applies to all picks):
- Every item must look GOOD with the centerpiece ${centerpieceItem.category}
- Do NOT suggest items that clash with the centerpiece's color or style
- Prioritize cohesive outfits over forced variety
- All 3 outfits should be genuinely wearable with the centerpiece
- Mood/intent should enhance, not override, outfit coherence

PICK #2 DIFFERENT VIBE CONSTRAINTS:
- MUST stay in the same formality band as Pick #1 (±1 level max)
- MUST change 1-2 items to create a different vibe
- MUST still complement the centerpiece ${centerpieceItem.category}
- MUST still reflect the mood/intent

PICK #3 CREATIVE CONSTRAINTS:
- MAY introduce one experimental element
- MUST still work with the centerpiece ${centerpieceItem.category}
- MUST still reflect the mood/intent
- MUST be realistically wearable
- Think "creative pairing" not "incompatible styling"`;
}

/**
 * PATH #2 COMPOSITION VALIDATOR
 * =============================
 * Validates that a PATH #2 outfit meets composition requirements:
 * - At least 3 items total (centerpiece + 2 complementary)
 * - Centerpiece is present
 * - At least 2 non-centerpiece items
 * - No duplicate categories
 * - All items have valid structure
 *
 * THIS IS ISOLATED FROM PATH #1. Do not use for PATH #1 validation.
 */
export type CompositionValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type OutfitForValidation = {
  outfit_id: string;
  title: string;
  items: Array<{
    id: string;
    main_category?: string;
    [key: string]: any;
  }>;
};

export function validateStartWithItemComposition(
  outfit: OutfitForValidation,
  centerpieceId: string,
  centerpieceCategory: string,
  outfitIndex: number,
): CompositionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rule 1: Minimum 3 items
  if (outfit.items.length < 3) {
    errors.push(
      `Outfit ${outfitIndex + 1} has only ${outfit.items.length} items (minimum 3 required)`,
    );
  }

  // Rule 2: Centerpiece must be present
  const hasCenterpiece = outfit.items.some((item) => item.id === centerpieceId);
  if (!hasCenterpiece) {
    errors.push(`Outfit ${outfitIndex + 1} is missing the centerpiece item`);
  }

  // Rule 3: At least 2 non-centerpiece items
  const nonCenterpieceItems = outfit.items.filter(
    (item) => item.id !== centerpieceId,
  );
  if (nonCenterpieceItems.length < 2) {
    errors.push(
      `Outfit ${outfitIndex + 1} has only ${nonCenterpieceItems.length} complementary items (minimum 2 required)`,
    );
  }

  // Rule 4: No duplicate categories
  const categories = outfit.items.map((item) =>
    item.main_category?.toLowerCase(),
  );
  const categorySet = new Set(categories.filter(Boolean));
  if (categorySet.size < categories.filter(Boolean).length) {
    errors.push(`Outfit ${outfitIndex + 1} has duplicate categories`);
  }

  // Rule 5: Check for accessory-only fills (centerpiece + only accessories)
  const nonAccessoryNonCenterpiece = nonCenterpieceItems.filter(
    (item) => item.main_category?.toLowerCase() !== 'accessories',
  );
  if (
    nonCenterpieceItems.length >= 2 &&
    nonAccessoryNonCenterpiece.length === 0
  ) {
    errors.push(
      `Outfit ${outfitIndex + 1} only has accessories as complementary items (need at least one core garment)`,
    );
  }

  // Rule 6: All items must have an ID
  const itemsWithoutId = outfit.items.filter((item) => !item.id);
  if (itemsWithoutId.length > 0) {
    errors.push(
      `Outfit ${outfitIndex + 1} has ${itemsWithoutId.length} items without IDs`,
    );
  }

  // Warnings (non-fatal)
  if (outfit.items.length === 3) {
    warnings.push(
      `Outfit ${outfitIndex + 1} has minimum items (3) - consider adding more variety`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates all outfits in a PATH #2 response
 * Returns aggregated validation result
 */
export function validateStartWithItemResponse(
  outfits: OutfitForValidation[],
  centerpieceId: string,
  centerpieceCategory: string,
): CompositionValidationResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Must have exactly 3 outfits
  if (outfits.length !== 3) {
    allErrors.push(`Expected 3 outfits, got ${outfits.length}`);
  }

  // Validate each outfit
  for (let i = 0; i < outfits.length; i++) {
    const result = validateStartWithItemComposition(
      outfits[i],
      centerpieceId,
      centerpieceCategory,
      i,
    );
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ============================================================================
// PATH #2 INTENT MODE EXCLUSIVITY (V3)
// ============================================================================
// Implements mutual exclusivity between mood chips and voice/text input.
// Users MUST choose EXACTLY ONE intent mode. No silent merging. No fallback.
// THIS IS COMPLETELY ISOLATED FROM PATH #1.
// ============================================================================

/**
 * Intent modes for PATH #2
 * - "mood": User selected mood chip(s)
 * - "freeform": User typed or spoke a styling intent
 * - "neutral": Neither provided - use default styling
 */
export type IntentMode = 'mood' | 'freeform' | 'neutral';

/**
 * Normalized input for PATH #2 with enforced intent mode exclusivity
 */
export type NormalizedStartWithItemInput = {
  centerpieceItem: CenterpieceItem;
  intentMode: IntentMode;
  moods: string[] | null; // Only populated if intentMode === 'mood'
  freeformPrompt: string | null; // Only populated if intentMode === 'freeform'
  weather?: {
    temp_f?: number;
    condition?: string;
    humidity?: number;
  };
  availableItems?: string[];
  userStyleProfile?: Record<string, any>; // Approved style signals (soft guidance)
};

/**
 * Raw input before normalization (what the frontend sends)
 */
export type RawStartWithItemInput = {
  centerpieceItem: CenterpieceItem;
  moodPrompts?: string[];
  freeformPrompt?: string;
  weather?: {
    temp_f?: number;
    condition?: string;
    humidity?: number;
  };
  availableItems?: string[];
};

/**
 * MUTUAL EXCLUSION ERROR
 * Thrown when both mood chips and freeform prompt are provided.
 */
export class MutualExclusionError extends Error {
  constructor() {
    super(
      'MUTUAL_EXCLUSION_ERROR: Cannot combine mood chips with voice/text prompt. Choose one.',
    );
    this.name = 'MutualExclusionError';
  }
}

/**
 * Normalizes PATH #2 input and ENFORCES intent mode exclusivity.
 *
 * RULES:
 * - If moods.length > 0 AND freeformPrompt exists → throw MUTUAL_EXCLUSION_ERROR
 * - If moods.length > 0 → intentMode = "mood"
 * - If freeformPrompt.trim().length > 0 → intentMode = "freeform"
 * - Otherwise → intentMode = "neutral"
 *
 * THIS IS ISOLATED FROM PATH #1. Do not use for PATH #1.
 */
export function normalizeStartWithItemIntent(
  input: RawStartWithItemInput,
): NormalizedStartWithItemInput {
  const hasMoods = input.moodPrompts && input.moodPrompts.length > 0;
  const hasFreeform =
    input.freeformPrompt && input.freeformPrompt.trim().length > 0;

  // MUTUAL EXCLUSIVITY CHECK - fail closed
  if (hasMoods && hasFreeform) {
    throw new MutualExclusionError();
  }

  let intentMode: IntentMode;
  let moods: string[] | null = null;
  let freeformPrompt: string | null = null;

  if (hasMoods) {
    intentMode = 'mood';
    moods = input.moodPrompts!;
  } else if (hasFreeform) {
    intentMode = 'freeform';
    freeformPrompt = input.freeformPrompt!.trim();
  } else {
    intentMode = 'neutral';
  }

  return {
    centerpieceItem: input.centerpieceItem,
    intentMode,
    moods,
    freeformPrompt,
    weather: input.weather,
    availableItems: input.availableItems,
  };
}

/**
 * START WITH ITEM PROMPT V3 - PATH #2 ONLY (EXCLUSIVE INTENT MODE)
 * =================================================================
 * This is an ISOLATED prompt builder for the "Start with 1 Item" flow.
 * V3 enforces MUTUAL EXCLUSIVITY between mood chips and freeform prompts.
 *
 * CRITICAL CONSTRAINTS:
 * - Accepts NORMALIZED input only (use normalizeStartWithItemIntent first)
 * - Uses ONLY the active intent source (mood OR freeform OR neutral)
 * - NEVER mixes mood + freeform
 * - The centerpiece item MUST appear in ALL 3 outfits
 * - The LLM must NOT generate a slot for the centerpiece's category
 * - Composition requirements enforced (3+ items, 2+ complements)
 *
 * THIS FUNCTION IS COMPLETELY ISOLATED FROM PATH #1.
 * DO NOT MODIFY buildOutfitPlanPrompt() - it is read-only.
 */
export function buildStartWithItemPromptV3(
  input: NormalizedStartWithItemInput,
): string {
  const {
    centerpieceItem,
    intentMode,
    moods,
    freeformPrompt,
    weather,
    availableItems,
  } = input;

  // Build styling intent based on EXCLUSIVE mode
  let stylingIntent: string;
  let moodInstruction = '';
  let userIntentInstruction = '';

  switch (intentMode) {
    case 'mood':
      // MOOD MODE: Use only mood chips
      const moodKeywords = (moods || [])
        .map((p) => {
          const match = p.match(/with (?:a |an )?(\w+(?:[- ]\w+)?)/i);
          return match ? match[1] : '';
        })
        .filter(Boolean);

      stylingIntent =
        moodKeywords.length > 0
          ? `Mood: ${moodKeywords.join(', ')}`
          : 'Mood-based styling';

      moodInstruction = `
STYLING MOOD (apply to ALL 3 outfits - EXCLUSIVE MODE):
${(moods || []).join('\n')}

IMPORTANT: User selected mood chips. Do NOT incorporate any text prompt.`;
      break;

    case 'freeform':
      // FREEFORM MODE: Use only voice/text prompt
      stylingIntent = `User request: ${freeformPrompt}`;

      userIntentInstruction = `
USER'S SPECIFIC REQUEST (EXCLUSIVE MODE):
"${freeformPrompt}"

You MUST incorporate this request into ALL 3 outfits while maintaining the centerpiece.
IMPORTANT: This is the ONLY styling input. Do NOT add mood interpretations.`;
      break;

    case 'neutral':
    default:
      // NEUTRAL MODE: No specific styling, use balanced defaults
      stylingIntent = 'Create versatile, well-coordinated outfits';
      break;
  }

  // Derive constraints
  const formality = deriveFormality(stylingIntent);
  const occasion = deriveOccasion(stylingIntent);
  const season = deriveSeason(stylingIntent, weather);
  const weatherCondition = deriveWeather(stylingIntent, weather);

  // Build constraints object
  const constraints: Record<string, unknown> = {
    formality: centerpieceItem.formality ?? formality,
  };
  if (occasion) constraints.occasion = occasion;
  if (weatherCondition) constraints.weather = weatherCondition;
  if (season) constraints.season = season;

  // Build available items constraint
  let availableItemsConstraint = '';
  if (availableItems?.length) {
    availableItemsConstraint = `
WARDROBE CONSTRAINT (only use item types from this list):
${availableItems.join(', ')}`;
  }

  // Determine which categories to generate (exclude centerpiece + structural complements)
  // All plan-visible categories (from canonical categoryMapping)
  const allCategories = [
    'Tops',
    'Bottoms',
    'Dresses',
    'Shoes',
    'Outerwear',
    'Accessories',
    'Activewear',
    'Swimwear',
    'Undergarments',
    'Other',
  ];
  const centerpieceCatLc = centerpieceItem.category.toLowerCase();
  const structuralExclusions = new Set<string>();
  structuralExclusions.add(centerpieceCatLc);
  if (centerpieceCatLc === 'dresses') {
    structuralExclusions.add('tops');
    structuralExclusions.add('bottoms');
  } else if (centerpieceCatLc === 'tops' || centerpieceCatLc === 'bottoms') {
    structuralExclusions.add('dresses');
  }
  const categoriesToGenerate = allCategories.filter(
    (c) => !structuralExclusions.has(c.toLowerCase()),
  );

  // Build centerpiece description
  const centerpieceDesc = [
    centerpieceItem.color,
    centerpieceItem.description,
    centerpieceItem.style ? `(${centerpieceItem.style} style)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Build intent mode indicator for the prompt
  const intentModeLabel =
    intentMode === 'mood'
      ? 'MOOD CHIPS'
      : intentMode === 'freeform'
        ? 'VOICE/TEXT PROMPT'
        : 'NEUTRAL (DEFAULT)';

  return `SYSTEM: Stateless outfit planning engine - START WITH ITEM MODE V3. Generate exactly 3 ranked outfits built AROUND a specific centerpiece item. No commentary.

INTENT MODE: ${intentModeLabel}

CENTERPIECE ITEM (MUST be in ALL 3 outfits - NON-NEGOTIABLE):
{
  "category": "${centerpieceItem.category}",
  "description": "${centerpieceDesc}",
  "formality": ${centerpieceItem.formality ?? formality}
}
${moodInstruction}${userIntentInstruction}

INPUT:
{
  "styling_intent": "${stylingIntent}",
  "constraints": ${JSON.stringify(constraints)}
}
${availableItemsConstraint}

CRITICAL RULES:
1. The centerpiece ${centerpieceItem.category} is ALREADY SELECTED - do NOT generate a slot for ${centerpieceItem.category}
2. ALL 3 outfits must be designed to COMPLEMENT the centerpiece item
3. Match formality, color palette, and aesthetic to work WITH the centerpiece
4. Only generate slots for: ${categoriesToGenerate.join(', ')}
5. Use ONLY the specified intent mode (${intentModeLabel}) - do not mix or infer additional intent

COMPOSITION REQUIREMENT (MANDATORY):
Each outfit MUST contain:
- The locked centerpiece (${centerpieceItem.category}) - already selected
- AT LEAST 2 complementary wardrobe items from DIFFERENT categories
- Forming a COMPLETE, wearable look (minimum 3 items total per outfit)

Do NOT generate:
- Single-item complements (centerpiece + 1 item only)
- Accessory-only fills (centerpiece + accessory only)
- Under-filled combinations

OUTPUT (JSON only):
{
  "outfits": [
    {
      "title": "Pick #1: [Safe/Classic pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining why these items complement the centerpiece",
      "slots": [
        {"category": "${categoriesToGenerate[0]}", "description": "item that complements centerpiece", "formality": N},
        {"category": "${categoriesToGenerate[1]}", "description": "item that complements centerpiece", "formality": N}
      ]
    },
    {
      "title": "Pick #2: [Different vibe with the ${centerpieceItem.category}]",
      "why": "One sentence explaining the different styling approach",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    },
    {
      "title": "Pick #3: [Creative pairing for the ${centerpieceItem.category}]",
      "why": "One sentence explaining the creative pairing",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    }
  ]
}

RULES:
- Exactly 3 outfits, all featuring the same centerpiece ${centerpieceItem.category}
- Each outfit MUST include a "why" field explaining the styling rationale
- DO NOT include a slot for ${centerpieceItem.category} (already selected)
- Each outfit MUST have AT LEAST 2 slots (2 complementary items + centerpiece = 3+ total)
- Each slot category must be DISTINCT (no duplicate categories)
- Description: generic (e.g., "dark jeans", "white sneakers", "navy blazer")
- All items must COMPLEMENT the centerpiece: ${centerpieceDesc}
- Match colors, formality, and aesthetic to work with the centerpiece
- No brands, no specific items, no images, no item names
- Formality 1-10 per slot (match centerpiece formality: ${centerpieceItem.formality ?? formality})
- JSON only, no extra text

QUALITY OVERRIDE (applies to all picks):
- Every item must look GOOD with the centerpiece ${centerpieceItem.category}
- Do NOT suggest items that clash with the centerpiece's color or style
- Prioritize cohesive outfits over forced variety
- All 3 outfits should be genuinely wearable with the centerpiece

PICK #2 DIFFERENT VIBE CONSTRAINTS:
- MUST stay in the same formality band as Pick #1 (±1 level max)
- MUST change 1-2 items to create a different vibe
- MUST still complement the centerpiece ${centerpieceItem.category}

PICK #3 CREATIVE CONSTRAINTS:
- MAY introduce one experimental element
- MUST still work with the centerpiece ${centerpieceItem.category}
- MUST be realistically wearable
- Think "creative pairing" not "incompatible styling"`;
}

/**
 * Validates that the PATH #2 result respects the input intent mode.
 * This is a sanity check to ensure the LLM response aligns with the request.
 *
 * THIS IS ISOLATED FROM PATH #1. Do not use for PATH #1 validation.
 */
export type IntentModeValidationResult = {
  valid: boolean;
  errors: string[];
  intentMode: IntentMode;
};

export function validateStartWithItemIntentMode(
  input: NormalizedStartWithItemInput,
): IntentModeValidationResult {
  const errors: string[] = [];

  // Validate that the normalized input is internally consistent
  switch (input.intentMode) {
    case 'mood':
      if (!input.moods || input.moods.length === 0) {
        errors.push('Intent mode is "mood" but no moods provided');
      }
      if (input.freeformPrompt) {
        errors.push(
          'Intent mode is "mood" but freeformPrompt is present (should be null)',
        );
      }
      break;

    case 'freeform':
      if (!input.freeformPrompt || input.freeformPrompt.trim().length === 0) {
        errors.push('Intent mode is "freeform" but no freeformPrompt provided');
      }
      if (input.moods && input.moods.length > 0) {
        errors.push(
          'Intent mode is "freeform" but moods are present (should be null)',
        );
      }
      break;

    case 'neutral':
      if (input.moods && input.moods.length > 0) {
        errors.push('Intent mode is "neutral" but moods are present');
      }
      if (input.freeformPrompt && input.freeformPrompt.trim().length > 0) {
        errors.push('Intent mode is "neutral" but freeformPrompt is present');
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    intentMode: input.intentMode,
  };
}

// ============================================================================
// PATH #2 CENTERPIECE-FIRST PROMPT (V4)
// ============================================================================
// V4 enforces that the CENTERPIECE is the PRIMARY constraint.
// User input (mood or freeform) is ONLY a styling MODIFIER.
// The centerpiece ALWAYS wins over any user request.
// THIS IS COMPLETELY ISOLATED FROM PATH #1.
// ============================================================================

/**
 * START WITH ITEM PROMPT V4 - PATH #2 ONLY (CENTERPIECE-FIRST)
 * =============================================================
 * This is an ISOLATED prompt builder for the "Start with 1 Item" flow.
 * V4 enforces CENTERPIECE-FIRST semantics where:
 *
 * CRITICAL CONSTRAINTS:
 * 1. The centerpiece is the PRIMARY constraint - it overrides ALL user input
 * 2. User text (freeform) is ONLY a styling MODIFIER, not a replacement
 * 3. The centerpiece MUST appear in ALL 3 outfits - NON-NEGOTIABLE
 * 4. The LLM CANNOT override, ignore, or deprioritize the centerpiece
 * 5. Rogue generations that omit/replace centerpiece are rejected
 *
 * FREEFORM MODE BOUNDARY:
 * User text may ONLY describe: vibe, occasion, setting, tone, risk level, aesthetic
 * User text MUST NOT redefine: outfit core, main item, anchor piece, base garment
 *
 * THIS FUNCTION IS COMPLETELY ISOLATED FROM PATH #1.
 * DO NOT MODIFY buildOutfitPlanPrompt() - it is read-only.
 */
export function buildStartWithItemPromptV4(
  input: NormalizedStartWithItemInput,
): string {
  const {
    centerpieceItem,
    intentMode,
    moods,
    freeformPrompt,
    weather,
    availableItems,
    userStyleProfile,
  } = input;

  // Build style profile soft guidance (same pattern as PATH #1)
  const sp = userStyleProfile;
  let styleProfileBlock = '';
  if (sp) {
    const lines: string[] = [];
    if (sp.preferredColors?.length)
      lines.push(`- Preferred colors: ${sp.preferredColors.join(', ')}`);
    if (sp.favoriteBrands?.length)
      lines.push(`- Preferred brands: ${sp.favoriteBrands.join(', ')}`);
    if (sp.occasions?.length)
      lines.push(`- Typical occasions: ${sp.occasions.join(', ')}`);
    if (sp.avoidSubcategories?.length)
      lines.push(
        `- Disliked styles (avoid): ${sp.avoidSubcategories.join(', ')}`,
      );
    if (sp.stylePreferences?.length)
      lines.push(`- Style preferences: ${sp.stylePreferences.join(', ')}`);
    if (sp.styleKeywords?.length)
      lines.push(`- Style keywords: ${sp.styleKeywords.join(', ')}`);
    if (sp.fitPreferences?.length)
      lines.push(`- Fit preferences: ${sp.fitPreferences.join(', ')}`);
    if (sp.fabricPreferences?.length)
      lines.push(`- Fabric preferences: ${sp.fabricPreferences.join(', ')}`);
    if (sp.climate) lines.push(`- Climate: ${sp.climate}`);
    if (sp.dressBias) lines.push(`- Dress bias: ${sp.dressBias}`);
    if (lines.length > 0) {
      styleProfileBlock = `

STYLE PREFERENCES (soft guidance — prefer but do not override centerpiece or constraints):
${lines.join('\n')}`;
    }
  }

  // Derive constraints
  const formality = deriveFormality(freeformPrompt || '');
  const occasion = deriveOccasion(freeformPrompt || '');
  const season = deriveSeason(freeformPrompt || '', weather);
  const weatherCondition = deriveWeather(freeformPrompt || '', weather);

  // Build constraints object
  const constraints: Record<string, unknown> = {
    formality: centerpieceItem.formality ?? formality,
  };
  if (occasion) constraints.occasion = occasion;
  if (weatherCondition) constraints.weather = weatherCondition;
  if (season) constraints.season = season;

  // Build available items constraint
  let availableItemsConstraint = '';
  if (availableItems?.length) {
    availableItemsConstraint = `
WARDROBE CONSTRAINT (only use item types from this list):
${availableItems.join(', ')}`;
  }

  // Determine which categories to generate (exclude centerpiece + structural complements)
  // All plan-visible categories (from canonical categoryMapping)
  const allCategories = [
    'Tops',
    'Bottoms',
    'Dresses',
    'Shoes',
    'Outerwear',
    'Accessories',
    'Activewear',
    'Swimwear',
    'Undergarments',
    'Other',
  ];
  const centerpieceCatLc = centerpieceItem.category.toLowerCase();
  const structuralExclusions = new Set<string>();
  structuralExclusions.add(centerpieceCatLc);
  if (centerpieceCatLc === 'dresses') {
    structuralExclusions.add('tops');
    structuralExclusions.add('bottoms');
  } else if (centerpieceCatLc === 'tops' || centerpieceCatLc === 'bottoms') {
    structuralExclusions.add('dresses');
  }
  const categoriesToGenerate = allCategories.filter(
    (c) => !structuralExclusions.has(c.toLowerCase()),
  );

  // Build centerpiece description
  const centerpieceDesc = [
    centerpieceItem.color,
    centerpieceItem.description,
    centerpieceItem.style ? `(${centerpieceItem.style} style)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Build intent mode indicator for the prompt
  const intentModeLabel =
    intentMode === 'mood'
      ? 'MOOD CHIPS'
      : intentMode === 'freeform'
        ? 'VOICE/TEXT PROMPT'
        : 'NEUTRAL (DEFAULT)';

  // Build styling modifier section based on intent mode
  let stylingModifierSection = '';

  switch (intentMode) {
    case 'mood':
      // MOOD MODE: Moods are styling MODIFIERS to the centerpiece
      const moodKeywords = (moods || [])
        .map((p) => {
          const match = p.match(/with (?:a |an )?(\w+(?:[- ]\w+)?)/i);
          return match ? match[1] : '';
        })
        .filter(Boolean);

      stylingModifierSection = `
STYLING MODIFIER (apply to items AROUND the locked centerpiece):
Mood: ${moodKeywords.length > 0 ? moodKeywords.join(', ') : 'balanced'}
${(moods || []).join('\n')}

IMPORTANT: These moods describe HOW to style the outfit around the centerpiece.
They do NOT replace or override the centerpiece. The centerpiece is LOCKED.`;
      break;

    case 'freeform':
      // FREEFORM MODE: User text is a MODIFIER, not a replacement
      stylingModifierSection = `
STYLING MODIFIER (apply to items AROUND the locked centerpiece):
User's styling request: "${freeformPrompt}"

CRITICAL INTERPRETATION RULES:
1. This text describes HOW to style the outfit - vibe, occasion, setting, tone
2. This text does NOT replace the centerpiece
3. This text does NOT redefine the outfit core
4. This text is asking: "How should I style THIS ${centerpieceItem.category}?"
5. The centerpiece is the ANCHOR - user text is a MODIFIER only

FORBIDDEN INTERPRETATIONS:
- "Build a completely different outfit"
- "Ignore the centerpiece and do X instead"
- "The user wants Y item as the main piece"
- "Replace the ${centerpieceItem.category} with something else"

CORRECT INTERPRETATION:
- "Style the locked ${centerpieceItem.category} for [user's occasion/vibe]"
- "Build complementary items around THIS specific ${centerpieceItem.category}"`;
      break;

    case 'neutral':
    default:
      // NEUTRAL MODE: No modifier, just balanced styling around centerpiece
      stylingModifierSection = `
STYLING MODIFIER: None specified
Build balanced, versatile outfits around the locked centerpiece.`;
      break;
  }

  return `SYSTEM: Stateless outfit planning engine - START WITH ITEM MODE V4 (CENTERPIECE-FIRST). Generate exactly 3 ranked outfits built AROUND a LOCKED centerpiece item. No commentary.

========================
HARD SYSTEM DIRECTIVE (NON-NEGOTIABLE)
========================

The following item is LOCKED and MUST appear in ALL 3 outfits:

LOCKED CENTERPIECE:
{
  "category": "${centerpieceItem.category}",
  "description": "${centerpieceDesc}",
  "formality": ${centerpieceItem.formality ?? formality}
}

This is the PRIMARY CONSTRAINT. It CANNOT be:
- Omitted from any outfit
- Replaced with another item
- Deprioritized or "worked around"
- Overridden by any user request
- Treated as optional or negotiable

If ANY user request conflicts with this centerpiece, the CENTERPIECE WINS.

========================
INTENT MODE: ${intentModeLabel}
========================
${stylingModifierSection}

INPUT:
{
  "locked_centerpiece": "${centerpieceItem.category}: ${centerpieceDesc}",
  "constraints": ${JSON.stringify(constraints)}
}
${availableItemsConstraint}${styleProfileBlock}

CRITICAL RULES:
1. The centerpiece ${centerpieceItem.category} is LOCKED - do NOT generate a slot for ${centerpieceItem.category}
2. ALL 3 outfits MUST be designed to COMPLEMENT this specific centerpiece
3. User input (mood/text) modifies HOW you style around the centerpiece, NOT what the centerpiece is
4. Only generate slots for: ${categoriesToGenerate.join(', ')}
5. Every generated item must work WITH the locked ${centerpieceItem.category}

COMPOSITION REQUIREMENT (MANDATORY):
Each outfit MUST contain:
- The LOCKED centerpiece (${centerpieceItem.category}) - already selected, NON-NEGOTIABLE
- AT LEAST 2 complementary wardrobe items from DIFFERENT categories
- Forming a COMPLETE, wearable look (minimum 3 items total per outfit)

Do NOT generate:
- Single-item complements (centerpiece + 1 item only)
- Accessory-only fills (centerpiece + accessory only)
- Under-filled combinations

OUTPUT (JSON only):
{
  "outfits": [
    {
      "title": "Pick #1: [Safe/Classic styling for the ${centerpieceItem.category}]",
      "why": "One sentence explaining why these items complement the centerpiece",
      "slots": [
        {"category": "${categoriesToGenerate[0]}", "description": "item that complements the LOCKED centerpiece", "formality": N},
        {"category": "${categoriesToGenerate[1]}", "description": "item that complements the LOCKED centerpiece", "formality": N}
      ]
    },
    {
      "title": "Pick #2: [Different styling for the ${centerpieceItem.category}]",
      "why": "One sentence explaining the different styling approach",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    },
    {
      "title": "Pick #3: [Creative styling for the ${centerpieceItem.category}]",
      "why": "One sentence explaining the creative pairing",
      "slots": [
        {"category": "...", "description": "...", "formality": N},
        {"category": "...", "description": "...", "formality": N}
      ]
    }
  ]
}

RULES:
- Exactly 3 outfits, ALL featuring the LOCKED centerpiece ${centerpieceItem.category}
- Each outfit MUST include a "why" field explaining the styling rationale
- DO NOT include a slot for ${centerpieceItem.category} (already LOCKED)
- Each outfit MUST have AT LEAST 2 slots (2 complementary items + centerpiece = 3+ total)
- Each slot category must be DISTINCT (no duplicate categories)
- Description: generic (e.g., "dark jeans", "white sneakers", "navy blazer")
- All items must COMPLEMENT the LOCKED centerpiece: ${centerpieceDesc}
- Match colors, formality, and aesthetic to work with the centerpiece
- No brands, no specific items, no images, no item names
- Formality 1-10 per slot (match centerpiece formality: ${centerpieceItem.formality ?? formality})
- JSON only, no extra text

QUALITY OVERRIDE (applies to all picks):
- Every item must look GOOD with the LOCKED centerpiece ${centerpieceItem.category}
- Do NOT suggest items that clash with the centerpiece's color or style
- Prioritize cohesive outfits over forced variety
- All 3 outfits should be genuinely wearable with the centerpiece
- User styling preference should ENHANCE the centerpiece, not override it

PICK #2 DIFFERENT VIBE CONSTRAINTS:
- MUST stay in the same formality band as Pick #1 (±1 level max)
- MUST change 1-2 complementary items to create a different vibe
- MUST still complement the LOCKED centerpiece ${centerpieceItem.category}

PICK #3 CREATIVE CONSTRAINTS:
- MAY introduce one experimental complementary element
- MUST still work with the LOCKED centerpiece ${centerpieceItem.category}
- MUST be realistically wearable
- Think "creative styling" not "replacing the centerpiece"`;
}
