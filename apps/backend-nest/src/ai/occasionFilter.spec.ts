import {
  isOccasionAppropriate,
  getOccasionRejectionReason,
  isFormalOccasion,
  type OccasionItem,
} from './occasionFilter';

// ── Helpers ───────────────────────────────────────────────────────────────

const mkItem = (
  main_category: string,
  subcategory: string,
  extra: Partial<OccasionItem> = {},
): OccasionItem => ({
  id: `${main_category}-${subcategory}`,
  name: extra.name ?? subcategory,
  subcategory,
  main_category,
  ...extra,
});

const church = { query: 'church outfit' };
const wedding = { query: 'wedding guest' };
const interview = { query: 'job interview' };
const casual = { query: 'casual weekend look' };
const noCtx = {};

// ── Formal context detection ─────────────────────────────────────────────

describe('isFormalOccasion', () => {
  it.each([
    'church outfit',
    'wedding guest',
    'funeral attire',
    'job interview',
    'business meeting',
    'formal dinner',
    'ceremony look',
    'baptism',
    'black tie event',
  ])('detects "%s" as formal', (q) => {
    expect(isFormalOccasion({ query: q })).toBe(true);
  });

  it.each([
    'casual weekend',
    'grocery store run',
    'hanging out with friends',
    'date night',
    'brunch look',
  ])('does NOT detect "%s" as formal', (q) => {
    expect(isFormalOccasion({ query: q })).toBe(false);
  });

  it('returns false for empty/missing query', () => {
    expect(isFormalOccasion({})).toBe(false);
    expect(isFormalOccasion({ query: '' })).toBe(false);
  });
});

// ── Rule 1: Loud pattern tops ────────────────────────────────────────────

describe('Rule 1: Loud pattern tops', () => {
  it('rejects hawaiian shirt for church', () => {
    const item = mkItem('Tops', 'Hawaiian Shirt');
    expect(isOccasionAppropriate(item, church)).toBe(false);
    expect(getOccasionRejectionReason(item, church)).toBe('LOUD_PATTERN_TOP');
  });

  it('rejects tropical print top for wedding', () => {
    const item = mkItem('Tops', 'Tropical Print Shirt');
    expect(isOccasionAppropriate(item, wedding)).toBe(false);
  });

  it('rejects aloha shirt for interview', () => {
    const item = mkItem('Tops', 'Aloha Shirt');
    expect(isOccasionAppropriate(item, interview)).toBe(false);
  });

  it('allows hawaiian shirt for casual', () => {
    const item = mkItem('Tops', 'Hawaiian Shirt');
    expect(isOccasionAppropriate(item, casual)).toBe(true);
  });

  it('allows plain dress shirt for church', () => {
    const item = mkItem('Tops', 'Dress Shirt', { name: 'White Dress Shirt' });
    expect(isOccasionAppropriate(item, church)).toBe(true);
  });
});

// ── Rule 2: Loud tailoring colors ────────────────────────────────────────

describe('Rule 2: Loud tailoring colors', () => {
  it('rejects magenta blazer for church', () => {
    const item = mkItem('Outerwear', 'Blazer', {
      name: 'Magenta Blazer',
      color: 'Magenta',
    });
    expect(isOccasionAppropriate(item, church)).toBe(false);
    expect(getOccasionRejectionReason(item, church)).toBe(
      'LOUD_TAILORING_COLOR',
    );
  });

  it('rejects neon sport coat for wedding', () => {
    const item = mkItem('Outerwear', 'Sport Coat', {
      name: 'Neon Sport Coat',
      color: 'Neon Green',
    });
    expect(isOccasionAppropriate(item, wedding)).toBe(false);
  });

  it('rejects electric blue blazer for interview', () => {
    const item = mkItem('Outerwear', 'Blazer', {
      name: 'Electric Blue Blazer',
      color: 'Electric Blue',
    });
    expect(isOccasionAppropriate(item, interview)).toBe(false);
  });

  it('allows navy blazer for church', () => {
    const item = mkItem('Outerwear', 'Blazer', {
      name: 'Navy Blazer',
      color: 'Navy',
    });
    expect(isOccasionAppropriate(item, church)).toBe(true);
  });

  it('allows magenta blazer for casual', () => {
    const item = mkItem('Outerwear', 'Blazer', {
      name: 'Magenta Blazer',
      color: 'Magenta',
    });
    expect(isOccasionAppropriate(item, casual)).toBe(true);
  });

  it('does NOT reject magenta t-shirt (not tailoring)', () => {
    const item = mkItem('Tops', 'T-Shirt', {
      name: 'Magenta T-Shirt',
      color: 'Magenta',
    });
    expect(isOccasionAppropriate(item, church)).toBe(true);
  });
});

// ── Rule 3: Athletic casual tops ─────────────────────────────────────────

describe('Rule 3: Athletic casual tops', () => {
  it('rejects hoodie for church', () => {
    const item = mkItem('Tops', 'Hoodie');
    expect(isOccasionAppropriate(item, church)).toBe(false);
    expect(getOccasionRejectionReason(item, church)).toBe(
      'ATHLETIC_CASUAL_TOP',
    );
  });

  it('rejects graphic tee for interview', () => {
    const item = mkItem('Tops', 'Graphic Tee');
    expect(isOccasionAppropriate(item, interview)).toBe(false);
  });

  it('rejects tank top for wedding', () => {
    const item = mkItem('Tops', 'Tank Top');
    expect(isOccasionAppropriate(item, wedding)).toBe(false);
  });

  it('allows hoodie for casual', () => {
    const item = mkItem('Tops', 'Hoodie');
    expect(isOccasionAppropriate(item, casual)).toBe(true);
  });

  it('allows polo for church', () => {
    const item = mkItem('Tops', 'Polo', { name: 'Navy Polo' });
    expect(isOccasionAppropriate(item, church)).toBe(true);
  });
});

// ── Rule 4: Open casual footwear ─────────────────────────────────────────

describe('Rule 4: Open casual footwear', () => {
  it('rejects slides for church', () => {
    const item = mkItem('Shoes', 'Slides');
    expect(isOccasionAppropriate(item, church)).toBe(false);
    expect(getOccasionRejectionReason(item, church)).toBe(
      'OPEN_CASUAL_FOOTWEAR',
    );
  });

  it('rejects flip-flops for wedding', () => {
    const item = mkItem('Shoes', 'Flip-Flops');
    expect(isOccasionAppropriate(item, wedding)).toBe(false);
  });

  it('rejects sandals for interview', () => {
    const item = mkItem('Shoes', 'Sandals');
    expect(isOccasionAppropriate(item, interview)).toBe(false);
  });

  it('allows slides for casual', () => {
    const item = mkItem('Shoes', 'Slides');
    expect(isOccasionAppropriate(item, casual)).toBe(true);
  });

  it('allows loafers for church', () => {
    const item = mkItem('Shoes', 'Loafers', { name: 'Brown Loafers' });
    expect(isOccasionAppropriate(item, church)).toBe(true);
  });

  it('allows dress shoes for wedding', () => {
    const item = mkItem('Shoes', 'Oxfords', { name: 'Black Oxfords' });
    expect(isOccasionAppropriate(item, wedding)).toBe(true);
  });
});

// ── Fail-open behavior ───────────────────────────────────────────────────

describe('Fail-open behavior', () => {
  it('passes item with no metadata in formal context', () => {
    expect(isOccasionAppropriate({}, church)).toBe(true);
  });

  it('passes item with empty name in formal context', () => {
    expect(
      isOccasionAppropriate(
        { name: '', subcategory: '', main_category: '' },
        church,
      ),
    ).toBe(true);
  });

  it('passes all items when no query context', () => {
    const hoodie = mkItem('Tops', 'Hoodie');
    expect(isOccasionAppropriate(hoodie, noCtx)).toBe(true);
  });
});

// ── Cross-demographic universality ───────────────────────────────────────

describe('Cross-demographic universality', () => {
  it('rejects hawaiian shirt for any formal context regardless of framing', () => {
    const item = mkItem('Tops', 'Hawaiian Shirt', {
      name: 'Tropical Hawaiian Shirt',
    });
    expect(isOccasionAppropriate(item, { query: 'church' })).toBe(false);
    expect(isOccasionAppropriate(item, { query: 'funeral' })).toBe(false);
    expect(isOccasionAppropriate(item, { query: 'formal dinner' })).toBe(false);
  });

  it('allows standard appropriate items across all formal contexts', () => {
    const shirt = mkItem('Tops', 'Button-Down Shirt', {
      name: 'White Oxford Shirt',
    });
    const trousers = mkItem('Bottoms', 'Trousers', { name: 'Navy Trousers' });
    const shoes = mkItem('Shoes', 'Oxfords', { name: 'Black Oxfords' });
    for (const ctx of [church, wedding, interview]) {
      expect(isOccasionAppropriate(shirt, ctx)).toBe(true);
      expect(isOccasionAppropriate(trousers, ctx)).toBe(true);
      expect(isOccasionAppropriate(shoes, ctx)).toBe(true);
    }
  });
});
