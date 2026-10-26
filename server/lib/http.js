/** Small fetch helpers: timeouts, retries, a courteous User-Agent. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const USER_AGENT =
  process.env.NWS_USER_AGENT ||
  'TexasWeatherCheddar/1.0 (ambient weather broadcast; contact: set NWS_USER_AGENT)';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with an abort timeout and bounded retries on transport errors and 5xx.
 * 4xx is returned to the caller immediately — retrying a policy denial or a
 * bad request only wastes the upstream's time.
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = 15000,
    retries = 2,
    backoffMs = 800,
    headers = {},
    accept = 'application/geo+json,application/json;q=0.9,*/*;q=0.5',
    ...rest
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...rest,
        signal: ac.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers },
      });
      if (res.status >= 500) throw new HttpError(res.status, url, await res.text().catch(() => ''));
      if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
      return res;
    } catch (err) {
      lastErr = err;
      const fatal = err instanceof HttpError && err.status < 500;
      if (fatal || attempt === retries) break;
      await sleep(backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return res.json();
}

export async function fetchBuffer(url, opts) {
  const res = await fetchWithRetry(url, { accept: 'image/png,image/*', ...opts });
  return Buffer.from(await res.arrayBuffer());
}

const BLOCKED_V4 = [
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^192\.168\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'carrier-grade-nat'],
  [/^(22[4-9]|23\d)\./, 'multicast'],
];

/**
 * Guard for the remote-media proxy: only http(s), and only after confirming
 * every resolved address is public. Keeps an operator-supplied URL from being
 * turned into a probe of the machine the broadcast runs on.
 */
export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported protocol ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });

  for (const { address, family } of addrs) {
    if (family === 6) {
      const a = address.toLowerCase();
      if (a === '::1' || a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) {
        throw new Error(`host resolves to a non-public address (${address})`);
      }
      // IPv4-mapped IPv6 still has to clear the v4 rules.
      const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (mapped) checkV4(mapped[1]);
      continue;
    }
    checkV4(address);
  }
  return u;

  function checkV4(ip) {
    for (const [re, label] of BLOCKED_V4) {
      if (re.test(ip)) throw new Error(`host resolves to a ${label} address (${ip})`);
    }
  }
}
