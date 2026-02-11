import { BACKEND_ORIGIN } from '../config';
import type { Env } from '../types';

export type WebSocketPayload = ArrayBuffer | ArrayBufferView | Blob | string;
type RelayDirection = 'client->backend' | 'backend->client';

export function hasUpgradeRequest(request: Request, strictWebSocketUpgrade: boolean): boolean {
  const connectionHasUpgrade = request.headers.get('Connection')?.toLowerCase().includes('upgrade') ?? false;
  const upgrade = request.headers.get('Upgrade');

  if (!connectionHasUpgrade || !upgrade) {
    return false;
  }

  if (!strictWebSocketUpgrade) {
    return true;
  }

  return upgrade.toLowerCase() === 'websocket';
}

export function parseBackendUrl(request: Request, env: Env, inbound: URL = new URL(request.url)): URL {
  const rawBackendUrl = (env.BACKEND_URL ?? BACKEND_ORIGIN).trim();
  let backendUrl: URL;

  try {
    backendUrl = new URL(rawBackendUrl);
  } catch {
    throw new Error('BACKEND_URL is not a valid URL.');
  }

  // Preserve the user-requested path exactly (no Worker-side path injection).
  backendUrl.pathname = inbound.pathname;
  backendUrl.search = inbound.search;
  return backendUrl;
}

export function buildBackendPassthroughHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Host');
  return headers;
}

export function buildBackendUpgradeHeaders(request: Request, upgradeValue = 'websocket'): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.set('Connection', 'Upgrade');
  headers.set('Upgrade', upgradeValue);
  headers.delete('Sec-WebSocket-Extensions');
  return headers;
}

export function toPassthroughInit(request: Request, headers: Headers): RequestInit {
  const method = request.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    return {
      method,
      headers,
      redirect: 'manual',
    };
  }

  return {
    method,
    headers,
    body: request.body,
    redirect: 'manual',
  };
}

export function sanitizeCloseCode(code: number): number {
  if (Number.isInteger(code) && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006) {
    return code;
  }

  return 1011;
}

export function safeClose(socket: WebSocket, code: number, reason: string): void {
  const normalizedCode = sanitizeCloseCode(code);
  const normalizedReason = reason.slice(0, 123);

  try {
    socket.close(normalizedCode, normalizedReason);
  } catch {
    try {
      socket.close();
    } catch {
      // Ignore close errors; socket may already be closed.
    }
  }
}

export function bridgeSockets(
  clientSocket: WebSocket,
  backendSocket: WebSocket,
  onRelayError: (direction: RelayDirection, error: unknown) => void,
): void {
  let closed = false;

  const closeBoth = (code: number, reason: string): void => {
    if (closed) {
      return;
    }

    closed = true;
    safeClose(clientSocket, code, reason);
    safeClose(backendSocket, code, reason);
  };

  const onForwardFailure = (direction: RelayDirection, error: unknown): void => {
    onRelayError(direction, error);
    closeBoth(1011, 'Relay failure');
  };

  const forward = (destination: WebSocket, payload: WebSocketPayload, direction: RelayDirection): void => {
    if (payload instanceof Blob) {
      void payload
        .arrayBuffer()
        .then((arrayBuffer) => {
          if (closed) {
            return;
          }

          try {
            destination.send(arrayBuffer);
          } catch (error) {
            onForwardFailure(direction, error);
          }
        })
        .catch((error: unknown) => {
          onForwardFailure(direction, error);
        });
      return;
    }

    try {
      destination.send(payload);
    } catch (error) {
      onForwardFailure(direction, error);
    }
  };

  clientSocket.addEventListener('message', (event) => {
    forward(backendSocket, event.data as WebSocketPayload, 'client->backend');
  });

  backendSocket.addEventListener('message', (event) => {
    forward(clientSocket, event.data as WebSocketPayload, 'backend->client');
  });

  clientSocket.addEventListener('close', (event) => {
    closeBoth(event.code, event.reason || 'Client closed connection');
  });

  backendSocket.addEventListener('close', (event) => {
    closeBoth(event.code, event.reason || 'Backend closed connection');
  });

  clientSocket.addEventListener('error', () => {
    closeBoth(1011, 'Client socket error');
  });

  backendSocket.addEventListener('error', () => {
    closeBoth(1011, 'Backend socket error');
  });
}
