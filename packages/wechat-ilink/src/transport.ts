import { IlinkApiClient, type IlinkApiClientOptions } from "./apiClient.js";
import { IlinkAuthorization } from "./auth.js";
import { decodeInboundMessage } from "./codec.js";
import { WechatIlinkError } from "./errors.js";
import type {
  WechatAuthChallenge,
  WechatAuthorizationObserver,
  WechatCredentials,
  WechatPollResult,
  WechatSendRequest,
  WechatSendResult,
} from "./types.js";

export interface WechatTransport {
  beginAuthorization(signal: AbortSignal): Promise<WechatAuthChallenge>;
  waitAuthorization(
    challenge: WechatAuthChallenge,
    signal: AbortSignal,
  ): Promise<WechatCredentials>;
  poll(cursor: string, signal: AbortSignal): Promise<WechatPollResult>;
  sendMessage(
    request: WechatSendRequest,
    signal: AbortSignal,
  ): Promise<WechatSendResult>;
  getTypingTicket(
    peerId: string,
    contextToken: string,
    signal: AbortSignal,
  ): Promise<string>;
  setTyping(
    peerId: string,
    ticket: string,
    active: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface TencentIlinkTransportOptions extends IlinkApiClientOptions {
  localTokens?: () => Promise<string[]>;
  authorizationObserver?: WechatAuthorizationObserver;
}

/** Default pure transport; the Desktop host owns all persistence and lifecycle. */
export class TencentIlinkTransport implements WechatTransport {
  private readonly api: IlinkApiClient;
  private readonly authorization: IlinkAuthorization;

  constructor(private readonly options: TencentIlinkTransportOptions) {
    this.api = new IlinkApiClient(options);
    this.authorization = new IlinkAuthorization(
      this.api,
      options.authorizationObserver,
    );
  }

  beginAuthorization(signal: AbortSignal): Promise<WechatAuthChallenge> {
    return Promise.resolve(this.options.localTokens?.() ?? []).then((tokens) =>
      this.authorization.begin(tokens, signal),
    );
  }

  waitAuthorization(
    challenge: WechatAuthChallenge,
    signal: AbortSignal,
  ): Promise<WechatCredentials> {
    return this.authorization.wait(challenge, signal);
  }

  async poll(cursor: string, signal: AbortSignal): Promise<WechatPollResult> {
    const response = await this.api.getUpdates(cursor, signal);
    if (response.ret !== undefined && typeof response.ret !== "number") {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid poll status.",
        true,
      );
    }
    if (
      response.errcode !== undefined &&
      typeof response.errcode !== "number"
    ) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid poll error code.",
        true,
      );
    }
    const ret = typeof response.ret === "number" ? response.ret : 0;
    if (response.errcode === -14) {
      throw new WechatIlinkError(
        "AUTH_REPLACED",
        "The iLink credential is no longer active.",
        false,
      );
    }
    if (ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the poll request.",
        true,
      );
    }
    const messages = this.api
      .messagesFrom(response)
      .map(decodeInboundMessage)
      .filter((message) => message !== null);
    return {
      cursor:
        typeof response.get_updates_buf === "string"
          ? response.get_updates_buf
          : cursor,
      messages,
      suggestedTimeoutMs:
        typeof response.longpolling_timeout_ms === "number"
          ? response.longpolling_timeout_ms
          : undefined,
    };
  }

  async sendMessage(
    request: WechatSendRequest,
    signal: AbortSignal,
  ): Promise<WechatSendResult> {
    await this.api.sendText(request, signal);
    return { clientId: request.clientId };
  }

  async getTypingTicket(
    peerId: string,
    contextToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.api.getConfig(peerId, contextToken, signal);
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the typing configuration request.",
        true,
      );
    }
    if (typeof response.typing_ticket !== "string" || !response.typing_ticket) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink omitted typing_ticket.",
        true,
      );
    }
    return response.typing_ticket;
  }

  setTyping(
    peerId: string,
    ticket: string,
    active: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    return this.api.setTyping(peerId, ticket, active, signal);
  }
}
