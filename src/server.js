const cluster = require("cluster");
const os = require("os");

const NUM_WORKERS = parseInt(process.env.WORKERS || os.cpus().length, 10);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} spawning ${NUM_WORKERS} workers…`);

  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork();

  cluster.on("exit", (worker, code) => {
    console.log(`Worker ${worker.process.pid} exited (code ${code}), replacing…`);
    cluster.fork();
  });
} else {
  const express = require("express");
  const { pool, getRecordsByGroupId } = require("./db");

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get("/api/data/:uuid", async (req, res) => {
    try {
      const rows = await getRecordsByGroupId(req.params.uuid);
      if (rows.length === 0) {
        return res.status(404).json({ error: "No records found for this UUID" });
      }
      res.json({ group_id: req.params.uuid, count: rows.length, records: rows });
    } catch (err) {
      console.error("Query error:", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const server = app.listen(PORT, () => {
    console.log(`Worker ${process.pid} listening on :${PORT}`);
  });

  process.on("SIGTERM", async () => {
    server.close();
    await pool.end();
  });
}
