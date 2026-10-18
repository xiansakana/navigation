import { createCodexStore as createStore } from '../../shared/codex/codex-store.js';
import { codexQqChunks } from './codex-text.js';
export const createCodexStore = db => createStore(db, { formatReply: codexQqChunks });
