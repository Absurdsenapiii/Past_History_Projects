/**
 * Funder Send Module
 * Funds wallets with ETH or USDC with NonceManager and budget validation
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction } from './tracker.js';
import { getGasPrice, calculateGasCost, getGasLimit } from './gas.js';
import { sendTelegramAlert, sleep, formatEth, retry, classifyError } from './utils.js';
import { validateSettings } from './utils.js';

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
 * Simple NonceManager for funder wallet
 * Prevents nonce collisions when sending multiple transactions rapidly
 */
class NonceManager {
  constructor(wallet) {
    this.wallet = wallet;
    this.nonce = null;
    this.pendingNonce = null;
  }
  
  async initialize() {
    this.nonce = await this.wallet.provider.getTransactionCount(
      this.wallet.address,
      'latest'
    );
    this.pendingNonce = this.nonce;
  }
  
  async getNextNonce() {
    if (this.pendingNonce === null) {
      await this.initialize();
    }
    const nonce = this.pendingNonce;
    this.pendingNonce++;
    return nonce;
  }
  
  reset() {
    this.nonce = null;
    this.pendingNonce = null;
  }
}

/**
 * Calculate total gas budget required for funding operation
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {number} walletCount - Number of wallets to fund
 * @param {BigInt} prefundAmount - Amount to send to each wallet in wei
 * @returns {Object} Budget breakdown
 */
async function calculateGasBudget(provider, walletCount, prefundAmount) {
  console.log('\n💰 Calculating gas budget...');
  
  // Get current gas price
  const gasPrice = await getGasPrice(provider, 'fund');
  const gasLimit = getGasLimit('fund');
  
  // Calculate gas cost per transaction
  const gasCostPerTx = calculateGasCost(gasPrice, gasLimit);
  
  // Total gas cost for all transfers
  const totalGasCost = gasCostPerTx * BigInt(walletCount);
  
  // Total ETH to send to wallets
  const totalPrefund = prefundAmount * BigInt(walletCount);
  
  // Safety margin
  const safetyMarginEth = settings.funder?.safetyMarginEth || '0.05';
  const safetyMargin = ethers.parseEther(safetyMarginEth);
  
  // Total required
  const totalRequired = totalPrefund + totalGasCost + safetyMargin;
  
  console.log('  Budget breakdown:');
  console.log(`    Wallets: ${walletCount}`);
  console.log(`    Per-wallet prefund: ${formatEth(prefundAmount)} ETH`);
  console.log(`    Total prefund: ${formatEth(totalPrefund)} ETH`);
  console.log(`    Gas per TX: ${formatEth(gasCostPerTx)} ETH`);
  console.log(`    Total gas cost: ${formatEth(totalGasCost)} ETH`);
  console.log(`    Safety margin: ${formatEth(safetyMargin)} ETH`);
  console.log(`    ─────────────────────────────`);
  console.log(`    Total required: ${formatEth(totalRequired)} ETH`);
  
  return {
    walletCount,
    prefundPerWallet: prefundAmount,
    totalPrefund,
    gasCostPerTx,
    totalGasCost,
    safetyMargin,
    totalRequired
  };
}

/**
 * Validate funder has sufficient balance
 * @param {ethers.Wallet} funder - Funder wallet
 * @param {BigInt} totalRequired - Total amount required in wei
 * @returns {boolean} True if sufficient
 */
async function validateFunderBalance(funder, totalRequired) {
  const balance = await funder.provider.getBalance(funder.address);
  
  console.log(`\n💳 Funder wallet: ${funder.address}`);
  console.log(`   Balance: ${formatEth(balance)} ETH`);
  console.log(`   Required: ${formatEth(totalRequired)} ETH`);
  
  if (balance < totalRequired) {
    const shortage = totalRequired - balance;
    console.error(`\n❌ INSUFFICIENT BALANCE`);
    console.error(`   Shortage: ${formatEth(shortage)} ETH`);
    console.error(`   Please add ${formatEth(shortage)} ETH to funder wallet`);
    console.error(`   Funder address: ${funder.address}\n`);
    return false;
  }
  
  const surplus = balance - totalRequired;
  console.log(`   ✅ Sufficient balance (surplus: ${formatEth(surplus)} ETH)`);
  
  return true;
}

/**
 * Fund all wallets with ETH
 * @returns {Object} Funding results
 */
export async function fundWallets() {
  console.log('💸 Starting wallet funding...');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  // Load funder wallet
  const funderKey = process.env.FunderPrivateKey;
  if (!funderKey) {
    throw new Error('FunderPrivateKey not set in .env file');
  }
  
  const funderWallet = new ethers.Wallet(funderKey, provider);
  
  // Load wallets to fund
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found. Run "npm run gen" first');
  }
  
  // Check for --maxWallets flag
  const maxWalletsArg = process.argv.find(arg => arg.startsWith('--maxWallets='));
  let maxWallets = wallets.length;
  
  if (maxWalletsArg) {
    maxWallets = parseInt(maxWalletsArg.split('=')[1]);
    console.log(`⚠️  Limited to ${maxWallets} wallets (--maxWallets flag)`);
  }
  
  const walletsToFund = wallets.slice(0, maxWallets);
  
  // Parse prefund amount
  const prefundAmount = BigInt(settings.prefundEthWei);
  
  // Calculate gas budget
  const budget = await calculateGasBudget(provider, walletsToFund.length, prefundAmount);
  
  // Validate funder balance
  if (!isDryRun) {
    const hasSufficientBalance = await validateFunderBalance(funderWallet, budget.totalRequired);
    if (!hasSufficientBalance) {
      process.exit(1);
    }
  }
  
  console.log(`\nFunding ${walletsToFund.length} wallets with ${formatEth(prefundAmount)} ETH each...\n`);
  
  // Initialize NonceManager for funder
  const nonceManager = new NonceManager(funderWallet);
  await nonceManager.initialize();
  
  console.log(`Starting nonce: ${nonceManager.pendingNonce}`);
  
  // Setup concurrency limiter
  const limit = pLimit(parseInt(process.env.CONCURRENCY || '10'));
  const fundingResults = [];
  let successCount = 0;
  let failCount = 0;
  
  // Fund individual wallet
  const fundWallet = async (walletData, index) => {
    const address = walletData.address;
    
    try {
      console.log(`  [${index + 1}/${walletsToFund.length}] Funding ${address}...`);
      
      // Get next nonce
      const nonce = await nonceManager.getNextNonce();
      
      // Get gas price
      const gasPrice = await getGasPrice(provider, 'fund');
      const gasLimit = getGasLimit('fund');
      
      // Create transaction
      const tx = {
        to: address,
        value: prefundAmount,
        nonce,
        gasLimit,
        ...gasPrice
      };
      
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: Would send ${formatEth(prefundAmount)} ETH (nonce: ${nonce})`);
        successCount++;
        return { address, status: 'dry-run', nonce };
      }
      
      // Send transaction with retry logic
      const sendTx = async () => {
        const txResponse = await funderWallet.sendTransaction(tx);
        console.log(`    📤 TX: ${txResponse.hash} (nonce: ${nonce})`);
        return txResponse;
      };
      
      const txResponse = await retry(sendTx, {
        maxRetries: settings.retryConfig?.maxRetries || 3,
        baseDelay: settings.retryConfig?.retryDelay || 5000,
        backoffMultiplier: settings.retryConfig?.backoffMultiplier || 1.5
      });
      
      // Wait for confirmation
      const receipt = await txResponse.wait(settings.confirmations || 1);
      
      if (receipt.status === 1) {
        console.log(`    ✅ Funded in block ${receipt.blockNumber}`);
        successCount++;
        
        // Record transaction
        const txData = {
          address,
          txHash: txResponse.hash,
          type: 'fund',
          amount: prefundAmount.toString(),
          nonce: nonce.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString() || '0',
          block: receipt.blockNumber,
          status: 'success',
          timestamp: new Date().toISOString()
        };
        
        fundingResults.push(txData);
        
        // Update tracker
        await updateWalletStatus(address, 'funded');
        await addTransaction(txData);
        
        return { address, status: 'success', txHash: txResponse.hash, nonce };
      } else {
        console.log(`    ❌ Funding failed`);
        failCount++;
        return { address, status: 'failed', nonce };
      }
      
    } catch (error) {
      console.error(`    ❌ Error funding ${address}:`, error.message);
      failCount++;
      
      const errorClass = classifyError(error);
      
      fundingResults.push({
        address,
        type: 'fund',
        status: 'failed',
        error: error.message,
        errorClass,
        timestamp: new Date().toISOString()
      });
      
      return { address, status: 'error', error: error.message, errorClass };
    }
  };
  
  console.log('Executing funding...\n');
  
  // Execute funding with concurrency control
  const fundingPromises = walletsToFund.map((wallet, index) =>
    limit(() => fundWallet(wallet, index))
  );
  
  const results = await Promise.all(fundingPromises);
  
  // Save results to CSV
  if (!isDryRun && fundingResults.length > 0) {
    await appendToCSV('funding.csv', fundingResults, [
      'address', 'txHash', 'type', 'amount', 'nonce', 'gasUsed',
      'effectiveGasPrice', 'block', 'status', 'error', 'errorClass', 'timestamp'
    ]);
  }
  
  // Summary
  console.log('\n📊 Funding Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  🎯 Success Rate: ${((successCount / walletsToFund.length) * 100).toFixed(2)}%`);
  console.log(`  💰 Total Sent: ${formatEth(prefundAmount * BigInt(successCount))} ETH`);
  
  // Send Telegram alert
  await sendTelegramAlert(
    `💸 Funding Complete\n` +
    `Success: ${successCount}/${walletsToFund.length}\n` +
    `Failed: ${failCount}\n` +
    `Total sent: ${formatEth(prefundAmount * BigInt(successCount))} ETH\n` +
    `Dry Run: ${isDryRun ? 'Yes' : 'No'}`
  );
  
  return {
    success: successCount,
    failed: failCount,
    total: walletsToFund.length,
    totalSent: prefundAmount * BigInt(successCount),
    results
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  fundWallets()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

// Display a budget table and flag shortages
export function renderBudgetTable(rows) {
  // rows: [{address, neededWei, currentWei, shortfallWei}]
  const headers = ['Wallet','NeededWei','CurrentWei','ShortfallWei'];
  console.log(headers.join('\t'));
  let totalNeed=0n, totalCur=0n, totalShort=0n;
  for (const r of rows) {
    const need = BigInt(r.neededWei||0);
    const cur = BigInt(r.currentWei||0);
    const short = need > cur ? (need - cur) : 0n;
    totalNeed += need; totalCur += cur; totalShort += short;
    console.log(`${r.address}\t${need}\t${cur}\t${short}`);
  }
  console.log(`TOTAL\t${totalNeed}\t${totalCur}\t${totalShort}`);
  if (totalShort > 0n) console.log(`⚠️ Budget shortage: ${totalShort} wei`);
  else console.log(`✅ Budget sufficient`);
}
