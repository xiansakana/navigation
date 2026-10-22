import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {originDownloadRequest, downloadVideo} from './knowledge-download.js';
// Public test-only certificate/key: never used by an installed worker or server.
const cert = `-----BEGIN CERTIFICATE-----
MIIC7jCCAdagAwIBAgIUToDdBnj0kf9Zbi+swL3wa/rsKWowDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNZG93bmxvYWQudGVzdDAeFw0yNjEwMjEwMzA3MTNaFw0z
NjEwMTkwMzA3MTNaMBgxFjAUBgNVBAMMDWRvd25sb2FkLnRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDRTe3NJEEpPTaLU1lVp9mG+4V+OevWawBW
UsPhk8RBv1vTHY8JFPImkoTmZ0ltBF1DbUY10WjyXBdGanfr675smsXkTgsUGXzw
uSIccZsxxgZXRqfgYpYlrc/WOHG5O/MOSzptpX5wJEZiLkqQo5sj00rGXu6NNx9o
tg8AjwwpCtSGYIhYMdE6Y+jpYAQsn/qAoiJMCxvCtkkZMkoE+5mveWpWlgveUEzA
Roga0JI9bQuZUiioKJuELyjL4XizcAipdyBzTrkPU8Xw1rnmzXCrCvTYrCFspTqk
FvKOYv/RgPsCzLGy+q9LayJtY+xPPqPO78LhR+TZPhiRXOwjZ/jJAgMBAAGjMDAu
MBgGA1UdEQQRMA+CDWRvd25sb2FkLnRlc3QwEgYDVR0TAQH/BAgwBgEB/wIBADAN
BgkqhkiG9w0BAQsFAAOCAQEAk4xXUjanztdX+60ItSs+s3NiYzLnUB3gFBzxaECx
q0xqhp87acQ3tpEjkqftgHFIppDU94uvj5l6+E5Bp04ArdoVwJKJWb3ztqEEtWHu
gXDDUcaPlUKWSDH/8+nk6bvRDpkmjIOjJY/DDfJZN76GuL+Qv5C5jAeeepIJ7Jw7
obMj/Be5rL1LyDXpPq6j3V2wow8inf475opt87knstD8Sv76nR9wiIFfnIVUc6Kh
5vZHq/MuVUpgTNPoj5G2yQApn2HKc9I1XmjM4RCYJciKlunYlrQbTooc8oSeBYfl
RdpAmlZY9A+WlpgvyITy+sBO5iIuC6zyV1XNV/y5TCy6Dg==
-----END CERTIFICATE-----
`;
const key = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDRTe3NJEEpPTaL
U1lVp9mG+4V+OevWawBWUsPhk8RBv1vTHY8JFPImkoTmZ0ltBF1DbUY10WjyXBdG
anfr675smsXkTgsUGXzwuSIccZsxxgZXRqfgYpYlrc/WOHG5O/MOSzptpX5wJEZi
LkqQo5sj00rGXu6NNx9otg8AjwwpCtSGYIhYMdE6Y+jpYAQsn/qAoiJMCxvCtkkZ
MkoE+5mveWpWlgveUEzARoga0JI9bQuZUiioKJuELyjL4XizcAipdyBzTrkPU8Xw
1rnmzXCrCvTYrCFspTqkFvKOYv/RgPsCzLGy+q9LayJtY+xPPqPO78LhR+TZPhiR
XOwjZ/jJAgMBAAECggEAD+oD9cAW8ELGPeu1dCzR/lBrgwB2bRQvr2CVojYxCuq4
2aF6ua8NBl/HmRkrXQ2i5biOSRNGDn9wCZuYyKhhDzLpbwV8FCgn9smszUraCPvM
iaBGrWnxjqXbkqcyBmqHfYO8yo91wKMRcu+gHcVCy4OKQPEA5F3XloeZNmqp+wjD
kYQWm5D5Xxpzn3z9jO2wvG/XDVNxMYij7DYC9FQsEfMAI/uAAm2IjIwnsMKRaw3q
uyrd4Ks9+XrDbi8Q3jPUBiEwfjgCiNbytiMekMTVxaQ12VnY4OTkPt69CRQto4Ma
YYgzTb/OSSivZFRiMuenNfPPF4WYQ2ESFM3x0VdtXQKBgQDrK/iBrEJKm8UT6t8h
PvXdyeTsP3kxHLhVqtImEdFFokmfpW5L6z3ZWsg+en2oXMstFolEjQb/dN/va/rF
yae/2lbCtUaQQ+UanTxljQQZRU4Lq88K4U7aCd1aTE/VeC1oEdLPz2llG4Uk86Lv
xrXBd5T0yGAEqBA/PzxsnsNIowKBgQDj13hOM/ImL3RpHETuIdlKlboagPWo1rQn
Rp1sAtP/ldb12P02ROJQWtKUyrHYRn22YgdB8KNmfYWIInuhozWL9TxIMgKSeudE
x0GEmOfHXqYtk9WGMdrDQQoT+ksggDr4lEQtuHVkPGJJ3nWyBnYthcvg4igNw0WC
TGxLkErzowKBgQDW3mL8383l6zMCwrtB3gu4rCncbRYm+E24AA5oOClUDTZlhjoj
ZXkqKZcB9truxHHi7U9X8d6t8zRTxf3nTxtU4IIa/pPNZitiyL0RL+nJyRfI9B6E
m113PEIhqc3bhiU+i+JoeuKaPa3GGFEL8SvJ65+Ok7GfL4tArl9gAyL8LwKBgF/N
iVuwwgBGcfeEmINdHkYbYS6lzSYaaZQeQDFbmxLcSZAElqxMGLFbDzLbbB6ZvWCE
JbMXYU3GN/C/NycHPovEKX3d8XDwVvB3rFf6B3Owm8WMZPtRWUBCx98Qnqhi4ukF
RwnGhy4HqfiPnwOlbenEWa8MyXTICCE6y0qWuL1rAoGBAIInkW7Wl3axWLXhE/07
YCCIX7IyXolO+im2YGQo8KMevoNwg5U/6AcbSMb0mNyq1adQoAx4aomMPoZC0V3d
IuvCiKVcCi3cP8Dhqb2Fd3hxkeGRnTpDNrTWCh7gSDdB1s1SQ9w4txTG06HEC1A6
JIgHQDDlea+m7KxNc474U/Sh
-----END PRIVATE KEY-----
`;

test('origin transfers preserve authorization/ranges and verify both the CA and Portal hostname', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'origin-download-'));
 let seen=0;const server=https.createServer({key,cert},(req,res)=>{seen++;assert.equal(req.headers.authorization,'Bearer test');assert.equal(req.headers.range,'bytes=3-');res.writeHead(206,{'Content-Range':'bytes 3-5/6'});res.end('def');});
 server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  const caFile=path.join(root,'ca.pem');await fs.writeFile(caFile,cert);
  const origin={address:'127.0.0.1',port:server.address().port,caFile};
  const route='/api/knowledge/worker/jobs/'+'a'.repeat(32)+'/source';
  const portal='https://download.test';const request=originDownloadRequest(portal,origin);
  const options={headers:{Authorization:'Bearer test',Range:'bytes=3-'},signal:AbortSignal.timeout(3000)};
  const response=await request(portal+route,options);assert.equal(response.status,206);assert.equal(await response.text(),'def');
  await assert.rejects(originDownloadRequest('https://wrong.test',origin)('https://wrong.test'+route,options),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');
  await assert.rejects(originDownloadRequest(portal,{...origin,caFile:''})(portal+route,options));
  assert.equal(seen,1,'Untrusted TLS must not reach the authenticated HTTP handler');
  assert.throws(()=>request('https://other.test'+route,options));
  assert.throws(()=>request(portal+'/api/knowledge/worker/claim',{method:'POST',body:'{}'}));
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});

test('stalled bodies abort promptly, retain partial bytes and resume instead of holding a slot indefinitely',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'download-stall-'));const target=path.join(root,'source');const data=Buffer.from('abcdef');let calls=0;const reports=[];
 try {
  await downloadVideo({bytes:6,sourceSha256:crypto.createHash('sha256').update(data).digest('hex')},target,async(range,signal)=>{
   if(++calls===1){assert.equal(range,undefined);return new Response(new ReadableStream({start(c){c.enqueue(data.subarray(0,3));signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}));}
   assert.equal(range,'bytes=3-');return new Response(data.subarray(3),{status:206,headers:{'Content-Range':'bytes 3-5/6'}});
  },undefined,{idleMs:50,retryDelayMs:0,progress:loaded=>reports.push(loaded)});
  assert.equal(calls,2);assert.deepEqual(await fs.readFile(target),data);assert.equal(reports.at(-1),6);
  let attempts=0;await assert.rejects(downloadVideo({bytes:6},target+'-headers',(_range,signal)=>new Promise((_resolve,reject)=>{attempts++;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),undefined,{idleMs:20,retryDelayMs:0}),/已自动续传重试2次/);
  assert.equal(attempts,3);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
