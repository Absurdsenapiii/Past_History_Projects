// swap.js - Jupiter swap functionality with WebSocket confirmation tracking

import { appState, log, showToast, showTxModal, updateTxModal, subscribeToSignature, addToTxHistory, updateTxHistoryStatus } from "./shared.js";

const web3 = window.solanaWeb3;

// Local swap state
const swapState = {
  lastQuote: null,
  prebuiltTx: null,
  prebuiltAt: null
};

// Get element by ID helper
function $(id) { return document.getElementById(id); }

// Base64 to bytes converter
const b64ToBytes = b64 => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// Priority fee heuristic for hyped launches
function guessPriorityFeeLamports() {
  // conservative recommended range: 50_000 - 200_000 lamports (~0.00005 - 0.0002 SOL)
  return Math.floor(50000 + Math.random() * 150000);
}

// Get wallet balance for input token
async function getBalance() {
  if (!appState.publicKey) return 0;
  if (!appState.conn) return 0;
  
  const inMint = $("inputMint").value.trim();

  let balanceLamports = 0;
  try {
    if (inMint === "So11111111111111111111111111111111111111112") {
      balanceLamports = await appState.conn.getBalance(appState.publicKey);
    } else {
      const tokenAccounts = await appState.conn.getParsedTokenAccountsByOwner(
        appState.publicKey,
        { mint: new web3.PublicKey(inMint) }
      );
      const acc = tokenAccounts.value[0];
      balanceLamports = acc
        ? acc.account.data.parsed.info.tokenAmount.amount
        : 0;
    }
  } catch (e) {
    log("Balance fetch error: " + e.message, "SWAP");
  }

  // Assume 9 decimals for SOL, 6 for most SPL like USDC
  const decimals = inMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
  const humanBal = balanceLamports / 10 ** decimals;
  $("balBox").textContent = `Balance: ${humanBal.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  return humanBal;
}

// Swap input and output mints
function swapMints() {
  const inp = $("inputMint");
  const out = $("outputMint");
  const tmp = inp.value;
  inp.value = out.value;
  out.value = tmp;
  log("Swapped input ↔ output mints", "SWAP");
  if (appState.publicKey) getBalance();
}

// Get quote from Jupiter API via proxy
async function getQuote() {
  try {
    if (!appState.publicKey) {
      showToast('Wallet Not Connected', 'Please connect your wallet first', 'warning');
      return;
    }

    const inMint = $("inputMint").value.trim();
    const outMint = $("outputMint").value.trim();
    const amount = $("amount").value.trim();
    const slippageBps = parseInt($("slippage").value || "50", 10);

    if (!inMint || !outMint || !amount) {
      showToast('Missing Information', 'Please fill in all fields', 'warning');
      return;
    }

    log("Requesting quote via proxy...", "SWAP");
    showToast('Getting Quote', 'Fetching best route from Jupiter...', 'info', 3000);

    // Convert to lamports
    const decimals = inMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const amountIn = Math.floor(Number(amount) * 10 ** decimals);

    const params = new URLSearchParams({
      inputMint: inMint,
      outputMint: outMint,
      amount: amountIn,
      slippageBps: slippageBps
    });

    const res = await fetch(`${window.BACKEND_BASE_URL}/quote?${params}`);
    const data = await res.json();

    if (data.error) {
      log("Quote error: " + data.error, "SWAP");
      showToast('Quote Failed', data.error, 'error');
      return;
    }

    swapState.lastQuote = data;
    $("swapBtn").disabled = false;

    // Display quote info
    const outDecimals = data.outputMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const outAmount = Number(data.outAmount) / 10 ** outDecimals;
    
    // Safely parse price impact - it might be missing, null, or a string
    let priceImpact = 0;
    if (data.priceImpactPct !== undefined && data.priceImpactPct !== null) {
      priceImpact = Number(data.priceImpactPct);
    }
    
    // Check if we got a valid number
    const priceImpactDisplay = isNaN(priceImpact) ? 'N/A' : priceImpact.toFixed(2) + '%';
    const priceImpactColor = (!isNaN(priceImpact) && priceImpact > 1) ? 'var(--danger)' : 'var(--ink)';

    $("quoteBox").innerHTML = `
      <div style="background:#0f1117;border:1px solid var(--stroke);border-radius:12px;padding:12px">
        <div style="color:var(--success);font-weight:700;margin-bottom:8px">✅ Quote received</div>
        <div style="font-size:12px;color:var(--muted)">
          Output: <strong style="color:var(--ink)">${outAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong><br/>
          Price impact: <strong style="color:${priceImpactColor}">${priceImpactDisplay}</strong><br/>
          Route: ${data.routePlan ? data.routePlan.length + ' step(s)' : 'direct'}
        </div>
      </div>
    `;

    log("✅ Quote OK (via proxy): " + outAmount.toFixed(6), "SWAP");
    showToast('Quote Received', `Output: ${outAmount.toFixed(6)}`, 'success', 3000);
  } catch (e) {
    console.error(e);
    log("Quote error: " + e.message, "SWAP");
    showToast('Quote Error', e.message, 'error');
  }
}

// Build and send swap transaction
async function buildAndSend() {
  let signature = null;
  
  try {
    if (!appState.publicKey || !appState.provider) {
      showToast('Wallet Not Connected', 'Please connect your wallet first', 'warning');
      return;
    }

    if (!swapState.lastQuote) {
      showToast('No Quote', 'Please get a quote first', 'warning');
      return;
    }

    log("Building swap transaction...", "SWAP");
    showToast('Building Swap', 'Creating swap transaction...', 'info', 3000);

    // Check if using QuickNode RPC (requires tip accounts)
    const isQuickNode = (appState.conn?._rpcEndpoint || '').includes('quiknode');
    
    const payload = {
      quoteResponse: swapState.lastQuote,
      userPublicKey: appState.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    };
    
    // Only add compute budget fields for non-QuickNode RPCs
    if (!isQuickNode) {
      const prioVal = $("prioFee").value ? Number($("prioFee").value) : undefined;
      if (Number.isFinite(prioVal) && prioVal > 0) {
        payload.dynamicComputeUnitLimit = true;
        payload.prioritizationFeeLamports = prioVal;
      }
    } else {
      log(`⚠️ QuickNode detected - omitting priority fee (uses tip accounts)`, "SWAP");
    }

    const res = await fetch(`${window.BACKEND_BASE_URL}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.swapTransaction) throw new Error(data.error || "Swap build failed");

    log("✅ Transaction built, requesting signature...", "SWAP");
    showToast('Sign Transaction', 'Please approve in your wallet', 'info', 5000);

    // Deserialize transaction
    const txBytes = b64ToBytes(data.swapTransaction);
    const tx = web3.VersionedTransaction.deserialize(txBytes);

    // Use smart transaction sender for cross-wallet compatibility
    const { sendTxSmart } = await import('./shared.js');
    signature = await sendTxSmart(appState.provider, tx, appState.conn, {
      skipPreflight: true,
      preflightCommitment: 'confirmed'
    });
    
    // Safety guard: ensure signature is a string
    if (typeof signature !== 'string') signature = String(signature?.signature || signature?.txid || '');
    
    log(`[SWAP] 🚀 Transaction sent: ${signature}`, "SWAP");

    // Calculate expected output for display
    const outDecimals = swapState.lastQuote.outputMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const expectedOutput = Number(swapState.lastQuote.outAmount) / 10 ** outDecimals;

    // Add to transaction history immediately
    addToTxHistory(signature, 'swap', 'pending', { expectedOutput });

    // Show transaction modal
    showTxModal(signature, 'swap', 'pending');
    
    // Show toast with Solscan link
    showToast(
      'Swap Sent! 🚀',
      `Expected output: ${expectedOutput.toFixed(6)}`,
      'info',
      0 // Don't auto-close
    );

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
      log("[SWAP] 📦 Sent bundle to Jito relay");
    } catch (jitoErr) {
      log("[SWAP] ⚠️ Jito relay error (non-critical): " + jitoErr.message);
    }
    */

    log("📡 Swap submitted: " + signature, "SWAP");

    // Start WebSocket confirmation tracking
    log('[SWAP] 📡 Starting real-time confirmation tracking...', 'SWAP');
    
    try {
      const result = await subscribeToSignature(signature, 'swap', (update) => {
        if (update.confirmed) {
          log(`✅ Swap confirmed at slot ${update.slot}`, "SWAP");
        } else {
          log(`❌ Swap failed: ${JSON.stringify(update.error)}`, "SWAP");
        }
      });

      if (result.timeout) {
        showToast(
          'Confirmation Timeout',
          'Transaction may still be processing. Check Solscan.',
          'warning',
          8000
        );
      }
    } catch (wsError) {
      log(`⚠️ WebSocket error (non-critical): ${wsError.message}`, "SWAP");
      
      // Fallback: try standard confirmation
      try {
        log('[SWAP] Falling back to standard confirmation...', 'SWAP');
        const conf = await appState.conn.confirmTransaction({ signature, commitment: "confirmed" });
        const confirmed = !conf.value.err;
        
        if (confirmed) {
          log("Confirmation: success", "SWAP");
          updateTxModal('confirmed');
          updateTxHistoryStatus(signature, 'confirmed');
          showToast('Swap Successful! 🎉', `Output: ${expectedOutput.toFixed(6)}`, 'success', 5000);
        } else {
          throw new Error('Transaction failed');
        }
      } catch (confError) {
        log(`⚠️ Standard confirmation also failed: ${confError.message}`, "SWAP");
        showToast(
          'Check Transaction Status',
          'Unable to confirm automatically. Please check Solscan.',
          'warning',
          8000
        );
      }
    }

    // Refresh balance
    setTimeout(() => getBalance(), 2000);

  } catch (e) {
    console.error(e);
    const errorMsg = e.message || 'Unknown error';
    log("Swap error: " + errorMsg, "SWAP");
    showToast('Swap Failed', errorMsg, 'error', 8000);
    
    if (signature) {
      updateTxModal('failed');
      updateTxHistoryStatus(signature, 'failed');
    }
  }
}

// Prebuild swap for instant execution
async function prebuildSwap() {
  try {
    if (!appState.publicKey) {
      showToast('Wallet Not Connected', 'Please connect your wallet first', 'warning');
      return;
    }

    if (!swapState.lastQuote) {
      showToast('No Quote', 'Please get a quote first', 'warning');
      return;
    }

    log("Prebuilding swap transaction...", "SWAP");
    showToast('Prebuilding Swap', 'Creating transaction for instant execution...', 'info', 3000);

    // Check if using QuickNode RPC (requires tip accounts)
    const isQuickNode = (appState.conn?._rpcEndpoint || '').includes('quiknode');
    
    const payload = {
      quoteResponse: swapState.lastQuote,
      userPublicKey: appState.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    };
    
    // Only add compute budget fields for non-QuickNode RPCs
    if (!isQuickNode) {
      const prioVal = $("prioFee").value ? Number($("prioFee").value) : guessPriorityFeeLamports();
      if (Number.isFinite(prioVal) && prioVal > 0) {
        payload.dynamicComputeUnitLimit = true;
        payload.prioritizationFeeLamports = prioVal;
      }
    } else {
      log(`⚠️ QuickNode detected - omitting priority fee (uses tip accounts)`, "SWAP");
    }

    const res = await fetch(`${window.BACKEND_BASE_URL}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.swapTransaction) throw new Error(data.error || "Prebuild failed");

    // Store prebuilt transaction
    const txBytes = b64ToBytes(data.swapTransaction);
    swapState.prebuiltTx = web3.VersionedTransaction.deserialize(txBytes);
    swapState.prebuiltAt = Date.now();

    // Update UI
    $("fireBtn").disabled = false;
    $("fireBtn").textContent = "Fire Prebuilt (ready)";
    $("fireBtn").className = "success";

    const prioVal = $("prioFee").value ? Number($("prioFee").value) : guessPriorityFeeLamports();
    log(`✅ Prebuilt swap ready in memory (priority: ${prioVal} lamports)`, "SWAP");
    log("⚠️ Prebuilt expires in 8 seconds - fire quickly!", "SWAP");
    showToast('Prebuilt Ready! ⚡', 'Fire within 8 seconds', 'success', 3000);
  } catch (e) {
    console.error(e);
    showToast('Prebuild Failed', e.message, 'error');
    log("Prebuild error: " + e.message, "SWAP");
  }
}

// Fire prebuilt transaction
async function firePrebuilt() {
  let signature = null;
  
  try {
    if (!swapState.prebuiltTx) {
      showToast('No Prebuilt Transaction', 'Please prebuild first', 'warning');
      return;
    }

    // Check TTL (8 seconds)
    const elapsed = Date.now() - swapState.prebuiltAt;
    if (elapsed > 8000) {
      swapState.prebuiltTx = null;
      swapState.prebuiltAt = null;
      $("fireBtn").disabled = true;
      $("fireBtn").textContent = "Fire Prebuilt";
      $("fireBtn").className = "secondary";
      log("❌ Prebuilt tx expired (>8s old)", "SWAP");
      showToast('Transaction Expired', 'Please prebuild again', 'error');
      return;
    }

    log(`🚀 Firing prebuilt tx (age: ${elapsed}ms)...`, "SWAP");

    // Use smart transaction sender for cross-wallet compatibility
    const { sendTxSmart } = await import('./shared.js');
    signature = await sendTxSmart(appState.provider, swapState.prebuiltTx, appState.conn, {
      skipPreflight: true,
      preflightCommitment: 'confirmed'
    });
    
    // Safety guard: ensure signature is a string
    if (typeof signature !== 'string') signature = String(signature?.signature || signature?.txid || '');
    
    log(`🔥 Prebuilt transaction fired: ${signature}`, "SWAP");

    // Calculate expected output for display
    const outDecimals = swapState.lastQuote.outputMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const expectedOutput = Number(swapState.lastQuote.outAmount) / 10 ** outDecimals;

    // Add to transaction history
    addToTxHistory(signature, 'swap-prebuilt', 'pending', { expectedOutput });

    // Show transaction modal
    showTxModal(signature, 'swap', 'pending');
    
    showToast(
      'Prebuilt Fired! 🔥',
      `Expected output: ${expectedOutput.toFixed(6)}`,
      'info',
      0
    );

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
      log("[SWAP] 📦 Sent bundle to Jito relay");
    } catch (jitoErr) {
      log("[SWAP] ⚠️ Jito relay error (non-critical): " + jitoErr.message);
    }
    */

    // Start WebSocket confirmation tracking
    try {
      await subscribeToSignature(signature, 'swap', (update) => {
        if (update.confirmed) {
          log(`✅ Prebuilt swap confirmed at slot ${update.slot}`, "SWAP");
        }
      });
    } catch (wsError) {
      log(`⚠️ WebSocket error: ${wsError.message}`, "SWAP");
      // Fallback confirmation
      try {
        const conf = await appState.conn.confirmTransaction({ signature, commitment: "confirmed" });
        if (!conf.value.err) {
          updateTxModal('confirmed');
          updateTxHistoryStatus(signature, 'confirmed');
          showToast('Swap Successful! 🎉', `Output: ${expectedOutput.toFixed(6)}`, 'success', 5000);
        }
      } catch (confError) {
        log(`⚠️ Confirmation error: ${confError.message}`, "SWAP");
      }
    }

    // Clear prebuilt state
    swapState.prebuiltTx = null;
    swapState.prebuiltAt = null;
    $("fireBtn").disabled = true;
    $("fireBtn").textContent = "Fire Prebuilt";
    $("fireBtn").className = "secondary";

    await getBalance();
  } catch (e) {
    console.error(e);
    showToast('Fire Failed', e.message, 'error');
    log("Fire error: " + e.message, "SWAP");
    
    if (signature) {
      updateTxModal('failed');
      updateTxHistoryStatus(signature, 'failed');
    }
  }
}

// Instant buy - quote + swap in one click
async function instantBuy() {
  let signature = null;
  
  try {
    if (!appState.publicKey) {
      showToast('Wallet Not Connected', 'Please connect your wallet first', 'warning');
      return;
    }

    const inMint = $("inputMint").value.trim();
    const outMint = $("outputMint").value.trim();
    const amount = $("amount").value.trim();
    const slippageBps = parseInt($("slippage").value || "50", 10);

    if (!inMint || !outMint || !amount) {
      showToast('Missing Information', 'Please fill in all fields', 'warning');
      return;
    }

    log("💥 Instant buy triggered - quote + swap in one shot...", "SWAP");
    showToast('Instant Buy! 💥', 'Getting quote and building transaction...', 'info', 5000);

    // Convert to lamports
    const decimals = inMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const amountIn = Math.floor(Number(amount) * 10 ** decimals);

    // Check if using QuickNode RPC (requires tip accounts)
    const isQuickNode = (appState.conn?._rpcEndpoint || '').includes('quiknode');
    
    const payload = {
      inputMint: inMint,
      outputMint: outMint,
      amount: amountIn,
      slippageBps: slippageBps,
      userPublicKey: appState.publicKey.toBase58(),
    };
    
    // Only add priority fee for non-QuickNode RPCs
    if (!isQuickNode) {
      const prioVal = $("prioFee").value ? Number($("prioFee").value) : guessPriorityFeeLamports();
      if (Number.isFinite(prioVal) && prioVal > 0) {
        payload.prioritizationFeeLamports = prioVal;
        log(`Requesting instant swap (priority: ${prioVal} lamports)...`, "SWAP");
      } else {
        log(`Requesting instant swap (no priority fee)...`, "SWAP");
      }
    } else {
      log(`⚠️ QuickNode detected - omitting priority fee (uses tip accounts)`, "SWAP");
    }
    console.log('[DEBUG] Instant buy payload:', payload);
    console.log(`[DEBUG] Fetching to: ${window.BACKEND_BASE_URL}/instantSwap`);

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    let res;
    try {
      res = await fetch(`${window.BACKEND_BASE_URL}/instantSwap`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload),
        mode: 'cors',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error('Request timeout - server took too long to respond');
      }
      throw new Error(`Network error: ${fetchError.message}`);
    }

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[DEBUG] Server error response:', errorText);
      throw new Error(`Server error: ${res.status} - ${errorText}`);
    }

    console.log('[DEBUG] Response status:', res.status);
    console.log('[DEBUG] Response headers:', Object.fromEntries(res.headers.entries()));
    
    const data = await res.json();
    console.log('[DEBUG] Response data received:', !!data.swapTransaction);
    
    if (!data.swapTransaction) throw new Error(data.error || "Instant swap failed");

    log("✅ Instant transaction built - signing...", "SWAP");
    showToast('Sign Transaction', 'Please approve in your wallet', 'info', 5000);

    // Deserialize transaction
    const txBytes = b64ToBytes(data.swapTransaction);
    const tx = web3.VersionedTransaction.deserialize(txBytes);

    // Use smart transaction sender for cross-wallet compatibility
    const { sendTxSmart } = await import('./shared.js');
    signature = await sendTxSmart(appState.provider, tx, appState.conn, {
      skipPreflight: true,
      preflightCommitment: 'confirmed'
    });
    
    // Safety guard: ensure signature is a string
    if (typeof signature !== 'string') signature = String(signature?.signature || signature?.txid || '');
    
    log(`💥 Instant buy sent: ${signature}`, "SWAP");

    // Add to transaction history
    addToTxHistory(signature, 'instant-buy', 'pending');

    // Show transaction modal
    showTxModal(signature, 'swap', 'pending');
    
    showToast(
      'Instant Buy Sent! 💥',
      `Signature: ${signature.slice(0, 8)}...`,
      'info',
      0
    );

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
      log("[SWAP] 📦 Sent bundle to Jito relay");
    } catch (jitoErr) {
      log("[SWAP] ⚠️ Jito relay error (non-critical): " + jitoErr.message);
    }
    */

    // Start WebSocket confirmation tracking
    try {
      await subscribeToSignature(signature, 'instant-buy', (update) => {
        if (update.confirmed) {
          log(`✅ Instant buy confirmed at slot ${update.slot}`, "SWAP");
        }
      });
    } catch (wsError) {
      log(`⚠️ WebSocket error: ${wsError.message}`, "SWAP");
      // Fallback confirmation
      try {
        const conf = await appState.conn.confirmTransaction({ signature, commitment: "confirmed" });
        if (!conf.value.err) {
          updateTxModal('confirmed');
          updateTxHistoryStatus(signature, 'confirmed');
          showToast('Instant Buy Successful! 🎉', 'Transaction confirmed', 'success', 5000);
        }
      } catch (confError) {
        log(`⚠️ Confirmation error: ${confError.message}`, "SWAP");
      }
    }

    await getBalance();
  } catch (e) {
    console.error('Instant buy error details:', e);
    console.error('Error name:', e.name);
    console.error('Error message:', e.message);
    console.error('Error stack:', e.stack);
    
    let errorMessage = e.message || 'Unknown error';
    
    // Provide more helpful error messages
    if (errorMessage.includes('Failed to fetch')) {
      errorMessage = `Cannot connect to backend server. Make sure:\n` +
        `1. Backend is running (node server/jupproxy.js)\n` +
        `2. Backend is at ${window.BACKEND_BASE_URL}\n` +
        `3. No firewall is blocking the connection`;
    } else if (errorMessage.includes('timeout')) {
      errorMessage = 'Request timed out. Jupiter API may be slow. Try again.';
    } else if (errorMessage.includes('Network error')) {
      errorMessage = 'Network error. Check your internet connection and backend server.';
    }
    
    showToast('Instant Buy Failed', errorMessage, 'error', 10000);
    log("Instant buy error: " + errorMessage, "SWAP");
    
    if (signature) {
      updateTxModal('failed');
      updateTxHistoryStatus(signature, 'failed');
    }
  }
}

// Initialize swap module
document.addEventListener("DOMContentLoaded", () => {
  // Button event listeners
  $("quoteBtn")?.addEventListener("click", getQuote);
  $("swapBtn")?.addEventListener("click", buildAndSend);
  $("swapMints")?.addEventListener("click", swapMints);
  $("prebuildBtn")?.addEventListener("click", prebuildSwap);
  $("fireBtn")?.addEventListener("click", firePrebuilt);
  $("instantBtn")?.addEventListener("click", instantBuy);

  // Auto-enable swap button when parameters change
  $("amount")?.addEventListener("input", () => {
    if (appState.publicKey) {
      $("swapBtn").disabled = false;
      log("Amount changed - will fetch fresh quote on swap", "SWAP");
    }
  });

  $("slippage")?.addEventListener("input", () => {
    if (appState.publicKey) {
      $("swapBtn").disabled = false;
      log("Slippage changed - will fetch fresh quote on swap", "SWAP");
    }
  });

  // Percentage buttons
  ["btn25", "btn50", "btn100"].forEach(id => {
    $(id)?.addEventListener("click", async () => {
      const bal = await getBalance();
      const pct = id === "btn25" ? 0.25 : id === "btn50" ? 0.5 : 1;
      const amt = bal * pct;
      $("amount").value = amt.toFixed(6);
      log(`Set amount to ${pct * 100}% of balance (${amt})`, "SWAP");
      if (appState.publicKey) $("swapBtn").disabled = false;
    });
  });

  // Refresh balance when input mint changes
  $("inputMint")?.addEventListener("change", async () => {
    if (appState.publicKey) await getBalance();
  });

  log("Swap module initialized", "SWAP");
});
