/**
 * Consolidate Module
 * Consolidates ERC-20 tokens from all wallets back to funder
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction, getWalletsByStatus } from './tracker.js';
import { getGasPrice, waitForConfirmation, getGasLimit } from './gas.js';
import { sendTelegramAlert, sleep, loadWalletWithKey, retry, classifyError, formatEth } from './utils.js';
import { validateSettings } from './utils.js';


import { readFileSync } from "fs";
import { join } from "path";
import { validateSettings } from "./utils.js";

const settings = JSON.parse(
  readFileSync(join(__dirname, "..", "config", "settings.json"), "utf8")
);
validateSettings(settings);

  readFileSync(join(__dirname, '..', 'config', 'settings.json'), 'utf8')
validateSettings(settings);
const __dirname = dirname(fileURLToPath(import.meta.url));
config();

// Load settings
readFileSync(join(__dirname, '..', 'config', 'settings.json'), 'utf8')
);

// Standard ERC-20 ABI for balanceOf and transfer
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

/**
 * Get token information
 * @param {ethers.Contract} tokenContract - Token contract instance
 * @returns {Object} Token info
 */
async function getTokenInfo(tokenContract) {
  try {
    const [symbol, decimals] = await Promise.all([
      tokenContract.symbol().catch(() => 'TOKEN'),
      tokenContract.decimals().catch(() => 18)
    ]);
    
    return { symbol, decimals };
  } catch (error) {
    console.warn('⚠️  Could not fetch token info, using defaults');
    return { symbol: 'TOKEN', decimals: 18 };
  }
}

/**
 * Format token amount
 * @param {BigInt} amount - Amount in smallest unit
 * @param {number} decimals - Token decimals
 * @returns {string} Formatted amount
 */
function formatTokenAmount(amount, decimals) {
  try { return ethers.formatUnits(amount, decimals); }
  catch { return (Number(amount) / Math.pow(10, Number(decimals))).toString(); }
}
  catch { return Number(amount) / Math.pow(10, Number(decimals)); }
}
/**
 * Consolidate tokens from all wallets
 * @returns {Object} Consolidation results
 */
export async function consolidateTokens() {
  console.log('🔄 Starting token consolidation...');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  // Validate token address
  if (!settings.tokenAddress || settings.tokenAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('tokenAddress not configured in settings.json');
  }
  
  // Get funder address
  const funderKey = process.env.FunderPrivateKey;
  if (!funderKey) {
    throw new Error('FunderPrivateKey not set in .env file');
  }
  
  const funderWallet = new ethers.Wallet(funderKey, provider);
  const funderAddress = funderWallet.address;
  
  console.log(`Token: ${settings.tokenAddress}`);
  console.log(`Funder: ${funderAddress}`);
  
  // Load token contract
  const tokenContract = new ethers.Contract(
    settings.tokenAddress,
    ERC20_ABI,
    provider
  );
  
  // Get token info
  const { symbol, decimals } = await getTokenInfo(tokenContract);
  console.log(`Symbol: ${symbol}, Decimals: ${decimals}`);
  
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
  
  // Optionally filter to only minted wallets
  const onlyMinted = process.argv.includes('--only-minted');
  if (onlyMinted) {
    const mintedWallets = getWalletsByStatus('minted');
    const mintedAddresses = new Set(mintedWallets.map(w => w.address.toLowerCase()));
    walletsToProcess = walletsToProcess.filter(w => 
      mintedAddresses.has(w.address.toLowerCase())
    );
    console.log(`📌 Filtering to ${walletsToProcess.length} minted wallets only`);
  }
  
  console.log(`Checking ${walletsToProcess.length} wallets...\n`);
  
  // Setup concurrency limiter
  const limit = pLimit(parseInt(process.env.CONCURRENCY || '10'));
  const consolidationResults = [];
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let totalConsolidated = 0n;
  
  // Consolidate from individual wallet
  const consolidateWallet = async (walletData, index) => {
    const address = walletData.address;
    
    try {
      console.log(`  [${index + 1}/${walletsToProcess.length}] Checking ${address}...`);
      
      // Check balance
      const balance = await tokenContract.balanceOf(address);
      
      if (balance === 0n) {
        console.log(`    ⏭️  Balance: 0 ${symbol} (skipping)`);
        skippedCount++;
        return { address, status: 'skipped', balance: '0' };
      }
      
      console.log(`    💰 Balance: ${formatTokenAmount(balance, decimals)} ${symbol}`);
      
      // Load wallet with private key
      const wallet = await loadWalletWithKey(address, provider);
      if (!wallet) {
        throw new Error('Unable to load wallet - check key storage');
      }
      
      // Create contract instance with wallet
      const tokenWithSigner = tokenContract.connect(wallet);
      
      // Get gas configuration for consolidate phase
      const gasPrice = await getGasPrice(provider, 'consolidate');
      const gasLimit = getGasLimit('consolidate');
      
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: Would transfer ${formatTokenAmount(balance, decimals)} ${symbol} to funder`);
        console.log(`       Gas: ${JSON.stringify(gasPrice)}, Limit: ${gasLimit.toString()}`);
        successCount++;
        totalConsolidated += balance;
        return { address, status: 'dry-run', balance: balance.toString() };
      }
      
      // Execute transfer
      const transferTx = async () => {
        const tx = await tokenWithSigner.transfer(funderAddress, balance, {
          gasLimit,
          ...gasPrice
        });
        console.log(`    📤 TX: ${tx.hash}`);
        return tx;
      };
      
      const txResponse = await retry(transferTx, {
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
        console.log(`    ✅ Consolidated in block ${receipt.blockNumber}`);
        successCount++;
        totalConsolidated += balance;
        
        // Record transaction
        const txData = {
          address,
          txHash: txResponse.hash,
          type: 'consolidate',
          amount: balance.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString() || '0',
          block: receipt.blockNumber,
          status: 'success',
          timestamp: new Date().toISOString()
        };
        
        consolidationResults.push(txData);
        
        // Update tracker
        await updateWalletStatus(address, 'consolidated');
        await addTransaction(txData);
        
        return { address, status: 'success', txHash: txResponse.hash, balance: balance.toString() };
      } else {
        console.log(`    ❌ Consolidation failed`);
        failCount++;
        return { address, status: 'failed', balance: balance.toString() };
      }
      
    } catch (error) {
      console.error(`    ❌ Error consolidating from ${address}:`, error.message);
      failCount++;
      
      const errorClass = classifyError(error);
      
      consolidationResults.push({
        address,
        type: 'consolidate',
        status: 'failed',
        error: error.message,
        errorClass,
        timestamp: new Date().toISOString()
      });
      
      return { address, status: 'error', error: error.message, errorClass };
    }
  };
  
  console.log('Executing consolidations...\n');
  
  // Execute consolidations with concurrency control
  const consolidatePromises = walletsToProcess.map((wallet, index) =>
    limit(() => consolidateWallet(wallet, index))
  );
  
  const results = await Promise.all(consolidatePromises);
  
  // Save results to CSV
  if (!isDryRun && consolidationResults.length > 0) {
    await appendToCSV('consolidations.csv', consolidationResults, [
      'address', 'txHash', 'type', 'amount', 'gasUsed',
      'effectiveGasPrice', 'block', 'status', 'error', 'errorClass', 'timestamp'
    ]);
  }
  
  // Summary
  console.log('\n📊 Consolidation Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  ⏭️  Skipped (zero balance): ${skippedCount}`);
  console.log(`  📦 Total Consolidated: ${formatTokenAmount(totalConsolidated, decimals)} ${symbol}`);
  
  if (successCount + failCount > 0) {
    const processedCount = successCount + failCount;
    console.log(`  🎯 Success Rate: ${((successCount / processedCount) * 100).toFixed(2)}%`);
  }
  
  // Send Telegram alert
  await sendTelegramAlert(
    `🔄 Consolidation Complete\n` +
    `Success: ${successCount}\n` +
    `Failed: ${failCount}\n` +
    `Skipped: ${skippedCount}\n` +
    `Total: ${formatTokenAmount(totalConsolidated, decimals)} ${symbol}\n` +
    `Dry Run: ${isDryRun ? 'Yes' : 'No'}`
  );
  
  return {
    success: successCount,
    failed: failCount,
    skipped: skippedCount,
    totalConsolidated: totalConsolidated.toString(),
    results
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  consolidateTokens()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
