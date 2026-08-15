'use strict';

const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const JOB_TTL_MS = Number(process.env.JOB_TTL_MINUTES || 30) * 60 * 1000;

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, any>} */
const jobs = new Map();

// ---------------------------------------------------------------- helpers

const ALLOWED_HOSTS = [
  'youtube.com', 'youtu.be', 'music.youtube.com',
  'tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com',
  'facebook.com', 'fb.watch', 'fb.com',
  'instagram.com', 'instagr.am',
];

function parseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { error: 'URL tidak valid.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: 'Hanya URL http/https yang didukung.' };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (!ok) {
    return { error: 'Platform tidak didukung. Gunakan YouTube, TikTok, Facebook, atau Instagram.' };
  }
  return { url: u.toString() };
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Link pendek TikTok (vt/vm.tiktok.com) baru menampilkan bentuk aslinya setelah
// redirect diikuti, dan slideshow foto memakai pola /photo/ yang tidak dikenali
// extractor yt-dlp — padahal isinya bisa diambil lewat pola /video/.
async function resolveUrl(raw) {
  let out = raw;
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {
    try {
      const ctl = AbortSignal.timeout(15000);
      const r = await fetch(raw, {
        redirect: 'follow',
        headers: { 'User-Agent': BROWSER_UA },
        signal: ctl,
      });
      if (r.url) out = r.url;
    } catch {
      return { url: raw }; // redirect gagal: biar yt-dlp yang mencoba
    }
    // Hasil redirect harus tetap berada di platform yang diizinkan.
    const checked = parseUrl(out);
    if (checked.error) return checked;
    out = checked.url;
  }

  return {
    url: out.replace(/\/photo\/(\d+)/, '/video/$1'),
    isPhoto: /\/photo\/\d+/.test(out),
  };
}

// --------------------------------------------- slideshow foto TikTok
// Halaman /photo/ biasa dijaga captcha untuk permintaan anonim, tetapi endpoint
// embed masih memuat daftar gambarnya pada field "displayImages".

// Mengambil satu array JSON utuh dari HTML, dengan menghormati tanda kutip
// sehingga kurung di dalam string tidak ikut terhitung.
function sliceJsonArray(html, key) {
  const at = html.indexOf(`"${key}":`);
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

async function fetchTikTokImages(url) {
  const m = url.match(/\/(?:video|photo)\/(\d+)/);
  if (!m) return [];
  try {
    const r = await fetch(`https://www.tiktok.com/embed/v2/${m[1]}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.tiktok.com/' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return [];
    const raw = sliceJsonArray(await r.text(), 'displayImages');
    if (!raw) return [];

    const out = [];
    const seen = new Set();
    for (const img of JSON.parse(raw)) {
      const u = img?.urlList?.[0];
      if (!u) continue;
      // Gambar yang sama disajikan dari beberapa host CDN; ambil satu saja.
      const key = (u.match(/photomode[^/]*\/([a-f0-9]{8,})/) || [])[1] || u;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    return out;
  } catch {
    return [];
  }
}

function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'tiktok';
}

// YouTube kadang membalas 403 pada satu klien player saja. Urutan ini dipakai
// bergantian saat unduhan diulang; android_vr paling andal pada pengujian
// (4/4 berhasil vs 2/4 untuk default) dan menyediakan resolusi yang sama.
const YT_CLIENTS = ['android_vr', 'default,android_vr', 'android_vr', 'default'];

// yt-dlp menulis ulang cookie jar setelah request, sehingga berkas cookies
// yang di-mount read-only akan menyebabkan galat "Read-only file system".
// Karena itu cookies disalin ke lokasi kerja yang bisa ditulis saat start.
let cookiesPath = '';

function initCookies() {
  if (!COOKIES_FILE || !fs.existsSync(COOKIES_FILE)) return;
  const work = path.join(DOWNLOAD_DIR, '.cookies.txt');
  try {
    fs.copyFileSync(COOKIES_FILE, work);
    fs.chmodSync(work, 0o600);
    cookiesPath = work;
    console.log(`cookies dimuat dari ${COOKIES_FILE}`);
  } catch (e) {
    console.warn(`gagal menyalin cookies (${e.message}), memakai berkas asli`);
    cookiesPath = COOKIES_FILE;
  }
}

function baseArgs(client = YT_CLIENTS[0]) {
  const args = [
    '--no-playlist', '--no-warnings', '--no-color',
    '--socket-timeout', '20', '--retries', '5', '--fragment-retries', '10',
    '--extractor-retries', '3',
    '--extractor-args', `youtube:player_client=${client}`,
  ];
  if (cookiesPath) args.push('--cookies', cookiesPath);
  return args;
}

function runJson(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'yt-dlp tidak ditemukan di server.' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(cleanError(err) || `yt-dlp keluar dengan kode ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Gagal membaca metadata dari yt-dlp.'));
      }
    });
  });
}

function cleanError(stderr) {
  const line = String(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => /error/i.test(l));
  if (!line) return '';
  return line.replace(/^ERROR:\s*/i, '').slice(0, 300);
}

function humanSize(bytes) {
  if (!bytes || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Peta pilihan UI -> selector format yt-dlp
function buildFormatArgs(quality) {
  switch (quality) {
    case 'audio':
      return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    case '360':
    case '480':
    case '720':
    case '1080': {
      const h = quality;
      return [
        '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
        '--merge-output-format', 'mp4',
      ];
    }
    case 'best':
    default:
      return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'];
  }
}

// ---------------------------------------------------------------- routes

app.post('/api/info', async (req, res) => {
  const parsed = parseUrl(req.body?.url);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { url, error, isPhoto } = await resolveUrl(parsed.url);
  if (error) return res.status(400).json({ error });

  try {
    const meta = await runJson([...baseArgs(), '-J', url]);
    const info = meta.entries?.[0] || meta;

    const heights = new Set();
    for (const f of info.formats || []) {
      if (f.vcodec && f.vcodec !== 'none' && f.height) heights.add(f.height);
    }
    const available = [1080, 720, 480, 360].filter(
      (h) => [...heights].some((x) => x >= h)
    );

    res.json({
      title: info.title || 'Tanpa judul',
      uploader: info.uploader || info.channel || info.webpage_url_domain || '',
      duration: info.duration || null,
      thumbnail: info.thumbnail || null,
      extractor: info.extractor_key || info.extractor || '',
      filesize: humanSize(info.filesize || info.filesize_approx),
      qualities: available,
      hasVideo: heights.size > 0,
      images: isPhoto ? (await fetchTikTokImages(url)).length : 0,
      url,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/download', async (req, res) => {
  const parsed = parseUrl(req.body?.url);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { url, error } = await resolveUrl(parsed.url);
  if (error) return res.status(400).json({ error });

  const quality = String(req.body?.quality || 'best');
  const id = crypto.randomUUID();
  const dir = path.join(DOWNLOAD_DIR, id);
  await fsp.mkdir(dir, { recursive: true });

  const job = {
    id,
    status: 'running',
    percent: 0,
    speed: '',
    eta: '',
    stage: 'Menyiapkan…',
    file: null,
    error: null,
    dir,
    createdAt: Date.now(),
    listeners: new Set(),
  };
  jobs.set(id, job);

  if (active >= MAX_CONCURRENT) {
    job.stage = 'Menunggu antrean…';
    job.queued = true;
  }
  const title = safeName(req.body?.title);
  enqueue(() =>
    quality === 'images'
      ? runImages(job, url, title)
      : runAttempt(job, url, quality, 0)
  );
  res.json({ id });
});

// Mengunduh gambar slideshow TikTok. Lebih dari satu gambar dikemas jadi ZIP
// agar browser tetap menerima satu berkas.
async function runImages(job, url, title) {
  try {
    job.stage = 'Mengambil daftar gambar…';
    emit(job);

    const urls = await fetchTikTokImages(url);
    if (!urls.length) {
      throw new Error('Tidak ada gambar yang bisa diambil dari postingan ini.');
    }

    const names = [];
    for (let i = 0; i < urls.length; i++) {
      const r = await fetch(urls[i], {
        headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.tiktok.com/' },
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error(`Gagal mengunduh gambar ke-${i + 1} (HTTP ${r.status}).`);

      const name = urls.length === 1
        ? `${title}.jpg`
        : `${title}-${String(i + 1).padStart(2, '0')}.jpg`;
      await fsp.writeFile(path.join(job.dir, name), Buffer.from(await r.arrayBuffer()));
      names.push(name);

      job.percent = Math.round(((i + 1) / urls.length) * 100);
      job.stage = `Mengunduh gambar ${i + 1}/${urls.length}…`;
      emit(job);
    }

    if (names.length > 1) {
      job.stage = 'Mengemas ZIP…';
      emit(job);
      const zipName = `${title}.zip`;
      await packZip(job.dir, names, zipName);
      await Promise.all(names.map((n) => fsp.rm(path.join(job.dir, n), { force: true })));
      job.file = zipName;
    } else {
      job.file = names[0];
    }

    job.status = 'done';
    job.percent = 100;
    job.stage = 'Selesai';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  }
  release(job);
  emit(job, true);
}

function packZip(dir, names, zipName) {
  return new Promise((resolve, reject) => {
    const z = spawn('zip', ['-j', '-q', zipName, ...names], { cwd: dir, windowsHide: true });
    let err = '';
    z.stderr.on('data', (d) => { err += d; });
    z.on('error', (e) => reject(new Error(`zip gagal dijalankan: ${e.message}`)));
    z.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `zip keluar dengan kode ${code}`))
    );
  });
}

// Antrean: YouTube dan TikTok membatasi laju per-IP, sehingga unduhan yang
// berjalan serentak sering ditolak 403. Job dijalankan bergiliran.
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 1));
let active = 0;
const queue = [];

function enqueue(fn) {
  queue.push(fn);
  pump();
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    active++;
    queue.shift()();
  }
}

// Dipanggil sekali per job saat job mencapai status akhir (selesai/gagal).
function release(job) {
  if (job.released) return;
  job.released = true;
  active--;
  pump();
}

// Menjalankan satu percobaan unduhan; jika gagal karena masalah sesaat
// (403 / koneksi), diulang dengan klien player berikutnya.
function runAttempt(job, url, quality, attempt) {
  const args = [
    ...baseArgs(YT_CLIENTS[attempt] || YT_CLIENTS[YT_CLIENTS.length - 1]),
    ...buildFormatArgs(quality),
    '--newline',
    '--progress',
    '--progress-template', 'FITY|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(job.dir, '%(title).120B.%(ext)s'),
    url,
  ];

  const child = spawn(YTDLP, args, { windowsHide: true });
  job.child = child;
  let stderr = '';

  const handleLine = (line) => {
    if (line.startsWith('FITY|')) {
      const [, pct, speed, eta] = line.split('|');
      const n = parseFloat(String(pct).replace('%', '').trim());
      if (!Number.isNaN(n)) job.percent = Math.min(99, n);
      job.speed = (speed || '').trim();
      job.eta = (eta || '').trim();
      job.stage = 'Mengunduh…';
    } else if (/\[Merger\]|\[ffmpeg\]/i.test(line)) {
      job.stage = 'Menggabungkan audio & video…';
      job.percent = Math.max(job.percent, 99);
    } else if (/\[ExtractAudio\]/i.test(line)) {
      job.stage = 'Mengonversi audio…';
      job.percent = Math.max(job.percent, 99);
    }
    emit(job);
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    lines.forEach((l) => handleLine(l.trim()));
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (e) => {
    job.status = 'error';
    job.error = e.code === 'ENOENT' ? 'yt-dlp tidak ditemukan di server.' : e.message;
    release(job);
    emit(job, true);
  });

  child.on('close', async (code) => {
    if (job.status === 'error') return;
    if (code !== 0) {
      // Galat sesaat akibat pembatasan laju: 403, timeout, atau ekstraksi
      // yang gagal karena situs membalas halaman kosong.
      const retryable = /403|Forbidden|timed out|Connection|fragment|Unable to extract|Cannot parse data|rate.?limit/i.test(stderr);
      if (retryable && attempt + 1 < YT_CLIENTS.length) {
        job.stage = `Mencoba lagi (${attempt + 2}/${YT_CLIENTS.length})…`;
        job.percent = 0;
        job.speed = '';
        job.eta = '';
        emit(job);
        await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
        await fsp.mkdir(job.dir, { recursive: true }).catch(() => {});
        // Jeda bertingkat agar tidak langsung menabrak pembatasan laju lagi.
        // TikTok khususnya butuh jeda beberapa detik sebelum ekstraksi ulang.
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        runAttempt(job, url, quality, attempt + 1);
        return;
      }
      job.status = 'error';
      job.error = cleanError(stderr) || `Unduhan gagal (kode ${code}).`;
      release(job);
      emit(job, true);
      return;
    }
    try {
      const files = await fsp.readdir(job.dir);
      const real = files.find((f) => !f.endsWith('.part'));
      if (!real) throw new Error('Berkas hasil unduhan tidak ditemukan.');
      job.file = real;
      job.status = 'done';
      job.percent = 100;
      job.stage = 'Selesai';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
    }
    release(job);
    emit(job, true);
  });
}

function emit(job, final = false) {
  const payload = JSON.stringify({
    status: job.status,
    percent: Number(job.percent.toFixed(1)),
    speed: job.speed,
    eta: job.eta,
    stage: job.stage,
    error: job.error,
    file: job.file,
  });
  for (const res of job.listeners) {
    res.write(`data: ${payload}\n\n`);
    if (final) res.end();
  }
  if (final) job.listeners.clear();
}

app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  job.listeners.add(res);
  emit(job, job.status !== 'running');
  req.on('close', () => job.listeners.delete(res));
});

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file) {
    return res.status(404).json({ error: 'Berkas belum siap atau sudah kedaluwarsa.' });
  }
  res.download(path.join(job.dir, job.file), job.file);
});

app.get('/api/health', (req, res) => {
  const child = spawn(YTDLP, ['--version'], { windowsHide: true });
  let v = '';
  child.stdout.on('data', (d) => { v += d; });
  child.on('error', () => res.status(500).json({ ok: false, error: 'yt-dlp tidak tersedia' }));
  child.on('close', (code) =>
    code === 0
      ? res.json({ ok: true, ytdlp: v.trim() })
      : res.status(500).json({ ok: false })
  );
});

// -------------------------------------------------- pembersihan berkas lama

async function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt < JOB_TTL_MS) continue;
    jobs.delete(id);
    try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch { /* abaikan */ }
  }
  // Direktori yatim: status job hanya disimpan di memori, sehingga sisa job
  // dari proses sebelumnya tidak akan pernah cocok dengan entri mana pun.
  try {
    const entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || jobs.has(e.name)) continue;
      const dir = path.join(DOWNLOAD_DIR, e.name);
      const { mtimeMs } = await fsp.stat(dir);
      if (now - mtimeMs < JOB_TTL_MS) continue;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } catch { /* abaikan */ }
}

setInterval(sweep, 5 * 60 * 1000).unref();

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
initCookies();
sweep();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`downloader_fity berjalan di http://localhost:${PORT}`);
});
