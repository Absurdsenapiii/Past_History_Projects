/**
 * Generate Wallets Module
 * Creates new wallets and stores them securely
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeCSV, getCSVStats } from './logger.js';
import { upsertWallet, getWalletStats } from './tracker.js';
import { isPlaintextEnabled } from './utils.js';

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
 * Generate wallets
 * @returns {Object} Generation results
 */
export async function generateWallets() {
  console.log('🔑 Starting wallet generation...\n');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const isPlaintext = isPlaintextEnabled();
  
  // Determine number of wallets to generate
  let walletCount = settings.walletCount || 10;
  
  // Check for --count flag
  const countArg = process.argv.find(arg => arg.startsWith('--count='));
  if (countArg) {
    walletCount = parseInt(countArg.split('=')[1]);
  }
  
  console.log(`Generating ${walletCount} wallets...`);
  console.log(`Plaintext logging: ${isPlaintext ? 'ENABLED (UNSAFE!)' : 'DISABLED'}`);
  
  // Check if addresses.csv already exists
  const csvStats = getCSVStats('addresses.csv');
  if (csvStats.exists && csvStats.rows > 0) {
    console.warn(`\n⚠️  WARNING: addresses.csv already exists with ${csvStats.rows} wallets!`);
    console.warn('⚠️  Generating new wallets will OVERWRITE the existing file!');
    console.warn('⚠️  Make sure you have backed up any important private keys!');
    
    if (!isDryRun && !process.argv.includes('--force')) {
      console.error('\n❌ Aborted to prevent data loss.');
      console.error('   Use --force flag to override this safety check.\n');
      process.exit(1);
    }
  }
  
  // Security warning for production
  if (isPlaintext) {
    console.warn('\n🚨 SECURITY WARNING 🚨');
    console.warn('You are storing private keys in PLAINTEXT!');
    console.warn('This is ONLY for testing/development.');
    console.warn('NEVER use this in production!');
    console.warn('');
  } else {
    console.warn('\n⚠️  Private key encryption is not yet implemented.');
    console.warn('⚠️  Set SAFE_PLAINTEXT_LOGGING=true in .env for testing only.');
    console.warn('⚠️  For production, implement encrypted keystore in utils.js\n');
    
    if (!isDryRun) {
      console.error('❌ Cannot generate wallets without key storage method.');
      console.error('   Either enable SAFE_PLAINTEXT_LOGGING=true for testing,');
      console.error('   or implement encrypted keystore loading.\n');
      process.exit(1);
    }
  }
  
  if (isDryRun) {
    console.log('\n🔍 DRY RUN MODE - No files will be created\n');
  }
  
  // Generate wallets
  const wallets = [];
  const startTime = Date.now();
  
  console.log('\nGenerating wallets...\n');
  
  for (let i = 0; i < walletCount; i++) {
    const wallet = ethers.Wallet.createRandom();
    
    const walletData = {
      index: i + 1,
      address: wallet.address,
      ...(isPlaintext && { privateKey: wallet.privateKey })
    };
    
    wallets.push(walletData);
    
    console.log(`  [${i + 1}/${walletCount}] ${wallet.address}`);
    
    if (!isDryRun) {
      // Add to tracker database
      upsertWallet(wallet.address, 'generated');
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  // Save to CSV
  if (!isDryRun && isPlaintext) {
    const headers = ['index', 'address'];
    if (isPlaintext) {
      headers.push('privateKey');
    }
    
    await writeCSV('addresses.csv', wallets, headers, true);
    console.log(`\n✅ Saved ${wallets.length} wallets to addresses.csv`);
    
    const stats = getCSVStats('addresses.csv');
    console.log(`   File size: ${(stats.size / 1024).toFixed(2)} KB`);
    console.log(`   Permissions: 0600 (owner read/write only)`);
  }
  
  // Summary
  console.log('\n📊 Generation Summary:');
  console.log(`  ✅ Generated: ${wallets.length} wallets`);
  console.log(`  ⏱️  Duration: ${duration}s`);
  console.log(`  📁 Storage: ${isPlaintext ? 'PLAINTEXT CSV' : 'None (dry run)'}`);
  
  if (isPlaintext) {
    console.log('\n🔒 Security Reminders:');
    console.log('  • addresses.csv contains UNENCRYPTED private keys');
    console.log('  • Keep this file secure and never commit to git');
    console.log('  • Use "npm run wipe-plaintext" to remove keys after testing');
    console.log('  • Implement encrypted keystore for production use');
  }
  
  // Show tracker stats
  if (!isDryRun) {
    const trackerStats = getWalletStats();
    console.log('\n📈 Tracker Stats:');
    console.log(`  Total wallets: ${trackerStats.total}`);
    console.log(`  Generated: ${trackerStats.generated}`);
  }
  
  console.log('\n✅ Wallet generation complete!');
  console.log('\n📋 Next steps:');
  console.log('  1. npm run fund       # Fund wallets with ETH');
  console.log('  2. npm run mint       # Execute mints');
  console.log('  3. npm run consolidate # Consolidate tokens');
  console.log('  4. npm run refund     # Refund remaining ETH');
  
  return {
    count: wallets.length,
    wallets: isDryRun ? [] : wallets.map(w => ({ address: w.address })), // Don't return private keys
    duration,
    dryRun: isDryRun
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateWallets()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
