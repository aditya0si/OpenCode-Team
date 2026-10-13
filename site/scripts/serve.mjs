// Test-only static file server for the built landing page.
//
// serveSite serves exactly the files under rootDir (the build output).
// It supports a mount basePath (for the GitHub Pages project path), returns
// correct content types, rejects decoded path traversal, and never provides an
// SPA fallback: unknown paths are 404. It binds loopback only.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function normaliseBase(basePath) {
  let base = basePath || "/";
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return base;
}

function contentType(filePath) {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function serveSite({ rootDir, basePath = "/", port, host = "127.0.0.1" }) {
  if (!rootDir) throw new Error("serveSite: rootDir is required");
  if (!Number.isInteger(port) || port <= 0) throw new Error("serveSite: a valid port is required");

  const resolvedRoot = resolve(rootDir);
  const base = normaliseBase(basePath);

  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, "Method Not Allowed", { allow: "GET, HEAD" });
      return;
    }

    let pathname;
    let search = "";
    try {
      const parsed = new URL(req.url, `http://${host}:${port}`);
      pathname = decodeURIComponent(parsed.pathname);
      search = parsed.search;
    } catch {
      send(400, "Bad Request");
      return;
    }
    if (pathname.includes("\0")) {
      send(400, "Bad Request");
      return;
    }

    let rel;
    if (base === "/") {
      rel = pathname.replace(/^\/+/, "");
    } else if (pathname === base.slice(0, -1)) {
      // The exact bare project path (no trailing slash). Redirect to the
      // directory form so relative assets resolve, preserving the query string.
      const location = `${base}${search}`;
      res.writeHead(301, {
        location,
        "content-type": "text/plain; charset=utf-8",
      });
      if (req.method === "HEAD") res.end();
      else res.end(`Redirecting to ${location}\n`);
      return;
    } else if (pathname.startsWith(base)) {
      rel = pathname.slice(base.length);
    } else {
      send(404, "Not Found");
      return;
    }

    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    const segments = rel.split(/[\\/]+/);
    if (segments.some((s) => s === "..")) {
      send(404, "Not Found");
      return;
    }

    const candidate = resolve(resolvedRoot, rel);
    if (!isInside(resolvedRoot, candidate) || candidate === resolvedRoot) {
      send(404, "Not Found");
      return;
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        send(404, "Not Found");
        return;
      }
      const body = await readFile(candidate);
      res.writeHead(200, { "content-type": contentType(candidate), "content-length": body.length });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch {
      send(404, "Not Found");
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}${base}`;
      resolvePromise({
        url,
        port,
        basePath: base,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

export function defaultRootDir() {
  return fileURLToPath(new URL("../dist", import.meta.url));
}

async function main() {
  const port = Number.parseInt(process.env.SERVE_PORT ?? "4174", 10);
  const basePath = process.env.SERVE_BASE ?? "/";
  const handle = await serveSite({ rootDir: defaultRootDir(), basePath, port });
  console.log(`Serving ${defaultRootDir()} at ${handle.url}`);
  const shutdown = () => handle.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`serve failed: ${err.message}`);
    process.exit(1);
  });
}
