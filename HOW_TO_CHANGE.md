# Anleitung für künftige Änderungen am Pair Trade Tracker

> Diese Datei beschreibt den User-Workflow für Robert. Für technischen Kontext (Architektur, Design-Entscheidungen, Konventionen) siehe `PROJECT_MEMORY.md`.

## Schritt 1 — Claude-Code-Session starten (seit Aug 2026 der Standard-Weg)

Claude Code arbeitet direkt auf dem lokalen Klon **`~/git/pair-trade-tracker`** auf dem Mac und **committet + pusht selbstständig** (GitHub-Zugang läuft über `gh`, angemeldet als RobertSmith202). Du musst weder Dateien hochladen noch manuell in GitHub editieren.

Sag der neuen Session einfach:

> "Arbeite an meinem Pair-Trade-Tracker (`~/git/pair-trade-tracker`). Lies zuerst `PROJECT_MEMORY.md`. Ich will: [BESCHREIBUNG DER ÄNDERUNG]."

Claude liest dann die Memory-Datei + den aktuellen Code und ist auf dem gleichen Stand wie am Ende der letzten Session.

## Schritt 2 — Je nach Art der Änderung

### A) UI / App-Verhalten ändern (häufigster Fall)

**Beispiele:** neue Farbe, neue Spalte, Layout-Anpassung, neuer Knopf, andere Berechnung in der App-Logik, neue Sprache hinzufügen.

**Workflow:**

1. Claude ändert `index.html` (und ggf. Doku-Dateien), committet und pusht
2. Cloudflare Pages deployed automatisch in 30-60 Sek (im Pages-Dashboard sichtbar welcher Commit live ist)
3. Auf iPhone/Mac PWA neu laden → fertig. Du machst nichts außer neu laden.

**Sonderfall localStorage:** Wenn du Datenstruktur änderst (z.B. neues Feld pro Trade), entweder Migration im Code einbauen oder bei dir lokal Settings zurücksetzen. Frag Claude explizit danach.

### B) Worker-Code / Alarm-Logik / Telegram-Nachrichten ändern

**Beispiele:** Cron-Intervall ändern, neue Telegram-Sprache, neuen Endpoint, andere Berechnung serverseitig, andere Schwelle für Trading-Hours.

**Workflow:**

1. Claude ändert `cloudflare-worker.js`, committet und pusht (GitHub bleibt Source of Truth)
2. Claude schickt dir die **komplette neue Datei** direkt im Chat
3. **DU:** Cloudflare-Dashboard → Worker → "Edit Code" → alles markieren (Cmd+A) + löschen → neuen Code einfügen → "Save and Deploy"
4. Testen: `/test-alert` aufrufen, sollte Telegram-Nachricht kommen

**Wichtig:** Schritt 3 nie vergessen, sonst läuft Cloudflare auf alter Version während GitHub neue hat (Drift). Das ist der einzige verbliebene manuelle Schritt im ganzen Workflow.

### C) Telegram-Bot-Identität / Beschreibung / Avatar

**Beispiele:** Bot umbenennen, Profilbild ändern, Beschreibung ändern, Commands hinzufügen.

**Workflow:**

Hat nichts mit Code zu tun. In Telegram an **@BotFather** schreiben → `/mybots` → deinen Bot wählen → "Edit Bot" → entsprechende Option.

### G) Telegram-Bot-Dialog aktivieren: Trades per Chat anlegen (einmalig, Aug 2026)

**Wozu:** Trades in freiem Deutsch an den Bot diktieren (via Wispr Flow) statt sie in der App einzutippen. Der Bot sucht Ticker der Heimbörse, fragt fehlende Angaben nach, fasst zusammen und trägt erst nach deinem „ok" ein.

**Setup-Schritte:**

1. Auf https://console.anthropic.com einen API-Key erstellen (Account → API Keys).
2. Cloudflare-Dashboard → Worker → Settings → Variables and Secrets → **Add** → Type: **Secret**, Name: **`ANTHROPIC_API_KEY`** (genau so), Value: der Key → Save.
3. Neuen Worker-Code deployen (Workflow B).
4. Testen: dem Bot in Telegram schreiben, z.B. „Neuer Long: Apple, 10 Stück zu 180 Dollar, Verlustschwelle 10 Prozent". Er sollte antworten und ggf. nachfragen.
5. Alternativ ohne Telegram testen: `curl -X POST -H "Authorization: Bearer <SYNC_SECRET>" -H "Content-Type: application/json" -d '{"text":"Long Apple 10 Stück zu 180"}' https://yahoo-finance-proxy.fabian-terhorst.workers.dev/bot-test`

**Deaktivieren:** Secret `ANTHROPIC_API_KEY` löschen → Webhook verhält sich wieder wie früher (jede Antwort quittiert Alarme).

### H) Zweiter Bot für den Eintrage-Dialog („Assistant Bot", einmalig, Aug 2026)

**Wozu:** Alarme (minütliche Wiederholung!) und Eintrage-Dialog in getrennten Chats — die Bestätigungs-Zusammenfassung geht nicht mehr zwischen 🚨-Nachrichten unter, und „ok" ist nie mehr doppeldeutig. Der Alarm-Bot quittiert dann wieder auf jede Antwort (kostenlos, ohne Claude).

**Setup-Schritte:**

1. In Telegram an **@BotFather**: `/newbot` → Namen vergeben (z.B. „Assistant Bot") → **Token** kopieren (Chat-ID braucht es NICHT neu — die ist bot-unabhängig deine Nutzer-ID).
2. Cloudflare → Worker → Settings → Variables and Secrets → Add → Secret **`TELEGRAM_ENTRY_BOT_TOKEN`** = der Token.
3. Neuen Worker-Code deployen (Workflow B).
4. Einmal im Browser aufrufen: `https://yahoo-finance-proxy.fabian-terhorst.workers.dev/setup-entry-webhook` → sollte `"ok": true` vom Telegram-API zeigen.
5. Dem neuen Bot in Telegram **`/start`** schreiben (sonst darf er nicht antworten).
6. Testen: dem Assistant-Bot „Neuer Long" schreiben → Rückfrage muss kommen. Dem Alarm-Bot irgendwas schreiben → „✅ Alarm bestätigt".

**Deaktivieren:** Secret `TELEGRAM_ENTRY_BOT_TOKEN` löschen → alles läuft wieder über den einen Bot.

### D) Cloudflare Secrets ändern (neues Token, neue Bin-ID)

**Beispiele:** JSONBin-Key rotiert, neuer Telegram-Bot.

**Workflow:**

Cloudflare-Dashboard → Worker → "Settings" → "Variables and Secrets" → entsprechendes Secret editieren oder neu anlegen → Save. Worker muss nicht neu deployed werden, Secrets sind sofort wirksam.

### F) Migration: JSONBin → Cloudflare KV als Sync-Storage (einmalig, Mai 2026)

**Wozu:** Worker wird zur einzigen Sync-Quelle, JSONBin-Abhängigkeit raus. Keine externen Single-Points-of-Failure mehr, keine 10k-Monats-Quota. Sync zwischen iPhone+Mac läuft jetzt über deinen eigenen Worker statt jsonbin.io.

**Voraussetzung:** Sektion E (KV-Namespace `TRADEBOOK_CACHE` ist gebunden) muss schon erledigt sein.

**Setup-Schritte (einmalig, ~15 Min):**

1. **Sync-Secret generieren** — random 32-Zeichen-String. Auf Mac/Linux:
   ```bash
   openssl rand -hex 32
   ```
   Output kopieren und SICHER notieren (Passwort-Manager).

2. **Secret im Cloudflare-Dashboard hinterlegen:**
   - Worker → Settings → Variables and Secrets → **„Add"**
   - Type: **Secret**
   - Variable name: **`SYNC_SECRET`** (genau so geschrieben)
   - Value: das in Schritt 1 generierte Secret rein
   - Save

3. **Neuen Worker-Code deployen** (Workflow B aus dieser Datei).

4. **JSONBin-Daten in KV importieren** (einmalig, solange JSONBin noch erreichbar ist):
   ```bash
   curl -X POST \
     -H "Authorization: Bearer <DEIN_SYNC_SECRET>" \
     https://yahoo-finance-proxy.fabian-terhorst.workers.dev/migrate-from-jsonbin
   ```
   Bei Erfolg kommt eine Response mit `ok: true` und der Anzahl migrierter Trades/Baskets/AlertStates zurück. Falls JSONBin grad nicht erreichbar ist (Quota / Outage): manuelle Alternative — JSONBin-Web-UI öffnen, JSON kopieren, mit `curl -X POST -d @datei.json` an `/tradebook` schicken.

5. **Neue `index.html` deployen** (Workflow A).

6. **App-Settings auf beiden Geräten** (iPhone + Mac) updaten:
   - Settings öffnen
   - Sync-Sektion: das neue Feld **„Sync-Secret (Worker)"** mit demselben Secret befüllen
   - Worker-URL prüfen (sollte schon gesetzt sein)
   - **„Test"** klicken — Sync-Test sollte „OK, N Trades" zeigen
   - **Speichern**

7. **Cross-Device-Sync verifizieren:**
   - Auf Mac einen Trade kurz editieren (z.B. Name ändern) → Sync wird ausgelöst
   - Auf iPhone die App reopen → Pull-Sync zieht die Änderung
   - Wenn der neue Name auf iPhone sichtbar ist → Migration komplett

8. **Aufräumen (optional, nach 1-2 Wochen ohne Probleme):**
   - JSONBin-Account löschen oder auslaufen lassen
   - Cloudflare-Dashboard → Worker → Settings → Variables and Secrets → `JSONBIN_KEY` und `JSONBIN_BIN_ID` löschen
   - App-Settings: Legacy-Felder (X-Master-Key, Bin-ID) leer machen
   - Worker-Code: optional den JSONBin-Code-Pfad rauslöschen (löscht ~50 Zeilen, ist aber pure Polish)

**Falls die Migration scheitert:** Worker behält die Legacy-Pfade als Fallback. Solange `apiKey + binId` in App-Settings stehen und JSONBin wieder reachable wird, läuft alles wie vorher. Du kannst den Migrations-Schritt 4 jederzeit nochmal versuchen.

### E) KV-Namespace für Worker-Resilience anlegen (einmalig, seit Mai 2026)

**Wozu:** der Worker fängt JSONBin-Outages und Quota-Exhaustions mit einem KV-Cache-Fallback ab. Ohne diesen Namespace verhält sich der Worker wie vorher (keine Telegram-Alarme wenn JSONBin gerade nicht erreichbar ist). Mit Namespace: Alarme laufen weiter mit dem letzten bekannten Trade-Stand, plus du kriegst eine Telegram-Warnung wenn der Fallback aktiv wird.

**Setup-Schritte (einmalig, ~5 Min):**

1. Cloudflare-Dashboard → **Storage & Databases** → **KV** → **„Create namespace"** → Name: `pair-trade-tracker-cache` (oder beliebig anders) → Create
2. Zurück zum **Worker** (yahoo-finance-proxy) → **Settings** → **Variables and Secrets**
3. Im Block **„KV Namespace Bindings"** → **„Add binding"**
4. **Variable name:** `TRADEBOOK_CACHE` (genau so, casesensitiv — der Worker-Code referenziert diesen Namen)
5. **KV namespace:** den in Schritt 1 erstellten Namespace auswählen
6. **Save**

Kein Worker-Redeploy nötig nach Setup — Bindings sind sofort aktiv. Beim nächsten Cron-Tick (max. 3 Min Wartezeit) sollte der Worker den KV-Cache schon nutzen.

**Verifizieren dass es funktioniert:**

- Browser auf `https://yahoo-finance-proxy.fabian-terhorst.workers.dev/check` aufrufen. Wenn die Response durchgeht, ist alles normal (`source: "jsonbin"` im Cache wenn du im Worker-Log nachschaust).
- Bei einem JSONBin-Outage: du bekommst eine Telegram-Nachricht „⚠ JSONBin nicht erreichbar — Worker arbeitet aus KV-Cache". Das ist der Trigger dass alles richtig läuft.

**Free-Tier-Limits (Cloudflare KV):** 100k Reads/Tag, 1k Writes/Tag — für diesen Use-Case völlig ausreichend (Worker schreibt nur bei JSONBin-Read-Success in den Cache, also wenige Schreibvorgänge pro Tag).

## Schritt 3 — Verifizieren dass alles läuft

Nach jeder Änderung:

- **HTML geändert:** PWA neu laden (iPhone: Karte schließen + neu öffnen / Mac: Cmd+R), prüfen dass Änderung sichtbar
- **Worker geändert:** Browser auf `https://yahoo-finance-proxy.fabian-terhorst.workers.dev/test-alert` → Telegram-Nachricht sollte kommen
- **Wenn du Logik in der Performance-Berechnung änderst:** prüf manuell an einem Trade dass die Zahlen plausibel sind

## Schritt 4 — Bei Bugs: Rollback

**Einfachster Weg:** der nächsten Claude-Session sagen „mach den letzten Commit rückgängig" — sie revertet und pusht, Pages deployed automatisch.

**Manuell** ermöglicht GitHub Rollback ohne Code-Verständnis:

- Repo öffnen → oben Tab **"Commits"** (oder einfach auf den letzten Commit-Eintrag klicken)
- Den vorletzten guten Commit finden

Drei Wege je nach Schwere:

- **Einzelne Datei zurückrollen:** auf die Datei in dem alten Commit klicken → "View raw" → Inhalt kopieren → in aktuelle Version pasten + commiten
- **Kompletter Revert:** auf den schlechten Commit klicken → oben rechts "Revert" — erstellt automatisch einen Commit der die Änderung rückgängig macht
- **Worker-Rollback:** Cloudflare Dashboard → Worker → "Deployments" Tab → "Rollback to this version" beim alten Deployment

## Wichtige Regeln zum Merken

1. **GitHub ist Source of Truth.** Nie direkt in Cloudflare Dashboard editieren ohne danach GitHub zu updaten. Sonst Drift.

2. **Worker = GitHub + Cloudflare**, nie nur eines.

3. **HTML = nur GitHub**, Rest läuft automatisch.

4. **ALLE Doku-Dateien aktuell halten.** Bei jeder substanziellen Änderung updated Claude im selben Commit auch `PROJECT_MEMORY.md`, diese Datei und die README, falls betroffen (Roberts explizite Anforderung seit Aug 2026: alle Files im Repo müssen immer up to date sein).

5. **Secrets gehören nie ins Repo.** Telegram-Token, JSONBin-Master-Key etc. immer nur in Cloudflare-Secrets bzw. App-Settings (localStorage). Niemals in eine Datei schreiben die nach GitHub geht.

## URLs zum Speichern

- **Repo:** https://github.com/RobertSmith202/pair-trade-tracker
- **App:** (Cloudflare Pages URL — nach Migration eintragen, z.B. `pair-trade-tracker.pages.dev`)
- **Worker:** https://yahoo-finance-proxy.fabian-terhorst.workers.dev
- **Cloudflare-Dashboard:** https://dash.cloudflare.com  (Workers UND Pages liegen beide hier)
- **Telegram BotFather:** https://t.me/BotFather
- **JSONBin-Dashboard:** https://jsonbin.io

## FAQ

**Was wenn die App im Browser aussieht wie vorher, obwohl ich gerade committed habe?**

Cache. PWA hat eine eigene Cache-Schicht plus Browser-Cache plus Cloudflare-Edge-Cache. Auf iPhone die PWA-Karte komplett schließen und neu öffnen. Auf Mac in Safari Cmd+Option+R (Hard Reload). Wenn das nicht hilft: Settings in der App öffnen — falls dort die Änderung sichtbar ist, sind nur die Trades-Daten gecached, das löst sich beim nächsten Sync. Wenn Settings auch alt aussehen: PWA aus Dock/Homescreen löschen und neu hinzufügen.

**Was wenn Cloudflare Pages den Deploy nicht startet?**

Cloudflare-Dashboard → Pages → deine Site → "Deployments" → "Retry deployment" auf dem letzten fehlgeschlagenen Eintrag, oder über "Create deployment" einen manuellen Trigger. Falls dauerhaft nichts kommt: Settings → Build & deployments → prüfen ob „Production branch" auf `main` steht und das GitHub-Repo noch korrekt verbunden ist.

**Was wenn der Telegram-Bot keine Nachrichten mehr schickt?**

Reihenfolge zum Diagnostizieren:

1. `/test-alert` direkt aufrufen — kommt was an? Wenn ja, Bot läuft.
2. Wenn nicht: Cloudflare Worker Logs checken (Dashboard → Worker → Logs → Live)
3. Cron-Trigger gesetzt? Dashboard → Worker → Triggers → "Cron Triggers" → sollte `*/3 * * * *` sein
4. Trading-Hours? Außerhalb 09:00-23:00 Berlin oder am Wochenende → kein Alarm-Check
5. JSONBin lesbar? Worker → `/check` aufrufen, schauen ob da Trades aus dem Bin geladen werden

**Was wenn JSONBin Free-Tier voll ist (10k Requests/Monat)?**

Bei Auto-Refresh 1× pro Min während ~10 Stunden/Tag × 5 Werktage = ~3000/Monat. Plus Worker-Cron alle 3 Min × Trading-Hours = ~2800/Monat. Sollte ausreichen. Falls doch Probleme: Auto-Refresh-Intervall verlängern (in HTML `AUTO_REFRESH_INTERVAL_MS`) oder auf Paid-Plan upgraden ($3/Monat).

**Was wenn der Cloudflare-Worker quota überschreitet (100k Requests/Tag Free-Tier)?**

Bei aktueller Nutzung extrem unwahrscheinlich (du machst ~50-100 Requests/Tag). Falls dennoch: gleiche Optionen wie oben.
