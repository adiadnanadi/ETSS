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
| `/admin` → tab **Literatura** | Upload materijala direktno na Google Drive |
| `/viewer?id=...` / `/viewer?m=...` | Čitanje materijala (PDF u browseru) |
| `/m/<token>` | Javni link na fajl (radi bez prijave) |
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

### 4. Literatura (materijali) — **Google Drive**

Fajl se uplouduje **direktno iz admin stranice na Google Drive** — nema odlaska na
Drive, nema Google Picker-a, nema ručnog prebacivanja fajlova. Na Drive-u se pojavi
fajl sa nazivom materijala (npr. `Skripta — Baze podataka.pdf`), a učenici ga čitaju
kroz našu stranicu (ne moraju imati Google nalog).

**Formati:** PDF, DOC, DOCX, PPT, PPTX, TXT · **max** 20 MB (podesivo, vidi dolje)

---

#### A) Tvoj lični Drive — OAuth (preporučeno, radi i na običnom Gmail-u)

Fajlovi idu na **tvoj** Drive i troše **tvoju** kvotu.

1. U Google Cloud Console za projekat `kviz-13f52` uključi **Google Drive API**
   (APIs & Services → Library → Google Drive API → Enable).
2. Credentials → *Create credentials* → **OAuth client ID** → tip **Desktop app**.
   Preuzmi JSON (`client_secret_….json`).
3. Lokalno, u ovom repou, pokreni jednokratno:
   ```bash
   npm install
   npm run drive:auth -- --client ~/Downloads/client_secret_XXXX.json
   ```
   Prijavi se svojim Google nalogom u browseru koji se otvori.
4. Skripta ispiše tri varijable — dodaj ih na Render → Environment:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_OAUTH_REFRESH_TOKEN=...
   ```
5. Provjera: `npm run drive:check` (ispisuje nalog, kvotu i folder).

Ako želiš da fajlovi idu u **konkretan folder**, napravi ga na Drive-u, kopiraj ID iz
linka (`drive.google.com/drive/folders/`**`OVO_JE_ID`**) i dodaj `GDRIVE_FOLDER_ID`.

#### B) Service account (za Workspace / dijeljeni drive)

1. Google Cloud Console → IAM & Admin → Service accounts → *Create* → Keys → *Add key* → JSON.
2. Uključi **Google Drive API**.
3. Na Drive-u napravi folder, desni klik → *Share* → dodaj e-mail servisnog naloga
   (`…@…iam.gserviceaccount.com`) kao **Editor**, kopiraj ID foldera.
4. Render env:
   ```
   GOOGLE_SERVICE_ACCOUNT={"type":"service_account", ...}   # cijeli JSON iz koraka 1, u jednom redu
   GDRIVE_FOLDER_ID=ID_FOLDERA
   ```

> **Važno:** servisni nalog na običnom (besplatnom) Gmail-u nema Google kvotu za
> upload, pa `upload` zna vratiti `The user's Drive storage quota has been exceeded`.
> Tada koristi varijantu **A**, ili Workspace/dijeljeni drive u koji servisni nalog
> ima pravo pisanja. Bez foldera, fajl ide u Drive samog servisnog naloga.

#### Varijable okruženja (literatura)

| Varijabla | Default | Značenje |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | — | Tvoj lični Drive (varijanta A) |
| `GOOGLE_SERVICE_ACCOUNT` | — | Service account JSON u jednom redu (varijanta B) |
| `GDRIVE_FOLDER_ID` | korijen Drive-a | Folder u koji idu fajlovi |
| `GDRIVE_SHARE_ANYONE` | `1` | Novi materijali dobiju Drive dozvolu „svako s linkom može gledati" |
| `GDRIVE_QUOTA_FALLBACK` | `1` | Ako servisni nalog nema kvotu, fajl ipak prođe (bez foldera) |
| `MATERIALS_STORE` | auto | `firestore` = koristi rezervno skladište umjesto Drive-a |
| `FALLBACK_FIRESTORE` | `1` | Rezervno skladište se uključi samo ako Drive nije povezan; `0` = nikad |
| `MATERIALS_MAX_MB` | `20` | Maksimalna veličina fajla za upload |

**Rezervno skladište:** ako Drive nije povezan (ili padne), materijali se čuvaju kao
chunk-ovi u Firestore-u (`materials/{id}/chunks`) — upload i čitanje i dalje rade, samo
fajl nije na Drive-u. Status se odmah vidi u admin panelu → **Literatura** (zeleni banner).

#### Linkovi

Svaki materijal ima:
- **Javni link** `/m/<token>` — otvara PDF direktno, radi i bez prijave
  (isključivo preko čekboks-a *Napravi javni link* u modalu). Dugme **Link** u tabeli ga kopira.
- **Viewer stranicu** `/viewer?m=<token>` ili `/viewer?id=<id>` — PDF se čita u browseru,
  DOC/PPT nude preuzimanje (+ Drive pregled ako je fajl dijeljen).
- **Google Drive dugme** — pravi link na fajl u Drive-u (admin uvijek; učenik samo ako je fajl dijeljen).

**API rute:**
| Metoda | Ruta | Ko | Opis |
|---|---|---|---|
| GET | `/api/materials` | svi prijavljeni | lista + linkovi (učenik vidi samo svoj razred i vidljive) |
| POST | `/api/materials` | admin | upload → Google Drive (multipart: `file`, `title`, `subject`, `description`, `razredi` JSON, `shareEnabled`) |
| PUT | `/api/materials/:id` | admin | izmjena naziva/predmeta/razreda/vidljivosti/dijeljenja (naziv se prenese i na Drive) |
| DELETE | `/api/materials/:id` | admin | briše zapis **i fajl sa Drive-a** |
| GET | `/api/materials/:id/file?token=...` | svi s pristupom | fajl (`&download=1` preuzimanje, `&inline=1` u browser) — podržava `Range` |
| GET | `/api/materials/:id/meta?token=...` | svi s pristupom | metapodaci za viewer |
| GET | `/api/materials/:id/drive-link` | admin | Google Drive linkovi za fajl |
| GET | `/api/storage/status` | admin | je li Drive povezan, kvota, aktivno skladište |
| GET | `/m/:token` | javno | fajl preko javnog linka |
| GET | `/api/materials/public/:token` | javno | metapodaci za javni link |

Autorizacija: Firebase ID token u `Authorization: Bearer ...` (ili `?token=` za direktne linkove).

#### Testovi

```bash
npm test        # 34 testa: rute, Range/stream, javni linkovi, Drive store, smoke servera
npm run drive:check   # provjeri Drive kredencijale (bez mijenjanja ičega)
```

### 5. Admin prava
Nakon registracije, u Firebase Console → Firestore → kolekcija `users`
→ tvoj dokument → postavi `role: "admin"`.
