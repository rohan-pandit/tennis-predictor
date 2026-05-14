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
  if (Array.isArray(raw))        return raw;
  if (raw?.data  !== undefined)  return raw.data;
  if (raw?.result !== undefined) return raw.result;
  return raw;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Round to dp decimal places; return null if not a finite number */
function n(val, dp = 1) {
  const f = parseFloat(val);
  return isFinite(f) ? Math.round(f * 10 ** dp) / 10 ** dp : null;
}

/** Unwrap single-element arrays */
function first(data) {
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

/**
 * Given p = probability of winning a single service point,
 * return the probability of holding serve (winning the game).
 * Uses the exact tennis game formula (includes deuce).
 */
function holdProbFromSvcPtPct(p) {
  const q = 1 - p;
  return (
    Math.pow(p, 4) +
    4 * Math.pow(p, 4) * q +
    10 * Math.pow(p, 4) * Math.pow(q, 2) +
    20 * Math.pow(p, 3) * Math.pow(q, 3) * (Math.pow(p, 2) / (Math.pow(p, 2) + Math.pow(q, 2)))
  );
}

// ── Stat extractors ────────────────────────────────────────────────────────────

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
    // Current year + previous year (≈ last 12-24 months)
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

/**
 * Count wins in last 10 matches.
 * The API's `result` field is a score string ("6-2 6-3"), not W/L.
 * Win indicator is `match_winner` (the winning player's numeric ID).
 */
function extractForm(pastMatchesData, playerId) {
  if (!Array.isArray(pastMatchesData) || !pastMatchesData.length) return null;
  const pid    = parseInt(playerId);
  const recent = pastMatchesData.slice(0, 10);
  let wins = 0;
  for (const m of recent) {
    const winner = parseInt(m.match_winner ?? m.matchWinner ?? m.winnerId ?? NaN);
    if (winner === pid) wins++;
  }
  return wins;
}

/**
 * Extract serve/return/bp stats from the match-stats endpoint.
 *
 * Actual response shape (confirmed from live API):
 * {
 *   serviceStats:        { acesGm, doubleFaultsGm, firstServeGm, firstServeOfGm,
 *                          winningOnFirstServeGm, winningOnSecondServeGm,
 *                          winningOnSecondServeOfGm, ... }
 *   rtnStats:            { same keys — opponent's serve stats vs this player }
 *   breakPointsServeStats: { breakPointFacedGm, breakPointSavedGm }
 *   breakPointsRtnStats:   { breakPointChanceGm, breakPointWonGm }
 * }
 * All values are raw career COUNTS, not percentages.
 * We compute the ratios ourselves.
 */
function extractMatchStats(matchStatsData) {
  const d = first(matchStatsData);
  if (!d) return { ace: null, serve: null, bp: null, hold: null, ret: null };

  const svc   = d.serviceStats          || {};
  const rtn   = d.rtnStats              || {};
  const bpSvc = d.breakPointsServeStats || {};
  const bpRtn = d.breakPointsRtnStats   || {};

  // ── First serve in % ──────────────────────────────────────────────────────
  const serve = (svc.firstServeGm && svc.firstServeOfGm)
    ? n(svc.firstServeGm / svc.firstServeOfGm * 100)
    : null;

  // ── Ace rate (aces per service game, approx 4 pts/game) ──────────────────
  // Note: all counts are career totals. Aces/game is stable enough career-wide.
  const ace = (svc.acesGm && svc.firstServeOfGm)
    ? n(svc.acesGm / (svc.firstServeOfGm / 4), 2)
    : null;

  // ── Break-point conversion % (as returner) ────────────────────────────────
  const bp = (bpRtn.breakPointChanceGm && bpRtn.breakPointWonGm)
    ? n(bpRtn.breakPointWonGm / bpRtn.breakPointChanceGm * 100)
    : null;

  // ── Hold % ────────────────────────────────────────────────────────────────
  // Derive from service points won %, then apply exact tennis game formula.
  let hold = null;
  const svcPtsWon = (svc.winningOnFirstServeGm ?? 0) + (svc.winningOnSecondServeGm ?? 0);
  const svcPtsTotal = svc.firstServeOfGm;
  if (svcPtsWon && svcPtsTotal) {
    const p = svcPtsWon / svcPtsTotal;
    if (p > 0 && p < 1) hold = n(holdProbFromSvcPtPct(p) * 100);
  }

  // ── Return points won % ───────────────────────────────────────────────────
  // total return pts = opponent's firstServeOfGm (every service point)
  // pts server won   = winningOnFirstServeGm + winningOnSecondServeGm
  // return pts won   = total - server won
  let ret = null;
  const rtnTotal   = rtn.firstServeOfGm;
  const serverWon  = (rtn.winningOnFirstServeGm ?? 0) + (rtn.winningOnSecondServeGm ?? 0);
  if (rtnTotal && serverWon) {
    ret = n((rtnTotal - serverWon) / rtnTotal * 100);
  }

  return { ace, serve, bp, hold, ret };
}

function extractH2H(h2hData) {
  // API returns an array of per-surface records — sum across all courts
  // e.g. [{court:"Hard", player1wins:"3", player2wins:"1"}, {court:"Clay", ...}]
  if (!Array.isArray(h2hData) || !h2hData.length) return { aWins: 0, bWins: 0 };
  let aWins = 0, bWins = 0;
  for (const row of h2hData) {
    aWins += parseInt(row.player1wins ?? row.player1Wins ?? row.p1Wins ?? 0) || 0;
    bWins += parseInt(row.player2wins ?? row.player2Wins ?? row.p2Wins ?? 0) || 0;
  }
  return { aWins, bWins };
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

  const failures = [
    profileAR, profileBR, matchStatsAR, matchStatsBR,
    surfSummaryAR, surfSummaryBR, pastMatchesAR, pastMatchesBR, h2hR,
  ].map(err).filter(Boolean);

  if (failures.length) console.log('Stats API partial failures:', failures);
  console.log('H2H raw:', JSON.stringify(ok(h2hR)));
  console.log('H2H result status:', h2hR.status, h2hR.status === 'rejected' ? h2hR.reason?.message : '');

  const msA = extractMatchStats(ok(matchStatsAR));
  const msB = extractMatchStats(ok(matchStatsBR));

  const statsA = {
    rank:    extractRank(ok(profileAR)),
    surface: extractSurfaceWinRate(ok(surfSummaryAR), surface),
    form:    extractForm(ok(pastMatchesAR), playerAId),
    bp:      msA.bp,
    hold:    msA.hold,
    ret:     msA.ret,
    serve:   msA.serve,
    ace:     msA.ace,
  };
  const statsB = {
    rank:    extractRank(ok(profileBR)),
    surface: extractSurfaceWinRate(ok(surfSummaryBR), surface),
    form:    extractForm(ok(pastMatchesBR), playerBId),
    bp:      msB.bp,
    hold:    msB.hold,
    ret:     msB.ret,
    serve:   msB.serve,
    ace:     msB.ace,
  };

  const filled = [...Object.values(statsA), ...Object.values(statsB)].filter(v => v !== null).length;
  const note   = failures.length
    ? `${failures.length}/9 API calls failed. ${filled}/16 stats populated.`
    : `Stats from RapidAPI live data (serve/return stats are career aggregates; surface & form are last 12 months). ${filled}/16 stats populated.`;

  return res.json({
    playerA: statsA,
    playerB: statsB,
    h2h:     extractH2H(ok(h2hR)),
    note,
  });
};
