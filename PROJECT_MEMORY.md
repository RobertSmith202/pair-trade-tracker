# Pair Trade Tracker — Project Memory

> Zweck: schnelles Onboarding für jede neue Claude-Session, ohne dass der Code komplett gelesen werden muss. Enthält die Architektur, Design-Entscheidungen, Konventionen und die nicht-offensichtlichen Stellen.

---

## Was die App tut

Persönlicher Tracker für Long/Short-Aktien-Trades — Pair, Long-only oder Short-only — mit Live-Performance in Heimat-Währung (absolut und Prozent). Single-User-Tool für Robert, deployed als PWA (iPhone Homescreen + Mac Dock).

Kern-Features:

- Drei Trade-Typen: **Pair** (Long + Short als Einheit), **Long only**, **Short only**
- Vier horizontale Pages mit Snap-Scroll: Paare / Longs / Shorts / Gesamt
- Manuelle Trade-Eingabe (Tickers + Quantity + Entry-Preise pro Leg)
- Live-Kurs-Updates über Yahoo Finance (via eigenen Cloudflare-Worker-Proxy)
- Multi-Currency mit pfadunabhängiger Einstands-Währung pro Leg
- **Super-Trades:** Automatisches Mergen von Aufstockungen mit gleichem Ticker und gleichem Typ zu Tranchen mit aggregierter Performance
- Cloud-Sync zwischen iPhone und Mac über JSONBin
- **Zwei-Schwellen-Alarm** pro Trade: Verlust (3-Min-Repeat bis Quittung) + Gewinn (30-Min-Repeat bis Quittung), via Telegram-Bot
- Bei Single-Leg-Trades (Long / Short) zusätzlich: Schwelle wahlweise als Prozentwert oder als absoluter Preis in der Notierungswährung des Tickers
- Zwei Sprachen (DE, EN) — geräteabhängig
- Drei Themes (Mitternacht / Hell / Dunkel) — geräteabhängig
- Standard-Page in Settings konfigurierbar — pro Gerät
- Grid/Liste-View-Toggle pro Page — pro Gerät
- Keyboard-Shortcuts Cmd/Ctrl+Shift+1..4 zum Wechseln der Pages (Desktop)
- Auto-Refresh jede Minute wenn App im Foreground während Handelszeit (Mo-Fr, 09:00-23:00 Berlin)
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

**Deployment-Reihenfolge bei Worker- und HTML-Änderungen gleichzeitig: immer Worker zuerst.** Der Worker ist rückwärts-kompatibel mit dem alten HTML-Datenformat (fehlende Felder defaulten auf alte Semantik). Das neue HTML hingegen schreibt Felder, die der alte Worker nicht kennt — z.B. `alertMinMode: "price"` mit `alertPctMin: null` würde vom alten Worker als „keine Schwelle gesetzt" interpretiert → Alarm stillschweigend tot.

---

## Datenmodell (was in JSONBin steht)

```json
{
  "trades": [
    {
      "id": "t_...",
      "type": "pair" | "long" | "short",
      "name": "Optional Anzeigename",
      "longTicker": "AAPL",
      "shortTicker": "MSFT",
      "alertPctMin": -30,
      "alertPctMax": 50,
      "alertPriceMin": null,
      "alertPriceMax": null,
      "alertMinMode": "pct" | "price",
      "alertMaxMode": "pct" | "price",
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
      "min": { "state": "idle" | "triggered" | "acknowledged", "lastAlertAt": <ms> },
      "max": { "state": "idle" | "notified" | "acknowledged", "lastAlertAt": <ms> }
    }
  },
  "lastModified": <ms-timestamp>,
  "lang": "de" | "en",
  "_device": "mobile"
}
```

**Wichtig zur Datenmodell-Evolution:**

- `type` wurde später hinzugefügt. Trades ohne `type` werden als `"pair"` interpretiert (Worker + Frontend haben Backward-Compat-Logik in `tradeType()`).
- `alertPctMin` ersetzte das alte `alertThreshold`. Beide Felder werden bei der Auswertung berücksichtigt (Frontend: `tradeType()` und `alarmStateOf()`; Worker: `min ?? alertThreshold`).
- `alertPctMax`, `alertPriceMin`, `alertPriceMax`, `alertMinMode`, `alertMaxMode` sind neuer. Fehlen sie → Default `null` bzw. `"pct"`.
- `alertStates` hat das alte flache Format `{state, lastAlertAt}` und das neue verschachtelte `{min: {...}, max: {...}}`. `ensureStateShape()` im Worker und `alarmStateOf()` im Frontend migrieren on-read transparent.
- `tranches` ersetzt die früheren flachen Felder (`longQty` etc. auf Top-Level). `migrateTrades()` läuft beim ersten App-Start nach Update.

---

## Wichtige Design-Entscheidungen (das Warum)

### Trade-Typen: pair / long / short

`type` ist Pflichtfeld für jeden Trade (mit Default `"pair"` für Legacy-Daten). Die Type-Wahl im Trade-Formular ist nur bei einem neuen Trade aus der „Gesamt"-Page möglich; auf den dedizierten Pages (Longs, Shorts) ist der Typ vorbelegt. Im Edit-Modus ist der Typ fix und kann nicht geändert werden — das würde die Daten-Semantik (insbesondere Tranchen-Aggregation) sprengen.

Für `type: "long"` werden `shortTicker`, `shortQty`, `shortEntry` als `null` / `0` gespeichert, analog umgekehrt. `hasLong(tr)` und `hasShort(tr)` checken die Existenz. Die Render-Funktionen (`renderOneTradeCard`, `legHtml`, `legAggregateHtml`) blenden Legs sauber aus, wenn der jeweilige Ticker fehlt.

### 4-Page-Layout mit Snap-Scroll

`pages-container` ist ein horizontaler Flex-Container mit `scroll-snap-type: x mandatory`. Jede Page = `flex: 0 0 100%`. Auf Mobile wischt man horizontal, auf Desktop scrollt man oder nutzt Cmd/Ctrl+Shift+1..4.

Reihenfolge fix: `["pair", "long", "short", "total"]`. Settings „Standard-Page" bestimmt, welche beim App-Start aktiv ist (default `pair`).

Aggregat-Berechnung pro Page in `updatePageAggregate(pageKey, rows)`. Die `total`-Page summiert alle Trades.

### Super-Trade / Tranchen-Modell — typ-isoliert

Wenn der User einen neuen Trade speichert dessen Ticker(s) **und Typ** einem bestehenden Trade entsprechen, wird der neue als zusätzliche Tranche an den bestehenden gehängt (Auto-Merge ohne Nachfrage). Beispiel: ein Long-only AAPL kann nur mit anderen Long-only AAPLs zu einem Super-Trade verschmelzen, nicht mit einem AAPL/MSFT-Pair.

Performance wird aggregiert: Total P&L = Σ aller Tranchen-P&Ls (in Heimat-Währung), Total Notional = Σ aller Tranchen-Notionals, Total % = P&L / Notional × 100. Mathematisch äquivalent zu volume-weighted-average-entry.

**Alarm-Schwelle bei Merges:** Wenn der bestehende Super-Trade bereits eine Schwelle hat (für loss oder profit), wird sie **niemals** durch eine neue Tranche überschrieben — auch wenn die neue Tranche eigene Schwellen mitbringt. Nur wenn der bestehende Trade die jeweilige Schwelle leer hatte und die neue eine setzt, übernimmt der Super-Trade die neue (inklusive `alertMinMode` / `alertMaxMode`). Edit-Form zeigt Hinweistext „Beim Aufstocken werden neue Tranchen-Schwellen nicht übernommen".

**Mixed-Currency-Tranchen:** Wenn Tranchen unterschiedliche Einstands-Währungen haben, wird auf Heimat-Währung (`HOME_CCY = EUR` im Worker, `homeCurrency` aus Settings im Frontend) aggregiert. Funktioniert weil jede Tranche ihren eigenen `longEntryCcy` / `shortEntryCcy` speichert (pfadunabhängig).

**Edit-Verhalten bei Multi-Tranche-Trades:** Edit-Form zeigt nur Name und Alarm-Schwellen (Ticker, Quantity, Entry sind disabled). Einzelne Tranchen können über die Tranchen-Detail-Ansicht gelöscht werden (Tap auf Trade-Card im Grid- oder Listen-Modus öffnet die Liste). Wenn die letzte Tranche eines Multi-Tranche-Trades gelöscht wird, wird der gesamte Trade gelöscht.

**Single-Tranche-Trades:** Edit-Form erlaubt alle Felder. Tranche-Detail-Ansicht wird nicht angezeigt (kein Tap-Toggle, kein Badge).

### Pfadunabhängige Einstands-Währung

Jede Tranche speichert ihre Entry-Currency **explizit** als `longEntryCcy` / `shortEntryCcy`. Wenn der User später die Heimat-Währung wechselt (z.B. EUR → CHF), bleiben die Entry-Preise korrekt interpretiert. Migration alter Daten: fehlende `*EntryCcy`-Felder defaulten zu `"EUR"`.

Das Flag `longEntryNative` / `shortEntryNative` erlaubt alternativ „verwende die API-Währung des Tickers" — z.B. wenn man AAPL in USD eingibt statt umgerechnet in EUR.

### Zwei-Schwellen-Alarm: Verlust + Gewinn

Pro Trade können bis zu **zwei** Schwellen gleichzeitig aktiv sein:

- **Verlust-Schwelle (`alertPctMin`):** Negativwert, intern immer als `-Math.abs(input)` gespeichert. User gibt im UI nur die positive Zahl ein (iOS hat auf dem Numerik-Keyboard kein Minus). Telegram-Repeat alle 3 Min bis quittiert.
- **Gewinn-Schwelle (`alertPctMax`):** Positivwert, intern immer als `Math.abs(input)`. Telegram-Repeat alle 30 Min bis quittiert.

Beide Schwellen sind unabhängig optional — ein Trade kann nur Loss, nur Profit, beides oder keines haben.

**Eine einzige Telegram-Reply quittiert alle aktiven Alarme über alle Trades hinweg.** Robert wollte das so — wenn das Handy mit fünf Alarm-Pings kommt, will er nicht fünfmal antworten.

### Schwellen-Modi: Pct vs. Preis (nur Single-Leg)

Bei `type: "long"` und `type: "short"` kann jede Schwelle **einzeln** zwischen zwei Modi umgeschaltet werden:

- **Pct-Mode** (Default): wie oben, basiert auf der berechneten Performance des Trades in %.
- **Preis-Mode:** absoluter Preis in der Notierungswährung des Tickers. Worker vergleicht direkt gegen den Yahoo-`regularMarketPrice`, kein FX-Trick.

Bei `type: "pair"` ist Preis-Mode nicht möglich (ein Spread hat keinen einzelnen Quoted Price). Worker erzwingt `"pct"` für Pair-Trades zur Sicherheit, auch wenn das Frontend `"price"` schickt.

**Trigger-Richtung pro Konstellation:**
| Typ | Schwelle | Trigger wenn... |
|---|---|---|
| Long | Loss | `livePrice ≤ thr` (Kurs ist gefallen) |
| Long | Profit | `livePrice ≥ thr` (Kurs ist gestiegen) |
| Short | Loss | `livePrice ≥ thr` (Kurs ist gestiegen, bad for short) |
| Short | Profit | `livePrice ≤ thr` (Kurs ist gefallen, good for short) |

UI: kleiner Pct/Preis-Toggle pro Schwelle (analog zum Grid/Liste-Toggle), erscheint nur wenn der Trade-Typ Long oder Short ist. Bei Pair-Trades wird er gar nicht eingeblendet.

**Soft-Warnung beim Speichern:** Wenn eine eingegebene Schwelle bei aktuellem Kurs/Performance bereits verletzt wäre (z.B. „Verlust-Schwelle 200 USD" für AAPL bei aktuell 180 USD), zeigt `confirmAlertWouldFire()` einen confirm()-Dialog mit konkreter Beschreibung. Der User kann abbrechen oder bewusst trotzdem speichern. Funktioniert für beide Modi (Pct und Preis).

### Alarm-State-Machine

Pro Trade gibt es zwei unabhängige States im JSONBin (in `alertStates[id]`):

- `min`: `idle → triggered → acknowledged → idle`
- `max`: `idle → notified → acknowledged → idle`

Edge-triggered: Alarm feuert nur beim Übergang `idle → triggered` (oder `idle → notified`). Während des „aktiven" Zustands repeat alle 3 Min (Loss) bzw. 30 Min (Profit) bis Telegram-Reply → `acknowledged`. Reset zu `idle` erst wenn die Performance/der Kurs wieder auf die richtige Seite der Schwelle dreht — verhindert Re-Trigger-Spam an der Grenze.

Telegram-Webhook setzt alle gerade aktiven `triggered` + `notified` States im JSONBin auf `acknowledged`. Eine einzige Reply quittiert also alles, was gerade scharf wäre.

Worker-Konstanten: `ALERT_REPEAT_MS = 3 * 60 * 1000`, `PROFIT_ALERT_REPEAT_MS = 30 * 60 * 1000`. Cron-Schedule `*/3 * * * *`.

### Handelszeit-Fenster

`TRADING_START_HOUR = 9`, `TRADING_END_HOUR = 23` (Berlin time, Mo-Fr). Deckt EU-Markt + US-Markt-Schluss ab. Außerhalb keine Alarm-Checks (Worker skipped, App stoppt Auto-Refresh). Bewusst breit gewählt — Telegram-Pings um 03:00 Uhr will keiner.

### Yahoo-Proxy ist transparenter Passthrough

Der Worker proxy't die rohe Yahoo-API-Response 1:1 — die App erwartet `data.chart.result[0].meta.regularMarketPrice` und nicht ein remapped Format. Wenn der Worker den Response remapped, bricht der Worker-Test in den App-Settings mit „Antwort unerwartet".

### Auto-Refresh nur im Foreground

`document.hidden`-Check verhindert Updates wenn Tab/App im Background. Im Foreground 1-Min-Intervall. User-Erwartung: „wenn ich draufschaue, will ich die neuesten Daten".

### Sprache und Theme: geräteabhängig

Sprache (`pair_trade_lang_v1`) und Theme (`pair_trade_theme_v1`) sind beide in `localStorage`, nicht in JSONBin. Trade-off: bei verschiedenen Einstellungen auf iPhone vs. Mac unterschiedliche Darstellung. Beim Push schickt das Gerät seine aktuelle Sprache im `lang`-Feld mit, damit der Worker weiß, in welcher Sprache er Telegram-Nachrichten schicken soll — das zuletzt pushende Gerät gewinnt.

Themes: `midnight` (Default, dunkles Lila-Blau), `light` (klassisch hell), `dark` (klassisch dunkel). Auswahl in Settings als drei Card-Buttons (GitHub-Style), nicht Dropdown.

Sprachangebot ist auf DE + EN reduziert (vorher 4 inkl. IT + RU — entfernt zur Code-Hygiene, brauchte keiner).

### Grid vs. Liste

Pro Page (Pair / Long / Short / Total) kann der User zwischen zwei Darstellungen wechseln:

- **Grid (Default):** detaillierte Cards mit allen Legs, Tranchen-Panel ausklappbar
- **Liste:** kompakte Zeilen, ein Tap auf eine Multi-Tranche-Zeile öffnet die Tranchen-Detail-Ansicht direkt darunter

View-Mode wird in `localStorage[pair_trade_view_v1]` pro Page gespeichert (geräteabhängig).

Beide Toggles (Grid/Liste und Pct/Preis) sind explizit groß dimensioniert für komfortable Touch-Bedienung auf dem iPhone (Treffer-Fläche ≥ 38 px).

---

## Worker-Endpoints

| Endpoint | Zweck |
|---|---|
| `GET /?symbol=AAPL` | Yahoo-Passthrough — used by App für Live-Preise und FX-Raten |
| `GET /check` | Manueller Alarm-Check (Cron ruft das gleiche intern auf) |
| `GET /test-alert` | Sendet Test-Telegram-Nachricht in aktueller Sprache |
| `GET /setup-webhook` | Registriert Worker-URL als Telegram-Webhook-Target |
| `POST /telegram-webhook` | Empfängt User-Replies → setzt alle triggered/notified States auf acknowledged |

Cron-Trigger im Cloudflare-Dashboard: `*/3 * * * *` (alle 3 Minuten).

Backward-Compat im Worker: `getTranches(trade)` erkennt ob ein Trade die neue oder alte Struktur hat. `ensureStateShape()` migriert alte flache AlertStates on-read. `tradeType()` defaultet auf `"pair"`.

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
- `pair_trade_theme_v1` — gewähltes Theme (geräteabhängig)
- `pair_trade_start_page_v1` — Standard-Page beim App-Start (geräteabhängig)
- `pair_trade_view_v1` — View-Mode pro Page (Grid/Liste, geräteabhängig)

Bei Versions-Bumps: neue Keys vergeben (`_v3`), alte beim ersten Load migrieren.

---

## Bekannte Stolperfallen

1. **Decimal-Comma:** Inputs sind `type="text" inputmode="decimal"`, nicht `type="number"`. `parseDecimal()` akzeptiert sowohl „150,50" als auch „150.50". Niemals auf `type="number"` umstellen — das brach den User-Workflow weil iOS-Keyboard Komma-Eingabe nur eingeschränkt erlaubt.

2. **iOS-Numerik-Keyboard hat kein Minus:** Negative Schwellen werden im UI als positive Zahl eingegeben, intern via `-Math.abs()` normalisiert. Gilt für Loss-Schwellen (sowohl Pct als auch Preis-Mode wenn als „unter Kurs" interpretiert) — der User soll nie ein Vorzeichen tippen müssen.

3. **Cache zwischen Netlify und Cloudflare:** Beim Deploy einer neuen HTML kann der Mac noch eine alte Version sehen (Safari-Cache + Cloudflare-Edge-Cache). Workaround: in Safari Cache leeren und PWA aus Dock entfernen/neu hinzufügen.

4. **CORS-Proxys sind tot:** Frühere Versionen nutzten corsproxy.io / allorigins.win — beide nicht mehr verlässlich. Eigener Cloudflare-Worker ist die einzige stabile Lösung.

5. **Twelve Data deckt europäische Aktien nicht ab:** Yahoo Finance schon. Niemals zu Twelve Data zurückwechseln auch wenn es als „saubere" API klingt.

6. **PWA auf Mac:** Safari „Add to Dock" (macOS Sonoma 14+) gibt true-PWA-Verhalten. iOS-Shortcuts auf Mac sind ein Anti-Pattern.

7. **Migration bei Bestandstrades:** Beim ersten Laden nach einem Update werden alte Strukturen transparent migriert: flache Trade-Felder → `tranches: [{...}]`, fehlendes `type` → `"pair"`, flache AlertStates → `{min, max}`. Migrationen sind idempotent.

8. **Auto-Merge bei identischen Tickern UND gleichem Typ:** Wenn der User glaubt einen separaten Trade anzulegen, aber Ticker und Typ identisch sind zu einem bestehenden — wird automatisch gemerged. Eine Alert-Box bestätigt mit „Aufstockung zu bestehendem Trade hinzugefügt (Tranche N)". Ein Long-only AAPL und ein AAPL/MSFT-Pair zählen als unterschiedlich (verschiedener Typ) und werden nicht gemerged.

9. **Deployment-Reihenfolge:** Worker-Änderungen zuerst, dann HTML. Wer das umdreht, riskiert dass neue HTML-Felder (z.B. `alertPriceMin`, `alertMinMode`) vom alten Worker ignoriert werden und Alarme stillschweigend nicht mehr feuern.

10. **Preis-Schwellen sind nicht FX-konvertiert:** Eine Preis-Schwelle für AAPL ist in USD, eine für SAP.DE in EUR. Der Worker vergleicht direkt gegen `regularMarketPrice` in der Notierungswährung. Wenn der User EUR als Heimat-Währung hat und eine Preis-Schwelle für AAPL setzt, ist sie trotzdem in USD — das Label im Form zeigt das auch entsprechend an.

---

## Internationalisierung

`STRINGS` ist ein zentrales Dictionary mit ~100 Keys × 2 Sprachen (DE, EN). `t(key, params)` für Lookups mit `{param}`-Interpolation. DOM-Elemente mit `data-i18n="key"` werden via `applyTranslations()` beim Sprachwechsel re-rendert.

Worker hat sein eigenes (kleineres) `WORKER_STRINGS`-Dictionary nur für Telegram-Nachrichten.

Beim Hinzufügen neuer UI-Strings: in DE und EN einpflegen. DE als Fallback wenn ein Key in EN fehlt.

---

## Robert's Präferenzen

- Sehr ehrliches Feedback, kein Sugarcoating. Lieber Bug zugeben als rumeiern.
- Mag pragmatische Code-Erklärungen mit Trade-offs.
- Schreibt Deutsch, versteht aber EN-Begriffe in Code (Variablen, etc.).
- Setup ist: iPhone als primäres Mobile-Gerät, Mac als Desktop. Beide nutzen die selbe Netlify-URL.
- Telegram-Alarms müssen zuverlässig sein — das ist der Hauptgrund für das ganze Setup, nicht nur die Live-Anzeige.
- Robert pullt die fertigen Dateien aus dem `outputs`-Ordner und committed sie selbst auf GitHub. Manuelle GitHub-Bearbeitung außerhalb des Cowork-Sessions findet nicht statt.

---

## Wenn du diese Datei in einer neuen Session liest

Du bist jetzt informiert genug um Änderungen vorzunehmen. Empfohlenes Vorgehen:

1. Den aktuellen Stand des Codes via WebFetch oder Upload anschauen
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (State-Machine, Pfadunabhängigkeit, Tranche-Modell, Trade-Typ-Isolation, Pct/Preis-Mode) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: **beide** Seiten gleichzeitig anpassen, Worker zuerst deployen
4. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk
