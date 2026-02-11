import type { Env } from '../types';
import {
  BACKEND_PASSTHROUGH_TIMEOUT_MS,
  BACKEND_UPGRADE_TIMEOUT_MS,
  fetchWithTimeout,
  isAbortError,
} from '../utils/fetch';
import { textResponse } from '../utils/response';
import {
  bridgeSockets,
  buildBackendPassthroughHeaders,
  buildBackendUpgradeHeaders,
  hasUpgradeRequest,
  parseBackendUrl,
  safeClose,
  toPassthroughInit,
} from '../utils/socket';

type XhttpMode = 'auto' | 'packet-up';

const EARLY_DATA_HEADER = 'sec-websocket-protocol';
const MAX_EARLY_DATA_BYTES = 64 * 1024;
const ALLOWED_MODES: readonly XhttpMode[] = ['auto', 'packet-up'];

function isDebugEnabled(env: Env): boolean {
  return env.DEBUG === 'true';
}

function validateRequest(request: Request): Response | null {
  void request;
  return null;
}

function parseEarlyDataHint(url: URL): number {
  const raw = url.searchParams.get('ed');

  if (raw === null) {
    return 0;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid early-data hint. The ed query parameter must be a non-negative integer.');
  }

  return Math.min(parsed, MAX_EARLY_DATA_BYTES);
}

function parseMode(url: URL, request: Request): XhttpMode {
  const fromQuery = url.searchParams.get('mode')?.toLowerCase();
  const fromHeader = request.headers.get('x-xhttp-mode')?.toLowerCase();
  const mode = fromQuery ?? fromHeader ?? 'auto';

  if ((ALLOWED_MODES as readonly string[]).includes(mode)) {
    return mode as XhttpMode;
  }

  throw new Error('Invalid xhttp mode. Supported values are auto and packet-up.');
}

function isLikelyBase64UrlToken(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array {
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingNeeded);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }

  return output;
}

function parseEarlyDataFromHeader(request: Request, maxBytes: number): Uint8Array | null {
  if (maxBytes <= 0) {
    return null;
  }

  const rawHeader = request.headers.get(EARLY_DATA_HEADER);

  if (!rawHeader) {
    return null;
  }

  const token = rawHeader.split(',')[0]?.trim();

  if (!token || !isLikelyBase64UrlToken(token)) {
    return null;
  }

  try {
    const decoded = decodeBase64UrlToUint8Array(token);

    if (decoded.byteLength > maxBytes) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

export async function handleUpgrade(request: Request, env: Env): Promise<Response> {
  const validationError = validateRequest(request);

  if (validationError) {
    return validationError;
  }

  const debugEnabled = isDebugEnabled(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, true);

  let earlyDataHint: number;
  let mode: XhttpMode;

  if (hasUpgrade) {
    try {
      earlyDataHint = parseEarlyDataHint(requestUrl);
      mode = parseMode(requestUrl, request);
    } catch (error) {
      return textResponse(400, error instanceof Error ? error.message : 'Invalid xhttp options.');
    }
  } else {
    earlyDataHint = 0;
    mode = 'auto';
  }

  let backendUrl: URL;

  try {
    backendUrl = parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : 'Invalid backend configuration.');
  }

  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);

    if (debugEnabled) {
      console.log('[xhttp]', 'forwarding non-upgrade xhttp request', {
        backendUrl: backendUrl.toString(),
        method: request.method,
      });
    }

    try {
      return await fetchWithTimeout(
        backendUrl.toString(),
        toPassthroughInit(request, passthroughHeaders),
        BACKEND_PASSTHROUGH_TIMEOUT_MS,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return textResponse(502, 'Backend request timed out.');
      }

      if (debugEnabled) {
        console.error('[xhttp] backend passthrough error', error);
      }

      return textResponse(502, 'Unable to connect to backend service.');
    }
  }

  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();

  const backendHeaders = buildBackendUpgradeHeaders(request);

  // xhttp early-data may be encoded in Sec-WebSocket-Protocol on some clients.
  const earlyDataChunk = parseEarlyDataFromHeader(request, earlyDataHint);
  if (earlyDataChunk) {
    // Prevent duplicated delivery when early-data is extracted and sent as first WS frame.
    backendHeaders.delete(EARLY_DATA_HEADER);
  }

  if (debugEnabled) {
    console.log('[xhttp]', 'dialing backend', {
      backendUrl: backendUrl.toString(),
      mode,
      earlyDataHint,
      earlyDataBytes: earlyDataChunk?.byteLength ?? 0,
    });
  }

  try {
    const backendResponse = await fetchWithTimeout(
      backendUrl.toString(),
      {
        method: 'GET',
        headers: backendHeaders,
        redirect: 'manual',
      },
      BACKEND_UPGRADE_TIMEOUT_MS,
    );

    if (backendResponse.status !== 101 || !backendResponse.webSocket) {
      await backendResponse.body?.cancel();
      safeClose(workerSocket, 1011, `Backend upgrade rejected (${backendResponse.status})`);
      return textResponse(502, `Backend failed to upgrade connection (status ${backendResponse.status}).`);
    }

    const backendSocket = backendResponse.webSocket;
    backendSocket.accept();

    if (earlyDataChunk && earlyDataChunk.byteLength > 0) {
      backendSocket.send(earlyDataChunk);
    }

    bridgeSockets(workerSocket, backendSocket, (direction, error) => {
      if (debugEnabled) {
        console.log('[xhttp]', 'relay error', { direction, error });
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  } catch (error) {
    safeClose(workerSocket, 1011, 'Unable to connect to backend');

    if (isAbortError(error)) {
      return textResponse(502, 'Backend upgrade timed out.');
    }

    if (debugEnabled) {
      console.error('[xhttp] backend connection error', error);
    }

    return textResponse(502, 'Unable to connect to backend service.');
  }
}
