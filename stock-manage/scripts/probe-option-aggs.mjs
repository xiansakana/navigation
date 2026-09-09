#!/usr/bin/env node
import { loadConfig } from '../src/storage.js';

const config = loadConfig();
const poly = 'O:BULL270115C00005000';
const key = config.polygonApiKey;
const today = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);
const from = fmt(new Date(today.getTime() - 86400000 * 10));
const to = fmt(today);

const urls = [
  ['day-range', `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=15&apiKey=${key}`],
  ['hour-range', `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=50&apiKey=${key}`],
  ['min-range', `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/range/1/minute/${fmt(today)}/${to}?adjusted=true&sort=desc&limit=5&apiKey=${key}`],
];
for (const [label, url] of urls) {
  const res = await fetch(url);
  const body = await res.json();
  console.log(label, res.status, body.status, body.error || '', 'n=', body.resultsCount ?? body.results?.length);
  console.log(JSON.stringify(body.results?.slice(-3), null, 2));
}
