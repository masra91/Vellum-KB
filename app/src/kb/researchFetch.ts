// Connect-time SSRF defense for the Web researcher's live fetch handler (SPEC-0028 RESEARCH-8;
// KB-QD's hard gate on #85). The static `isAllowedUrl` host check (researchWebAgent) cannot stop a
// PUBLIC-looking DNS name that RESOLVES to a private/loopback IP — DNS-rebinding, or an attacker
// domain with an A-record of 127.0.0.1 / 169.254.169.254. The complete defense enforces on the
// RESOLVED address at connect time: a custom DNS `lookup` (wired into the http(s) Agent) that
// rejects the connection if ANY resolved address is non-public. Reuses `isPublicHost` so the
// IP-range policy is defined once.
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isPublicHost, isAllowedUrl } from './researchWebAgent';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolve a hostname to all its addresses. Injected for tests; defaults to `dns.lookup({all:true})`. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses as ResolvedAddress[])));
  });

/** Throw if ANY resolved address is non-public (loopback/private/link-local/metadata/IPv6 equivs).
 *  An empty resolution also throws (a name that resolves to nothing must not be connected to). */
export function assertPublicResolved(addresses: readonly ResolvedAddress[]): void {
  if (addresses.length === 0) throw new Error('SSRF blocked: hostname did not resolve to any address');
  for (const a of addresses) {
    if (!isPublicHost(a.address)) throw new Error(`SSRF blocked: hostname resolves to non-public address ${a.address}`);
  }
}

/** Node `dns.lookup`-shaped callback signature, as `http.Agent({ lookup })` expects. */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void;
type LookupOptions = { all?: boolean };

/**
 * Build an SSRF-safe `lookup` for an http(s) Agent (RESEARCH-8): resolve the hostname, REFUSE the
 * connection (error the callback) if any resolved IP is non-public, else hand the address(es) back.
 * Because the Agent connects to exactly what this returns, a rebinding name can't slip a private IP
 * past the static gate. Honors the `{all:true}` option shape. The resolver is injected (tests) /
 * `dns.lookup` (production).
 */
export function makeSsrfSafeLookup(resolver: Resolver = defaultResolver): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((addresses) => {
        try {
          assertPublicResolved(addresses);
        } catch (e) {
          callback(e as NodeJS.ErrnoException, '');
          return;
        }
        if (options && options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((e) => callback(e as NodeJS.ErrnoException, ''));
  };
}

export interface GatedFetchResponse {
  url: string;
  status: number;
  /** Response body as text, capped at `maxBytes`. */
  text: string;
  /** True if the body was longer than `maxBytes` and got cut. */
  truncated: boolean;
}

export interface GatedFetchOptions {
  /** The researcher's allowed domains; `[]` = any public host (the public-web default). */
  allowedDomains?: readonly string[];
  /** Injected DNS resolver (tests). Production uses `dns.lookup` via {@link makeSsrfSafeLookup}. */
  resolver?: Resolver;
  /** Response body cap (default 256 KiB) — a researcher reads a page, not a file dump. */
  maxBytes?: number;
  /** Per-request timeout in ms (default 10 000). */
  timeoutMs?: number;
}

/**
 * Build the live web-researcher's ONE fetch primitive (SPEC-0028 RESEARCH-8) — the real, enforceable
 * egress control KB-QD's gate requires, NOT the soft prompt. The live SDK session registers a `fetch`
 * tool whose handler is this, and `overridesBuiltInTool` + an `availableTools` allow-list ensure it is
 * the agent's ONLY way to retrieve a page — so every live fetch passes BOTH gates:
 *   1. the static {@link isAllowedUrl} check (scheme + public host + per-researcher domain allowlist)
 *      runs FIRST, so a disallowed/`file:`/private-literal URL never even opens a socket; and
 *   2. the http(s) Agent's DNS `lookup` is {@link makeSsrfSafeLookup}, so a PUBLIC-looking name that
 *      RESOLVES to a private/loopback/metadata IP is refused at connect time (DNS-rebinding-safe) —
 *      the Agent connects to exactly the checked address, never re-resolving.
 * Body is size-capped. Fails closed: a refused/blocked/timed-out request rejects (the caller records a
 * no-finding), never a silent partial.
 */
export function makeGatedFetch(opts: GatedFetchOptions = {}): (url: string) => Promise<GatedFetchResponse> {
  const lookup = makeSsrfSafeLookup(opts.resolver);
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // The SSRF lookup is wired into the Agent (not just the request) so it governs every connection the
  // Agent makes for this researcher, incl. redirects handled at this layer.
  const httpsAgent = new https.Agent({ lookup });
  const httpAgent = new http.Agent({ lookup });

  return (url: string) =>
    new Promise<GatedFetchResponse>((resolve, reject) => {
      // Gate 1 — static allowlist, BEFORE any socket. Rejects non-http(s), non-public hosts, and
      // (when configured) anything outside the researcher's domain allowlist.
      if (!isAllowedUrl(url, opts.allowedDomains)) {
        reject(new Error(`egress refused: ${url} is not an allowed URL`));
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error('egress refused: malformed URL'));
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

      // Diagnostic marker (env-gated; silent in prod): emits one line per ACTUAL page retrieval through
      // this gate. Lets a live run prove every fetched page BODY passed the isAllowedUrl + SSRF-Agent
      // chokepoint — so KB-QD can confirm the CLI's built-in web_search returns query→results only and
      // never self-fetches page content un-gated (SPEC-0028 1d / RESEARCH-8 self-fetch check).
      if (process.env.KB_RESEARCH_FETCH_LOG) process.stderr.write(`[gated-fetch] ${url}\n`);

      let settled = false;
      const fail = (e: Error): void => {
        if (settled) return;
        settled = true;
        reject(e);
      };

      const req = lib.request(url, { method: 'GET', agent, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let len = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          chunks.push(c);
          len += c.length;
          if (len >= maxBytes) {
            truncated = true;
            res.destroy(); // stop reading once we have enough; 'close' settles the promise
          }
        });
        const done = (): void => {
          if (settled) return;
          settled = true;
          let text = Buffer.concat(chunks).toString('utf8');
          if (text.length > maxBytes) text = text.slice(0, maxBytes);
          resolve({ url, status: res.statusCode ?? 0, text, truncated });
        };
        res.on('end', done);
        res.on('close', done); // fires on our maxBytes-triggered destroy() too
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error(`egress timeout after ${timeoutMs}ms: ${url}`)));
      // Gate 2 surfaces here: the SSRF lookup erroring the connection lands as a request error → fail closed.
      req.on('error', fail);
      req.end();
    });
}
