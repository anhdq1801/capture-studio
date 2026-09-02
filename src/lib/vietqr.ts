/**
 * A VietQR payload, built here rather than fetched from an image service.
 *
 * PayPal is close to unusable for the people this app is mostly written for: opening the link
 * in Vietnam means being asked to create an account, which is where most of them stop. A bank
 * transfer QR is the thing they already use every day — every banking app on the phone scans
 * it, and there is nothing to sign up for.
 *
 * The payload is EMVCo's merchant-presented QR format as NAPAS profiles it: nested
 * tag-length-value triplets, ASCII throughout, ending in a CRC over everything before it. No
 * network call and no image service, so the code renders offline like the rest of the app and
 * the account number never leaves this machine.
 */

/** One tag: two-digit id, two-digit length, value. Lengths are of the *value*, in characters. */
function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, "0") + value;
}

/**
 * CRC-16/CCITT-FALSE — polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR.
 *
 * Named exactly because there are half a dozen CRC-16 variants that differ only in those four
 * details and all of them produce plausible-looking four-character output. The wrong one gives
 * a QR that scans and is then rejected by the banking app with nothing to explain why.
 */
export function crc16ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export interface VietQrAccount {
  /** NAPAS bank identification number — six digits, e.g. Techcombank is 970407. */
  bin: string;
  /** The account number the transfer lands in. */
  account: string;
  /** Amount in dong. Omit for a QR that lets the payer type their own. */
  amount?: number;
  /** Shown as the transfer description. ASCII only — diacritics are not safe here. */
  message?: string;
}

export function vietQrPayload({ bin, account, amount, message }: VietQrAccount): string {
  const beneficiary = tlv("00", bin) + tlv("01", account);
  const merchant =
    tlv("00", "A000000727") + // NAPAS's registered identifier
    tlv("01", beneficiary) +
    tlv("02", "QRIBFTTA"); // transfer to an account number rather than to a card

  let body =
    tlv("00", "01") +
    // 11 = reusable, 12 = one-off. A payload carrying an amount is a one-off by definition,
    // even though the picture on screen never changes.
    tlv("01", amount ? "12" : "11") +
    tlv("38", merchant) +
    tlv("53", "704") + // VND, per ISO 4217
    (amount ? tlv("54", String(Math.round(amount))) : "") +
    tlv("58", "VN");

  if (message) {
    body += tlv("62", tlv("08", message));
  }

  // The CRC covers everything before it *including* its own id and length, which is why "6304"
  // is appended before the sum is taken.
  const withCrcHeader = body + "6304";
  return withCrcHeader + crc16ccitt(withCrcHeader);
}
