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
- **Soft-Warnung beim Speichern** wenn eine eingegebene Schwelle bereits durch den aktuellen Kurs verletzt wäre
- **Auto-Wipe**: Sync-Credentials und Trade-Cache leben in `sessionStorage` und sind beim Safari-Close weg
- **Optionale App-Sperre** (PIN oder Passwort) für „App offen + Handy aus der Hand geben"-Szenario
- Zwei Sprachen (DE, EN) — geräteabhängig
- Drei Themes (Mitternacht / Hell / Dunkel) — geräteabhängig
- Standard-Page in Settings konfigurierbar — pro Gerät
- Grid/Liste-View-Toggle pro Page (touch-freundlich groß) — pro Gerät
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

## Storage-Architektur (Auto-Wipe)

Die App nutzt zwei verschiedene Browser-Speicher mit **unterschiedlichen Persistenz-Garantien**:

### sessionStorage (überlebt Safari-Schließen NICHT)

| Key | Inhalt |
|---|---|
| `pair_trade_tracker_v2` | Trades + AlertStates + lastModified — der gesamte Trade-Cache |
| `pair_trade_sync_v1` | JSONBin Master-Key, Bin-ID, enabled-Flag |

Diese Daten werden beim Schließen von Safari (oder beim Wischen der PWA aus dem App-Switcher auf iOS) **automatisch gelöscht**. Eine neue Session startet leer.

### localStorage (überlebt Safari-Schließen)

| Key | Inhalt |
|---|---|
| `pair_trade_price_v1` | Worker-URL + Home-Currency (keine Geheimnisse) |
| `pair_trade_lang_v1` | gewählte Sprache (DE/EN) |
| `pair_trade_theme_v1` | gewähltes Theme (midnight/light/dark) |
| `pair_trade_view_v1` | Grid/Liste-Modus pro Page |
| `pair_trade_start_page_v1` | Standard-Page beim App-Start |
| `pair_trade_lock_v1` | App-Sperre-Settings: `{enabled, type, hash}` |

### Warum diese Aufteilung?

**Threat Model**: Schutz davor, dass jemand das geklaute / geliehene Handy nimmt und die Trade-Historie sieht.

- **Geheime Daten** (Trades, JSONBin-Creds) sollen beim Safari-Close verschwinden. Wer die URL danach öffnet, sieht eine leere Form, die wie ein nicht eingerichtetes Tool aussieht — kein Hinweis darauf, dass es etwas zu schützen gäbe.
- **Nicht-geheime Settings** (Theme, Sprache, Worker-URL etc.) bleiben, damit die UX bei jeder Session nicht von Null beginnt.

Beim ersten Start einer neuen Session muss der User in Settings den JSONBin Master-Key und die Bin-ID neu eingeben. Sync pullt dann die Trades zurück. **Heißt operativ:** User muss sich Master-Key + Bin-ID irgendwo sicher speichern (Passwort-Manager + iCloud Keychain + Auto-Fill mit Face ID ist der reibungsärmste Weg).

### Was bedeutet das für Migration alter Builds?

Frühere Versionen speicherten alle Daten in `localStorage`. Beim ersten Start der neuen Version werden `pair_trade_tracker_v2`, `pair_trade_tracker_v1` und `pair_trade_sync_v1` aus dem localStorage **proaktiv gelöscht** (siehe einmaligen Cleanup-Aufruf direkt nach den Storage-Funktionen). Damit landen alte Caches nicht mehr persistent — der User muss sich danach einmalig neu einloggen, ist dann aber im neuen Modell.

---

## App-Sperre (Lock-Screen)

Optionaler Zusatzschutz für ein spezifisches Szenario, das vom Auto-Wipe NICHT abgedeckt wird.

### Threat-Matrix

| Szenario | Auto-Wipe | App-Sperre | iOS Auto-Lock |
|---|---|---|---|
| Handy weg, App geschlossen, Dieb öffnet URL | ✅ schützt (leere Form) | irrelevant | — |
| Handy weg, App offen | ❌ wirkt nicht | ✅ schützt (nach 30s Hintergrund) | ✅ schützt (sofort bei Sperre) |
| Handy entsperrt in fremder Hand <30s | ❌ | ❌ | ⚠️ je nach Auto-Lock-Konfig |

Die App-Sperre **deckt nur den zweiten Fall ab**: App ist offen, Handy wird kurz aus der Hand gegeben, User vergisst sie zu schließen. Nach 30 Sek. im Hintergrund kommt beim Zurückkehren der Lock-Screen.

### Wann der Lock-Screen feuert

- `lockSettings.enabled === true` UND `lockSettings.hash` gesetzt
- UND `sessionHasData()` ist true (Trades geladen ODER Sync-Credentials in sessionStorage)
- UND App war zuvor `document.hidden` für mehr als `LOCK_RELOCK_MS` (30 Sek.)

**Nicht beim Boot.** Eine frische Session hat noch keine Daten in `sessionStorage`, der Lock-Screen wäre redundant (es gibt nichts zu schützen). Der User landet sofort auf der leeren App und gibt seine Credentials ein. Erst nach erfolgreichem Sync ist „session has data" wahr, und ab dann ist die Sperre für diese Session „scharf".

### Code-Speicherung

Nur ein SHA-256-Hash via Web Crypto wird in `pair_trade_lock_v1` gespeichert. Der Klartext-Code landet nirgendwo. Settings-Wahl zwischen `type: "pin"` (numerisches iOS-Keyboard) und `type: "password"` (beliebige Zeichen).

Validierung beim Anlegen:
- Mindestlänge 4 Zeichen
- PIN darf nur Ziffern enthalten
- Code + Bestätigung müssen identisch sein (zweites Eingabefeld als Schutz vor Vertippern)

Beim Editieren bestehender Sperre: Code-Felder leer = bestehender Code bleibt. Nur Typ ändern oder Sperre ausschalten ist auch ohne Re-Entry möglich.

### Bekannte Grenzen / explizit dokumentierte Schwächen

Da das Repo privat ist, hier transparent die Schwachstellen:

1. **Pure UI-Sperre, keine Datenverschlüsselung.** Während die Session läuft, liegen die Trades unverschlüsselt in `sessionStorage`. Wer Safari-Developer-Tools öffnet (Mac angeschlossen + Web-Inspector), kommt direkt an die Daten ran, ohne den Lock-Screen passieren zu müssen.

2. **Lock kann durch Storage-Manipulation umgangen werden.** Wer den `lockSettings.hash` Eintrag in localStorage löscht (Safari Devtools → Application → Local Storage), kommt beim nächsten visibilitychange-Event ohne Code rein. Aber: der Angreifer braucht dafür eine offene Session — sobald die zu Ende ist, gibt's keine Daten mehr zu schützen.

3. **Brute-Force gegen 4-stelligen PIN ist trivial offline.** Wer den Hash hat (siehe Punkt 2), kann 10.000 PINs in unter einer Sekunde durchprobieren. Da hilft kein PBKDF2, weil der Lock selbst nicht zur Datenverschlüsselung genutzt wird — der Angreifer braucht den Hash gar nicht zu knacken, er löscht ihn einfach.

4. **Kein Recovery-Pfad.** Wenn der User den Code vergisst und gerade eine aktive Session läuft → keine Möglichkeit, ihn zurückzusetzen, außer Safari-Daten zu löschen. Damit gehen aber alle localStorage-Settings UND der gerade aktive sessionStorage (Trades, Sync-Creds) verloren. Sync pullt nach Re-Login die Trades zurück, andere Settings müssen einmal neu konfiguriert werden.

5. **Worker und Telegram-Bot wissen nichts vom Lock.** Die App-Sperre ist rein clientseitig. Damit hat sie keinen Einfluss auf:
   - Alarm-Cron alle 3 Min läuft weiter
   - Telegram-Alarme werden weiter verschickt
   - Telegram-Acknowledge funktioniert weiter
   
   Heißt: wer dein Telegram-Konto klaut, bekommt nach wie vor deine Alarme zu sehen. Schutz dort liegt bei Telegram selbst.

### Bewusste Design-Entscheidungen

- Lock-Settings werden nicht in JSONBin synct. Pro Gerät einstellbar.
- Sperre nur sichtbar wenn `sessionHasData()` — vermeidet redundante UX bei leerer Session.
- 30-Sek-Hintergrund-Schwelle, nicht sofort. Schnelles Wechseln zur Telegram-App und zurück soll nicht jedes Mal sperren.
- Eingabe-Feld iOS-spezifisch: `type="tel" inputmode="numeric"` für PIN (zeigt Ziffern-Keypad), `type="password"` für Passwort.

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
- `alertPctMin` ersetzte das alte `alertThreshold`. Beide Felder werden bei der Auswertung berücksichtigt.
- `alertPctMax`, `alertPriceMin`, `alertPriceMax`, `alertMinMode`, `alertMaxMode` sind neuer. Fehlen sie → Default `null` bzw. `"pct"`.
- `alertStates` hat das alte flache Format `{state, lastAlertAt}` und das neue verschachtelte `{min: {...}, max: {...}}`. `ensureStateShape()` im Worker und `alarmStateOf()` im Frontend migrieren on-read transparent.
- `tranches` ersetzt die früheren flachen Felder. `migrateTrades()` läuft beim ersten Mal nach Pull.

---

## Wichtige Design-Entscheidungen (das Warum)

### Trade-Typen: pair / long / short

`type` ist Pflichtfeld für jeden Trade (mit Default `"pair"` für Legacy-Daten). Die Type-Wahl im Trade-Formular ist nur bei einem neuen Trade aus der „Gesamt"-Page möglich; auf den dedizierten Pages (Longs, Shorts) ist der Typ vorbelegt. Im Edit-Modus ist der Typ fix.

Für `type: "long"` werden `shortTicker`, `shortQty`, `shortEntry` als `null` / `0` gespeichert, analog umgekehrt. `hasLong(tr)` und `hasShort(tr)` checken die Existenz.

### 4-Page-Layout mit Snap-Scroll

`pages-container` ist ein horizontaler Flex-Container mit `scroll-snap-type: x mandatory`. Reihenfolge fix: `["pair", "long", "short", "total"]`. Settings „Standard-Page" bestimmt, welche beim App-Start aktiv ist.

### Super-Trade / Tranchen-Modell — typ-isoliert

Auto-Merge nur bei gleichem Ticker UND gleichem Typ. Ein Long-only AAPL und ein AAPL/MSFT-Pair zählen als unterschiedlich.

**Alarm-Schwelle bei Merges:** Wenn der bestehende Super-Trade bereits eine Schwelle hat (für loss oder profit), wird sie niemals durch eine neue Tranche überschrieben. Nur wenn der bestehende Trade die jeweilige Schwelle leer hatte und die neue eine setzt, übernimmt der Super-Trade die neue (inklusive Mode-Felder).

**Edit-Verhalten bei Multi-Tranche-Trades:** Edit-Form zeigt nur Name und Alarm-Schwellen (Ticker, Quantity, Entry sind disabled). Einzelne Tranchen können über die Tranchen-Detail-Ansicht gelöscht werden.

### Pfadunabhängige Einstands-Währung

Jede Tranche speichert ihre Entry-Currency explizit als `longEntryCcy` / `shortEntryCcy`. Wenn der User später die Heimat-Währung wechselt, bleiben die Entry-Preise korrekt interpretiert.

`longEntryNative` / `shortEntryNative` erlaubt alternativ „verwende die API-Währung des Tickers".

### Zwei-Schwellen-Alarm: Verlust + Gewinn

- **Verlust-Schwelle (`alertPctMin`):** Negativwert, intern `-Math.abs(input)`. User gibt im UI nur positive Zahl ein (iOS hat kein Minus auf dem Ziffern-Keyboard). Telegram-Repeat alle 3 Min bis quittiert.
- **Gewinn-Schwelle (`alertPctMax`):** Positivwert, `Math.abs(input)`. Telegram-Repeat alle 30 Min bis quittiert.

Eine einzige Telegram-Reply quittiert alle aktiven Alarme über alle Trades hinweg.

### Schwellen-Modi: Pct vs. Preis (nur Single-Leg)

Bei `type: "long"` und `type: "short"` kann jede Schwelle einzeln zwischen Pct-Mode (Default) und Preis-Mode umgeschaltet werden. Bei Pair-Trades nicht möglich (Spread hat keinen Quoted Price). Worker erzwingt `"pct"` für Pair-Trades zur Sicherheit.

**Trigger-Richtung pro Konstellation:**

| Typ | Schwelle | Trigger wenn... |
|---|---|---|
| Long | Loss | `livePrice ≤ thr` |
| Long | Profit | `livePrice ≥ thr` |
| Short | Loss | `livePrice ≥ thr` (Kurs gestiegen, bad for short) |
| Short | Profit | `livePrice ≤ thr` (Kurs gefallen, good for short) |

UI: kleiner Pct/Preis-Toggle pro Schwelle (analog zum Grid/Liste-Toggle), erscheint nur wenn der Trade-Typ Long oder Short ist.

**Soft-Warnung beim Speichern:** Wenn eine eingegebene Schwelle bei aktuellem Kurs/Performance bereits verletzt wäre, zeigt `confirmAlertWouldFire()` einen confirm()-Dialog. Funktioniert für beide Modi.

### Alarm-State-Machine

Pro Trade zwei unabhängige States im JSONBin (`alertStates[id]`):

- `min`: `idle → triggered → acknowledged → idle`
- `max`: `idle → notified → acknowledged → idle`

Edge-triggered: Alarm feuert nur beim Übergang `idle → triggered`. Telegram-Webhook setzt alle gerade aktiven Triggered/Notified Status im JSONBin auf `acknowledged`.

Worker-Konstanten: `ALERT_REPEAT_MS = 3 * 60 * 1000`, `PROFIT_ALERT_REPEAT_MS = 30 * 60 * 1000`. Cron `*/3 * * * *`.

### Handelszeit-Fenster

`TRADING_START_HOUR = 9`, `TRADING_END_HOUR = 23` (Berlin, Mo-Fr). Außerhalb keine Alarm-Checks, App stoppt Auto-Refresh.

### Yahoo-Proxy ist transparenter Passthrough

Worker proxy't die rohe Yahoo-Response 1:1. App erwartet `data.chart.result[0].meta.regularMarketPrice`.

### Auto-Refresh nur im Foreground

`document.hidden`-Check verhindert Updates wenn Tab/App im Background.

### Sprache und Theme: geräteabhängig

Sprache (`pair_trade_lang_v1`) und Theme (`pair_trade_theme_v1`) in `localStorage`, nicht in JSONBin. Beim Sync-Push wird die aktuelle Sprache im `lang`-Feld mitgeschickt, damit der Worker weiß, in welcher Sprache er Telegram-Nachrichten schicken soll.

Themes: `midnight` (Default), `light`, `dark`. Auswahl in Settings als drei Card-Buttons.

### Grid vs. Liste

Pro Page wählbar zwischen kompakten Listenzeilen oder ausführlichen Cards mit allen Legs. View-Mode in `localStorage[pair_trade_view_v1]` pro Page. Toggle-Buttons sind explizit groß dimensioniert für komfortable Touch-Bedienung (Treffer-Fläche ≥ 38 px).

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

## Bekannte Stolperfallen

1. **Decimal-Comma:** Inputs sind `type="text" inputmode="decimal"`, nicht `type="number"`. `parseDecimal()` akzeptiert sowohl „150,50" als auch „150.50".

2. **iOS-Numerik-Keyboard hat kein Minus:** Negative Schwellen werden im UI als positive Zahl eingegeben, intern via `-Math.abs()` normalisiert.

3. **Cache zwischen Netlify und Cloudflare:** Beim Deploy einer neuen HTML kann der Mac noch eine alte Version sehen. Workaround: Safari-Cache leeren und PWA aus Dock neu hinzufügen.

4. **CORS-Proxys sind tot:** corsproxy.io / allorigins.win nicht mehr verlässlich. Eigener Cloudflare-Worker ist die einzige stabile Lösung.

5. **Twelve Data deckt europäische Aktien nicht ab:** Yahoo Finance schon. Niemals zu Twelve Data zurückwechseln.

6. **PWA auf Mac:** Safari „Add to Dock" (macOS Sonoma 14+) gibt true-PWA-Verhalten.

7. **Migration bei Bestandstrades:** Beim ersten Sync-Pull werden alte Strukturen transparent migriert: flache Trade-Felder → `tranches: [{...}]`, fehlendes `type` → `"pair"`, flache AlertStates → `{min, max}`. Migrationen sind idempotent.

8. **Auto-Merge bei identischen Tickern UND gleichem Typ:** Wenn der User glaubt einen separaten Trade anzulegen, aber Ticker und Typ identisch sind zu einem bestehenden — wird automatisch gemerged. Alert-Box „Aufstockung zu bestehendem Trade hinzugefügt (Tranche N)".

9. **Deployment-Reihenfolge:** Worker-Änderungen zuerst, dann HTML. Wer das umdreht, riskiert dass neue HTML-Felder (z.B. `alertPriceMin`, `alertMinMode`) vom alten Worker ignoriert werden und Alarme stillschweigend nicht mehr feuern.

10. **Preis-Schwellen sind nicht FX-konvertiert:** Eine Preis-Schwelle für AAPL ist in USD, eine für SAP.DE in EUR. Worker vergleicht direkt gegen `regularMarketPrice` in der Notierungswährung.

11. **Auto-Wipe braucht User-Disziplin bei Credentials:** JSONBin Master-Key + Bin-ID müssen außerhalb der App gespeichert sein (Passwort-Manager). Ohne diese zwei Strings kein Datenzugriff mehr. Die App selbst hat absichtlich keinen Recovery-Pfad — der würde Worker oder Bot involvieren, was die saubere Trennung „Datenschutz lebt nur auf dem Device" zerstören würde.

12. **App-Sperre ist UI-Schutz, keine Verschlüsselung:** Während eine Session läuft, sind Trades unverschlüsselt in sessionStorage. Wer Safari Devtools öffnet oder den `lockSettings.hash` aus localStorage löscht, umgeht die Sperre vollständig. Schutz nur gegen Casual-Snooping (jemand schaut kurz aufs offene Handy).

13. **Worker und Bot kennen weder Auto-Wipe noch App-Sperre:** Telegram-Alarme laufen unabhängig von der App-Session. Wenn der Cron einen Alarm feuert, kriegt der User die Telegram-Nachricht, egal ob die PWA gerade offen ist oder nicht, egal ob die App gesperrt ist oder nicht. Der Bot ist nur an JSONBin angedockt.

---

## Internationalisierung

`STRINGS` ist ein zentrales Dictionary mit ~110 Keys × 2 Sprachen (DE, EN). `t(key, params)` für Lookups mit `{param}`-Interpolation. DOM-Elemente mit `data-i18n="key"` werden via `applyTranslations()` beim Sprachwechsel re-rendert.

Worker hat sein eigenes (kleineres) `WORKER_STRINGS`-Dictionary nur für Telegram-Nachrichten.

Beim Hinzufügen neuer UI-Strings: in DE und EN einpflegen. DE als Fallback wenn ein Key in EN fehlt.

---

## Robert's Präferenzen

- Sehr ehrliches Feedback, kein Sugarcoating. Lieber Bug zugeben als rumeiern.
- Mag pragmatische Code-Erklärungen mit Trade-offs.
- Schreibt Deutsch, versteht aber EN-Begriffe in Code (Variablen, etc.).
- Setup ist: iPhone als primäres Mobile-Gerät, Mac als Desktop. Beide nutzen die selbe Netlify-URL.
- Telegram-Alarms müssen zuverlässig sein — das ist der Hauptgrund für das ganze Setup, nicht nur die Live-Anzeige.
- Robert pullt die fertigen Dateien aus dem `outputs`-Ordner und committed sie selbst auf GitHub. Manuelle GitHub-Bearbeitung außerhalb der Cowork-Sessions findet nicht statt.
- Repo ist privat — wir können in Dokumentation und Code-Kommentaren transparent über Sicherheits-Grenzen sein, ohne diese einem Angreifer zu offenbaren.

---

## Wenn du diese Datei in einer neuen Session liest

Du bist jetzt informiert genug um Änderungen vorzunehmen. Empfohlenes Vorgehen:

1. Den aktuellen Stand des Codes via WebFetch oder Upload anschauen
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (State-Machine, Pfadunabhängigkeit, Tranche-Modell, Trade-Typ-Isolation, Pct/Preis-Mode, sessionStorage vs. localStorage Trennung) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: beide Seiten gleichzeitig anpassen, Worker zuerst deployen
4. Bei neuen sensiblen Daten (z.B. weitere Credentials): **immer überlegen, ob sie in sessionStorage oder localStorage gehören.** Faustregel: was dem Angreifer beim Lesen schaden würde → sessionStorage. Was nur Komfort ist → localStorage.
5. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk.
