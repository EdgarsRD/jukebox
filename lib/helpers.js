const crypto = require('crypto');

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split('; ')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return cookies;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signCookie(value, secret) {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return value + '.' + sig;
}

function verifyCookie(signed, secret) {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot === -1) return null;
  const value = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const expected = crypto.createHmac('sha256', secret).update(value).digest('hex');
  if (sig.length !== expected.length) return null;
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return value;
  } catch { /* length mismatch or invalid hex */ }
  return null;
}

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
  const model = chModel || null;

  return { ip, os, browser, mobile, model };
}

module.exports = { parseCookies, generateToken, hashToken, signCookie, verifyCookie, getFingerprint, getDeviceInfo };
