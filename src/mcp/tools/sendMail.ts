import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { getAccount, getAccountPassword } from "../../imap/accounts.js";
import { getImapClient } from "../../imap/client.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

export async function sendMail(ctx: TokenContext, args: {
  to: string; subject: string; body: string; cc?: string; bcc?: string; inReplyTo?: string; references?: string; html?: string; saveToSent?: boolean;
}) {
  checkPermission(ctx.scopes, "mail:send");

  const account = getAccount(ctx.accountId);
  if (!account) throw new Error("Account not found");
  if (!account.smtp_host) throw new Error("SMTP not configured for this account");

  const implicitTls = account.smtp_port === 465;
  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_tls === 1 && implicitTls,
    // With TLS enabled on a STARTTLS port (587/25), refuse to send if the server does not
    // offer STARTTLS — otherwise credentials and mail could go out in plain text.
    requireTLS: account.smtp_tls === 1 && !implicitTls,
    auth: { user: account.username, pass: getAccountPassword(account) },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  const mail = {
    from: account.username,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body,
    html: args.html,
    inReplyTo: args.inReplyTo,
    references: args.references || args.inReplyTo,
  };

  const info = await transport.sendMail(mail);

  // Most IMAP servers do not store SMTP-sent mail automatically → append a copy to "Sent"
  let savedToSent: string | false = false;
  if (args.saveToSent !== false) {
    try {
      const raw = await new MailComposer({ ...mail, bcc: undefined, messageId: info.messageId, date: new Date() }).compile().build();
      const client = await getImapClient(ctx.accountId);
      const folders = await client.list();
      const sent = folders.find((f) => f.specialUse === "\\Sent")
        ?? folders.find((f) => /^(sent|sent items|sent messages|gesendet|gesendete (objekte|elemente))$/i.test(f.name));
      if (sent) {
        await client.append(sent.path, raw, ["\\Seen"]);
        savedToSent = sent.path;
      }
    } catch (e: any) {
      console.warn(`Could not save sent mail to IMAP: ${e?.message}`);
    }
  }

  return { success: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, savedToSent };
}
