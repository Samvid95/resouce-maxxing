const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASS || "app",
  database: process.env.DB_NAME || "appdb",
  max: 20,
});

async function getRecordsByGroupId(uuid) {
  const { rows } = await pool.query(
    "SELECT id, group_id, name, category, value, active, created_at FROM records WHERE group_id = $1",
    [uuid]
  );
  return rows;
}

module.exports = { pool, getRecordsByGroupId };
