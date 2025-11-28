#!/usr/bin/env node
/**
 * ERC-20 Multi-Wallet Mint Bot
 * Main entry point for orchestrating mint operations
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig, checkNetworkSafety } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load environment variables
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

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

console.log(`
╔══════════════════════════════════════════╗
║      ERC-20 Multi-Wallet Mint Bot        ║
║         v2.0 - Enhanced Edition          ║
╚══════════════════════════════════════════╝

Network: ${process.env.NETWORK_NAME || 'unknown'}
Dry Run: ${process.env.DRY_RUN === 'true' ? 'YES' : 'NO'}
Payment Mode: ${settings.paymentMode || 'directMint'}
Plaintext Logging: ${process.env.SAFE_PLAINTEXT_LOGGING === 'true' ? 'ENABLED (UNSAFE!)' : 'DISABLED'}
`);

if (process.env.SAFE_PLAINTEXT_LOGGING === 'true') {
  console.warn('⚠️  WARNING: Plaintext key logging is ENABLED!');
  console.warn('⚠️  This is for TESTING ONLY. Never use in production!');
  console.warn('⚠️  Delete all logs after testing and secure your system!');
  console.warn('');
}

/**
 * Main command router with validation
 */
async function main() {
  try {
    // Validate configuration before any operations
    console.log('🔍 Validating configuration...');
    validateConfig(settings, command);
    console.log('✅ Configuration valid\n');
    
    // Check network safety for plaintext logging
    if (command !== 'status' && command !== 'help') {
      const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
      await checkNetworkSafety(provider);
    }
    
    switch (command) {
      case 'generate':
      case 'gen':
        const { generateWallets } = await import('./generateWallets.js');
        await generateWallets();
        break;
        
      case 'fund':
        const { fundWallets } = await import('./funderSend.js');
        await fundWallets();
        break;
      
      case 'pay':
      case 'payment':
        if (settings.paymentMode !== 'usdcAuthorization') {
          console.error('❌ Payment mode must be "usdcAuthorization" to use this command');
          console.error('   Update settings.json or use "npm run mint" for direct minting');
          process.exit(1);
        }
        const { executeUSDCAuthorizations } = await import('./payment.js');
        await executeUSDCAuthorizations();
        break;
        
      case 'mint':
        if (settings.paymentMode === 'usdcAuthorization') {
          console.warn('⚠️  Note: You are in usdcAuthorization mode');
          console.warn('   Run "npm run pay" first to submit authorizations');
          console.warn('   Then use "npm run watch" to detect mints\n');
        }
        const { executeMints } = await import('./mintWorker.js');
        await executeMints();
        break;
      
      case 'watch':
      case 'watcher':
        const { startWatcher } = await import('./watcher.js');
        await startWatcher({
          autoConsolidate: args.includes('--auto-consolidate')
        });
        break;
        
      case 'consolidate':
        const { consolidateTokens } = await import('./consolidate.js');
        await consolidateTokens();
        break;
        
      case 'refund':
        const { refundEth } = await import('./refundEth.js');
        await refundEth();
        break;
        
      case 'status':
        const { showStatus } = await import('./tracker.js');
        await showStatus();
        break;
      
      case 'help':
      default:
        showHelp();
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Display help information
 */
function showHelp() {
  const mode = settings.paymentMode || 'directMint';
  
  console.log('Available commands:\n');
  
  if (mode === 'directMint') {
    console.log('📋 Direct Mint Flow:');
    console.log('  npm run gen         - Generate wallets');
    console.log('  npm run fund        - Fund wallets with ETH');
    console.log('  npm run mint        - Execute mints');
    console.log('  npm run consolidate - Consolidate ERC-20 tokens');
    console.log('  npm run refund      - Refund remaining ETH');
    console.log('  npm run status      - Show current status');
  } else {
    console.log('📋 USDC Authorization Flow:');
    console.log('  npm run gen         - Generate wallets');
    console.log('  npm run fund        - Fund wallets with USDC + gas ETH');
    console.log('  npm run pay         - Sign & submit USDC authorizations');
    console.log('  npm run watch       - Watch for mint events');
    console.log('  npm run consolidate - Consolidate tokens (after mints detected)');
    console.log('  npm run refund      - Refund remaining ETH');
    console.log('  npm run status      - Show current status');
  }
  
  console.log('\n🧪 Dry run variants (prefix with dry:):');
  console.log('  npm run dry:gen, dry:fund, dry:mint, etc.');
  
  console.log('\n🛠️  Additional tools:');
  console.log('  npm run watch -- --auto-consolidate  # Auto-trigger consolidation');
  console.log('  npm run wipe-plaintext               # Remove private keys from logs');
  
  console.log('\n⚙️  Runtime flags:');
  console.log('  --maxWallets=N      # Limit batch size to N wallets');
  console.log('  --i-understand      # Override production network safety check');
  
  console.log('\n📚 Documentation:');
  console.log('  See README.md for detailed usage and examples');
  console.log('  See UPGRADE_GUIDE.md for new features');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { settings };
