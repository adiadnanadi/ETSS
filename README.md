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
      allow read, write: if request.auth.uid == userId;
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

### 4. Admin prava
Nakon registracije, u Firebase Console → Firestore → kolekcija `users`
→ tvoj dokument → postavi `role: "admin"`.
