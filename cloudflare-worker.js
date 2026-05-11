// Pair Trade Tracker — Cloudflare Worker (Super-Trade / Tranche-aware)
const ALERT_REPEAT_MS = 3 * 60 * 1000;
const TRADING_START_HOUR = 9;
const TRADING_END_HOUR = 23;
const HOME_CCY = "EUR";

const WORKER_STRINGS = {
  de: { alarm_title:"🚨 ALARM", pair:"Paar", performance:"Performance", threshold:"Schwelle", pnl:"P&L", notional_now:"Notional jetzt", tranches:"Tranchen", ack_prompt:"→ Antworte mit beliebigem Text, um den Alarm zu bestätigen", ack_received:"✅ Alarm bestätigt", test_alert:"🧪 Test-Alarm", test_body:"Dies ist ein Test. Antworte um zu bestätigen." },
  en: { alarm_title:"🚨 ALERT", pair:"Pair", performance:"Performance", threshold:"Threshold", pnl:"P&L", notional_now:"Notional now", tranches:"Tranches", ack_prompt:"→ Reply with any text to acknowledge the alert", ack_received:"✅ Alert acknowledged", test_alert:"🧪 Test alert", test_body:"This is a test. Reply to acknowledge." },
  it: { alarm_title:"🚨 ALLARME", pair:"Coppia", performance:"Performance", threshold:"Soglia", pnl:"P&L", notional_now:"Notional ora", tranches:"Tranche", ack_prompt:"→ Rispondi con qualsiasi testo per confermare l'allarme", ack_received:"✅ Allarme confermato", test_alert:"🧪 Allarme di prova", test_body:"Questo è un test. Rispondi per confermare." },
  ru: { alarm_title:"🚨 ТРЕВОГА", pair:"Пара", performance:"Доходность", threshold:"Порог", pnl:"Прибыль/убыток", notional_now:"Номинал сейчас", tranches:"Транши", ack_prompt:"→ Ответьте любым текстом, чтобы подтвердить тревогу", ack_received:"✅ Тревога подтверждена", test_alert:"🧪 Тестовая тревога", test_body:"Это тест. Ответьте для подтверждения." }
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

function getTranches(trade) {
  if (Array.isArray(trade.tranches) && trade.tranches.length > 0) return trade.tranches;
  return [{
    longQty: trade.longQty, longEntry: trade.longEntry, longEntryCcy: trade.longEntryCcy, longEntryNative: !!trade.longEntryNative,
    shortQty: trade.shortQty, shortEntry: trade.shortEntry, shortEntryCcy: trade.shortEntryCcy, shortEntryNative: !!trade.shortEntryNative
  }];
}

async function computePerf(trade) {
  const longLive = await fetchPriceInternal(trade.longTicker);
  const shortLive = await fetchPriceInternal(trade.shortTicker);
  const tranches = getTranches(trade);
  async function legPnl(entry, qty, live, apiCcy, entryCcy, isLong) {
    const a2e = apiCcy === entryCcy ? 1 : await getFxRate(apiCcy, entryCcy);
    const e2h = entryCcy === HOME_CCY ? 1 : await getFxRate(entryCcy, HOME_CCY);
    const liveInEntry = live * a2e;
    const pnlEntry = (isLong ? (liveInEntry - entry) : (entry - liveInEntry)) * qty;
    return { pnlHome: pnlEntry * e2h, notionalHomeStart: entry * qty * e2h, notionalHomeNow: liveInEntry * qty * e2h };
  }
  let totalPnl = 0, totalNotStart = 0, totalNotNow = 0;
  for (const tr of tranches) {
    const longEntryCcy = tr.longEntryNative ? longLive.currency : (tr.longEntryCcy || HOME_CCY);
    const shortEntryCcy = tr.shortEntryNative ? shortLive.currency : (tr.shortEntryCcy || HOME_CCY);
    const L = await legPnl(tr.longEntry, tr.longQty, longLive.price, longLive.currency, longEntryCcy, true);
    const S = await legPnl(tr.shortEntry, tr.shortQty, shortLive.price, shortLive.currency, shortEntryCcy, false);
    totalPnl += L.pnlHome + S.pnlHome;
    totalNotStart += L.notionalHomeStart + S.notionalHomeStart;
    totalNotNow += L.notionalHomeNow + S.notionalHomeNow;
  }
  return { pnlHome: totalPnl, notionalHomeNow: totalNotNow, perfPct: totalNotStart > 0 ? (totalPnl / totalNotStart) * 100 : 0, trancheCount: tranches.length };
}

async function sendTelegram(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) });
  if (!r.ok) console.error("Telegram send failed:", r.status);
  return r.ok;
}

function buildAlarmMessage(lang, trade, perfPct, pnl, notionalNow, trancheCount) {
  const sign = perfPct >= 0 ? "+" : "";
  const th = trade.alertPctMin ?? trade.alertThreshold ?? 0;
  const lines = [
    workerT(lang, "alarm_title"), "",
    workerT(lang, "pair") + ": " + (trade.name || (trade.longTicker + " / " + trade.shortTicker)),
    workerT(lang, "performance") + ": " + sign + perfPct.toFixed(2) + "%",
    workerT(lang, "threshold") + ": " + Number(th).toFixed(2) + "%",
    workerT(lang, "pnl") + ": " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " " + HOME_CCY,
    workerT(lang, "notional_now") + ": " + notionalNow.toFixed(2) + " " + HOME_CCY
  ];
  if (trancheCount > 1) lines.push(workerT(lang, "tranches") + ": " + trancheCount);
  lines.push("", workerT(lang, "ack_prompt"));
  return lines.join("\n");
}

async function runAlarmCheck(env) {
  if (!isWithinTradingHours()) return { ok: true, skipped: "outside trading hours" };
  const record = await jsonbinRead(env);
  const trades = record.trades || [];
  const lang = record.lang || "de";
  const states = record.alertStates || {};
  let stateChanged = false; const results = [];
  for (const trade of trades) {
    const threshold = trade.alertPctMin ?? trade.alertThreshold;
    if (threshold == null || threshold === "") continue;
    const id = trade.id;
    const state = states[id] || { state: "idle", lastAlertAt: 0 };
    let perf;
    try { perf = await computePerf(trade); } catch (e) { results.push({ id, error: e.message }); continue; }
    const breached = perf.perfPct <= -Math.abs(Number(threshold));
    const now = Date.now();
    if (breached && state.state === "idle") {
      await sendTelegram(env, buildAlarmMessage(lang, trade, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
      states[id] = { state: "triggered", lastAlertAt: now }; stateChanged = true; results.push({ id, action: "triggered" });
    } else if (breached && state.state === "triggered" && (now - state.lastAlertAt) >= ALERT_REPEAT_MS) {
      await sendTelegram(env, buildAlarmMessage(lang, trade, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
      states[id] = { state: "triggered", lastAlertAt: now }; stateChanged = true; results.push({ id, action: "repeated" });
    } else if (!breached && state.state !== "idle") {
      states[id] = { state: "idle", lastAlertAt: 0 }; stateChanged = true; results.push({ id, action: "reset" });
    } else {
      results.push({ id, action: "noop", state: state.state, perf: perf.perfPct, tranches: perf.trancheCount });
    }
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
  for (const id of Object.keys(states)) { if (states[id]?.state === "triggered") { states[id] = { state: "acknowledged", lastAlertAt: Date.now() }; changed = true; } }
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
