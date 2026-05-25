#!/usr/bin/env node
/*
  Manually picks Games of the Week without opening the debug page.

  Usage:
    ADMIN_PASSWORD="your password" node scripts/pick-gotw.js
    ADMIN_PASSWORD="your password" LEDGER_URL="http://localhost:3000" node scripts/pick-gotw.js
*/

const baseUrl = process.env.LEDGER_URL || 'http://localhost:3000';
const password = process.env.ADMIN_PASSWORD;

if (!password) {
  console.error('Missing ADMIN_PASSWORD environment variable.');
  console.error('Example: ADMIN_PASSWORD="your password" node scripts/pick-gotw.js');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/pick-gotw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': password,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  console.log('Games of the Week picked successfully.');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error('Failed to pick Games of the Week:', err.message);
  process.exit(1);
});
