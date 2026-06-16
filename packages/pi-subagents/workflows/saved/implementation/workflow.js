export default async function workflow({ args, agent, checkpoint, progress }) {
  const task = args.task ?? args.issue ?? args.request;
  if (!task) throw new Error("implementation workflow requires input.task, input.issue, or input.request");
  await progress("plan", { task });
  const plan = await agent.run({ agent: "planner", task: `Plan implementation for: ${task}`, context: "fork" });
  await checkpoint("plan", plan);
  await progress("implement", { task });
  const result = await agent.run({ agent: "worker", task, context: "fork" });
  await checkpoint("implementation", result);
  await progress("review", { task });
  const review = await agent.run({ agent: "reviewer", task: `Review this implementation result against the task.\n\nTask:\n${task}\n\nImplementation result:\n${JSON.stringify(result)}`, context: "fork" });
  await checkpoint("review", review);
  return { task, plan, result, review };
}
