import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

/**
 * Send a message to Telegram
 * @param {string} msg - Message to send (supports Markdown)
 */
export async function sendTelegram(msg) {
  try {
    await bot.sendMessage(process.env.CHAT_ID, msg, { parse_mode: "Markdown" });
    console.log("[TELEGRAM] Message sent:", msg.substring(0, 50) + "...");
  } catch (err) {
    console.error("[TELEGRAM ERROR]", err.message);
  }
}
