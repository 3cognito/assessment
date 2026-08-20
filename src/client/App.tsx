import { type FormEvent, useCallback, useEffect, useState } from "react";

type TransferStatus = "pending" | "uncertain" | "succeeded" | "failed" | "reversed";
type StatusFilter = "all" | TransferStatus;

interface Account {
  id: string;
  name: string;
  balance: number;
}

interface Transfer {
  id: string;
  destinationAccount: string;
  amount: number;
  status: TransferStatus;
  providerReference?: string | null;
  failureReason?: string | null;
  createdAt: string;
}

const statuses: TransferStatus[] = ["pending", "uncertain", "succeeded", "failed", "reversed"];
const headers = { "Content-Type": "application/json", "x-demo-user": "user-a" };
const money = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" });

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [destinationAccount, setDestinationAccount] = useState("0000000001");
  const [amount, setAmount] = useState("10000");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const transferPath =
        statusFilter === "all" ? "/api/transfers" : `/api/transfers?status=${statusFilter}`;
      const [accountResponse, transferResponse] = await Promise.all([
        fetch("/api/accounts", { headers }),
        fetch(transferPath, { headers }),
      ]);

      if (!accountResponse.ok || !transferResponse.ok) {
        throw new Error("Unable to load operations data");
      }

      setAccounts(await accountResponse.json());
      setTransfers(await transferResponse.json());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load operations data");
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("Sending…");
    setError("");

    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          debitAccountId: accounts[0]?.id,
          destinationAccount,
          amount: Number(amount),
        }),
      });
      const result = await response.json();
      setMessage(response.ok ? `Created ${result.id}` : result.error ?? "Request failed");
      await refresh();
    } catch (submitError) {
      setMessage("");
      setError(submitError instanceof Error ? submitError.message : "Transfer request failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  const statusCounts = statuses.map((status) => ({
    status,
    count: transfers.filter((transfer) => transfer.status === status).length,
  }));
  const needsReconciliation = transfers.filter((transfer) => transfer.status === "uncertain").length;

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">RelayPay</p>
          <h1>Transfer operations</h1>
        </div>
        <span className="environment">Local sandbox</span>
      </header>

      <section className="grid">
        <article className="card balance">
          <p className="label">Available balance</p>
          <strong>{money.format((accounts[0]?.balance ?? 0) / 100)}</strong>
          <p className="muted">{accounts[0]?.id ?? "Loading account…"}</p>
        </article>

        <form className="card" onSubmit={submit}>
          <h2>New transfer</h2>
          <label>
            Destination account
            <input value={destinationAccount} onChange={(event) => setDestinationAccount(event.target.value)} />
          </label>
          <label>
            Amount in minor units
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
          </label>
          <button type="submit" disabled={!accounts.length || isSubmitting}>
            {isSubmitting ? "Sending" : "Send transfer"}
          </button>
          <p className="message">{message}</p>
        </form>
      </section>

      <section className="summary" aria-label="Transfer status summary">
        {statusCounts.map(({ status, count }) => (
          <div className="metric" key={status}>
            <span className={`status-dot ${status}`} />
            <span>{status}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </section>

      <section className="card transfers">
        <div className="section-heading">
          <div>
            <p className="label">Activity</p>
              <h2>Transfers</h2>
          </div>
          <div className="toolbar">
            <label className="filter">
              Status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">All</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
            <button className="secondary" onClick={() => void refresh()} disabled={isLoading}>
              {isLoading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {needsReconciliation > 0 ? (
          <p className="notice">{needsReconciliation} transfer{needsReconciliation === 1 ? "" : "s"} need reconciliation.</p>
        ) : null}
        {isLoading ? (
          <p className="empty">Loading transfers…</p>
        ) : transfers.length === 0 ? (
          <p className="empty">No transfers yet.</p>
        ) : (
          <table>
            <thead><tr><th>Destination</th><th>Amount</th><th>Status</th><th>Provider</th><th>Created</th></tr></thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td>{transfer.destinationAccount}</td>
                  <td>{money.format(transfer.amount / 100)}</td>
                  <td>
                    <span className={`status ${transfer.status}`}>{transfer.status}</span>
                    {transfer.status === "uncertain" ? <span className="reconcile">Reconcile</span> : null}
                  </td>
                  <td>{transfer.providerReference ?? transfer.failureReason ?? "—"}</td>
                  <td>{new Date(transfer.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
