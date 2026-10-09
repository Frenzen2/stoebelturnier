// Firebase-Konfiguration – Werte aus der Firebase-Konsole einsetzen:
// Projekteinstellungen → Allgemein → Meine Apps → Web-App → "SDK-Einrichtung und -Konfiguration".
//
// Diese Werte sind NICHT geheim (sie landen ohnehin im Browser). Geschützt werden die
// Daten ausschließlich durch Firebase Authentication + die Regeln in firestore.rules.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCyEXeDqjHAIPjm0TmrTrI0twnwTevOpTw",
  authDomain: "ragschicht.firebaseapp.com",
  projectId: "ragschicht",
  storageBucket: "ragschicht.firebasestorage.app",
  messagingSenderId: "1006184548262",
  appId: "1:1006184548262:web:4705504add873e72e4b167"
};

// Für Push-Benachrichtigungen: Projekteinstellungen → Cloud Messaging →
// Web-Konfiguration → Web-Push-Zertifikate → "Schlüsselpaar generieren" → Schlüssel hier einfügen.
export const VAPID_KEY = "BKJY9vILMzqmj66iR9Ms33En7FczkSTQsd0NinH5qULBDvXE_77qyJ-KSPwmDgA9CNZS0rO5LG4AV1RGKzgusqw";
