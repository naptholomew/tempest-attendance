import express from 'express';
import { wclQuery } from '../lib/wcl.js';
import { readAltMap, readOverrides, writeOverrides, writeAltMap } from '../lib/storage.js';

const router = express.Router();

const GUILD = {
  name: process.env.GUILD_NAME || 'Tempest',
  serverSlug: (process.env.GUILD_SERVER_SLUG || 'dreamscythe').toLowerCase(),
  serverRegion: (process.env.GUILD_REGION || 'us').toLowerCase()
};
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

const GUILD_REPORTS_GQL = `
query GuildReports($guildName: String!, $guildServerSlug: String!, $guildServerRegion: String!, $start: Float!, $end: Float!) {
  reportData {
    reports(
      guildName: $guildName
      guildServerSlug: $guildServerSlug
      guildServerRegion: $guildServerRegion
      startTime: $start
      endTime: $end
      limit: 25
      page: 1
    ) {
      data { code startTime endTime }
      has_more_pages
    }
  }
}
`;


const REPORT_FIGHTS_GQL = `
query ReportFights($code: String!) {
  reportData {
    report(code: $code) {
      fights { id boss kill startTime endTime }
    }
  }
}
`;

// Presence on boss KILLS if character appears in DamageDone OR Healing tables (no damage taken/active time math)
const REPORT_DMG_TABLE_GQL = `
query DamageTable($code: String!, $fightIDs: [Int]!) {
  reportData {
    report(code: $code) {
      table(dataType: DamageDone, fightIDs: $fightIDs) {
        entries { name }
      }
    }
  }
}
`;
const REPORT_HEAL_TABLE_GQL = `
query HealingTable($code: String!, $fightIDs: [Int]!) {
  reportData {
    report(code: $code) {
      table(dataType: Healing, fightIDs: $fightIDs) {
        entries { name }
      }
    }
  }
}
`;

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

// GET /api/attendance/refresh
router.get('/refresh', async (req, res) => {
  try {
    const { start, end } = sixWeeksRange();

    // 1) Get guild reports
	const vars = {
	guildName: GUILD.name,
	guildServerSlug: GUILD.serverSlug,
	guildServerRegion: GUILD.serverRegion,
	start, end
				};
	const data = await wclQuery(GUILD_REPORTS_GQL, vars);
	const reports = data.reportData?.reports?.data ?? [];


    // 2) Only Tuesday/Thursday by server time (America/Chicago)
    const filtered = reports.filter(r => isTueOrThuLocal(r.startTime, TIMEZONE));

    const nights = []; // { dateKey, reportCode, presentSet }
    for (const r of filtered) {
      // 3) Boss kill fights only
      const fightsData = await wclQuery(REPORT_FIGHTS_GQL, { code: r.code });
      const fights = fightsData.reportData?.report?.fights ?? [];
      const killFights = fights.filter(f => f.boss && f.kill);
      if (!killFights.length) continue;
      const killIDs = killFights.map(f => f.id);

      // 4) Presence if appears in Damage OR Healing tables for any kill
      const [dmg, heal] = await Promise.all([
        wclQuery(REPORT_DMG_TABLE_GQL, { code: r.code, fightIDs: killIDs }),
        wclQuery(REPORT_HEAL_TABLE_GQL, { code: r.code, fightIDs: killIDs })
      ]);

      const presentSet = new Set();
      for (const e of (dmg.reportData?.report?.table?.entries ?? [])) {
        const name = (e.name || '').trim();
        if (name) presentSet.add(name);
      }
      for (const e of (heal.reportData?.report?.table?.entries ?? [])) {
        const name = (e.name || '').trim();
        if (name) presentSet.add(name);
      }

      const dateKey = dateKeyLocal(r.startTime, TIMEZONE);
      nights.push({ dateKey, reportCode: r.code, presentSet });
    }

    // 5) Rollup with alt mapping and overrides
    const altMap = readAltMap(); // alt -> main
    const stats = {}; // { name: { nightsPossible, nightsAttended, lastSeen } }
    const dateSet = new Set();

    for (const night of nights) {
      dateSet.add(night.dateKey);

      const presentMain = new Set();
      for (const n of night.presentSet) presentMain.add(altMap[n] || n);

      const overrides = readOverrides(); // { [dateKey]: { [name]: fractional } }
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
