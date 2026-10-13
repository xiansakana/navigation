import fs from 'node:fs';
import path from 'node:path';
import { getDatabase, getDbPath, closeDatabase } from '../shared/db/index.js';
import { createBookkeepingStore } from '../portal/src/bookkeeping-store.js';

// Private screenshot values travel through stdin, never through Git or command arguments.
const args=process.argv.slice(2), userId=args[args.indexOf('--user-id')+1];
if(!args.includes('--user-id') || !userId || userId.startsWith('--'))throw new Error('需要 --user-id');
let input='';for await(const chunk of process.stdin)input+=chunk;
const rows=JSON.parse(input), db=getDatabase(), store=createBookkeepingStore(db), apply=args.includes('--apply');
try {
  const preview=store.importBalanceAdjustments(userId,rows);
  if(apply) {
    const dir=path.join(path.dirname(getDbPath()),'bookkeeping-backups');fs.mkdirSync(dir,{recursive:true});
    const backup=path.join(dir,'before-adjustments-'+Date.now()+'.json');
    fs.writeFileSync(backup,JSON.stringify(store.backup(userId)),{encoding:'utf8',mode:0o600});
    const before=JSON.stringify(store.accounts(userId)), result=store.importBalanceAdjustments(userId,rows,{apply:true});
    if(JSON.stringify(store.accounts(userId))!==before)throw new Error('账户当前余额核对失败');
    console.log(JSON.stringify({...result,backup,balancesUnchanged:true}));
  } else console.log(JSON.stringify(preview));
} finally {closeDatabase();}
