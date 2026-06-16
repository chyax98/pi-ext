export default async function workflow({ args, agent, checkpoint, progress }) {
  const target = args.target ?? args.task ?? "current working tree";
  await progress("scout", { target });
  const context = await agent.run({ agent: "scout", task: `Inspect ${target} and collect evidence for review. Do not edit.`, context: "fork" });
  await checkpoint("context", context);
  await progress("review", { target });
  const review = await agent.run({ agent: "reviewer", task: `Review ${target}. Use this collected context:\n${JSON.stringify(context)}`, context: "fork" });
  await checkpoint("review", review);
  return { target, context, review };
}
