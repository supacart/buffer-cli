#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import packageJson from "../package.json" with { type: "json" };

type Flags = Record<string, string | boolean>;

type ParsedArgs = {
  positionals: string[];
  flags: Flags;
};

type DraftPayload = {
  createdAt: string;
  channelHint: string | null;
  text: string;
};

type Channel = {
  id: string;
  name: string;
  service: string;
  raw: unknown;
};

type GraphQLPayload<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
  error?: { message?: string } | string;
  message?: string;
};

type CreatePostResult = {
  createPost?: {
    post?: {
      id: string;
      text: string;
    };
    message?: string;
  };
};

const BUFFER_GRAPHQL_URL = "https://api.buffer.com";
const BUFFER_LEGACY_BASE_URL = "https://api.bufferapp.com/1";
const DEFAULT_DRAFT_DIR = path.join(process.cwd(), ".social", "drafts");

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || flags.v) {
    console.log(packageJson.version);
    return;
  }

  const command = positionals[0] ?? "help";

  try {
    switch (command) {
      case "help":
        printHelp();
        break;
      case "version":
        console.log(packageJson.version);
        break;
      case "draft":
        await createDraft(flags);
        break;
      case "drafts":
        await listDrafts(flags);
        break;
      case "list-channels":
        await listChannels(flags);
        break;
      case "schedule":
        await createBufferPost("schedule", flags);
        break;
      case "publish-now":
        await createBufferPost("publish-now", flags);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`Error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`Buffer CLI

Usage:
  buffer help
  buffer version
  buffer list-channels [--org ORGANIZATION_ID] [--json]
  buffer draft --text "Post copy" [--slug launch-post] [--channel-hint facebook]
  buffer drafts [--json]
  buffer schedule --channel CHANNEL_ID (--text "Post copy" | --draft PATH) --at 2026-03-20T09:00:00Z
  buffer publish-now --channel CHANNEL_ID (--text "Post copy" | --draft PATH)

Environment:
  BUFFER_API_KEY       Required for schedule and publish-now, and preferred for list-channels
  BUFFER_ACCESS_TOKEN  Optional fallback for legacy profile listing
  BUFFER_ORGANIZATION_ID Optional for GraphQL channel listing
  SOCIAL_DRAFT_DIR     Optional override for local drafts directory

Flags:
  --version, -v       Print the CLI version
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positionals, flags };
}

function getDraftDir(flags: Flags): string {
  return path.resolve(getStringFlag(flags["draft-dir"]) || process.env.SOCIAL_DRAFT_DIR || DEFAULT_DRAFT_DIR);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "post"
  );
}

function getStringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readDraftText(draftPath: string): Promise<string> {
  const raw = await fs.readFile(path.resolve(draftPath), "utf8");
  const parsed = JSON.parse(raw) as Partial<DraftPayload>;

  if (!parsed.text) {
    throw new Error(`Draft file has no text: ${draftPath}`);
  }

  return parsed.text;
}

async function resolvePostText(flags: Flags): Promise<string> {
  const text = getStringFlag(flags.text);
  const draft = getStringFlag(flags.draft);
  const file = getStringFlag(flags.file);

  if (text) {
    return text.trim();
  }

  if (draft) {
    return readDraftText(draft);
  }

  if (file) {
    return (await fs.readFile(path.resolve(file), "utf8")).trim();
  }

  throw new Error("Provide post content with --text, --draft, or --file.");
}

async function createDraft(flags: Flags): Promise<void> {
  const text = await resolvePostText(flags);
  const draftDir = getDraftDir(flags);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(getStringFlag(flags.slug) || text.split(/\s+/).slice(0, 8).join(" "));
  const filename = `${date}_${slug}.json`;
  const draftPath = path.join(draftDir, filename);

  const payload: DraftPayload = {
    createdAt: new Date().toISOString(),
    channelHint: getStringFlag(flags["channel-hint"]) ?? null,
    text
  };

  await ensureDir(draftDir);
  await fs.writeFile(draftPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(draftPath);
}

async function listDrafts(flags: Flags): Promise<void> {
  const draftDir = getDraftDir(flags);
  await ensureDir(draftDir);
  const entries = await fs.readdir(draftDir, { withFileTypes: true });
  const drafts: Array<{
    path: string;
    channelHint?: string | null;
    createdAt?: string;
    textPreview: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const draftPath = path.join(draftDir, entry.name);
    const raw = await fs.readFile(draftPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DraftPayload>;
    drafts.push({
      path: draftPath,
      channelHint: parsed.channelHint,
      createdAt: parsed.createdAt,
      textPreview: String(parsed.text || "").slice(0, 120)
    });
  }

  drafts.sort((left, right) => left.path.localeCompare(right.path));

  if (flags.json) {
    console.log(JSON.stringify(drafts, null, 2));
    return;
  }

  if (drafts.length === 0) {
    console.log("No drafts found.");
    return;
  }

  for (const draft of drafts) {
    console.log(`${draft.path}`);
    console.log(`  created: ${draft.createdAt ?? "-"}`);
    console.log(`  channel: ${draft.channelHint ?? "-"}`);
    console.log(`  preview: ${draft.textPreview}`);
  }
}

async function listChannels(flags: Flags): Promise<void> {
  const apiKey = process.env.BUFFER_API_KEY;
  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  const organizationId = getStringFlag(flags.org) || process.env.BUFFER_ORGANIZATION_ID;
  const errors: string[] = [];

  if (apiKey && organizationId) {
    try {
      const data = await bufferGraphQLRequest<{ channels?: unknown[] }>({
        apiKey,
        query: `query ListChannels {
          channels(input: { organizationId: ${JSON.stringify(organizationId)} }) {
            id
            name
            service
            displayName
            descriptor
          }
        }`
      });
      const channels = normalizeChannels(data);

      if (channels.length > 0) {
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`GraphQL channels query: ${getErrorMessage(error)}`);
    }
  } else if (apiKey && !organizationId) {
    errors.push("GraphQL channels query needs an organizationId. Set BUFFER_ORGANIZATION_ID or pass --org.");
  }

  const bearerCandidates = [accessToken, apiKey].filter((value): value is string => Boolean(value));

  for (const token of bearerCandidates) {
    try {
      const response = await fetch(`${BUFFER_LEGACY_BASE_URL}/profiles.json`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await parseJsonResponse<unknown>(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`Legacy profiles with bearer token: ${getErrorMessage(error)}`);
    }
  }

  if (accessToken) {
    try {
      const response = await fetch(
        `${BUFFER_LEGACY_BASE_URL}/profiles.json?access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await parseJsonResponse<unknown>(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`Legacy profiles with query token: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(
    `Unable to list channels. ${
      errors.length > 0 ? `Tried:\n- ${errors.join("\n- ")}` : "No valid authentication method was available."
    }`
  );
}

function normalizeChannels(data: { channels?: unknown[]; accounts?: unknown[] | { nodes?: unknown[] } }): Channel[] {
  const candidates = [data.channels, data.accounts, data.accounts && "nodes" in data.accounts ? data.accounts.nodes : undefined];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    return candidate
      .filter(Boolean)
      .map((channel) => {
        const record = channel as Record<string, unknown>;
        return {
          id: String(record.id ?? ""),
          name: String(
            record.displayName ??
              record.name ??
              record.descriptor ??
              record.handle ??
              record.username ??
              "unknown"
          ),
          service: String(record.service ?? record.type ?? "unknown"),
          raw: channel
        };
      })
      .filter((channel) => channel.id.length > 0);
  }

  return [];
}

function normalizeLegacyProfiles(data: unknown): Channel[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(Boolean)
    .map((profile) => {
      const record = profile as Record<string, unknown>;
      return {
        id: String(record.id ?? ""),
        name: String(record.formatted_username ?? record.service_username ?? record.service ?? "unknown"),
        service: String(record.service ?? "unknown"),
        raw: profile
      };
    })
    .filter((channel) => channel.id.length > 0);
}

function printChannels(channels: Channel[], flags: Flags): void {
  if (flags.json) {
    console.log(JSON.stringify(channels, null, 2));
    return;
  }

  for (const channel of channels) {
    console.log(`${channel.id}\t${channel.service}\t${channel.name}`);
  }
}

async function createBufferPost(mode: "schedule" | "publish-now", flags: Flags): Promise<void> {
  const apiKey = requireValue(process.env.BUFFER_API_KEY, "Set BUFFER_API_KEY first.");
  const channelId = requireValue(getStringFlag(flags.channel), "Provide --channel with the Buffer channel ID.");
  const text = await resolvePostText(flags);

  let bufferMode = "shareNow";
  let dueAtClause = "";

  if (mode === "schedule") {
    bufferMode = "customSchedule";
    const dueAt = requireValue(
      getStringFlag(flags.at),
      "Provide --at with an ISO datetime, for example 2026-03-20T09:00:00Z."
    );
    dueAtClause = `, dueAt: ${JSON.stringify(new Date(dueAt).toISOString())}`;
  }

  const query = `mutation CreatePost {
    createPost(input: {
      text: ${JSON.stringify(text)},
      channelId: ${JSON.stringify(channelId)},
      schedulingType: automatic,
      mode: ${bufferMode}${dueAtClause}
    }) {
      ... on PostActionSuccess {
        post {
          id
          text
        }
      }
      ... on MutationError {
        message
      }
    }
  }`;

  const data = await bufferGraphQLRequest<CreatePostResult>({
    apiKey,
    query
  });

  const result = data.createPost;

  if (!result) {
    throw new Error("Buffer returned no createPost payload.");
  }

  if (result.message) {
    throw new Error(result.message);
  }

  console.log(JSON.stringify(result, null, 2));
}

async function bufferGraphQLRequest<T>({ apiKey, query }: { apiKey: string; query: string }): Promise<T> {
  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query })
  });

  const payload = await parseJsonResponse<GraphQLPayload<T>>(response);

  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }

  if (!payload.data) {
    throw new Error("Buffer returned no data.");
  }

  return payload.data;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const nestedError =
      typeof record.error === "object" && record.error && "message" in record.error
        ? String((record.error as { message?: unknown }).message ?? "")
        : undefined;
    const errorMessage =
      nestedError ||
      (typeof record.error === "string" ? record.error : undefined) ||
      (typeof record.message === "string" ? record.message : undefined) ||
      text ||
      `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

await main();
