# Schichtplan – Web-App für das Team

Schichtplan als Web-App, gehostet auf GitHub Pages, mit Firebase als Datenbank und Login.
Es gibt keinen Build-Schritt und keinen eigenen Server: nur statische Dateien.

## Funktionen

| | Mitarbeiter | Admin (Teamleitung) |
|---|---|---|
| Persönlicher Login (E-Mail + eigenes Passwort) | ✓ | ✓ |
| Monatsplan für das ganze Team, Besetzung pro Tag | ✓ | ✓ |
| „Meine Schichten“ + **Kalender-Abo** (Apple, Google, Outlook – aktualisiert sich selbst) | ✓ | ✓ |
| **Bedienung direkt im Plan:** eigenen Dienst antippen → tauschen, abgeben, Urlaub/ZA/Krank; Dienst einer Kollegin/eines Kollegen antippen → Tausch anfragen; offenen Dienst antippen → übernehmen | ✓ | ✓ |
| **„Für dich zu erledigen“**: Tauschanfragen annehmen/ablehnen und offene Dienste übernehmen, oben im Plan und unter „Meine“ | ✓ | ✓ |
| **Schichttausch anfragen**; die Kollegin oder der Kollege nimmt an → sofort im Plan | ✓ | ✓ |
| **Urlaub, Zeitausgleich und Fortbildung selbst eintragen** und wieder löschen | nur für sich | für alle |
| Beim Urlaub für jeden Dienst **eine Vertretung zuteilen oder offen lassen** | ✓ | ✓ |
| **Offene Dienste übernehmen** (alle, außer wer an dem Tag abwesend ist) | ✓ | ✓ + zuteilen |
| **Eigenen Dienst abgeben**: bleibt eigener Dienst, bis ihn jemand übernimmt | ✓ | ✓ |
| **Push-Benachrichtigungen** aufs Handy oder den PC (🔔) | ✓ | ✓ |
| Grundplan als **CSV oder Excel hochladen** (mit Vorschau) | – | ✓ |
| Vorlage und aktuellen Plan als Excel herunterladen | – | ✓ |
| Grundplan-Zellen direkt bearbeiten | – | ✓ |
| Mitarbeiter anlegen und deaktivieren, Rollen vergeben | – | ✓ |
| Schichtarten (Code, Zeiten, Farbe) pflegen | – | ✓ |
| Angenommene Tausche rückgängig machen | – | ✓ |

**Funktionsweise:** Der hochgeladene Grundplan bleibt unverändert gespeichert. Tausche und
Abwesenheiten liegen als eigene Einträge „darüber“. Man sieht also immer, was getauscht wurde (●
in der Zelle, Verlauf im Tab „Tausch“). Ein neuer Upload überschreibt keine Tausche und keine Urlaube.

## Sicherheit

- Jede Person hat einen eigenen Firebase-Login. Passwörter sieht niemand, auch die Admins nicht.
  Neue Mitarbeiter bekommen per E-Mail einen Link und setzen ihr Passwort selbst.
- Ohne **aktives Mitarbeiterprofil** sieht man nichts. Auch wer sich irgendwie selbst einen
  Firebase-Account anlegt, bekommt keinen Zugriff.
- Die Regeln in `firestore.rules` werden **auf dem Server** durchgesetzt, nicht nur in der Oberfläche:
  - Tauschanfragen gibt es nur im eigenen Namen. Annehmen kann nur die angefragte Person.
    Die getauschten Schichten lassen sich dabei nicht manipulieren.
  - Urlaub tragen Mitarbeiter nur für sich selbst ein.
  - Den Plan, die Mitarbeiter und die Rollen ändern nur Admins. Ein Admin kann sich nicht selbst aussperren.
- Die Werte in `firebase-config.js` sind öffentlich (das ist bei Firebase so vorgesehen).
  Geschützt werden die Daten allein durch Login und Regeln.

## Einrichtung (ca. 20 Minuten, einmalig)

### 1. Firebase-Projekt anlegen
1. <https://console.firebase.google.com> öffnen und **Projekt hinzufügen** wählen (z. B. „schichtplan-team“).
   Google Analytics wird nicht gebraucht. Der kostenlose **Spark-Tarif** reicht für 12 Personen locker.
2. **Build → Authentication → Jetzt starten**, dann unter *Anmeldemethode* **E-Mail/Passwort** aktivieren.
3. **Build → Firestore Database → Datenbank erstellen**. Standort **europe-west3 (Frankfurt)** wählen
   und im **Produktionsmodus** starten.
4. Unter **Firestore → Regeln** den kompletten Inhalt von `firestore.rules` einfügen und auf **Veröffentlichen** klicken.
5. **Projekteinstellungen (Zahnrad) → Allgemein → Meine Apps → Web-App hinzufügen (`</>`)**.
   Die angezeigten Werte in `firebase-config.js` eintragen.

### 2. Auf GitHub Pages veröffentlichen
1. Den Inhalt dieses Ordners in ein Repository legen. Am besten nimmst du ein **eigenes Repo**,
   z. B. `schichtplan`, und kopierst die Dateien in dessen Wurzelverzeichnis.
2. Im Repo unter **Settings → Pages → Source: Deploy from a branch** den Branch `main` und
   den Ordner `/ (root)` wählen.
3. Die Adresse lautet dann `https://<github-name>.github.io/<repo>/`.
4. In Firebase unter **Authentication → Einstellungen → Autorisierte Domains** den Eintrag
   `<github-name>.github.io` hinzufügen.

### 3. Ersten Admin anlegen
1. In Firebase unter **Authentication → Nutzer → Nutzer hinzufügen** deine E-Mail und ein Passwort eintragen.
   Danach die **Nutzer-UID** kopieren.
2. Unter **Firestore → Daten → Sammlung starten**:
   - Sammlungs-ID: `users`
   - Dokument-ID: *die kopierte UID*
   - Felder:
     - `name` (string): dein Name
     - `email` (string): deine E-Mail
     - `role` (string): `admin`
     - `active` (boolean): `true`
3. Die App öffnen und dich anmelden. Ab jetzt läuft alles über **Verwaltung**.

> Tipp: Meldest du dich an, bevor dein Profil existiert, zeigt die App dir die UID direkt an.

### 4. Team und Plan anlegen
1. **Verwaltung → + Mitarbeiter anlegen** für alle 12 Personen. Jede Person bekommt automatisch
   eine E-Mail zum Passwort-Setzen. Der Link ist begrenzt gültig; über 🔑 kannst du ihn jederzeit neu senden.
2. Unter **Schichtarten** die Codes, Zeiten und Farben anpassen.
3. Unter **Grundplan hochladen** die Datei auswählen, die Vorschau prüfen und importieren.

## Feiertage, Wunschfrei, Excel-Export

- **Feiertage (Österreich)** werden automatisch berechnet (inkl. Ostermontag, Pfingstmontag, Fronleichnam …),
  im Plan rot markiert und bei den Abwesenheitstagen nicht als Arbeitstag gezählt.
- **Wunschfrei:** Mitarbeiter tippen auf die eigene Schicht → **☆ Wunschfrei** (oder unter „Meine“ → **+ Wunsch**).
  Unverbindlich, z. B. für die Sommerurlaubsplanung. Im Plan als ☆ sichtbar. Admins sehen unter „Verwaltung“ alle Wünsche
  mit Überschneidungen und können sie mit **Als Urlaub eintragen** zusagen (der Wunsch wird dann entfernt)
  oder löschen – Dienste lassen sich trotzdem zuteilen.
- **Excel-Export** (☰ → 📊 bzw. „📊 Excel“): Monat oder ganzes Jahr, in den gewohnten Farben, mit Blättern
  „Abwesenheiten“ (inkl. Arbeitstage) und – für Admins – „Wunschfrei“.

## Kalender-Abo

Unter ☰ → **📆 Kalender-Abo** bekommt jede Person einen persönlichen Link. Damit erscheinen die eigenen Dienste
(1 Monat zurück bis 12 Monate voraus, Abwesenheiten als ganztägige Termine) im Apple-, Google- oder Outlook-Kalender.
Tausche, Übernahmen und Urlaube werden automatisch nachgezogen – je nach Kalender-App etwa stündlich bis alle paar Stunden.

- Läuft über die Cloud Function `calendar` – wird mit dem Deploy unten automatisch eingerichtet (Blaze-Tarif).
- Der Link enthält einen geheimen Schlüssel (`calTokens`). „Neuen Link erzeugen“ macht den alten ungültig.
- Kalender werden in `calCache` zwischengespeichert und nur neu berechnet, wenn sich etwas geändert hat
  (`meta/calendar`) – Abrufe der Kalender-Apps kosten so nur ~3 Lesevorgänge.
- Die Berechnung (`functions/calendar.js`) muss denselben Regeln folgen wie `effectiveDay()` in `app.js`.

## Push-Benachrichtigungen (optional)

**Wer bekommt wann eine Nachricht:**

| Ereignis | Empfänger |
|---|---|
| Neue Tauschanfrage | die angefragte Person |
| Tausch angenommen oder abgelehnt | die anfragende Person |
| Anfrage zurückgezogen | die angefragte Person |
| Tausch von einem Admin rückgängig gemacht | beide Beteiligten |
| Neuer Urlaub, Zeitausgleich oder Fortbildung | alle Admins (bei Eintrag durch einen Admin: die betroffene Person) |
| Urlaub mit zugeteilter Vertretung | die Vertretung (eine Nachricht mit allen Tagen) |
| Urlaub mit offenen Diensten | alle, die an mindestens einem dieser Tage nicht abwesend sind |
| Jemand gibt einen Dienst ab | alle anderen, die an dem Tag nicht abwesend sind |
| Offener Dienst übernommen oder von einem Admin zugeteilt | die Person im Urlaub (und die Vertretung, wenn ein Admin zugeteilt hat) |
| Urlaub gelöscht oder Vertretung neu vergeben | die bisherige Vertretung |

Beim Antippen der Nachricht öffnet sich die App direkt im passenden Bereich.

**Kosten:** Push braucht eine kleine Server-Funktion (Cloud Function), dafür den **Blaze-Tarif**.
Der Tarif rechnet nach Verbrauch ab und enthält das gleiche Gratiskontingent wie der kostenlose Tarif.
Bei 12 Personen bleibt man darin, es kostet also realistisch 0 € bis wenige Cent im Monat.
Der Versand der Push-Nachrichten selbst ist immer gratis. Trotzdem gleich ein Budget-Limit setzen (siehe unten).

### Einrichtung (einmalig, ca. 15 Minuten)
1. In der Firebase-Konsole unten links **Upgrade → Blaze** wählen und ein Rechnungskonto hinterlegen.
   Danach in der [Google Cloud Console](https://console.cloud.google.com/billing) unter
   *Budgets & Benachrichtigungen* ein Budget von z. B. **1 €** mit E-Mail-Warnung anlegen.
   Das ist nur ein Alarm, Google stoppt den Verbrauch nicht automatisch.
2. **Projekteinstellungen → Cloud Messaging → Web-Push-Zertifikate → Schlüsselpaar generieren**.
   Den Schlüssel in `firebase-config.js` bei `VAPID_KEY` eintragen und auf GitHub hochladen.
3. Auf einem PC mit [Node.js](https://nodejs.org) (Version 22) in diesem Ordner ausführen:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add            # dein Firebase-Projekt auswählen
   cd functions && npm install && cd ..
   firebase deploy --only functions,firestore:rules
   ```
   Beim ersten Deploy fragt Firebase nach `APP_URL`. Dort die Adresse der App eintragen,
   z. B. `https://name.github.io/schichtplan/`.
4. Jede Person tippt in der App einmal auf **🔕** und erlaubt Benachrichtigungen. Danach steht dort 🔔.
   Das muss **auf jedem Gerät** einzeln passieren.

**iPhone/iPad:** Apple erlaubt Web-Push nur für Apps auf dem Home-Bildschirm (ab iOS 16.4).
Also in Safari **Teilen → Zum Home-Bildschirm**, die App von dort öffnen und dann 🔕 antippen.
Die App erklärt das auch selbst. Android, Windows und Mac funktionieren direkt im Browser (Chrome, Edge, Firefox).

Beim **Abmelden** wird das Gerät abgemeldet, sodass auf gemeinsam genutzten PCs keine fremden Nachrichten ankommen.

Ob etwas verschickt wurde, siehst du in der Firebase-Konsole unter **Functions → Logs**.

**WhatsApp** statt Push wäre über die offizielle WhatsApp Business API (Meta) möglich. Dafür braucht es
eine eigene Nummer und von Meta genehmigte Textvorlagen, außerdem kostet jede Nachricht ca. 3–5 Cent.
Die Funktion in `functions/notify.js` ist so gebaut, dass sich ein weiterer Kanal ergänzen lässt.

## Übernahme aus der bisherigen Excel (einmalig)

Die bisherige Excel-Datei mit Tagen als Zeilen, Personen als Spalten und der Bedeutung über **Farben**
wird mit `tools/excel_uebernahme.py` in eine Übernahme-Datei (`.json`) umgewandelt:

| in der Excel | in der App |
|---|---|
| `6-14,15` / `14-22,15` / `22-6,15` | F / S / N |
| `TD1 auf Abruf`, `TD2 auf Abruf`, `TD 3 h Pool` | TD1 / TD2 / TD3 (Platzhalter) |
| Zelle in der **eigenen Farbe** der Person | Urlaub (Vermerk „Urlaub/ZA (aus Excel)“), ursprünglicher Dienst bleibt sichtbar |
| **rote** Zelle | Krankenstand (K) |
| **schwarze** Zelle, Schrift in der Farbe einer anderen Person | „übernommen von …“ (Vertretung/Tausch) |
| Texte wie „Erste Hilfe“, „KI-Schulung“ | Fortbildung (FB) |

```bash
pip install openpyxl
python3 tools/excel_uebernahme.py Schichtplan.xlsx uebernahme.json
```

In der App unter **Verwaltung → Übernahme aus der bisherigen Excel** die `.json` wählen, die Vorschau prüfen
und übernehmen. Die Personen werden über den **Nachnamen** zugeordnet, sie müssen also vorher angelegt sein.
Dabei werden Plan, Abwesenheiten, Markierungen und Personenfarben gesetzt. Bestehende Abwesenheiten
dieser Personen im Zeitraum werden auf Wunsch vorher ersetzt.

**Darstellung im Plan (wie in der Excel):** Abwesende in ihrer Farbe (krank: rot). Übernommene oder
getauschte Dienste erscheinen **dunkel mit Schrift in der Farbe der Person, deren Dienst es war**. Das gilt
auch für alles, was ab jetzt in der App getauscht, vertreten oder übernommen wird.
Die Farbe jeder Person lässt sich unter **Verwaltung → Bearbeiten** ändern.

## Format für den Import

Am einfachsten lädst du mit **„⬇ Vorlage“** die passende Excel-Datei herunter, füllst sie aus und lädst sie wieder hoch.
Die App erkennt drei Layouts automatisch:

**Matrix** (Standard, siehe `beispiel-grundplan.csv`):
```
Name;Do 01.10.;Fr 02.10.;Sa 03.10.
Anna Muster;F;F;S
"Bär, Ben";S;S;F
```

**Liste:**
```
Datum;Mitarbeiter;Schicht
01.10.2026;anna@firma.at;F
```

**Transponiert:** Die Tage stehen in Zeilen, die Mitarbeiter in den Spalten.

Weitere Regeln:
- **Mitarbeiter** werden über den Namen, „Nachname, Vorname“, das Kürzel oder die E-Mail erkannt.
  Groß- und Kleinschreibung spielt keine Rolle.
- Als **Datum** gehen `01.10.2026`, `01.10.26`, `2026-10-01`, echte Excel-Datumszellen und `01.10.`
  (dann gilt das Jahr aus dem Feld daneben).
- **Leer**, `-`, `frei` oder `x` bedeuten frei. Unbekannte Codes werden als neue Schichtart angelegt.
- **CSV** darf `;` oder `,` als Trennzeichen haben, in UTF-8 oder im Excel-Standard (Windows-1252).
  Erlaubt sind außerdem `.xlsx`, `.xls` und `.ods`.
- Überschrieben werden nur die Zellen der Mitarbeiter und Tage, die in der Datei vorkommen.

## Urlaub, Vertretung und offene Dienste

**Platzhalter (z. B. T):** Im Grundplan heißt `T` „ist an dem Tag da, Dienst wird noch zugeteilt“.
- Wer nur `T` hat, gilt als verfügbar. Übernimmt die Person einen offenen Dienst, **ersetzt dieser das T**.
- Für Urlaubstage mit nur `T` entsteht kein offener Dienst.
- Welche Codes Platzhalter sind, legst du unter **Verwaltung → Schichtarten** mit dem Häkchen **Platzhalter** fest.

Beim Eintragen von Urlaub listet die App **alle Dienste im Zeitraum** auf. Für jeden Dienst wählt man:
- **Vertretung: Name:** Die Person bekommt den Dienst sofort, zusätzlich zu einem eigenen Dienst, falls sie an dem Tag schon einen hat.
- **offen lassen:** Der Dienst erscheint im Plan in der roten Zeile **⚠ Offen** und im Tab **Offene Dienste**.

**Offene Dienste kann jede/r übernehmen**, außer wer an dem Tag selbst abwesend ist. **Wer zuerst kommt, bekommt den Dienst.**
Der Server stellt sicher, dass ein Dienst nicht doppelt vergeben wird. Hat man an dem Tag schon einen Dienst, fragt die App:
- **Zusätzlich übernehmen:** Man hat dann beide Dienste, im Plan z. B. `T+F`.
- **Übernehmen und meinen Dienst anbieten:** Der eigene Dienst landet bei den offenen Diensten. So entstehen Tauschketten.

**Dienst abgeben (ohne Urlaub):** Unter **Meine Schichten** auf **Abgeben** tippen.
- Der Dienst bleibt so lange der eigene, bis ihn jemand übernimmt. Er ist also nie unbesetzt.
- Alle im Team werden benachrichtigt.
- Solange niemand übernommen hat, kann man das Angebot zurückziehen.

Weitere Regeln:
- Wird ein Urlaub gelöscht, entfallen die Vertretungen und die Dienste gehen an die Person zurück.
- Admins können offene Dienste auch direkt jemandem zuteilen.

## Schichttausch

- **Gleicher Tag:** Anna (F) und Ben (S) tauschen am 01.10. Danach hat Anna S und Ben F.
- **Verschiedene Tage:** Anna gibt ihren Montag ab und übernimmt dafür Bens Mittwoch. An beiden
  Tagen werden die Einträge der beiden vertauscht.
- Vor dem Absenden zeigt die App eine Vorschau. Hat sich der Plan bis zum Annehmen geändert,
  gibt es eine Warnung.
- Ein Tausch gilt, sobald die angefragte Person annimmt. Admins können ihn rückgängig machen.

## Lokal testen (optional, ohne echte Daten)

```bash
npm i -g firebase-tools
firebase emulators:start --project demo-schichtplan   # in diesem Ordner
python3 -m http.server 5000                           # zweites Terminal
```
Danach <http://localhost:5000/?emulator> öffnen. Nutzer legst du in der Emulator-Oberfläche an
(<http://localhost:4000>), das Profil in `users` wie unter Schritt 3. In `firebase-config.js` muss
`projectId` dabei `demo-schichtplan` sein.

## Mitarbeiter verlassen das Team

Unter **Verwaltung → Bearbeiten** das Häkchen **Aktiv** entfernen. Die Person kann sich danach
nicht mehr anmelden, ihre bisherigen Einträge bleiben erhalten. Den Login ganz löschen kannst du
in der Firebase-Konsole unter *Authentication*.

## Mögliche Erweiterungen
- Zusätzlich E-Mail- oder WhatsApp-Benachrichtigung
- Freigabe von Urlaub oder Tausch durch die Teamleitung
- Feiertage im Plan markieren
- Urlaubskontingent pro Person
