const CAPACITY = parseInt(process.env.CACHE_CAPACITY || "10000", 10);
const TTL_MS = parseInt(process.env.CACHE_TTL_MS || "60000", 10);

class LRUCache {
  constructor(capacity = CAPACITY, ttl = TTL_MS) {
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

  get size() {
    return this.map.size;
  }
}

module.exports = { LRUCache };
