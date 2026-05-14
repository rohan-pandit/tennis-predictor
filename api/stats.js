const RAPIDAPI_HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const BASE_URL      = `https://${RAPIDAPI_HOST}`;

// ── RapidAPI helper ────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const raw = await res.json();
  if (Array.isArray(raw))          return raw;
  if (raw?.data  !== undefined)    return raw.data;
  if (raw?.result !== undefined)   return raw.result;
  return raw;
}

// ── Stat extractors ────────────────────────────────────────────────────────────

/** Round to dp decimal places, return null if NaN */
function n(val, dp = 1) {
  const f = parseFloat(val);
  return isNaN(f) ? null : Math.round(f * 10 ** dp) / 10 ** dp;
}

/** Unwrap single-element arrays */
function first(data) {
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

function extractRank(profileData) {
  const p = first(profileData);
  if (!p) return null;
  const r = parseInt(p.currentRank ?? p.ranking ?? p.rank ?? p.rankPoints);
  return isNaN(r) ? null : r;
}

function extractSurfaceWinRate(surfaceData, surface) {
  if (!Array.isArray(surfaceData) || !surfaceData.length) return null;

  const targetName  = surface === 'clay' ? 'Clay' : surface === 'grass' ? 'Grass' : 'Hard';
  const currentYear = new Date().getFullYear();
  let wins = 0, losses = 0;

  for (const entry of surfaceData) {
    const year = parseInt(entry.year ?? entry.gameYear ?? entry.Year ?? 0);
    // Only include current year + previous year (last ~12-24 months of surface data)
    if (year !== currentYear && year !== currentYear - 1) continue;

    const courts = entry.courts ?? entry.data ?? entry.surfaces ?? [];
    for (const c of (Array.isArray(courts) ? courts : [])) {
      const name = String(c.court ?? c.courtName ?? c.surface ?? '');
      if (name.toLowerCase().includes(targetName.toLowerCase())) {
        wins   += parseInt(c.courtWins   ?? c.wins   ?? c.W ?? 0);
        losses += parseInt(c.courtLosses ?? c.losses ?? c.L ?? 0);
      }
    }
  }

  const total = wins + losses;
  return total > 0 ? n((wins / total) * 100) : null;
}

function extractForm(pastMatchesData) {
  if (!Array.isArray(pastMatchesData) || !pastMatchesData.length) return null;
  const recent = pastMatchesData.slice(0, 10);
  let wins = 0;
  for (const m of recent) {
    const r = m.result ?? m.outcome ?? m.winner ?? m.win;
    if (r === 'W' || r === 1 || r === '1' || r === true) wins++;
  }
  return wins;
}

function extractMatchStats(matchStatsData) {
  const d = first(matchStatsData);
  if (!d) return { ace: null, serve: null, bp: null, hold: null, ret: null };

  // Break-point conversion %
  let bp = null;
  const bpWon    = parseFloat(d.breakPointWonGm    ?? d.breakpointWonGm    ?? d.bpWon    ?? NaN);
  const bpChance = parseFloat(d.breakPointChanceGm ?? d.breakpointChanceGm ?? d.bpChance ?? NaN);
  if (!isNaN(bpWon) && !isNaN(bpChance) && bpChance > 0) {
    bp = n((bpWon / bpChance) * 100);
  } else {
    bp = n(d.breakPointConversionGm ?? d.bpConversionGm ?? d.breakPointConversion);
  }

  // Hold % (service games won %)
  const hold = n(
    d.holdGm ?? d.serviceGamesWonGm ?? d.serviceGamesWonPct ?? d.holdPct ?? d.holdPercentGm
  );

  // Return points won %
  const ret = n(
    d.returnPointsWonGm ?? d.returnPointsWonPct ?? d.returnPointsWon ?? d.returnGamesWonGm
  );

  // First serve in %
  const serve = n(
    d.firstServeGm ?? d.firstServePct ?? d.firstServeInGm ?? d.firstServeIn
  );

  // Aces per game
  const ace = n(d.acesGm ?? d.acesPgm ?? d.acesPerGame, 2);

  return { ace, serve, bp, hold, ret };
}

function extractH2H(h2hData) {
  const d = first(h2hData);
  if (!d) return { aWins: 0, bWins: 0 };
  return {
    aWins: parseInt(d.player1AllWins ?? d.player1Wins ?? d.p1Wins ?? 0) || 0,
    bWins: parseInt(d.player2AllWins ?? d.player2Wins ?? d.p2Wins ?? 0) || 0,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const {
    playerA, playerB,
    surface = 'hard', tournament = '',
    playerAId, playerBId,
    tour = 'atp',
  } = req.body || {};

  if (!playerA || !playerB) return res.status(400).json({ error: 'playerA and playerB required' });
  if (!process.env.RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY' });

  if (!playerAId || !playerBId) {
    return res.status(400).json({
      error: 'Player IDs unavailable — stats cannot be fetched for this match.',
    });
  }

  const t = tour.toLowerCase();

  // ── Fetch all 9 endpoints in parallel ─────────────────────────────────────
  const [
    profileAR, profileBR,
    matchStatsAR, matchStatsBR,
    surfSummaryAR, surfSummaryBR,
    pastMatchesAR, pastMatchesBR,
    h2hR,
  ] = await Promise.allSettled([
    apiGet(`/tennis/v2/${t}/player/profile/${playerAId}`),
    apiGet(`/tennis/v2/${t}/player/profile/${playerBId}`),
    apiGet(`/tennis/v2/${t}/player/match-stats/${playerAId}`),
    apiGet(`/tennis/v2/${t}/player/match-stats/${playerBId}`),
    apiGet(`/tennis/v2/${t}/player/surface-summary/${playerAId}`),
    apiGet(`/tennis/v2/${t}/player/surface-summary/${playerBId}`),
    apiGet(`/tennis/v2/${t}/player/past-matches/${playerAId}?pageSize=10`),
    apiGet(`/tennis/v2/${t}/player/past-matches/${playerBId}?pageSize=10`),
    apiGet(`/tennis/v2/${t}/h2h/info/${playerAId}/${playerBId}`),
  ]);

  const ok  = r => r.status === 'fulfilled' ? r.value : null;
  const err = r => r.status === 'rejected'  ? r.reason?.message : null;

  const failures = [profileAR, profileBR, matchStatsAR, matchStatsBR,
                    surfSummaryAR, surfSummaryBR, pastMatchesAR, pastMatchesBR, h2hR]
    .map(err).filter(Boolean);

  if (failures.length) {
    console.log('Stats API partial failures:', failures);
  }

  // ── TEMPORARY DEBUG: log raw shapes so we can map field names ─────────────
  const rawMatchStats = ok(matchStatsAR);
  const rawPastMatches = ok(pastMatchesAR);
  console.log('match-stats raw (playerA):', JSON.stringify(rawMatchStats)?.slice(0, 1000));
  console.log('past-matches raw[0] (playerA):', JSON.stringify(Array.isArray(rawPastMatches) ? rawPastMatches[0] : rawPastMatches)?.slice(0, 500));

  const msA = extractMatchStats(ok(matchStatsAR));
  const msB = extractMatchStats(ok(matchStatsBR));

  const statsA = {
    rank:    extractRank(ok(profileAR)),
    surface: extractSurfaceWinRate(ok(surfSummaryAR), surface),
    form:    extractForm(ok(pastMatchesAR)),
    bp:      msA.bp,
    hold:    msA.hold,
    ret:     msA.ret,
    serve:   msA.serve,
    ace:     msA.ace,
  };
  const statsB = {
    rank:    extractRank(ok(profileBR)),
    surface: extractSurfaceWinRate(ok(surfSummaryBR), surface),
    form:    extractForm(ok(pastMatchesBR)),
    bp:      msB.bp,
    hold:    msB.hold,
    ret:     msB.ret,
    serve:   msB.serve,
    ace:     msB.ace,
  };

  const filled  = [...Object.values(statsA), ...Object.values(statsB)].filter(v => v !== null).length;
  const noteStr = failures.length
    ? `${failures.length}/9 API calls failed. ${filled}/16 stats populated.`
    : `All stats fetched from RapidAPI live data. ${filled}/16 stats populated.`;

  return res.json({
    playerA: statsA,
    playerB: statsB,
    h2h:     extractH2H(ok(h2hR)),
    note:    noteStr,
  });
};
