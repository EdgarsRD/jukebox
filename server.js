const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const os = require('os');
const { execFile } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request device model, platform and mobile hint from browsers that support Client Hints
app.use((req, res, next) => {
  res.set('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Mobile');
  next();
});

// ─── Config helpers ──────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HISTORY_PATH = path.join(__dirname, 'history.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      auth: { username: '', passwordHash: '' },
      network: { domain: '', localIp: '' },
      spotify: { clientId: '', clientSecret: '', refreshToken: '' },
      rules: { rateLimitMinutes: 5, maxQueueLength: 20, maxSongsPerDevice: 2 },
      moderation: { blockMode: 'silent', blockedDevices: [] }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

loadConfig(); // ensure config.json exists on first run

// ─── History helpers ──────────────────────────────────────────────────────────

const MAX_HISTORY = 200;

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function addToHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  saveHistory(history);
}

// ─── Queue state (persisted) ─────────────────────────────────────────────────

const QUEUE_PATH = path.join(__dirname, 'queue.json');
const rateLimitMap = {}; // fingerprint → timestamp

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')); } catch { return []; }
}

function saveQueue() {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(internalQueue, null, 2));
}

const internalQueue = loadQueue();

// ─── Unban requests (persisted) ──────────────────────────────────────────────

const UNBAN_PATH = path.join(__dirname, 'unban-requests.json');

function loadUnbanRequests() {
  if (!fs.existsSync(UNBAN_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(UNBAN_PATH, 'utf8')); } catch { return []; }
}

function saveUnbanRequests(requests) {
  fs.writeFileSync(UNBAN_PATH, JSON.stringify(requests, null, 2));
}

// ─── Device fingerprint ───────────────────────────────────────────────────────

function getFingerprint(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  return Buffer.from(ip + ua).toString('base64');
}

function getDeviceInfo(req) {
  const raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/, '');
  const ua = req.headers['user-agent'] || '';

  // Client Hints (Chrome 100+, Edge, Opera — not Firefox/Safari)
  const chModel = (req.headers['sec-ch-ua-model'] || '').replace(/"/g, '').trim();
  const chPlatform = (req.headers['sec-ch-ua-platform'] || '').replace(/"/g, '').trim();
  const chMobile = req.headers['sec-ch-ua-mobile'];

  let os = chPlatform || 'Unknown';
  if (os === 'Unknown') {
    if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Mac OS/.test(ua)) os = 'macOS';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Linux/.test(ua)) os = 'Linux';
  }

  let browser = 'Unknown';
  if (/EdgA?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  const mobile = chMobile === '?1' || /Mobile|Android|iPhone|iPad/.test(ua);
  const model = chModel || null; // e.g. "SM-G991B", "Pixel 7" — null on iOS/Firefox/desktop

  return { ip, os, browser, mobile, model };
}

// ─── Spotify token management ─────────────────────────────────────────────────

let accessToken = null;
let accessTokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;

  const cfg = loadConfig();
  if (!cfg.spotify.clientId || !cfg.spotify.clientSecret || !cfg.spotify.refreshToken) {
    throw new Error('Spotify not configured');
  }

  const creds = Buffer.from(`${cfg.spotify.clientId}:${cfg.spotify.clientSecret}`).toString('base64');
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({ grant_type: 'refresh_token', refresh_token: cfg.spotify.refreshToken }),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  accessToken = res.data.access_token;
  accessTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return accessToken;
}

async function spotifyRequest(method, endpoint, data = null) {
  const token = await getAccessToken();
  const config_req = {
    method,
    url: `https://api.spotify.com/v1${endpoint}`,
    headers: { Authorization: `Bearer ${token}` }
  };
  if (data) config_req.data = data;
  return axios(config_req);
}

// ─── Admin auth middleware ────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const cfg = loadConfig();

  // First-run: no password set yet
  if (!cfg.auth.passwordHash) {
    if (req.path === '/setup' || req.path === '/setup/save') return next();
    return res.redirect('/admin/setup');
  }

  // Basic Auth check
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Jukebox Admin"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [username, password] = decoded.split(':');
  const expectedUser = cfg.auth.username || 'admin';
  if (username !== expectedUser) {
    res.set('WWW-Authenticate', 'Basic realm="Jukebox Admin"');
    return res.status(401).send('Invalid credentials');
  }

  bcrypt.compare(password, cfg.auth.passwordHash).then(match => {
    if (!match) {
      res.set('WWW-Authenticate', 'Basic realm="Jukebox Admin"');
      return res.status(401).send('Invalid credentials');
    }
    next();
  });
}

// ─── Public routes ────────────────────────────────────────────────────────────

app.use('/', express.static(path.join(__dirname, 'public')));

// Search
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  try {
    const r = await spotifyRequest('get', `/search?q=${encodeURIComponent(q)}&type=track&limit=8`);
    const results = r.data.tracks.items.map(t => ({
      uri: t.uri,
      id: t.id,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      albumArt: t.album.images[1]?.url || t.album.images[0]?.url || ''
    }));
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed. Is Spotify configured?' });
  }
});

// Add to queue
app.post('/api/queue', async (req, res) => {
  const cfg = loadConfig();
  const fp = getFingerprint(req);
  const now = Date.now();

  // Block check
  const blockedList = cfg.moderation?.blockedDevices || [];
  const isBlocked = blockedList.some(b => (typeof b === 'string' ? b : b.fingerprint) === fp);
  if (isBlocked) {
    const pending = loadUnbanRequests().some(r => r.fingerprint === fp && r.status === 'pending');
    return res.status(403).json({ blocked: true, pending, error: 'Your device has been blocked from making requests.' });
  }

  // Rate limit check
  if (rateLimitMap[fp]) {
    const elapsed = now - rateLimitMap[fp];
    const limitMs = cfg.rules.rateLimitMinutes * 60 * 1000;
    if (elapsed < limitMs) {
      const remaining = Math.ceil((limitMs - elapsed) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      return res.status(429).json({
        error: `You can request again in ${mins}:${secs.toString().padStart(2, '0')}`
      });
    }
  }

  // Max queue length
  if (internalQueue.length >= cfg.rules.maxQueueLength) {
    return res.status(400).json({ error: 'Queue is full. Try again later!' });
  }

  // Max per device
  const deviceCount = internalQueue.filter(s => s.addedBy === fp).length;
  if (deviceCount >= cfg.rules.maxSongsPerDevice) {
    return res.status(400).json({
      error: `You already have ${cfg.rules.maxSongsPerDevice} songs in the queue.`
    });
  }

  const { uri, title, artist, albumArt } = req.body;
  if (!uri) return res.status(400).json({ error: 'Missing track URI' });

  try {
    console.log(`[Queue] Attempting to queue: ${title} (${uri})`);
    console.log(`[Queue] Access token valid: ${!!accessToken}, expires in: ${Math.round((accessTokenExpiry - Date.now()) / 1000)}s`);
    const queueRes = await spotifyRequest('post', `/me/player/queue?uri=${encodeURIComponent(uri)}`);
    console.log(`[Queue] Spotify response status: ${queueRes.status}`);

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      spotifyUri: uri,
      title,
      artist,
      albumArt,
      addedBy: fp,
      addedAt: now
    };
    internalQueue.push(entry);
    saveQueue();
    rateLimitMap[fp] = now;

    // Log to history
    const device = getDeviceInfo(req);
    addToHistory({
      id: entry.id,
      fingerprint: fp,
      fingerprintShort: crypto.createHash('sha256').update(fp).digest('hex').slice(0, 8),
      device,
      title,
      artist,
      albumArt,
      addedAt: now
    });

    res.json({ success: true, message: `"${title}" added to the queue!` });
  } catch (err) {
    console.error('[Queue] Error:', err.message);
    console.error('[Queue] Spotify status:', err.response?.status);
    console.error('[Queue] Spotify says:', JSON.stringify(err.response?.data));
    console.error('[Queue] URI was:', uri);
    res.status(500).json({ error: 'Failed to add song. Is Spotify playing?' });
  }
});

// Get queue
app.get('/api/queue', (req, res) => {
  const fp = getFingerprint(req);
  res.json({ queue: internalQueue.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    albumArt: s.albumArt,
    own: s.addedBy === fp
  }))});
});

// Remove own song from queue
app.delete('/api/queue/:id', (req, res) => {
  const fp = getFingerprint(req);
  const idx = internalQueue.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (internalQueue[idx].addedBy !== fp) return res.status(403).json({ error: 'You can only remove your own songs' });
  internalQueue.splice(idx, 1);
  saveQueue();
  res.json({ success: true });
});

// Now playing
app.get('/api/nowplaying', async (req, res) => {
  try {
    const r = await spotifyRequest('get', '/me/player/currently-playing');
    if (!r.data || !r.data.item) return res.json({ playing: false });
    const t = r.data.item;

    // Auto-prune: remove queue entries that are now playing or already played
    const currentUri = t.uri;
    let pruned = false;
    while (internalQueue.length > 0 && internalQueue[0].spotifyUri === currentUri) {
      internalQueue.shift();
      pruned = true;
    }
    if (pruned) saveQueue();

    res.json({
      playing: r.data.is_playing,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      albumArt: t.album.images[1]?.url || t.album.images[0]?.url || '',
      progress: r.data.progress_ms,
      duration: t.duration_ms
    });
  } catch {
    res.json({ playing: false });
  }
});

// Submit unban request
app.post('/api/unban-request', (req, res) => {
  const fp = getFingerprint(req);
  const device = getDeviceInfo(req);
  const { message } = req.body;

  // Only blocked devices can request unban
  const cfg = loadConfig();
  const blockedList = cfg.moderation?.blockedDevices || [];
  const isBlocked = blockedList.some(b => (typeof b === 'string' ? b : b.fingerprint) === fp);
  if (!isBlocked) return res.status(400).json({ error: 'Your device is not blocked' });

  const requests = loadUnbanRequests();
  const existing = requests.find(r => r.fingerprint === fp && r.status === 'pending');
  if (existing) return res.json({ success: true, message: 'Unban request already submitted' });

  requests.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    fingerprint: fp,
    fingerprintShort: crypto.createHash('sha256').update(fp).digest('hex').slice(0, 8),
    device,
    message: (message || '').slice(0, 200),
    status: 'pending',
    createdAt: Date.now()
  });
  saveUnbanRequests(requests);
  res.json({ success: true, message: 'Unban request submitted' });
});

// ─── Admin setup routes (public — bypass auth for first-run) ────────────────

app.get('/admin/setup', (req, res) => {
  const cfg = loadConfig();
  if (cfg.auth.passwordHash && !req.query.step) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'admin', 'setup.html'));
});

app.post('/admin/setup/save', async (req, res) => {
  const cfg = loadConfig();
  if (cfg.auth.passwordHash) return res.status(400).send('Password already set');
  const { username, password, confirm } = req.body;
  if (!username || !username.trim()) {
    return res.status(400).send('Username is required');
  }
  if (!password || password !== confirm) {
    return res.status(400).send('Passwords do not match');
  }
  if (password.length < 6) {
    return res.status(400).send('Password must be at least 6 characters');
  }
  const hash = await bcrypt.hash(password, 12);
  const cfg2 = loadConfig();
  cfg2.auth.username = username.trim();
  cfg2.auth.passwordHash = hash;
  saveConfig(cfg2);
  res.json({ success: true });
});

// Network info for wizard (no auth required)
app.get('/admin/setup/network-info', (req, res) => {
  const cfg = loadConfig();
  const certExists = fs.existsSync(path.join(__dirname, 'cert.pem')) && fs.existsSync(path.join(__dirname, 'key.pem'));
  const protocol = certExists ? 'https' : 'http';
  const host = req.get('host');

  // Detect local IP from network interfaces
  let detectedIp = '127.0.0.1';
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        detectedIp = iface.address;
        break;
      }
    }
    if (detectedIp !== '127.0.0.1') break;
  }

  res.json({
    certExists,
    protocol,
    host,
    detectedIp,
    domain: cfg.network?.domain || '',
    localIp: cfg.network?.localIp || detectedIp,
    redirectUri: `${protocol}://${host}/auth/callback`
  });
});

// Spotify authorize for wizard (no auth required, adds state=wizard)
app.get('/admin/setup/spotify/authorize', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.spotify.clientId) {
    return res.status(400).send('Save Spotify credentials first');
  }
  const protocol = (fs.existsSync(path.join(__dirname, 'cert.pem')) && fs.existsSync(path.join(__dirname, 'key.pem'))) ? 'https' : 'http';
  const scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.spotify.clientId,
    scope: scopes,
    redirect_uri: `${protocol}://${req.get('host')}/auth/callback`,
    state: 'wizard'
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// ─── Admin routes (protected) ─────────────────────────────────────────────────

const adminRouter = express.Router();
adminRouter.use(adminAuth);

adminRouter.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Change password
adminRouter.post('/api/password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  const cfg = loadConfig();
  cfg.auth.passwordHash = hash;
  saveConfig(cfg);
  res.json({ success: true });
});

// Get config (no secrets in response)
adminRouter.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    spotify: {
      clientId: cfg.spotify.clientId,
      clientSecret: cfg.spotify.clientSecret ? '••••••••' : '',
      connected: !!(cfg.spotify.refreshToken)
    },
    rules: cfg.rules
  });
});

// Save Spotify credentials
adminRouter.post('/api/spotify/credentials', (req, res) => {
  const { clientId, clientSecret } = req.body;
  const cfg = loadConfig();
  cfg.spotify.clientId = clientId;
  cfg.spotify.clientSecret = clientSecret;
  cfg.spotify.refreshToken = ''; // reset on new credentials
  saveConfig(cfg);
  accessToken = null; // invalidate cached token
  res.json({ success: true });
});

// Spotify OAuth step 1 — redirect to Spotify
adminRouter.get('/spotify/authorize', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.spotify.clientId) {
    return res.status(400).send('Save Spotify credentials first');
  }
  const scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.spotify.clientId,
    scope: scopes,
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// Save domain and local IP
adminRouter.post('/api/domain', (req, res) => {
  const { domain, localIp } = req.body;
  if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}[a-zA-Z0-9]$/.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain name' });
  }
  if (!localIp || !/^(\d{1,3}\.){3}\d{1,3}$/.test(localIp)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }
  const cfg = loadConfig();
  if (!cfg.network) cfg.network = {};
  cfg.network.domain = domain.toLowerCase();
  cfg.network.localIp = localIp;
  saveConfig(cfg);
  res.json({ success: true });
});

// Generate self-signed TLS certificate
adminRouter.post('/api/generate-cert', (req, res) => {
  const cfg = loadConfig();
  const domain = cfg.network?.domain;
  const localIp = cfg.network?.localIp;
  if (!domain || !localIp) {
    return res.status(400).json({ error: 'Configure domain and IP first' });
  }

  const certPath = path.join(__dirname, 'cert.pem');
  const keyPath = path.join(__dirname, 'key.pem');
  const san = `subjectAltName=DNS:${domain},DNS:localhost,IP:127.0.0.1,IP:${localIp}`;

  execFile('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '3650',
    '-subj', `/CN=${domain}/O=Jukebox/C=LV`,
    '-addext', san
  ], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Certificate generation failed. Is openssl installed?' });
    }
    res.json({ success: true, domain, localIp });
  });
});

// Restart server (to pick up new certs)
adminRouter.post('/api/restart', (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(1), 500);
});

// Save rules
adminRouter.post('/api/rules', (req, res) => {
  const { rateLimitMinutes, maxQueueLength, maxSongsPerDevice } = req.body;
  console.log('[Rules] Received:', { rateLimitMinutes, maxQueueLength, maxSongsPerDevice });
  const cfg = loadConfig();
  cfg.rules = {
    rateLimitMinutes: Math.max(0, parseInt(rateLimitMinutes) || 0),
    maxQueueLength: Math.max(1, parseInt(maxQueueLength) || 20),
    maxSongsPerDevice: Math.max(1, parseInt(maxSongsPerDevice) || 2)
  };
  saveConfig(cfg);
  console.log('[Rules] Saved:', cfg.rules);
  res.json({ success: true, rules: cfg.rules });
});

// Queue management
adminRouter.get('/api/queue', (req, res) => {
  res.json({ queue: internalQueue });
});

adminRouter.post('/api/skip', async (req, res) => {
  try {
    await spotifyRequest('post', '/me/player/next');
    if (internalQueue.length > 0) { internalQueue.shift(); saveQueue(); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete('/api/queue/:id', (req, res) => {
  const idx = internalQueue.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  internalQueue.splice(idx, 1);
  saveQueue();
  res.json({ success: true });
});

adminRouter.post('/api/queue/clear', (req, res) => {
  internalQueue.length = 0;
  saveQueue();
  res.json({ success: true });
});

adminRouter.post('/api/queue/sync', async (req, res) => {
  try {
    const r = await spotifyRequest('get', '/me/player/queue');
    const spotifyUris = (r.data.queue || []).map(t => t.uri);
    const before = internalQueue.length;
    // Remove internal entries no longer in Spotify's queue
    for (let i = internalQueue.length - 1; i >= 0; i--) {
      if (!spotifyUris.includes(internalQueue[i].spotifyUri)) {
        internalQueue.splice(i, 1);
      }
    }
    const removed = before - internalQueue.length;
    if (removed > 0) saveQueue();
    res.json({ success: true, removed, remaining: internalQueue.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch Spotify queue: ' + err.message });
  }
});

adminRouter.post('/api/queue/reorder', (req, res) => {
  const { fromIndex, toIndex } = req.body;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= internalQueue.length || toIndex >= internalQueue.length) {
    return res.status(400).json({ error: 'Invalid indices' });
  }
  const [item] = internalQueue.splice(fromIndex, 1);
  internalQueue.splice(toIndex, 0, item);
  saveQueue();
  res.json({ success: true });
});

// History
adminRouter.get('/api/history', (req, res) => {
  const cfg = loadConfig();
  const blockedEntries = (cfg.moderation?.blockedDevices || []).map(b =>
    typeof b === 'string' ? b : b.fingerprint
  );
  const history = loadHistory().map(h => ({
    ...h,
    isBlocked: blockedEntries.includes(h.fingerprint)
  }));
  res.json({ history });
});

// Block a device
adminRouter.post('/api/block', (req, res) => {
  const { fingerprint, comment } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const cfg = loadConfig();
  if (!cfg.moderation) cfg.moderation = { blockMode: 'silent', blockedDevices: [] };
  // Migrate any old string entries to objects
  cfg.moderation.blockedDevices = cfg.moderation.blockedDevices.map(b =>
    typeof b === 'string' ? { fingerprint: b, comment: '', blockedAt: Date.now() } : b
  );
  const exists = cfg.moderation.blockedDevices.find(b => b.fingerprint === fingerprint);
  if (!exists) {
    // Look up device info from history
    const history = loadHistory();
    const histEntry = history.find(h => h.fingerprint === fingerprint);
    const device = histEntry?.device || null;
    const shortId = histEntry?.fingerprintShort || crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 8);
    cfg.moderation.blockedDevices.push({ fingerprint, shortId, device, comment: comment || '', blockedAt: Date.now() });
  }
  saveConfig(cfg);
  res.json({ success: true });
});

// Update block comment
adminRouter.post('/api/block/comment', (req, res) => {
  const { fingerprint, comment } = req.body;
  const cfg = loadConfig();
  const entry = (cfg.moderation?.blockedDevices || []).find(b => b.fingerprint === fingerprint);
  if (!entry) return res.status(404).json({ error: 'Device not found' });
  entry.comment = comment || '';
  saveConfig(cfg);
  res.json({ success: true });
});

// Unblock a device
adminRouter.post('/api/unblock', (req, res) => {
  const { fingerprint } = req.body;
  const cfg = loadConfig();
  if (!cfg.moderation) return res.json({ success: true });
  cfg.moderation.blockedDevices = (cfg.moderation.blockedDevices || []).filter(b =>
    (typeof b === 'string' ? b : b.fingerprint) !== fingerprint
  );
  saveConfig(cfg);
  res.json({ success: true });
});

// Get blocked devices
adminRouter.get('/api/blocked', (req, res) => {
  const cfg = loadConfig();
  const blocked = (cfg.moderation?.blockedDevices || []).map(b =>
    typeof b === 'string' ? { fingerprint: b, comment: '', blockedAt: null } : b
  );
  res.json({ blocked });
});

// Unban requests
adminRouter.get('/api/unban-requests', (req, res) => {
  const requests = loadUnbanRequests().filter(r => r.status === 'pending');
  res.json({ requests });
});

adminRouter.post('/api/unban-requests/:id/approve', (req, res) => {
  const requests = loadUnbanRequests();
  const request = requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = 'approved';
  saveUnbanRequests(requests);

  // Unblock the device
  const cfg = loadConfig();
  if (cfg.moderation) {
    cfg.moderation.blockedDevices = (cfg.moderation.blockedDevices || []).filter(b =>
      (typeof b === 'string' ? b : b.fingerprint) !== request.fingerprint
    );
    saveConfig(cfg);
  }
  res.json({ success: true });
});

adminRouter.post('/api/unban-requests/:id/deny', (req, res) => {
  const requests = loadUnbanRequests();
  const request = requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = 'denied';
  saveUnbanRequests(requests);
  res.json({ success: true });
});

app.use('/admin', adminRouter);

// ─── Spotify OAuth callback (public, outside /admin) ─────────────────────────

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Spotify authorization failed: ${error}`);

  const cfg = loadConfig();
  const creds = Buffer.from(`${cfg.spotify.clientId}:${cfg.spotify.clientSecret}`).toString('base64');

  try {
    const r = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`
      }),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const cfg2 = loadConfig();
    cfg2.spotify.refreshToken = r.data.refresh_token;
    saveConfig(cfg2);
    accessToken = r.data.access_token;
    accessTokenExpiry = Date.now() + r.data.expires_in * 1000;

    const fromWizard = req.query.state === 'wizard';
    res.redirect(fromWizard ? '/admin/setup?step=spotify&spotify=connected' : '/admin?spotify=connected');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.send('OAuth failed. Check credentials and try again.');
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH = path.join(__dirname, 'key.pem');

const startupCfg = loadConfig();
const displayHost = startupCfg.network?.domain || 'localhost';

if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  const httpsOptions = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
  };
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`\n✅  Jukebox running`);
    console.log(`    Patron UI : https://${displayHost}:${PORT}`);
    console.log(`    Admin     : https://${displayHost}:${PORT}/admin\n`);
  });
  // Redirect HTTP → HTTPS
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
  }).listen(3001, () => console.log('↩️  HTTP→HTTPS redirect active on port 3001'));
} else {
  console.warn('⚠️  No cert.pem/key.pem found — running HTTP only (generate cert via setup wizard)');
  app.listen(PORT, () => {
    console.log(`\nJukebox running (HTTP only — generate cert for HTTPS)`);
    console.log(`  Patron UI : http://localhost:${PORT}`);
    console.log(`  Admin     : http://localhost:${PORT}/admin\n`);
  });
}
