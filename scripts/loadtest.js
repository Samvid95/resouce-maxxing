const autocannon = require("autocannon");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

const NUM_SELLERS = 5000;
const UUIDS = Array.from({ length: NUM_SELLERS }, (_, i) => {
  const hex = crypto.createHash("md5").update("seller-" + i).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const TARGET = process.env.TARGET || "http://localhost:3000";
const DURATION = parseInt(process.env.DURATION || "10", 10);
const CONNECTIONS = parseInt(process.env.CONNECTIONS || "100", 10);
const WORKERS = parseInt(process.env.WORKERS || String(os.cpus().length), 10);

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
    `Load test: ${CONNECTIONS} connections, ${WORKERS} workers for ${DURATION}s against ${TARGET}`
  );

  const cpuSnapshots = [];
  const cpuInterval = setInterval(() => {
    cpuSnapshots.push({ ts: Date.now(), cores: sampleCpu() });
  }, 1000);

  const requests = UUIDS.map((uuid) => ({ path: `/api/data/${uuid}`, method: "GET" }));

  const result = await autocannon({
    url: TARGET,
    connections: CONNECTIONS,
    duration: DURATION,
    workers: WORKERS,
    requests,
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
      workers: WORKERS,
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
