// vitest globals: describe, it, expect, beforeEach, afterEach, vi
const path = require('path');
const fs = require('fs');
const supertest = require('supertest');
const { createTmpDir, cleanupTmpDir, writeTestConfig, freshRequireServer, freshServerWithMockedAxios, restoreAxios } = require('./setup');

let tmpDir, server, app;

function fingerprint(ip, ua) {
  return Buffer.from(ip + ua).toString('base64');
}

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

describe('GET /api/branding', () => {
  it('returns branding from config', async () => {
    const res = await supertest(app).get('/api/branding');
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test Jukebox');
    expect(res.body.subtitle).toBe('Test subtitle');
  });
});

describe('GET /api/top-songs', () => {
  it('returns top songs from history', async () => {
    const history = [
      { title: 'Song A', artist: 'Artist 1', albumArt: 'art1', uri: 'spotify:track:a', addedAt: Date.now() },
      { title: 'Song A', artist: 'Artist 1', albumArt: 'art1', uri: 'spotify:track:a', addedAt: Date.now() },
      { title: 'Song B', artist: 'Artist 2', albumArt: 'art2', uri: 'spotify:track:b', addedAt: Date.now() }
    ];
    fs.writeFileSync(path.join(tmpDir, 'history.json'), JSON.stringify(history));

    const res = await supertest(app).get('/api/top-songs');
    expect(res.status).toBe(200);
    expect(res.body.songs).toHaveLength(2);
    expect(res.body.songs[0].title).toBe('Song A');
    expect(res.body.songs[0].count).toBe(2);
  });
});

describe('GET /api/search', () => {
  it('returns results from Spotify', async () => {
    const { server: s } = freshServerWithMockedAxios(tmpDir, [
      {
        data: {
          tracks: {
            items: [{
              uri: 'spotify:track:123',
              id: '123',
              name: 'Test Track',
              artists: [{ name: 'Test Artist' }],
              album: { name: 'Test Album', images: [{ url: 'http://img1' }, { url: 'http://img2' }] }
            }]
          }
        }
      }
    ]);

    const res = await supertest(s.app).get('/api/search?q=test');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].title).toBe('Test Track');
  });

  it('returns empty for blank query', async () => {
    const res = await supertest(app).get('/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe('GET /api/nowplaying', () => {
  it('returns now playing info', async () => {
    const { server: s } = freshServerWithMockedAxios(tmpDir, [
      {
        data: {
          is_playing: true,
          item: {
            name: 'Now Playing Track',
            artists: [{ name: 'NP Artist' }],
            album: { images: [{ url: 'http://large' }, { url: 'http://medium' }] },
            duration_ms: 240000
          },
          progress_ms: 60000
        }
      }
    ]);

    const res = await supertest(s.app).get('/api/nowplaying');
    expect(res.status).toBe(200);
    expect(res.body.playing).toBe(true);
    expect(res.body.title).toBe('Now Playing Track');
  });

  it('returns playing:false on Spotify error', async () => {
    const { server: s } = freshServerWithMockedAxios(tmpDir, () => Promise.reject(new Error('Spotify down')));

    const res = await supertest(s.app).get('/api/nowplaying');
    expect(res.status).toBe(200);
    expect(res.body.playing).toBe(false);
  });
});

describe('POST /api/unban-request', () => {
  it('returns 400 for non-blocked device', async () => {
    const res = await supertest(app)
      .post('/api/unban-request')
      .set('User-Agent', 'TestAgent')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ message: 'Please unban me' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not blocked');
  });

  it('submits unban request for blocked device', async () => {
    const fp = fingerprint('10.0.0.50', 'BlockedUA');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    cfg.moderation.blockedDevices.push({ fingerprint: fp, comment: 'test' });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    const res = await supertest(app)
      .post('/api/unban-request')
      .set('User-Agent', 'BlockedUA')
      .set('X-Forwarded-For', '10.0.0.50')
      .send({ message: 'Sorry!' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const unbanRequests = JSON.parse(fs.readFileSync(path.join(tmpDir, 'unban-requests.json'), 'utf8'));
    expect(unbanRequests).toHaveLength(1);
    expect(unbanRequests[0].fingerprint).toBe(fp);
    expect(unbanRequests[0].status).toBe('pending');
  });
});
