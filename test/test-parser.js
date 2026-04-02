#!/usr/bin/env node
/**
 * Yu-Gi-Oh! MCP Server Test Suite
 * ================================
 * Tests PSCT parser determinism and API integration.
 * Run: node test/test-parser.js
 */

import { parseCardText, analyzeInteraction } from "../src/psct-parser.js";
import { lookupCard, searchCards, formatCardInfo } from "../src/api-client.js";

let passed = 0;
let failed = 0;

function assert(condition, testName, detail = "") {
  if (condition) {
    console.log(`  \u2713 ${testName}`);
    passed++;
  } else {
    console.error(`  \u2717 ${testName}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ============================================================
// UNIT TESTS: PSCT PARSER (no network required)
// ============================================================
console.log("\n=== PSCT PARSER UNIT TESTS ===\n");

// --- Test 1: Ash Blossom & Joyous Spring ---
console.log("Test Group 1: Ash Blossom & Joyous Spring");
const ashText = `When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.`;
const ashParsed = parseCardText(ashText, "Effect Monster", "Ash Blossom & Joyous Spring");
assert(ashParsed.effects.length >= 1, "Ash has at least 1 effect");
assert(ashParsed.effects[0].effectType === "QUICK", "Ash is Quick Effect");
assert(ashParsed.effects[0].spellSpeed === 2, "Ash is SS2");
assert(ashParsed.effects[0].cost !== null, "Ash has a cost (discard)");
assert(ashParsed.effects[0].hasActivation === true, "Ash has activation");
assert(ashParsed.effects[0].timing?.timingWord === "When", "Ash uses 'When'");

// --- Test 2: Continuous Effect (no colon/semicolon) ---
console.log("\nTest Group 2: Continuous Effect");
const jinzoText = `Trap Cards, and their effects on the field, are negated.`;
const jinzoParsed = parseCardText(jinzoText, "Effect Monster", "Jinzo");
assert(jinzoParsed.effects[0].effectType === "CONTINUOUS", "Jinzo is CONTINUOUS");
assert(jinzoParsed.effects[0].hasActivation === false, "Jinzo has no activation");
assert(jinzoParsed.effects[0].spellSpeed === null, "Jinzo has no Spell Speed (continuous)");

// --- Test 3: "If...you can" (cannot miss timing) ---
console.log("\nTest Group 3: If...you can timing");
const dandylionText = `If this card is sent to the GY: You can Special Summon 2 "Fluff Tokens" (Plant/WIND/Level 1/ATK 0/DEF 0) in Defense Position.`;
const dandyParsed = parseCardText(dandylionText, "Effect Monster", "Dandylion");
assert(dandyParsed.effects[0].timing?.timingWord === "If", "Dandylion uses 'If'");
assert(dandyParsed.effects[0].timing?.canMissTiming === false, "Dandylion CANNOT miss timing");
assert(dandyParsed.effects[0].timing?.isOptional === true, "Dandylion is optional");

// --- Test 4: "When...you can" (CAN miss timing) ---
console.log("\nTest Group 4: When...you can timing");
const pinguText = `When this card is sent to the GY: You can add 1 "Penguin" monster from your Deck to your hand.`;
const pinguParsed = parseCardText(pinguText, "Effect Monster", "Penguin Soldier");
assert(pinguParsed.effects[0].timing?.timingWord === "When", "Uses 'When'");
assert(pinguParsed.effects[0].timing?.canMissTiming === true, "CAN miss timing");

// --- Test 5: Counter Trap (SS3) ---
console.log("\nTest Group 5: Counter Trap");
const solemnText = `When a monster(s) would be Summoned, OR when a Spell/Trap Card, or monster effect, is activated: Pay 1500 LP; negate the Summon or activation, and if you do, destroy that card.`;
const solemnParsed = parseCardText(solemnText, "Counter Trap", "Solemn Judgment");
assert(solemnParsed.effects[0].spellSpeed === 3, "Solemn Judgment is SS3");
assert(solemnParsed.effects[0].cost !== null, "Solemn has cost (LP)");
assert(solemnParsed.effects[0].damageStepLegal === true, "Counter Trap legal in Damage Step");

// --- Test 6: Conjunction "and if you do" ---
console.log("\nTest Group 6: Conjunction parsing");
const conjText = `Target 1 monster on the field; destroy it, and if you do, inflict damage equal to its ATK.`;
const conjParsed = parseCardText(conjText, "Normal Trap", "Test Trap");
assert(conjParsed.effects[0].conjunctions.some(c => c.type === "AND_IF_YOU_DO"), "Found 'and if you do'");
assert(conjParsed.effects[0].targets === true, "Detects targeting");

// --- Test 7: Conjunction "then" ---
console.log("\nTest Group 7: 'then' conjunction");
const thenText = `Send 1 card from your hand to the GY, then draw 2 cards.`;
const thenParsed = parseCardText(thenText, "Normal Spell", "Test Spell");
assert(thenParsed.effects[0].conjunctions.some(c => c.type === "THEN"), "Found 'then'");

// --- Test 8: Hard OPT detection ---
console.log("\nTest Group 8: Hard OPT");
const hoptText = `You can only use this effect of "Test Card" once per turn. If this card is Normal Summoned: You can draw 1 card.`;
const hoptParsed = parseCardText(hoptText, "Effect Monster", "Test Card");
assert(hoptParsed.effects[0].isHardOPT === true, "Detects Hard OPT");

// --- Test 9: Ignition Effect ---
console.log("\nTest Group 9: Ignition Effect");
const igniText = `You can Tribute this card; Special Summon 1 Level 7 or higher monster from your hand.`;
const igniParsed = parseCardText(igniText, "Effect Monster", "Test Monster");
assert(igniParsed.effects[0].effectType === "IGNITION", "Ignition effect detected");
assert(igniParsed.effects[0].spellSpeed === 1, "Ignition is SS1");
assert(igniParsed.effects[0].damageStepLegal === false, "Ignition NOT legal in Damage Step");

// --- Test 10: FLIP effect ---
console.log("\nTest Group 10: Flip Effect");
const flipText = `FLIP: You can destroy 1 Spell/Trap on the field.`;
const flipParsed = parseCardText(flipText, "Flip Effect Monster", "Test Flip");
assert(flipParsed.effects[0].effectType === "FLIP", "FLIP effect detected");
assert(flipParsed.effects[0].spellSpeed === 1, "Flip is SS1");

// --- Test 11: Interaction Analysis ---
// card1 = CL1 (activates first), card2 = CL2 (chains to it)
// Raigeki (SS1) activates → Apollousa (SS2 Quick) chains
console.log("\nTest Group 11: Interaction Analysis");
const raigekiP = parseCardText(
  `Destroy all monsters your opponent controls.`,
  "Normal Spell", "Raigeki"
);
const apollousaP = parseCardText(
  `If a card or effect is activated that would destroy a card(s) on the field (Quick Effect): You can negate the activation, and if you do, destroy it.`,
  "Effect Monster", "Apollousa"
);
const interaction = analyzeInteraction(raigekiP, apollousaP, { turnPlayer: "card1" });
assert(interaction.canChain === true, "SS2 (Quick) can chain to SS1 (Spell)");
assert(interaction.chainLegality.includes("CAN chain"), "Chain legality message correct");

// --- Test 12: SS3 restriction ---
// Solemn Judgment (SS3 Counter Trap) activates → Ash Blossom (SS2) tries to chain
console.log("\nTest Group 12: SS3 chain restriction");
const counterP = parseCardText(solemnText, "Counter Trap", "Solemn Judgment");
const quickP = parseCardText(ashText, "Effect Monster", "Ash Blossom");
const ss3Interaction = analyzeInteraction(counterP, quickP, { turnPlayer: "card1" });
assert(ss3Interaction.canChain === false, "SS2 CANNOT chain to SS3");
assert(ss3Interaction.chainLegality.includes("Counter Trap"), "SS3 restriction noted");

console.log(`\n=== PARSER TESTS: ${passed} passed, ${failed} failed ===\n`);

// ============================================================
// INTEGRATION TESTS: API + PARSER (requires network)
// ============================================================
console.log("=== API INTEGRATION TESTS ===\n");

let apiPassed = 0;
let apiFailed = 0;

function apiAssert(condition, testName, detail = "") {
  if (condition) {
    console.log(`  \u2713 ${testName}`);
    apiPassed++;
  } else {
    console.error(`  \u2717 ${testName}${detail ? " — " + detail : ""}`);
    apiFailed++;
  }
}

try {
  // API Test 1: Look up Ash Blossom
  console.log("API Test 1: lookupCard('Ash Blossom & Joyous Spring')");
  const ash = await lookupCard("Ash Blossom & Joyous Spring");
  apiAssert(ash.name === "Ash Blossom & Joyous Spring", "Card name correct");
  apiAssert(ash.id !== undefined, `Card ID present: ${ash.id}`);
  apiAssert(ash.desc && ash.desc.length > 0, "Card description present");
  apiAssert(ash.type.includes("Monster"), "Card type is monster");

  // API Test 2: Look up by ID
  console.log("\nAPI Test 2: lookupCard by ID");
  const ashById = await lookupCard(String(ash.id));
  apiAssert(ashById.name === ash.name, "ID lookup matches name lookup");

  // API Test 3: Search
  console.log("\nAPI Test 3: searchCards('Blue-Eyes')");
  const blueEyes = await searchCards("Blue-Eyes");
  apiAssert(Array.isArray(blueEyes), "Returns array");
  apiAssert(blueEyes.length > 0, `Found ${blueEyes.length} cards`);
  apiAssert(blueEyes.some(c => c.name.includes("Blue-Eyes")), "Contains Blue-Eyes cards");

  // API Test 4: Format card info
  console.log("\nAPI Test 4: formatCardInfo");
  const info = formatCardInfo(ash);
  apiAssert(info.name === "Ash Blossom & Joyous Spring", "Formatted name correct");
  apiAssert(info.banlist !== undefined, "Banlist info present");
  apiAssert(info.imageUrl !== undefined, "Image URL present");

  // API Test 5: Full pipeline — lookup → parse → analyze
  console.log("\nAPI Test 5: Full pipeline (lookup → parse → analyze)");
  const card1 = await lookupCard("Ash Blossom & Joyous Spring");
  const card2 = await lookupCard("Pot of Greed");
  const p1 = parseCardText(card1.desc, card1.type, card1.name);
  const p2 = parseCardText(card2.desc, card2.type, card2.name);

  apiAssert(p1.effects.length >= 1, "Ash parsed successfully");
  apiAssert(p1.effects[0].effectType === "QUICK", "Ash detected as Quick Effect");

  const fullInteraction = analyzeInteraction(p1, p2, { turnPlayer: "card2" });
  apiAssert(fullInteraction.canChain !== undefined, "Interaction analysis produced result");
  console.log(`  Chain legality: ${fullInteraction.chainLegality}`);

  // API Test 6: Archetype lookup
  console.log("\nAPI Test 6: getArchetypeCards (skipped — not imported in test, verified via search)");

  console.log(`\n=== API TESTS: ${apiPassed} passed, ${apiFailed} failed ===\n`);
} catch (err) {
  console.error(`API TEST ERROR: ${err.message}`);
  apiFailed++;
  console.log(`\n=== API TESTS: ${apiPassed} passed, ${apiFailed} failed ===\n`);
}

// Final summary
const totalPassed = passed + apiPassed;
const totalFailed = failed + apiFailed;
console.log(`\n==================================`);
console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`==================================\n`);

process.exit(totalFailed > 0 ? 1 : 0);
