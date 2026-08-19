import { type FormEvent, useCallback, useEffect, useState } from "react";

interface Account {
  id: string;
  name: string;
  balance: number;
}

interface Transfer {
  id: string;
  destinationAccount: string;
  amount: number;
  status: string;
  createdAt: string;
}

const headers = { "Content-Type": "application/json", "x-demo-user": "user-a" };
const money = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" });

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [destinationAccount, setDestinationAccount] = useState("0000000001");
  const [amount, setAmount] = useState("10000");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const [accountResponse, transferResponse] = await Promise.all([
      fetch("/api/accounts", { headers }),
      fetch("/api/transfers", { headers }),
    ]);
    setAccounts(await accountResponse.json());
    setTransfers(await transferResponse.json());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("Sending…");
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
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">RelayPay</p>
          <h1>Transfer operations</h1>
          <p className="muted">A deliberately basic screen. Make operational risk visible.</p>
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
          <button type="submit" disabled={!accounts.length}>Send transfer</button>
          <p className="message">{message}</p>
        </form>
      </section>

      <section className="card transfers">
        <div className="section-heading">
          <div>
            <p className="label">Activity</p>
            <h2>Transfers</h2>
          </div>
          <button className="secondary" onClick={() => void refresh()}>Refresh</button>
        </div>
        {transfers.length === 0 ? (
          <p className="empty">No transfers yet.</p>
        ) : (
          <table>
            <thead><tr><th>Destination</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td>{transfer.destinationAccount}</td>
                  <td>{money.format(transfer.amount / 100)}</td>
                  <td><span className={`status ${transfer.status}`}>{transfer.status}</span></td>
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
