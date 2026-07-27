import { WechatIlinkError } from "./errors.js";
import {
  MessageItemType,
  MessageType,
  type IlinkCdnMedia,
  type IlinkMessage,
  type WechatInboundMessage,
  type WechatMediaRef,
} from "./types.js";

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Converted to the stable package error below.
  }
  throw new WechatIlinkError(
    "BAD_RESPONSE",
    "iLink returned invalid JSON.",
    true,
  );
}

function mediaBase(
  kind: WechatMediaRef["kind"],
  media?: IlinkCdnMedia,
): WechatMediaRef {
  return {
    kind,
    downloadUrl: media?.full_url,
    encryptedQuery: media?.encrypt_query_param,
    aesKeyBase64: media?.aes_key,
  };
}

export function decodeInboundMessage(
  message: IlinkMessage,
): WechatInboundMessage | null {
  if (!message || typeof message !== "object") return null;
  if (message.message_type != null && message.message_type !== MessageType.USER)
    return null;
  const senderId =
    typeof message.from_user_id === "string" ? message.from_user_id.trim() : "";
  const recipientId =
    typeof message.to_user_id === "string" ? message.to_user_id.trim() : "";
  const contextToken =
    typeof message.context_token === "string"
      ? message.context_token.trim()
      : "";
  const messageId =
    typeof message.message_id === "number" &&
    Number.isSafeInteger(message.message_id)
      ? String(message.message_id)
      : "";
  if (!senderId || !recipientId || !contextToken || !messageId) return null;

  const textParts: string[] = [];
  const media: WechatMediaRef[] = [];
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case MessageItemType.TEXT:
        if (typeof item.text_item?.text === "string" && item.text_item.text) {
          textParts.push(item.text_item.text);
        }
        break;
      case MessageItemType.IMAGE:
        media.push({
          ...mediaBase("image", item.image_item?.media),
          aesKeyHex: item.image_item?.aeskey,
        });
        break;
      case MessageItemType.VOICE:
        if (typeof item.voice_item?.text === "string" && item.voice_item.text) {
          textParts.push(item.voice_item.text);
        }
        media.push({
          ...mediaBase("voice", item.voice_item?.media),
          voiceEncoding: item.voice_item?.encode_type,
          transcript: item.voice_item?.text,
        });
        break;
      case MessageItemType.FILE:
        media.push({
          ...mediaBase("file", item.file_item?.media),
          fileName: item.file_item?.file_name,
          byteLength:
            typeof item.file_item?.len === "string"
              ? Number(item.file_item.len) || undefined
              : undefined,
        });
        break;
      case MessageItemType.VIDEO:
        media.push({
          ...mediaBase("video", item.video_item?.media),
          byteLength: item.video_item?.video_size,
        });
        break;
    }
  }

  return {
    messageId,
    senderId,
    recipientId,
    clientId: message.client_id,
    createdAt: message.create_time_ms,
    contextToken,
    text: textParts.join("\n"),
    media,
  };
}
