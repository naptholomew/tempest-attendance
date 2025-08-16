import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wclQuery } from '../lib/wcl.js';
import { readAltMap, readOverrides, writeOverrides, writeAltMap } from '../lib/storage.js';

const router = express.Router();

// ------------ data dir (for excluded.json + latest cache) ------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const EXCLUDED_PATH = path.join(DATA_DIR, 'excluded.json');
const LATEST_PATH = path.join(DATA_DIR, 'attendance.latest.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EXCLUDED_PATH)) fs.writeFileSync(EXCLUDED_PATH, JSON.stringify({}, null, 2));
}
function readExcluded() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(EXCLUDED_PATH, 'utf-8')) || {}; }
  catch { return {}; }
}
function writeExcluded(obj) {
  ensureDataDir();
  fs.writeFileSync(EXCLUDED_PATH, JSON.stringify(obj, null, 2));
}
function readLatest() {
  try { return JSON.parse(fs.readFileSync(LATEST_PATH, 'utf-8')); }
  catch { return null; }
}
function writeLatest(payload) {
  ensureDataDir();
  fs.writeFileSync(LATEST_PATH, JSON.stringify({ ...payload, _cachedAt: new Date().toISOString() }, null, 2));
}

// ------------ guild & timezone ------------
const GUILD = {
  name: process.env.GUILD_NAME || 'Tempest',
  serverSlug: (process.env.GUILD_SERVER_SLUG || 'dreamscythe').toLowerCase(),
  serverRegion: (process.env.GUILD_REGION || 'us').toLowerCase()
};
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

// ------------ class filter + NPCs ------------
const PLAYER_CLASSES = new Set([
  'Warrior','Rogue','Warlock','Paladin','Priest','Druid','Hunter','Mage','Shaman',
  'Death Knight','DeathKnight','Monk','Demon Hunter','DemonHunter','Evoker'
]);
const KNOWN_NPCS = new Set(['Lieutenant General Andorov','Kaldorei Elite']);

// ------------ GraphQL ------------
const GUILD_REPORTS_GQL = `
query GuildReports($guildName:String!,$guildServerSlug:String!,$guildServerRegion:String!,$start:Float!,$end:Float!,$page:Int!,$limit:Int!){
  reportData{
    reports(
      guildName:$guildName
      guildServerSlug:$guildServerSlug
      guildServerRegion:$guildServerRegion
      startTime:$start
      endTime:$end
      page:$page
      limit:$limit
    ){
      data{ code startTime endTime }
      has_more_pages
    }
  }
}`;

const REPORT_FIGHTS_GQL = `
query ReportFights($code:String!){
  reportData{ report(code:$code){ fights(killType:Kills){ id name startTime endTime } } }
}`;

const REPORT_TABLE_GQL = `
query Table($code:String!,$fightIDs:[Int]!,$type:TableDataType!){
  reportData{ report(code:$code){ table(dataType:$type,fightIDs:$fightIDs) } }
}`;

// ------------ helpers ------------
function sixWeeksRange() {
  const end = Date.now();
  const start = end - 1000 * 60 * 60 * 24 * 7 * 6;
  return { start, end };
}
function isTueOrThuLocal(msUTC, tz) {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(msUTC)).toLowerCase();
  return w.startsWith('tue') || w.startsWith('thu');
}
function dateKeyLocal(msUTC, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(msUTC)); // yyyy-mm-dd
}
async function fetchAllReports(start, end) {
  const all = []; let page = 1; const limit = 100;
  while (true) {
    const d = await wclQuery(GUILD_REPORTS_GQL, {
      guildName: GUILD.name, guildServerSlug: GUILD.serverSlug, guildServerRegion: GUILD.serverRegion,
      start, end, page, limit
    });
    all.push(...(d?.reportData?.reports?.data ?? []));
    if (!d?.reportData?.reports?.has_more_pages) break;
    page += 1;
  }
  return all;
}
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
  for (const v of Object.values(tableJson)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in v[0]) return v;
  }
  return [];
}
function isPlayerEntry(e) {
  if (!e || !e.name) return false;
  if (KNOWN_NPCS.has(e.name)) return false;
  if (e.type == null) return true;
  return PLAYER_CLASSES.has(e.type);
}

// ------------ compute + cache payload ------------
async function computePayload() {
  const { start, end } = sixWeeksRange();
  const excluded = readExcluded();
  const reports = await fetchAllReports(start, end);

  // Group by Central date; keep only Tue/Thu; skip excluded
  const grouped = new Map(); // dateKey -> reports[]
  for (const r of reports) {
    if (!isTueOrThuLocal(r.startTime, TIMEZONE)) continue;
    const dkey = dateKeyLocal(r.startTime, TIMEZONE);
    if (excluded[dkey]) continue;
    if (!grouped.has(dkey)) grouped.set(dkey, []);
    grouped.get(dkey).push(r);
  }

  const nightKeys = Array.from(grouped.keys()).sort();
  const altMap = readAltMap();
  const overridesAll = readOverrides();

  const perNight = []; // { dateKey, presentMain:Set<string>, nightOverrides }
  for (const dateKey of nightKeys) {
    const presentSet = new Set();
    for (const r of grouped.get(dateKey) || []) {
      const fightsData = await wclQuery(REPORT_FIGHTS_GQL, { code: r.code });
      const fights = fightsData?.reportData?.report?.fights ?? [];
      if (!fights.length) continue;
      const killIDs = fights.map(f => f.id);

      const [dmg, heal] = await Promise.all([
        wclQuery(REPORT_TABLE_GQL, { code: r.code, fightIDs: killIDs, type: 'DamageDone' }),
        wclQuery(REPORT_TABLE_GQL, { code: r.code, fightIDs: killIDs, type: 'Healing' })
      ]);

      const dmgE = extractEntries(dmg?.reportData?.report?.table).filter(isPlayerEntry);
      const healE = extractEntries(heal?.reportData?.report?.table).filter(isPlayerEntry);
      for (const e of dmgE) presentSet.add((e.name || '').trim());
      for (const e of healE) presentSet.add((e.name || '').trim());
    }
    presentSet.delete('');

    const presentMain = new Set(Array.from(presentSet, n => altMap[n] || n));
    const nightOverrides = overridesAll[dateKey] || {};
    perNight.push({ dateKey, presentMain, nightOverrides });
  }

  // Per-player presence dates + player set
  const perPlayerDates = {}; // name -> string[]
  const allPlayers = new Set();
  for (const night of perNight) {
    for (const n of night.presentMain) {
      allPlayers.add(n);
      (perPlayerDates[n] ||= []).push(night.dateKey);
    }
    // An override > 0 means "present" for purposes of tooltip dates
    for (const [name, val] of Object.entries(night.nightOverrides)) {
      allPlayers.add(name);
      if (val > 0) (perPlayerDates[name] ||= []).push(night.dateKey);
    }
  }

  // Roll up stats
  const totalNights = nightKeys.length;
  const stats = {};
  for (const name of allPlayers) stats[name] = { nightsAttended: 0, lastSeen: '' };

  for (const night of perNight) {
    for (const name of allPlayers) {
      const base = night.presentMain.has(name) ? 1 : 0;
      const applied = (night.nightOverrides[name] ?? base);
      stats[name].nightsAttended += applied;
      if (applied > 0 && (!stats[name].lastSeen || night.dateKey > stats[name].lastSeen)) {
        stats[name].lastSeen = night.dateKey;
      }
    }
  }

  const rows = Object.entries(stats).map(([name, s]) => ({
    name,
    attended: Number(s.nightsAttended.toFixed(2)),
    possible: totalNights,
    pct: totalNights ? Math.round((s.nightsAttended / totalNights) * 100) : 0,
    lastSeen: s.lastSeen
  })).sort((a, b) => b.pct - a.pct || b.attended - a.attended || a.name.localeCompare(b.name));

  return { nights: nightKeys, rows, perPlayerDates, excluded };
}

// ------------ routes ------------

// FAST path: serve last cached payload
router.get('/latest', (_req, res) => {
  const cached = readLatest();
  if (!cached) return res.status(404).json({ error: 'no cached attendance yet' });
  res.json(cached);
});

// Slow path: recompute and cache
router.get('/refresh', async (_req, res) => {
  try {
    const payload = await computePayload();
    writeLatest(payload); // cache to disk
    res.json({ ...payload, _source: 'refresh' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// -------- Excluded Dates --------
router.get('/excluded', (_req, res) => {
  const ex = readExcluded();
  res.json({ dates: Object.entries(ex).map(([dateKey, reason]) => ({ dateKey, reason })) });
});
router.post('/excluded', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { dateKey, reason } = req.body || {};
  if (!dateKey) return res.status(400).json({ error: 'dateKey required (YYYY-MM-DD)' });
  const ex = readExcluded();
  ex[dateKey] = reason || 'Excluded';
  writeExcluded(ex);
  // Updating exclusions changes possible nights; recompute cache quickly
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true, dateKey, reason: ex[dateKey] });
});
router.delete('/excluded', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { dateKey } = req.body || {};
  if (!dateKey) return res.status(400).json({ error: 'dateKey required' });
  const ex = readExcluded();
  if (ex[dateKey]) { delete ex[dateKey]; writeExcluded(ex); }
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true });
});

// -------- Overrides (history + delete) --------
router.get('/overrides', (_req, res) => {
  const o = readOverrides(); // { [dateKey]: { [name]: fractional } }
  const overrides = [];
  for (const [dateKey, entries] of Object.entries(o)) {
    for (const [name, fractional] of Object.entries(entries)) {
      overrides.push({ dateKey, name, fractional });
    }
  }
  overrides.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.name.localeCompare(b.name));
  res.json({ overrides });
});
router.post('/override', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { dateKey, name, fractional } = req.body || {};
  if (!dateKey || !name || typeof fractional !== 'number') {
    return res.status(400).json({ error: 'dateKey, name, fractional required' });
  }
  const o = readOverrides();
  (o[dateKey] ||= {})[name] = fractional;
  writeOverrides(o);
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true });
});
router.delete('/override', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { dateKey, name } = req.body || {};
  if (!dateKey || !name) return res.status(400).json({ error: 'dateKey and name required' });
  const o = readOverrides();
  if (o[dateKey] && o[dateKey][name] != null) {
    delete o[dateKey][name];
    if (!Object.keys(o[dateKey]).length) delete o[dateKey];
    writeOverrides(o);
  }
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true });
});

// -------- Alt→Main (history + delete) --------
router.get('/alt-map', (_req, res) => {
  const map = readAltMap(); // { alt: main }
  const links = Object.entries(map).map(([alt, main]) => ({ alt, main }));
  links.sort((a, b) => a.alt.localeCompare(b.alt));
  res.json({ links });
});
router.post('/alt-map', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { alt, main } = req.body || {};
  if (!alt || !main) return res.status(400).json({ error: 'alt and main required' });
  const map = readAltMap();
  map[alt] = main;
  writeAltMap(map);
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true });
});
router.delete('/alt-map', express.json(), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { alt } = req.body || {};
  if (!alt) return res.status(400).json({ error: 'alt required' });
  const map = readAltMap();
  if (map[alt]) {
    delete map[alt];
    writeAltMap(map);
  }
  computePayload().then(writeLatest).catch(()=>{});
  res.json({ ok: true });
});

export default router;