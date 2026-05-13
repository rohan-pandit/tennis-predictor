const Anthropic = require('@anthropic-ai/sdk');

// ── Fetchers ───────────────────────────────────────────────────────────────────

function stripHtml(html, maxLen = 7000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function searchDDG(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const text = stripHtml(await res.text(), 7000);
  if (text.length < 50) throw new Error('DDG returned empty content');
  return text;
}

async function fetchWikipedia(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&origin=*`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Wikipedia: ${data.error.info}`);
  return (data?.parse?.wikitext?.['*'] || '').slice(0, 7000);
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured — add ANTHROPIC_API_KEY in Vercel.' });
  }

  const today = new Date().toISOString().split('T')[0];
  const year  = new Date().getFullYear();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Step 1: Identify the official tournament name (fast, no tools) ───────────
  const nameRes = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: `The user asked: "${query.trim()}"\n\nWhat is the full official name of the tennis tournament they are referring to? Reply with ONLY the tournament name, nothing else. Examples: "Internazionali BNL d'Italia", "Roland Garros", "Wimbledon".`,
    }],
  });
  const tournamentName = (nameRes.content[0]?.text || query).trim().replace(/['"]/g, '');
  console.log(`Tournament identified: ${tournamentName}`);

  // ── Step 2: Pre-fetch sources in parallel (we control what's fetched) ────────
  const searchQuery = `${tournamentName} ${year} today matches schedule draw results`;

  const [ddgResult, wikiMensResult, wikiWomensResult] = await Promise.allSettled([
    searchDDG(searchQuery),
    fetchWikipedia(`${year} ${tournamentName} – Men's singles`),
    fetchWikipedia(`${year} ${tournamentName} – Women's singles`),
  ]);

  const ddgText      = ddgResult.status      === 'fulfilled' ? ddgResult.value      : `[DDG failed: ${ddgResult.reason?.message}]`;
  const wikiMens     = wikiMensResult.status  === 'fulfilled' ? wikiMensResult.value  : `[Wikipedia men's failed: ${wikiMensResult.reason?.message}]`;
  const wikiWomens   = wikiWomensResult.status === 'fulfilled' ? wikiWomensResult.value : `[Wikipedia women's failed: ${wikiWomensResult.reason?.message}]`;

  console.log(`DDG: ${ddgText.length}c | WikiMens: ${wikiMens.length}c | WikiWomens: ${wikiWomens.length}c`);

  // ── Step 3: Extract matches from the pre-fetched data (no tool loop) ─────────
  const extractRes = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Tournament: ${tournamentName}
Today: ${today} (${year})

Data from sources:

=== WEB SEARCH RESULTS ===
${ddgText}

=== WIKIPEDIA — MEN'S DRAW ===
${wikiMens}

=== WIKIPEDIA — WOMEN'S DRAW ===
${wikiWomens}

From the data above, find the matches scheduled or played on ${today}, or if the exact date is unclear, the matches in the current round of the tournament.

Return ONLY valid JSON — no markdown, no explanation:
{
  "tournament": "${tournamentName}",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "First Last", "playerB": "First Last", "round": "Round name" }
  ]
}

Surface map (use to set "surface"):
- clay:  Internazionali BNL d'Italia, Roland Garros, Mutua Madrid Open, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon
- grass: Wimbledon, cinch Championships, Terra Wortmann Open, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
- hard:  Australian Open, US Open, Miami Open, BNP Paribas Open, National Bank Open, Western & Southern Open, Dubai, Doha, Adelaide, Paris, Vienna, Basel`,
    }],
  });

  const text = (extractRes.content[0]?.text || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    console.log('Extract step — no JSON found. Claude said:', text.slice(0, 400));
    return res.status(500).json({
      error: 'Could not find match data. The tournament may not be currently active, or try a slightly different tournament name.',
      debug: text.slice(0, 300),
    });
  }

  return res.json(JSON.parse(jsonMatch[0]));
};
