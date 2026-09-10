# 📚 KvizMajstor

AI platforma za testiranje učenika. Čisti HTML/CSS/JS + Node.js backend.
Sve se pokreće s jednog servera na Render.com — nema lokalnog builda.

## Stack
- **Frontend**: HTML + CSS + Vanilla JS (ES modules, Firebase SDK via CDN)
- **Backend**: Node.js + Express (servira i HTML i API)
- **AI**: Mistral AI (generisanje pitanja iz PDF-a)
- **Baza**: Firebase Firestore
- **Auth**: Firebase Authentication
- **Deploy**: Render.com

## Stranice
| Ruta | Opis |
|------|------|
| `/` | Login / Registracija |
| `/admin` | Admin panel (kvizovi, rezultati, učenici) |
| `/create-quiz` | Kreiranje kviza iz PDF-a s AI |
| `/student` | Lista kvizova za učenika |
| `/take-quiz?id=...` | Rješavanje kviza s tajmerom |
| `/result?id=...` | Pregled rezultata |
| `/admin` → tab **Literatura** | Upload/uređivanje materijala (PDF, Word, PPT) |
| `/student` → tab **Literatura** | Čitanje i preuzimanje materijala za svoj razred |

## Setup

### 1. Firebase config
Uredi `public/js/firebase-config.js` i unesi tvoje Firebase podatke.

### 2. Environment varijable na Render
Dodaj `MISTRAL_API_KEY` u Render dashboard → Environment.

### 3. Firebase Firestore Rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      // Svi prijavljeni mogu čitati, vlasnik + admin mogu pisati
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    match /quizzes/{quizId} {
      allow read: if request.auth != null;
      allow write: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    match /results/{resultId} {
      allow read, write: if request.auth != null;
    }
  }
}
```
> **Napomena:** Za izmjenu razreda admin koristi backend API `/api/admin/user/:uid` koji radi preko Firebase Admin SDK i zaobilazi rules, tako da radi i sa starim pravilima.

### 4. Literatura (materijali) — Firebase Storage

Materijali (PDF/DOC/DOCX/PPT/PPTX/TXT, max 20 MB) se čuvaju u **Firebase Storage**,
a metapodaci u Firestore kolekciji `materials`. Sav pristup ide kroz backend
(Firebase Admin SDK) pa **nisu potrebna dodatna Storage/Firestore pravila**.

Environment varijable:
- `FIREBASE_SERVICE_ACCOUNT` — JSON service account (već potreban za brisanje/izmjenu korisnika)
- `FIREBASE_STORAGE_BUCKET` — opcionalno, default `kviz-13f52.firebasestorage.app`

U Firebase Console → Storage → *Get started* (jednom aktivirati bucket).

**API rute:**
| Metoda | Ruta | Ko | Opis |
|---|---|---|---|
| GET | `/api/materials` | svi prijavljeni | lista (učenik vidi samo svoj razred + vidljive) |
| POST | `/api/materials` | admin | upload (multipart: `file`, `title`, `subject`, `description`, `razredi` JSON) |
| PUT | `/api/materials/:id` | admin | izmjena naziva/predmeta/razreda/vidljivosti |
| DELETE | `/api/materials/:id` | admin | briše zapis i fajl |
| GET | `/api/materials/:id/file?token=...` | svi s pristupom | stream fajla (`&download=1` za preuzimanje) |

Autorizacija: Firebase ID token u `Authorization: Bearer ...` (ili `?token=` za direktne linkove).

### 5. Admin prava
Nakon registracije, u Firebase Console → Firestore → kolekcija `users`
→ tvoj dokument → postavi `role: "admin"`.
