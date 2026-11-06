// Firebase-Konfiguration – Werte aus der Firebase-Konsole einsetzen:
// Projekteinstellungen → Allgemein → Meine Apps → Web-App → „SDK-Einrichtung und -Konfiguration“.
//
// Diese Werte sind NICHT geheim (sie landen ohnehin im Browser). Geschützt werden die
// Daten ausschließlich durch Firebase Authentication + die Regeln in firestore.rules.
export const FIREBASE_CONFIG = {
  apiKey: "HIER-API-KEY-EINTRAGEN",
  authDomain: "PROJEKT-ID.firebaseapp.com",
  projectId: "PROJEKT-ID",
  storageBucket: "PROJEKT-ID.firebasestorage.app",
  messagingSenderId: "",
  appId: ""
};
