import { getImapClient } from "../../imap/client.js";
import { mapAddresses, parseMessage, PREVIEW_FETCH_BYTES } from "../../imap/parse.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

export const PREVIEW_CHARS = 2000;

/** Shared summary builder for list/search results. */
export async function summarize(msg: any, includeBody: boolean) {
  const entry: Record<string, unknown> = {
    uid: msg.uid,
    subject: msg.envelope?.subject || "(no subject)",
    from: mapAddresses(msg.envelope?.from),
    to: mapAddresses(msg.envelope?.to),
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
    flags: Array.from(msg.flags || []),
    size: msg.size ?? null,
    messageId: msg.envelope?.messageId || null,
  };
  if (includeBody) {
    try {
      const parsed = await parseMessage(msg.source, PREVIEW_CHARS);
      entry.body = parsed.body;
      entry.bodyTruncated = parsed.truncated || (msg.size ?? 0) > PREVIEW_FETCH_BYTES;
      if (parsed.attachments.length) entry.attachments = parsed.attachments.map((a: any) => a.filename || a.contentType);
    } catch {
      entry.body = "(could not extract body)";
    }
  }
  return entry;
}

export function fetchQuery(includeBody: boolean) {
  const q: Record<string, unknown> = { envelope: true, flags: true, uid: true, size: true };
  // Fetch the (partial) source in the same command. Issuing other IMAP commands inside a
  // fetch loop (as before, via download()) can stall the connection.
  if (includeBody) q.source = { maxLength: PREVIEW_FETCH_BYTES };
  return q;
}

export async function listMessages(ctx: TokenContext, args: {
  folder?: string; page?: number; pageSize?: number; includeBody?: boolean;
}) {
  checkPermission(ctx.scopes, "mail:read");
  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";
  const page = Math.max(1, Math.floor(args.page || 1));
  const pageSize = Math.min(Math.max(1, Math.floor(args.pageSize || 20)), 50);
  const includeBody = args.includeBody || false;

  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const total = client.mailbox ? client.mailbox.exists || 0 : 0;
    const end = total - (page - 1) * pageSize;
    if (total === 0 || end < 1) {
      return { messages: [], total, page, pageSize, hasMore: false };
    }
    const start = Math.max(1, end - pageSize + 1);

    const raw: any[] = [];
    for await (const msg of client.fetch(`${start}:${end}`, fetchQuery(includeBody) as any)) {
      raw.push(msg);
    }
    const messages = [];
    for (const msg of raw.reverse()) messages.push(await summarize(msg, includeBody));
    return { messages, total, page, pageSize, hasMore: start > 1 };
  } finally {
    lock.release();
  }
}
