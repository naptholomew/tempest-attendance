import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import attendanceRoutes from './routes/attendance.js';
import { ensureFiles } from './lib/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
ensureFiles();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173'
}));

// Serve static admin UI
app.use(express.static(path.join(__dirname, '../public')));

// Health + API routes
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/attendance', attendanceRoutes);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Attendance server listening on http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin.html`);
});
