// Service Worker für Push-Benachrichtigungen (zeigt Nachrichten an, wenn die App geschlossen ist).
// Die Firebase-Konfiguration wird beim Registrieren als URL-Parameter übergeben (siehe app.js).
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const config = JSON.parse(new URL(self.location.href).searchParams.get('config') || '{}');
firebase.initializeApp(config);
// Nachrichten mit "notification"-Teil zeigt das SDK selbst an; Antippen öffnet den Link aus fcmOptions.
firebase.messaging();
