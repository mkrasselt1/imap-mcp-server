import type { ImapFlow } from "imapflow";
import { getImapClient } from "../../imap/client.js";
import { mapAddresses, parseMessage, MAX_BODY_CHARS, READ_FETCH_BYTES } from "../../imap/parse.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

async function readSingleMessage(client: ImapFlow, uid: number) {
  const msg: any = await client.fetchOne(String(uid), {
    envelope: true,
    flags: true,
    uid: true,
    size: true,
    source: { maxLength: READ_FETCH_BYTES },
  } as any, { uid: true });

  if (!msg) throw new Error(`Message UID ${uid} not found`);

  const parsed = await parseMessage(msg.source, MAX_BODY_CHARS);
  const envelope = msg.envelope;

  return {
    uid: msg.uid,
    subject: envelope?.subject || "(no subject)",
    from: mapAddresses(envelope?.from),
    to: mapAddresses(envelope?.to),
    cc: mapAddresses(envelope?.cc),
    replyTo: parsed.replyTo,
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    flags: Array.from(msg.flags || []),
    size: msg.size ?? null,
    body: parsed.body || "(no text content)",
    bodyTruncated: parsed.truncated || (msg.size ?? 0) > READ_FETCH_BYTES,
    attachments: parsed.attachments,
    inReplyTo: envelope?.inReplyTo || null,
    references: parsed.references || null,
    messageId: envelope?.messageId || null,
  };
}

export async function readMessage(ctx: TokenContext, args: { folder?: string; uid?: number; uids?: number[] }) {
  checkPermission(ctx.scopes, "mail:read");
  const uidList = args.uids && args.uids.length > 0
    ? [...new Set(args.uids)].slice(0, 10)
    : (args.uid !== undefined ? [args.uid] : []);
  if (uidList.length === 0) throw new Error("Provide 'uid' or 'uids'");

  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";

  // readOnly: reading via MCP must not silently mark messages as \Seen
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    if (uidList.length === 1) {
      return await readSingleMessage(client, uidList[0]);
    }
    const messages = [];
    for (const uid of uidList) {
      try {
        messages.push(await readSingleMessage(client, uid));
      } catch (e: any) {
        messages.push({ uid, error: e.message });
      }
    }
    return { messages };
  } finally {
    lock.release();
  }
}
