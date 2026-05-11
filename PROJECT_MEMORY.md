# Pair Trade Tracker — Project Memory

> Zweck: schnelles Onboarding für jede neue Claude-Session, ohne dass der Code komplett gelesen werden muss. Enthält die Architektur, Design-Entscheidungen, Konventionen und die nicht-offensichtlichen Stellen.

---

## Was die App tut

Persönlicher Tracker für Long/Short-Aktien-Pair-Trades, der Total-P&L (in EUR absolut und Prozent) anzeigt — etwas das die meisten Broker so nicht bieten. Single-User-Tool für Robert, deployed als PWA (iPhone Homescreen + Mac Dock).

Kern-Features:

- Manuelle Trade-Eingabe (zwei Tickers + Quantity + Entry-Preise pro Leg)
- Live-Kurs-Updates über Yahoo Finance (via eigenen Cloudflare-Worker-Proxy)
- Multi-Currency mit pfadunabhängiger Einstands-Währung pro Leg
- **Super-Trades:** Automatisches Mergen von Aufstockungen (gleicher Long/Short-Ticker) zu Tranchen mit aggregierter Performance
- Cloud-Sync zwischen iPhone und Mac über JSONBin
- Stop-Loss-artige Alarme mit Telegram-Bot ("Haus-Alarm"-Verhalten: alle 3 Min repeat bis quittiert)
- 4 Sprachen (DE, EN, IT, RU) — Sprache geräteabhängig
- Auto-Refresh jede Minute wenn App im Foreground während Handelszeit (Mo-Fr, 09:00-22:55 Berlin)
- Bloomberg-style Price-Flash-Animationen (grün/rot Hintergrund-Flash bei Kursänderung)

---

## Komponenten und wo sie leben

| Komponente | Wo | Was sie macht |
|---|---|---|
| `index.html` | Netlify (deployed) + GitHub-Repo (source) | Single-File PWA, alles drin (HTML + CSS + JS) |
| `cloudflare-worker.js` | Cloudflare Worker (deployed) + GitHub-Repo (source) | Yahoo-Proxy, Cron-Alarm-Engine, Telegram-Webhook |
| JSONBin.io | extern (Free Tier) | Cloud-Sync-Storage (Trades, AlertStates, Sprache) |
| Telegram-Bot | extern | Empfängt Alarm-Nachrichten, sendet Ack |

Deployment: GitHub → Netlify (auto-deploy für HTML), Cloudflare-Dashboard (manuelles Paste für Worker).

---

## Datenmodell (was in JSONBin steht)

```json
{
  "trades": [
    {
      "id": "t_...",
      "name": "Optional Anzeigename",
      "longTicker": "AAPL",
      "shortTicker": "MSFT",
      "alertPctMin": -30,
      "tranches": [
        {
          "id": "tr_...",
          "longQty": 100,
          "longEntry": 150.50,
          "longEntryCcy": "EUR",
          "longEntryNative": false,
          "shortQty": 50,
          "shortEntry": 300.00,
          "shortEntryCcy": "EUR",
          "shortEntryNative": false,
          "created": 1715432000000
        }
      ],
      "created": 1715432000000,
      "updated": 1715432000000
    }
  ],
  "alertStates": {
    "<trade-id>": {
      "current": "idle" | "triggered" | "acknowledged",
      "lastAlertAt": <ms-timestamp>,
      "notifyCount": <number>
    }
  },
  "lastModified": <ms-timestamp>,
  "lang": "de" | "en" | "it" | "ru",
  "_device": "mobile"
}
```

**Wichtig:** Trade hat `longTicker`, `shortTicker`, `alertPctMin`, `tranches` auf Top-Level. Quantity, Entry, EntryCcy, EntryNative liegen pro Tranche im `tranches`-Array. Migration von alten flachen Trades (mit `longQty` etc. auf Top-Level) passiert in `migrateTrades()` beim ersten App-Start nach Update.

---

## Wichtige Design-Entscheidungen (das Warum)

### Super-Trade / Tranchen-Modell

Wenn der User einen neuen Trade speichert dessen `longTicker` + `shortTicker` exakt einem bestehenden Trade entsprechen, wird der neue als **zusätzliche Tranche** an den bestehenden gehängt (Auto-Merge ohne Nachfrage). Performance wird aggregiert: Total P&L = Σ aller Tranchen-P&Ls (in Heimat-Währung), Total Notional = Σ aller Tranchen-Notionals, Total % = P&L / Notional × 100.

Mathematisch äquivalent zu volume-weighted-average-entry — beide Formulierungen führen zum identischen Prozent-Wert. Der "Σ Notional / Σ P&L"-Ansatz ist im Code so implementiert weil leichter zu verifizieren.

**Alarm-Schwelle bei Merges:** Wenn der bestehende Super-Trade bereits eine Schwelle gesetzt hat, wird **niemals** durch eine neue Tranche überschrieben — auch wenn die neue Tranche eine eigene Schwelle mitbringt. Nur wenn der bestehende Trade keine Schwelle hatte und die neue eine setzt, übernimmt der Super-Trade die neue. Schwelle kann jederzeit manuell über die normale Edit-Funktion geändert werden. Im Edit-Form gibt's einen Hinweistext "Beim Aufstocken werden neue Tranchen-Schwellen nicht übernommen".

**Mixed-Currency-Tranchen:** Wenn Tranchen unterschiedliche Einstands-Währungen haben, wird auf Heimat-Währung (`HOME_CCY = EUR` im Worker, `homeCurrency` aus Settings im Frontend) aggregiert. Funktioniert weil jede Tranche ihren eigenen `longEntryCcy`/`shortEntryCcy` speichert (pfadunabhängig).

**Edit-Verhalten bei Multi-Tranche-Trades:** Edit-Form zeigt nur Name und Alarm-Schwelle (Ticker, Quantity, Entry sind disabled). Begründung: bei mehreren Tranchen ist nicht eindeutig welche Tranche editiert werden soll. Einzelne Tranchen können über die Tranchen-Detail-Ansicht gelöscht werden (Tap auf Trade-Card öffnet die Liste). Wenn die letzte Tranche eines Multi-Tranche-Trades gelöscht wird, wird der gesamte Trade gelöscht.

**Single-Tranche-Trades:** Verhalten identisch zur Pre-Super-Trade-Version. Edit-Form erlaubt alle Felder. Die Tranche-Detail-Ansicht wird nicht angezeigt (kein Tap-Toggle, kein Badge).

### Pfadunabhängige Einstands-Währung
Jede Tranche speichert ihre Entry-Currency **explizit** als `longEntryCcy` / `shortEntryCcy`. Wenn der User später die Heimat-Währung wechselt (z.B. EUR → CHF), bleiben die Entry-Preise korrekt interpretiert. Migration alter Daten: fehlende `*EntryCcy`-Felder werden zu "EUR" defaultet.

Das Flag `longEntryNative` / `shortEntryNative` erlaubt alternativ "verwende die API-Währung des Tickers" — z.B. wenn man bei AAPL in USD denkt statt in EUR.

### Sprache geräteabhängig (nicht synced)
Sprache wird nur lokal in `localStorage[LANG_KEY]` gespeichert, **nicht** aus dem JSONBin-Pull übernommen. Aber: beim Push schickt jedes Gerät seine Sprache mit (`lang`-Feld), damit der Worker weiß in welcher Sprache er Telegram-Nachrichten schicken soll. Trade-off: bei verschiedenen Sprachen auf iPhone/Mac gewinnt für Telegram-Alerts das Gerät das zuletzt gepusht hat. Bewusst akzeptiert.

Auto-Erkennung des Browser-Locales wurde entfernt — verwirrte mehr als sie half bei Single-User-Setup. Default ist DE, vier Optionen DE/EN/IT/RU.

### Alarm-State-Machine
Pro Trade gibt es einen State im JSONBin: `idle → triggered → acknowledged → idle`. Edge-triggered: Alarm feuert nur beim Übergang `idle → triggered`. Während `triggered` repeat alle 3 Min bis der User per Telegram-Reply quittiert → `acknowledged`. Reset zu `idle` erst wenn die Performance wieder über die Schwelle steigt — verhindert Re-Trigger-Spam wenn Kurs an der Grenze schwingt.

`ALERT_REPEAT_MS = 3 * 60 * 1000` im Worker. Cron-Schedule muss auf `*/3 * * * *` stehen.

### Handelszeit-Fenster
`TRADING_START_HOUR = 9`, `TRADING_END_HOUR = 23` (Berlin time, Mo-Fr). Deckt EU-Markt + US-Markt-Schluss ab. Außerhalb gibt's keine Alarm-Checks (Worker skipped, App stoppt Auto-Refresh). Bewusst breit gewählt — Telegram-Pings um 03:00 Uhr will keiner.

### Yahoo-Proxy ist transparenter Passthrough
Der Worker proxy't die rohe Yahoo-API-Response 1:1 — die App erwartet `data.chart.result[0].meta.regularMarketPrice` und nicht ein remapped Format. **Wichtig:** Wenn der Worker den Response remapped, bricht der Worker-Test in den App-Settings mit "Antwort unerwartet". Schon einmal passiert, beim Wiederaufbau drauf achten.

### Auto-Refresh nur im Foreground
`document.hidden`-Check verhindert Updates wenn Tab/App im Background. Spart Yahoo-API-Calls und Worker-Requests. Im Foreground 1-Min-Intervall. User-Erwartung: "wenn ich draufschaue, will ich die neuesten Daten".

---

## Worker-Endpoints

| Endpoint | Zweck |
|---|---|
| `GET /?symbol=AAPL` | Yahoo-Passthrough — used by App für Live-Preise und FX-Raten |
| `GET /check` | Manueller Alarm-Check (Cron ruft das gleiche intern auf) |
| `GET /test-alert` | Sendet Test-Telegram-Nachricht in aktueller Sprache |
| `GET /setup-webhook` | Registriert Worker-URL als Telegram-Webhook-Target |
| `POST /telegram-webhook` | Empfängt User-Replies → setzt alle triggered Alarme auf acknowledged |

Cron-Trigger im Cloudflare-Dashboard: `*/3 * * * *` (alle 3 Minuten).

Der Worker enthält Backward-Compat-Logik: `getTranches(trade)` erkennt ob ein Trade die neue (`tranches: [...]`) oder alte (flache `longQty` etc.) Struktur hat und synthetisiert für alte einen Single-Tranche. Damit bricht der Worker nicht, selbst wenn das HTML-Update noch nicht überall durchgelaufen ist.

---

## Cloudflare Worker — Required Secrets

In Cloudflare-Dashboard unter Worker → Settings → Variables (Secret type):

- `TELEGRAM_BOT_TOKEN` (vom BotFather)
- `TELEGRAM_CHAT_ID` (die Chat-ID zwischen Robert und seinem Bot)
- `JSONBIN_BIN_ID`
- `JSONBIN_KEY` (Master Key)

---

## localStorage-Keys in der App

- `pair_trade_tracker_v2` — Trades + AlertStates + lastModified (lokal-Cache)
- `pair_trade_sync_v1` — Sync-Credentials (JSONBin API-Key + Bin-ID + enabled-Flag)
- `pair_trade_price_v1` — Worker-URL und Home-Currency
- `pair_trade_lang_v1` — gewählte Sprache (geräteabhängig)

Bei Versions-Bumps: neue Keys vergeben (`_v3`), alte beim ersten Load migrieren.

---

## Bekannte Stolperfallen

1. **Decimal-Comma:** Inputs sind `type="text" inputmode="decimal"`, nicht `type="number"`. `parseDecimal()` akzeptiert sowohl "150,50" als auch "150.50". Niemals auf `type="number"` umstellen — das brach den User-Workflow weil iOS-Keyboard Komma-Eingabe nur eingeschränkt erlaubt.

2. **Cache zwischen Netlify und Cloudflare:** Beim Deploy einer neuen HTML kann der Mac noch eine alte Version sehen (Safari-Cache + Cloudflare-Edge-Cache). Workaround: in Safari Cache leeren und PWA aus Dock entfernen/neu hinzufügen.

3. **CORS-Proxys sind tot:** Frühere Versionen nutzten corsproxy.io / allorigins.win — beide nicht mehr verlässlich. Eigener Cloudflare-Worker ist die einzige stabile Lösung.

4. **Twelve Data deckt europäische Aktien nicht ab:** Yahoo Finance schon. Niemals zu Twelve Data zurückwechseln auch wenn es als "saubere" API klingt.

5. **PWA auf Mac:** Safari "Add to Dock" (macOS Sonoma 14+) gibt true-PWA-Verhalten. iOS-Shortcuts auf Mac sind ein Anti-Pattern.

6. **Migration bei Bestandstrades:** Beim ersten Laden nach dem Super-Trade-Update werden alte flache Trades automatisch in das `tranches: [{...}]`-Format migriert. Die Migration ist idempotent (re-running tut nichts). Wenn die migrierte Version per Sync zu JSONBin gepusht wurde, sehen iPhone und Mac die neue Struktur. Worker hat Backward-Compat falls noch eine flache Version durchrutscht.

7. **Auto-Merge bei identischen Tickern:** Wenn der User glaubt einen separaten Trade anzulegen, aber die Ticker identisch sind zu einem bestehenden — wird automatisch gemerged. Eine Alert-Box bestätigt mit "Aufstockung zu bestehendem Trade hinzugefügt (Tranche N)". Wenn der User das nicht will, muss er den vorherigen Trade umbenennen/löschen vor dem neuen.

---

## Internationalisierung

`STRINGS` ist ein zentrales Dictionary mit ~90 Keys × 4 Sprachen. `t(key, params)` für Lookups mit `{param}`-Interpolation. DOM-Elemente mit `data-i18n="key"` werden via `applyTranslations()` beim Sprachwechsel re-rendert.

Worker hat sein eigenes (kleineres) `WORKER_STRINGS`-Dictionary nur für Telegram-Nachrichten.

Beim Hinzufügen neuer UI-Strings: in alle 4 Sprachen einpflegen. DE als Fallback wenn ein Key in einer Sprache fehlt.

---

## Robert's Präferenzen

- Sehr ehrliches Feedback, kein Sugarcoating. Lieber Bug zugeben als rumeiern.
- Mag pragmatische Code-Erklärungen mit Trade-offs.
- Schreibt Deutsch, versteht aber EN-Begriffe in Code (Variablen, etc.).
- Setup ist: iPhone als primäres Mobile-Gerät, Mac als Desktop. Beide nutzen die selbe Netlify-URL (`rs-pair-tracker.netlify.app`).
- Telegram-Alarms muss zuverlässig sein — das ist der Hauptgrund für das ganze Setup, nicht nur die Live-Anzeige.

---

## Wenn du diese Datei in einer neuen Session liest

Du bist jetzt informiert genug um Änderungen vorzunehmen. Empfohlenes Vorgehen:

1. Den aktuellen Stand des Codes via WebFetch oder Upload anschauen
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (State-Machine, Pfadunabhängigkeit, Tranche-Modell, etc.) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: **beide** Seiten gleichzeitig updaten und testen
4. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk
