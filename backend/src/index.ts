import { createApp } from "./server.js";

const PORT = 8000;
createApp().listen(PORT, "0.0.0.0", () => {
  console.log(`llm-code-execution backend listening on :${PORT}`);
});
