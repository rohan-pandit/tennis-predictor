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

/** DuckDuckGo plain-HTML search */
async function searchDDG(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const text = stripHtml(await res.text(), 7000);
  if (text.length < 100) throw new Error(`DDG returned near-empty content (${text.length}c)`);
  return text;
}

/**
 * Search Wikipedia for articles matching a query, then fetch the wikitext
 * of the best match. Avoids guessing exact article titles.
 */
async function fetchWikipediaBySearch(searchQuery) {
  // Step A: find matching article titles
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&srlimit=5&format=json&origin=*`;
  const searchRes = await fetch(searchUrl, {
    headers: { ...HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!searchRes.ok) throw new Error(`Wikipedia search HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();
  const titles = (searchData.query?.search || []).map(r => r.title);
  if (titles.length === 0) throw new Error('Wikipedia search returned no results');

  console.log(`Wikipedia search "${searchQuery}" → ${titles.join(' | ')}`);

  // Step B: fetch wikitext of the first result that has useful content
  for (const title of titles) {
    const pageUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&origin=*`;
    const pageRes = await fetch(pageUrl, {
      headers: { ...HEADERS, Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!pageRes.ok) continue;
    const pageData = await pageRes.json();
    if (pageData.error) continue;
    const wikitext = (pageData?.parse?.wikitext?.['*'] || '').slice(0, 7000);
    if (wikitext.length > 300) {
      console.log(`Wikipedia fetched "${title}" — ${wikitext.length}c`);
      return { title, content: wikitext };
    }
  }
  throw new Error('No Wikipedia article had sufficient content');
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

  // ── Step 1: Identify tournament name ────────────────────────────────────────
  const nameRes = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `The user asked: "${query.trim()}"

What is the full official name of the tennis tournament they are referring to?
Also give the common English name used on Wikipedia (e.g. "Italian Open" not "Internazionali BNL d'Italia").

Reply in this exact format (two lines, nothing else):
OFFICIAL: <official name>
WIKIPEDIA: <common English name>`,
    }],
  });

  const nameText = nameRes.content[0]?.text || '';
  const officialMatch  = nameText.match(/OFFICIAL:\s*(.+)/i);
  const wikipediaMatch = nameText.match(/WIKIPEDIA:\s*(.+)/i);

  // Strip only leading/trailing quote characters — never apostrophes inside names
  const strip = s => (s || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  const officialName  = strip(officialMatch?.[1]  || query);
  const wikipediaName = strip(wikipediaMatch?.[1] || officialName);

  console.log(`Official: "${officialName}" | Wikipedia: "${wikipediaName}"`);

  // ── Step 2: Fetch data in parallel ──────────────────────────────────────────
  const [ddgResult, wikiMensResult, wikiWomensResult] = await Promise.allSettled([
    searchDDG(`${officialName} ${year} today matches schedule draw results`),
    fetchWikipediaBySearch(`${year} ${wikipediaName} tennis singles`),
    fetchWikipediaBySearch(`${year} ${wikipediaName} women's singles tennis`),
  ]);

  const ddgText    = ddgResult.status      === 'fulfilled'
    ? ddgResult.value
    : `[DDG unavailable: ${ddgResult.reason?.message}]`;

  const wikiMens   = wikiMensResult.status  === 'fulfilled'
    ? `Article: "${wikiMensResult.value.title}"\n${wikiMensResult.value.content}`
    : `[Wikipedia men's unavailable: ${wikiMensResult.reason?.message}]`;

  const wikiWomens = wikiWomensResult.status === 'fulfilled'
    ? `Article: "${wikiWomensResult.value.title}"\n${wikiWomensResult.value.content}`
    : `[Wikipedia women's unavailable: ${wikiWomensResult.reason?.message}]`;

  console.log(`DDG: ${ddgText.length}c | WikiMens: ${wikiMens.length}c | WikiWomens: ${wikiWomens.length}c`);

  // ── Step 3: Extract matches ──────────────────────────────────────────────────
  const extractRes = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Tournament: ${officialName}
Today: ${today} (${year})

=== WEB SEARCH RESULTS ===
${ddgText}

=== WIKIPEDIA — MEN'S DRAW ===
${wikiMens}

=== WIKIPEDIA — WOMEN'S DRAW ===
${wikiWomens}

From the data above, identify the matches scheduled for TODAY (${today}) or currently in the active round of the tournament. Include both men's and women's matches if found.

Return ONLY valid JSON — no markdown, no explanation:
{
  "tournament": "${officialName}",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "First Last", "playerB": "First Last", "round": "Round name" }
  ]
}

Surface map:
- clay:  Internazionali BNL d'Italia, Roland Garros, Mutua Madrid Open, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon
- grass: Wimbledon, cinch Championships, Terra Wortmann Open, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
- hard:  Australian Open, US Open, Miami Open, BNP Paribas Open, National Bank Open, Western & Southern Open, Dubai, Doha, Adelaide, Paris, Vienna, Basel`,
    }],
  });

  const text = (extractRes.content[0]?.text || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    console.log('No JSON in extract response:', text.slice(0, 400));
    return res.status(500).json({
      error: 'Could not find match data. The tournament may not be currently active.',
      debug: text.slice(0, 300),
    });
  }

  return res.json(JSON.parse(jsonMatch[0]));
};
