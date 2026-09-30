# 🤖 KimiBot — AI Chat Full-Stack v1.2

Chatbot AI lengkap: **API key aman di server**, **streaming SSE**, **TTS**,
**upload gambar**, **voice input**, **auth per-user**, **PostgreSQL/JSON database**,
dan manajemen riwayat (hapus / rename / export).

## 📁 Struktur Proyek
```
kimibot-backend/
├── server.js          # Express: AI proxy (SSE), auth, rate limit, helmet
├── db.js              # Dual store: PostgreSQL (DATABASE_URL) atau JSON file
├── .env.example
├── render.yaml        # Deploy Render.com (+ addon Postgres)
├── railway.json       # Deploy Railway.app
├── package.json
└── public/index.html  # Frontend
```

## 🚀 Jalankan Lokal

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# Edit .env → isi GEMINI_API_KEY (gratis: aistudio.google.com/app/apikey)
npm start                   # http://localhost:3000
```

## 🐘 Database: PostgreSQL atau JSON

- **Tanpa setup (default)** — data tersimpan di `data/db.json`. Cocok untuk demo/dev.
- **PostgreSQL (produksi)** — isi `DATABASE_URL` di `.env`:
  ```bash
  DATABASE_URL=postgresql://user:password@host:5432/dbname
  ```
  Tabel (`users`, `sessions`, `chats`) **dibuat otomatis** saat server start. Tidak perlu migrasi manual.

**Render:** New → PostgreSQL → copy *Internal Database URL* → tambahkan sebagai env var `DATABASE_URL` di service KimiBot.
**Railway:** New → Database → Add PostgreSQL → Railway otomatis mengisi `DATABASE_URL`.

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| ⚡ Streaming SSE | Jawaban AI muncul kata-per-kata |
| 🔊 TTS | Tombol 🔊 di tiap balasan AI |
| 🖼️ Upload gambar | Analisis multimodal Gemini (maks 5MB) |
| 🎤 Voice input | Web Speech API (Chrome/Edge) |
| 🔐 Auth | Register/login bcrypt + sesi httpOnly, opsi Google OAuth |
| ☁️ Riwayat per-user | Tersimpan di DB, auto-sync |
| 🗑️ Hapus chat | Tombol ✕ saat hover di daftar chat |
| ✏️ Rename chat | Tombol ✏️ atau dobel-klik judul di sidebar |
| ⬇️ Export | Unduh seluruh riwayat sebagai file JSON |
| 🛡️ Proteksi | helmet, rate limit AI (`RATE_LIMIT_MAX`), limit auth |

## 🔌 Endpoint

| Method | Path | Auth |
|---|---|---|
| POST | `/api/auth/register` `/api/auth/login` `/api/auth/logout` | publik (rate-limited) |
| GET | `/api/auth/me` | publik |
| GET/PUT | `/api/chats` | ✅ wajib login |
| POST | `/api/chat/stream` `/api/chat` `/api/chat/image` | publik (rate-limited) |
| GET | `/auth/google` + `/auth/google/callback` | jika `GOOGLE_CLIENT_ID` diisi |

## ⚙️ Variabel .env

| Key | Default | Keterangan |
|---|---|---|
| `PROVIDER` | `gemini` | `gemini` atau `openrouter` |
| `GEMINI_API_KEY` | — | wajib untuk mode API |
| `DATABASE_URL` | *(kosong)* | isi → PostgreSQL; kosong → `data/db.json` |
| `RATE_LIMIT_MAX` | `30` | request AI per IP per 10 menit |
| `BASE_URL` | `http://localhost:3000` | **wajib** untuk Google OAuth saat deploy |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | opsional, aktifkan OAuth Google |

> HTTPS wajib untuk 🎤 voice & 🔊 TTS di production.
