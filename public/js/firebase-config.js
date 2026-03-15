// ─── FIREBASE CONFIG ─────────────────────────────────────────────────────────
// Zamijeni ove vrijednosti s tvojim Firebase config podacima!
const firebaseConfig = {
  apiKey: "AIzaSyDeWgrG5ulkp5VmqioCKkDGyOmEY1d7gzA",
  authDomain: "kviz-13f52.firebaseapp.com",
  projectId: "kviz-13f52",
  storageBucket: "kviz-13f52.firebasestorage.app",
  messagingSenderId: "138433175415",
  appId: "1:138433175415:web:3173d13a6b35025174cb72",
  measurementId: "G-8CY3P68KM8"
};

import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }     from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
