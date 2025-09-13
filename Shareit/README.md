# ShareIt Web Clone - Prototype

**Deskripsi singkat**
Ini adalah prototype web app yang meniru fungsi dasar *ShareIt*: transfer file cepat antar-perangkat menggunakan WebRTC DataChannel (P2P) dengan signaling lewat Socket.io. UI dibuat dengan HTML + Tailwind (CDN) agar bisa langsung dijalankan tanpa build step frontend.

**Fitur utama (prototype)**
- Pairing via Session ID atau QR code.
- Signaling server dengan Socket.io (Node.js + Express).
- Transfer file lewat WebRTC DataChannel (chunking 64KB).
- Checksum SHA-256 verifikasi integritas.
- Fallback: relay file chunk lewat signaling server (jika P2P gagal).
- UI responsif mobile & desktop, dark/light toggle.
- Resume sederhana: saat reconnect, receiver menginformasikan chunk terakhir diterima, pengirim melanjutkan dari situ.

**Batasan**
- Ini adalah prototype edukasi — belum production-ready.
- Tidak ada TURN server default (gunakan coturn jika butuh NAT traversal yang lebih baik).
- Resume dan transfer besar sudah bekerja tapi belum teruji pada ribuan file/very large files.
- Tidak ada autentikasi — jangan pakai untuk transfer data sensitif tanpa enkripsi ekstra.

---

## Cara menjalankan (lokal)

Prasyarat: Node.js (v16+ direkomendasikan), npm

1. Ekstrak ZIP (atau masuk ke folder):
```bash
cd shareit_web_clone
```

2. Install dependency:
```bash
npm install
```

3. Jalankan server:
```bash
node server.js
```

4. Buka browser:
- Buka `http://localhost:3000` pada dua perangkat/laptop/HP di jaringan yang sama.
- Buat *session* (Create Session) pada satu perangkat, lalu scan QR atau masukkan Session ID pada perangkat lainnya (Join Session).

---

## Struktur file (daftar lengkap)
Lihat juga `FILES_LIST.md`.

```
shareit_web_clone/
├─ README.md
├─ PROMPT_DETAILED.txt
├─ FILES_LIST.md
├─ package.json
├─ server.js
└─ public/
   ├─ index.html
   ├─ app.js
   └─ styles.css
```

---

## Cara penggunaan singkat (UI)
1. Tekan **Create Session** pada perangkat A → muncul Session ID + QR.
2. Pada perangkat B tekan **Join Session**, masukkan ID atau scan QR.
3. Setelah terkoneksi, pilih *Select Files* atau drag & drop.
4. Lihat progress pada pengirim dan penerima; file akan otomatis terdownload (link muncul) setelah selesai.
5. Jika P2P gagal, prototype akan coba relay melalui server.

---

## Catatan deploy
- Untuk deploy publik, siapkan server Node.js (DigitalOcean/VPS) dan optional coturn untuk TURN server.
- Pastikan HTTPS untuk WebRTC dan QR/sesi aman jika public.

---

## Lisensi & Credits
Prototype ini dibuat untuk tujuan pembelajaran. Bebas dipakai/ubah (attribution appreciated).

