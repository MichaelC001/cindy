import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createWechatMcpServer } from '../cindy_wechatMcpServer';

describe('cindy_wechat proactive routing', () => {
  it('sends only to the host-resolved known peer', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'msg-1' }));
    const server = createWechatMcpServer({
      getMostRecentPeerId: () => 'peer-history',
      getPeerId: () => 'peer-session',
      sendMessage,
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'send_message_to_user', args: { text: 'hello' } },
      });
      expect(sendMessage).toHaveBeenCalledWith('peer-session', 'hello');
      expect(JSON.stringify(result)).toContain('msg-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed when no peer has ever been observed', async () => {
    const sendMessage = vi.fn();
    const server = createWechatMcpServer({
      getMostRecentPeerId: () => null,
      getPeerId: () => null,
      sendMessage,
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'send_message_to_user', args: { text: 'hello' } },
      });
      expect(JSON.stringify(result)).toContain('NO_PEER_CONTEXT');
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
