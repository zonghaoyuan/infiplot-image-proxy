// ─────────────────────────────────────────────────────────────────────────
//  infiplot-image-proxy — image proxy for InfiPlot (Cloudflare Worker)
//
//  Why this exists:
//    Chrome's direct fetch of an image CDN (e.g. im.runware.ai) sometimes
//    fails with ERR_QUIC_PROTOCOL_ERROR — an HTTP/3 stream error mid-transfer
//    leaves the browser holding a partial PNG, which it renders progressively
//    (the visible top-to-bottom "层层加载" decode glitch). Routing the fetch
//    through this Worker fixes it two ways:
//
//      1. Browser ↔ Worker is HTTP/2 over Cloudflare's edge — extremely
//         stable, no QUIC fragility.
//      2. Worker ↔ CDN is a server-to-server fetch over Cloudflare's backbone
//         — also reliable, and `cacheEverything` warms the edge so a repeated
//         image URL is served from cache instead of re-touching the origin.
//
//  Bonus side-effects:
//    - CORS: the Worker adds Access-Control-Allow-Origin, so the client's
//      `fetch()` → blob: URL path works regardless of the CDN's own policy.
//      (im.runware.ai sends NO CORS header, so that blob path is impossible
//      without a proxy like this one.)
//    - Edge cache: the same image URL re-fetched within the TTL hits the CF
//      edge cache — sub-50ms from anywhere in the world.
//
//  Configuration — all optional, set as Worker vars / secrets:
//    ALLOWED_HOSTS    Comma-separated hostnames the proxy may fetch.
//                     Default: "im.runware.ai". Add your provider's image
//                     host here if you don't use Runware.
//    ALLOWED_ORIGINS  Comma-separated browser Origins allowed to USE the
//                     proxy — a quota-abuse guard against other sites
//                     hotlinking it. Default: empty = allow any origin. Set to
//                     your site(s), e.g. "https://infiplot.com,https://x.app".
//
//  Hardening:
//    - Only proxies hosts on the allow-list (open proxies invite abuse + quota burn).
//    - Only accepts GET / HEAD / OPTIONS.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_HOSTS = "im.runware.ai";

function parseList(raw) {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function buildCorsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin ?? "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(req, env) {
    const hostList = parseList(env.ALLOWED_HOSTS);
    const allowedHosts = hostList.length ? hostList : parseList(DEFAULT_ALLOWED_HOSTS);
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);

    const origin = req.headers.get("Origin");
    // Quota-abuse guard: when ALLOWED_ORIGINS is set, a browser fetch() from
    // any other site is rejected. Requests with no Origin header (curl, direct
    // navigation, CDN revalidation) pass through — the guard targets cross-site
    // browser hotlinking, which always sends Origin.
    const originAllowed =
      allowedOrigins.length === 0 ||
      origin === null ||
      allowedOrigins.includes(origin.toLowerCase());

    // With an allow-list, echo the specific origin back (and Vary: Origin);
    // otherwise stay fully open with "*".
    const acaoOrigin = allowedOrigins.length ? (origin ?? undefined) : undefined;
    const cors = buildCorsHeaders(acaoOrigin);

    if (!originAllowed) {
      return new Response("origin not allowed", { status: 403, headers: cors });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    const reqUrl = new URL(req.url);
    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return new Response("missing ?url=", { status: 400, headers: cors });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("malformed ?url=", { status: 400, headers: cors });
    }
    if (!allowedHosts.includes(targetUrl.hostname.toLowerCase())) {
      return new Response(`host not allowed: ${targetUrl.hostname}`, {
        status: 403,
        headers: cors,
      });
    }

    // Fetch upstream. `cf.cacheEverything: true` tells the CF edge to cache by
    // URL even when the origin's own cache headers are weak — so a second hit
    // on the same image lands in edge memory instead of re-touching the origin.
    // 1y TTL: image URLs are immutable, the bytes never change.
    const upstream = await fetch(targetUrl.toString(), {
      cf: { cacheTtl: 31536000, cacheEverything: true },
    });

    // Rebuild headers: add CORS + strong cache hints, preserve content-type /
    // content-length. The client awaits the full body via `.blob()`, so a
    // mid-stream error rejects that promise (client falls back to the direct
    // URL) rather than painting partial bytes.
    const headers = new Headers(cors);
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") ?? "image/png",
    );
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
