/**
 * JUP PROXY - Jupiter API Proxy Server
 * 
 * This proxy server handles Jupiter swap API requests to avoid CORS issues
 * and provides three main endpoints:
 * - GET /quote - Get swap quotes from Jupiter
 * - POST /swap - Build swap transactions
 * - POST /instantSwap - Quote + swap in one call (for instant buys)
 * 
 * Start with: node server/jupproxy.js
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import chalk from "chalk";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "3mb" }));

// 🗝️ Optional API key (only needed for Ultra or Pro)
const JUP_API_KEY = process.env.JUP_API_KEY || ""; // optional, set via env

// ✅ Correct modern endpoints
const ENDPOINTS = [
  { url: "https://lite-api.jup.ag/swap/v1/quote", keyRequired: false },
  { url: "https://api.jup.ag/swap/v1/quote", keyRequired: true },
];

let activeEndpoint = ENDPOINTS[0];

// 🌐 Endpoint chooser
async function chooseWorkingEndpoint() {
  console.log(chalk.cyan("\n[JUP PROXY] 🌐 Checking Jupiter endpoints..."));
  for (const e of ENDPOINTS) {
    try {
      const res = await axios.get(e.url, {
        params: {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 10000000,
          slippageBps: 50,
        },
        headers: {
          ...(e.keyRequired ? { "x-api-key": JUP_API_KEY } : {}),
        },
        timeout: 8000,
      });
      if (res.status === 200) {
        activeEndpoint = e;
        console.log(chalk.green(`[JUP PROXY] ✅ Active Jupiter endpoint: ${e.url}`));
        return;
      }
    } catch (err) {
      const status = err.response?.status || err.message;
      console.log(chalk.yellow(`[JUP PROXY] ⚠️ ${e.url} failed → ${status}`));
    }
  }
  console.log(chalk.red("[JUP PROXY] ❌ No Jupiter endpoints reachable — check API key or network"));
}

// 📄 Retry wrapper for quote calls
async function getQuoteWithRetry(params, maxRetries = 3) {
  const delays = [200, 500, 1000]; // exponential backoff
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios.get(activeEndpoint.url, {
        params,
        headers: {
          ...(activeEndpoint.keyRequired ? { "x-api-key": JUP_API_KEY } : {}),
        },
        timeout: 3000, // short timeout for quotes
      });
      return res;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const delay = delays[attempt] || 1000;
        console.log(chalk.yellow(`[JUP PROXY] Quote attempt ${attempt + 1} failed, retrying in ${delay}ms...`));
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
}

// 🧩 /quote route
app.get("/quote", async (req, res) => {
  const params = {
    inputMint: req.query.inputMint,
    outputMint: req.query.outputMint,
    amount: Number(req.query.amount) || 10000000,
    slippageBps: Number(req.query.slippageBps) || 50,
    platform: "localhost",
  };

  try {
    const r = await axios.get(activeEndpoint.url, {
      params,
      headers: {
        ...(activeEndpoint.keyRequired ? { "x-api-key": JUP_API_KEY } : {}),
      },
    });
    res.json(r.data);
  } catch (e) {
    console.error(chalk.red("[JUP PROXY] Quote error:"), e.message);
    res.status(e.response?.status || 500).json({
      error: e.message,
      detail: e.response?.data || null,
    });
  }
});

// 🧩 /swap route
app.post("/swap", async (req, res) => {
  try {
    const swapEndpoint = activeEndpoint.url.replace('/swap/v1/quote', '');
    const r = await axios.post(`${swapEndpoint}/swap/v1/swap`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        ...(activeEndpoint.keyRequired ? { "x-api-key": JUP_API_KEY } : {}),
      },
    });
    res.json(r.data);
  } catch (e) {
    console.error(chalk.red("[JUP PROXY] Swap error:"), e.message);
    res.status(e.response?.status || 500).json({
      error: e.message,
      detail: e.response?.data || null,
    });
  }
});

// 💥 /instantSwap route - quote + swap in one call
app.post("/instantSwap", async (req, res) => {
  const {
    inputMint,
    outputMint,
    amount,
    slippageBps = 50,
    userPublicKey,
    prioritizationFeeLamports  // No default - undefined means omit
  } = req.body;

  try {
    // Step 1: Get quote with retry logic
    console.log(chalk.cyan("[JUP PROXY] 🚀 Instant swap: getting quote..."));
    const quoteParams = {
      inputMint,
      outputMint,
      amount: Number(amount),
      slippageBps: Number(slippageBps),
      platform: "localhost",
    };

    const quoteRes = await getQuoteWithRetry(quoteParams);
    
    if (!quoteRes.data || !quoteRes.data.outAmount) {
      throw new Error("No route found in quote response");
    }

    // Step 2: Build swap transaction immediately
    console.log(chalk.cyan("[JUP PROXY] 🚀 Instant swap: building transaction..."));
    const swapEndpoint = activeEndpoint.url.replace('/swap/v1/quote', '');
    
    // Base payload without compute budget
    const swapPayload = {
      quoteResponse: quoteRes.data,
      userPublicKey,
      wrapAndUnwrapSol: true,
    };
    
    // Only add compute budget when priority fee is a positive number
    const prio = Number(prioritizationFeeLamports);
    if (Number.isFinite(prio) && prio > 0) {
      swapPayload.dynamicComputeUnitLimit = true;
      swapPayload.prioritizationFeeLamports = prio;
      console.log(chalk.cyan(`[JUP PROXY] Adding compute budget: ${prio} lamports`));
    } else {
      console.log(chalk.yellow("[JUP PROXY] ⚠️ Omitting compute budget (QuickNode safe mode)"));
    }

    const swapRes = await axios.post(`${swapEndpoint}/swap/v1/swap`, swapPayload, {
      headers: {
        'Content-Type': 'application/json',
        ...(activeEndpoint.keyRequired ? { "x-api-key": JUP_API_KEY } : {}),
      },
      timeout: 5000, // slightly longer timeout for swap
    });

    console.log(chalk.green("[JUP PROXY] ✅ Instant swap transaction built successfully"));
    res.json(swapRes.data);
  } catch (e) {
    console.error(chalk.red("[JUP PROXY] ❌ Instant swap error:"), e.message);
    res.status(e.response?.status || 500).json({
      error: e.message,
      detail: e.response?.data || null,
    });
  }
});

// 🩺 Health check endpoint
app.get('/health', (_req, res) => res.json({ ok: true, endpoint: activeEndpoint.url }));

// 🚀 Start server and initialize endpoints
const PORT = 3000;

// CRITICAL FIX: Call and await chooseWorkingEndpoint BEFORE starting server
(async () => {
  await chooseWorkingEndpoint();
  
  app.listen(PORT, () => {
    console.log(chalk.magentaBright(`\n[JUP PROXY] 🚀 Jupiter proxy running at http://localhost:${PORT}`));
    console.log(chalk.green(`[JUP PROXY] ✅ Ready to handle requests\n`));
  });
})();
