import { getImapClient } from "../../imap/client.js";
import { checkPermission } from "../permissions.js";
import { fetchQuery, summarize } from "./listMessages.js";
import type { TokenContext } from "../../types.js";

export async function searchMessages(ctx: TokenContext, args: {
  folder?: string; query?: string; from?: string; to?: string;
  since?: string; before?: string; unseen?: boolean; limit?: number; includeBody?: boolean;
}) {
  checkPermission(ctx.scopes, "mail:search");
  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";
  const includeBody = args.includeBody || false;
  const limit = Math.min(Math.max(1, Math.floor(args.limit || 20)), 50);

  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const criteria: Record<string, unknown> = {};
    if (args.query) criteria.or = [{ subject: args.query }, { body: args.query }];
    if (args.from) criteria.from = args.from;
    if (args.to) criteria.to = args.to;
    if (args.since) criteria.since = new Date(`${args.since}T00:00:00Z`);
    if (args.before) criteria.before = new Date(`${args.before}T00:00:00Z`);
    if (args.unseen) criteria.seen = false;

    const result = await client.search(Object.keys(criteria).length > 0 ? criteria : { all: true }, { uid: true });
    const uids = Array.isArray(result) ? result : [];
    const selected = uids.slice(-limit);
    if (selected.length === 0) {
      return { messages: [], total: 0 };
    }

    const raw: any[] = [];
    for await (const msg of client.fetch(selected.join(","), fetchQuery(includeBody) as any, { uid: true })) {
      raw.push(msg);
    }
    raw.sort((a, b) => b.uid - a.uid);
    const messages = [];
    for (const msg of raw) messages.push(await summarize(msg, includeBody));
    return { messages, total: uids.length, returned: messages.length };
  } finally {
    lock.release();
  }
}
