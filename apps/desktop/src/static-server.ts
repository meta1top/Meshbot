import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

const STATIC_PORT = 3101;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain",
};

function tryReadFile(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function killPortOccupier(port: number): void {
  try {
    const { execSync } = require("node:child_process");
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
      });
      const pid = output.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /PID ${pid} /F`);
    } else {
      const pid = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
      if (pid) execSync(`kill -9 ${pid}`);
    }
  } catch {
    // Port not occupied or kill failed — ignore
  }
}

export function startStaticServer(
  rootDir: string,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent(
        new URL(req.url || "/", "http://localhost").pathname,
      );
      let filePath = path.join(rootDir, urlPath);

      let data = tryReadFile(filePath);

      // Client-side routing fallback: file not found or is a directory -> index.html
      if (!data) {
        filePath = path.join(rootDir, "index.html");
        data = tryReadFile(filePath);
      }

      if (!data) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });

    server.listen(STATIC_PORT, "127.0.0.1", () => {
      resolve({ server, port: STATIC_PORT });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        killPortOccupier(STATIC_PORT);
        server.listen(STATIC_PORT, "127.0.0.1", () => {
          resolve({ server, port: STATIC_PORT });
        });
      } else {
        reject(err);
      }
    });
  });
}
