#!/usr/bin/env node
// =====================================================================
// Game matcher test set
// =====================================================================
// Run with: node scripts/test-game-matcher.js
//
// Covers the known-difficult shapes the matcher has to handle:
// punctuation, editions, roman numerals, leading articles, remasters,
// GOTY / definitive / complete editions, subtitles, unicode quirks.
//
// Each test gives an input string and the library entry it should
// resolve to. We also assert the tier we expect, so regressions in
// tier classification (e.g. "exact normalized" silently dropping to
// "fuzzy") surface immediately.

'use strict';

const path = require('path');
const { buildMatcher, normalize, stripEditionSuffix } = require(path.join(__dirname, '..', 'lib', 'gameMatcher'));

// Library fixture — names as they appear in Steam.
const LIBRARY = [
  { app_id: 1,  name: 'BioShock' },
  { app_id: 2,  name: 'BioShock 2' },
  { app_id: 3,  name: 'BioShock Infinite' },
  { app_id: 4,  name: 'Dark Souls: Prepare to Die Edition' },
  { app_id: 5,  name: 'DARK SOULS™: REMASTERED' },
  { app_id: 6,  name: 'The Witcher 3: Wild Hunt' },
  { app_id: 7,  name: 'The Elder Scrolls V: Skyrim Special Edition' },
  { app_id: 8,  name: 'Fallout 3 - Game of the Year Edition' },
  { app_id: 9,  name: 'Grand Theft Auto V' },
  { app_id: 10, name: 'DOOM' },
  { app_id: 11, name: 'DOOM (1993)' },
  { app_id: 12, name: 'DOOM II' },
  { app_id: 13, name: 'Civilization VI' },
  { app_id: 14, name: 'Final Fantasy XIV Online' },
  { app_id: 15, name: 'Crysis Remastered' },
  { app_id: 16, name: 'Trine 2: Complete Story' },
  { app_id: 17, name: 'Hitman: Absolution' },
  { app_id: 18, name: 'Plants vs. Zombies: Game of the Year Edition' },
  { app_id: 19, name: "Assassin's Creed Odyssey" },
  { app_id: 20, name: 'Mass Effect™ Legendary Edition' },
];

const ALIASES = {
  'gta 5': 'Grand Theft Auto V',
  'witcher 3': 'The Witcher 3: Wild Hunt',
};

const matcher = buildMatcher(LIBRARY, { aliases: ALIASES });

const TESTS = [
  // Tier 2: exact raw
  { input: 'BioShock', expectAppId: 1, expectTier: 'raw' },

  // Tier 3: normalized (case, trademark, unicode)
  { input: 'bioshock', expectAppId: 1, expectTier: 'normalized' },
  { input: 'BIOSHOCK', expectAppId: 1, expectTier: 'normalized' },
  { input: 'BioShock™', expectAppId: 1, expectTier: 'normalized' },
  // Curly apostrophe in input vs straight apostrophe in stored name
  { input: 'Assassin’s Creed Odyssey', expectAppId: 19, expectTier: 'normalized' },
  // Long dash vs ASCII hyphen — should normalize.
  { input: 'Fallout 3 – Game of the Year Edition', expectAppId: 8, expectTier: 'normalized' },

  // Roman numerals
  { input: 'Civilization 6', expectAppId: 13, expectTier: 'normalized' },
  // Library already has the exact raw "Civilization VI", so tier 2 wins.
  { input: 'Civilization VI', expectAppId: 13, expectTier: 'raw' },
  { input: 'Final Fantasy 14 Online', expectAppId: 14, expectTier: 'normalized' },
  { input: 'Doom 2', expectAppId: 12, expectTier: 'normalized' },
  // Same as above — exact raw match.
  { input: 'DOOM II', expectAppId: 12, expectTier: 'raw' },

  // Leading articles
  { input: 'Witcher 3: Wild Hunt', expectAppId: 6, expectTier: 'normalized' },
  { input: 'The Witcher 3 Wild Hunt', expectAppId: 6, expectTier: 'normalized' },

  // Tier 4: edition stripping
  // "BioShock Remastered" doesn't exist in library — should fall through
  // to edition-stripped match of "BioShock".
  { input: 'BioShock Remastered', expectAppId: 1, expectTier: 'edition-stripped' },
  { input: 'Crysis', expectAppId: 15, expectTier: 'edition-stripped' },
  { input: 'Mass Effect Legendary Edition', expectAppId: 20, expectTier: 'normalized' },

  // Tier 4: GOTY / complete / definitive
  { input: 'Fallout 3 GOTY', expectAppId: 8, expectTier: 'edition-stripped' },
  { input: 'Plants vs Zombies GOTY Edition', expectAppId: 18, expectTier: 'edition-stripped' },
  { input: 'Trine 2 Complete Story', expectAppId: 16, expectTier: 'normalized' },

  // Tier 6: alias fallback
  { input: 'GTA 5', expectAppId: 9, expectTier: 'alias' },
  { input: 'GTA V', expectAppId: 9, expectTier: 'alias' },

  // Safety: should NOT confidently match the wrong game
  { input: 'BioShock Infinite Complete Edition', expectAppId: 3, expectTier: 'edition-stripped' },
  // "Doom" alone is ambiguous with DOOM (1993) / DOOM II / DOOM only if
  // we're careless. Stored "DOOM" normalizes to "doom"; input "Doom"
  // also normalizes to "doom". So this should be an exact normalized
  // match on app 10, NOT a fuzzy match into DOOM II.
  { input: 'Doom', expectAppId: 10, expectTier: 'normalized' },
  // Single-token fuzzy is forbidden — "Skyrim" alone shouldn't match
  // "The Elder Scrolls V: Skyrim Special Edition" by fuzzy (it'd be a
  // dangerous match). Must come back unmatched.
  { input: 'Skyrim', expectAppId: null, expectTier: null },

  // Empty / junk
  { input: '', expectAppId: null, expectTier: null },
];

let passed = 0;
let failed = 0;
const failures = [];

for (const t of TESTS) {
  const r = matcher.match(t.input, { trackDiagnostics: false });
  const gotAppId = r.match ? r.match.app_id : null;
  const gotTier = r.tier;
  const ok = gotAppId === t.expectAppId && gotTier === t.expectTier;
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push({
      input: t.input,
      expected: { app_id: t.expectAppId, tier: t.expectTier },
      got: { app_id: gotAppId, tier: gotTier, score: r.score, debug: r.debug },
    });
  }
}

console.log(`\nGame matcher tests: ${passed} passed, ${failed} failed (${TESTS.length} total)`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log('  Input:    ', JSON.stringify(f.input));
    console.log('  Expected: ', f.expected);
    console.log('  Got:      ', { app_id: f.got.app_id, tier: f.got.tier, score: f.got.score });
    console.log('  Debug:    ', f.got.debug);
    console.log('');
  }
  process.exit(1);
}

// Smoke-check the helpers a caller may want to use directly.
const smoke = [
  ['  The Witcher 3:  Wild Hunt  ', 'witcher 3 wild hunt'],
  ['DARK SOULS™: REMASTERED', 'dark souls remastered'],
  ['Assassin’s Creed', 'assassins creed'],
  ['Civilization VI', 'civilization 6'],
];
for (const [input, want] of smoke) {
  const got = normalize(input);
  if (got !== want) {
    console.error(`normalize() smoke failed: ${JSON.stringify(input)} → ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`);
    process.exit(1);
  }
}

const editionSmoke = [
  ['skyrim special edition', 'skyrim special'],
  ['fallout 3 game of the year edition', 'fallout 3'],
  ['dark souls remastered', 'dark souls'],
  ['witcher 3 wild hunt', 'witcher 3 wild hunt'],
];
for (const [input, want] of editionSmoke) {
  const got = stripEditionSuffix(input);
  if (got !== want) {
    console.error(`stripEditionSuffix() smoke failed: ${JSON.stringify(input)} → ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`);
    process.exit(1);
  }
}

console.log('Helper smoke checks: ok');
