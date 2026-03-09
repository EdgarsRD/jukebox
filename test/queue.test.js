// vitest globals: describe, it, expect, beforeEach, afterEach, vi
const path = require('path');
const fs = require('fs');
const supertest = require('supertest');
const { createTmpDir, cleanupTmpDir, writeTestConfig, COOKIE_SECRET, freshRequireServer } = require('./setup');
const { signCookie, hashToken, generateToken } = require('../lib/helpers');

let tmpDir, server, app;

function fingerprint(ip, ua) {
  return Buffer.from(ip + ua).toString('base64');
}

const DEFAULT_UA = 'TestAgent/1.0';
const DEFAULT_IP = '10.0.0.1';

beforeEach(async () => {
  tmpDir = createTmpDir();
  process.env.JUKEBOX_DATA_DIR = tmpDir;
  await writeTestConfig(tmpDir);
  server = freshRequireServer();
  app = server.app;
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
  delete process.env.JUKEBOX_DATA_DIR;
  // Clear rate limit map
  for (const key in server.rateLimitMap) delete server.rateLimitMap[key];
});

describe('status helpers (unit)', () => {
  it('markPlaying changes status', () => {
    server.requestQueue.push({ id: 'test1', status: 'queued' });
    server.markRequestPlaying('test1');
    expect(server.requestQueue.find(r => r.id === 'test1').status).toBe('playing');
  });

  it('markPlayed changes status', () => {
    server.requestQueue.push({ id: 'test2', status: 'playing' });
    server.markRequestPlayed('test2');
    expect(server.requestQueue.find(r => r.id === 'test2').status).toBe('played');
  });

  it('markSkipped changes status', () => {
    server.requestQueue.push({ id: 'test3', status: 'playing' });
    server.markRequestSkipped('test3');
    expect(server.requestQueue.find(r => r.id === 'test3').status).toBe('skipped');
  });

  it('no-op on missing id', () => {
    server.markRequestPlaying('nonexistent');
    // Should not throw
  });

  it('getActiveRequest returns playing entry', () => {
    server.requestQueue.push({ id: 'a', status: 'queued' }, { id: 'b', status: 'playing' });
    expect(server.getActiveRequest().id).toBe('b');
  });

  it('getNextQueuedRequest returns first queued', () => {
    server.requestQueue.push({ id: 'a', status: 'played' }, { id: 'b', status: 'queued' }, { id: 'c', status: 'queued' });
    expect(server.getNextQueuedRequest().id).toBe('b');
  });
});

describe('POST /api/queue', () => {
  it('adds a song with status=queued', async () => {
    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ uri: 'spotify:track:abc', title: 'Test Song', artist: 'Artist', albumArt: 'http://img' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(server.requestQueue.some(r => r.spotifyUri === 'spotify:track:abc' && r.status === 'queued')).toBe(true);
  });

  it('returns 403 for blocked device', async () => {
    const fp = fingerprint('10.0.0.99', 'BlockedAgent');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    cfg.moderation.blockedDevices.push({ fingerprint: fp, comment: '' });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', 'BlockedAgent')
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ uri: 'spotify:track:abc', title: 'Song', artist: 'A' });
    expect(res.status).toBe(403);
    expect(res.body.blocked).toBe(true);
  });

  it('returns 429 for rate-limited device', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.rateLimitMap[fp] = Date.now();

    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ uri: 'spotify:track:abc', title: 'Song', artist: 'A' });
    expect(res.status).toBe(429);
  });

  it('returns 400 when queue is full', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    cfg.rules.maxQueueLength = 1;
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    server.requestQueue.push({ id: 'existing', status: 'queued', addedBy: 'other' });

    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ uri: 'spotify:track:abc', title: 'Song', artist: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('full');
  });

  it('enforces per-device limit', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.requestQueue.push(
      { id: 'a', status: 'queued', addedBy: fp },
      { id: 'b', status: 'queued', addedBy: fp }
    );

    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ uri: 'spotify:track:abc', title: 'Song', artist: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already have');
  });

  it('returns 400 for missing URI', async () => {
    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ title: 'Song', artist: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing');
  });

  it('played entries do not count toward limits', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.requestQueue.push(
      { id: 'a', status: 'played', addedBy: fp },
      { id: 'b', status: 'played', addedBy: fp }
    );

    const res = await supertest(app)
      .post('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP)
      .send({ uri: 'spotify:track:new', title: 'New Song', artist: 'A', albumArt: '' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/queue', () => {
  it('returns only queued/playing entries', async () => {
    server.requestQueue.push(
      { id: 'a', status: 'queued', title: 'A', artist: 'X', albumArt: '', addedBy: 'fp1' },
      { id: 'b', status: 'playing', title: 'B', artist: 'Y', albumArt: '', addedBy: 'fp2' },
      { id: 'c', status: 'played', title: 'C', artist: 'Z', albumArt: '', addedBy: 'fp3' }
    );
    const res = await supertest(app).get('/api/queue');
    expect(res.body.queue).toHaveLength(2);
    expect(res.body.queue.map(q => q.id)).toEqual(['a', 'b']);
  });

  it('sets own flag based on fingerprint', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.requestQueue.push(
      { id: 'mine', status: 'queued', title: 'A', artist: 'X', albumArt: '', addedBy: fp },
      { id: 'other', status: 'queued', title: 'B', artist: 'Y', albumArt: '', addedBy: 'someone-else' }
    );
    const res = await supertest(app)
      .get('/api/queue')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP);
    const mine = res.body.queue.find(q => q.id === 'mine');
    const other = res.body.queue.find(q => q.id === 'other');
    expect(mine.own).toBe(true);
    expect(other.own).toBe(false);
  });

  it('does not leak fingerprint', async () => {
    server.requestQueue.push({ id: 'a', status: 'queued', title: 'A', artist: 'X', albumArt: '', addedBy: 'secret-fp' });
    const res = await supertest(app).get('/api/queue');
    expect(res.body.queue[0].addedBy).toBeUndefined();
  });
});

describe('DELETE /api/queue/:id', () => {
  it('cancels own queued entry', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.requestQueue.push({ id: 'mine', status: 'queued', addedBy: fp });
    const res = await supertest(app)
      .delete('/api/queue/mine')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP);
    expect(res.status).toBe(200);
    expect(server.requestQueue.find(r => r.id === 'mine').status).toBe('cancelled');
  });

  it('returns 403 for other user entry', async () => {
    server.requestQueue.push({ id: 'other', status: 'queued', addedBy: 'someone-else' });
    const res = await supertest(app)
      .delete('/api/queue/other')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP);
    expect(res.status).toBe(403);
  });

  it('returns 400 for non-queued entry', async () => {
    const fp = fingerprint(DEFAULT_IP, DEFAULT_UA);
    server.requestQueue.push({ id: 'playing', status: 'playing', addedBy: fp });
    const res = await supertest(app)
      .delete('/api/queue/playing')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP);
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing entry', async () => {
    const res = await supertest(app)
      .delete('/api/queue/nonexistent')
      .set('User-Agent', DEFAULT_UA)
      .set('X-Forwarded-For', DEFAULT_IP);
    expect(res.status).toBe(404);
  });
});
