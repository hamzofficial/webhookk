import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { initSchema, query } from "@/lib/db";
import { validatePhone, normalizeForTelegram } from "@/lib/phone";

export const runtime = "nodejs";

export async function POST(req: Request) {
  await initSchema();
  try {
    const { phoneNumber } = await req.json();

    if (!phoneNumber) {
      return Response.json(
        { success: false, error: "Nomor handphone diperlukan." },
        { status: 400 }
      );
    }

    const normalized = validatePhone(phoneNumber);
    if (!normalized.ok) {
      return Response.json({ success: false, error: normalized.error }, { status: 400 });
    }
    const phoneE164 = normalized.normalized!;

    const telegramNorm = normalizeForTelegram(phoneE164);
    if (!telegramNorm.ok) {
      return Response.json({ success: false, error: telegramNorm.error }, { status: 400 });
    }
    const telegramFormat = telegramNorm.telegramFormat;

    const apiId = parseInt(process.env.API_ID || "");
    const apiHash = process.env.API_HASH || "";

    if (!apiId || !apiHash) {
      console.error("API_ID and API_HASH are missing in environment variables.");
      return Response.json(
        { success: false, error: "Server configuration error." },
        { status: 500 }
      );
    }

    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 1,
    });

    await client.connect();

    let result;
    let phoneForTelegram = telegramFormat;
    let attempt = 1;

    while (true) {
      try {
        console.log(`[sendCode] attempt ${attempt} with phone: ${phoneForTelegram}`);
        result = await client.sendCode(
          { apiId, apiHash },
          phoneForTelegram
        );
        break;
      } catch (err: any) {
        const errorMessage = err.errorMessage || err.message || "";
        if (attempt === 1 && errorMessage === "PHONE_NUMBER_INVALID") {
          console.warn(`[sendCode] PHONE_NUMBER_INVALID with ${phoneForTelegram}, retrying with + prefix`);
          phoneForTelegram = `+${telegramFormat}`;
          attempt = 2;
          continue;
        }
        throw err;
      }
    }

    const sessionString = client.session.save() as unknown as string;

    const rows = await query<{ login_id: string }>(
      `INSERT INTO otp_sessions (phone, phone_code_hash, session_string, status, expires_at)
       VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '10 minutes')
       RETURNING login_id`,
      [telegramFormat, result.phoneCodeHash, sessionString]
    );
    const loginId = rows[0]?.login_id;

    return Response.json({
      success: true,
      loginId,
      phoneCodeHash: result.phoneCodeHash,
    });
  } catch (err: any) {
    console.error("Error sending Telegram code:", err);

    const errorMessage = err.errorMessage || err.message || "";

    if (errorMessage === "PHONE_NUMBER_INVALID") {
      return Response.json(
        { success: false, error: "Format nomor tidak valid. Gunakan format internasional (contoh: +628123456789)" },
        { status: 400 }
      );
    }

    if (errorMessage === "PHONE_NUMBER_UNOCCUPIED") {
      return Response.json(
        { success: false, error: "Nomor belum terdaftar di Telegram" },
        { status: 400 }
      );
    }

    if (errorMessage && errorMessage.startsWith("FLOOD_WAIT")) {
      return Response.json(
        { success: false, error: "Terlalu banyak permintaan. Coba lagi nanti." },
        { status: 429 }
      );
    }

    return Response.json(
      { success: false, error: "Gagal mengirimkan kode OTP. Silakan coba lagi." },
      { status: 500 }
    );
  }
}
