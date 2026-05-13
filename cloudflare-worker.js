// Pair Trade Tracker — Cloudflare Worker
// Three Alarm-Typen:
//   • Loss   — alertPctMin / alertPriceMin, alle 3 Min wiederholt bis ack (Cron: */3 * * * *)
//   • Profit — alertPctMax / alertPriceMax, alle 30 Min wiederholt bis ack (Cron: */3 * * * *)
//   • Short-Squeeze — alertShortPct, einmal täglich wiederholt bis ack (Cron: beliebige Tageszeit, z.B. "0 17 * * *" für 17:00 UTC)
// Pair-Trades: nur pct-Mode für Loss/Profit (Spread hat keinen Quoted Price).
// Short-Squeeze nur für type=short oder pair (überwacht in beiden Fällen shortTicker).
// Cron-Dispatch: "*/3 ..."-Pattern → Loss/Profit-Check, alles andere → Squeeze-Check.
const ALERT_REPEAT_MS = 3 * 60 * 1000;
const PROFIT_ALERT_REPEAT_MS = 30 * 60 * 1000;
// Robuste Cron-Dispatch: der schnelle Loss/Profit-Cron startet mit "*/3 " (3-Min-Intervall).
// Alles andere (z.B. "0 17 * * *" für täglich 17:00 UTC) wird als Squeeze-Cron behandelt.
// Damit kannst du die Squeeze-Cron-Zeit im Cloudflare-Dashboard frei ändern ohne Code-Update.
const FAST_CRON_PREFIX = "*/3";
const TRADING_START_HOUR = 9;
const TRADING_END_HOUR = 23;
const HOME_CCY = "EUR";

const WORKER_STRINGS = {
  de: {
    alarm_title:"🚨 VERLUST-SCHWELLE ÜBERSCHRITTEN", profit_title:"🎯 GEWINN-SCHWELLE ERREICHT",
    squeeze_title:"⚡ SHORT-SQUEEZE-ALARM",
    pair:"Paar", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Schwelle", pnl:"P&L", notional_now:"Notional jetzt", tranches:"Tranchen",
    current_price:"Aktueller Kurs",
    short_interest:"Short-Interest", days_to_cover:"Days to Cover", data_as_of:"Datenstand",
    ack_prompt:"→ Antworte mit beliebigem Text, um den Alarm zu bestätigen",
    profit_ack_prompt:"→ Antworte mit beliebigem Text, um den Gewinn-Alarm zu bestätigen (Wiederholung alle 30 Min)",
    squeeze_ack_prompt:"→ Antworte mit beliebigem Text, um den Squeeze-Alarm zu quittieren (Wiederholung 1× pro Tag)",
    ack_received:"✅ Alarm bestätigt",
    test_alert:"🧪 Test-Alarm", test_body:"Dies ist ein Test. Antworte um zu bestätigen."
  },
  en: {
    alarm_title:"🚨 LOSS THRESHOLD BREACHED", profit_title:"🎯 PROFIT THRESHOLD REACHED",
    squeeze_title:"⚡ SHORT-SQUEEZE ALERT",
    pair:"Pair", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Threshold", pnl:"P&L", notional_now:"Notional now", tranches:"Tranches",
    current_price:"Current price",
    short_interest:"Short interest", days_to_cover:"Days to cover", data_as_of:"Data as of",
    ack_prompt:"→ Reply with any text to acknowledge the alert",
    profit_ack_prompt:"→ Reply with any text to acknowledge the profit alert (repeats every 30 min)",
    squeeze_ack_prompt:"→ Reply with any text to acknowledge the squeeze alert (repeats 1× per day)",
    ack_received:"✅ Alert acknowledged",
    test_alert:"🧪 Test alert", test_body:"This is a test. Reply to acknowledge."
  }
};
function workerT(lang, key) { const d = WORKER_STRINGS[lang] || WORKER_STRINGS.de; return d[key] || WORKER_STRINGS.de[key] || key; }

const CORS_HEADERS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type" };
function jsonResponse(o, s=200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }
function textResponse(t, s=200) { return new Response(t, { status: s, headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }); }

function isWithinTradingHours() {
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const d = n.getDay(); if (d === 0 || d === 6) return false;
  const h = n.getHours(); return h >= TRADING_START_HOUR && h < TRADING_END_HOUR;
}

async function yahooProxy(symbol) {
  if (!symbol) return jsonResponse({ error: "missing symbol" }, 400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
    if (!r.ok) return jsonResponse({ error: "yahoo http " + r.status }, 502);
    return jsonResponse(await r.json());
  } catch (e) { return jsonResponse({ error: "fetch failed: " + e.message }, 502); }
}

async function jsonbinRead(env) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`, { headers: { "X-Master-Key": env.JSONBIN_KEY }, cf: { cacheTtl: 0, cacheEverything: false } });
  if (!r.ok) throw new Error("JSONBin read failed: " + r.status);
  return (await r.json()).record || {};
}
async function jsonbinWrite(env, rec) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`, { method: "PUT", headers: { "X-Master-Key": env.JSONBIN_KEY, "Content-Type": "application/json" }, body: JSON.stringify(rec) });
  if (!r.ok) throw new Error("JSONBin write failed: " + r.status);
}

const FX_CACHE = new Map();
const FX_TTL_MS = 10 * 60 * 1000;
async function getFxRate(from, to) {
  if (from === to) return 1;
  const key = `${from}_${to}`;
  const c = FX_CACHE.get(key);
  if (c && Date.now() - c.ts < FX_TTL_MS) return c.rate;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${from}${to}=X?interval=1d&range=2d`, { headers: { "User-Agent": "Mozilla/5.0 PairTradeTracker" } });
    if (!r.ok) throw new Error("fx http " + r.status);
    const rate = (await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!rate || !isFinite(rate)) throw new Error("no fx rate");
    FX_CACHE.set(key, { rate, ts: Date.now() });
    return rate;
  } catch (e) { if (c) return c.rate; throw e; }
}

async function fetchPriceInternal(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`, { headers: { "User-Agent": "Mozilla/5.0 PairTradeTracker" } });
  if (!r.ok) throw new Error(`yahoo http ${r.status} for ${symbol}`);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) throw new Error(`no price for ${symbol}`);
  return { price: m.regularMarketPrice, currency: m.currency || HOME_CCY };
}

function tradeType(trade) {
  const t = trade.type;
  if (t === "long" || t === "short") return t;
  return "pair";
}

function getTranches(trade) {
  const arr = (Array.isArray(trade.tranches) && trade.tranches.length > 0) ? trade.tranches : [{
    longQty: trade.longQty, longEntry: trade.longEntry, longEntryCcy: trade.longEntryCcy, longEntryNative: !!trade.longEntryNative,
    shortQty: trade.shortQty, shortEntry: trade.shortEntry, shortEntryCcy: trade.shortEntryCcy, shortEntryNative: !!trade.shortEntryNative
  }];
  return arr;
}

async function legPnl(entry, qty, live, apiCcy, entryCcy, isLong) {
  const a2e = apiCcy === entryCcy ? 1 : await getFxRate(apiCcy, entryCcy);
  const e2h = entryCcy === HOME_CCY ? 1 : await getFxRate(entryCcy, HOME_CCY);
  const liveInEntry = live * a2e;
  const pnlEntry = (isLong ? (liveInEntry - entry) : (entry - liveInEntry)) * qty;
  return { pnlHome: pnlEntry * e2h, notionalHomeStart: entry * qty * e2h, notionalHomeNow: liveInEntry * qty * e2h };
}

async function computePerf(trade) {
  const type = tradeType(trade);
  const tranches = getTranches(trade);

  let longLive = null, shortLive = null;
  if (type === "pair" || type === "long")  longLive  = await fetchPriceInternal(trade.longTicker);
  if (type === "pair" || type === "short") shortLive = await fetchPriceInternal(trade.shortTicker);

  let totalPnl = 0, totalNotStart = 0, totalNotNow = 0;
  for (const tr of tranches) {
    if (type === "pair" || type === "long") {
      const longEntryCcy = tr.longEntryNative ? longLive.currency : (tr.longEntryCcy || HOME_CCY);
      const L = await legPnl(tr.longEntry, tr.longQty, longLive.price, longLive.currency, longEntryCcy, true);
      totalPnl += L.pnlHome; totalNotStart += L.notionalHomeStart; totalNotNow += L.notionalHomeNow;
    }
    if (type === "pair" || type === "short") {
      const shortEntryCcy = tr.shortEntryNative ? shortLive.currency : (tr.shortEntryCcy || HOME_CCY);
      const S = await legPnl(tr.shortEntry, tr.shortQty, shortLive.price, shortLive.currency, shortEntryCcy, false);
      totalPnl += S.pnlHome; totalNotStart += S.notionalHomeStart; totalNotNow += S.notionalHomeNow;
    }
  }
  return {
    pnlHome: totalPnl,
    notionalHomeNow: totalNotNow,
    perfPct: totalNotStart > 0 ? (totalPnl / totalNotStart) * 100 : 0,
    trancheCount: tranches.length,
    // Raw live data for price-mode threshold comparisons (single-leg trades)
    longLive, shortLive
  };
}

async function sendTelegram(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) });
  if (!r.ok) console.error("Telegram send failed:", r.status);
  return r.ok;
}

// alarmKind = "loss" (loss threshold, repeating until ack)
//           | "profit" (profit threshold, repeating until ack, every 30 min)
// mode      = "pct" (compare on perfPct) | "price" (compare on raw live price in ticker's quoted ccy)
function buildAlarmMessage(lang, trade, kind, mode, perfPct, pnl, notionalNow, trancheCount, livePrice, liveCcy) {
  const sign = perfPct >= 0 ? "+" : "";
  const isProfit = kind === "profit";
  const type = tradeType(trade);
  let typeLabel, displayName;
  if (type === "long")  { typeLabel = workerT(lang, "long_only");  displayName = trade.name || trade.longTicker; }
  else if (type === "short") { typeLabel = workerT(lang, "short_only"); displayName = trade.name || trade.shortTicker; }
  else                  { typeLabel = workerT(lang, "pair");       displayName = trade.name || (trade.longTicker + " / " + trade.shortTicker); }

  let thresholdStr;
  if (mode === "price") {
    const rawThr = isProfit ? (trade.alertPriceMax ?? 0) : (trade.alertPriceMin ?? 0);
    const thr = Math.abs(Number(rawThr));
    thresholdStr = thr.toFixed(2) + " " + (liveCcy || "");
  } else {
    const rawThr = isProfit ? (trade.alertPctMax ?? 0) : (trade.alertPctMin ?? trade.alertThreshold ?? 0);
    const thr = isProfit ? Math.abs(Number(rawThr)) : -Math.abs(Number(rawThr));
    thresholdStr = (isProfit ? "+" : "") + thr.toFixed(2) + "%";
  }

  const lines = [
    workerT(lang, isProfit ? "profit_title" : "alarm_title"), "",
    typeLabel + ": " + displayName,
    workerT(lang, "performance") + ": " + sign + perfPct.toFixed(2) + "%"
  ];
  if (mode === "price" && livePrice != null && isFinite(livePrice)) {
    lines.push(workerT(lang, "current_price") + ": " + livePrice.toFixed(2) + " " + (liveCcy || ""));
  }
  lines.push(
    workerT(lang, "threshold") + ": " + thresholdStr,
    workerT(lang, "pnl") + ": " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " " + HOME_CCY,
    workerT(lang, "notional_now") + ": " + notionalNow.toFixed(2) + " " + HOME_CCY
  );
  if (trancheCount > 1) lines.push(workerT(lang, "tranches") + ": " + trancheCount);
  lines.push("");
  lines.push(workerT(lang, isProfit ? "profit_ack_prompt" : "ack_prompt"));
  return lines.join("\n");
}

// Migrate legacy alertState format to {min, max, squeeze} structure
function ensureStateShape(st) {
  const empty = { state: "idle", lastAlertAt: 0 };
  if (!st || typeof st !== "object") return { min: { ...empty }, max: { ...empty }, squeeze: { ...empty } };
  if (st.min || st.max || st.squeeze) {
    return {
      min: st.min || { ...empty },
      max: st.max || { ...empty },
      squeeze: st.squeeze || { ...empty }
    };
  }
  // Legacy flat: {state, lastAlertAt} → migrate into min slot only
  return {
    min: { state: st.state || "idle", lastAlertAt: st.lastAlertAt || 0 },
    max: { ...empty },
    squeeze: { ...empty }
  };
}

// Yahoo verlangt für quoteSummary seit 2023 ein CSRF-Token ("crumb") plus
// passendes Session-Cookie. Hier ist der Auth-Dance: einmal fc.yahoo.com
// pingen, Cookie einsammeln, mit dem Cookie den Crumb-Endpoint aufrufen.
// Cache hält sich im Module-Scope solange das Worker-Isolate lebt.
let _yahooAuth = null; // { cookie, crumb, ts }
const YAHOO_AUTH_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    try { return headers.getSetCookie(); } catch {}
  }
  const single = headers.get("set-cookie") || "";
  // Aufsplitten an Kommas, denen ein Cookie-Name+Equal folgt — vermeidet,
  // dass `expires=Wed, 13 May...` als zwei Cookies missverstanden wird.
  return single.split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/).map(s => s.trim()).filter(Boolean);
}

async function getYahooAuth(force = false) {
  if (!force && _yahooAuth && (Date.now() - _yahooAuth.ts) < YAHOO_AUTH_TTL_MS) return _yahooAuth;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
  // Schritt 1: Cookie holen
  const r1 = await fetch("https://fc.yahoo.com", { redirect: "manual", headers: { "User-Agent": ua } });
  const cookieParts = extractSetCookies(r1.headers).map(c => c.split(";")[0].trim()).filter(Boolean);
  if (cookieParts.length === 0) throw new Error("yahoo: no cookie from fc.yahoo.com");
  const cookie = cookieParts.join("; ");
  // Schritt 2: Crumb mit Cookie holen
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "Cookie": cookie, "User-Agent": ua }
  });
  if (!r2.ok) throw new Error("yahoo crumb http " + r2.status);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length < 4 || /<html/i.test(crumb)) throw new Error("yahoo: empty/invalid crumb");
  _yahooAuth = { cookie, crumb, ts: Date.now() };
  return _yahooAuth;
}

// Holt Short-Interest-Statistiken via Yahoo quoteSummary defaultKeyStatistics.
// Liefert nur dann sinnvolle Werte, wenn Yahoo für den Ticker entsprechende
// Pflichtmeldungen verfügbar hat — primär US-Listings.
async function fetchShortInterest(symbol) {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
  let auth = await getYahooAuth();
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`;
    const r = await fetch(url, { headers: { "Cookie": auth.cookie, "User-Agent": ua } });
    if (r.status === 401 && attempt === 0) {
      // Auth stale → einmal frisch holen und retry
      _yahooAuth = null;
      auth = await getYahooAuth(true);
      continue;
    }
    if (!r.ok) throw new Error("yahoo http " + r.status);
    const data = await r.json();
    const stats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!stats) return null;
    const raw = (x) => (x && typeof x === "object" && "raw" in x) ? x.raw : x;
    const shortPctFloat = raw(stats.shortPercentOfFloat);
    if (shortPctFloat == null || !isFinite(shortPctFloat)) return null;
    return {
      shortPercentOfFloat: shortPctFloat * 100,
      sharesShort: raw(stats.sharesShort),
      sharesShortPriorMonth: raw(stats.sharesShortPriorMonth),
      shortRatio: raw(stats.shortRatio),
      dateShortInterest: raw(stats.dateShortInterest)
    };
  }
  throw new Error("yahoo http 401 (auth retry failed)");
}

function buildSqueezeMessage(lang, trade, shortPct, threshold, shortInfo) {
  const type = tradeType(trade);
  const typeLabel = (type === "short") ? workerT(lang, "short_only") : workerT(lang, "pair");
  const displayName = trade.name || (type === "short" ? trade.shortTicker : (trade.longTicker + " / " + trade.shortTicker));
  const lines = [
    workerT(lang, "squeeze_title"), "",
    typeLabel + ": " + displayName,
    workerT(lang, "short_interest") + ": " + shortPct.toFixed(2) + "% (Float)",
    workerT(lang, "threshold") + ": ≥ " + threshold.toFixed(2) + "%"
  ];
  if (shortInfo.shortRatio != null && isFinite(shortInfo.shortRatio)) {
    lines.push(workerT(lang, "days_to_cover") + ": " + shortInfo.shortRatio.toFixed(2));
  }
  if (shortInfo.dateShortInterest) {
    const d = new Date(shortInfo.dateShortInterest * 1000);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
    lines.push(workerT(lang, "data_as_of") + ": " + dateStr);
  }
  lines.push("");
  lines.push(workerT(lang, "squeeze_ack_prompt"));
  return lines.join("\n");
}

// Daily check: für jeden Trade vom Typ short oder pair mit gesetztem alertShortPct
// → Short-Interest von Yahoo holen und gegen Schwelle prüfen. Identische
// State-Maschine wie Loss/Profit (idle → triggered → acknowledged → idle).
async function runShortSqueezeCheck(env) {
  const record = await jsonbinRead(env);
  const trades = record.trades || [];
  const lang = record.lang || "de";
  const states = record.alertStates || {};
  let stateChanged = false;
  const results = [];
  const now = Date.now();

  for (const trade of trades) {
    const id = trade.id;
    const type = tradeType(trade);
    // Nur short-only und pair (für pair: shortTicker, gleiche Logik wie short-only).
    // Long-only bewusst ausgeschlossen — Robert wollte das explizit so.
    if (type !== "short" && type !== "pair") continue;
    const thrRaw = trade.alertShortPct;
    if (thrRaw == null || thrRaw === "") continue;
    const threshold = Math.abs(Number(thrRaw));
    if (!isFinite(threshold) || threshold <= 0) continue;
    const symbol = trade.shortTicker;
    if (!symbol) continue;

    let info;
    try { info = await fetchShortInterest(symbol); } catch (e) { results.push({ id, error: e.message }); continue; }
    if (!info) {
      // Yahoo hat keine Short-Interest-Daten für diesen Ticker (typisch für nicht-US-Werte).
      // State unverändert lassen — nicht reset auf idle, weil das Daten-Lücke und nicht Erholung ist.
      results.push({ id, kind: "squeeze", action: "no_data" });
      continue;
    }

    const breached = info.shortPercentOfFloat >= threshold;
    const st = ensureStateShape(states[id]);
    const cur = st.squeeze.state;
    let stChanged = false;

    if (breached && cur === "idle") {
      await sendTelegram(env, buildSqueezeMessage(lang, trade, info.shortPercentOfFloat, threshold, info));
      st.squeeze = { state: "triggered", lastAlertAt: now };
      stChanged = true;
      results.push({ id, kind: "squeeze", action: "triggered" });
    } else if (breached && cur === "triggered") {
      // Cron ist 1× pro Tag → jeder erneute breached-Treffer = täglicher Repeat
      await sendTelegram(env, buildSqueezeMessage(lang, trade, info.shortPercentOfFloat, threshold, info));
      st.squeeze = { state: "triggered", lastAlertAt: now };
      stChanged = true;
      results.push({ id, kind: "squeeze", action: "repeated" });
    } else if (!breached && cur !== "idle") {
      st.squeeze = { state: "idle", lastAlertAt: 0 };
      stChanged = true;
      results.push({ id, kind: "squeeze", action: "reset" });
    }

    if (stChanged) { states[id] = st; stateChanged = true; }
  }

  if (stateChanged) await jsonbinWrite(env, { ...record, alertStates: states });
  return { ok: true, results };
}

async function runAlarmCheck(env) {
  if (!isWithinTradingHours()) return { ok: true, skipped: "outside trading hours" };
  const record = await jsonbinRead(env);
  const trades = record.trades || [];
  const lang = record.lang || "de";
  const states = record.alertStates || {};
  let stateChanged = false; const results = [];
  const now = Date.now();

  for (const trade of trades) {
    const id = trade.id;
    const type = tradeType(trade);
    // For pair-trades, price mode makes no sense (a spread has no single quoted price).
    // Force pct semantics there.
    const minMode = (type === "long" || type === "short") && trade.alertMinMode === "price" ? "price" : "pct";
    const maxMode = (type === "long" || type === "short") && trade.alertMaxMode === "price" ? "price" : "pct";
    const minPct = trade.alertPctMin ?? trade.alertThreshold;
    const maxPct = trade.alertPctMax;
    const minPrice = trade.alertPriceMin;
    const maxPrice = trade.alertPriceMax;
    const hasMin = minMode === "price"
      ? (minPrice != null && minPrice !== "")
      : (minPct != null && minPct !== "");
    const hasMax = maxMode === "price"
      ? (maxPrice != null && maxPrice !== "")
      : (maxPct != null && maxPct !== "");
    if (!hasMin && !hasMax) continue;

    let perf;
    try { perf = await computePerf(trade); } catch (e) { results.push({ id, error: e.message }); continue; }

    // Pick the relevant live leg for price-mode comparisons.
    const live = type === "short" ? perf.shortLive : perf.longLive;
    const livePrice = live?.price;
    const liveCcy = (live?.currency || HOME_CCY).toUpperCase();

    const st = ensureStateShape(states[id]);
    let stChanged = false;

    // --- LOSS alarm (repeating every 3 min until ack) ---
    if (hasMin) {
      let breached = false;
      if (minMode === "price") {
        const thr = Math.abs(Number(minPrice));
        // Long: loss when current price has FALLEN below threshold
        // Short: loss when current price has RISEN above threshold
        if (livePrice != null && isFinite(livePrice)) {
          breached = (type === "short") ? (livePrice >= thr) : (livePrice <= thr);
        }
      } else {
        const threshold = -Math.abs(Number(minPct));
        breached = perf.perfPct <= threshold;
      }
      const cur = st.min.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "loss", minMode, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount, livePrice, liveCcy));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "loss", action: "triggered" });
      } else if (breached && cur === "triggered" && (now - st.min.lastAlertAt) >= ALERT_REPEAT_MS) {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "loss", minMode, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount, livePrice, liveCcy));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "loss", action: "repeated" });
      } else if (!breached && cur !== "idle") {
        st.min = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id, kind: "loss", action: "reset" });
      }
    }

    // --- PROFIT alarm (repeating every 30 min until ack) ---
    if (hasMax) {
      let breached = false;
      if (maxMode === "price") {
        const thr = Math.abs(Number(maxPrice));
        // Long: profit when current price has RISEN above threshold
        // Short: profit when current price has FALLEN below threshold
        if (livePrice != null && isFinite(livePrice)) {
          breached = (type === "short") ? (livePrice <= thr) : (livePrice >= thr);
        }
      } else {
        const threshold = Math.abs(Number(maxPct));
        breached = perf.perfPct >= threshold;
      }
      const cur = st.max.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "profit", maxMode, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount, livePrice, liveCcy));
        st.max = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "profit", action: "notified" });
      } else if (breached && cur === "notified" && (now - st.max.lastAlertAt) >= PROFIT_ALERT_REPEAT_MS) {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "profit", maxMode, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount, livePrice, liveCcy));
        st.max = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "profit", action: "repeated" });
      } else if (!breached && cur !== "idle") {
        st.max = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id, kind: "profit", action: "reset" });
      }
    }

    if (stChanged) { states[id] = st; stateChanged = true; }
  }
  if (stateChanged) await jsonbinWrite(env, { ...record, alertStates: states });
  return { ok: true, results };
}

async function sendTestAlert(env) {
  let lang = "de";
  try { lang = (await jsonbinRead(env)).lang || "de"; } catch {}
  const msg = [workerT(lang, "test_alert"), "", workerT(lang, "test_body"), "", workerT(lang, "ack_prompt")].join("\n");
  return (await sendTelegram(env, msg)) ? "test sent" : "test failed";
}

async function handleTelegramWebhook(req, env) {
  let update; try { update = await req.json(); } catch { return textResponse("bad json", 400); }
  const m = update.message;
  if (!m || !m.chat || String(m.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return textResponse("ignored");
  let record, lang = "de";
  try { record = await jsonbinRead(env); lang = record.lang || "de"; } catch { await sendTelegram(env, workerT(lang, "ack_received")); return textResponse("ok (no record)"); }
  const states = record.alertStates || {}; let changed = false;
  const ackTs = Date.now();
  for (const id of Object.keys(states)) {
    const st = ensureStateShape(states[id]);
    let touched = false;
    if (st.min?.state === "triggered") {
      st.min = { state: "acknowledged", lastAlertAt: ackTs };
      touched = true;
    }
    if (st.max?.state === "notified") {
      st.max = { state: "acknowledged", lastAlertAt: ackTs };
      touched = true;
    }
    if (st.squeeze?.state === "triggered") {
      st.squeeze = { state: "acknowledged", lastAlertAt: ackTs };
      touched = true;
    }
    if (touched) { states[id] = st; changed = true; }
  }
  if (changed) { try { await jsonbinWrite(env, { ...record, alertStates: states }); } catch {} }
  await sendTelegram(env, workerT(lang, "ack_received"));
  return textResponse("ok");
}

async function setupWebhook(req, env) {
  const u = new URL(req.url);
  const webhookUrl = u.origin + "/telegram-webhook";
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  return jsonResponse({ requested: webhookUrl, telegram: await r.json() });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "") {
      const s = url.searchParams.get("symbol");
      if (s) return yahooProxy(s);
      return textResponse("Pair Trade Tracker Worker — endpoints: /?symbol=, /check, /check-squeeze, /test-alert, /setup-webhook, /telegram-webhook");
    }
    if (url.pathname === "/check") { try { return jsonResponse(await runAlarmCheck(env)); } catch (e) { return jsonResponse({ ok: false, error: e.message }, 500); } }
    if (url.pathname === "/check-squeeze") { try { return jsonResponse(await runShortSqueezeCheck(env)); } catch (e) { return jsonResponse({ ok: false, error: e.message }, 500); } }
    if (url.pathname === "/test-alert") return textResponse(await sendTestAlert(env));
    if (url.pathname === "/setup-webhook") return setupWebhook(req, env);
    if (url.pathname === "/telegram-webhook" && req.method === "POST") return handleTelegramWebhook(req, env);
    return textResponse("not found", 404);
  },
  // Mehrere Cron-Trigger im Cloudflare-Dashboard: "*/3 * * * *" für Loss/Profit,
  // beliebige Tages-Cron (z.B. "0 17 * * *") für Short-Squeeze. Wir matchen den
  // Fast-Cron explizit über das "*/3"-Präfix und behandeln alles andere als Squeeze.
  // Vorteil: die Squeeze-Cron-Zeit kann im Dashboard frei geändert werden.
  async scheduled(event, env, ctx) {
    const cronStr = (event && event.cron) ? String(event.cron) : "";
    if (cronStr.startsWith(FAST_CRON_PREFIX)) {
      ctx.waitUntil(runAlarmCheck(env).catch(e => console.error("cron error:", e)));
    } else {
      ctx.waitUntil(runShortSqueezeCheck(env).catch(e => console.error("squeeze cron error:", e)));
    }
  }
};
