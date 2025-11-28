/**
 * Payment Module
    // nonce-retry: wrap authorization send with a single retry on nonce/authorization errors
    let __nonceRetry = false;
    while (true) {
      try {
 * Handles USDC EIP-3009 transferWithAuthorization for gasless payments
 */

import { getNonce, putNonce } from './tracker.js';
import { allocAuthNonce, markAuthNonceUsed } from './tracker.js';
import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import { appendToCSV, readCSV } from './logger.js';
import { updateWalletStatus, addTransaction } from './tracker.js';
import { allocAuthNonce, markAuthNonceUsed } from './tracker.js';
import { sendTelegramAlert, sleep, loadWalletWithKey, retry, classifyError } from './utils.js';
import { validateSettings } from './utils.js';
import { randomHex } from './utils.js';
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

// EIP-3009 transferWithAuthorization signature
const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
  )
);

/**
 * Get EIP-712 domain for USDC token
 * @param {ethers.Contract} usdcContract - USDC contract instance
 * @param {number} chainId - Chain ID
 * @returns {Object} EIP-712 domain
 */
async function getEIP712Domain(usdcContract, chainId) {
  let tokenName;
  try {
    tokenName = await usdcContract.name();
        break; // success
      } catch (e) {
        const msg = (e?.reason || e?.shortMessage || e?.message || String(e)).toLowerCase();
        const nonceRelated = msg.includes('nonce') || msg.includes('authorization') || msg.includes('used');
        if (!__nonceRetry && nonceRelated) {
          console.warn('⚠️  Authorization nonce issue detected — retrying with a fresh nonce');
          __nonceRetry = true;
          // Allocate a fresh auth nonce and rebuild authorization
          nonce = await allocAuthNonce(owner, token.target);
          // NOTE: Rebuild your authorization signature here if it's computed above
          // e.g., signature = await signTransferAuthorization(ownerKey, token, nonce, ...)
          continue;
        }
        throw e;
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not fetch token name, using "USD Coin"');
    tokenName = 'USD Coin';
  }
  
  return {
    name: tokenName,
    version: '2', // USDC uses version "2" for EIP-3009
    chainId: chainId,
    verifyingContract: await usdcContract.getAddress()
  };
}

/**
 * Create EIP-712 typed data for transferWithAuthorization
 * @param {Object} params - Authorization parameters
 * @returns {Object} Typed data for signing
 */
function createTypedData(domain, from, to, value, validAfter, validBefore, nonce) {
  return {
    domain,
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce
    }
  };
}

/**
 * Sign transferWithAuthorization for a wallet
 * @param {ethers.Wallet} wallet - Wallet to sign with
 * @param {Object} params - Authorization parameters
 * @returns {Object} Signature components {v, r, s}
 */
async function signAuthorization(wallet, domain, params) {
  const { to, value, validAfter, validBefore, nonce } = params;
  
  const typedData = createTypedData(
    domain,
    wallet.address,
    to,
    value,
    validAfter,
    validBefore,
    nonce
  );
  
  // Sign the typed data
  const signature = await wallet.signTypedData(
    typedData.domain,
    { TransferWithAuthorization: typedData.types.TransferWithAuthorization },
    typedData.message
  );
  
  // Split signature into v, r, s components
  const sig = ethers.Signature.from(signature);
  
  return {
    v: sig.v,
    r: sig.r,
    s: sig.s,
    signature
  };
}

/**
 * Submit authorization directly to USDC contract
 * @param {ethers.Contract} usdcContract - USDC contract instance
 * @param {Object} authData - Authorization data with signature
 * @returns {Object} Transaction receipt
 */
async function submitAuthorizationDirect(usdcContract, authData) {
  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = authData;
  
  // Call transferWithAuthorization
  const tx = await usdcContract.transferWithAuthorization(
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s
  );
  
  console.log(`    📤 TX: ${tx.hash}`);
  
  const receipt = await tx.wait(settings.confirmations || 1);
  return receipt;
}

/**
 * Submit authorization to relay endpoint
 * @param {string} relayUrl - Relay endpoint URL
 * @param {Object} authData - Authorization data with signature
 * @returns {Object} Relay response
 */
async function submitAuthorizationRelay(relayUrl, authData) {
  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: authData.from,
      to: authData.to,
      value: authData.value.toString(),
      validAfter: authData.validAfter.toString(),
      validBefore: authData.validBefore.toString(),
      nonce: authData.nonce,
      signature: authData.signature
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Relay failed: ${response.status} ${errorText}`);
  }
  
  return await response.json();
}

/**
 * Execute USDC authorization for all wallets
 * @returns {Object} Execution results
 */
export async function executeUSDCAuthorizations() {
  console.log('💳 Starting USDC authorization execution...');
  
  const isDryRun = process.env.DRY_RUN === 'true';
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  
  // Validate USDC configuration
  if (!settings.usdc || !settings.usdc.tokenAddress || !settings.usdc.recipient) {
    throw new Error('USDC configuration incomplete. Check settings.json');
  }
  
  // Load USDC contract
  const usdcAbi = [
    'function name() view returns (string)',
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
    'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'
  ];
  
  const usdcContract = new ethers.Contract(
    settings.usdc.tokenAddress,
    usdcAbi,
    provider
  );
  
  // Get EIP-712 domain
  const domain = await getEIP712Domain(usdcContract, chainId);
  
  console.log(`USDC Token: ${settings.usdc.tokenAddress}`);
  console.log(`Recipient: ${settings.usdc.recipient}`);
  console.log(`Amount: ${settings.usdc.amount} (${ethers.formatUnits(settings.usdc.amount, 6)} USDC)`);
  console.log(`Chain ID: ${chainId}`);
  
  // Load wallets
  const wallets = await readCSV('addresses.csv');
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets found. Run "npm run gen" first');
  }
  
  console.log(`Wallets: ${wallets.length}`);
  
  // Setup concurrency limiter
  const limit = pLimit(parseInt(process.env.CONCURRENCY || '10'));
  const authResults = [];
  let successCount = 0;
  let failCount = 0;
  
  // Process authorization for each wallet
  const processAuthorization = async (walletData, index) => {
    const address = walletData.address;
    
    try {
      console.log(`  [${index + 1}/${wallets.length}] Processing authorization for ${address}...`);
      
      // Load wallet
      const wallet = await loadWalletWithKey(address, provider);
      if (!wallet) {
        throw new Error('Unable to load wallet - check key storage');
      }
      
      // Generate unique nonce
      const nonce = await allocAuthNonce(owner, token.target);
      
      // Calculate time window
      const now = Math.floor(Date.now() / 1000);
      const validAfter = now + (settings.usdc.validAfterSec || 0);
      const validBefore = now + (settings.usdc.validBeforeSec || 120);
      
      // Create authorization parameters
      const authParams = {
        to: settings.usdc.recipient,
        value: BigInt(settings.usdc.amount),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce
      };
      
      console.log(`    Signing authorization...`);
      console.log(`    Valid window:

// --- AUTHORIZATION SIGN + SUBMIT (with single retry on nonce/auth errors) ---
{
  let __nonceRetry = false;
  while (true) {
    try {
      let nonce = await allocAuthNonce(wallet.address, settings.usdc.tokenAddress);
      const authParams = {
        to: settings.usdc.recipient,
        value: amountWei,
        validAfter,
        validBefore,
        nonce
      };
      const { v, r, s, signature } = await signAuthorization(wallet, domain, authParams);
      const authData = {
        from: wallet.address,
        to: authParams.to,
        value: authParams.value,
        validAfter: authParams.validAfter,
        validBefore: authParams.validBefore,
        nonce,
        v, r, s, signature
      };
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: would submit transferWithAuthorization`);
        break;
      }
      const receipt = await submitAuthorizationDirect(usdcContract, authData);
      await markAuthNonceUsed(wallet.address, settings.usdc.tokenAddress, nonce);
      console.log(`    ✅ Authorization tx confirmed in block ${receipt.blockNumber}`);
      break;
    } catch (e) {
      const msg = (e?.reason || e?.shortMessage || e?.message || String(e)).toLowerCase();
      const nonceRelated =
        msg.includes('nonce') ||
        msg.includes('authorization') ||
        msg.includes('used') ||
        msg.includes('invalid signature') ||
        msg.includes('replay') ||
        msg.includes('authorizationstate');
      if (!__nonceRetry && nonceRelated) {
        console.warn('⚠️  Authorization/nonce issue detected — retrying once with a fresh nonce & signature');
        __nonceRetry = true;
        continue;
      }
      throw e;
    }
  }
}
// --- END AUTHORIZATION SIGN + SUBMIT ---

 ${validAfter} - ${validBefore} (${validBefore - validAfter}s)`);
      
      // Sign authorization
      const { v, r, s, signature } = await signAuthorization(wallet, domain, authParams);
      
      const authData = {
        from: wallet.address,
        to: authParams.to,
        value: authParams.value,
        validAfter: authParams.validAfter,
        validBefore: authParams.validBefore,
        nonce,
        v,
        r,
        s,
        signature
      };
      
      if (isDryRun) {
        console.log(`    🔍 DRY RUN: Would submit authorization`);
        console.log(`       Signature: ${signature.substring(0, 20)}...`);
        successCount++;
        
        authResults.push({
          address,
          status: 'dry-run',
          nonce,
          signature: signature.substring(0, 20) + '...',
          timestamp: new Date().toISOString()
        });
        
        return { address, status: 'dry-run' };
      }
      
      // Submit authorization
      let receipt;
      let txHash = null;
      
      if (settings.usdc.relayUrl) {
        // Submit to relay
        console.log(`    📡 Submitting to relay: ${settings.usdc.relayUrl}`);
        const relayResponse = await submitAuthorizationRelay(settings.usdc.relayUrl, authData);
        console.log(`    ✅ Relay accepted authorization`);
        txHash = relayResponse.txHash || 'relay-pending';
        
      } else {
        // Submit directly to contract (requires funder to send the tx)
        console.log(`    ⚠️  No relay configured - authorization signed but not submitted`);
        console.log(`    💡 Use a relay or implement direct submission logic`);
      }
      
      successCount++;
      
      // Record authorization
      const authRecord = {
        address,
        type: 'usdc-authorization',
        nonce,
        signature,
        v: v.toString(),
        r,
        s,
        amount: settings.usdc.amount,
        recipient: settings.usdc.recipient,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        txHash,
        status: 'success',
        timestamp: new Date().toISOString()
      };
      
      authResults.push(authRecord);
      
      // Update tracker
      await updateWalletStatus(address, 'usdc-authorized');
      await addTransaction({
        address,
        type: 'usdc-authorization',
        txHash,
        status: 'success',
        amount: settings.usdc.amount
      });
      
      return { address, status: 'success', nonce, signature };
      
    } catch (error) {
      console.error(`    ❌ Error processing ${address}:`, error.message);
      failCount++;
      
      const errorClass = classifyError(error);
      
      authResults.push({
        address,
        type: 'usdc-authorization',
        status: 'failed',
        error: error.message,
        errorClass,
        timestamp: new Date().toISOString()
      });
      
      return { address, status: 'error', error: error.message, errorClass };
    }
  };
  
  console.log('\nExecuting authorizations...\n');
  
  // Execute with concurrency control
  const authPromises = wallets.map((wallet, index) =>
    limit(() => processAuthorization(wallet, index))
  );
  
  const results = await Promise.all(authPromises);
  
  // Save results to CSV
  if (!isDryRun && authResults.length > 0) {
    await appendToCSV('usdc-authorizations.csv', authResults, [
      'address', 'type', 'nonce', 'signature', 'v', 'r', 's',
      'amount', 'recipient', 'validAfter', 'validBefore',
      'txHash', 'status', 'error', 'errorClass', 'timestamp'
    ]);
  }
  
  // Summary
  console.log('\n📊 USDC Authorization Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  🎯 Success Rate: ${((successCount / wallets.length) * 100).toFixed(2)}%`);
  
  // Send Telegram alert
  await sendTelegramAlert(
    `💳 USDC Authorizations Complete\n` +
    `Success: ${successCount}/${wallets.length}\n` +
    `Failed: ${failCount}\n` +
    `Amount per wallet: ${ethers.formatUnits(settings.usdc.amount, 6)} USDC`
  );
  
  return {
    success: successCount,
    failed: failCount,
    total: wallets.length,
    results
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  executeUSDCAuthorizations()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
