import { readFile } from "node:fs/promises";

const DIMS = 14;
const K = 5;
const INV127 = 1 / 127;
const SCALE_SQ = 127 * 127; // 16129 — usado para converter tauSq para espaço escalado

async function loadBinary(path: string): Promise<ArrayBuffer> {
  try {
    const buf = await readFile(path);
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  } catch (e) {
    console.error(`Failed to load binary file "${path}":`, e);
    process.exit(1);
  }
}

// Carrega os 4 binários em paralelo
const [vBuf, lBuf, treeBuf] = await Promise.all([
  loadBinary("vectors.bin"),
  loadBinary("labels.bin"),
  loadBinary("vptree.bin"),
]);

// Int8: 4× menos memória que Float32 (42 MB vs 168 MB para 3M vetores)
const referenceVectors = new Int8Array(vBuf);
const referenceLabels = new Uint8Array(lBuf);
export const referenceCount = referenceLabels.length;

// Leitura das 4 seções do VP-Tree via views sobre o mesmo buffer
const vpIndices = new Int32Array(treeBuf, 0, referenceCount);
const vpMus = new Float32Array(treeBuf, referenceCount * 4, referenceCount);
const vpLefts = new Int32Array(treeBuf, referenceCount * 8, referenceCount);
const vpRights = new Int32Array(treeBuf, referenceCount * 12, referenceCount);

// ── Buffers reutilizáveis por requisição (seguro: Node.js é single-threaded) ──
export const queryVector = new Float32Array(DIMS); // escrito pelo index.ts
const queryVectorScaled = new Float32Array(DIMS); // queryVector × 127, pré-calculado por query

// Stack de traversal do VP-Tree: profundidade máxima ≈ 2 × log₂(N)
// Para N = 1M: ≈ 40; reservamos 1024 para folga.
const searchStack = new Int32Array(1024);

// Max-heap de tamanho fixo K para os top-K vizinhos
const heapDists = new Float32Array(K).fill(Infinity);
const heapLabels = new Uint8Array(K);

// ── Helpers inline ────────────────────────────────────────────────────────

// Retorna distância quadrática no espaço escalado: Σ(q×127 - ref)²
// Distância real = sqrt(resultado) × INV127  (evita 14 divisões por chamada)
function euclideanSq(refIdx: number): number {
  let sum = 0;
  const base = refIdx * DIMS;
  for (let j = 0; j < DIMS; j++) {
    const d = queryVectorScaled[j]! - referenceVectors[base + j]!;
    sum += d * d;
  }
  return sum;
}

// Insere no max-heap de tamanho K. Retorna o novo tau (máximo atual).
function heapInsert(dist: number, label: number, heapSize: number): number {
  if (heapSize < K) {
    heapDists[heapSize] = dist;
    heapLabels[heapSize] = label;
    // Retorna o max real até agora (fix: antes retornava dist, causando tau incorreto)
    let mx = heapDists[0]!;
    for (let i = 1; i <= heapSize; i++)
      if (heapDists[i]! > mx) mx = heapDists[i]!;
    return mx;
  }
  // Heap cheio: encontrar o pior slot em scan único
  let maxDist = heapDists[0]!;
  let maxIdx = 0;
  for (let i = 1; i < K; i++) {
    if (heapDists[i]! > maxDist) {
      maxDist = heapDists[i]!;
      maxIdx = i;
    }
  }
  if (dist < maxDist) {
    heapDists[maxIdx] = dist;
    heapLabels[maxIdx] = label;
    let newMax = 0;
    for (let i = 0; i < K; i++)
      if (heapDists[i]! > newMax) newMax = heapDists[i]!;
    return newMax;
  }
  return maxDist;
}

// ── k-NN via VP-Tree ──────────────────────────────────────────────────────

export function knnFraudScore(): number {
  heapDists.fill(Infinity);

  // Pré-escala a query uma vez: elimina 14 divisões float por chamada a euclideanSq
  for (let j = 0; j < DIMS; j++) queryVectorScaled[j] = queryVector[j]! * 127;

  let stackTop = 0;
  let heapSize = 0;
  let tau = Infinity;
  let tauSq = Infinity; // tau² × 127² — compara diretamente com saída de euclideanSq

  searchStack[stackTop++] = 0; // começa pela raiz (nodeIdx = 0)

  while (stackTop > 0) {
    const nodeIdx = searchStack[--stackTop]!;
    const refIdx = vpIndices[nodeIdx]!;
    const left = vpLefts[nodeIdx]!;
    const right = vpRights[nodeIdx]!;

    const dSq = euclideanSq(refIdx);

    // Nós folha que não melhoram o heap: pula sqrt completamente
    if (left < 0 && right < 0 && dSq >= tauSq && heapSize >= K) continue;

    const d = Math.sqrt(dSq) * INV127; // distância real (multiplicação > divisão)

    if (d < tau || heapSize < K) {
      tau = heapInsert(d, referenceLabels[refIdx]!, heapSize);
      if (heapSize < K) heapSize++;
      tauSq = tau * tau * SCALE_SQ;
    }

    if (left >= 0 || right >= 0) {
      const mu = vpMus[nodeIdx]!;
      const enterLeft = left >= 0 && d - tau < mu;
      const enterRight = right >= 0 && d + tau >= mu;

      if (d < mu) {
        if (enterRight) searchStack[stackTop++] = right;
        if (enterLeft) searchStack[stackTop++] = left;
      } else {
        if (enterLeft) searchStack[stackTop++] = left;
        if (enterRight) searchStack[stackTop++] = right;
      }
    }
  }

  // Weighted fraud score: soma dos pesos dos vizinhos com label=fraud
  let fraudWeight = 0;
  let totalWeight = 0;
  for (let i = 0; i < K; i++) {
    const w = 1 / (heapDists[i]! + 1e-6);
    totalWeight += w;
    if (heapLabels[i] === 1) fraudWeight += w;
  }

  return fraudWeight / totalWeight;
}
