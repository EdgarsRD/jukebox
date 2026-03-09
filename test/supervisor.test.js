// vitest globals: describe, it, expect, beforeEach, afterEach, vi
const path = require('path');
const fs = require('fs');
const { createTmpDir, cleanupTmpDir, writeTestConfig, freshRequireServer, freshServerWithMockedAxios, restoreAxios } = require('./setup');

let tmpDir, server;

beforeEach(async () => {
  tmpDir = createTmpDir();
  process.env.JUKEBOX_DATA_DIR = tmpDir;
  await writeTestConfig(tmpDir);
  server = freshRequireServer();
  server.lastSupervisorAction = 0;
  server.resetAccessToken();
});

afterEach(() => {
  restoreAxios();
  cleanupTmpDir(tmpDir);
  delete process.env.JUKEBOX_DATA_DIR;
  vi.restoreAllMocks();
});

function mockAxios(results) {
  const { server: s, callFn } = freshServerWithMockedAxios(tmpDir, results);
  server = s;
  return callFn;
}

describe('learnBackgroundContextFromSpotify', () => {
  it('stores context fields from spotify data', () => {
    server.learnBackgroundContextFromSpotify({
      context: { uri: 'spotify:playlist:abc', type: 'playlist' },
      item: { uri: 'spotify:track:xyz' },
      progress_ms: 45000
    });
    expect(server.playbackState.baseContextUri).toBe('spotify:playlist:abc');
    expect(server.playbackState.baseContextType).toBe('playlist');
    expect(server.playbackState.baseTrackUri).toBe('spotify:track:xyz');
    expect(server.playbackState.baseProgressMs).toBe(45000);
  });

  it('no-op on null input', () => {
    const before = { ...server.playbackState };
    server.learnBackgroundContextFromSpotify(null);
    expect(server.playbackState.baseContextUri).toBe(before.baseContextUri);
  });

  it('no-op when item is missing', () => {
    const before = { ...server.playbackState };
    server.learnBackgroundContextFromSpotify({ context: null });
    expect(server.playbackState.baseContextUri).toBe(before.baseContextUri);
  });

  it('handles missing context but present item', () => {
    server.learnBackgroundContextFromSpotify({
      item: { uri: 'spotify:track:solo' },
      progress_ms: 1000
    });
    expect(server.playbackState.baseTrackUri).toBe('spotify:track:solo');
  });
});

describe('playRequest', () => {
  it('calls Spotify PUT and transitions to serving_request mode', async () => {
    mockAxios([{ data: {} }]);
    const request = { id: 'req1', spotifyUri: 'spotify:track:test' };
    server.requestQueue.push({ ...request, status: 'queued' });

    const result = await server.playRequest(request);
    expect(result).toBe(true);
    expect(server.playbackState.mode).toBe('serving_request');
    expect(server.playbackState.activeRequestId).toBe('req1');
    expect(server.requestQueue.find(r => r.id === 'req1').status).toBe('playing');
  });

  it('returns false on Spotify error', async () => {
    mockAxios(() => Promise.reject(new Error('Spotify down')));
    const request = { id: 'req2', spotifyUri: 'spotify:track:test' };
    server.requestQueue.push({ ...request, status: 'queued' });

    const result = await server.playRequest(request);
    expect(result).toBe(false);
  });
});

describe('resumeBackgroundPlayback', () => {
  it('resumes with context_uri and offset, transitions to background', async () => {
    let capturedBody;
    mockAxios((config) => {
      capturedBody = config.data;
      return Promise.resolve({ data: {} });
    });

    server.playbackState.mode = 'serving_request';
    server.playbackState.activeRequestId = 'req1';
    server.playbackState.baseContextUri = 'spotify:playlist:bg';
    server.playbackState.baseTrackUri = 'spotify:track:bg1';

    const result = await server.resumeBackgroundPlayback();
    expect(result).toBe(true);
    expect(server.playbackState.mode).toBe('background');
    expect(server.playbackState.activeRequestId).toBeNull();
    expect(capturedBody.context_uri).toBe('spotify:playlist:bg');
    expect(capturedBody.offset.uri).toBe('spotify:track:bg1');
  });

  it('clears context on failure and transitions to background', async () => {
    mockAxios(() => Promise.reject(new Error('fail')));

    server.playbackState.mode = 'serving_request';
    server.playbackState.baseContextUri = 'spotify:playlist:old';

    const result = await server.resumeBackgroundPlayback();
    expect(result).toBe(false);
    expect(server.playbackState.mode).toBe('background');
    expect(server.playbackState.baseContextUri).toBeNull();
    expect(server.playbackState.baseContextType).toBeNull();
    expect(server.playbackState.baseTrackUri).toBeNull();
  });
});

describe('playbackSupervisorTick', () => {
  it('does nothing in background with no queued requests', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:bg' }, context: { uri: 'spotify:playlist:bg', type: 'playlist' }, progress_ms: 100 } }
    ]);
    server.playbackState.mode = 'background';

    await server.playbackSupervisorTick();
    expect(server.playbackState.mode).toBe('background');
  });

  it('plays next request when in background mode with queued entry', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:bg' }, context: { uri: 'spotify:playlist:bg', type: 'playlist' }, progress_ms: 100 } },
      { data: {} }
    ]);

    server.playbackState.mode = 'background';
    server.requestQueue.push({ id: 'next1', spotifyUri: 'spotify:track:req', status: 'queued' });

    await server.playbackSupervisorTick();
    expect(server.playbackState.mode).toBe('serving_request');
    expect(server.requestQueue.find(r => r.id === 'next1').status).toBe('playing');
  });

  it('continues serving if track matches active request', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:active' } } }
    ]);

    server.playbackState.mode = 'serving_request';
    server.playbackState.activeRequestId = 'active1';
    server.requestQueue.push({ id: 'active1', spotifyUri: 'spotify:track:active', status: 'playing' });

    await server.playbackSupervisorTick();
    expect(server.playbackState.mode).toBe('serving_request');
    expect(server.requestQueue.find(r => r.id === 'active1').status).toBe('playing');
  });

  it('transitions to next request when current finishes', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:different' } } },
      { data: {} }
    ]);

    server.playbackState.mode = 'serving_request';
    server.playbackState.activeRequestId = 'done1';
    server.requestQueue.push(
      { id: 'done1', spotifyUri: 'spotify:track:original', status: 'playing' },
      { id: 'next1', spotifyUri: 'spotify:track:next', status: 'queued' }
    );

    await server.playbackSupervisorTick();
    expect(server.requestQueue.find(r => r.id === 'done1').status).toBe('played');
    expect(server.requestQueue.find(r => r.id === 'next1').status).toBe('playing');
  });

  it('resumes background when last request finishes', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:different' } } },
      { data: {} }
    ]);

    server.playbackState.mode = 'serving_request';
    server.playbackState.activeRequestId = 'last1';
    server.playbackState.baseContextUri = 'spotify:playlist:bg';
    server.requestQueue.push({ id: 'last1', spotifyUri: 'spotify:track:original', status: 'playing' });

    await server.playbackSupervisorTick();
    expect(server.requestQueue.find(r => r.id === 'last1').status).toBe('played');
    expect(server.playbackState.mode).toBe('background');
  });

  it('resumes background when active request is missing (cancelled)', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:whatever' } } },
      { data: {} }
    ]);

    server.playbackState.mode = 'serving_request';
    server.playbackState.activeRequestId = 'gone';
    server.playbackState.baseContextUri = 'spotify:playlist:bg';

    await server.playbackSupervisorTick();
    expect(server.playbackState.mode).toBe('background');
  });

  it('skips tick when Spotify is not configured', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    cfg.spotify = { clientId: '', clientSecret: '', refreshToken: '' };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    const callFn = mockAxios([]);
    await server.playbackSupervisorTick();
    expect(callFn).not.toHaveBeenCalled();
  });

  it('skips tick when Spotify is unreachable', async () => {
    mockAxios(() => Promise.reject(new Error('Network error')));

    server.playbackState.mode = 'background';
    server.requestQueue.push({ id: 'q1', spotifyUri: 'spotify:track:test', status: 'queued' });

    await server.playbackSupervisorTick();
    expect(server.playbackState.mode).toBe('background');
    expect(server.requestQueue.find(r => r.id === 'q1').status).toBe('queued');
  });

  it('respects 2s rate guard', async () => {
    mockAxios([
      { data: { item: { uri: 'spotify:track:bg' }, context: { uri: 'spotify:playlist:bg', type: 'playlist' }, progress_ms: 100 } },
      { data: {} },
    ]);

    server.playbackState.mode = 'background';
    server.requestQueue.push({ id: 'q1', spotifyUri: 'spotify:track:test', status: 'queued' });
    await server.playbackSupervisorTick();

    server.lastSupervisorAction = Date.now();
    server.requestQueue.push({ id: 'q2', spotifyUri: 'spotify:track:test2', status: 'queued' });
    await server.playbackSupervisorTick();
    expect(server.requestQueue.find(r => r.id === 'q2').status).toBe('queued');
  });
});
