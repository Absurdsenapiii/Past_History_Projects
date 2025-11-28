/**
 * Gas Management Module
 * Handles gas price fetching, estimation, and bumping with per-phase settings
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

let __gasCeilingWarned = false;
const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * Apply gas ceiling to gas configuration
 * @param {Object} gasConfig - Gas configuration
 * @param {number} ceilGwei - Maximum gas price in gwei
 * @returns {Object} Gas configuration with ceiling applied
 */
function applyGasCeiling(gasConfig, ceilGwei) {
  if (!ceilGwei || ceilGwei <= 0) {
    return gasConfig;
  }
  
  const ceilWei = ethers.parseUnits(ceilGwei.toString(), 'gwei');
  
  if (gasConfig.type === 2) {
    // EIP-1559: Apply ceiling to maxFeePerGas
    const maxFee = BigInt(gasConfig.maxFeePerGas);
    if (maxFee > ceilWei) {
      if (!__gasCeilingWarned) { 
        console.warn(`⚠️  Gas ceiling applied: ${ceilGwei} gwei max`);
        __gasCeilingWarned = true;
      }
      return {
        maxFeePerGas: ceilWei.toString(),
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        type: 2
      };
    }
  } else {
    // Legacy: Apply ceiling to gasPrice
    const gasPrice = BigInt(gasConfig.gasPrice);
    if (gasPrice > ceilWei) {
      if (!__gasCeilingWarned) { 
        console.warn(`⚠️  Gas ceiling applied: ${ceilGwei} gwei max`);
        __gasCeilingWarned = true;
      }
      return {
        gasPrice: ceilWei.toString(),
        type: 0
      };
    }
  }
  
  return gasConfig;
}

/**
 * Get gas limit for specific transaction phase
 * @param {string} phase - Transaction phase (mint, fund, consolidate, refund)
 * @returns {BigInt} Gas limit
 */
export function getGasLimit(phase) {
  // Check for phase-specific gas limit
  if (settings.gas?.[phase]?.gasLimit) {
    return BigInt(settings.gas[phase].gasLimit);
  }
  
  // Fall back to default gasLimit
  if (settings.gas?.gasLimit) {
    return BigInt(settings.gas.gasLimit);
  }
  
  // Hard defaults by phase
  const defaults = {
    mint: '300000',
    fund: '21000',
    consolidate: '120000',
    refund: '21000',
    default: '200000'
  };
  
  return BigInt(defaults[phase] || defaults.default);
}

/**
 * Get optimal gas price for transaction
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {string} txType - Type of transaction (fund, mint, consolidate, refund)
 * @returns {Object} Gas price configuration
 */
export async function getGasPrice(provider, txType = 'default') {
  let gasConfig;
  
  try {
    // Check if dynamic pricing is enabled
    if (settings.gas?.useDynamic) {
      // Get fee data from provider
      const feeData = await provider.getFeeData();
      
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        // EIP-1559 transaction
        gasConfig = {
          maxFeePerGas: feeData.maxFeePerGas.toString(),
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.toString(),
          type: 2 // EIP-1559
        };
      } else if (feeData.gasPrice) {
        // Legacy transaction
        gasConfig = {
          gasPrice: feeData.gasPrice.toString(),
          type: 0 // Legacy
        };
      }
    }
  } catch (error) {
    console.warn(`⚠️  Failed to fetch dynamic gas price: ${error.message}`);
  }
  
  // Fall back to configured values if dynamic failed
  if (!gasConfig) {
    if (settings.gas?.maxFeePerGas && settings.gas?.maxPriorityFeePerGas) {
      gasConfig = {
        maxFeePerGas: settings.gas.maxFeePerGas,
        maxPriorityFeePerGas: settings.gas.maxPriorityFeePerGas,
        type: 2
      };
    } else {
      // Default legacy gas price
      gasConfig = {
        gasPrice: settings.gas?.gasPrice || '20000000000', // 20 gwei default
        type: 0
      };
    }
  }
  
  // Apply gas ceiling
  const ceilGwei = settings.gas?.ceilGwei;
  if (ceilGwei) {
    gasConfig = applyGasCeiling(gasConfig, ceilGwei);
  }
  
  return gasConfig;
}

/**
 * Estimate gas for a transaction
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {Object} tx - Transaction object
 * @returns {BigInt} Estimated gas limit
 */
export async function estimateGas(provider, tx) {
  try {
    const estimate = await provider.estimateGas(tx);
    // Add 20% buffer
    return (estimate * 120n) / 100n;
  } catch (error) {
    console.warn(`⚠️  Gas estimation failed, using default: ${error.message}`);
    return BigInt(settings.gas?.gasLimit || '200000');
  }
}

/**
 * Wait for transaction confirmation
 * @param {ethers.TransactionResponse} tx - Transaction response
 * @param {number} confirmations - Number of confirmations to wait
 * @returns {ethers.TransactionReceipt} Transaction receipt
 */
export async function waitForConfirmation(tx, confirmations = 1) {
  try {
    const receipt = await tx.wait(confirmations);
    return receipt;
  } catch (error) {
    // Check if transaction was replaced
    if (error.code === 'TRANSACTION_REPLACED') {
      console.log('    ⚡ Transaction was replaced');
      if (error.replacement && error.replacement.receipt) {
        return error.replacement.receipt;
      }
    }
    throw error;
  }
}

/**
 * Bump gas price if transaction is stuck
 * @param {ethers.Wallet} wallet - Wallet instance
 * @param {ethers.TransactionResponse} originalTx - Original transaction
 * @returns {ethers.TransactionResponse|null} New transaction or null
 */
export async function bumpGasIfNeeded(wallet, originalTx) {
  try {
    const provider = wallet.provider;
    
    // Check if transaction is still pending
    const tx = await provider.getTransaction(originalTx.hash);
    if (!tx) {
      console.log('    Transaction not found or already mined');
      return null;
    }
    
    // Get current gas price
    const currentGasPrice = await getGasPrice(provider, 'bump');
    
    // Calculate bumped price (10% increase by default)
    const bumpPercent = settings.gasBump?.bumpPercent || 10;
    const multiplier = BigInt(100 + bumpPercent);
    
    let newGasConfig;
    
    if (currentGasPrice.type === 2) {
      // EIP-1559
      const oldMaxFee = BigInt(tx.maxFeePerGas || '0');
      const oldMaxPriority = BigInt(tx.maxPriorityFeePerGas || '0');
      
      newGasConfig = {
        maxFeePerGas: ((oldMaxFee * multiplier) / 100n).toString(),
        maxPriorityFeePerGas: ((oldMaxPriority * multiplier) / 100n).toString(),
        type: 2
      };
    } else {
      // Legacy
      const oldGasPrice = BigInt(tx.gasPrice || '0');
      newGasConfig = {
        gasPrice: ((oldGasPrice * multiplier) / 100n).toString(),
        type: 0
      };
    }
    
    // Apply gas ceiling to bumped price
    const ceilGwei = settings.gas?.ceilGwei;
    if (ceilGwei) {
      newGasConfig = applyGasCeiling(newGasConfig, ceilGwei);
    }
    
    // Create replacement transaction
    const replacementTx = {
      to: tx.to,
      data: tx.data,
      value: tx.value,
      nonce: tx.nonce, // Same nonce to replace
      gasLimit: tx.gasLimit,
      ...newGasConfig
    };
    
    console.log(`    Bumping gas: ${JSON.stringify(newGasConfig)}`);
    
    // Send replacement transaction
    const newTx = await wallet.sendTransaction(replacementTx);
    return newTx;
    
  } catch (error) {
    console.error(`    Failed to bump gas: ${error.message}`);
    return null;
  }
}

/**
 * Monitor pending transactions and auto-bump if needed
 * @param {Array} transactions - Array of transaction responses
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {Object} options - Monitoring options
 */
export async function monitorTransactions(transactions, provider, options = {}) {
  const waitTime = options.waitTime || settings.gasBump?.waitTime || 45000;
  const checkInterval = options.checkInterval || 5000;
  
  const monitoring = new Map();
  
  // Start monitoring each transaction
  for (const tx of transactions) {
    monitoring.set(tx.hash, {
      tx,
      startTime: Date.now(),
      bumped: false,
      interval: setInterval(async () => {
        try {
          const pending = await provider.getTransaction(tx.hash);
          if (!pending) {
            // Transaction mined or dropped
            clearInterval(monitoring.get(tx.hash).interval);
            monitoring.delete(tx.hash);
            return;
          }
          
          const elapsed = Date.now() - monitoring.get(tx.hash).startTime;
          if (elapsed > waitTime && !monitoring.get(tx.hash).bumped) {
            console.log(`⚡ Auto-bumping gas for ${tx.hash}`);
            // TODO: Actual rebroadcast requires wallet access (private key)
            // This monitoring function only tracks pending status.
            // Gas bumping should be called at the transaction call-site where wallet is available.
            // See mintWorker.js and other modules for proper implementation.
            monitoring.get(tx.hash).bumped = true;
          }
        } catch (error) {
          // Ignore errors in monitoring
        }
      }, checkInterval)
    });
  }
  
  // Return cleanup function
  return () => {
    for (const [hash, data] of monitoring) {
      clearInterval(data.interval);
    }
    monitoring.clear();
  };
}

/**
 * Calculate total gas cost for a transaction
 * @param {Object} gasConfig - Gas configuration
 * @param {BigInt} gasLimit - Gas limit
 * @returns {BigInt} Total gas cost in wei
 */
export function calculateGasCost(gasConfig, gasLimit) {
  if (gasConfig.type === 2) {
    // EIP-1559: Use maxFeePerGas for worst case
    return BigInt(gasConfig.maxFeePerGas) * BigInt(gasLimit);
  } else {
    // Legacy
    return BigInt(gasConfig.gasPrice) * BigInt(gasLimit);
  }
}

/**
 * Format gas price for display
 * @param {Object} gasConfig - Gas configuration
 * @returns {string} Formatted gas price
 */
export function formatGasPrice(gasConfig) {
  if (gasConfig.type === 2) {
    const maxFee = ethers.formatUnits(gasConfig.maxFeePerGas, 'gwei');
    const priority = ethers.formatUnits(gasConfig.maxPriorityFeePerGas, 'gwei');
    return `Max: ${maxFee} gwei, Priority: ${priority} gwei`;
  } else {
    const gasPrice = ethers.formatUnits(gasConfig.gasPrice, 'gwei');
    return `${gasPrice} gwei`;
  }
}
