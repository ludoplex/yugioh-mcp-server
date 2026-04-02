/**
 * Yu-Gi-Oh! API Client
 * ====================
 * Interfaces with YGOProDeck API v7 for card data.
 * Includes LRU cache to minimize API calls.
 */

const BASE_URL = "https://db.ygoprodeck.com/api/v7";

// ============================================================
// LRU CACHE
// ============================================================
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      // Delete oldest (first entry)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  get size() {
    return this.cache.size;
  }
}

const cardCache = new LRUCache(1000);

// ============================================================
// API FUNCTIONS
// ============================================================

async function fetchJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to fetch from YGOProDeck: ${error.message}`);
  }
}

/**
 * Look up a card by exact name or ID
 */
async function lookupCard(nameOrId) {
  const cacheKey = `card:${String(nameOrId).toLowerCase()}`;
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  let url;
  if (typeof nameOrId === "number" || /^\d+$/.test(nameOrId)) {
    url = `${BASE_URL}/cardinfo.php?id=${encodeURIComponent(nameOrId)}`;
  } else {
    url = `${BASE_URL}/cardinfo.php?name=${encodeURIComponent(nameOrId)}`;
  }

  const data = await fetchJSON(url);
  if (data.data && data.data.length > 0) {
    const card = data.data[0];
    cardCache.set(cacheKey, card);
    // Also cache by ID
    if (card.id) cardCache.set(`card:${card.id}`, card);
    return card;
  }
  throw new Error(`Card not found: ${nameOrId}`);
}

/**
 * Search cards by fuzzy name match
 */
async function searchCards(query, filters = {}) {
  let url = `${BASE_URL}/cardinfo.php?fname=${encodeURIComponent(query)}`;

  if (filters.type) url += `&type=${encodeURIComponent(filters.type)}`;
  if (filters.attribute) url += `&attribute=${encodeURIComponent(filters.attribute)}`;
  if (filters.race) url += `&race=${encodeURIComponent(filters.race)}`;
  if (filters.level) url += `&level=${encodeURIComponent(filters.level)}`;
  if (filters.archetype) url += `&archetype=${encodeURIComponent(filters.archetype)}`;
  if (filters.banlist) url += `&banlist=${encodeURIComponent(filters.banlist)}`;
  if (filters.atk) url += `&atk=${encodeURIComponent(filters.atk)}`;
  if (filters.def) url += `&def=${encodeURIComponent(filters.def)}`;

  // Limit results
  url += "&num=20&offset=0";

  const data = await fetchJSON(url);
  return data.data || [];
}

/**
 * Get all cards in an archetype
 */
async function getArchetypeCards(archetype) {
  const cacheKey = `archetype:${archetype.toLowerCase()}`;
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}/cardinfo.php?archetype=${encodeURIComponent(archetype)}`;
  const data = await fetchJSON(url);
  const cards = data.data || [];
  cardCache.set(cacheKey, cards);
  return cards;
}

/**
 * Get all archetypes
 */
async function getAllArchetypes() {
  const cacheKey = "all_archetypes";
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}/archetypes.php`;
  const data = await fetchJSON(url);
  cardCache.set(cacheKey, data);
  return data;
}

/**
 * Get card sets info
 */
async function getCardSets() {
  const cacheKey = "all_sets";
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}/cardsets.php`;
  const data = await fetchJSON(url);
  cardCache.set(cacheKey, data);
  return data;
}

/**
 * Get database version
 */
async function getDBVersion() {
  const url = `${BASE_URL}/checkDBVer.php`;
  return await fetchJSON(url);
}

/**
 * Extract clean card info for display
 */
function formatCardInfo(card) {
  const info = {
    name: card.name,
    id: card.id,
    type: card.type,
    desc: card.desc,
    race: card.race,       // For monsters: type line (Warrior, Spellcaster, etc.)
    attribute: card.attribute,
    archetype: card.archetype || "None",
  };

  // Monster-specific fields
  if (card.atk !== undefined) info.atk = card.atk;
  if (card.def !== undefined) info.def = card.def;
  if (card.level) info.level = card.level;
  if (card.scale !== undefined) info.scale = card.scale;
  if (card.linkval) info.linkRating = card.linkval;
  if (card.linkmarkers) info.linkArrows = card.linkmarkers;

  // Banlist status
  info.banlist = {
    tcg: card.banlist_info?.ban_tcg || "Unlimited",
    ocg: card.banlist_info?.ban_ocg || "Unlimited",
  };

  // Image URLs
  if (card.card_images && card.card_images.length > 0) {
    info.imageUrl = card.card_images[0].image_url;
    info.imageUrlSmall = card.card_images[0].image_url_small;
    info.imageUrlCropped = card.card_images[0].image_url_cropped;
  }

  // Card sets
  if (card.card_sets) {
    info.sets = card.card_sets.map(s => ({
      name: s.set_name,
      code: s.set_code,
      rarity: s.set_rarity,
      price: s.set_price,
    }));
  }

  return info;
}

export {
  lookupCard,
  searchCards,
  getArchetypeCards,
  getAllArchetypes,
  getCardSets,
  getDBVersion,
  formatCardInfo,
  cardCache,
};
