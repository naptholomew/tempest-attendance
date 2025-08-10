// === attendance.js (adds perPlayerDates for tooltips) ===
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wclQuery } from '../lib/wcl.js';
import { readAltMap, readOverrides, writeOverrides, writeAltMap } from '../lib/storage.js';

const router = express.Router();

// data dir (for excluded.json)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const EXCLUDED_PATH = path.join(DATA_DIR, 'excluded.json');
function ensureDataDir(){ if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  if (!fs.existsSync(EXCLUDED_PATH)) fs.writeFileSync(EXCLUDED_PATH, JSON.stringify({},null,2));}
const readExcluded = ()=>{ ensureDataDir(); try{return JSON.parse(fs.readFileSync(EXCLUDED_PATH,'utf-8'))||{};}catch{return{}} };
const writeExcluded = (o)=>{ ensureDataDir(); fs.writeFileSync(EXCLUDED_PATH, JSON.stringify(o,null,2)); };

// guild/timezone
const GUILD = {
  name: process.env.GUILD_NAME || 'Tempest',
  serverSlug: (process.env.GUILD_SERVER_SLUG || 'dreamscythe').toLowerCase(),
  serverRegion: (process.env.GUILD_REGION || 'us').toLowerCase()
};
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

// class filter + NPCs
const PLAYER_CLASSES = new Set(['Warrior','Rogue','Warlock','Paladin','Priest','Druid','Hunter','Mage','Shaman','Death Knight','DeathKnight','Monk','Demon Hunter','DemonHunter','Evoker']);
const KNOWN_NPCS = new Set(['Lieutenant General Andorov','Kaldorei Elite']);

// GQL
const GUILD_REPORTS_GQL = `
query GuildReports($guildName:String!,$guildServerSlug:String!,$guildServerRegion:String!,$start:Float!,$end:Float!,$page:Int!,$limit:Int!){
  reportData{ reports(guildName:$guildName,guildServerSlug:$guildServerSlug,guildServerRegion:$guildServerRegion,startTime:$start,endTime:$end,page:$page,limit:$limit){ data{code startTime endTime} has_more_pages } }
}`;
const REPORT_FIGHTS_GQL = `
query ReportFights($code:String!){ reportData{ report(code:$code){ fights(killType:Kills){ id name startTime endTime } } } }`;
const REPORT_TABLE_GQL = `
query Table($code:String!,$fightIDs:[Int]!,$type:TableDataType!){ reportData{ report(code:$code){ table(dataType:$type,fightIDs:$fightIDs) } } }`;

// helpers
const sixWeeksRange = ()=>({ end: Date.now(), start: Date.now() - 1000*60*60*24*7*6 });
function isTueOrThuLocal(ms,tz){ const day=new Intl.DateTimeFormat('en-US',{timeZone:tz,weekday:'short'}).format(new Date(ms)).toLowerCase(); return day.startsWith('tue')||day.startsWith('thu'); }
function dateKeyLocal(ms,tz){ return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)); }
async function fetchAllReports(start,end){
  const all=[]; let page=1, limit=100;
  while(true){ const d=await wclQuery(GUILD_REPORTS_GQL,{guildName:GUILD.name,guildServerSlug:GUILD.serverSlug,guildServerRegion:GUILD.serverRegion,start,end,page,limit});
    all.push(...(d?.reportData?.reports?.data??[]));
    if(!d?.reportData?.reports?.has_more_pages) break; page++; }
  return all;
}
function extractEntries(t){ if(!t) return []; if(Array.isArray(t.entries)) return t.entries;
  if(t.data && Array.isArray(t.data.entries)) return t.data.entries;
  if(Array.isArray(t.series)){ for(const s of t.series){ if(s?.entries) return s.entries; if(s?.data?.entries) return s.data.entries; } }
  for(const v of Object.values(t)){ if(Array.isArray(v)&&v[0]&&typeof v[0]==='object'&&'name'in v[0]) return v; } return []; }
function isPlayerEntry(e){ if(!e||!e.name) return false; if(KNOWN_NPCS.has(e.name)) return false; if(e.type==null) return true; return PLAYER_CLASSES.has(e.type); }

// refresh
router.get('/refresh', async (_req,res)=>{
  try{
    const {start,end}=sixWeeksRange();
    const excluded = readExcluded();
    const reports = await fetchAllReports(start,end);

    // group by local date
    const grouped = new Map();
    for(const r of reports){
      if(!isTueOrThuLocal(r.startTime, TIMEZONE)) continue;
      const dkey = dateKeyLocal(r.startTime, TIMEZONE);
      if(excluded[dkey]) continue;
      if(!grouped.has(dkey)) grouped.set(dkey,[]);
      grouped.get(dkey).push(r);
    }

    const nightKeys = Array.from(grouped.keys()).sort();
    const altMap = readAltMap();
    const overridesAll = readOverrides();

    const perNight = []; // { dateKey, presentMain:Set, nightOverrides }
    for(const dateKey of nightKeys){
      const presentSet = new Set();
      for(const r of grouped.get(dateKey) || []){
        const fightsData = await wclQuery(REPORT_FIGHTS_GQL,{code:r.code});
        const fights = fightsData?.reportData?.report?.fights ?? [];
        if(!fights.length) continue;
        const killIDs = fights.map(f=>f.id);

        const [dmg, heal] = await Promise.all([
          wclQuery(REPORT_TABLE_GQL,{code:r.code,fightIDs:killIDs,type:'DamageDone'}),
          wclQuery(REPORT_TABLE_GQL,{code:r.code,fightIDs:killIDs,type:'Healing'})
        ]);

        const dmgE = extractEntries(dmg?.reportData?.report?.table).filter(isPlayerEntry);
        const healE = extractEntries(heal?.reportData?.report?.table).filter(isPlayerEntry);
        for(const e of dmgE) presentSet.add((e.name||'').trim());
        for(const e of healE) presentSet.add((e.name||'').trim());
      }
      presentSet.delete('');
      const presentMain = new Set(Array.from(presentSet, n => altMap[n] || n));
      const nightOverrides = overridesAll[dateKey] || {};
      perNight.push({ dateKey, presentMain, nightOverrides });
    }

    // build player universe + per-player present dates
    const perPlayerDates = {}; // name -> string[]
    const allPlayers = new Set();
    for(const night of perNight){
      for(const n of night.presentMain){ allPlayers.add(n); (perPlayerDates[n] ||= []).push(night.dateKey); }
      for(const [name,val] of Object.entries(night.nightOverrides)){
        allPlayers.add(name);
        if(val>0){ (perPlayerDates[name] ||= []).push(night.dateKey); }
      }
    }

    const totalNights = nightKeys.length;
    const stats = {};
    for(const name of allPlayers) stats[name] = { nightsAttended: 0, lastSeen: '' };

    for(const night of perNight){
      for(const name of allPlayers){
        const base = night.presentMain.has(name) ? 1 : 0;
        const applied = (night.nightOverrides[name] ?? base);
        stats[name].nightsAttended += applied;
        if(applied>0 && (!stats[name].lastSeen || night.dateKey > stats[name].lastSeen)) {
          stats[name].lastSeen = night.dateKey;
        }
      }
    }

    const rows = Object.entries(stats).map(([name,s])=>({
      name,
      attended: Number(s.nightsAttended.toFixed(2)),
      possible: totalNights,
      pct: totalNights ? Math.round((s.nightsAttended/totalNights)*100) : 0,
      lastSeen: s.lastSeen
    })).sort((a,b)=> b.pct - a.pct || b.attended - a.attended || a.name.localeCompare(b.name));

    res.json({ nights: nightKeys, rows, perPlayerDates, excluded });
  }catch(e){
    res.status(500).json({ error: e.message || String(e) });
  }
});

// excluded admin (unchanged)
router.get('/excluded', (_req,res)=>{ const ex=readExcluded(); res.json({dates:Object.entries(ex).map(([dateKey,reason])=>({dateKey,reason}))}); });
router.post('/excluded', express.json(), (req,res)=>{ if(req.get('authorization')!==`Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) return res.status(401).json({error:'unauthorized'});
  const {dateKey,reason}=req.body||{}; if(!dateKey) return res.status(400).json({error:'dateKey required'});
  const ex=readExcluded(); ex[dateKey]=reason||'Excluded'; writeExcluded(ex); res.json({ok:true,dateKey,reason:ex[dateKey]}); });
router.delete('/excluded', express.json(), (req,res)=>{ if(req.get('authorization')!==`Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) return res.status(401).json({error:'unauthorized'});
  const {dateKey}=req.body||{}; if(!dateKey) return res.status(400).json({error:'dateKey required'});
  const ex=readExcluded(); if(ex[dateKey]){ delete ex[dateKey]; writeExcluded(ex);} res.json({ok:true}); });

// (keeps /override and /alt-map as you already have)
router.post('/override', express.json(), (req,res)=>{ if(req.get('authorization')!==`Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) return res.status(401).json({error:'unauthorized'});
  const {dateKey,name,fractional}=req.body||{}; if(!dateKey||!name||typeof fractional!=='number') return res.status(400).json({error:'dateKey, name, fractional required'});
  const o=readOverrides(); (o[dateKey] ||= {})[name]=fractional; writeOverrides(o); res.json({ok:true}); });
router.post('/alt-map', express.json(), (req,res)=>{ if(req.get('authorization')!==`Bearer ${process.env.ATTEND_ADMIN_TOKEN}`) return res.status(401).json({error:'unauthorized'});
  const {alt,main}=req.body||{}; if(!alt||!main) return res.status(400).json({error:'alt and main required'});
  const m=readAltMap(); m[alt]=main; writeAltMap(m); res.json({ok:true}); });

export default router;
