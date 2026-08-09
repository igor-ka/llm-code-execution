import { MemoryQuotaStore } from "../../src/limits/memoryQuota.js";
import { quotaContract } from "./quotaContract.js";

quotaContract("MemoryQuotaStore", async () => new MemoryQuotaStore());
