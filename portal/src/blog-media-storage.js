import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, ListObjectVersionsCommand, AbortMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { readPiclistConfig } from './piclist-admin.js';
import { makeThumbnail, withMediaProcessor, uploadDirectory, removeUploadFiles, compressVideo } from './blog-media-process.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../piclist');
const envPath = process.env.PICLIST_ENV_PATH || path.join(process.env.PICLIST_ROOT || root, '.env');
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const VIDEO_TYPES = new Map([['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']]);
let sharedConnection;

function acquireStorageConnection(setting) {
    const options = { region: setting.region, endpoint: setting.endpoint,
        forcePathStyle: setting.pathStyleAccess !== false,
        credentials: { accessKeyId: setting.accessKeyID, secretAccessKey: setting.secretAccessKey } };
    const signature = crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex');
    if (!sharedConnection || sharedConnection.signature !== signature) {
        if (sharedConnection) {
            sharedConnection.retired = true;
            if (!sharedConnection.users) sharedConnection.client.destroy();
        }
        sharedConnection = { signature, client: new S3Client(options), users: 0, retired: false };
    }
    const connection = sharedConnection;
    connection.users++;
    let released = false;
    return { client: connection.client, release() {
        if (released) return;
        released = true;
        connection.users--;
        if (connection.retired && !connection.users) connection.client.destroy();
    } };
}

function profile() {
    const doc = readPiclistConfig();
    const name = doc.picBed?.current || doc.picBed?.uploader;
    const value = doc.picBed?.[name];
    if (!value?.bucketName || !value?.endpoint || !value?.urlPrefix) throw new Error('PicList B2 配置不完整');
    return value;
}

export function normalizeMediaPosition(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('媒体顺序参数无效');
    return value;
}

export function videoStorage(mimeType, existingKey) {
    const extension = VIDEO_TYPES.get(mimeType);
    if (!extension) throw new Error('仅支持 MP4、WebM、MOV 视频');
    const setting = profile();
    if (!setting.accessKeyID || !setting.secretAccessKey) throw new Error('B2 凭据未配置');
    const key = existingKey || `blog/video/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;
    return { ...acquireStorageConnection(setting), bucket: setting.bucketName, key, mimeType, url: setting.urlPrefix.replace(/\/$/, '') + '/' + key };
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
    const thumbnailData = await withMediaProcessor(async () => {
        const id = crypto.randomUUID().replaceAll('-', ''), directory = uploadDirectory(id);
        try {
            await fs.promises.mkdir(directory, { recursive: true });
            const input = path.join(directory, 'source.jpg');
            await fs.promises.writeFile(input, bytes);
            return await makeThumbnail(input, path.join(directory, 'thumbnail.jpg'));
        } catch { return null; }
        finally { await removeUploadFiles(id); }
    });
    return { kind: 'image', mimeType: 'image/jpeg', url, storageKey: decodeURIComponent(url.slice(base.href.length)), thumbnailData };
}

export async function uploadCompressedVideo(file, progress = () => {}, existingKey) {
    const storage = videoStorage('video/mp4', existingKey);
    try {
        const upload = new Upload({ client: storage.client, params: { Bucket: storage.bucket, Key: storage.key,
            Body: fs.createReadStream(file), ContentType: 'video/mp4' }, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
        upload.on('httpUploadProgress', event => progress(event.total ? Math.round(event.loaded / event.total * 100) : 0));
        await upload.done();
        return { kind: 'video', mimeType: 'video/mp4', url: storage.url, storageKey: storage.key };
    } finally { storage.release(); }
}

export async function uploadVideo(req) {
    const mimeType = req.headers['content-type']?.split(';')[0];
    if (!VIDEO_TYPES.has(mimeType)) throw new Error('仅支持 MP4、WebM、MOV 视频');
    const id = crypto.randomUUID().replaceAll('-', ''), directory = uploadDirectory(id);
    const { pipeline } = await import('node:stream/promises');
    try {
        await fs.promises.mkdir(directory, { recursive: true });
        const input = path.join(directory, 'source');
        await pipeline(req, fs.createWriteStream(input));
        return await withMediaProcessor(async () => {
            const output = path.join(directory, 'compressed.mp4');
            await compressVideo(input, output);
            const thumbnailData = await makeThumbnail(output, path.join(directory, 'thumbnail.jpg'));
            return { ...await uploadCompressedVideo(output), thumbnailData };
        });
    } finally { await removeUploadFiles(id); }
}

export async function deleteMediaVersions(client, bucket, key, canDelete = () => true) {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('媒体存储路径无效');
    const versions = [], markers = [];
    let keyMarker, versionIdMarker;
    do {
        if (!canDelete(key)) return;
        const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
        versions.push(...(page.Versions || []).filter(item => item.Key === key));
        markers.push(...(page.DeleteMarkers || []).filter(item => item.Key === key));
        if (!page.IsTruncated) break;
        if (!page.NextKeyMarker || (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionIdMarker)) throw new Error('媒体版本分页无效');
        keyMarker = page.NextKeyMarker; versionIdMarker = page.NextVersionIdMarker;
    } while (true);
    // Delete data versions before hide markers; never delete objects sharing a prefix.
    for (const item of [...versions, ...markers]) {
        if (!canDelete(key)) return;
        if (!item.VersionId) throw new Error('媒体版本编号缺失');
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: item.VersionId }));
    }
}

export async function deleteStoredMedia(items, options = {}) {
    if (!items.length) return;
    const storage = videoStorage('video/webm', items[0].storageKey);
    try {
        for (const item of items) await deleteMediaVersions(storage.client, storage.bucket, item.storageKey, options.canDelete);
    } finally { storage.release(); }
}

export async function abortStoredUpload(item) {
    const storage = videoStorage('video/webm', item.storageKey);
    try {
        await storage.client.send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: item.storageKey, UploadId: item.multipartId }));
    } catch (error) { if (error.name !== 'NoSuchUpload') throw error; }
    finally { storage.release(); }
}
