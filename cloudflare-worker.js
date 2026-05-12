// Pair Trade Tracker — Cloudflare Worker (Type-aware: pair / long / short)
// Two-threshold alarm: alertPctMin (loss, repeating until ack) + alertPctMax (profit, one-shot)
const ALERT_REPEAT_MS = 3 * 60 * 1000;
const TRADING_START_HOUR = 9;
const TRADING_END_HOUR = 23;
const HOME_CCY = "EUR";

const WORKER_STRINGS = {
  de: {
    alarm_title:"🚨 ALARM", profit_title:"🎯 GEWINN-SCHWELLE ERREICHT",
    pair:"Paar", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Schwelle", pnl:"P&L", notional_now:"Notional jetzt", tranches:"Tranchen",
    ack_prompt:"→ Antworte mit beliebigem Text, um den Alarm zu bestätigen",
    profit_note:"(Informativ — keine Quittierung nötig)",
    ack_received:"✅ Alarm bestätigt",
    test_alert:"🧪 Test-Alarm", test_body:"Dies ist ein Test. Antworte um zu bestätigen."
  },
  en: {
    alarm_title:"🚨 ALERT", profit_title:"🎯 PROFIT THRESHOLD REACHED",
    pair:"Pair", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Threshold", pnl:"P&L", notional_now:"Notional now", tranches:"Tranches",
    ack_prompt:"→ Reply with any text to acknowledge the alert",
    profit_note:"(Informational — no acknowledgement needed)",
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
  return { pnlHome: totalPnl, notionalHomeNow: totalNotNow, perfPct: totalNotStart > 0 ? (totalPnl / totalNotStart) * 100 : 0, trancheCount: tranches.length };
}

async function sendTelegram(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) });
  if (!r.ok) console.error("Telegram send failed:", r.status);
  return r.ok;
}

// alarmKind = "loss" (alertPctMin, repeating, ack required)
//           | "profit" (alertPctMax, one-shot, no ack)
function buildAlarmMessage(lang, trade, kind, perfPct, pnl, notionalNow, trancheCount) {
  const sign = perfPct >= 0 ? "+" : "";
  const isProfit = kind === "profit";
  const rawThr = isProfit ? (trade.alertPctMax ?? 0) : (trade.alertPctMin ?? trade.alertThreshold ?? 0);
  // Defensive normalization: profit is always +|X|, loss is always -|X|
  const threshold = isProfit ? Math.abs(Number(rawThr)) : -Math.abs(Number(rawThr));
  const type = tradeType(trade);
  let typeLabel, displayName;
  if (type === "long")  { typeLabel = workerT(lang, "long_only");  displayName = trade.name || trade.longTicker; }
  else if (type === "short") { typeLabel = workerT(lang, "short_only"); displayName = trade.name || trade.shortTicker; }
  else                  { typeLabel = workerT(lang, "pair");       displayName = trade.name || (trade.longTicker + " / " + trade.shortTicker); }
  const thresholdStr = (isProfit ? "+" : "") + threshold.toFixed(2) + "%";
  const lines = [
    workerT(lang, isProfit ? "profit_title" : "alarm_title"), "",
    typeLabel + ": " + displayName,
    workerT(lang, "performance") + ": " + sign + perfPct.toFixed(2) + "%",
    workerT(lang, "threshold") + ": " + thresholdStr,
    workerT(lang, "pnl") + ": " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " " + HOME_CCY,
    workerT(lang, "notional_now") + ": " + notionalNow.toFixed(2) + " " + HOME_CCY
  ];
  if (trancheCount > 1) lines.push(workerT(lang, "tranches") + ": " + trancheCount);
  lines.push("");
  lines.push(workerT(lang, isProfit ? "profit_note" : "ack_prompt"));
  return lines.join("\n");
}

// Migrate legacy alertState format to {min, max} structure
function ensureStateShape(st) {
  if (!st || typeof st !== "object") return { min: { state: "idle", lastAlertAt: 0 }, max: { state: "idle", lastAlertAt: 0 } };
  // New structure already
  if (st.min || st.max) {
    return {
      min: st.min || { state: "idle", lastAlertAt: 0 },
      max: st.max || { state: "idle", lastAlertAt: 0 }
    };
  }
  // Legacy flat: {state, lastAlertAt} → migrate into min, max defaults
  return {
    min: { state: st.state || "idle", lastAlertAt: st.lastAlertAt || 0 },
    max: { state: "idle", lastAlertAt: 0 }
  };
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
    const min = trade.alertPctMin ?? trade.alertThreshold;
    const max = trade.alertPctMax;
    const hasMin = min != null && min !== "";
    const hasMax = max != null && max !== "";
    if (!hasMin && !hasMax) continue;

    let perf;
    try { perf = await computePerf(trade); } catch (e) { results.push({ id, error: e.message }); continue; }

    const st = ensureStateShape(states[id]);
    let stChanged = false;

    // --- LOSS alarm (repeating, ack required) ---
    if (hasMin) {
      const threshold = -Math.abs(Number(min));
      const breached = perf.perfPct <= threshold;
      const cur = st.min.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "loss", perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "loss", action: "triggered" });
      } else if (breached && cur === "triggered" && (now - st.min.lastAlertAt) >= ALERT_REPEAT_MS) {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "loss", perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "loss", action: "repeated" });
      } else if (!breached && cur !== "idle") {
        st.min = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id, kind: "loss", action: "reset" });
      }
    }

    // --- PROFIT alarm (one-shot, no ack) ---
    if (hasMax) {
      const threshold = Math.abs(Number(max));
      const breached = perf.perfPct >= threshold;
      const cur = st.max.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildAlarmMessage(lang, trade, "profit", perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
        st.max = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id, kind: "profit", action: "notified" });
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
  for (const id of Object.keys(states)) {
    const st = ensureStateShape(states[id]);
    if (st.min?.state === "triggered") {
      st.min = { state: "acknowledged", lastAlertAt: Date.now() };
      states[id] = st;
      changed = true;
    }
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
      return textResponse("Pair Trade Tracker Worker — endpoints: /?symbol=, /check, /test-alert, /setup-webhook, /telegram-webhook");
    }
    if (url.pathname === "/check") { try { return jsonResponse(await runAlarmCheck(env)); } catch (e) { return jsonResponse({ ok: false, error: e.message }, 500); } }
    if (url.pathname === "/test-alert") return textResponse(await sendTestAlert(env));
    if (url.pathname === "/setup-webhook") return setupWebhook(req, env);
    if (url.pathname === "/telegram-webhook" && req.method === "POST") return handleTelegramWebhook(req, env);
    return textResponse("not found", 404);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runAlarmCheck(env).catch(e => console.error("cron error:", e))); }
};
