#!/usr/bin/env python3
# (short header comment retained; full implementation included below)
import os, re, time, json, random, threading
from datetime import datetime, timezone
from typing import Dict, Tuple, Optional
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from dotenv import load_dotenv

load_dotenv()

def _env_num(name, default, cast=float, min_val=None, max_val=None):
    v=os.getenv(name, str(default))
    try: x=cast(v)
    except Exception: raise ValueError(f'Invalid value for {name}: {v}')
    if min_val is not None and x < min_val: raise ValueError(f'{name} must be >= {min_val}, got {x}')
    if max_val is not None and x > max_val: raise ValueError(f'{name} must be <= {max_val}, got {x}')
    return x

MODE=os.getenv('MODE','both').lower()
if MODE not in {'spike','dip','both'}: raise ValueError('MODE must be one of: spike, dip, both')
CHECK_INTERVAL_MS=_env_num('CHECK_INTERVAL_MS',60000,int,5000,600000)
WINDOW_MINUTES=_env_num('WINDOW_MINUTES',5,int,1,120)
WINDOW_MS=WINDOW_MINUTES*60000
SPIKE_THRESHOLD=_env_num('SPIKE_THRESHOLD',0.10,float,0.01,0.99)
DIP_THRESHOLD=_env_num('DIP_THRESHOLD',0.10,float,0.01,0.99)
SYMBOL_SUFFIX=os.getenv('SYMBOL_SUFFIX','USDT').upper().strip()
MIN_QUOTE_VOLUME=_env_num('MIN_QUOTE_VOLUME',20000000,float,0)
MIN_5M_QUOTE_VOLUME=_env_num('MIN_5M_QUOTE_VOLUME',1000000,float,0)
COOLDOWN_MINUTES=_env_num('COOLDOWN_MINUTES',15,int,1,1440)
TELEGRAM_BOT_TOKEN=os.getenv('TELEGRAM_BOT_TOKEN','').strip()
TELEGRAM_CHAT_ID=os.getenv('TELEGRAM_CHAT_ID','').strip()
TELEGRAM_TIMEOUT=_env_num('TELEGRAM_TIMEOUT',5,int,2,30)
LOG_FILE=os.getenv('LOG_FILE','futures_monitor.log').strip()
HTTP_TIMEOUT_SECONDS=_env_num('HTTP_TIMEOUT_SECONDS',8,int,2,60)
HTTP_RETRIES=_env_num('HTTP_RETRIES',5,int,1,10)
HTTP_MAX_BACKOFF=_env_num('HTTP_MAX_BACKOFF',15,int,3,60)
MAX_5M_WORKERS=_env_num('MAX_5M_WORKERS',8,int,1,32)
BINANCE_API_KEY=os.getenv('BINANCE_API_KEY','').strip()
BINANCE_API_SECRET=os.getenv('BINANCE_API_SECRET','').strip()
BINANCE_KEY_MODE=os.getenv('BINANCE_KEY_MODE','on').lower()
FAPI_BASES=os.getenv('FAPI_BASES','https://fapi.binance.com,https://fapi1.binance.com,https://fapi2.binance.com,https://fapi3.binance.com').split(',')
if WINDOW_MS <= CHECK_INTERVAL_MS: raise ValueError('WINDOW_MINUTES must be large enough so WINDOW_MS > CHECK_INTERVAL_MS.')

def now_ms(): return int(time.time()*1000)
def iso(ts=None): return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).isoformat()

def rotate_if_needed(path, max_size):
    try:
        if os.path.exists(path) and os.path.getsize(path) > max_size:
            bak=path+'.1'
            if os.path.exists(bak): os.remove(bak)
            os.rename(path,bak)
    except: pass

def log(msg):
    line=f'[{iso()}] {msg}'
    print(line, flush=True)
    try:
        rotate_if_needed(LOG_FILE, 5*1024*1024)
        with open(LOG_FILE,'a',encoding='utf-8') as f: f.write(line+'\n')
    except: pass

import requests
def http_get(url, params=None, headers=None, timeout=HTTP_TIMEOUT_SECONDS, retries=HTTP_RETRIES, max_backoff=HTTP_MAX_BACKOFF):
    headers=headers or {}
    for i in range(retries):
        t0=time.time(); dt=0
        try:
            res=requests.get(url, params=params, headers=headers, timeout=timeout)
            dt=int((time.time()-t0)*1000)
            s=res.status_code
            if s in (429,418) or s>=500: raise requests.HTTPError(f'status {s}', response=res)
            if s==403: raise requests.HTTPError('status 403 (forbidden)', response=res)
            res.raise_for_status()
            return res
        except Exception as e:
            if i==retries-1: raise
            base=2**i
            if isinstance(e, requests.HTTPError) and getattr(e,'response',None) is not None and e.response.status_code in (418,429):
                base*=1.5
            sleep=min(max_backoff, base)*(0.8+0.4*random.random())
            log(f'HTTP retry {i+1}/{retries} for {url.split("?")[0]}: {e} (after {dt}ms); sleep {sleep:.2f}s')
            time.sleep(sleep)

def http_post(url, data=None, json_body=None, headers=None, timeout=TELEGRAM_TIMEOUT, retries=3, max_backoff=6):
    headers=headers or {}
    for i in range(retries):
        t0=time.time(); dt=0
        try:
            res=requests.post(url, data=data, json=json_body, headers=headers, timeout=timeout)
            dt=int((time.time()-t0)*1000)
            if res.status_code in (429,418) or res.status_code>=500: raise requests.HTTPError(f'status {res.status_code}', response=res)
            res.raise_for_status()
            return res
        except Exception as e:
            if i==retries-1: raise
            base=1.5**i; sleep=min(max_backoff, base)*(0.8+0.4*random.random())
            log(f'POST retry {i+1}/{retries} for {url}: {e} (after {dt}ms); sleep {sleep:.2f}s')
            time.sleep(sleep)

def send_telegram(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log(f'[telegram-disabled] {text}'); return
    try:
        url=f'https://api.telegram.org/bot<masked>/sendMessage'
        real_url=f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
        http_post(real_url, data={'chat_id':TELEGRAM_CHAT_ID, 'text':text, 'disable_web_page_preview':False})
    except Exception as e:
        log(f'Telegram send error: {e} (url={url})')

def fmt_price(x):
    if x>=100: return f'{x:,.2f}'
    if x>=1: return f'{x:,.4f}'
    return f'{x:.8f}'.rstrip('0')

def _bn_headers():
    # Axios-like headers; enable brotli if available for Binance edge compatibility
    enc = "gzip, deflate"
    try:
        import brotli as _  # or brotlicffi
        enc = "gzip, deflate, br"
    except Exception:
        pass
    h = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": enc,
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Connection": "keep-alive",
    }
    if BINANCE_KEY_MODE == 'on' and BINANCE_API_KEY:
        h["X-MBX-APIKEY"] = BINANCE_API_KEY
    return h

def bn_get(path, params=None):
    last_err=None
    headers=_bn_headers()
    start=int(time.time()*1000)%len(FAPI_BASES)
    for j in range(len(FAPI_BASES)):
        base=FAPI_BASES[(start+j)%len(FAPI_BASES)].strip()
        url=f'{base}{path}'
        try:
            return http_get(url, params=params, headers=headers)
        except Exception as e:
            last_err=e; log(f'bn_get error on {base}: {e}'); continue
    raise last_err if last_err else RuntimeError('bn_get exhausted hosts')

def fetch_24h_tickers():
    try:
        r = bn_get('/fapi/v1/ticker/24hr')
        ct = (r.headers.get('content-type') or '').lower()
        enc = (r.headers.get('content-encoding') or '').lower()
        if 'application/json' not in ct:
            # Log details and bail early to avoid JSON decode exceptions
            snippet = (r.text[:200].replace("\\n", " ") if hasattr(r, "text") else "")
            log(f'fetch_24h_tickers warning: non-JSON response ct={ct} enc={enc} len={len(r.content)} first={snippet!r}')
            return []
        try:
            data = r.json()
        except json.JSONDecodeError as e:
            snippet = (r.text[:200].replace("\\n", " ") if hasattr(r, "text") else "")
            log(f'fetch_24h_tickers error: JSON decode failed ({e}) ct={ct} enc={enc} first={snippet!r}')
            return []
        if not isinstance(data, list):
            log(f'Non-list ticker response: {str(data)[:120]}')
            return []
    except Exception as e:
        log(f'fetch_24h_tickers error: {e}')
        return []
    out = []
    for item in data:
        sym = item.get('symbol','')
        if SYMBOL_SUFFIX and not sym.endswith(SYMBOL_SUFFIX):
            continue
        try:
            price = float(item.get('lastPrice','0'))
            qv = float(item.get('quoteVolume','0'))
        except Exception:
            continue
        out.append({'symbol': sym, 'price': price, 'quoteVolume': qv})
    return out

KLINE_QUOTE_VOL_INDEX=7
def fetch_5m_quote_volume(symbol):
    try:
        r=bn_get('/fapi/v1/klines', params={'symbol':symbol, 'interval':'5m', 'limit':1})
        k=r.json()
        if not k or not isinstance(k, list) or not k[0]:
            log(f'kline empty/malformed for {symbol}'); return 0.0
        return float(k[0][KLINE_QUOTE_VOL_INDEX])
    except Exception as e:
        log(f'kline fetch error for {symbol}: {e}'); return 0.0

class Monitor:
    def __init__(self):
        self.price_hist: Dict[str, deque] = {}
        self.cooldown_until: Dict[Tuple[str,str], int] = {}
        self.lock=threading.Lock()
        self._load_cooldowns()
    def _load_cooldowns(self):
        try:
            with open('cooldowns.json','r',encoding='utf-8') as f: data=json.load(f)
            now=now_ms()
            with self.lock:
                for k,v in data.items():
                    sym,kind=k.split('::',1)
                    if v>now: self.cooldown_until[(sym,kind)]=v
        except Exception: pass
    def _save_cooldowns(self):
        try:
            with self.lock:
                data={f'{k[0]}::{k[1]}':v for k,v in self.cooldown_until.items() if v>now_ms()}
            with open('cooldowns.json','w',encoding='utf-8') as f: json.dump(data,f)
        except Exception: pass
    def append_price(self, symbol, price):
        ts=now_ms()
        with self.lock:
            dq=self.price_hist.setdefault(symbol, deque())
            dq.append((ts,price))
            cutoff=ts-WINDOW_MS
            while dq and dq[0][0]<cutoff: dq.popleft()
    def get_info(self, symbol):
        with self.lock:
            dq=self.price_hist.get(symbol)
            if not dq or len(dq)<2: return None
            latest_ts, latest_price=dq[-1]; ref_ts, ref_price=dq[0]
            return {'latest':{'ts':latest_ts,'price':latest_price}, 'ref':{'ts':ref_ts,'price':ref_price}, 'points':len(dq)}
    def eligible_window(self, info): 
        dt=info['latest']['ts']-info['ref']['ts']; return dt>=int(WINDOW_MS*0.9)
    def on_cooldown(self, symbol, kind):
        with self.lock: until=self.cooldown_until.get((symbol,kind),0); return now_ms()<until
    def set_cooldown(self, symbol, kind):
        with self.lock: self.cooldown_until[(symbol,kind)]=now_ms()+COOLDOWN_MINUTES*60000
        self._save_cooldowns()

monitor=Monitor()


def binance_link(symbol: str) -> str:
    base = os.getenv('BINANCE_WEB_BASE', 'https://www.binance.com').rstrip('/')
    return f"{base}/en/futures/{symbol}"

def fmt_pct(p): return f'{p:+.2%}'


def build_message(symbol, kind, pct, latest, ref, qv24, qv5):
    emoji = "🚀" if kind == "spike" else "🔻"
    header = f"{emoji} {symbol} {fmt_pct(pct)} in {WINDOW_MINUTES}m"
    price_line = f"Price: {fmt_price(ref)} → {fmt_price(latest)}"
    vol_line = f"Vol (24h): ${qv24:,.0f}"
    return "\n".join([header, price_line, vol_line, binance_link(symbol)])
def tick_once():
    tickers=fetch_24h_tickers()
    for t in tickers: monitor.append_price(t['symbol'], t['price'])
    candidates=[]
    for t in tickers:
        symbol=t['symbol']; qv24=t['quoteVolume']
        if qv24<MIN_QUOTE_VOLUME: continue
        info=monitor.get_info(symbol)
        if not info or not monitor.eligible_window(info): continue
        ref=info['ref']['price']; latest=info['latest']['price']
        if ref is None or ref<=0: continue
        pct=(latest-ref)/ref
        if MODE in {'spike','both'} and pct>=SPIKE_THRESHOLD and not monitor.on_cooldown(symbol,'spike'):
            candidates.append((symbol,'spike',pct,latest,ref,qv24))
        if MODE in {'dip','both'} and pct<=-DIP_THRESHOLD and not monitor.on_cooldown(symbol,'dip'):
            candidates.append((symbol,'dip',pct,latest,ref,qv24))
    alerts=[]
    if candidates:
        with ThreadPoolExecutor(max_workers=MAX_5M_WORKERS) as ex:
            futs={ex.submit(fetch_5m_quote_volume, c[0]): c for c in candidates}
            for fut in as_completed(futs):
                symbol,kind,pct,latest,ref,qv24=futs[fut]
                try: qv5=fut.result()
                except Exception: qv5=0.0
                if MIN_5M_QUOTE_VOLUME>0 and qv5<MIN_5M_QUOTE_VOLUME: continue
                alerts.append((qv24, build_message(symbol,kind,pct,latest,ref,qv24,qv5), symbol, kind))
    if alerts:
        alerts.sort(key=lambda x:x[0], reverse=True)
        if len(alerts)>5:
            top3='\n\n'.join(a[1] for a in alerts[:3])
            send_telegram(f'⚠ {len(alerts)} symbols moved (mode: {MODE}).\n\n{top3}\n\n(+{len(alerts)-3} more)')
        else:
            for _,msg,_,_ in alerts: send_telegram(msg)
        for _,_,symbol,kind in alerts:
            monitor.set_cooldown(symbol,kind); log(f'COOLDOWN set {symbol}/{kind} +{COOLDOWN_MINUTES}m')

def main():
    log(f'Starting monitor MODE={MODE}, WINDOW_MINUTES={WINDOW_MINUTES}, CHECK_INTERVAL_MS={CHECK_INTERVAL_MS}')
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        send_telegram(f'Monitor started. MODE={MODE} WINDOW={WINDOW_MINUTES}m INTERVAL={int(CHECK_INTERVAL_MS/1000)}s')
    try:
        while True:
            t0=time.time()
            try: tick_once()
            except Exception as e: log(f'tick error: {e}')
            time.sleep(max(0.0, (CHECK_INTERVAL_MS/1000.0)-(time.time()-t0)))
    except KeyboardInterrupt:
        log('Shutting down (Ctrl+C)')
        if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID: send_telegram('Monitor stopped.')

if __name__=='__main__': main()
