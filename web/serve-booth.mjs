// Booth static server: serves dist/ on localhost with the headers MediaPipe
// WASM needs. Zero dependencies (node built-ins only) so it works offline.
//
// Why not `npx serve` / `vite preview`?
// - `serve` sends no COOP/COEP headers -> crossOriginIsolated=false -> worker FAILS.
// - `vite preview` sends COOP/COEP on 200s but NOT on 304 revalidations, so a
//   browser holding a stale cached document keeps running without isolation
//   (Network tab full of 304s, game stuck at boot).
// This server always answers 200 (no ETag/conditional logic -> no 304 ever),
// always sets COOP/COEP, serves correct MIME types, and disables caching.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  // Required for MediaPipe WASM worker. Set on EVERY response (incl. 404s).
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  // Booth is localhost: determinism beats caching. No stale docs, no 304s.
  res.setHeader("Cache-Control", "no-store");

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  // Block path traversal: resolved path must stay inside dist/.
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[booth] serving dist/ at http://localhost:${PORT}  (Ctrl+C to stop)`);
});
