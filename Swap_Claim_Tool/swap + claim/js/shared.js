// shared.js - Shared wallet connection, RPC logic, and transaction tracking

const web3 = window.solanaWeb3;

// WEBSOCKET CONFIRMATION TRACKING
// Dynamic WS URL derived from HTTP RPC endpoint

// Helper to compute WebSocket URL from HTTP RPC endpoint
function makeWsUrlFromHttp(httpUrl) {
  if (!httpUrl) return 'wss://api.mainnet-beta.solana.com/';
  const u = new URL(httpUrl);
  
  // Common providers with specific WS patterns
  if (u.hostname.includes('alchemy.com')) return `wss://${u.hostname}${u.pathname}/ws`;
  if (u.hostname.includes('ankr.com'))    return `wss://${u.hostname}${u.pathname}/ws`;
  
  // Helius / QuickNode / others: just swap scheme
  u.protocol = 'wss:';
  return u.toString().replace(/\/?$/, '/');
}

// Global application state shared across swap and claim modules
export const appState = {
  conn: null,
  provider: null,
  publicKey: null,
  wallet: null, // BACKPACK + PHANTOM SUPPORT
  wsConnection: null,
  activeSubscriptions: new Map(),
};

// Get element by ID helper
function $(id) { return document.getElementById(id); }

// Global logging function with source tagging
export function log(msg, source = "SYSTEM") {
  const el = $("log");
  if (el) {
    el.textContent = `[${new Date().toLocaleTimeString()}] [${source}] ${msg}\n` + el.textContent;
  }
  console.log(`[${source}] ${msg}`);
}

// TOAST NOTIFICATION SYSTEM
export function showToast(title, message, type = 'info', duration = 5000) {
  const container = $('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">×</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => removeToast(toast));

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }

  return toast;
}

function removeToast(toast) {
  toast.classList.add('closing');
  setTimeout(() => toast.remove(), 300);
}

// TRANSACTION STATUS MODAL
export function showTxModal(signature, type = 'swap', initialStatus = 'pending') {
  const modal = $('txModal');
  const content = $('txModalContent');
  
  const statusInfo = {
    pending: {
      icon: '⏳',
      text: 'Transaction Pending',
      subtext: 'Waiting for network confirmation...',
      badge: 'pending'
    },
    confirmed: {
      icon: '✅',
      text: 'Transaction Confirmed!',
      subtext: 'Your transaction has been successfully confirmed',
      badge: 'confirmed'
    },
    failed: {
      icon: '❌',
      text: 'Transaction Failed',
      subtext: 'The transaction could not be confirmed',
      badge: 'failed'
    }
  };

  const status = statusInfo[initialStatus] || statusInfo.pending;
  const solscanUrl = `https://solscan.io/tx/${signature}`;
  const shortSig = signature.slice(0, 8) + '...' + signature.slice(-8);

  content.innerHTML = `
    <div class="tx-status">
      <div class="status-icon">${status.icon}</div>
      <div class="status-text">${status.text}</div>
      <div class="status-subtext">${status.subtext}</div>
      <span class="status-badge ${status.badge}">${initialStatus.toUpperCase()}</span>
      ${initialStatus === 'pending' ? '<div class="progress-bar"><div class="progress-fill" style="width:30%"></div></div>' : ''}
    </div>
    <div class="tx-details">
      <div class="tx-detail-row">
        <span class="tx-detail-label">Type</span>
        <span class="tx-detail-value">${type.toUpperCase()}</span>
      </div>
      <div class="tx-detail-row">
        <span class="tx-detail-label">Signature</span>
        <span class="tx-detail-value" style="font-size:11px">${shortSig}</span>
      </div>
      <div class="tx-detail-row">
        <span class="tx-detail-label">Time</span>
        <span class="tx-detail-value">${new Date().toLocaleTimeString()}</span>
      </div>
    </div>
    <div style="text-align:center">
      <a href="${solscanUrl}" target="_blank" class="tx-link">View on Solscan →</a>
    </div>
  `;

  modal.classList.add('active');
  return content;
}

export function updateTxModal(status, additionalInfo = {}) {
  const content = $('txModalContent');
  if (!content) return;

  const statusInfo = {
    pending: { icon: '⏳', text: 'Transaction Pending', badge: 'pending' },
    confirmed: { icon: '✅', text: 'Transaction Confirmed!', badge: 'confirmed' },
    failed: { icon: '❌', text: 'Transaction Failed', badge: 'failed' }
  };

  const info = statusInfo[status] || statusInfo.pending;
  
  // Update status icon and text
  const statusIcon = content.querySelector('.status-icon');
  const statusText = content.querySelector('.status-text');
  const statusBadge = content.querySelector('.status-badge');
  const progressBar = content.querySelector('.progress-bar');

  if (statusIcon) statusIcon.textContent = info.icon;
  if (statusText) statusText.textContent = info.text;
  if (statusBadge) {
    statusBadge.textContent = status.toUpperCase();
    statusBadge.className = `status-badge ${info.badge}`;
  }
  if (progressBar && status !== 'pending') {
    progressBar.remove();
  }

  // Add additional info if provided
  if (additionalInfo.slot) {
    const txDetails = content.querySelector('.tx-details');
    const slotRow = document.createElement('div');
    slotRow.className = 'tx-detail-row';
    slotRow.innerHTML = `
      <span class="tx-detail-label">Slot</span>
      <span class="tx-detail-value">${additionalInfo.slot}</span>
    `;
    txDetails.appendChild(slotRow);
  }
}

// TRANSACTION HISTORY MANAGEMENT
export function addToTxHistory(signature, type, status = 'pending', details = {}) {
  const history = getTxHistory();
  const tx = {
    signature,
    type,
    status,
    timestamp: Date.now(),
    ...details
  };
  
  history.unshift(tx);
  
  // Keep only last 50 transactions
  if (history.length > 50) {
    history.splice(50);
  }
  
  localStorage.setItem('txHistory', JSON.stringify(history));
  renderTxHistory();
}

export function updateTxHistoryStatus(signature, status, details = {}) {
  const history = getTxHistory();
  const tx = history.find(t => t.signature === signature);
  
  if (tx) {
    tx.status = status;
    Object.assign(tx, details);
    localStorage.setItem('txHistory', JSON.stringify(history));
    renderTxHistory();
  }
}

export function getTxHistory() {
  try {
    return JSON.parse(localStorage.getItem('txHistory') || '[]');
  } catch {
    return [];
  }
}

// Cleanup corrupted transaction history entries (call this if you have errors)
export function cleanupTxHistory() {
  try {
    const history = getTxHistory();
    const cleaned = history.filter(tx => {
      // Keep only valid transactions with string signatures
      return tx && typeof tx.signature === 'string' && tx.signature.length > 0;
    });
    localStorage.setItem('txHistory', JSON.stringify(cleaned));
    log(`Cleaned up transaction history: ${history.length - cleaned.length} invalid entries removed`, "SYSTEM");
    renderTxHistory();
    return cleaned.length;
  } catch (e) {
    log(`Error cleaning up transaction history: ${e.message}`, "SYSTEM");
    return 0;
  }
}

export function renderTxHistory() {
  const list = $('txHistoryList');
  if (!list) return;

  const history = getTxHistory();
  
  if (history.length === 0) {
    list.innerHTML = '<div class="tx-history-empty">No transactions yet</div>';
    return;
  }

  list.innerHTML = history.map(tx => {
    // Safety: ensure signature is a string (handles old data from localStorage)
    const sig = typeof tx.signature === 'string' ? tx.signature : String(tx.signature?.signature || tx.signature?.txid || tx.signature || '');
    if (!sig) return ''; // Skip invalid entries
    
    const shortSig = sig.slice(0, 8) + '...' + sig.slice(-8);
    const time = new Date(tx.timestamp).toLocaleTimeString();
    const statusEmoji = {
      pending: '⏳',
      confirmed: '✅',
      failed: '❌'
    }[tx.status] || '⏳';
    
    return `
      <div class="tx-history-item" onclick="window.open('https://solscan.io/tx/${sig}', '_blank')">
        <div class="tx-history-info">
          <div class="tx-history-type">${tx.type}</div>
          <div class="tx-history-sig">${shortSig}</div>
        </div>
        <div class="tx-history-status">
          <div style="font-size:20px">${statusEmoji}</div>
          <div class="tx-history-time">${time}</div>
        </div>
      </div>
    `;
  }).filter(Boolean).join('');
}

// WEBSOCKET CONFIRMATION TRACKING
export async function subscribeToSignature(signature, type = 'swap', onUpdate = null) {
  return new Promise((resolve, reject) => {
    try {
      const httpUrl = appState.conn?._rpcEndpoint || 'https://api.mainnet-beta.solana.com';
      const wsUrl = makeWsUrlFromHttp(httpUrl);
      
      log(`[WS] Connecting to ${wsUrl}`, "WEBSOCKET");
      
      const ws = new WebSocket(wsUrl);
      let subscriptionId = null;
      let confirmed = false;
      let timeoutId = null;

      // Timeout after 60 seconds
      timeoutId = setTimeout(() => {
        if (!confirmed) {
          log(`[WS] Confirmation timeout for ${signature}`, "WEBSOCKET");
          ws.close();
          resolve({ confirmed: false, timeout: true });
        }
      }, 60000);

      ws.onopen = () => {
        log('[WS] Connected, subscribing to signature...', "WEBSOCKET");
        
        const subscribeRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'signatureSubscribe',
          params: [
            signature,
            {
              commitment: 'confirmed',
              enableReceivedNotification: false
            }
          ]
        };
        
        ws.send(JSON.stringify(subscribeRequest));
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data);
          
          // Handle subscription ID
          if (response.id === 1 && response.result) {
            subscriptionId = response.result;
            log(`[WS] Subscribed with ID: ${subscriptionId}`, "WEBSOCKET");
            return;
          }

          // Handle signature notification
          if (response.method === 'signatureNotification') {
            const value = response.params?.result?.value;
            
            if (value) {
              confirmed = true;
              clearTimeout(timeoutId);
              
              const update = {
                confirmed: !value.err,
                slot: response.params?.result?.context?.slot,
                error: value.err
              };

              log(`[WS] Transaction ${update.confirmed ? 'confirmed' : 'failed'} at slot ${update.slot}`, "WEBSOCKET");

              // Call update callback if provided
              if (onUpdate) {
                onUpdate(update);
              }

              // Update modal and history
              if (update.confirmed) {
                updateTxModal('confirmed', { slot: update.slot });
                updateTxHistoryStatus(signature, 'confirmed', { slot: update.slot });
              } else {
                updateTxModal('failed');
                updateTxHistoryStatus(signature, 'failed', { error: update.error });
              }

              ws.close();
              resolve(update);
            }
          }
        } catch (err) {
          log(`[WS] Message parse error: ${err.message}`, "WEBSOCKET");
        }
      };

      ws.onerror = (error) => {
        log(`[WS] Error: ${error.message || 'Connection failed'}`, "WEBSOCKET");
        clearTimeout(timeoutId);
        ws.close();
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = () => {
        log('[WS] Connection closed', "WEBSOCKET");
        if (!confirmed && timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      // Store WebSocket for cleanup
      appState.activeSubscriptions.set(signature, ws);

    } catch (err) {
      reject(err);
    }
  });
}

// Close modal
document.addEventListener('DOMContentLoaded', () => {
  const modal = $('txModal');
  const closeBtn = $('closeTxModal');
  
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }
  
  // Close on background click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  }
});

// SIGNATURE NORMALIZATION UTILITY
// Extracts string signature from various wallet response formats
function normalizeSig(value) {
  if (typeof value === 'string') return value;
  if (value?.signature) return String(value.signature);
  if (value?.txid) return String(value.txid);
  if (value?.result) return String(value.result);
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return '';
}

// SMART TRANSACTION SENDER
// Handles different wallet APIs (Backpack signAndSendTransaction, Phantom sendTransaction, legacy signTransaction)
export async function sendTxSmart(wallet, tx, connection, options = {}) {
  const { skipPreflight = true, preflightCommitment = 'confirmed' } = options;

  // Method 1: signAndSendTransaction (Backpack + some Phantom versions)
  // This is the preferred modern method that combines signing and sending
  if ('signAndSendTransaction' in wallet && typeof wallet.signAndSendTransaction === 'function') {
    log('[sendTxSmart] Using signAndSendTransaction (Backpack/Phantom modern)', "TX");
    
    const res = await wallet.signAndSendTransaction(tx, {
      skipPreflight,
      preflightCommitment
    });
    
    const sig = normalizeSig(res);
    if (!sig) throw new Error('Missing signature from signAndSendTransaction response');
    
    log(`[sendTxSmart] ✅ Sent via signAndSendTransaction: ${sig}`, "TX");
    return sig;
  }

  // Method 2: sendTransaction (Phantom v2 style, also Solflare compatible)
  // This method signs and sends in one call, returns signature directly
  if ('sendTransaction' in wallet && typeof wallet.sendTransaction === 'function') {
    log('[sendTxSmart] Using sendTransaction (Phantom v2 style)', "TX");
    
    const res = await wallet.sendTransaction(tx, connection, {
      skipPreflight,
      preflightCommitment
    });
    
    const sig = normalizeSig(res);
    if (!sig) throw new Error('Missing signature from sendTransaction response');
    
    log(`[sendTxSmart] ✅ Sent via sendTransaction: ${sig}`, "TX");
    return sig;
  }

  // Method 3: signTransaction + sendRawTransaction (traditional fallback)
  // This is the legacy method that works with all wallets but may trigger warnings
  if ('signTransaction' in wallet) {
    log('[sendTxSmart] Using signTransaction + sendRawTransaction (fallback)', "TX");
    
    const signedTx = await wallet.signTransaction(tx);
    const rawTx = signedTx.serialize();
    
    const res = await connection.sendRawTransaction(rawTx, { 
      skipPreflight,
      maxRetries: 3
    });
    
    const sig = normalizeSig(res);
    if (!sig) throw new Error('Missing signature from sendRawTransaction response');
    
    log(`[sendTxSmart] ✅ Sent via signTransaction fallback: ${sig}`, "TX");
    return sig;
  }

  throw new Error('Wallet does not support any known transaction sending methods');
}

// BACKPACK + PHANTOM SUPPORT
// Detect available wallets
export async function detectWallet() {
  const providers = [];

  // Check for Backpack
  if (window.backpack?.solana || window.solana?.isBackpack) {
    providers.push({ 
      name: "Backpack", 
      provider: window.backpack?.solana || window.solana 
    });
  }

  // Check for Phantom
  if (window.phantom?.solana || (window.solana?.isPhantom && !window.solana?.isBackpack)) {
    providers.push({ 
      name: "Phantom", 
      provider: window.phantom?.solana || window.solana 
    });
  }

  if (providers.length === 0) {
    const errorMsg = "No wallet detected. Please install Phantom or Backpack wallet extension.";
    console.error('[WALLET] ❌ ' + errorMsg);
    console.error('[WALLET] Download Phantom: https://phantom.app');
    console.error('[WALLET] Download Backpack: https://backpack.app');
    throw new Error(errorMsg);
  }

  log(`Found ${providers.length} wallet(s): ${providers.map(p => p.name).join(', ')}`, "WALLET");

  // If both wallets are present, ask user to choose
  if (providers.length > 1) {
    const choice = prompt("Choose wallet: Backpack or Phantom");
    const pick = providers.find(p => p.name.toLowerCase() === choice?.toLowerCase());
    if (pick) return pick;
    // If invalid choice, default to first provider
    log("Invalid choice, defaulting to " + providers[0].name, "WALLET");
  }

  return providers[0];
}

// BACKPACK + PHANTOM SUPPORT
// Connect to wallet (generic function for both Phantom and Backpack)
export async function connectWallet() {
  try {
    const walletInfo = await detectWallet();
    const provider = walletInfo.provider;
    
    log(`Connecting to ${walletInfo.name}...`, "WALLET");
    
    const { publicKey } = await provider.connect();
    appState.provider = provider;
    appState.publicKey = publicKey;
    appState.wallet = walletInfo.name; // BACKPACK + PHANTOM SUPPORT
    
    // Update UI
    $("pubkey").textContent = publicKey.toBase58();
    
    // Initialize connection if not already done
    if (!appState.conn) {
      await ensureConnection();
    }
    
    log(`✅ ${walletInfo.name} connected: ${publicKey.toBase58().slice(0, 8)}...`, "WALLET");
    showToast(
      `${walletInfo.name} Connected`,
      `Address: ${publicKey.toBase58().slice(0, 8)}...`,
      'success',
      3000
    );
    
    return publicKey;
  } catch (e) {
    log("❌ Connect error: " + e.message, "WALLET");
    
    // Special handling for "no wallet" errors
    if (e.message.includes('No wallet detected') || e.message.includes('No supported wallet')) {
      showToast(
        'No Wallet Found',
        'Please install Phantom or Backpack wallet extension and refresh the page.',
        'error',
        0  // Don't auto-close
      );
    } else {
      showToast('Connection Failed', e.message, 'error', 8000);
    }
    
    throw e;
  }
}

// BACKPACK + PHANTOM SUPPORT
// Disconnect from wallet
export async function disconnectWallet() {
  try {
    if (appState.provider) {
      await appState.provider.disconnect();
      const walletName = appState.wallet || "wallet";
      appState.provider = null;
      appState.publicKey = null;
      appState.wallet = null; // BACKPACK + PHANTOM SUPPORT
      
      // Update UI
      $("pubkey").textContent = "Not connected";
      
      log(`Disconnected from ${walletName}`, "WALLET");
      showToast('Disconnected', `Disconnected from ${walletName}`, 'info', 2000);
    }
  } catch (e) {
    log("Disconnect error: " + e.message, "WALLET");
  }
}

// Legacy function for backward compatibility
export async function connectPhantom() {
  return connectWallet();
}

// Legacy function for backward compatibility
export async function disconnectPhantom() {
  return disconnectWallet();
}

// Ensure RPC connection is established
export async function ensureConnection(customUrl = null) {
  const rpcSelect = $("rpcEndpoint");
  const customRpcInput = $("customRpc");
  
  let url;
  if (customUrl) {
    url = customUrl;
  } else if (rpcSelect.value === "custom" && customRpcInput.value.trim()) {
    url = customRpcInput.value.trim();
  } else if (rpcSelect.value === "custom") {
    log("⚠️ Custom RPC selected but no URL provided", "RPC");
    return appState.conn;
  } else {
    url = rpcSelect.value;
  }
  
  if (!appState.conn || appState.conn._rpcEndpoint !== url) {
    appState.conn = new web3.Connection(url, { commitment: "confirmed" });
    log("RPC endpoint set: " + url, "RPC");
  }
  
  return appState.conn;
}

// Initialize shared functionality
document.addEventListener("DOMContentLoaded", () => {
  // CRITICAL: Self-check to verify script loaded correctly
  const connectBtn = $("connectBtn");
  if (!connectBtn) {
    console.error('[BOOT] ❌ shared.js not initialized — check script tag path in index.html');
    console.error('[BOOT] ❌ Expected: <script type="module" src="./shared.js"></script>');
    showToast(
      'Initialization Error',
      'Module failed to load. Check browser console for details.',
      'error',
      0
    );
    return;
  }
  
  log("✅ shared.js initialized successfully", "SYSTEM");
  
  // BACKPACK + PHANTOM SUPPORT
  // Connect button handler
  if (connectBtn) {
    connectBtn.addEventListener("click", connectWallet);
  }
  
  // BACKPACK + PHANTOM SUPPORT
  // Disconnect button handler
  const disconnectBtn = $("disconnectBtn");
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", disconnectWallet);
  }
  
  // RPC selector change handler
  const rpcSelect = $("rpcEndpoint");
  const customRpcInput = $("customRpc");
  
  if (rpcSelect) {
    rpcSelect.addEventListener("change", async () => {
      if (rpcSelect.value === "custom") {
        customRpcInput.style.display = "block";
      } else {
        customRpcInput.style.display = "none";
        await ensureConnection();
      }
    });
  }
  
  if (customRpcInput) {
    customRpcInput.addEventListener("change", async () => {
      if (customRpcInput.value.trim()) {
        await ensureConnection();
      }
    });
  }
  
  // Initialize default connection
  ensureConnection();
  
  // Cleanup any corrupted transaction history from previous versions
  cleanupTxHistory();
  
  // Render transaction history
  renderTxHistory();
  
  log("Dashboard initialized - ready to connect", "SYSTEM");
});

// Safe-guard against EVM wallet interference
try {
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    writable: true,
    value: window.ethereum || {}
  });
} catch (e) {
  console.warn("Safe-guarded ethereum injection:", e.message);
}
