import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const mediaWorkRoot = process.env.BLOG_MEDIA_WORK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/blog-media');
export function uploadDirectory(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('上传编号无效');
  return path.join(mediaWorkRoot, id);
}
export async function removeUploadFiles(id) { await fsp.rm(uploadDirectory(id), { recursive: true, force: true }); }

let tail = Promise.resolve();
export function withMediaProcessor(operation) {
  const result = tail.then(operation);
  tail = result.catch(() => {});
  return result;
}

export function runMediaCommand(binary, args, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 6 * 3600000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); onOutput(String(chunk)); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
    child.once('error', error => { clearTimeout(timeout); reject(new Error('媒体处理程序无法启动：' + error.message)); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error('媒体处理失败：' + diagnostic.slice(-500)));
    });
  });
}
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
export function compressionArguments(input, output) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-threads', '1', '-filter_threads', '1',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', output];
}
export async function makeThumbnail(input, output) {
  await runMediaCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,jpeg_pipe,png_pipe,mjpeg,image2', '-i', input,
    '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-threads', '1', '-filter_threads', '1', '-q:v', '5', output]);
  const bytes = await fsp.readFile(output);
  if (!bytes.length || bytes.length > 200000) throw new Error('缩略图生成失败');
  return bytes;
}
export async function compressVideo(input, output, progress = () => {}) {
  const info = JSON.parse(await runMediaCommand(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-show_entries', 'format=duration', '-of', 'json', input]));
  const duration = Number(info.format?.duration);
  let pending = '';
  await runMediaCommand(ffmpeg, compressionArguments(input, output), chunk => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) if (line.startsWith('out_time_us=') && duration > 0) {
      progress(Math.min(99, Math.max(0, Math.round(Number(line.slice(12)) / 1000000 / duration * 100))));
    }
  });
  const stat = await fsp.stat(output);
  if (stat.size < 12) throw new Error('视频压缩结果为空');
  return stat.size;
}

export async function joinVideoParts(upload, parts) {
  const directory = uploadDirectory(upload.id);
  const input = path.join(directory, 'source');
  const target = await fsp.open(input, 'w');
  try {
    for (const part of parts) {
      for await (const bytes of fs.createReadStream(path.join(directory, String(part.PartNumber)))) {
        await target.writeFile(bytes);
      }
    }
    return input;
  } finally { await target.close(); }
}

let thumbnailsBusy = false;
export async function backfillThumbnails(db) {
  if (thumbnailsBusy) return;
  thumbnailsBusy = true;
  try {
    const items = db.prepare('SELECT id, url, kind FROM blog_media WHERE thumbnail_data IS NULL AND thumbnail_attempts < 3 LIMIT 2').all();
    for (const item of items) {
      await withMediaProcessor(async () => {
        const directory = uploadDirectory(item.id);
        try {
          await fsp.mkdir(directory, { recursive: true });
          // FFmpeg reads only the downloaded local file, never a user-controlled network URL.
          const response = await fetch(item.url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
          if (!response.ok) throw new Error('媒体读取失败');
          const { Readable } = await import('node:stream');
          const { pipeline } = await import('node:stream/promises');
          const input = path.join(directory, 'thumbnail-source');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(input));
          const bytes = await makeThumbnail(input, path.join(directory, 'thumbnail.jpg'));
          db.prepare('UPDATE blog_media SET thumbnail_data = ? WHERE id = ?').run(bytes, item.id);
        } catch { db.prepare('UPDATE blog_media SET thumbnail_attempts = thumbnail_attempts + 1 WHERE id = ?').run(item.id); }
        finally { await removeUploadFiles(item.id); }
      });
    }
  } finally { thumbnailsBusy = false; }
}
export function startThumbnailWorker(db) {
  setTimeout(() => backfillThumbnails(db).catch(console.error), 3000).unref();
  return setInterval(() => backfillThumbnails(db).catch(console.error), 30000).unref();
}
