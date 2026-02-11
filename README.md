<p align="center">
  <img src="https://cdn.simpleicons.org/cloudflare/F38020?viewbox=auto&size=68" alt="Cloudflare logo" height="68" />
  <span>&nbsp;+&nbsp;</span>
  <img src="https://camo.githubusercontent.com/ede9710f2920f243f0e56cb036684fff6fef9c0a174ea5bb92109e5ef72c3812/68747470733a2f2f726177322e736561646e2e696f2f657468657265756d2f3078356565333632383636303031363133303933333631656238353639643539633431343162373664312f3766613963653930306662333962343432323633343864623333306533322f38623766613963653930306662333962343432323633343864623333306533322e737667" alt="Xray logo" height="68" />
</p>

<p align="center">
  <a href="https://workers.cloudflare.com/">
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript Strict" />
  </a>
  <a href="/.github/workflows/deploy.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/YrustPd/cf-xray-proxy/deploy.yml?branch=main&label=deploy" alt="Deploy" />
  </a>
  <a href="/LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License" />
  </a>
</p>

# cf-xray-proxy

Cloudflare Worker reverse-proxy frontend for VLESS/VMess traffic, forwarding `ws`, `xhttp`, and `httpupgrade` requests to an Xray or sing-box backend.

## What this project is

This repository provides a Worker entrypoint (`src/index.ts`) plus transport handlers (`src/transports/*`) that:

- accept inbound HTTP/Upgrade requests at Cloudflare edge,
- select a transport handler (`ws`, `xhttp`, or `httpupgrade`),
- forward path/query to backend as-is,
- bridge upgraded sockets between client and backend.

The backend remains the protocol/authentication authority.

## Why you would use it

- Put Cloudflare edge in front of an existing Xray/sing-box backend.
- Terminate TLS at the edge while keeping origin/backend on plain HTTP.
- Select transports per request via query/header/path without redeploying.
- Keep Worker logic thin and backend-focused for VLESS/VMess validation and policy.

## Architecture

```text
Client (VLESS / VMess)
        |
        | HTTPS / TLS
        v
Cloudflare Worker (this repo)
  - transport selection
  - upgrade handling
  - request forwarding
        |
        | HTTP or HTTPS (BACKEND_URL)
        v
Backend (Xray / sing-box)
  - authentication
  - protocol validation
  - routing / outbound
```

> TLS terminates at Cloudflare Worker edge. `BACKEND_URL` can be `http://...` or `https://...`.

## Supported transports

| Transport | Handler file | Upgrade detection | Notes |
| --- | --- | --- | --- |
| `ws` | `src/transports/ws.ts` | `Connection: upgrade` + `Upgrade: websocket` | WebSocket upgrade + passthrough fallback |
| `xhttp` | `src/transports/xhttp.ts` | `Connection: upgrade` + `Upgrade: websocket` | Supports `mode` (`auto`/`packet-up`) and `ed` hint |
| `httpupgrade` | `src/transports/httpupgrade.ts` | `Connection: upgrade` + any `Upgrade` value | HTTP Upgrade semantics with shared WS bridging |

### Transport selection order

Selection logic is implemented in `src/index.ts`:

1. Query parameter `transport` (`xhttp`, `httpupgrade`, `ws`)
2. Header `x-transport-type`
3. Path prefix (`/xhttp/...`, `/httpupgrade/...`, `/ws/...`)
4. Environment/default transport (`TRANSPORT`, otherwise default `xhttp`)

## Routing behavior

- Path and query are forwarded exactly from inbound request to backend URL.
- Worker does not inject fixed paths.
- Worker strips transport prefix only when that same prefix selected routing:
  - `/ws/<path>` -> `/<path>`
  - `/xhttp/<path>` -> `/<path>`
  - `/httpupgrade/<path>` -> `/<path>`
- Worker-only routing selectors are removed before backend forward:
  - query `transport`
  - header `x-transport-type`
- Worker does not validate UUID, port, or path.

> Authentication, UUID checks, and policy enforcement belong on backend Xray/sing-box.

## Configuration

### Runtime variables and defaults

| Name | Required | Default | Description | Examples |
| --- | --- | --- | --- | --- |
| `BACKEND_URL` | No | Falls back to `BACKEND_ORIGIN` | Backend origin URL used for all forwarding | `http://127.0.0.1:10000`, `https://backend.example.com:443` |
| `TRANSPORT` | No | `xhttp` | Default transport when no query/header/path selector matches | `xhttp`, `httpupgrade`, `ws` |
| `DEBUG` | No | effectively `false` unless exactly `true` | Enables debug logs in router and transport handlers | `true`, `false` |
| `BACKEND_ORIGIN` (code constant) | No (not an env var) | `http://127.0.0.1:10000` | Fallback backend origin defined in `src/config.ts` | `http://127.0.0.1:10000` |

### Set variables for local `wrangler dev`

Option A: one command invocation

```bash
BACKEND_URL="http://127.0.0.1:10000" TRANSPORT="xhttp" DEBUG="true" wrangler dev
```

Option B: keep defaults in `wrangler.toml` under `[vars]` and run:

```bash
wrangler dev
```

### Set variables for `wrangler deploy`

1. Edit `wrangler.toml`:

```toml
[vars]
TRANSPORT = "xhttp"
DEBUG = "false"
# BACKEND_URL = "http://your-backend:10000"
```

2. Deploy:

```bash
wrangler deploy
```

### Set variables in Cloudflare Dashboard

1. Open **Workers & Pages**.
2. Create/select this Worker.
3. Go to **Settings** -> **Variables and Secrets**.
4. Add variables:
   - `BACKEND_URL`
   - `TRANSPORT`
   - `DEBUG`
5. Save and deploy.

## Quickstart

### 1) Install dependencies

```bash
npm install
```

### 2) Run local Worker

```bash
BACKEND_URL="http://127.0.0.1:10000" TRANSPORT="xhttp" DEBUG="true" wrangler dev
```

### 3) Minimal checks

Replace placeholders:

- `<worker-domain>`: your Worker URL (for local dev typically `127.0.0.1:8787`)
- `<path>`: backend inbound path

HTTP passthrough:

```bash
curl -i "http://<worker-domain>/<path>?check=1"
```

`ws` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/ws/<path>"
```

`xhttp` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/xhttp/<path>?mode=auto&ed=0"
```

`httpupgrade` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/httpupgrade/<path>"
```

Expected handshake result: `HTTP/1.1 101 Switching Protocols` when backend accepts upgrade.

## Deployment guide

### Wrangler CLI deployment

1. Authenticate:

```bash
wrangler login
```

2. Confirm Worker settings in `wrangler.toml`:
   - `name`
   - `main`
   - `compatibility_date`
   - `[vars]` values (`TRANSPORT`, `DEBUG`, optional `BACKEND_URL`)

3. Deploy:

```bash
wrangler deploy
```

4. Verify:
   - open deployed Worker URL in browser for landing page (`/`),
   - run the quickstart `curl` checks against deployed domain.

### Cloudflare Dashboard deployment

1. Go to **Workers & Pages** and create/import Worker.
2. Ensure main script entry maps to this repository Worker.
3. In **Settings** -> **Variables and Secrets**, add runtime vars.
4. Deploy from dashboard.
5. Test:
   - `GET /` for landing page,
   - transport checks (`/ws/<path>`, `/xhttp/<path>`, `/httpupgrade/<path>`).

## Troubleshooting

### 502 backend unreachable

Check backend listener on origin host:

```bash
ss -ltnp | grep -E '(:10000|:443|:80)'
lsof -iTCP -sTCP:LISTEN -n -P
```

Check direct backend response:

```bash
curl -i --http1.1 "http://<backend-host>:<backend-port>/<path>"
```

If direct backend fails, fix backend binding/firewall/path first.

### Upgrade not returning 101

Test backend upgrade directly:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<backend-host>:<backend-port>/<path>"
```

If backend direct returns non-101, Worker will also fail upgrade.

### Host/SNI/path mismatch pitfalls

| Field | Where to set | Must align with |
| --- | --- | --- |
| Host | Client URI/headers | Worker domain and backend expectations |
| SNI | Client TLS config | Worker certificate domain |
| Path | Client `path` | Backend inbound path |
| Transport type | Client config | Worker route selection and backend inbound type |

Use matching transport on both client and backend (`ws`, `xhttp`, `httpupgrade`).

### Debug mode

Enable debug:

```bash
DEBUG="true" wrangler dev
```

Tail deployed logs:

```bash
wrangler tail
```

Look for handler prefixes:

- `[cf-xray-proxy]` (router)
- `[ws]`
- `[xhttp]`
- `[httpupgrade]`

## Security considerations

- This Worker forwards traffic and manages upgrades; it does not enforce UUID/port/path validation.
- Backend Xray/sing-box must enforce authentication, protocol checks, and routing policy.
- Keep backend ingress restricted to expected sources.
- Use `DEBUG=false` for normal production operation.

## Landing page

`GET /` and `GET /index.html` document requests are served by `src/landing.ts` with cache header:

```text
Cache-Control: public, max-age=3600
```

## License

[MIT](/LICENSE)
