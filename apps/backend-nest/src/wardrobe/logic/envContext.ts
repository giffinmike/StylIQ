export type EnvContext = {
  climate: 'hot' | 'warm' | 'mild' | 'cool' | 'cold' | 'extreme' | 'unknown';
  setting:
    | 'beach'
    | 'gym'
    | 'wedding'
    | 'blacktie'
    | 'upscale'
    | 'casual'
    | 'travel'
    | 'formal'
    | 'unknown';
  formalityFloor?: number;
  formalityCeiling?: number;
};

const HOT_KEYWORDS = [
  'hot',
  'humid',
  'tropical',
  'miami',
  'mexico',
  'rooftop',
  'beach',
  'summer',
];

const COLD_KEYWORDS = [
  'freezing',
  'snow',
  'winter',
  'ski',
  'alpine',
  'tundra',
  'arctic',
];

const SETTING_KEYWORDS: ReadonlyArray<{
  setting: EnvContext['setting'];
  keywords: ReadonlyArray<string>;
}> = [
  { setting: 'blacktie', keywords: ['black tie', 'gala', 'tuxedo'] },
  { setting: 'wedding', keywords: ['wedding', 'ceremony'] },
  {
    setting: 'upscale',
    keywords: ['fine dining', 'upscale', 'michelin', 'rooftop dinner'],
  },
  { setting: 'formal', keywords: ['interview', 'formal', 'business meeting'] },
  { setting: 'beach', keywords: ['beach', 'sand', 'tropical', 'resort', 'yacht', 'pool'] },
  { setting: 'gym', keywords: ['gym', 'workout', 'training', 'athletic', 'fitness'] },
  { setting: 'travel', keywords: ['airport', 'flight', 'travel'] },
  { setting: 'casual', keywords: ['casual', 'brunch', 'picnic'] },
];

function climateFromTemp(tempF: number): EnvContext['climate'] {
  if (tempF >= 90) return 'hot';
  if (tempF >= 75) return 'warm';
  if (tempF >= 60) return 'mild';
  if (tempF >= 45) return 'cool';
  if (tempF >= 30) return 'cold';
  return 'extreme';
}

function containsAny(haystack: string, needles: ReadonlyArray<string>): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

export function parseEnvContext(
  query: string,
  weather?: { tempF?: number },
): EnvContext {
  const q = (query ?? '').toLowerCase();

  let climate: EnvContext['climate'] = 'unknown';
  if (typeof weather?.tempF === 'number' && Number.isFinite(weather.tempF)) {
    climate = climateFromTemp(weather.tempF);
  }

  if (containsAny(q, HOT_KEYWORDS)) {
    climate = 'hot';
  } else if (containsAny(q, COLD_KEYWORDS)) {
    climate = 'cold';
  }

  let setting: EnvContext['setting'] = 'unknown';
  for (const entry of SETTING_KEYWORDS) {
    if (containsAny(q, entry.keywords)) {
      setting = entry.setting;
      break;
    }
  }

  let formalityFloor: number | undefined;
  let formalityCeiling: number | undefined;
  switch (setting) {
    case 'blacktie':
      formalityFloor = 8;
      break;
    case 'wedding':
      formalityFloor = 6;
      break;
    case 'formal':
      formalityFloor = 6;
      break;
    case 'beach':
      formalityCeiling = 4;
      break;
    case 'gym':
      formalityCeiling = 3;
      break;
    default:
      break;
  }

  const result: EnvContext = { climate, setting };
  if (formalityFloor !== undefined) result.formalityFloor = formalityFloor;
  if (formalityCeiling !== undefined) result.formalityCeiling = formalityCeiling;
  return result;
}
