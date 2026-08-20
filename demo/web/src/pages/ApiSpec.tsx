import { useMemo, useState } from "react";
import { CATALOG, GROUPS, type EndpointSpec } from "../api/catalog";
import { buildOpenApi } from "../api/openapi";
import { AuthBadge, CopyButton, MethodChip, PathTemplate } from "../components/ui";

const pathParams = (t: string) => [...t.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

export function ApiSpec() {
  const openapi = useMemo(() => JSON.stringify(buildOpenApi(), null, 2), []);
  const [showJson, setShowJson] = useState(false);

  function download() {
    const blob = new Blob([openapi], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "herdr-web-broker.openapi.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <div className="spec-head">
        <h1>API reference</h1>
        <button className="btn ghost" onClick={() => setShowJson(!showJson)}>
          {showJson ? "hide" : "view"} openapi.json
        </button>
        <button className="btn" onClick={download}>
          download openapi 3.1
        </button>
      </div>
      <p className="note" style={{ maxWidth: "48rem" }}>
        Generated from the same catalog that renders the live console, so these docs cannot drift from the demo.
        Import the OpenAPI document into Swagger UI, Postman, or Insomnia for client generation. The WebSocket
        channel (WS /parent/ws) is described in its console card — OpenAPI has no vocabulary for it.
      </p>
      {showJson && (
        <div style={{ marginBottom: "2rem" }}>
          <div className="curl-line">
            <code>herdr-web-broker.openapi.json — {Math.round(openapi.length / 1024)}KB</code>
            <CopyButton text={openapi} />
          </div>
          <pre className="codeview" style={{ maxHeight: "30rem" }}>
            {openapi}
          </pre>
        </div>
      )}
      {GROUPS.map((g) => (
        <section key={g}>
          <h2 className="group-title">{g}</h2>
          {CATALOG.filter((s) => s.group === g).map((s) => (
            <SpecEntry key={s.id} spec={s} />
          ))}
        </section>
      ))}
      <section>
        <h2 className="group-title">Errors</h2>
        <p className="note" style={{ maxWidth: "48rem" }}>
          Every failure is a JSON envelope <code>{"{code, message, …details}"}</code>. Broker codes map to HTTP
          statuses (unauthorized 401, bad_request 400, unknown_* 404, instance_offline 503, upstream_timeout
          504…); unknown codes are herdr passthrough errors and answer 502. Partial-failure details carry
          recovery handles — a failed spawn returns the created workspace_id so a retry can join it instead of
          leaking it.
        </p>
      </section>
    </div>
  );
}

function SpecEntry({ spec }: { spec: EndpointSpec }) {
  const inPath = new Set(pathParams(spec.pathTemplate));
  const wire = spec.fields.filter((f) => !f.uiOnly && !inPath.has(f.key));
  const rows = [
    ...pathParams(spec.pathTemplate).map((name) => ({ name, where: "path", kind: "string", required: true })),
    ...wire.map((f) => ({
      name: f.key,
      where: spec.method === "POST" ? "body" : "query",
      kind: f.kind === "json" ? "json" : f.kind === "number" ? "number" : f.kind === "toggle" ? "flag (1)" : "string",
      required: f.required ?? false,
    })),
  ];
  return (
    <article className="spec-entry" id={`spec-${spec.id}`}>
      <header>
        <MethodChip method={spec.method} />
        <PathTemplate template={spec.pathTemplate} />
        <span className="spacer" />
        <AuthBadge auth={spec.auth} />
      </header>
      <div className="body">
        <p>{spec.summary}</p>
        {spec.docs && <p>{spec.docs}</p>}
        {rows.length > 0 && (
          <table className="param-table">
            <thead>
              <tr>
                <th>param</th>
                <th>in</th>
                <th>type</th>
                <th>required</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.where}-${r.name}`}>
                  <td>{r.name}</td>
                  <td className={r.where === "path" ? "in-path" : ""}>{r.where}</td>
                  <td>{r.kind}</td>
                  <td>{r.required ? "yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </article>
  );
}
