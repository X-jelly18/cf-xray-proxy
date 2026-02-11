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

function isDebugEnabled(env: Env): boolean {
  return env.DEBUG === 'true';
}

function validateRequest(request: Request): Response | null {
  void request;
  return null;
}

export async function handleUpgrade(request: Request, env: Env): Promise<Response> {
  const validationError = validateRequest(request);

  if (validationError) {
    return validationError;
  }

  const debugEnabled = isDebugEnabled(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, true);
  let backendUrl: URL;

  try {
    backendUrl = parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : 'Invalid backend configuration.');
  }

  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);

    if (debugEnabled) {
      console.log('[ws]', 'forwarding non-upgrade ws request', {
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
        console.error('[ws] backend passthrough error', error);
      }

      return textResponse(502, 'Unable to connect to backend service.');
    }
  }

  if (request.method.toUpperCase() !== 'GET') {
    return textResponse(400, 'ws upgrade requests must use GET.');
  }

  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();

  const backendHeaders = buildBackendUpgradeHeaders(request);

  if (debugEnabled) {
    console.log('[ws]', 'dialing backend', {
      backendUrl: backendUrl.toString(),
      subprotocol: backendHeaders.get('sec-websocket-protocol') ?? 'none',
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

    bridgeSockets(workerSocket, backendSocket, (direction, error) => {
      if (debugEnabled) {
        console.log('[ws]', 'relay error', { direction, error });
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
      console.error('[ws] backend connection error', error);
    }

    return textResponse(502, 'Unable to connect to backend service.');
  }
}
