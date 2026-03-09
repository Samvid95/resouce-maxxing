# Resource Maxxing

**The road to 100,000 requests per second** -- pushing a simple Node.js + PostgreSQL stack to its absolute limits, one bottleneck at a time.

## The Goal

Take the most boring, vanilla web stack imaginable -- Express.js talking to PostgreSQL -- and see how far we can push it on a single machine. No Kubernetes. No load balancers. No cloud auto-scaling. Just raw optimization, one layer at a time, until we hit **100K req/s**.

Every step is documented in [`blog.md`](blog.md) with real benchmarks, the exact code changes, and analysis of what bottleneck we hit next.

## Current Status

| Step | Optimization | Req/s | Improvement |
|------|-------------|-------|-------------|
| 0 | Baseline (untuned Express + pg) | 5,426 | -- |
| 1 | Cluster mode + prepared statements + pool scaling | 8,950 | 1.65x |

**Target: 100,000 req/s** -- we need an ~11x improvement from here.

## Architecture

```
                          ┌─ Worker 1  (Express + pg pool)
                          ├─ Worker 2  (Express + pg pool)
[autocannon] ──HTTP──►  ──┤    ...          ──►  [PostgreSQL in Docker]
  (10 workers,            ├─ Worker 9  (Express + pg pool)
   100 conns)             └─ Worker 10 (Express + pg pool)
```

- **API**: `GET /api/data/:uuid` -- queries `records` by `group_id`, returns JSON. Runs in **cluster mode** across all CPU cores.
- **Database**: PostgreSQL 16 in Docker. 100,000 rows (5,000 sellers x 20 items), B-tree index on `group_id`. Uses **prepared statements** and cluster-aware connection pooling (80 total).
- **Load Testing**: [autocannon](https://github.com/mcollina/autocannon) with **multi-worker threads**, 100 connections, CPU sampling, results saved as JSON to `results/`.

## Quick Start

### Prerequisites

- Node.js 18+
- Docker

### Run It

```bash
# Install dependencies
npm install

# Start PostgreSQL
npm run db:up

# Start the API server
npm start

# Run the load test (in another terminal)
npm run loadtest
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the Express server |
| `npm run dev` | Start with `--watch` for auto-reload |
| `npm run db:up` | Start PostgreSQL in Docker |
| `npm run db:down` | Stop and remove the database |
| `npm run loadtest` | Run a 10-second load test and save results |

## Project Structure

```
.
├── src/
│   ├── server.js          # Clustered Express API server (multi-core)
│   └── db.js              # PostgreSQL pool + prepared statements
├── db/
│   └── init.sql           # Schema, indexes, and seed data
├── scripts/
│   └── loadtest.js        # Load test with CPU sampling
├── results/               # Load test output (JSON)
├── blog.md                # The optimization journey, step by step
├── docker-compose.yml     # PostgreSQL 16 container
└── package.json
```

## The Blog

The heart of this project is [`blog.md`](blog.md) -- a detailed write-up of each optimization step, including:

- What we changed and why
- Before/after benchmark numbers
- What bottleneck we identified
- What we're tackling next

It's written to be read start-to-finish, like a series of engineering blog posts.

## License

This project is licensed under the MIT License -- see the [LICENSE](LICENSE) file for details.
