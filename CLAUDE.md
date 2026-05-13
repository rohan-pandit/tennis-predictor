# Tennis Match Predictor — Claude Workflow Rules

This file defines how Claude should behave when assisting with the Tennis Match Predictor project. All rules here are the source of truth for data fetching, the prediction rules engine, and null handling.

---

## Workflow Overview

1. User asks "who is playing today at [tournament]?"
2. Claude fetches today's fixtures via MCP and lists matches for that tournament
3. User selects a match
4. Claude fetches all data points (see Data Sourcing Priority below)
5. Claude generates a pre-filled URL and gives it to the user to click
6. User reviews the pre-filled form and hits Predict

---

## Data Recency Rule

- **All stats except H2H** must use a **rolling 12-month window** (e.g. 13 May 2025 → 13 May 2026)
- If 12-month data is not available or filterable, fall back to **year to date** (1 Jan of current year → today)
- **H2H is exempt** — always use the full career head-to-head record with no date restriction
- **Ranking is exempt** — always use the current live ranking (it is not a calculated average)

---

## Data Sourcing Priority

Work through these steps in order for every stat. Stop at the first step that returns data.

### Step 1 — MCP (Tennis Scores Tool)

Use `get_tennis_scores` or `get_live_tennis_scores` for:

| Data | Method |
|---|---|
| Today's fixtures and player names | `get_tennis_scores(day=today)` |
| Surface | Inferred from tournament name (Rome = clay, Wimbledon = grass, US Open = hard, Australian Open = hard, French Open = clay) |
| Recent Form (last 10 W/L) | Query prior dates one by one, count wins and losses per player within the 12-month window |
| Head-to-Head record | Query historical dates, find past meetings between the two players (no date restriction) |

The MCP does not return player statistics (rankings, percentages, etc.). Use Steps 2–4 for those.

### Step 2 — Official Tour Sites (Primary Source for Stats)

| Tour | URL pattern |
|---|---|
| WTA | `https://www.wtatennis.com/players/[player-name]` |
| ATP | `https://www.atptour.com/en/players/[player-name]` |

Retrieve the following from the player's profile/stats page, filtered to the 12-month window where possible:

- Current ranking
- Surface win rate (filter by clay / grass / hard to match the match surface)
- Hold %
- Break point conversion %
- Return points won %
- First serve in %
- Ace rate

### Step 3 — Broader Internet Search (Fallback)

If a stat cannot be found on the official tour site:
- Run a targeted web search: `[Player Name] [stat] [current year] tennis`
- Acceptable sources: Tennis Abstract, Ultimate Tennis Statistics, ESPN, BBC Sport, official tournament pages
- Use the most recent figure available within the 12-month window, or YTD if not available

### Step 4 — Leave Blank (Final Fallback)

If a stat cannot be found after Steps 2 and 3:
- Leave the field empty — do not guess or estimate
- The null handling rules in the prediction engine will apply (neutral 50/50)

---

## Pre-filled URL Format

Once all data is collected, generate a URL using the following query parameters:

```
https://tennis-predictor-sand.vercel.app/?surface=clay
  &aName=Player+A+Name&aRank=1&aSurface=82&aForm=8&aBp=48&aHold=85&aReturn=42&aServe=68&aAce=2.1&aH2h=6
  &bName=Player+B+Name&bRank=3&bSurface=74&bForm=6&bBp=44&bHold=80&bReturn=39&bServe=64&bAce=1.4&bH2h=3
```

| Parameter | Stat |
|---|---|
| `surface` | hard / clay / grass |
| `aName` / `bName` | Player names |
| `aRank` / `bRank` | Current ranking (integer) |
| `aSurface` / `bSurface` | Surface win rate % (0–100) |
| `aForm` / `bForm` | Wins in last 10 matches (0–10) |
| `aBp` / `bBp` | Break point conversion % (0–100) |
| `aHold` / `bHold` | Hold % (0–100) |
| `aReturn` / `bReturn` | Return points won % (0–100) |
| `aServe` / `bServe` | First serve in % (0–100) |
| `aAce` / `bAce` | Ace rate (aces per game, decimal) |
| `aH2h` / `bH2h` | H2H wins (integer) |

Only include parameters where data was found. Omit parameters for missing stats — the form will leave those fields blank.

---

## Prediction Rules Engine

### Weight Table

| Priority | Stat | Weight | Direction |
|---|---|---|---|
| 1 | Head-to-Head | 22% | Higher wins = better |
| 2 | Recent Form (last 10) | 18% | More wins = better |
| 3 | Surface Win Rate | 15% | Higher % = better |
| 4 | Ranking | 12% | Lower number = better (inverted) |
| 5 | Hold % | 10% | Higher % = better |
| 6 | Break Point Conversion | 10% | Higher % = better |
| 7 | Return Points Won | 8% | Higher % = better |
| 8 | First Serve In % | 3% | Higher % = better |
| 9 | Ace Rate | 2% | Higher = better |

**Total: 100%**

### H2H Sample Size Scaling

The 22% H2H weight scales down when the two players have limited meeting history:

| Career Meetings | H2H Weight Applied | Unused Weight Redistributed To |
|---|---|---|
| 0 | 0% of 22% | Recent Form + Surface Win Rate (proportionally) |
| 1 | 25% of 22% = 5.5% | Recent Form + Surface Win Rate (proportionally) |
| 2 | 50% of 22% = 11% | Recent Form + Surface Win Rate (proportionally) |
| 3 | 75% of 22% = 16.5% | Recent Form + Surface Win Rate (proportionally) |
| 4+ | Full 22% | Nothing redistributed |

### Scoring Method

For each stat, both players receive a score between 0.0 and 1.0:
- The two scores always sum to 1.0
- A score of 0.5 means no edge either way
- Scores are scaled to a [0.2, 0.8] range so that even a large gap between players does not produce a 0% or 100% result
- Each score is multiplied by its weight
- All weighted scores are summed per player
- Final win probability = Player A total ÷ (Player A total + Player B total)

### Null Handling (Missing Stats → Neutral 50/50)

Weights never change based on data availability. A missing stat simply contributes no advantage to either player.

| Scenario | Handling |
|---|---|
| Both players have the stat | Normal scoring — compared against each other |
| Only Player A has the stat | Player B scores 0.5 (neutral), Player A keeps their real score |
| Only Player B has the stat | Player A scores 0.5 (neutral), Player B keeps their real score |
| Neither player has the stat | Both score 0.5 — zero net impact on the result |

---

## Surface Inference Map

Use this to set the `surface` parameter from the tournament name returned by the MCP:

| Surface | Tournaments (examples) |
|---|---|
| Clay | Rome (Internazionali BNL d'Italia), Roland Garros (French Open), Madrid, Barcelona, Monte Carlo, Hamburg |
| Grass | Wimbledon, Queen's Club, Halle, Eastbourne, 's-Hertogenbosch |
| Hard | Australian Open, US Open, Miami, Indian Wells, Cincinnati, Canada (Montreal/Toronto), Dubai, Doha, Adelaide |

If the tournament is not in this list, search the web for the surface before leaving it blank.

---

## Important Constraints

- Never guess or fabricate a stat value — if it cannot be found, leave the field blank
- Always tell the user which stats were found, which were estimated from YTD data, and which were left blank
- Do not modify the weights in `index.html` without also updating this file
- This file is the single source of truth — if `index.html` and this file conflict, this file wins
