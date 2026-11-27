function reject(code) {
  process.stderr.write(`client media cleanup result rejected: ${code}\n`);
  process.exitCode = 1;
}

let raw = "";
process.stdin.setEncoding("utf8");

try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  reject("input_error");
}

if (process.exitCode !== 1) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    reject("invalid_json");
  }

  if (process.exitCode !== 1) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reject("invalid_shape");
    } else if (
      ![
        "claimed",
        "deleted",
        "retained",
        "blocked",
        "failed",
        "recoveryFailed",
        "backlog",
        "backlog_metrics_available",
      ].every((field) => field in value)
    ) {
      reject("missing_counts");
    } else {
      const {
        claimed,
        deleted,
        retained,
        blocked,
        failed,
        recoveryFailed,
        backlog,
        backlog_metrics_available: backlogMetricsAvailable,
      } = value;
      const counts = [claimed, deleted, retained, blocked, failed, recoveryFailed];
      if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
        reject("invalid_counts");
      } else if (claimed !== deleted + retained + blocked + failed) {
        reject("inconsistent_counts");
      } else if (
        backlogMetricsAvailable !== true ||
        !backlog ||
        typeof backlog !== "object" ||
        Array.isArray(backlog)
      ) {
        reject("backlog_unavailable");
      } else if (
        !["client_due", "client_retry_exhausted", "profile_due", "profile_blocked"].every(
          (field) => Number.isSafeInteger(backlog[field]) && backlog[field] >= 0,
        )
      ) {
        reject("invalid_backlog");
      } else if (
        failed > 0 ||
        recoveryFailed > 0 ||
        blocked > 0 ||
        backlog.client_retry_exhausted > 0 ||
        backlog.profile_blocked > 0
      ) {
        reject("partial_failure");
      } else {
        process.stdout.write(
          `client media cleanup accepted: claimed=${claimed} deleted=${deleted} retained=${retained} blocked=${blocked} failed=0 recoveryFailed=0\n`,
        );
      }
    }
  }
}
