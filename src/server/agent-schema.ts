// Native OpenAPI document; no SDK or documentation runtime dependency.
const fields = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  notes: { type: "string", maxLength: 10000 },
  kind: { type: "string", enum: ["undated", "all_day", "timed"] },
  start: {
    type: ["string", "null"],
    description:
      "undated: null; all_day: YYYY-MM-DD; timed: canonical UTC ISO string, e.g. 2026-09-09T15:00:00.000Z",
  },
  end: {
    type: ["string", "null"],
    description:
      "Exclusive end. For all_day, the day after the final displayed date. Must be after start, duration <=366 days.",
  },
  public: {
    type: "boolean",
    description:
      "If true, visitors holding the share link can read title, notes, dates and completion.",
  },
  done: {
    type: "boolean",
    description: "Per-occurrence only for repeating items.",
  },
  reminder: {
    type: ["integer", "null"],
    minimum: -1439,
    maximum: 10080,
    description:
      "Minutes before start; null disables. All-day 09:00 KST is -540.",
  },
  rule: { anyOf: [{ type: "null" }, { $ref: "#/components/schemas/Rule" }] },
};
const id = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const idempotency = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
  description:
    "Use a new key for each intended mutation; retry the same request with the same key. Replay window: 7 days.",
};
const body = (schema: object) => ({
  required: true,
  content: { "application/json": { schema } },
});
const json = (schema: object, description = "Success") => ({
  description,
  content: { "application/json": { schema } },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 500].map((code) => [
    String(code),
    json({ $ref: "#/components/schemas/Error" }, String(code)),
  ]),
);
const identity = {
  key: {
    type: "string",
    description:
      "Use the occurrence key from list results (Korean original date for recurrence, single otherwise).",
  },
  version: { type: "integer", minimum: 1 },
  scope: { type: "string", enum: ["one", "future", "all"] },
};
export function agentSchema(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "하루의 계획 Agent API",
      version: "1.0.0",
      description:
        "Bearer API for the owner’s private calendar. Not an OAuth authorization server. Keys are issued and revoked through the owner-session /api/agent-keys endpoints.",
    },
    servers: [{ url: `${origin}/api/agent/v1` }],
    security: [{ agentBearer: [] }],
    paths: {
      "/me": {
        get: {
          operationId: "getAgentIdentity",
          description: "items:read. Inspect key scope and expiration.",
          responses: { ...errors, "200": json({ type: "object" }) },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getAgentSchema",
          responses: { ...errors, "200": json({ type: "object" }) },
        },
      },
      "/items": {
        get: {
          operationId: "listOccurrences",
          description:
            "items:read. Includes private entries and undated items. Range is [from,to), at most 100 days. Pagination is not a frozen snapshot; re-list after changes.",
          parameters: [
            {
              name: "from",
              in: "query",
              required: true,
              schema: { type: "string", format: "date" },
            },
            {
              name: "to",
              in: "query",
              required: true,
              schema: { type: "string", format: "date" },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 500,
                default: 100,
              },
            },
            {
              name: "offset",
              in: "query",
              schema: {
                type: "integer",
                minimum: 0,
                maximum: 1000000,
                default: 0,
              },
            },
          ],
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Occurrence" },
                },
                total: { type: "integer" },
                nextOffset: { type: ["integer", "null"] },
                timezone: { const: "Asia/Seoul" },
              },
            }),
          },
        },
        post: {
          operationId: "createItem",
          description:
            "items:write. All fields required; default private, incomplete; recurring items cannot be created complete.",
          parameters: [idempotency],
          requestBody: body({ $ref: "#/components/schemas/Fields" }),
          responses: {
            ...errors,
            "201": json({
              type: "object",
              properties: { item: { $ref: "#/components/schemas/Item" } },
            }),
          },
        },
      },
      "/items/{id}": {
        get: {
          operationId: "getSeries",
          description:
            "items:read. Returns the base series; use listOccurrences for effective per-occurrence values.",
          parameters: [id],
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: { item: { $ref: "#/components/schemas/Item" } },
            }),
          },
        },
        patch: {
          operationId: "updateItem",
          description:
            "items:write. Required version is shared by a series; HTTP 409 means re-read before editing. A future split may create new series IDs: re-list afterward. rule cannot change with scope=one on a repeating item.",
          parameters: [id, idempotency],
          requestBody: body({
            type: "object",
            additionalProperties: false,
            required: ["key", "version", "scope", "changes"],
            properties: {
              ...identity,
              changes: {
                type: "object",
                minProperties: 1,
                additionalProperties: false,
                properties: fields,
              },
            },
          }),
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: {
                item: { $ref: "#/components/schemas/Item" },
                refreshRequired: { const: true },
              },
            }),
          },
        },
        delete: {
          operationId: "trashItem",
          description:
            "items:delete. Soft delete, recoverable for 30 days. Scope is mandatory.",
          parameters: [id, idempotency],
          requestBody: body({
            type: "object",
            additionalProperties: false,
            required: ["key", "version", "scope"],
            properties: identity,
          }),
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: {
                ok: { const: true },
                refreshRequired: { const: true },
              },
            }),
          },
        },
      },
      "/trash": {
        get: {
          operationId: "listTrash",
          description: "items:read. Includes private deleted-item titles.",
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      deleted_at: {
                        type: "integer",
                        description: "Unix milliseconds",
                      },
                    },
                  },
                },
              },
            }),
          },
        },
      },
      "/trash/{id}/restore": {
        post: {
          operationId: "restoreItem",
          description:
            "items:write. Restore without overwriting unrelated changes. Resolve dependencies first on HTTP 409.",
          parameters: [id, idempotency],
          requestBody: body({ type: "object", additionalProperties: false }),
          responses: {
            ...errors,
            "200": json({
              type: "object",
              properties: { ok: { const: true } },
            }),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        agentBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "plan_agent_<secret>",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        Fields: {
          type: "object",
          required: Object.keys(fields),
          properties: fields,
        },
        Rule: {
          type: "object",
          required: [
            "frequency",
            "interval",
            "weekdays",
            "monthly",
            "day",
            "ordinal",
            "weekday",
            "until",
          ],
          properties: {
            frequency: { enum: ["daily", "weekly", "monthly"] },
            interval: { type: "integer", minimum: 1, maximum: 99 },
            weekdays: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 6 },
              description: "Monday=0; weekly must be nonempty.",
            },
            monthly: { enum: ["date", "last_day", "nth_weekday"] },
            day: { type: "integer", minimum: 1, maximum: 31 },
            ordinal: {
              enum: [-1, 1, 2, 3, 4, 5],
              description:
                "-1: last weekday; nonexistent dates/ordinals skip the month.",
            },
            weekday: { type: "integer", minimum: 0, maximum: 6 },
            until: {
              type: ["string", "null"],
              format: "date",
              description: "Inclusive Korean date.",
            },
          },
        },
        Item: {
          type: "object",
          properties: {
            ...fields,
            id: { type: "string" },
            version: { type: "integer" },
            deletedAt: { type: ["string", "null"] },
            cutoff: { type: ["string", "null"] },
          },
        },
        Occurrence: {
          type: "object",
          properties: {
            ...fields,
            id: { type: "string" },
            itemId: { type: "string" },
            key: { type: "string" },
            version: { type: "integer" },
            recurring: { type: "boolean" },
            seriesStart: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}
