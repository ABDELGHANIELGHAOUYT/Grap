const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const urlModule = require('url');

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

// دالة باش توسع الرابط المختصر (بحال b23.tv)
function expandUrl(shortUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(shortUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    const req = https.request(options, (res) => {
      const location = res.headers.location;
      if (location) {
        resolve(location);
      } else {
        resolve(shortUrl);
      }
    });
    req.on('error', (err) => {
      resolve(shortUrl); // إذا فشل التوسيع، استعمل الرابط الأصلي
    });
    req.end();
  });
}

// دالة باش ترجع الأوامر الأساسية ديال yt-dlp باش نتجنب التكرار
function getBaseArgs(extra = []) {
  return [
    '--no-playlist',
    '--no-warnings',
    '--geo-bypass',
    '--add-header', 'Referer: https://www.bilibili.com',
    '--add-header', 'Origin: https://www.bilibili.com',
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '--add-header', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '--add-header', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    ...extra
  ];
}

// POST /api/info
app.post('/api/info', rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'رابط غير صحيح' });

  try {
    // توسيع الرابط المختصر قبل ما نرسلو لـ yt-dlp
    const fullUrl = await expandUrl(url);
    
    const args = getBaseArgs(['-j', fullUrl]);
    
    execFile(YT_DLP, args, { maxBuffer: 1024 * 1024 * 20, timeout: 30_000 }, (err, stdout) => {
      if (err) {
        console.error('yt-dlp error:', err.message);
        return res.status(422).json({ error: 'ماقدرتش نقرا هاد الرابط', detail: err.message });
      }

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
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

      res.json({
        id: data.id,
        title: data.title,
        duration: data.duration,
        thumbnail: data.thumbnail,
        platform: data.extractor_key,
        formats
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'مشكل فالسيرفر', detail: error.message });
  }
});

// GET /api/download
app.get('/api/download', rateLimit, async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'رابط غير صحيح' });

  try {
    // توسيع الرابط المختصر
    const fullUrl = await expandUrl(url);
    
    let args = getBaseArgs(['-o', '-']);
    if (format_id) args.push('-f', String(format_id));
    args.push(fullUrl);

    const filename = `grab-${crypto.randomBytes(4).toString('hex')}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const proc = spawn(YT_DLP, args, { maxBuffer: undefined });
    proc.stdout.pipe(res);
    proc.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });
    proc.on('error', (err) => {
      console.error('spawn error:', err);
      if (!res.headersSent) res.status(500).end();
    });
    req.on('close', () => proc.kill('SIGKILL'));
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: 'مشكل فالسيرفر' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Grab API خدامة فوق http://localhost:${PORT}`));
