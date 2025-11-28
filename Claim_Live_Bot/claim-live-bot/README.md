# 🧭 Claim Live Detector Bot

A real-time Solana launch monitor that detects claim phase transitions and sends instant Telegram alerts.

## 🎯 Features

- ⚡ **1 Hz Polling** - Checks launch state every second
- 📱 **Telegram Alerts** - Instant notifications for state changes
- 📊 **Complete State Tracking** - Monitors all 5 launch states
- 📝 **Transaction Logging** - Records all state transitions to file
- 🐛 **Debug Mode** - Detailed byte-level state detection
- 💪 **Graceful Shutdown** - Clean exit with Ctrl+C

## 📦 Installation

### 1. Clone or Download

Download all files to a folder called `claim-live-bot/`

### 2. Install Dependencies

```bash
cd claim-live-bot
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Then edit `.env` with your values:

```bash
# Get Telegram Bot Token from @BotFather
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

# Find your Chat ID by messaging your bot and visiting:
# https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
CHAT_ID=123456789

# Optional: Change the launch address to monitor
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY

# Optional: Use your own RPC endpoint
RPC_URL=https://api.mainnet-beta.solana.com
```

## 🚀 Usage

### Start the Bot

```bash
npm start
```

or

```bash
node index.js
```

### Expected Output

```
[BOT] 🚀 Claim Live Detector Started
[BOT] Watching launch: E7kXdS...
[BOT] Poll interval: 1 second
[BOT] Target state: Complete (3) for claim phase
[BOT] Logging transitions to: state-transitions.log
─────────────────────────────────────────────────────
[BOT] Initial state: Live (1)
[HEARTBEAT] Current state: Live at 6:30:45 PM
```

### When Claim Goes Live

**Console:**
```
[STATE CHANGE] 2025-10-23T10:30:45.123Z | Live → Complete
[BOT] ✅ Claim phase detected!
[TELEGRAM] Message sent: 🚨 CLAIM PHASE LIVE! 🚨...
```

**Telegram Message:**
```
🚨 CLAIM PHASE LIVE! 🚨
Launch: `E7kXdS...`
State: Complete
Previous: Live
Time: 23/10/2025, 6:30:45 PM
```

## 📊 Launch States

| State | Value | Description | Alert |
|-------|-------|-------------|-------|
| Initialized | 0 | Just created | ℹ️ Info |
| Live | 1 | Sale is active | 🟢 Live |
| Closed | 2 | Sale ended | 🔒 Closed |
| **Complete** | **3** | **Claim phase active** | **🚨 Critical** |
| Refunding | 4 | Refund available | ⚠️ Warning |

## 🐛 Debug Mode

To see detailed byte-level state detection:

```bash
# In .env file
DEBUG=true
```

This will show:
- Raw account data samples
- Potential state byte locations
- Context around state bytes

Use this to find the exact byte offset of the state field, then optimize the code:

```javascript
// In index.js, replace the scan loop with:
const STATE_OFFSET = 185; // Your discovered offset
const state = data[STATE_OFFSET];
return (state >= 0 && state <= 4) ? state : null;
```

## 📝 Logs

All state transitions are logged to `state-transitions.log`:

```
2025-10-23T10:25:30.123Z | Initialized → Live
2025-10-23T10:30:45.456Z | Live → Complete
2025-10-23T10:35:12.789Z | Complete → Closed
```

## 🛠️ Customization

### Change Poll Interval

Edit `index.js`:

```javascript
}, 1000); // Change from 1000ms (1s) to desired interval
```

### Stop After Claim Detection

Uncomment in `index.js`:

```javascript
if (newState === 3 && !claimDetected) {
  claimDetected = true;
  clearInterval(interval);  // Uncomment this
  process.exit(0);          // and this
}
```

### Monitor Multiple Launches

Create multiple bot instances with different `.env` files:

```bash
# Bot 1
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY

# Bot 2
LAUNCH_ID=YOUR_LAUNCH_ACCOUNT_PUBKEY
```

## 🔧 Telegram Setup

### 1. Create Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the token (looks like: `1234567890:ABCdefGHI...`)

### 2. Get Chat ID

**Option A: Using the bot**
1. Start a chat with your new bot
2. Send any message
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find `"chat":{"id":123456789}` - that's your Chat ID

**Option B: Using @userinfobot**
1. Message [@userinfobot](https://t.me/userinfobot)
2. It will reply with your Chat ID

## 🚨 Troubleshooting

### "Cannot find module"

```bash
npm install
```

### "Invalid token"

Check `BOT_TOKEN` in `.env` - should be from @BotFather

### "No response from RPC"

Try a different RPC endpoint in `.env`:

```bash
# Free public endpoint (slower)
RPC_URL=https://api.mainnet-beta.solana.com

# Or get a free account from:
# - QuickNode: https://www.quicknode.com/
# - Alchemy: https://www.alchemy.com/
# - Helius: https://www.helius.dev/
```

### "Bot not detecting state changes"

1. Enable debug mode: `DEBUG=true` in `.env`
2. Check console output for state byte locations
3. Update `STATE_OFFSET` in code if needed

### Telegram message not sending

1. Verify bot token: `echo $BOT_TOKEN`
2. Verify chat ID: `echo $CHAT_ID`
3. Make sure you've started a chat with your bot
4. Check bot has permission to send messages

## 📁 File Structure

```
claim-live-bot/
├── package.json           # Dependencies
├── .env.example          # Environment template
├── .env                  # Your configuration (create this)
├── index.js              # Main bot logic
├── utils/
│   └── notify.js         # Telegram notification handler
├── state-transitions.log # Auto-generated log file
└── README.md            # This file
```

## 🔐 Security Notes

- **Never commit `.env`** to version control
- Keep your `BOT_TOKEN` secret
- Use environment variables for sensitive data
- Consider using a process manager like PM2 for production

## 📄 License

MIT

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

## ⚡ Quick Start Checklist

- [ ] Install Node.js (v16+)
- [ ] Run `npm install`
- [ ] Create Telegram bot with @BotFather
- [ ] Get your Chat ID
- [ ] Copy `.env.example` to `.env`
- [ ] Fill in `BOT_TOKEN` and `CHAT_ID`
- [ ] Run `npm start`
- [ ] Test by sending a message to your bot
- [ ] Wait for claim phase notification! 🚀

---

**Need help?** Check the Troubleshooting section or open an issue.