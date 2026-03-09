const cluster = require("cluster");
const os = require("os");

const NUM_WORKERS = parseInt(process.env.WORKERS || "8", 10);

if (cluster.isPrimary) {
  console.log(`[uWS] Primary ${process.pid} spawning ${NUM_WORKERS} workers…`);

  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork();

  cluster.on("exit", (worker, code) => {
    console.log(`Worker ${worker.process.pid} exited (code ${code}), replacing…`);
    cluster.fork();
  });
} else {
  const uWS = require("uWebSockets.js");
  const { pool, getRecordsByGroupId } = require("./db");
  const { LRUCache } = require("./cache");

  const PORT = parseInt(process.env.PORT || "3000", 10);
  const cache = new LRUCache();

  const NOT_FOUND_BUF = Buffer.from(JSON.stringify({ error: "No records found for this UUID" }));
  const HEALTH_BUF = Buffer.from(JSON.stringify({ status: "ok" }));
  const JSON_CT = "application/json; charset=utf-8";

  uWS
    .App()
    .get("/api/data/:uuid", async (res, req) => {
      const uuid = req.getParameter(0);
      res.onAborted(() => { res.aborted = true; });

      const cached = cache.get(uuid);
      if (cached) {
        if (!res.aborted) {
          res.cork(() => {
            res.writeHeader("content-type", JSON_CT);
            res.end(cached);
          });
        }
        return;
      }

      try {
        const rows = await getRecordsByGroupId(uuid);
        if (res.aborted) return;

        if (rows.length === 0) {
          res.cork(() => {
            res.writeStatus("404 Not Found");
            res.writeHeader("content-type", JSON_CT);
            res.end(NOT_FOUND_BUF);
          });
          return;
        }

        const body = { group_id: uuid, count: rows.length, records: rows };
        const buf = Buffer.from(JSON.stringify(body));
        cache.set(uuid, buf);

        res.cork(() => {
          res.writeHeader("content-type", JSON_CT);
          res.end(buf);
        });
      } catch (err) {
        if (!res.aborted) {
          res.cork(() => {
            res.writeStatus("500 Internal Server Error");
            res.writeHeader("content-type", JSON_CT);
            res.end(Buffer.from(JSON.stringify({ error: "Internal server error" })));
          });
        }
      }
    })
    .get("/health", (res) => {
      res.writeHeader("content-type", JSON_CT);
      res.end(HEALTH_BUF);
    })
    .listen(PORT, (listenSocket) => {
      if (listenSocket) {
        console.log(`[uWS] Worker ${process.pid} listening on :${PORT}`);
      } else {
        console.error(`[uWS] Worker ${process.pid} failed to listen on :${PORT}`);
        process.exit(1);
      }
    });

  process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
  });
}
