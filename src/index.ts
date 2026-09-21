export * from "./core/types.js";
export * from "./core/errors.js";
export { Harness, type HarnessOptions, type DoctorReport } from "./core/harness.js";
export { Session, type SessionOptions, type ActionResult, type ScreenView } from "./core/session.js";
export { Policy, DEFAULT_POLICY, type PolicyConfig, type PolicyMode } from "./core/policy.js";
export { ApprovalStore, approvals, type ApprovalRequest } from "./core/approvals.js";
export { SecretStore, secrets } from "./core/secrets.js";
export { AuditLog, type TraceEvent } from "./core/audit.js";
export {
  finalizeElements, pruneElements, renderElements, resolveSelector,
  matchesSelector, diffSnapshots, hashElements, type RawElement,
} from "./core/elements.js";
export { annotateScreenshot } from "./core/image.js";
export { AndroidProvider, AndroidDevice } from "./providers/android/index.js";
export { IosProvider, IosDevice } from "./providers/ios/index.js";
export { MockProvider, MockDevice } from "./providers/mock/index.js";
export { setLogLevel, logger } from "./core/logger.js";
