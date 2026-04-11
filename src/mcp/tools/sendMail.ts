import nodemailer from "nodemailer";
import { getAccount, getAccountPassword } from "../../imap/accounts.js";
import { checkPermission } from "../permissions.js";
import type { TokenContext } from "../../types.js";

export const sendMailDef = {
  name: "send_mail" as const,
  description: "Send an email message via SMTP",
  inputSchema: {
    type: "object" as const,
    properties: {
      to: { type: "string" as const, description: "Recipient email address(es), comma-separated" },
      subject: { type: "string" as const, description: "Email subject" },
      body: { type: "string" as const, description: "Email body (plain text)" },
      cc: { type: "string" as const, description: "CC address(es), comma-separated" },
      inReplyTo: { type: "string" as const, description: "Message-ID to reply to" },
      html: { type: "string" as const, description: "HTML body (optional, overrides plain text)" },
    },
    required: ["to" as const, "subject" as const, "body" as const],
  },
};

export async function sendMail(ctx: TokenContext, args: {
  to: string; subject: string; body: string; cc?: string; inReplyTo?: string; html?: string;
}) {
  checkPermission(ctx.scopes, "mail:send");

  const account = getAccount(ctx.accountId);
  if (!account) throw new Error("Account not found");
  if (!account.smtp_host) throw new Error("SMTP not configured for this account");

  const password = getAccountPassword(account);

  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_tls === 1 && account.smtp_port === 465,
    auth: { user: account.username, pass: password },
    tls: { rejectUnauthorized: true },
  });

  const info = await transport.sendMail({
    from: account.username,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    text: args.body,
    html: args.html,
    inReplyTo: args.inReplyTo,
  });

  return { success: true, messageId: info.messageId };
}
