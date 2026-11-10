import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "module";
import type { TokenContext } from "../types.js";

import { listFolders } from "./tools/listFolders.js";
import { listMessages } from "./tools/listMessages.js";
import { readMessage } from "./tools/readMessage.js";
import { readAttachment } from "./tools/readAttachment.js";
import { searchMessages } from "./tools/searchMessages.js";
import { moveMessage } from "./tools/moveMessage.js";
import { flagMessage } from "./tools/flagMessage.js";
import { sendMail } from "./tools/sendMail.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const folder = z.string().min(1).max(500);
const uid = z.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const shortText = z.string().max(1000);

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wrap a tool so errors are returned as MCP tool errors (isError) instead of protocol errors,
 * and the current token context (refreshed on every HTTP request) is resolved per call.
 */
function tool<A>(getCtx: () => TokenContext, fn: (ctx: TokenContext, args: A) => Promise<unknown>, raw = false) {
  return async (args: A): Promise<any> => {
    try {
      const data = await fn(getCtx(), args);
      // raw tools already return MCP content (e.g. images), everything else is serialized as JSON
      return raw ? data : result(data);
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e?.message || String(e)}` }], isError: true };
    }
  };
}

export function createMcpServer(getCtx: () => TokenContext): McpServer {
  const server = new McpServer({ name: "imap-bridge", version });

  server.tool(
    "list_folders",
    "List all mailbox folders in the email account",
    {},
    tool(getCtx, (ctx) => listFolders(ctx)),
  );

  server.tool(
    "list_messages",
    "List email messages in a folder, newest first, with pagination. Use includeBody=true to get a text preview of each message and avoid separate read_message calls.",
    {
      folder: folder.optional().default("INBOX").describe("Mailbox folder path"),
      page: z.number().int().min(1).optional().default(1).describe("Page number (1-based)"),
      pageSize: z.number().int().min(1).max(50).optional().default(20).describe("Messages per page (max 50)"),
      includeBody: z.boolean().optional().default(false).describe("Include a decoded text preview (up to 2000 chars each)"),
    },
    tool(getCtx, listMessages),
  );

  server.tool(
    "read_message",
    "Read full email message(s) by UID: headers, decoded text body and attachment list. Use 'uids' to read up to 10 messages in one call. Reading does not mark messages as read.",
    {
      folder: folder.optional().default("INBOX").describe("Mailbox folder path"),
      uid: uid.optional().describe("Message UID (for a single message)"),
      uids: z.array(uid).max(10).optional().describe("Multiple message UIDs to read at once (max 10)"),
    },
    tool(getCtx, readMessage),
  );

  server.tool(
    "read_attachment",
    "Read the content of an email attachment. PDFs are returned as extracted text, text files (txt, csv, json, xml, html, ics) as decoded text, " +
      "images as image content, other files as base64 resource (max 5 MB). " +
      "Get 'index' from the attachment list of read_message. Does not mark the message as read.",
    {
      folder: folder.optional().default("INBOX").describe("Mailbox folder path"),
      uid: uid.describe("Message UID"),
      index: z.number().int().min(0).optional().describe("Attachment index (0-based) as listed by read_message"),
      filename: z.string().max(500).optional().describe("Attachment filename (alternative to index; exact or partial match)"),
      maxChars: z.number().int().min(100).max(100_000).optional().describe("Max. characters of extracted text (default 100000)"),
    },
    tool(getCtx, readAttachment, true),
  );

  server.tool(
    "search_messages",
    "Search email messages by text, sender, recipient, date or unread state (newest first). Use includeBody=true to get text previews inline.",
    {
      folder: folder.optional().default("INBOX").describe("Mailbox folder path"),
      query: shortText.optional().describe("Search text (subject and body)"),
      from: shortText.optional().describe("Filter by sender"),
      to: shortText.optional().describe("Filter by recipient"),
      since: isoDate.optional().describe("Messages since date (YYYY-MM-DD)"),
      before: isoDate.optional().describe("Messages before date (YYYY-MM-DD)"),
      unseen: z.boolean().optional().describe("Only unread messages"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Max results (max 50)"),
      includeBody: z.boolean().optional().default(false).describe("Include a decoded text preview (up to 2000 chars each)"),
    },
    tool(getCtx, searchMessages),
  );

  server.tool(
    "move_message",
    "Move an email message to a different folder",
    {
      folder: folder.describe("Source folder path"),
      uid: uid.describe("Message UID"),
      destination: folder.describe("Destination folder path"),
    },
    tool(getCtx, moveMessage),
  );

  server.tool(
    "flag_message",
    "Set or remove flags on an email (read/unread, star, delete)",
    {
      folder: folder.optional().default("INBOX").describe("Mailbox folder path"),
      uid: uid.describe("Message UID"),
      seen: z.boolean().optional().describe("Mark as read/unread"),
      flagged: z.boolean().optional().describe("Star/flag the message"),
      deleted: z.boolean().optional().describe("Mark as deleted"),
    },
    tool(getCtx, flagMessage),
  );

  server.tool(
    "send_mail",
    "Send an email via SMTP. A copy is saved to the Sent folder unless saveToSent=false.",
    {
      to: shortText.describe("Recipient email(s), comma-separated"),
      subject: z.string().max(998).describe("Email subject"),
      body: z.string().max(500_000).describe("Email body (plain text)"),
      cc: shortText.optional().describe("CC address(es), comma-separated"),
      bcc: shortText.optional().describe("BCC address(es), comma-separated"),
      inReplyTo: z.string().max(998).optional().describe("Message-ID being replied to (sets In-Reply-To/References for threading)"),
      references: z.string().max(5000).optional().describe("References header (space-separated Message-IDs), optional"),
      html: z.string().max(1_000_000).optional().describe("HTML body (optional)"),
      saveToSent: z.boolean().optional().default(true).describe("Store a copy in the Sent folder"),
    },
    tool(getCtx, sendMail),
  );

  return server;
}
