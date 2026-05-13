const Anthropic = require('@anthropic-ai/sdk');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Fetch a URL and return stripped plain text (max 6000 chars) */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

/** Convert "First Last" → "FirstLast" for Tennis Abstract URLs */
function taSlug(name) {
  return name.replace(/\s+/g, '').replace(/[^a-zA-Z]/g, '');
}

/** Map surface name to Tennis Abstract surface code */
function surfaceCode(surface) {
  if (surface === 'clay') return 'C';
  if (surface === 'grass') return 'G';
  return 'H';
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { playerA, playerB, surface = 'hard', tournament = '' } = req.body || {};
  if (!playerA || !playerB) return res.status(400).json({ error: 'playerA and playerB are required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  const today = new Date();
  const currentYear = today.getFullYear();
  const oneYearAgo = new Date(today - 365 * 24 * 60 * 60 * 1000);
  const dateRange = `${oneYearAgo.toISOString().split('T')[0]} to ${today.toISOString().split('T')[0]}`;
  const sc = surfaceCode(surface);
  const paSlug = taSlug(playerA);
  const pbSlug = taSlug(playerB);

  // ── Fetch pages in parallel ──────────────────────────────────────────────────
  const urlMap = {
    paYTD:   `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${paSlug}&f=ACareer&t=0&surface=${sc}&year=${currentYear}`,
    pbYTD:   `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${pbSlug}&f=ACareer&t=0&surface=${sc}&year=${currentYear}`,
    h2h:     `https://www.tennisabstract.com/cgi-bin/player-matchrecord.cgi?p=${paSlug}&p2=${pbSlug}`,
    paForm:  `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${paSlug}&f=ACareer&t=0&year=${currentYear - 1}&year2=${currentYear}`,
    pbForm:  `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${pbSlug}&f=ACareer&t=0&year=${currentYear - 1}&year2=${currentYear}`,
  };

  const fetched = {};
  await Promise.allSettled(
    Object.entries(urlMap).map(async ([key, url]) => {
      try {
        fetched[key] = `[Source: ${url}]\n${await fetchPage(url)}`;
      } catch (err) {
        fetched[key] = `[Could not fetch ${url}: ${err.message}]`;
      }
    })
  );

  // ── Ask Claude to extract stats from the fetched pages ──────────────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const extractPrompt = `You are a tennis statistics researcher. Extract stats for this match:

Match: ${playerA} vs ${playerB}
Surface: ${surface}
Tournament: ${tournament || 'unknown'}
Stats date range (12-month rolling window): ${dateRange}

FETCHED PAGES:

=== ${playerA} — ${surface} surface stats (${currentYear} YTD) ===
${fetched.paYTD}

=== ${playerB} — ${surface} surface stats (${currentYear} YTD) ===
${fetched.pbYTD}

=== Head-to-Head (career, no date restriction) ===
${fetched.h2h}

=== ${playerA} — Last 12 months (for recent form / win rate) ===
${fetched.paForm}

=== ${playerB} — Last 12 months (for recent form / win rate) ===
${fetched.pbForm}

INSTRUCTIONS:
- Extract each stat from the pages above. Use the ${currentYear} YTD or 12-month data.
- "form" = wins in last 10 matches (count the 10 most recent matches in the 12-month window and tally W/L).
- "surface" = win rate % on ${surface} courts (0–100).
- "rank" = current ATP/WTA ranking (integer); if not on the page, leave null.
- "bp" = break point conversion % (0–100).
- "hold" = hold % / service games won % (0–100).
- "ret" = return points won % (0–100).
- "serve" = first serve in % (0–100).
- "ace" = aces per game (decimal, e.g. 1.5).
- H2H: count career wins for each player. Use the full career record.
- Use null for any stat that cannot be found in the pages — do NOT guess or invent values.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "playerA": {
    "rank": null,
    "surface": null,
    "form": null,
    "bp": null,
    "hold": null,
    "ret": null,
    "serve": null,
    "ace": null
  },
  "playerB": {
    "rank": null,
    "surface": null,
    "form": null,
    "bp": null,
    "hold": null,
    "ret": null,
    "serve": null,
    "ace": null
  },
  "h2h": {
    "aWins": 0,
    "bWins": 0
  },
  "note": "brief summary of what was found vs left null"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      messages: [{ role: 'user', content: extractPrompt }],
    });

    const text = (response.content[0]?.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Could not extract stats.', raw: text.slice(0, 400) });
    }

    const stats = JSON.parse(jsonMatch[0]);
    return res.json(stats);
  } catch (err) {
    console.error('stats handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
