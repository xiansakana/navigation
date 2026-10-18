import { createCodexService as createService } from '../../shared/codex/codex-service.js';
import { codexQqChunks } from './codex-text.js';
export { codexEvent, authorizedCodexUser } from '../../shared/codex/codex-service.js';
export const createCodexService = options => createService({ formatReply: codexQqChunks, ...options });
