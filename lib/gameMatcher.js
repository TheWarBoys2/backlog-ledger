// =====================================================================
// Game title matcher
// =====================================================================
// Isolated, reusable matching helper used wherever a free-text game
// title needs to be resolved against the user's Steam library.
//
// Pipeline (highest confidence first):
//   Tier 1 — exact AppID match (if input.appId is provided)
//   Tier 2 — exact raw title match (case-sensitive, byte-for-byte)
//   Tier 3 — exact normalized title match
//   Tier 4 — normalized title match after safe edition/subtitle stripping
//   Tier 5 — token-based fuzzy match (Sørensen–Dice on token sets)
//            with a strict threshold and minimum shared-token guards
//   Tier 6 — manual alias table fallback
//
// The matcher prefers correctness over aggression: it returns `null`
// (with diagnostic info) when nothing scores cleanly, so callers can
// flag the row for manual review instead of confidently picking the
// wrong game.

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- Normalization ----------

// Roman numerals we'll convert. Only standalone tokens — never word
// fragments like "II" inside "Trine III" stays correct because we only
// touch whole tokens. Keep this list tight; large numerals are rare in
// game titles and risk false positives.
const ROMAN_MAP = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8',
  ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15',
};

// Edition / re-release suffixes that should not affect matching when
// they appear at the end of a title. The order matters — longer
// phrases must be tried first so "game of the year edition" wins over
// just "edition". Each entry is matched at end-of-string only.
const EDITION_SUFFIXES = [
  'game of the year edition',
  'goty edition',
  'definitive edition',
  'enhanced edition',
  'complete edition',
  'deluxe edition',
  'ultimate edition',
  'anniversary edition',
  'hd edition',
  'directors cut',
  'remastered edition',
  'remastered',
  'remaster',
  'goty',
  'edition',
];

// Leading articles to strip for comparison only. We never mutate the
// display name; this is purely a key-comparison concern.
const LEADING_ARTICLES = ['the', 'a', 'an'];

function normalizeUnicode(str) {
  return String(str || '')
    // Strip trademark, registered, copyright, service mark
    .replace(/[™®©℠]/g, '')
    // Curly single quotes / apostrophes → straight
    .replace(/[‘’‚‛′‵]/g, "'")
    // Curly double quotes → straight
    .replace(/[“”„‟″‶]/g, '"')
    // Long dashes / minus / hyphens of various kinds → ascii hyphen
    .replace(/[‐‑‒–—―−]/g, '-')
    // Ellipsis → three dots
    .replace(/…/g, '...')
    // Non-breaking and other unicode spaces → regular space
    .replace(/[   -​  　]/g, ' ');
}

function stripLeadingArticle(str) {
  for (const a of LEADING_ARTICLES) {
    const re = new RegExp(`^${a}\\s+`, 'i');
    if (re.test(str)) return str.replace(re, '');
  }
  return str;
}

function convertRomanNumerals(str) {
  return str.split(' ').map(tok => {
    const lc = tok.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ROMAN_MAP, lc) ? ROMAN_MAP[lc] : tok;
  }).join(' ');
}

// Full normalization used as the primary comparison key.
// Does NOT strip edition suffixes — that's a separate, secondary step.
function normalize(name) {
  let s = normalizeUnicode(name).toLowerCase();
  // Normalize "&" to "and" — Steam is inconsistent
  s = s.replace(/\s*&\s*/g, ' and ');
  // Remove apostrophes entirely so "directors" == "director's"
  s = s.replace(/'/g, '');
  // Replace any punctuation that shouldn't affect matching with a space.
  // We keep digits, letters, and spaces. Hyphens, colons, dots, commas,
  // parens, slashes, etc. all become spaces.
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  s = stripLeadingArticle(s);
  s = convertRomanNumerals(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Secondary normalization: drop edition suffixes from the end.
// Only used in Tier 4 — never as the primary key, so we don't
// accidentally merge "Dark Souls" with "Dark Souls Remastered" when
// both exist in the library.
function stripEditionSuffix(normalized) {
  let s = normalized;
  let changed = true;
  // Loop because some titles stack suffixes ("complete edition remastered")
  while (changed) {
    changed = false;
    for (const suffix of EDITION_SUFFIXES) {
      const re = new RegExp(`(\\s|^)${suffix}$`);
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

function tokens(normalized) {
  if (!normalized) return [];
  return normalized.split(' ').filter(t => t.length > 0);
}

// Sørensen–Dice coefficient on token bigrams. Robust against word
// reordering, but biased toward longer-than-1-word inputs, which is
// what we want — single-word fuzzy matches are dangerous.
function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      out.set(bg, (out.get(bg) || 0) + 1);
    }
    return out;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aGrams) {
    if (bGrams.has(bg)) intersection += Math.min(count, bGrams.get(bg));
  }
  return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

// ---------- Aliases ----------

const DEFAULT_ALIASES_PATH = path.join(__dirname, 'manual-aliases.json');

function loadAliases(filePath = DEFAULT_ALIASES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

// ---------- Matcher ----------

const DEFAULT_FUZZY_THRESHOLD = 0.88;

// Build a matcher over a library snapshot. Library entries are
// `{ app_id, name }`. The returned object exposes:
//   match(input, opts) → { match, tier, score, debug }
//   diagnostics()      → array of recent failed / uncertain matches
function buildMatcher(libraryGames, options = {}) {
  const aliases = options.aliases || {};
  const fuzzyThreshold = options.fuzzyThreshold == null
    ? DEFAULT_FUZZY_THRESHOLD
    : Number(options.fuzzyThreshold);
  const maxDiagnostics = options.maxDiagnostics || 500;

  // Indexes
  const byAppId = new Map();         // app_id → game
  const byRaw = new Map();           // raw name (as stored) → game
  const byNormalized = new Map();    // normalized → game[]
  const byEditionStripped = new Map(); // stripped → game[]
  const allEntries = [];             // for fuzzy scan

  for (const g of libraryGames || []) {
    if (!g || g.app_id == null) continue;
    byAppId.set(Number(g.app_id), g);
    if (g.name) {
      if (!byRaw.has(g.name)) byRaw.set(g.name, g);
      const norm = normalize(g.name);
      if (norm) {
        if (!byNormalized.has(norm)) byNormalized.set(norm, []);
        byNormalized.get(norm).push(g);
        const stripped = stripEditionSuffix(norm);
        if (stripped) {
          if (!byEditionStripped.has(stripped)) byEditionStripped.set(stripped, []);
          byEditionStripped.get(stripped).push(g);
        }
        allEntries.push({ game: g, norm, stripped, toks: tokens(norm) });
      }
    }
  }

  const diagnostics = []; // ring buffer

  function recordDiagnostic(entry) {
    diagnostics.push({ ...entry, at: Date.now() });
    if (diagnostics.length > maxDiagnostics) diagnostics.shift();
  }

  function pickSingle(arr) {
    if (!arr || arr.length === 0) return null;
    if (arr.length === 1) return arr[0];
    return null; // ambiguous — refuse to pick
  }

  function bestFuzzy(rawNorm, rawTokens) {
    if (!rawNorm) return null;
    if (rawTokens.length < 2) return null; // never fuzzy on single-word input
    let best = null;
    for (const e of allEntries) {
      if (e.toks.length < 2) continue;
      // Quick length-similarity prefilter — if one string is more than
      // 2.5x the other, skip. Avoids matching "Doom" to "Doom Eternal".
      const lenRatio = Math.max(rawNorm.length, e.norm.length)
                     / Math.min(rawNorm.length, e.norm.length);
      if (lenRatio > 2.5) continue;
      // Require at least 2 shared tokens of length > 2
      const meaningful = rawTokens.filter(t => t.length > 2);
      const shared = meaningful.filter(t => e.toks.includes(t)).length;
      if (shared < 2) continue;
      const score = diceCoefficient(rawNorm, e.norm);
      if (!best || score > best.score) best = { game: e.game, norm: e.norm, score };
    }
    return best;
  }

  function match(input, opts = {}) {
    const trackDiagnostics = opts.trackDiagnostics !== false;
    const rawName = typeof input === 'string' ? input : (input?.rawName ?? input?.name ?? '');
    const appId = typeof input === 'object' && input ? input.appId : undefined;
    const result = {
      match: null,
      tier: null,
      score: 0,
      debug: {
        input: rawName,
        normalized: '',
        edition_stripped: '',
        best_candidate: null,
        best_candidate_normalized: null,
        score: 0,
        tier_attempted: 'none',
        reason: null,
      },
    };

    // Tier 1: AppID
    if (appId != null) {
      const g = byAppId.get(Number(appId));
      if (g) {
        result.match = g;
        result.tier = 'appid';
        result.score = 1;
        result.debug.tier_attempted = 'appid';
        result.debug.score = 1;
        return result;
      }
    }

    if (!rawName || typeof rawName !== 'string') {
      result.debug.reason = 'empty input';
      if (trackDiagnostics) recordDiagnostic({ ...result.debug, match: null });
      return result;
    }

    // Tier 2: exact raw
    if (byRaw.has(rawName)) {
      const g = byRaw.get(rawName);
      result.match = g;
      result.tier = 'raw';
      result.score = 1;
      result.debug.tier_attempted = 'raw';
      result.debug.score = 1;
      return result;
    }

    const norm = normalize(rawName);
    result.debug.normalized = norm;

    // Tier 3: exact normalized
    if (norm && byNormalized.has(norm)) {
      const candidates = byNormalized.get(norm);
      const picked = pickSingle(candidates);
      if (picked) {
        result.match = picked;
        result.tier = 'normalized';
        result.score = 1;
        result.debug.tier_attempted = 'normalized';
        result.debug.score = 1;
        result.debug.best_candidate = picked.name;
        result.debug.best_candidate_normalized = norm;
        return result;
      }
      // Ambiguous — fall through and let later tiers pick, but record why
      result.debug.reason = `ambiguous normalized match (${candidates.length} candidates)`;
    }

    // Tier 4: edition-stripped on both sides
    const stripped = stripEditionSuffix(norm);
    result.debug.edition_stripped = stripped;
    if (stripped && byEditionStripped.has(stripped)) {
      const candidates = byEditionStripped.get(stripped);
      const picked = pickSingle(candidates);
      if (picked) {
        result.match = picked;
        result.tier = 'edition-stripped';
        result.score = 0.95;
        result.debug.tier_attempted = 'edition-stripped';
        result.debug.score = 0.95;
        result.debug.best_candidate = picked.name;
        result.debug.best_candidate_normalized = normalize(picked.name);
        return result;
      }
      if (!result.debug.reason) result.debug.reason = `ambiguous edition-stripped match (${candidates.length} candidates)`;
    }

    // Tier 5: token-based fuzzy
    const rawTokens = tokens(norm);
    const fuzzy = bestFuzzy(norm, rawTokens);
    if (fuzzy) {
      result.debug.best_candidate = fuzzy.game.name;
      result.debug.best_candidate_normalized = fuzzy.norm;
      result.debug.score = fuzzy.score;
      result.debug.tier_attempted = 'token-fuzzy';
      if (fuzzy.score >= fuzzyThreshold) {
        result.match = fuzzy.game;
        result.tier = 'token-fuzzy';
        result.score = fuzzy.score;
        return result;
      }
      result.debug.reason = `fuzzy score ${fuzzy.score.toFixed(3)} below threshold ${fuzzyThreshold}`;
    }

    // Tier 6: manual alias table
    if (norm && Object.prototype.hasOwnProperty.call(aliases, norm)) {
      const canonical = aliases[norm];
      // Aliases map normalized input → canonical library name. Resolve
      // the canonical via the same normalization path so casing/edition
      // quirks in the alias file don't matter.
      const canonicalNorm = normalize(canonical);
      const candidates = byNormalized.get(canonicalNorm)
        || byEditionStripped.get(stripEditionSuffix(canonicalNorm))
        || [];
      const picked = pickSingle(candidates) || candidates[0] || null;
      if (picked) {
        result.match = picked;
        result.tier = 'alias';
        result.score = 1;
        result.debug.tier_attempted = 'alias';
        result.debug.score = 1;
        result.debug.best_candidate = picked.name;
        result.debug.best_candidate_normalized = canonicalNorm;
        result.debug.reason = `alias → ${canonical}`;
        return result;
      }
      result.debug.reason = `alias points to "${canonical}" but it is not in the library`;
    }

    if (!result.debug.reason) result.debug.reason = 'no candidate found';
    result.debug.tier_attempted = result.debug.tier_attempted === 'none'
      ? 'exhausted'
      : result.debug.tier_attempted;

    if (trackDiagnostics) recordDiagnostic({ ...result.debug, match: null });
    return result;
  }

  return {
    match,
    diagnostics: () => diagnostics.slice(),
    clearDiagnostics: () => { diagnostics.length = 0; },
    librarySize: allEntries.length,
  };
}

module.exports = {
  buildMatcher,
  loadAliases,
  normalize,
  stripEditionSuffix,
  tokens,
  diceCoefficient,
  DEFAULT_FUZZY_THRESHOLD,
  DEFAULT_ALIASES_PATH,
};
