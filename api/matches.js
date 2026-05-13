const Anthropic = require('@anthropic-ai/sdk');

// ── Data fetchers ──────────────────────────────────────────────────────────────

/** Strip HTML and return plain text (max maxLen chars) */
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

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Fetch ESPN tennis scoreboard (ATP or WTA) */
async function fetchESPN(tour) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard`;
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ESPN ${tour} HTTP ${res.status}`);
  const data = await res.json();
  // Normalise ESPN event structure → flat match list
  const matches = [];
  for (const event of (data.events || [])) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;
    const [home, away] = comp.competitors || [];
    matches.push({
      playerA:    home?.athlete?.displayName || home?.team?.displayName || '',
      playerB:    away?.athlete?.displayName || away?.team?.displayName || '',
      tournament: event.tournament?.displayName || event.name || '',
      category:   tour.toUpperCase(),
      round:      event.tournament?.round?.displayName || comp.type?.abbreviation || '',
      status:     comp.status?.type?.description || '',
    });
  }
  return matches;
}

/** Fetch Sofascore scheduled tennis events */
async function fetchSofascore(date) {
  const url = `https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${date}`;
  const res = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      'Referer': 'https://www.sofascore.com/',
      'Origin':  'https://www.sofascore.com',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sofascore HTTP ${res.status}`);
  const text = await res.text();
  // Guard against non-JSON (bot detection pages)
  if (!text.trim().startsWith('{')) throw new Error('Sofascore returned non-JSON (likely blocked)');
  const data = JSON.parse(text);
  return (data.events || []).slice(0, 200).map(e => ({
    playerA:    e.homeTeam?.name || e.homePlayer?.name || '',
    playerB:    e.awayTeam?.name || e.awayPlayer?.name || '',
    tournament: e.tournament?.name || '',
    category:   e.tournament?.category?.name || '',
    round:      e.roundInfo?.name || e.roundInfo?.nameCode || '',
    status:     e.status?.description || '',
  }));
}

/** Fetch a page as plain text (for Claude's fetch_page tool) */
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return stripHtml(await res.text(), 8000);
}

// ── Main handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured — add ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  const today = new Date().toISOString().split('T')[0];

  // ── Step 1: Gather match data from available sources ────────────────────────
  let matches = [];
  const sourceLog = [];

  // Try ESPN ATP + WTA in parallel
  const [atpResult, wtaResult] = await Promise.allSettled([
    fetchESPN('atp'),
    fetchESPN('wta'),
  ]);

  if (atpResult.status === 'fulfilled') {
    matches.push(...atpResult.value);
    sourceLog.push(`ESPN ATP: ${atpResult.value.length} events`);
  } else {
    sourceLog.push(`ESPN ATP failed: ${atpResult.reason?.message}`);
  }
  if (wtaResult.status === 'fulfilled') {
    matches.push(...wtaResult.value);
    sourceLog.push(`ESPN WTA: ${wtaResult.value.length} events`);
  } else {
    sourceLog.push(`ESPN WTA failed: ${wtaResult.reason?.message}`);
  }

  // If ESPN gave us nothing, try Sofascore
  if (matches.length === 0) {
    const sfResult = await Promise.allSettled([fetchSofascore(today)]);
    if (sfResult[0].status === 'fulfilled') {
      matches = sfResult[0].value;
      sourceLog.push(`Sofascore: ${matches.length} events`);
    } else {
      sourceLog.push(`Sofascore failed: ${sfResult[0].reason?.message}`);
    }
  }

  console.log('Match sources:', sourceLog.join(' | '));

  // ── Step 2: Use Claude — either filter structured data OR fetch+parse live ──
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let claudePrompt;
  let tools;
  let messages;

  if (matches.length > 0) {
    // We have data — ask Claude to filter by the tournament the user named
    claudePrompt = `The user asked: "${query.trim()}"
Today is ${today}.

Here are today's tennis matches from live data sources:
${JSON.stringify(matches, null, 2)}

1. Identify the tournament the user is asking about.
2. Filter to only matches at that tournament.
3. Infer the surface using this map:
   - clay:  Rome/Internazionali BNL d'Italia, Roland Garros/French Open, Madrid, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon, Estoril
   - grass: Wimbledon, Queen's Club, Halle, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
   - hard:  Australian Open, US Open, Miami, Indian Wells, Cincinnati, Canada, Dubai, Doha, Adelaide, Beijing, Shanghai, Paris, Vienna, Basel

Return ONLY valid JSON — no markdown, no explanation:
{
  "tournament": "exact tournament name",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "...", "playerB": "...", "round": "..." }
  ]
}`;

    messages = [{ role: 'user', content: claudePrompt }];

    try {
      const response = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 2048,
        messages,
      });
      const text = (response.content[0]?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Could not parse match list.' });
      return res.json(JSON.parse(jsonMatch[0]));
    } catch (err) {
      console.error('Claude filtering error:', err);
      return res.status(500).json({ error: err.message });
    }

  } else {
    // All APIs failed — fall back to Claude fetching a schedule page directly
    console.log('All live sources failed — using Claude fetch_page fallback');

    tools = [{
      name: 'fetch_page',
      description: 'Fetch plain text from a web page',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    }];

    messages = [{
      role: 'user',
      content: `The user asked: "${query.trim()}"
Today is ${today}.

Live score APIs are unavailable. Use fetch_page to find today's tennis matches.
Try in order:
1. https://www.bbc.com/sport/tennis
2. https://www.espn.com/tennis/
3. https://www.atptour.com/en/scores/current

Return ONLY valid JSON:
{
  "tournament": "...",
  "surface": "clay" | "grass" | "hard",
  "matches": [ { "playerA": "...", "playerB": "...", "round": "..." } ]
}`,
    }];

    try {
      let response = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 4096,
        tools,
        messages,
      });

      let iters = 0;
      while (response.stop_reason === 'tool_use' && iters < 4) {
        iters++;
        const toolUses = response.content.filter(b => b.type === 'tool_use');
        const results = await Promise.all(toolUses.map(async tu => {
          let content;
          try   { content = await fetchPageText(tu.input.url); }
          catch (e) { content = `Error: ${e.message}`; }
          return { type: 'tool_result', tool_use_id: tu.id, content };
        }));
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: results });
        response = await client.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 4096,
          tools,
          messages,
        });
      }

      const text = (response.content.find(b => b.type === 'text')?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Could not find match data from any source.' });
      return res.json(JSON.parse(jsonMatch[0]));
    } catch (err) {
      console.error('Claude fetch_page fallback error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
};
