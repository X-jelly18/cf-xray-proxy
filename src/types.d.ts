export type TransportType = 'xhttp' | 'httpupgrade' | 'ws';

export interface Env {
  BACKEND_URL?: string;
  TRANSPORT?: TransportType;
  DEBUG?: string;
}

export type WebSocketPairTuple = [WebSocket, WebSocket];
