# 🎯 Quick Setup Guide

Follow these steps to get your Claim Live Detector Bot running in under 5 minutes!

## ✅ Prerequisites

- Node.js v16 or higher ([Download here](https://nodejs.org/))
- A Telegram account
- 5 minutes of your time ⏱️

## 📝 Step-by-Step Setup

### Step 1: Download & Install Dependencies

```bash
# Navigate to the bot folder
cd claim-live-bot

# Install all required packages
npm install
```

**Expected output:**
```
added 45 packages, and audited 46 packages in 3s
```

---

### Step 2: Create Telegram Bot

1. **Open Telegram** and search for [@BotFather](https://t.me/BotFather)

2. **Start a chat** and send:
   ```
   /newbot
   ```

3. **Follow the prompts:**
   ```
   BotFather: Alright, a new bot. How are we going to call it?
   You: Claim Live Detector
   
   BotFather: Good. Now let's choose a username for your bot.
   You: claim_live_detector_bot
   ```

4. **Copy your token** - it looks like:
   ```
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz-123456
   ```

---

### Step 3: Get Your Chat ID

**Option A: Quick Method**

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your ID instantly
3. Copy the number (e.g., `123456789`)

**Option B: Manual Method**

1. Send any message to your new bot
2. Visit this URL in your browser:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
   Replace `<YOUR_BOT_TOKEN>` with the token from Step 2

3. Look for `"chat":{"id":123456789}` in the response
4. Copy that number

---

### Step 4: Configure Environment

1. **Copy the template:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` file** with your favorite editor:
   ```bash
   nano .env
   # or
   code .env
   # or
   notepad .env  # Windows
   ```

3. **Fill in your values:**
   ```bash
   # Paste your bot token from Step 2
   BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz-123456
   
   # Paste your chat ID from Step 3
   CHAT_ID=123456789
   
   # Keep the rest as default (or customize)
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY
   RPC_URL=https://YOUR_SOLANA_MAINNET_RPC_URL
   DEBUG=false
   ```

4. **Save the file** (Ctrl+S or Cmd+S)

---

### Step 5: Test Your Setup

**Start the bot:**
```bash
npm start
```

**You should see:**
```
[BOT] 🚀 Claim Live Detector Started
[BOT] Watching launch: E7kXdS...
[BOT] Poll interval: 1 second
[BOT] Target state: Complete (3) for claim phase
─────────────────────────────────────────────────────
[BOT] Initial state: Live (1)
```

**If you see errors, jump to [Troubleshooting](#-troubleshooting)**

---

### Step 6: Send Test Alert (Optional)

To verify Telegram is working, temporarily modify `index.js`:

```javascript
// Add this right after "Initial state" log:
await sendTelegram("🧪 Test: Bot is working! Monitoring started.");
```

You should receive a Telegram message immediately.

---

## 🎉 You're Done!

Your bot is now monitoring the launch. When the claim phase goes live, you'll get an instant Telegram alert!

**To stop the bot:** Press `Ctrl+C`

---

## 🐛 Troubleshooting

### "Cannot find module"
```bash
# Solution: Install dependencies
npm install
```

### "Error: 401 Unauthorized"
**Problem:** Invalid bot token

**Solution:**
1. Go back to @BotFather on Telegram
2. Send `/mybots`
3. Select your bot → API Token
4. Copy the new token to `.env`

### "Error: 400 Bad Request: chat not found"
**Problem:** Invalid Chat ID

**Solution:**
1. Make sure you've started a chat with your bot
2. Send any message to the bot first
3. Then get your Chat ID again using [@userinfobot](https://t.me/userinfobot)

### "Connection refused" or "RPC error"
**Problem:** RPC endpoint is down or slow

**Solution:** Use a different RPC in `.env`:
```bash
# Free public endpoint
RPC_URL=https://api.mainnet-beta.solana.com
```

Or get a free RPC from:
- [QuickNode](https://www.quicknode.com/) - 25M credits/month free
- [Helius](https://www.helius.dev/) - 100k requests/month free
- [Alchemy](https://www.alchemy.com/) - Free tier available

### Bot starts but no alerts
**Check:**
1. Is the launch address correct in `.env`?
2. Is the current state not "Complete" yet? (Check console output)
3. Enable debug mode: `DEBUG=true` in `.env`

---

## 🚀 Advanced: Run 24/7 with PM2

Want to keep the bot running even after you close the terminal?

```bash
# Install PM2 globally
npm install -g pm2

# Start bot with PM2
pm2 start index.js --name claim-bot

# View logs
pm2 logs claim-bot

# Stop bot
pm2 stop claim-bot

# Restart bot
pm2 restart claim-bot

# Make it start on system boot
pm2 startup
pm2 save
```

---

## 📱 Customize Alerts

Edit the alert messages in `index.js` around line 85:

```javascript
case 3: // Complete - CLAIM LIVE
  await sendTelegram(
    `🚨 *YOUR CUSTOM MESSAGE!* 🚨\n` +
    `Do something now!\n` +
    `Link: https://yourapp.com/claim`
  );
  break;
```

---

## 🔄 Monitor Multiple Launches

**Option 1: Multiple instances**
```bash
# Terminal 1
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY

# Terminal 2  
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY
```

**Option 2: Modify code**
Create a `launches` array in `index.js` and loop through them.

---

## 📞 Need More Help?

1. Check the main [README.md](README.md)
2. Enable `DEBUG=true` for detailed logs
3. Check `state-transitions.log` for history
4. Verify your Telegram bot token at: https://t.me/BotFather

---

## ✨ Tips

- Use a dedicated RPC endpoint for better reliability
- Set up PM2 for 24/7 monitoring
- Monitor your RPC rate limits
- Join the Telegram channel to get notified on mobile
- Test with DEBUG=true first to understand how it works

---

**Happy monitoring! 🎯**