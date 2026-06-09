const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4';

const SPORTS = ['baseball_mlb', 'basketball_nba', 'mma_mixed_martial_arts'];

async function fetchSport(sport) {
  const url = `${BASE}/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=draftkings`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

async function fetchProps(sport) {
  const gamesUrl = `${BASE}/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings`;
  const gamesRes = await fetch(gamesUrl);
  if (!gamesRes.ok) return [];
  const games = await gamesRes.json();
  const props = [];
  // fetch pitcher strikeout props for top 3 games
  for (const game of games.slice(0, 3)) {
    const pUrl = `${BASE}/sports/${sport}/events/${game.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=pitcher_strikeouts,batter_hits,batter_home_runs&oddsFormat=american&bookmakers=draftkings`;
    try {
      const pRes = await fetch(pUrl);
      if (pRes.ok) {
        const pData = await pRes.json();
        const dk = pData.bookmakers?.find(b => b.key === 'draftkings');
        if (dk) {
          for (const mkt of dk.markets || []) {
            for (const outcome of mkt.outcomes || []) {
              props.push({
                game_id: game.id,
                game: `${game.away_team} vs ${game.home_team}`,
                player: outcome.description || outcome.name,
                prop: mkt.key.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
                side: outcome.name,
                line: outcome.point,
                odds: outcome.price
              });
            }
          }
        }
      }
    } catch(e) { /* skip if prop market unavailable */ }
  }
  return props;
}

function extractLines(game) {
  const dk = game.bookmakers?.find(b => b.key === 'draftkings');
  if (!dk) return null;
  const h2h = dk.markets?.find(m => m.key === 'h2h');
  const spreads = dk.markets?.find(m => m.key === 'spreads');
  const totals = dk.markets?.find(m => m.key === 'totals');
  const awayH2H = h2h?.outcomes?.find(o => o.name === game.away_team);
  const homeH2H = h2h?.outcomes?.find(o => o.name === game.home_team);
  const awaySpread = spreads?.outcomes?.find(o => o.name === game.away_team);
  const homeSpread = spreads?.outcomes?.find(o => o.name === game.home_team);
  const over = totals?.outcomes?.find(o => o.name === 'Over');
  const under = totals?.outcomes?.find(o => o.name === 'Under');
  return {
    away_ml: awayH2H?.price ?? null,
    home_ml: homeH2H?.price ?? null,
    away_spread: awaySpread?.point ?? null,
    away_spread_odds: awaySpread?.price ?? null,
    home_spread: homeSpread?.point ?? null,
    home_spread_odds: homeSpread?.price ?? null,
    total: over?.point ?? null,
    over_odds: over?.price ?? null,
    under_odds: under?.price ?? null
  };
}

exports.handler = async () => {
  try {
    const [mlb, nba, ufc] = await Promise.all(SPORTS.map(fetchSport));
    const mlbProps = await fetchProps('baseball_mlb');

    const games = [];
    for (const sport of [{data: mlb, key:'MLB'}, {data: nba, key:'NBA'}, {data: ufc, key:'UFC'}]) {
      for (const game of (sport.data || [])) {
        const lines = extractLines(game);
        if (!lines) continue;
        games.push({
          id: game.id,
          sport: sport.key,
          away: game.away_team,
          home: game.home_team,
          game_time: game.commence_time,
          ...lines,
          sporty_pick: null,
          sporty_reasoning: null
        });
      }
    }

    // Load Sporty's picks overlay from the data repo
    let sportyData = { picks: [], parlays: [], record: {} };
    try {
      const r = await fetch('https://raw.githubusercontent.com/kteam472-cell/sporty-picks-data/main/picks.json?t=' + Date.now());
      if (r.ok) sportyData = await r.json();
    } catch(e) {}

    // Overlay Sporty's picks onto games
    for (const pick of sportyData.picks || []) {
      const game = games.find(g =>
        g.away.includes(pick.game.split(' vs ')[0].split(' ').pop()) ||
        g.home.includes(pick.game.split(' vs ')[1]?.split(' ').pop() || '')
      );
      if (game && !game.sporty_pick) {
        game.sporty_pick = pick.pick;
        game.sporty_reasoning = pick.reasoning;
        game.sporty_confidence = pick.confidence;
        game.sporty_edge = pick.edge_pct;
        game.sporty_units = pick.units;
        game.sporty_odds = pick.odds;
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify({
        last_updated: new Date().toISOString(),
        games,
        props: mlbProps,
        parlays: sportyData.parlays || [],
        record: sportyData.record || {}
      })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
