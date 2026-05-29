export type SourceType = "onchain" | "exchange" | "custom";

export interface Account {
  id: string;
  name: string;
  source: SourceType;
  addr: string;
  group: string;
  bal: number;
  d: number;
  chain?: string | null;
  pnl?: number | null;
  note?: string | null;
}

export type PriceSource = "custom" | "api";

export interface CustomAssetInput {
  symbol: string;
  amount: number;
  unit_price: number;
  name?: string | null;
  price_source?: PriceSource;
}

export interface AccountInput {
  name: string;
  source: SourceType;
  addr: string;
  group: string;
  chain?: string | null;
  note?: string | null;
  custom_assets?: CustomAssetInput[] | null;
}

export interface Holding {
  kind: "tok" | "pos";
  sym: string;
  name: string;
  proto: string;
  chain: string;
  amt: string;
  price: string;
  usd: number;
  d: number;
  c: string;
  apr?: string | null;
  logo?: string | null;
  proto_logo?: string | null;
  amt_raw?: number | null;
  price_raw?: number | null;
  price_source?: PriceSource | null;
  excluded?: boolean;
  key?: string | null;
}

export interface AccountDetail extends Account {
  holdings: Holding[];
  synced_at?: string | null;
  provider?: string | null;
  excluded_keys?: string[];
}

export interface Group {
  name: string;
  bal: number;
  d: number;
  accounts: number;
  color: string;
}

export interface TopAsset {
  sym: string;
  name: string;
  bal: number;
  pct: number;
  chains: number;
  chg: number;
}

export interface DashboardSummary {
  total: number;
  change_24h_usd: number;
  change_24h_pct: number;
  change_7d_pct: number;
  change_30d_pct: number;
  change_ytd_pct: number;
  change_1h_pct: number;
  accounts_count: number;
  sources_breakdown: Record<string, number>;
  last_sync_at?: string | null;
}

export interface BalancePoint {
  t: string;
  v: number;
}
export interface BalanceHistory {
  total: BalancePoint[];
  by_source: Record<string, BalancePoint[]>;
  per_account: Record<string, BalancePoint[]>;
  by_wallet: Record<string, BalancePoint[]>;
  by_group: Record<string, BalancePoint[]>;
  by_asset: Record<string, BalancePoint[]>;
}

export interface CashflowSummary {
  inflows_30d: number;
  outflows_30d: number;
  net_30d: number;
  pending: number;
}

export type SyncStatus = "ok" | "skipped" | "error";

export interface SyncResult {
  account_id: string;
  name: string;
  source: SourceType;
  status: SyncStatus;
  balance?: number | null;
  message?: string | null;
}

export interface SyncSummary {
  results: SyncResult[];
  total: number;
  ok_count: number;
  skipped_count: number;
  error_count: number;
}

export interface SyncEstimate {
  accounts_count: number;
  remote_accounts: number;
}

export interface CexCredentialInput {
  exchange: string;
  api_key: string;
  api_secret: string;
  passphrase: string;
  wallet_address: string;
}

export interface CexCredentialStatus {
  account_id: string;
  account_name: string;
  exchange: string;
  has_api_key: boolean;
  has_api_secret: boolean;
  has_passphrase: boolean;
  has_wallet_address: boolean;
}

export interface CredentialsStatus {
  cex: CexCredentialStatus[];
}

export interface AutoSyncSettings {
  enabled: boolean;
  timezone: string;
  local_time: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status: string;
  last_error?: string | null;
}

export interface AutoSyncSettingsInput {
  enabled: boolean;
  timezone: string;
  local_time: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
}
