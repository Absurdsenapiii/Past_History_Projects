/**
 * Utilities Module
 * Helper functions and common utilities
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { readCSV, cleanSensitiveData } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config();

/**
 * Error types for classification
 */
export const ErrorType = {
  THROTTLE: 'THROTTLE',
  UNDERPRICED: 'UNDERPRICED',
  NONCE_TOO_LOW: 'NONCE_TOO_LOW',
  REVERT: 'REVERT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Classify error for better retry logic
 * @param {Error} err - Error object
 * @returns {string} Error classification
 */
export function classifyError(err) {
  const message = err.message?.toLowerCase() || '';
  const code = err.code || '';
  
  // Throttling / rate limiting
  if (
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('throttle') ||
    code === 'THROTTLED' ||
    code === 'RATE_LIMIT'
  ) {
    return ErrorType.THROTTLE;
  }
  
  // Underpriced transaction
  if (
    message.includes('underpriced') ||
    message.includes('fee too low') ||
    message.includes('max fee per gas less than block') ||
    code === 'REPLACEMENT_UNDERPRICED' ||
    code === 'INSUFFICIENT_FUNDS_FOR_GAS'
  ) {
    return ErrorType.UNDERPRICED;
  }
  
  // Nonce issues
  if (
    message.includes('nonce too low') ||
    message.includes('nonce has already been used') ||
    message.includes('nonce already consumed') ||
    code === 'NONCE_EXPIRED'
  ) {
    return ErrorType.NONCE_TOO_LOW;
  }
  
  // Transaction reverted
  if (
    message.includes('revert') ||
    message.includes('execution reverted') ||
    message.includes('transaction failed') ||
    code === 'CALL_EXCEPTION'
  ) {
    return ErrorType.REVERT;
  }
  
  // Insufficient funds
  if (
    message.includes('insufficient funds') ||
    message.includes('insufficient balance') ||
    message.includes('transfer amount exceeds balance') ||
    code === 'INSUFFICIENT_FUNDS'
  ) {
    return ErrorType.INSUFFICIENT_FUNDS;
  }
  
  return ErrorType.UNKNOWN;
}

/**
 * Validate configuration settings
 * @param {Object} settings - Settings object
 * @param {string} command - Command being executed (gen, fund, mint, payment, consolidate, refund, etc.)
 * @throws {Error} If validation fails
 */
export function validateConfig(settings, command = null) {
  const errors = [];
  
  // Context-aware validation based on command
  
  // ==========================================
  // COMMAND: gen (wallet generation)
  // ==========================================
  if (command === 'generate' || command === 'gen') {
    if (!settings.walletCount || settings.walletCount <= 0) {
      errors.push('walletCount must be a positive number for wallet generation');
    }
    
    // Check plaintext logging safety (unless DRY_RUN)
    const isDryRun = process.env.DRY_RUN === 'true';
    if (!isDryRun && process.env.SAFE_PLAINTEXT_LOGGING !== 'true') {
      errors.push(
        'SAFE_PLAINTEXT_LOGGING=true is required for wallet generation (until encrypted keystore is implemented)\n' +
        '   Set this in .env file or run with DRY_RUN=true'
      );
    }
    
    // For gen command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: fund (wallet funding)
  // ==========================================
  if (command === 'fund') {
    if (!process.env.RPC_URL) {
      errors.push('RPC_URL environment variable is required for funding');
    }
    
    if (!process.env.FunderPrivateKey) {
      errors.push('FunderPrivateKey environment variable is required for funding');
    }
    
    if (!settings.prefundEthWei) {
      errors.push('prefundEthWei is required for funding');
    } else {
      try {
        const prefund = BigInt(settings.prefundEthWei);
        if (prefund < 0n) {
          errors.push('prefundEthWei cannot be negative');
        }
      } catch {
        errors.push(`prefundEthWei must be a valid BigInt string: ${settings.prefundEthWei}`);
      }
    }
    
    // For fund command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: mint (direct minting)
  // ==========================================
  if (command === 'mint' && settings.paymentMode === 'directMint') {
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    
    if (settings.contractAddress === zeroAddress) {
      errors.push('contractAddress cannot be zero address for minting');
    }
    
    if (!settings.mintFunction || typeof settings.mintFunction !== 'string') {
      errors.push('mintFunction must be a non-empty string for minting');
    }
    
    // Note: ABI can be empty - fallback to signature-only encoding is acceptable
    console.log('ℹ️  ABI validation: Will attempt to use targetMintAbi.json, fallback to signature if needed');
    
    // For mint command in directMint mode, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: payment (USDC authorization)
  // ==========================================
  if (command === 'pay' || command === 'payment') {
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    
    if (settings.paymentMode !== 'usdcAuthorization') {
      errors.push('paymentMode must be "usdcAuthorization" for payment command');
    }
    
    if (!settings.usdc) {
      errors.push('usdc configuration is required for payment command');
    } else {
      if (settings.usdc.tokenAddress === zeroAddress) {
        errors.push('usdc.tokenAddress cannot be zero address');
      }
      
      if (settings.usdc.recipient === zeroAddress) {
        errors.push('usdc.recipient cannot be zero address');
      }
      
      if (!settings.usdc.amount || BigInt(settings.usdc.amount) <= 0n) {
        errors.push('usdc.amount must be a positive number');
      }
    }
    
    // For payment command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: consolidate (token consolidation)
  // ==========================================
  if (command === 'consolidate') {
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    
    if (settings.tokenAddress === zeroAddress) {
      errors.push('tokenAddress cannot be zero address for consolidation');
    }
    
    // For consolidate command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: refund (ETH refunding)
  // ==========================================
  if (command === 'refund') {
    if (!process.env.RPC_URL) {
      errors.push('RPC_URL environment variable is required for refunding');
    }
    
    if (!process.env.FunderPrivateKey) {
      errors.push('FunderPrivateKey environment variable is required for refunding');
    }
    
    // minDustWei is optional, but validate if present
    if (settings.minDustWei) {
      try {
        const minDust = BigInt(settings.minDustWei);
        if (minDust < 0n) {
          errors.push('minDustWei cannot be negative');
        }
      } catch {
        errors.push(`minDustWei must be a valid BigInt string: ${settings.minDustWei}`);
      }
    }
    
    // For refund command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: status (wallet status check)
  // ==========================================
  if (command === 'status' || command === 'tracker') {
    // Status command only needs RPC access, no mint config required
    if (!process.env.RPC_URL) {
      errors.push('RPC_URL environment variable is required for status checks');
    }
    
    // For status command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // COMMAND: watch (event watching)
  // ==========================================
  if (command === 'watch' || command === 'watcher') {
    // Watch command only needs RPC access and contract address
    if (!process.env.RPC_URL) {
      errors.push('RPC_URL environment variable is required for watching');
    }
    
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    if (settings.contractAddress === zeroAddress) {
      errors.push('contractAddress cannot be zero address for watching');
    }
    
    // For watch command, skip other validation
    if (errors.length > 0) {
      throwValidationErrors(errors);
    }
    return true;
  }
  
  // ==========================================
  // GENERAL VALIDATION (when no specific command)
  // ==========================================
  
  // Validate addresses
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  
  if (settings.tokenAddress === zeroAddress) {
    errors.push('tokenAddress cannot be zero address');
  }
  
  if (settings.contractAddress === zeroAddress) {
    errors.push('contractAddress cannot be zero address');
  }
  
  if (settings.tokenAddress === settings.contractAddress) {
    errors.push('tokenAddress and contractAddress cannot be the same (common misconfiguration)');
  }
  
  // Validate addresses are valid
  try {
    if (settings.tokenAddress) ethers.getAddress(settings.tokenAddress);
  } catch {
    errors.push(`tokenAddress is not a valid Ethereum address: ${settings.tokenAddress}`);
  }
  
  try {
    if (settings.contractAddress) ethers.getAddress(settings.contractAddress);
  } catch {
    errors.push(`contractAddress is not a valid Ethereum address: ${settings.contractAddress}`);
  }
  
  // Validate mint function
  if (!settings.mintFunction || typeof settings.mintFunction !== 'string') {
    errors.push('mintFunction must be a non-empty string');
  }
  
  if (!Array.isArray(settings.mintArgs)) {
    errors.push('mintArgs must be an array');
  }
  
  // Validate mintValueWei
  if (settings.mintValueWei) {
    try {
      const value = BigInt(settings.mintValueWei);
      if (value < 0n) {
        errors.push('mintValueWei cannot be negative');
      }
    } catch {
      errors.push(`mintValueWei must be a valid number string: ${settings.mintValueWei}`);
    }
  }
  
  // Validate payment mode
  const validPaymentModes = ['directMint', 'usdcAuthorization'];
  if (settings.paymentMode && !validPaymentModes.includes(settings.paymentMode)) {
    errors.push(`paymentMode must be one of: ${validPaymentModes.join(', ')}`);
  }
  
  // If USDC authorization mode, validate USDC settings
  if (settings.paymentMode === 'usdcAuthorization') {
    if (!settings.usdc) {
      errors.push('usdc configuration is required when paymentMode is "usdcAuthorization"');
    } else {
      if (settings.usdc.tokenAddress === zeroAddress) {
        errors.push('usdc.tokenAddress cannot be zero address');
      }
      
      if (settings.usdc.recipient === zeroAddress) {
        errors.push('usdc.recipient cannot be zero address');
      }
      
      if (!settings.usdc.amount || BigInt(settings.usdc.amount) <= 0n) {
        errors.push('usdc.amount must be a positive number');
      }
      
      try {
        ethers.getAddress(settings.usdc.tokenAddress);
      } catch {
        errors.push(`usdc.tokenAddress is not valid: ${settings.usdc.tokenAddress}`);
      }
      
      try {
        ethers.getAddress(settings.usdc.recipient);
      } catch {
        errors.push(`usdc.recipient is not valid: ${settings.usdc.recipient}`);
      }
    }
  }
  
  // Validate gas settings
  if (settings.gas) {
    if (settings.gas.ceilGwei && settings.gas.ceilGwei <= 0) {
      errors.push('gas.ceilGwei must be positive');
    }
    
    // Check per-phase gas limits
    const phases = ['mint', 'fund', 'consolidate', 'refund'];
    for (const phase of phases) {
      if (settings.gas[phase]) {
        try {
          const limit = BigInt(settings.gas[phase].gasLimit);
          if (limit <= 0n) {
            errors.push(`gas.${phase}.gasLimit must be positive`);
          }
        } catch {
          errors.push(`gas.${phase}.gasLimit must be a valid number string`);
        }
      }
    }
  }
  
  // Validate wallet count
  if (settings.walletCount <= 0) {
    errors.push('walletCount must be positive');
  }
  
  // Validate prefundEthWei if present
  if (settings.prefundEthWei) {
    try {
      const prefund = BigInt(settings.prefundEthWei);
      if (prefund < 0n) {
        errors.push('prefundEthWei cannot be negative');
      }
    } catch {
      errors.push(`prefundEthWei must be a valid BigInt string: ${settings.prefundEthWei}`);
    }
  }
  
  // Validate mint events config if present
  if (settings.mintEvents) {
    if (settings.mintEvents.address && settings.mintEvents.address !== zeroAddress) {
      try {
        ethers.getAddress(settings.mintEvents.address);
      } catch {
        errors.push(`mintEvents.address is not valid: ${settings.mintEvents.address}`);
      }
    }
    
    if (!settings.mintEvents.event || typeof settings.mintEvents.event !== 'string') {
      errors.push('mintEvents.event must be a non-empty string');
    }
  }
  
  // If errors found, throw with all issues listed
  if (errors.length > 0) {
    throwValidationErrors(errors);
  }
  
  return true;
}

/**
 * Helper function to throw validation errors with formatting
 * @param {Array<string>} errors - Array of error messages
 * @throws {Error}
 */
function throwValidationErrors(errors) {
  console.error('\n❌ Configuration Validation Failed:\n');
  errors.forEach((error, index) => {
    console.error(`  ${index + 1}. ${error}`);
  });
  console.error('\nPlease fix these issues in config/settings.json or .env before continuing.\n');
  throw new Error(`Configuration validation failed with ${errors.length} error(s)`);
}

/**
 * Check network safety for plaintext logging
 * @param {ethers.Provider} provider - Ethereum provider
 * @returns {Promise<boolean>} True if safe to use plaintext logging
 */
export async function checkNetworkSafety(provider) {
  const isPlaintextEnabled = process.env.SAFE_PLAINTEXT_LOGGING === 'true';
  
  if (!isPlaintextEnabled) {
    return true; // Not using plaintext, always safe
  }
  
  try {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    
    // Safe networks: local development only
    const safeChainIds = [
      1337, // Hardhat
      31337, // Hardhat default
      1338, // Local dev
    ];
    
    const networkName = process.env.NETWORK_NAME?.toLowerCase() || '';
    const isLocalhost = networkName.includes('localhost') || 
                        networkName.includes('local') ||
                        networkName.includes('anvil');
    
    if (safeChainIds.includes(chainId) || isLocalhost) {
      return true;
    }
    
    // Production network detected with plaintext logging!
    console.error('\n🚨 CRITICAL SECURITY WARNING 🚨\n');
    console.error('You have SAFE_PLAINTEXT_LOGGING=true enabled on a PRODUCTION network!');
    console.error(`Network: ${networkName}`);
    console.error(`Chain ID: ${chainId}`);
    console.error('\nThis will save private keys in PLAINTEXT - EXTREMELY DANGEROUS!\n');
    console.error('To proceed anyway, run with --i-understand flag');
    console.error('(But you really should not do this!)\n');
    
    // Check for override flag
    const hasUnderstandFlag = process.argv.includes('--i-understand');
    
    if (!hasUnderstandFlag) {
      process.exit(1);
    }
    
    console.warn('⚠️  Proceeding with plaintext logging on production network...');
    console.warn('⚠️  You have been warned!\n');
    
    return true;
    
  } catch (error) {
    console.warn('⚠️  Unable to verify network safety:', error.message);
    return false;
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
export async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff based on error type
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 */
export async function retry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 5000;
  const backoffMultiplier = options.backoffMultiplier || 1.5;
  
  let lastError;
  let lastErrorClass = ErrorType.UNKNOWN;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      lastErrorClass = classifyError(error);
      
      console.warn(`  ⚠️  Attempt ${i + 1}/${maxRetries} failed [${lastErrorClass}]: ${error.message}`);
      
      // Don't retry certain errors
      if (lastErrorClass === ErrorType.REVERT || lastErrorClass === ErrorType.INSUFFICIENT_FUNDS) {
        console.warn(`  ⚠️  Error type ${lastErrorClass} is not retryable, failing immediately`);
        throw error;
      }
      
      if (i < maxRetries - 1) {
        // Adjust delay based on error type
        let delay = Math.floor(baseDelay * Math.pow(backoffMultiplier, i));
        
        if (lastErrorClass === ErrorType.THROTTLE) {
          // Longer delay for throttling
          delay = delay * 2;
        }
        
        console.log(`  ⏳ Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }
  
  // Attach error classification to the error
  lastError.errorClass = lastErrorClass;
  throw lastError;
}

/**
 * Load wallet with private key from storage
 * @param {string} address - Wallet address
 * @param {ethers.Provider} provider - Ethereum provider
 * @returns {ethers.Wallet|null} Wallet instance or null
 */
export async function loadWalletWithKey(address, provider) {
  // Check if plaintext logging is enabled
  if (process.env.SAFE_PLAINTEXT_LOGGING === 'true') {
    // Read from CSV (TESTING ONLY - INSECURE!)
    const wallets = await readCSV('addresses.csv');
    const walletData = wallets.find(w => 
      w.address.toLowerCase() === address.toLowerCase()
    );
    
    if (walletData && walletData.privateKey) {
      const privateKey = walletData.privateKey.startsWith('0x')
        ? walletData.privateKey
        : `0x${walletData.privateKey}`;
      
      return new ethers.Wallet(privateKey, provider);
    }
  }
  
  // TODO: In production, load from encrypted keystore
  console.error('❌ Unable to load wallet - private key not found');
  console.error('   Ensure SAFE_PLAINTEXT_LOGGING=true for testing');
  console.error('   Or implement encrypted keystore loading');
  
  return null;
}

/**
 * Send Telegram alert
 * @param {string} message - Alert message
 */
export async function sendTelegramAlert(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    // Telegram not configured, skip
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    
    if (!response.ok) {
      console.warn('⚠️  Failed to send Telegram alert');
    }
  } catch (error) {
    console.warn('⚠️  Telegram alert failed:', error.message);
  }
}

/**
 * Format wei to ETH with specified decimals
 * @param {BigInt|string} wei - Amount in wei
 * @param {number} decimals - Number of decimals
 */
export function formatEth(wei, decimals = 4) {
  const eth = ethers.formatEther(wei);
  return parseFloat(eth).toFixed(decimals);
}

/**
 * Parse ETH to wei
 * @param {string} eth - Amount in ETH
 * @returns {BigInt} Amount in wei
 */
export function parseEth(eth) {
  return ethers.parseEther(eth);
}

/**
 * Validate Ethereum address
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid
 */
export function isValidAddress(address) {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get block explorer URL for transaction
 * @param {string} txHash - Transaction hash
 * @returns {string} Explorer URL
 */
export function getExplorerUrl(txHash) {
  const network = process.env.NETWORK_NAME || 'ethereum';
  
  const explorers = {
    'ethereum': 'https://etherscan.io/tx/',
    'goerli': 'https://goerli.etherscan.io/tx/',
    'sepolia': 'https://sepolia.etherscan.io/tx/',
    'polygon': 'https://polygonscan.com/tx/',
    'arbitrum': 'https://arbiscan.io/tx/',
    'optimism': 'https://optimistic.etherscan.io/tx/',
    'base': 'https://basescan.org/tx/',
    'bsc': 'https://bscscan.com/tx/'
  };
  
  const baseUrl = explorers[network] || explorers.ethereum;
  return `${baseUrl}${txHash}`;
}

/**
 * Wipe plaintext keys from logs (security cleanup)
 */
export async function wipePrivateKeys() {
  console.log('🔒 Wiping private keys from logs...');
  console.warn('⚠️  This will remove all private keys from CSV files');
  console.warn('⚠️  Make sure you have backed up keys if needed!');
  
  // Give user time to abort
  console.log('\nPress Ctrl+C to abort, continuing in 5 seconds...');
  await sleep(5000);
  
  // Clean sensitive data
  await cleanSensitiveData(false); // false = not a dry run
  
  console.log('✅ Private keys wiped from logs');
  console.log('💡 Consider using encrypted keystores for production');
}

/**
 * Generate random hex string
 * @param {number} bytes - Number of bytes
 * @returns {string} Random hex string
 */
export function randomHex(bytes = 32) {
  return '0x' + Buffer.from(ethers.randomBytes(bytes)).toString('hex');
}

/**
 * Calculate percentage
 * @param {number} value - Value
 * @param {number} total - Total
 * @param {number} decimals - Decimal places
 */
export function percentage(value, total, decimals = 2) {
  if (total === 0) return '0';
  return ((value / total) * 100).toFixed(decimals);
}

/**
 * Format large numbers with commas
 * @param {number|string} num - Number to format
 */
export function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Estimate transaction time based on confirmations
 * @param {number} confirmations - Number of confirmations
 * @param {number} blockTime - Average block time in seconds
 */
export function estimateTime(confirmations, blockTime = 12) {
  const seconds = confirmations * blockTime;
  
  if (seconds < 60) {
    return `~${seconds}s`;
  } else if (seconds < 3600) {
    return `~${Math.ceil(seconds / 60)}m`;
  } else {
    return `~${Math.ceil(seconds / 3600)}h`;
  }
}

/**
 * Check if running in dry run mode
 */
export function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

/**
 * Check if plaintext logging is enabled
 */
export function isPlaintextEnabled() {
  return process.env.SAFE_PLAINTEXT_LOGGING === 'true';
}

// Command line utility handler
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.includes('--wipe-plaintext-keys')) {
    wipePrivateKeys()
      .then(() => {
        console.log('✅ Complete');
        process.exit(0);
      })
      .catch(error => {
        console.error('❌ Error:', error);
        process.exit(1);
      });
  } else {
    console.log('Utility functions available:');
    console.log('  --wipe-plaintext-keys  # Remove private keys from logs');
  }
}


// Production validation for critical settings
export function validateSettings(settings) {
  const required = ['contractAddress','mintFunction','rpcUrl'];
  const missing = required.filter(k => !settings[k]);
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')}`);
  return true;
}


// Warn if plaintext key usage is not explicitly acknowledged
export function requirePlaintextKeyAcknowledgement() {
  if (process.env.SAFE_PLAINTEXT_LOGGING !== 'true') {
    console.warn('⚠️  SAFE_PLAINTEXT_LOGGING not set to true. For production, store private keys in an encrypted keystore or HSM. Set SAFE_PLAINTEXT_LOGGING=true to acknowledge plaintext for dev.');
  }
}
