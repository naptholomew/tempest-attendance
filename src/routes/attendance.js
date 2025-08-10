import express from 'express';
import { wclQuery } from '../lib/wcl.js';
import { readAltMap, readOverrides, writeOverrides, writeAltMap } from '../lib/storage.js';

const router = express.Router();

// Guild & timezone config
const GUILD = {
  name: process.env.GUILD_NAME || 'Tempest',
  serverSlug: (process.env.GUILD_SERVER_SLUG || 'dreamscythe').toLowerCase(),
  serverRegion: (process.env.GUILD_REGION || 'us').toLowerCase()
};
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

// Valid WoW classes (Classic + retail for safety)
const PLAYER_CLASSES = new Set([
  'Warrior','Rogue','Warlock','Paladin','Priest','Druid','Hunter','Mage','Shaman',
  'Death Knight','DeathKnight','Monk','Demon Hunter','DemonHunter','Evoker'
]);

// Known NPCs that sometimes appear in tables
const KNOWN_NPCS = new Set([
  'Lieutenant General Andorov',
  'Kaldorei Elite'
]);

/** GraphQL: paginated guild reports in a time window */
const GUILD_REPORTS_GQL = `
query GuildReports(
  $guildName: String!, $guildServerSlug: String!, $guildServerRegion: String!,
  $start: Float!, $end: Float!, $page: Int!, $limit: Int!
) {
  reportData {
    reports(
      guildName: $guildName
      guildServerSlug: $guildServerSlug
      guildServerRegion: $guildServerRegion
      startTime: $start
      endTime: $end
      page: $page
      limit: $limit
    ) {
      data { code startTime endTime }
      has_more_pages
    }
  }
}
`;

/** GraphQL: fights for a report (boss KILL fights only) */
const REPORT_FIGHTS_GQL = `
query ReportFights($code: String!) {
  reportData {
    report(code: $code) {
      fights(killType: Kills) { id name startTime endTime }
    }
  }
}
`;

/** GraphQL: table JSON for a report and fight IDs */
const REPORT_TABLE_GQL = `
query Table($code: String!, $fightIDs: [Int]!, $type: TableDataType!) {
  reportData {
    report(code: $code) {
      table(dataType: $type, fightIDs: $fightIDs)
    }
  }
}
`;

// ---- helpers ----
function sixWeeksRange() {
  const end = Date.now();
  const start = end - 1000 * 60 * 60 * 24 * 7 * 6;
  return { start, end };
}

// Tue/Thu in provided timezone
function isTueOrThuLocal(msUTC, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const day = fmt.format(new Date(msUTC)).toLowerCase();
  return day.startsWith('tue') || day.startsWith('thu');
}
function dateKeyLocal(msUTC, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(msUTC)); // yyyy-mm-dd
}

/** Pull *all* pages of reports in the window */
async function fetchAllReports(start, end) {
  const all = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const vars = {
      guildName: GUILD.name,
      guildServerSlug: GUILD.serverSlug,
      guildServerRegion: GUILD.serverRegion,
      start, end, page, limit
    };
    const data = await wclQuery(GUILD_REPORTS_GQL, vars);
    const chunk = data?.reportData?.reports?.data ?? [];
    all.push(...chunk);
    const more = data?.reportData?.reports?.has_more_pages;
    if (!more) break;
    page += 1;
  }
  return all;
}

// Safely extract entries arrays from JSON table shapes
function extractEntries(tableJson) {
  if (!tableJson) return [];
  if (Array.isArray(tableJson.entries)) return tableJson.entries;
  if (tableJson.data && Array.isArray(tableJson.data.entries)) return tableJson.data.entries;
  if (Array.isArray(tableJson.series)) {
    for (const s of tableJson.series) {
      if (s && Array.isArray(s.entries)) return s.entries;
      if (s && s.data && Array.isArray(s.data.entries)) return s.data.entries;
    }
  }
  // Fallback: scan object values for arrays of objects with "name"
  for (const v of Object.values(tableJson)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in v[0]) return v;
  }
  return [];
}

// Consider entry a player if it has a name AND (type is a known class OR type missing)
// Exclude known NPC names explicitly
function isPlayerEntry(e) {
  if (!e || !e.name) return false;
  if (KNOWN_NPCS.has(e.name)) return false;
  if (e.type == null) return true;
  return PLAYER_CLASSES.has(e.type);
}

// ---- routes ----

// GET /api/attendance/refresh
router.get('/refresh', async (_req, res) => {
  try {
    const { start, end } = sixWeeksRange();

    // 1) Get *all* reports for the window (paginated)
    const reports = await fetchAllReports(start, end);

    // 2) Only Tuesday/Thursday by server time (America/Chicago)
    const filtered = reports.filter(r => isTueOrThuLocal(r.startTime, TIMEZONE));

    // Collect per-night presence (mapped to mains) and per-night overrides
    const altMap = readAltMap(); // alt -> main
    const overridesAll = readOverrides(); // { [dateKey]: { [name]: fractional } }

    const nightKeys = []; // unique list of dateKeys
    const perNight = []; // [{ dateKey, presentMain:Set<string>, nightOverrides: Record<string, number> }]

    for (const r of filtered) {
      // 3) Boss kill fights only
      const fightsData = await wclQuery(REPORT_FIGHTS_GQL, { code: r.code });
      const fights = fightsData?.reportData?.report?.fights ?? [];
      if (!fights.length) continue;
      const killIDs = fights.map(f => f.id);

      // 4) Presence if appears in Damage OR Healing tables for any kill
      const [dmg, heal] = await Promise.all([
        wclQuery(REPORT_TABLE_GQL, { code: r.code, fightIDs: killIDs, type: 'DamageDone' }),
        wclQuery(REPORT_TABLE_GQL, { code: r.code, fightIDs: killIDs, type: 'Healing' })
      ]);

      const dmgEntries = extractEntries(dmg?.reportData?.report?.table).filter(isPlayerEntry);
      const healEntries = extractEntries(heal?.reportData?.report?.table).filter(isPlayerEntry);

      const presentSet = new Set();
      for (const e of dmgEntries) presentSet.add((e.name || '').trim());
      for (const e of healEntries) presentSet.add((e.name || '').trim());
      presentSet.delete('');

      const presentMain = new Set();
      for (const n of presentSet) presentMain.add(altMap[n] || n);

      const dateKey = dateKeyLocal(r.startTime, TIMEZONE);
      const nightOverrides = overridesAll[dateKey] || {};

      if (!nightKeys.includes(dateKey)) nightKeys.push(dateKey);
      perNight.push({ dateKey, presentMain, nightOverrides });
    }

    // 5) Universe of players who appeared or were overridden at least once
    const allPlayers = new Set();
    for (const night of perNight) {
      for (const n of night.presentMain) allPlayers.add(n);
      for (const k of Object.keys(night.nightOverrides)) allPlayers.add(k);
    }

    const totalNights = nightKeys.length;
    const stats = {}; // { name: { nightsAttended, lastSeen } }
    for (const name of allPlayers) stats[name] = { nightsAttended: 0, lastSeen: '' };

    for (const night of perNight) {
      for (const name of allPlayers) {
        const baseAttend = night.presentMain.has(name) ? 1 : 0;
        const applied = (night.nightOverrides[name] ?? baseAttend);
        stats[name].nightsAttended += applied;
        if (night.presentMain.has(name)) {
          if (!stats[name].lastSeen || night.dateKey > stats[name].lastSeen) {
            stats[name].lastSeen = night.dateKey;
          }
        }
      }
    }

    const rows = Object.entries(stats).map(([name, s]) => ({
      name,
      attended: Number(s.nightsAttended.toFixed(2)),
      possible: totalNights,
      pct: totalNights ? Math.round((s.nightsAttended / totalNights) * 100) : 0,
      lastSeen: s.lastSeen
    })).sort((a, b) => b.pct - a.pct || b.attended - a.attended);

    res.json({ nights: nightKeys.sort(), rows });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// POST /api/attendance/override  (Authorization: Bearer <token>)
router.post('/override', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { dateKey, name, fractional } = req.body || {};
  if (!dateKey || !name || typeof fractional !== 'number') {
    return res.status(400).json({ error: 'dateKey, name, fractional required' });
  }
  const overrides = readOverrides();
  overrides[dateKey] = overrides[dateKey] || {};
  overrides[dateKey][name] = fractional;
  writeOverrides(overrides);
  res.json({ ok: true });
});

// POST /api/attendance/alt-map  (Authorization: Bearer <token>)
router.post('/alt-map', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { alt, main } = req.body || {};
  if (!alt || !main) return res.status(400).json({ error: 'alt and main required' });
  const current = readAltMap();
  current[alt] = main;
  writeAltMap(current);
  res.json({ ok: true });
});

export default router;
