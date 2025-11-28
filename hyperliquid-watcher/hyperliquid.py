import requests
import time
import random
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import threading

# === CONFIGURATION ===
RPCS = [
    
]
ZAP_URL = ""
WATCH_ADDRESS = "0x07c249fa3902fd243ad0fa58047bE8A3262B7104".lower()

ERC20_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"  # Fixed: full signature
SLEEP_BASE = 0.3            # Reduced poll interval for better responsiveness
MAX_BLOCK_GAP = 10          # Increased to handle larger gaps
BATCH_SIZE = 100            # Max blocks per batch to avoid timeout
MAX_RETRIES = 3             # Retry failed requests

symbol_cache = {}
processed_txs = deque(maxlen=1000)  # Track processed transactions to avoid duplicates
zapier_queue = []
zapier_lock = threading.Lock()

# === HELPER FUNCTIONS ===
def rpc(node, method, params=[], timeout=5, retry_count=0):
    """Enhanced RPC call with retry logic"""
    try:
        r = requests.post(node, json={
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1
        }, timeout=timeout)
        result = r.json()
        
        if "error" in result:
            raise Exception(f"RPC error: {result['error']}")
        return result
    except Exception as e:
        if retry_count < MAX_RETRIES:
            time.sleep(0.5 * (retry_count + 1))
            return rpc(node, method, params, timeout, retry_count + 1)
        print(f"⚠️ RPC error after {MAX_RETRIES} retries: {e}")
        return None

def get_latest_block(node):
    res = rpc(node, "eth_blockNumber")
    return int(res["result"], 16) if res and "result" in res else 0

def get_best_rpc():
    """Select RPC with highest block and lowest latency"""
    results = {}
    
    def check_rpc(n):
        start = time.time()
        blk = get_latest_block(n)
        latency = time.time() - start
        return n, blk, latency
    
    with ThreadPoolExecutor(max_workers=len(RPCS)) as executor:
        futures = [executor.submit(check_rpc, n) for n in RPCS]
        for future in futures:
            n, blk, latency = future.result()
            if blk > 0:
                results[n] = (blk, latency)
    
    if not results:
        return RPCS[0], 0
    
    # Sort by block height first, then by latency
    best = max(results.items(), key=lambda x: (x[1][0], -x[1][1]))
    print(f"🧠 Using {best[0].split('/')[2]} | block {best[1][0]} | latency {best[1][1]:.2f}s")
    return best[0], best[1][0]

def get_transfer_logs_batch(node, start_block, end_block):
    """Get logs in smaller batches to avoid timeouts"""
    all_logs = []
    current = start_block
    
    while current <= end_block:
        batch_end = min(current + BATCH_SIZE - 1, end_block)
        params = [{
            "fromBlock": hex(current),
            "toBlock": hex(batch_end),
            "topics": [ERC20_SIG],
        }]
        
        res = rpc(node, "eth_getLogs", params, timeout=10)
        if res and "result" in res:
            all_logs.extend(res["result"])
        else:
            print(f"⚠️ Failed to get logs for blocks {current}-{batch_end}")
        
        current = batch_end + 1
    
    return all_logs

def decode_log(log):
    """Decode ERC20 transfer log"""
    topics = log.get("topics", [])
    if not topics or topics[0] != ERC20_SIG:
        return None
    if len(topics) < 3:
        return None
    
    from_addr = "0x" + topics[1][-40:].lower()
    to_addr = "0x" + topics[2][-40:].lower()
    
    # Handle both indexed and non-indexed value
    if len(topics) > 3:
        # Value is indexed (rare but possible)
        val = int(topics[3], 16)
    else:
        # Value is in data field (standard)
        val = int(log.get("data", "0x0"), 16)
    
    token = log.get("address", "").lower()
    tx_hash = log.get("transactionHash", "")
    
    return {
        "from": from_addr, 
        "to": to_addr, 
        "value": val, 
        "token": token,
        "txHash": tx_hash,
        "blockNumber": int(log.get("blockNumber", "0x0"), 16)
    }

def get_symbol(node, token_addr):
    """Get token symbol with caching"""
    if token_addr in symbol_cache:
        return symbol_cache[token_addr]
    
    try:
        data = "0x95d89b41"  # symbol()
        res = rpc(node, "eth_call", [{"to": token_addr, "data": data}, "latest"])
        if res and res.get("result") and res["result"] != "0x":
            hexstr = res["result"][2:]
            # Handle dynamic string encoding
            if len(hexstr) > 128:  # Dynamic string
                offset = int(hexstr[0:64], 16) * 2
                length = int(hexstr[offset:offset+64], 16)
                sym_hex = hexstr[offset+64:offset+64+length*2]
            else:  # Static string
                sym_hex = hexstr[128:].rstrip("0")
            
            sym = bytes.fromhex(sym_hex).decode("utf-8", errors="ignore").strip("\x00").strip()
            symbol_cache[token_addr] = sym or "UNK"
            return symbol_cache[token_addr]
    except Exception as e:
        print(f"⚠️ Failed to get symbol for {token_addr}: {e}")
    
    symbol_cache[token_addr] = "UNK"
    return "UNK"

def zapier_worker():
    """Background thread to send data to Zapier without blocking main loop"""
    print("⚙️ Zapier worker started")   # <-- NEW

    while True:
        try:
            with zapier_lock:
                if zapier_queue:
                    payload = zapier_queue.pop(0)
                else:
                    payload = None

            if payload:
                print(f"📤 Sending payload → {payload}")  # <-- NEW debug print
                try:
                    r = requests.post(ZAP_URL, json=payload, timeout=5)
                    print(f"🌐 Zapier response: {r.status_code} {r.text}")  # <-- NEW
                    if r.status_code != 200:
                        print(f"⚠️ Zapier returned {r.status_code} → {r.text}")
                except Exception as e:
                    print(f"⚠️ Zapier post failed: {e}")
                    # Re-queue on failure
                    with zapier_lock:
                        zapier_queue.insert(0, payload)
                    time.sleep(2)
            else:
                time.sleep(0.1)

        except Exception as e:
            print(f"⚠️ Zapier worker error: {e}")
            time.sleep(1)


def send_to_zapier(payload):
    """Queue payload for Zapier (non-blocking)"""
    with zapier_lock:
        zapier_queue.append(payload)
        print(f"🧾 Queued for Zapier ({len(zapier_queue)} pending)")  # <-- NEW


# === MAIN LOOP ===
def main():
    # Start Zapier worker thread
    zapier_thread = threading.Thread(target=zapier_worker, daemon=True)
    zapier_thread.start()
    
    node, last_block = get_best_rpc()
    print(f"🚀 Starting from block {last_block}")
    print(f"👀 Watching address: {WATCH_ADDRESS}")
    
    consecutive_errors = 0
    last_rpc_check = time.time()
    
    while True:
        try:
            # Periodically check for better RPC (every 30 seconds)
            if time.time() - last_rpc_check > 30:
                new_node, _ = get_best_rpc()
                if new_node != node:
                    node = new_node
                    print(f"🔄 Switched to {node.split('/')[2]}")
                last_rpc_check = time.time()
            
            latest = get_latest_block(node)
            if latest == 0:
                consecutive_errors += 1
                if consecutive_errors > 3:
                    node, _ = get_best_rpc()
                    consecutive_errors = 0
                time.sleep(1)
                continue
            
            consecutive_errors = 0
            
            # Check if we're behind
            if latest > last_block:
                blocks_behind = latest - last_block
                
                if blocks_behind > MAX_BLOCK_GAP:
                    print(f"⚠️ Too far behind ({blocks_behind} blocks), jumping to recent blocks")
                    last_block = latest - 2  # Keep 2 blocks buffer
                
                # Process blocks in batches
                process_from = last_block + 1
                process_to = latest
                
                print(f"\n[{time.strftime('%H:%M:%S')}] ⛓️ Processing blocks {process_from}-{process_to} ({blocks_behind} blocks)")
                
                logs = get_transfer_logs_batch(node, process_from, process_to)
                
                relevant_count = 0
                for lg in logs:
                    decoded = decode_log(lg)
                    if not decoded:
                        continue
                    
                    # Check if relevant to our address
                    if WATCH_ADDRESS not in (decoded["from"], decoded["to"]):
                        continue
                    
                    # Check for duplicates
                    tx_id = decoded["txHash"]
                    if tx_id in processed_txs:
                        continue
                    processed_txs.append(tx_id)
                    
                    relevant_count += 1
                    
                    # Get token symbol
                    symbol = get_symbol(node, decoded["token"])
                    direction = "BUY" if WATCH_ADDRESS == decoded["to"] else "SELL"
                    
                    # Assuming 18 decimals (adjust if needed per token)
                    amt = decoded["value"] / 1e18
                    
                    payload = {
                        "direction": direction,
                        "symbol": symbol,
                        "amount": round(amt, 6),
                        "txHash": tx_id,
                        "block": decoded["blockNumber"],
                        "timestamp": int(time.time()),
                        "from": decoded["from"],
                        "to": decoded["to"],
                        "token": decoded["token"]
                    }
                    
                    print(f"💰 {direction} {amt:.4f} {symbol} | Block {decoded['blockNumber']} | TX: {tx_id[:10]}...")
                    send_to_zapier(payload)
                
                if relevant_count > 0:
                    print(f"✅ Found {relevant_count} relevant transactions")
                
                last_block = latest
            
            # Dynamic sleep based on activity
            if blocks_behind > 5:
                sleep_time = 0.1  # Fast catch-up
            elif blocks_behind > 1:
                sleep_time = SLEEP_BASE
            else:
                sleep_time = SLEEP_BASE + random.random() * 0.2
            
            time.sleep(sleep_time)
            
        except KeyboardInterrupt:
            print("\n👋 Shutting down...")
            break
        except Exception as e:
            print(f"⚠️ Main loop error: {e}")
            consecutive_errors += 1
            if consecutive_errors > 5:
                print("🔄 Too many errors, switching RPC...")
                node, last_block = get_best_rpc()
                consecutive_errors = 0
            time.sleep(2)

if __name__ == "__main__":
    main()