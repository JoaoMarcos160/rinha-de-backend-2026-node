import { readFile, writeFile } from "node:fs/promises";

const DIMS = 14;

const data: { vector: number[]; label: string }[] = JSON.parse(
  await readFile("references.json", "utf-8"),
);
const total = data.length;

// --- Vetores (Float32 interno para VP-Tree) e labels ---
const vectorBuffer = new Float32Array(total * DIMS);
const labelBuffer = new Uint8Array(total);

for (let i = 0; i < total; i++) {
  vectorBuffer.set(data[i]!.vector, i * DIMS);
  labelBuffer[i] = data[i]!.label === "legit" ? 0 : 1;
}

// Quantizar Float32 → Int8: range [-1,1] → [-127,127]
// Reduz vectors.bin de 160 MB para 42 MB (3M vetores × 14 dims)
const int8Vectors = new Int8Array(total * DIMS);
for (let i = 0; i < total * DIMS; i++) {
  int8Vectors[i] = Math.max(
    -127,
    Math.min(127, Math.round(vectorBuffer[i]! * 127)),
  );
}

await writeFile("vectors.bin", Buffer.from(int8Vectors.buffer));
await writeFile("labels.bin", Buffer.from(labelBuffer.buffer));
console.log(
  `Vetores: ${total} elementos convertidos (Int8, ${(
    int8Vectors.byteLength /
    1024 /
    1024
  ).toFixed(1)} MB).`,
);

// --- VP-Tree ---
// Layout de vptree.bin (N × 16 bytes, 4 seções de N × 4 bytes cada):
//   [0      .. N×4-1 ] vpIndices : Int32   — qual vetor de referência este nó representa
//   [N×4   .. N×8-1  ] vpMus     : Float32 — threshold (mediana das distâncias)
//   [N×8   .. N×12-1 ] vpLefts   : Int32   — filho esquerdo (-1 = nenhum)
//   [N×12  .. N×16-1 ] vpRights  : Int32   — filho direito  (-1 = nenhum)

const vpIndices = new Int32Array(total);
const vpMus = new Float32Array(total);
const vpLefts = new Int32Array(total).fill(-1);
const vpRights = new Int32Array(total).fill(-1);

let nodeCount = 0;

function euclidean(a: number, b: number): number {
  let sum = 0;
  const ao = a * DIMS;
  const bo = b * DIMS;
  for (let j = 0; j < DIMS; j++) {
    const d = vectorBuffer[ao + j]! - vectorBuffer[bo + j]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// Índices de trabalho usados in-place durante o build
const workIndices = new Int32Array(total);
for (let i = 0; i < total; i++) workIndices[i] = i;

// Build iterativo com stack explícita (evita estouro de pilha de recursão para N grande)
type Frame = { lo: number; hi: number; parent: number; isLeft: boolean };
const buildStack: Frame[] = [
  { lo: 0, hi: total - 1, parent: -1, isLeft: true },
];

while (buildStack.length > 0) {
  const frame = buildStack.pop()!;
  const { lo, hi, parent, isLeft } = frame;

  if (lo > hi) continue;

  const nodeIdx = nodeCount++;
  if (parent >= 0) {
    if (isLeft) vpLefts[parent] = nodeIdx;
    else vpRights[parent] = nodeIdx;
  }

  // Escolher VP aleatório dentro do intervalo para balancear a árvore
  const randomOffset = Math.floor(Math.random() * (hi - lo + 1));
  const temp = workIndices[lo]!;
  workIndices[lo] = workIndices[lo + randomOffset]!;
  workIndices[lo + randomOffset] = temp;

  const vp = workIndices[lo]!;
  vpIndices[nodeIdx] = vp;

  if (lo === hi) {
    vpMus[nodeIdx] = 0;
    continue;
  }

  const n = hi - lo;

  // Distâncias do VP para os demais itens no intervalo [lo+1..hi]
  const dists = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dists[i] = euclidean(vp, workIndices[lo + 1 + i]!);
  }

  // Mediana das distâncias → threshold do nó
  const sortedDists = dists.slice().sort();
  const mu = sortedDists[Math.floor(n / 2)]!;
  vpMus[nodeIdx] = mu;

  // Particionar workIndices[lo+1..hi]: esquerda (dist < mu), direita (dist >= mu)
  const leftBuf: number[] = [];
  const rightBuf: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dists[i]! < mu) leftBuf.push(workIndices[lo + 1 + i]!);
    else rightBuf.push(workIndices[lo + 1 + i]!);
  }

  let pos = lo + 1;
  for (const idx of leftBuf) workIndices[pos++] = idx;
  const leftHi = pos - 1;
  for (const idx of rightBuf) workIndices[pos++] = idx;

  // Empilhar direito antes para que esquerdo seja processado primeiro
  if (rightBuf.length > 0) {
    buildStack.push({ lo: leftHi + 1, hi, parent: nodeIdx, isLeft: false });
  }
  if (leftBuf.length > 0) {
    buildStack.push({ lo: lo + 1, hi: leftHi, parent: nodeIdx, isLeft: true });
  }
}

// Serializar em buffer único contíguo (4 seções × N × 4 bytes)
const treeBuf = new ArrayBuffer(total * 16);
new Int32Array(treeBuf, 0, total).set(vpIndices);
new Float32Array(treeBuf, total * 4, total).set(vpMus);
new Int32Array(treeBuf, total * 8, total).set(vpLefts);
new Int32Array(treeBuf, total * 12, total).set(vpRights);

await writeFile("vptree.bin", Buffer.from(treeBuf));
console.log(
  `VP-Tree: ${nodeCount} nós serializados (${((total * 16) / 1024).toFixed(
    1,
  )} KB).`,
);

const PRINT_DEPTH = 2; // profundidade máxima para printar

function printNode(
  nodeIdx: number,
  depth: number = 0,
  prefix: string = "",
  connType: "root" | "mid" | "last" = "root",
): void {
  if (nodeIdx < 0) return;
  const G = "\x1b[90m",
    Y = "\x1b[33m",
    C = "\x1b[36m",
    GR = "\x1b[32m",
    B = "\x1b[1m",
    R = "\x1b[0m",
    RED = "\x1b[31m";

  const vp = vpIndices[nodeIdx]!;
  const mu = vpMus[nodeIdx]!;
  const left = vpLefts[nodeIdx]!;
  const right = vpRights[nodeIdx]!;
  const isLeaf = left < 0 && right < 0;

  const connector =
    connType === "root"
      ? ""
      : connType === "last"
      ? `${G}└── ${R}`
      : `${G}├── ${R}`;
  const bullet = isLeaf ? `${GR}●${R}` : `${C}◆${R}`;
  const vpLabel = labelBuffer[vp] === 0 ? `${GR}legit${R}` : `${RED}fraud${R}`;
  console.log(
    `${prefix}${connector}${bullet} ${B}#${nodeIdx}${R}  ${G}vp${R}=${vp}(${vpLabel})  ${Y}μ=${mu.toFixed(
      4,
    )}${R}`,
  );

  const childPrefix =
    prefix +
    (connType === "root" ? "" : connType === "last" ? "    " : `${G}│${R}   `);

  if (depth >= PRINT_DEPTH) {
    if (left >= 0 || right >= 0) console.log(`${childPrefix}${G}└── …${R}`);
    return;
  }

  if (left >= 0)
    printNode(left, depth + 1, childPrefix, right >= 0 ? "mid" : "last");
  if (right >= 0) printNode(right, depth + 1, childPrefix, "last");
}

console.log(`\n\x1b[1mVP-Tree\x1b[0m  \x1b[90m(${nodeCount} nodes)\x1b[0m\n`);

printNode(0);
