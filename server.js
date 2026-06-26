'use strict';
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const archiver = require('archiver');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { execSync, execFileSync } = require('child_process');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const DATA_PATH = path.resolve(process.env.DATA_PATH || '/data');
const TEMP_PATH = process.env.TEMP_PATH || '/tmp/pvcbrowser-uploads';

// ─── Multi-volume support ─────────────────────────────────────────────────────
// VOLUMES env var format: "label1:/mount/path1,label2:/mount/path2"
// Example: VOLUMES=app1:/app1,data-01:/data-01,shared:/mnt/shared
// Falls back to single DATA_PATH volume if VOLUMES is not set.
const volumes = {};
if (process.env.VOLUMES) {
  process.env.VOLUMES.split(',').forEach(entry => {
    const idx = entry.indexOf(':');
    if (idx < 1) return;
    const label = entry.slice(0, idx).trim();
    const mountPath = path.resolve(entry.slice(idx + 1).trim());
    if (label && mountPath) volumes[label] = mountPath;
  });
}
if (Object.keys(volumes).length === 0) {
  // default: single volume from DATA_PATH
  volumes['data'] = DATA_PATH;
}
// Ensure all volume dirs exist
Object.values(volumes).forEach(p => fs.ensureDirSync(p));

// ─── Configuration ────────────────────────────────────────────────────────────
const cfg = {
  username: process.env.USERNAME || process.env.APP_USERNAME || 'admin',
  password: process.env.PASSWORD || process.env.APP_PASSWORD || 'admin',
  companyName: process.env.COMPANY_NAME || 'PVC File Browser',
  logoUrl: process.env.LOGO_URL || '',
  sessionSecret: process.env.SESSION_SECRET || uuidv4(),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || String(50 * 1024 * 1024 * 1024)), // 50 GB
};

fs.ensureDirSync(TEMP_PATH);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: cfg.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,            // Set to true if behind TLS terminator
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function volumeRoot(volName) {
  const root = volumes[volName];
  if (!root) throw new Error(`Unknown volume: "${volName}". Available: ${Object.keys(volumes).join(', ')}`);
  return root;
}

function safePath(userPath, volName) {
  const root = volumeRoot(volName || Object.keys(volumes)[0]);
  if (!userPath || userPath === '/') return root;
  const clean = String(userPath).replace(/\.\./g, '').replace(/\/+/g, '/');
  const full = path.resolve(root, clean.replace(/^\//, ''));
  if (!full.startsWith(root)) throw new Error('Invalid path');
  return full;
}

function relativePath(full, root) {
  const rel = path.relative(root, full);
  return rel ? '/' + rel : '/';
}

function volParam(req) {
  return req.query.volume || req.body?.volume || Object.keys(volumes)[0];
}

function hasCustomLogo() {
  return (
    fs.existsSync(path.join(__dirname, 'public', 'logo.png')) ||
    fs.existsSync(path.join(__dirname, 'public', 'logo.svg')) ||
    fs.existsSync(path.join(__dirname, 'public', 'logo.jpg')) ||
    !!cfg.logoUrl
  );
}

function logoSrc() {
  if (cfg.logoUrl) return cfg.logoUrl;
  if (fs.existsSync(path.join(__dirname, 'public', 'logo.png'))) return '/logo.png';
  if (fs.existsSync(path.join(__dirname, 'public', 'logo.svg'))) return '/logo.svg';
  if (fs.existsSync(path.join(__dirname, 'public', 'logo.jpg'))) return '/logo.jpg';
  return '';
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    companyName: cfg.companyName,
    logoSrc: logoSrc(),
    hasCustomLogo: hasCustomLogo(),
  });
});

app.get('/api/volumes', requireAuth, (req, res) => {
  res.json(Object.entries(volumes).map(([label, mountPath]) => ({
    label,
    mountPath,
  })));
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === cfg.username && password === cfg.password) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ success: true, username });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username });
});

// ─── File Listing ─────────────────────────────────────────────────────────────
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const vol = volParam(req);
    const root = volumeRoot(vol);
    const dirPath = safePath(req.query.path, vol);
    if (!await fs.pathExists(dirPath)) return res.status(404).json({ error: 'Path not found' });
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = (await Promise.all(entries.map(async (e) => {
      const ep = path.join(dirPath, e.name);
      try {
        const s = await fs.stat(ep);
        const isDir = e.isDirectory();
        return {
          name: e.name,
          path: relativePath(ep, root),
          isDirectory: isDir,
          size: s.size,
          modified: s.mtime,
          uid: s.uid,
          gid: s.gid,
          mode: (s.mode & 0o777).toString(8).padStart(3, '0'),
          mimeType: isDir ? 'inode/directory' : (mime.lookup(e.name) || 'application/octet-stream'),
        };
      } catch { return null; }
    }))).filter(Boolean);

    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return b.isDirectory ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.json({ path: relativePath(dirPath, root), volume: vol, files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/files/info', requireAuth, async (req, res) => {
  try {
    const vol = volParam(req);
    const root = volumeRoot(vol);
    const fp = safePath(req.query.path, vol);
    const s = await fs.stat(fp);
    res.json({
      name: path.basename(fp),
      path: relativePath(fp, root),
      size: s.size,
      modified: s.mtime,
      created: s.birthtime,
      uid: s.uid,
      gid: s.gid,
      mode: (s.mode & 0o777).toString(8).padStart(3, '0'),
      isDirectory: s.isDirectory(),
      mimeType: mime.lookup(path.basename(fp)) || 'application/octet-stream',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Upload ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_PATH),
  filename: (_req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: cfg.maxFileSize } });

app.post('/api/files/upload', requireAuth, upload.array('files', 500), async (req, res) => {
  try {
    const vol = volParam(req);
    const root = volumeRoot(vol);
    const targetDir = safePath(req.body.path || '/', vol);
    await fs.ensureDir(targetDir);

    const relPaths = [].concat(req.body['relativePaths[]'] || req.body.relativePaths || []);

    const results = [];
    for (let i = 0; i < (req.files || []).length; i++) {
      const file = req.files[i];
      const relPath = relPaths[i] || file.originalname;
      const finalPath = safePath(path.join(relativePath(targetDir, root), relPath), vol);
      await fs.ensureDir(path.dirname(finalPath));
      await fs.move(file.path, finalPath, { overwrite: true });
      results.push({ name: path.basename(finalPath), path: relativePath(finalPath, root), size: file.size });
    }
    res.json({ success: true, files: results });
  } catch (err) {
    (req.files || []).forEach(f => fs.remove(f.path).catch(() => {}));
    res.status(400).json({ error: err.message });
  }
});

// ─── Download ─────────────────────────────────────────────────────────────────
app.get('/api/files/download', requireAuth, async (req, res) => {
  try {
    const fp = safePath(req.query.path, req.query.volume);
    if (!await fs.pathExists(fp)) return res.status(404).json({ error: 'File not found' });
    const s = await fs.stat(fp);

    if (s.isDirectory()) {
      const name = path.basename(fp);
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.setHeader('Content-Type', 'application/zip');
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => res.end());
      archive.pipe(res);
      archive.directory(fp, name);
      await archive.finalize();
    } else {
      const name = path.basename(fp);
      const mimeType = mime.lookup(name) || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        const size = s.size;
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr);
        const end = endStr ? parseInt(endStr) : Math.min(start + 2 * 1024 * 1024, size - 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': mimeType,
        });
        fs.createReadStream(fp, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', s.size);
        res.setHeader('Accept-Ranges', 'bytes');
        fs.createReadStream(fp).pipe(res);
      }
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Preview ──────────────────────────────────────────────────────────────────
app.get('/api/files/preview', requireAuth, async (req, res) => {
  try {
    const fp = safePath(req.query.path, req.query.volume);
    if (!await fs.pathExists(fp)) return res.status(404).json({ error: 'File not found' });
    const s = await fs.stat(fp);
    if (s.isDirectory()) return res.status(400).json({ error: 'Cannot preview directory' });

    const name = path.basename(fp);
    const mimeType = mime.lookup(name) || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const size = s.size;
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : Math.min(start + 5 * 1024 * 1024, size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
      });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', s.size);
      fs.createReadStream(fp).pipe(res);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── File Operations ──────────────────────────────────────────────────────────
app.post('/api/files/mkdir', requireAuth, async (req, res) => {
  try {
    const vol = volParam(req);
    const dp = safePath(req.body.path, vol);
    await fs.ensureDir(dp);
    res.json({ success: true, path: relativePath(dp, volumeRoot(vol)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/files', requireAuth, async (req, res) => {
  try {
    const vol = req.query.volume || Object.keys(volumes)[0];
    const fp = safePath(req.query.path || req.body?.path, vol);
    if (fp === volumeRoot(vol)) return res.status(400).json({ error: 'Cannot delete root' });
    await fs.remove(fp);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/files/move', requireAuth, async (req, res) => {
  try {
    const vol = volParam(req);
    const root = volumeRoot(vol);
    const src = safePath(req.body.src, vol);
    const dst = safePath(req.body.dst, vol);
    await fs.ensureDir(path.dirname(dst));
    await fs.move(src, dst, { overwrite: !!req.body.overwrite });
    res.json({ success: true, path: relativePath(dst, root) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/files/copy', requireAuth, async (req, res) => {
  try {
    const vol = volParam(req);
    const root = volumeRoot(vol);
    const src = safePath(req.body.src, vol);
    const dst = safePath(req.body.dst, vol);
    await fs.ensureDir(path.dirname(dst));
    await fs.copy(src, dst, { overwrite: !!req.body.overwrite });
    res.json({ success: true, path: relativePath(dst, root) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Permissions ──────────────────────────────────────────────────────────────
app.post('/api/files/chmod', requireAuth, async (req, res) => {
  try {
    const fp = safePath(req.body.path, volParam(req));
    const modeStr = String(req.body.mode || '755').replace(/[^0-7]/g, '');
    if (!modeStr) return res.status(400).json({ error: 'Invalid mode' });
    if (req.body.recursive) {
      execFileSync('chmod', ['-R', modeStr, fp]);
    } else {
      await fs.chmod(fp, parseInt(modeStr, 8));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/files/chown', requireAuth, async (req, res) => {
  try {
    const fp = safePath(req.body.path, volParam(req));
    const uid = parseInt(req.body.uid);
    const gid = parseInt(req.body.gid);
    if (isNaN(uid) || isNaN(gid)) return res.status(400).json({ error: 'Invalid uid/gid' });
    if (req.body.recursive) {
      execFileSync('chown', ['-R', `${uid}:${gid}`, fp]);
    } else {
      await fs.chown(fp, uid, gid);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── S3 ───────────────────────────────────────────────────────────────────────
const S3_CONFIG_FILE = path.join(Object.values(volumes)[0], '.pvcbrowser-s3.json');

let s3Cfg = {
  endpoint: process.env.S3_ENDPOINT || '',
  accessKeyId: process.env.S3_ACCESS_KEY || '',
  secretAccessKey: process.env.S3_SECRET_KEY || '',
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: process.env.S3_PATH_STYLE === 'true',
};

(async () => {
  try {
    if (await fs.pathExists(S3_CONFIG_FILE) && !process.env.S3_ENDPOINT) {
      Object.assign(s3Cfg, await fs.readJson(S3_CONFIG_FILE));
    }
  } catch {}
})();

function buildS3Client() {
  const c = {
    region: s3Cfg.region || 'us-east-1',
    credentials: { accessKeyId: s3Cfg.accessKeyId, secretAccessKey: s3Cfg.secretAccessKey },
    forcePathStyle: s3Cfg.forcePathStyle,
  };
  if (s3Cfg.endpoint) c.endpoint = s3Cfg.endpoint;
  return new S3Client(c);
}

app.get('/api/s3/config', requireAuth, (_req, res) => {
  res.json({
    endpoint: s3Cfg.endpoint,
    accessKeyId: s3Cfg.accessKeyId ? '•••' + s3Cfg.accessKeyId.slice(-4) : '',
    bucket: s3Cfg.bucket,
    region: s3Cfg.region,
    forcePathStyle: s3Cfg.forcePathStyle,
    configured: !!(s3Cfg.accessKeyId && s3Cfg.bucket),
  });
});

app.post('/api/s3/config', requireAuth, async (req, res) => {
  try {
    s3Cfg = {
      endpoint: req.body.endpoint || '',
      accessKeyId: req.body.accessKeyId || '',
      secretAccessKey: req.body.secretAccessKey || '',
      bucket: req.body.bucket || '',
      region: req.body.region || 'us-east-1',
      forcePathStyle: !!req.body.forcePathStyle,
    };
    await fs.writeJson(S3_CONFIG_FILE, s3Cfg, { spaces: 2 });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/s3/list', requireAuth, async (req, res) => {
  try {
    const client = buildS3Client();
    const bucket = req.query.bucket || s3Cfg.bucket;
    const prefix = req.query.prefix || '';
    const flat = req.query.flat === 'true';   // flat=true → no Delimiter, list all keys

    const cmdParams = { Bucket: bucket, Prefix: prefix, MaxKeys: 1000 };
    if (!flat) cmdParams.Delimiter = '/';

    const cmd = new ListObjectsV2Command(cmdParams);
    const data = await client.send(cmd);

    const items = [
      ...(!flat ? (data.CommonPrefixes || []).map(p => ({
        key: p.Prefix,
        name: p.Prefix.replace(prefix, '').replace(/\/$/, '') || p.Prefix,
        isDirectory: true,
        size: 0,
      })) : []),
      ...(data.Contents || [])
        .filter(c => c.Key !== prefix && c.Key !== '')
        .map(c => ({
          key: c.Key,
          name: flat ? c.Key : (c.Key.split('/').pop() || c.Key),
          isDirectory: false,
          size: c.Size,
          modified: c.LastModified,
          etag: c.ETag,
          mimeType: mime.lookup(c.Key) || 'application/octet-stream',
        })),
    ];

    res.json({ bucket, prefix, flat, items, truncated: data.IsTruncated, totalKeys: data.KeyCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/s3/download', requireAuth, async (req, res) => {
  try {
    const client = buildS3Client();
    const key = req.query.key;
    const bucket = req.query.bucket || s3Cfg.bucket;

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const data = await client.send(cmd);

    const name = path.basename(key);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', mime.lookup(name) || 'application/octet-stream');
    if (data.ContentLength) res.setHeader('Content-Length', data.ContentLength);
    data.Body.pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/s3/preview', requireAuth, async (req, res) => {
  try {
    const client = buildS3Client();
    const key = req.query.key;
    const bucket = req.query.bucket || s3Cfg.bucket;

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const data = await client.send(cmd);
    res.setHeader('Content-Type', mime.lookup(path.basename(key)) || 'application/octet-stream');
    if (data.ContentLength) res.setHeader('Content-Length', data.ContentLength);
    data.Body.pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/s3/copy-to-pvc', requireAuth, async (req, res) => {
  try {
    const client = buildS3Client();
    const key = req.body.key;
    const bucket = req.body.bucket || s3Cfg.bucket;
    const targetDir = safePath(req.body.targetPath || '/');

    await fs.ensureDir(targetDir);
    const finalPath = path.join(targetDir, path.basename(key));

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const data = await client.send(cmd);

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(finalPath);
      data.Body.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    res.json({ success: true, path: relativePath(finalPath) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── System Info ──────────────────────────────────────────────────────────────
app.get('/api/system/info', requireAuth, (req, res) => {
  let uid = 0, gid = 0, idOutput = 'unavailable';
  try {
    uid = process.getuid ? process.getuid() : 0;
    gid = process.getgid ? process.getgid() : 0;
    idOutput = execSync('id', { timeout: 2000 }).toString().trim();
  } catch {}

  res.json({
    uid,
    gid,
    idOutput,
    dataPath: DATA_PATH,
    commands: {
      getCurrentUser: 'id',
      getFileOwner: 'stat -c "%u %g %a %n" /path/to/file',
      listWithOwners: 'ls -lan /path/to/directory',
      findByUid: `find ${DATA_PATH} -user <uid>`,
      findByGid: `find ${DATA_PATH} -group <gid>`,
      changeOwner: 'chown -R <uid>:<gid> /path/to/file',
      changeMode: 'chmod -R 777 /path/to/file',
      setAllPermissions: `find ${DATA_PATH} -exec chmod 777 {} \\;`,
    },
  });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ PVC File Browser  → http://0.0.0.0:${PORT}`);
  console.log(`  Data path         → ${DATA_PATH}`);
  console.log(`  Company name      → ${cfg.companyName}`);
  console.log(`  Username          → ${cfg.username}`);
});
