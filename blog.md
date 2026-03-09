# Resource Maxxing: The Road to 100,000 Requests Per Second

A hands-on journey of pushing a simple Node.js + PostgreSQL stack to its absolute limits, one bottleneck at a time.

---

## Why 100K Requests Per Second?

Before we start optimizing anything, let's talk about why this number matters and what it actually *means*.

### Putting 100K req/s Into Perspective

100,000 requests per second sounds abstract. Let's make it concrete.

- **Per minute**, that's **6 million requests**. An average mid-size e-commerce site handles about 1,000 requests per minute. We're talking about the traffic of 6,000 of those sites. Combined. On one server.
- **Per hour**, that's **360 million requests**. Instagram gets roughly 500 million daily active users. We'd burn through a request for each one of them in under 90 minutes.
- **Per day**, that's **8.64 billion requests**. The world population is about 8 billion people. At this rate, we'd serve more requests in a single day than there are humans on the planet.
- **Google Search** handles roughly 99,000 queries per second globally. Hitting 100K req/s means your single service is handling Google-Search-level query volume.

If you sold out an NFL stadium (70,000 seats), every single fan would need to make a request roughly every 0.7 seconds -- non-stop, all game long -- to generate this kind of load.

### What Does This Cost in the Real World?

Let's say instead of serving these requests ourselves, we were *making* them to somebody else's API. Take weather data as an example -- something a lot of apps depend on.

OpenWeatherMap's One Call API charges about **$0.0015 per request** on their pay-as-you-go tier. At 100K requests per second:

| Time Window | Requests | Cost |
|---|---|---|
| 1 second | 100,000 | **$150** |
| 1 minute | 6,000,000 | **$9,000** |
| 1 hour | 360,000,000 | **$540,000** |
| 1 day | 8,640,000,000 | **$12.96 million** |

That's **$150 per second**. The time it takes you to read this sentence, $600 gone. Step away for a coffee break, come back to a $90,000 bill.

And that's a *cheap* API. Many enterprise APIs charge $0.01-$0.05 per request. At $0.01/call, we're looking at **$86.4 million per day**.

This is why handling these requests *yourself* matters. If your architecture can't serve this traffic from your own infrastructure, you're either paying someone else an absurd amount to handle it, or you're dropping requests and losing users. Every request you can serve from your own stack, from your own cache, from your own database -- that's money staying in your pocket.

### Who Actually Needs This?

You'd be surprised. It's not just FAANG.

- **Ad tech platforms** routinely handle 100K+ bid requests per second during peak hours. Each one has a ~100ms deadline. Miss it, you lose revenue.
- **Gaming backends** for popular multiplayer titles handle player state updates, matchmaking, and telemetry at this scale.
- **Payment processors** like Stripe and Square need to process high-throughput transaction volumes with zero room for dropped requests.
- **IoT platforms** ingesting sensor data from millions of devices -- each device reporting every few seconds adds up fast.

Even if you never *need* 100K req/s in production, understanding what it takes to get there teaches you more about systems engineering than any textbook. You learn where the bottlenecks hide, what the hardware actually does, and why certain architectural decisions matter.

That's what this series is about. Let's start from scratch and see how far we can push it.

---

## Step 0: The Baseline

### The Setup

The simplest possible architecture that actually resembles a real application:

```
[autocannon] --HTTP--> [Express.js] --SQL--> [PostgreSQL in Docker]
```

**Database**: PostgreSQL 16 running in a Docker container. One table called `records` with **100,000 rows** of dummy product data -- **5,000 sellers** (distinct UUIDs), each with **20 items** (name, category, price, active flag, timestamp). Think of it as a marketplace: 5,000 vendors each listing about 20 products. There's a B-tree index on `group_id`. The dataset is big enough that Postgres has real work to do on every query -- scanning a 100K-row index to find the right 20 rows among 5,000 possible groups.

**API Server**: A single Express.js process. One endpoint: `GET /api/data/:uuid`. It takes a seller UUID, queries Postgres for their items, and returns the matching rows as JSON.

**Load Tester**: autocannon running a 10-second burst, rotating through all 5,000 seller UUIDs. A CPU sampler takes a snapshot every second so we can see how hard the machine is working.

### The Code

The Express server is about as minimal as it gets:

```javascript
app.get("/api/data/:uuid", async (req, res) => {
  const rows = await getRecordsByGroupId(req.params.uuid);
  if (rows.length === 0) {
    return res.status(404).json({ error: "No records found for this UUID" });
  }
  res.json({ group_id: req.params.uuid, count: rows.length, records: rows });
});
```

The database layer is a `pg` connection pool with 20 max connections:

```javascript
const pool = new Pool({
  host: "localhost",
  port: 5432,
  user: "app",
  password: "app",
  database: "appdb",
  max: 20,
});
```

Load test config: 10 concurrent connections, 10 seconds duration.

### The Results

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **5,426** |
| Latency (avg) | 1.27 ms |
| Latency (p50) | 1 ms |
| Latency (p99) | 3 ms |
| Latency (max) | 51 ms |
| Total requests | 54,250 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~20 MB/s |
| Peak CPU (avg across cores) | 20.5% |

**5,426 requests per second.** Zero errors. Latency averaging just **1.27 ms** -- that's fast. Each request is querying a 100,000-row table, finding the right 20 rows out of 5,000 possible sellers, and serializing them to JSON. Not bad for a completely untuned stack.

But we're going to 100K. That means we need roughly an **18x improvement** from here.

### Bottleneck #0: We're Only Using One CPU Core

Look at that CPU number: **20.5% average across all cores**. That might *look* like the machine is barely breaking a sweat. It's not. It's misleading.

Node.js is single-threaded. The Express server runs on **one core**. That one core is likely pegged close to 100% while every other core on the machine sits idle, doing nothing. When you average them all together, it *looks* like 20% utilization. In reality, one core is maxed out and the rest are wasted.

This is the fundamental constraint of Node.js out of the box. It doesn't matter how many cores your machine has -- 4, 8, 16 -- a single Node process will only ever use one of them. We're effectively running a V8 engine on a single piston while the rest of the cylinders are disconnected.

The load test is also only using 10 concurrent connections across 5,000 seller UUIDs. That's a relatively gentle amount of pressure. We might be able to squeeze more out of this single process just by turning up the concurrency -- but we'll quickly hit that single-core ceiling.

**To break past this, we need to use all the cores.** That's what's next.

---

## Step 1: Going Multi-Core

### What We Changed

Three changes, all aimed at one thing: stop leaving 9 out of 10 CPU cores on the bench.

**1. Node.js Cluster Mode**

The biggest lever. We wrapped the Express server in Node's built-in `cluster` module. The primary process forks 10 workers -- one per CPU core -- and they all share port 3000. The OS round-robins incoming connections across workers. If a worker crashes, the primary respawns it automatically.

```
                          ┌─ Worker 1  (Express + pg pool)
                          ├─ Worker 2  (Express + pg pool)
[autocannon] ──HTTP──►  ──┤    ...
  (10 workers,            ├─ Worker 9  (Express + pg pool)
   100 conns)             └─ Worker 10 (Express + pg pool)
                                   │
                                   ▼
                            [PostgreSQL]
```

The key code:

```javascript
if (cluster.isPrimary) {
  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork();
} else {
  // Each worker runs its own Express server + pg pool
  app.listen(PORT);
}
```

**2. Prepared Statements**

Every time we called `pool.query("SELECT ... WHERE group_id = $1", [uuid])`, Postgres had to parse the SQL, plan the query, and execute it. With 5,000 distinct UUIDs flying in, that's thousands of redundant parse-and-plan cycles for the exact same query shape.

We switched to a named prepared statement. Postgres parses and plans it once per connection, then reuses the plan for every subsequent call:

```javascript
const GET_RECORDS_QUERY = {
  name: "get_records_by_group_id",
  text: "SELECT id, group_id, name, category, value, active, created_at FROM records WHERE group_id = $1",
};

const { rows } = await pool.query({ ...GET_RECORDS_QUERY, values: [uuid] });
```

**3. Cluster-Aware Connection Pool**

With 10 workers, each running its own `pg.Pool`, we needed to be smart about connection counts. The old setup was a flat `max: 20`. Now each worker calculates its share of a total target of 80 connections:

```javascript
const totalPoolTarget = 80;
const perWorkerPool = Math.max(4, Math.floor(totalPoolTarget / numWorkers));
```

That gives us 8 connections per worker, 80 total across the cluster. Postgres's default `max_connections` is 100, so we're leaving some headroom for admin connections and monitoring.

**4. Load Test Upgrade**

We also cranked the load test itself. Connections went from 10 to **100**, and autocannon now runs with **10 worker threads** to ensure the load generator isn't the bottleneck. The request list was refactored from a `setupRequest` callback to a pre-built array of 5,000 request objects -- necessary because functions can't be serialized across worker threads.

### The Results

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **8,950** |
| Latency (avg) | 11.01 ms |
| Latency (p50) | 8 ms |
| Latency (p99) | 61 ms |
| Latency (max) | 956 ms |
| Total requests | 89,501 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~33.5 MB/s |
| Peak CPU (avg across cores) | 20.5% |

**Up from 5,426 to 8,950 req/s -- a 1.65x improvement.** Zero errors, zero timeouts. Total throughput jumped from ~20 MB/s to ~33.5 MB/s. We're now handling almost **90,000 requests** in a 10-second window, up from 54,000.

But the latency tells an important story. Average went from 1.27 ms to 11 ms, and p99 jumped from 3 ms to 61 ms. That's not because the server got *slower* -- it's because we're pushing **10x more concurrent connections** through it. Per-connection, each request is still being served quickly. We're just asking the system to juggle a lot more balls at once.

### Bottleneck #1: Where Did Our 10x Go?

Here's the uncomfortable truth: we added **10 CPU cores** but only got a **1.65x improvement**. That's... not great. If we were purely CPU-bound, clustering should have given us close to linear scaling. Something else is holding us back.

Look at the CPU numbers: **20.5% average across all cores** -- the exact same number as Step 0. That seems impossible if we're using 10 workers. The issue is our CPU sampling: `os.cpus()` returns cumulative times since boot, not deltas. On a machine that's been running for hours, a 10-second load test barely moves the needle on cumulative averages. The CPU is working harder than this number suggests.

The real bottleneck is likely **PostgreSQL**. Think about it: we went from 20 connections on one process to 80 connections across 10 processes, all hammering the same Postgres instance running in Docker with default configuration. Postgres is now the shared resource every worker is contending over. Default `shared_buffers` is only **128 MB**, `work_mem` is **4 MB**, and `max_connections` is **100** (we're using 80 of those).

We need to tune Postgres itself. More shared buffers, more work memory, and possibly more connections. We should also fix our CPU sampling to measure deltas between snapshots instead of cumulative averages -- we're flying blind on actual CPU utilization.

---

*Next up: Step 2 -- tuning PostgreSQL and fixing our CPU metrics.*
