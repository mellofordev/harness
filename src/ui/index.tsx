import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentInfo, AgentProvider, HarnessConfig, Plan, Task } from "../core/types";
import { executePrompt, type PreparedPromptRun } from "../core/prompt-runner";
import { REGISTRY } from "../agents";
import { HARNESS_VERSION } from "../core/version";

type RunMode = "normal" | "plan";
type RunPhase = "idle" | "running" | "done" | "error";
const SPINNER_FRAMES = ["·", "•", "◦", "•"];

interface DashboardState {
  agents: AgentInfo[];
  tasks: Task[];
  plans: Plan[];
}

interface TranscriptEntry {
  id: string;
  kind: "user" | "system" | "assistant";
  text: string;
  tone?: "default" | "success" | "warn" | "error" | "muted";
}

interface SlashCommand {
  name: string;
  description: string;
  action: (ctx: SlashCommandContext) => void;
}

interface SlashCommandContext {
  exit: ReturnType<typeof useApp>["exit"];
  setMode: React.Dispatch<React.SetStateAction<RunMode>>;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  setPhase: React.Dispatch<React.SetStateAction<RunPhase>>;
  setPrepared: React.Dispatch<React.SetStateAction<PreparedPromptRun | null>>;
  setResults: React.Dispatch<React.SetStateAction<Array<Record<string, unknown>>>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>;
  setAvailability: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setPreferredLeadProvider: React.Dispatch<React.SetStateAction<AgentProvider | null>>;
  setSelectedWorkerProviders: React.Dispatch<React.SetStateAction<AgentProvider[] | null>>;
  dashboard: DashboardState;
  availability: Record<string, boolean>;
  preferredLeadProvider: AgentProvider | null;
  selectedWorkerProviders: AgentProvider[] | null;
  commandArgs: string[];
}

function HarnessApp({ config }: { config: HarnessConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RunMode>("normal");
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [prepared, setPrepared] = useState<PreparedPromptRun | null>(null);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [preferredLeadProvider, setPreferredLeadProvider] = useState<AgentProvider | null>(null);
  const [selectedWorkerProviders, setSelectedWorkerProviders] = useState<AgentProvider[] | null>(null);
  const [dashboard, setDashboard] = useState<DashboardState>({ agents: [], tasks: [], plans: [] });
  const dashboardSignatureRef = useRef("");
  const reportSnapshotRef = useRef<{ taskStates: Map<string, string>; agentStates: Map<string, string> }>({
    taskStates: new Map(),
    agentStates: new Map(),
  });
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [liveReport, setLiveReport] = useState<string | null>(null);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    {
      id: "welcome",
      kind: "assistant",
      tone: "muted",
      text:
        "Harness is ready. Type a feature request, issue, or @file reference. Use /help for commands.",
    },
  ]);

  useEffect(() => {
    REGISTRY.checkAll().then(setAvailability).catch(() => setAvailability({}));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const baseDir = join(resolve(config.workDir), config.harnessDir);
      const nextDashboard = {
        agents: readJsonDir<AgentInfo>(join(baseDir, "agents")),
        tasks: readJsonDir<Task>(join(baseDir, "tasks")),
        plans: readJsonDir<Plan>(join(baseDir, "plans")),
      };
      const nextSignature = JSON.stringify({
        agents: nextDashboard.agents.map((agent) => [agent.id, agent.status, agent.lastHeartbeat]),
        tasks: nextDashboard.tasks.map((task) => [task.id, task.status, task.assignedTo]),
        plans: nextDashboard.plans.map((plan) => [plan.id, plan.status, plan.updatedAt]),
      });

      if (nextSignature !== dashboardSignatureRef.current) {
        dashboardSignatureRef.current = nextSignature;
        setDashboard(nextDashboard);
      }
    }, phase === "running" ? 400 : 1500);

    return () => clearInterval(interval);
  }, [config.harnessDir, config.workDir, phase]);

  useEffect(() => {
    if (phase !== "running") {
      setLiveReport(null);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerIndex((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 120);

    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "running") {
      reportSnapshotRef.current = {
        taskStates: new Map(dashboard.tasks.map((task) => [task.id, task.status])),
        agentStates: new Map(dashboard.agents.map((agent) => [agent.id, agent.status])),
      };
      return;
    }

    const nextTaskStates = new Map(dashboard.tasks.map((task) => [task.id, task.status]));
    const nextAgentStates = new Map(dashboard.agents.map((agent) => [agent.id, agent.status]));
    const previous = reportSnapshotRef.current;
    const events: Array<Omit<TranscriptEntry, "id">> = [];

    for (const task of dashboard.tasks) {
      const prevStatus = previous.taskStates.get(task.id);
      if (!prevStatus || prevStatus === task.status) continue;

      if (task.status === "assigned" || task.status === "in_progress") {
        events.push({
          kind: "assistant",
          tone: "muted",
          text: `Working on: ${task.title}`,
        });
      } else if (task.status === "completed") {
        events.push({
          kind: "assistant",
          tone: "success",
          text: `Completed: ${task.title}`,
        });
      } else if (task.status === "failed") {
        events.push({
          kind: "assistant",
          tone: "error",
          text: `Failed: ${task.title}`,
        });
      }
    }

    for (const agent of dashboard.agents) {
      const prevStatus = previous.agentStates.get(agent.id);
      if (!prevStatus || prevStatus === agent.status) continue;

      if (agent.status === "busy") {
        events.push({
          kind: "system",
          tone: "muted",
          text: `${agent.provider} is active`,
        });
      } else if (prevStatus === "busy" && agent.status === "idle") {
        events.push({
          kind: "system",
          tone: "muted",
          text: `${agent.provider} is idle`,
        });
      }
    }

    if (events.length > 0) {
      setTranscript((current) => [...current, ...events.map((event) => ({ ...event, id: createId() }))].slice(-30));
    }

    const activeTasks = dashboard.tasks.filter(
      (task) => task.status === "assigned" || task.status === "in_progress"
    );
    const completed = dashboard.tasks.filter((task) => task.status === "completed").length;
    const total = dashboard.tasks.length;
    const activePlan = dashboard.plans.find((plan) => plan.status === "active") || dashboard.plans.at(-1);

    if (activePlan || total > 0) {
      const currentTask = activeTasks[0]?.title;
      setLiveReport(
        `${SPINNER_FRAMES[spinnerIndex]} ${activePlan?.title || "Orchestrating"} · ${completed}/${total} completed` +
          (currentTask ? ` · ${currentTask}` : "")
      );
    } else {
      setLiveReport(`${SPINNER_FRAMES[spinnerIndex]} Orchestrating`);
    }

    reportSnapshotRef.current = {
      taskStates: nextTaskStates,
      agentStates: nextAgentStates,
    };
  }, [dashboard, phase, spinnerIndex]);

  const commands = useMemo<SlashCommand[]>(
    () => [
      {
        name: "/exit",
        description: "Leave the interactive Harness shell",
        action: (ctx) => ctx.exit(),
      },
      {
        name: "/help",
        description: "Show available slash commands",
        action: (ctx) => {
          ctx.setStatus("Showing slash commands");
          appendTranscript(ctx.setTranscript, {
            kind: "assistant",
            tone: "muted",
            text:
              "Commands: /exit, /help, /planner, /workers, /plan, /normal, /clear, /status, /discover, /watch, /agents, /version",
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/planner",
        description: "Show or set the planner, e.g. /planner codex",
        action: (ctx) => {
          const nextPlanner = ctx.commandArgs[0] as AgentProvider | undefined;

          if (!nextPlanner) {
            appendTranscript(ctx.setTranscript, {
              kind: "assistant",
              tone: "muted",
              text: `Planner: ${ctx.preferredLeadProvider ?? "auto"}`,
            });
            ctx.setStatus("Printed planner selection");
            ctx.setPrompt("");
            return;
          }

          if (!(nextPlanner in ctx.availability)) {
            appendTranscript(ctx.setTranscript, {
              kind: "assistant",
              tone: "warn",
              text: `Unknown provider: ${nextPlanner}`,
            });
            ctx.setStatus(`Unknown provider: ${nextPlanner}`);
            ctx.setPrompt("");
            return;
          }

          ctx.setPreferredLeadProvider(nextPlanner);
          appendTranscript(ctx.setTranscript, {
            kind: "system",
            tone: "success",
            text: `Planner set to ${nextPlanner}`,
          });
          ctx.setStatus(`Planner set to ${nextPlanner}`);
          ctx.setPrompt("");
        },
      },
      {
        name: "/workers",
        description: "Show or set workers, e.g. /workers claude-code,codex",
        action: (ctx) => {
          const raw = ctx.commandArgs[0];

          if (!raw) {
            appendTranscript(ctx.setTranscript, {
              kind: "assistant",
              tone: "muted",
              text: `Workers: ${ctx.selectedWorkerProviders?.join(", ") ?? "auto"}`,
            });
            ctx.setStatus("Printed worker selection");
            ctx.setPrompt("");
            return;
          }

          if (raw === "auto") {
            ctx.setSelectedWorkerProviders(null);
            appendTranscript(ctx.setTranscript, {
              kind: "system",
              tone: "success",
              text: "Workers reset to auto",
            });
            ctx.setStatus("Workers reset to auto");
            ctx.setPrompt("");
            return;
          }

          const requestedWorkers = raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean) as AgentProvider[];

          const unknownWorkers = requestedWorkers.filter((provider) => !(provider in ctx.availability));
          if (unknownWorkers.length > 0) {
            appendTranscript(ctx.setTranscript, {
              kind: "assistant",
              tone: "warn",
              text: `Unknown provider(s): ${unknownWorkers.join(", ")}`,
            });
            ctx.setStatus(`Unknown provider(s): ${unknownWorkers.join(", ")}`);
            ctx.setPrompt("");
            return;
          }

          ctx.setSelectedWorkerProviders(requestedWorkers);
          appendTranscript(ctx.setTranscript, {
            kind: "system",
            tone: "success",
            text: `Workers set to ${requestedWorkers.join(", ")}`,
          });
          ctx.setStatus(`Workers set to ${requestedWorkers.join(", ")}`);
          ctx.setPrompt("");
        },
      },
      {
        name: "/plan",
        description: "Switch the shell to review-first plan mode",
        action: (ctx) => {
          ctx.setMode("plan");
          ctx.setStatus("Mode switched to plan");
          appendTranscript(ctx.setTranscript, {
            kind: "system",
            tone: "success",
            text: "Mode switched to plan",
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/normal",
        description: "Switch the shell to immediate execution mode",
        action: (ctx) => {
          ctx.setMode("normal");
          ctx.setStatus("Mode switched to normal");
          appendTranscript(ctx.setTranscript, {
            kind: "system",
            tone: "success",
            text: "Mode switched to normal",
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/discover",
        description: "Refresh local CLI detection and print available providers",
        action: (ctx) => {
          ctx.setStatus("Refreshing provider discovery");
          void REGISTRY.checkAll()
            .then((nextAvailability) => {
              ctx.setAvailability(nextAvailability);
              const available = Object.entries(nextAvailability)
                .filter(([, value]) => value)
                .map(([provider]) => provider);
              appendTranscript(ctx.setTranscript, {
                kind: "assistant",
                tone: "muted",
                text:
                  available.length > 0
                    ? `Available CLIs: ${available.join(", ")}`
                    : "No supported CLIs detected on PATH.",
              });
              ctx.setStatus("Provider discovery refreshed");
            })
            .catch((discoverError) => {
              const message =
                discoverError instanceof Error ? discoverError.message : String(discoverError);
              ctx.setError(message);
              ctx.setStatus("Discovery failed");
              appendTranscript(ctx.setTranscript, {
                kind: "assistant",
                tone: "error",
                text: message,
              });
            });
          ctx.setPrompt("");
        },
      },
      {
        name: "/watch",
        description: "Print the current plan and active task snapshot",
        action: (ctx) => {
          const activePlan =
            ctx.dashboard.plans.find((plan) => plan.status === "active") || ctx.dashboard.plans.at(-1);
          const activeTasks = ctx.dashboard.tasks.filter(
            (task) => task.status === "assigned" || task.status === "in_progress"
          );
          const planLine = activePlan
            ? `${activePlan.title} (${activePlan.tasks.filter((task) => task.status === "completed").length}/${activePlan.tasks.length} completed)`
            : "No active plan";
          const taskLine =
            activeTasks.length > 0
              ? activeTasks.map((task) => `[${task.status}] ${task.title}`).join("\n")
              : "No active tasks";

          ctx.setStatus("Printed live watch snapshot");
          appendTranscript(ctx.setTranscript, {
            kind: "assistant",
            tone: "muted",
            text: `${planLine}\n${taskLine}`,
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/agents",
        description: "List registered agents and their current status",
        action: (ctx) => {
          const lines =
            ctx.dashboard.agents.length > 0
              ? ctx.dashboard.agents.map((agent) => `${agent.provider} ${agent.role} ${agent.status}`)
              : ["No registered agents"];
          ctx.setStatus("Printed agent snapshot");
          appendTranscript(ctx.setTranscript, {
            kind: "assistant",
            tone: "muted",
            text: lines.join("\n"),
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/version",
        description: "Print the installed Harness CLI version",
        action: (ctx) => {
          ctx.setStatus("Printed version");
          appendTranscript(ctx.setTranscript, {
            kind: "assistant",
            tone: "muted",
            text: `Harness CLI v${HARNESS_VERSION}`,
          });
          ctx.setPrompt("");
        },
      },
      {
        name: "/clear",
        description: "Clear local shell transcript and result state",
        action: (ctx) => {
          ctx.setPhase("idle");
          ctx.setPrepared(null);
          ctx.setResults([]);
          ctx.setError(null);
          ctx.setStatus("Cleared local shell state");
          ctx.setTranscript([
            {
              id: createId(),
              kind: "assistant",
              tone: "muted",
              text: "Shell state cleared.",
            },
          ]);
          ctx.setPrompt("");
        },
      },
      {
        name: "/status",
        description: "Print the current orchestration mode and live status",
        action: (ctx) => {
          ctx.setStatus("Printed current status");
          appendTranscript(ctx.setTranscript, {
            kind: "assistant",
            tone: "muted",
            text: `Mode: ${mode}. Status: ${status}.`,
          });
          ctx.setPrompt("");
        },
      },
    ],
    [mode, status]
  );

  const matchingCommands = useMemo(() => {
    if (!prompt.trim().startsWith("/")) return [];
    const query = prompt.trim().toLowerCase();
    return commands.filter((command) => command.name.startsWith(query)).slice(0, 6);
  }, [commands, prompt]);

  useEffect(() => {
    if (matchingCommands.length === 0) {
      setSelectedCommandIndex(0);
      return;
    }

    setSelectedCommandIndex((current) =>
      current >= matchingCommands.length ? 0 : current
    );
  }, [matchingCommands]);

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (phase === "running") return;

    if (key.tab) {
      setMode((current) => (current === "normal" ? "plan" : "normal"));
      return;
    }

    if (prompt.trim().startsWith("/") && matchingCommands.length > 0) {
      if (key.upArrow) {
        setSelectedCommandIndex((current) =>
          current === 0 ? matchingCommands.length - 1 : current - 1
        );
        return;
      }

      if (key.downArrow) {
        setSelectedCommandIndex((current) =>
          current === matchingCommands.length - 1 ? 0 : current + 1
        );
        return;
      }
    }

    if (key.return) {
      const trimmed = prompt.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("/")) {
        const [commandName, ...commandArgs] = trimmed.split(/\s+/);
        const command =
          commands.find((entry) => entry.name === commandName) ||
          matchingCommands[selectedCommandIndex];
        if (command) {
          command.action({
            exit,
            setMode,
            setPrompt,
            setPhase,
            setPrepared,
            setResults,
            setStatus,
            setError,
            setTranscript,
            setAvailability,
            setPreferredLeadProvider,
            setSelectedWorkerProviders,
            dashboard,
            availability,
            preferredLeadProvider,
            selectedWorkerProviders,
            commandArgs,
          });
        } else {
          setStatus(`Unknown command: ${trimmed}`);
          appendTranscript(setTranscript, {
            kind: "system",
            tone: "warn",
            text: `Unknown command: ${trimmed}`,
          });
          setPrompt("");
        }
        return;
      }

      const submittedPrompt = trimmed;
      setPhase("running");
      setPrepared(null);
      setResults([]);
      setError(null);
      setStatus("Preparing orchestration");
      setLiveReport(`${SPINNER_FRAMES[0]} Starting orchestration`);
      appendTranscript(setTranscript, {
        kind: "user",
        text: submittedPrompt,
      });
      setPrompt("");

      void executePrompt({
        prompt: submittedPrompt,
        mode,
        config,
        preferredLeadProvider: preferredLeadProvider ?? undefined,
        workerProviders: selectedWorkerProviders ?? undefined,
        onPrepared: (next) => {
          setPrepared(next);
          setStatus(`Lead ${next.leadProvider} decomposed into ${next.tasks.length} task(s)`);
          appendTranscript(setTranscript, {
            kind: "assistant",
            tone: "muted",
            text:
              mode === "plan"
                ? formatPreparedPlan(next)
                : `Lead ${next.leadProvider} prepared ${next.tasks.length} task(s) with ${next.workerProviders.join(", ")}.`,
          });
        },
        onTick: (next) => {
          setStatus(
            `${next.status} · ${next.tasks.completed}/${next.tasks.total} completed · ${next.tasks.active} active`
          );
        },
      })
        .then((summary) => {
          setPhase("done");
          setResults(summary.taskResults);
          setStatus(
            summary.success
              ? `Completed ${summary.status.tasks.completed}/${summary.status.tasks.total} task(s)`
              : `Failed with ${summary.status.tasks.failed} failed task(s)`
          );
          appendTranscript(setTranscript, {
            kind: "assistant",
            tone: summary.success ? "success" : "warn",
            text: formatSummary(summary.taskResults, summary.success),
          });
        })
        .catch((runError) => {
          const message = runError instanceof Error ? runError.message : String(runError);
          setPhase("error");
          setError(message);
          setStatus("Execution failed");
          appendTranscript(setTranscript, {
            kind: "assistant",
            tone: "error",
            text: message,
          });
        });
      return;
    }

    if (key.backspace || key.delete) {
      setPrompt((value) => value.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setPrompt((value) => value + input);
    }
  });

  const availableProviders = Object.entries(availability)
    .filter(([, available]) => available)
    .map(([provider]) => provider);
  const headerProviders =
    availableProviders.length > 0 ? availableProviders.join(", ") : "detecting local CLIs";
  const orchestrationConfigLine = [
    preferredLeadProvider ? `planner ${preferredLeadProvider}` : "planner auto",
    selectedWorkerProviders ? `workers ${selectedWorkerProviders.join(",")}` : "workers auto",
  ].join(" · ");

  const activePlan = dashboard.plans.find((plan) => plan.status === "active") || dashboard.plans.at(-1);
  const activeTasks = dashboard.tasks.filter(
    (task) => task.status === "assigned" || task.status === "in_progress"
  );
  const recentTranscript = transcript.slice(-10);
  const terminalWidth = Math.max(40, (stdout.columns || 100) - 2);
  const transcriptHeight = Math.max(12, (stdout.rows || 30) - 14);

  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Header
        workDir={config.workDir}
        providers={headerProviders}
        mode={mode}
        orchestrationConfigLine={orchestrationConfigLine}
      />

      <Divider width={terminalWidth} />

      <Box minHeight={transcriptHeight} flexDirection="column" paddingX={1} width="100%">
        {recentTranscript.map((entry) => (
          <TranscriptLine key={entry.id} entry={entry} />
        ))}
        {liveReport ? (
          <TranscriptLine
            entry={{
              id: "live-report",
              kind: "system",
              tone: "muted",
              text: liveReport,
            }}
          />
        ) : null}
        {recentTranscript.length === 0 ? (
          <Text color="gray">No transcript yet.</Text>
        ) : null}
      </Box>

      <Divider width={terminalWidth} />

      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={0}
        width="100%"
      >
        <Text>
          <Text color="whiteBright">{">"}</Text>
          <Text> </Text>
          <Text color="white">{prompt || " "}</Text>
          {phase !== "running" ? <Text backgroundColor="white"> </Text> : null}
        </Text>

        {matchingCommands.length > 0 ? (
          <Box marginTop={1} marginBottom={1} flexDirection="column">
            {matchingCommands.map((command, index) => (
              <Text key={command.name}>
                <Text color={index === selectedCommandIndex ? "black" : "blueBright"} backgroundColor={index === selectedCommandIndex ? "blueBright" : undefined}>
                  {command.name.padEnd(12)}
                </Text>
                <Text> </Text>
                <Text color="gray">{command.description}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      <Divider width={terminalWidth} />

      <Footer
        error={error}
        activePlan={activePlan}
        activeTasks={activeTasks}
      />
    </Box>
  );
}

function Header({
  workDir,
  providers,
  mode,
  orchestrationConfigLine,
}: {
  workDir: string;
  providers: string;
  mode: RunMode;
  orchestrationConfigLine: string;
}) {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="cyanBright">Harness CLI v{HARNESS_VERSION}</Text>
      <Text color="gray">{providers}</Text>
      <Text color="gray">{shortenPath(workDir)}</Text>
      <Text color={mode === "plan" ? "yellow" : "green"}>
        {mode === "plan" ? "Plan mode" : "Normal mode"}
      </Text>
      <Text color="gray">{orchestrationConfigLine}</Text>
    </Box>
  );
}

function Footer({
  error,
  activePlan,
  activeTasks,
}: {
  error: string | null;
  activePlan?: Plan;
  activeTasks: Task[];
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {activePlan ? (
        <Text color="gray">
          {activePlan.title} · {activeTasks.length} active task(s)
        </Text>
      ) : (
        <Text color="gray">No active plan</Text>
      )}
      {error ? <Text color="red">{error}</Text> : null}
      <Text color="gray">tab mode  enter submit  esc exit  /help commands</Text>
    </Box>
  );
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const prefix =
    entry.kind === "user" ? ">" : entry.kind === "system" ? "L" : "●";
  const prefixColor =
    entry.kind === "user" ? "cyanBright" : entry.kind === "system" ? "green" : "yellow";
  const textColor = entryTone(entry.tone, entry.kind);
  const lines = entry.text.split("\n");

  return (
    <Box marginBottom={entry.kind === "user" ? 0 : 1} flexDirection="column">
      {lines.map((line, index) => (
        <Box key={`${entry.id}-${index}`}>
          <Text color={prefixColor}>{index === 0 ? `${prefix} ` : "  "}</Text>
          <Text color={textColor}>{line || " "}</Text>
        </Box>
      ))}
    </Box>
  );
}

function Divider({ width }: { width: number }) {
  return <Text color="gray">{"─".repeat(width)}</Text>;
}

function appendTranscript(
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>,
  entry: Omit<TranscriptEntry, "id">
) {
  setTranscript((current) => [...current, { ...entry, id: createId() }].slice(-30));
}

function formatPreparedPlan(prepared: PreparedPromptRun): string {
  const taskLines = prepared.tasks.map((task, index) => {
    const deps = task.dependsOnIndex?.length
      ? ` depends on ${task.dependsOnIndex.map((value) => value + 1).join(", ")}`
      : "";
    return `${index + 1}. ${task.title}${deps}`;
  });

  return [
    `${prepared.title}`,
    prepared.description,
    ...taskLines,
  ].join("\n");
}

function formatSummary(
  taskResults: Array<Record<string, unknown>>,
  success: boolean
): string {
  if (taskResults.length === 0) {
    return success ? "Run completed." : "Run finished without task results.";
  }

  const lines = taskResults.slice(-4).map((task) => {
    const result = task.result as Record<string, unknown>;
    return `${String(task.title)}: ${String(result?.summary ?? "")}`;
  });

  return lines.join("\n");
}

function entryTone(
  tone: TranscriptEntry["tone"],
  kind: TranscriptEntry["kind"]
) {
  switch (tone) {
    case "success":
      return "green";
    case "warn":
      return "yellowBright";
    case "error":
      return "redBright";
    case "muted":
      return kind === "assistant" ? "white" : "gray";
    default:
      return kind === "user" ? "whiteBright" : "white";
  }
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function shortenPath(path: string) {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(dir, file), "utf-8")) as T;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as T[];
  } catch {
    return [];
  }
}

export async function runInteractiveApp(config: HarnessConfig) {
  render(<HarnessApp config={config} />);
}
