const { Pool } = require("pg");
const os = require("os");

const numWorkers = parseInt(process.env.WORKERS || os.cpus().length, 10);
const totalPoolTarget = 80;
const perWorkerPool = Math.max(4, Math.floor(totalPoolTarget / numWorkers));

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASS || "app",
  database: process.env.DB_NAME || "appdb",
  max: perWorkerPool,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const GET_RECORDS_QUERY = {
  name: "get_records_by_group_id",
  text: "SELECT id, group_id, name, category, value, active, created_at FROM records WHERE group_id = $1",
};

async function getRecordsByGroupId(uuid) {
  const { rows } = await pool.query({ ...GET_RECORDS_QUERY, values: [uuid] });
  return rows;
}

module.exports = { pool, getRecordsByGroupId };
