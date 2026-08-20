import { describe, expect, test } from "vitest";
import { buildOpenApi } from "./openapi";

const doc = buildOpenApi();
type Op = {
  operationId: string;
  tags: string[];
  security: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } };
};
const paths = doc.paths as Record<string, Record<string, Op>>;

describe("buildOpenApi", () => {
  test("is an OpenAPI 3.1 document with both security schemes", () => {
    expect(doc.openapi.startsWith("3.1")).toBe(true);
    const schemes = doc.components.securitySchemes as Record<string, { type: string }>;
    expect(schemes.bearerAuth.type).toBe("http");
    expect(schemes.adminToken.type).toBe("apiKey");
  });

  test("agents path carries GET and POST (list + spawn)", () => {
    const p = paths["/parent/{instance}/sessions/{session}/agents"];
    expect(p.get.operationId).toBe("agents");
    expect(p.post.operationId).toBe("spawn");
  });

  test("path placeholders become required path parameters", () => {
    const params = paths["/parent/{instance}/sessions/{session}/agents"].get.parameters ?? [];
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.instance.in).toBe("path");
    expect(byName.instance.required).toBe(true);
    expect(byName.session.in).toBe("path");
  });

  test("non-path GET fields become query parameters", () => {
    const params = paths["/parent/{instance}/sessions/{session}/agents"].get.parameters ?? [];
    expect(params.some((p) => p.name === "fresh" && p.in === "query")).toBe(true);
  });

  test("POST fields become requestBody properties; UI-only fields are excluded", () => {
    const props = paths["/parent/{instance}/sessions/{session}/agents"].post.requestBody?.content[
      "application/json"
    ].schema.properties;
    expect(props).toBeDefined();
    expect(Object.keys(props!)).toContain("kind");
    expect(Object.keys(props!)).toContain("cwd");
    expect(Object.keys(props!)).toContain("workspace_id");
    expect(Object.keys(props!)).not.toContain("target_mode");
  });

  test("auth maps to security: none is open, admin uses adminToken", () => {
    expect(paths["/health"].get.security).toEqual([]);
    expect(paths["/admin/status"].get.security).toEqual([{ adminToken: [] }]);
    expect(paths["/parent"].get.security).toEqual([{ bearerAuth: [] }]);
  });

  test("env delete: name is a path param, scopes are query params", () => {
    const params = paths["/parent/{instance}/env/{name}"].delete.parameters ?? [];
    const byName = Object.fromEntries(params.map((p) => [p.name, p.in]));
    expect(byName.name).toBe("path");
    expect(byName.kind).toBe("query");
    expect(byName.session).toBe("query");
  });

  test("every catalog entry appears exactly once as an operation", () => {
    const ids = Object.values(paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(38);
  });

  test("endpoints with declared response schemas surface them for codegen", () => {
    const spawn = paths["/parent/{instance}/sessions/{session}/agents"].post as Op & {
      responses: Record<string, { content?: { "application/json": { schema: { properties: Record<string, { type?: string }> } } } }>;
    };
    const schema = spawn.responses["201"].content?.["application/json"].schema;
    expect(schema).toBeDefined();
    expect(schema!.properties.agent.type).toBe("string");
    expect(Object.keys(schema!.properties)).toEqual(
      expect.arrayContaining(["workspace_id", "pane_id", "agent", "status"]),
    );
  });
});
