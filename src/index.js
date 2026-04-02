#!/usr/bin/env node
/**
 * Yu-Gi-Oh! OCG/TCG MCP Server
 * ==============================
 * Model Context Protocol server providing deterministic PSCT parsing,
 * card database access, and interaction analysis for Yu-Gi-Oh! judges.
 *
 * Tools:
 *   ygo_card_lookup     - Look up a card by exact name or ID
 *   ygo_card_search     - Search cards by fuzzy name, archetype, type, etc.
 *   ygo_parse_card_text - Parse card text using deterministic PSCT grammar
 *   ygo_analyze_interaction - Analyze interaction between 2+ cards
 *   ygo_check_legality  - Check banlist status in OCG/TCG
 *   ygo_archetype_cards - Get all cards in an archetype
 *   ygo_ruling_guide    - Get ruling guidance on common mechanics
 *
 * Data Source: YGOProDeck API v7 (db.ygoprodeck.com)
 * Parser: Deterministic PSCT engine (not LLM interpretation)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { parseCardText, analyzeInteraction } from "./psct-parser.js";
import {
  lookupCard,
  searchCards,
  getArchetypeCards,
  formatCardInfo,
} from "./api-client.js";

// ============================================================
// TOOL DEFINITIONS
// ============================================================

const TOOLS = [
  {
    name: "ygo_card_lookup",
    description: "Look up a Yu-Gi-Oh! card by exact name or card ID. Returns full card data: type, ATK/DEF, level, effect text, archetype, banlist status (OCG & TCG), card images, and set appearances. Use this to get the official card text before parsing.",
    inputSchema: {
      type: "object",
      properties: {
        name_or_id: {
          type: "string",
          description: "The exact card name (e.g., 'Ash Blossom & Joyous Spring') or numeric card ID (e.g., '14558127')",
        },
      },
      required: ["name_or_id"],
    },
  },
  {
    name: "ygo_card_search",
    description: "Search for Yu-Gi-Oh! cards by partial/fuzzy name match, or filter by archetype, type, attribute, race, level, ATK, DEF, or banlist status. Returns up to 20 matching cards. Use this when you don't know the exact card name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Partial card name to search (fuzzy match)" },
        type: { type: "string", description: "Card type filter (e.g., 'Effect Monster', 'Normal Trap', 'Quick-Play Spell')" },
        attribute: { type: "string", description: "Monster attribute (DARK, LIGHT, FIRE, WATER, EARTH, WIND, DIVINE)" },
        race: { type: "string", description: "Monster type/race (Warrior, Spellcaster, Dragon, Fiend, etc.)" },
        level: { type: "number", description: "Monster level/rank" },
        archetype: { type: "string", description: "Archetype name (e.g., 'Blue-Eyes', 'Branded', 'Snake-Eye')" },
        atk: { type: "number", description: "ATK value" },
        def: { type: "number", description: "DEF value" },
        banlist: { type: "string", description: "Filter by banlist: 'tcg' or 'ocg'" },
      },
      required: ["query"],
    },
  },
  {
    name: "ygo_parse_card_text",
    description: "Parse a Yu-Gi-Oh! card's effect text using the deterministic PSCT (Problem-Solving Card Text) parser. This is NOT an LLM interpretation — it is a formal grammar parser that identifies: activation conditions (text before :), costs (text before ;), effects, conjunctions (and/and if you do/also/then), timing (When vs If), effect type (Trigger/Ignition/Quick/Continuous/Flip), Spell Speed, targeting, OPT status, and Damage Step legality. Provide a card name to auto-fetch its text, or provide raw text directly.",
    inputSchema: {
      type: "object",
      properties: {
        card_name: {
          type: "string",
          description: "Card name to look up and parse (will fetch official text from database)",
        },
        card_text: {
          type: "string",
          description: "Raw card text to parse directly (use if you already have the text)",
        },
        card_type: {
          type: "string",
          description: "Card type for context (e.g., 'Effect Monster', 'Counter Trap'). Helps determine Spell Speed.",
        },
      },
    },
  },
  {
    name: "ygo_analyze_interaction",
    description: "Analyze the interaction between two Yu-Gi-Oh! cards. Determines: chain legality (can card B chain to card A?), Spell Speed compatibility, missing timing risks, SEGOC ordering (if both are triggers), and resolution sequence. Provide two card names and optionally specify who the turn player is.",
    inputSchema: {
      type: "object",
      properties: {
        card1_name: {
          type: "string",
          description: "First card name (the card that activates first / Chain Link 1)",
        },
        card2_name: {
          type: "string",
          description: "Second card name (the card responding / Chain Link 2)",
        },
        turn_player: {
          type: "string",
          enum: ["card1", "card2"],
          description: "Which card's controller is the turn player? Default: 'card1'",
        },
        scenario: {
          type: "string",
          description: "Optional scenario description (e.g., 'Card 1 activates during Main Phase, Card 2 chains')",
        },
      },
      required: ["card1_name", "card2_name"],
    },
  },
  {
    name: "ygo_check_legality",
    description: "Check a card's banlist status in both OCG and TCG. Returns whether the card is Forbidden, Limited, Semi-Limited, or Unlimited in each format.",
    inputSchema: {
      type: "object",
      properties: {
        card_name: {
          type: "string",
          description: "The card name to check",
        },
      },
      required: ["card_name"],
    },
  },
  {
    name: "ygo_archetype_cards",
    description: "Get all cards belonging to a specific Yu-Gi-Oh! archetype. Returns card names, types, and key stats for every card in the archetype.",
    inputSchema: {
      type: "object",
      properties: {
        archetype: {
          type: "string",
          description: "The archetype name (e.g., 'Blue-Eyes', 'Branded', 'Tearlaments', 'Snake-Eye')",
        },
      },
      required: ["archetype"],
    },
  },
  {
    name: "ygo_ruling_guide",
    description: "Get definitive ruling guidance on a specific Yu-Gi-Oh! game mechanic. Covers: PSCT grammar, conjunctions, timing/missing timing, SEGOC, Damage Step, Spell Speed, chain rules, targeting, effect types, and common misreadings. This returns the official rules — not opinions.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: [
            "psct_grammar",
            "conjunctions",
            "timing_missing_timing",
            "segoc",
            "damage_step",
            "spell_speed_chains",
            "targeting",
            "effect_types",
            "common_misreadings",
            "turn_structure",
            "once_per_turn",
          ],
          description: "The ruling topic to look up",
        },
      },
      required: ["topic"],
    },
  },
];

// ============================================================
// RULING GUIDE DATABASE (embedded authoritative rulings)
// ============================================================
const RULING_GUIDES = {
  psct_grammar: `# PSCT Grammar Rules

COLON (:) — Indicates the card has an activation. Text before the colon is the activation condition or timing. Text after is the effect. Cards with a colon START A CHAIN.

SEMICOLON (;) — Separates costs from the effect. Text before the semicolon is cost (paid at activation, NEVER refunded even if negated). Text after is the effect (resolves later when the chain resolves).

NO COLON + NO SEMICOLON — This is a CONTINUOUS EFFECT. It does NOT activate, does NOT start a chain, and CANNOT be "chained to." It just applies.

COMMA (,) — Separates multiple targets or clauses within the same portion of the effect. Does not have the structural weight of : or ;.

Key principle: If a card has : or ; it HAS an activation and starts a chain. If it has neither, it is continuous.`,

  conjunctions: `# The Four Conjunctions

"and" — SIMULTANEOUS, INDEPENDENT. A and B happen at the same time. Both are attempted. If one fails, the other still resolves (do as much as possible). Both must be possible at ACTIVATION.

"and if you do" — SIMULTANEOUS, B DEPENDS ON A. A and B happen at the same time, but B only occurs if A successfully happened. If A fails, B does not happen.

"also" — INDEPENDENT. A and B are independent. Even if one fails, the other still happens. They may be simultaneous or sequential.

"then" — SEQUENTIAL, B DEPENDS ON A. A happens FIRST, THEN B. If A does not happen, B does not happen. Order matters for timing purposes.

| Conjunction     | Simultaneous? | B needs A? | A needs B? |
|-----------------|:---:|:---:|:---:|
| and             | Yes | No  | No  |
| and if you do   | Yes | Yes | No  |
| also            | Either | No  | No  |
| then            | No  | Yes | No  |`,

  timing_missing_timing: `# Timing: "When" vs "If" and Missing the Timing

"When...you can" — CAN MISS TIMING. The trigger must be the LAST THING TO HAPPEN. If anything occurs after the trigger (e.g., another chain link resolving, or a card sent as cost), the "when" window passes.

"If...you can" — CANNOT MISS TIMING. Checks whether the condition was met at any point. Does not need to be the last thing.

"When/If [mandatory]" (no "you can") — CANNOT MISS TIMING. Mandatory effects must activate.

"Each time...you can" — CANNOT MISS TIMING.

WHY effects miss timing in chains: Chains resolve backwards (LIFO). If the trigger is at Chain Link 1, but Chain Link 2 resolves after it, the trigger is NOT the last thing to happen → misses timing.

SEGOC EXCEPTION: A "When...you can" effect placed on the chain by SEGOC does NOT miss timing. SEGOC guarantees its activation window.`,

  segoc: `# SEGOC — Simultaneous Effects Go On Chain

When multiple trigger effects activate at the same time, they are ordered on the chain using SEGOC:

1. Turn player's MANDATORY trigger effects (TP chooses order among their mandatory effects)
2. Non-turn player's MANDATORY trigger effects (NTP chooses order)
3. Turn player's OPTIONAL trigger effects (TP chooses order)
4. Non-turn player's OPTIONAL trigger effects (NTP chooses order)

CRITICAL: Effects placed by SEGOC do NOT miss timing, even "When...you can" effects.

OCG DIFFERENCE: OCG allows ordering non-public cards before public ones in optional effects. TCG does not distinguish.
OCG DIFFERENCE: OCG allows multiple monsters to Special Summon from hand in the same SEGOC. TCG restricts this.`,

  damage_step: `# Damage Step Rules

5 Sub-Steps:
1. Start of Damage Step — Face-down NOT flipped. ATK/DEF modifiers, Counter Traps.
2. Before Damage Calculation — Face-down monsters FLIPPED (Flip effects wait). Honest activates here.
3. During Damage Calculation — MOST RESTRICTIVE. Only "during damage calculation" effects + Counter Traps.
4. After Damage Calculation — Flip effects activate. Battle damage triggers activate. Destroyed monsters NOT yet sent to GY.
5. End of Damage Step — Destroyed monsters sent to GY. "Destroyed by battle" triggers activate.

ALWAYS legal during Damage Step:
- Counter Traps (SS3)
- Mandatory trigger effects
- Effects that directly modify ATK/DEF
- Effects that negate activations
- Cards explicitly stating Damage Step activation

NEVER legal during Damage Step:
- Ignition Effects
- General Quick-Play Spells/Traps not modifying ATK/DEF (e.g., MST)
- Normal Spell activations`,

  spell_speed_chains: `# Spell Speed & Chain Mechanics

SS1 — Normal Spells, Equip/Continuous/Field/Ritual Spells, Ignition Effects, Trigger Effects. Cannot be chained to anything. Can only start chains.

SS2 — Quick-Play Spells, Normal/Continuous Traps, Quick Effects. Can respond to SS1 and SS2.

SS3 — Counter Traps ONLY. Can respond to SS1, SS2, and SS3. ONLY another Counter Trap can respond to a Counter Trap.

Chain Building: Each new chain link must be EQUAL TO OR HIGHER Spell Speed than the previous link.

Chain Resolution: Chains resolve in REVERSE ORDER (Last In, First Out). The last effect added resolves first.

After a chain fully resolves, the game returns to an Open Game State. The turn player gets priority.`,

  targeting: `# Targeting Rules

"Target" is a SPECIFIC MECHANIC. If the card says "target," it targets. If it doesn't say "target," it does NOT target — even if the player selects/chooses a card.

Targeting happens AT ACTIVATION (before the chain resolves). The target is declared when the effect is activated, not when it resolves.

If a targeted card is no longer in the same location when the effect resolves, the effect typically cannot affect it (it "lost its target").

Cards with "choose" or that reference cards without using "target" do NOT target. Many modern boss monsters are designed to not target to get around targeting protection.

Protection against targeting (e.g., "cannot be targeted by card effects") prevents the card from being declared as a target at activation. It does NOT prevent non-targeting effects.`,

  effect_types: `# Monster Effect Types

TRIGGER — "If/When [event]: [effect]" — Activates in response to a specific game event. SS1. Can be mandatory or optional.

IGNITION — No trigger condition. Activated manually by the player. Main Phase, Open Game State only. SS1.

QUICK — Contains "(Quick Effect)." Can activate during either player's turn. SS2. Old text: "during either player's turn."

CONTINUOUS — No colon, no semicolon. Just states what it does. Does NOT activate. No Spell Speed (N/A). Cannot be chained to. Always applied while conditions met.

FLIP — "FLIP:" prefix. Activates when flipped face-up. SS1. When flipped by battle: flipped at "Before Damage Calculation," but Flip effect activates at "After Damage Calculation."`,

  common_misreadings: `# Common Card Text Misreadings

1. "Target" is specific — no "target" text = no targeting, even if choosing a card.
2. "Destroy" ≠ "Send to GY" ≠ "Banish" — different mechanics, different protections.
3. "Negate the activation" ≠ "Negate the effect" — the first treats it as never activated.
4. "Once per turn" resets if card leaves/returns. "You can only use this effect of [name] once per turn" is HARD OPT — doesn't reset, applies across copies.
5. "Cannot be destroyed by card effects" ≠ invincibility. Tribute, banish, return to hand, send to GY all still work.
6. "Special Summon" doesn't mean "from anywhere" — check the specified location.
7. "Negate" on a Continuous Effect means different things vs "Negate the effect" of an activated effect.
8. Costs (before ;) are PAID AT ACTIVATION and NEVER REFUNDED.
9. "When this card is Normal Summoned" does NOT trigger if the card was Set then Flip Summoned.
10. "Either player's turn" is old text for Quick Effect.`,

  turn_structure: `# Turn Structure

Draw Phase → Standby Phase → Main Phase 1 → Battle Phase (optional) → Main Phase 2 (only if BP entered) → End Phase

First-turn player: Skips Draw Phase, cannot enter Battle Phase.

Battle Phase Sub-Steps: Start Step → Battle Step → Damage Step → End Step

Priority: Turn player gets priority first in each phase. If TP passes and NTP also passes, phase ends.

Open Game State: Start of phases, after chains resolve. Any legal action allowed.
Closed Game State: During chain building/resolution. Only fast effects (SS2+).

Phase transitions: TP announces intent. NTP can activate fast effects before change. Both must pass for change to occur. Cannot rewind once confirmed.`,

  once_per_turn: `# Once Per Turn Rules

"Once per turn" (no card name specified) — SOFT OPT:
- Resets if the card leaves the field and returns
- Each copy of the card gets its own "once per turn"
- The same card can use the effect again if it's flipped face-down and back up

"You can only use this effect of [card name] once per turn" — HARD OPT:
- Applies regardless of how many copies you control
- Does NOT reset if the card leaves and returns
- Tracked by card name, not by individual card
- If the effect is negated, it is still "used" — you cannot try again

"You can only activate this effect of [card name] once per turn" — HARD OPT (activation):
- Similar to above, but tracks activation specifically
- If the ACTIVATION is negated (not just the effect), some interpretations allow re-activation (OCG/TCG may differ)

"You can only use each effect of [card name] once per turn" — HARD OPT for ALL effects:
- Each distinct effect on the card can only be used once per turn
- Applies across all copies`,
};

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleToolCall(name, args) {
  switch (name) {
    case "ygo_card_lookup": {
      const card = await lookupCard(args.name_or_id);
      const info = formatCardInfo(card);
      return JSON.stringify(info, null, 2);
    }

    case "ygo_card_search": {
      const filters = {};
      if (args.type) filters.type = args.type;
      if (args.attribute) filters.attribute = args.attribute;
      if (args.race) filters.race = args.race;
      if (args.level) filters.level = args.level;
      if (args.archetype) filters.archetype = args.archetype;
      if (args.atk) filters.atk = args.atk;
      if (args.def) filters.def = args.def;
      if (args.banlist) filters.banlist = args.banlist;

      const cards = await searchCards(args.query, filters);
      const results = cards.slice(0, 20).map(c => ({
        name: c.name,
        id: c.id,
        type: c.type,
        atk: c.atk,
        def: c.def,
        level: c.level,
        race: c.race,
        attribute: c.attribute,
        archetype: c.archetype || "None",
      }));
      return JSON.stringify({ count: results.length, cards: results }, null, 2);
    }

    case "ygo_parse_card_text": {
      let cardText = args.card_text;
      let cardType = args.card_type || "";
      let cardName = args.card_name || "";

      // If card_name provided, fetch from database
      if (args.card_name && !args.card_text) {
        const card = await lookupCard(args.card_name);
        cardText = card.desc;
        cardType = card.type;
        cardName = card.name;
      }

      if (!cardText) {
        return JSON.stringify({ error: "No card text provided. Specify card_name or card_text." });
      }

      const parsed = parseCardText(cardText, cardType, cardName);
      return JSON.stringify(parsed, null, 2);
    }

    case "ygo_analyze_interaction": {
      // Fetch and parse both cards
      const card1 = await lookupCard(args.card1_name);
      const card2 = await lookupCard(args.card2_name);

      const parsed1 = parseCardText(card1.desc, card1.type, card1.name);
      const parsed2 = parseCardText(card2.desc, card2.type, card2.name);

      const interaction = analyzeInteraction(parsed1, parsed2, {
        turnPlayer: args.turn_player || "card1",
        scenario: args.scenario || "",
      });

      return JSON.stringify({
        card1: { name: card1.name, type: card1.type, parsedEffects: parsed1.overallAnalysis },
        card2: { name: card2.name, type: card2.type, parsedEffects: parsed2.overallAnalysis },
        interaction,
        scenario: args.scenario || "Card 1 activates, Card 2 responds",
      }, null, 2);
    }

    case "ygo_check_legality": {
      const card = await lookupCard(args.card_name);
      const info = formatCardInfo(card);
      return JSON.stringify({
        cardName: info.name,
        banlist: info.banlist,
        type: info.type,
      }, null, 2);
    }

    case "ygo_archetype_cards": {
      const cards = await getArchetypeCards(args.archetype);
      const results = cards.map(c => ({
        name: c.name,
        type: c.type,
        atk: c.atk,
        def: c.def,
        level: c.level,
        desc: c.desc ? c.desc.substring(0, 120) + "..." : "",
      }));
      return JSON.stringify({
        archetype: args.archetype,
        count: results.length,
        cards: results,
      }, null, 2);
    }

    case "ygo_ruling_guide": {
      const guide = RULING_GUIDES[args.topic];
      if (!guide) {
        return JSON.stringify({ error: `Unknown topic: ${args.topic}. Available: ${Object.keys(RULING_GUIDES).join(", ")}` });
      }
      return guide;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// MCP SERVER SETUP
// ============================================================

const server = new Server(
  { name: "yugioh-rulings", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args || {});
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Yu-Gi-Oh! Rulings MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
