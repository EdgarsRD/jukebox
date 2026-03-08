const acme = require('acme-client');
const axios = require('axios');
const fs = require('fs');

const CF_API = 'https://api.cloudflare.com/client/v4';

// Extract base domain (last 2 segments): sub.example.com -> example.com
function baseDomain(domain) {
  const parts = domain.split('.');
  return parts.slice(-2).join('.');
}

async function getZoneId(domain, token) {
  const base = baseDomain(domain);
  const r = await axios.get(`${CF_API}/zones?name=${base}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.data.success || !r.data.result.length) {
    throw new Error(`No Cloudflare zone found for "${base}". Check your API token permissions.`);
  }
  return r.data.result[0].id;
}

async function createTxtRecord(zoneId, fqdn, value, token) {
  const r = await axios.post(`${CF_API}/zones/${zoneId}/dns_records`, {
    type: 'TXT',
    name: fqdn,
    content: value,
    ttl: 120
  }, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.data.success) {
    throw new Error('Failed to create DNS TXT record: ' + JSON.stringify(r.data.errors));
  }
  return r.data.result.id;
}

async function deleteTxtRecord(zoneId, recordId, token) {
  try {
    await axios.delete(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.error('[LE] Warning: failed to delete TXT record:', e.message);
  }
}

async function waitForDns(fqdn, expected, maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`[LE] Waiting for TXT record on ${fqdn}...`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await axios.get(`https://dns.google/resolve?name=${fqdn}&type=TXT`);
      const answers = r.data.Answer || [];
      if (answers.some(a => a.data.replace(/"/g, '') === expected)) {
        console.log('[LE] DNS propagation confirmed');
        return;
      }
    } catch {}
    await new Promise(ok => setTimeout(ok, 5000));
  }
  throw new Error('DNS propagation timeout - TXT record not visible after 2 minutes');
}

/**
 * Obtain a Let's Encrypt certificate via Cloudflare DNS-01 challenge.
 * @param {object} opts
 * @param {string} opts.domain - e.g. "kzdjukebox.lat"
 * @param {string} opts.cloudflareToken - Cloudflare API token with Zone:DNS:Edit
 * @param {string} opts.certPath - path to write cert.pem
 * @param {string} opts.keyPath - path to write key.pem
 * @param {string|null} opts.accountKey - PEM string of existing account key, or null
 * @returns {Promise<{accountKey: string}>}
 */
async function obtainCertificate({ domain, cloudflareToken, certPath, keyPath, accountKey }) {
  // Get Cloudflare zone ID
  const zoneId = await getZoneId(domain, cloudflareToken);
  console.log(`[LE] Cloudflare zone ID: ${zoneId}`);

  // Account key (reuse or create)
  let accountKeyPem;
  if (accountKey) {
    accountKeyPem = accountKey;
    console.log('[LE] Reusing existing account key');
  } else {
    console.log('[LE] Generating new account key...');
    accountKeyPem = (await acme.crypto.createPrivateKey()).toString();
    console.log('[LE] Account key generated');
  }

  // Create CSR + certificate private key
  console.log('[LE] Creating CSR...');
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: domain });
  console.log('[LE] CSR created');

  // ACME client
  console.log('[LE] Connecting to Let\'s Encrypt...');
  const client = new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey: accountKeyPem
  });
  console.log('[LE] Registering account...');
  await client.createAccount({ termsOfServiceAgreed: true });
  console.log('[LE] Account registered');

  console.log('[LE] Creating order...');
  const order = await client.createOrder({ identifiers: [{ type: 'dns', value: domain }] });
  console.log('[LE] Order created');

  const authorizations = await client.getAuthorizations(order);
  let createdRecordId = null;

  for (const authz of authorizations) {
    const challenge = authz.challenges.find(c => c.type === 'dns-01');
    if (!challenge) throw new Error('No dns-01 challenge offered');

    const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
    const fqdn = `_acme-challenge.${authz.identifier.value}`;

    console.log(`[LE] Creating TXT record: ${fqdn}`);
    createdRecordId = await createTxtRecord(zoneId, fqdn, keyAuthorization, cloudflareToken);
    await waitForDns(fqdn, keyAuthorization);

    console.log('[LE] Completing challenge...');
    await client.completeChallenge(challenge);
    await client.waitForValidStatus(challenge);
    console.log('[LE] Challenge validated');

    console.log(`[LE] Cleaning up TXT record: ${fqdn}`);
    await deleteTxtRecord(zoneId, createdRecordId, cloudflareToken);
    createdRecordId = null;
  }

  console.log('[LE] Finalizing order...');
  await client.finalizeOrder(order, csr);
  const cert = await client.getCertificate(order);
  console.log('[LE] Certificate obtained');

  // Write files
  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, certKey.toString(), { mode: 0o600 });
  console.log(`[LE] Certificate written to ${certPath}`);

  return { accountKey: accountKeyPem };
}

/**
 * Validate a Cloudflare API token can access the domain's zone.
 */
async function validateToken(domain, token) {
  const zoneId = await getZoneId(domain, token);
  // Try listing records to confirm DNS edit permission
  const r = await axios.get(`${CF_API}/zones/${zoneId}/dns_records?type=TXT&per_page=1`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.data.success) {
    throw new Error('Token lacks DNS read permission for this zone');
  }
  return { zoneId };
}

module.exports = { obtainCertificate, validateToken };
