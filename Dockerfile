# Estágio 1: Build e Conversão (Exige mais RAM no seu PC/CI)
FROM node:24-alpine AS builder
WORKDIR /app

# Copia o JSON comprimido e o script de conversão
COPY ./src/files/references.json.gz .
COPY ./src/convert.ts .

# Descomprime o dataset e converte para binário
RUN gunzip references.json.gz && node convert.ts

# Estágio 2: Runtime (Onde os 120MB de limite serão aplicados)
FROM node:24-alpine
WORKDIR /app

# Copia apenas os binários gerados e o código da aplicação
COPY --from=builder /app/vectors.bin .
COPY --from=builder /app/labels.bin .
COPY --from=builder /app/vptree.bin .
COPY ./src/index.ts .
COPY ./src/vector.ts .
COPY ./src/types.ts .
COPY ./src/files/mcc_risk.json ./files/mcc_risk.json
COPY ./src/files/normalization.json ./files/normalization.json

ENV NODE_OPTIONS="--max-old-space-size=96"

LABEL maintainer="João Marcos <joaomarcostomaz70@gmail.com>"
LABEL description="API de Risco de Fraude para a Rinha de Backend 2026"

EXPOSE 3000

CMD ["node", "index.ts"]
