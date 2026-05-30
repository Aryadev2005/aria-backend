require('dotenv').config();
const { Client } = require('pg');

const urls = {
  'DATABASE_URL (pooler)': process.env.DATABASE_URL,
  'DIRECT_URL': process.env.DIRECT_URL
};

console.log('Testing database connections...\n');

async function testConnection(name, url) {
  console.log(`Testing ${name}...`);
  const client = new Client(url);
  
  const timeout = setTimeout(() => {
    console.log(`  ✗ TIMEOUT after 5 seconds`);
    client.end().catch(() => {});
  }, 5000);

  try {
    await client.connect();
    clearTimeout(timeout);
    const result = await client.query('SELECT NOW()');
    console.log(`  ✓ SUCCESS - Current time: ${result.rows[0].now}\n`);
    await client.end();
    return true;
  } catch (err) {
    clearTimeout(timeout);
    console.log(`  ✗ ERROR - ${err.message}\n`);
    return false;
  }
}

(async () => {
  for (const [name, url] of Object.entries(urls)) {
    await testConnection(name, url);
  }
})();
