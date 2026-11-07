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
  ihre Buchungen zählen nie als „unkontiert“; zuordnen lassen sie sich nur dem Festkassabuch einer Veranstaltung.
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

## Handy und Computer

Die App läuft im Browser auf Computer, Tablet und Handy – ohne Installation, mit demselben Login.

- **Computer**: am bequemsten für Import, Kontieren, Jahresabschluss und Ausdrucke (PDF).
- **Handy**: Listen werden als Karten angezeigt (Datum, Betrag, Text, Kategorie), die Filter bei den Buchungen sind
  eingeklappt. Gut geeignet zum Nachschauen, Kontieren einzelner Buchungen und für die **Festkassa direkt beim Fest**
  (Einnahmen/Ausgaben erfassen, Kassasturz mit Zählprotokoll).
- **Als App auf den Startbildschirm**: iPhone/iPad in Safari *Teilen → Zum Home-Bildschirm*, Android in Chrome
  *⋮ → Zum Startbildschirm hinzufügen*. Dann startet das Kassenbuch wie eine App mit eigenem Symbol.
- Es ist eine Internetverbindung nötig; kurze Funklöcher überbrückt die App, Änderungen werden nachgeschickt.

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

## Sponsoren und Transparente

Im Festkassabuch jedes Festes gibt es den Bereich **Sponsoren / Transparente**:

- **+ Sponsor**: Name, Anschrift, Leistung, Betrag, Zahlweg (*Überweisung* mit Rechnung oder *bar* in die Festkassa),
  Fotos vom Transparent. Bekannte Sponsoren werden beim Tippen vorgeschlagen, die Anschrift wird übernommen.
- **⧉ Aus anderem Fest übernehmen**: z. B. alle Sponsoren vom Wiesnfest des Vorjahres – Status „offen“, ohne Rechnungsnummer.
- **🖨 Rechnungen**: fortlaufende Nummer je Jahr (2026-001, 2026-002 …), Briefkopf, IBAN und Rechnungsnummer als
  Verwendungszweck; für Barzahler eine Quittung. Im Druckdialog „Als PDF speichern“ für den Versand per E-Mail.
- **🖨 Dankesschreiben** mit dem ersten Foto des Transparents.
- **⇄ Zahlungen zuordnen**: Zahlungseingänge beider Konten werden über die **Rechnungsnummer** im Text oder über
  **Betrag und Namen** erkannt; der Sponsor wird „bezahlt“ und mit der Bankbuchung verknüpft.
- **⬇ Aus Überweisungen**: Eingänge mit „Transparent“, „Sponsoring“ oder „Werbung“, die noch keinem Sponsor gehören,
  als neue (bezahlte) Sponsoren anlegen – Zahlungen, die schon einer Position entsprechen, werden nicht vorgeschlagen.
- **Bezahlte Sponsoren stehen automatisch im Festkassabuch** (Bereich „Transparente“, bar oder Überweisung) und zählen
  zum Ergebnis; offene Rechnungen nicht – sie erscheinen als Hinweis im Jahresabschluss.
- Aus dem bisherigen Excel übernommene Transparent-Positionen lassen sich mit **In Sponsoren umwandeln** übernehmen
  (das Ergebnis bleibt gleich, Überweisungen werden gleich verknüpft).

Briefkopf (Anschrift, E-Mail, Kommandant, Kassier), Konto für Zahlungen, Zahlungsziel, Steuerhinweis und die Texte für
Rechnung und Dankesschreiben stellt der Admin unter **Verwaltung → Briefkopf, Rechnungen und Dankesschreiben** ein.
Den Steuerhinweis bitte mit der Gemeinde bzw. Steuerberatung abklären.

## Belege (PDF und Fotos)

An jede Bankbuchung und jede Festkassa-Position lassen sich Belege hängen: **📄 Datei wählen** (PDF oder Bild) oder am Handy
**📷 Foto** direkt mit der Kamera. Fotos werden vor dem Hochladen verkleinert (max. 2000 px), höchstens 15 MB pro Datei.

- In der Buchungsliste zeigt **📎** die Anzahl der Belege; der Filter **Beleg → ohne Beleg** zeigt, wo noch einer fehlt.
- Antippen öffnet den Beleg. Lesen dürfen alle mit Profil (auch Kassaprüfer); hochladen und löschen Kassier/Admin,
  bei der Festkassa auch die Rolle Festkassa. In abgeschlossenen Jahren lassen sich Belege nicht mehr löschen oder ergänzen.
- **Jahresabschluss → 📎 Belege als ZIP** lädt alle Belege des Jahres herunter – geordnet nach Konto bzw. Fest,
  benannt nach Belegnummer, Datum und Text, mit einer **Belegliste.csv**.

**Einrichtung (einmalig):**
1. Firebase-Projekt auf den **Blaze-Tarif** umstellen (wie beim Schichtplan) und in der Google Cloud Console ein
   **Budget** mit E-Mail-Warnung anlegen, z. B. 1 €. Belege einer Feuerwehr brauchen meist weit unter 1 GB – das kostet Cent-Beträge.
2. **Build → Storage → Jetzt starten**, Standort wie bei Firestore (z. B. europe-west3).
3. **Storage → Regeln**: Inhalt von `storage.rules` einfügen und **Veröffentlichen**. Die Konsole fragt, ob Storage
   auf Firestore zugreifen darf (für Rollen und Jahressperre) – **zulassen**.
4. Für den **ZIP-Download** einmal CORS setzen: in der Google Cloud Console oben rechts die **Cloud Shell** öffnen, `cors.json`
   hochladen (⋮ → Hochladen) und ausführen:
   ```bash
   gsutil cors set cors.json gs://PROJEKT-ID.firebasestorage.app
   ```
   (Bucket-Name steht in der Firebase-Konsole unter Storage.) Öffnen einzelner Belege funktioniert auch ohne diesen Schritt.

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
728 Entgelte für sonst. Leistungen, 729 Sonst. Ausgaben). Die Mannschaftskassa wird nicht kontiert; dort ordnet man nur Buchungen dem Festkassabuch einer Veranstaltung zu.
Ob ein Konto kontiert werden muss, stellt man unter *Verwaltung → Bankkonten* ein („muss nicht kontiert werden“).
Wechselgeld-Abhebungen werden wie bisher mit 729, Einzahlungen von Festerlösen und Wechselgeld retour mit 829 kontiert;
die Zuordnung zum Festkassabuch ist davon unabhängig (siehe „Festkassa für Veranstaltungen“).

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

Typischer Ablauf, z. B. beim Wiesnfest:

1. **Festkassa → + Veranstaltung** anlegen (Name, Datum, Verantwortlicher) – am besten **vor** dem Raika-Import.
2. **Wechselgeld** wird von der Feuerwehr- oder Mannschaftskassa abgehoben. Diese Bankbuchung wird dem Festkassabuch
   zugeordnet und erscheint dort automatisch als *Wechselgeld / Vorschuss* (🏦). Nichts doppelt eintragen.
3. Nach dem Fest je Stand einen **🧮 Kassasturz** machen: Anzahl der Scheine und Münzen eingeben,
   das enthaltene Wechselgeld abziehen. Daraus wird die Einnahme. Alternativ Einnahmen mit **+ Einnahme** eintragen.
4. **+ Ausgabe** / **+ Einnahme** für eigene Positionen (mit Beleg-Nr.). Bei jeder Position wählt man:
   - **Zahlweg**: *Bar aus der Festkassa* (ändert den Kassabestand) oder *Überweisung* (steht im Festkassabuch,
     ändert den Kassabestand nicht – z. B. die Getränkerechnung, die der Kassier überweist);
   - **zählt fürs Ergebnis**: abschalten für Durchlaufposten wie Pfand, Kaution oder weitergeleitetes Geld.
     Sie ändern (bar) den Kassabestand, aber nicht das Ergebnis und stehen in der Abrechnung getrennt.
5. Das Geld wird auf ein Bankkonto eingezahlt (Erlös, Wechselgeld retour). Auch diese Bankbuchungen dem Festkassabuch
   zuordnen; sie erscheinen als *Ablieferung an Bank* (🏦). Danach ist der Kassabestand 0.
6. **✓ Abschließen** sperrt das Festkassabuch, **🖨 Drucken** erzeugt das Festkassabuch mit Zählprotokollen und Unterschriften.

**Ohne Kassasturz – Barumsatz errechnen:** Wird nicht je Stand gezählt, sondern nur der Erlös eingezahlt, fehlt der Barumsatz
und der Kassabestand wird negativ. **🧮 Barumsatz errechnen** trägt ihn als Einnahme ein:
Barumsatz = Ablieferungen + Barausgaben − Wechselgeld − sonstige Bareinnahmen. Das Ergebnis ist dann dasselbe wie bei der
bisherigen Netto-Rechnung im Excel (Einzahlung + Überweisungen − Überweisungs-Ausgaben), die Bar-Positionen stehen aber brutto drin.

**Bisheriges Festkassabuch aus Excel übernehmen** (⬆ Excel übernehmen): Aufbau *Datum | Text | Einnahmen | Ausgaben | Zahlweg*
mit „Überweisung“, „bar in/aus Geldtasche“ oder „Bank“. Positionen ohne eigenes Datum bekommen das Datum der Veranstaltung,
Zeilen über „Summe Transparente“ den Bereich „Transparente“. Übersprungen werden die Bankbewegungen
(Wechselgeld, „Bank“, „Bank Einzahlung“) – dafür die Bankbuchungen zuordnen – sowie Summen- und Ergebniszeilen.
Steckt in der Zeile „Bank Einzahlung“ zusätzlich eine Überweisung (z. B. Transparente), diese als eigene Position oder
Bankbuchung (🧾) ergänzen. Erneutes Übernehmen ersetzt die zuvor übernommenen Positionen.

**Abgleich mit der Bank:** Unter dem Festkassabuch vergleicht die App jede Position mit Zahlweg *Überweisung* mit den
Bankbuchungen beider Konten (60 Tage vor bis 120 Tage nach dem Fest) – gleicher Betrag, Summe mehrerer Buchungen
(z. B. drei SumUp-Auszahlungen, sechs Getränke-Einkäufe am selben Tag, zwei Brau-Union-Rechnungen) oder ähnlicher Name mit
abweichendem Betrag. Angezeigt werden Abweichungen (mit „Bankbetrag übernehmen“), Positionen ohne Bankbuchung,
Treffer nur über den Betrag (Name prüfen) und Bankbuchungen, die das Fest nennen, aber im Festkassabuch fehlen
(mit „+ als Position“).

**Feste unterscheiden:** Jedes Fest ist eine eigene Veranstaltung (je Jahr eine neue, z. B. „Wiesnfest 2026“).
Erkannt wird ein Fest in Bank-Texten an den markanten Wörtern seines Namens (ab 5 Buchstaben, ohne Jahreszahl) und an den
**weiteren Suchbegriffen** in der Veranstaltung (mit Komma getrennt, z. B. „Wiesn, Oktoberfest, Frühschoppen“; kurze Begriffe
nur als ganzes Wort). Passen mehrere Feste, gewinnt der längere, genauere Begriff; bei Gleichstand wird nichts automatisch
zugeordnet. Der Dialog zeigt beim Eingeben, wie viele Bankbuchungen des Jahres gefunden werden.

**Bankbuchungen dem Festkassabuch zuordnen** – in beiden Konten:

- Beim Import geschieht das automatisch für Wechselgeld, Erlös und Einzahlungen, wenn der **Name der Veranstaltung**
  oder einer ihrer **weiteren Suchbegriffe** im Bank-Text steht (z. B. „Wechselgeld für Wiesnfest“, „Erlös Sonnwendfeuer“, „Zahlungsreferenz: Wiesnfest“).
- Alles andere (z. B. „Wechselgeld retour“) im Festkassabuch über **🏦 Bankbuchung zuordnen**: Die App schlägt Buchungen
  beider Konten rund um das Fest vor, die wahrscheinlichsten sind schon angehakt.
- Oder beim Kontieren einer Buchung im Feld **„Festkassabuch der Veranstaltung“**.
- Art der Zuordnung:
  - 💶 **Geld zwischen Bank und Festkassa** (Wechselgeld/Ablieferung) – steht im Festkassabuch, zählt nicht zum Ergebnis;
  - 🧾 **Einnahme/Ausgabe der Veranstaltung über die Bank** (Rechnung Getränke, SumUp …) – zählt zum Ergebnis des Festes,
    ändert den Kassabestand nicht. Wird nur von Hand zugeordnet.
  - Eine Rechnung entweder als Position mit Zahlweg *Überweisung* eintragen **oder** die Bankbuchung als 🧾 zuordnen –
    nicht beides. Die App warnt, wenn beides mit demselben Betrag vorkommt.
- In der **Feuerwehrkassa** bleibt die V-P-Kontierung davon unabhängig (Wechselgeld-Abhebung 729, Einzahlung 829 wie bisher).
  Die **Mannschaftskassa** hat keine Kontierung – dort gibt es nur die Zuordnung zum Festkassabuch.
- **Alle zugeordneten Bankbuchungen beider Konten stehen als eigene Zeilen (🏦 mit Kontoname) im Festkassabuch** –
  Wechselgeld/Ablieferung ändern den Kassabestand, Rechnungen und Eingänge über die Bank zählen zum Ergebnis, ohne den Bestand zu ändern.
- Die Knöpfe **+ Wechselgeld (bar)** / **+ Ablieferung (bar)** sind nur für Bargeld, das nicht über ein Bankkonto läuft.

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
| `buchungen/{id}` | konto, datum, valuta, jahr, betrag (Cent), text, zeitstempel, seq (Zeile im ELBA-Export), festArt (kassa/bank), kategorie, veranstaltung, splits, beleg, notiz, quelle (import/manuell) |
| `veranstaltungen/{id}` | name, jahr, von, bis, ort, konto, verantwortlich, status (offen/abgeschlossen) |
| `veranstaltungen/{id}/posten/{id}` | art (wechselgeld/einnahme/ausgabe/ablieferung), datum, zeit, betrag (Cent), bereich, text, beleg, zahlweg (bar/ueberweisung), ergebnis (true/false), stueckelung |
| `veranstaltungen/{id}/sponsoring/{id}` | name, zusatz, strasse, plzOrt, email, leistung, betrag (Cent), zahlweg, status (offen/bezahlt), bezahltAm, buchungId, rechnungsNr, rechnungsDatum, belege (Fotos), dankGedruckt |
| `jahre/{jahr}` | anfang, bankEnde, gesperrt, endsalden, rechnungNr (Zähler für Rechnungsnummern) |
| Storage `belege/{jahr}/buchung/{id}/…`, `belege/{jahr}/posten/{fest}/{id}/…` | Belege; am Dokument steht `belege: [{id, name, pfad, typ, groesse, am, von}]` |
| `log/{id}` | Änderungsprotokoll: uid, name, wann, aktion, text |

Alle Beträge werden als ganze **Cent** gespeichert (12,50 € = 1250), damit keine Rundungsfehler entstehen.

## Mögliche Erweiterungen

- Belege (Rechnungen) als Foto/PDF an Buchungen hängen (Firebase Storage)
- Excel-Export mit Formatierung
- Budget/Voranschlag je Kategorie mit Soll-Ist-Vergleich
