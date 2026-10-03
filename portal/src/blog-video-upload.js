import crypto from 'node:crypto';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { videoStorage, normalizeMediaPosition } from './blog-media-storage.js';

export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;

export function validateVideoUpload(size, mimeType) {
  if (!Number.isSafeInteger(size) || size < 12 || Math.ceil(size / VIDEO_CHUNK_BYTES) > 10000) throw new Error('视频文件大小无效');
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(mimeType)) throw new Error('仅支持 MP4、WebM、MOV 视频');
}

export async function startVideoUpload(db, postId, userId, size, mimeType, position = null) {
  position = normalizeMediaPosition(position);
  validateVideoUpload(size, mimeType);
  const storage = videoStorage(mimeType);
  let uploadId;
  try {
    const result = await storage.client.send(new CreateMultipartUploadCommand({ Bucket: storage.bucket, Key: storage.key, ContentType: mimeType }));
    uploadId = result.UploadId;
    if (!uploadId) throw new Error('无法创建视频上传');
    const id = crypto.randomUUID().replaceAll('-', '');
    db.prepare('INSERT INTO blog_video_uploads (id, post_id, user_id, mime_type, byte_size, storage_key, multipart_id, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, postId, userId, mimeType, size, storage.key, uploadId, new Date().toISOString(), position);
    return { id, chunkBytes: VIDEO_CHUNK_BYTES };
  } catch (error) {
    if (uploadId) await storage.client.send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: storage.key, UploadId: uploadId })).catch(() => {});
    throw error;
  } finally { storage.release(); }
}

export function findVideoUpload(db, id, session) {
  const row = db.prepare('SELECT * FROM blog_video_uploads WHERE id = ? AND user_id = ?').get(id, session.userId);
  if (!row || session.isGuest) return null;
  return row;
}

export function validateVideoPart(upload, number, bytes) {
  const count = Math.ceil(upload.byte_size / VIDEO_CHUNK_BYTES);
  if (!Number.isInteger(number) || number < 1 || number > count) throw new Error('视频分段编号无效');
  const expected = number === count ? upload.byte_size - (number - 1) * VIDEO_CHUNK_BYTES : VIDEO_CHUNK_BYTES;
  if (bytes.length !== expected) throw new Error('视频分段大小不符');
  if (number === 1) {
    const valid = upload.mime_type === 'video/webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : bytes.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) throw new Error('视频内容与格式不符');
  }
}

export async function writeVideoPart(db, upload, number, req) {
  const parts = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > VIDEO_CHUNK_BYTES) throw new Error('视频分段过大');
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  validateVideoPart(upload, number, bytes);
  const storage = videoStorage(upload.mime_type, upload.storage_key);
  try {
    const result = await storage.client.send(new UploadPartCommand({ Bucket: storage.bucket, Key: storage.key, UploadId: upload.multipart_id,
      PartNumber: number, Body: bytes, ContentLength: bytes.length }));
    if (!result.ETag) throw new Error('视频分段上传失败');
    if (!db.prepare('SELECT 1 FROM blog_video_uploads WHERE id = ?').get(upload.id)) throw new Error('视频上传已取消');
    db.prepare('INSERT INTO blog_video_parts (upload_id, part_number, etag, byte_size) VALUES (?, ?, ?, ?) ON CONFLICT(upload_id, part_number) DO UPDATE SET etag = excluded.etag, byte_size = excluded.byte_size')
      .run(upload.id, number, result.ETag, size);
  } finally { storage.release(); }
}

export function completedVideoParts(db, upload) {
  const rows = db.prepare('SELECT part_number, etag, byte_size FROM blog_video_parts WHERE upload_id = ? ORDER BY part_number').all(upload.id);
  if (rows.length !== Math.ceil(upload.byte_size / VIDEO_CHUNK_BYTES) || rows.some((row, index) => row.part_number !== index + 1)
    || rows.reduce((total, row) => total + row.byte_size, 0) !== upload.byte_size) throw new Error('视频分段尚未上传完成');
  return rows.map(row => ({ PartNumber: row.part_number, ETag: row.etag }));
}

export async function finishVideoUpload(db, upload) {
  const parts = completedVideoParts(db, upload);
  const storage = videoStorage(upload.mime_type, upload.storage_key);
  try {
    await storage.client.send(new CompleteMultipartUploadCommand({ Bucket: storage.bucket, Key: storage.key, UploadId: upload.multipart_id, MultipartUpload: { Parts: parts } }));
    return { kind: 'video', mimeType: upload.mime_type, url: storage.url, storageKey: storage.key };
  } finally { storage.release(); }
}

export function forgetVideoUpload(db, id) {
  db.prepare('DELETE FROM blog_video_parts WHERE upload_id = ?').run(id);
  db.prepare('DELETE FROM blog_video_uploads WHERE id = ?').run(id);
}

export async function abortVideoUpload(db, upload) {
  const storage = videoStorage(upload.mime_type, upload.storage_key);
  try {
    await storage.client.send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: storage.key, UploadId: upload.multipart_id }));
    forgetVideoUpload(db, upload.id);
  } catch (error) {
    if (error.name === 'NoSuchUpload') forgetVideoUpload(db, upload.id);
    else throw error;
  } finally { storage.release(); }
}
