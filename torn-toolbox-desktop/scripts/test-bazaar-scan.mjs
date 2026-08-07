import fs from 'node:fs';
import { fetchUserBazaar, fetchUserItemMarket } from '../src/torn-api.js';

const config = JSON.parse(fs.readFileSync('config.undercut.json', 'utf8'));
const watcher = config.undercut.watchers[0];
const apiKey = watcher.apiKey;
const sel = new Set((watcher.selectedItems || []).map((i) => Number(i.id)));

const bazaar = await fetchUserBazaar(apiKey);
const im = await fetchUserItemMarket(apiKey);

function bazaarItemId(row) {
    return Number(row.ID || row.id || row.item_id || row.item?.id || row.item?.ID || 0);
}

const bFiltered = bazaar.filter((r) => sel.has(bazaarItemId(r)));
const imFiltered = im.filter((r) => sel.has(Number(r.item?.id || r.item?.ID || 0)));

console.log('selected items:', [...sel].join(', '));
console.log('bazaar total:', bazaar.length, 'matching selected:', bFiltered.length);
if (bazaar[0]) console.log('bazaar row keys:', Object.keys(bazaar[0]).join(', '));
if (bFiltered[0]) console.log('bazaar sample id:', bazaarItemId(bFiltered[0]), 'price:', bFiltered[0].price);
console.log('itemmarket total:', im.length, 'matching selected:', imFiltered.length);
