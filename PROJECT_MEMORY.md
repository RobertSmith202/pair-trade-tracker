# Pair Trade Tracker — Project Memory

> Zweck: schnelles Onboarding für jede neue Claude-Session, ohne dass der Code komplett gelesen werden muss. Enthält die Architektur, Design-Entscheidungen, Konventionen und die nicht-offensichtlichen Stellen.

---

## Was die App tut

Persönlicher Tracker für Long/Short-Aktien-Trades, der Total-P&L (in EUR absolut und Prozent) anzeigt — etwas das die meisten Broker so nicht bieten. Single-User-Tool für Robert, deployed als PWA (iPhone Homescreen + Mac Dock).

Kern-Features:

- **Drei Trade-Typen**: Paar (Long + Short gemeinsam), nur Long, nur Short — frei wählbar pro Trade
- Manuelle Trade-Eingabe mit Quantity + Entry-Preis (pro Leg)
- Live-Kurs-Updates über Yahoo Finance (via eigenen Cloudflare-Worker-Proxy)
- Multi-Currency mit pfadunabhängiger Einstands-Währung pro Leg
- **Super-Trades:** Automatisches Mergen von Aufstockungen mit gleichem Ticker zu Tranchen — strikt typ-isoliert (siehe unten)
- Cloud-Sync zwischen iPhone und Mac über JSONBin
- Stop-Loss-artige Alarme mit Telegram-Bot ("Haus-Alarm"-Verhalten: alle 3 Min repeat bis quittiert)
- 4 Sprachen (DE, EN, IT, RU) — Sprache geräteabhängig
- Auto-Refresh jede Minute wenn App im Foreground während Handelszeit (Mo-Fr, 09:00-22:55 Berlin)
- Bloomberg-style Price-Flash-Animationen (grün/rot Hintergrund-Flash bei Kursänderung)
- **4 horizontal swipbare Pages** mit eigenen Aggregaten je Trade-Typ
- **Tastatur-Shortcuts** auf Mac (`Cmd+Shift+1..4`) für direktes Springen zu einer Page
- **Theme-Wahl** in den Einstellungen (Auto folgt System / Hell / Dunkel)

---

## Komponenten und wo sie leben

| Komponente | Wo | Was sie macht |
|---|---|---|
| `index.html` | Netlify (deployed) + GitHub-Repo (source) | Single-File PWA, alles drin (HTML + CSS + JS) |
| `cloudflare-worker.js` | Cloudflare Worker (deployed) + GitHub-Repo (source) | Yahoo-Proxy, Cron-Alarm-Engine, Telegram-Webhook |
| JSONBin.io | extern (Free Tier) | Cloud-Sync-Storage (Trades, AlertStates, Sprache) |
| Telegram-Bot | extern | Empfängt Alarm-Nachrichten, sendet Ack |

Deployment: GitHub → Netlify (auto-deploy für HTML), Cloudflare-Dashboard (manuelles Paste für Worker). **WICHTIG bei Updates die das Datenmodell oder Compute-Logik betreffen: erst Worker, dann HTML** — Reihenfolge nicht umkehren, sonst rechnet der alte Worker neue Trade-Typen falsch.

---

## UI-Aufbau: die 4 Pages

Die App zeigt vier horizontal swipbare Pages über einen CSS-`scroll-snap-x mandatory`-Container. Page-Indikator-Dots am unteren Bildschirmrand (`position: fixed`).

| # | Key | Titel | Inhalt |
|---|---|---|---|
| 1 | `pair` | Paare | Alle Trades mit `type === "pair"`, eigene Aggregat-Karte oben, einzelne Trade-Cards darunter |
| 2 | `long` | Longs | Alle Trades mit `type === "long"`, eigene Aggregat-Karte oben, einzelne Trade-Cards darunter |
| 3 | `short` | Shorts | Alle Trades mit `type === "short"`, eigene Aggregat-Karte oben, einzelne Trade-Cards darunter |
| 4 | `total` | Gesamt | Großes Total-Aggregat oben über alle Trades. Darunter **drei Breakdown-Cards** (Paare/Longs/Shorts) mit je P&L/Performance/Notional/Count. **Keine** einzelnen Trade-Karten auf dieser Page. |

Page-Reihenfolge ist hart kodiert in `const PAGES = ["pair", "long", "short", "total"]`. Änderung der Reihenfolge erfordert Code-Edit.

**Standard-Page** beim App-Start: einstellbar in Settings (`pair_trade_start_page_v1`-Key, lokal pro Gerät, Default `pair`). Beim Sync **nicht** übertragen — analog zur Sprach-Logik.

**Navigation:**
- Wischen (Touch/Trackpad) — `scroll-snap` mit `scroll-snap-stop: always`
- Tap auf Page-Dot — direkter Sprung mit Smooth-Scroll
- **Tastatur-Shortcut**: `Cmd+Shift+1..4` auf Mac, `Ctrl+Shift+1..4` auf anderen Plattformen. Globaler `keydown`-Listener mit `capture: true` + `preventDefault`. **Implementation-Detail:** Listener nutzt `e.code` (Layout-unabhängig: `"Digit1".."Digit4"`) statt `e.key` — mit gedrückter Shift-Taste wäre `e.key` das Sonderzeichen (`"!"`, `'"'`, `"§"`, `"$"` je nach Layout). Ignoriert Events aus Input/Textarea/Select, damit Form-Eingaben nicht abgegriffen werden.
- **macOS-Konflikt bei Cmd+Shift+3 und Cmd+Shift+4:** beide sind systemweit für Screenshots reserviert. macOS fängt die Events ab, bevor sie überhaupt zum Browser kommen → JavaScript-Listener feuert nicht. Workaround entweder a) die Screenshot-Shortcuts in *Systemeinstellungen → Tastatur → Tastaturkurzbefehle → Bildschirmfotos* deaktivieren/umlegen, oder b) `Ctrl+Shift+3` und `Ctrl+Shift+4` benutzen (`Ctrl` als Modifier ist von macOS für Screenshots nicht belegt).

**Toolbar oben** (`+ Neuer Trade`, `↻ Kurse`, `⋯ Menü`) ist `position: sticky; top: 0` — bleibt beim vertikalen Scrollen oben. Kein Header mit App-Title mehr im Body — der wandert ins Settings-Modal als h1.

---

## Datenmodell (was in JSONBin steht)

```json
{
  "trades": [
    {
      "id": "t_...",
      "type": "pair" | "long" | "short",
      "name": "Optional Anzeigename",
      "longTicker": "AAPL" | null,
      "shortTicker": "MSFT" | null,
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

**Wichtig zum Trade-Typ:**
- Bei `type: "long"` ist `shortTicker = null` und in jeder Tranche `shortQty = 0, shortEntry = 0, shortEntryNative = false, shortEntryCcy = null`.
- Bei `type: "short"` ist `longTicker = null` und in jeder Tranche `longQty = 0, longEntry = 0, longEntryNative = false, longEntryCcy = null`.
- Bei `type: "pair"` sind beide Seiten gefüllt (wie bisher).

**Migration:** alte Trades ohne `type`-Feld bekommen beim ersten App-Start nach dem Update `type: "pair"` (siehe `migrateTrades()`). Migration ist idempotent.

---

## Wichtige Design-Entscheidungen (das Warum)

### Trade-Typen: Paar, Long, Short

Robert wollte über die ursprüngliche Pair-Mechanik hinaus auch separate Long- und Short-Positionen tracken können. Ein neuer `type`-Field am Trade entscheidet, welche Legs gefüllt sind und wie die Performance gerechnet wird.

**Performance-Formeln:**
- **Pair** (unverändert): `P&L = LongP&L + ShortP&L`; `Notional = LongNotional + ShortNotional`; `% = P&L / Notional × 100`
- **Long-only**: `P&L = (currentPrice − entry) × qty`; `Notional = entry × qty`; `% = P&L / Notional × 100`
- **Short-only**: `P&L = (entry − currentPrice) × qty` (invertiert — Profit wenn Kurs fällt); `Notional = entry × qty`; `% = P&L / Notional × 100`

Bei Multi-Tranche wird über alle Tranchen aggregiert (Σ P&L, Σ Notional).

### Page-Layout: Filter-Sichten, nicht UI-Tab

Die 4 Pages sind **Filter-Sichten** auf eine einzige `trades`-Liste. `tradesForPage(pageKey)` filtert nach `type === pageKey` (außer "total" → alle). Es gibt **keine separaten Trade-Listen** pro Page. Konsequenz: ein Trade hat genau einen Typ, taucht auf genau einer der 3 Typ-Pages auf und auf der Gesamt-Page.

### Gesamt-Page anders gebaut

Die Gesamt-Page (`data-page="total"`) hat **bewusst keine Trade-Karten**, sondern stattdessen drei kompakte Breakdown-Cards (Pair/Long/Short) mit jeweils P&L, %, Notional, Count für die Untermenge. Begründung: auf der Gesamt-Page will man nur den Überblick — Detail liegt schon auf den anderen 3 Pages.

Die Breakdown-Cards haben dezente farbige Border-Stripes links (blau für Paare, grün für Longs, rot für Shorts), damit die Sub-Aggregate visuell trennbar sind, ohne mit den großen Zahlen zu konkurrieren.

### Super-Trade / Tranchen-Modell — TYP-ISOLIERT

Wenn der User einen neuen Trade speichert dessen Ticker(s) **exakt einem bestehenden Trade vom selben Typ** entsprechen, wird der neue als zusätzliche Tranche an den bestehenden gehängt (Auto-Merge ohne Nachfrage).

**Match-Regel pro Typ:**
- `pair`: `existing.longTicker === new.longTicker && existing.shortTicker === new.shortTicker`
- `long`: `existing.longTicker === new.longTicker`
- `short`: `existing.shortTicker === new.shortTicker`

**Strikt typ-isoliert:** Ein neuer Long-Trade auf AAPL wird **nie** mit einem Pair-Trade `AAPL/MSFT` zusammengeführt, auch wenn der Long-Ticker identisch ist. Begründung: Pair und Long-only sind konzeptionell verschiedene Trades.

Performance wird wie bisher aggregiert: Σ Tranchen-P&Ls und Σ Notionals, dann % daraus.

**Alarm-Schwelle bei Merges:** Wenn der bestehende Trade bereits eine Schwelle gesetzt hat, wird **niemals** durch eine neue Tranche überschrieben. Nur wenn der bestehende keine hatte und die neue eine setzt, übernimmt der Super-Trade. Manuelle Änderung jederzeit über Edit möglich.

**Edit-Form bei Multi-Tranche-Trades:** Nur Name und Alarm-Schwelle editierbar (Ticker, Quantity, Entry sind disabled). Type kann **nie** geändert werden (Section ausgeblendet im Edit-Modus).

**Edit-Form bei Single-Tranche:** Alle relevanten Legs editierbar (nur die für den Typ relevanten — auf Long-only-Trade ist die Short-Section ausgeblendet).

**Tranchen löschen:** über Tap auf Trade-Card → Tranchen-Detail-Ansicht → × pro Tranche. Letzte Tranche eines Multi-Trades löschen → ganzer Trade weg.

### Neuanlegen je nach Page

- Auf **Paare/Longs/Shorts-Page**: Typ implizit, Typ-Auswahl im Form versteckt.
- Auf **Gesamt-Page**: Typ-Auswahl als 3-Radio-Switch (`Paar` / `Nur Long` / `Nur Short`) im Form sichtbar. Default `Paar`. Form-Sektionen für Long/Short blenden sich je nach Wahl ein/aus.

### Tastatur-Shortcuts: Wahl der Modifier-Kombo

Erste Version war `Cmd+1..4`. Problem: Safari (auch im PWA-Modus) reserviert `Cmd+1..9` auf System-Ebene für Tab-Switching bzw. App-internes Fenster-Navigation und gibt diese Events nicht ans JavaScript weiter. `preventDefault` half nicht. Auf Roberts Wunsch auf `Cmd+Shift+1..4` umgestellt — diese Kombo wird von Safari nicht abgegriffen.

Konflikt-Hinweis: macOS reserviert `Cmd+Shift+3` (Vollbild-Screenshot) und `Cmd+Shift+4` (Auswahl-Screenshot) systemweit. Diese werden auf einer noch tieferen Ebene abgefangen als Browser-Shortcuts — JavaScript bekommt das Event gar nicht. Workarounds:
- macOS-Screenshot-Shortcuts in den System-Einstellungen deaktivieren oder umlegen, oder
- `Ctrl+Shift+3` und `Ctrl+Shift+4` benutzen (`Ctrl` ist auf Mac nicht für Screenshots belegt).

Der Listener akzeptiert beide Modifier (`metaKey || ctrlKey`), sodass `Ctrl+Shift+1..4` als Fallback immer funktioniert.

### Theme-Wahl: Auto / Hell / Dunkel

In den Einstellungen ganz oben gibt es eine Section "Erscheinungsbild" mit Select **Auto (System) / Hell / Dunkel**. Default ist `auto` — folgt der System-Einstellung von macOS/iOS automatisch (wie das vorherige Verhalten via `@media (prefers-color-scheme: dark)`).

**Implementation:**
- Das `<html>`-Element trägt ein `data-theme="auto"|"light"|"dark"`-Attribut.
- CSS: Light-Werte als Default in `:root`. Dark-Werte werden via `:root[data-theme="dark"]` aktiv gesetzt, plus via `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] { ...dark... } }` für den Auto-Modus.
- `color-scheme` ist pro Theme explizit gesetzt (`light` / `dark` / `light dark`), sodass Browser-native UI (Scrollbars, Form-Controls) farblich mit der Wahl mitgeht.
- Das `<meta name="theme-color">` wird beim Theme-Switch dynamisch aktualisiert (#0f0f10 für Dunkel, #fafafa für Hell). Sorgt dafür, dass die PWA-Titlebar-Farbe oben auf dem iPhone zur Wahl passt.
- **Live-Update bei Auto-Modus:** `matchMedia("(prefers-color-scheme: dark)").addEventListener("change", …)` reagiert auf System-Wechsel und re-rendert sofort. Kein Reload nötig.
- `applyTheme()` wird **vor dem ersten sichtbaren Render** ausgeführt, damit kein Flash-of-wrong-theme auftritt.

**Speicherung:** lokal pro Gerät in `localStorage["pair_trade_theme_v1"]` — **nicht** über JSONBin synced. Begründung: User möchte vielleicht das iPhone bei Tageshelligkeit hell, den Mac am Abend dunkel — analog zur Sprache und Standard-Page-Logik.

### Pfadunabhängige Einstands-Währung

Jede Tranche speichert ihre Entry-Currency explizit als `longEntryCcy` / `shortEntryCcy`. Wenn der User später die Heimat-Währung wechselt (z.B. EUR → CHF), bleiben Entry-Preise korrekt interpretiert. Migration alter Daten: fehlende `*EntryCcy`-Felder werden zu "EUR" defaultet.

`longEntryNative` / `shortEntryNative` erlaubt alternativ "verwende die API-Währung des Tickers" — z.B. bei AAPL in USD denken statt EUR.

### Mixed-Currency-Tranchen

Wenn Tranchen unterschiedliche Einstands-Währungen haben, wird auf Heimat-Währung (`HOME_CCY = EUR` im Worker, `homeCurrency` aus Settings im Frontend) aggregiert. Jede Tranche hat ihre eigene Entry-Currency → pfadunabhängig.

### Sprache geräteabhängig (nicht synced)

Sprache wird nur lokal in `localStorage[LANG_KEY]` gespeichert, nicht aus JSONBin-Pull übernommen. Aber: beim Push schickt jedes Gerät seine Sprache mit (`lang`-Feld), damit der Worker weiß in welcher Sprache er Telegram-Nachrichten schicken soll. Trade-off bewusst akzeptiert.

Default DE, vier Optionen DE/EN/IT/RU.

### Standard-Page geräteabhängig (nicht synced)

Analog zur Sprache: in `localStorage[START_PAGE_KEY]` lokal pro Gerät. Beim App-Start scrollt die App per `requestAnimationFrame(() => scrollToPage(savedStartPage, false))` ohne Animation auf die gewählte Page.

### Alarm-State-Machine

Pro Trade ein State im JSONBin: `idle → triggered → acknowledged → idle`. Edge-triggered: Alarm feuert nur beim Übergang `idle → triggered`. Während `triggered` repeat alle 3 Min bis User per Telegram-Reply quittiert → `acknowledged`. Reset zu `idle` erst wenn Performance wieder über Schwelle steigt — verhindert Re-Trigger-Spam.

`ALERT_REPEAT_MS = 3 * 60 * 1000` im Worker. Cron-Schedule auf `*/3 * * * *`.

Alarm-Logik im Worker ist type-aware: `computePerf()` zieht je nach Trade-Typ Long- und/oder Short-Live-Preise und rechnet die Performance entsprechend. Das verwendete Telegram-Label im Alarm-Text ist je nach Typ "Paar" / "Long" / "Short".

### Handelszeit-Fenster

`TRADING_START_HOUR = 9`, `TRADING_END_HOUR = 23` (Berlin time, Mo-Fr). Außerhalb keine Alarm-Checks, App stoppt Auto-Refresh.

### Yahoo-Proxy ist transparenter Passthrough

Der Worker proxied die rohe Yahoo-API-Response 1:1 — die App erwartet `data.chart.result[0].meta.regularMarketPrice` und nicht ein remapped Format. Worker-Test in Settings prüft genau diesen Pfad.

### Auto-Refresh nur im Foreground

`document.hidden`-Check verhindert Updates wenn Tab/App im Background. Im Foreground 1-Min-Intervall.

### Kein App-Title-Header

Der h1 "Pair Trade Tracker" wurde vom Body-Header in das Settings-Modal verschoben. Begründung: maximaler Platz für die Page-Titel und Aggregate auf der Hauptansicht; der App-Name ist dort sichtbar wo er gebraucht wird (Settings).

### Page-Titel groß und prominent

Die Page-Titel ("Paare", "Longs", "Shorts", "Gesamt") sind 30 px, font-weight 800, in Texturfarbe statt grau. Sie dominieren visuell die jeweilige Page und ersetzen den weggefallenen App-Title als optischer Anker.

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

**Type-Awareness im Worker:**
- `tradeType(trade)` liest `trade.type`, fällt zurück auf `"pair"` bei fehlendem Feld (Backward-Compat).
- `computePerf()` zieht nur die Live-Preise die der Typ braucht (long-only braucht nur Long-Ticker etc.).
- `buildAlarmMessage()` zeigt im Telegram-Text "Paar" / "Long" / "Short" als Label je nach Typ.

`getTranches(trade)` hat weiterhin Backward-Compat-Logik für alte flache Trades ohne `tranches`-Array.

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
- `pair_trade_start_page_v1` — Standard-Page beim App-Start (geräteabhängig, Werte `pair`/`long`/`short`/`total`)
- `pair_trade_theme_v1` — Theme-Wahl (geräteabhängig, Werte `auto`/`light`/`dark`, Default `auto`)

Bei Versions-Bumps: neue Keys vergeben (`_v3`), alte beim ersten Load migrieren.

---

## Bekannte Stolperfallen

1. **Decimal-Comma:** Inputs sind `type="text" inputmode="decimal"`, nicht `type="number"`. `parseDecimal()` akzeptiert sowohl "150,50" als auch "150.50". Niemals auf `type="number"` umstellen — brach den User-Workflow weil iOS-Keyboard Komma-Eingabe nur eingeschränkt erlaubt.

2. **Cache zwischen Netlify und Cloudflare:** Beim Deploy einer neuen HTML kann der Mac noch eine alte Version sehen (Safari-Cache + Cloudflare-Edge-Cache). Workaround: in Safari Cache leeren und PWA aus Dock entfernen/neu hinzufügen.

3. **CORS-Proxys sind tot:** Frühere Versionen nutzten corsproxy.io / allorigins.win — beide nicht mehr verlässlich. Eigener Cloudflare-Worker ist die einzige stabile Lösung.

4. **Twelve Data deckt europäische Aktien nicht ab:** Yahoo Finance schon. Niemals zu Twelve Data zurückwechseln auch wenn es als "saubere" API klingt.

5. **PWA auf Mac:** Safari "Add to Dock" (macOS Sonoma 14+) gibt true-PWA-Verhalten. iOS-Shortcuts auf Mac sind ein Anti-Pattern.

6. **Migration bei Bestandstrades:** Beim ersten Laden nach Update werden alte Trades automatisch in das `tranches: [{...}]`-Format migriert und bekommen `type: "pair"`. Migration ist idempotent. Wenn die migrierte Version per Sync zu JSONBin gepusht wurde, sehen iPhone und Mac die neue Struktur. Worker hat Backward-Compat falls eine alte Version durchrutscht.

7. **Auto-Merge bei identischen Tickern:** Wenn der User glaubt einen separaten Trade anzulegen, aber Type und Ticker identisch zu einem bestehenden — wird automatisch gemerged. Alert-Box bestätigt mit "Aufstockung zu bestehendem Trade hinzugefügt (Tranche N)". Wenn der User das nicht will, muss er den vorherigen Trade umbenennen/löschen vor dem neuen. **Type-Mismatch verhindert Merge** — neuer Long-AAPL wird nicht in Pair-Trade AAPL/MSFT gemerged.

8. **Worker und HTML synchron deployen:** Bei Datenmodell- oder Compute-Änderungen erst Worker, dann HTML. Sonst rechnet der alte Worker neue Trade-Typen falsch (z.B. fragt er bei Long-only nach `shortTicker` der null ist). Bei reinen UX-Änderungen ohne Compute-Touch (Layout, Farben, Shortcuts, Theme) reicht HTML-Only.

9. **macOS-Screenshot vs. Cmd+Shift+3/4:** Diese Kombos sind auf macOS systemweit reserviert für Screenshots und werden bevor sie zum Browser kommen abgegriffen. Workaround: Screenshot-Shortcuts in den System-Einstellungen deaktivieren/umlegen, oder `Ctrl+Shift+3` und `Ctrl+Shift+4` benutzen (der Listener akzeptiert beide Modifier).

10. **Layout-abhängige `e.key` mit Shift:** Mit gedrückter Shift-Taste liefert `e.key` das Sonderzeichen (`"!"`, `'"'`, `"§"`, `"$"` je nach Layout) statt der Zahl. Deshalb verwendet der Shortcut-Listener `e.code` (Layout-unabhängig: `"Digit1".."Digit4"`). Niemals auf `e.key` umstellen.

11. **`scroll-snap` und Trackpad:** Horizontales Wischen mit Mac-Trackpad funktioniert mit `scroll-snap-x mandatory`, ist aber für viele User unintuitiv. Daher: `Cmd+Shift+1..4` als Haupt-Bedienpfad auf Mac, Wischen als Backup.

12. **Theme bei Auto-Modus reagiert live:** Wenn der User auf System-Ebene zwischen hell und dunkel umschaltet während die App offen ist, schaltet `applyTheme("auto")` automatisch mit (via `matchMedia` change-event). Wenn der User explizit Hell oder Dunkel gewählt hat, ignoriert die App den System-Wechsel — bewusst, da dies die "Override"-Semantik der Wahl ist.

13. **`applyTheme()` vor erstem Render:** Wenn beim App-Start die Reihenfolge umgedreht würde (erst render, dann theme), gäbe es einen Flash-of-wrong-theme (FOWT) — sichtbarer kurzer Helligkeits-Sprung. Daher: `applyTheme(loadTheme())` läuft als allererste DOM-Operation im Script, **bevor** `setLanguage`, `loadStorage` oder `render` aufgerufen werden.

---

## Internationalisierung

`STRINGS` ist ein zentrales Dictionary mit ~105 Keys × 4 Sprachen. `t(key, params)` für Lookups mit `{param}`-Interpolation. DOM-Elemente mit `data-i18n="key"` werden via `applyTranslations()` beim Sprachwechsel re-rendert.

Worker hat sein eigenes (kleineres) `WORKER_STRINGS`-Dictionary nur für Telegram-Nachrichten. Neu seit Type-Update: `long_only` und `short_only` als Labels neben dem alten `pair`.

Beim Hinzufügen neuer UI-Strings: in alle 4 Sprachen einpflegen. DE als Fallback wenn ein Key in einer Sprache fehlt.

Spezielle Strings für die neuen Features:
- `page_pairs`, `page_longs`, `page_shorts`, `page_total` — die großen Page-Titel
- `form_type_label`, `form_type_pair`, `form_type_long`, `form_type_short` — Typ-Switch im Form
- `settings_start_page`, `settings_start_page_label`, `settings_start_page_info` — Settings-Section "Standard-Page"
- `settings_theme`, `settings_theme_label`, `settings_theme_info`, `theme_auto`, `theme_light`, `theme_dark` — Settings-Section "Erscheinungsbild"
- `empty_no_pairs`, `empty_no_longs`, `empty_no_shorts` — Empty-State pro Page
- `err_long_ticker_required`, `err_short_ticker_required` — Validation für Single-Leg

---

## Robert's Präferenzen

- Sehr ehrliches Feedback, kein Sugarcoating. Lieber Bug zugeben als rumeiern.
- Mag pragmatische Code-Erklärungen mit Trade-offs.
- Schreibt Deutsch, versteht aber EN-Begriffe in Code (Variablen, etc.).
- Setup ist: iPhone als primäres Mobile-Gerät, Mac als Desktop. Beide nutzen die selbe Netlify-URL (`rs-pair-tracker.netlify.app`).
- Telegram-Alarms muss zuverlässig sein — Hauptgrund für das ganze Setup, nicht nur die Live-Anzeige.
- Bevorzugt Tastatur-Shortcuts auf Mac (`Cmd+Shift+1..4`) gegenüber Trackpad-Wischen.

---

## Wenn du diese Datei in einer neuen Session liest

Du bist jetzt informiert genug um Änderungen vorzunehmen. Empfohlenes Vorgehen:

1. Den aktuellen Stand des Codes via WebFetch oder Upload anschauen
2. Bei Architektur-Änderungen: prüfe ob bestehende Konventionen (Type-Isolation beim Auto-Merge, State-Machine, Pfadunabhängigkeit, Tranche-Modell, Page-Filter-Logik) tangiert werden
3. Bei API-Contract-Änderungen zwischen App und Worker: **beide** Seiten gleichzeitig updaten und testen, **Worker zuerst deployen**
4. Bei UI-Änderungen die nur das Frontend betreffen: HTML allein deployen reicht
5. Diese Datei bei substanziellen Änderungen aktualisieren — sie ist Teil des Projekts, nicht Beiwerk
