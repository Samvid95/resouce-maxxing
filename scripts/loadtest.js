const autocannon = require("autocannon");
const os = require("os");
const fs = require("fs");
const path = require("path");

const UUIDS = [
  "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
  "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80",
  "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091",
  "f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8091a2",
  "17b8c9d0-e1f2-4a3b-4c5d-6e7f8091a2b3",
  "28c9d0e1-f2a3-4b4c-5d6e-7f8091a2b3c4",
  "39d0e1f2-a3b4-4c5d-6e7f-8091a2b3c4d5",
  "40e1f2a3-b4c5-4d6e-7f80-91a2b3c4d5e6",
];

const TARGET = process.env.TARGET || "http://localhost:3000";
const DURATION = parseInt(process.env.DURATION || "10", 10);
const CONNECTIONS = parseInt(process.env.CONNECTIONS || "10", 10);

function sampleCpu() {
  const cpus = os.cpus();
  return cpus.map((cpu, i) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return { core: i, usagePct: +(((total - idle) / total) * 100).toFixed(1) };
  });
}

async function run() {
  console.log(
    `Load test: ${CONNECTIONS} connections for ${DURATION}s against ${TARGET}`
  );

  const cpuSnapshots = [];
  const cpuInterval = setInterval(() => {
    cpuSnapshots.push({ ts: Date.now(), cores: sampleCpu() });
  }, 1000);

  let reqIndex = 0;
  const result = await autocannon({
    url: TARGET,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        setupRequest(req) {
          const uuid = UUIDS[reqIndex++ % UUIDS.length];
          return { ...req, path: `/api/data/${uuid}` };
        },
      },
    ],
  });

  clearInterval(cpuInterval);

  const avgCpuPerSnapshot = cpuSnapshots.map((snap) => {
    const avg =
      snap.cores.reduce((sum, c) => sum + c.usagePct, 0) / snap.cores.length;
    return { ts: snap.ts, avgCpuPct: +avg.toFixed(1) };
  });

  const summary = {
    timestamp: new Date().toISOString(),
    config: {
      target: TARGET,
      duration: DURATION,
      connections: CONNECTIONS,
    },
    latency: {
      avg: result.latency.average,
      p50: result.latency.p50,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    throughput: {
      avgBytesPerSec: result.throughput.average,
      totalBytes: result.throughput.total,
    },
    requests: {
      avgPerSec: result.requests.average,
      total: result.requests.total,
    },
    errors: result.errors,
    timeouts: result.timeouts,
    statusCodes: result["2xx"]
      ? { "2xx": result["2xx"], "4xx": result["4xx"], "5xx": result["5xx"] }
      : {},
    cpu: avgCpuPerSnapshot,
  };

  const resultsDir = path.join(__dirname, "..", "results");
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const filename = `loadtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));

  console.log("\n--- Results Summary ---");
  console.log(`Requests/sec (avg): ${summary.requests.avgPerSec}`);
  console.log(`Latency avg: ${summary.latency.avg}ms | p99: ${summary.latency.p99}ms`);
  console.log(`Total requests: ${summary.requests.total}`);
  console.log(`Errors: ${summary.errors} | Timeouts: ${summary.timeouts}`);
  console.log(`\nCPU snapshots: ${avgCpuPerSnapshot.length}`);
  if (avgCpuPerSnapshot.length > 0) {
    const peakCpu = Math.max(...avgCpuPerSnapshot.map((s) => s.avgCpuPct));
    console.log(`Peak avg CPU: ${peakCpu}%`);
  }
  console.log(`\nFull results saved to: ${filepath}`);
}

run().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
