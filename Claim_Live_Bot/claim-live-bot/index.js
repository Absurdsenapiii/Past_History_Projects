import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import { sendTelegram } from "./utils/notify.js";
import fs from "fs";
dotenv.config();

const connection = new Connection(process.env.RPC_URL, { commitment: "confirmed" });
const launchKey = new PublicKey(process.env.LAUNCH_ID);

// State enum mapping
const LaunchState = {
  0: "Initialized",
  1: "Live",
  2: "Closed",
  3: "Complete",
  4: "Refunding"
};

/**
 * Decode Launch.state with precise offset detection
 * First run will help identify the exact offset
 */
async function getLaunchState() {
  try {
    const acc = await connection.getAccountInfo(launchKey);
    if (!acc?.data) return null;
    const data = Buffer.from(acc.data);

    // Debug: Print potential state locations (run once to find offset)
    if (process.env.DEBUG === "true") {
      console.log("Data sample [0-50]:", [...data.slice(0, 50)]);
      console.log("Data sample [180-220]:", [...data.slice(180, 220)]);
    }
    
    // Scan for state byte (temporary until offset is confirmed)
    // Look for bytes 0-4 in likely positions
    let detectedState = null;
    for (let i = 0; i < Math.min(data.length, 300); i++) {
      const byte = data[i];
      if (byte >= 0 && byte <= 4) {
        // Potential state found - validate by checking surrounding context
        const prevBytes = data.slice(Math.max(0, i-8), i);
        const nextBytes = data.slice(i+1, Math.min(data.length, i+9));
        
        // Log for debugging
        if (process.env.DEBUG === "true") {
          console.log(`Potential state at offset ${i}: ${byte} (${LaunchState[byte]})`);
          console.log(`Context: [...${prevBytes.join(',')}] [${byte}] [${nextBytes.join(',')}...]`);
        }
        
        // Use the first reasonable state found
        // In production, replace this with: data[EXACT_OFFSET]
        if (detectedState === null) {
          detectedState = byte;
        }
      }
    }
    
    return detectedState;
  } catch (e) {
    console.error("Error reading launch:", e.message);
    return null;
  }
}

/**
 * Log state transitions to file
 */
function logStateChange(oldState, newState) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} | ${LaunchState[oldState] || 'Unknown'} → ${LaunchState[newState]}\n`;
  
  fs.appendFileSync("state-transitions.log", logEntry);
  console.log(`[STATE CHANGE] ${logEntry.trim()}`);
}

/**
 * Send alerts for different state transitions
 */
async function handleStateChange(oldState, newState) {
  const timestamp = new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
  
  // Log the transition
  logStateChange(oldState, newState);
  
  // Alert based on new state
  switch (newState) {
    case 3: // Complete - CLAIM LIVE
      await sendTelegram(
        `🚨 *CLAIM PHASE LIVE!* 🚨\n` +
        `Launch: \`${launchKey}\`\n` +
        `State: *${LaunchState[newState]}*\n` +
        `Previous: ${LaunchState[oldState] || 'Unknown'}\n` +
        `Time: ${timestamp}`
      );
      break;
      
    case 4: // Refunding
      await sendTelegram(
        `⚠️ *REFUNDING STATE DETECTED* ⚠️\n` +
        `Launch: \`${launchKey}\`\n` +
        `State: *${LaunchState[newState]}*\n` +
        `Time: ${timestamp}`
      );
      break;
      
    case 2: // Closed
      await sendTelegram(
        `🔒 *Launch Closed*\n` +
        `Launch: \`${launchKey}\`\n` +
        `State: *${LaunchState[newState]}*\n` +
        `Time: ${timestamp}`
      );
      break;
      
    case 1: // Live
      await sendTelegram(
        `🟢 *Launch Now Live*\n` +
        `Launch: \`${launchKey}\`\n` +
        `State: *${LaunchState[newState]}*\n` +
        `Time: ${timestamp}`
      );
      break;
  }
}

async function main() {
  console.log(`[BOT] 🚀 Claim Live Detector Started`);
  console.log(`[BOT] Watching launch: ${launchKey.toBase58()}`);
  console.log(`[BOT] Poll interval: 1 second`);
  console.log(`[BOT] Target state: Complete (3) for claim phase`);
  console.log(`[BOT] Logging transitions to: state-transitions.log`);
  console.log(`[BOT] Debug mode: ${process.env.DEBUG || 'false'}`);
  console.log(`─────────────────────────────────────────────────────`);
  
  let currentState = await getLaunchState();
  console.log(`[BOT] Initial state: ${LaunchState[currentState] || 'Unknown'} (${currentState})`);
  
  // 🚨 Send Telegram "bot started" notification
  await sendTelegram(
    `🟢 *Claim Live Detector Started*\n` +
    `Watching: \`${launchKey.toBase58()}\`\n` +
    `Current State: *${LaunchState[currentState] || 'Unknown'}*\n` +
    `Poll interval: 1 second\n` +
    `Target state: *Complete (3)* for claim phase\n` +
    `Started at: ${new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" })}`
  );
  
  let claimDetected = false;

  const interval = setInterval(async () => {
    const newState = await getLaunchState();
    
    // State changed
    if (newState !== null && newState !== currentState) {
      await handleStateChange(currentState, newState);
      currentState = newState;
      
      // If claim is live, optionally stop monitoring
      if (newState === 3 && !claimDetected) {
        claimDetected = true;
        console.log("[BOT] ✅ Claim phase detected! Continuing to monitor for further changes...");
        // Uncomment to stop after claim detected:
        // clearInterval(interval);
        // process.exit(0);
      }
    }
    
    // Heartbeat every 60 checks (1 minute)
    const now = Date.now();
    if (now % 60000 < 1000) {
      console.log(`[HEARTBEAT] Current state: ${LaunchState[currentState]} at ${new Date().toLocaleTimeString()}`);
    }
  }, 1000);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[BOT] Shutting down gracefully...');
    clearInterval(interval);
    process.exit(0);
  });
}

main().catch(err => {
  console.error("[FATAL ERROR]", err);
  process.exit(1);
});
