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
  const fastify = require("fastify")({ logger: false });
  const { pool, getRecordsByGroupId } = require("./db");
  const { LRUCache } = require("./cache");

  const PORT = process.env.PORT || 3000;
  const cache = new LRUCache();

  const recordSchema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      group_id: { type: "string" },
      name: { type: "string" },
      category: { type: "string" },
      value: { type: "string" },
      active: { type: "boolean" },
      created_at: { type: "string" },
    },
  };

  fastify.get("/api/data/:uuid", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            group_id: { type: "string" },
            count: { type: "integer" },
            records: { type: "array", items: recordSchema },
          },
        },
        404: {
          type: "object",
          properties: { error: { type: "string" } },
        },
      },
    },
    handler: async (request, reply) => {
      const uuid = request.params.uuid;

      const cached = cache.get(uuid);
      if (cached) {
        reply.header("content-type", "application/json; charset=utf-8");
        reply.header("x-cache", "HIT");
        return reply.send(cached);
      }

      const rows = await getRecordsByGroupId(uuid);
      if (rows.length === 0) {
        reply.code(404);
        return { error: "No records found for this UUID" };
      }

      const body = { group_id: uuid, count: rows.length, records: rows };
      const serialized = JSON.stringify(body);
      cache.set(uuid, serialized);

      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("x-cache", "MISS");
      return reply.send(serialized);
    },
  });

  fastify.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: { status: { type: "string" } },
        },
      },
    },
    handler: async () => ({ status: "ok" }),
  });

  fastify.listen({ port: PORT, host: "::" }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Worker ${process.pid} listening on :${PORT}`);
  });

  process.on("SIGTERM", async () => {
    await fastify.close();
    await pool.end();
  });
}
