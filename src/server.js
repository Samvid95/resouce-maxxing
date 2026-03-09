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

  const PORT = process.env.PORT || 3000;

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
      const rows = await getRecordsByGroupId(request.params.uuid);
      if (rows.length === 0) {
        reply.code(404);
        return { error: "No records found for this UUID" };
      }
      return { group_id: request.params.uuid, count: rows.length, records: rows };
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
