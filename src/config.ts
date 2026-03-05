import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://localhost/continuum"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  DECISION_MODE: z
    .enum(["strict_ai", "ai_with_fallback", "heuristic_only"])
    .default("ai_with_fallback"),
  ACTIVE_TO_COOLING_MINUTES: z.coerce.number().default(30),
  COOLING_TO_ARCHIVED_HOURS: z.coerce.number().default(72),
  ASSIGNMENT_POLL_MS: z.coerce.number().default(1500),
  MERGE_POLL_MS: z.coerce.number().default(45000),
  MAX_ACTIVE_THREAD_CANDIDATES: z.coerce.number().default(15),
  MAX_ARCHIVED_THREAD_CANDIDATES: z.coerce.number().default(20)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(
    `Invalid environment configuration:\n${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n")}`
  );
}

export const config = {
  ...parsed.data,
  hasOpenAI: Boolean(parsed.data.OPENAI_API_KEY)
};
