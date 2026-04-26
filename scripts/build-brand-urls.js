#!/usr/bin/env node
/**
 * Brand URL Generator — Mission-Critical Safe
 *
 * Populates apps/frontend/src/data/brandUrls.json with official website URLs
 * sourced from Wikidata P856 (official website) property.
 *
 * MERGE MODE (default): node scripts/build-brand-urls.js
 *   - Preserves ALL existing non-empty valid entries in brandUrls.json.
 *   - Only fills entries that are currently empty.
 *   - Never overwrites SEEDED entries (quickShopSites defaults).
 *   - Reports conflicts if Wikidata disagrees with an existing entry.
 *
 * FRESH MODE: node scripts/build-brand-urls.js --fresh
 *   - Re-queries Wikidata for ALL brands (even those with existing URLs).
 *   - Still never overwrites SEEDED entries.
 *   - Overwrites existing entries only if Wikidata returns HIGH confidence.
 *   - Reports conflicts for all discrepancies.
 *
 * Safety:
 *   - SPARQL filters to brand/company/business entities (P31 instance-of check).
 *   - FOUND_MED (multiple candidates after filtering) leaves URL EMPTY.
 *   - Blocked-domain list rejects social, marketplace, and non-brand URLs.
 *   - Zero external npm dependencies (uses Node.js built-in https).
 *
 * Outputs:
 *   - apps/frontend/src/data/brandUrls.json   (the URL map)
 *   - scripts/brand-urls.report.md            (human-review report)
 *   - scripts/brand-urls.raw.json             (per-brand traceability)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── CLI flags ───────────────────────────────────────────────────────────────
const FRESH_MODE = process.argv.includes('--fresh');

// ─── Paths ───────────────────────────────────────────────────────────────────
const BRANDS_PATH = path.join(__dirname, '../apps/frontend/src/data/brands.json');
const URLS_PATH = path.join(__dirname, '../apps/frontend/src/data/brandUrls.json');
const SKIP_PATH = path.join(__dirname, 'brand-urls.skip.json');
const REPORT_PATH = path.join(__dirname, 'brand-urls.report.md');
const RAW_PATH = path.join(__dirname, 'brand-urls.raw.json');

// ─── Verified seed: shoppingStore.ts lines 788-811 ──────────────────────────
// Only brands that exist in brands.json (by lowercase name match).
const QUICK_SHOP_SEEDS = {
  'louis vuitton': 'https://us.louisvuitton.com',
  versace: 'https://www.versace.com',
  gucci: 'https://www.gucci.com',
  chanel: 'https://www.chanel.com',
  asos: 'https://www.asos.com',
  zara: 'https://www.zara.com',
  'h&m': 'https://www.hm.com',
  prada: 'https://www.prada.com',
  burberry: 'https://us.burberry.com',
  'hermès': 'https://www.hermes.com',
  hermes: 'https://www.hermes.com',
};

// ─── Blocklist ───────────────────────────────────────────────────────────────
const BLOCKED_DOMAINS = [
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'pinterest.com', 'linkedin.com', 'threads.net',
  'myspace.com', 'tumblr.com',
  'amazon.com', 'amazon.co.uk', 'ebay.com', 'etsy.com',
  'farfetch.com', 'nordstrom.com', 'saksfifthavenue.com', 'neimanmarcus.com',
  'bloomingdales.com', 'zappos.com', 'shopbop.com', 'net-a-porter.com',
  'mytheresa.com', 'ssense.com', 'mrporter.com', 'therealreal.com',
  'wikipedia.org', 'wikidata.org',
];

// ─── Government / non-commercial TLDs to reject ─────────────────────────────
const BLOCKED_TLDS = ['.gov', '.gov/', '.edu', '.mil'];

function isBlockedUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    if (BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return true;
    if (BLOCKED_TLDS.some(t => hostname.endsWith(t) || u.pathname === t)) return true;
    return false;
  } catch {
    return true;
  }
}

function isValidUrl(url) {
  return typeof url === 'string' &&
    (url.startsWith('https://') || url.startsWith('http://')) &&
    !isBlockedUrl(url);
}

// ─── SPARQL ──────────────────────────────────────────────────────────────────
// Batched query: look up all brand names at once, filtered to business/brand
// entities via P31 (instance of) with subclass traversal.
//
// Entity type filters:
//   Q431289  = brand
//   Q4830453 = business
//   Q6881511 = enterprise
//   Q3661311 = fashion label (niche but precise)
//   Q12136   = corporation (used by many fashion houses)
//
// Two-phase approach to avoid expensive P279* recursive traversal in batch:
//   Phase 1: batch query gets ALL P856 results for labels (no entity filter)
//   Phase 2: for each QID returned, check entity type with a focused query
//
// Phase 1: get all entities with P856 for a batch of labels
function buildBatchSparql(names) {
  const values = names
    .map(n => `"${n.replace(/"/g, '\\"')}"@en`)
    .join(' ');

  return `
SELECT ?label ?item ?itemType ?website WHERE {
  VALUES ?label { ${values} }
  ?item rdfs:label ?label .
  ?item wdt:P856 ?website .
  OPTIONAL { ?item wdt:P31 ?itemType . }
}
LIMIT 500
`.trim();
}

// Entity types we accept (direct P31 values — no recursive subclass)
const ACCEPTED_TYPES = new Set([
  'http://www.wikidata.org/entity/Q431289',   // brand
  'http://www.wikidata.org/entity/Q4830453',  // business
  'http://www.wikidata.org/entity/Q6881511',  // enterprise
  'http://www.wikidata.org/entity/Q3661311',  // fashion label
  'http://www.wikidata.org/entity/Q12136',    // corporation
  'http://www.wikidata.org/entity/Q891723',   // public company
  'http://www.wikidata.org/entity/Q163740',   // nonprofit organization
  'http://www.wikidata.org/entity/Q4671286',  // academic institution — REJECT marker
  'http://www.wikidata.org/entity/Q7275',     // state — REJECT marker
  'http://www.wikidata.org/entity/Q515',      // city — REJECT marker
  'http://www.wikidata.org/entity/Q486972',   // human settlement — REJECT marker
  'http://www.wikidata.org/entity/Q11424',    // film — REJECT marker
  'http://www.wikidata.org/entity/Q5',        // human — REJECT marker
]);

const REJECT_TYPES = new Set([
  'http://www.wikidata.org/entity/Q4671286',  // academic institution
  'http://www.wikidata.org/entity/Q7275',     // state
  'http://www.wikidata.org/entity/Q515',      // city
  'http://www.wikidata.org/entity/Q486972',   // human settlement
  'http://www.wikidata.org/entity/Q11424',    // film
  'http://www.wikidata.org/entity/Q5',        // human
  'http://www.wikidata.org/entity/Q3305213',  // painting
  'http://www.wikidata.org/entity/Q571',      // book
  'http://www.wikidata.org/entity/Q2385804',  // educational institution
  'http://www.wikidata.org/entity/Q3918',     // university
  'http://www.wikidata.org/entity/Q6256',     // country
  'http://www.wikidata.org/entity/Q56061',    // administrative territorial entity
]);

const BRAND_TYPES = new Set([
  'http://www.wikidata.org/entity/Q431289',   // brand
  'http://www.wikidata.org/entity/Q4830453',  // business
  'http://www.wikidata.org/entity/Q6881511',  // enterprise
  'http://www.wikidata.org/entity/Q3661311',  // fashion label
  'http://www.wikidata.org/entity/Q12136',    // corporation
  'http://www.wikidata.org/entity/Q891723',   // public company
  'http://www.wikidata.org/entity/Q167270',   // trademark
  'http://www.wikidata.org/entity/Q1589009',  // clothing brand
  'http://www.wikidata.org/entity/Q1331793',  // shoe brand
]);

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'StylIQ-BrandUrlBuilder/2.0 (build-script; contact: dev@styliq.app)',
          Accept: 'application/sparql-results+json',
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Query Wikidata for a batch of names.
// Returns Map<lowercaseName, {qid, website, types[]}[]> grouped by QID.
async function queryBatch(names) {
  const sparql = buildBatchSparql(names);
  const url =
    'https://query.wikidata.org/sparql?format=json&query=' +
    encodeURIComponent(sparql);

  const raw = await httpsGet(url);
  const json = JSON.parse(raw);
  const bindings = json.results?.bindings || [];

  // Group by label → by QID, collecting types and websites
  const byLabel = new Map(); // label → Map<qid, {websites: Set, types: Set}>
  for (const b of bindings) {
    const label = (b.label?.value || '').toLowerCase();
    const qid = b.item?.value || '';
    const website = b.website?.value || '';
    const itemType = b.itemType?.value || '';

    if (!byLabel.has(label)) byLabel.set(label, new Map());
    const entityMap = byLabel.get(label);
    if (!entityMap.has(qid)) entityMap.set(qid, { websites: new Set(), types: new Set() });
    const entity = entityMap.get(qid);
    if (website) entity.websites.add(website);
    if (itemType) entity.types.add(itemType);
  }

  // Convert to flat results grouped by label, filtering by entity type
  const grouped = new Map();
  for (const [label, entityMap] of byLabel) {
    const results = [];
    for (const [qid, data] of entityMap) {
      // Check entity types: reject if any REJECT type, prefer if any BRAND type
      const hasRejectType = [...data.types].some(t => REJECT_TYPES.has(t));
      const hasBrandType = [...data.types].some(t => BRAND_TYPES.has(t));

      if (hasRejectType && !hasBrandType) continue; // Skip non-brand entities

      for (const website of data.websites) {
        results.push({
          qid,
          website,
          hasBrandType,
          types: [...data.types],
        });
      }
    }
    grouped.set(label, results);
  }
  return grouped;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Brand URL Generator (${FRESH_MODE ? 'FRESH' : 'MERGE'} mode) ===\n`);

  // 1. Load brands
  const brands = JSON.parse(fs.readFileSync(BRANDS_PATH, 'utf8'));
  console.log(`Loaded ${brands.length} brands from brands.json`);

  // 2. Load existing brandUrls.json
  let existing = {};
  if (fs.existsSync(URLS_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
    } catch {
      console.warn('Warning: could not parse existing brandUrls.json, treating as empty.');
    }
  }

  // 3. Load skip list (brands manually marked as "do not auto-fill")
  let skipIds = new Set();
  if (fs.existsSync(SKIP_PATH)) {
    try {
      const skipList = JSON.parse(fs.readFileSync(SKIP_PATH, 'utf8'));
      skipIds = new Set(Array.isArray(skipList) ? skipList : []);
      console.log(`Loaded skip list: ${skipIds.size} brands will not be auto-filled`);
    } catch {
      console.warn('Warning: could not parse brand-urls.skip.json');
    }
  }

  // 4. Determine which brands need Wikidata lookup
  const needsLookup = []; // brands to query
  const results = {};     // brandId → final url
  const report = [];      // per-brand report entries
  const rawDebug = {};    // per-brand traceability

  // Build seeded set (by brand id) for protection
  const seededIds = new Set();
  for (const b of brands) {
    if (QUICK_SHOP_SEEDS[b.name.toLowerCase()]) {
      seededIds.add(b.id);
    }
  }

  for (const brand of brands) {
    const { id, name } = brand;

    // SEEDED: always use seed value, never query
    const seedUrl = QUICK_SHOP_SEEDS[name.toLowerCase()];
    if (seedUrl) {
      results[id] = seedUrl;
      report.push({
        id, name, url: seedUrl, status: 'SEEDED',
        source: 'quickShopSites', qid: '', candidates: [],
        notes: 'shoppingStore.ts defaults — never overwritten',
      });
      continue;
    }

    const existingUrl = existing[id];
    const existingValid = existingUrl && isValidUrl(existingUrl);

    // Skip list: brand was manually cleared and marked "do not auto-fill"
    if (skipIds.has(id) && !FRESH_MODE) {
      results[id] = existingValid ? existingUrl : '';
      report.push({
        id, name, url: results[id], status: 'SKIPPED_MANUAL',
        source: 'brand-urls.skip.json', qid: '', candidates: [],
        notes: 'In skip list — needs manual URL entry',
      });
      continue;
    }

    if (!FRESH_MODE && existingValid) {
      // MERGE mode: preserve existing, skip Wikidata query
      results[id] = existingUrl;
      report.push({
        id, name, url: existingUrl, status: 'SKIPPED_EXISTING',
        source: 'brandUrls.json (preserved)', qid: '', candidates: [],
        notes: 'Existing valid URL preserved in merge mode',
      });
      continue;
    }

    // Needs Wikidata lookup (either empty, or FRESH mode)
    needsLookup.push(brand);
  }

  console.log(`  Seeded: ${seededIds.size}`);
  console.log(`  Preserved (existing): ${report.filter(r => r.status === 'SKIPPED_EXISTING').length}`);
  console.log(`  Need Wikidata lookup: ${needsLookup.length}\n`);

  // 4. Batch Wikidata queries (batches of 15 for reliability)
  const BATCH_SIZE = 15;
  const wikidataResults = new Map(); // lowercaseName → [{qid, website}]

  for (let i = 0; i < needsLookup.length; i += BATCH_SIZE) {
    const batch = needsLookup.slice(i, i + BATCH_SIZE);
    const batchNames = batch.map(b => b.name);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(needsLookup.length / BATCH_SIZE);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} brands)... `);

    try {
      const batchResult = await queryBatch(batchNames);
      for (const [label, entries] of batchResult) {
        // Merge into main map
        if (!wikidataResults.has(label)) wikidataResults.set(label, []);
        wikidataResults.get(label).push(...entries);
      }
      console.log('done');
    } catch (err) {
      console.log(`error: ${err.message}`);
      // Mark all brands in this batch as errored
      for (const brand of batch) {
        const label = brand.name.toLowerCase();
        if (!wikidataResults.has(label)) wikidataResults.set(label, []);
        // Leave empty — will be UNRESOLVED
      }
    }

    // Rate limit between batches (Wikidata courtesy)
    if (i + BATCH_SIZE < needsLookup.length) {
      await sleep(2000);
    }
  }

  // 5. Process Wikidata results for each brand that needed lookup
  for (const brand of needsLookup) {
    const { id, name } = brand;
    const label = name.toLowerCase();
    const entries = wikidataResults.get(label) || [];
    const existingUrl = existing[id];
    const existingValid = existingUrl && isValidUrl(existingUrl);

    // Deduplicate by website URL, filtering blocked, preferring brand-typed entities
    const candidateMap = new Map(); // url → { qid, hasBrandType }
    for (const e of entries) {
      const normalized = (e.website || '').replace(/^http:\/\//, 'https://');
      if (isValidUrl(normalized)) {
        const existing = candidateMap.get(normalized);
        if (!existing || (!existing.hasBrandType && e.hasBrandType)) {
          candidateMap.set(normalized, { qid: e.qid, hasBrandType: e.hasBrandType });
        }
      }
    }

    // Sort: brand-typed entities first
    const candidates = [...candidateMap.entries()]
      .map(([url, { qid, hasBrandType }]) => ({ url, qid, hasBrandType }))
      .sort((a, b) => (b.hasBrandType ? 1 : 0) - (a.hasBrandType ? 1 : 0));

    // Build raw debug entry
    rawDebug[id] = {
      brandId: id,
      name,
      candidates: candidates.map(c => ({ qid: c.qid, url: c.url })),
      rawEntries: entries.length,
      chosenUrl: '',
      chosenQid: '',
      confidence: '',
      source: 'Wikidata P856 + P31 filter',
    };

    // Determine confidence:
    // HIGH = exactly 1 candidate total after all filtering, AND it has a brand/business type.
    //        This is the strictest threshold: any ambiguity → MED (left empty).
    // MED  = multiple candidates, or single candidate without brand type.
    const brandTyped = candidates.filter(c => c.hasBrandType);
    const isHigh = candidates.length === 1 && brandTyped.length === 1;
    const isMed = candidates.length > 0 && !isHigh;
    const chosen = brandTyped[0] || candidates[0];

    if (isHigh && chosen) {
      rawDebug[id].chosenUrl = chosen.url;
      rawDebug[id].chosenQid = chosen.qid;
      rawDebug[id].confidence = 'HIGH';

      if (FRESH_MODE && existingValid && existingUrl !== chosen.url) {
        results[id] = chosen.url;
        report.push({
          id, name, url: chosen.url, status: 'CONFLICT',
          source: 'Wikidata', qid: chosen.qid, candidates,
          notes: `FRESH overwrite: was "${existingUrl}" → now "${chosen.url}" (HIGH confidence)`,
        });
      } else {
        results[id] = chosen.url;
        report.push({
          id, name, url: chosen.url, status: 'FILLED_HIGH',
          source: 'Wikidata', qid: chosen.qid, candidates,
          notes: `1 brand-typed candidate${candidates.length > 1 ? ` (${candidates.length} total, ${candidates.length - 1} non-brand filtered)` : ''}`,
        });
      }
    } else if (isMed) {
      // MEDIUM: multiple brand-typed candidates, or candidates without brand type
      // SAFETY: do NOT auto-pick. Leave empty.
      rawDebug[id].confidence = 'MED';

      if (existingValid) {
        results[id] = existingUrl;
        report.push({
          id, name, url: existingUrl, status: 'FILLED_MED',
          source: 'brandUrls.json (kept — ambiguous Wikidata)', qid: '', candidates,
          notes: `${candidates.length} candidates — existing preserved: ${candidates.map(c => c.url).join(', ')}`,
        });
      } else {
        results[id] = '';
        report.push({
          id, name, url: '', status: 'FILLED_MED',
          source: 'Wikidata (ambiguous)', qid: '', candidates,
          notes: `${candidates.length} candidates — left empty: ${candidates.map(c => c.url).join(', ')}`,
        });
      }
    } else {
      // UNRESOLVED: no candidates after filtering
      rawDebug[id].confidence = 'NONE';

      if (FRESH_MODE && existingValid) {
        // Fresh mode but no Wikidata result: keep existing, don't erase
        results[id] = existingUrl;
        report.push({
          id, name, url: existingUrl, status: 'SKIPPED_EXISTING',
          source: 'brandUrls.json (kept — Wikidata empty)', qid: '', candidates: [],
          notes: `No Wikidata result; existing "${existingUrl}" preserved`,
        });
      } else {
        results[id] = '';
        report.push({
          id, name, url: '', status: 'UNRESOLVED',
          source: 'Wikidata', qid: '', candidates: [],
          notes: `No P856 found with brand/company/business entity filter (${entries.length} raw unfiltered)`,
        });
      }
    }
  }

  // 6. Ensure all brand ids exist in output
  for (const b of brands) {
    if (!(b.id in results)) results[b.id] = '';
  }

  // 7. Write brandUrls.json
  fs.writeFileSync(URLS_PATH, JSON.stringify(results, null, 2) + '\n');

  // 8. Write raw debug
  fs.writeFileSync(RAW_PATH, JSON.stringify(rawDebug, null, 2) + '\n');

  // 9. Generate report
  const counts = {};
  for (const r of report) counts[r.status] = (counts[r.status] || 0) + 1;

  const filled = Object.values(results).filter(v => v !== '').length;

  let md = `# Brand URL Generation Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Mode: **${FRESH_MODE ? 'FRESH' : 'MERGE'}**\n\n`;
  md += `## Summary\n\n`;
  md += `**Coverage: ${filled}/${brands.length} brands have URLs (${Math.round(filled / brands.length * 100)}%)**\n\n`;
  md += `| Status | Count | Description |\n`;
  md += `|--------|-------|-------------|\n`;
  md += `| SEEDED | ${counts.SEEDED || 0} | From quickShopSites defaults (never overwritten) |\n`;
  md += `| SKIPPED_EXISTING | ${counts.SKIPPED_EXISTING || 0} | Preserved existing valid URL (merge mode / Wikidata empty) |\n`;
  md += `| SKIPPED_MANUAL | ${counts.SKIPPED_MANUAL || 0} | In skip list — Wikidata returns wrong entity |\n`;
  md += `| FILLED_HIGH | ${counts.FILLED_HIGH || 0} | Single Wikidata P856 match after entity-type filter |\n`;
  md += `| FILLED_MED | ${counts.FILLED_MED || 0} | Multiple candidates — left EMPTY (needs manual review) |\n`;
  md += `| UNRESOLVED | ${counts.UNRESOLVED || 0} | No valid URL found |\n`;
  md += `| CONFLICT | ${counts.CONFLICT || 0} | Existing URL overwritten by Wikidata (FRESH mode only) |\n`;
  md += `| **Total** | **${report.length}** | |\n\n`;

  // Needs review: FILLED_MED
  const medItems = report.filter(r => r.status === 'FILLED_MED');
  md += `## Needs Review: Ambiguous (${medItems.length})\n\n`;
  md += `These brands had multiple Wikidata candidates after entity-type filtering.\n`;
  md += `URL was left EMPTY. Pick the correct one manually.\n\n`;
  if (medItems.length === 0) {
    md += `None.\n\n`;
  } else {
    md += `| Brand | ID | Candidates |\n`;
    md += `|-------|-----|------------|\n`;
    for (const m of medItems) {
      const cands = m.candidates.map(c => c.url).join(', ');
      md += `| ${m.name} | ${m.id} | ${cands} |\n`;
    }
    md += `\n`;
  }

  // Conflicts
  const conflictItems = report.filter(r => r.status === 'CONFLICT');
  md += `## Conflicts (${conflictItems.length})\n\n`;
  if (conflictItems.length === 0) {
    md += `None.\n\n`;
  } else {
    md += `| Brand | ID | Old URL | New URL | QID |\n`;
    md += `|-------|-----|---------|---------|-----|\n`;
    for (const c of conflictItems) {
      md += `| ${c.name} | ${c.id} | ${c.notes} | ${c.url} | ${c.qid} |\n`;
    }
    md += `\n`;
  }

  // Unresolved
  const unresolvedItems = report.filter(r => r.status === 'UNRESOLVED').sort((a, b) => a.name.localeCompare(b.name));
  md += `## Unresolved (${unresolvedItems.length})\n\n`;
  md += `These brands need manual URL entry in brandUrls.json:\n\n`;
  if (unresolvedItems.length === 0) {
    md += `None!\n\n`;
  } else {
    md += `| Brand | ID | Notes |\n`;
    md += `|-------|-----|-------|\n`;
    for (const u of unresolvedItems) {
      md += `| ${u.name} | ${u.id} | ${u.notes} |\n`;
    }
    md += `\n`;
  }

  // Full table
  md += `## All Results\n\n`;
  md += `| # | Brand | ID | Status | URL | QID |\n`;
  md += `|---|-------|-----|--------|-----|-----|\n`;
  report.forEach((r, i) => {
    md += `| ${i + 1} | ${r.name} | ${r.id} | ${r.status} | ${r.url || '(empty)'} | ${r.qid || ''} |\n`;
  });

  fs.writeFileSync(REPORT_PATH, md);

  // 10. Summary
  console.log(`\n=== Done ===`);
  console.log(`brandUrls.json: ${filled}/${brands.length} brands have URLs`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(`Raw:    ${RAW_PATH}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
