// Pair Trade Tracker — Cloudflare Worker
// Three Alarm-Typen:
//   • Loss   — alertPctMin / alertPriceMin, alle 1 Min wiederholt bis ack (Cron: * * * * *)
//   • Profit — alertPctMax / alertPriceMax, alle 30 Min wiederholt bis ack (Cron: * * * * *)
//   • Short-Squeeze — alertShortPct, einmal täglich wiederholt bis ack (Cron: beliebige Tageszeit, z.B. "0 17 * * *" für 17:00 UTC)
// Pair-Trades: nur pct-Mode für Loss/Profit (Spread hat keinen Quoted Price).
// Short-Squeeze nur für type=short oder pair (überwacht in beiden Fällen shortTicker).
// Cron-Dispatch: "* ..."- oder "*/N ..."-Pattern → Loss/Profit-Check, alles andere → Squeeze-Check.
// WICHTIG: bewusst 45s, NICHT exakt 60s. Der Cron (* * * * *) ist der eigentliche
// Frequenz-Begrenzer und feuert höchstens 1× pro Minute. Cloudflare führt Crons aber
// mit ein paar Sekunden Jitter aus — bei exakt 60000ms würde die Schwelle den
// Minuten-Cron um Haaresbreite verfehlen und der Loss-Alarm käme nur alle 2 Minuten.
// 45s liegt sicher unter 60s (15s Jitter-Toleranz) und garantiert Feuern bei jedem
// Minuten-Cron. Ein Doppel-Feuern innerhalb einer Minute ist unmöglich, weil der
// Cron nicht öfter als 1×/Min aufwacht.
const ALERT_REPEAT_MS = 45 * 1000;
const PROFIT_ALERT_REPEAT_MS = 30 * 60 * 1000;
// Robuste Cron-Dispatch: der schnelle Loss/Profit-Cron startet mit "*/3 " (3-Min-Intervall).
// Alles andere (z.B. "0 17 * * *" für täglich 17:00 UTC) wird als Squeeze-Cron behandelt.
// Damit kannst du die Squeeze-Cron-Zeit im Cloudflare-Dashboard frei ändern ohne Code-Update.
// Cron-Dispatcher: erkennt Fast-Cron (Alarm-Check, * oder */N im Minuten-Feld) vs.
// Daily-Cron (Squeeze-Check, fixe Minute wie "0 6 * * *"). Damit kannst du im
// Cloudflare-Dashboard zwischen */3, */2, */1 oder * wechseln ohne den Worker
// neu deployen zu müssen — Dispatcher erkennt alle als "Fast" weil Minuten-Feld
// mit * anfängt. Squeeze-Cron hat eine fixe Ziffer (z.B. "0") als ersten Token.
function isFastCron(cronStr) {
  const firstField = String(cronStr || "").trim().split(/\s+/)[0] || "";
  return firstField.startsWith("*");
}
const TRADING_START_HOUR = 9;
const TRADING_END_HOUR = 23;
const HOME_CCY = "EUR";

const WORKER_STRINGS = {
  de: {
    alarm_title:"🚨 VERLUST-SCHWELLE ÜBERSCHRITTEN", profit_title:"🎯 GEWINN-SCHWELLE ERREICHT",
    squeeze_title:"⚡ SHORT-SQUEEZE-ALARM",
    basket_loss_title:"🚨 KORB-VERLUST-SCHWELLE ÜBERSCHRITTEN", basket_profit_title:"🎯 KORB-GEWINN-SCHWELLE ERREICHT",
    basket_label:"Korb", basket_default_name:"Unbenannter Korb",
    pair:"Paar", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Schwelle", pnl:"P&L", notional_now:"Notional jetzt", tranches:"Tranchen",
    current_price:"Aktueller Kurs",
    short_interest:"Short-Interest", days_to_cover:"Days to Cover", data_as_of:"Datenstand",
    ack_prompt:"→ Antworte mit beliebigem Text, um den Alarm zu bestätigen",
    profit_ack_prompt:"→ Antworte mit beliebigem Text, um den Gewinn-Alarm zu bestätigen (Wiederholung alle 30 Min)",
    squeeze_ack_prompt:"→ Antworte mit beliebigem Text, um den Squeeze-Alarm zu quittieren (Wiederholung 1× pro Tag)",
    ack_received:"✅ Alarm bestätigt",
    watch_title:"📡 WATCHLIST",
    watch_above:"{side} {ticker} hat {level} {ccy} überschritten (aktuell {price} {ccy})",
    watch_below:"{side} {ticker} hat {level} {ccy} unterschritten (aktuell {price} {ccy})",
    watch_side_long:"Long-Kandidat", watch_side_short:"Short-Kandidat",
    test_alert:"🧪 Test-Alarm", test_body:"Dies ist ein Test. Antworte um zu bestätigen.",
    fallback_warning_title:"⚠ JSONBin nicht erreichbar — Worker arbeitet aus KV-Cache",
    fallback_warning_body:"Alarme für existierende Trades laufen weiter mit dem letzten bekannten Stand ({age} Min alt). Neue Trades oder geänderte Schwellen sind nicht sichtbar bis JSONBin wieder erreichbar ist. Fehler: {err}"
  },
  en: {
    alarm_title:"🚨 LOSS THRESHOLD BREACHED", profit_title:"🎯 PROFIT THRESHOLD REACHED",
    squeeze_title:"⚡ SHORT-SQUEEZE ALERT",
    basket_loss_title:"🚨 BASKET LOSS THRESHOLD BREACHED", basket_profit_title:"🎯 BASKET PROFIT THRESHOLD REACHED",
    basket_label:"Basket", basket_default_name:"Unnamed basket",
    pair:"Pair", long_only:"Long", short_only:"Short",
    performance:"Performance", threshold:"Threshold", pnl:"P&L", notional_now:"Notional now", tranches:"Tranches",
    current_price:"Current price",
    short_interest:"Short interest", days_to_cover:"Days to cover", data_as_of:"Data as of",
    ack_prompt:"→ Reply with any text to acknowledge the alert",
    profit_ack_prompt:"→ Reply with any text to acknowledge the profit alert (repeats every 30 min)",
    squeeze_ack_prompt:"→ Reply with any text to acknowledge the squeeze alert (repeats 1× per day)",
    ack_received:"✅ Alert acknowledged",
    watch_title:"📡 WATCHLIST",
    watch_above:"{side} {ticker} has broken above {level} {ccy} (now {price} {ccy})",
    watch_below:"{side} {ticker} has broken below {level} {ccy} (now {price} {ccy})",
    watch_side_long:"Long candidate", watch_side_short:"Short candidate",
    test_alert:"🧪 Test alert", test_body:"This is a test. Reply to acknowledge.",
    fallback_warning_title:"⚠ JSONBin unreachable — worker running from KV cache",
    fallback_warning_body:"Alarms for existing trades continue with the last known snapshot ({age} min old). New trades or threshold changes are not visible until JSONBin is reachable again. Error: {err}"
  }
};
function workerT(lang, key, params) {
  const d = WORKER_STRINGS[lang] || WORKER_STRINGS.de;
  let s = d[key] || WORKER_STRINGS.de[key] || key;
  if (params && typeof s === "string") {
    for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
  }
  return s;
}

const CORS_HEADERS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization" };
function jsonResponse(o, s=200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }
function textResponse(t, s=200) { return new Response(t, { status: s, headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }); }

function isWithinTradingHours() {
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const d = n.getDay(); if (d === 0 || d === 6) return false;
  const h = n.getHours(); return h >= TRADING_START_HOUR && h < TRADING_END_HOUR;
}

// Sector/Industry-Lookup für Branchen-Donut. Cached aggressiv in KV (30 Tage),
// weil sich Yahoo's Klassifizierung praktisch nie ändert.
// Returns { sector, industry, source: "cache"|"yahoo"|"unknown" }.
//
// WICHTIG: Yahoo's quoteSummary-API (v10) verlangt seit Mitte 2023 einen
// Crumb-Token plus passende Session-Cookies, sonst antwortet sie mit
// "401 Invalid Crumb". Flow:
//   1. GET https://fc.yahoo.com/ → liefert A1/A3-Cookies via Set-Cookie
//   2. GET https://query2.finance.yahoo.com/v1/test/getcrumb mit Cookie
//      → returnt einen kurzen Crumb-String (z.B. "abc.123XYZ")
//   3. GET quoteSummary?crumb=<crumb>&... mit demselben Cookie
// Crumbs sind ein paar Stunden gültig. Wir cachen in KV für 6h.
const PROFILE_KV_PREFIX = "profile:";
const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 Tage
const CRUMB_KV_KEY = "yahoo_crumb_v1";
const CRUMB_TTL_SECONDS = 6 * 60 * 60; // 6 Stunden
const YH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Sammelt Set-Cookie-Header von einer Response. Cloudflare Workers haben
// `headers.getSetCookie()` für getrennte Set-Cookie-Werte (Workers Runtime
// 2023+). Fallback: `headers.get("set-cookie")` (concatenated string).
function extractCookiePairs(res) {
  let raws = [];
  try {
    if (typeof res.headers.getSetCookie === "function") raws = res.headers.getSetCookie() || [];
  } catch {}
  if (raws.length === 0) {
    const concat = res.headers.get("set-cookie") || "";
    if (concat) raws = [concat];
  }
  return raws.map(c => String(c).split(";")[0].trim()).filter(Boolean);
}

// Holt einen frischen Crumb + Cookie-String. Drei Fallback-Endpoints, weil
// fc.yahoo.com gelegentlich 404 zurückgibt (setzt aber Cookies), und
// finance.yahoo.com manchmal ein Region-Redirect macht.
async function fetchYahooCrumb() {
  // Schritt 1: A1/A3 Session-Cookies einsammeln
  const cookieUrls = [
    "https://fc.yahoo.com/",
    "https://finance.yahoo.com/quote/AAPL",
    "https://login.yahoo.com/"
  ];
  let cookieHeader = "";
  let lastStatus = "";
  for (const u of cookieUrls) {
    try {
      const r = await fetch(u, {
        method: "GET",
        headers: { "User-Agent": YH_UA, "Accept": "text/html,*/*" },
        redirect: "follow"
      });
      lastStatus = `${u} → ${r.status}`;
      const pairs = extractCookiePairs(r);
      // Wir brauchen mindestens einen A1/A3-Cookie, der Crumb-Service akzeptiert keinen leeren Cookie
      const wanted = pairs.filter(p => /^(A[13]|A1S|GUC|B|cmp|gpp)=/.test(p));
      if (wanted.length > 0) { cookieHeader = wanted.join("; "); break; }
      if (pairs.length > 0 && !cookieHeader) cookieHeader = pairs.join("; "); // wenigstens irgendwas, falls die A-Cookies nicht erkannt werden
    } catch (e) { lastStatus = `${u} → ${e.message}`; }
  }
  if (!cookieHeader) throw new Error("no yahoo cookies (" + lastStatus + ")");
  // Schritt 2: Crumb holen — manchmal braucht's mehrere Versuche bis das Cookie greift
  let lastErr = "";
  for (let i = 0; i < 2; i++) {
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      method: "GET",
      headers: { "User-Agent": YH_UA, "Accept": "*/*", "Cookie": cookieHeader }
    });
    const text = (await crumbRes.text()).trim();
    if (crumbRes.ok && text && text.length < 50 && !/^[\s\S]*(too\s*many|error|html)/i.test(text)) {
      return { crumb: text, cookie: cookieHeader, ts: Date.now() };
    }
    lastErr = `getcrumb http ${crumbRes.status} → "${text.slice(0, 60)}"`;
  }
  throw new Error(lastErr);
}

// Cached den Crumb in KV für 6h, refreshed bei Bedarf. forceRefresh=true
// erzwingt einen neuen Crumb (falls quoteSummary trotz frischem Cache scheitert).
async function getYahooCrumb(env, forceRefresh = false) {
  if (!forceRefresh && env.TRADEBOOK_CACHE) {
    try {
      const cached = await env.TRADEBOOK_CACHE.get(CRUMB_KV_KEY, { type: "json" });
      if (cached && cached.crumb && cached.cookie) return cached;
    } catch (e) { console.warn("crumb KV read failed:", e.message); }
  }
  const fresh = await fetchYahooCrumb();
  if (env.TRADEBOOK_CACHE) {
    try { await env.TRADEBOOK_CACHE.put(CRUMB_KV_KEY, JSON.stringify(fresh), { expirationTtl: CRUMB_TTL_SECONDS }); }
    catch (e) { console.warn("crumb KV write failed:", e.message); }
  }
  return fresh;
}

// Extrahiert Number aus Yahoo's "{ raw: 1.23 }"-Wrappern oder direkten Werten
function ynum(v) {
  if (v == null) return null;
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "object" && v && typeof v.raw === "number" && isFinite(v.raw)) return v.raw;
  return null;
}

async function handleProfile(symbol, env) {
  const sym = String(symbol).toUpperCase().trim();
  if (!sym) return jsonResponse({ error: "missing symbol" }, 400);
  // KV-Cache prüfen (pro Ticker). Schema v2: jetzt mit beta. Alte Einträge ohne beta-Feld
  // werden nicht akzeptiert → re-fetch zwingen, damit das Beta nachgeholt wird.
  if (env.TRADEBOOK_CACHE) {
    try {
      const cached = await env.TRADEBOOK_CACHE.get(PROFILE_KV_PREFIX + sym, { type: "json" });
      if (cached && cached.sector && Object.prototype.hasOwnProperty.call(cached, "beta")) {
        return jsonResponse({
          symbol: sym,
          sector: cached.sector,
          industry: cached.industry || null,
          beta: cached.beta ?? null,
          beta3y: cached.beta3y ?? null,
          source: "cache"
        });
      }
    } catch (e) { console.warn("profile KV read failed for", sym, e.message); }
  }
  // Yahoo abrufen, mit Crumb-Retry-Loop
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let crumbData;
    try { crumbData = await getYahooCrumb(env, attempt > 0); }
    catch (e) { lastError = "crumb: " + e.message; break; }
    // Ein Call holt mehrere Module gleichzeitig → kein extra API-Roundtrip
    const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile,defaultKeyStatistics,summaryDetail&crumb=${encodeURIComponent(crumbData.crumb)}`;
    try {
      const r = await fetch(u, {
        method: "GET",
        headers: { "User-Agent": YH_UA, "Accept": "application/json,text/plain,*/*", "Cookie": crumbData.cookie }
      });
      if (r.status === 401 || r.status === 403) { lastError = "yahoo " + r.status; continue; }
      if (!r.ok) { lastError = "yahoo http " + r.status; break; }
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0] || null;
      const profile = res?.assetProfile || null;
      const dks = res?.defaultKeyStatistics || null;
      const sd  = res?.summaryDetail || null;
      const sector = (profile?.sector || "").trim() || null;
      const industry = (profile?.industry || "").trim() || null;
      // Yahoo's "beta" = 5Y monthly gegen S&P 500 (für Stocks).
      // Für ETFs liegt's manchmal in beta3Year statt beta.
      // Priorität: defaultKeyStatistics.beta → summaryDetail.beta → defaultKeyStatistics.beta3Year.
      const betaStock = ynum(dks?.beta) ?? ynum(sd?.beta);
      const beta3y    = ynum(dks?.beta3Year);
      const beta      = betaStock != null ? betaStock : (beta3y != null ? beta3y : null);
      if (env.TRADEBOOK_CACHE && sector) {
        try {
          await env.TRADEBOOK_CACHE.put(PROFILE_KV_PREFIX + sym, JSON.stringify({ sector, industry, beta, beta3y, ts: Date.now() }), { expirationTtl: PROFILE_TTL_SECONDS });
        } catch (e) { console.warn("profile KV write failed for", sym, e.message); }
      }
      return jsonResponse({ symbol: sym, sector, industry, beta, beta3y, source: sector ? "yahoo" : "unknown" });
    } catch (e) { lastError = "fetch: " + e.message; break; }
  }
  return jsonResponse({ symbol: sym, sector: null, industry: null, beta: null, beta3y: null, source: "unknown", error: lastError || "unknown" });
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

// === KV-Cache-Resilience-Layer ============================================
// Worker wickelt JSONBin-Reads/Writes durch loadTradebook/saveTradebook ab.
// Funktionsweise:
//   • Read:  JSONBin zuerst probieren → bei Erfolg in KV spiegeln; bei Fehler
//            (z.B. HTTP 403 Quota-exhausted, 500/520-Outage) auf KV-Cache zurückfallen.
//   • Write: JSONBin zuerst probieren → bei Fehler in KV-only schreiben damit
//            der nächste Cron-Tick zumindest den aktuellsten AlertState sieht.
// Beim Fallback auf KV wird eine Telegram-Warnung an Robert geschickt, rate-limited
// auf max. 1× pro Stunde (sonst spammt's bei einem Mehrtages-Outage). Worker-Cron
// liefert die Alarme weiter mit dem letzten bekannten Trade-Stand — wichtig damit
// Verlust-Schwellen auch bei JSONBin-Outage feuern.
// KV-Binding-Name: TRADEBOOK_CACHE. Setup in Cloudflare-Dashboard → Worker →
// Settings → Variables and Secrets → KV Namespace Bindings → "TRADEBOOK_CACHE".
// Falls Binding nicht existiert, verhält sich der Worker wie vorher (kein Fallback).
const TRADEBOOK_KV_KEY = "tradebook:latest";
const FALLBACK_WARN_KV_KEY = "fallback_warn:last_ts";
const FALLBACK_WARN_MIN_INTERVAL_MS = 60 * 60 * 1000;  // 1h zwischen Warnungen
const KV_TTL_SECONDS = 7 * 24 * 3600;                  // 7 Tage Cache-Aufbewahrung

// loadTradebook: KV ist seit der JSONBin→KV-Migration (Mai 2026) der PRIMÄRE Storage.
// JSONBin ist nur noch Cold-Start-Fallback falls KV leer ist UND JSONBin-Secrets noch
// gesetzt sind — dieser Pfad existiert für die Migration von alten Bins. Nach erfolgreicher
// Migration kann der JSONBin-Read-Block komplett raus, plus die Secrets im CF-Dashboard.
//
// Wichtig: „KV leer + JSONBin nicht verfügbar" ist KEIN Fehler, sondern ein gültiger
// Bootstrap-Zustand. Wir geben ein leeres Tradebook zurück — das Frontend behandelt
// es korrekt (sieht remote = leer, lokal hat Daten → Push triggert → KV wird gefüllt).
// Wenn wir hier throwen würden, blockt der Pull den ganzen Sync-Flow und KV bleibt
// für immer leer. Beobachtet bei Roberts Erst-Migration Mai 2026.
async function loadTradebook(env) {
  // 1. KV zuerst — das ist der reguläre Pfad
  if (env.TRADEBOOK_CACHE) {
    try {
      const cached = await env.TRADEBOOK_CACHE.get(TRADEBOOK_KV_KEY, { type: "json" });
      if (cached && cached.data) {
        return { data: cached.data, source: "kv", ts: cached.ts || 0 };
      }
    } catch (kvErr) {
      console.warn("KV read failed:", kvErr.message);
      // weiter zu JSONBin-Fallback
    }
  }
  // 2. JSONBin-Cold-Start-Bootstrap — nur best-effort, Fehler werden geschluckt
  if (env.JSONBIN_BIN_ID && env.JSONBIN_KEY) {
    try {
      const data = await jsonbinRead(env);
      // Erfolgreich von JSONBin gelesen → in KV spiegeln damit der nächste Read direkt aus KV kommt
      if (env.TRADEBOOK_CACHE) {
        try {
          await env.TRADEBOOK_CACHE.put(TRADEBOOK_KV_KEY,
            JSON.stringify({ data, ts: Date.now() }),
            { expirationTtl: KV_TTL_SECONDS });
        } catch (e) { /* swallowed */ }
      }
      return { data, source: "jsonbin_bootstrap" };
    } catch (jbErr) {
      console.warn("jsonbin cold-start fallback failed (ok during migration):", jbErr.message);
      // Fall-through zu „leeres Tradebook" — kein Throw
    }
  }
  // 3. Leeres Tradebook als gültiger Bootstrap-Zustand
  return { data: {}, source: "empty", ts: 0 };
}

// saveTradebook: KV ist der primäre Persistenz-Layer. JSONBin-Mirror wird nur dann
// versucht wenn die Secrets noch gesetzt sind (Übergangs-Phase) — schlägt's fehl,
// ist's egal weil KV schon den State hält.
async function saveTradebook(env, record) {
  // 1. KV schreiben — der Hauptpfad
  if (env.TRADEBOOK_CACHE) {
    await env.TRADEBOOK_CACHE.put(TRADEBOOK_KV_KEY,
      JSON.stringify({ data: record, ts: Date.now() }),
      { expirationTtl: KV_TTL_SECONDS });
  } else {
    throw new Error("TRADEBOOK_CACHE binding not configured — cannot save");
  }
  // 2. JSONBin-Mirror nur best-effort (für Migrations-Phase, kann später raus)
  if (env.JSONBIN_BIN_ID && env.JSONBIN_KEY) {
    try {
      await jsonbinWrite(env, record);
      return { ok: true, source: "kv_and_jsonbin" };
    } catch (jbErr) {
      console.warn("jsonbin mirror failed (KV is authoritative):", jbErr.message);
      return { ok: true, source: "kv_only", jsonbinError: jbErr.message };
    }
  }
  return { ok: true, source: "kv_only" };
}

// Persistiert Alarm-States OHNE den restlichen Tradebook zu klobbern.
//
// KRITISCH: Der Alarm-Cron lädt den Tradebook, macht dann SEKUNDENLANG Yahoo-Fetches,
// und schreibt am Ende zurück. Würde er dabei seinen VERALTETEN trades-Snapshot
// zurückschreiben (`{...record, alertStates}`), dann würde ein Trade, den der User
// während des Checks gelöscht hat, wieder auferstehen ("Zombie-Trade") — und der
// nächste Cron alarmiert weiter. Genau das war der Bug: gelöschter Trade, aber
// weiterhin Minuten-Alarme.
//
// Fix: kurz VOR dem Schreiben den frischesten Record neu laden und nur die
// Alarm-States hineinmergen. Damit gewinnen zwischenzeitliche Frontend-Löschungen
// und Telegram-Quittierungen. Das Race-Fenster schrumpft von "ganze Check-Dauer"
// auf "Mikrosekunden zwischen Reload und Write".
function alarmAckWins(mine, theirs) {
  // Wenn zwischenzeitlich per Telegram quittiert wurde (state "acknowledged"),
  // darf der Cron das nicht auf "triggered"/"notified" zurücksetzen. Nur solange
  // der Cron-State noch aktiv alarmiert — bei Erholung (idle) gewinnt idle, damit
  // ein späterer neuer Breach wieder alarmieren kann.
  const pick = (m, t) => (t && t.state === "acknowledged" && m && (m.state === "triggered" || m.state === "notified")) ? t : m;
  if (!theirs) return mine;
  return {
    min:     pick(mine?.min,     theirs.min),
    max:     pick(mine?.max,     theirs.max),
    squeeze: pick(mine?.squeeze, theirs.squeeze)
  };
}
async function persistAlarmStates(env, computedStates, computedWatchStates = null) {
  const fresh = (await loadTradebook(env)).data || {};
  const freshStates = fresh.alertStates || {};
  // Gültige IDs = Trades + Baskets im FRISCHEN Record. States ohne zugehörige
  // Entität werden verworfen (kein Zombie-State für gelöschte Trades/Körbe).
  const validIds = new Set([
    ...(Array.isArray(fresh.trades)  ? fresh.trades.map(x => x.id)  : []),
    ...(Array.isArray(fresh.baskets) ? fresh.baskets.map(x => x.id) : [])
  ]);
  const merged = {};
  // 1. Basis: gültige States aus dem frischen Record (prunt Zombies automatisch)
  for (const id of Object.keys(freshStates)) {
    if (validIds.has(id)) merged[id] = freshStates[id];
  }
  // 2. Overlay: die vom Cron berechneten Änderungen — aber Ack gewinnt
  for (const id of Object.keys(computedStates)) {
    if (!validIds.has(id)) continue; // gelöschter Trade → State verwerfen
    merged[id] = alarmAckWins(computedStates[id], freshStates[id]);
  }
  const rec = { ...fresh, alertStates: merged };
  // Watch-States (separates Dict, kein Ack-Konzept): gleiche Merge-Semantik —
  // frischer Record ist Basis, Cron-Änderungen überlagern, gelöschte Einträge fliegen raus.
  if (computedWatchStates) {
    const freshWatch = fresh.watchStates || {};
    const validWatchIds = new Set(Array.isArray(fresh.watchlist) ? fresh.watchlist.map(w => w.id) : []);
    const mergedWatch = {};
    for (const id of Object.keys(freshWatch)) if (validWatchIds.has(id)) mergedWatch[id] = freshWatch[id];
    for (const id of Object.keys(computedWatchStates)) if (validWatchIds.has(id)) mergedWatch[id] = computedWatchStates[id];
    rec.watchStates = mergedWatch;
  }
  await saveTradebook(env, rec);
}

// Watch-State-Shape: pro Eintrag zwei unabhängige Einmal-Achsen (above/below).
function ensureWatchShape(st) {
  const empty = { state: "idle", lastAlertAt: 0 };
  if (!st || typeof st !== "object") return { above: { ...empty }, below: { ...empty } };
  return { above: st.above || { ...empty }, below: st.below || { ...empty } };
}

// Auth-Check für Frontend-Sync-Endpoints. Erwartet Authorization: Bearer <SYNC_SECRET>.
// Das Secret wird in Cloudflare-Dashboard → Worker → Settings → Secrets als SYNC_SECRET
// angelegt (32-Zeichen-Random-String empfohlen). Beide Geräte (iPhone + Mac) tragen
// dasselbe Secret in ihre App-Settings ein.
function checkSyncAuth(req, env) {
  if (!env.SYNC_SECRET) return { ok: false, msg: "SYNC_SECRET not configured on worker" };
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, msg: "missing Bearer token" };
  if (m[1].trim() !== env.SYNC_SECRET) return { ok: false, msg: "invalid sync secret" };
  return { ok: true };
}

// GET /tradebook — Frontend pulled hier her statt von JSONBin.
async function handleTradebookGet(req, env) {
  const auth = checkSyncAuth(req, env);
  if (!auth.ok) return jsonResponse({ error: auth.msg }, 401);
  try {
    const result = await loadTradebook(env);
    return jsonResponse({
      data: result.data,
      source: result.source,
      ts: result.ts || Date.now()
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// POST /tradebook — Frontend pushed hier her statt zu JSONBin.
async function handleTradebookPost(req, env) {
  const auth = checkSyncAuth(req, env);
  if (!auth.ok) return jsonResponse({ error: auth.msg }, 401);
  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  // Sanity-Check: tradebook sollte zumindest ein Objekt sein, idealerweise mit trades-Array
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "body must be an object" }, 400);
  }
  try {
    const result = await saveTradebook(env, body);
    return jsonResponse({ ok: true, source: result.source });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// POST /migrate-from-jsonbin — einmaliger Migrations-Endpoint. Liest direkt von JSONBin,
// schreibt in KV. Wird vom User manuell aufgerufen wenn JSONBin reachable ist.
// Nach Migration kann der JSONBin-Account gelöscht und die Secrets im CF-Dashboard
// entfernt werden — der Worker läuft dann komplett KV-only.
async function handleMigrateFromJsonbin(req, env) {
  const auth = checkSyncAuth(req, env);
  if (!auth.ok) return jsonResponse({ error: auth.msg }, 401);
  if (!env.JSONBIN_BIN_ID || !env.JSONBIN_KEY) {
    return jsonResponse({ error: "JSONBin secrets not configured" }, 400);
  }
  if (!env.TRADEBOOK_CACHE) {
    return jsonResponse({ error: "TRADEBOOK_CACHE binding not configured" }, 500);
  }
  try {
    const data = await jsonbinRead(env);
    await env.TRADEBOOK_CACHE.put(TRADEBOOK_KV_KEY,
      JSON.stringify({ data, ts: Date.now() }),
      { expirationTtl: KV_TTL_SECONDS });
    return jsonResponse({
      ok: true,
      message: "Migration complete. Tradebook now lives in KV.",
      stats: {
        trades: Array.isArray(data.trades) ? data.trades.length : 0,
        baskets: Array.isArray(data.baskets) ? data.baskets.length : 0,
        alertStates: data.alertStates ? Object.keys(data.alertStates).length : 0
      }
    });
  } catch (e) {
    return jsonResponse({ error: "migration failed: " + e.message }, 500);
  }
}

async function maybeSendFallbackWarning(env, record, ageMin, errMsg) {
  if (!env.TRADEBOOK_CACHE) return;
  try {
    const lastRaw = await env.TRADEBOOK_CACHE.get(FALLBACK_WARN_KV_KEY);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    if (Date.now() - last < FALLBACK_WARN_MIN_INTERVAL_MS) return;  // rate-limited
    const lang = (record && record.lang) || "de";
    const shortErr = (errMsg || "").slice(0, 100);
    const msg = workerT(lang, "fallback_warning_title") + "\n\n"
              + workerT(lang, "fallback_warning_body", { age: String(ageMin), err: shortErr });
    await sendTelegram(env, msg);
    await env.TRADEBOOK_CACHE.put(FALLBACK_WARN_KV_KEY, String(Date.now()),
      { expirationTtl: KV_TTL_SECONDS });
  } catch (e) { /* swallowed — Warnung ist Best-Effort */ }
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
    notionalHomeStart: totalNotStart,
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

    const sharesShort   = raw(stats.sharesShort);
    const floatShares   = raw(stats.floatShares);
    const shortPctYahoo = raw(stats.shortPercentOfFloat);  // Yahoo's vorberechnete Quote, Dezimalbruch

    // Yahoo's Feld `shortPercentOfFloat` ist gelegentlich inkonsistent mit den
    // Roh-Inputs (sharesShort/floatShares) in derselben Datenstruktur.
    // Konkret beobachtet bei BROS (Mai 2026): shortPctFloat=0.446 (= 44.6 %),
    // sharesShort=18.07M / floatShares=126.46M = 14.29 %. Andere Aggregatoren
    // (stockanalysis.com etc.) bestätigen die Computation, nicht das Yahoo-Feld.
    // Daher: wir rechnen selbst sobald wir beide Roh-Werte haben und nutzen
    // Yahoo's vorberechnetes Feld nur als Fallback wenn die Inputs fehlen.
    let shortPercentOfFloat;
    let computedFrom = "none";
    if (sharesShort != null && floatShares != null
        && floatShares > 0 && isFinite(sharesShort) && isFinite(floatShares)) {
      shortPercentOfFloat = (sharesShort / floatShares) * 100;
      computedFrom = "raw";
    } else if (shortPctYahoo != null && isFinite(shortPctYahoo)) {
      shortPercentOfFloat = shortPctYahoo * 100;
      computedFrom = "yahoo_precomputed";
    } else {
      return null;
    }

    return {
      shortPercentOfFloat,
      computedFrom,                                                                  // "raw" oder "yahoo_precomputed"
      sharesShort,
      floatShares,
      shortPercentOfFloatYahooRaw: shortPctYahoo != null && isFinite(shortPctYahoo)  // Yahoo's eigene Zahl zur Transparenz
        ? shortPctYahoo * 100 : null,
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
  // Transparenz: wenn Yahoo's vorberechnetes Feld deutlich (>3pp) vom selbstgerechneten
  // Wert abweicht, beide zeigen. Beobachteter Fall war BROS Mai 2026: Yahoo 44.60 % vs.
  // Computation 14.29 %. Andere Tickers würden den Hinweis gar nicht sehen wenn die Daten
  // intern konsistent sind.
  const yahooPct = shortInfo.shortPercentOfFloatYahooRaw;
  if (yahooPct != null && isFinite(yahooPct) && Math.abs(yahooPct - shortPct) > 3) {
    lines.push("(Yahoo-Feld: " + yahooPct.toFixed(2) + "% — Diskrepanz, Worker nutzt Computation)");
  }
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
  const { data: record } = await loadTradebook(env);
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

  if (stateChanged) await persistAlarmStates(env, states);
  return { ok: true, results };
}

async function runAlarmCheck(env) {
  if (!isWithinTradingHours()) return { ok: true, skipped: "outside trading hours" };
  const { data: record } = await loadTradebook(env);
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
    // Trades innerhalb eines Korbs: Loss/Profit-Alarme laufen über den Korb-Aggregat,
    // nicht über Einzeltrades. Squeeze-Alarme (separater Cron) bleiben unberührt.
    if (trade.basketId) continue;

    let perf;
    try { perf = await computePerf(trade); } catch (e) { results.push({ id, error: e.message }); continue; }

    // Pick the relevant live leg for price-mode comparisons.
    const live = type === "short" ? perf.shortLive : perf.longLive;
    const livePrice = live?.price;
    const liveCcy = (live?.currency || HOME_CCY).toUpperCase();

    const st = ensureStateShape(states[id]);
    let stChanged = false;

    // --- LOSS alarm (repeating every 1 min until ack) ---
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

  // --- Basket-Alarme: Aggregat aller im Korb enthaltenen Trades ---
  const basketsArr = Array.isArray(record.baskets) ? record.baskets : [];
  for (const basket of basketsArr) {
    const bId = basket.id;
    const minPct = basket.alertPctMin;
    const maxPct = basket.alertPctMax;
    const hasMin = minPct != null && minPct !== "";
    const hasMax = maxPct != null && maxPct !== "";
    if (!hasMin && !hasMax) continue;
    // Trades dieses Korbs sammeln + Aggregat berechnen
    const inBasket = trades.filter(tr => tr.basketId === bId);
    let aggPnl = 0, aggNotStart = 0, aggNotNow = 0, computed = 0;
    let aggError = null;
    for (const tr of inBasket) {
      try { const p = await computePerf(tr); aggPnl += p.pnlHome; aggNotStart += p.notionalHomeStart; aggNotNow += p.notionalHomeNow; computed++; }
      catch (e) { aggError = e.message; break; }
    }
    if (aggError) { results.push({ id: bId, kind: "basket", error: aggError }); continue; }
    if (computed === 0 || aggNotStart <= 0) {
      // Kein Trade im Korb auswertbar → State unverändert lassen
      results.push({ id: bId, kind: "basket", action: "no_data", tradeCount: inBasket.length });
      continue;
    }
    const aggPerfPct = (aggPnl / aggNotStart) * 100;
    const st = ensureStateShape(states[bId]);
    let stChanged = false;
    // LOSS
    if (hasMin) {
      const threshold = -Math.abs(Number(minPct));
      const breached = aggPerfPct <= threshold;
      const cur = st.min.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildBasketAlarmMessage(lang, basket, "loss", aggPerfPct, aggPnl, aggNotNow, inBasket.length));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id: bId, kind: "basket-loss", action: "triggered" });
      } else if (breached && cur === "triggered" && (now - st.min.lastAlertAt) >= ALERT_REPEAT_MS) {
        await sendTelegram(env, buildBasketAlarmMessage(lang, basket, "loss", aggPerfPct, aggPnl, aggNotNow, inBasket.length));
        st.min = { state: "triggered", lastAlertAt: now }; stChanged = true; results.push({ id: bId, kind: "basket-loss", action: "repeated" });
      } else if (!breached && cur !== "idle") {
        st.min = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id: bId, kind: "basket-loss", action: "reset" });
      }
    }
    // PROFIT
    if (hasMax) {
      const threshold = Math.abs(Number(maxPct));
      const breached = aggPerfPct >= threshold;
      const cur = st.max.state;
      if (breached && cur === "idle") {
        await sendTelegram(env, buildBasketAlarmMessage(lang, basket, "profit", aggPerfPct, aggPnl, aggNotNow, inBasket.length));
        st.max = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id: bId, kind: "basket-profit", action: "notified" });
      } else if (breached && cur === "notified" && (now - st.max.lastAlertAt) >= PROFIT_ALERT_REPEAT_MS) {
        await sendTelegram(env, buildBasketAlarmMessage(lang, basket, "profit", aggPerfPct, aggPnl, aggNotNow, inBasket.length));
        st.max = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id: bId, kind: "basket-profit", action: "repeated" });
      } else if (!breached && cur !== "idle") {
        st.max = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id: bId, kind: "basket-profit", action: "reset" });
      }
    }
    if (stChanged) { states[bId] = st; stateChanged = true; }
  }

  // --- Watchlist: Über-/Unterschreitungsgrenzen (seit Aug 2026) ---
  // Läuft im selben Cron-Takt wie die Trade-Alarme (bei Robert: minütlich zu
  // Handelszeiten). Einmalige Nachricht pro Kreuzen, edge-getriggert: notified
  // bleibt stehen bis der Kurs die Grenze wieder verlässt (auto-re-arm), dann
  // kann das nächste Kreuzen wieder genau eine Nachricht auslösen. Kein Repeat,
  // keine Quittierung — Watch-States leben separat in record.watchStates.
  const watchArr = Array.isArray(record.watchlist) ? record.watchlist : [];
  const wStates = record.watchStates || {};
  let watchChanged = false;
  for (const w of watchArr) {
    if (!w.ticker) continue;
    const hasAbove = w.levelAbove != null && w.levelAbove !== "";
    const hasBelow = w.levelBelow != null && w.levelBelow !== "";
    if (!hasAbove && !hasBelow) continue;
    let live;
    try { live = await fetchPriceInternal(w.ticker); }
    catch (e) { results.push({ id: w.id, kind: "watch", error: e.message }); continue; }
    const st = ensureWatchShape(wStates[w.id]);
    const sideLabel = workerT(lang, w.side === "short" ? "watch_side_short" : "watch_side_long");
    const label = w.name ? (w.name + " (" + w.ticker + ")") : w.ticker;
    const msgParams = (level) => ({ side: sideLabel, ticker: label, level: Number(level).toFixed(2), price: live.price.toFixed(2), ccy: live.currency || "" });
    let stChanged = false;
    if (hasAbove) {
      const breached = live.price >= Number(w.levelAbove);
      if (breached && st.above.state === "idle") {
        await sendTelegram(env, workerT(lang, "watch_title") + "\n\n" + workerT(lang, "watch_above", msgParams(w.levelAbove)));
        st.above = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id: w.id, kind: "watch-above", action: "notified" });
      } else if (!breached && st.above.state !== "idle") {
        st.above = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id: w.id, kind: "watch-above", action: "rearmed" });
      }
    }
    if (hasBelow) {
      const breached = live.price <= Number(w.levelBelow);
      if (breached && st.below.state === "idle") {
        await sendTelegram(env, workerT(lang, "watch_title") + "\n\n" + workerT(lang, "watch_below", msgParams(w.levelBelow)));
        st.below = { state: "notified", lastAlertAt: now }; stChanged = true; results.push({ id: w.id, kind: "watch-below", action: "notified" });
      } else if (!breached && st.below.state !== "idle") {
        st.below = { state: "idle", lastAlertAt: 0 }; stChanged = true; results.push({ id: w.id, kind: "watch-below", action: "rearmed" });
      }
    }
    if (stChanged) { wStates[w.id] = st; watchChanged = true; }
  }

  if (stateChanged || watchChanged) await persistAlarmStates(env, states, watchChanged ? wStates : null);
  return { ok: true, results };
}

// Telegram-Nachricht für einen Basket-Alarm. Klar als Korb deklariert.
function buildBasketAlarmMessage(lang, basket, kind, aggPerfPct, aggPnl, aggNotionalNow, tradeCount) {
  const sign = aggPerfPct >= 0 ? "+" : "";
  const isProfit = kind === "profit";
  const titleKey = isProfit ? "basket_profit_title" : "basket_loss_title";
  const rawThr = isProfit ? (basket.alertPctMax ?? 0) : (basket.alertPctMin ?? 0);
  const threshold = isProfit ? Math.abs(Number(rawThr)) : -Math.abs(Number(rawThr));
  const thresholdStr = (isProfit ? "+" : "") + threshold.toFixed(2) + "%";
  const typeLabel = basket.type === "short" ? workerT(lang, "short_only") : workerT(lang, "long_only");
  const name = basket.name || workerT(lang, "basket_default_name");
  const lines = [
    workerT(lang, titleKey), "",
    workerT(lang, "basket_label") + ": " + name + " (" + typeLabel + ", " + tradeCount + " " + workerT(lang, "tranches") + ")",
    workerT(lang, "performance") + ": " + sign + aggPerfPct.toFixed(2) + "%",
    workerT(lang, "threshold") + ": " + thresholdStr,
    workerT(lang, "pnl") + ": " + (aggPnl >= 0 ? "+" : "") + aggPnl.toFixed(2) + " " + HOME_CCY,
    workerT(lang, "notional_now") + ": " + aggNotionalNow.toFixed(2) + " " + HOME_CCY,
    "",
    workerT(lang, isProfit ? "profit_ack_prompt" : "ack_prompt")
  ];
  return lines.join("\n");
}

async function sendTestAlert(env) {
  let lang = "de";
  try { lang = (await loadTradebook(env)).data.lang || "de"; } catch {}
  const msg = [workerT(lang, "test_alert"), "", workerT(lang, "test_body"), "", workerT(lang, "ack_prompt")].join("\n");
  return (await sendTelegram(env, msg)) ? "test sent" : "test failed";
}

// Quittiert alle gerade aktiven Alarme (triggered/notified) — die klassische
// Webhook-Funktion, jetzt als eigenständige Funktion damit sowohl der Legacy-Pfad
// (ohne ANTHROPIC_API_KEY) als auch der Bot-Dialog sie aufrufen können.
// Returns Anzahl quittierter Alarm-Achsen.
async function ackAllActiveAlarms(env, record) {
  const states = record.alertStates || {}; let changed = false; let count = 0;
  const ackTs = Date.now();
  for (const id of Object.keys(states)) {
    const st = ensureStateShape(states[id]);
    let touched = false;
    if (st.min?.state === "triggered") { st.min = { state: "acknowledged", lastAlertAt: ackTs }; touched = true; count++; }
    if (st.max?.state === "notified")  { st.max = { state: "acknowledged", lastAlertAt: ackTs }; touched = true; count++; }
    if (st.squeeze?.state === "triggered") { st.squeeze = { state: "acknowledged", lastAlertAt: ackTs }; touched = true; count++; }
    if (touched) { states[id] = st; changed = true; }
  }
  if (changed) { try { await persistAlarmStates(env, states); } catch {} }
  return count;
}

// Liste der aktuell aktiven (unquittierten) Alarme — als Kontext für den Bot.
function listActiveAlarms(record) {
  const states = record.alertStates || {};
  const nameOf = (id) => {
    const tr = (record.trades || []).find(t => t.id === id);
    if (tr) return tr.name || tr.longTicker || tr.shortTicker || id;
    const b = (record.baskets || []).find(x => x.id === id);
    if (b) return "Korb " + (b.name || id);
    return id;
  };
  const out = [];
  for (const id of Object.keys(states)) {
    const st = ensureStateShape(states[id]);
    if (st.min?.state === "triggered") out.push({ name: nameOf(id), kind: "loss" });
    if (st.max?.state === "notified")  out.push({ name: nameOf(id), kind: "profit" });
    if (st.squeeze?.state === "triggered") out.push({ name: nameOf(id), kind: "squeeze" });
  }
  return out;
}

// === Telegram-Bot-Dialog: Trades per Chat anlegen (seit Aug 2026) ==========
// Freitext (typisch via Wispr-Flow diktiert) → Claude versteht, sucht Ticker der
// Heimbörse, fragt fehlende Angaben so lange nach bis alles da ist, fasst dann
// komplett zusammen und trägt erst nach expliziter Bestätigung ("ok") ein.
// Änderungswünsche nach der Zusammenfassung werden erkannt, eingearbeitet und
// neu zusammengefasst. Ausgang ist binär: Eintrag oder kein Eintrag.
// Feature ist nur aktiv wenn Secret ANTHROPIC_API_KEY gesetzt ist — ohne den Key
// verhält sich der Webhook exakt wie früher (jede Antwort quittiert Alarme).
// Eindeutige Kurz-Bestätigungen, die der Worker OHNE Claude-Aufruf verarbeitet
// (Kosten-Kurzschluss): Zusammenfassung bestätigen bzw. Alarme quittieren.
// Nur exakte Ein-Wort-Treffer nach Normalisierung — alles Längere geht an Claude.
const BOT_ACK_WORDS = new Set([
  "ok", "okay", "okey", "k", "ja", "jo", "jup", "jep", "yes", "passt", "go",
  "danke", "thx", "thanks", "quittiert", "bestätigt", "bestätigen", "erledigt", "done",
  "👍", "✅", "👌"
]);
const BOT_STATE_KEY = "bot_state:v1";
const BOT_STATE_TTL_SECONDS = 24 * 3600;   // Dialog-Kontext lebt max. 24h
const BOT_MAX_HISTORY = 24;                // gespeicherte Chat-Nachrichten (user+bot)
const BOT_MAX_LLM_ROUNDS = 6;              // Tool-Loop-Deckel pro Webhook-Aufruf
// Haiku statt Opus: ~1/5 der Kosten (~2–5 Cent pro kompletter Trade-Eintragung).
// Roberts explizite Wahl (Aug 2026). Falls das Verstehen mal zu schwach wird:
// hier auf "claude-opus-5" zurückstellen und Worker neu deployen.
const CLAUDE_MODEL = "claude-haiku-4-5";

async function botLoadState(env) {
  try { return (await env.TRADEBOOK_CACHE.get(BOT_STATE_KEY, { type: "json" })) || { history: [], draft: null, watchDraft: null, phase: "collecting" }; }
  catch { return { history: [], draft: null, watchDraft: null, phase: "collecting" }; }
}
async function botSaveState(env, state) {
  state.history = (state.history || []).slice(-BOT_MAX_HISTORY);
  try { await env.TRADEBOOK_CACHE.put(BOT_STATE_KEY, JSON.stringify(state), { expirationTtl: BOT_STATE_TTL_SECONDS }); } catch {}
}
async function botClearState(env) {
  try { await env.TRADEBOOK_CACHE.delete(BOT_STATE_KEY); } catch {}
}

// Yahoo-Symbolsuche: fehlertolerant auch bei Diktier-Verschreibern. Liefert
// die Kandidaten-Listings inkl. Börse, damit Claude die Heimbörse wählen kann.
async function botSearchSymbol(query) {
  const u = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true`;
  const r = await fetch(u, { headers: { "User-Agent": YH_UA, "Accept": "application/json" } });
  if (!r.ok) return { error: "yahoo search http " + r.status };
  const j = await r.json();
  const quotes = (j.quotes || []).filter(q => q.symbol && (q.quoteType === "EQUITY" || q.quoteType === "ETF"));
  return {
    results: quotes.map(q => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || null,
      exchange: q.exchDisp || q.exchange || null,
      type: q.quoteType
    }))
  };
}

// Live-Kurs für Plausibilitätsprüfungen (Einstand vs. aktueller Kurs, Schwellen-Logik)
async function botGetQuote(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`, { headers: { "User-Agent": "Mozilla/5.0 PairTradeTracker" } });
    if (!r.ok) return { error: "yahoo http " + r.status };
    const m = (await r.json())?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return { error: "no price for " + symbol };
    return { symbol, price: m.regularMarketPrice, currency: m.currency || null, exchange: m.exchangeName || null };
  } catch (e) { return { error: e.message }; }
}

// Draft-Felder-Schema für emit_action (strict) — alle Felder Pflicht im Schema,
// fehlende Infos als null. entryCurrency null = native Währung der Heimbörse
// (Roberts Default), sonst expliziter Ccy-Code wenn er eine andere nennt.
const BOT_DRAFT_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    type:          { type: ["string", "null"], description: "pair | long | short" },
    name:          { type: ["string", "null"] },
    longTicker:    { type: ["string", "null"] },
    shortTicker:   { type: ["string", "null"] },
    longQty:       { type: ["number", "null"] },
    longEntry:     { type: ["number", "null"] },
    shortQty:      { type: ["number", "null"] },
    shortEntry:    { type: ["number", "null"] },
    entryCurrency: { type: ["string", "null"], description: "null = Notierungswährung der Börse (Default). Nur setzen wenn der User explizit eine andere Währung nennt." },
    lossPct:       { type: ["number", "null"], description: "Verlust-Schwelle in % (positive Zahl)" },
    lossPrice:     { type: ["number", "null"], description: "Verlust-Schwelle als Kurs (nur long/short)" },
    profitPct:     { type: ["number", "null"] },
    profitPrice:   { type: ["number", "null"] },
    squeezePct:    { type: ["number", "null"], description: "Short-Squeeze-Schwelle in % (nur short/pair)" },
    longTarget:    { type: ["number", "null"], description: "Zielkurs Long (stille Markierung)" },
    shortTarget:   { type: ["number", "null"] }
  },
  required: ["type", "name", "longTicker", "shortTicker", "longQty", "longEntry", "shortQty", "shortEntry", "entryCurrency", "lossPct", "lossPrice", "profitPct", "profitPrice", "squeezePct", "longTarget", "shortTarget"]
};

// Watchlist-Entwurf für emit_action: Kandidat mit Kurs-Grenzen. remove=true
// löscht den Eintrag mit diesem Ticker (nach Bestätigung).
const BOT_WATCH_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    ticker:     { type: ["string", "null"] },
    name:       { type: ["string", "null"] },
    side:       { type: ["string", "null"], description: "long | short — Kandidat-Typ, Pflicht" },
    levelAbove: { type: ["number", "null"], description: "Überschreitungsgrenze (Kurs ≥), in Notierungswährung des Tickers" },
    levelBelow: { type: ["number", "null"], description: "Unterschreitungsgrenze (Kurs ≤)" },
    remove:     { type: ["boolean", "null"], description: "true = Eintrag mit diesem Ticker von der Watchlist löschen" }
  }
};

const BOT_TOOLS = [
  {
    name: "search_symbol",
    description: "Sucht Aktien/ETFs bei Yahoo Finance per Firmenname oder Ticker (fehlertolerant). Liefert Kandidaten mit Symbol, Name und Börse.",
    input_schema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "get_quote",
    description: "Holt aktuellen Kurs, Währung und Börse für ein Yahoo-Symbol. Nur nutzen wenn Robert nach Kursen/Status fragt — NICHT zur Kontrolle seiner Angaben.",
    input_schema: { type: "object", additionalProperties: false, properties: { symbol: { type: "string" } }, required: ["symbol"] }
  },
  {
    name: "emit_action",
    description: "MUSS als letzter Schritt jeder Antwort aufgerufen werden. Beendet den Zug mit genau einer Aktion Richtung User. Alle draft-Felder immer mitgeben, unbekannte als null.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["ask", "propose", "save", "cancel", "ack_alarms", "reply"] },
        text: { type: "string", description: "Nachricht an den User. Bei propose: die vollständige Zusammenfassung aller Felder plus Hinweis, mit 'ok' zu bestätigen oder Änderungen zu nennen." },
        draft: BOT_DRAFT_SCHEMA,
        watch: BOT_WATCH_SCHEMA
      },
      required: ["action", "text", "draft"]
    }
  }
];

// Pflichtfeld-Validierung, worker-seitig — Claude darf 'propose'/'save' nur mit
// vollständigem Draft; sonst wird der Fehler in den Tool-Loop zurückgespielt
// und Claude fragt stattdessen nach.
function botValidateDraft(d) {
  const missing = [];
  if (!d || typeof d !== "object") return ["kompletter Draft"];
  const t = d.type;
  if (t !== "pair" && t !== "long" && t !== "short") missing.push("type (pair/long/short)");
  const needLong = t === "pair" || t === "long";
  const needShort = t === "pair" || t === "short";
  if (needLong) {
    if (!d.longTicker) missing.push("longTicker");
    if (!(d.longQty > 0)) missing.push("longQty");
    if (!(d.longEntry > 0)) missing.push("longEntry");
  }
  if (needShort) {
    if (!d.shortTicker) missing.push("shortTicker");
    if (!(d.shortQty > 0)) missing.push("shortQty");
    if (!(d.shortEntry > 0)) missing.push("shortEntry");
  }
  return missing;
}

// Watchlist-Entwurf validieren (worker-seitig, analog botValidateDraft).
function botValidateWatch(w) {
  const missing = [];
  if (!w || typeof w !== "object") return ["kompletter Watchlist-Entwurf"];
  if (!w.ticker) missing.push("ticker");
  if (w.remove) return missing; // Löschen braucht nur den Ticker
  if (w.side !== "long" && w.side !== "short") missing.push("side (long/short)");
  if (w.levelAbove == null && w.levelBelow == null) missing.push("mindestens eine Grenze (levelAbove/levelBelow)");
  return missing;
}

// Watchlist-Eintrag anlegen/aktualisieren/löschen. Gleicher Ticker = Update
// (geänderte Grenzen re-armen ihre Alarm-Achse), remove=true = löschen.
async function botSaveWatch(env, w) {
  const now = Date.now();
  const fresh = (await loadTradebook(env)).data || {};
  const list = Array.isArray(fresh.watchlist) ? fresh.watchlist : [];
  const wStates = fresh.watchStates || {};
  const tick = String(w.ticker).toUpperCase();
  const existing = list.find(x => (x.ticker || "").toUpperCase() === tick);
  let info;
  if (w.remove) {
    if (!existing) return { notFound: true };
    fresh.watchlist = list.filter(x => x !== existing);
    if (wStates[existing.id]) delete wStates[existing.id];
    info = { removed: true };
  } else if (existing) {
    const st = ensureWatchShape(wStates[existing.id]);
    if (w.levelAbove != null && String(existing.levelAbove ?? "") !== String(w.levelAbove)) st.above = { state: "idle", lastAlertAt: 0 };
    if (w.levelBelow != null && String(existing.levelBelow ?? "") !== String(w.levelBelow)) st.below = { state: "idle", lastAlertAt: 0 };
    wStates[existing.id] = st;
    if (w.levelAbove != null) existing.levelAbove = w.levelAbove;
    if (w.levelBelow != null) existing.levelBelow = w.levelBelow;
    if (w.side === "long" || w.side === "short") existing.side = w.side;
    if (w.name) existing.name = w.name;
    existing.updated = now;
    fresh.watchlist = list;
    info = { updated: true };
  } else {
    list.push({ id: "w_" + now + "_" + Math.floor(Math.random() * 10000), ticker: tick, name: w.name || null, side: w.side, levelAbove: w.levelAbove ?? null, levelBelow: w.levelBelow ?? null, created: now, updated: now });
    fresh.watchlist = list;
    info = { created: true };
  }
  fresh.watchStates = wStates;
  fresh.lastModified = now;
  await saveTradebook(env, fresh);
  return info;
}

function botWatchResultText(info) {
  if (info.notFound) return "⚠️ Kein Watchlist-Eintrag mit diesem Ticker gefunden.";
  if (info.removed) return "🗑 Watchlist-Eintrag gelöscht — verschwindet beim nächsten Sync aus der App.";
  if (info.updated) return "✅ Watchlist-Eintrag aktualisiert — geänderte Grenzen sind wieder scharf.";
  return "✅ Auf die Watchlist gesetzt — erscheint beim nächsten Sync in der App.";
}

// Baut aus dem bestätigten Draft einen Trade im App-Datenmodell und schreibt ihn
// ins Tradebook. Existiert bereits ein Standalone-Trade mit gleichem Ticker+Typ,
// wird stattdessen eine Tranche angehängt (Super-Trade-Konvention der App:
// Schwellen/Ziele nur übernehmen wenn der bestehende Trade dort leer ist).
async function botSaveTrade(env, draft) {
  const now = Date.now();
  const t = draft.type;
  const needLong = t === "pair" || t === "long";
  const needShort = t === "pair" || t === "short";
  const entryNative = draft.entryCurrency == null;
  const entryCcy = entryNative ? null : String(draft.entryCurrency).toUpperCase();
  const tranche = {
    id: "tr_" + now + "_" + Math.floor(Math.random() * 10000),
    longQty: needLong ? draft.longQty : 0,
    longEntry: needLong ? draft.longEntry : 0,
    longEntryNative: needLong ? entryNative : false,
    longEntryCcy: needLong ? entryCcy : null,
    shortQty: needShort ? draft.shortQty : 0,
    shortEntry: needShort ? draft.shortEntry : 0,
    shortEntryNative: needShort ? entryNative : false,
    shortEntryCcy: needShort ? entryCcy : null,
    created: now
  };
  const lossPct = draft.lossPct != null ? -Math.abs(draft.lossPct) : null;
  const profitPct = draft.profitPct != null ? Math.abs(draft.profitPct) : null;
  const minMode = (t !== "pair" && draft.lossPrice != null && draft.lossPct == null) ? "price" : "pct";
  const maxMode = (t !== "pair" && draft.profitPrice != null && draft.profitPct == null) ? "price" : "pct";
  const squeeze = (t === "short" || t === "pair") && draft.squeezePct != null ? Math.abs(draft.squeezePct) : null;

  const fresh = (await loadTradebook(env)).data || {};
  const trades = Array.isArray(fresh.trades) ? fresh.trades : [];
  let matching = null;
  if (t === "long")  matching = trades.find(x => tradeType(x) === "long"  && x.longTicker === draft.longTicker && !x.basketId);
  if (t === "short") matching = trades.find(x => tradeType(x) === "short" && x.shortTicker === draft.shortTicker && !x.basketId);
  if (t === "pair")  matching = trades.find(x => tradeType(x) === "pair"  && x.longTicker === draft.longTicker && x.shortTicker === draft.shortTicker);

  let resultInfo;
  if (matching) {
    matching.tranches = (Array.isArray(matching.tranches) ? matching.tranches : []).concat([tranche]);
    const hasMin = (matching.alertPctMin != null && matching.alertPctMin !== "") || (matching.alertPriceMin != null && matching.alertPriceMin !== "");
    const hasMax = (matching.alertPctMax != null && matching.alertPctMax !== "") || (matching.alertPriceMax != null && matching.alertPriceMax !== "");
    if (!hasMin && (lossPct != null || draft.lossPrice != null)) { matching.alertPctMin = lossPct; matching.alertPriceMin = draft.lossPrice ?? null; matching.alertMinMode = minMode; }
    if (!hasMax && (profitPct != null || draft.profitPrice != null)) { matching.alertPctMax = profitPct; matching.alertPriceMax = draft.profitPrice ?? null; matching.alertMaxMode = maxMode; }
    if (squeeze != null && (matching.alertShortPct == null || matching.alertShortPct === "")) matching.alertShortPct = squeeze;
    if (draft.longTarget != null && matching.longTarget == null) matching.longTarget = draft.longTarget;
    if (draft.shortTarget != null && matching.shortTarget == null) matching.shortTarget = draft.shortTarget;
    matching.updated = now;
    resultInfo = { merged: true, trancheCount: matching.tranches.length };
  } else {
    trades.push({
      id: "t_" + now + "_" + Math.floor(Math.random() * 10000),
      type: t, name: draft.name || null, basketId: null,
      longTicker: needLong ? draft.longTicker : null,
      shortTicker: needShort ? draft.shortTicker : null,
      longBetaOverride: null, shortBetaOverride: null,
      longTarget: needLong ? (draft.longTarget ?? null) : null,
      shortTarget: needShort ? (draft.shortTarget ?? null) : null,
      alertPctMin: lossPct, alertPctMax: profitPct,
      alertPriceMin: (t !== "pair") ? (draft.lossPrice ?? null) : null,
      alertPriceMax: (t !== "pair") ? (draft.profitPrice ?? null) : null,
      alertMinMode: minMode, alertMaxMode: maxMode,
      alertShortPct: squeeze,
      created: now, updated: now,
      tranches: [tranche]
    });
    resultInfo = { merged: false };
  }
  fresh.trades = trades;
  fresh.lastModified = now;
  await saveTradebook(env, fresh);
  return resultInfo;
}

function botSystemPrompt(record, state) {
  const tradesCompact = (record.trades || []).map(tr => {
    const ty = tradeType(tr);
    const tick = ty === "long" ? tr.longTicker : ty === "short" ? tr.shortTicker : (tr.longTicker + "/" + tr.shortTicker);
    return `- ${tr.name || tick} [${ty}] ${tick}${tr.basketId ? " (im Korb)" : ""}`;
  }).join("\n") || "- (keine)";
  const alarms = listActiveAlarms(record);
  const alarmsCompact = alarms.length ? alarms.map(a => `- ${a.name}: ${a.kind}`).join("\n") : "- (keine)";
  const watchCompact = (Array.isArray(record.watchlist) ? record.watchlist : []).map(w =>
    `- ${w.name || w.ticker} [${w.side}] ${w.ticker}${w.levelAbove != null ? " ≥" + w.levelAbove : ""}${w.levelBelow != null ? " ≤" + w.levelBelow : ""}`
  ).join("\n") || "- (leer)";
  return `Du bist der Telegram-Assistent von Roberts "Pair Trade Tracker" (private Trading-App). Robert diktiert dir Trades in freiem Deutsch (Diktier-Verschreiber sind normal — interpretiere wohlwollend). Deine Aufgabe: alle Angaben einsammeln, dann eintragen lassen.

REGELN FÜR TICKER UND BÖRSE:
- Firmennamen per search_symbol auflösen. Default ist IMMER der Ticker der HEIMBÖRSE des Unternehmens (deutsches Unternehmen → Xetra/.DE, UK → .L, Frankreich → .PA, Niederlande → .AS, Schweiz → .SW, Italien → .MI, Spanien → .MC, US → NYSE/NASDAQ-Listing ohne Suffix). Nur wenn Robert explizit eine andere Börse nennt, diese nehmen.
- Bei Mehrdeutigkeit (mehrere plausible Unternehmen) kurz nachfragen mit nummerierten Optionen — nie raten.
- entryCurrency bleibt null (= Notierungswährung der Heimbörse, Roberts Default), außer Robert nennt explizit eine andere Währung.

REGELN FÜR ZAHLEN:
- Zahlen NIE raten, ändern oder anzweifeln. Robert trägt oft HISTORISCHE Einstände ein — die dürfen beliebig weit vom aktuellen Kurs entfernt sein. KEINE Plausibilitäts-Rückfragen zu Zahlen, keine Kontroll-Kursabfragen: die Zusammenfassung vor dem Eintragen ist das Korrektur-Netz, das reicht.
- Bei fehlenden Pflichtangaben so lange nachfragen, bis Robert eine konkrete Antwort gibt — freundlich hartnäckig, eine gezielte Frage pro Nachricht. Es gibt nur zwei Ausgänge: vollständiger Eintrag oder Abbruch (cancel nur wenn Robert explizit abbrechen will).
- get_quote nur nutzen, wenn Robert selbst nach Kursen oder Status fragt — nicht zur Kontrolle seiner Angaben.

PFLICHTFELDER: type (pair/long/short); je nach Typ Ticker, Stückzahl und Einstandskurs pro Leg. Optional (nicht nachbohren, nur aufnehmen wenn genannt): Verlust-/Gewinn-Schwelle (% oder Kurs; bei Pair nur %), Squeeze-Schwelle (nur short/pair), Zielkurs, Name.

WATCHLIST (zweiter Eintrags-Typ neben Trades):
- Robert kann Kandidaten beobachten lassen: "setz X auf die Watchlist", "beobachte X als Short-Kandidat, meld dich bei 250" o.ä. → gleicher Ablauf wie bei Trades, aber mit dem watch-Feld von emit_action statt draft.
- Pflicht: ticker (Heimbörsen-Regel wie oben), side (long/short — wenn unklar, nachfragen) und MINDESTENS eine Grenze: levelAbove (Meldung bei Kurs ≥) und/oder levelBelow (Meldung bei Kurs ≤), in der Notierungswährung des Tickers. Beide Grenzen zusammen = Korridor.
- Die Meldung beim Kreuzen ist einmalig (kein Repeat, re-armt automatisch) — das kannst du in der Zusammenfassung kurz erwähnen.
- Gleicher Ticker schon auf der Watchlist → propose als Update (nur genannte Felder ändern sich). Löschen ("nimm X von der Watchlist") → watch mit ticker + remove:true, ebenfalls erst propose ("Eintrag X löschen — ok?"), dann save.

ABLAUF:
1. Solange Pflichtangaben fehlen → action "ask".
2. Alles da → action "propose": vollständige Zusammenfassung ALLER Felder (Typ, Ticker+Börse, Stückzahl, Einstand+Währung, alle Schwellen, Zielkurs) + Hinweis: mit "ok" bestätigen oder Änderungen nennen.
3. Robert bestätigt ("ok", "ja", "passt", "go" o.ä.) NACH einer Zusammenfassung → action "save" (der Worker trägt den gespeicherten Draft ein — nichts mehr ändern).
4. Robert will nach der Zusammenfassung etwas ändern → Änderung in den Draft einarbeiten → erneut "propose" mit neuer kompletter Zusammenfassung.
5. Robert will abbrechen → action "cancel".
6. Nachricht ist eine Alarm-Quittierung (kurze Bestätigung während aktive Alarme laufen und KEINE Zusammenfassung aussteht, oder Worte wie "quittiert") → action "ack_alarms".
7. Alles andere (Statusfrage, Smalltalk) → action "reply" (Statusfragen zu Kursen per get_quote beantworten).

WICHTIG: Beende JEDE Antwort mit genau einem emit_action-Aufruf. Bei "ask"/"propose" immer den aktuellen Draft-Zwischenstand mitgeben (bekannte Felder gefüllt, Rest null). Antworte auf ${record.lang === "en" ? "Englisch" : "Deutsch"}, kompakt und ohne Floskeln (Telegram-Chat).

AKTUELLER DIALOG-STATUS: phase=${state.phase}${state.draft ? ", gespeicherter Trade-Draft: " + JSON.stringify(state.draft) : ""}${state.watchDraft ? ", gespeicherter Watch-Draft: " + JSON.stringify(state.watchDraft) : ""}${!state.draft && !state.watchDraft ? ", kein Draft" : ""}

BESTEHENDE TRADES (für Kontext/Statusfragen; gleicher Ticker+Typ wird beim Eintragen automatisch als Tranche zusammengeführt):
${tradesCompact}

WATCHLIST AKTUELL:
${watchCompact}

AKTIVE ALARME:
${alarmsCompact}`;
}

async function claudeCall(env, system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system,
      messages,
      tools: BOT_TOOLS
    })
  });
  if (!r.ok) throw new Error("anthropic http " + r.status + ": " + (await r.text()).slice(0, 400));
  return r.json();
}

// Kern des Bot-Dialogs: ein User-Text rein, genau eine Telegram-Antwort raus.
// Tool-Loop: Claude darf search_symbol/get_quote mehrfach nutzen und MUSS mit
// emit_action enden. propose/save werden worker-seitig validiert; bei Lücken
// wird der Fehler in den Loop zurückgespielt (Claude fragt dann nach).
async function botProcessMessage(env, userText, opts = {}) {
  const { data: record } = await loadTradebook(env);
  const state = await botLoadState(env);
  const system = botSystemPrompt(record, state);
  const messages = [...(state.history || []), { role: "user", content: userText }];
  let replyText = null;

  for (let round = 0; round < BOT_MAX_LLM_ROUNDS; round++) {
    const resp = await claudeCall(env, system, messages);
    if (resp.stop_reason === "refusal") { replyText = "⚠️ Anfrage konnte nicht verarbeitet werden — bitte anders formulieren."; break; }
    if (resp.stop_reason !== "tool_use") {
      // Modell hat ohne emit_action geantwortet → Text übernehmen als Fallback
      replyText = (resp.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "…";
      break;
    }
    const toolResults = [];
    let terminal = null;
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "search_symbol") {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(await botSearchSymbol(block.input.query)) });
      } else if (block.name === "get_quote") {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(await botGetQuote(block.input.symbol)) });
      } else if (block.name === "emit_action") {
        const a = block.input;
        if (a.action === "propose") {
          // Zwei Entwurfs-Typen: Trade (draft) oder Watchlist-Eintrag (watch)
          if (a.watch && a.watch.ticker) {
            const missing = botValidateWatch(a.watch);
            if (missing.length) {
              toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Watchlist-Entwurf unvollständig — fehlend: " + missing.join(", ") + ". Frage stattdessen nach (action: ask)." });
              continue;
            }
            state.watchDraft = a.watch; state.draft = null; state.phase = "awaiting_confirm";
            terminal = a.text;
          } else {
            const missing = botValidateDraft(a.draft);
            if (missing.length) {
              toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Draft unvollständig — fehlende Pflichtfelder: " + missing.join(", ") + ". Frage stattdessen nach (action: ask)." });
              continue;
            }
            state.draft = a.draft; state.watchDraft = null; state.phase = "awaiting_confirm";
            terminal = a.text;
          }
        } else if (a.action === "save") {
          if (state.phase !== "awaiting_confirm" || (!state.draft && !state.watchDraft)) {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Es liegt keine bestätigte Zusammenfassung vor. Erst propose mit vollständigem Entwurf, dann auf Bestätigung warten." });
            continue;
          }
          // Eintragen — es gilt der GESPEICHERTE Entwurf (der zuletzt zusammengefasste Stand)
          try {
            let doneText;
            if (state.watchDraft) {
              doneText = botWatchResultText(await botSaveWatch(env, state.watchDraft));
            } else {
              const info = await botSaveTrade(env, state.draft);
              const suffix = info.merged ? `\n(Als Tranche ${info.trancheCount} zu bestehendem Trade zusammengeführt.)` : "";
              doneText = "✅ Eingetragen — erscheint beim nächsten Sync in der App." + suffix;
            }
            state.draft = null; state.watchDraft = null; state.phase = "collecting"; state.history = [];
            await botSaveState(env, state);
            terminal = doneText + (a.text && a.text !== "✅" ? "\n" + a.text : "");
          } catch (e) {
            terminal = "❌ Eintragen fehlgeschlagen: " + e.message + "\nDer Entwurf bleibt erhalten — nochmal 'ok' senden zum erneuten Versuch.";
          }
        } else if (a.action === "cancel") {
          await botClearState(env);
          state.draft = null; state.watchDraft = null; state.phase = "collecting"; state.history = [];
          terminal = a.text || "Abgebrochen — nichts eingetragen.";
        } else if (a.action === "ack_alarms") {
          const n = await ackAllActiveAlarms(env, record);
          terminal = n > 0 ? workerT(record.lang || "de", "ack_received") : (a.text || "Keine aktiven Alarme.");
        } else { // ask | reply
          if (a.action === "ask" && a.draft) state.draft = a.draft;
          if (a.action === "ask") state.phase = "collecting";
          terminal = a.text;
        }
      }
    }
    if (terminal != null) { replyText = terminal; break; }
    // Loop fortsetzen: Assistant-Content + Tool-Results anhängen
    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });
  }

  if (replyText == null) replyText = "⚠️ Zu viele Verarbeitungsschritte — bitte die Angabe kompakter formulieren.";
  // Verlauf fortschreiben (nur Text-Ebene, Tool-Zwischenschritte bleiben ephemer)
  state.history = [...(state.history || []), { role: "user", content: userText }, { role: "assistant", content: replyText }];
  await botSaveState(env, state);
  if (!opts.dryRun) await sendTelegram(env, replyText);
  return replyText;
}

async function handleTelegramWebhook(req, env, ctx) {
  let update; try { update = await req.json(); } catch { return textResponse("bad json", 400); }
  const m = update.message;
  if (!m || !m.chat || String(m.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return textResponse("ignored");

  // Bot-Dialog nur mit konfiguriertem ANTHROPIC_API_KEY + Text-Nachricht.
  // Verarbeitung async via waitUntil — Telegram will schnell ein 200 sehen.
  if (env.ANTHROPIC_API_KEY && typeof m.text === "string" && m.text.trim()) {
    const text = m.text.trim();
    ctx.waitUntil((async () => {
      try {
        // Kosten-Kurzschluss: eindeutige Kurz-Bestätigungen brauchen kein Claude.
        // 1. Zusammenfassung steht aus + "ok" → Draft deterministisch eintragen.
        // 2. Kein Dialog aktiv + aktive Alarme + "ok" → Alarme quittieren.
        // Alles andere (inkl. "ja" als Antwort auf eine Bot-Frage) geht an Claude.
        const normed = text.toLowerCase().replace(/[\s!.,:;()]+/g, "");
        if (BOT_ACK_WORDS.has(normed)) {
          const state = await botLoadState(env);
          const { data: record } = await loadTradebook(env);
          if (state.phase === "awaiting_confirm" && (state.draft || state.watchDraft)) {
            try {
              let doneText;
              if (state.watchDraft) {
                doneText = botWatchResultText(await botSaveWatch(env, state.watchDraft));
              } else {
                const info = await botSaveTrade(env, state.draft);
                const suffix = info.merged ? `\n(Als Tranche ${info.trancheCount} zu bestehendem Trade zusammengeführt.)` : "";
                doneText = "✅ Eingetragen — erscheint beim nächsten Sync in der App." + suffix;
              }
              await botClearState(env);
              await sendTelegram(env, doneText);
            } catch (e2) {
              await sendTelegram(env, "❌ Eintragen fehlgeschlagen: " + e2.message + "\nDer Entwurf bleibt erhalten — nochmal 'ok' senden zum erneuten Versuch.");
            }
            return;
          }
          const dialogActive = (state.history && state.history.length > 0) || state.draft || state.watchDraft;
          if (!dialogActive && listActiveAlarms(record).length > 0) {
            await ackAllActiveAlarms(env, record);
            await sendTelegram(env, workerT(record.lang || "de", "ack_received"));
            return;
          }
          // weder ausstehende Zusammenfassung noch Alarm-Kontext → normal weiterreichen
        }
        await botProcessMessage(env, text);
      } catch (e) {
        // Claude/API nicht erreichbar → Alarm-Quittierung darf NIE davon abhängen:
        // Fallback auf Legacy-Verhalten (alles quittieren) wenn Alarme aktiv sind.
        console.error("bot error:", e.message);
        try {
          const { data: record } = await loadTradebook(env);
          const n = await ackAllActiveAlarms(env, record);
          const note = "⚠️ Bot momentan nicht erreichbar (" + e.message.slice(0, 300) + ")";
          await sendTelegram(env, n > 0 ? workerT(record.lang || "de", "ack_received") + "\n" + note : note);
        } catch {}
      }
    })());
    return textResponse("ok");
  }

  // Legacy-Pfad (kein API-Key): jede Antwort quittiert alle aktiven Alarme
  let record, lang = "de";
  try { const r = await loadTradebook(env); record = r.data; lang = record.lang || "de"; } catch { await sendTelegram(env, workerT(lang, "ack_received")); return textResponse("ok (no record)"); }
  await ackAllActiveAlarms(env, record);
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
      return textResponse("Pair Trade Tracker Worker — endpoints: /?symbol=, /profile?symbol=, /check, /check-squeeze, /test-alert, /setup-webhook, /telegram-webhook, /tradebook (GET+POST), /migrate-from-jsonbin (POST), /bot-test (POST)");
    }
    if (url.pathname === "/profile") {
      const s = url.searchParams.get("symbol");
      if (!s) return jsonResponse({ error: "missing symbol" }, 400);
      return handleProfile(s, env);
    }
    if (url.pathname === "/check") { try { return jsonResponse(await runAlarmCheck(env)); } catch (e) { return jsonResponse({ ok: false, error: e.message }, 500); } }
    if (url.pathname === "/check-squeeze") { try { return jsonResponse(await runShortSqueezeCheck(env)); } catch (e) { return jsonResponse({ ok: false, error: e.message }, 500); } }
    if (url.pathname === "/test-alert") return textResponse(await sendTestAlert(env));
    if (url.pathname === "/setup-webhook") return setupWebhook(req, env);
    if (url.pathname === "/telegram-webhook" && req.method === "POST") return handleTelegramWebhook(req, env, ctx);
    // Bot-Dialog testen ohne Telegram (Bearer SYNC_SECRET): POST /bot-test {"text": "..."}
    // Antwort kommt als HTTP-Response zurück statt als Telegram-Nachricht (dry-run).
    if (url.pathname === "/bot-test" && req.method === "POST") {
      const auth = checkSyncAuth(req, env);
      if (!auth.ok) return jsonResponse({ error: auth.msg }, 401);
      if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 400);
      let body; try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
      if (!body || typeof body.text !== "string" || !body.text.trim()) return jsonResponse({ error: "missing text" }, 400);
      try { return jsonResponse({ reply: await botProcessMessage(env, body.text.trim(), { dryRun: true }) }); }
      catch (e) { return jsonResponse({ error: e.message }, 500); }
    }
    // Sync-Endpoints für Frontend (ersetzt direkten JSONBin-Zugriff, seit Mai 2026)
    if (url.pathname === "/tradebook" && req.method === "GET")  return handleTradebookGet(req, env);
    if (url.pathname === "/tradebook" && req.method === "POST") return handleTradebookPost(req, env);
    if (url.pathname === "/migrate-from-jsonbin" && req.method === "POST") return handleMigrateFromJsonbin(req, env);
    return textResponse("not found", 404);
  },
  // Mehrere Cron-Trigger im Cloudflare-Dashboard: "*/3 * * * *" für Loss/Profit,
  // beliebige Tages-Cron (z.B. "0 17 * * *") für Short-Squeeze. Wir matchen den
  // Fast-Cron explizit über das "*/3"-Präfix und behandeln alles andere als Squeeze.
  // Vorteil: die Squeeze-Cron-Zeit kann im Dashboard frei geändert werden.
  async scheduled(event, env, ctx) {
    const cronStr = (event && event.cron) ? String(event.cron) : "";
    if (isFastCron(cronStr)) {
      // Market-Hours-Gate: Cron läuft 24/7, aber Loss/Profit-Alarme prüfen wir nur
      // wenn irgendein relevanter Markt offen sein KÖNNTE (Mo-Fr 09:00-23:00 Berlin).
      // Außerhalb passieren keine Kursbewegungen → Yahoo-Call wäre Verschwendung.
      // Override mit env-flag RUN_24_7=1 (für Debug/Testing).
      if (env.RUN_24_7 !== "1" && !isWithinTradingHours()) {
        console.log("scheduled: outside trading hours, skipping alarm check");
        return;
      }
      ctx.waitUntil(runAlarmCheck(env).catch(e => console.error("cron error:", e)));
    } else {
      // Squeeze-Cron läuft täglich (z.B. 06:00 UTC) — kein Gating, Snapshot ist
      // Hintergrund-Daten und muss auch am Wochenende einmal refreshen.
      ctx.waitUntil(runShortSqueezeCheck(env).catch(e => console.error("squeeze cron error:", e)));
    }
  }
};
