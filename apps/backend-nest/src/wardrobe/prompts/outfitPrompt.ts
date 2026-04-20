// apps/backend-nest/src/wardrobe/prompts/outfitPrompt.ts

import { parseConstraints } from '../logic/constraints';
import { STYLE_AGENTS } from '../logic/style-agents';
import type { StudioContext } from '../logic/studioContext';

export function buildOutfitPrompt(
  catalogLines: string,
  userQuery: string,
  styleAgent?: string,
  userStyleProfile?: any, // 👈 pass this in too
  genderDirective?: string, // Layer 2 defense-in-depth
  // Studio-authoritative overrides. When provided, the builder SKIPS
  // its internal parseConstraints() / intent-regex derivations so the
  // caller (Studio slow path) remains the single source of truth.
  studioOverrides?: {
    constraints?: any;
    studio?: StudioContext;
  },
): string {
  const constraints =
    studioOverrides?.constraints ?? parseConstraints(userQuery);
  const constraintsLine = JSON.stringify(constraints);

  const studio = studioOverrides?.studio;
  const s = (userQuery || '').toLowerCase();
  const gymIntent = studio
    ? studio.environment === 'gym'
    : /\b(gym|work ?out|workout|training|exercise)\b/.test(s);
  const upscaleIntent = studio
    ? studio.environment === 'upscale'
    : /\b(upscale|smart\s*casual|business|formal|dressy|rooftop)\b/.test(s);

  let styleContextLine = '';

  if (styleAgent && STYLE_AGENTS[styleAgent]) {
    // 🟢 Style Agent mode = stylist preset
    const a = STYLE_AGENTS[styleAgent];
    styleContextLine = `
STYLE AGENT ACTIVE: "${a.name}"
TASTES & BIASES:
- Preferred colors: ${a.preferredColors?.join(', ') || 'n/a'}
- Favorite brands: ${a.favoriteBrands?.join(', ') || 'n/a'}
- Dress bias: ${a.dressBias || 'n/a'}
- Style keywords: ${a.styleKeywords?.join(', ') || 'n/a'}
- Lifestyle: ${a.lifestyle?.join(', ') || 'n/a'}
- Fashion goals: ${a.fashionGoals?.join(', ') || 'n/a'}
(Always reflect this stylist’s taste — overrides the user profile.)
    `.trim();
  } else if (userStyleProfile) {
    // 🟢 Default mode = user's own style profile (all approved signals)
    const profileLines: string[] = [];
    if (userStyleProfile.preferredColors?.length)
      profileLines.push(
        `- Preferred colors: ${userStyleProfile.preferredColors.join(', ')}`,
      );
    if (userStyleProfile.favoriteBrands?.length)
      profileLines.push(
        `- Preferred brands: ${userStyleProfile.favoriteBrands.join(', ')}`,
      );
    if (userStyleProfile.occasions?.length)
      profileLines.push(
        `- Typical occasions: ${userStyleProfile.occasions.join(', ')}`,
      );
    if (userStyleProfile.avoidSubcategories?.length)
      profileLines.push(
        `- Disliked styles (avoid): ${userStyleProfile.avoidSubcategories.join(', ')}`,
      );
    if (userStyleProfile.stylePreferences?.length)
      profileLines.push(
        `- Style preferences: ${userStyleProfile.stylePreferences.join(', ')}`,
      );
    if (userStyleProfile.styleKeywords?.length)
      profileLines.push(
        `- Style keywords: ${userStyleProfile.styleKeywords.join(', ')}`,
      );
    if (userStyleProfile.fitPreferences?.length)
      profileLines.push(
        `- Fit preferences: ${userStyleProfile.fitPreferences.join(', ')}`,
      );
    if (userStyleProfile.fabricPreferences?.length)
      profileLines.push(
        `- Fabric preferences: ${userStyleProfile.fabricPreferences.join(', ')}`,
      );
    if (userStyleProfile.climate)
      profileLines.push(`- Climate: ${userStyleProfile.climate}`);
    if (userStyleProfile.dressBias)
      profileLines.push(`- Dress bias: ${userStyleProfile.dressBias}`);

    // P0 hard vetoes — LLM must respect
    if (userStyleProfile.coverageNoGo?.length)
      profileLines.push(
        `HARD RULE — Coverage restrictions (NEVER include items violating these): ${userStyleProfile.coverageNoGo.join(', ')}`,
      );
    if (userStyleProfile.avoidColors?.length)
      profileLines.push(
        `HARD RULE — NEVER use these colors: ${userStyleProfile.avoidColors.join(', ')}`,
      );
    if (userStyleProfile.avoidMaterials?.length)
      profileLines.push(
        `HARD RULE — NEVER use these materials: ${userStyleProfile.avoidMaterials.join(', ')}`,
      );
    if (userStyleProfile.formalityFloor)
      profileLines.push(
        `HARD RULE — Minimum formality: ${userStyleProfile.formalityFloor} (never suggest items below this level)`,
      );
    if (
      userStyleProfile.walkabilityRequirement &&
      userStyleProfile.walkabilityRequirement !== 'Low'
    )
      profileLines.push(
        `HARD RULE — Walkability requirement: ${userStyleProfile.walkabilityRequirement} (avoid impractical footwear)`,
      );

    // P1 soft preferences
    if (userStyleProfile.patternPreferences?.length)
      profileLines.push(
        `- Preferred patterns: ${userStyleProfile.patternPreferences.join(', ')}`,
      );
    if (userStyleProfile.avoidPatterns?.length)
      profileLines.push(
        `- Avoided patterns: ${userStyleProfile.avoidPatterns.join(', ')}`,
      );
    if (userStyleProfile.silhouettePreference)
      profileLines.push(
        `- Silhouette preference: ${userStyleProfile.silhouettePreference}`,
      );

    if (profileLines.length > 0) {
      styleContextLine = `
USER STYLE PROFILE (use as primary guidance — treat as strong signals):
${profileLines.join('\n')}
Prioritize items matching these preferences. Avoid items matching disliked styles.
      `.trim();
    }
  }

  return `
You are a world-class personal stylist.

CATALOG (use ONLY these items by numeric index):
${catalogLines}

USER REQUEST: "${userQuery || 'no explicit request'}"
PARSED_CONSTRAINTS: ${constraintsLine}
${styleContextLine}
CONTEXT_HINTS: ${
    studio
      ? JSON.stringify({ environment: studio.environment })
      : JSON.stringify({ gymIntent, upscaleIntent })
  }

SELECTION RULES (strict):
- Build 2–3 complete outfits using ONLY catalog indices.
- Each outfit MUST include:
  • Exactly ONE BOTTOM,
  • Exactly ONE pair of SHOES,
  • At least ONE TOP.
  Outerwear and accessories are optional.
- If a required slot is unavailable in the catalog, **still output the outfit with the available items and add a short "missing" note.**
- NEVER return an empty "outfits" array. If only 1 outfit is possible, output exactly 1.
- Prefer earlier indices (they are higher-ranked by the app).
- Do NOT invent items. The "items" array MUST contain numeric indices only.
- Do not repeat the same index within a single outfit.
- Outfits must strongly reflect STYLE_AGENT preferences (colors, brands, dressBias, styleKeywords, lifestyle, fashionGoals).
- Reject items that do not align with STYLE_AGENT unless no alternatives exist.


INTENT GUARDRAILS:
${
  studio
    ? (() => {
        switch (studio.environment) {
          case 'beach':
            return `- Beach/resort context:
  • Shorts allowed and preferred.
  • Sneakers / sandals / espadrilles allowed.
  • Linen / cotton preferred; avoid heavy wool / cashmere unless evening.
  • Do NOT enforce business formality.`;
          case 'gym':
            return `- Gym/training context: sneakers + athletic bottoms; avoid dress shoes / blazers / dress shirts.`;
          case 'black-tie':
            return `- Black-tie context: tux jackets / dress shirts / formal shoes only; block sneakers, shorts, t-shirts, hoodies.`;
          case 'wedding':
            return `- Wedding context: SmartCasual → Business; blazers, dress shoes preferred; avoid shorts, sneakers, hoodies.`;
          case 'upscale':
            return `- Upscale context: avoid hoodies / windbreakers / shorts unless clearly upscale.`;
          default:
            return `- Everyday context: balance comfort and polish; no specific restrictions.`;
        }
      })()
    : `- If gymIntent: sneakers + athletic bottoms, avoid dress shoes/blazers unless explicitly requested.
- If upscaleIntent: avoid hoodies/windbreakers/shorts unless clearly upscale.`
}

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "outfits": [
    {
      "title": "string",
      "items": [1,2,3],
      "why": "one concise sentence",
      "missing": "optional short note"
    }
  ]
}
${genderDirective || ''}`.trim();
}

//////////////////////

// // apps/backend-nest/src/wardrobe/prompts/outfitPrompt.ts

// import { parseConstraints } from '../logic/constraints';
// import { STYLE_AGENTS } from '../logic/style-agents';

// export function buildOutfitPrompt(
//   catalogLines: string,
//   userQuery: string,
//   styleAgent?: string, // 👈 add this arg
// ): string {
//   const constraints = parseConstraints(userQuery);
//   const constraintsLine = JSON.stringify(constraints);

//   const s = (userQuery || '').toLowerCase();
//   const gymIntent = /\b(gym|work ?out|workout|training|exercise)\b/.test(s);
//   const upscaleIntent =
//     /\b(upscale|smart\s*casual|business|formal|dressy|rooftop)\b/.test(s);

//   // 👇 Agent override text
//   let agentLine = '';
//   if (styleAgent && STYLE_AGENTS[styleAgent]) {
//     const a = STYLE_AGENTS[styleAgent];
//     agentLine = `
// STYLE AGENT ACTIVE: "${a.name}"

// TASTES & BIASES:
// - Preferred colors: ${a.preferredColors?.join(', ') || 'n/a'}
// - Favorite brands: ${a.favoriteBrands?.join(', ') || 'n/a'}
// - Dress bias: ${a.dressBias || 'n/a'}
// - Style keywords: ${a.styleKeywords?.join(', ') || 'n/a'}
// - Lifestyle: ${a.lifestyle?.join(', ') || 'n/a'}
// - Fashion goals: ${a.fashionGoals?.join(', ') || 'n/a'}
// (Always prefer items matching this stylist’s tastes, even over raw constraints.)
//     `.trim();
//   }

//   return `
// You are a world-class personal stylist.

// CATALOG (use ONLY these items by numeric index):
// ${catalogLines}

// USER REQUEST: "${userQuery || 'no explicit request'}"
// PARSED_CONSTRAINTS: ${constraintsLine}
// ${agentLine ? agentLine : ''}
// CONTEXT_HINTS: ${JSON.stringify({ gymIntent, upscaleIntent })}

// SELECTION RULES (strict):
// - Build 2–3 complete outfits using ONLY catalog indices.
// - Each outfit MUST include:
//   • Exactly ONE BOTTOM,
//   • Exactly ONE pair of SHOES,
//   • At least ONE TOP.
//   Outerwear and accessories are optional.
// - If a required slot is unavailable in the catalog, omit that slot from "items" and put a short note in "missing".
// - Prefer earlier indices (they are higher-ranked by the app).
// - Do NOT invent items. The "items" array MUST contain numeric indices only.
// - Do not repeat the same index within a single outfit.
// - Outfits must strongly reflect STYLE_AGENT preferences (colors, brands, dressBias, styleKeywords, lifestyle, fashionGoals).
// - Reject items that do not align with STYLE_AGENT unless no alternatives exist.

// SLOT DETECTION (by label keywords; case-insensitive):
// - TOPS: shirt, t-shirt, tee, polo, sweater, knit, henley, hoodie.
// - BOTTOMS: trouser, pants, jeans, chinos, shorts, jogger, sweatpant.
// - SHOES: sneaker, trainer, loafer, boot, oxford, derby, dress shoe, sandal.
// - OUTERWEAR: blazer, sport coat, jacket, coat, trench, parka, windbreaker.

// INTENT GUARDRAILS:
// - If CONTEXT_HINTS.gymIntent === true:
//   • Require sneakers in every outfit.
//   • Prefer shorts or joggers.
//   • Avoid loafers, dress shoes, blazers, and belts unless explicitly requested.
// - If CONTEXT_HINTS.upscaleIntent === true:
//   • Avoid hoodies, windbreakers, shorts, and casual jeans unless clearly dressy.
//   • Prefer footwear aligned to the dress intent.

// OUTPUT FORMAT (STRICT JSON ONLY — no markdown, no code fences):
// {
//   "outfits": [
//     {
//       "title": "string",
//       "items": [1,2,3],
//       "why": "one concise sentence",
//       "missing": "optional short note"
//     }
//   ]
// }
// `.trim();
// }

/////////////////////////

// // apps/backend-nest/src/wardrobe/prompts/outfitPrompt.ts
// // outfitPrompt.ts — builds the strict JSON outfit prompt

// import { parseConstraints } from '../logic/constraints';

// export function buildOutfitPrompt(
//   catalogLines: string,
//   userQuery: string,
// ): string {
//   const constraints = parseConstraints(userQuery);
//   const constraintsLine = JSON.stringify(constraints);

//   const s = (userQuery || '').toLowerCase();
//   const gymIntent = /\b(gym|work ?out|workout|training|exercise)\b/.test(s);
//   const upscaleIntent =
//     /\b(upscale|smart\s*casual|business|formal|dressy|rooftop)\b/.test(s);

//   return `
// You are a world-class personal stylist.

// CATALOG (use ONLY these items by numeric index):
// ${catalogLines}

// USER REQUEST: "${userQuery}"
// PARSED_CONSTRAINTS: ${constraintsLine}
// CONTEXT_HINTS: ${JSON.stringify({ gymIntent, upscaleIntent })}

// SELECTION RULES (strict):
// - Build 2–3 complete outfits using ONLY catalog indices.
// - Each outfit MUST include:
//   • Exactly ONE BOTTOM,
//   • Exactly ONE pair of SHOES,
//   • At least ONE TOP.
//   Outerwear and accessories are optional.
// - If a required slot is unavailable in the catalog, omit that slot from "items" and put a short note in "missing" (e.g., "no bottoms found").
// - Prefer earlier indices (they are higher-ranked by the app).
// - Do NOT invent items. The "items" array MUST contain numeric indices only (no text labels).
// - Do not repeat the same index within a single outfit.

// SLOT DETECTION (by label keywords; case-insensitive):
// - TOPS: shirt, t-shirt, tee, polo, sweater, knit, henley, hoodie (treat as top when no jacket is used).
// - BOTTOMS: trouser, pants, jeans, chinos, shorts, jogger, sweatpant.
// - SHOES: sneaker, trainer, loafer, boot, oxford, derby, dress shoe, sandal.
// - OUTERWEAR: blazer, sport coat, jacket, coat, trench, parka, windbreaker.

// INTENT GUARDRAILS:
// - If CONTEXT_HINTS.gymIntent === true:
//   • Require sneakers in every outfit.
//   • Prefer shorts or joggers; avoid trousers/jeans when shorts/joggers exist.
//   • Avoid loafers, dress shoes, blazers, and belts unless explicitly requested.
// - If CONTEXT_HINTS.upscaleIntent === true:
//   • Avoid hoodies, windbreakers, shorts, and casual jeans unless clearly dressy.
//   • Prefer footwear aligned to the dress intent (e.g., loafers/dress shoes for Business/SmartCasual; minimalist sneakers only for SmartCasual).

// OUTPUT FORMAT (STRICT JSON ONLY — no markdown, no code fences):
// {
//   "outfits": [
//     {
//       "title": "string",
//       "items": [1,2,3],  // TOP, BOTTOM, SHOES (+ optional outerwear/accessories)
//       "why": "one concise sentence",
//       "missing": "optional short note"
//     }
//   ]
// }
// `.trim();
// }
