import { Hono } from "hono";
import { SERVER_IDENTITY } from "../mcp/identity";

export const health = new Hono();

health.get("/", (c) =>
  c.json({
    status: "ok",
    service: "agentfilings",
    version: SERVER_IDENTITY.version,
    time: new Date().toISOString(),
  }),
);
