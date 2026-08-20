export function MethodChip({ method }: { method: string }) {
  return <span className={`chip ${method.toLowerCase()}`}>{method}</span>;
}

export function AuthBadge({ auth }: { auth: "bearer" | "admin" | "none" }) {
  if (auth === "none") return <span className="chip auth">open</span>;
  if (auth === "admin") return <span className="chip auth admin">admin · loopback</span>;
  return <span className="chip auth">bearer</span>;
}
