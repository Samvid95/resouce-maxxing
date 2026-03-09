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

**Database**: PostgreSQL 16 running in a Docker container. One table called `records` with **100,000 rows** of dummy product data -- 10 distinct UUIDs, each with 10,000 rows (name, category, price, active flag, timestamp). There's a B-tree index on `group_id`. This isn't a toy dataset; every single API call has to fetch, serialize, and transmit 10,000 rows of JSON. That's the kind of payload size that separates benchmarks from reality.

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
| **Requests/sec (avg)** | **35** |
| Latency (avg) | 282.12 ms |
| Latency (p50) | 278 ms |
| Latency (p99) | 486 ms |
| Latency (max) | 519 ms |
| Total requests | 350 |
| Errors | 0 |
| Timeouts | 0 |
| Throughput | ~60 MB/s |
| Peak CPU (avg across cores) | 20.5% |

**35 requests per second.** Zero errors, but *thirty-five*. That's it. Each request is hauling back 10,000 rows of JSON, and it shows -- average latency is sitting at **282 ms**, with p99 creeping up to nearly half a second.

To put that in perspective: at 35 req/s, it would take us almost **48 minutes** to serve a single million requests. We need to get to 100K req/s. That's a **~2,857x improvement** from where we're standing. We've got a long road ahead.

### Bottleneck #0: Death by Serialization (and a Single Core)

There are two things crushing us here, and they're stacking on top of each other.

**First: the payload.** Every request fetches 10,000 rows from Postgres and serializes them into a massive JSON blob. That's not a light operation. `JSON.stringify()` on an array of 10,000 objects with multiple fields is CPU-intensive work -- and it happens on *every single request*. The ~60 MB/s throughput tells us we're moving a lot of data, but the 282ms latency tells us we're spending most of our time *preparing* it.

**Second: single-threaded Node.js.** Look at that CPU number: **20.5% average across all cores**. That might *look* like the machine is barely breaking a sweat. It's misleading. Node.js runs on **one core**. That one core is likely pegged near 100% -- grinding through query results and JSON serialization -- while every other core sits idle. Average them together and it *looks* like 20%. In reality, we're maxing out the only engine we've got.

Together, these two bottlenecks create a brutal ceiling: each request takes ~282ms of single-threaded CPU time, mostly spent serializing JSON, and we can only process them one-at-a-time on a single core. With 10 concurrent connections fighting over that one core, we get 35 req/s. That's the math.

**To break past this, we need to attack both fronts** -- use all available cores, and find a way to stop paying the serialization tax on every request.

---

*Next up: Step 1 -- breaking the single-core barrier.*
