const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Known password hashes for testing (pre-computed to avoid bcrypt in every test)
const ADMIN_PASSWORD = 'admin123';
const SUPERADMIN_PASSWORD = 'super456';
let adminHash, superadminHash;

async function getHashes() {
  if (!adminHash) {
    adminHash = await bcrypt.hash(ADMIN_PASSWORD, 4); // low rounds for speed
    superadminHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 4);
  }
  return { adminHash, superadminHash };
}

const COOKIE_SECRET = 'a'.repeat(64); // deterministic test secret

function createTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-test-'));
  // Create uploads subdirectory
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  return dir;
}

function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

async function writeTestConfig(dir, overrides = {}) {
  const { adminHash, superadminHash } = await getHashes();
  const config = {
    auth: {
      username: 'admin',
      passwordHash: adminHash,
      superadminPasswordHash: superadminHash,
      trustedDevices: [],
      cookieSecret: COOKIE_SECRET,
      sessions: []
    },
    network: { domain: 'test.local', localIp: '192.168.1.1' },
    cloudflare: { apiToken: '', accountKey: '', certType: '' },
    spotify: { clientId: 'test-client-id', clientSecret: 'test-client-secret', refreshToken: 'test-refresh-token' },
    rules: { rateLimitMinutes: 5, maxQueueLength: 20, maxSongsPerDevice: 2 },
    moderation: { blockMode: 'silent', blockedDevices: [] },
    branding: { title: 'Test Jukebox', subtitle: 'Test subtitle', logoUrl: '' },
    ...overrides
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return config;
}

function mockReq(overrides = {}) {
  return {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36',
      ...overrides.headers
    },
    socket: { remoteAddress: '127.0.0.1', ...overrides.socket },
    ...overrides
  };
}

function mockRes() {
  const cookies = [];
  return {
    _cookies: cookies,
    append(name, value) {
      if (name === 'Set-Cookie') cookies.push(value);
    },
    set() {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    send(data) { this.body = data; return this; }
  };
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// Clear Node's CJS module cache for server.js and re-require it fresh
function freshRequireServer() {
  const serverPath = require.resolve('../server');
  delete require.cache[serverPath];
  return require('../server');
}

// Replace axios in require.cache with a mock that intercepts both
// the callable form (axios(config)) and axios.post() for token refresh.
// Returns { server, callFn } where callFn is the vi.fn() for the callable.
function freshServerWithMockedAxios(tmpDir, axiosResults) {
  const axiosPath = require.resolve('axios');
  const realAxios = require('axios');

  const callFn = (typeof axiosResults === 'function')
    ? (() => { const fn = vi.fn(); fn.mockImplementation(axiosResults); return fn; })()
    : (() => { const fn = vi.fn(); if (Array.isArray(axiosResults)) { for (const r of axiosResults) fn.mockResolvedValueOnce(r); } return fn; })();

  // Build a callable replacement
  const replacement = function(...args) { return callFn(...args); };
  Object.keys(realAxios).forEach(k => { replacement[k] = realAxios[k]; });
  replacement.post = vi.fn().mockResolvedValue({
    data: { access_token: 'fake-token', expires_in: 3600 }
  });
  replacement.isAxiosError = realAxios.isAxiosError;

  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: replacement };
  delete require.cache[require.resolve('../server')];

  const server = require('../server');
  if (server.resetAccessToken) server.resetAccessToken();
  if (server.lastSupervisorAction !== undefined) server.lastSupervisorAction = 0;

  return { server, callFn };
}

function restoreAxios() {
  delete require.cache[require.resolve('axios')];
  delete require.cache[require.resolve('../server')];
}

module.exports = {
  ADMIN_PASSWORD,
  SUPERADMIN_PASSWORD,
  COOKIE_SECRET,
  getHashes,
  createTmpDir,
  cleanupTmpDir,
  writeTestConfig,
  mockReq,
  mockRes,
  basicAuth,
  freshRequireServer,
  freshServerWithMockedAxios,
  restoreAxios
};
