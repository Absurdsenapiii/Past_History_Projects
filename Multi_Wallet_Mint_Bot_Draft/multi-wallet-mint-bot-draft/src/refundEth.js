/**
 * Refund ETH Module
 * Refunds remaining ETH from all wallets back to funder
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction } from './tracker.js';
import { getGasPrice, waitForConfirmation, calculateGasCost, getGasLimit } from './gas.js';
import { sendTelegramAlert, sleep, loadWalletWithKey, retry, classifyError, formatEth } from './utils.js';

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
 * Calculate refundable amount
 * Leaves enough for gas + minimum dust
 * @param {BigInt} balance - Current balance in wei
 * @param {BigInt} gasCost - Gas cost for refund transaction in wei
 * @param {BigInt} minDust - Minimum dust to leave in wallet
 * @returns {BigInt} Amount that can be refunded
 */
function calculateRefundAmount(balance, gasCost, minDust) {
  // Amount needed to keep: gas cost + dust
  const amountToKeep = gasCost + minDust;
  
  // If balance is less than what we need to keep, can't refund
  if (balance <= amountToKeep) {
    return 0n;
  }
  
  // Refundable amount
  const refundable = balance - amountToKeep;
  
  // Add safety buffer (5% of gas cost)
  const safetyBuffer = gasCost / 20n;
  
  if (refundable <= safetyBuffer) {
    return 0n;
  }
  
  return refundable - safetyBuffer;
}

/**
 * Refund ETH from all wallets
 * @returns {Object} Refund results
 */
export async function refundEth() {
  console.log('💸 Starting ETH refund...');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  // Get funder address
  const funderKey = process.env.FunderPrivateKey;
  if (!funderKey) {
    throw new Error('FunderPrivateKey not set in .env file');
  }
  
  const funderWallet = new ethers.Wallet(funderKey, provider);
  const funderAddress = funderWallet.address;
  
  console.log(`Funder: ${funderAddress}`);
  
  // Parse minimum dust to leave
  const minDust = BigInt(settings.minDustWei || '1000000000000000'); // Default: 0.001 ETH
  console.log(`Min Dust: ${formatEth(minDust)} ETH`);
  
  // Load wallets
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found. Run "npm run gen" first');
  }
  
  // Check for --maxWallets flag
  const maxWalletsArg = process.argv.find(arg => arg.startsWith('--maxWallets='));
  let walletsToProcess = wallets;
  
  if (maxWalletsArg) {
    const maxWallets = parseInt(maxWalletsArg.split('=')[1]);
    walletsToProcess = wallets.slice(0, maxWallets);
    console.log(`⚠️  Limited to ${maxWallets} wallets (--maxWallets flag)`);
  }
  
  console.log(`Checking ${walletsToProcess.length} wallets...\n`);
  
  // Get gas price estimate
  const gasPrice = await getGasPrice(provider, 'refund');
  const gasLimit = getGasLimit('refund');
  const estimatedGasCost = calculateGasCost(gasPrice, gasLimit);
  
  console.log(`Estimated gas cost: ${formatEth(estimatedGasCost)} ETH per refund\n`);
  
  // Setup concurrency limiter
  const limit = pLimit(parseInt(process.env.CONCURRENCY || '10'));
  const refundResults = [];
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let totalRefunded = 0n;
  
  // Refund from individual wallet
  const refundWallet = async (walletData, index) => {
    const address = walletData.address;
    
    try {
      console.log(`  [${index + 1}/${walletsToProcess.length}] Checking ${address}...`);
      
      // Check balance
      const balance = await provider.getBalance(address);
      console.log(`    💰 Balance: ${formatEth(balance)} ETH`);
      
      // Get fresh gas estimate for this transaction
      const currentGasPrice = await getGasPrice(provider, 'refund');
      const gasCost = calculateGasCost(currentGasPrice, gasLimit);
      
      // Calculate refundable amount
      const refundAmount = calculateRefundAmount(balance, gasCost, minDust);
      
      if (refundAmount === 0n) {
        console.log(`    ⏭️  Nothing to refund (balance too low or zero)`);
        console.log(`       Needed: ${formatEth(gasCost + minDust)} ETH (gas + dust)`);
        skippedCount++;
        return { address, status: 'skipped', balance: balance.toString() };
      }
      
      console.log(`    📤 Refundable: ${formatEth(refundAmount)} ETH`);
      console.log(`       Will keep: ${formatEth(balance - refundAmount)} ETH`);
      
      // Load wallet with private key
      const wallet = await loadWalletWithKey(address, provider);
      if (!wallet) {
        throw new Error('Unable to load wallet - check key storage');
      }
      
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: Would refund ${formatEth(refundAmount)} ETH to funder`);
        console.log(`       Gas: ${JSON.stringify(currentGasPrice)}, Limit: ${gasLimit.toString()}`);
        successCount++;
        totalRefunded += refundAmount;
        return { address, status: 'dry-run', refundAmount: refundAmount.toString() };
      }
      
      // Create refund transaction
      const tx = {
        to: funderAddress,
        value: refundAmount,
        gasLimit,
        ...currentGasPrice
      };
      
      // Send transaction with retry logic
      const sendTx = async () => {
        const txResponse = await wallet.sendTransaction(tx);
        console.log(`    📤 TX: ${txResponse.hash}`);
        return txResponse;
      };
      
      const txResponse = await retry(sendTx, {
        maxRetries: settings.retryConfig?.maxRetries || 3,
        baseDelay: settings.retryConfig?.retryDelay || 5000,
        backoffMultiplier: settings.retryConfig?.backoffMultiplier || 1.5
      });
      
      // Wait for confirmation
      const receipt = await waitForConfirmation(
        txResponse,
        settings.confirmations || 1
      );
      
      if (receipt.status === 1) {
        console.log(`    ✅ Refunded in block ${receipt.blockNumber}`);
        successCount++;
        totalRefunded += refundAmount;
        
        // Record transaction
        const txData = {
          address,
          txHash: txResponse.hash,
          type: 'refund',
          amount: refundAmount.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString() || '0',
          block: receipt.blockNumber,
          status: 'success',
          timestamp: new Date().toISOString()
        };
        
        refundResults.push(txData);
        
        // Update tracker
        await updateWalletStatus(address, 'refunded');
        await addTransaction(txData);
        
        return { address, status: 'success', txHash: txResponse.hash, refundAmount: refundAmount.toString() };
      } else {
        console.log(`    ❌ Refund failed`);
        failCount++;
        return { address, status: 'failed', refundAmount: refundAmount.toString() };
      }
      
    } catch (error) {
      console.error(`    ❌ Error refunding from ${address}:`, error.message);
      failCount++;
      
      const errorClass = classifyError(error);
      
      refundResults.push({
        address,
        type: 'refund',
        status: 'failed',
        error: error.message,
        errorClass,
        timestamp: new Date().toISOString()
      });
      
      return { address, status: 'error', error: error.message, errorClass };
    }
  };
  
  console.log('Executing refunds...\n');
  
  // Execute refunds with concurrency control
  const refundPromises = walletsToProcess.map((wallet, index) =>
    limit(() => refundWallet(wallet, index))
  );
  
  const results = await Promise.all(refundPromises);
  
  // Save results to CSV
  if (!isDryRun && refundResults.length > 0) {
    await appendToCSV('refunds.csv', refundResults, [
      'address', 'txHash', 'type', 'amount', 'gasUsed',
      'effectiveGasPrice', 'block', 'status', 'error', 'errorClass', 'timestamp'
    ]);
  }
  
  // Summary
  console.log('\n📊 Refund Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  ⏭️  Skipped (insufficient balance): ${skippedCount}`);
  console.log(`  💰 Total Refunded: ${formatEth(totalRefunded)} ETH`);
  
  if (successCount + failCount > 0) {
    const processedCount = successCount + failCount;
    console.log(`  🎯 Success Rate: ${((successCount / processedCount) * 100).toFixed(2)}%`);
  }
  
  // Send Telegram alert
  await sendTelegramAlert(
    `💸 ETH Refund Complete\n` +
    `Success: ${successCount}\n` +
    `Failed: ${failCount}\n` +
    `Skipped: ${skippedCount}\n` +
    `Total: ${formatEth(totalRefunded)} ETH\n` +
    `Dry Run: ${isDryRun ? 'Yes' : 'No'}`
  );
  
  return {
    success: successCount,
    failed: failCount,
    skipped: skippedCount,
    totalRefunded: totalRefunded.toString(),
    results
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  refundEth()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
