import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import legacyAttendanceRoutes from './routes/attendance.js';               // legacy router (has /refresh)
import memoryAttendanceRoutes from './routes/attendance.memoryroutes.esm.js'; // new admin/state router
import { ensureFiles } from './lib/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

ensureFiles();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173'
}));

// (optional but harmless) JSON body parsing for POSTs
app.use(express.json());

// Serve static admin UI
app.use(express.static(path.join(__dirname, '../public')));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Legacy router (mounted separately) ----
app.use('/api/legacy', legacyAttendanceRoutes);

// Restore the original refresh URL expected by the frontend
// This forwards to the legacy router's /refresh handler.
app.get('/api/attendance/refresh', (req, res) => {
  // 307 preserves the method if it were ever POST; also keeps body/headers intact.
  res.redirect(307, '/api/legacy/refresh');
});

// ---- New memory router for admin/state endpoints ----
app.use('/api/attendance', memoryAttendanceRoutes({
  adminToken: process.env.ATTEND_ADMIN_TOKEN,              // REQUIRED
  persistFile: process.env.LOCAL_STATE_PATH || ''          // OPTIONAL (e.g. "./attendance-state.json")
}));

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Attendance server listening on http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin.html`);
});
