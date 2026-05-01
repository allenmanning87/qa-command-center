// One-time migration: reads all data/*.json files and seeds them into data/app.db.
// Run once with: node scripts/migrate-json-to-db.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'app.db');

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, data TEXT NOT NULL)`);

const insert = db.prepare('INSERT OR REPLACE INTO collections (name, data) VALUES (?, ?)');

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
if (files.length === 0) {
  console.log('No JSON files found in data/. Nothing to migrate.');
  process.exit(0);
}

for (const file of files) {
  const collection = file.replace('.json', '');
  const filePath = path.join(DATA_DIR, file);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(content); // validate before inserting
    insert.run(collection, content);
    console.log(`✓ ${collection}`);
  } catch (err) {
    console.warn(`✗ ${file} — skipped (${err.message})`);
  }
}

db.close();
console.log('\nDone. Verify the app works, then the JSON files can be removed.');
