---
description: Generate a new blog entry for the Resource Maxxing journey
---

You are writing the next entry in a performance engineering blog. Follow these steps exactly:

## 1. Gather Context

- Read `blog.md` to understand the existing writing style, voice, structure, and what step number we're on. The next entry should be the next sequential step (e.g., if the last entry is "Step 2", write "Step 3").
- Read ALL files in the `results/` directory. Sort them by timestamp. Identify which result files are **new** since the last blog entry was written (compare timestamps from the results JSON `timestamp` field against what's already documented in the blog).
- Read the current source files (`src/`, `scripts/`, `docker-compose.yml`, `db/`, `package.json`) to understand what changed since the last entry.
- Read the git log (if available) to see what commits were made since the last entry.

## 2. Analyze the Changes

- Compare the **previous step's results** (already in `blog.md`) with the **latest load test results** from `results/`.
- Calculate the improvement: what's the req/s delta, latency change, CPU change, error rate change.
- Identify what code/architecture changes were made that caused the improvement (or regression).
- Determine what the **current bottleneck** is based on the new results. Look at CPU utilization patterns, latency distribution (avg vs p99 vs max), error counts, and throughput ceiling.

## 3. Write the Blog Entry

Append a new `## Step N` section to `blog.md`, following the **exact same structure** as the existing steps:

### Required Sections (in order):

1. **`## Step N: [Descriptive Title]`** -- a short, punchy title describing what we changed.

2. **`### What We Changed`** -- explain the architectural or code change. Include a brief ASCII diagram if the architecture changed. Show the key code snippets that changed (not the whole file, just the important diff). Explain *why* this change should help.

3. **`### The Results`** -- a markdown table with these exact metrics from the latest load test:
   - Requests/sec (avg) -- **bold this row**
   - Latency (avg)
   - Latency (p50)
   - Latency (p99)
   - Latency (max)
   - Total requests
   - Errors
   - Timeouts
   - Throughput
   - Peak CPU (avg across cores)

   After the table, write 1-2 sentences calling out the most interesting result. Include the **delta from the previous step** (e.g., "Up from 5,661 to 15,200 -- a 2.7x improvement").

4. **`### Bottleneck #N: [What's Limiting Us Now]`** -- analyze the results to identify the *new* bottleneck. Be specific. Use the data to back up the claim (e.g., "CPU is now at 85% avg, we're compute-bound" or "p99 jumped to 45ms while avg is 2ms, something is causing tail latency spikes"). End with a one-liner about what we need to do next.

5. **Closing separator and teaser** -- end with `---` and an italic teaser line like: `*Next up: Step N+1 -- [brief hint at next optimization].*`

## 4. Style Rules

- Match the tone: technical but conversational, like explaining to a smart friend over coffee.
- Use **bold** for key numbers and metrics.
- Use analogies and comparisons to make numbers tangible (the existing blog compares to NFL stadiums, Google Search, etc.).
- Keep paragraphs short. No walls of text.
- Code blocks should use ```javascript or ``` (plain) for architecture diagrams.
- Don't repeat information already in the blog. Reference it briefly (e.g., "Up from our Step 0 baseline of 5,661 req/s").
- Don't add a "realistic path to 100K" or roadmap section. Stay focused on what we did and what we learned.
- Do NOT add any meta-commentary about the blog generation process itself.
