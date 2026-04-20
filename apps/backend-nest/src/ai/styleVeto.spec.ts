import { isStylisticallyIncoherent, type VetoItem } from './styleVeto';

// ── Helpers ───────────────────────────────────────────────────────────────

const item = (slot: string, sub: string, name?: string): VetoItem => ({
  id: `${slot}-${sub}`,
  name: name ?? sub,
  subcategory: sub,
  main_category: slot,
});

const outfit = (...items: VetoItem[]) => ({ items });

// ── Rule 1: Tailored upper + athletic lower ──────────────────────────────

describe('Rule 1: Tailored upper + athletic lower', () => {
  it('rejects blazer + joggers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Blazer'),
        item('Bottoms', 'Joggers'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('TAILORED_UPPER_ATHLETIC_LOWER');
  });

  it('rejects dress shirt + gym shorts', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Dress Shirt'),
        item('Bottoms', 'Gym Shorts'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('TAILORED_UPPER_ATHLETIC_LOWER');
  });

  it('rejects suit jacket + sweatpants', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Outerwear', 'Suit Jacket'),
        item('Bottoms', 'Sweatpants'),
        item('Shoes', 'Loafers'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('TAILORED_UPPER_ATHLETIC_LOWER');
  });

  it('allows blazer + chinos', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Blazer'),
        item('Bottoms', 'Chinos'),
        item('Shoes', 'Loafers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });

  it('allows t-shirt + joggers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Joggers'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });
});

// ── Rule 2: Formal footwear + athletic lower ─────────────────────────────

describe('Rule 2: Formal footwear + athletic lower', () => {
  it('rejects oxfords + joggers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Joggers'),
        item('Shoes', 'Oxfords'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('FORMAL_FOOTWEAR_ATHLETIC_LOWER');
  });

  it('rejects dress shoes + sweatpants', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Polo'),
        item('Bottoms', 'Sweatpants'),
        item('Shoes', 'Dress Shoes'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('FORMAL_FOOTWEAR_ATHLETIC_LOWER');
  });

  it('allows sneakers + joggers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Joggers'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });

  it('allows loafers + chinos', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Polo'),
        item('Bottoms', 'Chinos'),
        item('Shoes', 'Loafers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });
});

// ── Rule 3: Formal context + exposed athleticwear ────────────────────────

describe('Rule 3: Formal context + exposed athleticwear', () => {
  it('rejects shorts for church', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Dress Shirt'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Loafers'),
      ),
      { query: 'church outfit' },
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('FORMAL_CONTEXT_EXPOSED_ATHLETIC');
  });

  it('rejects flip-flops for wedding', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Dress Shirt'),
        item('Bottoms', 'Trousers'),
        item('Shoes', 'Flip-Flops'),
      ),
      { query: 'wedding guest outfit' },
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('FORMAL_CONTEXT_EXPOSED_ATHLETIC');
  });

  it('rejects hoodie for interview', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Hoodie'),
        item('Bottoms', 'Jeans'),
        item('Shoes', 'Sneakers'),
      ),
      { query: 'interview outfit' },
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('FORMAL_CONTEXT_EXPOSED_ATHLETIC');
  });

  it('allows shorts for casual query', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Sneakers'),
      ),
      { query: 'casual weekend' },
    );
    expect(r.invalid).toBe(false);
  });

  it('allows slides for no-context query', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Slides'),
      ),
    );
    expect(r.invalid).toBe(false);
  });
});

// ── Rule 4: Tailored jacket + casual open footwear ───────────────────────

describe('Rule 4: Tailored jacket + casual open footwear', () => {
  it('rejects blazer + sandals', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Outerwear', 'Blazer'),
        item('Bottoms', 'Chinos'),
        item('Shoes', 'Sandals'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('TAILORED_JACKET_CASUAL_OPEN_FOOTWEAR');
  });

  it('rejects sport coat + flip-flops', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Outerwear', 'Sport Coat'),
        item('Bottoms', 'Trousers'),
        item('Shoes', 'Flip-Flops'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('TAILORED_JACKET_CASUAL_OPEN_FOOTWEAR');
  });

  it('allows blazer + loafers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Outerwear', 'Blazer'),
        item('Bottoms', 'Chinos'),
        item('Shoes', 'Loafers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });

  it('allows windbreaker + sandals', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Outerwear', 'Windbreaker'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Sandals'),
      ),
    );
    expect(r.invalid).toBe(false);
  });
});

// ── Rule 5: Covered formal upper + exposed casual lower ──────────────────

describe('Rule 5: Covered formal upper + bare-leg lower', () => {
  it('rejects blazer + mini skirt', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Blazer'),
        item('Bottoms', 'Mini Skirt'),
        item('Shoes', 'Heels'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('COVERED_FORMAL_UPPER_BARE_LEG_LOWER');
  });

  it('rejects dress shirt + shorts', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Dress Shirt'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('COVERED_FORMAL_UPPER_BARE_LEG_LOWER');
  });

  it('allows t-shirt + shorts', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'T-Shirt'),
        item('Bottoms', 'Shorts'),
        item('Shoes', 'Sneakers'),
      ),
    );
    expect(r.invalid).toBe(false);
  });

  it('allows blazer + trousers', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Blazer'),
        item('Bottoms', 'Trousers'),
        item('Shoes', 'Oxfords'),
      ),
    );
    expect(r.invalid).toBe(false);
  });
});

// ── Fail-open behavior ───────────────────────────────────────────────────

describe('Fail-open behavior', () => {
  it('passes empty outfit', () => {
    const r = isStylisticallyIncoherent({ items: [] });
    expect(r.invalid).toBe(false);
  });

  it('passes items with no metadata', () => {
    const r = isStylisticallyIncoherent({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    expect(r.invalid).toBe(false);
  });

  it('passes outfit with only one item', () => {
    const r = isStylisticallyIncoherent(outfit(item('Tops', 'Blazer')));
    expect(r.invalid).toBe(false);
  });
});

// ── Cross-demographic universality ───────────────────────────────────────

describe('Cross-demographic universality', () => {
  it('rejects blazer + joggers regardless of gender framing', () => {
    // This rule applies universally — no gender context needed
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Blazer', 'Navy Structured Blazer'),
        item('Bottoms', 'Joggers', 'Grey Cotton Joggers'),
        item('Shoes', 'Sneakers', 'White Sneakers'),
      ),
    );
    expect(r.invalid).toBe(true);
  });

  it('allows hoodie + joggers for any context without formal keyword', () => {
    const r = isStylisticallyIncoherent(
      outfit(
        item('Tops', 'Hoodie', 'Oversized Hoodie'),
        item('Bottoms', 'Joggers', 'Black Joggers'),
        item('Shoes', 'Sneakers', 'Running Shoes'),
      ),
      { query: 'something to wear to the grocery store' },
    );
    expect(r.invalid).toBe(false);
  });
});
