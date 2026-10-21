import { Converter } from 'opencc-js/t2cn';

const simplify = Converter({ from: 't', to: 'cn' });
export const ASR_FIELDS = ['asrModel', 'asrLanguage', 'asrProfile', 'asrHotwords'];
export function asrSettings(raw = {}, previous = {}) {
  const result = {};
  for (const [key, fallback, allowed] of [['asrModel', 'turbo', ['small', 'turbo', 'large-v3']], ['asrLanguage', 'zh', ['zh', 'auto']], ['asrProfile', 'auto', ['auto', 'general', 'bazi']]]) {
    const value = raw[key] ?? previous[key] ?? fallback;
    if (!allowed.includes(value)) throw new Error('语音转写设置无效');
    result[key] = value;
  }
  if (raw.asrHotwords !== undefined && typeof raw.asrHotwords !== 'string') throw new Error('术语提示需为文字');
  const words = String(raw.asrHotwords ?? previous.asrHotwords ?? '').trim();
  if (words.length > 120 || /[\x00-\x1f]/.test(words)) throw new Error('术语提示最多120字，请用逗号分隔，不要输入段落或指令');
  result.asrHotwords = words;
  return result;
}
export function readableTranscript(transcript) {
  return transcript.map(segment => ({ ...segment, text: simplify(segment.text), rawText: segment.text }));
}
