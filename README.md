# Pair Trade Tracker

Persönlicher Long/Short-Trade-Tracker als Single-File-PWA — Pair-, Long-only- und Short-only-Trades mit Live-Kursen (Yahoo Finance), Multi-Currency-Performance in Heimatwährung, Körben (Baskets) mit Aggregat-Alarmen, Zielkursen und Telegram-Alarmierung über einen Cloudflare Worker.

## Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette App (HTML + CSS + JS, keine Build-Steps). Deployed automatisch via Cloudflare Pages bei jedem Push. |
| `cloudflare-worker.js` | Yahoo-Finance-Proxy, Cron-Alarm-Engine (Verlust/Gewinn/Short-Squeeze), Telegram-Webhook, KV-Sync-Storage. Wird manuell ins Cloudflare-Dashboard deployed. |
| `PROJECT_MEMORY.md` | Architektur, Design-Entscheidungen und Konventionen — Pflichtlektüre vor jeder Code-Änderung. |
| `HOW_TO_CHANGE.md` | Workflow-Anleitung: wie Änderungen gemacht, deployed und verifiziert werden. |

## Features (Auszug)

- Drei Trade-Typen (Pair / Long / Short) mit Tranchen-Modell (Super-Trades bei Aufstockungen)
- Körbe auf den Long-/Short-Pages mit Aggregat-Performance und eigenen Alarmen — Standalone-Trades lassen sich per Drag & Drop (Apple-Lift-Effekt) in Körbe ziehen
- Karten auf allen Pages per Drag & Drop umsortierbar — die übrigen Karten machen animiert Platz wie App-Icons auf dem iOS-Homescreen; die Reihenfolge synct zwischen den Geräten
- Drei Alarm-Typen via Telegram: Verlust-, Gewinn- und Short-Squeeze-Schwellen, edge-getriggert mit Quittierung per Telegram-Reply
- Zielkurse mit stiller optischer Markierung
- Cross-Device-Sync (iPhone ↔ Mac) über Cloudflare KV
- Zwei Layout-Modi (Mobile-PWA / Bloomberg-Style-Desktop), drei Themes, DE/EN, optionale App-Sperre

## Hinweis

Single-User-Projekt, auf einen konkreten Workflow zugeschnitten. Secrets (Telegram-Token, Sync-Secret etc.) liegen ausschließlich in Cloudflare-Worker-Secrets bzw. im localStorage der Geräte — nie im Repo.
