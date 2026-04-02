# Yu-Gi-Oh! Rulings MCP Server — Installation Guide

## Prerequisites
- Node.js 18+ (with native `fetch`)
- Claude Desktop (any version supporting MCP)

## Quick Install

1. **Copy this folder** to a permanent location on your computer:
   ```
   cp -r yugioh-mcp-server ~/yugioh-mcp-server
   ```

2. **Install dependencies**:
   ```
   cd ~/yugioh-mcp-server
   npm install
   ```

3. **Add to Claude Desktop config**:

   Open your Claude Desktop configuration file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

   Add the following inside `"mcpServers"`:
   ```json
   {
     "mcpServers": {
       "yugioh-rulings": {
         "command": "node",
         "args": ["/FULL/PATH/TO/yugioh-mcp-server/src/index.js"]
       }
     }
   }
   ```
   Replace `/FULL/PATH/TO/` with the actual absolute path where you placed the folder.

4. **Restart Claude Desktop**.

## Available Tools

| Tool | Description |
|------|-------------|
| `ygo_card_lookup` | Look up any card by exact name or ID |
| `ygo_card_search` | Fuzzy search with filters (type, attribute, archetype, etc.) |
| `ygo_parse_card_text` | **Deterministic PSCT parser** — identifies costs, conditions, effects, timing, conjunctions, Spell Speed |
| `ygo_analyze_interaction` | Analyze chain legality, SEGOC ordering, and missing timing between two cards |
| `ygo_check_legality` | OCG/TCG banlist status |
| `ygo_archetype_cards` | List all cards in an archetype |
| `ygo_ruling_guide` | Authoritative ruling reference for 11 game mechanic topics |

## How It Works

This is NOT an LLM interpreting card text. The PSCT parser treats Problem-Solving Card Text as a **formal grammar**:

- **Colon (`:`)** = activation condition boundary
- **Semicolon (`;`)** = cost/effect boundary
- **No punctuation** = continuous effect (no chain)
- **Conjunctions** parsed with exact mechanical meanings (`and`, `and if you do`, `also`, `then`)
- **Timing** determined by pattern matching (`When...you can` = can miss timing, `If...you can` = cannot)
- **Spell Speed** derived from effect type + card type

The parser output is structured data that Claude uses to make rulings — Claude never interprets raw card text probabilistically.

## Data Source

Card data comes from YGOProDeck API v7 (https://db.ygoprodeck.com/api/v7), the largest public Yu-Gi-Oh! card database with 13,000+ cards, updated regularly. Results are cached in an LRU cache (1000 entries) to minimize API calls.

## Testing

```
npm test
```
Runs 44 tests covering PSCT parsing (12 test groups) and API integration (6 test groups).
