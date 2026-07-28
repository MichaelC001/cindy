/**
 * 平台代发 GitHub Issue 时公开署名的跨进程契约。
 *
 * github-server 会把 userName 原样写进 Markdown 正文，因此这里同时限制长度与
 * 单行纯文本形状。Renderer 用它控制提交状态，Main 在 IPC 边界再次校验。
 */
export const ISSUE_PUBLIC_NAME_MAX = 100;

export function normalizeIssuePublicName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ISSUE_PUBLIC_NAME_MAX) {
    return null;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}
