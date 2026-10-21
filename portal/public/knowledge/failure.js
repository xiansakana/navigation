export function interruptedTransfer(error) {
  return /^(terminated|fetch failed)$/i.test(String(error?.message || error).trim()) || ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code || error?.code);
}
export function failureMessage(error, stage = '') {
  const message = String(error?.message || error || '处理失败');
  if (!interruptedTransfer(error)) return message;
  const phase = stage && !['处理失败', 'media'].includes(stage) ? '在“' + stage + '”阶段，' : '';
  return phase + '网络连接在传输完成前中断（' + (/terminated/i.test(message) ? 'terminated' : '连接异常') + '）。可能与网络、代理或服务重启有关；现有记录无法确定具体原因。可点击一键重试。';
}
