import { useState } from "react";
import { send, toCurl, type BrokerResult, type EndpointRequest } from "../api/client";
import type { EndpointSpec } from "../api/catalog";
import { useSettings } from "../settings";
import { AuthBadge, CopyButton, JsonView, MethodChip, PathTemplate, StatusPill } from "@jefelabs/herdr-broker-ui";

export const BROKER_ORIGIN = import.meta.env.VITE_BROKER_TARGET ?? "http://127.0.0.1:7591";

export function EndpointCard({ spec }: { spec: EndpointSpec }) {
  const settings = useSettings();
  const [values, setValues] = useState<Record<string, string>>({});
  const [built, setBuilt] = useState<EndpointRequest | null>(null);
  const [result, setResult] = useState<BrokerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ctx = { instance: settings.instance, session: settings.session };
  const tokens = { bearer: settings.bearer, admin: settings.admin };

  async function run() {
    setError(null);
    setResult(null);
    let req: EndpointRequest;
    try {
      req = spec.build(values, ctx);
    } catch (e) {
      setBuilt(null);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBuilt(req);
    setBusy(true);
    try {
      setResult(await send(req, tokens));
    } catch (e) {
      setError(`network error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const curl = built ? toCurl(built, tokens, BROKER_ORIGIN) : null;

  return (
    <article className="card" id={spec.id}>
      <div className="card-head">
        <MethodChip method={spec.method} />
        <PathTemplate template={spec.pathTemplate} />
        <span className="spacer" />
        <AuthBadge auth={spec.auth} />
      </div>
      <div className="card-body">
        <p className="card-summary">{spec.summary}</p>
        {spec.fields.length > 0 && (
          <div className="field-grid">
            {spec.fields.map((f) => (
              <Field
                key={f.key}
                spec={f}
                value={values[f.key] ?? ""}
                onChange={(v) => setValues((old) => ({ ...old, [f.key]: v }))}
              />
            ))}
          </div>
        )}
        <div className="card-actions">
          <button className="btn" disabled={busy} onClick={() => void run()}>
            {busy ? "…" : "send"}
          </button>
          {result && <StatusPill status={result.status} ok={result.ok} ms={result.ms} />}
          {error && <span className="card-error">{error}</span>}
        </div>
        {curl && (
          <div className="curl-line">
            <code>{curl}</code>
            <CopyButton text={curl} />
          </div>
        )}
        {result && <JsonView value={result.body} />}
      </div>
    </article>
  );
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: EndpointSpec["fields"][number];
  value: string;
  onChange: (v: string) => void;
}) {
  if (spec.kind === "toggle") {
    return (
      <label className="check">
        <input type="checkbox" checked={value === "1"} onChange={(e) => onChange(e.target.checked ? "1" : "")} />
        {spec.label}
      </label>
    );
  }
  if (spec.kind === "select") {
    return (
      <label className="field">
        <span>{spec.label}</span>
        <select value={value || (spec.options?.[0] ?? "")} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span>
        {spec.label} {spec.required && <b className="req">*</b>}
      </span>
      <input
        type="text"
        value={value}
        placeholder={spec.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
