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
  console.log(`Server listening on http://localhost:${PORT}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
});
