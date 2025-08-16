// index.js — wired to the ESM memory router
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import memoryAttendanceRoutes from './routes/attendance.memoryroutes.esm.js'; // <-- new router
import { ensureFiles } from './lib/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
ensureFiles();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173'
}));

app.use(express.json());

// Serve static admin UI (e.g., public/admin.html)
app.use(express.static(path.join(__dirname, '../public')));

// Health + API routes
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/attendance', memoryAttendanceRoutes({
  adminToken: process.env.ATTEND_ADMIN_TOKEN,            // required to modify/import
  persistFile: process.env.LOCAL_STATE_PATH || ''        // optional local persistence (e.g. "./attendance-state.json")
}));

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Attendance server listening on http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin.html`);
});
