// claim.js - Presale claim functionality with WebSocket confirmation tracking

import { appState, log, showToast, showTxModal, updateTxModal, subscribeToSignature, addToTxHistory, updateTxHistoryStatus } from "./shared.js";

const web3 = window.solanaWeb3;

// Setup Buffer polyfill if needed
if (typeof window.Buffer === 'undefined' && typeof buffer !== 'undefined') {
  window.Buffer = buffer.Buffer;
}

// Fallback: Create a simple Buffer implementation if still not available
if (typeof window.Buffer === 'undefined') {
  window.Buffer = {
    from: (data) => {
      if (typeof data === 'number') {
        return new Uint8Array([data]);
      } else if (Array.isArray(data)) {
        return new Uint8Array(data);
      } else if (typeof data === 'string') {
        const encoder = new TextEncoder();
        return encoder.encode(data);
      }
      return new Uint8Array(data);
    },
    alloc: (size) => {
      return new Uint8Array(size);
    }
  };
}

// Program IDs
const TOKEN_PROGRAM_ID = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM_ID = new web3.PublicKey('11111111111111111111111111111111');
const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Get element by ID helper
function $(id) { return document.getElementById(id); }

// Display claim output
function say(msg, err = false) {
  const el = $('claimOut');
  if (el) {
    el.textContent = String(msg);
    el.className = err ? 'err muted' : 'muted';
  }
  log(msg, err ? "CLAIM-ERROR" : "CLAIM");
}

// Derive Associated Token Account
async function getATA(owner, mint) {
  const [ata] = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

// Compute Budget instructions without Buffer dependency
function createComputeUnitPriceIx(microLamports) {
  const COMPUTE_BUDGET_PROGRAM_ID = new web3.PublicKey('ComputeBudget111111111111111111111111111111');

  // Instruction discriminator for SetComputeUnitPrice (3)
  // followed by microLamports as u64 (8 bytes, little-endian)
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice discriminator

  // Write microLamports as little-endian u64
  const view = new DataView(data.buffer, 1, 8);
  view.setBigUint64(0, BigInt(microLamports), true);

  return new web3.TransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data: data
  });
}

function createComputeUnitLimitIx(units) {
  const COMPUTE_BUDGET_PROGRAM_ID = new web3.PublicKey('ComputeBudget111111111111111111111111111111');

  // Instruction discriminator for SetComputeUnitLimit (2)
  // followed by units as u32 (4 bytes, little-endian)
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminator

  // Write units as little-endian u32
  const view = new DataView(data.buffer, 1, 4);
  view.setUint32(0, units, true);

  return new web3.TransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data: data
  });
}

// Build Associated Token Account CreateIdempotent instruction (u8=1)
function createATAIx(payer, owner, mint, ata) {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
  ];
  // Use Uint8Array directly for better compatibility
  const data = new Uint8Array([1]); // CreateIdempotent
  return new web3.TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys, data });
}

// Claim instruction with Anchor discriminator
function claimIx({
  programId, launch, fundingRecord, launchSigner, mint, vault, funder, funderAta, eventAuthority
}) {
  const keys = [
    { pubkey: launch, isSigner: false, isWritable: true },
    { pubkey: fundingRecord, isSigner: false, isWritable: true },
    { pubkey: launchSigner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: funder, isSigner: true, isWritable: true },
    { pubkey: funderAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false }  // Program itself as 11th account
  ];

  // Anchor discriminator for "claim" instruction
  // This is the first 8 bytes of sha256("global:claim")
  const discriminator = new Uint8Array([62, 198, 214, 193, 213, 159, 108, 210]);

  return new web3.TransactionInstruction({ programId, keys, data: discriminator });
}

// Send claim transaction
async function sendClaim() {
  let signature = null;
  
  try {
    if (!appState.publicKey || !appState.provider) {
      throw new Error('Connect wallet first.');
    }

    if (!appState.conn) {
      throw new Error('RPC connection not established.');
    }

    // Read inputs
    const programId = new web3.PublicKey($('programId').value.trim());
    const launch = new web3.PublicKey($('launch').value.trim());
    const fundingRecord = new web3.PublicKey($('fundingRecord').value.trim());
    const launchSigner = new web3.PublicKey($('launchSigner').value.trim());
    const mint = new web3.PublicKey($('mint').value.trim());
    const vault = new web3.PublicKey($('vault').value.trim());
    const eventAuthority = new web3.PublicKey($('eventAuthority').value.trim());

    const ataInput = $('ata').value.trim();
    const funderAta = ataInput ? new web3.PublicKey(ataInput) : await getATA(appState.publicKey, mint);

    say('Building transaction...');
    showToast('Building Transaction', 'Creating claim transaction...', 'info', 3000);
    
    const tx = new web3.Transaction();

    // Check if RPC is QuickNode (requires tip accounts)
    const isQuickNode = (appState.conn?._rpcEndpoint || '').includes('quiknode');
    
    if (!isQuickNode) {
      // Set compute unit limit (only for non-QuickNode RPCs)
      const units = window.SETTINGS?.defaultComputeUnits || 200000;
      const computeLimitIx = createComputeUnitLimitIx(units);
      tx.add(computeLimitIx);

      // Optional priority fee (only for non-QuickNode RPCs)
      const feeInput = $('priorityFee');
      const feeStr = feeInput?.value ?? 'auto';
      const microLamports = (feeStr === 'auto' || feeStr === '') ? 0 : Number(feeStr);
      
      if (microLamports > 0) {
        const computePriceIx = createComputeUnitPriceIx(microLamports);
        tx.add(computePriceIx);
        log(`Added priority fee: ${microLamports} microLamports`, "CLAIM");
      }
    } else {
      log(`⚠️ Skipping compute budget instructions on QuickNode (requires tip accounts)`, "CLAIM");
    }

    if ($('createAta').checked) {
      tx.add(createATAIx(appState.publicKey, appState.publicKey, mint, funderAta));
    }

    tx.add(claimIx({
      programId, launch, fundingRecord, launchSigner, mint, vault,
      funder: appState.publicKey, funderAta, eventAuthority
    }));

    tx.feePayer = appState.publicKey;

    // Get recent blockhash with multiple fallback options
    say('Getting recent blockhash...');
    let blockhashInfo;

    const rpcEndpoints = [
      appState.conn._rpcEndpoint,  // Current selected endpoint
      'https://rpc.ankr.com/solana',
      'https://api.mainnet-beta.solana.com'
    ];

    let workingEndpoint = null;
    for (const endpoint of rpcEndpoints) {
      try {
        const tempConn = new web3.Connection(endpoint, 'confirmed');
        blockhashInfo = await tempConn.getLatestBlockhash('finalized');
        workingEndpoint = endpoint;
        appState.conn = tempConn;  // Update to working connection
        log('Successfully connected to: ' + endpoint, "CLAIM");
        break;
      } catch (err) {
        log('Failed to connect to: ' + endpoint + ' - ' + err.message, "CLAIM");
        continue;
      }
    }

    if (!blockhashInfo) {
      throw new Error('Could not connect to any RPC endpoint. Please try a custom RPC URL or wait a moment and try again.');
    }

    tx.recentBlockhash = blockhashInfo.blockhash;

    say('Requesting signature from wallet...');
    showToast('Sign Transaction', 'Please approve in your wallet', 'info', 5000);

    // Use smart transaction sender for cross-wallet compatibility
    const skipPreflight = window.SETTINGS?.skipPreflight ?? true;
    const { sendTxSmart } = await import('./shared.js');
    
    signature = await sendTxSmart(appState.provider, tx, appState.conn, {
      skipPreflight,
      preflightCommitment: 'confirmed'
    });
    
    // Safety guard: ensure signature is a string
    if (typeof signature !== 'string') signature = String(signature?.signature || signature?.txid || '');
    
    log(`[CLAIM] 🚀 Transaction sent: ${signature}`, "CLAIM");

    // Add to transaction history immediately
    addToTxHistory(signature, 'claim', 'pending');

    // Show transaction modal
    showTxModal(signature, 'claim', 'pending');
    
    // Show toast with Solscan link
    showToast(
      'Transaction Sent! 🚀',
      `Signature: ${signature.slice(0, 8)}...`,
      'info',
      0 // Don't auto-close
    );

    say(`🚀 Transaction sent!\nSignature: ${signature}\n⏳ Waiting for confirmation...`);

    // Optional: also broadcast to Jito relay
    /*
    try {
      await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [[Buffer.from(rawTx).toString("base64")]]
        }),
      });
      log("[CLAIM] 📦 Sent bundle to Jito relay");
    } catch (jitoErr) {
      log("[CLAIM] ⚠️ Jito relay error (non-critical): " + jitoErr.message);
    }
    */

    // Start WebSocket confirmation tracking
    log('[CLAIM] 📡 Starting real-time confirmation tracking...', 'CLAIM');
    
    try {
      const result = await subscribeToSignature(signature, 'claim', (update) => {
        if (update.confirmed) {
          say(`✅ Claim successful!\nSignature: ${signature}\nSlot: ${update.slot || 'unknown'}`);
          log(`✅ Claim confirmed at slot ${update.slot}`, "CLAIM");
        } else {
          say(`❌ Claim failed\nSignature: ${signature}\nError: ${JSON.stringify(update.error)}`, true);
          log(`❌ Claim failed: ${JSON.stringify(update.error)}`, "CLAIM");
        }
      });

      if (result.timeout) {
        say(`⏱️ Confirmation timeout - transaction may still be processing\nCheck Solscan: https://solscan.io/tx/${signature}`);
        showToast(
          'Confirmation Timeout',
          'Transaction may still be processing. Check Solscan.',
          'warning',
          8000
        );
      }
    } catch (wsError) {
      log(`⚠️ WebSocket error (non-critical): ${wsError.message}`, "CLAIM");
      say(`Transaction sent but confirmation tracking failed.\nCheck Solscan: https://solscan.io/tx/${signature}`);
      
      // Fallback: try standard confirmation
      try {
        log('[CLAIM] Falling back to standard confirmation...', 'CLAIM');
        const conf = await appState.conn.confirmTransaction(signature, 'confirmed');
        const confirmed = !conf.value.err;
        
        if (confirmed) {
          say(`✅ Claim successful!\nSignature: ${signature}`);
          updateTxModal('confirmed');
          updateTxHistoryStatus(signature, 'confirmed');
          showToast('Claim Successful! 🎉', 'Tokens have been claimed', 'success', 5000);
        } else {
          throw new Error('Transaction failed');
        }
      } catch (confError) {
        log(`⚠️ Standard confirmation also failed: ${confError.message}`, "CLAIM");
        showToast(
          'Check Transaction Status',
          'Unable to confirm automatically. Please check Solscan.',
          'warning',
          8000
        );
      }
    }

  } catch (e) {
    console.error('Transaction error:', e);

    // Extract RPC logs if available
    let logs = e?.logs || e?.data?.logs;
    if (logs) {
      console.error('[RPC LOGS]', logs);
    }

    // Full error details for debugging
    const fullError = JSON.stringify(e, Object.getOwnPropertyNames(e));
    console.error('[FULL ERROR]', fullError);

    // Parse common error codes
    let errorMsg = e.message || String(e);

    if (errorMsg.includes('0x64')) {
      errorMsg += '\n\nPossible causes:\n' +
        '• Tokens already claimed for this funding record\n' +
        '• Invalid vault address (check if it matches on-chain data)\n' +
        '• Funding record does not exist for your wallet\n' +
        '• Presale not yet claimable or already ended';
    } else if (errorMsg.includes('0x1')) {
      errorMsg += '\n\n• Insufficient balance for transaction fees';
    } else if (errorMsg.includes('InstructionMissing')) {
      errorMsg += '\n\n• Invalid instruction data format';
    } else if (errorMsg.includes('User rejected')) {
      errorMsg = 'Transaction rejected by user';
    } else if (errorMsg.includes('tip account')) {
      errorMsg += '\n\n• This RPC requires tip accounts for priority fees\n• Set priority fee to 0 or switch RPC';
    }

    // Show logs in toast if available
    const displayMsg = logs 
      ? `RPC Logs:\n${Array.isArray(logs) ? logs.join('\n') : logs}`.slice(0, 300)
      : errorMsg;

    say('[ERROR] ' + errorMsg, true);
    showToast('Claim Failed', displayMsg, 'error', 8000);
    
    if (signature) {
      updateTxModal('failed');
      updateTxHistoryStatus(signature, 'failed');
    }
  }
}

// Initialize claim module
document.addEventListener("DOMContentLoaded", () => {
  const sendBtn = $('sendBtn');
  if (sendBtn) {
    sendBtn.addEventListener('click', sendClaim);
  }

  log("Claim module initialized", "CLAIM");
});
