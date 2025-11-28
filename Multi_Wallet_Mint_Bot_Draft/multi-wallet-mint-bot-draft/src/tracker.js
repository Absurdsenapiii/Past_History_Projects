import { randomBytes } from 'crypto';
/**
 * Tracker Module
 * SQLite database for tracking wallet states and transactions
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path
const DB_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DB_DIR, 'tracker.db');

let db = null;

/**
 * Initialize database and create tables
 */
function initializeDatabase() {
  if (db) {
    return db;
  }
  
  // Ensure data directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  
  // Open database
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // Enable WAL mode for better performance
  
  // Create wallets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      status TEXT DEFAULT 'generated',
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )
  `);
  
  // Create transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS txs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      type TEXT NOT NULL,
      txHash TEXT,
      status TEXT DEFAULT 'pending',
      block INTEGER,
      gasUsed TEXT,
      effectiveGasPrice TEXT,
      errorClass TEXT,
      error TEXT,
      amount TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (address) REFERENCES wallets(address)
    )
  `);
  
  // Create indices for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wallets_status ON wallets(status);
    CREATE INDEX IF NOT EXISTS idx_txs_address ON txs(address);
    CREATE INDEX IF NOT EXISTS idx_txs_type ON txs(type);
    CREATE INDEX IF NOT EXISTS idx_txs_status ON txs(status);
    CREATE INDEX IF NOT EXISTS idx_txs_txHash ON txs(txHash);
  `);
  
  return db;
}

/**
 * Get database instance
 */
export function getDatabase() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

/**
 * Add or update wallet
 * @param {string} address - Wallet address
 * @param {string} status - Wallet status
 * @param {string} notes - Optional notes
 */
export function upsertWallet(address, status = 'generated', notes = null) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    INSERT INTO wallets (address, status, notes, createdAt, updatedAt)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(address) DO UPDATE SET
      status = excluded.status,
      notes = COALESCE(excluded.notes, notes),
      updatedAt = CURRENT_TIMESTAMP
  `);
  
  stmt.run(address.toLowerCase(), status, notes);
}

/**
 * Update wallet status
 * @param {string} address - Wallet address
 * @param {string} status - New status
 */
export function updateWalletStatus(address, status) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    UPDATE wallets 
    SET status = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE address = ?
  `);
  
  stmt.run(status, address.toLowerCase());
}

/**
 * Get wallet by address
 * @param {string} address - Wallet address
 * @returns {Object|null} Wallet data or null
 */
export function getWallet(address) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM wallets WHERE address = ?
  `);
  
  return stmt.get(address.toLowerCase());
}

/**
 * Get wallets by status
 * @param {string} status - Status to filter by
 * @returns {Array} Array of wallets
 */
export function getWalletsByStatus(status) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM wallets WHERE status = ? ORDER BY createdAt ASC
  `);
  
  return stmt.all(status);
}

/**
 * Get all wallets
 * @returns {Array} Array of all wallets
 */
export function getAllWallets() {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM wallets ORDER BY createdAt ASC
  `);
  
  return stmt.all();
}

/**
 * Get wallet statistics
 * @returns {Object} Statistics
 */
export function getWalletStats() {
  const database = getDatabase();
  
  const stats = database.prepare(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'generated' THEN 1 END) as generated,
      COUNT(CASE WHEN status = 'funded' THEN 1 END) as funded,
      COUNT(CASE WHEN status = 'usdc-authorized' THEN 1 END) as authorized,
      COUNT(CASE WHEN status = 'minted' THEN 1 END) as minted,
      COUNT(CASE WHEN status = 'consolidated' THEN 1 END) as consolidated,
      COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded
    FROM wallets
  `).get();
  
  return stats;
}

/**
 * Add transaction record
 * @param {Object} txData - Transaction data
 */
export function addTransaction(txData) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    INSERT INTO txs (
      address, type, txHash, status, block, gasUsed, 
      effectiveGasPrice, errorClass, error, amount, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  
  stmt.run(
    txData.address?.toLowerCase(),
    txData.type || 'unknown',
    txData.txHash || null,
    txData.status || 'pending',
    txData.block || null,
    txData.gasUsed || null,
    txData.effectiveGasPrice || null,
    txData.errorClass || null,
    txData.error || null,
    txData.amount || null
  );
}

/**
 * Get transactions for a wallet
 * @param {string} address - Wallet address
 * @returns {Array} Array of transactions
 */
export function getTransactionsByAddress(address) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM txs 
    WHERE address = ? 
    ORDER BY createdAt DESC
  `);
  
  return stmt.all(address.toLowerCase());
}

/**
 * Get transactions by type
 * @param {string} type - Transaction type
 * @returns {Array} Array of transactions
 */
export function getTransactionsByType(type) {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM txs 
    WHERE type = ? 
    ORDER BY createdAt DESC
  `);
  
  return stmt.all(type);
}

/**
 * Get transaction statistics
 * @returns {Object} Statistics
 */
export function getTransactionStats() {
  const database = getDatabase();
  
  const stats = database.prepare(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'success' THEN 1 END) as success,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
      COUNT(DISTINCT address) as uniqueWallets
    FROM txs
  `).get();
  
  const byType = database.prepare(`
    SELECT type, COUNT(*) as count
    FROM txs
    GROUP BY type
  `).all();
  
  stats.byType = {};
  byType.forEach(row => {
    stats.byType[row.type] = row.count;
  });
  
  return stats;
}

/**
 * Show comprehensive status report
 */
export async function showStatus() {
  console.log('\n📊 Tracker Status Report\n');
  
  const database = getDatabase();
  
  // Wallet statistics
  const walletStats = getWalletStats();
  console.log('💼 Wallet Statistics:');
  console.log(`   Total: ${walletStats.total}`);
  console.log(`   Generated: ${walletStats.generated}`);
  console.log(`   Funded: ${walletStats.funded}`);
  console.log(`   USDC Authorized: ${walletStats.authorized}`);
  console.log(`   Minted: ${walletStats.minted}`);
  console.log(`   Consolidated: ${walletStats.consolidated}`);
  console.log(`   Refunded: ${walletStats.refunded}`);
  
  // Transaction statistics
  const txStats = getTransactionStats();
  console.log('\n📝 Transaction Statistics:');
  console.log(`   Total: ${txStats.total}`);
  console.log(`   Success: ${txStats.success}`);
  console.log(`   Failed: ${txStats.failed}`);
  console.log(`   Pending: ${txStats.pending}`);
  console.log(`   Unique Wallets: ${txStats.uniqueWallets}`);
  
  if (Object.keys(txStats.byType).length > 0) {
    console.log('\n   By Type:');
    Object.entries(txStats.byType).forEach(([type, count]) => {
      console.log(`     ${type}: ${count}`);
    });
  }
  
  // Progress calculation
  if (walletStats.total > 0) {
    console.log('\n📈 Progress:');
    
    if (walletStats.funded > 0) {
      const fundedPct = ((walletStats.funded / walletStats.total) * 100).toFixed(2);
      console.log(`   Funded: ${fundedPct}%`);
    }
    
    if (walletStats.minted > 0) {
      const mintedPct = ((walletStats.minted / walletStats.total) * 100).toFixed(2);
      console.log(`   Minted: ${mintedPct}%`);
    }
    
    if (walletStats.consolidated > 0) {
      const consolidatedPct = ((walletStats.consolidated / walletStats.total) * 100).toFixed(2);
      console.log(`   Consolidated: ${consolidatedPct}%`);
    }
    
    if (walletStats.refunded > 0) {
      const refundedPct = ((walletStats.refunded / walletStats.total) * 100).toFixed(2);
      console.log(`   Refunded: ${refundedPct}%`);
    }
  }
  
  // Recent transactions
  const recentTxs = database.prepare(`
    SELECT * FROM txs 
    ORDER BY createdAt DESC 
    LIMIT 5
  `).all();
  
  if (recentTxs.length > 0) {
    console.log('\n🕐 Recent Transactions:');
    recentTxs.forEach(tx => {
      const status = tx.status === 'success' ? '✅' : 
                     tx.status === 'failed' ? '❌' : '⏳';
      console.log(`   ${status} ${tx.type} - ${tx.address.substring(0, 10)}... ${tx.txHash ? `(${tx.txHash.substring(0, 10)}...)` : ''}`);
    });
  }
  
  console.log('\n');
}

/**
 * Delete all data (for testing)
 */
export function clearAllData() {
  const database = getDatabase();
  
  database.exec('DELETE FROM txs');
  database.exec('DELETE FROM wallets');
  
  console.log('✅ All tracker data cleared');
}

/**
 * Close database connection
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.includes('--status')) {
    showStatus()
      .then(() => {
        closeDatabase();
        process.exit(0);
      })
      .catch(error => {
        console.error('Error:', error);
        closeDatabase();
        process.exit(1);
      });
  } else if (args.includes('--clear')) {
    console.warn('⚠️  This will delete ALL tracker data!');
    console.warn('Press Ctrl+C to abort...');
    
    setTimeout(() => {
      clearAllData();
      closeDatabase();
      process.exit(0);
    }, 3000);
  } else {
    console.log('Tracker Module');
    console.log('Usage:');
    console.log('  node src/tracker.js --status   # Show status report');
    console.log('  node src/tracker.js --clear    # Clear all data');
  }
}


import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
const DB_DIR = '.db';
const NONCE_DB = join(DB_DIR, 'nonces.json');

function loadNonceDb() {
  try {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR);
    if (!existsSync(NONCE_DB)) writeFileSync(NONCE_DB, '{}');
    return JSON.parse(readFileSync(NONCE_DB, 'utf8'));
  } catch { return {}; }
}
function saveNonceDb(db) { try { atomicWriteJSON(NONCE_DB, db); } catch {} }

export async function getNonce(owner, token) {
  const db = loadNonceDb();
  return db?.[owner]?.[token] ?? null;
}
export async function putNonce(owner, token, next) {
  const db = loadNonceDb();
  db[owner] = db[owner] || {};
  db[owner][token] = next;
  saveNonceDb(db);
  return true;
}


function atomicWriteJSON(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // rename is atomic on same filesystem
  try { 
    renameSync(tmp, path); 
  } catch (e) {
    // Fallback: write directly if rename fails
    writeFileSync(path, JSON.stringify(obj, null, 2));
  }
}


export async function hasAuthNonce(owner, token, nonce) {
  const db = loadNonceDb();
  return !!(db?.authNonces?.[owner]?.[token]?.used?.includes(nonce) || db?.authNonces?.[owner]?.[token]?.issued?.includes(nonce));
}
export async function allocAuthNonce(owner, token) {
  const db = loadNonceDb();
  db.authNonces = db.authNonces || {};
  db.authNonces[owner] = db.authNonces[owner] || {};
  db.authNonces[owner][token] = db.authNonces[owner][token] || { issued: [], used: [] };
  // generate unique 32-byte hex nonce
  let nonce;
  do {
    nonce = '0x' + Buffer.from(randomBytes(32)).toString('hex');
  } while (db.authNonces[owner][token].issued.includes(nonce) || db.authNonces[owner][token].used.includes(nonce));
  db.authNonces[owner][token].issued.push(nonce);
  saveNonceDb(db);
  return nonce;
}
export async function markAuthNonceUsed(owner, token, nonce) {
  const db = loadNonceDb();
  db.authNonces = db.authNonces || {};
  db.authNonces[owner] = db.authNonces[owner] || {};
  db.authNonces[owner][token] = db.authNonces[owner][token] || { issued: [], used: [] };
  if (!db.authNonces[owner][token].used.includes(nonce)) {
    db.authNonces[owner][token].used.push(nonce);
  }
  // Optionally remove from issued
  const idx = db.authNonces[owner][token].issued.indexOf(nonce);
  if (idx >= 0) db.authNonces[owner][token].issued.splice(idx, 1);
  saveNonceDb(db);
  return true;
}
