import { FlightRecorder } from "../src/index.js";

const recorder = new FlightRecorder();
try {
  await recorder.run({ name: "support-agent", attributes: { model: "example-model" } }, async (run) => {
    await run.event("request.received", { ticketId: "T-1042" });
    await run.tool("lookup_customer", async () => ({ customer: "Ada Lovelace" }), { attributes: { source: "local-fixture" } });
    await run.tool("fetch_order", async () => {
      throw new Error("Order service returned HTTP 503");
    }, { attributes: { endpoint: "https://orders.example.test" } });
  });
} catch {
  console.log("The sample agent failed as expected. Inspect it with: npx afr list");
}
