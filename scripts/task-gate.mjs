const taskId = process.argv[2];

if (!taskId) {
  console.error('[TASK_GATE_INVALID] Missing task ID.');
  process.exit(2);
}

console.error(
  `[TASK_NOT_IMPLEMENTED] ${taskId} has not replaced its acceptance-test gate with a real command.`,
);
process.exit(1);
