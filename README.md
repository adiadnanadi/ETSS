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
| `/preview/razredni-pregled` | Prikaz novog "Razredi" izvještaja na demo podacima (bez prijave) |

## Izvještaj po odjeljenjima (kartica "Razredi")
Sažima sve učenike po razredu:
- broj učenika, riješenih kvizova, prosječan % i prosječna ocjena odjeljenja
- koliko je učenika prešlo prag (zadano 54% = Dovoljan, bira se u padajućem meniju)
- vizuelni raspored ocjena 1–5 po odjeljenju i najbolji učenik
- lista učenika koji još nijesu riješili nijedan kviz (klik → profil učenika)
- CSV izvoz trenutno filtriranog prikaza

Logika je odvojena u `public/js/class-report.js` (čiste funkcije, bez DOM-a i Firebasea),
pa se može testirati bez servera. UI se vidi i bez prijave: `/admin?demo=1&cr=1`
(preko `/preview/razredni-pregled`).

## Testovi
```bash
npm test          # 16 jediničnih + 22 e2e (jsdom) — ne traži server ni Firebase
```
`tests/class-report.test.js` pokriva računanje izvještaja, `tests/e2e/admin-class-report.test.mjs`
učitava **stvarni** inline modul iz `public/pages/admin.html` u jsdom DOM i provjerava render,
filtere, prag polaganja, CSV izvoz, eskapiranje HTML-a i da ostale kartice rade.

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

### 4. Admin prava
Nakon registracije, u Firebase Console → Firestore → kolekcija `users`
→ tvoj dokument → postavi `role: "admin"`.
