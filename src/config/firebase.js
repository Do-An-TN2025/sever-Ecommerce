const admin = require('firebase-admin');

let svc = null;
try {
  if (process.env.FIREBASE_SERVICE_JSON) {
    svc = JSON.parse(process.env.FIREBASE_SERVICE_JSON);
  } else {
    console.warn('[FIREBASE] FIREBASE_SERVICE_JSON missing');
  }
} catch (e) {
  console.warn('[FIREBASE] Invalid FIREBASE_SERVICE_JSON:', e.message);
}

if (!admin.apps.length) {
  if (svc?.client_email) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    console.log('[FIREBASE] Initialized project_id:', svc.project_id);
  } else {
    console.warn('[FIREBASE] Service account incomplete (client_email missing)');
  }
}

module.exports = admin;