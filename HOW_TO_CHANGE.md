# Anleitung für künftige Änderungen am Pair Trade Tracker

> Diese Datei beschreibt den User-Workflow für Robert. Für technischen Kontext (Architektur, Design-Entscheidungen, Konventionen) siehe `PROJECT_MEMORY.md`.

## Schritt 1 — Neuen Cowork-Chat starten

Sag der neuen Claude-Session als erste Nachricht:

> "Hier ist mein Repo: **github.com/RobertSmith202/pair-trade-tracker**. Lies bitte zuerst `PROJECT_MEMORY.md`, dann schau dir den aktuellen Code an. Ich will: [BESCHREIBUNG DER ÄNDERUNG]."

Claude liest dann die Memory-Datei + den aktuellen Code und ist auf dem gleichen Stand wie am Ende der letzten Session. Spart 15-20 Minuten Kontext-Aufbau pro Session.

## Schritt 2 — Je nach Art der Änderung

### A) UI / App-Verhalten ändern (häufigster Fall)

**Beispiele:** neue Farbe, neue Spalte, Layout-Anpassung, neuer Knopf, andere Berechnung in der App-Logik, neue Sprache hinzufügen.

**Workflow:**

1. Claude schlägt geänderte `index.html` vor
2. Du gehst in GitHub auf die Datei → Stift-Icon (Edit) → Änderungen einfügen oder die ganze Datei austauschen (Add file → Upload files → gleicher Name überschreibt)
3. Commit
4. Netlify deployed automatisch in 30-60 Sek
5. Auf iPhone/Mac PWA neu laden → fertig

**Sonderfall localStorage:** Wenn du Datenstruktur änderst (z.B. neues Feld pro Trade), entweder Migration im Code einbauen oder bei dir lokal Settings zurücksetzen. Frag Claude explizit danach.

### B) Worker-Code / Alarm-Logik / Telegram-Nachrichten ändern

**Beispiele:** Cron-Intervall ändern, neue Telegram-Sprache, neuen Endpoint, andere Berechnung serverseitig, andere Schwelle für Trading-Hours.

**Workflow:**

1. Claude schlägt geänderte `cloudflare-worker.js` vor
2. Du commitest in GitHub
3. **ZUSÄTZLICH:** Cloudflare-Dashboard → Worker → "Edit Code" → alles markieren (Cmd+A) + löschen → neuen Code aus GitHub einfügen → "Save and Deploy"
4. Testen: `/test-alert` aufrufen, sollte Telegram-Nachricht kommen

**Wichtig:** Schritt 3 nie vergessen, sonst läuft Cloudflare auf alter Version während GitHub neue hat (Drift).

### C) Telegram-Bot-Identität / Beschreibung / Avatar

**Beispiele:** Bot umbenennen, Profilbild ändern, Beschreibung ändern, Commands hinzufügen.

**Workflow:**

Hat nichts mit Code zu tun. In Telegram an **@BotFather** schreiben → `/mybots` → deinen Bot wählen → "Edit Bot" → entsprechende Option.

### D) Cloudflare Secrets ändern (neues Token, neue Bin-ID)

**Beispiele:** JSONBin-Key rotiert, neuer Telegram-Bot.

**Workflow:**

Cloudflare-Dashboard → Worker → "Settings" → "Variables and Secrets" → entsprechendes Secret editieren oder neu anlegen → Save. Worker muss nicht neu deployed werden, Secrets sind sofort wirksam.

## Schritt 3 — Verifizieren dass alles läuft

Nach jeder Änderung:

- **HTML geändert:** PWA neu laden (iPhone: Karte schließen + neu öffnen / Mac: Cmd+R), prüfen dass Änderung sichtbar
- **Worker geändert:** Browser auf `https://yahoo-finance-proxy.fabian-terhorst.workers.dev/test-alert` → Telegram-Nachricht sollte kommen
- **Wenn du Logik in der Performance-Berechnung änderst:** prüf manuell an einem Trade dass die Zahlen plausibel sind

## Schritt 4 — Bei Bugs: Rollback

GitHub ermöglicht Rollback ohne Code-Verständnis:

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

4. **PROJECT_MEMORY.md aktuell halten.** Wenn substanzielle Architektur-Änderung passiert (neuer Endpoint, neues Sync-Feld, etc.) Memory-Datei entsprechend updaten. Auch das geht über GitHub-Edit.

5. **Secrets gehören nie ins Repo.** Telegram-Token, JSONBin-Master-Key etc. immer nur in Cloudflare-Secrets bzw. App-Settings (localStorage). Niemals in eine Datei schreiben die nach GitHub geht.

## URLs zum Speichern

- **Repo:** https://github.com/RobertSmith202/pair-trade-tracker
- **App:** https://rs-pair-tracker.netlify.app
- **Worker:** https://yahoo-finance-proxy.fabian-terhorst.workers.dev
- **Netlify-Dashboard:** https://app.netlify.com
- **Cloudflare-Dashboard:** https://dash.cloudflare.com
- **Telegram BotFather:** https://t.me/BotFather
- **JSONBin-Dashboard:** https://jsonbin.io

## FAQ

**Was wenn die App im Browser aussieht wie vorher, obwohl ich gerade committed habe?**

Cache. PWA hat eine eigene Cache-Schicht plus Browser-Cache plus Cloudflare-Edge-Cache. Auf iPhone die PWA-Karte komplett schließen und neu öffnen. Auf Mac in Safari Cmd+Option+R (Hard Reload). Wenn das nicht hilft: Settings in der App öffnen — falls dort die Änderung sichtbar ist, sind nur die Trades-Daten gecached, das löst sich beim nächsten Sync. Wenn Settings auch alt aussehen: PWA aus Dock/Homescreen löschen und neu hinzufügen.

**Was wenn Netlify den Deploy nicht startet?**

Netlify-Dashboard → Site → Deploys → "Trigger deploy" → "Deploy site". Manuell anstoßen. Falls das auch nicht klappt: Build & Deploy Settings checken (Branch sollte auf `main` stehen, Publish-Directory leer oder `/`).

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
