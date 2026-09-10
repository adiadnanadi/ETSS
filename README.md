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

### 4. Literatura (materijali) — **samo Google Drive**

Fajl se uplouduje **sa naše stranice direktno na Google Drive** — nema odlaska na
Drive, nema Google Picker-a, nema ručnog prebacivanja fajlova i **ništa se ne čuva
u bazi**. Na Drive-u se pojavi fajl pod nazivom materijala
(npr. `Skripta — Baze podataka.pdf`), a učenici ga čitaju kroz našu stranicu
(ne trebaju Google nalog).

**Formati:** PDF, DOC, DOCX, PPT, PPTX, TXT · **max** 20 MB (`MATERIALS_MAX_MB`)

---

#### Povezivanje Drive-a — klikom u panelu (preporučeno)

1. Admin panel → **Literatura** → kartica *Google Drive nije povezan*.
2. Klikni **Google Drive API → Enable** (link je u kartici).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. U *Authorized redirect URIs* zalijepi link koji kartica prikazuje i kopira
   (dugme **Kopiraj**), npr.
   `https://tvoja-aplikacija.onrender.com/api/drive/connect/callback` → **Create**.
5. Zalijepi **Client ID** i **Client Secret** u karticu, po želji **Folder ID**
   (ako želiš da fajlovi idu u konkretan folder) → **Poveži Google Drive**.
6. Prijavi se svojim Google nalogom i dozvoli pristup. Gotovo — kartica postane
   zelena i odmah pokazuje nalog, folder i zauzeće.

Refresh token se čuva u Firestore-u (`settings/drive`) i koristi za uploude.
Veza se može prekinuti u svakom trenutku (**Prekini vezu** — opozove i token na
Google-u); materijali tada ostaju na Drive-u, samo im stranica ne pristupa.

#### Povezivanje preko env varijabli (alternativa)

Ako više voliš da kredencijali budu u Render env varijablama, pokreni jednom
lokalno `npm run drive:auth -- --client client_secret_XXXX.json` (OAuth, tvoj
lični Drive) ili postavi service account, pa dodaj na Render:

| Varijabla | Značenje |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | Tvoj lični Drive |
| `GOOGLE_SERVICE_ACCOUNT` | Service account JSON u jednom redu (+ `GDRIVE_FOLDER_ID`, folder podijeljen s nalogom) |
| `GDRIVE_FOLDER_ID` | Folder na Drive-u (i za panel i za env način) |
| `GDRIVE_SHARE_ANYONE` | `1` (default) — novi materijali dobiju dozvolu „svako s linkom može gledati" |
| `GDRIVE_REDIRECT_URI` | Ako je aplikacija na custom domenu (default: `/api/drive/connect/callback`) |
| `MATERIALS_MAX_MB` | Maksimalna veličina fajla (default 20) |

Env kredencijali imaju prioritet nad onima iz panela. Provjera: `npm run drive:check`.

> Servisni nalozi na običnom (besplatnom) Gmail-u **nemaju Google kvotu** za upload —
> zato je povezivanje iz panela (tvoj lični Drive) najjednostavniji put.

#### Linkovi

- **Javni link** `/m/<token>` — otvara fajl direktno, radi i bez prijave; uključuje
  se/isključuje čekboksom *Napravi javni link*, a dugme **Link** u tabeli ga kopira.
- **Viewer** `/viewer?m=<token>` ili `/viewer?id=<id>` — PDF se čita u browseru,
  DOC/PPT nude preuzimanje (+ Google Drive pregled).
- **Drive** dugme — pravi link na fajl u Drive-u; vidi ga **samo administrator**.
  Učenik nema direktan pristup Google Drive-u — ima samo dugmad **Otvori**
  (novi prozor) i **Preuzmi**, oba kroz naš server.

**API rute:**
| Metoda | Ruta | Ko | Opis |
|---|---|---|---|
| GET | `/api/drive/status` | admin | je li Drive povezan, nalog, kvota, folder, redirect URI |
| POST | `/api/drive/connect` | admin | `{ clientId, clientSecret, folderId }` → Google link za prijavu |
| GET | `/api/drive/connect/callback` | javno | Google vraća kod → sprema refresh token |
| POST | `/api/drive/disconnect` | admin | prekida vezu i opoziva token |
| GET | `/api/materials` | svi prijavljeni | lista + linkovi (učenik vidi samo svoj razred i vidljive) |
| POST | `/api/materials` | admin | upload → Google Drive (`file`, `title`, `subject`, `description`, `razredi`, `shareEnabled`) |
| PUT | `/api/materials/:id` | admin | izmjena (naziv se prenese i na Drive) |
| DELETE | `/api/materials/:id` | admin | briše zapis **i fajl sa Drive-a** |
| GET | `/api/materials/:id/file?token=...` | svi s pristupom | fajl (`&download=1`, `&inline=1`), podržava `Range` |
| GET | `/api/materials/:id/meta?token=...` | svi s pristupom | metapodaci za viewer |
| GET | `/api/materials/:id/drive-link` | admin | Google Drive linkovi |
| GET | `/m/:token` | javno | fajl preko javnog linka |
| GET | `/api/materials/public/:token` | javno | metapodaci za javni link |

Autorizacija: Firebase ID token u `Authorization: Bearer ...` (ili `?token=` za direktne linkove).

#### Testovi

```bash
npm test              # 75 testova: rute, Range/stream, javni linkovi, Drive klijent,
                      # povezivanje Drive-a iz panela, učenik bez Drive linka,
                      # smoke pravog servera
npm run drive:check   # provjeri env kredencijale (ako ih koristiš)
```

### 5. Admin prava
Nakon registracije, u Firebase Console → Firestore → kolekcija `users`
→ tvoj dokument → postavi `role: "admin"`.
