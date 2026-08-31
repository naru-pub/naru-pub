// Local-only acceptance fixture. Does not modify or contact production.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = new Map([
  ["/", new URL("./sdk.html", import.meta.url)],
  [
    "/sdk/1.0.0/naru-data.js",
    new URL("../../public/sdk/1.0.0/naru-data.js", import.meta.url),
  ],
]);
createServer(async (req, res) => {
  const file = routes.get(req.url);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": req.url.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(file));
  } catch {
    res.destroy();
  }
}).listen(3111, "127.0.0.1", () =>
  console.log("SDK acceptance: http://127.0.0.1:3111/"),
);
