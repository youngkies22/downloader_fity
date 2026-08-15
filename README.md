# Downloader Fity

Aplikasi web sederhana untuk mengunduh video dari YouTube, TikTok, Facebook, dan Instagram.
Tempel URL → cek → pilih kualitas → unduh.

- **Backend:** Node.js + Express, memanggil `yt-dlp` (+ `ffmpeg`)
- **Frontend:** satu halaman HTML dengan Tailwind CSS, progres real-time via SSE
- **Deploy:** Docker / Docker Compose

## Menjalankan dengan Docker (disarankan)

```bash
cd "E:\1.WEB_SERVER\5 .nodejs\downloader_fity"
docker compose up -d --build
```

Buka http://localhost:5006

Menghentikan:

```bash
docker compose down
```

## Menjalankan tanpa Docker

Butuh `yt-dlp` dan `ffmpeg` terpasang di PATH.

```bash
npm install
npm start          # http://localhost:3000
```

## Konfigurasi (environment variable)

| Variabel            | Default        | Keterangan                                  |
| ------------------- | -------------- | ------------------------------------------- |
| `PORT`              | `3000`         | Port HTTP                                   |
| `DOWNLOAD_DIR`      | `./downloads`  | Folder berkas sementara                     |
| `JOB_TTL_MINUTES`   | `30`           | Umur berkas sebelum dihapus otomatis        |
| `MAX_CONCURRENT`    | `1`            | Jumlah unduhan yang jalan bersamaan         |
| `YTDLP_BIN`         | `yt-dlp`       | Path binary yt-dlp                          |
| `COOKIES_FILE`      | *(kosong)*     | Path `cookies.txt` untuk konten butuh login |

### Kenapa unduhan diantrekan

YouTube dan TikTok membatasi laju per alamat IP. Pada pengujian, tiga unduhan
yang dijalankan serentak membuat dua di antaranya ditolak (`HTTP 403`), padahal
lima unduhan berurutan lolos semua. Karena itu `MAX_CONCURRENT` bernilai `1`:
job berikutnya menunggu giliran dan UI menampilkan "Menunggu antrean…".
Menaikkan nilai ini mempercepat throughput tetapi memperbesar peluang 403.

Bila satu percobaan tetap gagal karena 403 atau ekstraksi kosong, server
mengulang otomatis sampai 4 kali dengan klien player YouTube yang berbeda
(`android_vr` lebih dulu karena paling andal pada pengujian).

### Instagram / Facebook yang butuh login

Instagram praktis mewajibkan login untuk hampir semua konten, dan sebagian video
Facebook juga demikian. Ekspor cookies dari browser (ekstensi "Get cookies.txt
LOCALLY") ke `cookies.txt` di folder proyek, lalu buka komentar pada
`COOKIES_FILE` dan baris mount `./cookies.txt:/app/cookies.txt:ro` di
`docker-compose.yml`, kemudian:

```bash
docker compose up -d
```

Mount `:ro` aman: yt-dlp menulis ulang cookie jar setiap request, jadi server
menyalin `cookies.txt` ke lokasi kerja yang bisa ditulis saat start. Tanpa
penyalinan ini, mount read-only akan menghasilkan galat
`Read-only file system`.

## API

| Endpoint              | Metode | Fungsi                                    |
| --------------------- | ------ | ----------------------------------------- |
| `/api/info`           | POST   | Metadata video: `{ url }`                 |
| `/api/download`       | POST   | Mulai unduhan: `{ url, quality }` → `{id}`|
| `/api/progress/:id`   | GET    | Stream progres (SSE)                      |
| `/api/file/:id`       | GET    | Ambil berkas hasil                        |
| `/api/health`         | GET    | Cek versi yt-dlp                          |

Nilai `quality`: `best`, `1080`, `720`, `480`, `360`, `audio` (MP3).

## Memperbarui yt-dlp

Situs target sering berubah; kalau unduhan mulai gagal, rebuild image agar
yt-dlp ikut terbaru:

```bash
docker compose build --no-cache && docker compose up -d
```

## Catatan

Berkas hasil unduhan disimpan sementara di volume `downloads` dan dihapus
otomatis setelah `JOB_TTL_MINUTES`. Gunakan aplikasi ini hanya untuk konten
milik sendiri atau yang Anda punya izin mengunduhnya, dan patuhi ketentuan
layanan masing-masing platform.
