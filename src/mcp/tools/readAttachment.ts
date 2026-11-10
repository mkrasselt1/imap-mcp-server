import { simpleParser } from "mailparser";
import type { Attachment } from "mailparser";
import { getImapClient } from "../../imap/client.js";
import { ATTACHMENT_FETCH_BYTES, MAX_BODY_CHARS, htmlToText, parseMessage } from "../../imap/parse.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

/** Max. size of binary content (images, other files) returned as base64. */
const MAX_BINARY_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/csv",
  "application/x-sh",
]);

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ReadAttachmentArgs {
  folder?: string;
  uid: number;
  index?: number;
  filename?: string;
  maxChars?: number;
}

export function pickAttachment(attachments: Attachment[], args: ReadAttachmentArgs): { att: Attachment; index: number } {
  if (attachments.length === 0) throw new Error(`Message UID ${args.uid} has no attachments`);
  if (args.index !== undefined) {
    const att = attachments[args.index];
    if (!att) throw new Error(`Attachment index ${args.index} not found (message has ${attachments.length} attachment(s), 0-based)`);
    return { att, index: args.index };
  }
  if (args.filename) {
    const wanted = args.filename.toLowerCase();
    let index = attachments.findIndex((a) => (a.filename || "").toLowerCase() === wanted);
    if (index < 0) index = attachments.findIndex((a) => (a.filename || "").toLowerCase().includes(wanted));
    if (index < 0) throw new Error(`No attachment matching filename '${args.filename}'`);
    return { att: attachments[index], index };
  }
  if (attachments.length === 1) return { att: attachments[0], index: 0 };
  throw new Error(`Message has ${attachments.length} attachments; specify 'index' or 'filename'`);
}

function clip(text: string, maxChars: number) {
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated };
}

function isTextType(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml");
}

/** Guess a better MIME type from the file extension when the sender used application/octet-stream. */
function effectiveType(att: Attachment): string {
  const mime = (att.contentType || "application/octet-stream").toLowerCase();
  if (mime !== "application/octet-stream") return mime;
  const ext = (att.filename || "").toLowerCase().split(".").pop() || "";
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    eml: "message/rfc822",
    ics: "text/calendar",
  };
  return byExt[ext] || mime;
}

async function pdfToText(content: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(content));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const joined = text.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join("\n\n");
  return { text: joined, pages: totalPages };
}

export async function renderAttachment(att: Attachment, maxChars: number): Promise<{ meta: Record<string, unknown>; content: Content[] }> {
  const mime = effectiveType(att);
  const buf = att.content;

  if (mime === "application/pdf") {
    const { text, pages } = await pdfToText(buf);
    if (text.replace(/--- Page \d+ ---/g, "").trim()) {
      const c = clip(text, maxChars);
      return { meta: { extracted: "pdf-text", pages, truncated: c.truncated }, content: [{ type: "text", text: c.text }] };
    }
    // Scanned PDF without a text layer: hand the file over as-is
    if (buf.length <= MAX_BINARY_BYTES) {
      return {
        meta: { extracted: "none", pages, note: "PDF has no text layer (probably scanned); returned as binary resource" },
        content: [{ type: "resource", resource: { uri: `attachment:///${encodeURIComponent(att.filename || "file.pdf")}`, mimeType: mime, blob: buf.toString("base64") } }],
      };
    }
    return { meta: { extracted: "none", pages, note: "PDF has no text layer and is too large to return as binary" }, content: [] };
  }

  if (mime === "message/rfc822") {
    const inner = await parseMessage(buf, maxChars);
    const p = await simpleParser(buf, { skipImageLinks: true, skipTextToHtml: true });
    const header = [
      `Subject: ${p.subject || "(no subject)"}`,
      `From: ${p.from?.text || ""}`,
      `To: ${Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : p.to?.text || ""}`,
      `Date: ${p.date ? p.date.toISOString() : ""}`,
    ].join("\n");
    return {
      meta: { extracted: "email", truncated: inner.truncated, attachments: inner.attachments },
      content: [{ type: "text", text: `${header}\n\n${inner.body}` }],
    };
  }

  if (isTextType(mime)) {
    let text = buf.toString("utf8");
    if (mime === "text/html") text = htmlToText(text);
    const c = clip(text, maxChars);
    return { meta: { extracted: "text", truncated: c.truncated }, content: [{ type: "text", text: c.text }] };
  }

  if (buf.length > MAX_BINARY_BYTES) {
    return {
      meta: { extracted: "none", note: `Attachment too large to return (${buf.length} bytes, max ${MAX_BINARY_BYTES})` },
      content: [],
    };
  }

  if (IMAGE_TYPES.has(mime)) {
    return { meta: { extracted: "image" }, content: [{ type: "image", data: buf.toString("base64"), mimeType: mime }] };
  }

  return {
    meta: { extracted: "binary" },
    content: [{ type: "resource", resource: { uri: `attachment:///${encodeURIComponent(att.filename || "file")}`, mimeType: mime, blob: buf.toString("base64") } }],
  };
}

/**
 * Read one attachment of a message. PDFs are converted to text, text formats are decoded,
 * images are returned as MCP image content, other files as base64 resource (size-limited).
 */
export async function readAttachment(ctx: TokenContext, args: ReadAttachmentArgs): Promise<{ content: Content[] }> {
  checkPermission(ctx.scopes, "mail:read");
  const client = await getImapClient(ctx.accountId);
  const folder = args.folder || "INBOX";
  const maxChars = Math.min(args.maxChars ?? MAX_BODY_CHARS, MAX_BODY_CHARS);

  let source: Buffer | undefined;
  let size: number | null = null;
  // readOnly: reading via MCP must not silently mark messages as \Seen
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const msg: any = await client.fetchOne(String(args.uid), {
      uid: true,
      size: true,
      source: { maxLength: ATTACHMENT_FETCH_BYTES },
    } as any, { uid: true });
    if (!msg) throw new Error(`Message UID ${args.uid} not found`);
    source = msg.source;
    size = msg.size ?? null;
  } finally {
    lock.release();
  }

  if (!source || source.length === 0) throw new Error(`Message UID ${args.uid} has no content`);
  if ((size ?? 0) > ATTACHMENT_FETCH_BYTES) {
    throw new Error(`Message is too large (${size} bytes, max ${ATTACHMENT_FETCH_BYTES}) to read attachments`);
  }

  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const { att, index } = pickAttachment(parsed.attachments || [], args);

  let rendered: Awaited<ReturnType<typeof renderAttachment>>;
  try {
    rendered = await renderAttachment(att, maxChars);
  } catch (e: any) {
    throw new Error(`Could not read attachment '${att.filename || index}': ${e?.message || String(e)}`);
  }

  const meta = {
    uid: args.uid,
    index,
    filename: att.filename || null,
    contentType: att.contentType,
    size: att.size,
    ...rendered.meta,
  };
  return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, ...rendered.content] };
}
