/**
 * 子路径部署支持：构建时注入 NEXT_PUBLIC_BASE_PATH（如 /tv），为空则部署在根路径。
 * Next 会自动给 Link/router/静态资源加前缀，但手写的 fetch('/api/...') 不会，
 * 统一走 withBasePath() 包一层。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export function withBasePath(path: string): string {
  return BASE_PATH && path.startsWith('/') ? `${BASE_PATH}${path}` : path;
}
