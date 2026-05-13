interface TransactionData {
  amount: number;
  installments: number;
  requested_at: string;
}

interface CustomerProfile {
  avg_amount: number;
  tx_count_24h: number;
  known_merchants: string[];
}

interface MerchantInfo {
  id: string;
  mcc: string;
  avg_amount: number;
}

interface TerminalStatus {
  is_online: boolean;
  card_present: boolean;
  km_from_home: number;
}

interface LastTransactionContext {
  timestamp: string;
  km_from_current: number;
}

export interface TransactionPayload {
  readonly id: string;
  readonly transaction: TransactionData;
  readonly customer: CustomerProfile;
  readonly merchant: MerchantInfo;
  readonly terminal: TerminalStatus;
  readonly last_transaction: LastTransactionContext | null;
}

export interface FraudScoreResponse {
  approved: boolean;
  fraud_score: number;
}

type amount = number;
type installments = number;
type amount_vs_avg = number;
type hour_of_day = number;
type day_of_week = number;
type minutes_since_last_tx = number;
type km_from_last_tx = number;
type km_from_home = number;
type tx_count_24h = number;
type is_online = 1 | 0;
type card_present = 1 | 0;
type unknown_merchant = 1 | 0;
type mcc_risk = number;
type merchant_avg_amount = number;

export type VectorizedTransaction = [
  amount,
  installments,
  amount_vs_avg,
  hour_of_day,
  day_of_week,
  minutes_since_last_tx,
  km_from_last_tx,
  km_from_home,
  tx_count_24h,
  is_online,
  card_present,
  unknown_merchant,
  mcc_risk,
  merchant_avg_amount,
];
