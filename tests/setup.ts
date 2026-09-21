import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests out of the real ~/.agent-phone.
process.env.PHONE_HOME = mkdtempSync(join(tmpdir(), "agent-phone-test-"));
process.env.PHONE_LOG_LEVEL = "silent";
