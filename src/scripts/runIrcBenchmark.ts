import fs from "node:fs/promises";
import path from "node:path";

import { AIDecider } from "../ai";
import { OfflineThreadingSystem } from "../offline-threading";
import type { OfflineAssignment, OfflineMessageInput } from "../offline-threading";
import type { DecisionMode } from "../threading-core";

interface CliArgs {
  datasetDir: string;
  outputPath: string;
  startIndex: number;
  decisionMode: DecisionMode;
}

interface PredictionEdge {
  fileKey: string;
  source: number;
  target: number;
}

const CHAT_LINE_RE = /^\[(\d{1,2}):(\d{2})\]\s+<([^>]+)>\s?(.*)$/;

function parseArgs(argv: string[]): CliArgs {
  let datasetDir = "";
  let outputPath = "";
  let startIndex = 1000;
  let decisionMode: DecisionMode = "strict_ai";

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dataset-dir") {
      datasetDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--output") {
      outputPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--start-index") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--start-index must be a non-negative integer");
      }
      startIndex = value;
      i += 1;
      continue;
    }
    if (token === "--decision-mode") {
      const value = argv[i + 1] ?? "";
      if (
        value !== "strict_ai" &&
        value !== "ai_with_fallback" &&
        value !== "heuristic_only"
      ) {
        throw new Error(
          "--decision-mode must be one of: strict_ai, ai_with_fallback, heuristic_only"
        );
      }
      decisionMode = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!datasetDir) {
    throw new Error("--dataset-dir is required");
  }
  if (!outputPath) {
    throw new Error("--output is required");
  }

  return {
    datasetDir,
    outputPath,
    startIndex,
    decisionMode
  };
}

function buildMessageTimestamp(
  fileOrdinal: number,
  lineId: number,
  hour: number | null,
  minute: number | null
): string {
  const baseMs = Date.UTC(2000, 0, 1 + fileOrdinal, 0, 0, 0, 0);
  if (hour !== null && minute !== null) {
    const minuteOffset = (hour * 60 + minute) * 60_000;
    return new Date(baseMs + minuteOffset + lineId).toISOString();
  }
  return new Date(baseMs + lineId).toISOString();
}

async function loadAsciiMessages(
  asciiPath: string,
  fileKey: string,
  fileOrdinal: number
): Promise<OfflineMessageInput[]> {
  const text = await fs.readFile(asciiPath, "utf8");
  const lines = text.split(/\r?\n/);

  return lines
    .map((line, lineId): OfflineMessageInput | null => {
      if (line.length === 0 && lineId === lines.length - 1) {
        return null;
      }

      const match = CHAT_LINE_RE.exec(line);
      if (!match) {
        return {
          id: `${fileKey}:${lineId}`,
          file_key: fileKey,
          line_id: lineId,
          created_at: buildMessageTimestamp(fileOrdinal, lineId, null, null),
          author: "_system",
          content: line
        };
      }

      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) {
        return {
          id: `${fileKey}:${lineId}`,
          file_key: fileKey,
          line_id: lineId,
          created_at: buildMessageTimestamp(fileOrdinal, lineId, null, null),
          author: "_system",
          content: line
        };
      }

      return {
        id: `${fileKey}:${lineId}`,
        file_key: fileKey,
        line_id: lineId,
        created_at: buildMessageTimestamp(fileOrdinal, lineId, hour, minute),
        author: match[3],
        content: match[4]
      };
    })
    .filter((row): row is OfflineMessageInput => Boolean(row));
}

function assignmentsToEdges(
  assignments: OfflineAssignment[],
  startIndex: number
): PredictionEdge[] {
  const sorted = [...assignments].sort((a, b) => a.line_id - b.line_id);
  const lastLineByThread = new Map<string, number>();
  const out: PredictionEdge[] = [];

  for (const item of sorted) {
    const previous = lastLineByThread.get(item.thread_id);
    const target = previous ?? item.line_id;
    if (item.line_id >= startIndex) {
      out.push({
        fileKey: item.file_key,
        source: item.line_id,
        target
      });
    }
    lastLineByThread.set(item.thread_id, item.line_id);
  }

  return out;
}

function renderEdges(edges: PredictionEdge[]): string {
  return edges
    .sort((a, b) => {
      const fileCmp = a.fileKey.localeCompare(b.fileKey);
      if (fileCmp !== 0) {
        return fileCmp;
      }
      return a.source - b.source;
    })
    .map((edge) => `${edge.fileKey}:${edge.source} ${edge.target} -`)
    .join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const decider = new AIDecider();

  if (args.decisionMode === "strict_ai" && !decider.enabled) {
    throw new Error(
      "strict_ai mode requires OPENAI_API_KEY to be set so AI calls are mandatory"
    );
  }

  const entries = await fs.readdir(args.datasetDir);
  const asciiFiles = entries
    .filter((name) => name.endsWith(".ascii.txt"))
    .sort((a, b) => a.localeCompare(b));

  if (asciiFiles.length === 0) {
    throw new Error(`No .ascii.txt files found in ${args.datasetDir}`);
  }

  const allEdges: PredictionEdge[] = [];

  for (let fileOrdinal = 0; fileOrdinal < asciiFiles.length; fileOrdinal += 1) {
    const filename = asciiFiles[fileOrdinal];
    const fileKey = filename.replace(/\.ascii\.txt$/, "");
    const asciiPath = path.join(args.datasetDir, filename);
    const messages = await loadAsciiMessages(asciiPath, fileKey, fileOrdinal);

    const system = new OfflineThreadingSystem(decider, {
      decisionMode: args.decisionMode
    });
    const result = await system.run(messages);
    allEdges.push(...assignmentsToEdges(result.assignments, args.startIndex));
  }

  const rendered = renderEdges(allEdges);
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(
    args.outputPath,
    rendered.length > 0 ? `${rendered}\n` : "",
    "utf8"
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dataset_dir: args.datasetDir,
        output: args.outputPath,
        files: asciiFiles.length,
        edges_written: allEdges.length,
        decision_mode: args.decisionMode
      },
      null,
      2
    )}\n`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
