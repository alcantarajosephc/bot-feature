import type { GhRunner } from "../tickets/github.ts";

/** Stand-in for `gh issue view` in UI tests: every issue is the sample "greet" ticket; #404 doesn't exist. */
export const fakeGh: GhRunner = async (args) => {
  const n = args[2] ?? "1";
  const repo = args[args.indexOf("-R") + 1] ?? "acme/widgets";
  if (n === "404") return { code: 1, stdout: "", stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${n}.` };
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      number: Number(n),
      title: "Add a greet function",
      body: "Users want a greet(name) helper that returns a friendly greeting. Empty names should greet the world.",
      state: "OPEN",
      url: `https://github.com/${repo}/issues/${n}`,
      labels: [{ name: "enhancement" }],
      comments: [],
    }),
  };
};
