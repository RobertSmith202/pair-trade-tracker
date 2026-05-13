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
- **Optionale App-Sperre** (PIN oder Passwort) — Lock-Screen bei jedem App-Öffnen und nach 30 Sek. im Hintergrund. Pro Gerät einstellbar, nicht synced.
- **Brute-Force-Schutz**: Eskalierende Eingabe-Freezes nach je 3 falschen Versuchen (1/3/5 Min, dann Verdopplung). Während Freeze nur Master-Key-Recovery möglich.
- **Master-Key-Recovery** auf dem Lock-Screen: bei vergessenem Code per JSONBin Master-Key entsperren
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

## Storage-Architektur

Alle App-Daten leben in `localStorage` und überleben Safari-Schließen / App-Switcher-Wischen.

| Key | Inhalt |
|---|---|
| `pair_trade_tracker_v2` | Trades + AlertStates + lastModified |
| `pair_trade_sync_v1` | JSONBin Master-Key, Bin-ID, enabled-Flag |
| `pair_trade_price_v1` | Worker-URL + Home-Currency |
| `pair_trade_lang_v1` | gewählte Sprache (DE/EN) |
| `pair_trade_theme_v1` | gewähltes Theme (midnight/light/dark) |
| `pair_trade_view_v1` | Grid/Liste-Modus pro Page |
| `pair_trade_start_page_v1` | Standard-Page beim App-Start |
| `pair_trade_lock_v1` | App-Sperre-Settings: `{enabled, type, hash}` |
| `pair_trade_lock_attempts_v1` | Brute-Force-Zähler: `{wrongAttempts, freezeUntil}` |

**Historische Notiz:** Eine frühere Version dieser App verschob `tracker_v2` und `sync_v1` nach `sessionStorage` (Auto-Wipe beim Safari-Close). Wurde rückgängig gemacht, weil der User-Komfort darunter litt (jede Session = JSONBin-Master-Key und Bin-ID neu eintippen). Der Schutz vor neugierigen Blicken übernimmt jetzt komplett der Lock-Screen mit Master-Key-Recovery (siehe unten).

**Threat-Modell:** Schutz davor, dass jemand das geklaute / geliehene Handy nimmt und die Trade-Historie sieht. Erste Verteidigungslinie ist iOS Auto-Lock (Face ID / PIN). Zweite ist der Lock-Screen der PWA. Beide sind UI-Schichten — keine Verschlüsselung der lokalen Daten. Wer Safari-Devtools öffnet, kann `localStorage` direkt lesen.

---

## App-Sperre (Lock-Screen)

Hauptschutz vor neugierigen Blicken. Da `localStorage` Trades und Sync-Credentials persistent hält, ist der Lock-Screen das einzige UI-Hindernis zwischen einem entsperrten Gerät und der Trade-Anzeige.

### Threat-Matrix

| Szenario | App-Sperre | iOS Auto-Lock |
|---|---|---|
| Handy verloren, durch iOS-PIN/FaceID gesperrt | irrelevant (iOS schützt) | ✅ |
| Entsperrtes Handy, App geschlossen, jemand öffnet URL | ✅ Lock-Screen beim Boot | — |
| Entsperrtes Handy, App offen, User legt es weg | ✅ Re-Lock nach 30 Sek. Hintergrund | ✅ wenn iOS-Auto-Lock kürzer |
| Entsperrtes Handy <30 Sek. in fremder Hand bei offener App | ❌ | ⚠️ je nach Auto-Lock-Konfig |
| Forensiker mit Mac-Kabel + Safari Devtools | ❌ (Lock ist UI-Schutz) | ❌ |

### Wann der Lock-Screen feuert

- **Beim App-Boot:** wenn `lockSettings.enabled === true` UND `lockSettings.hash` gesetzt. Lock erscheint sofort, **bevor** `loadStorage()` und `render()` aufgerufen werden — keine Flash der gecachten Trade-Daten hinter dem Lock.
- **Beim Zurückkommen aus dem Hintergrund:** wenn die App `document.hidden` für mehr als `LOCK_RELOCK_MS` (30 Sek.) war.

Schnelles Wechseln zur Telegram-App (z. B. zum Alarm-Acknowledge) und zurück bleibt unter 30 Sek. → kein Re-Lock.

### Master-Key-Recovery

Auf dem Lock-Screen gibt es unter dem „Entsperren"-Button einen Link „Passwort vergessen?". Klick öffnet ein zweites Eingabefeld für den JSONBin Master-Key.

Logik (in `attemptLockRecovery()`):
1. Eingegebener Master-Key wird mit `syncSettings.apiKey` aus `localStorage` verglichen (`===` String-Match nach trim).
2. Bei Match: `lockSettings = { enabled: false, hash: null }`, Persistierung, Lock-Screen wird ausgeblendet.
3. Bei Mismatch: rote Fehlermeldung + Shake-Animation.
4. Wenn kein `apiKey` gespeichert ist (Sync nie konfiguriert): „Kein Master-Key gespeichert" als Hinweis.

**Wichtige Eigenschaften der Recovery:**
- Der Master-Key liegt im gleichen `localStorage` wie der Lock-Hash. Ein Angreifer mit Devtools-Zugriff kann beide direkt lesen — die Recovery erhöht die Angriffsfläche nicht, weil sie nur einen UX-Komfort-Weg auf das bietet, was der Angreifer ohnehin schon hätte.
- Die Recovery feuert **niemals** automatisch — der User muss den Link explizit antippen UND den Master-Key tippen/pasten. Damit kein Risiko durch versehentliches Auslösen.
- Nach erfolgreicher Recovery ist die Sperre aus. Der User muss sie in Settings neu einrichten, falls er sie wieder will. So vermeidet man Verwirrung darüber, ob der vergessene Code „repariert" wurde oder nicht.
- Worker und Bot werden nicht involviert. Recovery ist rein clientseitig.

### Code-Speicherung

Nur ein SHA-256-Hash via Web Crypto wird in `pair_trade_lock_v1` gespeichert. Der Klartext-Code landet nirgendwo. Settings-Wahl zwischen `type: "pin"` (numerisches iOS-Keyboard) und `type: "password"` (beliebige Zeichen).

### Validierungs-Regeln pro Modus

**Passwort-Modus:**
- Jedes Keyboard-Zeichen erlaubt (Buchstaben, Ziffern, Sonderzeichen, Emojis, beliebige Unicode-Zeichen)
- **Keine Mindestlänge** — auch ein einzelnes Zeichen ist gültig. Robert hat das explizit so gewollt.
- Einzige Bedingungen: beide Felder nicht leer + beide identisch.

**PIN-Modus:**
- Nur Ziffern 0-9 erlaubt
- **Mindestens 4 Stellen** Pflicht
- Beide Felder identisch.

Code + Bestätigung müssen in beiden Modi identisch sein (zweites Eingabefeld als Schutz vor Vertippern).

### UI-Flow zum Anlegen / Ändern / Entfernen

Die Lock-Konfiguration ist **nicht** an den Haupt-Save-Button des Settings-Modals gekoppelt. Stattdessen gibt es einen dedizierten „Sperre bestätigen" / „Sperre entfernen"-Button direkt unter den Code-Feldern. Begründung: ein versehentliches „Speichern" mit nicht-übereinstimmenden Codes wäre eine sinnlose UX. Der dedizierte Button validiert und schreibt atomar.

Live-Feedback während des Tippens (über `evaluateLockForm()` + `updateLockUiState()`):
- Beide Felder leer → graues neutrales „Beide Felder ausfüllen", Button deaktiviert
- PIN-Mode mit weniger als 4 Ziffern → rot „PIN mindestens 4 Ziffern", Button deaktiviert
- PIN-Mode mit Nicht-Ziffer → rot „PIN darf nur Ziffern enthalten", Button deaktiviert
- Codes unterschiedlich → rot „✗ Codes stimmen nicht überein", Button deaktiviert
- Codes valide + identisch → grün „✓ Codes stimmen überein", Button **aktiviert**

Klick auf den Button:
- Bei Status=Aktiv mit validem Code → schreibt Hash in localStorage, leert die Felder, zeigt „✓ Sperre aktiviert"
- Bei Status=Aus → entfernt die Sperre (oder zeigt „Keine aktive Sperre vorhanden" falls bereits aus)
- Bei Status=Aktiv ohne validen Code → Button bleibt deaktiviert, kein Klick möglich

Beim Editieren einer bestehenden Sperre: Code-Felder leer lassen → bestehender Code bleibt. Nur Typ-Änderung allein ohne neuen Code wird nicht unterstützt (Button bleibt deaktiviert) — Robert müsste in diesem Fall einen neuen Code eintippen.

### Brute-Force-Schutz (Eingabe-Freeze)

Nach jeweils 3 falschen Eingaben wird die Eingabe für einen wachsenden Zeitraum komplett gesperrt — Input-Feld + Entsperren-Button disabled, Countdown läuft. Während des Freezes ist die **einzige** Möglichkeit reinzukommen die Master-Key-Recovery.

Eskalation (per 3er-Block):

| Block | Falsch-Eingaben | Freeze-Dauer |
|---|---|---|
| 1 | 3 | 1 Min |
| 2 | 6 | 3 Min |
| 3 | 9 | 5 Min |
| 4 | 12 | 10 Min |
| 5 | 15 | 20 Min |
| 6 | 18 | 40 Min |
| 7 | 21 | 80 Min |
| n ≥ 4 | 3·n | 5 · 2^(n−3) Min |

Implementiert in `freezeDurationMs(totalWrongAttempts)`. Zähler `wrongAttempts` ist kumulativ über die ganze Lebenszeit der Sperre — kein Reset zwischen Freezes, sondern erst bei erfolgreicher Entsperrung (richtiger Code ODER Master-Key-Recovery) ODER beim Ändern/Entfernen der Sperre in Settings.

**Persistenz:** `wrongAttempts` und `freezeUntil` liegen in `localStorage`, überleben Safari-Close und PWA-Neustart. Ein Angreifer kann den Freeze nicht durch App-Neustart umgehen.

**UI-Verhalten während Freeze:**
- Beim Anzeigen des Lock-Screens (`showLockScreen()`) wird der aktuelle Freeze-Status sofort geprüft und die UI entsprechend gesetzt.
- Ein `setInterval` aktualisiert den Countdown sekündlich; läuft ab und gibt die Eingabe wieder frei.
- Master-Key-Eingabefeld (`#lock-recovery-input`) bleibt vom Freeze unberührt — Robert wollte das explizit so.

### Bekannte Grenzen / explizit dokumentierte Schwächen

Da das Repo privat ist, hier transparent die Schwachstellen:

1. **Pure UI-Sperre, keine Datenverschlüsselung.** Trades liegen unverschlüsselt in `localStorage`. Wer Safari-Developer-Tools öffnet (Mac angeschlossen + Web-Inspector), kommt direkt an die Daten ran, ohne den Lock-Screen passieren zu müssen.

2. **Lock kann durch Storage-Manipulation umgangen werden.** Wer den `lockSettings.hash` Eintrag in `localStorage` löscht (Safari Devtools → Application → Local Storage), kommt beim nächsten Boot ohne Code rein.

3. **Brute-Force gegen 4-stelligen PIN ist trivial offline.** Wer den Hash hat (siehe Punkt 2), kann 10.000 PINs in unter einer Sekunde durchprobieren. Da hilft kein PBKDF2, weil der Lock selbst nicht zur Datenverschlüsselung genutzt wird — der Angreifer braucht den Hash gar nicht zu knacken, er löscht ihn einfach. **Aber:** UI-Brute-Force durch wiederholtes Tippen am Lock-Screen wird durch die Freeze-Eskalation (siehe Brute-Force-Schutz-Abschnitt oben) so weit verlangsamt, dass selbst der einfachste 4-stellige PIN unzumutbar lange dauert. Der Schutz greift nur gegen casual snoopers, nicht gegen Devtools-Angreifer.

   Devtools-Angreifer kann auch den Brute-Force-Zähler in `pair_trade_lock_attempts_v1` löschen, um den Freeze zu umgehen. Konsistent mit dem Rest des Threat-Models.

4. **Recovery-Pfad ist nur ein UX-Komfort, keine zweite Schutzschicht.** Der Master-Key liegt im gleichen `localStorage` wie der Lock-Hash. Wer eines lesen kann, kann beides lesen. Der Recovery-Button ist nur dazu da, dass der User selbst (mit Passwort-Manager + Face ID Auto-Fill) bei vergessenem Code wieder reinkommt. Er erhöht NICHT die Sicherheit gegenüber einem technisch versierten Angreifer.

5. **Worker und Telegram-Bot wissen nichts vom Lock.** Die App-Sperre ist rein clientseitig. Damit hat sie keinen Einfluss auf:
   - Alarm-Cron alle 3 Min läuft weiter
   - Telegram-Alarme werden weiter verschickt
   - Telegram-Acknowledge funktioniert weiter
   
   Heißt: wer dein Telegram-Konto klaut, bekommt nach wie vor deine Alarme zu sehen. Schutz dort liegt bei Telegram selbst.

### Bewusste Design-Entscheidungen

- **Lock-Settings + Brute-Force-Zähler werden nie in JSONBin synct.** Beide Storage-Keys (`pair_trade_lock_v1` und `pair_trade_lock_attempts_v1`) sind strikt pro Gerät. Begründung: das iPhone wird realistisch eher geklaut als das MacBook — also soll der User pro Gerät entscheiden können, ob er eine Sperre braucht. Beispielsweise: iPhone aktiv mit PIN, MacBook ohne Sperre. Auch ein laufender Freeze am iPhone wirkt nicht aufs MacBook.
- Lock-Screen feuert beim Boot **bevor** `loadStorage()`/`render()` aufgerufen werden — keine Flash der gecachten Trade-Daten hinter dem Lock.
- 30-Sek-Hintergrund-Schwelle (`LOCK_RELOCK_MS`), nicht sofort. Schnelles Wechseln zur Telegram-App und zurück soll nicht jedes Mal sperren.
- Eingabe-Felder iOS-spezifisch (über `applyInputModeForCode()`):
  - PIN: `type="text" inputmode="numeric" pattern="[0-9]*"` zeigt den sauberen Ziffern-Keypad (nicht den Telefon-Dial-Pad mit `*` und `#`). Visuelles Maskieren über CSS-Klasse `pin-mask` (`-webkit-text-security: disc`). Autocomplete `one-time-code` damit Safari keine gespeicherten Passwörter vorschlägt.
  - Passwort: `type="password"` mit nativer iOS-Maskierung und vollem Alpha-Keyboard.
- Lock-Commit ist atomar (dedizierter Button), Haupt-Save berührt die Lock-Settings nicht.
- Recovery-Sektion ist beim Öffnen des Lock-Screens immer kollabiert. Der User muss aktiv auf den „Passwort vergessen?"-Link tippen, damit das Master-Key-Feld auftaucht.

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

11. **Master-Key + Bin-ID extern sichern:** liegen zwar in `localStorage` und müssen nicht jedes Mal eingetippt werden, aber wer den Lock-Code vergessen hat UND keinen Backup des Master-Keys hat (z. B. Passwort-Manager), kommt über den Recovery-Pfad nicht rein. Die einzige Fallback-Option ist dann das vollständige Löschen der Safari-Site-Daten — was ALLE Settings wegnimmt, der Sync zieht die Trades zwar wieder zurück, aber Heimat-Währung, Theme, etc. müssen neu konfiguriert werden.

12. **App-Sperre ist UI-Schutz, keine Verschlüsselung:** Trades liegen unverschlüsselt in `localStorage`. Wer Safari Devtools öffnet oder den `lockSettings.hash` aus localStorage löscht, umgeht die Sperre vollständig. Schutz nur gegen Casual-Snooping (jemand schaut kurz aufs offene Handy).

13. **Worker und Bot kennen die App-Sperre nicht:** Telegram-Alarme laufen unabhängig von der App-Session. Wenn der Cron einen Alarm feuert, kriegt der User die Telegram-Nachricht, egal ob die PWA gerade offen ist oder nicht, egal ob die App gesperrt ist oder nicht. Der Bot ist nur an JSONBin angedockt.

14. **Master-Key-Recovery setzt vorhandene Sync-Config voraus:** Wenn der User die Sperre aktiviert hat OHNE jemals Sync zu konfigurieren (also `syncSettings.apiKey` ist leer), bringt der „Passwort vergessen"-Pfad nichts — es gibt keinen Master-Key zum Verifizieren. Der Lock-Screen zeigt dann „Kein Master-Key gespeichert". In diesem Edge-Case muss der User Safari-Site-Daten löschen.

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
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (State-Machine, Pfadunabhängigkeit, Tranche-Modell, Trade-Typ-Isolation, Pct/Preis-Mode, Lock-Boot-Reihenfolge) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: beide Seiten gleichzeitig anpassen, Worker zuerst deployen
4. Bei neuen sensiblen Daten (z.B. weitere Credentials): überlege, ob sie an Worker/Bot exponiert sein dürfen. Lock-Settings und alles Lock-bezogene bleibt rein clientseitig.
5. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk.
