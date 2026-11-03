/**
 * 临时静态服务器（只为在内置浏览器里预览本地 HTML）
 *
 * 用法：node scripts/serve-design.js [--port 8731] [--dir <目录>]
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = parseInt(arg("--port", "8731"), 10);
const root = path.resolve(arg("--dir", path.join(__dirname, "..", "design")));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

http
  .createServer(function (req, res) {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(root, url === "/" ? "index.html" : url);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("not found: " + url);
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(port, "127.0.0.1", function () {
    console.log("静态服务已启动: http://127.0.0.1:" + port + "/  (根目录 " + root + ")");
  });
