// apps/backend-nest/src/wardrobe/logic/studioContext.ts
//
// Single authoritative environment-intent axis for AI Outfit Studio.
// Derived once per request in generateOutfits() and threaded through
// every downstream scorer / validator. Additive and default-safe:
// absent `studio` in any consumer reproduces legacy behavior.

export type StudioEnvironment =
  | 'beach'
  | 'gym'
  | 'black-tie'
  | 'wedding'
  | 'upscale'
  | 'everyday';

export interface StudioContext {
  environment: StudioEnvironment;
  isBeachContext: boolean;
  isGymContext: boolean;
  isFormalContext: boolean;
  /**
   * When true, downstream scorers should suppress the user's persistent
   * dress-code bias (profile.dressBias). Environment dominates profile.
   * Color / brand / category / fit / fabric preferences remain active.
   */
  neutralizeProfileDressBias: boolean;
}

const BEACH_RE = /(beach|resort|coast|sandy|miami)/i;
const GYM_RE = /(gym|workout|training|athletic)/i;
const BLACK_TIE_RE = /(black\s*tie|gala|tuxedo)/i;
const WEDDING_RE = /(wedding)/i;
const UPSCALE_RE = /(upscale|fine\s*dining|luxury)/i;

export function deriveStudioContext(
  effectiveQuery: string,
  _constraints: any,
  _userStyle?: any,
): StudioContext {
  const q = (effectiveQuery || '').toString();

  let environment: StudioEnvironment = 'everyday';
  if (BEACH_RE.test(q)) environment = 'beach';
  else if (GYM_RE.test(q)) environment = 'gym';
  else if (BLACK_TIE_RE.test(q)) environment = 'black-tie';
  else if (WEDDING_RE.test(q)) environment = 'wedding';
  else if (UPSCALE_RE.test(q)) environment = 'upscale';

  const isBeachContext = environment === 'beach';
  const isGymContext = environment === 'gym';
  const isFormalContext =
    environment === 'black-tie' ||
    environment === 'wedding' ||
    environment === 'upscale';

  const neutralizeProfileDressBias =
    environment === 'beach' ||
    environment === 'gym' ||
    environment === 'black-tie';

  return {
    environment,
    isBeachContext,
    isGymContext,
    isFormalContext,
    neutralizeProfileDressBias,
  };
}
