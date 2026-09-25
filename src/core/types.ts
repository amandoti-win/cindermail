export interface OwnerRef {
  type: string;
  id: string;
}

export interface ParsedMailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: ArrayBuffer;
}

export interface ParsedMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments: ParsedMailAttachment[];
}

export interface DeliveryResult {
  success: boolean;
  error?: string;
}

export interface MailAdapter {
  name: string;
  deliver(owner: OwnerRef, mail: ParsedMail): Promise<DeliveryResult>;
  // A message from the bot itself rather than a forwarded email, used for
  // expiry reminders. Separate from deliver() because that one renders
  // From/To/Subject headers, which would be nonsense on a notice like this.
  // Same contract otherwise: returns a result, never throws.
  notify(owner: OwnerRef, message: string): Promise<DeliveryResult>;
}

export interface AddressRow {
  address: string;
  owner_type: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  revoked: number;
  revoked_at: number | null;
  permanent: number;
  note: string | null;
  short_id: string | null;
  expiry_warned_at: number | null;
  receiver_data: string | null;
}
