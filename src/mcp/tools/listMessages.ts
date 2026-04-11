import { getImapClient } from "../../imap/client.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

export async function listMessages(ctx: TokenContext, args: { folder?: string; page?: number; pageSize?: number }) {
  checkPermission(ctx.scopes, "mail:read");
  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";
  const page = args.page || 1;
  const pageSize = Math.min(args.pageSize || 20, 50);

  const lock = await client.getMailboxLock(folder);
  try {
    const mailbox = client.mailbox;
    const total = mailbox ? (mailbox as any).exists || 0 : 0;

    if (total === 0) {
      return { messages: [], total, page, pageSize };
    }

    const start = Math.max(1, total - page * pageSize + 1);
    const end = Math.max(1, total - (page - 1) * pageSize);

    const messages: any[] = [];
    for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, flags: true, uid: true })) {
      messages.push({
        uid: (msg as any).uid,
        seq: (msg as any).seq,
        subject: (msg as any).envelope?.subject || "(no subject)",
        from: (msg as any).envelope?.from?.map((a: any) => ({ name: a.name, address: `${a.mailbox}@${a.host}` })) || [],
        to: (msg as any).envelope?.to?.map((a: any) => ({ name: a.name, address: `${a.mailbox}@${a.host}` })) || [],
        date: (msg as any).envelope?.date?.toISOString() || null,
        flags: Array.from((msg as any).flags || []),
      });
    }

    messages.reverse();
    return { messages, total, page, pageSize };
  } finally {
    lock.release();
  }
}
