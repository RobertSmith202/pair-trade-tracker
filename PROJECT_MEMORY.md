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
- **Körbe (Baskets)** auf den Long- und Short-Pages: Ordner-artige Gruppierungen mehrerer Trades mit aggregierter Performance und eigenen Aggregat-Alarmen (nur Pct, kein Preis-Mode). Modal-Detailansicht statt eigene Page. Trades in einem Korb erscheinen NICHT in der Standalone-Liste der Page (verschoben in den Korb), zählen aber natürlich weiterhin im Gesamt-Aggregat der Page mit.
- Cloud-Sync zwischen iPhone und Mac über JSONBin
- **Drei Alarm-Typen** pro Trade via Telegram-Bot:
  - **Verlust** — 3-Min-Repeat bis Quittung
  - **Gewinn** — 30-Min-Repeat bis Quittung
  - **Short-Squeeze** — 1× pro Tag bis Quittung. Nur für short-only und pair-Trades, überwacht den shortTicker. Yahoo `quoteSummary/defaultKeyStatistics` als Datenquelle, brauchbar nur für US-Werte (Non-US-Warnung in der UI).
- Bei Single-Leg-Trades (Long / Short) zusätzlich: Verlust/Gewinn-Schwelle wahlweise als Prozentwert oder als absoluter Preis in der Notierungswährung des Tickers
- **Soft-Warnung beim Speichern** wenn eine eingegebene Verlust- oder Gewinn-Schwelle bereits durch den aktuellen Kurs verletzt wäre
- **Optionale App-Sperre** (PIN oder Passwort) — Lock-Screen bei jedem App-Öffnen und nach 30 Sek. im Hintergrund. Pro Gerät einstellbar, nicht synced.
- **Brute-Force-Schutz**: Eskalierende Eingabe-Freezes nach je 3 falschen Versuchen (1/3/5 Min, dann Verdopplung). Während Freeze nur Master-Key-Recovery möglich.
- **Master-Key-Recovery** auf dem Lock-Screen: bei vergessenem Code per JSONBin Master-Key entsperren
- Zwei Sprachen (DE, EN) — geräteabhängig
- Drei Themes (Mitternacht / Hell / Dunkel) — geräteabhängig
- **Zwei Layout-Modi (Handy / Desktop)** — geräteabhängig. Mobile = klassische iPhone-Optik (Snap-Scroll, einspaltig). Desktop = Bloomberg-Style mit linker Sidebar, Pfeiltasten-Navigation, iOS-Control-Center-Page-Transitions, Multi-Column-Grid-View und Floating-Form-Dialogen.
- **Schriftgrößen-Skalierung** (100/110/120/130%) nur im Desktop-Modus via `zoom`-CSS auf `<html>` — geräteabhängig
- Standard-Page in Settings konfigurierbar — pro Gerät
- Grid/Liste-View-Toggle pro Page (touch-freundlich groß) — pro Gerät
- Keyboard-Shortcuts: **plain `1`/`2`/`3`/`4`** (ohne Modifier) für direkten Page-Switch in allen Layouts. Pfeiltasten **← →** für sequenzielles Page-Durchblättern (Desktop). `?` öffnet eine Shortcut-Übersicht, `Esc` schließt Modals/Forms hierarchisch.
- **Boot ohne Lock-Sperre:** App startet direkt, ohne Welcome-Screen / Progress-Bar / Pentagon-Loader. Der Loader-Pfad lebt nur noch nach einer echten Code-Eingabe (Lock → Code → Pentagon-Loader → App). Ohne echten Auth-Schritt war das Lade-Theater Reibung ohne Funktion. Frühere Intro-Phase (Owl-Wasserzeichen + Tagline + 2.5s Auto-Progress-Bar) wurde entfernt.
- **Empty-State-Illustration** mit Owl-SVG + page-spezifischem Titel + Beschreibung + Primary-CTA-Button auf leeren Pages.
- Auto-Refresh jede Minute wenn App im Foreground während Handelszeit (Mo-Fr, 09:00-23:00 Berlin)
- Bloomberg-style Price-Flash-Animationen (grün/rot Hintergrund-Flash bei Kursänderung)

---

## Komponenten und wo sie leben

| Komponente | Wo | Was sie macht |
|---|---|---|
| `index.html` | Cloudflare Pages (deployed) + GitHub-Repo (source) | Single-File PWA, alles drin (HTML + CSS + JS) |
| `cloudflare-worker.js` | Cloudflare Worker (deployed) + GitHub-Repo (source) | Yahoo-Proxy, Cron-Alarm-Engine, Telegram-Webhook |
| JSONBin.io | extern (Free Tier) | Cloud-Sync-Storage (Trades, AlertStates, Sprache) |
| Telegram-Bot | extern | Empfängt Alarm-Nachrichten, sendet Ack |

Deployment: GitHub → Cloudflare Pages (auto-deploy für HTML, kein Build-Step da Single-File), Cloudflare-Worker-Dashboard (manuelles Paste für Worker). Beide Pieces leben jetzt in einer einzigen Cloudflare-Konsole, statt vorher verteilt auf Netlify + Cloudflare.

Historische Notiz: vorher lief das HTML auf Netlify (`rs-pair-tracker.netlify.app`). Wurde Mai 2026 auf Cloudflare Pages migriert weil Netlify-Auto-Deploys wiederholt ausgesetzt hatten — Live-Site war monatelang Versionen hinter dem GitHub-Stand, ohne dass das im Netlify-Dashboard offensichtlich war. Cloudflare Pages zeigt im Dashboard sofort welcher Commit live ist; weniger Mystery.

**Deployment-Reihenfolge bei Worker- und HTML-Änderungen gleichzeitig: immer Worker zuerst.** Der Worker ist rückwärts-kompatibel mit dem alten HTML-Datenformat (fehlende Felder defaulten auf alte Semantik). Das neue HTML hingegen schreibt Felder, die der alte Worker nicht kennt — z.B. `alertMinMode: "price"` mit `alertPctMin: null` würde vom alten Worker als „keine Schwelle gesetzt" interpretiert → Alarm stillschweigend tot.

---

## Storage-Architektur

Alle App-Daten leben in `localStorage` und überleben Safari-Schließen / App-Switcher-Wischen.

| Key | Inhalt |
|---|---|
| `pair_trade_tracker_v2` | Trades + Baskets + AlertStates + lastModified |
| `pair_trade_sync_v1` | JSONBin Master-Key, Bin-ID, enabled-Flag |
| `pair_trade_price_v1` | Worker-URL + Home-Currency |
| `pair_trade_lang_v1` | gewählte Sprache (DE/EN) |
| `pair_trade_theme_v1` | gewähltes Theme (midnight/light/dark) |
| `pair_trade_layout_v1` | Layout-Modus (mobile/desktop) — pro Gerät |
| `pair_trade_font_scale_v1` | Schriftgröße in Prozent (100/110/120/130) — pro Gerät, nur Desktop-wirksam |
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
      "basketId": "b_..." | null,
      "longTicker": "AAPL",
      "shortTicker": "MSFT",
      "alertPctMin": -30,
      "alertPctMax": 50,
      "alertPriceMin": null,
      "alertPriceMax": null,
      "alertMinMode": "pct" | "price",
      "alertMaxMode": "pct" | "price",
      "alertShortPct": 25,
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
  "baskets": [
    {
      "id": "b_...",
      "type": "long" | "short",
      "name": "Tech-Longs",
      "alertPctMin": -25,
      "alertPctMax": 40,
      "created": 1715432000000,
      "updated": 1715432000000
    }
  ],
  "alertStates": {
    "<trade-id-or-basket-id>": {
      "min":     { "state": "idle" | "triggered"  | "acknowledged", "lastAlertAt": <ms> },
      "max":     { "state": "idle" | "notified"   | "acknowledged", "lastAlertAt": <ms> },
      "squeeze": { "state": "idle" | "triggered"  | "acknowledged", "lastAlertAt": <ms> }
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
- `alertShortPct` (positive Prozentzahl) ist die jüngste Erweiterung. Nur ausgewertet wenn `type === "short" || "pair"`. Speicherung intern als `Math.abs(input)`. Fehlt das Feld → kein Squeeze-Alarm.
- `alertStates` hatte mehrere Inkarnationen:
  1. Legacy flach: `{state, lastAlertAt}` (nur Loss-Alarm)
  2. Zwei-Schwellen: `{min: {...}, max: {...}}`
  3. Aktuell: `{min: {...}, max: {...}, squeeze: {...}}`
  
  `ensureStateShape()` im Worker und `alarmStateOf()` im Frontend migrieren transparent on-read. Alle drei Achsen sind unabhängig.
- `tranches` ersetzt die früheren flachen Felder. `migrateTrades()` läuft beim ersten Mal nach Pull.

---

## Wichtige Design-Entscheidungen (das Warum)

### Trade-Typen: pair / long / short

`type` ist Pflichtfeld für jeden Trade (mit Default `"pair"` für Legacy-Daten). Die Type-Wahl im Trade-Formular ist nur bei einem neuen Trade aus der „Gesamt"-Page möglich; auf den dedizierten Pages (Longs, Shorts) ist der Typ vorbelegt. Im Edit-Modus ist der Typ fix.

Für `type: "long"` werden `shortTicker`, `shortQty`, `shortEntry` als `null` / `0` gespeichert, analog umgekehrt. `hasLong(tr)` und `hasShort(tr)` checken die Existenz.

### 4-Page-Layout mit Snap-Scroll

`pages-container` ist ein horizontaler Flex-Container mit `scroll-snap-type: x mandatory`. Reihenfolge fix: `["pair", "long", "short", "total"]`. Settings „Standard-Page" bestimmt, welche beim App-Start aktiv ist.

### Layout-Modus: Handy vs. Desktop (Ebene 3)

Die App existiert in **zwei strukturell unterschiedlichen Layout-Modi**, umschaltbar in Settings → „Ansicht". Speicherung in `pair_trade_layout_v1`, **geräteabhängig** (nicht synct über JSONBin). Boot-Default ist `mobile`.

Der Layout-Modus wird an `<html data-layout="mobile|desktop">` angeheftet. Alle Desktop-spezifischen CSS-Regeln sind unter `[data-layout="desktop"]` gescoped — der Mobile-Pfad bleibt pixelgenau unverändert.

**Mobile-Modus** (Default, identisch zur ursprünglichen iPhone-PWA):
- Body `max-width: 640px`, mittig zentriert
- Horizontaler Snap-Scroll zwischen den 4 Pages über `pages-container` mit `overflow-x: auto; scroll-snap-type: x mandatory`
- Page-Dots am unteren Bildschirmrand
- Sticky-Toolbar oben mit `+ Neuer Trade`, `↻ Kurse`, Menü-Button
- Forms (Trade-, Korb-Form) als Inline-Expand unter der Toolbar
- Basket-Modal als Vollbild-Overlay
- Page-Wechsel via Swipe (Touch), Klick auf Dots, oder Ziffer `1`/`2`/`3`/`4` (ohne Modifier)

**Desktop-Modus** (Ebene 3 — drei iterative Layout-Levels wurden gebaut, Ebene 3 ist der finale Stand):
- Body `max-width: none; padding-left: 220px; overflow: hidden` — Body selbst scrollt nicht mehr
- **Linke Sidebar** (`<aside class="desktop-sidebar">`, position-fixed, 220px breit) mit:
  - Brand-Block (Logo + „Pair Trade Tracker")
  - Vertikale Page-Nav (4 Buttons mit farbcodierten Glyphen ▲ ▼)
  - Primary-Action `+ Neuer Trade`, neutraler `↻ Kurse`
  - Status-Block (Status / Auto / Sync) als Key-Value-Zeilen — wird via MutationObserver aus den bestehenden `#status`, `#auto-status`, `#sync-status` Elementen gespiegelt
  - Footer-Button `⚙ Einstellungen`
- **Pages-Container `position: fixed`** mit `top: 0; right: 0; bottom: 0; left: 220px` — füllt den Viewport rechts neben der Sidebar
- **Jede `.page` ist ein eigener Scroll-Container** (`position: absolute; inset: 0; overflow-y: auto`). Body-Höhe ändert sich nie beim Page-Wechsel → kein Scroll-Jitter
- `scrollbar-gutter: stable` reserviert konstant Platz für die Scrollbar
- **iOS-Control-Center-Style synchronisierte Slide-Transitions** beim Page-Wechsel:
  - Vorwärts (next): alte Page `translateY(0 → -100%)`, neue Page `translateY(100% → 0)` — beide synchron, alte schiebt nach oben raus, neue kommt von unten rein
  - Rückwärts (prev): alte slidet nach unten raus, neue von oben rein
  - 280ms mit `cubic-bezier(0.16, 1, 0.3, 1)` (easeOutExpo)
  - `translate3d` statt `translateY` für GPU-Compositing-Layer
  - `.page.active-page` Klasse für die sichtbare Page, `.page.leaving` während der Übergangsphase
  - JS koordiniert: `activateDesktopPage(pageKey, direction)` setzt `data-direction` attribut VOR der `active-page`-Klasse, damit CSS die richtige Keyframe-Sequence wählt; AnimationEnd-Listener räumt `.leaving` auf
- **Pfeiltasten-Navigation:** ← / → triggert `scrollToPage(prev/next)`. Guards: nicht in Inputs/Textareas, nicht wenn ein Modal offen ist, keine Modifier-Kombos
- **Trackpad-Wheel-Hijack wurde bewusst entfernt** — eine frühere Version hat Wheel-Events am Page-Boundary abgefangen und Page-Switches getriggert. Das hat aber legitimes Scrollen durch lange Trade-Listen blockiert (am Ende → automatischer Page-Wechsel). Ersetzt durch Pfeiltasten als bewusste Navigation
- **`.page > *` Content-Constraint:** `max-width: min(1100px, 100%); margin-left: 0; margin-right: auto` — alle direkten Page-Children (Page-Head, Aggregate, Trade-Liste, Total-Breakdown, Donut, Basket-Cards) landen in derselben Spalte links-aligned, identische Breite. Verhindert Cmd+/- Zoom-Probleme und gibt eine konsistente Lesespalte
- **Multi-Column Trade-Grid:** in Grid-View `display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))` mit max-width 1080px → 3 Karten nebeneinander auf breiten Displays
- **Forms als zentrierte Floating-Dialoge** statt Inline-Expand: `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); max-width: 600px`. Backdrop via `body:has(.form-card.open)::before`
- **Owl-Watermark im Desktop-Modus ausgeblendet** (`body::before { display: none }`) — wirkt im breiteren Layout zu dominant. Lock-Screen behält den Owl
- Toolbar im Desktop-Modus komplett verborgen (Sidebar übernimmt deren Funktionen)

**Layout-Switch im laufenden Betrieb** (`applyLayout(v)`):
- Setzt `data-layout`-Attribut auf `<html>`
- Beim Switch zu Mobile: räumt alle `.active-page`-Klassen ab (sonst hängt Snap-Scroll an falscher Position)
- Beim Switch zu Desktop: `scrollToPage(currentPage, false)` aktiviert die richtige Page mit `.active-page`
- Ruft `applyFontScale()` neu auf — Zoom greift nur im Desktop-Modus

### Schriftgrößen-Skalierung (Desktop)

Eigener Settings-Block „Schriftgröße (Desktop)" mit 4 Card-Buttons: Klein/Mittel/Groß/XL = 100/110/120/130 Prozent. Persistiert in `pair_trade_font_scale_v1`, geräteabhängig.

`applyFontScale(v)` setzt `document.documentElement.style.zoom = (parseInt(v) / 100)` — aber **nur wenn `data-layout === "desktop"`**. Im Mobile-Modus wird das Inline-Zoom auf leer gesetzt. Damit bleibt das iPhone-Layout in nativer Größe, während der Mac auf 110-130% skalieren kann.

CSS `zoom` skaliert layout-uniform (Schrift + Padding + Sidebar-Breite + Spacing) — fühlt sich an wie Browser-Zoom, ist aber an die App gebunden. Browser-Kompatibilität: Chrome/Safari seit jeher, Firefox seit 126 (Mai 2024).

### Boot ohne Lock — direkt in die App

Wenn `!lockSettings.enabled || !lockSettings.hash`: Boot-Logic setzt `appUnlocked = true` und ruft sofort `loadStorage()` + `render()` auf. **Kein Welcome-Screen, kein Progress-Bar, kein Pentagon-Loader.** Begründung: ohne echten Auth-Schritt ist die „wird geladen"-Visualisierung Theater — Refresh und Sync laufen ohnehin im Hintergrund über die normalen `refreshAll()` / `syncFull()` Aufrufe im Boot-Path (direkt nach `render()`).

Frühere Intro-Phase (`showIntroScreen()` / `dismissIntroScreen()`, `<div class="intro-screen">` HTML, intro-screen-CSS, `INTRO_AUTO_DISMISS_MS`, `introState`) wurde vollständig entfernt — keine Dead-Code-Reste. Wenn jemand den Welcome wiederhaben will: Git-History nach „intro-screen" durchsuchen, der Block ist atomar wiederherstellbar.

**Lock-Pfad bleibt unverändert:** Lock-Screen → Code-Eingabe → `unlockWithLoader()` → Pentagon-Hexagon-Loader 1500ms + 360ms Fade → App. Hier macht der Loader Sinn, weil tatsächlich ein Auth-Schritt + Sync/Refresh parallel laufen.

### Desktop-Visual-Polish (gelandet)

- **Typografie-Hierarchie deutlich hochskaliert** (nur unter `[data-layout="desktop"]`, Mobile pixelgenau unverändert):
  - `.page-title` 30 → 42px, letter-spacing −0.9px
  - `.agg-cell .value` 22 → 32px, `.agg-cell.wide .value` 28 → 48px (Hero-Stat)
  - `.aggregate` Padding 16 → 22/26px, Radius 14 → 16px
  - `.trade-perf .pnl-abs` 22 → 26px, `.pnl-pct` 18 → 20px
  - Trade-Card-Padding 14 → 16/18px, Radius 14 → 16px
- **Sidebar-Restructure (HTML-Reihenfolge):** Brand → Status-Block → Nav → Divider → Actions → Spacer → Footer. Status sitzt jetzt im Top-Third statt unten.
- **Sidebar-Status-Block visuell:** eigene Card (`var(--bg)` BG + Border + 10px Radius). Pro Zeile Status-Dot (`.ds-status-dot.ok|err|warn|off`) als Glance-Signal links, dann Label, dann Wert rechts. `mirrorStatusToSidebar()` synct sowohl Text als auch State (`.ok` / `.err` / `.warn` / `.off`) in Dot UND Value-Span.
- **Sidebar-Nav aktiver State:** linker 3px-Akzent-Balken via `.ds-nav-btn::before` (background `var(--info)`) — vorher nur dezenter Border, kaum sichtbar.
- **Sidebar-Nav Tastatur-Hints:** jeder Nav-Button hat ein `<kbd class="ds-nav-kbd">1..4</kbd>` rechts. Macht die existierenden Plain-Ziffern-Shortcuts discoverable. Active-Button bekommt einen kontrastierten Card-Background im Kbd.
- **`data-i18n` runter vom Nav-Button selber** (nur noch auf `<span class="ds-nav-label">` innen). Vorher war es auch auf dem `<button>`-Element, was beim Sprachwechsel via `applyTranslations()` (`textContent = t(key)`) den Glyph + Kbd weggewischt hätte. Latenter Bug — beim Layout-Wechsel oder Sprachwechsel war die Sidebar potentiell kaputt.
- **Floating Desktop-Header-Meta** (`.desktop-header-meta` oben rechts, position fixed): Markt-Offen-Indikator (Dot + Label „MARKT OFFEN / ZU") + Uhrzeit HH:MM. Permanent sichtbar. Auf Mobile via `display:none`. Update über `updateDesktopHeaderMeta()`, getriggert durch `setAutoStatus()` (das wiederum von `setInterval(setAutoStatus, 60000)` und dem Auto-Refresh-Loop aufgerufen wird). i18n: `dhm_market_open` / `dhm_market_closed`.
- **Page-Transitions auf Desktop**: 280ms iOS-Control-Center-Slide → 120ms simple Opacity-Fade (`@keyframes pageFadeIn` / `pageFadeOut`). Direction-agnostisch, kein translate3d mehr. Die alten Keyframes `pageEnterFromBelow / pageEnterFromAbove / pageLeaveToAbove / pageLeaveToBelow` sind noch definiert (für Backward-Compat), werden aber per Spezifität von den neuen Regeln überschrieben. Mobile-Snap-Scroll unangetastet.
- **Trade-Card-Hover**: jetzt `border-color: rgba(127,192,238,0.45)` (info-tint) zusätzlich zum bestehenden Box-Shadow. Subtile Affordance.
- **Tabular-Nums hart erzwungen** auf allen Zahlen-Spalten unter Desktop (`.trade-row-pnl`, `.trade-row-pct`, `.trade-perf .pnl-abs/.pnl-pct`, `.agg-cell .value`, `.leg .v`, `.ds-status-value`) — Zahlen stehen über Cards hinweg in derselben Pixel-Spalte, scanbar.
- **Brand-Mark** 26 → 28px, Brand-Title 13 → 14px, Layout etwas atmender.

**Zweiter Polish-Pass (gelandet)** — reine Kosmetik + Bugs, keine neuen Features:

- **CSS-Konflikt behoben:** zwei konkurrierende `[data-layout="desktop"] body { max-width: ... }`-Regeln (eine `none`, eine `1280px`) — die zweite hatte die erste überschrieben und ergab effektiv einen zentrierten 1280px-Body statt full-bleed mit Sidebar. Zweite Regel entfernt.
- **Tab-Bar Ebene 2 entfernt:** `<div class="desktop-tabs">` HTML-Block, `.desktop-tabs`/`.dt-btn`-CSS, zugehörige JS-Click-Handler und Active-State-Sync — alles raus. Sidebar (Ebene 3) ist der einzige Page-Switch-Mechanismus auf Desktop. Mobile bleibt Snap-Scroll. Die drei nebeneinander koexistierenden Layout-Ebenen aus der iterativen Entwicklung sind damit auf zwei reduziert (Mobile + Sidebar-Desktop).
- **Midnight + Dark Theme Soft-Backgrounds aufgehellt:** `--pos-soft` von `#0c1d12` → `#15301f` (Midnight) bzw. `#102315` → `#1f3a26` (Dark); `--neg-soft` analog. Vorher fast identisch zur Card-Background-Luminanz, der `.leg.long`/`.leg.short`-Färbung war praktisch wirkungslos.
- **Brand-Block aufgewertet:** Logo `⌬` jetzt in einer 36×36px-Box mit eigenem Background + Border (statt nackt). Wirkt mehr nach Brand, weniger nach noch-ein-Sidebar-Item.
- **Content-Cap 1100px → 1280px:** `.page > * max-width` plus Basket-Modal-Inhalt. Gewinnt 180px Lesespalte auf 1440px+ Displays. Auf 1440 mit 220px Sidebar bleibt der effektive Cap durch den Viewport gebunden (1220), auf 1920 wirkt's voll.
- **Trade-Row Spalten-Alignment (Desktop):** vorher `grid-template-columns: 1fr auto auto` — PnL-Spalte schwamm je nach Ticker-Name. Jetzt `minmax(0, 1fr) 180px 96px` plus 16px column-gap. Zahlen stehen über mehrere Trades hinweg in derselben Pixel-Spalte, scanbar.
- **Leg-Row-Werte (Desktop):** `.leg .row .v` bekommt `min-width: 90px` für visuelle Stabilität wenn Label-Längen unterschiedlich sind.

**Was bewusst NICHT angefasst wurde** (würde Layout-Architektur tangieren oder ist ein Feature, kein Polish):
- 220px Sidebar-Breite
- 4-Page-Snap-Navigation
- Sticky Page-Header beim Scrollen
- Owl-Watermark-Lücke auf Desktop (deliberat per Design-Entscheidung, siehe oben)
- CSS `zoom` für Font-Scale (funktional korrekt, nur stilistisch hackig)
- Mobile-Layout (überhaupt)
- Worker / Sync / Storage / Alarm-Logik
- Sparklines, Heute-Delta, FX-Rate-Block (alles Feature-Erweiterungen)

### Keyboard-Shortcut-Overlay

**Trigger:** `?` (= Shift+/) öffnet ein modales Overlay mit allen Tastatur-Kürzeln. `Esc` oder erneut `?` schließt. Click auf Backdrop schließt.

**Inhalt** in zwei Spalten (Navigation / Allgemein):
- ← →: Page zurück / weiter (nur Desktop)
- `1`/`2`/`3`/`4`: direkter Page-Sprung (alle Layouts, **ohne Modifier**)
- `?`: dieses Overlay
- `Esc`: Modal/Form schließen
- `Enter`: Intro-Screen überspringen

**Visual-Design:** Gestylte `<kbd>`-Elemente mit dünnen Borders, verstärkter Unterkante (wie echte Tastatur-Caps), monospace-mäßiger Höhe. Mac-Symbol-Glyphen (⌘, ⇧) werden NICHT benutzt seit der Umstellung auf modifier-freie Shortcuts.

**Esc-Hierarchie** für sauberes Schließen mehrerer offener Layer:
1. Shortcut-Overlay (höchste Priorität)
2. Trade-Form (`.form-card.open`)
3. Korb-Form (`#basket-form.open`)
4. Basket-Modal (`.basket-modal.open`)
5. Settings-Modal (`#settings-modal.open`)

Esc tastet sich von oben nach unten durch — das erste offene Element wird geschlossen, Event-Propagation stoppt.

### Keyboard-Shortcuts: warum ohne Modifier

**Originalplan** war `Cmd+Shift+1..4` für Page-Switch. Das hat folgende Konflikte:
- `Cmd+Shift+3` = macOS-Vollbild-Screenshot (OS-Level, kann Browser nicht überschreiben)
- `Cmd+Shift+4` = macOS-Bereichs-Screenshot
- `Cmd+1`, `Cmd+2` etc. = Browser-Tab-Switching

**Lösung:** Plain Ziffern `1`/`2`/`3`/`4` ohne irgendeinen Modifier. Funktioniert weil:
- Kein OS-Konflikt
- Kein Browser-Konflikt
- Guard `isTypingTarget()` verhindert dass die Ziffer einen Trade-Input überschreibt
- Guard `isAnyOverlayOpen()` verhindert Page-Switch wenn ein Modal/Form/Lock offen ist

Implementiert in einem einzigen `window.addEventListener("keydown")` der auch ← → (nur Desktop), `?` (Shortcut-Overlay-Toggle), `Esc` (Modal-Close-Hierarchie) handelt. Alle Guards laufen vor jedem Action-Branch.

### Empty-State-Illustration

Wenn eine Page (Pair/Long/Short/Total) ohne Trades ist: statt nur „Noch keine Trades"-Text rendert `renderEmptyState(pageKey)` eine zentrierte Box mit:
- Inline-Owl-SVG-Symbol (~64×64, opacity 0.4) — gleiche Pfade wie das Watermark aber als sichtbares Element
- Page-spezifischer Titel („Noch keine Pair-Trades" etc.)
- Beschreibung mit relevanten Konzepten (Körbe, Squeeze-Monitoring, Spreads etc.) — kann `<kbd>` und `<strong>`-Tags enthalten weil's via Template-Literal in `innerHTML` rendert
- Primary CTA-Button „+ Ersten Pair-Trade anlegen" — setzt `currentPage` auf den Page-Type und ruft `openForm(null)` auf

**Total-Page hat KEINEN CTA-Button**, weil sie ein Aggregat ist und kein direkter Anlegepunkt. Stattdessen: „Wechsle auf eine der Pages..." mit `<kbd>?</kbd>`-Hinweis auf die Shortcut-Übersicht.

### i18n-System: `data-i18n` vs. `data-i18n-html`

**`data-i18n="key"`** (Standard): `applyTranslations()` setzt `element.textContent = t(key)`. HTML-Tags im String werden literal angezeigt.

**`data-i18n-html="key"`** (Opt-in für Tags): setzt `element.innerHTML = t(key)`. Erlaubt `<kbd>`, `<strong>`, `<em>` in Übersetzungs-Strings. Wird verwendet für:
- `shortcut_note` (enthält `<kbd>`-Tags)
- Andere Strings mit Inline-Markup-Bedarf

**Wichtig:** Beim Hinzufügen neuer i18n-Strings prüfen ob HTML-Tags drin sind. Wenn ja → `data-i18n-html` benutzen, sonst rendert Browser literale `<kbd>`-Texte als Code.

### Super-Trade / Tranchen-Modell — typ-isoliert

Auto-Merge nur bei gleichem Ticker UND gleichem Typ. Ein Long-only AAPL und ein AAPL/MSFT-Pair zählen als unterschiedlich.

**Alarm-Schwelle bei Merges:** Wenn der bestehende Super-Trade bereits eine Schwelle hat (für loss oder profit), wird sie niemals durch eine neue Tranche überschrieben. Nur wenn der bestehende Trade die jeweilige Schwelle leer hatte und die neue eine setzt, übernimmt der Super-Trade die neue (inklusive Mode-Felder).

**Edit-Verhalten bei Multi-Tranche-Trades:** Edit-Form zeigt nur Name und Alarm-Schwellen (Ticker, Quantity, Entry sind disabled). Einzelne Tranchen können über die Tranchen-Detail-Ansicht gelöscht werden.

### Pfadunabhängige Einstands-Währung

Jede Tranche speichert ihre Entry-Currency explizit als `longEntryCcy` / `shortEntryCcy`. Wenn der User später die Heimat-Währung wechselt, bleiben die Entry-Preise korrekt interpretiert.

`longEntryNative` / `shortEntryNative` erlaubt alternativ „verwende die API-Währung des Tickers".

### Körbe (Baskets) — Long-only und Short-only

Körbe sind ordner-artige Gruppierungen von Trades **innerhalb** einer Long- oder Short-Page. Sie existieren NICHT auf der Pair-Page (Pair-Trades sind per Definition schon Gruppierungen).

**Designentscheidungen (von Robert explizit bestätigt):**
1. **Separates `baskets`-Array** im Datenmodell. Trades referenzieren einen Korb optional via `basketId`. Keine doppelte Speicherung.
2. **Modal-Overlay** für die Detail-Ansicht eines Korbs (statt eigene Snap-Page). z-index 800 unter dem Lock-Screen (1000).
3. **Gesamt-Page bleibt unangetastet.** Die Aggregat-Zahlen der Pages (Long, Short, Gesamt) zählen ALLE Trades, unabhängig davon ob sie in einem Korb sind oder nicht — Körbe sind nur eine Sicht-Gruppierung, kein Cashflow-Filter.
4. **Worker-Alarme auf Korb-Aggregat** analog zu Single-Trade-Alarmen, plus pro Trade in Short-Körben optional Squeeze-Alarme (siehe unten).

**Render-Reihenfolge auf Long/Short-Pages:** `+ Neuer Korb`-Button (gestrichelte volle-Breite-Box) zuerst, dann Körbe, dann Standalone-Trades. Körbe sehen aus wie spezielle Cards mit Aggregat-Performance, Trade-Count und Ordner-Icon. Tap öffnet das Modal.

**Korb-Card-Layout (parallel zur Trade-Card für visuelle Konsistenz):**
- Row 1 (Head): Korb-Icon + Name + Alarm-Pills (rechts via separater `<div class="basket-card-pills">`). Pills sitzen rechts, weil `.basket-card-name` `flex: 1` hat und alle Sibling-Elemente nach rechts drückt — gleicher Mechanismus wie bei `.trade-row-line1` mit Pills.
- Row 2 (Werte): Count-Chip links, dann `<div class="basket-card-vals">` rechts mit PnL + Pct-Chip + Bearbeiten-Button + ×-Button + Pfeil-Arrow. Damit liegen Aktionen und Werte auf derselben Höhe wie bei Trade-Cards.
- (Nur Grid-View) Row 3+ als `.basket-card-extra`: Notional + Typ-Meta, Alarm-Status-Zeilen, Top-3-Trades nach |Performance|. In List-View per CSS versteckt.
- In **List-View** zusätzlich getönter Vertikal-Gradient als Background (`var(--pos-bg)` → `var(--pos-soft)` für Long, `var(--neg-bg)` → `var(--neg-soft)` für Short) + verstärkter Box-Shadow, damit Körbe sich elegant von Standalone-Trades absetzen.

**Korb-Card Edit/Delete-Buttons** verwenden die Standard-`.icon`/`.icon.danger`-Klassen (`padding: 8px 12px; min-height: 0; font-size: 12px`) — pixelgenau identisch zu den Trade-Card-Buttons. JS-Selektoren laufen über `[data-basket-edit]`/`[data-basket-del]` data-attributes, nicht über die Klassen, damit Styling und Logik entkoppelt sind.

**Geschichte des `+ Neuer Korb`-Buttons** (für Debugging-Kontext, falls Robert nochmal umentscheidet):
1. Erste Iteration: Per-Page-Button (gestrichelte Box auf Long-/Short-Page, zwischen Aggregate und Trade-Liste). **AKTUELLE FORM.**
2. Zweite Iteration: Toolbar-Button als `.primary` in der oberen Bar neben `+ Neuer Trade`, dynamisch ein-/ausgeblendet per Page → wieder verworfen.
3. Dritte Iteration: Sidebar-Button (`.ds-action-primary`) im Desktop-Modus → ebenfalls verworfen.
Die aktuelle Per-Page-Form gewann, weil sie die discoverable-ste und kontextuell sauberste ist (Korb-Action gehört zur Page).

**Korb-Modal-Aufbau:**
- Header: Name + Typ-Pill + Edit-/Schließen-Buttons
- Aggregat-Block: P&L (home ccy), Performance %, Anzahl Trades, Alarm-Pills wenn welche aktiv
- Toolbar: „+ Trade zum Korb" (öffnet Trade-Form mit `tradeFormBasketContext` gesetzt)
- Trade-Liste: alle Trades mit `basketId === currentBasketId`, dieselbe Card-/List-Darstellung wie auf der Page

**Korb-Form (Create/Edit):** Felder Name, Typ (bei Create fix aus Page-Kontext, bei Edit disabled), Loss-Schwelle Pct, Profit-Schwelle Pct. **Bewusst kein Preis-Modus** — ein Korb hat keinen einzelnen quoted Price.

**Trade-Form mit Basket-Kontext (`tradeFormBasketContext` Global):**
- Type-Sektion ausgeblendet (Typ kommt aus dem Korb)
- Loss- und Profit-Alarm-Sektionen ausgeblendet (die Alarme leben am Korb)
- Squeeze-Sektion nur sichtbar bei Short-Körben (für `type === "short"`)
- `closeForm()` resettet den Kontext zwingend, auch beim Abbrechen — sonst hängt der Kontext für den nächsten Form-Aufruf

**Edit-Pfad für bestehende Korb-Trades:** `openForm(id)` checkt `tr.basketId` und setzt den Kontext automatisch, damit die Form-Sektionen konsistent ausgeblendet sind.

**Super-Trade-Auto-Merge im Korb-Kontext:** Auto-Merge ist auf die Korb-Zugehörigkeit konstrainiert. Ein AAPL-Long im Korb X und ein freistehender AAPL-Long werden NICHT gemerged. Der `ctxBasketId`-Filter im `matching = trades.find(...)` Aufruf sorgt dafür.

**Korb-Aggregat (`computeBasket` im Frontend, analog im Worker):**
- Iteriert über alle `trades` mit passendem `basketId`
- Summiert `totalPnlHome` und `totalNotionalHome` aus `computeTrade(...)`
- `pct = totalPnl / totalNotional * 100` wenn beide vorhanden, sonst null
- Wenn kein Trade auswertbar (z.B. alle Live-Preise fehlen): Korb-State unverändert, kein Trigger

**Korb-Alarm-Logik im Worker (`runAlarmCheck`, Basket-Loop nach Trade-Loop):**
1. Filtert alle Trades mit passendem `basketId`
2. Ruft pro Trade `computePerf()` auf — dafür wurde `computePerf` erweitert um `notionalHomeStart` (nötig für saubere Aggregation des Performance-Pct, da `notionalHomeNow / (1 + perfPct/100)` bei FX-bewegungen das falsche Ergebnis liefert)
3. Summiert `pnlHome`, `notionalHomeStart`, `notionalHomeNow` über alle Trades
4. `aggPerfPct = (aggPnl / aggNotStart) * 100`
5. State-Machine identisch zu Single-Trade-Alarmen (3-Min-Repeat für Loss, 30-Min-Repeat für Profit, edge-triggered)
6. `alertStates[basketId]` lebt im gleichen Dict wie Trade-States — IDs kollidieren nicht (`t_…` vs. `b_…`)

**Defensive Doppel-Alarm-Vermeidung:** Wenn ein Trade in einem Korb liegt, **überspringt** der Worker die Loss-/Profit-Alarm-Checks für den Einzeltrade komplett (`if (trade.basketId) continue`) — die laufen dann nur noch über den Korb-Aggregat. Squeeze-Alarme (separater Cron `runShortSqueezeCheck`) bleiben unberührt, weil die explizit pro Trade gewollt sind.

**Telegram-Nachricht für Korb-Alarme (`buildBasketAlarmMessage`):**
- Titel: `🚨 KORB-VERLUST-SCHWELLE ÜBERSCHRITTEN` / `🎯 KORB-GEWINN-SCHWELLE ERREICHT`
- Inhalt: Korb-Name + Typ-Label + Anzahl Trades, Performance %, Schwelle, P&L (home ccy), Notional jetzt (home ccy)
- Ack-Prompt analog zu Trade-Alarmen — eine Reply quittiert alle aktiven Triggered/Notified States über Trades UND Körbe hinweg, weil der Telegram-Webhook über alle `alertStates`-Keys iteriert.

**i18n:** DE/EN-Strings im HTML (`basket_*` Keys: form-Titel, Button-Texte, Aggregat-Labels, Modal-Header, Delete-Confirm) und im Worker `WORKER_STRINGS` (`basket_loss_title`, `basket_profit_title`, `basket_label`, `basket_default_name`).

**Sync:** `baskets` wird in `loadStorage()`, `persistLocal()`, `syncPush()`, `syncPull()` analog zu `trades` mitgeführt. JSONBin enthält jetzt `{trades, baskets, alertStates, lastModified, lang, _device}`.

**View-Modus:** `viewModes` hat einen zusätzlichen Key `basket` für die Trade-Liste innerhalb des Modals. Standalone-Anzeige auf der Page benutzt nach wie vor `viewModes.long` bzw. `viewModes.short`.

**Bekannte Edge-Cases:**
- Korb ohne Trades: zeigt Aggregat als „—", Alarme greifen nicht (kein Trade → `aggNotStart == 0` → `no_data` ohne State-Change).
- Trade aus Korb entfernen: nur via Edit → `basketId` auf null setzen. Es gibt aktuell keinen UI-Shortcut „Trade aus Korb verschieben" — das ist bewusst, weil Verschiebe-Operationen leicht zu Verwirrung führen.
- Korb löschen: zeigt `confirm()` mit Hinweis dass die enthaltenen Trades zu Standalones werden (deren `basketId` wird auf null gesetzt). Trades selbst werden nicht gelöscht.

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

Pro Trade drei unabhängige States im JSONBin (`alertStates[id]`):

- `min`:     `idle → triggered → acknowledged → idle`
- `max`:     `idle → notified  → acknowledged → idle`
- `squeeze`: `idle → triggered → acknowledged → idle`

Edge-triggered: Alarm feuert nur beim Übergang `idle → triggered/notified`. Telegram-Webhook setzt alle gerade aktiven Triggered/Notified Status im JSONBin auf `acknowledged` (eine Reply quittiert auch alles über alle drei Achsen hinweg).

Worker-Konstanten: `ALERT_REPEAT_MS = 3 * 60 * 1000`, `PROFIT_ALERT_REPEAT_MS = 30 * 60 * 1000`. Squeeze hat keinen Repeat-Timer im Code — die einmal-pro-Tag-Cadence ergibt sich implizit aus dem Cron-Schedule.

Crons im Cloudflare-Dashboard:
- `*/3 * * * *` → `runAlarmCheck()` (Loss + Profit)
- `0 6 * * *` → `runShortSqueezeCheck()` (täglicher Squeeze-Check 06:00 UTC)

Die Dispatch-Logik im `scheduled()`-Handler unterscheidet anhand des `event.cron`-Strings.

### Short-Squeeze-Alarm

Tägliche Überprüfung des Short-Interest auf Float für leerverkaufte Positionen. Worker holt einmal pro Tag (06:00 UTC) Yahoo-`quoteSummary/defaultKeyStatistics` für den `shortTicker` jedes betroffenen Trades.

**Wer kriegt einen Squeeze-Alarm?**
- Trade-Typ `short` → überwacht `shortTicker` (= die eigene Short-Position)
- Trade-Typ `pair` → überwacht ebenfalls `shortTicker` (= der leerverkaufte Leg)
- Trade-Typ `long` → **explizit ausgeschlossen.** Im Form ist die Squeeze-Sektion bei Long-only gar nicht sichtbar; selbst wenn ein Long-Trade ein `alertShortPct`-Feld hätte (z.B. nach Type-Wechsel), würde der Worker es überspringen.

**Schwellen-Semantik:** `alertShortPct` ist eine positive Prozentzahl (z.B. `25` für 25 %). Im Save-Pfad wird `Math.abs(input)` gespeichert. Yahoo liefert `shortPercentOfFloat` als Dezimalbruch (0.25); der Worker multipliziert mit 100 und vergleicht direkt.

**Yahoo-Datenquelle und Non-US-Problem:**

Yahoo's `defaultKeyStatistics` füllt `shortPercentOfFloat` zuverlässig nur für **US-gelistete Wertpapiere**. Für EU-/Asia-Tickers (SAP.DE, AIR.PA, RYA.IR etc.) ist das Feld meist null oder veraltet — die offizielle europäische Short-Disclosure-Regulation (ESMA/BaFin/FCA) hat eine ganz andere Struktur (Einzel-Positionen ≥ 0,5 %, kein aggregiertes Short-Interest) und Yahoo aggregiert das nicht zurück.

**Wie geht die App damit um?**
1. **Frontend-Warnung:** `looksLikeNonUsTicker()` checkt auf Punkt-Suffix im shortTicker. Wenn ja, erscheint im Form unter der Squeeze-Schwelle eine deutliche Hinweis-Box: „⚠ Der Short-Ticker hat einen Markt-Suffix — Yahoo liefert für nicht-US-Werte sehr wahrscheinlich keine Short-Interest-Daten." User kann trotzdem speichern (nicht blockiert).
2. **Worker:** Wenn Yahoo `null`/`undefined` für `shortPercentOfFloat` zurückgibt, lässt der Worker den State unverändert (kein Reset auf `idle`, keine Trigger). Das ist eine **Daten-Lücke**, keine „Erholung". Ergebnis-Liste enthält `{kind: "squeeze", action: "no_data"}` für Debug-Zwecke.

**State-Verhalten:**
- `idle` + breached → Telegram-Nachricht, State → `triggered`
- `triggered` + breached → erneute Telegram-Nachricht (nächster Tag), State bleibt `triggered`
- `triggered` + not breached → State → `idle`
- `acknowledged` + breached → keine Aktion (wartet bis Wert unter Schwelle fällt)
- `acknowledged` + not breached → State → `idle` (re-armed für nächste Überschreitung)

**Telegram-Nachricht** ist visuell distinkt:
- Title: `⚡ SHORT-SQUEEZE-ALARM` (statt `🚨 VERLUST-SCHWELLE ÜBERSCHRITTEN` oder `🎯 GEWINN-SCHWELLE ERREICHT`)
- Inhalt: Short-Interest %, Days to Cover, Datenstand-Datum, Schwelle
- Ack-Prompt erwähnt explizit „Wiederholung 1× pro Tag"

**Pill in der App:** ⚡-Icon, orange/gelbe Färbung (über `--warn`), pulsiert bei `triggered`. Klar abgegrenzt von der grünen Profit- und roten Loss-Pill.

**Worker-Endpoint zum manuellen Testen:** `GET /check-squeeze` (analog zu `/check`).

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
| `GET /check` | Manueller Loss/Profit-Alarm-Check (3-Min-Cron ruft intern dasselbe auf) |
| `GET /check-squeeze` | Manueller Short-Squeeze-Check (Tages-Cron ruft intern dasselbe auf) |
| `GET /test-alert` | Sendet Test-Telegram-Nachricht in aktueller Sprache |
| `GET /setup-webhook` | Registriert Worker-URL als Telegram-Webhook-Target |
| `POST /telegram-webhook` | Empfängt User-Replies → setzt alle triggered/notified States (min/max/squeeze) auf acknowledged |

**Cron-Trigger im Cloudflare-Dashboard — BEIDE müssen aktiv sein:**
- `*/3 * * * *` für Loss + Profit (3-Min-Intervall)
- `0 6 * * *` für Short-Squeeze (täglich 06:00 UTC)

Wer den zweiten Cron nach einem Worker-Update vergisst zuzufügen, hat keinen Squeeze-Alarm — der Code ist da, wird aber nie aufgerufen. Manuelles Testen via `/check-squeeze` zeigt, ob die Logik selbst funktioniert.

Backward-Compat im Worker: `getTranches(trade)` erkennt ob ein Trade die neue oder alte Struktur hat. `ensureStateShape()` migriert alte AlertStates on-read (flach → `{min, max}` → `{min, max, squeeze}`). `tradeType()` defaultet auf `"pair"`.

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

3. **Cache zwischen Cloudflare Pages und Cloudflare Worker:** Beim Deploy einer neuen HTML kann der Mac noch eine alte Version sehen. Workaround: Safari-Cache leeren (Cmd+Option+E) und PWA aus Dock neu hinzufügen. Da seit der Migration alles auf Cloudflare läuft (HTML auf Pages, API auf Worker), kann auch CF-Edge-Caching reinspielen — falls's hartnäckig ist, im Pages-Dashboard „Purge cache" anstoßen.

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

15. **Squeeze-Alarm braucht den 2. Cron-Trigger im Cloudflare-Dashboard.** Nur den Code zu deployen reicht nicht — der `scheduled()`-Handler wird sonst nur vom 3-Min-Cron aufgerufen und der Squeeze-Check feuert nie. Manuelles Testen via `/check-squeeze`-Endpoint zeigt, ob die Logik selbst klappt. Robert vergisst das gerne nach Worker-Updates.

16. **Yahoo liefert für nicht-US-Werte keine Short-Interest-Daten.** Der `shortPercentOfFloat` ist bei EU-/Asia-Tickern fast immer `null`. Der Worker reagiert auf `null` mit „state unverändert lassen", nicht mit Reset. Das Frontend zeigt eine deutliche Warnung wenn der Short-Ticker einen Punkt-Suffix hat. Wer trotzdem eine Squeeze-Schwelle für SAP.DE setzt, kriegt nie einen Alarm — das ist erwartet, nicht ein Bug.

17. **Loss-Alarm-Titel wurde umbenannt.** Vorherige Worker-Versionen schickten `🚨 ALARM` als Telegram-Titel. Aktuell: `🚨 VERLUST-SCHWELLE ÜBERSCHRITTEN` (parallel zur Gewinn-Schwelle). Der HTML-Pill/Status zeigt davon unabhängig `🚨 VERLUST-ALARM AUSGELÖST` — die App-Texte wurden bewusst nicht angepasst, weil sie im Kontext der App schon spezifisch genug sind.

18. **Korb-Trades dürfen keine eigenen Loss/Profit-Alarme haben.** UI versteckt die Sektionen wenn `tradeFormBasketContext` gesetzt ist; Worker überspringt den Loss/Profit-Check für alle Trades mit `basketId` (`if (trade.basketId) continue`). Wer einen bestehenden Standalone-Trade mit Alarm später in einen Korb verschiebt (manuell via Edit), behält die Alarm-Werte in den Feldern stehen — der Worker ignoriert sie aber. Squeeze-Alarme sind davon ausgenommen und feuern weiter, weil Robert das für Short-Körbe explizit so wollte.

19. **`computePerf()` im Worker liefert seit Basket-Feature auch `notionalHomeStart`.** Das wird für die saubere Aggregation des Korb-Performance-Pct gebraucht (man kann NICHT einfach Pct-Werte mitteln). Wenn jemand eine ältere Worker-Version deployt, in der `notionalHomeStart` fehlt, geht der Basket-Aggregat-Pct entweder kaputt oder feuert falsch. Worker-Update zuerst, dann HTML — wie immer.

20. **`baskets`-Array muss in allen vier Storage-Pfaden mitgeführt werden:** `loadStorage()`, `persistLocal()`, `syncPush()`, `syncPull()`. Wer einen davon vergisst, verliert Körbe entweder lokal oder beim Sync. Trades selbst überleben das, aber ihre `basketId` zeigt dann ins Leere und sie erscheinen als Standalones.

21. **Body `max-width: 640px` ist der Default für Mobile.** Im Desktop-Modus wird `max-width: none; padding-left: 220px; overflow: hidden` gesetzt. Wer „warum sehe ich auf dem Mac alles in einer schmalen Spalte" debugged: das ist absichtlich für Mobile, und der Layout-Modus muss auf Desktop stehen. CSS-Cache kann nach Layout-Switch noch hartnäckig sein — Cmd+Shift+R für Hard-Reload.

22. **Page-Wechsel-Animation und Render-Pfad sind unterschiedlich pro Layout-Modus.** Mobile nutzt `scrollToPage` mit `container.scrollTo({left: idx*w})` für horizontalen Snap-Scroll. Desktop nutzt `activateDesktopPage(pageKey, direction)` mit Class-Toggle `.active-page` + `.leaving`. Beide Pfade dispatchen vom selben `scrollToPage(pageKey)`-Entry-Point auf Basis des `data-layout`-Attributes. Wer einen Pfad modifiziert, muss prüfen ob's auch im anderen Modus noch funktioniert.

23. ~~Tab-Bar (Ebene 2) existiert noch im DOM~~ — **im zweiten Polish-Pass entfernt.** Der HTML-Block, das CSS und die zugehörigen Click-Handler sind raus. Sidebar (Ebene 3) ist der einzige Desktop-Nav-Mechanismus. Wenn jemand die Tab-Bar wiederbeleben will, muss er sie aus der Git-History rekonstruieren.

24. **CSS `zoom` ist non-standard aber breit unterstützt.** Chrome/Safari schon ewig, Firefox seit 126 (Mai 2024). Auf älteren Firefox-Versionen würde der Font-Scale-Setting visuell nichts tun. Robert verwendet Safari/Chrome — kein Problem in der Praxis.

25. **Desktop-Page-Animation ist seit dem Polish-Pass ein simpler Opacity-Fade (`pageFadeIn` / `pageFadeOut`, 120ms).** Direction-agnostisch — `data-direction` wird in `activateDesktopPage()` weiterhin gesetzt, hat aber CSS-mäßig keine sichtbare Auswirkung mehr (die alten direction-spezifischen Keyframes `pageEnterFromBelow`/`pageEnterFromAbove`/`pageLeaveToAbove`/`pageLeaveToBelow` werden durch die neueren Fade-Regeln überschrieben). Die JS-Logik (data-direction-Setzen vor `.active-page`-Klasse, force-Reflow via `void offsetWidth`) ist defensiv beibehalten, falls jemand die iOS-Slides wieder aktivieren will — dann muss man nur die Fade-Regeln entfernen.

26. **`data-i18n` darf NICHT direkt auf einem Element stehen das Kind-Elemente mit eigenem Inhalt hat.** `applyTranslations()` macht `el.textContent = t(key)` — das wischt ALLE Kinder weg. Beispiel-Bug der vor dem Polish-Pass im Code stand: `<button data-i18n="page_pairs"><span class="ds-nav-glyph">⇄</span><span data-i18n="page_pairs">Paare</span></button>` → nach erstem Sprachwechsel: nur noch "Paare", Glyph weg. Lösung: `data-i18n` nur auf den innersten Text-Span, nicht auf den Wrapper-Button.

27. **`updateDesktopHeaderMeta()` muss alle Stellen aufrufen die den Markt-Offen-Status oder die Uhrzeit visuell ändern können.** Aktuell nur über `setAutoStatus()` (= `setInterval(..., 60000)` + Auto-Refresh-Loop). Wer einen früheren Trigger braucht (z.B. wenn der User die Settings-Modal-Trading-Hours editiert, falls das je hinzukommt), muss `updateDesktopHeaderMeta()` selbst aufrufen.

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
- Setup ist: iPhone als primäres Mobile-Gerät, Mac als Desktop. Beide nutzen die selbe Cloudflare-Pages-URL.
- Telegram-Alarms müssen zuverlässig sein — das ist der Hauptgrund für das ganze Setup, nicht nur die Live-Anzeige.
- Robert pullt die fertigen Dateien aus dem `outputs`-Ordner und committed sie selbst auf GitHub. Manuelle GitHub-Bearbeitung außerhalb der Cowork-Sessions findet nicht statt.
- Repo ist privat — wir können in Dokumentation und Code-Kommentaren transparent über Sicherheits-Grenzen sein, ohne diese einem Angreifer zu offenbaren.

---

## Wenn du diese Datei in einer neuen Session liest

Du bist jetzt informiert genug um Änderungen vorzunehmen. Empfohlenes Vorgehen:

1. Den aktuellen Stand des Codes via WebFetch oder Upload anschauen (Robert lädt typischerweise `index.html`, `cloudflare-worker.js` und diese `PROJECT_MEMORY.md` hoch)
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (State-Machine, Pfadunabhängigkeit, Tranche-Modell, Trade-Typ-Isolation, Pct/Preis-Mode, Lock-Boot-Reihenfolge, **Layout-Mode-Branching in scrollToPage, max-width-Constraint auf `.page > *`**) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: beide Seiten gleichzeitig anpassen, Worker zuerst deployen
4. Bei neuen sensiblen Daten (z.B. weitere Credentials): überlege, ob sie an Worker/Bot exponiert sein dürfen. Lock-Settings und alles Lock-bezogene bleibt rein clientseitig.
5. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk.

**Schnelle Architektur-Karte für Layout-relevante Änderungen:**

| Was | Wo im Code | Mobile-Verhalten | Desktop-Verhalten |
|---|---|---|---|
| Page-Navigation | `scrollToPage(pageKey)` | `container.scrollTo({left: idx*w})` Snap-Scroll | `activateDesktopPage(pageKey, dir)` mit `.active-page`/`.leaving` Class-Toggle |
| Page-Transition | (keine — Snap-Scroll IS die Animation) | — | iOS-Slide via CSS `@keyframes pageEnterFromBelow/Above + pageLeaveToAbove/Below`, 280ms easeOutExpo |
| Page-Container | `display: flex; overflow-x: auto` | sichtbar als horizontale 4-Spalten-Reihe | `position: fixed; left: 220px; overflow: hidden`, Pages sind absolute Inset:0 |
| Page-Scrollbarkeit | Body scrollt | Body hat overflow auto | Body `overflow: hidden`, jede `.page` scrollt intern |
| Navigation-UI | Page-Dots unten | sichtbar | versteckt |
| Sidebar | `.desktop-sidebar` | versteckt (`display: none`) | sichtbar, fixed left, 220px |
| Toolbar | `.toolbar-wrap` | sticky top | versteckt (`display: none`) |
| Forms | `.form-card.open` | Inline-Expand unter Toolbar | Floating-Dialog mit Backdrop via `body:has(.form-card.open)::before` |
| Content-Breite | `body { max-width: 640px; margin: 0 auto }` | aktiv | overridden zu `max-width: none; padding-left: 220px` (eine konkurrierende `body { max-width: 1280px }`-Regel wurde im 2. Polish-Pass entfernt) |
| Page-Child-Spalte | `.page > * { max-width: ... }` | nicht beschränkt | `max-width: min(1280px, 100%); margin-left: 0` (left-aligned, war vorher 1100) |
| Owl-Watermark | `body::before` mit Mask-SVG | sichtbar mit 5% Opacity | versteckt (`display: none !important`) |
| Schriftgröße | `applyFontScale(v)` | wird in Mobile auf leer gesetzt (kein Zoom) | `document.documentElement.style.zoom = v/100` |
| Boot ohne Lock | `appUnlocked = true` direkt | App startet sofort | App startet sofort |
| Boot mit Lock | `showLockScreen()` | Lock + Keypad → Pentagon-Loader → App | Lock + Keypad → Pentagon-Loader → App |
| Page-Shortcuts | `1`/`2`/`3`/`4` keydown | aktiv, ohne Modifier | aktiv, ohne Modifier — Kbd-Pills in Sidebar sichtbar |
| Sequenz-Navigation | `← →` keydown | NICHT aktiv (Swipe ersetzt das) | aktiv |
| Shortcut-Overlay | `?` keydown | aktiv (öffnet Hilfe-Modal) | aktiv (öffnet Hilfe-Modal) |
| Page-Transition | (Snap-Scroll = Animation) | nativ | `@keyframes pageFadeIn/Out` 120ms (vorher 280ms iOS-Slide) |
| Header-Meta (Live) | `.desktop-header-meta` | `display: none` | floating top-right, Markt-Dot + HH:MM Uhr, Update über `updateDesktopHeaderMeta()` |
| Sidebar-Status-Dots | `.ds-status-dot` | nicht relevant (Sidebar versteckt) | farbcodiert via `mirrorStatusToSidebar()` aus `#status`/`#auto-status`/`#sync-status` |

**Robert's typischer Workflow:** Mac für Entwicklung + sitzendes Trading (Desktop-Layout), iPhone für unterwegs + Telegram-Alarme-Acknowledgement (Mobile-Layout). Beide Geräte syncen Trades über JSONBin, aber Layout-Modus, Theme, Sprache, Schriftgröße sind geräteabhängig (pro localStorage, nicht über JSONBin).

**Kritische Konventionen die in einer neuen Session nicht vergessen werden dürfen:**

1. **Layout-Modus ist die wichtigste Verzweigung in der App.** Fast jede UI-Logik branched auf `data-layout="mobile|desktop"`. Bei jeder neuen Funktion fragen: Wie verhält sie sich auf der jeweils anderen Plattform?

2. **Mobile-Layout darf NIE durch Desktop-Polish verschlechtert werden.** Alle Desktop-Regeln sind in `[data-layout="desktop"]`-Selektoren gescoped. Wer das übersieht, bricht das iPhone-Erlebnis.

3. **`scrollToPage(pageKey)` ist der ZENTRALE Page-Switch-Entry-Point.** Sidebar-Klicks, Pfeiltasten, Ziffern-Shortcuts, Empty-State-CTAs — alle gehen hier durch. Branching auf data-layout intern (Snap-Scroll vs. activateDesktopPage).

4. **Tastatur-Shortcuts haben einen einzigen `keydown`-Handler** (in der `setupDesktopArrowKeyNav` IIFE). Reihenfolge der Checks: Esc → ? → Plain 1-4 → Arrow Keys. Jeder Branch hat Guards: `isAnyOverlayOpen`, `isTypingTarget`, Modifier-Checks.

5. **Worker zuerst deployen wenn HTML-Datenmodell sich ändert.** Worker ist rückwärts-kompatibel; HTML ist's nicht (neue Felder, die alter Worker ignoriert → Alarme stillschweigend tot).

6. **PROJECT_MEMORY.md ist Teil des Projekts, nicht Beiwerk.** Bei jeder substanziellen Änderung mitaktualisieren — sonst weiß keine neue Session warum die App so ist wie sie ist.
