// ─── FIREBASE CONFIG ─────────────────────────────────────────────────────────
// Zamijeni ove vrijednosti s tvojim Firebase config podacima!
const firebaseConfig = {
  apiKey:            "TVOJ_API_KEY",
  authDomain:        "TVOJ_PROJECT.firebaseapp.com",
  projectId:         "TVOJ_PROJECT_ID",
  storageBucket:     "TVOJ_PROJECT.appspot.com",
  messagingSenderId: "TVOJ_SENDER_ID",
  appId:             "TVOJ_APP_ID"
};

import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }     from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
