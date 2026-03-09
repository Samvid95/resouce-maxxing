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

**Database**: PostgreSQL 16 running in a Docker container. One table called `records` with 10 distinct UUIDs, each having 5-6 rows of dummy product data (name, category, price, active flag, timestamp). There's a B-tree index on `group_id`.

**API Server**: A single Express.js process. One endpoint: `GET /api/data/:uuid`. It takes a UUID, queries Postgres, and returns the matching rows as JSON.

**Load Tester**: autocannon running a 10-second burst, rotating through all 10 UUIDs. A CPU sampler takes a snapshot every second so we can see how hard the machine is working.

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
| **Requests/sec (avg)** | **5,661** |
| Latency (avg) | 1.3 ms |
| Latency (p50) | 1 ms |
| Latency (p99) | 4 ms |
| Latency (max) | 61 ms |
| Total requests | 62,267 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~7 MB/s |
| Peak CPU (avg across cores) | 20.4% |

**5,661 requests per second.** Zero errors. Not bad for a completely untuned stack -- that's already enough to handle a solid mid-tier production workload.

But we're going to 100K. That means we need roughly an **18x improvement** from here.

### Bottleneck #0: We're Only Using One CPU Core

Look at that CPU number: **20.4% average across all cores**. That might *look* like the machine is barely breaking a sweat. It's not. It's misleading.

Node.js is single-threaded. The Express server runs on **one core**. That one core is likely pegged close to 100% while every other core on the machine sits idle, doing nothing. When you average them all together, it *looks* like 20% utilization. In reality, one core is maxed out and the rest are wasted.

This is the fundamental constraint of Node.js out of the box. It doesn't matter how many cores your machine has -- 4, 8, 16 -- a single Node process will only ever use one of them. We're effectively running a V8 engine on a single piston while the rest of the cylinders are disconnected.

The load test is also only using 10 concurrent connections. That's a relatively gentle amount of pressure. We might be able to squeeze more out of this single process just by turning up the concurrency -- but we'll quickly hit that single-core ceiling.

**To break past this, we need to use all the cores.** That's what's next.

---

*Next up: Step 1 -- breaking the single-core barrier.*
