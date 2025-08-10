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

    const nights = []; // list of dateKeys
    const attendanceByNight = []; // [{ dateKey, presentSet:Set<string> }]

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

      const dateKey = dateKeyLocal(r.startTime, TIMEZONE);
      nights.push(dateKey);
      attendanceByNight.push({ dateKey, presentSet });
    }

    // 5) Rollup with alt mapping and overrides
    const altMap = readAltMap(); // alt -> main
    const overrides = readOverrides(); // { [dateKey]: { [name]: fractional } }

    const stats = {}; // { name: { nightsPossible, nightsAttended, lastSeen } }
    const dateSet = new Set(nights);

    for (const night of attendanceByNight) {
      const presentMain = new Set();
      for (const n of night.presentSet) presentMain.add(altMap[n] || n);

      const nightOverrides = overrides[night.dateKey] || {};
      const candidates = new Set([...presentMain, ...Object.keys(nightOverrides)]);

      for (const name of candidates) {
        const s = (stats[name] ||= { nightsPossible: 0, nightsAttended: 0, lastSeen: '' });
        s.nightsPossible += 1;
        const baseAttend = presentMain.has(name) ? 1 : 0;
        const applied = (nightOverrides[name] ?? baseAttend);
        s.nightsAttended += applied;
        if (!s.lastSeen || night.dateKey > s.lastSeen) s.lastSeen = night.dateKey;
      }
    }

    const rows = Object.entries(stats).map(([name, s]) => ({
      name,
      attended: Number(s.nightsAttended.toFixed(2)),
      possible: s.nightsPossible,
      pct: s.nightsPossible ? Math.round((s.nightsAttended / s.nightsPossible) * 100) : 0,
      lastSeen: s.lastSeen
    })).sort((a, b) => b.pct - a.pct || b.attended - a.attended);

    res.json({ nights: Array.from(dateSet).sort(), rows });
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
