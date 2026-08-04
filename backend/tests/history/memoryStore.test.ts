import { MemoryHistoryStore } from "../../src/history/memoryStore.js";
import { runHistoryContract } from "./contractTests.js";

runHistoryContract("memory", async () => new MemoryHistoryStore());
