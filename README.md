# Melde-Tracker

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories)
[![Prüfen](https://github.com/Urakatons67/ha-meldetracker/actions/workflows/validate.yml/badge.svg)](https://github.com/Urakatons67/ha-meldetracker/actions/workflows/validate.yml)

Home-Assistant-Integration für Schulkinder: Meldungen im Unterricht je Fach erfassen (Strichliste übertragen), über Wochen auswerten und Erfolge feiern. Mehrere Kinder mit eigenen Profilen. Oberfläche auf Deutsch.

## Funktionen
- Seite **„Melden“** in der Seitenleiste, auch für Benutzer ohne Adminrechte
- **Eintragen:** Stunden des Tages laut Stundenplan, Zähler je Stunde, Ausfall, Zusatzstunden
- **Woche:** Fach × Tag, Summe, Meldungen je Unterrichtsstunde (Doppelstunde = 2), Wochenziele
- **Verlauf:** Tabelle und Liniendiagramm, Summe oder pro Stunde, 4–26 Wochen
- **Erfolge:** Wochenziele (Vorschlag aus den letzten 4 Wochen), Sterne, Wochenstern, Serien, Abzeichen, Stufen
- **Feiern:** Licht-Show, Sprachausgabe (z. B. Echo), Push ans Kind und Lob-Hinweis an die Eltern, Ruhezeit
- **Einstellungen:** Fächer (Name, Farbe, aktiv), Stundenplan Mo–Fr mit Doppelstunden

## Mehrere Kinder
- Ein **Profil je Kind** mit eigenen Fächern, Stundenplan, Einträgen, Zielen, Erfolgen und Feier-Einstellungen.
- Ein Profil wird mit dem **HA-Benutzer des Kindes** verknüpft. Das Kind sieht dann nur sein eigenes Profil.
- **Administratoren** und die Benutzer der **Eltern-Liste** sehen alle Profile und schalten oben in der Kopfzeile um.
- Profile und Eltern-Liste pflegt ein Administrator unter *Einstellungen → Profile / Eltern*.
- Die Rechte prüft der Server bei jedem Aufruf, nicht nur die Oberfläche.

## Installation über HACS
1. HACS → ⋮ → **Benutzerdefinierte Repositories** → `https://github.com/Urakatons67/ha-meldetracker`, Typ **Integration**.
2. „Melde-Tracker“ suchen → **Herunterladen**.
3. Home Assistant neu starten.
4. *Einstellungen → Geräte & Dienste → Integration hinzufügen → Melde-Tracker*.
5. Seite **Melden** öffnen → *Einstellungen*: Profile anlegen und Benutzern zuordnen, Fächer und Stundenplan eintragen.

Updates zeigt HACS automatisch an. Nach einem Update Home Assistant neu starten.

### Manuell
Ordner `custom_components/meldetracker` nach `/config/custom_components/` kopieren und ab Schritt 3 weitermachen.

## Daten und Datenschutz
- Alle Daten bleiben lokal in `.storage/meldetracker` und sind im HA-Backup enthalten. Es gibt keine Cloud.
- Umstellung von 1.x: Die bisherigen Daten werden unverändert zu einem Profil, Sicherung in `.storage/meldetracker.bak-v1`.

## Ereignis für Automationen
Bei jedem neuen Erfolg feuert `meldetracker_erfolg` mit `profil`, `name` und `events` (Art, Titel, Text, Datum).

## Voraussetzungen
Home Assistant 2024.8 oder neuer. Das App-Icon erscheint ab Home Assistant 2026.3.

## Lizenz
MIT
