import { Hono } from "hono";

export const health = new Hono();

health.get("/", (c) =>
  c.json({
    status: "ok",
    service: "agentfilings",
    version: "0.0.0",
    time: new Date().toISOString(),
  }),
);
