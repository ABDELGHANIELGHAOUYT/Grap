const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

// simple in-memory rate limit (IP -> timestamps)
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const win = 60_000, max = 12;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  if (arr.length >= max) return res.status(429).json({ error: 'بزاف ديال الطلبات، صبر شوية' });
  arr.push(now);
  hits.set(ip, arr);
  next();
}

function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// POST /api/info  { url }  -> title, duration, thumbnail, formats[]
app.post('/api/info', rateLimit, (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'رابط غير صحيح' });

  execFile(
    YT_DLP,
    ['-j', '--no-playlist', '--no-warnings', url],
    { maxBuffer: 1024 * 1024 * 20, timeout: 30_000 },
    (err, stdout) => {
      if (err) return res.status(422).json({ error: 'ماقدرتش نقرا هاد الرابط', detail: err.message });

      let data;
      try { data = JSON.parse(stdout); }
      catch { return res.status(500).json({ error: 'جاوبني بشكل ماشي متوقع' }); }

      const formats = (data.formats || [])
        .filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'))
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || (f.height ? `${f.height}p` : 'audio'),
          type: f.vcodec && f.vcodec !== 'none' ? 'video' : 'audio',
          filesize: f.filesize || f.filesize_approx || null,
          note: f.format_note || ''
        }))
        // keep it short: unique resolutions, best-ish first
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

      res.json({
        id: data.id,
        title: data.title,
        duration: data.duration,
        thumbnail: data.thumbnail,
        platform: data.extractor_key,
        formats
      });
    }
  );
});

// GET /api/download?url=...&format_id=...  -> streams the file to the client
app.get('/api/download', rateLimit, (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'رابط غير صحيح' });

  const args = ['--no-playlist', '--no-warnings', '-o', '-'];
  if (format_id) args.push('-f', String(format_id));
  args.push(String(url));

  const filename = `grab-${crypto.randomBytes(4).toString('hex')}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const proc = spawn(YT_DLP, args, { maxBuffer: undefined });
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {}); // swallow yt-dlp logs
  proc.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  req.on('close', () => proc.kill('SIGKILL'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Grab API خدامة فوق http://localhost:${PORT}`));
