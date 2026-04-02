/**
 * Yu-Gi-Oh! PSCT (Problem-Solving Card Text) Deterministic Parser
 * ================================================================
 * This is NOT an LLM interpretation. It is a formal grammar parser.
 * PSCT is a controlled language with deterministic rules.
 *
 * The parser identifies:
 * - Costs (text before ;)
 * - Activation conditions (text before :)
 * - Effects (text after ; or after :)
 * - Conjunctions (and, and if you do, also, then)
 * - Timing words (When/If, mandatory/optional)
 * - Effect type (Trigger/Ignition/Quick/Continuous/Flip)
 * - Spell Speed (1/2/3)
 * - Damage Step legality
 */

// ============================================================
// CONJUNCTION PATTERNS (order matters - longest match first)
// ============================================================
const CONJUNCTIONS = [
  { pattern: /,?\s+and if you do,?\s+/gi, type: "AND_IF_YOU_DO", simultaneous: true, b_depends_on_a: true, description: "Simultaneous; B only happens if A succeeds" },
  { pattern: /,?\s+and also\s+/gi, type: "ALSO", simultaneous: true, b_depends_on_a: false, description: "Independent; both happen regardless" },
  { pattern: /;\s+also,?\s+/gi, type: "ALSO", simultaneous: true, b_depends_on_a: false, description: "Independent; both happen regardless" },
  { pattern: /,?\s+also,?\s+/gi, type: "ALSO", simultaneous: true, b_depends_on_a: false, description: "Independent; both happen regardless" },
  { pattern: /,?\s+then\s+/gi, type: "THEN", simultaneous: false, b_depends_on_a: true, description: "Sequential; B only after A succeeds" },
  // "and" is tricky - must not match "and if you do" or common phrases
  // We only match standalone "and" between two effect clauses
];

// ============================================================
// TIMING PATTERNS
// ============================================================
const TIMING_PATTERNS = {
  WHEN_OPTIONAL: /\bWhen\b.*?:\s*You can\b/i,
  IF_OPTIONAL: /\bIf\b.*?:\s*You can\b/i,
  WHEN_MANDATORY: /\bWhen\b.*?:(?!\s*You can)/i,
  IF_MANDATORY: /\bIf\b.*?:(?!\s*You can)/i,
  EACH_TIME: /\bEach time\b/i,
};

// ============================================================
// EFFECT TYPE IDENTIFIERS
// ============================================================
const QUICK_EFFECT_MARKER = /\(Quick Effect\)/i;
const FLIP_MARKER = /^FLIP:\s*/i;
const IGNITION_PATTERNS = [
  /^You can\b/i, // Starts with "You can" without trigger
  /^Once per turn[:,]?\s*you can/i,
  /^You can only use this effect/i,
];

// ============================================================
// CARD TYPE → SPELL SPEED MAPPING
// ============================================================
const CARD_TYPE_SPELL_SPEED = {
  "Normal Spell": 1, "Spell Card": 1, "Equip Spell": 1,
  "Continuous Spell": 1, "Field Spell": 1, "Ritual Spell": 1,
  "Quick-Play Spell": 2,
  "Normal Trap": 2, "Trap Card": 2, "Continuous Trap": 2,
  "Counter Trap": 3,
};

// ============================================================
// MAIN PARSER
// ============================================================

function parseCardText(cardText, cardType = "", cardName = "") {
  if (!cardText || typeof cardText !== "string") {
    return { error: "No card text provided" };
  }

  const result = {
    cardName: cardName || "Unknown",
    cardType: cardType || "Unknown",
    rawText: cardText,
    effects: [],
    overallAnalysis: {},
  };

  // Split into individual effects (separated by bullet points or line breaks for Pendulum, or numbered effects)
  // Most cards have a single effect block, but some have multiple
  const effectBlocks = splitIntoEffects(cardText);

  for (const block of effectBlocks) {
    const parsed = parseSingleEffect(block.trim(), cardType);
    result.effects.push(parsed);
  }

  // Overall analysis
  result.overallAnalysis = {
    totalEffects: result.effects.length,
    hasActivation: result.effects.some(e => e.hasActivation),
    isContinuous: result.effects.every(e => !e.hasActivation && e.effectType === "CONTINUOUS"),
    canMissTiming: result.effects.some(e => e.timing?.canMissTiming),
    spellSpeed: determineOverallSpellSpeed(result.effects, cardType),
    damageStepLegal: result.effects.map(e => ({
      effect: e.effectSummary || e.rawText.substring(0, 50),
      legal: e.damageStepLegal,
      reason: e.damageStepReason,
    })),
  };

  return result;
}

function splitIntoEffects(text) {
  // Handle bullet-point style (some modern cards)
  if (text.includes("●")) {
    return text.split("●").filter(s => s.trim());
  }
  // Handle numbered effects: (1), (2), (3)
  const numbered = text.split(/(?=\(\d+\)\s*)/).filter(s => s.trim());
  if (numbered.length > 1) return numbered;
  // Handle line-break separated (pendulum effects, etc.)
  const lines = text.split(/\r?\n/).filter(s => s.trim());
  if (lines.length > 1) {
    // Each line may still contain multiple effects — recursively split each line
    const allEffects = [];
    for (const line of lines) {
      allEffects.push(...splitSentenceEffects(line));
    }
    return allEffects;
  }
  // Single paragraph — split on sentence boundaries that start new effects
  return splitSentenceEffects(text);
}

/**
 * Split a single paragraph into separate effects at sentence boundaries.
 * Looks for ". If ", ". When ", ". You can only use ", ". Once per turn, ",
 * ". During ", ". At the start ", ". At the end " etc.
 *
 * Must NOT split inside quoted card names like "Card Name".
 * Must NOT split on ". " inside parenthetical text.
 */
function splitSentenceEffects(text) {
  if (!text || text.length < 20) return [text];

  // Regex: split at ". " followed by a PSCT effect-start keyword
  // Uses lookbehind for the period and lookahead for the keyword
  // We manually walk the string to respect quotes and parentheses
  const effects = [];
  let current = "";
  let i = 0;
  let inQuote = false;
  let depth = 0;

  while (i < text.length) {
    const c = text[i];

    // Track quotes (straight and curly)
    if (c === '"' || c === '\u201C' || c === '\u201D') {
      inQuote = !inQuote;
      current += c;
      i++;
      continue;
    }

    // Track parentheses/brackets depth
    if (!inQuote) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
    }

    // Only split at top-level (not inside quotes or parens)
    if (c === '.' && !inQuote && depth <= 0) {
      // Check if this period is followed by a space + effect-start keyword
      const rest = text.substring(i + 1);
      const effectStartMatch = rest.match(
        /^\s+(If |When |You can only |Once per turn|During |At the start |At the end |Each time |This card )/
      );

      if (effectStartMatch) {
        // Check this isn't a card-name abbreviation or abbreviation like "e.g."
        // Heuristic: the current clause should be at least 15 chars (real effect text)
        const trimmed = current.trim();
        if (trimmed.length >= 15) {
          effects.push(trimmed + ".");
          current = "";
          i++; // skip the period
          // skip whitespace after period
          while (i < text.length && /\s/.test(text[i])) i++;
          continue;
        }
      }
    }

    current += c;
    i++;
  }

  if (current.trim()) {
    effects.push(current.trim());
  }

  return effects.length > 0 ? effects : [text];
}

function parseSingleEffect(text, cardType) {
  const result = {
    rawText: text,
    hasActivation: false,
    activationCondition: null,
    cost: null,
    effect: null,
    effectType: "UNKNOWN",
    spellSpeed: null,
    timing: null,
    conjunctions: [],
    targets: false,
    isHardOPT: false,
    isSoftOPT: false,
    damageStepLegal: false,
    damageStepReason: "",
    effectSummary: "",
  };

  // ---- Step 1: Check for Hard OPT ----
  result.isHardOPT = /You can only use (?:this effect of|each effect of)?\s*"?[^"]*"?\s*once per turn/i.test(text);
  result.isSoftOPT = !result.isHardOPT && /once per turn/i.test(text);

  // ---- Step 2: Strip OPT prefix for parsing ----
  let workingText = text.replace(/^You can only use (?:this effect of|each effect of)?\s*"[^"]*"\s*once per turn\.\s*/i, "").trim();
  workingText = workingText.replace(/^\(\d+\)\s*:?\s*/, "").trim(); // Strip (1): prefix

  // ---- Step 3: Parse PSCT Punctuation (: and ;) ----
  const colonIdx = findPSCTColon(workingText);
  const semicolonIdx = findPSCTSemicolon(workingText);

  if (colonIdx !== -1) {
    result.hasActivation = true;
    result.activationCondition = workingText.substring(0, colonIdx).trim();

    const afterColon = workingText.substring(colonIdx + 1).trim();

    if (semicolonIdx !== -1 && semicolonIdx > colonIdx) {
      // Format: [condition]: [cost]; [effect]
      const afterColonSemiIdx = afterColon.indexOf(";");
      if (afterColonSemiIdx !== -1) {
        result.cost = afterColon.substring(0, afterColonSemiIdx).trim();
        result.effect = afterColon.substring(afterColonSemiIdx + 1).trim();
      } else {
        result.effect = afterColon;
      }
    } else if (semicolonIdx !== -1 && semicolonIdx < colonIdx) {
      // Format: [cost]; [condition]: [effect] (rare)
      result.cost = workingText.substring(0, semicolonIdx).trim();
      result.activationCondition = workingText.substring(semicolonIdx + 1, colonIdx).trim();
      result.effect = workingText.substring(colonIdx + 1).trim();
    } else {
      // Format: [condition]: [effect] (no cost)
      result.effect = afterColon;
    }
  } else if (semicolonIdx !== -1) {
    // Has cost but no condition (unusual but possible)
    result.hasActivation = true;
    result.cost = workingText.substring(0, semicolonIdx).trim();
    result.effect = workingText.substring(semicolonIdx + 1).trim();
  } else {
    // No colon, no semicolon = continuous effect
    result.hasActivation = false;
    result.effect = workingText;
  }

  // ---- Step 4: Identify Effect Type ----
  result.effectType = identifyEffectType(workingText, result, cardType);

  // ---- Step 5: Determine Spell Speed ----
  result.spellSpeed = determineSpellSpeed(result.effectType, cardType);

  // ---- Step 6: Parse Timing ----
  result.timing = parseTiming(workingText, result);

  // ---- Step 7: Parse Conjunctions in effect text ----
  if (result.effect) {
    result.conjunctions = parseConjunctions(result.effect);
  }

  // ---- Step 8: Check targeting ----
  result.targets = /\btarget\b/i.test(workingText);

  // ---- Step 9: Damage Step legality ----
  const ds = checkDamageStepLegality(result, cardType);
  result.damageStepLegal = ds.legal;
  result.damageStepReason = ds.reason;

  // ---- Step 10: Summary ----
  result.effectSummary = generateSummary(result);

  return result;
}

// ============================================================
// PSCT COLON FINDER (ignoring colons inside parentheses/quotes)
// ============================================================
function findPSCTColon(text) {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '\u201C' || c === '\u201D') inQuote = !inQuote;
    if (inQuote) continue;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ':' && depth === 0) {
      // Verify this isn't part of "FLIP:" or a card name
      const before = text.substring(0, i).trim();
      if (before === "FLIP") continue; // FLIP: is a special marker, not PSCT colon
      return i;
    }
  }
  return -1;
}

function findPSCTSemicolon(text) {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '\u201C' || c === '\u201D') inQuote = !inQuote;
    if (inQuote) continue;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ';' && depth === 0) return i;
  }
  return -1;
}

// ============================================================
// EFFECT TYPE IDENTIFICATION
// ============================================================
function identifyEffectType(text, parsed, cardType) {
  // Spell/Trap classification takes priority when card type is known
  // Counter Traps are ALWAYS Counter Traps regardless of effect text
  if (cardType) {
    if (/Counter Trap/i.test(cardType)) return "COUNTER_TRAP";
  }

  // Quick Effect check (highest priority for monsters)
  if (QUICK_EFFECT_MARKER.test(text)) return "QUICK";

  // Flip Effect
  if (FLIP_MARKER.test(text)) return "FLIP";

  // No activation = Continuous
  if (!parsed.hasActivation) return "CONTINUOUS";

  // For non-Counter Spell/Trap cards, classify by card type
  if (cardType) {
    if (/Quick-Play/i.test(cardType)) return "QUICK_PLAY_SPELL";
    if (/Trap/i.test(cardType)) return "TRAP";
    if (/Spell/i.test(cardType)) return "SPELL";
  }

  // Monster effect classification: check for trigger indicators
  const condition = parsed.activationCondition || "";
  const hasTrigger = /\b(When|If|Each time|During|At the start|At the end)\b/i.test(condition);

  if (hasTrigger) return "TRIGGER";

  // Check for ignition patterns
  for (const pattern of IGNITION_PATTERNS) {
    if (pattern.test(text)) return "IGNITION";
  }

  // Default to IGNITION for monster effects with activation but no trigger
  return "IGNITION";
}

// ============================================================
// SPELL SPEED
// ============================================================
function determineSpellSpeed(effectType, cardType) {
  // Monster effect spell speeds
  const monsterSS = {
    "TRIGGER": 1, "IGNITION": 1, "QUICK": 2,
    "FLIP": 1, "CONTINUOUS": null,
  };
  if (monsterSS[effectType] !== undefined) return monsterSS[effectType];

  // Card type spell speeds
  if (effectType === "COUNTER_TRAP") return 3;
  if (effectType === "TRAP") return 2;
  if (effectType === "QUICK_PLAY_SPELL") return 2;
  if (effectType === "SPELL") return 1;

  // Fallback to card type mapping
  for (const [type, ss] of Object.entries(CARD_TYPE_SPELL_SPEED)) {
    if (cardType && cardType.toLowerCase().includes(type.toLowerCase())) return ss;
  }
  return null;
}

function determineOverallSpellSpeed(effects, cardType) {
  const speeds = effects.map(e => e.spellSpeed).filter(s => s !== null);
  if (speeds.length === 0) {
    // Check card type
    for (const [type, ss] of Object.entries(CARD_TYPE_SPELL_SPEED)) {
      if (cardType && cardType.toLowerCase().includes(type.toLowerCase())) return ss;
    }
    return null;
  }
  // Return the highest spell speed among all effects
  return Math.max(...speeds);
}

// ============================================================
// TIMING ANALYSIS
// ============================================================
function parseTiming(text, parsed) {
  const result = {
    timingWord: null,     // "When" or "If" or null
    isOptional: false,    // "you can" present?
    isMandatory: false,   // No "you can"
    canMissTiming: false, // Only "When...you can" can miss timing
    explanation: "",
  };

  if (TIMING_PATTERNS.WHEN_OPTIONAL.test(text)) {
    result.timingWord = "When";
    result.isOptional = true;
    result.canMissTiming = true;
    result.explanation = 'Uses "When...you can" — CAN miss timing if the trigger is not the last thing to happen.';
  } else if (TIMING_PATTERNS.IF_OPTIONAL.test(text)) {
    result.timingWord = "If";
    result.isOptional = true;
    result.canMissTiming = false;
    result.explanation = 'Uses "If...you can" — CANNOT miss timing. Checks if condition was met at any point.';
  } else if (TIMING_PATTERNS.WHEN_MANDATORY.test(text) && parsed.hasActivation) {
    result.timingWord = "When";
    result.isMandatory = true;
    result.canMissTiming = false;
    result.explanation = 'Mandatory "When" trigger — CANNOT miss timing. Must activate when condition is met.';
  } else if (TIMING_PATTERNS.IF_MANDATORY.test(text) && parsed.hasActivation) {
    result.timingWord = "If";
    result.isMandatory = true;
    result.canMissTiming = false;
    result.explanation = 'Mandatory "If" trigger — CANNOT miss timing.';
  } else if (TIMING_PATTERNS.EACH_TIME.test(text)) {
    result.timingWord = "Each time";
    result.canMissTiming = false;
    result.explanation = '"Each time" effects NEVER miss timing.';
  }

  return result;
}

// ============================================================
// CONJUNCTION ANALYSIS
// ============================================================
function parseConjunctions(effectText) {
  const found = [];

  // Check for "and if you do" first (longest match)
  if (/\band if you do\b/i.test(effectText)) {
    found.push({
      type: "AND_IF_YOU_DO",
      simultaneous: true,
      b_depends_on_a: true,
      a_depends_on_b: false,
      description: "Simultaneous; Part B only happens if Part A succeeds. Both happen at the same time.",
    });
  }

  // Check for "also" (but not "and also" which was caught above)
  if (/\balso\b/i.test(effectText) && !/\band also\b/i.test(effectText)) {
    found.push({
      type: "ALSO",
      simultaneous: true,
      b_depends_on_a: false,
      a_depends_on_b: false,
      description: "Independent; both parts happen regardless of whether the other succeeds.",
    });
  }

  // Check for "then" (sequential dependent)
  // Must be careful not to match "then" inside other phrases
  if (/[,;]\s*then\s+/i.test(effectText) || /\.\s*then\s+/i.test(effectText) || /\bthen\s+(?:you|it|that|this|the|your|each|all|both|destroy|banish|draw|add|send|return|special|tribute|discard|negate|place|attach|detach|shuffle|excavate|look|pay|gain|lose|inflict|take)/i.test(effectText)) {
    found.push({
      type: "THEN",
      simultaneous: false,
      b_depends_on_a: true,
      a_depends_on_b: false,
      description: "Sequential; Part A happens first, then Part B. If A fails, B does not happen.",
    });
  }

  return found;
}

// ============================================================
// DAMAGE STEP LEGALITY
// ============================================================
function checkDamageStepLegality(parsed, cardType) {
  // Counter Traps: ALWAYS legal
  if (/Counter Trap/i.test(cardType) || parsed.effectType === "COUNTER_TRAP") {
    return { legal: true, reason: "Counter Traps (SS3) can always activate during the Damage Step." };
  }

  // Mandatory trigger effects: ALWAYS legal
  if (parsed.effectType === "TRIGGER" && parsed.timing?.isMandatory) {
    return { legal: true, reason: "Mandatory trigger effects can always activate during the Damage Step." };
  }

  // Effects that modify ATK/DEF
  const modifiesAtkDef = /\b(ATK|DEF|attack|gains?\s+\d+|loses?\s+\d+|becomes?\s+\d+|increase|decrease|halve|double)\b/i.test(parsed.effect || "");
  if (modifiesAtkDef) {
    return { legal: true, reason: "Effects that directly modify ATK/DEF can activate during the Damage Step." };
  }

  // Effects that negate activations or effects
  const negates = /\bnegate\b/i.test(parsed.effect || "");
  if (negates) {
    const negatesActivation = /\bnegate\s+(the\s+)?activation/i.test(parsed.effect || "");
    const negatesEffect = /\bnegate\s+(that\s+|the\s+|its\s+)?effect/i.test(parsed.effect || "");
    if (negatesActivation) {
      return { legal: true, reason: "Effects that negate activations can activate during the Damage Step." };
    }
    if (negatesEffect) {
      return { legal: true, reason: "Effects that negate card effects can activate during the Damage Step." };
    }
  }

  // Ignition effects: NEVER legal
  if (parsed.effectType === "IGNITION") {
    return { legal: false, reason: "Ignition Effects cannot activate during the Damage Step." };
  }

  // General spell/trap: usually NOT legal unless they modify ATK/DEF
  if (/Spell/i.test(cardType) && !/Quick-Play/i.test(cardType)) {
    return { legal: false, reason: "Normal/Continuous/Equip/Field/Ritual Spells cannot be activated during the Damage Step." };
  }

  // Default: restricted
  return { legal: false, reason: "Most effects cannot activate during the Damage Step unless they modify ATK/DEF, negate activations, or are Counter Traps/mandatory triggers." };
}

// ============================================================
// SUMMARY GENERATOR
// ============================================================
function generateSummary(parsed) {
  const parts = [];

  parts.push(`Effect Type: ${parsed.effectType}`);
  if (parsed.spellSpeed !== null) parts.push(`Spell Speed: ${parsed.spellSpeed}`);
  if (parsed.cost) parts.push(`Cost: ${parsed.cost}`);
  if (parsed.timing?.canMissTiming) parts.push("WARNING: Can miss timing (When...you can)");
  if (parsed.isHardOPT) parts.push("Hard Once Per Turn");
  if (parsed.targets) parts.push("This effect TARGETS");
  if (parsed.conjunctions.length > 0) {
    parts.push(`Conjunctions: ${parsed.conjunctions.map(c => c.type).join(", ")}`);
  }

  return parts.join(" | ");
}

// ============================================================
// INTERACTION ANALYZER
// ============================================================

function analyzeInteraction(card1Parsed, card2Parsed, scenario = {}) {
  const result = {
    canChain: false,
    chainLegality: "",
    timingAnalysis: "",
    segocRelevant: false,
    segocOrder: null,
    missingTimingRisk: [],
    resolution: "",
  };

  // Check chain legality (Spell Speed)
  if (card1Parsed.effects[0] && card2Parsed.effects[0]) {
    const ss1 = card1Parsed.overallAnalysis.spellSpeed;
    const ss2 = card2Parsed.overallAnalysis.spellSpeed;

    if (ss2 !== null && ss1 !== null) {
      if (ss2 >= ss1) {
        result.canChain = true;
        result.chainLegality = `${card2Parsed.cardName} (SS${ss2}) CAN chain to ${card1Parsed.cardName} (SS${ss1}). SS${ss2} >= SS${ss1}.`;
      } else {
        result.canChain = false;
        result.chainLegality = `${card2Parsed.cardName} (SS${ss2}) CANNOT chain to ${card1Parsed.cardName} (SS${ss1}). SS${ss2} < SS${ss1} — a lower Spell Speed cannot respond to a higher one.`;
      }

      // Special SS3 rule
      if (ss1 === 3 && ss2 < 3) {
        result.chainLegality += ` CRITICAL: ${card1Parsed.cardName} is SS3 (Counter Trap). ONLY another Counter Trap can respond.`;
      }
    }
  }

  // Check for missing timing risks
  for (const effect of [...card1Parsed.effects, ...card2Parsed.effects]) {
    if (effect.timing?.canMissTiming) {
      result.missingTimingRisk.push({
        card: effect.rawText.substring(0, 40) + "...",
        risk: 'This effect uses "When...you can" and CAN miss timing if it is not the last thing to happen in a chain.',
      });
    }
  }

  // SEGOC check (both are triggers activating simultaneously)
  const e1 = card1Parsed.effects[0];
  const e2 = card2Parsed.effects[0];
  if (e1?.effectType === "TRIGGER" && e2?.effectType === "TRIGGER") {
    result.segocRelevant = true;
    result.segocOrder = buildSEGOCOrder(e1, e2, scenario.turnPlayer || "card1");
  }

  return result;
}

function buildSEGOCOrder(effect1, effect2, turnPlayer) {
  // SEGOC ordering: TP mandatory → NTP mandatory → TP optional → NTP optional
  const order = [];

  const e1IsTurnPlayer = turnPlayer === "card1";
  const e1Mandatory = effect1.timing?.isMandatory || (!effect1.timing?.isOptional && effect1.effectType === "TRIGGER");
  const e2Mandatory = effect2.timing?.isMandatory || (!effect2.timing?.isOptional && effect2.effectType === "TRIGGER");

  const entries = [
    { label: "Card 1", isTurnPlayer: e1IsTurnPlayer, mandatory: e1Mandatory, optional: !e1Mandatory },
    { label: "Card 2", isTurnPlayer: !e1IsTurnPlayer, mandatory: e2Mandatory, optional: !e2Mandatory },
  ];

  // Sort: TP mandatory, NTP mandatory, TP optional, NTP optional
  const tpMandatory = entries.filter(e => e.isTurnPlayer && e.mandatory);
  const ntpMandatory = entries.filter(e => !e.isTurnPlayer && e.mandatory);
  const tpOptional = entries.filter(e => e.isTurnPlayer && e.optional);
  const ntpOptional = entries.filter(e => !e.isTurnPlayer && e.optional);

  let chainLink = 1;
  for (const group of [tpMandatory, ntpMandatory, tpOptional, ntpOptional]) {
    for (const entry of group) {
      order.push({ chainLink: chainLink++, card: entry.label, isTurnPlayer: entry.isTurnPlayer, mandatory: entry.mandatory });
    }
  }

  return order;
}

export { parseCardText, analyzeInteraction };
