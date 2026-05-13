const Anthropic = require('@anthropic-ai/sdk');

// ── Fetchers ───────────────────────────────────────────────────────────────────

function stripHtml(html, maxLen = 8000) {
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

/** DuckDuckGo lite HTML search — plain HTML, works from servers */
async function searchDDG(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  return stripHtml(await res.text(), 8000);
}

/** Wikipedia summary API — clean JSON, always accessible */
async function fetchWikipedia(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&origin=*`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  const wikitext = data?.parse?.wikitext?.['*'] || '';
  return wikitext.slice(0, 8000);
}

/** Generic page fetch (strips HTML to plain text) */
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return stripHtml(await res.text(), 8000);
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
    return res.status(500).json({
      error: 'Server is not configured — add ANTHROPIC_API_KEY in Vercel environment variables.',
    });
  }

  const today = new Date().toISOString().split('T')[0];
  const year  = new Date().getFullYear();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tools = [
    {
      name: 'search_web',
      description: 'Search DuckDuckGo and return plain-text search results including titles and snippets. Best first tool to try.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'fetch_wikipedia',
      description: 'Fetch the wikitext of a Wikipedia article by its page title. Great for tournament draw pages.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Wikipedia page title, e.g. "2026 Italian Open – Men\'s Singles"' },
        },
        required: ['title'],
      },
    },
    {
      name: 'fetch_page',
      description: 'Fetch the plain-text content of any web page URL.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch' },
        },
        required: ['url'],
      },
    },
  ];

  const messages = [{
    role: 'user',
    content: `The user asked: "${query.trim()}"
Today is ${today} (year: ${year}).

STEP 1 — Identify the tournament.
Users often use informal names. Map to the official name:
- "Rome", "Rome Open", "Italian Open", "Rome Masters" → Internazionali BNL d'Italia
- "French Open", "Paris clay" → Roland Garros
- "Wimbledon", "the Championships", "SW19" → Wimbledon
- "US Open", "Flushing Meadows" → US Open
- "Australian Open", "AO" → Australian Open
- "Madrid", "Madrid Open" → Mutua Madrid Open
- "Monte Carlo", "Monaco" → Rolex Monte-Carlo Masters
- "Barcelona" → Barcelona Open Banc Sabadell
- "Miami" → Miami Open
- "Indian Wells" → BNP Paribas Open
- "Canada", "Toronto", "Montreal" → National Bank Open
- "Cincinnati" → Western & Southern Open
- "Halle" → Terra Wortmann Open
- "Queen's", "Queen's Club" → cinch Championships
Use your tennis knowledge for any other tournament.

STEP 2 — Find today's matches using tools (try in this order):

1. search_web with query: "[tournament name] ${year} today schedule draw results"
   → Look for match pairings (Player A vs Player B) in the search snippets.

2. If not enough detail, fetch_wikipedia with the ${year} tournament draw page title,
   e.g. "${year} Italian Open – Men's Singles" or "${year} French Open – Women's Singles"
   → Wikipedia draw tables list every match with player names and rounds.

3. If still needed, fetch_page from the official tournament site or a reliable schedule page.

STEP 3 — Return ONLY a valid JSON object (no markdown, no explanation):
{
  "tournament": "full official tournament name",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "First Last", "playerB": "First Last", "round": "e.g. Round of 16" }
  ]
}

Surface map:
- clay:  Internazionali BNL d'Italia, Roland Garros, Mutua Madrid Open, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon
- grass: Wimbledon, cinch Championships, Terra Wortmann Open, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
- hard:  Australian Open, US Open, Miami Open, BNP Paribas Open, National Bank Open, Western & Southern Open, Dubai, Doha, Adelaide, Paris, Vienna, Basel`,
  }];

  try {
    let response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      tools,
      messages,
    });

    let iters = 0;
    while (response.stop_reason === 'tool_use' && iters < 6) {
      iters++;

      const toolUses  = response.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          let content;
          try {
            if (tu.name === 'search_web') {
              content = await searchDDG(tu.input.query);
              console.log(`DDG search "${tu.input.query}" — ${content.length} chars`);
            } else if (tu.name === 'fetch_wikipedia') {
              content = await fetchWikipedia(tu.input.title);
              console.log(`Wikipedia "${tu.input.title}" — ${content.length} chars`);
            } else {
              content = await fetchPageText(tu.input.url);
              console.log(`Fetched ${tu.input.url} — ${content.length} chars`);
            }
          } catch (err) {
            content = `Error: ${err.message}`;
            console.log(`Tool ${tu.name} failed: ${err.message}`);
          }
          return { type: 'tool_result', tool_use_id: tu.id, content };
        })
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 4096,
        tools,
        messages,
      });
    }

    const text = (response.content.find(b => b.type === 'text')?.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('Claude final response (no JSON found):', text.slice(0, 500));
      return res.status(500).json({
        error: 'Could not find match data for that tournament today. Check that the tournament is currently active and try again.',
        debug: text.slice(0, 300),
      });
    }

    return res.json(JSON.parse(jsonMatch[0]));

  } catch (err) {
    console.error('matches error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
