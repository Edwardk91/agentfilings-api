import { serve } from "@hono/node-server";
import { loadEnvFile } from "./load-env";

loadEnvFile(); // must run before the app reads process.env

const { app } = await import("./index");
const { loadEnv } = await import("./env");

const env = loadEnv();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`agentfilings api listening on http://localhost:${info.port}`);
});
