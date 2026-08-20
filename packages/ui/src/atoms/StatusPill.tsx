export function StatusPill({ status, ok, ms }: { status: number; ok: boolean; ms: number }) {
  return (
    <span className={`status-pill ${ok ? "ok" : "err"}`}>
      {ok ? "▮" : "▯"} {status} · {ms}ms
    </span>
  );
}
