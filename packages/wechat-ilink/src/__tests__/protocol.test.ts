import { describe, expect, it, vi } from "vitest";
import {
  IlinkApiClient,
  TencentIlinkTransport,
  WechatIlinkError,
  aes128EcbPaddedSize,
  chunkWechatText,
  decodeInboundMessage,
  decryptAes128Ecb,
  encryptAes128Ecb,
  filterWechatMarkdown,
} from "../index.js";

const signal = () => new AbortController().signal;

describe("pure protocol utilities", () => {
  it("round-trips AES-128-ECB and validates padded sizes", () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    const input = Buffer.from("Cindy WeChat");
    const encrypted = encryptAes128Ecb(input, key);
    expect(Buffer.from(decryptAes128Ecb(encrypted, key))).toEqual(input);
    expect(aes128EcbPaddedSize(0)).toBe(16);
    expect(aes128EcbPaddedSize(16)).toBe(32);
  });

  it("chunks by code point rather than splitting surrogate pairs", () => {
    expect(chunkWechatText("A😀B", 2)).toEqual(["A😀", "B"]);
    const softBoundary = chunkWechatText("abcd efgh", 6);
    expect(softBoundary).toEqual(["abcd ", "efgh"]);
    expect(softBoundary.join("")).toBe("abcd efgh");
    const fenced = chunkWechatText(
      "before\n```ts\nconst value = 1234567890;\n```\nafter",
      24,
    );
    expect(fenced.length).toBeGreaterThan(1);
    expect(fenced.every((chunk) => Array.from(chunk).length <= 24)).toBe(true);
    expect(fenced[0]).toMatch(/\n```$/);
    expect(fenced[1]).toMatch(/^```\n/);
  });

  it("filters unsupported markdown without changing code or bold", () => {
    expect(
      filterWechatMarkdown("##### 标题\n*中文* **保留** ![x](https://x)"),
    ).toBe("标题\n中文 **保留** ");
    expect(
      filterWechatMarkdown(
        "```\n##### untouched ![x](url)\n```\n`*中文*` *中文*",
      ),
    ).toBe("```\n##### untouched ![x](url)\n```\n`*中文*` 中文");
  });

  it("rejects incomplete inbound messages before they reach the host", () => {
    expect(decodeInboundMessage({ message_id: 1 })).toBeNull();
    expect(
      decodeInboundMessage({
        message_id: 1,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      }),
    ).toMatchObject({ messageId: "1", senderId: "user", text: "hello" });
    expect(
      decodeInboundMessage({
        message_id: 2,
        message_type: 2,
        from_user_id: "bot",
        to_user_id: "user",
        context_token: "ctx",
      }),
    ).toBeNull();
    expect(
      decodeInboundMessage({
        message_id: 3,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [null] as never,
      }),
    ).toMatchObject({ messageId: "3", media: [] });
  });
});

describe("iLink HTTP boundary", () => {
  it("builds authenticated poll requests without exposing response bodies in errors", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer fake-token",
          AuthorizationType: "ilink_bot_token",
        });
        expect(init?.redirect).toBe("manual");
        return new Response(
          JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }),
        );
      },
    );
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: fetchMock,
    });
    await expect(transport.poll("old", signal())).resolves.toEqual({
      cursor: "next",
      messages: [],
      suggestedTimeoutMs: undefined,
    });
  });

  it("maps HTTP failures to stable secret-free errors", async () => {
    const api = new IlinkApiClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "top-secret",
      botAgent: "Cindy/1.0.0",
      fetch: async () => new Response("token=top-secret", { status: 503 }),
    });
    await expect(api.getUpdates("", signal())).rejects.toMatchObject({
      code: "HTTP_ERROR",
      retryable: true,
    } satisfies Partial<WechatIlinkError>);
    await expect(api.getUpdates("", signal())).rejects.not.toThrow(
      /top-secret/,
    );
  });

  it("builds deterministic text messages and includes the declared client identity", async () => {
    let request: RequestInit | undefined;
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      clientVersion: "1.1.21",
      botAgent: "Cindy/1.1.21 invalid",
      fetch: async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({ ret: 0 }));
      },
    });
    await expect(
      transport.sendMessage(
        {
          peerId: "peer",
          text: "hello",
          contextToken: "context",
          clientId: "stable-client-id",
          runId: "run",
        },
        signal(),
      ),
    ).resolves.toEqual({ clientId: "stable-client-id" });

    expect(request?.headers).toMatchObject({
      "iLink-App-ClientVersion": String((1 << 16) | (1 << 8) | 21),
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      msg: {
        to_user_id: "peer",
        client_id: "stable-client-id",
        context_token: "context",
      },
      base_info: {
        channel_version: "1.1.21",
        bot_agent: "Cindy/1.1.21",
      },
    });
  });

  it("maps stale credentials and malformed message lists to stable errors", async () => {
    const responses = [
      { ret: 1, errcode: -14 },
      { ret: 0, msgs: "not-an-array" },
    ];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async () => new Response(JSON.stringify(responses.shift())),
    });
    await expect(transport.poll("", signal())).rejects.toMatchObject({
      code: "AUTH_REPLACED",
      retryable: false,
    });
    await expect(transport.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });

  it("propagates host cancellation instead of treating it as a long-poll timeout", async () => {
    const controller = new AbortController();
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    const pending = transport.poll("", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects oversized responses and bounded poll collections", async () => {
    const oversized = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxResponseBytes: 16,
      fetch: async () =>
        new Response(JSON.stringify({ ret: 0, padding: "x".repeat(100) })),
    });
    await expect(oversized.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });

    const tooMany = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxPollMessages: 1,
      fetch: async () =>
        new Response(JSON.stringify({ ret: 0, msgs: [{}, {}] })),
    });
    await expect(tooMany.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });

    const tooManyItems = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxItemsPerMessage: 1,
      fetch: async () =>
        new Response(
          JSON.stringify({ ret: 0, msgs: [{ item_list: [{}, {}] }] }),
        ),
    });
    await expect(tooManyItems.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
});
