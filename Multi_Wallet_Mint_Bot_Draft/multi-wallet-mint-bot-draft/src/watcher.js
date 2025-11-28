/**
 * Watcher Module
 * Subscribes to mint contract events and triggers consolidation when mints detected
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction, getWalletsByStatus } from './tracker.js';
import { sendTelegramAlert, sleep } from './utils.js';
import { validateSettings } from './utils.js';


// Safely decode a log; return null if it doesn't match the ABI
function safeDecodeLog(iface, log) {
  try { return iface.parseLog(log); } catch { return null; }
}
const __dirname = dirname(fileURLToPath(import.meta.url));
config();

// Load settings
import { readFileSync } from "fs";
import { join } from "path";
import { validateSettings } from "./utils.js";

const settings = JSON.parse(
  readFileSync(join(__dirname, "..", "config", "settings.json"), "utf8")
);
validateSettings(settings);

  readFileSync(join(__dirname, '..', 'config', 'settings.json'), 'utf8')

/**
 * Parse event signature to extract event name and parameters
 * @param {string} eventSig - Event signature (e.g., "Transfer(address,address,uint256)")
 * @returns {Object} Parsed event info
 */
function parseEventSignature(eventSig) {
  const match = eventSig.match(/^(\w+)\((.*)\)$/);
  if (!match) {
    throw new Error(`Invalid event signature: ${eventSig}`);
  }
  
  const [, name, paramsStr] = match;
  const params = paramsStr.split(',').map(p => p.trim());
  
  return { name, params };
}

/**
 * Create event filter for the configured mint event
 * @param {ethers.Contract} contract - Contract instance
 * @returns {Object} Event filter
 */
function createEventFilter(contract) {
  const eventConfig = settings.mintEvents;
  
  if (!eventConfig || !eventConfig.event) {
    throw new Error('mintEvents configuration missing in settings.json');
  }
  
  const { name } = parseEventSignature(eventConfig.event);
  
  // Create filter for the event
  const filter = contract.filters[name]();
  
  return filter;
}

/**
 * Extract recipient address from event log
 * @param {Object} log - Decoded log
 * @param {string} toField - Field name for recipient (default: 'to')
 * @returns {string|null} Recipient address or null
 */
function extractRecipient(log, toField = 'to') {
  // PREFERRED: Try configured field name from decoded args
  if (log.args && log.args[toField]) {
    return log.args[toField].toLowerCase();
  }
  
  // Try common field names in decoded args
  const commonFields = ['to', 'recipient', 'minter', 'account', 'owner'];
  for (const field of commonFields) {
    if (log.args && log.args[field]) {
      return log.args[field].toLowerCase();
    }
  }
  
  // FALLBACK: Try indexed parameters from topics (for safety)
  // This handles cases where args might not be properly decoded
  if (log.topics && log.topics.length >= 3) {
    try {
      // topics[0] is event signature, topics[1] is usually 'from', topics[2] is 'to'
      const address = ethers.getAddress('0x' + log.topics[2].slice(26));
      console.log(`    ⚠️  Using topics fallback for recipient extraction`);
      return address.toLowerCase();
    } catch (error) {
      // Ignore topics extraction errors
    }
  }
  
  return null;
}

/**
 * Check if an address is one of our wallets
 * @param {string} address - Address to check
 * @param {Array} wallets - Array of wallet addresses
 * @returns {boolean} True if address is one of our wallets
 */
function isOurWallet(address, wallets) {
  const normalizedAddress = address.toLowerCase();
  return wallets.some(w => w.address.toLowerCase() === normalizedAddress);
}

/**
 * Process a mint event log
 * @param {Object} log - Event log
 * @param {Array} wallets - Array of our wallet addresses
 * @param {ethers.Provider} provider - Ethereum provider
 */
async function processMintEvent(log, wallets, provider) {
  try {
    const recipient = extractRecipient(log, settings.mintEvents?.toField || 'to');
    
    if (!recipient) {
      console.log(`    ⚠️  Could not extract recipient from event`);
      return null;
    }
    
    // Check if recipient is one of our wallets
    if (!isOurWallet(recipient, wallets)) {
      // Not our wallet, skip
      return null;
    }
    
    console.log(`    ✅ Mint detected for wallet ${recipient}`);
    console.log(`       TX: ${log.transactionHash}`);
    console.log(`       Block: ${log.blockNumber}`);
    
    // Mark wallet as minted
    await updateWalletStatus(recipient, 'minted');
    
    // Record the mint event
    await addTransaction({
      address: recipient,
      type: 'mint-detected',
      txHash: log.transactionHash,
      status: 'success',
      block: log.blockNumber
    });
    
    // Log to CSV
    await appendToCSV('mint-events.csv', [{
      address: recipient,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      timestamp: new Date().toISOString()
    }], ['address', 'txHash', 'blockNumber', 'logIndex', 'timestamp']);
    
    return recipient;
    
  } catch (error) {
    console.error(`    ❌ Error processing mint event:`, error.message);
    return null;
  }
}

/**
 * Reconcile historical logs from past blocks
 * @param {ethers.Contract} contract - Contract instance
 * @param {Array} wallets - Array of our wallets
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {number} lookbackBlocks - Number of blocks to look back
 */
async function reconcileHistoricalLogs(contract, wallets, provider, lookbackBlocks) {
  console.log(`\n🔍 Reconciling historical logs (last ${lookbackBlocks} blocks)...`);
  
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - lookbackBlocks);
    
    console.log(`   Scanning blocks ${fromBlock} to ${currentBlock}...`);
    
    const filter = createEventFilter(contract);
    const logs = await contract.queryFilter(filter, fromBlock, currentBlock);
    
    console.log(`   Found ${logs.length} total events`);
    
    let mintedCount = 0;
    const mintedWallets = new Set();
    
    for (const log of logs) {
      const recipient = await processMintEvent(log, wallets, provider);
      if (recipient) {
        mintedCount++;
        mintedWallets.add(recipient);
      }
    }
    
    console.log(`   ✅ Found ${mintedCount} mints for our wallets`);
    console.log(`   📊 Unique wallets minted: ${mintedWallets.size}`);
    
    return { mintedCount, mintedWallets: Array.from(mintedWallets) };
    
  } catch (error) {
    console.error(`   ❌ Error reconciling historical logs:`, error.message);
    throw error;
  }
}

/**
 * Start watching for mint events
 * @param {Object} options - Watcher options
 */
export async function startWatcher(options = {}) {
  console.log('👁️  Starting mint event watcher...\n');
  
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const eventConfig = settings.mintEvents;
  
  // Validate configuration
  if (!eventConfig || !eventConfig.address || !eventConfig.event) {
    throw new Error(
      'mintEvents configuration incomplete. Required: address, event in settings.json'
    );
  }
  
  console.log(`Watching: ${eventConfig.address}`);
  console.log(`Event: ${eventConfig.event}`);
  console.log(`Network: ${process.env.NETWORK_NAME || 'unknown'}\n`);
  
  // Load our wallets
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found. Run "npm run gen" first');
  }
  
  console.log(`Monitoring ${wallets.length} wallets\n`);
  
  // Create contract instance
  const eventSig = eventConfig.event;
  
  // Build minimal ABI for the event using the full signature with parameter names
  const eventAbi = [`event ${eventSig}`];
  const contract = new ethers.Contract(eventConfig.address, eventAbi, provider);
  
  // Parse for filter creation
  const { name, params } = parseEventSignature(eventSig);
  
  // Reconcile historical logs first
  const lookbackBlocks = eventConfig.lookbackBlocks || 1000;
  let historicalMints = null;
  
  try {
    historicalMints = await reconcileHistoricalLogs(contract, wallets, provider, lookbackBlocks);
  } catch (error) {
    console.warn('⚠️  Could not reconcile historical logs:', error.message);
  }
  
  // Setup live event listener
  console.log('\n📡 Listening for new events (Ctrl+C to stop)...\n');
  
  const filter = createEventFilter(contract);
  let mintedCount = 0;
  const mintedWallets = new Set();
  
  // Add historical mints to tracking
  if (historicalMints) {
    mintedCount = historicalMints.mintedCount;
    historicalMints.mintedWallets.forEach(addr => mintedWallets.add(addr));
  }
  
  // Listen for new events
  contract.on(name, async (...args) => {
    try {
      // The last argument in the callback is always the event object
      const event = args[args.length - 1];
      const log = event.log;
      
      console.log(`\n📬 New event in block ${log.blockNumber}:`);
      
      // Process with the decoded log that includes args
      const recipient = await processMintEvent(log, wallets, provider);
      
      if (recipient) {
        mintedCount++;
        mintedWallets.add(recipient);
        
        console.log(`\n📊 Progress: ${mintedWallets.size}/${wallets.length} wallets minted`);
        
        // Check if we should trigger consolidation
        if (options.autoConsolidate && mintedWallets.size >= wallets.length * 0.8) {
          console.log('\n🎯 80% threshold reached - consider running consolidation');
        }
      }
      
    } catch (error) {
      console.error('❌ Error processing event:', error.message);
    }
  });
  
  // Send initial status alert
  await sendTelegramAlert(
    `👁️ Watcher Started\n` +
    `Contract: ${eventConfig.address}\n` +
    `Event: ${name}\n` +
    `Wallets: ${wallets.length}\n` +
    `${historicalMints ? `Historical mints found: ${historicalMints.mintedCount}` : ''}`
  );
  
  // Periodic status updates
  const statusInterval = setInterval(async () => {
    console.log(`\n📊 Status Update:`);
    console.log(`   Total mints detected: ${mintedCount}`);
    console.log(`   Unique wallets minted: ${mintedWallets.size}/${wallets.length}`);
    console.log(`   Completion: ${((mintedWallets.size / wallets.length) * 100).toFixed(2)}%`);
  }, 60000); // Every minute
  
  // Graceful shutdown handler
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down watcher...');
    clearInterval(statusInterval);
    provider.removeAllListeners();
    
    console.log('\n📊 Final Statistics:');
    console.log(`   Total mints detected: ${mintedCount}`);
    console.log(`   Unique wallets minted: ${mintedWallets.size}/${wallets.length}`);
    console.log(`   Completion: ${((mintedWallets.size / wallets.length) * 100).toFixed(2)}%`);
    
    await sendTelegramAlert(
      `🛑 Watcher Stopped\n` +
      `Total mints: ${mintedCount}\n` +
      `Wallets minted: ${mintedWallets.size}/${wallets.length}\n` +
      `Completion: ${((mintedWallets.size / wallets.length) * 100).toFixed(2)}%`
    );
    
    process.exit(0);
  });
  
  // Keep process alive
  return new Promise(() => {}); // Never resolves, waits for SIGINT
}

/**
 * Check mint status for all wallets
 */
export async function checkMintStatus() {
  console.log('📊 Checking mint status...\n');
  
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found');
  }
  
  const mintedWallets = getWalletsByStatus('minted');
  const mintedAddresses = new Set(mintedWallets.map(w => w.address.toLowerCase()));
  
  console.log(`Total wallets: ${wallets.length}`);
  console.log(`Minted: ${mintedAddresses.size}`);
  console.log(`Pending: ${wallets.length - mintedAddresses.size}`);
  console.log(`Completion: ${((mintedAddresses.size / wallets.length) * 100).toFixed(2)}%`);
  
  return {
    total: wallets.length,
    minted: mintedAddresses.size,
    pending: wallets.length - mintedAddresses.size
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.includes('--status')) {
    checkMintStatus()
      .then(() => process.exit(0))
      .catch(error => {
        console.error('Error:', error);
        process.exit(1);
      });
  } else {
    startWatcher({ autoConsolidate: args.includes('--auto-consolidate') })
      .catch(error => {
        console.error('Error:', error);
        process.exit(1);
      });
  }
}
