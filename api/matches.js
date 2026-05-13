const Anthropic = require('@anthropic-ai/sdk');

const RAPIDAPI_HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const BASE_URL      = `https://${RAPIDAPI_HOST}`;

// ── RapidAPI fetcher (same API the MCP uses) ───────────────────────────────────

async function fetchFixtures(tour, date) {
  const url = `${BASE_URL}/tennis/v2/${tour}/fixtures/${date}?include=tournament,round&pageSize=100`;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RapidAPI ${tour} HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data ?? data.result ?? []);
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
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY in Vercel environment variables.' });
  }
  if (!process.env.RAPIDAPI_KEY) {
    return res.status(500).json({ error: 'Missing RAPIDAPI_KEY in Vercel environment variables.' });
  }

  const today = new Date().toISOString().split('T')[0];

  // ── Step 1: Fetch today's ATP + WTA fixtures from RapidAPI (parallel) ────────
  const [atpResult, wtaResult] = await Promise.allSettled([
    fetchFixtures('atp', today),
    fetchFixtures('wta', today),
  ]);

  const raw = [
    ...(atpResult.status  === 'fulfilled' ? atpResult.value  : []),
    ...(wtaResult.status  === 'fulfilled' ? wtaResult.value  : []),
  ];

  if (atpResult.status === 'rejected') console.log('ATP fetch failed:', atpResult.reason?.message);
  if (wtaResult.status === 'rejected') console.log('WTA fetch failed:', wtaResult.reason?.message);

  if (raw.length === 0) {
    return res.status(503).json({ error: 'Could not fetch today\'s fixtures. Please try again.' });
  }

  // Log first raw match so we can see all available fields (used to find singles/doubles filter)
  console.log('RAW MATCH SAMPLE:', JSON.stringify(raw[0], null, 2));

  // Normalise to a slim structure Claude can filter easily
  const matches = raw
    .map(m => ({
      playerA:    m.player1?.fullName ?? m.player1?.name ?? '',
      playerB:    m.player2?.fullName ?? m.player2?.name ?? '',
      tournament: m.tournament?.name  ?? '',
      round:      m.round?.name       ?? (typeof m.round === 'string' ? m.round : ''),
    }))
    .filter(m => m.playerA && m.playerB);

  console.log(`Fetched ${matches.length} matches across ${new Set(matches.map(m => m.tournament)).size} tournaments`);

  // ── Step 2: Ask Claude to filter by tournament + infer surface ─────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `The user asked: "${query.trim()}"
Today is ${today}.

Here are all tennis matches scheduled today (${matches.length} total across all tournaments):
${JSON.stringify(matches, null, 2)}

1. Identify which tournament the user is asking about. They may use an informal name:
   - "Rome", "Rome Open", "Italian Open", "Rome Masters" → Internazionali BNL d'Italia
   - "French Open", "Paris clay" → Roland Garros
   - "Wimbledon", "the Championships" → Wimbledon
   - "US Open", "Flushing Meadows" → US Open
   - "Australian Open", "AO" → Australian Open
   - "Madrid" → Mutua Madrid Open
   - "Monte Carlo" → Rolex Monte-Carlo Masters
   - "Canada", "Toronto", "Montreal" → National Bank Open
   - "Cincinnati" → Western & Southern Open
   - "Halle" → Terra Wortmann Open
   - "Queen's" → cinch Championships
   Use your tennis knowledge for any other tournament name.

2. Filter the matches list to only those from that tournament.

3. Infer the surface:
   - clay:  Internazionali BNL d'Italia, Roland Garros, Mutua Madrid Open, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon
   - grass: Wimbledon, cinch Championships, Terra Wortmann Open, Eastbourne, 's-Hertogenbosch, Birmingham
   - hard:  Australian Open, US Open, Miami Open, BNP Paribas Open, National Bank Open, Western & Southern Open, Dubai, Doha, Adelaide, Paris, Vienna, Basel

Return ONLY valid JSON — no markdown, no explanation:
{
  "tournament": "exact tournament name from the data",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "First Last", "playerB": "First Last", "round": "Round name" }
  ]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (response.content[0]?.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.log('Claude returned no JSON:', text.slice(0, 300));
      return res.status(500).json({ error: 'Could not parse match list.', debug: text.slice(0, 300) });
    }

    return res.json(JSON.parse(jsonMatch[0]));

  } catch (err) {
    console.error('Claude error:', err);
    return res.status(500).json({ error: err.message });
  }
};
