import { createCodexService as createService } from '../../shared/codex/codex-service.js';
import { codexQqChunks } from './codex-text.js';
import { getPostgresMonitoring } from './postgres.js';
export { codexEvent, authorizedCodexUser } from '../../shared/codex/codex-service.js';
export const createCodexService = options => createService({ formatReply: codexQqChunks, getPostgresDatabase: getPostgresMonitoring, ...options });
