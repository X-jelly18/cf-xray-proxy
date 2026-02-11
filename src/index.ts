import { DEFAULT_TRANSPORT, SUPPORTED_TRANSPORTS } from './config';
import { renderLandingPage } from './landing';
import { handleUpgrade as handleHttpUpgrade } from './transports/httpupgrade';
import { handleUpgrade as handleWsUpgrade } from './transports/ws';
import { handleUpgrade as handleXhttpUpgrade } from './transports/xhttp';
import type { Env, TransportType } from './types';

type UpgradeHandler = (request: Request, env: Env) => Promise<Response>;

const HANDLERS: Record<TransportType, UpgradeHandler> = {
  xhttp: handleXhttpUpgrade,
  httpupgrade: handleHttpUpgrade,
  ws: handleWsUpgrade,
};

function isDebugEnabled(env: Env): boolean {
  return env.DEBUG === 'true';
}

function isTransportType(value: string): value is TransportType {
  return (SUPPORTED_TRANSPORTS as readonly string[]).includes(value);
}

function getDefaultTransport(env: Env): TransportType {
  const configured = (env.TRANSPORT ?? '').toLowerCase();

  if (isTransportType(configured)) {
    return configured;
  }

  return DEFAULT_TRANSPORT;
}

function resolveTransport(request: Request, requestUrl: URL, env: Env, pathTransport: TransportType | null): TransportType {
  const fromQuery = (requestUrl.searchParams.get('transport') ?? '').toLowerCase();
  const fromHeader = (request.headers.get('x-transport-type') ?? '').toLowerCase();

  if (isTransportType(fromQuery)) {
    return fromQuery;
  }

  if (isTransportType(fromHeader)) {
    return fromHeader;
  }

  if (pathTransport) {
    return pathTransport;
  }

  return getDefaultTransport(env);
}

function rewritePath(request: Request, path: string): Request {
  const rewritten = new URL(request.url);
  rewritten.pathname = path;

  return buildForwardRequest(request, rewritten.toString(), request.headers);
}

function parsePathTransport(pathname: string): { transport: TransportType | null; forwardedPath: string } {
  for (const transport of SUPPORTED_TRANSPORTS) {
    const prefix = `/${transport}`;

    if (pathname === prefix) {
      return { transport, forwardedPath: '/' };
    }

    if (pathname.startsWith(`${prefix}/`)) {
      return { transport, forwardedPath: pathname.slice(prefix.length) };
    }
  }

  return { transport: null, forwardedPath: pathname };
}

function toForwardedRequest(
  request: Request,
  finalTransport: TransportType,
  pathTransport: TransportType | null,
  forwardedPath: string,
  originalPath: string,
): Request {
  // Only strip /{transport} prefix when that prefix is actually selected as transport.
  if (pathTransport && pathTransport === finalTransport && forwardedPath !== originalPath) {
    return rewritePath(request, forwardedPath);
  }

  return request;
}

function stripRoutingSelectors(request: Request): Request {
  const hasTransportHeader = request.headers.has('x-transport-type');
  const maybeTransportQuery = request.url.includes('transport=');

  if (!hasTransportHeader && !maybeTransportQuery) {
    return request;
  }

  let url = request.url;
  let headers: HeadersInit = request.headers;
  let changed = false;

  if (maybeTransportQuery) {
    const parsed = new URL(request.url);

    if (parsed.searchParams.has('transport')) {
      // transport is a Worker-side selector and should not be passed to backend.
      parsed.searchParams.delete('transport');
      changed = true;
    }

    url = parsed.toString();
  }

  if (hasTransportHeader) {
    headers = new Headers(request.headers);
    headers.delete('x-transport-type');
    changed = true;
  }

  if (!changed) {
    return request;
  }

  return buildForwardRequest(request, url, headers);
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function isUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get('upgrade');
  const connection = request.headers.get('connection')?.toLowerCase() ?? '';
  return Boolean(upgrade) || connection.includes('upgrade');
}

function isLandingPageRequest(request: Request, pathname: string): boolean {
  if (request.method.toUpperCase() !== 'GET') {
    return false;
  }

  if (pathname !== '/' && pathname !== '/index.html') {
    return false;
  }

  if (isUpgradeRequest(request)) {
    return false;
  }

  const accept = request.headers.get('accept') ?? '';
  const isDocument = (request.headers.get('sec-fetch-dest') ?? '').toLowerCase() === 'document';
  return isDocument || accept.includes('text/html');
}

function buildForwardRequest(request: Request, url: string, headers: HeadersInit): Request {
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    redirect: 'manual',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
  }

  return new Request(url, init);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const debugEnabled = isDebugEnabled(env);
    const requestUrl = new URL(request.url);

    if (isLandingPageRequest(request, requestUrl.pathname)) {
      return renderLandingPage();
    }

    const { transport: pathTransport, forwardedPath } = parsePathTransport(requestUrl.pathname);
    const transport = resolveTransport(request, requestUrl, env, pathTransport);
    const transportRoutedRequest = toForwardedRequest(
      request,
      transport,
      pathTransport,
      forwardedPath,
      requestUrl.pathname,
    );
    const forwardedRequest = stripRoutingSelectors(transportRoutedRequest);
    const handler = HANDLERS[transport];

    if (debugEnabled) {
      const forwardedPathForLog =
        pathTransport && pathTransport === transport && forwardedPath !== requestUrl.pathname
          ? forwardedPath
          : requestUrl.pathname;

      console.log('[cf-xray-proxy]', 'routing request', {
        originalPath: requestUrl.pathname,
        forwardedPath: forwardedPathForLog,
        transport,
      });
    }

    try {
      return await handler(forwardedRequest, env);
    } catch (error) {
      if (debugEnabled) {
        console.error('[cf-xray-proxy] unhandled transport error', error);
      }

      return textResponse(502, 'Backend connection failed.');
    }
  },
};
