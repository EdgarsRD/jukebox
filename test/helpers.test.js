const { parseCookies, generateToken, hashToken, signCookie, verifyCookie, getFingerprint, getDeviceInfo } = require('../lib/helpers');
const { mockReq } = require('./setup');

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    const req = mockReq({ headers: { cookie: 'foo=bar' } });
    expect(parseCookies(req)).toEqual({ foo: 'bar' });
  });

  it('parses multiple cookies', () => {
    const req = mockReq({ headers: { cookie: 'a=1; b=2; c=3' } });
    expect(parseCookies(req)).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('returns empty object for empty header', () => {
    const req = mockReq({ headers: {} });
    expect(parseCookies(req)).toEqual({});
  });

  it('handles values with equals sign', () => {
    const req = mockReq({ headers: { cookie: 'token=abc=def=ghi' } });
    expect(parseCookies(req)).toEqual({ token: 'abc=def=ghi' });
  });

  it('skips malformed pairs without equals', () => {
    const req = mockReq({ headers: { cookie: 'good=val; badpair; also=ok' } });
    const result = parseCookies(req);
    expect(result.good).toBe('val');
    expect(result.also).toBe('ok');
    expect(result.badpair).toBeUndefined();
  });
});

describe('generateToken', () => {
  it('returns a 64-char hex string', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns unique values per call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it('returns a deterministic 64-char hex SHA-256', () => {
    const hash = hashToken('hello');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('hello')).toBe(hash);
  });

  it('different inputs produce different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('signCookie / verifyCookie', () => {
  const secret = 'test-secret-key';

  it('roundtrips correctly', () => {
    const signed = signCookie('myvalue', secret);
    expect(verifyCookie(signed, secret)).toBe('myvalue');
  });

  it('fails with wrong secret', () => {
    const signed = signCookie('myvalue', secret);
    expect(verifyCookie(signed, 'wrong-secret')).toBeNull();
  });

  it('fails with tampered signature', () => {
    const signed = signCookie('myvalue', secret);
    const tampered = signed.slice(0, -4) + 'ffff';
    expect(verifyCookie(tampered, secret)).toBeNull();
  });

  it('returns null for missing dot', () => {
    expect(verifyCookie('nodothere', secret)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(verifyCookie('.', secret)).toBeNull();
  });

  it('returns null for non-hex signature', () => {
    expect(verifyCookie('value.not-hex-at-all!', secret)).toBeNull();
  });

  it('handles value containing dots', () => {
    const signed = signCookie('a.b.c', secret);
    expect(verifyCookie(signed, secret)).toBe('a.b.c');
  });
});

describe('getFingerprint', () => {
  it('returns consistent output for same input', () => {
    const req = mockReq();
    expect(getFingerprint(req)).toBe(getFingerprint(req));
  });

  it('different IPs produce different fingerprints', () => {
    const req1 = mockReq({ headers: { 'x-forwarded-for': '1.1.1.1', 'user-agent': 'UA' }, socket: {} });
    const req2 = mockReq({ headers: { 'x-forwarded-for': '2.2.2.2', 'user-agent': 'UA' }, socket: {} });
    expect(getFingerprint(req1)).not.toBe(getFingerprint(req2));
  });

  it('handles missing headers gracefully', () => {
    const req = mockReq({ headers: {}, socket: {} });
    expect(typeof getFingerprint(req)).toBe('string');
  });
});

describe('getDeviceInfo', () => {
  it('detects iOS from user agent', () => {
    const req = mockReq({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' } });
    const info = getDeviceInfo(req);
    expect(info.os).toBe('iOS');
    expect(info.browser).toBe('Safari');
    expect(info.mobile).toBe(true);
  });

  it('detects Android from user agent', () => {
    const req = mockReq({ headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36' } });
    const info = getDeviceInfo(req);
    expect(info.os).toBe('Android');
    expect(info.browser).toBe('Chrome');
    expect(info.mobile).toBe(true);
  });

  it('detects Chrome on desktop', () => {
    const req = mockReq({ headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36' } });
    const info = getDeviceInfo(req);
    expect(info.browser).toBe('Chrome');
    expect(info.mobile).toBe(false);
  });

  it('detects Firefox', () => {
    const req = mockReq({ headers: { 'user-agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0' } });
    const info = getDeviceInfo(req);
    expect(info.browser).toBe('Firefox');
    expect(info.os).toBe('Linux');
  });

  it('strips ::ffff: prefix from IP', () => {
    const req = mockReq({ socket: { remoteAddress: '::ffff:192.168.1.5' }, headers: {} });
    const info = getDeviceInfo(req);
    expect(info.ip).toBe('192.168.1.5');
  });

  it('uses Client Hints when available', () => {
    const req = mockReq({
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/120',
        'sec-ch-ua-platform': '"Android"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-model': '"Pixel 7"'
      }
    });
    const info = getDeviceInfo(req);
    expect(info.os).toBe('Android');
    expect(info.mobile).toBe(true);
    expect(info.model).toBe('Pixel 7');
  });

  it('returns null model when no Client Hints', () => {
    const req = mockReq({ headers: { 'user-agent': 'Mozilla/5.0 Firefox/120' } });
    const info = getDeviceInfo(req);
    expect(info.model).toBeNull();
  });
});
