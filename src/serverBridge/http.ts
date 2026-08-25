import type { IncomingMessage, ServerResponse } from 'node:http';

export type ConnectNext = (error?: unknown) => void;
export type ConnectMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: ConnectNext,
) => void | Promise<void>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function assertLoopbackTarget(rawUrl: string, label: string): URL {
  const target = new URL(rawUrl.endsWith('/') ? rawUrl : `${rawUrl}/`);
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`${label} must be an http:// loopback URL.`);
  }
  return target;
}

export function isTrustedBrowserRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) return false;

  const hostName = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOOPBACK_HOSTS.has(hostName)) return false;

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return LOOPBACK_HOSTS.has(parsed.hostname) && parsed.host === host;
  } catch {
    return false;
  }
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 1_048_576,
): Promise<{ raw: Buffer; value: unknown }> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpInputError(415, 'Content-Type must be application/json.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new HttpInputError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  try {
    return { raw, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    throw new HttpInputError(400, 'Request body is not valid JSON.');
  }
}

export function readCookie(request: IncomingMessage, name: string): string | null {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

export class HttpInputError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpInputError';
    this.status = status;
  }
}
