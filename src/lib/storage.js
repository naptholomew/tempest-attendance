import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT, 'data');
const OVERRIDES = path.join(DATA_DIR, 'attendance_overrides.json'); // { [dateKey]: { [name]: fractional } }
const ALTMAP = path.join(DATA_DIR, 'alt_map.json');                 // { altName: mainName }

export function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(OVERRIDES)) fs.writeFileSync(OVERRIDES, '{}', 'utf-8');
  if (!fs.existsSync(ALTMAP)) fs.writeFileSync(ALTMAP, '{}', 'utf-8');
}

export function readOverrides() {
  ensureFiles();
  return JSON.parse(fs.readFileSync(OVERRIDES, 'utf-8'));
}
export function writeOverrides(data) {
  ensureFiles();
  fs.writeFileSync(OVERRIDES, JSON.stringify(data, null, 2), 'utf-8');
}

export function readAltMap() {
  ensureFiles();
  return JSON.parse(fs.readFileSync(ALTMAP, 'utf-8'));
}
export function writeAltMap(data) {
  ensureFiles();
  fs.writeFileSync(ALTMAP, JSON.stringify(data, null, 2), 'utf-8');
}
