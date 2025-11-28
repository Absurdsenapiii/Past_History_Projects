/**
 * Logger Module
 * Handles CSV logging with secure file permissions
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default CSV directory
const CSV_DIR = join(__dirname, '..', 'data');

/**
 * Ensure CSV directory exists
 */
function ensureCSVDirectory() {
  if (!existsSync(CSV_DIR)) {
    mkdirSync(CSV_DIR, { recursive: true });
  }
}

/**
 * Get full path for CSV file
 * @param {string} filename - CSV filename
 * @returns {string} Full path
 */
function getCSVPath(filename) {
  ensureCSVDirectory();
  return join(CSV_DIR, filename);
}

/**
 * Convert object to CSV row
 * @param {Object} obj - Object to convert
 * @param {Array} headers - Header array
 * @returns {string} CSV row
 */
function objectToCSVRow(obj, headers) {
  return headers.map(header => {
    let value = obj[header];
    
    // Handle undefined/null
    if (value === undefined || value === null) {
      return '';
    }
    
    // Convert to string
    value = String(value);
    
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      value = '"' + value.replace(/"/g, '""') + '"';
    }
    
    return value;
  }).join(',');
}

/**
 * Parse CSV row
 * @param {string} row - CSV row
 * @returns {Array} Parsed values
 */
function parseCSVRow(row) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    const nextChar = row[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add last field
  values.push(current);
  
  return values;
}

/**
 * Read CSV file
 * @param {string} filename - CSV filename
 * @returns {Array} Array of objects
 */
export async function readCSV(filename) {
  const filepath = getCSVPath(filename);
  
  if (!existsSync(filepath)) {
    return [];
  }
  
  try {
    const content = readFileSync(filepath, 'utf8');
    const lines = content.trim().split('\n');
    
    if (lines.length === 0) {
      return [];
    }
    
    // First line is headers
    const headers = parseCSVRow(lines[0]);
    
    // Parse data rows
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVRow(lines[i]);
      const obj = {};
      
      headers.forEach((header, index) => {
        obj[header] = values[index] || '';
      });
      
      data.push(obj);
    }
    
    return data;
  } catch (error) {
    console.error(`Error reading CSV ${filename}:`, error.message);
    return [];
  }
}

/**
 * Write CSV file
 * @param {string} filename - CSV filename
 * @param {Array} data - Array of objects
 * @param {Array} headers - Header array
 * @param {boolean} secure - Apply secure permissions (default: true)
 */
export async function writeCSV(filename, data, headers, secure = true) {
  const filepath = getCSVPath(filename);
  
  if (!Array.isArray(data) || data.length === 0) {
    console.warn(`No data to write to ${filename}`);
    return;
  }
  
  try {
    // Build CSV content
    const lines = [headers.join(',')];
    
    for (const row of data) {
      lines.push(objectToCSVRow(row, headers));
    }
    
    const content = lines.join('\n') + '\n';
    
    // Write file
    writeFileSync(filepath, content, 'utf8');
    
    // Apply secure permissions if requested
    if (secure && process.platform !== 'win32') {
      try {
        chmodSync(filepath, 0o600); // Owner read/write only
      } catch (error) {
        console.warn(`Could not set secure permissions on ${filename}:`, error.message);
      }
    }
    
  } catch (error) {
    console.error(`Error writing CSV ${filename}:`, error.message);
    throw error;
  }
}

/**
 * Append to CSV file
 * @param {string} filename - CSV filename
 * @param {Array} data - Array of objects to append
 * @param {Array} headers - Header array
 * @param {boolean} secure - Apply secure permissions (default: true)
 */
export async function appendToCSV(filename, data, headers, secure = true) {
  const filepath = getCSVPath(filename);
  
  if (!Array.isArray(data) || data.length === 0) {
    return;
  }
  
  try {
    const fileExists = existsSync(filepath);
    
    // If file doesn't exist, create it with headers
    if (!fileExists) {
      await writeCSV(filename, data, headers, secure);
      return;
    }
    
    // Build rows to append
    const lines = [];
    for (const row of data) {
      lines.push(objectToCSVRow(row, headers));
    }
    
    const content = lines.join('\n') + '\n';
    
    // Append to file
    appendFileSync(filepath, content, 'utf8');
    
    // Apply secure permissions if requested
    if (secure && process.platform !== 'win32') {
      try {
        chmodSync(filepath, 0o600);
      } catch (error) {
        // Ignore permission errors on append
      }
    }
    
  } catch (error) {
    console.error(`Error appending to CSV ${filename}:`, error.message);
    throw error;
  }
}

/**
 * Clean sensitive data from CSV files
 * @param {boolean} dryRun - If true, only show what would be removed
 */
export async function cleanSensitiveData(dryRun = true) {
  const sensitiveFiles = ['addresses.csv'];
  
  for (const filename of sensitiveFiles) {
    const filepath = getCSVPath(filename);
    
    if (!existsSync(filepath)) {
      continue;
    }
    
    try {
      const data = await readCSV(filename);
      
      if (data.length === 0) {
        continue;
      }
      
      console.log(`\n📄 Processing ${filename}:`);
      console.log(`   Found ${data.length} entries with private keys`);
      
      if (dryRun) {
        console.log(`   🔍 DRY RUN: Would remove privateKey column`);
        continue;
      }
      
      // Remove privateKey from each entry
      const cleanedData = data.map(entry => {
        const { privateKey, ...cleaned } = entry;
        return cleaned;
      });
      
      // Get headers (exclude privateKey)
      const headers = Object.keys(data[0]).filter(h => h !== 'privateKey');
      
      // Write cleaned data
      await writeCSV(filename, cleanedData, headers, true);
      
      console.log(`   ✅ Removed privateKey column from ${data.length} entries`);
      
    } catch (error) {
      console.error(`   ❌ Error cleaning ${filename}:`, error.message);
    }
  }
}

/**
 * Get CSV file stats
 * @param {string} filename - CSV filename
 * @returns {Object} File stats
 */
export function getCSVStats(filename) {
  const filepath = getCSVPath(filename);
  
  if (!existsSync(filepath)) {
    return { exists: false, rows: 0, size: 0 };
  }
  
  try {
    const content = readFileSync(filepath, 'utf8');
    const lines = content.trim().split('\n');
    const rows = Math.max(0, lines.length - 1); // Exclude header
    const size = Buffer.byteLength(content, 'utf8');
    
    return {
      exists: true,
      rows,
      size,
      path: filepath
    };
  } catch (error) {
    return { exists: false, rows: 0, size: 0, error: error.message };
  }
}

/**
 * List all CSV files in data directory
 * @returns {Array} Array of filenames
 */
export function listCSVFiles() {
  ensureCSVDirectory();
  
  try {
    const fs = await import('fs/promises');
    const files = await fs.readdir(CSV_DIR);
    return files.filter(f => f.endsWith('.csv'));
  } catch (error) {
    console.error('Error listing CSV files:', error.message);
    return [];
  }
}

export { CSV_DIR };
