const Anthropic = require('@anthropic-ai/sdk');

// ── Page fetcher ───────────────────────────────────────────────────────────────

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
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
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Claude uses fetch_page to find today's matches for the requested tournament.
  // We give it a prioritised list of reliable plain-HTML sources to try.
  const tools = [{
    name: 'fetch_page',
    description: 'Fetch the plain-text content of a web page',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
      },
      required: ['url'],
    },
  }];

  const messages = [{
    role: 'user',
    content: `The user asked: "${query.trim()}"
Today is ${today}.

You need to find today's tennis match schedule for the tournament the user is asking about.

Fetch pages in this order until you have enough match data:
1. BBC Sport tennis scores: https://www.bbc.com/sport/tennis/scores-fixtures
2. LiveScore tennis: https://www.livescore.com/en/tennis/
3. The official tournament website (construct the URL based on the tournament name, e.g. https://www.internazionalibnlditalia.com for Rome, https://www.rolandgarros.com for French Open, https://www.wimbledon.com for Wimbledon)
4. WTA scores page: https://www.wtatennis.com/scores
5. ATP scores page: https://www.atptour.com/en/scores/current

Once you have match data, return ONLY a valid JSON object — no markdown fences, no explanation:
{
  "tournament": "exact full tournament name",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "First Last", "playerB": "First Last", "round": "e.g. Round of 16" }
  ]
}

Surface inference:
- clay:  Rome/Internazionali BNL d'Italia, Roland Garros/French Open, Madrid, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon
- grass: Wimbledon, Queen's Club, Halle, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
- hard:  Australian Open, US Open, Miami, Indian Wells, Cincinnati, Canada, Dubai, Doha, Adelaide, Paris, Vienna, Basel`,
  }];

  try {
    let response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      tools,
      messages,
    });

    let iters = 0;
    while (response.stop_reason === 'tool_use' && iters < 5) {
      iters++;

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          let content;
          try {
            content = await fetchPageText(tu.input.url);
            console.log(`Fetched ${tu.input.url} — ${content.length} chars`);
          } catch (err) {
            content = `Error fetching ${tu.input.url}: ${err.message}`;
            console.log(`Failed ${tu.input.url}: ${err.message}`);
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
      return res.status(500).json({ error: 'Could not find match data. Try a different tournament name or check back later.' });
    }

    return res.json(JSON.parse(jsonMatch[0]));

  } catch (err) {
    console.error('matches error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
