/**
 * Mint Worker Module
 * Executes mint transactions with payable support and enhanced error handling
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction } from './tracker.js';
import { getGasPrice, waitForConfirmation, bumpGasIfNeeded, getGasLimit } from './gas.js';
import { sendTelegramAlert, sleep, loadWalletWithKey, retry, classifyError } from './utils.js';
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
validateSettings(settings, 'mint');

/**
 * Execute mints for all wallets
 */
export async function executeMints() {
  console.log('🚀 Starting mint execution...');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  // Load target contract ABI
  let mintAbi = JSON.parse(
    readFileSync(join(__dirname, 'abi', 'targetMintAbi.json'), 'utf8')
  );
  
  // Create contract interface with fallback for missing ABI
  let mintInterface;
  try {
    mintInterface = new ethers.Interface(mintAbi);
    
    // Verify the ABI contains the required mint function
    const hasFunction = mintInterface.fragments.some(
      f => f.type === 'function' && f.name === settings.mintFunction.split('(')[0]
    );
    
    if (!hasFunction) {
      throw new Error('Required mint function not found in ABI');
    }
  } catch (error) {
    // ABI is empty or doesn't contain the mint function - use signature fallback
    console.warn(`⚠️  ABI invalid or missing mint function: ${error.message}`);
    console.log(`🔧 Falling back to signature-only ABI: function ${settings.mintFunction}`);
    
    // Build minimal ABI from function signature
    const signatureAbi = [`function ${settings.mintFunction}`];
    mintAbi = signatureAbi;
    mintInterface = new ethers.Interface(signatureAbi);
    
    console.log('✅ Using signature-only ABI for encoding (this is safe but less validated)');
  }
  
  // Load wallets
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found. Run "npm run gen" first');
  }
  
  // Check for --maxWallets flag
  const maxWalletsArg = process.argv.find(arg => arg.startsWith('--maxWallets='));
  let walletsToMint = wallets;
  
  if (maxWalletsArg) {
    const maxWallets = parseInt(maxWalletsArg.split('=')[1]);
    walletsToMint = wallets.slice(0, maxWallets);
    console.log(`⚠️  Limited to ${maxWallets} wallets (--maxWallets flag)`);
  }
  
  // Parse mint value
  const mintValue = BigInt(settings.mintValueWei || '0');
  const isPayable = mintValue > 0n;
  
  console.log(`Contract: ${settings.contractAddress}`);
  console.log(`Function: ${settings.mintFunction}`);
  console.log(`Args: ${JSON.stringify(settings.mintArgs)}`);
  console.log(`Value: ${ethers.formatEther(mintValue)} ETH ${isPayable ? '(PAYABLE)' : ''}`);
  console.log(`Wallets: ${walletsToMint.length}`);
  console.log(`Concurrency: ${process.env.CONCURRENCY || 10}`);
  
  // Setup concurrency limiter
  const limit = pLimit(parseInt(process.env.CONCURRENCY || '10'));
  const mintResults = [];
  let successCount = 0;
  let failCount = 0;
  
  // Process mint args - replace {wallet} placeholder
  const processMintArgs = (wallet) => {
    return settings.mintArgs.map(arg => {
      if (arg === '{wallet}') {
        return wallet;
      }
      return arg;
    });
  };
  
  // Mint function
  const mintWithWallet = async (walletData, index) => {
    const address = walletData.address;
    
    try {
      console.log(`  [${index + 1}/${walletsToMint.length}] Minting from ${address}...`);
      
      // Load wallet with private key
      const wallet = await loadWalletWithKey(address, provider);
      if (!wallet) {
        throw new Error('Unable to load wallet - check key storage');
      }
      
      // Create contract instance
      const contract = new ethers.Contract(
        settings.contractAddress,
        mintAbi,
        wallet
      );
      
      // Process arguments
      const args = processMintArgs(address);
      
      // Get gas configuration for mint phase
      const gasPrice = await getGasPrice(provider, 'mint');
      const gasLimit = getGasLimit('mint');
      
      // Encode function data
      const data = mintInterface.encodeFunctionData(
        settings.mintFunction,
        args
      );
      // ========================================
      // MINT PRE-SIMULATION (CRITICAL)
      // ========================================
      // Simulate the mint transaction before broadcasting
      // This catches reverts early and prevents wasting gas
      console.log(`    🔬 Simulating mint...`);
      try {
        const simTx = {
          to: settings.contractAddress,
          from: wallet.address,
          data,
          gasLimit,
          ...(isPayable ? { value: mintValue } : {})
        };
        // Perform an eth_call against latest state
        await provider.call(simTx);
        console.log(`    ✅ Simulation passed`);
      } catch (simError) {
        const errMsg = (simError && (simError.reason || simError.shortMessage || simError.message)) || String(simError);
        const errorClass = classifyError(simError);
        
        console.log(`    ❌ Simulation failed: ${errMsg}`);
        failCount++;
        return { 
          address, 
          status: 'simulation-failed', 
          error: errMsg, 
          errorClass 
        };
      }

      
      // Create transaction
      const tx = {
        to: settings.contractAddress,
        data,
        ...gasPrice,
        gasLimit
      };
      
      // Add value if payable
      if (isPayable) {
        tx.value = mintValue;
        console.log(`    💰 Sending ${ethers.formatEther(mintValue)} ETH with mint`);
      }
      
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: Would mint with args ${JSON.stringify(args)}`);
        if (isPayable) {
          console.log(`       Value: ${ethers.formatEther(mintValue)} ETH`);
        }
        console.log(`       Gas: ${JSON.stringify(gasPrice)}, Limit: ${gasLimit.toString()}`);
        successCount++;
        return { address, status: 'dry-run' };
      }
      
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
      
      // Monitor for gas bumping
      let receipt;
      let bumped = false;
      
      if (settings.gasBump?.enabled) {
        const waitTime = settings.gasBump.waitTime || 45000;
        const startTime = Date.now();
        
        const checkInterval = setInterval(async () => {
          try {
            const pending = await provider.getTransaction(txResponse.hash);
            if (!pending) {
              clearInterval(checkInterval);
              return;
            }
            
            // Check if we should bump
            if (Date.now() - startTime > waitTime && !bumped) {
              console.log(`    ⚡ Bumping gas for ${txResponse.hash}`);
              const bumpedTx = await bumpGasIfNeeded(wallet, txResponse);
              if (bumpedTx) {
                bumped = true;
                console.log(`    📤 Replacement TX: ${bumpedTx.hash}`);
              }
            }
          } catch (error) {
            // Ignore errors in monitoring
          }
        }, 5000);
        
        // Wait for confirmation
        receipt = await waitForConfirmation(
          txResponse,
          settings.confirmations || 1
        );
        
        clearInterval(checkInterval);
      } else {
        // Wait without gas bumping
        receipt = await waitForConfirmation(
          txResponse,
          settings.confirmations || 1
        );
      }
      
      if (receipt.status === 1) {
        console.log(`    ✅ Minted in block ${receipt.blockNumber}`);
        successCount++;
        
        // Record transaction
        const txData = {
          address,
          txHash: txResponse.hash,
          type: 'mint',
          function: settings.mintFunction,
          args: JSON.stringify(args),
          value: mintValue.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString() || '0',
          block: receipt.blockNumber,
          status: 'success',
          timestamp: new Date().toISOString()
        };
        
        mintResults.push(txData);
        
        // Update tracker
        await updateWalletStatus(address, 'minted');
        await addTransaction(txData);
        
        return { address, status: 'success', txHash: txResponse.hash };
      } else {
        console.log(`    ❌ Mint failed`);
        failCount++;
        return { address, status: 'failed' };
      }
      
    } catch (error) {
      console.error(`    ❌ Error minting from ${address}:`, error.message);
      failCount++;
      
      const errorClass = classifyError(error);
      
      mintResults.push({
        address,
        type: 'mint',
        status: 'failed',
        error: error.message,
        errorClass,
        timestamp: new Date().toISOString()
      });
      
      return { address, status: 'error', error: error.message, errorClass };
    }
  };
  
  console.log('\nExecuting mints...\n');
  
  // Execute mints with concurrency control
  const mintPromises = walletsToMint.map((wallet, index) =>
    limit(() => mintWithWallet(wallet, index))
  );
  
  const results = await Promise.all(mintPromises);
  
  // Save results to CSV
  if (!isDryRun && mintResults.length > 0) {
    await appendToCSV('mints.csv', mintResults, [
      'address', 'txHash', 'type', 'function', 'args', 'value', 'gasUsed',
      'effectiveGasPrice', 'block', 'status', 'error', 'errorClass', 'timestamp'
    ]);
  }
  
  // Summary
  console.log('\n📊 Mint Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  🎯 Success Rate: ${((successCount / walletsToMint.length) * 100).toFixed(2)}%`);
  if (isPayable) {
    console.log(`  💰 Total Value Sent: ${ethers.formatEther(mintValue * BigInt(successCount))} ETH`);
  }
  
  // Send Telegram alert
  await sendTelegramAlert(
    `🚀 Minting Complete\n` +
    `Success: ${successCount}/${walletsToMint.length}\n` +
    `Failed: ${failCount}\n` +
    `Success Rate: ${((successCount / walletsToMint.length) * 100).toFixed(2)}%\n` +
    (isPayable ? `Total sent: ${ethers.formatEther(mintValue * BigInt(successCount))} ETH\n` : '') +
    `Dry Run: ${isDryRun ? 'Yes' : 'No'}`
  );
  
  return {
    success: successCount,
    failed: failCount,
    total: walletsToMint.length,
    results
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  executeMints()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
