# 🚂 SimRail Companion

Begleit-App für [SimRail](https://simrail.eu): **Dienstpläne wie im echten Bahnbetrieb** – direkt im Browser,
kostenlos, als Gast oder mit eigenem Konto.

👉 **Zur App: https://simrail-companion.github.io**

> Inoffizielles Fanprojekt – nicht mit SimRail S.A. verbunden.

## Was kann Version 1?

- **Dienstplan generieren:** Border Station und Zeitfenster wählen – die App kettet Fahrten aneinander,
  jede beginnt dort, wo die vorige endete. Fünf Pläne zur Auswahl, Countdown bis Dienstbeginn.
- **Fahrten abhaken:** mit Kilometern und Verspätung. Ganz gefahrene Züge werden nicht noch einmal eingeplant;
  der nächste Dienst beginnt am Ziel des letzten.
- **Gast oder Konto:** Ohne Anmeldung bleibt der Fortschritt im Browser. Mit Konto (E-Mail + Passwort) ist er
  auf jedem Gerät verfügbar.
- **Stationsansagen:** Etwa einen Kilometer vor jedem Halt sagt die App den Stationsnamen an – auf Polnisch,
  Deutsch oder Englisch. Im Fernverkehr meldet sich der Zugbegleiter mit Begrüßung und Ankunftsansage.
  Die App erkennt deinen Zug über deine Steam-ID in den Live-Daten von SimRail (nur Server DE1).

## Was kommt?

Schritt für Schritt kommen Funktionen aus unserer lokalen Version dazu: Level & Abzeichen, Fahrplanunterlagen
(Buchfahrplan) und später ein kleines Programm, das die Web-App mit dem laufenden Spiel verbindet
(First-Person-Dienste, Live-Abfahrten, Umstiegsansagen, automatische Auswertung).

Ideen und Fehler gerne als [Issue](../../issues) melden.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Startseite |
| `app.html`, `js/app.js` | die App (Dienstplan, Fahrten, Einstellungen) |
| `js/ansage.js` | Stationsansagen (Live-Daten von SimRail, Sprachausgabe des Browsers) |
| `daten/ansagen.js` | Halte, Sollzeiten und Bahnsteig-Koordinaten für die Ansagen (automatisch erzeugt) |
| `js/konto.js` | Burger-Menü, Gast-Modus, Konto und Speichern des Fortschritts (Supabase) |
| `css/stil.css` | gemeinsames Aussehen |
| `daten/trains.js` | Fahrplan (aus der offiziellen SimRail-Schnittstelle, Server DE1, automatisch erzeugt) |
| `supabase/einrichtung.sql` | Datenbank-Einrichtung für die Konten |

Es gibt keinen Build-Schritt: reine HTML-, CSS- und JavaScript-Dateien. Zum Ausprobieren auf dem eigenen
Rechner im Projektordner `python -m http.server 8080` starten und `http://localhost:8080` öffnen.

### Konten einrichten (für eigene Kopien)

1. Kostenloses Projekt bei [Supabase](https://supabase.com) anlegen.
2. Im SQL Editor den Inhalt von `supabase/einrichtung.sql` ausführen.
3. In `js/konto.js` `SUPABASE_URL` und `SUPABASE_KEY` (publishable/anon Key) eintragen.
4. Unter *Authentication → URL Configuration* die Adresse der eigenen Seite als *Site URL* eintragen.

## Quellen

- Fahrplandaten: offizielle SimRail-Schnittstelle (`api1.aws.simrail.eu`)
- Live-Daten der Züge: offizielle SimRail-Schnittstelle (`panel.simrail.eu`)
- Lage der Bahnsteige: eigene Messungen und [OpenStreetMap](https://www.openstreetmap.org/copyright)
  (© OpenStreetMap-Mitwirkende, Lizenz [ODbL](https://opendatacommons.org/licenses/odbl/))
- Konten: [Supabase](https://supabase.com), Bibliothek `@supabase/supabase-js`

## Lizenz

[MIT](LICENSE) – mach damit, was du willst; ein Hinweis auf dieses Projekt freut uns.
