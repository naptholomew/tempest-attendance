/**
 * attendance.memoryroutes.esm.js
 * ES Module router for zero-cost, in-memory storage with optional JSON persistence.
 * Mount:
 *   app.use('/api/attendance', memoryRoutes({
 *     adminToken: process.env.ATTEND_ADMIN_TOKEN,
 *     persistFile: process.env.LOCAL_STATE_PATH
 *   }));
 */
import { Router, json as jsonParser } from 'express';
import fs from 'fs';
const fsp = fs.promises;

export default function memoryRoutes(opts = {}) {
  const ADMIN_TOKEN = opts.adminToken || process.env.ATTEND_ADMIN_TOKEN || '';
  const FILE_PATH   = opts.persistFile || process.env.LOCAL_STATE_PATH || '';

  /** @type {{ overrides: {dateKey:string,name:string,fractional:number}[], links: {alt:string,main:string}[], dates: {dateKey:string,reason?:string|null}[] }} */
  const state = { overrides: [], links: [], dates: [] };

  async function maybeLoad() {
    if (!FILE_PATH) return;
    try {
      const txt = await fsp.readFile(FILE_PATH, 'utf8');
      const parsed = JSON.parse(txt);
      state.overrides = Array.isArray(parsed?.overrides) ? parsed.overrides : [];
      state.links     = Array.isArray(parsed?.links)     ? parsed.links     : [];
      state.dates     = Array.isArray(parsed?.dates)     ? parsed.dates     : [];
    } catch {}
  }
  async function maybeSave() {
    if (!FILE_PATH) return;
    try {
      await fsp.writeFile(FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch {}
  }
  function requireAuth(req, res, next) {
    const hdr = req.headers['authorization'] || '';
    const token = (hdr.startsWith('Bearer ') ? hdr.slice(7) : '').trim();
    if (!ADMIN_TOKEN) return res.status(401).json({ error: 'Server missing ATTEND_ADMIN_TOKEN' });
    if (!token || token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  const r = Router();
  r.use(jsonParser());

  // Health (no auth)
  r.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Export/Import
  r.get('/state', (_req, res) => res.json({ overrides: state.overrides, links: state.links, dates: state.dates }));
  r.post('/import', requireAuth, async (req, res) => {
    const inc = req.body || {};
    state.overrides = Array.isArray(inc.overrides) ? inc.overrides : [];
    state.links     = Array.isArray(inc.links)     ? inc.links     : [];
    state.dates     = Array.isArray(inc.dates)     ? inc.dates     : [];
    await maybeSave();
    res.json({ ok: true });
  });

  // Overrides
  r.get('/overrides', (_req, res) => {
    const sorted = [...state.overrides].sort((a,b)=> a.dateKey===b.dateKey ? a.name.localeCompare(b.name) : b.dateKey.localeCompare(a.dateKey));
    res.json({ overrides: sorted });
  });
  r.post('/override', requireAuth, async (req, res) => {
    const { dateKey, name } = req.body || {};
    let { fractional } = req.body || {};
    fractional = Number(fractional);
    if (!dateKey || !name || Number.isNaN(fractional)) return res.status(400).json({ error: 'dateKey, name, fractional required' });
    const idx = state.overrides.findIndex(o => o.dateKey === dateKey && o.name.toLowerCase() === String(name).toLowerCase());
    const row = { dateKey, name, fractional };
    if (idx >= 0) state.overrides[idx] = row; else state.overrides.push(row);
    await maybeSave();
    res.json({ ok: true });
  });
  r.delete('/override', requireAuth, async (req, res) => {
    const { dateKey, name } = req.body || {};
    if (!dateKey || !name) return res.status(400).json({ error: 'dateKey and name required' });
    const before = state.overrides.length;
    state.overrides = state.overrides.filter(o => !(o.dateKey === dateKey && o.name.toLowerCase() === String(name).toLowerCase()));
    if (state.overrides.length === before) return res.status(404).json({ error: 'not found' });
    await maybeSave();
    res.json({ ok: true });
  });

  // Alt map
  r.get('/alt-map', (_req, res) => {
    const sorted = [...state.links].sort((a,b)=> a.alt.localeCompare(b.alt));
    res.json({ links: sorted });
  });
  r.post('/alt-map', requireAuth, async (req, res) => {
    const { alt, main } = req.body || {};
    if (!alt || !main) return res.status(400).json({ error: 'alt and main required' });
    const idx = state.links.findIndex(l => l.alt.toLowerCase() === String(alt).toLowerCase());
    const row = { alt, main };
    if (idx >= 0) state.links[idx] = row; else state.links.push(row);
    await maybeSave();
    res.json({ ok: true });
  });
  r.delete('/alt-map', requireAuth, async (req, res) => {
    const { alt } = req.body || {};
    if (!alt) return res.status(400).json({ error: 'alt required' });
    const before = state.links.length;
    state.links = state.links.filter(l => l.alt.toLowerCase() !== String(alt).toLowerCase());
    if (state.links.length === before) return res.status(404).json({ error: 'not found' });
    await maybeSave();
    res.json({ ok: true });
  });

  // Excluded dates
  r.get('/excluded', (_req, res) => {
    const sorted = [...state.dates].sort((a,b)=> b.dateKey.localeCompare(a.dateKey));
    res.json({ dates: sorted });
  });
  r.post('/excluded', requireAuth, async (req, res) => {
    const { dateKey, reason } = req.body || {};
    if (!dateKey) return res.status(400).json({ error: 'dateKey required' });
    const idx = state.dates.findIndex(d => d.dateKey === dateKey);
    const row = { dateKey, reason: reason || null };
    if (idx >= 0) state.dates[idx] = row; else state.dates.push(row);
    await maybeSave();
    res.json({ ok: true });
  });
  r.delete('/excluded', requireAuth, async (req, res) => {
    const { dateKey } = req.body || {};
    if (!dateKey) return res.status(400).json({ error: 'dateKey required' });
    const before = state.dates.length;
    state.dates = state.dates.filter(d => d.dateKey !== dateKey);
    if (state.dates.length === before) return res.status(404).json({ error: 'not found' });
    await maybeSave();
    res.json({ ok: true });
  });

  void maybeLoad();
  return r;
}
