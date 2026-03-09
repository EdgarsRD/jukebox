// vitest globals: describe, it, expect, beforeEach, afterEach, vi
const path = require('path');
const fs = require('fs');
const supertest = require('supertest');
const { createTmpDir, cleanupTmpDir, writeTestConfig, ADMIN_PASSWORD, SUPERADMIN_PASSWORD, basicAuth, COOKIE_SECRET, freshRequireServer, freshServerWithMockedAxios, restoreAxios } = require('./setup');
const { signCookie, hashToken, generateToken } = require('../lib/helpers');

let tmpDir, server, app;

beforeEach(async () => {
  tmpDir = createTmpDir();
  process.env.JUKEBOX_DATA_DIR = tmpDir;
  await writeTestConfig(tmpDir);
  server = freshRequireServer();
  app = server.app;
});

afterEach(() => {
  restoreAxios();
  cleanupTmpDir(tmpDir);
  delete process.env.JUKEBOX_DATA_DIR;
  vi.restoreAllMocks();
});

const superadminAuth = () => basicAuth('admin', SUPERADMIN_PASSWORD);
const adminAuth = () => basicAuth('admin', ADMIN_PASSWORD);

describe('admin auth', () => {
  it('returns 401 with no credentials', async () => {
    const res = await supertest(app).get('/admin/api/config');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong password', async () => {
    const res = await supertest(app)
      .get('/admin/api/config')
      .set('Authorization', basicAuth('admin', 'wrong'));
    expect(res.status).toBe(401);
  });

  it('creates session cookie on Basic Auth login', async () => {
    const res = await supertest(app)
      .get('/admin/api/config')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'] || [];
    expect(setCookies.some(c => c.startsWith('jukebox_session='))).toBe(true);
  });

  it('reuses session cookie on subsequent requests', async () => {
    const loginRes = await supertest(app)
      .get('/admin/api/config')
      .set('Authorization', superadminAuth());
    const setCookies = loginRes.headers['set-cookie'] || [];
    const sessionCookie = setCookies.find(c => c.startsWith('jukebox_session=')).split(';')[0];

    const res = await supertest(app)
      .get('/admin/api/config')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    const newCookies = res.headers['set-cookie'] || [];
    expect(newCookies.some(c => c.startsWith('jukebox_session=') && !c.includes('Max-Age=0'))).toBe(false);
  });
});

describe('trusted devices', () => {
  it('returns 403 for admin role', async () => {
    const res = await supertest(app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', adminAuth());
    expect(res.status).toBe(403);
  });

  it('creates trusted device and sets cookie', async () => {
    const res = await supertest(app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const setCookies = res.headers['set-cookie'] || [];
    expect(setCookies.some(c => c.startsWith('jukebox_superadmin='))).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    expect(cfg.auth.trustedDevices.length).toBe(1);
  });

  it('deletes a trusted device', async () => {
    await supertest(app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', superadminAuth());
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    const deviceId = cfg.auth.trustedDevices[0].id;

    const res = await supertest(app)
      .delete(`/admin/api/trusted-devices/${deviceId}`)
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);

    const cfg2 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    expect(cfg2.auth.trustedDevices.length).toBe(0);
  });

  it('revokes a trusted device', async () => {
    await supertest(app)
      .post('/admin/api/trusted-devices')
      .set('Authorization', superadminAuth());
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    const deviceId = cfg.auth.trustedDevices[0].id;

    const res = await supertest(app)
      .post(`/admin/api/trusted-devices/revoke/${deviceId}`)
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);

    const cfg2 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    expect(cfg2.auth.trustedDevices.length).toBe(0);
  });
});

describe('queue management (admin)', () => {
  it('returns full queue with all statuses', async () => {
    server.requestQueue.push(
      { id: 'a', status: 'queued', title: 'A' },
      { id: 'b', status: 'playing', title: 'B' },
      { id: 'c', status: 'played', title: 'C' }
    );
    const res = await supertest(app)
      .get('/admin/api/queue')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(res.body.queue).toHaveLength(3);
  });

  it('admin can cancel any entry', async () => {
    server.requestQueue.push({ id: 'any1', status: 'queued', addedBy: 'someone' });
    const res = await supertest(app)
      .delete('/admin/api/queue/any1')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(server.requestQueue.find(r => r.id === 'any1').status).toBe('cancelled');
  });

  it('clears all queued entries', async () => {
    server.requestQueue.push(
      { id: 'a', status: 'queued' },
      { id: 'b', status: 'queued' },
      { id: 'c', status: 'playing' }
    );
    const res = await supertest(app)
      .post('/admin/api/queue/clear')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(server.requestQueue.filter(r => r.status === 'queued')).toHaveLength(0);
    expect(server.requestQueue.find(r => r.id === 'c').status).toBe('playing');
  });

  it('reorders only queued items', async () => {
    server.requestQueue.push(
      { id: 'played1', status: 'played' },
      { id: 'q1', status: 'queued' },
      { id: 'q2', status: 'queued' },
      { id: 'q3', status: 'queued' }
    );
    const res = await supertest(app)
      .post('/admin/api/queue/reorder')
      .set('Authorization', superadminAuth())
      .send({ fromIndex: 0, toIndex: 2 });
    expect(res.status).toBe(200);
    // After reorder: the internal requestQueue is rebuilt
    // Need to re-read from the module since reorder reassigns requestQueue
    const cfg = server;
    const queued = cfg.requestQueue.filter(r => r.status === 'queued');
    expect(queued.map(q => q.id)).toEqual(['q2', 'q3', 'q1']);
  });

  it('skip marks active request as skipped', async () => {
    const { server: s } = freshServerWithMockedAxios(tmpDir, [{ data: {} }]);
    s.requestQueue.push({ id: 'active1', status: 'playing', spotifyUri: 'spotify:track:x' });

    const res = await supertest(s.app)
      .post('/admin/api/skip')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(s.requestQueue.find(r => r.id === 'active1').status).toBe('skipped');
  });
});

describe('config', () => {
  it('masks clientSecret in response', async () => {
    const res = await supertest(app)
      .get('/admin/api/config')
      .set('Authorization', superadminAuth());
    expect(res.status).toBe(200);
    expect(res.body.spotify.clientSecret).toBe('••••••••');
  });

  it('validates rules values', async () => {
    const res = await supertest(app)
      .post('/admin/api/rules')
      .set('Authorization', superadminAuth())
      .send({ rateLimitMinutes: -5, maxQueueLength: 0, maxSongsPerDevice: -1 });
    expect(res.status).toBe(200);
    // rateLimitMinutes: Math.max(0, parseInt(-5) || 0) = Math.max(0, -5) = 0
    expect(res.body.rules.rateLimitMinutes).toBe(0);
    // maxQueueLength: Math.max(1, parseInt(0) || 20) = Math.max(1, 20) = 20 (0 is falsy)
    expect(res.body.rules.maxQueueLength).toBe(20);
    // maxSongsPerDevice: Math.max(1, parseInt(-1) || 2) = Math.max(1, -1) = 1
    expect(res.body.rules.maxSongsPerDevice).toBe(1);
  });
});
