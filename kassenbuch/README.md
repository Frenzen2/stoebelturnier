# Kassenbuch FF Pichl

Web-App für die Kassaführung der Freiwilligen Feuerwehr Pichl. Läuft auf GitHub Pages, Daten und
Login liegen in Google Firebase, genau wie beim Schichtplan. Es gibt keinen Build-Schritt und keinen
eigenen Server, nur statische Dateien.

## Funktionen

- **Persönlicher Login** (E-Mail und eigenes Passwort) mit Rollen:

  | Rolle | darf |
  |---|---|
  | **Admin** | alles, auch Benutzer, Konten und Kategorien verwalten und abgeschlossene Jahre wieder öffnen |
  | **Kassier** | Raika-CSV importieren, kontieren, Veranstaltungen und Festkassa führen, Jahr abschließen |
  | **Festkassa** | nur Einträge im Festkassabuch offener Veranstaltungen (z. B. für den Festkassier) |
  | **Kassaprüfer** | alles ansehen, auch das Änderungsprotokoll, aber nichts ändern |

- **Zwei Bankkonten**: *Feuerwehrkassa* und *Mannschaftskassa*. Weitere Konten (z. B. Sparbuch) lassen sich ergänzen.
- **Raika-Import**: CSV-Export aus ELBA einlesen. Die Spalten werden automatisch erkannt.
  Bereits importierte Umsätze werden übersprungen, überlappende Zeiträume sind also kein Problem.
- **Kontenplan wie im Feuerwehr-Rechnungsabschluss**: Die Feuerwehrkassa wird nach den **Voranschlagsposten (V-P)**
  der Gemeinde kontiert (Einnahmen 298 … 871, Ausgaben 10 … 729). Die **Mannschaftskassa muss nicht kontiert werden**:
  ihre Buchungen zählen nie als „unkontiert“. Festkassa oder Veranstaltung lassen sich bei Bedarf trotzdem zuordnen.
- **Laufende Belegnummern** je Konto und Jahr in ELBA-Reihenfolge, wie in der bisherigen Excel-Liste.
- **Kontieren**: Jede Buchung bekommt eine Kategorie aus dem Kontenplan und optional eine Veranstaltung.
  Mehrere Buchungen auf einmal kontieren, eine Buchung auf mehrere Kategorien aufteilen,
  **Kontierungsregeln** (z. B. „Kontoführung“ → Bankspesen) wirken schon beim Import.
- **Festkassabuch je Veranstaltung** (Zeltfest, Ball, Florianifeier …): Wechselgeld, Einnahmen je Stand,
  **Kassasturz mit Zählprotokoll** (Scheine und Münzen), Barausgaben mit Beleg-Nr., Ablieferung an die Bank,
  laufender Kassabestand und Abrechnung nach Bereichen. Druckbar mit Unterschriftszeilen.
- **Feuerwehr-Rechnungsabschluss für die Gemeinde**: alle V-P mit Summen, Summe der Einnahmen und Ausgaben,
  Kassastand 01.01. und 01.01. des Folgejahres, Unterschriften (Rechnungsprüfer, Kassier, Feuerwehrkommandant). Wie das Blatt „Abschluß Gde“.
- **Kassabuch** je Konto zum Ausdrucken: Nr., Datum, Bezeichnung, Einnahme, Ausgabe, Kontierung, laufender Saldo.
- **Kontierung aus der bisherigen Excel übernehmen** (Spalten Belegnr., Datum, Bezeichnung, Betrag, Kontierung).
- **Jahresabschluss**: Anfangsbestand, Einnahmen und Ausgaben je Kategorie und Konto, Umbuchungen, Endbestand,
  Abgleich mit dem Kontoauszug, Übersicht der Veranstaltungen. Hinweise auf Unkontiertes, offene Festkassen
  und Differenzen. Druck/PDF mit Unterschriften (Kassier, Kommandant, Kassaprüfer), CSV für Excel.
  **Jahr abschließen** sperrt alle Buchungen des Jahres und überträgt die Endbestände ins Folgejahr.
- **Änderungsprotokoll**: Jede Änderung wird mit Person und Zeitpunkt festgehalten und kann nicht gelöscht werden.

## Sicherheit

- Ohne **aktives Profil** in der Datenbank sieht man nichts, auch wenn sich jemand selbst einen Firebase-Login anlegt.
- Die Regeln in `firestore.rules` werden **auf dem Server** durchgesetzt, nicht nur in der Oberfläche:
  - Rollen wie oben; Kassaprüfer können nichts schreiben.
  - Betrag, Datum, Text und Konto einer **importierten** Bankbuchung lassen sich nicht verändern, nur kontieren.
  - Beträge sind ganze Cent-Zahlen; das Buchungsjahr muss zum Datum passen.
  - Ein **abgeschlossenes Jahr** ist gegen jede Änderung gesperrt. Nur ein Admin kann es wieder öffnen.
  - Das Protokoll kann nur ergänzt werden, nie geändert oder gelöscht. Einträge nur im eigenen Namen.
- Die Werte in `firebase-config.js` sind öffentlich (das ist bei Firebase so vorgesehen).

## Einrichtung (ca. 20 Minuten, einmalig)

### 1. Firebase-Projekt anlegen
1. <https://console.firebase.google.com> → **Projekt hinzufügen**, z. B. „ffpichl-kassa“.
   Google Analytics wird nicht gebraucht. Der kostenlose **Spark-Tarif** reicht.
   (Ein eigenes Projekt, getrennt vom Schichtplan und vom Stöbelturnier, wird empfohlen.)
2. **Build → Authentication → Jetzt starten**, unter *Anmeldemethode* **E-Mail/Passwort** aktivieren.
3. **Build → Firestore Database → Datenbank erstellen**, Standort **europe-west3 (Frankfurt)**, **Produktionsmodus**.
4. **Firestore → Regeln**: den kompletten Inhalt von `firestore.rules` einfügen und **Veröffentlichen**.
5. **Projekteinstellungen (Zahnrad) → Allgemein → Meine Apps → Web-App hinzufügen (`</>`)**.
   Die angezeigten Werte in `firebase-config.js` eintragen.

### 2. Auf GitHub Pages veröffentlichen
1. Am besten ein **eigenes Repository** anlegen, z. B. `kassenbuch`, und den Inhalt dieses Ordners ins Wurzelverzeichnis kopieren.
   (Alternativ funktioniert es auch direkt aus diesem Ordner: `https://<github-name>.github.io/stoebelturnier/kassenbuch/`.)
2. **Settings → Pages → Source: Deploy from a branch**, Branch `main`, Ordner `/ (root)`.
3. In Firebase unter **Authentication → Einstellungen → Autorisierte Domains** `<github-name>.github.io` hinzufügen.

### 3. Ersten Admin anlegen
1. **Authentication → Nutzer → Nutzer hinzufügen**: E-Mail und Passwort eintragen, die **Nutzer-UID** kopieren.
2. **Firestore → Daten → Sammlung starten**: Sammlungs-ID `users`, Dokument-ID = *die UID*, Felder:
   - `name` (string): dein Name
   - `email` (string): deine E-Mail
   - `role` (string): `admin`
   - `active` (boolean): `true`
3. App öffnen und anmelden. Meldest du dich an, bevor das Profil existiert, zeigt die App die UID direkt an.

### 4. Loslegen
1. Auf der Übersicht **„Feuerwehrkassa und Mannschaftskassa anlegen“** tippen.
2. **Verwaltung → Bankkonten**: bei beiden Konten die **IBAN** eintragen.
3. **Verwaltung → Kategorien**: den vorgeschlagenen Kontenplan prüfen und anpassen (Nummern, Namen, neue Kategorien).
4. **Verwaltung → Benutzer**: Kassier, Festkassier und Kassaprüfer anlegen. Jede Person bekommt eine
   E-Mail mit einem Link, um ihr Passwort selbst zu setzen.
5. **Jahresabschluss**: für das erste Jahr den **Anfangsbestand per 1.1.** je Konto eintragen.
   In den Folgejahren wird er aus dem abgeschlossenen Vorjahr übernommen.

## Raika-Umsätze importieren

1. In **ELBA** (bzw. Mein ELBA) das Konto öffnen, unter *Umsätze* den Zeitraum wählen und als **CSV exportieren**.
2. In der App **Raika-Import → Konto wählen → Datei auswählen**.
3. Spaltenzuordnung und Vorschau prüfen und **Importieren** tippen.

Das klassische ELBA-Format hat keine Kopfzeile:

```
Buchungsdatum;Buchungstext;Valutadatum;Betrag;Währung;Zeitstempel
02.01.2026;Gutschrift Gemeinde Pichl … Subvention;02.01.2026;+3.500,00;EUR;02.01.2026 07:12:44:301
```

Ein Beispiel liegt in `beispiel-raika.csv`. Erkannt werden außerdem Dateien **mit Kopfzeile**
(z. B. „Buchungsdatum“, „Betrag“, „Auftraggeber/Empfänger“, „Verwendungszweck“), mit `;`, `,` oder Tab
als Trennzeichen, in UTF-8 oder Windows-1252. Stimmt eine Spalte nicht, lässt sie sich in der Vorschau umstellen.
Steht die IBAN im Dateinamen, wird das Konto automatisch gewählt.

**Doppelte Umsätze:** Jeder Umsatz bekommt eine Kennung aus Datum, Valuta, Betrag, Text und Zeitstempel.
Wird er erneut importiert, wird er übersprungen. Zwei gleiche Umsätze am selben Tag in derselben Datei bleiben getrennt.

## Kontieren

**Kontenplan:** Für die Feuerwehrkassa sind die Voranschlagsposten des Feuerwehr-Rechnungsabschlusses angelegt
(z. B. 753 lfd. Transferz. v. Gemeinden, 823 Zinsen, 829 Sonst. Einnahmen; 409 Ersatzteile, 616 Instandh. Geräte,
728 Entgelte für sonst. Leistungen, 729 Sonst. Ausgaben). Die Mannschaftskassa wird nicht kontiert; dort kann man optional die Festkassa-Kategorie und eine Veranstaltung wählen.
Ob ein Konto kontiert werden muss, stellt man unter *Verwaltung → Bankkonten* ein („muss nicht kontiert werden“).
Die Festkassa-Kategorie (Wechselgeld, Ablieferung) erscheint im Gemeinde-Abschluss bei Eingängen unter 829 und bei Ausgängen unter 729,
so wie bisher in der Excel. Das lässt sich unter Verwaltung → Kategorien ändern.

**Bisherige Excel übernehmen:** Raika-CSV des Jahres importieren, dann unter *Raika-Import → Kontierung aus der bisherigen Excel übernehmen*
Konto und Excel-Datei wählen (Blatt z. B. „FW Kassa“). Zugeordnet wird über Datum und Betrag.

- **Buchungen** zeigt alle Bankbuchungen des gewählten Jahres. Der rote Zähler am Reiter zeigt, wie viele noch unkontiert sind.
- Buchung antippen → Kategorie und ggf. Veranstaltung wählen. Mit **„Für künftige Importe merken“**
  entsteht eine Regel, die ähnliche Umsätze künftig automatisch kontiert.
- **Mehrere auf einmal:** Häkchen setzen → Kategorie wählen → *Zuweisen*.
- **Aufteilen:** z. B. eine Rechnung, die teils das Fest und teils die Kameradschaftspflege betrifft.
- **⚙ Regeln anwenden** kontiert alle noch offenen Buchungen nach den aktuellen Regeln.
- **Umbuchungen** zwischen Feuerwehrkassa und Mannschaftskassa mit der Kategorie *Umbuchung* kontieren.
  Sie zählen weder als Einnahme noch als Ausgabe, ergeben in Summe 0, und der Abschluss warnt, wenn eine Seite fehlt.
- **+ Buchung** legt eine manuelle Buchung an, z. B. für ein Konto ohne CSV-Export.

## Festkassa für Veranstaltungen

Typischer Ablauf, z. B. beim Zeltfest:

1. **Festkassa → + Veranstaltung** (Name, Datum, Verantwortlicher).
2. **+ Wechselgeld**: Wechselgeld, das in die Kassen gegeben wird (je Stand oder gesamt).
3. Nach dem Fest je Stand einen **🧮 Kassasturz** machen: Anzahl der Scheine und Münzen eingeben,
   das enthaltene Wechselgeld abziehen. Daraus wird die Einnahme.
   Alternativ Einnahmen direkt mit **+ Einnahme** eintragen.
4. **+ Barausgabe** für alles, was bar aus der Festkassa bezahlt wurde (mit Beleg-Nr.).
5. **+ Ablieferung an Bank**, wenn das Geld eingezahlt wird. Danach sollte der Kassabestand 0 sein.
6. Beim Kontieren der Bankbuchungen:
   - die Einzahlung (und eine Wechselgeld-Abhebung) mit **„Festkassa: Ablieferung / Wechselgeld“**
     und der Veranstaltung kontieren, damit sie nicht doppelt zählt;
   - Rechnungen, die über die Bank bezahlt wurden (Getränke, Zelt, Musik), mit
     **„Veranstaltungen – Ausgaben (Bank)“** und der Veranstaltung kontieren.
7. Die Abrechnung zeigt dann das **Gesamtergebnis** aus Bar- und Bankbewegungen.
   **✓ Abschließen** sperrt das Festkassabuch, **🖨 Drucken** erzeugt das Festkassabuch mit Zählprotokollen und Unterschriften.

## Jahresabschluss

1. Alle Umsätze bis 31.12. importieren und kontieren, bis der Zähler auf 0 steht.
   Für den **Feuerwehr-Rechnungsabschluss** müssen alle Buchungen der Feuerwehrkassa einen V-P haben – sonst erscheint ein Hinweis.
2. Im Reiter **Jahresabschluss** den **Saldo laut Kontoauszug per 31.12.** je Konto eintragen.
   Die Differenz zum Endbestand laut Buchungen muss 0 sein.
3. Die Hinweise abarbeiten (unkontierte Buchungen, offene Festkassen, Umbuchungen).
4. **🏛 Rechnungsabschluss drucken** für die Gemeinde, **🖨 Drucken / PDF** (Übersicht beider Konten) für Kassaprüfung
   und Mitgliederversammlung, **⬇ CSV** für Excel. Das Kassabuch eines Kontos druckt man unter *Buchungen* (Konto wählen → 🖨 Kassabuch).
5. **🔒 Jahr abschließen**. Danach ist das Jahr gesperrt, und die Endbestände werden
   als Anfangsbestände ins neue Jahr übernommen.

## Lokal testen (optional, ohne echte Daten)

```bash
npm i -g firebase-tools
firebase emulators:start --project demo-kassenbuch   # in diesem Ordner
python3 -m http.server 5000                          # zweites Terminal
```

Danach <http://localhost:5000/?emulator> öffnen. Nutzer legst du in der Emulator-Oberfläche an
(<http://localhost:4000>), das Profil in `users` wie unter Schritt 3.

Die Rechen- und Importlogik (`lib.js`) hat eigene Tests: `npm test` (Node 20 oder neuer).

## Datenmodell (Firestore)

| Sammlung | Inhalt |
|---|---|
| `users/{uid}` | name, email, role, active |
| `konten/{id}` | name, iban, order, ohneKontierung (Standard: `feuerwehr`, `mannschaft` mit ohneKontierung) |
| `config/kategorien` | `list`: Kontenplan [{id, nr, name, art: E/A/F/U, konto, vp, vpE, vpA, inaktiv}] |
| `config/allgemein` | ffName, gemeinde, ort (Kopf der Ausdrucke) |
| `config/regeln` | `list`: Kontierungsregeln [{muster, richtung, konto, kategorie}] |
| `buchungen/{id}` | konto, datum, valuta, jahr, betrag (Cent), text, zeitstempel, seq (Zeile im ELBA-Export), kategorie, veranstaltung, splits, beleg, notiz, quelle (import/manuell) |
| `veranstaltungen/{id}` | name, jahr, von, bis, ort, konto, verantwortlich, status (offen/abgeschlossen) |
| `veranstaltungen/{id}/posten/{id}` | art (wechselgeld/einnahme/ausgabe/ablieferung), datum, zeit, betrag (Cent), bereich, text, beleg, stueckelung |
| `jahre/{jahr}` | anfang, bankEnde, gesperrt, endsalden |
| `log/{id}` | Änderungsprotokoll: uid, name, wann, aktion, text |

Alle Beträge werden als ganze **Cent** gespeichert (12,50 € = 1250), damit keine Rundungsfehler entstehen.

## Mögliche Erweiterungen

- Belege (Rechnungen) als Foto/PDF an Buchungen hängen (Firebase Storage)
- Excel-Export mit Formatierung
- Budget/Voranschlag je Kategorie mit Soll-Ist-Vergleich
