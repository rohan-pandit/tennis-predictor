const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // ── Step 1: Fetch live tennis schedule from Sofascore ──────────────────────
  let matches = [];
  try {
    const sfRes = await fetch(
      `https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${today}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.sofascore.com/',
          'Origin': 'https://www.sofascore.com',
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (sfRes.ok) {
      const raw = await sfRes.json();
      // Slim to only the fields we need, cap at 200 events
      matches = (raw.events || []).slice(0, 200).map(e => ({
        playerA: e.homeTeam?.name || e.homePlayer?.name || '',
        playerB: e.awayTeam?.name || e.awayPlayer?.name || '',
        tournament: e.tournament?.name || '',
        category: e.tournament?.category?.name || '',
        round: e.roundInfo?.name || e.roundInfo?.nameCode || '',
        status: e.status?.description || '',
      }));
    }
  } catch (_) {
    // Sofascore unreachable — tell the user
    return res.status(503).json({
      error: 'Live match data is temporarily unavailable. Please try again in a moment.',
    });
  }

  if (matches.length === 0) {
    return res.json({ tournament: '', surface: 'hard', matches: [], note: 'No matches found for today.' });
  }

  // ── Step 2: Ask Claude to filter by the tournament the user asked about ─────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `The user asked: "${query.trim()}"
Today's date is ${today}.

Here are all tennis matches scheduled today (from Sofascore):
${JSON.stringify(matches, null, 2)}

Instructions:
1. Identify which tournament the user is asking about from their query.
2. Filter the list to only matches at that tournament.
3. Infer the court surface from the tournament name using this map:
   - clay:  Rome / Internazionali BNL d'Italia, Roland Garros / French Open, Madrid, Barcelona, Monte Carlo, Hamburg, Geneva, Lyon, Estoril
   - grass: Wimbledon, Queen's Club, Halle, Eastbourne, 's-Hertogenbosch, Birmingham, Nottingham
   - hard:  Australian Open, US Open, Miami, Indian Wells, Cincinnati, Canada, Dubai, Doha, Adelaide, Beijing, Shanghai, Paris, Vienna, Basel, Tokyo, Stockholm
   - If not in list, use "hard" as default.

Return ONLY a valid JSON object — no markdown fences, no explanation:
{
  "tournament": "Full tournament name",
  "surface": "clay" | "grass" | "hard",
  "matches": [
    { "playerA": "...", "playerB": "...", "round": "..." }
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
      return res.status(500).json({ error: 'Could not parse match data from response.' });
    }

    const result = JSON.parse(jsonMatch[0]);
    return res.json(result);
  } catch (err) {
    console.error('matches handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
