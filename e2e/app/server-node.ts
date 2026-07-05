// Node entry for the e2e app (Node 24+: native type stripping + node:sqlite).
// The only Node-specific piece is this small node:http ↔ Request/Response
// adapter — the app and the package are identical across runtimes.

import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { handler } from "./app.ts";

function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) as unknown as BodyInit : undefined,
    // Required by Node's fetch when the body is a stream.
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
}

const server = createServer(async (req, res) => {
  try {
    const response = await handler(toRequest(req));
    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    if (response.body) {
      // deno-lint-ignore no-explicit-any
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("internal error");
  }
});

server.listen(8000, "0.0.0.0", () => {
  console.log("node e2e app listening on :8000");
});
