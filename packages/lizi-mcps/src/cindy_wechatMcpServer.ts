import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { WechatBotMcpHostDeps } from './types.js';

const MAX_MESSAGE_CHARS = 30_000;

/**
 * In-process MCP bridge for proactive personal WeChat messages.
 *
 * The host resolves the receiver from the current WeChat session or the most
 * recent peer seen by the active binding. The model never supplies an
 * arbitrary peer id, so this tool cannot be used to probe or message unknown
 * WeChat users.
 */
export function createWechatMcpServer(
  deps: WechatBotMcpHostDeps & { getPeerId: () => Promise<string | null> | string | null },
): McpServer {
  const server = new McpServer({ name: 'cindy_wechat', version: '1.0.0' });

  server.tool(
    'list_tools',
    '列出个人微信可用工具。使用 call_tool 调用具体工具。',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            tools: [
              {
                name: 'send_message_to_user',
                description: '向当前个人微信会话对应的历史联系人发送一条文本消息。',
              },
            ],
          }),
        },
      ],
    }),
  );

  server.tool(
    'call_tool',
    '调用个人微信工具。先用 list_tools 获取工具名。',
    {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    },
    async ({ name, args }) => {
      if (name !== 'send_message_to_user') {
        return result({ ok: false, errorCode: 'UNKNOWN_TOOL', error: name }, true);
      }
      const parsed = z
        .object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS) })
        .safeParse(args);
      if (!parsed.success || parsed.data.text.trim().length === 0) {
        return result({ ok: false, errorCode: 'INVALID_ARGS', error: 'text 不能为空' }, true);
      }
      const peerId = await deps.getPeerId();
      if (!peerId) {
        return result(
          {
            ok: false,
            errorCode: 'NO_PEER_CONTEXT',
            error: '当前绑定尚未收到过微信消息，无法确定安全的发送目标。',
          },
          true,
        );
      }
      try {
        const sent = await deps.sendMessage(peerId, parsed.data.text);
        return sent.ok
          ? result({ ok: true, messageId: sent.messageId })
          : result({ ok: false, errorCode: 'SEND_FAILED', error: sent.reason ?? 'unknown' }, true);
      } catch (error) {
        deps.logger?.warn?.(
          'send_message_to_user failed peer=...%s detail=%s',
          peerId.slice(-8),
          error instanceof Error ? error.message : String(error),
        );
        return result({ ok: false, errorCode: 'SEND_FAILED', error: 'WeChat send failed' }, true);
      }
    },
  );

  return server;
}

function result(payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
