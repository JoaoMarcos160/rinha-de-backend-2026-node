import { unlinkSync } from "node:fs";
import { createServer } from 'node:http';
import mccRiskData from "./files/mcc_risk.json" with { type: "json" };
import normalizationData from "./files/normalization.json" with { type: "json" };
import type { TransactionPayload } from "./types.ts";
import { knnFraudScore, queryVector, referenceCount } from "./vector.ts";

const N = normalizationData;
const MCC_RISK = mccRiskData as Record<string, number>;
const MCC_RISK_DEFAULT = 0.5;
const APPROVAL_THRESHOLD = 0.6;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Escreve o vetor de consulta diretamente no Float32Array pré-alocado — zero alocações.
function vectorizeToBuffer(q: Float32Array, p: TransactionPayload): void {
  const requestedAtMs = Date.parse(p.transaction.requested_at);
  const avgAmount = p.customer.avg_amount > 0 ? p.customer.avg_amount : 1;
  const utcHour = Math.floor((requestedAtMs % 86_400_000) / 3_600_000);
  const jsDay = (Math.floor(requestedAtMs / 86_400_000) + 4) % 7;

  let minutesSinceLast = -1;
  let kmFromLast = -1;
  if (p.last_transaction) {
    minutesSinceLast = clamp(
      (requestedAtMs - Date.parse(p.last_transaction.timestamp)) /
        60_000 /
        N.max_minutes,
    );
    kmFromLast = clamp(p.last_transaction.km_from_current / N.max_km);
  }

  // Verificar se merchant é desconhecido: loop simples é mais rápido que new Set() para listas curtas
  let unknownMerchant = 1;
  const merchants = p.customer.known_merchants;
  for (let i = 0; i < merchants.length; i++) {
    if (merchants[i] === p.merchant.id) {
      unknownMerchant = 0;
      break;
    }
  }

  q[0] = clamp(p.transaction.amount / N.max_amount);
  q[1] = clamp(p.transaction.installments / N.max_installments);
  q[2] = clamp(p.transaction.amount / avgAmount / N.amount_vs_avg_ratio);
  q[3] = utcHour / 23;
  q[4] = (jsDay === 0 ? 6 : jsDay - 1) / 6;
  q[5] = minutesSinceLast;
  q[6] = kmFromLast;
  q[7] = clamp(p.terminal.km_from_home / N.max_km);
  q[8] = clamp(p.customer.tx_count_24h / N.max_tx_count_24h);
  q[9] = p.terminal.is_online ? 1 : 0;
  q[10] = p.terminal.card_present ? 1 : 0;
  q[11] = unknownMerchant;
  q[12] = MCC_RISK[p.merchant.mcc] ?? MCC_RISK_DEFAULT;
  q[13] = clamp(p.merchant.avg_amount / N.max_merchant_avg_amount);
}

const isReady = referenceCount > 0;
console.log(`✅ VP-Tree pronto — ${referenceCount} vetores de referência.`);


const JSON_HEADERS = { 'Content-Type': 'application/json' };

const socketPath = process.env.SOCKET_PATH!;

process.umask(0o000);
try {
  unlinkSync(socketPath);
} catch {}

const server = createServer((req, res) => {
  const { url, method } = req;

  if (url === '/fraud-score' && method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      const body = JSON.parse(raw.toString()) as TransactionPayload;
      vectorizeToBuffer(queryVector, body);
      const fraudScore = knnFraudScore();
      const result = `{"approved":${fraudScore < APPROVAL_THRESHOLD},"fraud_score":${fraudScore}}`;
      res.writeHead(200, JSON_HEADERS);
      res.end(result);
    });
    return;
  }

  if (url === '/ready') {
    res.writeHead(isReady ? 200 : 503);
    res.end(isReady ? 'OK' : 'Initializing');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen({ path: socketPath }, () => {
  console.log(`🚀 Server running on ${socketPath}`);
});
