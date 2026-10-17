// CAB Radar scanner for GitHub Actions. Reuses the exact engine from index.html
// (between //==CORE-START and //==CORE-END) and sends new fresh signals to ntfy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- load the engine straight from index.html (single source of truth) ----
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('//==CORE-START'), b = html.indexOf('//==CORE-END');
if (a < 0 || b < 0) { console.error('CORE markers not found in index.html'); process.exit(1); }
const { analyze } = new Function(html.slice(a, b) + '\nreturn {analyze};')();

const PRESETS = {
  strict: { spreadX: 1.8, volX: 2.5, bgMin: 5 },
  balanced: { spreadX: 1.5, volX: 2, bgMin: 4 },
  sensitive: { spreadX: 1.2, volX: 1.5, bgMin: 3 }
};
const P = Object.assign(
  { atrLen: 14, spreadX: 1.5, volLen: 20, volX: 2, bgLen: 6, bgMin: 4, maxAge: 40, slBuf: .1, rr1: 1.5, rr2: 3, obLook: 10, reqFVG: 1, limitMode: 1 },
  PRESETS[cfg.preset] || {}, cfg.params || {}
);
let mk = cfg.market === 'spot' ? 'spot' : 'fut';
let fellBack = false;
const tfs = Array.isArray(cfg.tfs) ? cfg.tfs : [cfg.tf || '15m'];

// ---- Binance ----
const BASES = { fut: ['https://fapi.binance.com'], spot: ['https://api.binance.com', 'https://data-api.binance.vision'] };
const PATH = {
  fut: { info: '/fapi/v1/exchangeInfo', tick: '/fapi/v1/ticker/24hr', kl: '/fapi/v1/klines' },
  spot: { info: '/api/v3/exchangeInfo', tick: '/api/v3/ticker/24hr', kl: '/api/v3/klines' }
};
async function api(key, qs) {
  let last;
  for (const base of BASES[mk]) {
    for (let t = 0; t < 2; t++) {
      try {
        const r = await fetch(base + PATH[mk][key] + (qs || ''), { signal: AbortSignal.timeout(20000) });
        if (r.status === 429 || r.status === 418) { await sleep(2500); continue; }
        if (!r.ok) { const e = new Error('HTTP ' + r.status + ' from ' + base); e.status = r.status; throw e; }
        return await r.json();
      } catch (e) { last = e; }
    }
  }
  throw last || new Error('request failed');
}
async function loadUniverse() {
  const [info, tick] = await Promise.all([api('info'), api('tick')]);
  const tm = {}; tick.forEach(t => tm[t.symbol] = { q: +t.quoteVolume, chg: +t.priceChangePercent });
  const syms = mk === 'fut'
    ? info.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol)
    : info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s.symbol)).map(s => s.symbol);
  return syms.filter(s => tm[s]).map(s => ({ sym: s, q: tm[s].q, chg: tm[s].chg }));
}
async function getBars(sym, tf) {
  const k = await api('kl', '?symbol=' + sym + '&interval=' + tf + '&limit=250');
  const now = Date.now();
  const bars = k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: x[6] }));
  if (bars.length && bars[bars.length - 1].ct > now) bars.pop();
  return bars;
}

// ---- helpers (same as the app) ----
const base = o => o.sym.replace(/USDT$/, '');
const fmt = p => { if (p == null || !isFinite(p)) return '-'; const x = Math.abs(p); return x >= 1000 ? p.toFixed(2) : x >= 10 ? p.toFixed(3) : x >= 1 ? p.toFixed(4) : x >= .01 ? p.toFixed(5) : p.toPrecision(4); };
const evName = o => o.e3 ? 'E3 filled' : (o.pend && o.stage === 3) ? 'E3 limit placed' : ['CAB formed', 'E1', 'E2', 'E3'][o.stage];
function plan(o) {
  const sg = o.dir === 'buy' ? 1 : -1, tp = (e, s, k) => e + sg * Math.abs(e - s) * k;
  if (o.stage === 0) return { entry: o.trig, sl: o.far, tp1: null };
  if (o.stage === 1) return { entry: o.e1.price, sl: o.e1.sl, tp1: o.e1.tp };
  if (o.stage === 2) return { entry: o.e2.price, sl: o.e2.sl, tp1: tp(o.e2.price, o.e2.sl, P.rr1) };
  const en = o.e3 ? o.e3.price : o.limit, sl = o.e3 ? o.e3.sl : o.sl3;
  return { entry: en, sl, tp1: tp(en, sl, P.rr1) };
}

// ---- notifications: web push (your own app) and/or ntfy ----
const repo = process.env.GITHUB_REPOSITORY || '';
const APP_URL = process.env.APP_URL || (repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : undefined);
async function push(title, message, priority = 3, tags = ['bell']) {
  let ok = 0;
  const subEnv = (process.env.PUSH_SUB || '').trim();
  if (subEnv) {
    if (!process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY secret is not set.');
    const wp = (await import('web-push')).default;
    wp.setVapidDetails(APP_URL || 'mailto:noreply@example.com', cfg.vapidPublic, process.env.VAPID_PRIVATE_KEY.trim());
    let subs; try { subs = JSON.parse(subEnv); } catch { throw new Error('PUSH_SUB is not valid JSON. Copy the full code from the app again.'); }
    if (!Array.isArray(subs)) subs = [subs];
    for (const s of subs) {
      try {
        await wp.sendNotification(s, JSON.stringify({ title, body: message, url: APP_URL || './' }), { TTL: 3600, urgency: priority >= 4 ? 'high' : 'normal' });
        ok++;
      } catch (e) {
        console.error('Web push failed:', e.statusCode || '', (e.body || e.message || '').toString().slice(0, 200));
        if (e.statusCode === 404 || e.statusCode === 410) console.error('This phone subscription expired. Open the app, tap Phone alerts, allow again and update the PUSH_SUB secret.');
      }
    }
  }
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
    const body = { topic, title, message, priority, tags };
    if (APP_URL) body.click = APP_URL;
    const r = await fetch(server + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (r.ok) ok++; else console.error('ntfy HTTP ' + r.status);
  }
  if (!ok) throw new Error('No notification could be sent. Set the PUSH_SUB and VAPID_PRIVATE_KEY secrets (see instructions).');
}

// ---- state (dedupe between runs) ----
const stateFile = process.env.STATE_FILE || path.join(root, '.state', 'seen.json');
let seen = {}, firstRun = false;
try { seen = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { firstRun = true; }
const saveState = () => {
  const cut = Date.now() - 48 * 3600e3;
  for (const k of Object.keys(seen)) if (seen[k] < cut) delete seen[k];
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(seen));
};

// ---- main ----
(async () => {
  if (process.env.TEST === 'true') {
    await push('CAB Radar · test', 'Notifications are working. Scanner: ' + mk + ' ' + tfs.join(', '), 3, ['white_check_mark']);
    console.log('Test notification sent.');
  }

  let uni;
  try { uni = await loadUniverse(); }
  catch (e0) {
    let e = e0;
    if (mk === 'fut' && cfg.fallbackToSpot !== false && (e.status === 451 || e.status === 403)) {
      console.error('Futures blocked from this server, falling back to spot.');
      mk = 'spot'; fellBack = true;
      try { uni = await loadUniverse(); e = null; } catch (e2) { e = e2; }
    }
    if (!e) { /* ok */ } else {
    console.error('Binance API not reachable: ' + e.message);
    if (e.status === 451 || e.status === 403) console.error('Binance blocks this server location. Set "market" to "spot" in scanner/config.json.');
    process.exit(1);
    }
  }
  uni = uni.filter(u => u.q >= (cfg.minVolM ?? 5) * 1e6);

  const found = [];
  let fail = 0, total = 0;
  for (const tf of tfs) {
    let idx = 0;
    const worker = async () => {
      while (idx < uni.length) {
        const u = uni[idx++]; total++;
        try {
          const bars = await getBars(u.sym, tf);
          for (const r of analyze(u.sym, bars, P)) { r.tf = tf; found.push(r); }
        } catch { fail++; }
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
  }
  console.log(`Scanned ${uni.length} symbols x ${tfs.length} tf (${mk}), ${found.length} setups, ${fail} failed requests.`);
  if (total && fail > total * .5) { console.error('Too many failed requests (rate limit or blocked).'); process.exit(1); }

  const fresh = r => r.evAge <= (cfg.freshBars ?? 2);
  const newOnes = [];
  for (const r of found) {
    const k = [r.tf, r.sym, r.dir, r.bar, r.stage, r.e3 ? 'f' : 'p'].join('|');
    if (!(k in seen)) {
      seen[k] = Date.now();
      if (fresh(r) && (cfg.directions === 'all' || !cfg.directions || cfg.directions === r.dir) && r.stage >= (cfg.minStage ?? 0)) newOnes.push(r);
    }
  }

  if (firstRun && process.env.TEST !== 'true') {
    await push('CAB Radar · scanner is live', `${fellBack ? '(Spot mode: futures blocked here) ' : ''}Watching ${uni.length} ${mk === 'fut' ? 'futures' : 'spot'} pairs on ${tfs.join(', ')}. You will be notified of new fresh signals.`, 3, ['white_check_mark']);
    console.log('First run: marked current setups as seen, sent start notification.');
  } else if (newOnes.length) {
    newOnes.sort((x, y) => y.stage - x.stage || y.score - x.score);
    const lines = newOnes.slice(0, 6).map(r => {
      const p = plan(r);
      return `${base(r)} ${r.dir.toUpperCase()} ${evName(r)} [${r.tf}] in ${fmt(p.entry)} sl ${fmt(p.sl)}` + (p.tp1 != null ? ` tp ${fmt(p.tp1)}` : '');
    });
    if (newOnes.length > 6) lines.push(`+${newOnes.length - 6} more`);
    const top = newOnes[0];
    await push(`CAB Radar${fellBack ? ' (spot)' : ''} · ${newOnes.length} fresh signal${newOnes.length > 1 ? 's' : ''}`, lines.join('\n'),
      top.stage >= 2 ? 4 : 3, [top.dir === 'buy' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend']);
    console.log('Notified:\n' + lines.join('\n'));
  } else console.log('No new fresh signals.');

  saveState();
})().catch(e => { console.error(e.message || e); process.exit(1); });
