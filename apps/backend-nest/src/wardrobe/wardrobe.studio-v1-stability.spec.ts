/**
 * AI Outfit Studio v1 – Elite Structural Stable
 *
 * Studio-owned regression spec that pins Studio's shipped post-curation
 * contract at the Studio call boundary in wardrobe.service.ts:
 *
 *   eliteOutfits = selectTopOutfits(eliteOutfits, judgeCtx);
 *
 * These tests validate the OUTPUT properties Studio depends on. They do NOT
 * change shared ai/* logic and they do NOT add randomness or new flags.
 *
 * Determinism:
 *   - No DB, no network, no timestamps, no Date.now, no Math.random.
 *   - All fixtures are static literals; selectTopOutfits is a pure function.
 *
 * Studio call boundary mirrored:
 *   Source: apps/backend-nest/src/wardrobe/wardrobe.service.ts (~L2534)
 *   Call:   selectTopOutfits(eliteOutfits, { requestedDressCode, query })
 *
 * NOTE: selectTopOutfits is imported strictly as a dependency (per the
 * Studio-scope rules: shared files are not modified, test lives under
 * wardrobe/, and tests assert Studio's contract — not styleJudge internals).
 */
import { selectTopOutfits } from '../ai/styleJudge';

// ─────────────────────────────────────────────────────────────────────────
// Fixture builders (deterministic, no randomness, no time)
// ─────────────────────────────────────────────────────────────────────────

type FixtureItem = {
  id: string;
  name: string;
  main_category: string; // Studio slot label, e.g. 'Tops' | 'Bottoms' | 'Shoes'
  subcategory: string;
  color: string;
};

type FixtureOutfit = {
  outfit_id: string;
  items: FixtureItem[];
};

const item = (
  id: string,
  main_category: string,
  subcategory: string,
  color: string,
  name?: string,
): FixtureItem => ({
  id,
  name: name ?? `${color} ${subcategory}`,
  main_category,
  subcategory,
  color,
});

const outfit = (outfit_id: string, items: FixtureItem[]): FixtureOutfit => ({
  outfit_id,
  items,
});

// Mirrors the Studio call site in wardrobe.service.ts:
//   eliteOutfits = selectTopOutfits(eliteOutfits, _judgeCtxSlow);
// Helper kept Studio-local so tests document the Studio contract.
function studioCurate<T extends FixtureOutfit>(
  candidates: T[],
  ctx: { requestedDressCode?: string; query?: string } = {},
): T[] {
  return selectTopOutfits(candidates as any, ctx) as T[];
}

// ─────────────────────────────────────────────────────────────────────────
// Studio post-curation property helpers (used only inside assertions)
// ─────────────────────────────────────────────────────────────────────────

const lower = (s: string | undefined): string => (s ?? '').toLowerCase().trim();

const bottomSubOf = (o: FixtureOutfit): string => {
  const it = o.items.find((i) => /^bottoms?$/.test(lower(i.main_category)));
  return lower(it?.subcategory);
};

const silhouetteOf = (o: FixtureOutfit): string => {
  const find = (re: RegExp): string => {
    const it = o.items.find((i) => re.test(lower(i.main_category)));
    return lower(it?.subcategory);
  };
  return `${find(/^tops?$/)}|${find(/^bottoms?$/)}|${find(/^shoes$/)}`;
};

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('AI Outfit Studio v1 — Elite Structural Stable (post-curation contract)', () => {
  // ───────────────────────────────────────────────────────────────────────
  // 1) NEVER returns 0 outfits when at least one viable outfit exists.
  // ───────────────────────────────────────────────────────────────────────
  describe('shallow wardrobe — never returns 0 outfits', () => {
    it('returns >= 1 outfit when only a single viable outfit exists', () => {
      const o1 = outfit('o1', [
        item('t1', 'Tops', 'T-Shirt', 'white'),
        item('b1', 'Bottoms', 'Jeans', 'blue'),
        item('s1', 'Shoes', 'Sneakers', 'white'),
      ]);

      const result = studioCurate([o1]);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].outfit_id).toBe('o1');
    });

    it('returns >= 1 outfit when two viable outfits exist', () => {
      const o1 = outfit('o1', [
        item('t1', 'Tops', 'T-Shirt', 'white'),
        item('b1', 'Bottoms', 'Jeans', 'blue'),
        item('s1', 'Shoes', 'Sneakers', 'white'),
      ]);
      const o2 = outfit('o2', [
        item('t2', 'Tops', 'Button-Down', 'white'),
        item('b2', 'Bottoms', 'Chinos', 'khaki'),
        item('s2', 'Shoes', 'Loafers', 'brown'),
      ]);

      const result = studioCurate([o1, o2]);

      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2) Returns up to 3 outfits but may return fewer (no minimum-3 floor).
  // ───────────────────────────────────────────────────────────────────────
  describe('shallow wardrobe — up to 3 outfits, may return fewer', () => {
    it('returns 1 outfit when only 1 candidate exists', () => {
      const o1 = outfit('o1', [
        item('t1', 'Tops', 'T-Shirt', 'white'),
        item('b1', 'Bottoms', 'Jeans', 'blue'),
        item('s1', 'Shoes', 'Sneakers', 'white'),
      ]);

      const result = studioCurate([o1]);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);
      expect(result.length).toBe(1);
    });

    it('returns 2 outfits when only 2 candidates exist (does not fabricate a 3rd)', () => {
      const o1 = outfit('o1', [
        item('t1', 'Tops', 'T-Shirt', 'white'),
        item('b1', 'Bottoms', 'Jeans', 'blue'),
        item('s1', 'Shoes', 'Sneakers', 'white'),
      ]);
      const o2 = outfit('o2', [
        item('t2', 'Tops', 'Button-Down', 'white'),
        item('b2', 'Bottoms', 'Chinos', 'khaki'),
        item('s2', 'Shoes', 'Loafers', 'brown'),
      ]);

      const result = studioCurate([o1, o2]);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);
      expect(result.length).toBe(2);
    });

    it('caps at 3 when more than 3 candidates exist', () => {
      const candidates: FixtureOutfit[] = [];
      for (let i = 1; i <= 5; i++) {
        candidates.push(
          outfit(`o${i}`, [
            item(`t${i}`, 'Tops', 'T-Shirt', 'white'),
            item(`b${i}`, 'Bottoms', 'Jeans', 'blue'),
            item(`s${i}`, 'Shoes', 'Sneakers', 'white'),
          ]),
        );
      }

      const result = studioCurate(candidates);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3) Structural diversity at Top-N — no collapse on bottom subcategory,
  //    dominant color family, or silhouette stack signature.
  //
  //    Fixture is shaped so naive top-by-score-only would collapse into
  //    three identical-shape looks (same bottom subcategory, same dominant
  //    family, same silhouette signature). The Studio v1 curation must
  //    surface a structurally different candidate at the third slot.
  // ───────────────────────────────────────────────────────────────────────
  describe('Top-N structural diversity — no collapse', () => {
    it('avoids returning 3 outfits that all share bottom + family + silhouette', () => {
      // Three near-twin outfits (would collapse under naive top-by-score).
      const twin = (n: number): FixtureOutfit =>
        outfit(`twin-${n}`, [
          item(`t-twin-${n}`, 'Tops', 'T-Shirt', 'white'),
          item(`b-twin-${n}`, 'Bottoms', 'Jeans', 'blue'),
          item(`s-twin-${n}`, 'Shoes', 'Sneakers', 'white'),
        ]);

      // A structurally distinct outfit:
      //   - different bottom subcategory   (Chinos vs Jeans)
      //   - different dominant color family (earth vs neutral)
      //   - different silhouette signature  (button-down|chinos|loafers)
      const distinct = outfit('distinct', [
        item('t-distinct', 'Tops', 'Button-Down', 'olive'),
        item('b-distinct', 'Bottoms', 'Chinos', 'olive'),
        item('s-distinct', 'Shoes', 'Loafers', 'brown'),
      ]);

      // Order matters: place the twins first so naive top-by-index would
      // pick all three of them. Studio's diversity filter must intervene.
      const candidates = [twin(1), twin(2), twin(3), distinct];

      const result = studioCurate(candidates);

      // Sanity: Top-N is honored.
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);

      // When 3 are returned, the set must NOT collapse on all three signals.
      if (result.length === 3) {
        const bottoms = new Set(result.map(bottomSubOf));
        const silhouettes = new Set(result.map(silhouetteOf));

        const collapsedOnBottom = bottoms.size === 1;
        const collapsedOnSilhouette = silhouettes.size === 1;

        // Property under test: at least one of the three structural signals
        // is non-uniform across the returned set.
        expect(collapsedOnBottom && collapsedOnSilhouette).toBe(false);

        // Stronger expectation on this fixture: the structurally distinct
        // outfit displaces one of the twins.
        expect(result.map((o) => o.outfit_id)).toContain('distinct');
      }
    });

    it('returns determinably the same selection on repeated invocations (no randomness)', () => {
      const twin = (n: number): FixtureOutfit =>
        outfit(`twin-${n}`, [
          item(`t-twin-${n}`, 'Tops', 'T-Shirt', 'white'),
          item(`b-twin-${n}`, 'Bottoms', 'Jeans', 'blue'),
          item(`s-twin-${n}`, 'Shoes', 'Sneakers', 'white'),
        ]);
      const distinct = outfit('distinct', [
        item('t-distinct', 'Tops', 'Button-Down', 'olive'),
        item('b-distinct', 'Bottoms', 'Chinos', 'olive'),
        item('s-distinct', 'Shoes', 'Loafers', 'brown'),
      ]);
      const candidates = [twin(1), twin(2), twin(3), distinct];

      const a = studioCurate(candidates).map((o) => o.outfit_id);
      const b = studioCurate(candidates).map((o) => o.outfit_id);
      const c = studioCurate(candidates).map((o) => o.outfit_id);

      expect(a).toEqual(b);
      expect(b).toEqual(c);
    });
  });
});
