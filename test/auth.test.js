// vitest globals: describe, it, expect, beforeEach, afterEach, vi
const path = require('path');
const fs = require('fs');
const { createTmpDir, cleanupTmpDir, writeTestConfig, COOKIE_SECRET, ADMIN_PASSWORD, SUPERADMIN_PASSWORD, basicAuth, freshRequireServer } = require('./setup');
const { signCookie, hashToken, generateToken } = require('../lib/helpers');

let tmpDir;
let server;

beforeEach(async () => {
  tmpDir = createTmpDir();
  process.env.JUKEBOX_DATA_DIR = tmpDir;
  await writeTestConfig(tmpDir);
  server = freshRequireServer();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
  delete process.env.JUKEBOX_DATA_DIR;
});

describe('createSessionCookie', () => {
  it('is created on Basic Auth login via adminAuth middleware', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'] || [];
    const sessionCookie = setCookies.find(c => c.startsWith('jukebox_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Max-Age=86400');
  });

  it('stores session with hash, role, and expiry in config', async () => {
    const supertest = require('supertest');
    await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    expect(cfg.auth.sessions.length).toBeGreaterThan(0);
    const session = cfg.auth.sessions[0];
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.role).toBe('superadmin');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('validateSessionCookie', () => {
  it('accepts a valid session cookie', async () => {
    const supertest = require('supertest');
    const loginRes = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    const setCookies = loginRes.headers['set-cookie'] || [];
    const sessionCookie = setCookies.find(c => c.startsWith('jukebox_session='));
    const cookieValue = sessionCookie.split(';')[0];

    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', cookieValue);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('superadmin');
  });

  it('rejects expired session', async () => {
    const token = generateToken();
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    cfg.auth.sessions.push({
      tokenHash: hashToken(token),
      role: 'admin',
      createdAt: Date.now() - 100000,
      expiresAt: Date.now() - 1000
    });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    const signed = signCookie(token, COOKIE_SECRET);
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', `jukebox_session=${signed}`);
    expect(res.status).toBe(401);
  });

  it('rejects tampered cookie', async () => {
    const token = generateToken();
    const signed = signCookie(token, COOKIE_SECRET);
    const tampered = signed.slice(0, -4) + 'dead';

    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', `jukebox_session=${tampered}`);
    expect(res.status).toBe(401);
  });

  it('rejects missing cookie', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role');
    expect(res.status).toBe(401);
  });

  it('rejects unknown token hash', async () => {
    const token = generateToken();
    const signed = signCookie(token, COOKIE_SECRET);

    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', `jukebox_session=${signed}`);
    expect(res.status).toBe(401);
  });
});

describe('setTrustedDeviceCookie', () => {
  it('sets a cookie with 180-day max-age on trusted device creation', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'] || [];
    const trustedCookie = setCookies.find(c => c.startsWith('jukebox_superadmin='));
    expect(trustedCookie).toBeDefined();
    expect(trustedCookie).toContain('Max-Age=15552000');
  });
});

describe('getTrustedSuperadminFromCookie', () => {
  it('recognizes a valid trusted device cookie', async () => {
    const supertest = require('supertest');
    const createRes = await supertest(server.app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    const setCookies = createRes.headers['set-cookie'] || [];
    const trustedCookie = setCookies.find(c => c.startsWith('jukebox_superadmin='));
    const cookieValue = trustedCookie.split(';')[0];

    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', cookieValue);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('superadmin');
  });

  it('rejects bad signature on trusted cookie', async () => {
    const token = generateToken();
    const signed = signCookie(token, 'wrong-secret');

    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', `jukebox_superadmin=${signed}`);
    expect(res.status).toBe(401);
  });

  it('rejects unknown token hash', async () => {
    const token = generateToken();
    const signed = signCookie(token, COOKIE_SECRET);

    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', `jukebox_superadmin=${signed}`);
    expect(res.status).toBe(401);
  });

  it('updates lastSeen on valid trusted device access', async () => {
    const supertest = require('supertest');
    const createRes = await supertest(server.app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    const setCookies = createRes.headers['set-cookie'] || [];
    const trustedCookie = setCookies.find(c => c.startsWith('jukebox_superadmin='));
    const cookieValue = trustedCookie.split(';')[0];

    const before = Date.now();
    await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Cookie', cookieValue);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    const device = cfg.auth.trustedDevices[0];
    expect(device.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe('clearAuthCookies', () => {
  it('sets both cookies to Max-Age=0 on logout', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/logout');
    const setCookies = res.headers['set-cookie'] || [];
    const sessionClear = setCookies.find(c => c.includes('jukebox_session=') && c.includes('Max-Age=0'));
    const trustedClear = setCookies.find(c => c.includes('jukebox_superadmin=') && c.includes('Max-Age=0'));
    expect(sessionClear).toBeDefined();
    expect(trustedClear).toBeDefined();
  });
});

describe('resolveAuthRole', () => {
  it('returns superadmin for superadmin password via Basic Auth', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', SUPERADMIN_PASSWORD));
    expect(res.body.role).toBe('superadmin');
  });

  it('returns admin for admin password via Basic Auth', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', ADMIN_PASSWORD));
    expect(res.body.role).toBe('admin');
  });

  it('returns null (401) for wrong password', async () => {
    const supertest = require('supertest');
    const res = await supertest(server.app)
      .get('/admin/api/auth/role')
      .set('Authorization', basicAuth('admin', 'wrongpassword'));
    expect(res.status).toBe(401);
  });
});
