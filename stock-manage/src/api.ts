/** 相对路径 API，兼容 portal 反代下的 `<base href="/stock-manage/">` */
export function apiUrl(path: string): string {
  const clean = path.replace(/^\//, '');
  return clean;
}
