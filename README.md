# infiplot-image-proxy

A tiny Cloudflare Worker that proxies image-CDN fetches for [InfiPlot](https://github.com/zonghaoyuan/infiplot). It adds CORS, edge caching, and HTTP/2 stability so the browser never paints a half-loaded image.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zonghaoyuan/infiplot-image-proxy)

> **Optional.** InfiPlot works fine without it — by default the browser fetches images directly. Deploy this only if you see images load "top-to-bottom".

## Why

Chrome's direct fetch of an image CDN (e.g. `im.runware.ai`) sometimes fails with `ERR_QUIC_PROTOCOL_ERROR` — an HTTP/3 stream error mid-transfer leaves the browser holding a partial PNG, which it renders progressively (a visible top-to-bottom decode glitch). This Worker fixes it:

1. **Browser ↔ Worker** is HTTP/2 over Cloudflare's edge — extremely stable, no QUIC fragility.
2. **Worker ↔ CDN** is a server-to-server fetch over Cloudflare's backbone — also reliable. `cacheEverything` warms the edge, so a repeated image URL is served from cache instead of re-touching the origin.
3. **CORS**: the Worker adds `Access-Control-Allow-Origin`, which lets the client fetch the bytes and hand its `<img>` a fully-local `blob:` URL (atomic paint). `im.runware.ai` sends no CORS header, so that path is impossible without a proxy.

## Deploy

One click: use the button above (Cloudflare clones this repo and deploys it to your account).

Or from a terminal:

```bash
npm i -g wrangler   # one-time
wrangler login      # one-time, OAuth in the browser
wrangler deploy     # prints https://infiplot-image-proxy.<you>.workers.dev
```

Then wire the printed URL into your InfiPlot deploy:

```
NEXT_PUBLIC_IMAGE_PROXY_URL=https://infiplot-image-proxy.<you>.workers.dev
```

(`NEXT_PUBLIC_*` vars are inlined at build time — set it in Vercel/Cloudflare project settings, then redeploy InfiPlot.)

## Configuration

All optional — defaults are fine for a Runware-backed InfiPlot. Set them as Worker vars (uncomment `[vars]` in `wrangler.toml`) or as secrets (`wrangler secret put <NAME>`):

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_HOSTS` | `im.runware.ai` | Comma-separated hostnames the proxy may fetch. Add your provider's image host if you don't use Runware. Anything else returns `403`. |
| `ALLOWED_ORIGINS` | _(empty = any)_ | Comma-separated browser Origins allowed to use the proxy — a quota-abuse guard against other sites hotlinking it. e.g. `https://infiplot.com,https://yourapp.vercel.app`. Requests with no `Origin` (curl, CDN revalidation) always pass. |

## How it's called

```
GET https://<your-worker>/?url=<url-encoded image URL>
```

The Worker validates the target host, fetches it server-side, and streams the bytes back with CORS + a 1-year immutable cache header. Only `GET` / `HEAD` / `OPTIONS` are accepted.

## License

[AGPL-3.0-only](./LICENSE) — same as InfiPlot.
