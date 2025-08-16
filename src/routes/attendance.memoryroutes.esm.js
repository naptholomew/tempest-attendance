/**
 * attendance.memoryroutes.esm.js
 * ESM router: in-memory state + optional snapshot + **mirror to legacy files**
 * so your legacy /refresh sees admin changes.
 *
 * Legacy file expectations from storage.js:
 *   ./data/attendance_overrides.json   // { [dateKey]: { [name]: fractional } }
 *   ./data/alt_map.json                // { [altName]: mainName }
 * (No excluded file defined in storage.js)
 *
 * Optional: we also write ./data/excluded_dates.json (array) for future use,
 * but legacy /refresh must be patched to read/apply it.
 */

import { Router, json as jsonParser } from 'express';
import fs from 'fs';
import path from 'path';

const fsp = fs.promises;

// ---------- Helpers ----------
async function ensureDir(dir) {
  if (!dir) return;
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
}

async function writeJSON(filepath, data) {
  await ensureDir(path.dirname(filepath));
  await fsp.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeStateShape(obj) {
  return {
    overrides: Array.isArray(obj?.overrides) ? obj.overrides : [], // [{dateKey,name,fractional}]
    links:     Array.isArray(obj?.links)     ? obj.links     : [], // [{alt,main}]
    dates:     Array.isArray(obj?.dates)     ? obj.dates     : [], // [{dateKey,reason?}]
  };
}

// Convert memory state → legacy file shapes
function toLegacyOverrides(overridesArr) {
  // [{dateKey,name,fractional}] -> { [dateKey]: { [name]: fractional } }
  const out = {};
  for (const { dateKey, name, fractional } of overridesArr) {
    if (!dateKey || !name || Number.isNaN(Number(fractional))) continue;
    const dk = String(dateKey);
    const nm = String(name);
    const fr = Number(fractional);
    out[dk] ??= {};
    out[dk][nm] = fr;
  }
  return out;
}

function toLegacyAltMap(linksArr) {
  // [{alt,main}] -> { [alt]: main }
  const out = {};
  for (const { alt, main } of linksArr) {
    if (!alt || !main) continue;
    out[String(alt)] = String(main);
  }
  return out;
}

export default function memoryRoutes(opts = {}) {
  const ADMIN_TOKEN  = (opts.adminToken  ?? process.env.ATTEND_ADMIN_TOKEN ?? '').trim();
  const PERSIST_FILE = (opts.persistFile ?? process.env.LOCAL_STATE_PATH   ?? '').trim();

  // Mirror to the same dir/file names your storage.js uses:
  const LEGACY_DIR = (process.env.LEGACY_DATA_DIR ?? './data').trim();
  const LEGACY_PATHS = {
    overrides: path.join(LEGACY_DIR, 'attendance_overrides.json'),
    links:     path.join(LEGACY_DIR, 'alt_map.json'),
    // Not used by legacy yet, but we write it for future:
    dates:     path.join(LEGACY_DIR, 'excluded_dates.json'),
  };

  /** In-memory state (used by admin export/import) */
  const state = { overrides: [], links: [], dates: [] };

  // ---------- Persistence (optional snapshot of WHOLE state) ----------
  async function maybeLoadPersist() {
    if (!PERSIST_FILE) return;
    try {
      const txt = await fsp.readFile(PERSIST_FILE, 'utf-8');
      Object.assign(state, normalizeStateShape(JSON.parse(txt)));
    } catch {
      // ok if missing/invalid
    }
  }
  async function maybeSavePersist() {
    if (!PERSIST_FILE) return;
    await writeJSON(PERSIST_FILE, state);
  }

  // Mirror to legacy files/shape so legacy /refresh reads latest admin changes
  async function mirrorToLegacy() {
    const legacyOverrides = toLegacyOverrides(state.overrides);
    const legacyAltMap    = toLegacyAltMap(state.links);
    // dates remain as array; legacy /refresh must be updated to read/apply if desired
    await Promise.all([
      writeJSON(LEGACY_PATHS.overrides, legacyOverrides),
      writeJSON(LEGACY_PATHS.links,     legacyAltMap),
      writeJSON(LEGACY_PATHS.dates,     state.dates),
    ]);
  }

  async function saveAll() {
    await Promise.all([maybeSavePersist(), mirrorToLegacy()]);
  }

  // ---------- Auth ----------
  function requireAuth(req, res, next) {
    const header = String(req.headers['authorization'] || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!ADMIN_TOKEN) return res.status(401).json({ error: 'Server missing ATTEND_ADMIN_TOKEN' });
    if (!token || token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  // ---------- Router ----------
  const r = Router();
  r.use(jsonParser());

  r.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Admin export/import of full state
  r.get('/state', (_req, res) => {
    res.json({ overrides: state.overrides, links: state.links, dates: state.dates });
  });
  r.post('/import', requireAuth, async (req, res) => {
    const inc = normalizeStateShape(req.body || {});
    state.overrides = inc.overrides;
    state.links     = inc.links;
    state.dates     = inc.dates;
    await saveAll();
    res.json({ ok: true });
  });

  // ----- Overrides -----
  r.get('/overrides', (_req, res) => {
    const sorted = [...state.overrides]
      .sort((a, b) => (a.dateKey === b.dateKey)
        ? String(a.name).localeCompare(String(b.name))
        : String(b.dateKey).localeCompare(String(a.dateKey)));
    res.json({ overrides: sorted });
  });
  r.post('/override', requireAuth, async (req, res) => {
    const { dateKey, name } = req.body || {};
    let { fractional } = req.body || {};
    fractional = Number(fractional);
    if (!dateKey || !name || Number.isNaN(fractional)) {
      return res.status(400).json({ error: 'dateKey, name, fractional required' });
    }
    const dk = String(dateKey), nm = String(name);
    const idx = state.overrides.findIndex(o =>
      String(o.dateKey) === dk && String(o.name).toLowerCase() === nm.toLowerCase()
    );
    const row = { dateKey: dk, name: nm, fractional };
    if (idx >= 0) state.overrides[idx] = row; else state.overrides.push(row);
    await saveAll();
    res.json({ ok: true });
  });
  r.delete('/override', requireAuth, async (req, res) => {
    const { dateKey, name } = req.body || {};
    if (!dateKey || !name) return res.status(400).json({ error: 'dateKey and name required' });
    const before = state.overrides.length;
    state.overrides = state.overrides.filter(o =>
      !(String(o.dateKey) === String(dateKey) &&
        String(o.name).toLowerCase() === String(name).toLowerCase())
    );
    if (state.overrides.length === before) return res.status(404).json({ error: 'not found' });
    await saveAll();
    res.json({ ok: true });
  });

  // ----- Alt map -----
  r.get('/alt-map', (_req, res) => {
    const sorted = [...state.links].sort((a, b) => String(a.alt).localeCompare(String(b.alt)));
    res.json({ links: sorted });
  });
  r.post('/alt-map', requireAuth, async (req, res) => {
    const { alt, main } = req.body || {};
    if (!alt || !main) return res.status(400).json({ error: 'alt and main required' });
    const a = String(alt), m = String(main);
    const idx = state.links.findIndex(l => String(l.alt).toLowerCase() === a.toLowerCase());
    const row = { alt: a, main: m };
    if (idx >= 0) state.links[idx] = row; else state.links.push(row);
    await saveAll();
    res.json({ ok: true });
  });
  r.delete('/alt-map', requireAuth, async (req, res) => {
    const { alt } = req.body || {};
    if (!alt) return res.status(400).json({ error: 'alt required' });
    const before = state.links.length;
    state.links = state.links.filter(l => String(l.alt).toLowerCase() !== String(alt).toLowerCase());
    if (state.links.length === before) return res.status(404).json({ error: 'not found' });
    await saveAll();
    res.json({ ok: true });
  });

  // ----- Excluded dates (admin-visible; legacy /refresh must be taught to use it) -----
  r.get('/excluded', (_req, res) => {
    const sorted = [...state.dates].sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)));
    res.json({ dates: sorted });
  });
  r.post('/excluded', requireAuth, async (req, res) => {
    const { dateKey, reason } = req.body || {};
    if (!dateKey) return res.status(400).json({ error: 'dateKey required' });
    const dk = String(dateKey);
    const idx = state.dates.findIndex(d => String(d.dateKey) === dk);
    const row = { dateKey: dk, reason: reason ? String(reason) : null };
    if (idx >= 0) state.dates[idx] = row; else state.dates.push(row);
    await saveAll();
    res.json({ ok: true });
  });
  r.delete('/excluded', requireAuth, async (req, res) => {
    const { dateKey } = req.body || {};
    if (!dateKey) return res.status(400).json({ error: 'dateKey required' });
    const before = state.dates.length;
    state.dates = state.dates.filter(d => String(d.dateKey) !== String(dateKey));
    if (state.dates.length === before) return res.status(404).json({ error: 'not found' });
    await saveAll();
    res.json({ ok: true });
  });

  // ---------- Startup ----------
  void ensureDir(LEGACY_DIR);
  void maybeLoadPersist();

  return r;
}
