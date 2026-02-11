import type { TransportType } from './types';

export const BACKEND_ORIGIN = 'http://127.0.0.1:10000';
export const DEFAULT_TRANSPORT: TransportType = 'xhttp';
export const DEBUG = 'false';

export const SUPPORTED_TRANSPORTS = ['xhttp', 'httpupgrade', 'ws'] as const satisfies readonly TransportType[];
