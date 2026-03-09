# Resource Maxxing: The Road to 50,000 Requests Per Second

A hands-on journey of pushing a simple Node.js + PostgreSQL stack to its absolute limits, one bottleneck at a time.

---

## Why 50K Requests Per Second?

Before we start optimizing anything, let's talk about why this number matters and what it actually *means*.

### Putting 50K req/s Into Perspective

50,000 requests per second sounds abstract. Let's make it concrete.

- **Per minute**, that's **3 million requests**. An average mid-size e-commerce site handles about 1,000 requests per minute. We're talking about the traffic of 3,000 of those sites. Combined. On one server.
- **Per hour**, that's **180 million requests**. Instagram gets roughly 500 million daily active users. We'd burn through a request for each one of them in under 3 hours.
- **Per day**, that's **4.32 billion requests**. That's more than half the world's population. One request per person, served from a single machine, in a single day.
- **Google Search** handles roughly 99,000 queries per second globally. Hitting 50K req/s means your single service is handling **half of Google Search's** query volume.

If you sold out an NFL stadium (70,000 seats), every single fan would need to make a request roughly every 1.4 seconds -- non-stop, all game long -- to generate this kind of load.

### What Does This Cost in the Real World?

Let's say instead of serving these requests ourselves, we were *making* them to somebody else's API. Take weather data as an example -- something a lot of apps depend on.

OpenWeatherMap's One Call API charges about **$0.0015 per request** on their pay-as-you-go tier. At 50K requests per second:

| Time Window | Requests | Cost |
|---|---|---|
| 1 second | 50,000 | **$75** |
| 1 minute | 3,000,000 | **$4,500** |
| 1 hour | 180,000,000 | **$270,000** |
| 1 day | 4,320,000,000 | **$6.48 million** |

That's **$75 per second**. The time it takes you to read this sentence, $300 gone. Step away for a coffee break, come back to a $45,000 bill.

And that's a *cheap* API. Many enterprise APIs charge $0.01-$0.05 per request. At $0.01/call, we're looking at **$43.2 million per day**.

This is why handling these requests *yourself* matters. If your architecture can't serve this traffic from your own infrastructure, you're either paying someone else an absurd amount to handle it, or you're dropping requests and losing users. Every request you can serve from your own stack, from your own cache, from your own database -- that's money staying in your pocket.

### Who Actually Needs This?

You'd be surprised. It's not just FAANG.

- **Ad tech platforms** routinely handle 100K+ bid requests per second during peak hours. Each one has a ~100ms deadline. Miss it, you lose revenue.
- **Gaming backends** for popular multiplayer titles handle player state updates, matchmaking, and telemetry at this scale.
- **Payment processors** like Stripe and Square need to process high-throughput transaction volumes with zero room for dropped requests.
- **IoT platforms** ingesting sensor data from millions of devices -- each device reporting every few seconds adds up fast.

Even if you never *need* 50K req/s in production, understanding what it takes to get there teaches you more about systems engineering than any textbook. You learn where the bottlenecks hide, what the hardware actually does, and why certain architectural decisions matter.

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

But we're going to 50K. That means we need roughly a **9x improvement** from here.

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

## Step 2: Tuning Postgres and Seeing the Truth

### What We Changed

Two categories of changes this time: one that makes things faster, and one that finally lets us *see* how fast things actually are.

**1. Fixed CPU Measurement**

Our CPU numbers have been lying to us. The `os.cpus()` API returns cumulative times since the system booted -- not since the test started. On a machine that's been running for hours, a 10-second load test barely nudges the cumulative averages. We were reading 20.5% CPU in both Step 0 and Step 1, which is like checking your car's *lifetime* average speed to see how fast you're going right now.

The fix: delta-based sampling. Each snapshot now computes the difference from the previous snapshot, giving us actual per-second CPU usage:

```javascript
function getCpuTimes() {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: cpu.times.idle, total };
  });
}

function cpuDelta(prev, curr) {
  return curr.map((c, i) => {
    const dTotal = c.total - prev[i].total;
    const dIdle = c.idle - prev[i].idle;
    if (dTotal === 0) return { core: i, usagePct: 0 };
    return { core: i, usagePct: +(((dTotal - dIdle) / dTotal) * 100).toFixed(1) };
  });
}
```

**2. PostgreSQL Tuning**

We created a custom `postgresql.conf` and mounted it into the Docker container. The defaults are designed for a small shared server from 2005, not a dedicated performance test. Here's what we changed:

| Setting | Default | Tuned | Why |
|---|---|---|---|
| `shared_buffers` | 128 MB | **1 GB** | Main buffer cache -- our entire dataset (11 MB) lives in RAM now |
| `effective_cache_size` | 4 GB | **3 GB** | Tells the query planner how much OS cache to expect |
| `work_mem` | 4 MB | **32 MB** | More memory per sort/hash operation |
| `max_connections` | 100 | **200** | Headroom above our 80 pool connections |
| `synchronous_commit` | on | **off** | Don't wait for WAL flush -- we're read-heavy |
| `random_page_cost` | 4.0 | **1.1** | Data is in memory, random I/O is nearly free |
| `wal_level` | replica | **minimal** | No replication, less WAL overhead |

We also gave the Docker container real resources: **4 GB memory limit** with **1 GB shared memory** (`shm_size`) to support the larger `shared_buffers`. Previously it was running with Docker's defaults -- about 2 GB and 64 MB shm.

The `synchronous_commit = off` deserves a callout. By default, Postgres waits for every transaction's WAL (write-ahead log) entry to be flushed to disk before confirming. For a read-heavy benchmark where we never write, this shouldn't matter much -- but turning it off removes the overhead from Postgres's internal bookkeeping and any background checkpoint activity.

Setting `random_page_cost = 1.1` (down from 4.0) is another subtle one. The default assumes spinning disks where random I/O is 4x more expensive than sequential. But our data fits entirely in `shared_buffers`. Random vs sequential is meaningless when everything is in RAM. This nudges the planner toward index scans instead of sequential scans.

### The Results

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **11,110** |
| Latency (avg) | 8.75 ms |
| Latency (p50) | 7 ms |
| Latency (p99) | 33 ms |
| Latency (max) | 820 ms |
| Total requests | 111,087 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~41.6 MB/s |
| Peak CPU (avg across cores) | 100% |

**Up from 8,950 to 11,110 req/s -- a 1.24x improvement** over Step 1, and **2.05x over our original baseline**. We crossed 100,000 total requests in a 10-second window for the first time.

But the real headline is that CPU number. **100%.** Every single core, maxed out, for the entire duration of the test. That's not 20.5% anymore -- that was a ghost. Now we're seeing reality, and reality says the machine is fully saturated.

Latency actually *improved* despite higher throughput: average dropped from 11 ms to **8.75 ms**, and p99 nearly halved from 61 ms to **33 ms**. The Postgres tuning made each query faster, which freed up cycles for more concurrent requests.

### Bottleneck #2: Total CPU Saturation

The machine is at **100% CPU** across all 10 cores. But here's the thing -- it's not just the server that's eating those cycles. We're running **10 Node.js server workers** and **10 autocannon worker threads** on the same 10-core machine, plus Postgres in Docker. That's 20+ processes fighting for 10 cores.

This is like timing a race where the referee is also one of the runners. The load generator is stealing CPU from the server and vice versa. We can't know if we'd get 15K, 20K, or more req/s if the server had all 10 cores to itself.

The p99-to-avg ratio is **3.8x** (33 ms vs 8.75 ms), and the max latency hit **820 ms**. That tail is likely context-switching overhead -- when 20+ processes compete for 10 cores, some requests inevitably get paused mid-execution while the OS scheduler swaps processes in and out.

To go further, we need to either get more CPU (bigger machine) or get more throughput per CPU cycle. That means replacing Express with something faster -- the middleware chain, `JSON.stringify()` on every response, and the request parsing overhead are all burning cycles that a leaner framework could save.

---

## Step 3: Fastify and Stopping the Load Test From Stealing CPU

### What We Changed

Two changes this time, both aimed at getting more throughput per CPU cycle.

**1. Express → Fastify**

Express has been the default Node.js framework since 2010. It's battle-tested, well-documented, and... slow. Every request passes through a middleware chain, creates new request/response wrapper objects, and serializes the response body using generic `JSON.stringify()`. When you're CPU-bound and handling 11K req/s, that overhead adds up.

Fastify takes a different approach. Its core innovation is **schema-based serialization**: you define a JSON Schema for your response, and Fastify pre-compiles a dedicated serializer using `fast-json-stringify`. Instead of walking the object tree at runtime to figure out types and escaping (which is what `JSON.stringify()` does), the compiled serializer *already knows* the structure and generates the JSON string directly. For our 20-record response payload, that's a meaningful speedup -- we're serializing it 14,000+ times per second.

The route definition now includes a response schema:

```javascript
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
```

Fastify also has a faster radix-tree router (via `find-my-way`), lower per-request object allocation, and native support for `async` handlers without wrapping -- all small wins that compound at high request rates.

**2. Stopped the Load Test From Hogging CPU**

In Step 2, we discovered the machine was at 100% CPU with **10 Node.js server workers** and **10 autocannon worker threads** fighting for 10 cores. The load generator was eating half the CPU.

Here's the thing about HTTP load generators: they're I/O-bound, not CPU-bound. Sending HTTP requests and reading responses is almost entirely network I/O. You don't need 10 cores for that. We dropped autocannon from **10 workers to 2** and bumped connections from **100 to 200** to maintain pressure. The server now gets the lion's share of the CPU.

```
                          ┌─ Worker 1  (Fastify + pg pool)
                          ├─ Worker 2  (Fastify + pg pool)
[autocannon] ──HTTP──►  ──┤    ...          ──►  [PostgreSQL]
  (2 workers,             ├─ Worker 9  (Fastify + pg pool)
   200 conns)             └─ Worker 10 (Fastify + pg pool)
```

### The Results

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **14,640** |
| Latency (avg) | 15.71 ms |
| Latency (p50) | 13 ms |
| Latency (p99) | 28 ms |
| Latency (max) | 3,931 ms |
| Total requests | 146,379 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~53.8 MB/s |
| Peak CPU (avg across cores) | ~100% |

**Up from 11,110 to 14,640 req/s -- a 1.32x improvement** over Step 2, and **2.7x over our original baseline**. We blew past the 100K-in-10-seconds mark with nearly **146,000 total requests**. Throughput jumped from 41.6 to **53.8 MB/s** -- that's over half a gigabit of JSON flying over the wire every second.

The p99 latency actually *improved* from 33 ms to **28 ms** despite doubling connections from 100 to 200. That's the combined effect of Fastify's lower per-request overhead and freeing up 8 CPU cores by shrinking autocannon. Less context switching, fewer processes competing for time slices.

### Bottleneck #3: We're Still CPU-Bound, But Burning Smarter

The machine is still pegged at **~100% CPU**. We're saturated. But we're now getting **14,640 req/s** out of those same 10 cores, up from 11,110. That's **32% more throughput per CPU cycle** -- the Fastify switch and autocannon right-sizing are doing real work.

The max latency spike to **3,931 ms** is concerning though. That's nearly 4 seconds for a single request. The average is 15.71 ms and p99 is 28 ms, so 99% of requests are fine -- but something is causing rare, extreme outliers. With 200 connections and 10 server workers, some requests are likely getting stuck behind garbage collection pauses or OS-level scheduling delays when the CPU is this saturated.

At this point, the path forward splits. We could try to squeeze more out of the framework layer by switching to something even lower-level like `uWebSockets.js`, or we could attack the problem from a completely different angle: **stop hitting the database entirely**. If we cache responses in memory, we eliminate the Postgres round-trip and the serialization cost for repeated UUIDs. With 5,000 distinct sellers, a warm cache would mean most requests never touch the database.

---

## Step 4: In-Memory Caching -- Skipping the Database Entirely

### What We Changed

Every request in Steps 0-3 hit PostgreSQL. Every. Single. One. Even with prepared statements and a tuned Postgres config, that's still a network round-trip to Docker, a query plan execution, row fetching, and result serialization -- for data that *doesn't change during the test*. With only 5,000 distinct seller UUIDs, we're asking the same questions over and over and expecting different answers. Time to stop doing that.

We added a **per-worker in-memory LRU cache** that stores pre-serialized JSON response strings. The flow now looks like this:

```
Request arrives
    │
    ▼
Cache lookup (Map.get)
    │
    ├── HIT:  send cached JSON string directly ← no DB, no serialization
    │
    └── MISS: query Postgres → serialize → store in cache → send
```

Each of the 10 cluster workers maintains its own cache (no cross-process sharing, no locking). The cache uses JavaScript's `Map` as an ordered data structure -- on every access, the entry is deleted and re-inserted at the end, making the oldest entries naturally bubble to the front for eviction. It's a textbook LRU in ~30 lines:

```javascript
class LRUCache {
  constructor(capacity = 10000, ttl = 60000) {
    this.capacity = capacity;
    this.ttl = ttl;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, ts: Date.now() });
  }
}
```

The critical trick is *what* we cache. Not the database rows -- the **fully serialized JSON string**. On a cache hit, the handler does:

```javascript
const cached = cache.get(uuid);
if (cached) {
  reply.header("content-type", "application/json; charset=utf-8");
  return reply.send(cached);
}
```

That bypasses Fastify's schema serializer too. No `JSON.stringify`, no `fast-json-stringify`, no object traversal. Just raw bytes from memory straight to the socket. On a cache miss, we query Postgres, serialize once, store the string, and return it. Every subsequent request for that UUID is pure memory-to-socket.

With 5,000 seller UUIDs, a 10,000-entry cache with 60-second TTL means the entire working set fits comfortably in each worker's cache. After the first pass through all UUIDs, the hit rate approaches **100%**.

### The Results

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **24,738** |
| Latency (avg) | 8.9 ms |
| Latency (p50) | 5 ms |
| Latency (p99) | 21 ms |
| Latency (max) | 3,337 ms |
| Total requests | 247,426 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~91.5 MB/s |
| Peak CPU (avg across cores) | ~100% |

**Up from 14,640 to 24,738 req/s -- a 1.69x improvement** over Step 3, and **4.56x over our original baseline**. We're now handling nearly **a quarter million requests** in a 10-second window. Throughput jumped from 53.8 to **91.5 MB/s** -- that's **730 megabits per second** of JSON. We're getting close to saturating a gigabit network interface.

The latency story is dramatic. The p50 dropped from 13 ms to **5 ms** -- the median request is now twice as fast. Average fell from 15.71 to **8.9 ms**, and p99 improved from 28 to **21 ms**. Eliminating the Postgres round-trip on cached requests cut the per-request cost roughly in half.

### Bottleneck #4: Pure CPU, No Escape

We're at **~100% CPU** again, but now we're getting **24,738 req/s** out of those 10 cores -- up from 14,640 in Step 3. That's **69% more throughput per cycle**. The cache eliminated the biggest per-request cost (Postgres + serialization), and the remaining CPU is spent almost entirely on HTTP parsing, connection management, and event loop overhead.

The max latency is still high at **3,337 ms**. These extreme outliers are GC pauses and OS scheduling jitter -- inevitable when the CPU is 100% saturated and V8 needs to stop the world for garbage collection. The gap between p99 (**21 ms**) and max (**3,337 ms**) is **159x**, which tells us 99% of requests are fast but the rare worst case is brutal.

At this point, we've optimized away the database, the serialization, and the framework overhead. We're left with the raw cost of Node.js event loop + HTTP protocol processing. To go further, we'd need to either drop below Fastify to something like raw `http` module or `uWebSockets.js`, or find ways to reduce the per-request CPU cost at the Node.js runtime level -- HTTP pipelining, response compression trade-offs, or `Buffer` pre-allocation for cached responses.

---

## Step 5: HTTP Pipelining -- Honest Numbers and the Server's True Ceiling

### What We Changed

This step was about finding how much more we could wring out of the stack. We tried four things. Most of them didn't work. One of them changed everything -- but not in the way you'd expect.

**1. Buffer Caching (No Effect)**

We switched the LRU cache from storing JSON strings to pre-allocated `Buffer` objects, hoping to skip Node's internal string-to-Buffer conversion on `socket.write()`. Result: no measurable improvement. Node's `socket.write()` already handles string conversion efficiently -- the explicit `Buffer.from()` on cache miss actually adds a small allocation cost that cancels out any write-side savings.

**2. HTTP Keep-Alive Tuning (No Effect)**

We tuned Fastify's `keepAliveTimeout`, `connectionTimeout`, `requestTimeout`, and `backlog`. Result: nothing. autocannon already reuses connections for the full test duration, and the default timeouts weren't causing any issues. The kernel's listen backlog wasn't the bottleneck at 200 connections.

**3. uWebSockets.js Experiment (Worse)**

We built a separate server using `uWebSockets.js` -- a C++ HTTP server with a thin JS binding that benchmarks 3-5x faster than Fastify in isolation. Result: **12,060 req/s** (down from 24,738). The problem: uWS manages its own socket layer and doesn't integrate with Node's `cluster` module for port sharing. Each worker fought for the port instead of cooperating. The CPU only hit 88% -- the workers were tripping over each other. The experiment lives at `src/server-uws.js` for future exploration with uWS's native threading model.

**4. HTTP Pipelining (The Big One)**

This is where it gets interesting -- and where we need to be honest.

HTTP pipelining lets a single TCP connection send multiple requests *without waiting for each response*. Instead of the normal back-and-forth:

```
Normal:    Req1 → [wait] → Res1 → Req2 → [wait] → Res2 → Req3 → [wait] → Res3

Pipelined: Req1 Req2 Req3 Req4 ... Req10 → [wait] → Res1 Res2 Res3 ... Res10
```

We added `pipelining: 10` to autocannon and dropped to 1 worker (since pipelining generates so much more load per thread):

```javascript
const result = await autocannon({
  url: TARGET,
  connections: 100,
  pipelining: 10,
  duration: 10,
  workers: 1,
  requests,
});
```

With 100 connections × pipelining 10, there are up to **1,000 requests in-flight** simultaneously, versus 200 before. The server reads batches of requests from each socket buffer in tight loops, processes them, and streams responses back in bursts. Less idle time, fewer event loop wake-ups, better TCP packet utilization.

### The Results

Here's where we show both numbers, because they tell different stories.

**Realistic (no pipelining) -- what production traffic looks like:**

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **24,738** |
| Latency (avg) | 8.9 ms |
| Latency (p50) | 5 ms |
| Latency (p99) | 21 ms |
| Latency (max) | 3,337 ms |
| Total requests | 247,426 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~91.5 MB/s |
| Peak CPU (avg across cores) | ~100% |

This is the same number as Step 4. The Buffer caching and keep-alive tuning didn't move the needle. **24,738 req/s is our honest, production-realistic throughput** -- each connection sends one request and waits for the response, just like a real browser, mobile app, or API client.

**Pipelined (10x in-flight) -- the server's theoretical ceiling:**

| Metric | Value |
|---|---|
| **Requests/sec (avg)** | **56,750** |
| Latency (avg) | 20.03 ms |
| Latency (p50) | 15 ms |
| Latency (p99) | 67 ms |
| Latency (max) | 3,169 ms |
| Total requests | 567,455 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~209.4 MB/s |
| Peak CPU (avg across cores) | ~100% |

**56,750 req/s** -- over **half a million requests** in 10 seconds, pushing **209 MB/s** (~1.7 gigabits) of JSON. That's a **2.29x jump** over the non-pipelined number using the exact same server code.

But let's be real about what this number means.

### A Note on Honesty

HTTP pipelining was defined in the HTTP/1.1 spec but was never widely adopted. Browsers disabled it because of head-of-line blocking problems. Most proxies and CDNs don't support it. HTTP/2 replaced it with proper multiplexing (out-of-order responses). In practice, almost no real-world client sends pipelined HTTP/1.1 requests.

So the **24,738 number is our real throughput**. That's what you'd see in production with real clients. The **56,750 number tells us something different**: it reveals that the server has massive untapped capacity. When requests arrive efficiently (batched, no round-trip gaps), the server can handle 2.3x more. The gap between those two numbers is pure HTTP/1.1 protocol overhead -- the cost of the request-response dance.

In the real world, you'd close that gap not with pipelining, but with **HTTP/2** (which does real-world multiplexing), **batched API endpoints** (one request that returns data for multiple UUIDs), or **connection pooling at the load balancer level**.

For this journey, the pipelined number represents the ceiling we *could* reach with a more efficient transport layer. The non-pipelined number is where we actually are.

### Bottleneck #5: The Protocol and the Machine

With the realistic number (**24,738 req/s**), we're at **100% CPU** and limited by HTTP/1.1's request-response synchronization. Half of the CPU time is spent in the gaps *between* requests -- waiting for the client to receive the response and send the next one. Pipelining proves this by filling those gaps and doubling throughput.

With the pipelined number (**56,750 req/s**), we've exceeded our **50K goal** but we're bumping up against the single-machine ceiling. The load generator (1 autocannon thread) is close to its own limits, and the 10 server workers are saturating all 10 cores.

The journey to 50K on a single machine is essentially about two things: can the server process requests fast enough (yes -- 56K proves it), and can real-world clients push requests fast enough to keep it busy (not with HTTP/1.1 from a single machine). For production at this scale, HTTP/2, multiple client machines, or a load balancer in front would close the gap.

---

*We hit the ceiling. From 5,426 to 56,750 -- a 10.5x improvement. The server can handle 50K+. Getting real clients to push that hard is a different problem.*
