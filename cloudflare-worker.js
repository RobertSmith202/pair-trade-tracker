// =============================================================================
// Pair Trade Tracker — Cloudflare Worker
// Endpoints:
//   GET  /?symbol=AAPL           Yahoo Finance proxy (raw passthrough)
//   GET  /check                  Manual alarm check (cron also calls this)
//   GET  /test-alert             Send test Telegram message
//   GET  /setup-webhook          Register Telegram webhook for this worker
//   POST /telegram-webhook       Receives Telegram replies (ack)
//
// Secrets required (set via wrangler or dashboard):
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   JSONBIN_BIN_ID
//   JSONBIN_KEY
//
// Cron trigger: configure to run every 3 minutes (*/3 * * * *).
// =============================================================================

const ALERT_REPEAT_MS = 3 * 60 * 1000;
const TRADING_START_HOUR = 9;
const TRADING_END_HOUR = 23;
const HOME_CCY = "EUR";

// =============================================================================
// i18n — Telegram message strings
// =============================================================================
const WORKER_STRINGS = {
  de: {
    alarm_title:   "🚨 ALARM",
    pair:          "Paar",
    performance:   "Performance",
    threshold:     "Schwelle",
    pnl:           "P&L",
    notional_now:  "Notional jetzt",
    tranches:      "Tranchen",
    ack_prompt:    "→ Antworte mit beliebigem Text, um den Alarm zu bestätigen",
    ack_received:  "✅ Alarm bestätigt",
    test_alert:    "🧪 Test-Alarm",
    test_body:     "Dies ist ein Test. Antworte um zu bestätigen."
  },
  en: {
    alarm_title:   "🚨 ALERT",
    pair:          "Pair",
    performance:   "Performance",
    threshold:     "Threshold",
    pnl:           "P&L",
    notional_now:  "Notional now",
    tranches:      "Tranches",
    ack_prompt:    "→ Reply with any text to acknowledge the alert",
    ack_received:  "✅ Alert acknowledged",
    test_alert:    "🧪 Test alert",
    test_body:     "This is a test. Reply to acknowledge."
  },
  it: {
    alarm_title:   "🚨 ALLARME",
    pair:          "Coppia",
    performance:   "Performance",
    threshold:     "Soglia",
    pnl:           "P&L",
    notional_now:  "Notional ora",
    tranches:      "Tranche",
    ack_prompt:    "→ Rispondi con qualsiasi testo per confermare l'allarme",
    ack_received:  "✅ Allarme confermato",
    test_alert:    "🧪 Allarme di prova",
    test_body:     "Questo è un test. Rispondi per confermare."
  },
  ru: {
    alarm_title:   "🚨 ТРЕВОГА",
    pair:          "Пара",
    performance:   "Доходность",
    threshold:     "Порог",
    pnl:           "Прибыль/убыток",
    notional_now:  "Номинал сейчас",
    tranches:      "Транши",
    ack_prompt:    "→ Ответьте любым текстом, чтобы подтвердить тревогу",
    ack_received:  "✅ Тревога подтверждена",
    test_alert:    "🧪 Тестовая тревога",
    test_body:     "Это тест. Ответьте для подтверждения."
  }
};

function workerT(lang, key) {
  const dict = WORKER_STRINGS[lang] || WORKER_STRINGS.de;
  return dict[key] || WORKER_STRINGS.de[key] || key;
}

// =============================================================================
// CORS helpers
// =============================================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
  });
}

// =============================================================================
// Trading hours check (Berlin time, Mon-Fri)
// =============================================================================
function isWithinTradingHours() {
  const nowBerlin = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" })
  );
  const dow = nowBerlin.getDay();
  if (dow === 0 || dow === 6) return false;
  const hour = nowBerlin.getHours();
  return hour >= TRADING_START_HOUR && hour < TRADING_END_HOUR;
}

// =============================================================================
// Yahoo Finance proxy — raw passthrough
// =============================================================================
async function yahooProxy(symbol) {
  if (!symbol) return jsonResponse({ error: "missing symbol" }, 400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
      }
    });
    if (!resp.ok) return jsonResponse({ error: "yahoo http " + resp.status }, 502);
    const data = await resp.json();
    return jsonResponse(data);
  } catch (e) {
    return jsonResponse({ error: "fetch failed: " + e.message }, 502);
  }
}

// =============================================================================
// JSONBin read/write
// =============================================================================
async function jsonbinRead(env) {
  const url = `https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`;
  const resp = await fetch(url, {
    headers: { "X-Master-Key": env.JSONBIN_KEY },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (!resp.ok) throw new Error("JSONBin read failed: " + resp.status);
  const data = await resp.json();
  return data.record || {};
}

async function jsonbinWrite(env, record) {
  const url = `https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Master-Key":  env.JSONBIN_KEY,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify(record)
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error("JSONBin write failed: " + resp.status + " " + txt.slice(0, 120));
  }
}

// =============================================================================
// FX rate cache (in-memory; resets per worker isolate)
// =============================================================================
const FX_CACHE = new Map();
const FX_TTL_MS = 10 * 60 * 1000;

async function getFxRate(from, to) {
  if (from === to) return 1;
  const key = `${from}_${to}`;
  const cached = FX_CACHE.get(key);
  if (cached && Date.now() - cached.ts < FX_TTL_MS) return cached.rate;

  const pair = `${from}${to}=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}?interval=1d&range=2d`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 PairTradeTracker" }
    });
    if (!resp.ok) throw new Error("fx http " + resp.status);
    const data = await resp.json();
    const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!rate || !isFinite(rate)) throw new Error("no fx rate");
    FX_CACHE.set(key, { rate, ts: Date.now() });
    return rate;
  } catch (e) {
    if (cached) return cached.rate;
    throw e;
  }
}

// =============================================================================
// Internal price fetch (for alarm check)
// =============================================================================
async function fetchPriceInternal(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 PairTradeTracker" }
  });
  if (!resp.ok) throw new Error(`yahoo http ${resp.status} for ${symbol}`);
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`no price for ${symbol}`);
  return { price: meta.regularMarketPrice, currency: meta.currency || HOME_CCY };
}

// =============================================================================
// Get tranches array, with backward-compat for old flat-trade format
// =============================================================================
function getTranches(trade) {
  if (Array.isArray(trade.tranches) && trade.tranches.length > 0) return trade.tranches;
  // Legacy flat format → synthesize a single tranche from top-level fields
  return [{
    longQty: trade.longQty,
    longEntry: trade.longEntry,
    longEntryCcy: trade.longEntryCcy,
    longEntryNative: !!trade.longEntryNative,
    shortQty: trade.shortQty,
    shortEntry: trade.shortEntry,
    shortEntryCcy: trade.shortEntryCcy,
    shortEntryNative: !!trade.shortEntryNative
  }];
}

// =============================================================================
// Path-independent performance calculation, aggregated across tranches
// =============================================================================
async function computePerf(trade) {
  const longLive  = await fetchPriceInternal(trade.longTicker);
  const shortLive = await fetchPriceInternal(trade.shortTicker);
  const tranches = getTranches(trade);

  async function legPnl(entry, qty, live, apiCcy, entryCcy, isLong) {
    const apiToEntry  = apiCcy === entryCcy   ? 1 : await getFxRate(apiCcy, entryCcy);
    const entryToHome = entryCcy === HOME_CCY ? 1 : await getFxRate(entryCcy, HOME_CCY);
    const liveInEntry = live * apiToEntry;
    const pxDelta     = isLong ? (liveInEntry - entry) : (entry - liveInEntry);
    const pnlEntry    = pxDelta * qty;
    const pnlHome     = pnlEntry * entryToHome;
    const notionalEntryStart = entry * qty;
    const notionalHomeStart  = notionalEntryStart * entryToHome;
    const notionalEntryNow   = liveInEntry * qty;
    const notionalHomeNow    = notionalEntryNow * entryToHome;
    return { pnlHome, notionalHomeStart, notionalHomeNow };
  }

  let totalPnlHome = 0;
  let totalNotionalStart = 0;
  let totalNotionalNow = 0;

  for (const tranche of tranches) {
    const longEntryCcy = tranche.longEntryNative
      ? longLive.currency
      : (tranche.longEntryCcy || HOME_CCY);
    const shortEntryCcy = tranche.shortEntryNative
      ? shortLive.currency
      : (tranche.shortEntryCcy || HOME_CCY);

    const longLeg  = await legPnl(tranche.longEntry,  tranche.longQty,  longLive.price,  longLive.currency,  longEntryCcy,  true);
    const shortLeg = await legPnl(tranche.shortEntry, tranche.shortQty, shortLive.price, shortLive.currency, shortEntryCcy, false);

    totalPnlHome      += longLeg.pnlHome + shortLeg.pnlHome;
    totalNotionalStart += longLeg.notionalHomeStart + shortLeg.notionalHomeStart;
    totalNotionalNow   += longLeg.notionalHomeNow   + shortLeg.notionalHomeNow;
  }

  const perfPct = totalNotionalStart > 0 ? (totalPnlHome / totalNotionalStart) * 100 : 0;
  return { pnlHome: totalPnlHome, notionalHomeNow: totalNotionalNow, perfPct, trancheCount: tranches.length };
}

// =============================================================================
// Telegram helpers
// =============================================================================
async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("Telegram send failed:", resp.status, txt);
  }
  return resp.ok;
}

function buildAlarmMessage(lang, trade, perfPct, pnl, notionalNow, trancheCount) {
  const sign = perfPct >= 0 ? "+" : "";
  const threshold = trade.alertPctMin ?? trade.alertThreshold ?? 0;
  const lines = [
    workerT(lang, "alarm_title"),
    "",
    workerT(lang, "pair")         + ": " + (trade.name || (trade.longTicker + " / " + trade.shortTicker)),
    workerT(lang, "performance")  + ": " + sign + perfPct.toFixed(2) + "%",
    workerT(lang, "threshold")    + ": " + Number(threshold).toFixed(2) + "%",
    workerT(lang, "pnl")          + ": " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " " + HOME_CCY,
    workerT(lang, "notional_now") + ": " + notionalNow.toFixed(2) + " " + HOME_CCY
  ];
  if (trancheCount > 1) {
    lines.push(workerT(lang, "tranches") + ": " + trancheCount);
  }
  lines.push("", workerT(lang, "ack_prompt"));
  return lines.join("\n");
}

// =============================================================================
// Alarm check (called by cron and /check)
// =============================================================================
async function runAlarmCheck(env) {
  if (!isWithinTradingHours()) {
    return { ok: true, skipped: "outside trading hours" };
  }

  const record = await jsonbinRead(env);
  const trades = record.trades || [];
  const lang   = record.lang   || "de";
  const states = record.alertStates || {};
  let stateChanged = false;
  const results = [];

  for (const trade of trades) {
    const threshold = trade.alertPctMin ?? trade.alertThreshold;
    if (threshold == null || threshold === "") continue;
    const id = trade.id;
    const state = states[id] || { state: "idle", lastAlertAt: 0 };
    let perf;
    try {
      perf = await computePerf(trade);
    } catch (e) {
      results.push({ id, error: e.message });
      continue;
    }

    const breached = perf.perfPct <= -Math.abs(Number(threshold));
    const now = Date.now();

    if (breached && state.state === "idle") {
      await sendTelegram(env, buildAlarmMessage(lang, trade, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
      states[id] = { state: "triggered", lastAlertAt: now };
      stateChanged = true;
      results.push({ id, action: "triggered" });
    } else if (breached && state.state === "triggered" && (now - state.lastAlertAt) >= ALERT_REPEAT_MS) {
      await sendTelegram(env, buildAlarmMessage(lang, trade, perf.perfPct, perf.pnlHome, perf.notionalHomeNow, perf.trancheCount));
      states[id] = { state: "triggered", lastAlertAt: now };
      stateChanged = true;
      results.push({ id, action: "repeated" });
    } else if (!breached && state.state !== "idle") {
      states[id] = { state: "idle", lastAlertAt: 0 };
      stateChanged = true;
      results.push({ id, action: "reset" });
    } else {
      results.push({ id, action: "noop", state: state.state, perf: perf.perfPct, tranches: perf.trancheCount });
    }
  }

  if (stateChanged) {
    await jsonbinWrite(env, { ...record, alertStates: states });
  }

  return { ok: true, results };
}

// =============================================================================
// Test alert
// =============================================================================
async function sendTestAlert(env) {
  let lang = "de";
  try {
    const record = await jsonbinRead(env);
    lang = record.lang || "de";
  } catch {}
  const msg = [
    workerT(lang, "test_alert"),
    "",
    workerT(lang, "test_body"),
    "",
    workerT(lang, "ack_prompt")
  ].join("\n");
  const ok = await sendTelegram(env, msg);
  return ok ? "test sent" : "test failed";
}

// =============================================================================
// Telegram webhook (handles ack)
// =============================================================================
async function handleTelegramWebhook(req, env) {
  let update;
  try { update = await req.json(); } catch { return textResponse("bad json", 400); }
  const message = update.message;
  if (!message || !message.chat || String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return textResponse("ignored");
  }

  let record, lang = "de";
  try {
    record = await jsonbinRead(env);
    lang = record.lang || "de";
  } catch {
    await sendTelegram(env, workerT(lang, "ack_received"));
    return textResponse("ok (no record)");
  }

  const states = record.alertStates || {};
  let changed = false;
  for (const id of Object.keys(states)) {
    if (states[id]?.state === "triggered") {
      states[id] = { state: "acknowledged", lastAlertAt: Date.now() };
      changed = true;
    }
  }
  if (changed) {
    try { await jsonbinWrite(env, { ...record, alertStates: states }); } catch {}
  }

  await sendTelegram(env, workerT(lang, "ack_received"));
  return textResponse("ok");
}

// =============================================================================
// Setup webhook
// =============================================================================
async function setupWebhook(req, env) {
  const u = new URL(req.url);
  const webhookUrl = u.origin + "/telegram-webhook";
  const apiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  const resp = await fetch(apiUrl);
  const data = await resp.json();
  return jsonResponse({ requested: webhookUrl, telegram: data });
}

// =============================================================================
// Main router
// =============================================================================
export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "") {
      const symbol = url.searchParams.get("symbol");
      if (symbol) return yahooProxy(symbol);
      return textResponse("Pair Trade Tracker Worker — endpoints: /?symbol=, /check, /test-alert, /setup-webhook, /telegram-webhook");
    }
    if (url.pathname === "/check") {
      try {
        const r = await runAlarmCheck(env);
        return jsonResponse(r);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }
    if (url.pathname === "/test-alert") {
      const r = await sendTestAlert(env);
      return textResponse(r);
    }
    if (url.pathname === "/setup-webhook") {
      return setupWebhook(req, env);
    }
    if (url.pathname === "/telegram-webhook" && req.method === "POST") {
      return handleTelegramWebhook(req, env);
    }
    return textResponse("not found", 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlarmCheck(env).catch(e => console.error("cron error:", e)));
  }
};
