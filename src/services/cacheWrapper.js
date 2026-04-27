'use strict';
const { cache } = require('../config/redis');

async function getCache(key) {
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

async function setCache(key, value, ttlSeconds = 300) {
  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    // Redis unavailable — continue without cache
  }
}

async function deleteCache(key) {
  try {
    await cache.del(key);
  } catch {}
}

module.exports = { getCache, setCache, deleteCache };
