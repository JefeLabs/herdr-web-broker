import { CATALOG, GROUPS, type EndpointSpec, type FieldSpec } from "./catalog";
import { RESPONSES } from "./responses";

/** OpenAPI 3.1 document derived from the same catalog that renders the
 * console — importable into Swagger UI, Postman, Insomnia, etc. */

const FIELD_SCHEMA: Record<FieldSpec["kind"], Record<string, unknown>> = {
  text: { type: "string" },
  select: { type: "string" },
  number: { type: "number" },
  json: {},
  toggle: { type: "string", enum: ["1"] },
};

const SECURITY: Record<EndpointSpec["auth"], unknown[]> = {
  none: [],
  bearer: [{ bearerAuth: [] }],
  admin: [{ adminToken: [] }],
};

function pathParamNames(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function toOperation(spec: EndpointSpec): Record<string, unknown> {
  const inPath = new Set(pathParamNames(spec.pathTemplate));
  const wire = spec.fields.filter((f) => !f.uiOnly && !inPath.has(f.key));

  const parameters: Record<string, unknown>[] = pathParamNames(spec.pathTemplate).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

  const op: Record<string, unknown> = {
    operationId: spec.id,
    summary: spec.title,
    description: spec.docs ? `${spec.summary}\n\n${spec.docs}` : spec.summary,
    tags: [spec.group],
    security: SECURITY[spec.auth],
    responses: {
      [spec.id === "spawn" ? "201" : "200"]: {
        description: "Success",
        ...((spec.response ?? RESPONSES[spec.id])
          ? { content: { "application/json": { schema: spec.response ?? RESPONSES[spec.id] } } }
          : {}),
      },
      default: { description: "Error envelope: {code, message, ...details}" },
    },
  };

  if (spec.method === "POST") {
    if (wire.length > 0) {
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                wire.map((f) => [f.key, { ...FIELD_SCHEMA[f.kind], ...(f.help ? { description: f.help } : {}) }]),
              ),
              required: wire.filter((f) => f.required).map((f) => f.key),
            },
          },
        },
      };
    }
  } else {
    for (const f of wire) {
      parameters.push({ name: f.key, in: "query", required: f.required ?? false, schema: FIELD_SCHEMA[f.kind] });
    }
  }
  if (parameters.length > 0) op.parameters = parameters;
  return op;
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const spec of CATALOG) {
    (paths[spec.pathTemplate] ??= {})[spec.method.toLowerCase()] = toOperation(spec);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "herdr-web-broker API",
      version: "0.1.0",
      description:
        "herdr's local socket lifted onto the network — REST + WebSocket, federated parent↔child. " +
        "Instance 'runtime' is the machine the broker runs on; other instances are paired children " +
        "reached over their outbound tunnel. WS /events (not expressible in OpenAPI) carries duplex " +
        "rpc frames {id, instance, session, method, params} and unsolicited {event} pushes.",
    },
    servers: [{ url: "http://127.0.0.1:7591", description: "local broker" }],
    tags: GROUPS.map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "[[client_tokens]] entry from config.toml" },
        adminToken: {
          type: "apiKey",
          in: "header",
          name: "x-admin-token",
          description: "state-dir admin token; loopback connections only",
        },
      },
    },
    paths,
  };
}
