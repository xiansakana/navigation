import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../config.json');

export function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(
            '未找到 config.json，请复制 config.example.json 为 config.json 并填写 NapCat 地址与 QQ 号'
        );
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
