import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function jsonResponse(response: ServerResponse, status: number, body?: unknown): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (body === undefined) { response.writeHead(status).end(); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 16_384) throw new HttpError(413, "request_too_large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "invalid_request"); }
}

export function requestSource(request: IncomingMessage, trustProxy = false): string {
  const forwarded = request.headers["x-real-ip"];
  return trustProxy && typeof forwarded === "string" ? forwarded : request.socket.remoteAddress ?? "unknown";
}
