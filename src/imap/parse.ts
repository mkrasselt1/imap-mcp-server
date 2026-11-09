import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";

/** Max. raw bytes fetched for body previews (list/search with includeBody). */
export const PREVIEW_FETCH_BYTES = 256 * 1024;
/** Max. raw bytes parsed for read_message (larger mails are read partially; attachments are skipped anyway). */
export const READ_FETCH_BYTES = 10 * 1024 * 1024;
/** Max. characters of body text returned by read_message. */
export const MAX_BODY_CHARS = 100_000;

export function mapAddresses(list: any[] | undefined): { name?: string; address?: string }[] {
  return (list || []).map((a: any) => ({ name: a.name || undefined, address: a.address }));
}

function flattenAddressObject(a: AddressObject | AddressObject[] | undefined): { name?: string; address?: string }[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((o) => o.value.map((v) => ({ name: v.name || undefined, address: v.address })));
}

/**
 * Turn raw RFC 822 source into readable text: decodes MIME/quoted-printable/base64 and charsets,
 * falls back to a text rendering of the HTML part. Attachments are listed, never returned.
 */
export async function parseMessage(source: Buffer | undefined, maxChars: number) {
  if (!source || source.length === 0) {
    return { body: "", truncated: false, attachments: [] as any[], replyTo: [], references: undefined as string[] | undefined };
  }
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  let body = (parsed.text || "").trim();
  if (!body && typeof parsed.html === "string") {
    body = htmlToText(parsed.html);
  }
  const truncated = body.length > maxChars;
  if (truncated) body = body.slice(0, maxChars);

  const refs = parsed.references;
  return {
    body,
    truncated,
    replyTo: flattenAddressObject(parsed.replyTo),
    references: refs ? (Array.isArray(refs) ? refs : [refs]) : undefined,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || null,
      contentType: att.contentType,
      size: att.size,
      inline: att.contentDisposition === "inline",
    })),
  };
}

/** Very small HTML → text fallback (mailparser only derives text when a text/plain part exists). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
