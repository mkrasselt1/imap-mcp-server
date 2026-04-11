import { getImapClient } from "../../imap/client.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

export async function readMessage(ctx: TokenContext, args: { folder?: string; uid: number }) {
  checkPermission(ctx.scopes, "mail:read");
  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";

  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(args.uid), {
      envelope: true,
      source: true,
      flags: true,
      uid: true,
    }, { uid: true });

    if (!msg) throw new Error(`Message UID ${args.uid} not found`);

    const source = (msg as any).source?.toString("utf-8") || "";

    let textBody = "";
    const parts = source.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
      textBody = parts.slice(1).join("\n\n");
    }

    // Try download for cleaner body
    let cleanText = "";
    try {
      const downloaded = await client.download(String(args.uid), undefined, { uid: true });
      if (downloaded?.content) {
        const chunks: Buffer[] = [];
        for await (const chunk of downloaded.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        cleanText = Buffer.concat(chunks).toString("utf-8");
      }
    } catch {}

    const envelope = (msg as any).envelope;
    const flags = (msg as any).flags;

    return {
      uid: (msg as any).uid,
      subject: envelope?.subject || "(no subject)",
      from: envelope?.from?.map((a: any) => ({ name: a.name, address: `${a.mailbox}@${a.host}` })) || [],
      to: envelope?.to?.map((a: any) => ({ name: a.name, address: `${a.mailbox}@${a.host}` })) || [],
      cc: envelope?.cc?.map((a: any) => ({ name: a.name, address: `${a.mailbox}@${a.host}` })) || [],
      date: envelope?.date?.toISOString() || null,
      flags: Array.from(flags || []),
      body: cleanText || textBody || "(could not extract body)",
      inReplyTo: envelope?.inReplyTo || null,
      messageId: envelope?.messageId || null,
    };
  } finally {
    lock.release();
  }
}
