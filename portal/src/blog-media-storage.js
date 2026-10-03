import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { readPiclistConfig } from './piclist-admin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../piclist');
const envPath = process.env.PICLIST_ENV_PATH || path.join(process.env.PICLIST_ROOT || root, '.env');
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const VIDEO_TYPES = new Map([['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']]);

function profile() {
    const doc = readPiclistConfig();
    const name = doc.picBed?.current || doc.picBed?.uploader;
    const value = doc.picBed?.[name];
    if (!value?.bucketName || !value?.endpoint || !value?.urlPrefix) throw new Error('PicList B2 配置不完整');
    return value;
}

function readServerKey() {
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
        .find(item => item.trim().startsWith('PICLIST_SERVER_KEY='));
    const key = line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!key) throw new Error('PicList 上传密钥未配置');
    return key;
}

async function readImage(req) {
    const parts = [];
    let size = 0;
    for await (const part of req) {
        size += part.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('转换后的 JPG 过大（超过 80MB）');
        parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
        || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('仅接受 JPG 图片');
    return bytes;
}

export async function uploadImage(req, service) {
    if (req.headers['content-type']?.split(';')[0] !== 'image/jpeg') throw new Error('仅接受 JPG 图片');
    const bytes = await readImage(req);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), `blog-${crypto.randomUUID()}.jpg`);
    const endpoint = new URL('/upload', service?.internalUrl || 'http://127.0.0.1:36677');
    endpoint.searchParams.set('key', readServerKey());
    const response = await fetch(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true || !Array.isArray(result.result) || !result.result[0]) {
        throw new Error('PicList 图片上传失败');
    }
    const url = result.result[0];
    const base = new URL(profile().urlPrefix.replace(/\/$/, '') + '/');
    if (!url.startsWith(base.href)) throw new Error('PicList 返回了意外的图片地址');
    return { kind: 'image', mimeType: 'image/jpeg', url, storageKey: decodeURIComponent(url.slice(base.href.length)) };
}

export async function uploadVideo(req) {
    const mimeType = req.headers['content-type']?.split(';')[0];
    const extension = VIDEO_TYPES.get(mimeType);
    if (!extension) throw new Error('仅支持 MP4、WebM、MOV 视频');
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 12) throw new Error('视频文件大小无效');
    const first = await new Promise((resolve, reject) => {
        req.once('data', resolve);
        req.once('end', () => reject(new Error('视频文件为空')));
        req.once('error', reject);
    });
    req.pause();
    const head = first.subarray(0, 12);
    const valid = mimeType === 'video/webm'
        ? head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        : head.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) throw new Error('视频内容与格式不符');
    const { PassThrough } = await import('node:stream');
    const stream = new PassThrough();
    stream.write(first);
    req.pipe(stream);
    req.resume();
    const setting = profile();
    if (!setting.accessKeyID || !setting.secretAccessKey) throw new Error('B2 凭据未配置');
    const key = `blog/video/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;
    const client = new S3Client({
        region: setting.region,
        endpoint: setting.endpoint,
        forcePathStyle: setting.pathStyleAccess !== false,
        credentials: { accessKeyId: setting.accessKeyID, secretAccessKey: setting.secretAccessKey }
    });
    try {
        const upload = new Upload({ client, params: {
            Bucket: setting.bucketName, Key: key, Body: stream, ContentType: mimeType
        }, queueSize: 2, partSize: 10 * 1024 * 1024, leavePartsOnError: false });
        await upload.done();
    } finally {
        client.destroy();
    }
    return { kind: 'video', mimeType, url: setting.urlPrefix.replace(/\/$/, '') + '/' + key, storageKey: key };
}

export async function deleteStoredMedia(items) {
    if (!items.length) return;
    const setting = profile();
    const client = new S3Client({
        region: setting.region,
        endpoint: setting.endpoint,
        forcePathStyle: setting.pathStyleAccess !== false,
        credentials: { accessKeyId: setting.accessKeyID, secretAccessKey: setting.secretAccessKey }
    });
    try {
        for (const item of items) {
            if (!item.storageKey || item.storageKey.includes('..') || item.storageKey.startsWith('/')) continue;
            await client.send(new DeleteObjectCommand({ Bucket: setting.bucketName, Key: item.storageKey }));
        }
    } finally { client.destroy(); }
}
