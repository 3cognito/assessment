export type TransferStatus =
  | "pending"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "reversed";

export interface ProviderTransferRequest {
  clientReference: string;
  destinationAccount: string;
  amount: number;
}

export interface ProviderTransferResult {
  providerReference: string;
  status: "accepted" | "rejected";
}

export interface ProviderStatusResult {
  status: "pending" | "succeeded" | "failed";
}

export interface TransferProvider {
  send(request: ProviderTransferRequest): Promise<ProviderTransferResult>;
  getStatus(providerReference: string): Promise<ProviderStatusResult>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
